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
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D
from sklearn.decomposition import PCA
import json
import pickle
import traceback

# Use standard logger that goes to stdout/st
#derr
logger = logging.getLogger("model_selector")

# Configuration
CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "mxbai-embed-large")
COLLECTION_NAME = os.environ.get("COLLECTION_NAME", "llmms_catalogue")
MAX_INIT_RETRIES = int(os.environ.get("MAX_INIT_RETRIES", "3"))
RETRY_DELAY = int(os.environ.get("RETRY_DELAY", "5"))  # seconds
NUMBER_OF_QUESTIONS = int(os.environ.get("NUMBER_OF_QUESTIONS", "100"))



# Default directory for CSV files
DEFAULT_CSV_DIRECTORY = os.environ.get(
    "CSV_DIRECTORY", "/home/konstantinkrasovitskiy/METALLM/truthful_qa/generation"
)

# Parquet file with questions
QUESTION_PARQUET = os.environ.get(
    "QUESTION_PARQUET",
    "/home/konstantinkrasovitskiy/METALLM/truthful_qa/generation/validation-00000-of-00001.parquet",
)

# Cache file for collection data
COLLECTION_CACHE_FILE = os.environ.get(
    "COLLECTION_CACHE_FILE", 
    "/home/konstantinkrasovitskiy/model_selector_cache.pkl"
)

# Global persistent client
_chroma_client = None
_collection = None
_is_initialized = False
_initialization_attempted = False

# Simple fallback for import time to avoid circular dependency
DEFAULT_MODELS = ["llama3.1:latest", "gemma3:27b", "qwen2.5:latest"]


def save_collection_cache(collection_data, cache_file=COLLECTION_CACHE_FILE):
    """Save collection data to cache file"""
    try:
        logger.info(f"Saving collection cache to: {cache_file}")
        
        # Create directory if it doesn't exist
        cache_dir = os.path.dirname(cache_file)
        if cache_dir and not os.path.exists(cache_dir):
            os.makedirs(cache_dir, exist_ok=True)
        
        with open(cache_file, 'wb') as f:
            pickle.dump(collection_data, f)
        
        logger.info(f"Collection cache saved successfully. Size: {len(collection_data['embeddings'])} embeddings")
        return True
        
    except Exception as e:
        logger.error(f"Error saving collection cache: {e}")
        return False


def load_collection_cache(cache_file=COLLECTION_CACHE_FILE):
    """Load collection data from cache file"""
    try:
        if not os.path.exists(cache_file):
            logger.info(f"Cache file not found: {cache_file}")
            return None
        
        logger.info(f"Loading collection cache from: {cache_file}")
        
        with open(cache_file, 'rb') as f:
            collection_data = pickle.load(f)
        
        logger.info(f"Collection cache loaded successfully. Size: {len(collection_data['embeddings'])} embeddings")
        return collection_data
        
    except Exception as e:
        logger.error(f"Error loading collection cache: {e}")
        return None


def is_cache_valid(cache_file=COLLECTION_CACHE_FILE):
    """Check if cache file exists and is newer than CSV files"""
    try:
        if not os.path.exists(cache_file):
            return False
        
        cache_mtime = os.path.getmtime(cache_file)
        
        # Check if any CSV file is newer than cache
        csv_files = find_v2_csv_files()
        for csv_file in csv_files:
            if os.path.getmtime(csv_file) > cache_mtime:
                logger.info(f"CSV file {csv_file} is newer than cache, invalidating cache")
                return False
        
        # Check if parquet file is newer than cache
        if os.path.exists(QUESTION_PARQUET):
            if os.path.getmtime(QUESTION_PARQUET) > cache_mtime:
                logger.info(f"Question parquet file is newer than cache, invalidating cache")
                return False
        
        logger.info("Cache is valid and up to date")
        return True
        
    except Exception as e:
        logger.error(f"Error checking cache validity: {e}")
        return False


def populate_collection_from_cache(collection, collection_data):
    """Populate ChromaDB collection from cached data"""
    try:
        logger.info("Populating collection from cached data...")
        
        embeddings = collection_data['embeddings']
        documents = collection_data['documents']
        ids = collection_data['ids']
        
        # Add to collection in batches to avoid memory issues
        batch_size = 100
        for i in range(0, len(embeddings), batch_size):
            end_idx = min(i + batch_size, len(embeddings))
            
            collection.add(
                ids=ids[i:end_idx],
                embeddings=embeddings[i:end_idx],
                documents=documents[i:end_idx]
            )
            
            if (end_idx) % 100 == 0:
                logger.info(f"Added {end_idx}/{len(embeddings)} cached embeddings to collection")
        
        logger.info(f"Successfully populated collection with {len(embeddings)} cached embeddings")
        return True
        
    except Exception as e:
        logger.error(f"Error populating collection from cache: {e}")
        return False


def clear_cache(cache_file=COLLECTION_CACHE_FILE):
    """Clear the collection cache file"""
    try:
        if os.path.exists(cache_file):
            os.remove(cache_file)
            logger.info(f"Cache file cleared: {cache_file}")
            return True
        else:
            logger.info(f"Cache file doesn't exist: {cache_file}")
            return False
    except Exception as e:
        logger.error(f"Error clearing cache: {e}")
        return False


def get_cache_info(cache_file=COLLECTION_CACHE_FILE):
    """Get information about the cache file"""
    try:
        if not os.path.exists(cache_file):
            return {
                'exists': False,
                'size_mb': 0,
                'modified_time': None,
                'valid': False
            }
        
        size_bytes = os.path.getsize(cache_file)
        size_mb = size_bytes / (1024 * 1024)
        modified_time = os.path.getmtime(cache_file)
        
        return {
            'exists': True,
            'size_mb': size_mb,
            'size_bytes': size_bytes,
            'modified_time': modified_time,
            'modified_time_str': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(modified_time)),
            'valid': is_cache_valid(cache_file)
        }
        
    except Exception as e:
        logger.error(f"Error getting cache info: {e}")
        return {'exists': False, 'error': str(e)}

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
    """
    Build the vector index: question embeddings -> best models for that question
    
    This creates a searchable index where:
    - Vector: embedding of the question
    - Document: ranked list of models that performed best on this question
    """
    try:
        count = collection.count()
        if count > 0:
            logger.info(f"Vector index already contains {count} questions. Skipping.")
            return
    except Exception as e:
        logger.error(f"Error checking collection: {e}")

    # Try to load from cache first
    if is_cache_valid():
        logger.info("Valid cache found, attempting to load from cache...")
        collection_data = load_collection_cache()
        
        if collection_data:
            success = populate_collection_from_cache(collection, collection_data)
            if success:
                logger.info("Successfully initialized collection from cache!")
                return
            else:
                logger.warning("Failed to load from cache, rebuilding...")

    # Build from scratch if no cache or cache failed
    try:
        # Get question -> best_models mapping
        question_stats = _parse_csvs()

        if not question_stats:
            logger.warning("No performance data to build index from")
            return

        logger.info(f"Building vector index for {len(question_stats)} questions...")

        # Prepare data for caching
        cache_data = {
            'embeddings': [],
            'documents': [],
            'ids': []
        }

        for i, entry in enumerate(question_stats):
            question_text = entry["question"]
            best_models = entry["models"]  # Already sorted by performance
            
            try:
                # Create embedding for this question
                question_embedding = ollama.embed(
                    model=EMBEDDING_MODEL, 
                    input=question_text
                ).get("embeddings", [])

                if not question_embedding:
                    logger.warning(f"Failed to embed question {i}")
                    continue

                # Store: question_embedding -> best_models_for_this_question
                collection.add(
                    ids=[str(i)],
                    embeddings=question_embedding,
                    documents=[str(best_models)]  # Serialized model rankings
                )

                # Also store for caching
                cache_data['embeddings'].append(question_embedding[0])
                cache_data['documents'].append(str(best_models))
                cache_data['ids'].append(str(i))

                if (i + 1) % 10 == 0:
                    logger.info(f"Indexed {i+1}/{len(question_stats)} questions")

            except Exception as e:
                logger.error(f"Error indexing question {i}: {str(e)}")

        logger.info("Vector index built successfully!")
        
        # Save to cache for next time
        if cache_data['embeddings']:
            save_collection_cache(cache_data)

    except Exception as e:
        logger.error(f"Error building vector index: {str(e)}")


def extract_model_name_from_filename(filename):
    """Extract clean model name from CSV filename"""
    basename = os.path.basename(filename)
    # Remove 'v2.csv' and '_evaluation_results' suffixes
    if basename.endswith('v2.csv'):
        basename = basename[:-6]  # Remove 'v2.csv'
    if basename.endswith('_evaluation_results'):
        basename = basename[:-19]  # Remove '_evaluation_results'
    return basename

def get_available_models():
    """Get list of available models from CSV files"""
    try:
        csv_files = find_v2_csv_files()
        models = [extract_model_name_from_filename(f) for f in csv_files]
        if models:
            logger.info(f"Available models from CSV files: {models}")
        return models
    except Exception as e:
        logger.warning(f"Error getting available models: {e}")
        return []

def _parse_csvs(
    csv_files=None, number_of_questions: int = NUMBER_OF_QUESTIONS
) -> List[Dict]:
    """
    Parse CSV files to build question -> best_models mapping
    
    For each question, we collect all model performances and rank them by score.
    This creates a training dataset for our vector search.
    """
    question_models = {}

    try:
        if csv_files is None:
            csv_files = find_v2_csv_files()

        if not csv_files:
            logger.warning("No CSV files to process.")
            return []

        # Load questions from parquet
        data = pd.read_parquet(QUESTION_PARQUET).head(number_of_questions)
        data = data[["question"]].dropna().reset_index(drop=True)
        
        logger.info(f"Processing {len(data)} questions from {len(csv_files)} model CSV files")

        # For each CSV file (one per model)
        for file in csv_files:
            model_name = extract_model_name_from_filename(file)
            
            try:
                df = pd.read_csv(file)
            except Exception as e:
                logger.error(f"Error reading {file}: {str(e)}")
                continue

            if df.empty:
                logger.warning(f"Empty dataframe for {file}")
                continue

            logger.info(f"Processing model: {model_name}")

            # For each question, get this model's performance
            for idx, row in df.iterrows():
                if idx >= number_of_questions:
                    break

                question = data.loc[idx, "question"]

                if question not in question_models:
                    question_models[question] = []

                # Store model performance for this question
                question_models[question].append({
                    "model": model_name,
                    "reward": row["reward"],
                    "tokens_used": row["tokens_used"],
                    "efficiency": row["reward"] / row["tokens_used"]  # Performance score
                })

        # For each question, sort models by performance (best first)
        result = []
        for question, models in question_models.items():
            # Sort by efficiency (reward/tokens_used ratio)
            sorted_models = sorted(
                models, 
                key=lambda x: x["efficiency"], 
                reverse=True
            )
            
            result.append({
                "question": question,
                "models": sorted_models  # Best models first
            })

        logger.info(f"Built performance index for {len(result)} questions")
        return result

    except Exception as e:
        logger.error(f"Error parsing CSVs: {str(e)}")
        return []

def get_suitable_models(
    question: str, use_retrieval: bool = False, default_count: int = 3
) -> List[str]:
    """
    Find best models for a new question using vector similarity search
    
    Process:
    1. Embed the new question
    2. Find most similar question(s) in our index
    3. Return the models that performed best on those similar questions
    """
    logger.info(f"Finding best models for: '{question[:50]}...'")

    # Get dynamic default models from available CSV files
    available_models = get_available_models()
    default_models = available_models[:default_count] if available_models else DEFAULT_MODELS[:default_count]

    collection = get_collection()
    if collection is None:
        logger.warning("Vector index not available, using defaults")
        return default_models

    try:
        # Step 1: Embed the new question
        logger.debug(f"Embedding new question using {EMBEDDING_MODEL}")
        query_emb = ollama.embed(model=EMBEDDING_MODEL, input=question).get("embeddings", [])

        if not query_emb:
            logger.error("Failed to generate embeddings for the question")
            logger.warning(f"Using default models due to embedding failure: {default_models}")
            return default_models

        # Step 2: Find most similar question in our index
        logger.debug("Searching for similar questions in vector index")
        results = collection.query(query_embeddings=query_emb, n_results=1)

        if not results or not results["documents"] or not results["documents"][0]:
            logger.warning(f"No similar questions found in index, using defaults: {default_models}")
            return default_models

        # Step 3: Parse the best models for the similar question
        best_models_str = results["documents"][0][0]
        logger.debug(f"Found similar question with models: {best_models_str[:100]}...")

        try:
            best_models = eval(best_models_str)
        except Exception as parse_err:
            logger.error(f"Error parsing model rankings: {parse_err}")
            return default_models

        # Extract model names (already sorted by performance)
        model_names = [model["model"] for model in best_models]
        logger.info(f"Models ranked by performance: {model_names}")

        # Apply retrieval optimization if needed
        if use_retrieval:
            # Prioritize models good for RAG/retrieval tasks
            retrieval_friendly = ["llama3.1:latest", "qwen2.5:latest"]
            
            for model in reversed(retrieval_friendly):
                if model in model_names:
                    model_names.remove(model)
                    model_names.insert(0, model)

            selected = model_names[:default_count]
            logger.info(f"Retrieval-optimized selection: {selected}")
            return selected
        else:
            selected = model_names[:default_count]
            logger.info(f"Best models for this question: {selected}")
            return selected

    except Exception as e:
        logger.error(f"Error in vector search: {str(e)}")
        logger.warning(f"Using fallback models due to error: {default_models}")
        return default_models


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


def main():
    """Main function to test the model selector functionality"""
    print("=" * 60)
    print("TESTING MODEL SELECTOR")
    print("=" * 60)

    # Test 1: Show what models we can extract from filenames
    print("\n1. Testing model name extraction...")
    csv_files = find_v2_csv_files()
    available_models = get_available_models()
    print(f"Found {len(csv_files)} CSV files")
    print(f"Extracted model names: {available_models}")
    for i, file in enumerate(csv_files[:5]):
        model_name = extract_model_name_from_filename(file)
        print(f"  {os.path.basename(file)} -> {model_name}")
    if len(csv_files) > 5:
        print(f"  ... and {len(csv_files) - 5} more files")

    # Test 2: Initialize the system with RESET to rebuild with clean names
    print("\n2. Testing initialization with reset...")
    success = initialize_once(reset=True)  # FORCE RESET
    print(f"Initialization successful: {success}")
    
    # Test 2.1: Check cache status
    print("\n2.1. Checking cache status...")
    cache_info = get_cache_info()
    print(f"Cache file exists: {cache_info['exists']}")
    if cache_info['exists']:
        print(f"Cache file size: {cache_info['size_mb']:.2f} MB")
        print(f"Cache modified: {cache_info['modified_time_str']}")
        print(f"Cache is valid: {cache_info['valid']}")
    else:
        print("No cache file found")

    # Test 3: Test with sample questions
    test_questions = [
        "What is the capital of France?",
        "Explain quantum computing in simple terms",
        "How do I sort a list in Python?",
        "What are the health benefits of exercise?",
        "Describe the process of photosynthesis",
    ]

    print("\n3. Testing model selection without retrieval...")
    for i, question in enumerate(test_questions, 1):
        print(f"\nTest {i}: {question}")
        models = get_models_for_question(question, use_retrieval=False, default_count=3)
        print(f"Recommended models: {models}")

    print("\n4. Testing model selection with retrieval...")
    for i, question in enumerate(test_questions, 1):
        print(f"\nTest {i}: {question}")
        models = get_models_for_question(question, use_retrieval=True, default_count=3)
        print(f"Recommended models (with retrieval): {models}")

    # Test 5: Test collection status
    print("\n5. Testing collection status...")
    collection = get_collection()
    if collection:
        try:
            count = collection.count()
            print(f"Collection contains {count} entries")
        except Exception as e:
            print(f"Error getting collection count: {e}")
    else:
        print("Collection is not available")

    # Test 6: Test with different default counts
    print("\n6. Testing different default counts...")
    test_question = "What is machine learning?"
    for count in [1, 2, 3, 5]:
        models = get_models_for_question(test_question, use_retrieval=False, default_count=count)
        print(f"Count {count}: {models}")

    # Test 7: Test error handling with invalid question
    print("\n7. Testing error handling...")
    try:
        models = get_models_for_question("", use_retrieval=False, default_count=3)
        print(f"Empty question result: {models}")
    except Exception as e:
        print(f"Error with empty question: {e}")

    # Test 8: Test ChromaDB connection
    print("\n8. Testing ChromaDB connection...")
    client = get_chroma_client()
    if client:
        try:
            collections = client.list_collections()
            print(f"Available collections: {collections}")
        except Exception as e:
            print(f"Error listing collections: {e}")
    else:
        print("ChromaDB client is not available")

    # Test 9: Create 3D visualization of embeddings
    print("\n9. Creating 3D visualization of embeddings...")
    collection = get_collection()
    if collection:
        try:
            # Use the same test questions for visualization
            visualization_questions = [
                "What is the capital of France?",
                "Explain quantum computing in simple terms", 
                "How do I sort a list in Python?",
                "What are the health benefits of exercise?",
                "Describe the process of photosynthesis"
            ]
            
            embeddings_3d, pca = visualize_embeddings_3d(
                collection, 
                test_questions=visualization_questions,
                save_path="llm_embeddings_3d_visualization.png"
            )
            
            if embeddings_3d is not None:
                print(f"3D visualization created successfully!")
                print(f"PCA explained variance: {pca.explained_variance_ratio_}")
                print(f"Total variance explained: {sum(pca.explained_variance_ratio_):.1%}")
            else:
                print("Failed to create 3D visualization")
                
        except Exception as e:
            print(f"Error creating visualization: {e}")
    else:
        print("Collection not available for visualization")

    # Test 10: Create model performance heatmap
    print("\n10. Creating model performance heatmap...")
    try:
        create_model_performance_heatmap("model_performance_heatmap.png")
        print("Model performance heatmap created successfully!")
    except Exception as e:
        print(f"Error creating heatmap: {e}")

    # Test 11: Cache management
    print("\n11. Testing cache management...")
    cache_info = get_cache_info()
    print(f"Final cache status:")
    print(f"  - Exists: {cache_info['exists']}")
    if cache_info['exists']:
        print(f"  - Size: {cache_info['size_mb']:.2f} MB")
        print(f"  - Modified: {cache_info['modified_time_str']}")
        print(f"  - Valid: {cache_info['valid']}")
    
    print(f"\nCache file location: {COLLECTION_CACHE_FILE}")
    print("Note: Next run will load from cache (much faster!)")

    print("\n" + "=" * 60)
    print("TESTING COMPLETED")
    print("=" * 60)

        
        logger.info(f"PCA analysis info saved to: {pca_info_path}")
        
        return embeddings_3d, pca
        
    except Exception as e:
        logger.error(f"Error creating 3D visualization: {e}")
        import traceback
        traceback.print_exc()
        return None, None


def create_model_performance_heatmap(save_path="model_performance_heatmap.png"):
    """
    Create a heatmap showing model performance across different question types
    """
    try:
        logger.info("Creating model performance heatmap...")
        
        # Get performance data
        question_stats = _parse_csvs()
        if not question_stats:
            logger.warning("No performance data available for heatmap")
            return
        
        # Extract model performance matrix
        all_models = set()
        for entry in question_stats:
            for model_data in entry['models']:
                all_models.add(model_data['model'])
        
        all_models = sorted(list(all_models))
        
        # Create performance matrix (questions x models)
        performance_matrix = []
        question_labels = []
        
        for i, entry in enumerate(question_stats[:50]):  # Show first 50 questions
            question_labels.append(f"Q{i+1}")
            row = []
            
            # Create model performance lookup for this question
            model_perf = {m['model']: m['efficiency'] for m in entry['models']}
            
            for model in all_models:
                row.append(model_perf.get(model, 0))
            
            performance_matrix.append(row)
        
        performance_matrix = np.array(performance_matrix)
        
        # Create heatmap
        fig, ax = plt.subplots(figsize=(len(all_models) * 0.8, 12))
        
        im = ax.imshow(performance_matrix, cmap='viridis', aspect='auto')
        
        # Set ticks and labels
        ax.set_xticks(range(len(all_models)))
        ax.set_xticklabels(all_models, rotation=45, ha='right')
        ax.set_yticks(range(len(question_labels)))
        ax.set_yticklabels(question_labels)
        
        # Add colorbar
        cbar = plt.colorbar(im, ax=ax)
        cbar.set_label('Efficiency (Reward/Tokens)', rotation=270, labelpad=20)
        
        ax.set_title('Model Performance Heatmap\n(Efficiency = Reward/Tokens Used)')
        ax.set_xlabel('Models')
        ax.set_ylabel('Questions')
        
        plt.tight_layout()
        plt.savefig(save_path, dpi=300, bbox_inches='tight')
        logger.info(f"Performance heatmap saved to: {save_path}")
        
    except Exception as e:
        logger.error(f"Error creating performance heatmap: {e}")

        
