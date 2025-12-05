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

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
import ollama
from werkzeug.datastructures import FileStorage

from app.utils.file_extraction import handle_text_extraction
from app.utils.rag_session import SessionRAG

router = APIRouter()
logger = logging.getLogger(__name__)


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

    Expects JSON with fields:
      - model: The LLM model to use
      - messages: Array of conversation messages
      - fileData: Base64 encoded file content
      - fileName: Name of the file
      - fileType: MIME type of the file (optional; defaults to application/octet-stream)
    """
    try:
        data = await request.json()
        if not data.get("model") or not data.get("messages"):
            return JSONResponse(
                {"error": "Missing required parameters (model or messages)"},
                status_code=400,
            )
        if not data.get("fileData") or not data.get("fileName"):
            return JSONResponse(
                {"error": "Missing file data or file name"},
                status_code=400,
            )
        try:
            file_obj, file_name, file_type = base64_to_file(
                data["fileData"],
                data["fileName"],
                data.get("fileType", "application/octet-stream"),
            )
        except ValueError as ve:
            return JSONResponse({"error": str(ve)}, status_code=400)

        model = data["model"]
        message_history = data["messages"]
        stream = True  # default to streaming for better UX
        return process_rag_chain(file_obj, file_name, model, message_history, stream)
    except Exception as e:
        logger.error(f"Error in RAG chain endpoint: {str(e)}", exc_info=True)
        return JSONResponse(
            {"error": "Server error processing request"}, status_code=500
        )


def process_rag_chain(
    file, file_name: str, model: str, message_history, stream: bool = True
):
    """
    Process RAG chain using the new privacy-first SessionRAG implementation
    with advanced retrieval (semantic chunking + MMR).
    """
    rag_session = None
    try:
        if not file or not file_name:
            raise ValueError("No file or empty file provided")
        if not model:
            raise ValueError("Model name is required")
        if not message_history:
            raise ValueError("Message history is required")

        # Use file.stream.getvalue() because 'file' is a FileStorage object.
        file.stream.seek(0)
        content = file.stream.getvalue()
        logger.info(f"Decoded file length: {len(content)} bytes")
        if not content:
            raise ValueError("Empty file provided")

        # Create a temporary RAG session (privacy-first, in-memory only)
        rag_session = SessionRAG(chat_model=model)
        
        # Write the in-memory content to a temporary file for processing
        with tempfile.NamedTemporaryFile(
            mode="wb", delete=True, suffix=os.path.splitext(file_name)[1]
        ) as tmp:
            tmp.write(content)
            tmp.flush()

            # Open the temporary file for reading
            with open(tmp.name, "rb") as temp_file:
                file_storage = FileStorage(
                    stream=temp_file,
                    filename=file_name,
                    content_type=file.content_type,
                )
                
                # Add document to RAG session with semantic chunking
                result = rag_session.add_file(
                    file=file_storage,
                    chunk_size=220,  # Semantic chunks with sentence boundaries
                    overlap=40
                )
                
                if not result["success"]:
                    raise ValueError(result.get("error", "Failed to process document"))

        # Get the user's question from last message
        last_message = message_history[-1]
        user_query = last_message["content"]
        
        # Query the RAG session with advanced retrieval (MMR)
        rag_result = rag_session.ask(
            query=user_query,
            top_k=5,  # Top 5 chunks after MMR reranking
            n_candidates=15,  # Consider 15 candidates before MMR
            lambda_param=0.7,  # Balance relevance (0.7) vs diversity (0.3)
            stream=stream
        )
        
        if not rag_result["success"]:
            raise ValueError(rag_result.get("error", "Failed to query RAG session"))
        
        if stream:
            # Stream the response
            def stream_with_cleanup():
                try:
                    for chunk in rag_result["stream"]:
                        yield chunk
                finally:
                    # Cleanup after streaming
                    if rag_session:
                        rag_session.close()
            
            return StreamingResponse(
                stream_with_cleanup(),
                media_type="text/event-stream",
            )
        else:
            # Return the answer directly
            answer = rag_result["answer"]
            # Cleanup
            if rag_session:
                rag_session.close()
            return JSONResponse({"response": answer})
            
    except ValueError as ve:
        if rag_session:
            rag_session.close()
        return JSONResponse({"error": str(ve)}, status_code=400)
    except Exception as e:
        logger.error(f"RAG chain error: {str(e)}", exc_info=True)
        if rag_session:
            rag_session.close()
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        if hasattr(file, "close"):
            file.close()


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

        # Use the same grounded prompt style as SessionRAG
        prompt = (
            "You are a helpful AI assistant. You MUST follow these rules strictly:\n\n"
            "1. Answer ONLY using the information provided in the context below.\n"
            "2. If the answer is not clearly supported by the context, say 'I don't know based on the provided context.'\n"
            "3. Do not make assumptions or add information not present in the context.\n"
            "4. Be concise and direct in your answer.\n\n"
            "Context:\n"
            f"{local_context}\n\n"
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
