import requests
import json
import logging
import os
from bs4 import BeautifulSoup
from readability.readability import Document
from flask import current_app as app
import ollama
import chromadb
import nltk
from typing import List

# Set NLTK data path to /tmp to avoid permission issues
nltk_data_dir = os.path.join('/tmp', 'nltk_data')
nltk.data.path.insert(0, nltk_data_dir)

# Lazy-load NLTK data only when needed (not at import time)
_nltk_initialized = False

def _ensure_nltk_data():
    """Download NLTK data only when first needed."""
    global _nltk_initialized
    if not _nltk_initialized:
        try:
            os.makedirs(nltk_data_dir, exist_ok=True)
            nltk.data.find('tokenizers/punkt')
        except (LookupError, OSError):
            try:
                nltk.download('punkt', quiet=True, download_dir=nltk_data_dir)
            except Exception as e:
                logging.warning(f"Failed to download NLTK data: {e}")
        _nltk_initialized = True

# Initialize a global ChromaDB client for this module.
chroma_client = chromadb.HttpClient(host="localhost", port=8000)


def get_ollama_embedding(text, model="nomic-embed-text"):
    """
    Get embeddings for a text using Ollama's embedding API.
    Args:
        text (str): The text to get embeddings for
        model (str): The model to use for embeddings (default: nomic-embed-text)
    Returns:
        list: The embedding vector
    """
    try:
        response = ollama.embeddings(model=model, prompt=text)
        return response["embeddings"]
    except Exception as e:
        logging.error(f"Error getting embeddings: {e}")
        return None


def save_to_chromadb(name, content, embedding, collection_name):
    """
    Save a document (or document chunk) to a ChromaDB collection.
    The document is stored with an 'id', 'content', and its 'embedding'.
    """
    try:
        collection = chroma_client.get_collection(collection_name)
        document = {"id": str(name), "content": content, "embedding": embedding}
        collection.add([document])
        return {"success": True, "message": "Document saved successfully to ChromaDB."}
    except Exception as e:
        error_message = f"ChromaDB error: {str(e)}"
        return {"success": False, "error": error_message}


def get_context_length(model_details):
    """
    Determine the context length based on model details.
    Returns 2048 if not found.
    """
    context_length = (
        model_details.get("model_info", {}).get("llama.context_length")
        or model_details.get("model_info", {}).get("gemma2.context_length")
        or model_details.get("model_info", {}).get("nomic-bert.context_length")
    )
    if context_length:
        return context_length
    return 8096


def get_max_context_tokens(model_name):
    """
    Retrieve the maximum context tokens for the given model using Ollama's show API.
    """
    try:
        model_info = ollama.show(model_name)
        max_context_tokens = model_info.get("context_length")
        if max_context_tokens:
            return max_context_tokens
        else:
            return None
    except Exception as e:
        return None


def get_token_count(text):
    """
    Approximate token count using whitespace splitting.
    (In production, replace with a proper tokenizer.)
    """
    return len(text.split())


def chunk_document(text, chunk_size=200, overlap=50):
    """
    Splits text into chunks of approximately 'chunk_size' words with an overlap.
    This implementation uses whitespace splitting.
    """
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


def retrieve_relevant_text(query, top_k=3, collection_name=None):
    """
    Retrieve relevant chunks from the specified ChromaDB collection using semantic search.
    Computes the query's embedding and calls the collection's query method.
    Returns the concatenated 'content' fields of the top-k results.
    """
    try:
        query_embedding = get_ollama_embedding(query)
        collection = chroma_client.get_collection(collection_name)
        # Assume collection.query() returns a list of dicts with a "content" key.
        results = collection.query(query_embedding, top_k=top_k)
        retrieved_texts = "\n---\n".join([res["content"] for res in results])
        return retrieved_texts
    except Exception as e:
        return "Error retrieving relevant text."


def web_search(user_msg, model, current_token_count=0):
    """
    Perform a web search using a local SearxNG instance.
    Fetches search results and returns concatenated, cleaned content.
    """
    try:
        model_details = ollama.show(model)
        max_tokens = get_context_length(model_details)
        query = user_msg
        if not query:
            return "Query is required"
        SEARXNG_API_URL = "http://localhost:8080/search"
        params = {"q": query, "format": "json", "categories": "general"}
        response = requests.get(SEARXNG_API_URL, params=params)
        if response.status_code != 200:
            return "Failed to fetch search results"
        search_results = response.json()
        results = search_results.get("results", [])
        cleaned_content = ""
        for result in results:
            url = result.get("url")
            if not url:
                continue
            try:
                page_response = requests.get(url, timeout=10)
                page_response.raise_for_status()
                soup = BeautifulSoup(page_response.text, "html.parser")
                doc = Document(page_response.text)
                cleaned_text = BeautifulSoup(doc.summary(), "html.parser").get_text(
                    strip=True
                )
                if not cleaned_text.strip():
                    continue
                cleaned_content += f"Source: {url}\n\n{cleaned_text}\n\n"
                token_count = len(cleaned_content.split()) + current_token_count
                if token_count >= max_tokens * 0.7:
                    break
            except Exception as e:
                continue
        if not cleaned_content:
            return "No content could be extracted from the search results"
        return cleaned_content
    except Exception as e:
        return "Internal server error occurred"


def summarize_text(text, model="mistral-small"):
    """
    Summarize text using Ollama's chat API in a single call.
    """
    try:
        response = ollama.chat(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": "Summarize the following text in bullet points",
                },
                {"role": "user", "content": text},
            ],
        )
        if response and "message" in response:
            return response["message"]["content"]
    except Exception as e:
        app.logger.error(f"Summarization failed: {str(e)}")
    return ""


def semantic_chunks(text: str, max_words: int = 220, overlap_words: int = 40) -> List[str]:
    """
    Split text into semantic chunks that preserve sentence boundaries.
    
    Args:
        text: The text to chunk
        max_words: Maximum words per chunk
        overlap_words: Number of words to overlap between chunks
    
    Returns:
        List of text chunks
    """
    # Lazy-load NLTK data only when this function is called
    _ensure_nltk_data()
    
    try:
        sentences = nltk.sent_tokenize(text)
    except Exception:
        # Fallback if NLTK fails
        sentences = text.split('. ')
    
    chunks = []
    current = []
    current_len = 0

    for sentence in sentences:
        sentence_len = len(sentence.split())
        
        if current_len + sentence_len > max_words and current:
            # Save current chunk
            chunk_text = " ".join(current)
            chunks.append(chunk_text)
            
            # Create overlap: keep last N words
            overlap_text = " ".join(chunk_text.split()[-overlap_words:])
            current = [overlap_text, sentence]
            current_len = len(overlap_text.split()) + sentence_len
        else:
            current.append(sentence)
            current_len += sentence_len

    # Add the last chunk
    if current:
        chunks.append(" ".join(current))

    return chunks if chunks else [text]
