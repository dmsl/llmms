import os
from ...shared.config import MODEL_DIR, GGUF_METADATA_SIMILARITY_THRESHOLD, UNUSED_FILES
from ...shared.enums import LLMModel
from ..git.pygguf import gguf
import numpy as np
from itertools import combinations
from sklearn.metrics.pairwise import cosine_similarity
import pandas as pd
from scipy.stats import pearsonr, spearmanr

def get_model_files_metadata():
    if not MODEL_DIR.exists():
        MODEL_DIR.mkdir(parents=True)

    all_models = [
        f for f in MODEL_DIR.iterdir()
        if f.is_file()
        and f.suffix.lower() == ".gguf"
        and UNUSED_FILES.lower() not in f.name.lower()  # ignore disabled files
    ]

    if not all_models:
        raise RuntimeError("No active GGUF files found in the specified directory.")
    
    all_models_metadata = []
    for f in all_models:
        metadata = {
            LLMModel.FILE_NAME: f.name,
            LLMModel.FILE_PATH: str(f),
            LLMModel.FILE_SIZE: f.stat().st_size
        }
        all_models_metadata.append(metadata)

    return all_models_metadata

def _load_gguf(file):
  with open(file, "rb") as f:
    metadata, tensor_info = gguf.load_gguf(f)
    all_weights = {}

    for name in tensor_info:
      all_weights[name] = gguf.load_gguf_tensor(f, tensor_info, name)

  return {"metadata": metadata, "weights": all_weights}

def _compare_metadata(meta1, meta2):
  keys1 = set(meta1.keys())
  keys2 = set(meta2.keys())
  common_keys = keys1.intersection(keys2)

  if not common_keys:
      return 0.0

  score = sum(1 for key in common_keys if meta1[key] == meta2[key])

  return score / len(common_keys)

def _compare_tensors(tensor_dict1, tensor_dict2):
    common = set(tensor_dict1.keys()).intersection(tensor_dict2.keys())
    if not common:
        return {
            "cosine": 0.0,
            "mse": np.nan,
            "mae": np.nan,
            "corr": np.nan,
            "norm_diff": np.nan,
        }

    cos_scores = []
    mse_scores = []
    mae_scores = []
    corr_scores = []
    norm_diffs = []

    for name in common:
        t1 = tensor_dict1[name].ravel()
        t2 = tensor_dict2[name].ravel()

        # Pad to match length if needed
        if t1.size > t2.size:
            t2 = np.pad(t2, (0, t1.size - t2.size))
        elif t2.size > t1.size:
            t1 = np.pad(t1, (0, t2.size - t1.size))

        t1 = np.nan_to_num(t1)
        t2 = np.nan_to_num(t2)

        # Cosine similarity
        cos = np.dot(t1, t2) / (np.linalg.norm(t1) * np.linalg.norm(t2) + 1e-12)
        cos_scores.append(cos)

        # Mean squared error
        mse = np.mean((t1 - t2) ** 2)
        mse_scores.append(mse)

        # Mean absolute error
        mae = np.mean(np.abs(t1 - t2))
        mae_scores.append(mae)

        # Pearson correlation (only if variance is non-zero)
        if np.std(t1) > 1e-12 and np.std(t2) > 1e-12:
            corr = np.corrcoef(t1, t2)[0, 1]
        else:
            corr = np.nan
        corr_scores.append(corr)

        # Difference in L2 norms
        norm_diff = abs(np.linalg.norm(t1) - np.linalg.norm(t2))
        norm_diffs.append(norm_diff)

    return {
        "cosine": np.nanmean(cos_scores),
        "mse": np.nanmean(mse_scores),
        "mae": np.nanmean(mae_scores),
        "corr": np.nanmean(corr_scores),
        "norm_diff": np.nanmean(norm_diffs),
    }

def compare_all_models(all_models):
    results = []

    all_pairs = list(combinations(all_models, 2))
    for idx, (f1, f2) in enumerate(all_pairs, start=1):
        models = {}
        models[f1] = _load_gguf(f1)
        models[f2] = _load_gguf(f2)

        print('Calculating combination', idx, '/',len(all_pairs))
        meta_score = _compare_metadata(models[f1]["metadata"], models[f2]["metadata"])
        # tensor_score = _compare_tensors(models[f1]["weights"], models[f2]["weights"])
        results.append({
            "pair": (os.path.basename(f1), os.path.basename(f2)),
            "metadata_similarity": meta_score,
            # "tensor_cosine": tensor_score["cosine"],
            # "tensor_mse": tensor_score["mse"],
            # "tensor_mae": tensor_score["mae"],
            # "tensor_corr": tensor_score["corr"],
            # "tensor_norm_diff": tensor_score["norm_diff"],
        })

    df = pd.DataFrame(results)
    df = df.sort_values(by="metadata_similarity", ascending=False).reset_index(drop=True)
    # Returns pairs that are in the same family (metadata similarity > threshold)
    df_filtered = df[df["metadata_similarity"] > GGUF_METADATA_SIMILARITY_THRESHOLD].reset_index(drop=True)

    # print_info()
    return df_filtered