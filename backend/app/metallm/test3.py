#!/usr/bin/env python3
# ann_multi_metrics.py  –  evaluate several truncation sizes in one go
# --------------------------------------------------------------------

from __future__ import annotations
import os, re, time, random, math, numpy as np, faiss
from typing import List
from tqdm.auto import tqdm
from datasets import load_dataset
import ollama
from scipy.stats import spearmanr

# ---------------- CONFIG -------------------------------------------------
MODEL          = "mxbai-embed-large"
DATASET_SLICE  = "train[:50000]"
CACHE_DIR      = "embed_cache_compare"
FORCE_REBUILD  = False               # True → ignore vecs_*.npy and re-embed
TRUNC_LIST     = [64, 128, 256, 512] # skip any ≥ full dim automatically

QUERY_NUM      = 1000
TOP_K          = 10
HNSW_M         = 32
EF_SEARCH      = 64
# ------------------------------------------------------------------------

os.makedirs(CACHE_DIR, exist_ok=True)
SAFE_MODEL = re.sub(r"[^\w\-]", "_", MODEL)

# ---------------- helpers ------------------------------------------------
def embed(txt: str) -> np.ndarray:
    return np.asarray(ollama.embed(model=MODEL, input=txt)["embeddings"],
                      dtype=np.float32).ravel()

def embed_corpus(texts: List[str]) -> np.ndarray:
    path = os.path.join(CACHE_DIR, f"vecs_{SAFE_MODEL}.npy")
    if FORCE_REBUILD and os.path.exists(path):
        os.remove(path)
    if os.path.exists(path):
        return np.load(path)
    arr = np.vstack([embed(t) for t in tqdm(texts, desc=f"Embed {MODEL}")])
    np.save(path, arr)
    return arr

def truncate(mat: np.ndarray, d_out: int) -> np.ndarray:
    return np.ascontiguousarray(mat[:, :d_out], dtype=np.float32)  # naïve slice

def ndcg(hit_ranks: List[int]) -> float:
    return sum(1 / math.log2(r + 1) for r in hit_ranks) / \
           sum(1 / math.log2(r + 1) for r in range(1, len(hit_ranks)+1))

# ---------------- load data & embeddings -------------------------------
texts = load_dataset("ag_news", split=DATASET_SLICE)["text"]
N     = len(texts)
full  = embed_corpus(texts);  faiss.normalize_L2(full)
D     = full.shape[1]

print(f"Corpus {N:,} sentences  •  full dim = {D}")

# ---------------- exact baseline index ----------------------------------
t0 = time.time()
exact = faiss.IndexFlatIP(D); exact.add(full)
build_exact = time.time() - t0

# ---------------- query set ---------------------------------------------
qry_ids  = random.sample(range(N), QUERY_NUM)
Q_full   = full[qry_ids]
S_ref, I_ref = exact.search(Q_full, TOP_K)

# reuse for recall@1 as well
I_ref1 = I_ref[:, :1]

# ---------------- results header ----------------------------------------
print("\n================ MULTI-SETTING BENCHMARK =============================")
print(f"{'Variant':<15}{'dim':>6}{'build(s)':>9}{'lat(ms)':>9}"
      f"{'R@10':>7}{'R@1':>7}{'P@10':>7}{'olap':>7}"
      f"{'NDCG':>8}{'ρ':>7}{'MB':>7}")

def row(label, dim, build, lat, r10, r1, p10, olap, nd, rho, mb):
    print(f"{label:<15}{dim:6}{build:9.2f}{lat:9.2f}"
          f"{r10:7.3f}{r1:7.3f}{p10:7.3f}{olap:7.2f}"
          f"{nd:8.3f}{rho:7.3f}{mb:7.0f}")

row("Exact Flat", D, build_exact, 0.0, 1.0, 1.0, 1.0, TOP_K, 1.0, 1.0,
    full.nbytes / 1e6)

# ---------------- loop over truncation sizes ----------------------------
for TRUNC_DIMS in TRUNC_LIST:
    if TRUNC_DIMS >= D:
        continue

    # build ANN index on truncated vectors
    trunc = truncate(full, TRUNC_DIMS)
    t0 = time.time()
    ann = faiss.IndexHNSWFlat(TRUNC_DIMS, HNSW_M)
    ann.hnsw.efConstruction = 200
    ann.add(trunc)
    build_hnsw = time.time() - t0
    ann.hnsw.efSearch = EF_SEARCH

    # latency
    Q_trunc = trunc[qry_ids]
    t0 = time.time()
    S_ann, I_ann = ann.search(Q_trunc, TOP_K)
    lat = (time.time() - t0) / QUERY_NUM * 1000

    # metrics
    hits10 = hits1 = overlap = ndcg_sum = rho_sum = 0
    for ex_ids, ex1, ann_ids, ex_s, ann_s in zip(I_ref, I_ref1, I_ann,
                                                 S_ref, S_ann):
        inter = set(ex_ids) & set(ann_ids)
        overlap += len(inter)
        hits10 += bool(inter)
        hits1  += bool(set(ex1) & inter)

        if inter:
            ranks = [ list(ex_ids).index(idx)+1 for idx in inter ]
            ndcg_sum += ndcg(ranks)
        rho, _ = spearmanr(ex_s, ann_s);  rho_sum += 0 if math.isnan(rho) else rho

    r10 = hits10 / QUERY_NUM
    r1  = hits1  / QUERY_NUM
    p10 = overlap / (QUERY_NUM * TOP_K)
    olp = overlap / QUERY_NUM
    nd  = ndcg_sum / hits10 if hits10 else 0.0
    rho = rho_sum / QUERY_NUM
    mb  = trunc.nbytes / 1e6

    row(f"HNSW D′={TRUNC_DIMS}", TRUNC_DIMS, build_hnsw, lat,
        r10, r1, p10, olp, nd, rho, mb)

print("======================================================================")
