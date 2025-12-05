#!/usr/bin/env python3
# hottest_dim_knn_pruned_cache.py  –  cosine on 64 hottest dims
# -------------------------------------------------------------
# • First run  : sentence-by-sentence embedding → vecs.npy
# • Later runs : reload vecs.npy; sketches, postings, FAISS
#               rebuilt in memory (fast) each time
# -------------------------------------------------------------

from __future__ import annotations
import os, random
from collections import defaultdict
from typing import List, Tuple

import numpy as np, faiss
from tqdm.auto import tqdm
from datasets import load_dataset
import ollama

# ============== CONFIG ==============
DATASET_NAME   = "ag_news"
DATASET_SLICE  = "train[:20000]"
TEXT_FIELD     = "text"

EMBEDDING_MODEL = "nomic-embed-text"
K_HOT           = 64          # keep exactly 64 hottest coordinates
MIN_OVERLAP     = 8           # require ≥ 8 shared hot dims to score
NUM_QUERY       = 20

CACHE_DIR       = "cache_ag_news_train[-20000]_k32_min2"   # ← keep fixed
# ====================================

os.makedirs(CACHE_DIR, exist_ok=True)

# ---------- 1 · embed helpers -------------------
def embed(text: str) -> np.ndarray:
    vec = ollama.embed(model=EMBEDDING_MODEL, input=text)["embeddings"]
    return np.asarray(vec, dtype=np.float32).ravel()

def embed_all(txts: List[str]) -> np.ndarray:
    return np.vstack([embed(t) for t in tqdm(txts, desc="Embedding")])

# ---------- 2 · hottest-k sketch -----------------
def sketch(vec: np.ndarray, k: int) -> Tuple[np.ndarray, np.ndarray, float]:
    idx = np.argpartition(-np.abs(vec), k)[:k]
    idx = idx[np.argsort(-np.abs(vec[idx]))]           # order by |v_i|
    vals = vec[idx]                                    # raw signed values
    return idx.astype(np.int16), vals.astype(np.float32), float(np.linalg.norm(vals))

def sparse_cos(q_idx, q_val, q_norm,
               d_idx, d_val, d_norm) -> float:
    """True cosine on the overlapping hot dims."""
    if q_norm == 0 or d_norm == 0:
        return 0.0
    i = j = overlap = 0
    dot = 0.0
    while i < K_HOT and j < K_HOT:
        if q_idx[i] == d_idx[j]:
            dot += q_val[i] * d_val[j]
            overlap += 1
            i += 1; j += 1
        elif q_idx[i] < d_idx[j]:
            i += 1
        else:
            j += 1
    if overlap < MIN_OVERLAP:
        return 0.0
    return dot / (q_norm * d_norm)

# ---------- 3 · load corpus ---------------------
ds    = load_dataset(DATASET_NAME, split=DATASET_SLICE)
texts = ds[TEXT_FIELD];   N = len(texts)
print(f"Corpus size : {N:,}")

# ---------- 4 · embeddings (cached) -------------
vec_path = os.path.join(CACHE_DIR, "vecs.npy")
if os.path.exists(vec_path):
    print("Loading cached embeddings …")
    vecs = np.load(vec_path)
else:
    print("Embedding corpus …")
    vecs = embed_all(texts)
    np.save(vec_path, vecs)
faiss.normalize_L2(vecs)

# ---------- 5 · build sketches ------------------
idx_mat = np.zeros((N, K_HOT), np.int16)
val_mat = np.zeros((N, K_HOT), np.float32)
l2_mat  = np.zeros(N,            np.float32)

for i, v in enumerate(vecs):
    idx_mat[i], val_mat[i], l2_mat[i] = sketch(v, K_HOT)

# ---------- 6 · posting lists -------------------
posting: defaultdict[int, list[int]] = defaultdict(list)
for vid, dims in enumerate(idx_mat):
    for d in dims:
        posting[int(d)].append(vid)

# ---------- 7 · exact cosine ground truth -------
full = faiss.IndexFlatIP(768);  full.add(vecs)

# ---------- 8 · query experiment ----------------
queries = random.sample(range(N), NUM_QUERY)

print(f"\n=== cosine on {K_HOT} hottest dims (≥{MIN_OVERLAP} overlap) vs full cosine ===")
for qid in queries:
    q_idx, q_val, q_n = idx_mat[qid], val_mat[qid], l2_mat[qid]

    # ground truth top-10
    _, gt = full.search(vecs[qid].reshape(1,-1), 10)
    gt = set(gt[0])

    # candidate IDs
    cand = {vid for d in q_idx for vid in posting[int(d)]}
    cand.discard(qid)

    # sparse cosine scoring
    scored = [
        (s, vid)
        for vid in cand
        if (s := sparse_cos(q_idx, q_val, q_n,
                            idx_mat[vid], val_mat[vid], l2_mat[vid])) > 0.0
    ]
    scored.sort(reverse=True)
    top_sparse = [vid for s, vid in scored[:10]]

    overlap = len(gt.intersection(top_sparse))
    pruned  = N - len(cand)

    print(f"• \"{texts[qid][:55]}…\"")
    print(f"  overlap in top-10 : {overlap}/10")
    print(f"  vectors scored    : {len(cand):,}  (pruned {pruned:,})\n")
