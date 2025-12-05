"""
Privacy-first RAG implementation with advanced retrieval techniques.

Features:
- In-memory Chroma vector store (no persistence)
- Semantic chunking with sentence boundaries
- MMR (Maximum Marginal Relevance) for diverse retrieval
- Session-based isolation for privacy
- Multi-document support per session
"""

import logging
import uuid
from typing import List, Dict, Optional, Tuple
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
import chromadb
import ollama

from app.utils.embeddings import get_ollama_embedding
from app.utils.text_utils import semantic_chunks
from app.utils.file_extraction import handle_text_extraction

logger = logging.getLogger(__name__)


class MMRRetriever:
    """Maximum Marginal Relevance retriever for diverse results."""
    
    @staticmethod
    def rerank(
        query_vec: List[float],
        doc_vecs: List[List[float]],
        docs: List[str],
        top_k: int = 5,
        lambda_param: float = 0.7
    ) -> List[str]:
        """
        Apply MMR to rerank documents for relevance and diversity.
        
        Args:
            query_vec: Query embedding vector
            doc_vecs: List of document embedding vectors
            docs: List of document texts
            top_k: Number of documents to return
            lambda_param: Balance between relevance (1.0) and diversity (0.0)
        
        Returns:
            List of top-k documents after MMR reranking
        """
        if not docs or len(doc_vecs) == 0:
            return []
        
        query_vec = np.array(query_vec).reshape(1, -1)
        doc_vecs = np.array(doc_vecs)
        
        # Calculate similarity to query for all documents
        sim_to_query = cosine_similarity(doc_vecs, query_vec).flatten()
        
        selected = []
        candidates = list(range(len(docs)))
        
        for _ in range(min(top_k, len(docs))):
            if not candidates:
                break
            
            # Select first document based on highest similarity
            if not selected:
                idx = int(np.argmax(sim_to_query[candidates]))
                selected.append(candidates[idx])
                candidates.remove(candidates[idx])
                continue
            
            # For subsequent selections, balance relevance and diversity
            best_score = None
            best_idx = None
            
            for idx in candidates:
                # Calculate similarity to already selected documents
                selected_vecs = doc_vecs[selected]
                sim_to_selected = cosine_similarity(
                    doc_vecs[idx].reshape(1, -1),
                    selected_vecs
                ).flatten()
                max_sim_to_selected = np.max(sim_to_selected)
                
                # MMR score: relevance - diversity penalty
                score = (lambda_param * sim_to_query[idx] - 
                        (1 - lambda_param) * max_sim_to_selected)
                
                if best_score is None or score > best_score:
                    best_score = score
                    best_idx = idx
            
            if best_idx is not None:
                selected.append(best_idx)
                candidates.remove(best_idx)
        
        return [docs[i] for i in selected]


class SessionRAG:
    """
    Privacy-first RAG system with in-memory vector storage.
    
    Each session maintains its own isolated collection in RAM.
    All data is removed when the session is closed.
    """
    
    def __init__(
        self,
        session_id: Optional[str] = None,
        embedding_model: str = "nomic-embed-text",
        chat_model: str = "mistral"
    ):
        """
        Initialize a new RAG session.
        
        Args:
            session_id: Unique session identifier (auto-generated if None)
            embedding_model: Ollama model for embeddings
            chat_model: Ollama model for generation
        """
        self.session_id = session_id or str(uuid.uuid4())
        self.embedding_model = embedding_model
        self.chat_model = chat_model
        
        # Initialize in-memory Chroma client (no persistence)
        self.chroma_client = chromadb.Client()
        self.collection_name = f"session_{self.session_id}"
        
        # Create collection for this session
        self.collection = self.chroma_client.get_or_create_collection(
            name=self.collection_name,
            metadata={"hnsw:space": "cosine"}
        )
        
        self.document_count = 0
        logger.info(f"Created RAG session: {self.session_id}")
    
    def add_file(
        self,
        file,
        doc_id: Optional[str] = None,
        chunk_size: int = 220,
        overlap: int = 40
    ) -> Dict:
        """
        Add a document to the session's knowledge base.
        
        Args:
            file: File object with .filename and .save() method
            doc_id: Document identifier (uses filename if None)
            chunk_size: Maximum words per chunk
            overlap: Overlap words between chunks
        
        Returns:
            Dict with success status and metadata
        """
        try:
            doc_id = doc_id or file.filename
            
            # Extract text from file
            text = handle_text_extraction(file)
            
            if text.startswith("Error") or text.startswith("Unsupported"):
                return {
                    "success": False,
                    "error": text,
                    "doc_id": doc_id
                }
            
            # Create semantic chunks
            chunks = semantic_chunks(text, max_words=chunk_size, overlap_words=overlap)
            
            # Prepare data for batch insertion
            ids = []
            documents = []
            embeddings = []
            metadatas = []
            
            for i, chunk in enumerate(chunks):
                chunk_id = f"{doc_id}_chunk_{i}"
                
                # Get embedding
                embedding = get_ollama_embedding(chunk)
                
                ids.append(chunk_id)
                documents.append(chunk)
                embeddings.append(embedding)
                metadatas.append({
                    "doc_id": doc_id,
                    "chunk_index": i,
                    "total_chunks": len(chunks)
                })
            
            # Add all chunks to collection in batch
            self.collection.add(
                ids=ids,
                documents=documents,
                embeddings=embeddings,
                metadatas=metadatas
            )
            
            self.document_count += 1
            
            logger.info(
                f"Added document '{doc_id}' to session {self.session_id}: "
                f"{len(chunks)} chunks"
            )
            
            return {
                "success": True,
                "doc_id": doc_id,
                "chunks": len(chunks),
                "session_id": self.session_id
            }
            
        except Exception as e:
            logger.error(f"Error adding file to session: {str(e)}")
            return {
                "success": False,
                "error": str(e),
                "doc_id": doc_id
            }
    
    def ask(
        self,
        query: str,
        top_k: int = 5,
        n_candidates: int = 15,
        lambda_param: float = 0.7,
        doc_filter: Optional[str] = None,
        stream: bool = False
    ) -> Dict:
        """
        Query the RAG system with advanced retrieval.
        
        Args:
            query: User question
            top_k: Number of final chunks to use in context
            n_candidates: Initial retrieval count (before MMR)
            lambda_param: MMR balance (1.0=relevance, 0.0=diversity)
            doc_filter: Optional document ID to filter by
            stream: Whether to stream the response
        
        Returns:
            Dict with answer and metadata
        """
        try:
            # Get query embedding
            query_embedding = get_ollama_embedding(query)
            
            # Build filter if specified
            where_filter = {"doc_id": doc_filter} if doc_filter else None
            
            # Retrieve candidates from vector store
            results = self.collection.query(
                query_embeddings=[query_embedding],
                n_results=min(n_candidates, self.collection.count()),
                where=where_filter,
                include=["documents", "embeddings", "metadatas"]
            )
            
            if not results["documents"] or len(results["documents"][0]) == 0:
                return {
                    "success": False,
                    "error": "No relevant documents found",
                    "answer": "I don't have enough information to answer that question."
                }
            
            # Extract results
            docs = results["documents"][0]
            embs = results["embeddings"][0]
            metas = results["metadatas"][0]
            
            # Apply MMR reranking for diversity
            top_docs = MMRRetriever.rerank(
                query_vec=query_embedding,
                doc_vecs=embs,
                docs=docs,
                top_k=top_k,
                lambda_param=lambda_param
            )
            
            # Build context with chunk references
            context = self._format_context(top_docs)
            
            # Create grounded prompt
            prompt = self._build_grounded_prompt(context, query)
            
            # Generate response
            if stream:
                return {
                    "success": True,
                    "stream": self._generate_stream(prompt),
                    "context_chunks": len(top_docs)
                }
            else:
                answer = self._generate_response(prompt)
                return {
                    "success": True,
                    "answer": answer,
                    "context_chunks": len(top_docs),
                    "session_id": self.session_id
                }
            
        except Exception as e:
            logger.error(f"Error querying RAG: {str(e)}")
            return {
                "success": False,
                "error": str(e),
                "answer": "An error occurred while processing your question."
            }
    
    def _format_context(self, chunks: List[str]) -> str:
        """Format chunks as clean text without markers."""
        return "\n\n".join(chunks)
    
    def _build_grounded_prompt(self, context: str, query: str) -> str:
        """Build a prompt that enforces grounding and reduces hallucinations."""
        return f"""You are a helpful assistant. You MUST follow these rules strictly:

1. Answer ONLY using the information provided in the context below.
2. If the answer is not clearly supported by the context, say "I don't know based on the provided context."
3. Do not make assumptions or add information not present in the context.
4. Be concise and direct in your answer.
5. Do NOT mention chunk numbers or reference markers in your response.

Context:
{context}

User question: {query}

Answer:"""
    
    def _generate_response(self, prompt: str) -> str:
        """Generate a non-streaming response."""
        try:
            response = ollama.chat(
                model=self.chat_model,
                messages=[
                    {"role": "user", "content": prompt}
                ]
            )
            
            if response and "message" in response:
                return response["message"]["content"]
            else:
                return "Failed to generate response."
                
        except Exception as e:
            logger.error(f"Generation error: {str(e)}")
            return f"Error generating response: {str(e)}"
    
    def _generate_stream(self, prompt: str):
        """Generate a streaming response."""
        try:
            stream = ollama.chat(
                model=self.chat_model,
                messages=[
                    {"role": "user", "content": prompt}
                ],
                stream=True
            )
            
            for chunk in stream:
                if "message" in chunk and "content" in chunk["message"]:
                    yield chunk["message"]["content"]
                    
        except Exception as e:
            logger.error(f"Streaming error: {str(e)}")
            yield f"Error: {str(e)}"
    
    def get_stats(self) -> Dict:
        """Get session statistics."""
        return {
            "session_id": self.session_id,
            "document_count": self.document_count,
            "chunk_count": self.collection.count(),
            "embedding_model": self.embedding_model,
            "chat_model": self.chat_model
        }
    
    def close(self):
        """Close session and remove all data from memory."""
        try:
            self.chroma_client.delete_collection(name=self.collection_name)
            logger.info(f"Closed RAG session: {self.session_id}")
        except Exception as e:
            logger.error(f"Error closing session: {str(e)}")
    
    def __enter__(self):
        """Context manager support."""
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Ensure cleanup on context manager exit."""
        self.close()
