"""
MCP Agent Endpoint - Server-side agent loop with tool-call forwarding
This handles the agent loop on the Ollama server and forwards tool requests to student desktops
"""

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError
from typing import List, Dict, Any, Optional
import json
import asyncio
import logging
import httpx
from datetime import datetime
import uuid

router = APIRouter()
logger = logging.getLogger(__name__)

try:
    from app.core.structured_llm import StructuredLLMService, StructuredLLMError
    STRUCTURED_LLM_AVAILABLE = True
except Exception:
    STRUCTURED_LLM_AVAILABLE = False

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


class ToolCallFunction(BaseModel):
    name: str
    arguments: Dict[str, Any] = Field(default_factory=dict)


class NormalizedToolCall(BaseModel):
    id: str
    function: ToolCallFunction


class StructuredToolCall(BaseModel):
    name: str
    arguments: Dict[str, Any] = Field(default_factory=dict)


class StructuredToolCallEnvelope(BaseModel):
    tool_calls: List[StructuredToolCall] = Field(default_factory=list)


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


def _safe_parse_arguments(arguments: Any) -> Dict[str, Any]:
    if isinstance(arguments, dict):
        return arguments

    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            logger.warning("Received non-JSON tool arguments string; defaulting to empty args")
            return {}

    return {}


def _build_tool_registry(session_tools: List[Dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    tools: List[Dict[str, Any]] = []
    registry: Dict[str, Dict[str, Any]] = {}

    for tool in session_tools:
        name = tool.get("name")
        if not name:
            continue

        parameters = tool.get("parameters") or {}
        if not isinstance(parameters, dict):
            parameters = {}

        if "type" not in parameters:
            parameters["type"] = "object"
        if "properties" not in parameters or not isinstance(parameters.get("properties"), dict):
            parameters["properties"] = {}
        if "required" not in parameters or not isinstance(parameters.get("required"), list):
            parameters["required"] = []

        parameters["additionalProperties"] = False

        tool_schema = {
            "type": "function",
            "function": {
                "name": name,
                "description": tool.get("description", ""),
                "parameters": parameters,
            },
        }
        tools.append(tool_schema)
        registry[name] = tool_schema["function"]

    return tools, registry


def _normalize_tool_calls(raw_tool_calls: Any, tool_registry: Dict[str, Dict[str, Any]]) -> List[NormalizedToolCall]:
    normalized: List[NormalizedToolCall] = []

    if not isinstance(raw_tool_calls, list):
        return normalized

    for index, raw_call in enumerate(raw_tool_calls):
        try:
            function_data = raw_call.get("function", {}) if isinstance(raw_call, dict) else {}
            tool_name = function_data.get("name")
            if not tool_name or tool_name not in tool_registry:
                logger.warning("Ignoring unknown tool call: %s", tool_name)
                continue

            arguments = _safe_parse_arguments(function_data.get("arguments", {}))
            parameters = tool_registry[tool_name].get("parameters", {})
            allowed_props = parameters.get("properties", {}) if isinstance(parameters, dict) else {}
            if isinstance(allowed_props, dict) and allowed_props:
                arguments = {k: v for k, v in arguments.items() if k in allowed_props}

            normalized_call = NormalizedToolCall.model_validate(
                {
                    "id": raw_call.get("id") if isinstance(raw_call, dict) and raw_call.get("id") else f"call_{index}",
                    "function": {
                        "name": tool_name,
                        "arguments": arguments,
                    },
                }
            )
            normalized.append(normalized_call)
        except ValidationError as exc:
            logger.warning("Skipping invalid tool call payload: %s", exc)

    return normalized


def _recover_tool_calls_with_instructor(
    assistant_content: str,
    tool_registry: Dict[str, Dict[str, Any]],
) -> List[NormalizedToolCall]:
    if not STRUCTURED_LLM_AVAILABLE or not assistant_content.strip():
        return []

    tool_specs = []
    for name, info in tool_registry.items():
        tool_specs.append(
            {
                "name": name,
                "description": info.get("description", ""),
                "parameters": info.get("parameters", {}),
            }
        )

    prompt = (
        "Extract zero or more MCP tool calls from the assistant content. "
        "Return only tool calls that match available tool names and pass JSON-object arguments.\n\n"
        f"Available tools: {json.dumps(tool_specs)}\n\n"
        f"Assistant content:\n{assistant_content}"
    )

    try:
        service = StructuredLLMService()
        extracted = service.extract(prompt, StructuredToolCallEnvelope)
    except StructuredLLMError as exc:
        logger.warning("Structured recovery unavailable for tool calls: %s", exc)
        return []
    except Exception as exc:
        logger.warning("Structured recovery failed for tool calls: %s", exc)
        return []

    recovered_raw = []
    for idx, call in enumerate(extracted.tool_calls):
        recovered_raw.append(
            {
                "id": f"recovered_{idx}",
                "function": {
                    "name": call.name,
                    "arguments": call.arguments,
                },
            }
        )

    return _normalize_tool_calls(recovered_raw, tool_registry)


async def _execute_tool_calls_and_append_results(
    session_id: str,
    normalized_tool_calls: List[NormalizedToolCall],
    messages: List[Dict[str, Any]],
) -> None:
    for tool_call in normalized_tool_calls:
        tool_name = tool_call.function.name
        tool_args = tool_call.function.arguments

        try:
            result = await forward_tool_call_to_desktop(session_id, tool_name, tool_args)
            messages.append(
                {
                    "role": "tool",
                    "tool_name": tool_name,
                    "content": json.dumps(result),
                }
            )
        except Exception as exc:
            logger.error("Tool execution error (%s): %s", tool_name, exc)
            messages.append(
                {
                    "role": "tool",
                    "tool_name": tool_name,
                    "content": json.dumps({"error": str(exc)}),
                }
            )


@router.post("/api/mcp/agent_chat")
async def agent_chat(request: AgentChatRequest):
    """
    Agent chat endpoint with tool-calling support
    This runs the agent loop on the server and forwards tool calls to the desktop
    """
    if request.session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    session = active_sessions[request.session_id]
    
    # Convert MCP tools to Ollama tool schema + indexed registry for validation
    tools, tool_registry = _build_tool_registry(session.tools)
    
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
                        normalized_tool_calls = _normalize_tool_calls(tool_calls, tool_registry)
                        if not normalized_tool_calls:
                            recovered = _recover_tool_calls_with_instructor(
                                str(data.get("message", {}).get("content", "")),
                                tool_registry,
                            )
                            normalized_tool_calls = recovered
                        
                        # Add assistant message to history
                        messages.append(data["message"])
                        
                        # Execute each validated tool call
                        await _execute_tool_calls_and_append_results(
                            request.session_id,
                            normalized_tool_calls,
                            messages,
                        )
                        
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
                                        normalized_tool_calls = _normalize_tool_calls(tool_calls, tool_registry)
                                        if not normalized_tool_calls:
                                            recovered = _recover_tool_calls_with_instructor(
                                                full_response,
                                                tool_registry,
                                            )
                                            normalized_tool_calls = recovered

                                        # Model wants to call tools
                                        messages.append({
                                            "role": "assistant",
                                            "content": full_response,
                                            "tool_calls": tool_calls
                                        })

                                        # Execute tools (similar to non-streaming)
                                        await _execute_tool_calls_and_append_results(
                                            request.session_id,
                                            normalized_tool_calls,
                                            messages,
                                        )
                                        
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
