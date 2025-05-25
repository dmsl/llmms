import json
import uuid
from flask import Blueprint, request, jsonify, current_app as app
import ollama
import chromadb
from app import csrf  # CSRF protection

# Import only these utility functions.
from app.utils.embeddings import get_ollama_embedding
from app.utils.text_utils import get_max_context_tokens, get_token_count

# Create a blueprint for conversation memory management.
conversation_memory_bp = Blueprint("conversation_memory_bp", __name__)

# Initialize a global ChromaDB client.
chroma_client = chromadb.HttpClient(host="localhost", port=8000)


def store_qa_pair(qa_pair, collection_name):
    """
    Store a question–answer pair in a ChromaDB collection.
    The Q/A pair is stored as a single document with a content field.
    """
    # Combine question and answer with clear labels.
    content = f"Q: {qa_pair.get('question', '')}\nA: {qa_pair.get('answer', '')}"
    embedding = get_ollama_embedding(content)
    doc_id = str(uuid.uuid4())
    collection = chroma_client.get_collection(collection_name)
    document = {"id": doc_id, "content": content, "embedding": embedding}
    collection.add([document])
    return True


def retrieve_conversation_context(query, top_k=3, collection_name=None):
    """
    Retrieve the top_k most relevant Q/A pairs (stored as documents) from the conversation memory.
    This uses the query's embedding to perform a semantic search in ChromaDB.
    """
    query_embedding = get_ollama_embedding(query)
    collection = chroma_client.get_collection(collection_name)
    results = collection.query(query_embedding, top_k=top_k)
    # Join the contents of the retrieved documents using a delimiter.
    context = "\n---\n".join([res["content"] for res in results])
    return context


@conversation_memory_bp.route("/update_conversation", methods=["POST"])
@csrf.exempt
def update_conversation():
    """
    Update conversation history by storing each Q/A tuple in ChromaDB.

    Expects JSON with a key "conversation" which is a list of Q/A dicts,
    e.g.: [{"question": "How are you?", "answer": "I'm fine."}, ...].

    A unique collection name can be provided or a new one is created.
    """
    data = request.get_json()
    conversation = data.get("conversation", [])
    # Optionally, the client can provide a collection_name to continue a session.
    collection_name = data.get("collection_name", f"conversation_{uuid.uuid4()}")
    # Create the collection if it doesn't already exist.
    chroma_client.get_or_create_collection(name=collection_name)

    for qa in conversation:
        store_qa_pair(qa, collection_name)

    return jsonify(
        {"message": "Conversation updated", "collection_name": collection_name}
    )


@conversation_memory_bp.route("/fetch_context", methods=["POST"])
@csrf.exempt
def fetch_context():
    """
    Fetch only the necessary conversation context for a new query.

    Expects JSON with:
      - "query": The user's new question.
      - "collection_name": The name of the conversation memory collection.

    Returns a concise context constructed from the most relevant Q/A pairs.
    """
    data = request.get_json()
    query = data.get("query")
    collection_name = data.get("collection_name")
    if not query or not collection_name:
        return jsonify({"error": "Query and collection_name required"}), 400

    context = retrieve_conversation_context(
        query, top_k=3, collection_name=collection_name
    )
    return jsonify({"context": context})
