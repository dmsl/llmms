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
import chromadb
from werkzeug.datastructures import FileStorage

from app.utils.file_extraction import handle_text_extraction
from app.utils.embeddings import get_ollama_embedding
from app.utils.text_utils import get_max_context_tokens

router = APIRouter()
logger = logging.getLogger(__name__)


def get_token_count(text: str) -> int:
    """Approximate token count using whitespace splitting."""
    return len(text.split())


def chunk_document(text: str, chunk_size: int = 200, overlap: int = 50):
    """Splits text into chunks of approximately 'chunk_size' words with an overlap."""
    words = text.split()
    if len(words) <= chunk_size:
        return [text]
    chunks = []
    start = 0
    while start < len(words):
        end = start + chunk_size
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        if end >= len(words):
            break
        start = end - overlap  # slide with overlap
    return chunks


def save_to_chromadb(file_id, content, embedding, collection_name):
    """Save a document (or document chunk) to a ChromaDB collection."""
    collection = chroma_client.get_collection(collection_name)
    collection.add(ids=[file_id], documents=[content], embeddings=[embedding])
    return True


def retrieve_relevant_text(
    query: str, top_k: int = 3, collection_name: str = None
) -> str:
    """Retrieve relevant chunks from the specified collection using semantic search."""
    query_embedding = get_ollama_embedding(query)
    collection = chroma_client.get_collection(collection_name)
    results = collection.query(query_embeddings=[query_embedding], n_results=top_k)
    if "documents" in results and results["documents"]:
        # Flatten list-of-lists
        retrieved_texts = "\n".join(
            [doc for sublist in results["documents"] for doc in sublist]
        )
        return retrieved_texts
    return ""


def build_context(
    extracted_text: str,
    model: str,
    messages_str: str,
    file_name: str,
    collection_name: str,
) -> str:
    """Build the context to be injected into the prompt."""
    chunks = chunk_document(extracted_text, chunk_size=200, overlap=50)
    if len(chunks) == 1:
        context = f"Context:\n{chunks[0]}\n"
    else:
        for i, chunk in enumerate(chunks):
            chunk_id = f"{file_name}_chunk_{i}"
            chunk_embedding = get_ollama_embedding(chunk)
            save_to_chromadb(
                chunk_id, chunk, chunk_embedding, collection_name=collection_name
            )
        retrieved_texts = retrieve_relevant_text(
            messages_str, top_k=3, collection_name=collection_name
        )
        context = f"{retrieved_texts}"
    return context


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


# Initialize Chroma client.
chroma_client = chromadb.HttpClient(host="localhost", port=8000)


@router.post("/rag_chain")
async def rag_chain_endpoint(request: Request):
    """
    Endpoint to handle RAG chain requests with base64‑encoded file data.

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


from werkzeug.datastructures import FileStorage


def process_rag_chain(
    file, file_name: str, model: str, message_history, stream: bool = True
):
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

        # Write the in-memory content to a temporary file.
        with tempfile.NamedTemporaryFile(
            mode="wb", delete=True, suffix=os.path.splitext(file_name)[1]
        ) as tmp:
            tmp.write(content)
            tmp.flush()  # Ensure all data is written

            # Open the temporary file for reading in binary mode.
            with open(tmp.name, "rb") as temp_file:
                # Wrap the temporary file in a new FileStorage object.
                # This mimics Flask’s behavior exactly.
                file_storage = FileStorage(
                    stream=temp_file,
                    filename=file_name,
                    content_type=file.content_type,  # or pass file_type if available
                )
                extracted_text = handle_text_extraction(file_storage)

        if extracted_text.startswith("Error"):
            raise ValueError(extracted_text)

        # Create temporary ChromaDB collection
        collection_name = f"temp_collection_{uuid.uuid4()}"
        chroma_client.get_or_create_collection(name=collection_name)

        try:
            messages_str = json.dumps(message_history)
            context = build_context(
                extracted_text=extracted_text,
                model=model,
                messages_str=messages_str,
                file_name=file_name,
                collection_name=collection_name,
            )
            last_message = message_history[-1]
            prompt = (
                "You are a helpful AI assistant. Follow these instructions carefully:\n"
                "1. Use only the provided context to answer the question.\n"
                "2. Even if the context is not complete, infer the best possible answer using the given information. Do not mention any uncertainty or lack of information.\n"
                "3. Provide a clear, concise, and confident answer.\n\n"
                "Context:\n"
                f"{context}\n\n"
                "User Question:\n"
                f"{last_message['content']}\n\n"
                "Assistant:"
            )

            last_message["content"] = prompt

            if stream:
                return StreamingResponse(
                    stream_response(model, message_history),
                    media_type="text/event-stream",
                )
            else:
                response = ollama.chat(model=model, messages=message_history)
                return JSONResponse({"response": response["message"]["content"]})
        finally:
            try:
                chroma_client.delete_collection(name=collection_name)
            except Exception as e:
                logger.error(f"Failed to delete collection: {e}")
            if hasattr(file, "close"):
                file.close()
    except ValueError as ve:
        return JSONResponse({"error": str(ve)}, status_code=400)
    except Exception as e:
        logger.error(f"RAG chain error: {str(e)}", exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)


def stream_response(model: str, messages):
    """Helper generator to stream model responses."""
    try:
        stream = ollama.chat(model=model, messages=messages, stream=True)
        for chunk in stream:
            if content := chunk.get("message", {}).get("content"):
                yield content
    except Exception as e:
        logger.error(f"Streaming error: {e}")
        yield "Error during response generation"


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

        prompt = (
            "You are a helpful AI assistant. Follow these instructions strictly:\n"
            "1. Disregard any prior knowledge; use only the information in the context below.\n"
            "2. Even if some details are not explicitly mentioned in the context, infer the best possible answer.\n"
            "3. Provide a clear, concise, and confident answer without referencing missing details or uncertainty.\n\n"
            "Context:\n"
            f"{local_context}\n\n"
            "User Question:\n"
            f"{query}\n\n"
            "Assistant:"
        )

        # Replace the content of the last message with the constructed prompt.
        last_message = message_history[-1]
        last_message["content"] = prompt

        # Set streaming mode; adjust if you want a non-streaming response.
        stream = True
        if stream:
            return StreamingResponse(
                stream_response(model, message_history),
                media_type="text/event-stream",
            )
        else:
            # If not streaming, call the synchronous version.
            response = ollama.chat(model=model, messages=message_history)
            return JSONResponse({"response": response["message"]["content"]})
    except Exception as e:
        logger.error(f"Error in local_rag_chain endpoint: {str(e)}", exc_info=True)
        return JSONResponse({"error": "Internal server error"}, status_code=500)
