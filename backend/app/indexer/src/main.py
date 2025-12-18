from itertools import islice
from pprint import pprint
# from src.libs.gguf_utils.gguf_utils import compare_all_models, get_model_files_metadata
from src.libs.query_classification.query_classification import query_classification
from src.libs.system_status.system_status import get_system_status
from src.libs.model_filtering.model_filtering import filter_by_benchmark, filter_by_file_size, filter_by_memory_awareness, sort_by_memory_and_quality, useSelectedModel
from src.shared.classes import MemoryManager
from src.shared.config import IS_DEBUG, SHOULD_BE_MEMORY_AWARE, SHOULD_FIT_IN_GPU, PICK_TOP_N_MODELS, QUERY, SHOULD_USE_MEMORY_MANAGER
from src.shared.enums import SystemStatusModel
from src.libs.leaderboard_dataset.leaderboard_dataset import getBenchmarkResults, getEstimatedModelSize, load_hf_dataset
import pandas as pd
from pathlib import Path
import src.shared.config as CONFIG


from src.utils.csv_export.csv_export import export_top_models_csv

SYSTEM_STATUS = {}
MODELS = []
MEMORY_MANAGER = None

average_results = []

FAULTY_MODELS = [
    'distilbert/distilgpt2',
    'gpt2',
    'openai-community/gpt2'
    ]
MODELS_USED = []

TOP_MODELS_ROWS = []


def init():
    print("Initializing system...")
    global SYSTEM_STATUS
    global MODELS

    SYSTEM_STATUS = get_system_status()
    MODELS = load_hf_dataset()
    if SHOULD_USE_MEMORY_MANAGER:
        global MEMORY_MANAGER
        MEMORY_MANAGER = MemoryManager()

    print("System initialized.\n")
    # MODELS = get_model_files_metadata()

def getIndexerModels(query): 
    global QUERY

    QUERY = query

    # print("Models loaded:", len(MODELS))
    # 2. Major filtering of models based on size
    if SHOULD_FIT_IN_GPU:
        best_models = filter_by_file_size(MODELS, SYSTEM_STATUS[SystemStatusModel.GPU_AVAILABLE])
    else:
        if(SHOULD_BE_MEMORY_AWARE):
            best_models = filter_by_file_size(MODELS, SYSTEM_STATUS[SystemStatusModel.GPU_TOTAL])
        else:
            best_models = MODELS

    # print("Models after size filtering:", len(best_models))
    # 3. Classify query
    query_categories = query_classification(QUERY)

    # 4. Filtering based on benchmarks
    best_models = filter_by_benchmark(best_models, query_categories)

    # 5. Sort based on memory and quality importance
    sorted_models = sort_by_memory_and_quality(best_models, MEMORY_MANAGER)

    # 6. Sort, and return top N
    top_n = sorted_models[:PICK_TOP_N_MODELS]

    average_suitability = sum(model.suitability for model in top_n) / len(top_n) if top_n else 0
    average_size = sum(model.size for model in top_n) / len(top_n) if top_n else 0
    average_results.append(
        {
            "query": QUERY,
            "average_suitability": average_suitability,
            "average_size": average_size
        }
    )

    # export_top_models_csv(top_n, SYSTEM_STATUS, QUERY)

    # 7. Memory awareness filtering
    # if SHOULD_BE_MEMORY_AWARE and SHOULD_USE_MEMORY_MANAGER:
    #     for model in sorted_models:
    #         # Copy only fullname and suitability
    #         attrs = {k: v for k, v in vars(model).items() if k == "fullname" or k == "suitability" or k == "size"}
    #         # pprint(attrs)
    #     try:
    #         top_model = filter_by_memory_awareness(sorted_models, MEMORY_MANAGER)
    #         print(top_model)
    #         return top_model
    #     except Exception as e:
    #         print(Exception)
    #         return e
    # else:
    #     top_model = top_n[0] if top_n else None
    #     # return top_model
    
    # if IS_DEBUG:
    #     debugPrints(top_n, top_n[0])
    return sorted_models


# def debugPrints(top_n, top_model):
#     print("\n--- DEBUG INFO ---\n")
#     print("Memory Importance:", MEMORY_IMPORTANCE)
#     print("Quality Importance:", QUALITY_IMPORTANCE)
#     print("\n------\n")

#     # Print all top N models with final_score
#     if top_n:
#         print("Top N models (with final weighted score):")
#         for model in top_n:
#             attrs = {
#                 "fullname": model.fullname,
#                 "suitability": round(model.suitability, 4),
#                 "size": model.size,
#                 "final_score": round(model.final_score, 4),
#             }
#             pprint(attrs)

#     # Print top model
#     if top_model:
#         print("\nTop model:")
#         attrs = {
#             "fullname": top_model.fullname,
#             "suitability": round(top_model.suitability, 4),
#             "size": top_model.size,
#             "final_score": round(top_model.final_score, 4),
#         }
#         pprint(attrs)

#     # Print memory manager state
#     # if SHOULD_USE_MEMORY_MANAGER:
#     #     printMemoryState()


def debugPrints(top_n, top_model):
    print("\n--- DEBUG INFO ---\n")
    print(f"Memory Importance:  {MEMORY_IMPORTANCE}")
    print(f"Quality Importance: {QUALITY_IMPORTANCE}")
    print("\n------\n")

    def bytes_to_gb(size_in_bytes):
        return size_in_bytes / (1024**3)

    # Print all top-N models as a table
    if top_n:
        print(f"Top {PICK_TOP_N_MODELS} Models:\n")
        header = f"{'Model':40} {'Suitability':12} {'Size (GB)':10} {'Final Score':12}"
        print(header)
        print("-" * len(header))

        for m in top_n:
            size_gb = bytes_to_gb(m.size)
            print(f"{m.fullname[:40]:40} "
                  f"{m.suitability:12.4f} "
                  f"{size_gb:10.2f} "
                  f"{m.final_score:12.4f}")

    # Print top model separately
    if top_model:
        print("\nTop Model:\n")
        header = f"{'Model':40} {'Suitability':12} {'Size (GB)':10} {'Final Score':12}"
        print(header)
        print("-" * len(header))

        m = top_model
        size_gb = bytes_to_gb(m.size)
        print(f"{m.fullname[:40]:40} "
              f"{m.suitability:12.4f} "
              f"{size_gb:10.2f} "
              f"{m.final_score:12.4f}")


def loadModel(model_fullname, model_size):
    global MEMORY_MANAGER
    tokenizer, model = MEMORY_MANAGER.load_model(model_fullname, model_size)
    return tokenizer, model


def unloadModel(model_fullname):
    global MEMORY_MANAGER
    MEMORY_MANAGER.unload_model(model_fullname)

def getLoadedModel(model_id):
    global MEMORY_MANAGER
    return MEMORY_MANAGER.getLoadedModel(model_id)

def printMemoryState():
    global MEMORY_MANAGER
    MEMORY_MANAGER.print_memory_state()

# def updateUsedModels(model):
#     global MODELS_USED
#     MODELS_USED.append(model)

# def getScoresAndExportToCSV(question_index):
#     global MODELS_USED
#     global TOP_MODELS_ROWS

#     rows = export_top_models_csv(MODELS_USED, SYSTEM_STATUS, QUERY, question_index)

#     MODELS_USED = []
#     TOP_MODELS_ROWS.extend(rows)

#     return rows

def useModel(model):
    global MEMORY_MANAGER
    try:
        useSelectedModel(model, MEMORY_MANAGER)
    except Exception as e:
        # print(f"Exception in useModel: {e}")
        raise Exception
    
# if __name__ == "__main__":
    
#     # 0. get system status, load models
#     init()

#     embeddings_path = Path("src//embeddings_data.parquet")
#     embeddings_data = pd.read_parquet(embeddings_path).head(100)
#     print("Loaded embeddings_data from parquet file.\n----------------------------")
#     for idx, row in embeddings_data.iterrows():
        
#         query = row["question"]
#         getIndexerModels(query)
#         print(f"Processed query {idx}: {query}\n----------------------------")

#     final_average_suitability = sum(item["average_suitability"] for item in average_results) / len(average_results) if average_results else 0
#     final_average_size = sum(item["average_size"] for item in average_results) / len(average_results) if average_results else 0

#     print(f"Memory Importance:  {MEMORY_IMPORTANCE}")
#     print(f"Quality Importance: {QUALITY_IMPORTANCE}")

#     print(f"\nFinal Average Suitability across all queries: {final_average_suitability:.4f}")
#     print(f"Final Average Size across all queries: {final_average_size / (1024**3):.2f} GB")
#     # getIndexerModels("no")
#     # 1. get indexer model
#     # tempQuery = 'Explain the theory of relativity in simple terms.'
#     # while(True):
#     #     print("Enter your query:")
#     #     tempQuery = input()
        
#     #     getIndexerModels("no")


if __name__ == "__main__":
    CONFIG.MEMORY_IMPORTANCE = 0
    # 0. get system status, load models
    init()

    embeddings_path = Path("src//embeddings_data.parquet")
    df = pd.read_parquet(embeddings_path)
    print("Loaded embeddings_data from parquet file.\n----------------------------")

    # Stores the final averages for each MEMORY_IMPORTANCE value
    memory_importance_results = []

   

    

    while CONFIG.MEMORY_IMPORTANCE <= 100:

        print(f"\n==============================")
        print(f"Running loop with MEMORY_IMPORTANCE = {CONFIG.MEMORY_IMPORTANCE}")
        print(f"==============================\n")

        CONFIG.QUALITY_IMPORTANCE = 100 - CONFIG.MEMORY_IMPORTANCE

        # clear per-loop results
        average_results.clear()

        # -----------------------
        # Run the 100 questions
        # -----------------------
        for idx, row in df.iterrows():
            query = row["question"]
            getIndexerModels(query)
            print(f"Processed query {idx}: {query}\n----------------------------")

        # -----------------------------------
        # Compute final averages for this loop
        # -----------------------------------
        final_avg_suitability = (
            sum(item["average_suitability"] for item in average_results) /
            len(average_results)
            if average_results else 0
        )

        final_avg_size = (
            sum(item["average_size"] for item in average_results) /
            len(average_results)
            if average_results else 0
        )

        # Save the results for this memory importance value
        memory_importance_results.append({
            "memory_importance": CONFIG.MEMORY_IMPORTANCE,
            "avg_suitability": final_avg_suitability,
            "avg_size": final_avg_size
        })

        print(f"\nResults for MEMORY_IMPORTANCE={CONFIG.MEMORY_IMPORTANCE}")
        print(f"Average Suitability: {final_avg_suitability:.4f}")
        print(f"Average Size: {final_avg_size / (1024**3):.2f} GB")

        # Increase mem importance
        CONFIG.MEMORY_IMPORTANCE += 5

    # ---------------------------------------
    # Export results to CSV at the very end
    # ---------------------------------------
    output_df = pd.DataFrame(memory_importance_results)
    output_df.to_csv("memory_importance_results.csv", index=False)

    print("\n\n=================================")
    print("Saved memory_importance_results.csv")
    print("All loops completed.")
    print("=================================\n")
