from pprint import pprint

from ...shared.config import CATEGORY_TO_BENCHMARKS, IS_DEBUG, LOADED_MODEL_BONUS, PICK_TOP_N_MODELS, GPU_SAFETY_FACTOR, SHOULD_USE_MEMORY_MANAGER, SUITABILITY_THRESHOLD
import src.shared.config as CONFIG

def filter_by_file_size(models, available_gpu):
    filtered = [model for model in models if model.size <= available_gpu * GPU_SAFETY_FACTOR]
    return filtered

def filter_by_benchmark(models, query_classification):

    # normalize query_classification to sum=1
    total = sum(query_classification.values())
    if total == 0:
        total = 1
    query_classification = {k: v / total for k, v in query_classification.items()}

    # collect all benchmark values
    benchmark_values = {b: [m.benchmarks.get(b, 0.0) for m in models]
                        for cat in query_classification
                        for b in CATEGORY_TO_BENCHMARKS.get(cat, [])}

    # compute percentiles per benchmark (rank models from best to worst based on benchmark results)
    # use these values instead of the actual results to avoid domination of one model over others
    benchmark_percentiles = {}
    for b, vals in benchmark_values.items():
        sorted_idx = sorted(range(len(vals)), key=lambda i: vals[i])
        ranks = [0] * len(vals)
        for r, i in enumerate(sorted_idx):
            ranks[i] = r / (len(vals) - 1) if len(vals) > 1 else 0.5
        benchmark_percentiles[b] = ranks

    updated_models = []
    for i, model in enumerate(models):
        suitability = 0.0
        for category, cat_w in query_classification.items():
            benchmarks = CATEGORY_TO_BENCHMARKS.get(category, [])
            if not benchmarks:
                continue
            per_bench_w = cat_w / len(benchmarks)
            for b in benchmarks:
                suitability += benchmark_percentiles[b][i] * per_bench_w
        model.suitability = suitability
        updated_models.append(model)

    return updated_models

def filter_by_memory_awareness(models, memory_manager):
    adjusted = []
    for m in models:
        bias = 0
        if memory_manager.is_model_loaded(m.fullname):
            bias = LOADED_MODEL_BONUS
        # small bump to prefer loaded models
        adjusted.append((m.fullname, m.suitability + bias, m.size, m.precision))

    # Pick highest adjusted score that fits in memory
    adjusted.sort(key=lambda x: x[1], reverse=True)
    for name, score, size, precision in adjusted:
        if memory_manager.is_model_loaded(name):
            memory_manager.mark_used(name)
            return name
        
        if memory_manager.can_load_model(size):
            try:
                memory_manager.load_model(name, size, precision)
                return name
            except Exception as e:
                # print(f"⚠️ Failed to load model {name}. Trying next best")
                continue

    # fallback: try smallest model that can be loaded
    for name, score, size, precision in sorted(adjusted, key=lambda x: x[2]):
        try:
            memory_manager.load_model(name, size, precision)
            return name
        except Exception as e:
            # print(f"⚠️ Failed to load model {name}. Trying next best")
            continue

    # if nothing works, raise an error
    raise RuntimeError("No model could be loaded")

def useSelectedModel(model, memory_manager):
    # print("useSelectedModel------------------------")
    # print("Using model:", model.fullname)
    # print(memory_manager.loaded_models.keys())
    # input()

    if memory_manager.is_model_loaded(model.fullname):
        # print(f"Model '{model.fullname}' is already loaded in GPU.")
        # input()
        memory_manager.mark_used(model.fullname)
        return model.fullname
    
    # if memory_manager.can_load_model(model.size):
    else:
        try:
            memory_manager.load_model(model.fullname, model.size, model.precision)
            return model.fullname
        except Exception as e:
            # print(f"Exception in model_filtering: {e}")
            # print(f"⚠️ Failed to load model {model.fullname}.")
            raise Exception

                



def sort_by_memory_and_quality(models, memory_manager):
    """
    Sort models by weighted importance:
    - MEMORY_IMPORTANCE: prioritize smaller models
    - QUALITY_IMPORTANCE: prioritize higher suitability
    - SHOULD_USE_MEMORY_MANAGER: if provided, gives a small bias to models already loaded in memory
    Tie-break: if scores are equal, prefer the smaller model
    Debug: prints per-model calculations if IS_DEBUG=True
    """
    if not models:
        return models
    
    # Adjust suitability with memory awareness bonus
    for m in models:
        if memory_manager.is_model_loaded(m.fullname):
            m.suitability += (m.suitability * LOADED_MODEL_BONUS / 100)
            print(f"Model {m.fullname} is loaded in memory, adding bonus to suitability.")

    # Compute min/max after bias
    sizes = [m.size for m in models]
    suits = [m.suitability for m in models]

    min_size, max_size = min(sizes), max(sizes)
    min_suit, max_suit = min(suits), max(suits)

    scored_models = []
    print(f"Sorting models by MEMORY_IMPORTANCE={CONFIG.MEMORY_IMPORTANCE}, QUALITY_IMPORTANCE={CONFIG.QUALITY_IMPORTANCE}")    
    for m in models:

        # --- Normalize size (smaller = better) ---
        size_score = 1.0 if max_size == min_size else (max_size - m.size) / (max_size - min_size)

        # --- Normalize suitability (higher = better) ---
        quality_score = 1.0 if max_suit == min_suit else (m.suitability - min_suit) / (max_suit - min_suit)

        # --- Weighted final score ---
        final_score = (
            size_score * (CONFIG.MEMORY_IMPORTANCE / 100) +
            quality_score * (CONFIG.QUALITY_IMPORTANCE / 100)
        )

        # store in model
        m.final_score = final_score

        # store for sorting: (score, size tie-breaker, model)
        scored_models.append((final_score, m.size, m))

    # Sort descending by final_score, tie-break smaller size
    scored_models.sort(key=lambda x: (x[0], -x[1]), reverse=True)

    # Return only models
    return [m for score, size, m in scored_models]