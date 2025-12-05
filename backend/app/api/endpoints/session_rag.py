"""
Privacy-first session-based RAG endpoints.

Provides API routes for:
- Creating RAG sessions
- Adding documents to sessions
- Querying sessions with advanced retrieval
- Managing session lifecycle
"""

import logging
import json
import base64
import io
from typing import Dict, Optional
from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse, StreamingResponse
from werkzeug.datastructures import FileStorage

from app.utils.rag_session import SessionRAG

router = APIRouter()
logger = logging.getLogger(__name__)

# Store active sessions (in production, use Redis or similar)
active_sessions: Dict[str, SessionRAG] = {}


def base64_to_file_storage(base64_string: str, filename: str) -> FileStorage:
    """Convert base64 string to FileStorage object."""
    try:
        file_data = base64.b64decode(base64_string)
        file_obj = io.BytesIO(file_data)
        
        # Create FileStorage object
        return FileStorage(
            stream=file_obj,
            filename=filename,
            content_type="application/octet-stream"
        )
    except Exception as e:
        logger.error(f"Error converting base64 to file: {str(e)}")
        raise


@router.post("/session_rag/create")
async def create_session(request: Request):
    """
    Create a new privacy-first RAG session.
    
    Request body:
    {
        "embedding_model": "nomic-embed-text",  // optional
        "chat_model": "mistral"  // optional
    }
    
    Returns:
    {
        "success": true,
        "session_id": "uuid",
        "message": "Session created"
    }
    """
    try:
        data = await request.json()
        
        embedding_model = data.get("embedding_model", "nomic-embed-text")
        chat_model = data.get("chat_model", "mistral")
        
        # Create new session
        rag_session = SessionRAG(
            embedding_model=embedding_model,
            chat_model=chat_model
        )
        
        session_id = rag_session.session_id
        active_sessions[session_id] = rag_session
        
        logger.info(f"Created RAG session: {session_id}")
        
        return JSONResponse({
            "success": True,
            "session_id": session_id,
            "message": "Session created successfully"
        })
        
    except Exception as e:
        logger.error(f"Error creating session: {str(e)}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)


@router.post("/session_rag/add_document")
async def add_document(request: Request):
    """
    Add a document to an existing RAG session.
    
    Request body:
    {
        "session_id": "uuid",
        "file_data": "base64_encoded_file",
        "filename": "document.pdf",
        "chunk_size": 220,  // optional
        "overlap": 40  // optional
    }
    
    Returns:
    {
        "success": true,
        "doc_id": "document.pdf",
        "chunks": 15,
        "session_id": "uuid"
    }
    """
    try:
        data = await request.json()
        
        session_id = data.get("session_id")
        file_data = data.get("file_data")
        filename = data.get("filename")
        chunk_size = data.get("chunk_size", 220)
        overlap = data.get("overlap", 40)
        
        if not session_id or not file_data or not filename:
            return JSONResponse({
                "success": False,
                "error": "Missing required fields: session_id, file_data, filename"
            }, status_code=400)
        
        # Get session
        if session_id not in active_sessions:
            return JSONResponse({
                "success": False,
                "error": f"Session {session_id} not found"
            }, status_code=404)
        
        rag_session = active_sessions[session_id]
        
        # Convert base64 to file
        file = base64_to_file_storage(file_data, filename)
        
        # Add document to session
        result = rag_session.add_file(
            file=file,
            chunk_size=chunk_size,
            overlap=overlap
        )
        
        return JSONResponse(result)
        
    except Exception as e:
        logger.error(f"Error adding document: {str(e)}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)


@router.post("/session_rag/query")
async def query_session(request: Request):
    """
    Query a RAG session with advanced retrieval.
    
    Request body:
    {
        "session_id": "uuid",
        "query": "What is the main topic?",
        "top_k": 5,  // optional, number of chunks in context
        "n_candidates": 15,  // optional, initial retrieval count
        "lambda_param": 0.7,  // optional, MMR balance (1.0=relevance, 0.0=diversity)
        "doc_filter": "document.pdf",  // optional, filter by document
        "stream": false  // optional, stream response
    }
    
    Returns (non-streaming):
    {
        "success": true,
        "answer": "The main topic is...",
        "context_chunks": 5,
        "session_id": "uuid"
    }
    """
    try:
        data = await request.json()
        
        session_id = data.get("session_id")
        query = data.get("query")
        top_k = data.get("top_k", 5)
        n_candidates = data.get("n_candidates", 15)
        lambda_param = data.get("lambda_param", 0.7)
        doc_filter = data.get("doc_filter")
        stream = data.get("stream", False)
        
        if not session_id or not query:
            return JSONResponse({
                "success": False,
                "error": "Missing required fields: session_id, query"
            }, status_code=400)
        
        # Get session
        if session_id not in active_sessions:
            return JSONResponse({
                "success": False,
                "error": f"Session {session_id} not found"
            }, status_code=404)
        
        rag_session = active_sessions[session_id]
        
        # Query session
        result = rag_session.ask(
            query=query,
            top_k=top_k,
            n_candidates=n_candidates,
            lambda_param=lambda_param,
            doc_filter=doc_filter,
            stream=stream
        )
        
        if stream and result.get("success"):
            # Return streaming response
            async def generate():
                for chunk in result["stream"]:
                    yield f"data: {json.dumps({'content': chunk})}\n\n"
            
            return StreamingResponse(
                generate(),
                media_type="text/event-stream"
            )
        else:
            return JSONResponse(result)
        
    except Exception as e:
        logger.error(f"Error querying session: {str(e)}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)


@router.get("/session_rag/stats/{session_id}")
async def get_session_stats(session_id: str):
    """
    Get statistics for a RAG session.
    
    Returns:
    {
        "session_id": "uuid",
        "document_count": 3,
        "chunk_count": 45,
        "embedding_model": "nomic-embed-text",
        "chat_model": "mistral"
    }
    """
    try:
        if session_id not in active_sessions:
            return JSONResponse({
                "success": False,
                "error": f"Session {session_id} not found"
            }, status_code=404)
        
        rag_session = active_sessions[session_id]
        stats = rag_session.get_stats()
        
        return JSONResponse({
            "success": True,
            **stats
        })
        
    except Exception as e:
        logger.error(f"Error getting stats: {str(e)}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)


@router.delete("/session_rag/close/{session_id}")
async def close_session(session_id: str):
    """
    Close a RAG session and remove all data from memory.
    
    Returns:
    {
        "success": true,
        "message": "Session closed and data removed"
    }
    """
    try:
        if session_id not in active_sessions:
            return JSONResponse({
                "success": False,
                "error": f"Session {session_id} not found"
            }, status_code=404)
        
        # Close session and cleanup
        rag_session = active_sessions[session_id]
        rag_session.close()
        
        # Remove from active sessions
        del active_sessions[session_id]
        
        logger.info(f"Closed and removed session: {session_id}")
        
        return JSONResponse({
            "success": True,
            "message": "Session closed and data removed from memory"
        })
        
    except Exception as e:
        logger.error(f"Error closing session: {str(e)}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)


@router.get("/session_rag/list")
async def list_sessions():
    """
    List all active RAG sessions.
    
    Returns:
    {
        "success": true,
        "sessions": ["uuid1", "uuid2"],
        "count": 2
    }
    """
    try:
        session_ids = list(active_sessions.keys())
        
        return JSONResponse({
            "success": True,
            "sessions": session_ids,
            "count": len(session_ids)
        })
        
    except Exception as e:
        logger.error(f"Error listing sessions: {str(e)}")
        return JSONResponse({
            "success": False,
            "error": str(e)
        }, status_code=500)
