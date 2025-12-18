import pandas as pd
import os
from src.shared.config import MEMORY_IMPORTANCE, QUALITY_IMPORTANCE, IS_DEBUG, PICK_TOP_N_MODELS
from src.shared.enums import SystemStatusModel
from datetime import datetime

def export_top_models_csv(top_models, system_status, query, avg_reward=None, avg_f1=None, question_index=None):
    """
    Export top N models to a CSV including memory/quality importance, total GPU, and query.
    Saves the CSV inside an 'exported_top_models' folder in the same directory as this file.
    Filename includes GPU (GB) and importance values.
    """
    if not top_models:
        print("No models to export.")
        return

    # Extract GPU total in GB
    gpu_total_bytes = system_status.get(SystemStatusModel.GPU_TOTAL, 32 * 1024**3)
    gpu_total_gb = round(gpu_total_bytes / (1024**3), 2)

    total_reward = sum(m.reward for m in top_models if m.reward is not None)
    total_f1     = sum(m.f1 for m in top_models if m.f1 is not None)
    total_size   = sum(m.size for m in top_models)

    avg_reward = total_reward / PICK_TOP_N_MODELS if PICK_TOP_N_MODELS > 0 else None
    avg_f1     = total_f1 / PICK_TOP_N_MODELS if PICK_TOP_N_MODELS > 0 else None
    avg_size_gb = (total_size / PICK_TOP_N_MODELS) / (1024**3) if PICK_TOP_N_MODELS > 0 else None
    avg_tokens_used = sum(m.tokens_used for m in top_models) / PICK_TOP_N_MODELS if PICK_TOP_N_MODELS > 0 else None

    # Prepare data for export
    rows = []
    for rank, model in enumerate(top_models, start=1):
        rows.append({
            "rank": rank,
            "fullname": model.fullname,
            "size_bytes": model.size,
            "size_gb": round(model.size / (1024**3), 4),
            "suitability": round(model.suitability, 4),
            "final_score": round(getattr(model, "final_score", 0), 4),
            "memory_importance": MEMORY_IMPORTANCE,
            "quality_importance": QUALITY_IMPORTANCE,
            "total_gpu_gb": gpu_total_gb,
            "query": query,
            "model_reward": model.reward,
            "model_f1": model.f1,
            "avg_reward": avg_reward,
            "avg_f1": avg_f1,
            "avg_size_gb": avg_size_gb,
            "avg_tokens_used": avg_tokens_used,
            "question_index": question_index
        })

    # df = pd.DataFrame(rows)

    # # Create folder relative to this file
    # base_dir = os.path.dirname(os.path.abspath(__file__))
    # export_folder = os.path.join(base_dir, "exported_top_models")
    # # os.makedirs(export_folder, exist_ok=True)

    # # Create filename
    # timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # filename = f"top_models_{gpu_total_gb}GB_mem{MEMORY_IMPORTANCE}_qual{QUALITY_IMPORTANCE}_Q{question_index}.csv"
    # filepath = os.path.join(export_folder, filename)

    # # Export
    # df.to_csv(filepath, index=False)
    # # print(f"✅ Top {len(top_models)} models exported to {filepath}")

    return rows
