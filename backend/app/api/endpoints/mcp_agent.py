"""
MCP Agent Endpoint - Server-side agent loop with tool-call forwarding
This handles the agent loop on the Ollama server and forwards tool requests to student desktops
"""

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import json
import asyncio
import logging
import httpx
from datetime import datetime
import uuid

router = APIRouter()
logger = logging.getLogger(__name__)

# Store active student sessions
active_sessions = {}  # session_id -> SessionInfo
tool_pending_requests = {}  # request_id -> Future


class SessionInfo(BaseModel):
    session_id: str
    student_id: str
    device_id: str
    tools: List[Dict[str, Any]]
    websocket: Optional[Any] = None
    connected_at: datetime = datetime.now()


class RegisterSessionRequest(BaseModel):
    session_id: str
    student_id: str
    device_id: str
    tools: List[Dict[str, Any]]


class ToolResultRequest(BaseModel):
    session_id: str
    request_id: str
    result: Dict[str, Any]


class AgentChatRequest(BaseModel):
    session_id: str
    messages: List[Dict[str, str]]
    model: str = "llama3.2:latest"
    stream: bool = True


@router.post("/api/mcp/register_session")
async def register_session(request: RegisterSessionRequest):
    """
    Register a student desktop session with available MCP tools
    """
    session_info = SessionInfo(
        session_id=request.session_id,
        student_id=request.student_id,
        device_id=request.device_id,
        tools=request.tools
    )
    
    active_sessions[request.session_id] = session_info
    
    logger.info(f"Registered session {request.session_id} for student {request.student_id}")
    logger.info(f"Available tools: {[t.get('name') for t in request.tools]}")
    
    return {
        "success": True,
        "message": "Session registered successfully",
        "session_id": request.session_id
    }


@router.websocket("/api/mcp/tool_requests")
async def tool_request_websocket(websocket: WebSocket):
    """
    WebSocket endpoint for receiving tool requests from server
    Students connect here to listen for tool execution requests
    """
    await websocket.accept()
    
    # Get session ID from query params
    session_id = websocket.query_params.get("session_id")
    
    if not session_id or session_id not in active_sessions:
        await websocket.close(code=1008, reason="Invalid session")
        return
    
    # Store websocket in session info
    active_sessions[session_id].websocket = websocket
    
    logger.info(f"WebSocket connected for session {session_id}")
    
    try:
        # Keep connection alive and handle any messages
        while True:
            data = await websocket.receive_text()
            # Handle any client messages if needed
            logger.debug(f"Received from client: {data}")
            
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for session {session_id}")
        if session_id in active_sessions:
            active_sessions[session_id].websocket = None


@router.post("/api/mcp/tool_result")
async def receive_tool_result(request: ToolResultRequest):
    """
    Receive tool execution results from student desktop
    """
    if request.request_id in tool_pending_requests:
        future = tool_pending_requests[request.request_id]
        future.set_result(request.result)
        del tool_pending_requests[request.request_id]
        
        return {"success": True, "message": "Result received"}
    else:
        logger.warning(f"Received result for unknown request: {request.request_id}")
        return {"success": False, "message": "Unknown request ID"}


async def forward_tool_call_to_desktop(session_id: str, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """
    Forward a tool call request to the student's desktop and wait for result
    """
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[session_id]
    
    if not session.websocket:
        raise HTTPException(status_code=503, detail="Desktop not connected")
    
    # Generate unique request ID
    request_id = str(uuid.uuid4())
    
    # Create a future to wait for the result
    loop = asyncio.get_event_loop()
    future = loop.create_future()
    tool_pending_requests[request_id] = future
    
    # Send tool request to desktop
    tool_request = {
        "request_id": request_id,
        "tool_name": tool_name,
        "arguments": arguments
    }
    
    try:
        await session.websocket.send_json(tool_request)
        
        # Wait for result with timeout
        result = await asyncio.wait_for(future, timeout=60.0)
        return result
        
    except asyncio.TimeoutError:
        if request_id in tool_pending_requests:
            del tool_pending_requests[request_id]
        raise HTTPException(status_code=408, detail="Tool execution timeout")
    
    except Exception as e:
        if request_id in tool_pending_requests:
            del tool_pending_requests[request_id]
        logger.error(f"Error forwarding tool call: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/mcp/agent_chat")
async def agent_chat(request: AgentChatRequest):
    """
    Agent chat endpoint with tool-calling support
    This runs the agent loop on the server and forwards tool calls to the desktop
    """
    if request.session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[request.session_id]
    
    # Convert MCP tools to Ollama tool schema
    tools = []
    for tool in session.tools:
        tool_schema = {
            "type": "function",
            "function": {
                "name": tool.get("name"),
                "description": tool.get("description", ""),
                "parameters": tool.get("parameters", {})
            }
        }
        tools.append(tool_schema)
    
    async def generate_response():
        """
        Generator for streaming agent responses
        """
        messages = request.messages.copy()
        max_iterations = 10  # Prevent infinite loops
        iteration = 0
        
        while iteration < max_iterations:
            iteration += 1
            
            # Call Ollama with tools
            async with httpx.AsyncClient(timeout=120.0) as client:
                ollama_request = {
                    "model": request.model,
                    "messages": messages,
                    "stream": request.stream,
                    "tools": tools if tools else None
                }
                
                response = await client.post(
                    "http://localhost:11434/api/chat",
                    json=ollama_request
                )
                
                if not request.stream:
                    # Non-streaming response
                    data = response.json()
                    
                    # Check if model wants to call tools
                    if "tool_calls" in data.get("message", {}):
                        tool_calls = data["message"]["tool_calls"]
                        
                        # Add assistant message to history
                        messages.append(data["message"])
                        
                        # Execute each tool call
                        for tool_call in tool_calls:
                            tool_name = tool_call["function"]["name"]
                            tool_args = tool_call["function"]["arguments"]
                            
                            # Forward to desktop
                            try:
                                result = await forward_tool_call_to_desktop(
                                    request.session_id,
                                    tool_name,
                                    tool_args
                                )
                                
                                # Add tool result to messages
                                messages.append({
                                    "role": "tool",
                                    "content": json.dumps(result)
                                })
                                
                            except Exception as e:
                                logger.error(f"Tool execution error: {str(e)}")
                                messages.append({
                                    "role": "tool",
                                    "content": json.dumps({"error": str(e)})
                                })
                        
                        # Continue loop to get next response
                        continue
                    else:
                        # Final response, yield and exit
                        yield f"data: {json.dumps(data)}\n\n"
                        break
                else:
                    # Streaming response
                    full_response = ""
                    tool_calls = []
                    
                    async for line in response.aiter_lines():
                        if line:
                            try:
                                chunk = json.loads(line)
                                yield f"data: {line}\n\n"
                                
                                # Collect response content
                                if "message" in chunk:
                                    if "content" in chunk["message"]:
                                        full_response += chunk["message"]["content"]
                                    if "tool_calls" in chunk["message"]:
                                        tool_calls.extend(chunk["message"]["tool_calls"])
                                
                                # Check if done
                                if chunk.get("done", False):
                                    if tool_calls:
                                        # Model wants to call tools
                                        messages.append({
                                            "role": "assistant",
                                            "content": full_response,
                                            "tool_calls": tool_calls
                                        })
                                        
                                        # Execute tools (similar to non-streaming)
                                        for tool_call in tool_calls:
                                            tool_name = tool_call["function"]["name"]
                                            tool_args = tool_call["function"]["arguments"]
                                            
                                            try:
                                                result = await forward_tool_call_to_desktop(
                                                    request.session_id,
                                                    tool_name,
                                                    tool_args
                                                )
                                                
                                                messages.append({
                                                    "role": "tool",
                                                    "content": json.dumps(result)
                                                })
                                                
                                            except Exception as e:
                                                logger.error(f"Tool execution error: {str(e)}")
                                                messages.append({
                                                    "role": "tool",
                                                    "content": json.dumps({"error": str(e)})
                                                })
                                        
                                        # Break inner loop to continue outer agent loop
                                        break
                                    else:
                                        # Final response, no more tools needed
                                        return
                            
                            except json.JSONDecodeError:
                                continue
                    
                    # If we broke out of streaming loop due to tool calls, continue agent loop
                    if tool_calls:
                        continue
                    else:
                        break
        
        # Max iterations reached
        if iteration >= max_iterations:
            yield f"data: {json.dumps({'error': 'Max iterations reached'})}\n\n"
    
    if request.stream:
        return StreamingResponse(
            generate_response(),
            media_type="text/event-stream"
        )
    else:
        # Collect all generated data
        result = []
        async for chunk in generate_response():
            result.append(chunk)
        return {"response": "".join(result)}


@router.get("/api/mcp/sessions")
async def list_sessions():
    """
    List all active student sessions
    """
    sessions = []
    for session_id, info in active_sessions.items():
        sessions.append({
            "session_id": session_id,
            "student_id": info.student_id,
            "device_id": info.device_id,
            "connected": info.websocket is not None,
            "tools_count": len(info.tools),
            "connected_at": info.connected_at.isoformat()
        })
    
    return {"sessions": sessions}
