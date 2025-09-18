import os
import logging
import chromadb
import pandas as pd
import ollama
from typing import List, Dict, Any, Optional
import time
import functools
import glob
import sys

# Use standard logger that goes to stdout/stderr
logger = logging.getLogger("model_selector")

# Configuration
CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "mxbai-embed-large")
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "llmms_catalogue")
MAX_INIT_RETRIES = int(os.environ.get("MAX_INIT_RETRIES", "3"))
RETRY_DELAY = int(os.environ.get("RETRY_DELAY", "5"))  # seconds
NUMBER_OF_QUESTIONS = int(os.environ.get("NUMBER_OF_QUESTIONS", "100"))

# Default models to use as fallback
DEFAULT_MODELS = ["llama3", "mistral", "qwen2"]

# Default directory for CSV files
DEFAULT_CSV_DIRECTORY = os.environ.get(
    "CSV_DIRECTORY", "/home/konstantinkrasovitskiy/METALLM/truthful_qa/generation"
)

# Parquet file with questions
QUESTION_PARQUET = os.environ.get(
    "QUESTION_PARQUET",
    "/home/konstantinkrasovitskiy/METALLM/truthful_qa/generation/validation-00000-of-00001.parquet",
)

# Global persistent client
_chroma_client = None
_collection = None
_is_initialized = False
_initialization_attempted = False


def find_v2_csv_files(directory=DEFAULT_CSV_DIRECTORY):
    """Find all *v2.csv files in the specified directory"""
    pattern = os.path.join(directory, "*v2.csv")
    csv_files = glob.glob(pattern)
    if not csv_files:
        logger.warning(f"No *v2.csv files found in {directory}")
    else:
        logger.info(
            f"Found {len(csv_files)} v2.csv files: {[os.path.basename(f) for f in csv_files]}"
        )
    return csv_files


def get_chroma_client():
    """Get a persistent ChromaDB client"""
    global _chroma_client

    if _chroma_client is None:
        try:
            logger.info(f"Connecting to ChromaDB at {CHROMA_HOST}:{CHROMA_PORT}")
            _chroma_client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
            logger.info("ChromaDB client initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize ChromaDB client: {str(e)}")
            return None

    return _chroma_client


def collection_exists(chroma_client, collection_name):
    """Check if a collection exists"""
    try:
        # Updated for Chroma v0.6.0
        collection_names = chroma_client.list_collections()
        return collection_name in collection_names
    except Exception as e:
        logger.error(f"Error checking collections: {e}")
        return False


def delete_all_collections(chroma_client):
    """Delete all collections"""
    # Updated for Chroma v0.6.0
    collection_names = chroma_client.list_collections()
    for name in collection_names:
        chroma_client.delete_collection(name)
    logger.info(f"Deleted {len(collection_names)} collections")


def get_collection(reset=False):
    """Get the collection, creating it if it doesn't exist"""
    global _collection, _is_initialized, _initialization_attempted

    # If we already have a collection and no reset requested, return it
    if _collection is not None and not reset:
        return _collection

    # If we've already attempted to initialize and failed, avoid retrying continuously
    if _initialization_attempted and not _is_initialized and not reset:
        logger.warning("Previous initialization attempt failed, skipping")
        return None

    _initialization_attempted = True

    client = get_chroma_client()
    if client is None:
        logger.error("Cannot get collection: ChromaDB client is not initialized")
        return None

    try:
        # Check if collection exists
        collection_exists_already = collection_exists(client, COLLECTION_NAME)

        if reset and collection_exists_already:
            logger.info(f"Deleting existing collection: {COLLECTION_NAME}")
            client.delete_collection(COLLECTION_NAME)
            logger.info(f"Creating new collection: {COLLECTION_NAME}")
            _collection = client.create_collection(name=COLLECTION_NAME)
        elif not collection_exists_already:
            logger.info(f"Creating new collection: {COLLECTION_NAME}")
            _collection = client.create_collection(name=COLLECTION_NAME)
        else:
            logger.info(f"Using existing collection: {COLLECTION_NAME}")
            _collection = client.get_collection(name=COLLECTION_NAME)

        # Initialize collection if it's empty
        initialize_embeddings(_collection)

        _is_initialized = True
        return _collection

    except Exception as e:
        logger.error(f"Error getting/creating collection: {str(e)}")
        _is_initialized = False
        return None


def initialize_embeddings(collection):
    """Initialize the vector database with question embeddings"""
    # Check if collection is already populated
    try:
        count = collection.count()
        if count > 0:
            logger.info(
                f"Collection already contains {count} entries. Skipping initialization."
            )
            return
    except Exception as e:
        logger.error(f"Error checking collection count: {e}")

    # Proceed with initialization if collection is empty
    try:
        question_stats = _parse_csvs()

        if not question_stats:
            logger.warning("No question stats data obtained")
            return

        logger.info(f"Generating embeddings for {len(question_stats)} questions")

        for i, question in enumerate(question_stats):
            question_text = question["question"]
            try:
                # Get embedding for the question
                question_embedding = ollama.embed(
                    model=EMBEDDING_MODEL, input=question_text
                ).get("embeddings", [])

                # Add directly to collection
                collection.add(
                    ids=[str(i)],
                    embeddings=question_embedding,
                    documents=[str(question["models"])],
                )

                if (i + 1) % 10 == 0:
                    logger.info(f"Processed {i+1} questions")

            except Exception as e:
                logger.error(f"Error embedding question '{question_text}': {str(e)}")

        logger.info("Collection populated successfully")

    except Exception as e:
        logger.error(f"Error initializing embeddings: {str(e)}")


def _parse_csvs(
    csv_files=None, number_of_questions: int = NUMBER_OF_QUESTIONS
) -> List[Dict]:
    """Parse CSV files to extract model performance data"""
    # Dictionary to store question -> model performances
    question_models = {}

    try:
        if csv_files is None:
            csv_files = find_v2_csv_files()

        if not csv_files:
            logger.warning("No CSV files to process.")
            return []

        # Load and preprocess data
        data = pd.read_parquet(QUESTION_PARQUET).head(number_of_questions)
        data = data[["question"]].dropna().reset_index(drop=True)

        # Process each CSV file
        for file in csv_files:
            model_name = (
                os.path.basename(file)
                .replace("_evaluation_results.csv", "")
                .replace("v2.csv", "")
            )

            try:
                df = pd.read_csv(file)
            except Exception as e:
                logger.error(f"Error reading {file}: {str(e)}")
                continue

            if df.empty:
                logger.warning(f"Empty dataframe for {file}")
                continue

            # Group by question and calculate average scores
            logger.info(f"Processing {file}")

            for idx, row in df.iterrows():
                if idx >= number_of_questions:
                    break

                question = data.loc[idx, "question"]

                if question not in question_models:
                    question_models[question] = []

                question_models[question].append(
                    {
                        "model": model_name,
                        "reward": row["reward"],
                        "tokens_used": row["tokens_used"],
                    }
                )

        # Sort models by reward/tokens_used ratio for each question and create final array
        result = []
        for question, models in question_models.items():
            sorted_models = sorted(
                models, key=lambda x: (x["reward"] / x["tokens_used"]), reverse=True
            )
            result.append({"question": question, "models": sorted_models})

        return result

    except Exception as e:
        logger.error(f"Error parsing CSVs: {str(e)}")
        return []


def get_suitable_models(
    question: str, use_retrieval: bool = False, default_count: int = 3
) -> List[str]:
    """
    Get suitable models for a given question based on the catalogue

    Args:
        question: The question to analyze
        use_retrieval: Whether retrieval/indexing is being used
        default_count: Number of default models to return when not initialized

    Returns:
        List of model IDs sorted by predicted performance
    """
    logger.info(
        f"Getting suitable models for question: '{question[:50]}...' (use_retrieval={use_retrieval}, default_count={default_count})"
    )

    # Define default models with slicing to ensure correct length
    default_models = DEFAULT_MODELS[:default_count]

    # Initialize collection on first request if not already initialized
    collection = get_collection()

    if collection is None:
        logger.warning(
            f"Collection not available, returning default models: {default_models}"
        )
        return default_models

    try:
        # Try to generate embedding - use a timeout to prevent hanging
        try:
            logger.debug(f"Generating embedding for question using {EMBEDDING_MODEL}")
            query_emb = ollama.embed(model=EMBEDDING_MODEL, input=question).get(
                "embeddings", []
            )
        except Exception as embed_err:
            logger.error(f"Error generating embedding: {str(embed_err)}")
            return default_models

        if not query_emb:
            logger.error("Failed to generate embeddings for the question")
            logger.warning(
                f"Using default models due to embedding failure: {default_models}"
            )
            return default_models

        # Try to query the collection
        try:
            logger.debug(f"Querying collection {COLLECTION_NAME} for similar questions")
            results = collection.query(query_embeddings=query_emb, n_results=1)
        except Exception as query_err:
            logger.error(f"Error querying collection: {str(query_err)}")
            return default_models

        if not results or not results["documents"] or not results["documents"][0]:
            logger.warning(
                f"No results found in catalogue, using default models: {default_models}"
            )
            return default_models

        # Parse the best models from the result
        best_models_str = results["documents"][0][0]
        logger.debug(
            f"Found matching question with models data: {best_models_str[:100]}..."
        )

        try:
            best_models = eval(best_models_str)
        except Exception as parse_err:
            logger.error(f"Error parsing model data: {str(parse_err)}")
            return default_models

        # Extract model names
        model_names = [model["model"] for model in best_models]
        logger.info(f"Extracted model names in order of performance: {model_names}")

        # If using retrieval, prioritize models with larger context windows and good comprehension
        if use_retrieval:
            # Models that typically have better retrieval capabilities (larger context or better comprehension)
            retrieval_friendly = ["llama3", "qwen2"]
            logger.debug(
                f"Retrieval mode active, prioritizing retrieval-friendly models: {retrieval_friendly}"
            )

            # Move retrieval-friendly models to the front, preserving their relative order
            for model in reversed(retrieval_friendly):
                if model in model_names:
                    # Move to front
                    model_names.remove(model)
                    model_names.insert(0, model)
                    logger.debug(f"Moved {model} to the front of the list")

            selected_models = model_names[:default_count]
            logger.info(f"Final prioritized models for retrieval: {selected_models}")
            return selected_models
        else:
            selected_models = model_names[:default_count]
            logger.info(f"Final selected models without retrieval: {selected_models}")
            return selected_models

    except Exception as e:
        logger.error(f"Error getting suitable models: {str(e)}", exc_info=True)
        logger.warning(f"Using fallback models due to error: {default_models}")
        return default_models  # Default fallback


def initialize_once(reset=False):
    """Ensure the collection is initialized once at startup"""
    global _is_initialized

    if not _is_initialized or reset:
        for attempt in range(MAX_INIT_RETRIES):
            try:
                collection = get_collection(reset=reset)
                if collection is not None:
                    logger.info("Successfully initialized the collection")
                    return True
            except Exception as e:
                logger.error(f"Initialization attempt {attempt+1} failed: {str(e)}")

            if attempt < MAX_INIT_RETRIES - 1:  # Don't sleep after the last attempt
                logger.info(f"Retrying in {RETRY_DELAY} seconds...")
                time.sleep(RETRY_DELAY)

        logger.error(f"Failed to initialize after {MAX_INIT_RETRIES} attempts")
        return False
    return True


# Function-based API without singleton initialization
def get_models_for_question(
    question: str, use_retrieval: bool = False, default_count: int = 3
) -> List[str]:
    """Robust wrapper to get models for a question, handling failures gracefully"""
    # Ensure collection is initialized
    if not _is_initialized and not _initialization_attempted:
        initialize_once()

    try:
        return get_suitable_models(question, use_retrieval, default_count)
    except Exception as e:
        logger.error(f"Failed to get models for question: {str(e)}")
        return DEFAULT_MODELS[:default_count]
