import ollama
import numpy as np

EMBED_MODEL = "nomic-embed-text"


def get_ollama_embedding(text, model=None):
    """
    Use Ollama to get an embedding for the provided text.
    
    Args:
        text: Text to embed
        model: Optional model name (defaults to EMBED_MODEL)
    
    Returns:
        List of floats representing the embedding
    """
    try:
        embedding_model = model or EMBED_MODEL
        response = ollama.embeddings(embedding_model, prompt=text)
        
        if response and response["embedding"]:
            return response["embedding"]
        else:
            raise Exception("Embedding data not found in the response.")
    except Exception as e:
        raise Exception(f"Failed to get embedding using Ollama library: {str(e)}")


# def get_ollama_embedding_using_model(model, text):
#     """
#     Use Ollama to get an embedding for the provided text.
#     """

#     try:
#         response = ollama.embeddings(EMBED_MODEL, prompt=text)
#         # Extract and return the embedding
#         if response and response.get("embedding"):
#             return response.get("embedding")
#         else:
#             # try with default model
#             response = ollama.embeddings(EMBED_MODEL, prompt=text)
#             if response and response.get("embedding"):
#                 return response.get("embedding")
#             else:
#                 raise Exception("Embedding data not found in the response.")
#     except Exception as e:
#         raise Exception(f"Failed to get embedding using Ollama library: {str(e)}")
