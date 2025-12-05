#!/usr/bin/env python3
# compare_embeddings_ranklog.py  –  fixed model list, one combined plot
# ---------------------------------------------------------------------

from __future__ import annotations
import os, re, sys, numpy as np
from typing import List
from tqdm.auto import tqdm
from datasets import load_dataset
import matplotlib.pyplot as plt
import ollama

# ---------------- USER-SELECTED EMBEDDING MODELS --------------------
MODEL_LIST = [
    "bge-m3",
    "paraphrase-multilingual",
    "bge-large",
    "snowflake-arctic-embed2",
    "granite-embedding",
    "mxbai-embed-large",
    "nomic-embed-text",
]
# --------------------------------------------------------------------

DATASET_SLICE = "train[:1000]"              # change if you need more/less
CACHE_DIR     = "embed_cache_compare"
os.makedirs(CACHE_DIR, exist_ok=True)

def clean(name: str) -> str:
    """Filename-safe model string."""
    return re.sub(r"[^\w\-]", "_", name)

# ---------------- helpers -------------------------------------------
def embed(txt: str, model: str) -> np.ndarray:
    try:
        out = ollama.embed(model=model, input=txt)
    except Exception as e:
        print(f"✖  Cannot embed with {model}: {e}", file=sys.stderr)
        raise
    vec = out["embeddings"]
    if not vec:
        raise RuntimeError(f"{model} returned no embedding.")
    return np.asarray(vec, dtype=np.float32).ravel()

def embed_corpus(lines: List[str], model: str) -> np.ndarray:
    path = os.path.join(CACHE_DIR, f"vecs_{clean(model)}.npy")
    if os.path.exists(path):
        return np.load(path)
    print(f"→ embedding corpus with {model} …")
    arr = np.vstack([embed(t, model) for t in tqdm(lines)])
    np.save(path, arr)
    return arr
# --------------------------------------------------------------------

# ---------------- load corpus once ----------------------------------
ds     = load_dataset("ag_news", split=DATASET_SLICE)
texts  = ds["text"]
N      = len(texts)
print(f"Corpus size: {N:,}")

# ---------------- compute curves ------------------------------------
curves = {}
for model in MODEL_LIST:
    try:
        vecs      = embed_corpus(texts, model)
    except Exception:
        print(f"  → skipped {model}\n")
        continue
    mean_abs   = np.mean(np.abs(vecs), axis=0)
    curves[model] = np.sort(mean_abs)[::-1]      # rank-ordered
    print(f"  {model:<25}  dim={len(mean_abs)}   top={mean_abs.max():.4f}")

if not curves:
    sys.exit("No models produced embeddings – abort.")

# ---------------- joint rank-log plot -------------------------------
plt.figure(figsize=(10, 6))
for model, vals in curves.items():
    x = np.arange(1, len(vals) + 1)
    plt.plot(x, vals, marker=".", lw=0, label=model)

plt.yscale("log")
plt.xlabel("Rank (dims sorted by |value|)")
plt.ylabel("Mean |value|   (log scale)")
plt.title(f"Rank-ordered mean |value|  •  N={N:,} sentences")
plt.legend(fontsize=8)
plt.tight_layout()

out_png = os.path.join(CACHE_DIR, "all_models_ranklog.png")
plt.savefig(out_png, dpi=150); plt.close()

print("\nCombined plot saved →", out_png)
