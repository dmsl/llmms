"""
Privacy-first RAG endpoints using SessionRAG with advanced retrieval.

Features:
- Semantic chunking with sentence boundaries
- MMR (Maximum Marginal Relevance) for diverse results
- In-memory vector store (no persistence)
- Automatic cleanup after processing
"""

import json
import logging
import os
import tempfile
import uuid
import base64
import io
from typing import Dict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
import ollama
from werkzeug.datastructures import FileStorage

from app.utils.file_extraction import handle_text_extraction
from app.utils.rag_session import SessionRAG

router = APIRouter()
logger = logging.getLogger(__name__)

# Global dictionary to store RAG sessions per chat session
# Format: {session_id: {"rag": SessionRAG, "files": [list of filenames]}}
rag_sessions: Dict[str, dict] = {}


def base64_to_file(base64_string: str, filename: str, file_type: str):
    """
    Convert a base64 string to a FileStorage object, mimicking Flask's file handling.
    """
    try:
        file_data = base64.b64decode(base64_string)
        file_obj = io.BytesIO(file_data)
        # Create a FileStorage object from the in-memory stream.
        file_storage = FileStorage(
            stream=file_obj, filename=filename, content_type=file_type
        )
        return file_storage, filename, file_type
    except Exception as e:
        raise ValueError(f"Failed to process the encoded file: {str(e)}")


@router.post("/rag_chain")
async def rag_chain_endpoint(request: Request):
    """
    Endpoint to handle RAG chain requests with base64‑encoded file data.
    Uses advanced retrieval with semantic chunking and MMR reranking.
    Supports multiple files in a single request AND across chat sessions.

    Expects JSON with fields:
      - model: The LLM model to use
      - messages: Array of conversation messages
      - sessionId: Chat session ID (required for persistent RAG)
      - files: Array of {fileData, fileName, fileType} objects (optional)
      - query: User query (optional, derived from last message if not provided)
    """
    try:
        data = await request.json()
        if not data.get("model") or not data.get("messages"):
            return JSONResponse(
                {"error": "Missing required parameters (model or messages)"},
                status_code=400,
            )
        
        session_id = data.get("sessionId")
        if not session_id:
            return JSONResponse(
                {"error": "Missing sessionId for persistent RAG"},
                status_code=400,
            )
        
        model = data["model"]
        message_history = data["messages"]
        files_data = data.get("files", [])
        
        # Support legacy single file format
        if data.get("fileData") and data.get("fileName"):
            files_data = [{
                "fileData": data["fileData"],
                "fileName": data["fileName"],
                "fileType": data.get("fileType", "application/octet-stream")
            }]
        
        stream = True  # default to streaming for better UX
        return await process_rag_chain_session(
            session_id, files_data, model, message_history, stream
        )
    except Exception as e:
        logger.error(f"Error in RAG chain endpoint: {str(e)}", exc_info=True)
        return JSONResponse(
            {"error": "Server error processing request"}, status_code=500
        )


async def process_rag_chain_session(
    session_id: str,
    files_data: list,
    model: str,
    message_history: list,
    stream: bool = True
):
    """
    Process RAG chain with session persistence.
    Maintains SessionRAG instance across multiple requests.
    """
    try:
        if not model:
            raise ValueError("Model name is required")
        if not message_history:
            raise ValueError("Message history is required")
        
        # Get or create RAG session for this chat session
        if session_id not in rag_sessions:
            rag_sessions[session_id] = {
                "rag": SessionRAG(chat_model=model),
                "files": []
            }
            logger.info(f"Created new RAG session: {session_id}")
        
        session_data = rag_sessions[session_id]
        rag_session = session_data["rag"]
        
        # Process any new files
        if files_data:
            for file_info in files_data:
                try:
                    file_obj, file_name, file_type = base64_to_file(
                        file_info["fileData"],
                        file_info["fileName"],
                        file_info.get("fileType", "application/octet-stream"),
                    )
                    
                    # Skip if file already processed
                    if file_name in session_data["files"]:
                        logger.info(f"File {file_name} already in session, skipping")
                        continue
                    
                    # Process the file
                    file_obj.stream.seek(0)
                    content = file_obj.stream.getvalue()
                    logger.info(f"Processing file: {file_name}, size: {len(content)} bytes")
                    
                    if not content:
                        logger.warning(f"Empty file: {file_name}")
                        continue
                    
                    # Write to temporary file for processing
                    with tempfile.NamedTemporaryFile(
                        mode="wb", delete=True, suffix=os.path.splitext(file_name)[1]
                    ) as tmp:
                        tmp.write(content)
                        tmp.flush()
                        
                        with open(tmp.name, "rb") as temp_file:
                            file_storage = FileStorage(
                                stream=temp_file,
                                filename=file_name,
                                content_type=file_type,
                            )
                            
                            # Add document to RAG session
                            result = rag_session.add_file(
                                file=file_storage,
                                chunk_size=220,
                                overlap=40
                            )
                            
                            if result["success"]:
                                session_data["files"].append(file_name)
                                logger.info(f"Added file to session: {file_name}")
                            else:
                                logger.error(f"Failed to add file: {result.get('error')}")
                    
                    if hasattr(file_obj, "close"):
                        file_obj.close()
                        
                except Exception as e:
                    logger.error(f"Error processing file {file_info.get('fileName')}: {str(e)}")
                    continue
        
        # Get user query from last message
        last_message = message_history[-1]
        user_query = last_message["content"]
        
        # Check if session has any documents
        if not session_data["files"]:
            return JSONResponse(
                {"error": "No documents in session. Please upload files first."},
                status_code=400
            )
        
        # Query the RAG session
        rag_result = rag_session.ask(
            query=user_query,
            top_k=5,
            n_candidates=15,
            lambda_param=0.7,
            stream=stream
        )
        
        if not rag_result["success"]:
            raise ValueError(rag_result.get("error", "Failed to query RAG session"))
        
        if stream:
            def stream_response():
                try:
                    for chunk in rag_result["stream"]:
                        yield chunk
                except Exception as e:
                    logger.error(f"Streaming error: {str(e)}")
                    yield f"Error: {str(e)}"
                finally:
                    # Clean up session after streaming completes
                    if session_id in rag_sessions:
                        rag_sessions[session_id]["rag"].close()
                        del rag_sessions[session_id]
                        logger.info(f"Cleaned up RAG session after request: {session_id}")
            
            return StreamingResponse(
                stream_response(),
                media_type="text/event-stream",
            )
        else:
            response = JSONResponse({"response": rag_result["answer"]})
            # Clean up session after non-streaming response
            if session_id in rag_sessions:
                rag_sessions[session_id]["rag"].close()
                del rag_sessions[session_id]
                logger.info(f"Cleaned up RAG session after request: {session_id}")
            return response
            
    except ValueError as ve:
        return JSONResponse({"error": str(ve)}, status_code=400)
    except Exception as e:
        logger.error(f"RAG chain error: {str(e)}", exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("/local_rag_chain")
async def local_rag_chain_endpoint(request: Request):
    """
    Endpoint to handle RAG chain requests using pre-computed context.

    Expects JSON with fields:
      - model: The LLM model to use
      - messages: Array of conversation messages
      - query: The user query to be appended to the prompt
      - localContext: Pre-computed context (e.g., a JSON array or a string) to inject into the prompt
    """
    try:
        data = await request.json()

        # Validate required fields
        if not data.get("model") or not data.get("messages"):
            return JSONResponse(
                {"error": "Missing required parameters (model or messages)"},
                status_code=400,
            )
        if not data.get("query") or not data.get("localContext"):
            return JSONResponse(
                {"error": "Missing query or localContext"},
                status_code=400,
            )

        model = data["model"]
        message_history = data["messages"]
        query = data["query"]
        local_context = data["localContext"]

        # Format context properly - extract text from chunks
        if isinstance(local_context, dict) and "context" in local_context:
            context_chunks = local_context["context"]
        else:
            context_chunks = local_context if isinstance(local_context, list) else []
        
        # Format context as clean text without chunk markers
        formatted_context = "\n\n".join([
            chunk["text"] if isinstance(chunk, dict) else str(chunk)
            for chunk in context_chunks
        ]) if context_chunks else ""

        # Use the same grounded prompt style as SessionRAG
        prompt = (
            "You are a helpful AI assistant. You MUST follow these rules strictly:\n\n"
            "1. Answer ONLY using the information provided in the context below.\n"
            "2. If the answer is not clearly supported by the context, say 'I don't know based on the provided context.'\n"
            "3. Do not make assumptions or add information not present in the context.\n"
            "4. Be concise and direct in your answer.\n"
            "5. Do NOT mention chunk numbers or reference markers in your response.\n\n"
            "Context:\n"
            f"{formatted_context}\n\n"
            f"User question: {query}\n\n"
            "Answer:"
        )

        # Replace the content of the last message with the constructed prompt.
        last_message = message_history[-1]
        last_message["content"] = prompt

        # Set streaming mode; adjust if you want a non-streaming response.
        stream = True
        if stream:
            def stream_ollama():
                try:
                    stream_resp = ollama.chat(model=model, messages=message_history, stream=True)
                    for chunk in stream_resp:
                        if content := chunk.get("message", {}).get("content"):
                            yield content
                except Exception as e:
                    logger.error(f"Streaming error: {e}")
                    yield "Error during response generation"
            
            return StreamingResponse(
                stream_ollama(),
                media_type="text/event-stream",
            )
        else:
            # If not streaming, call the synchronous version.
            response = ollama.chat(model=model, messages=message_history)
            return JSONResponse({"response": response["message"]["content"]})
    except Exception as e:
        logger.error(f"Error in local_rag_chain endpoint: {str(e)}", exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("/rag_session/clear")
async def clear_rag_session(request: Request):
    """
    Clear all documents from a RAG session.
    
    Expects JSON with:
      - sessionId: The chat session ID to clear
    """
    try:
        data = await request.json()
        session_id = data.get("sessionId")
        
        if not session_id:
            return JSONResponse(
                {"error": "Missing sessionId"},
                status_code=400
            )
        
        if session_id in rag_sessions:
            # Close and cleanup the session
            rag_sessions[session_id]["rag"].close()
            del rag_sessions[session_id]
            logger.info(f"Cleared RAG session: {session_id}")
            return JSONResponse({"success": True, "message": "Session cleared"})
        else:
            return JSONResponse({"success": True, "message": "Session not found"})
            
    except Exception as e:
        logger.error(f"Error clearing session: {str(e)}", exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/rag_session/info")
async def get_rag_session_info(session_id: str):
    """
    Get information about a RAG session.
    
    Query params:
      - session_id: The chat session ID
    """
    try:
        if session_id in rag_sessions:
            session_data = rag_sessions[session_id]
            return JSONResponse({
                "success": True,
                "sessionId": session_id,
                "filesCount": len(session_data["files"]),
                "files": session_data["files"]
            })
        else:
            return JSONResponse({
                "success": True,
                "sessionId": session_id,
                "filesCount": 0,
                "files": []
            })
            
    except Exception as e:
        logger.error(f"Error getting session info: {str(e)}", exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)