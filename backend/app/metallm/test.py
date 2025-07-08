#!/usr/bin/env python3
# ---------------------------------------------------------------
# embedding_dimension_importance.py
#
#  • Requires:  numpy,  ollama-python client  ( pip install ollama )
#  • Purpose :  Inspect which coordinate dimensions of a
#               768-dim sentence embedding carry the most weight.
#               No tokeniser or per-token embeddings needed.
# ---------------------------------------------------------------

from __future__ import annotations
import numpy as np
import ollama
from typing import Tuple

# ────────────────────────────────────────────────────────────────
# 1 · BACKEND  —  adapt model name as needed
# ────────────────────────────────────────────────────────────────
EMBEDDING_MODEL = "nomic-embed-text"       # change to your Ollama model

def embed_text(text: str) -> np.ndarray:
    """
    Return a (768,) float32 NumPy array for *text* using Ollama.
    Raises RuntimeError if the backend returns nothing.
    """
    res = ollama.embed(model=EMBEDDING_MODEL, input=text)
    vec = res.get("embeddings", [])
    if not vec:
        raise RuntimeError("No embeddings returned for text")
    return np.asarray(vec, dtype=np.float32).ravel()   # ensure 1-D shape


# ────────────────────────────────────────────────────────────────
# 2 · NORMALISATION SCHEMES
# ────────────────────────────────────────────────────────────────
def l1_normalise(vec: np.ndarray, *, eps: float = 1e-12) -> np.ndarray:
    """
    |v_i| / Σ|v_j|  →  non-negative weights that sum to 1.
    Good when you want sign-agnostic “magnitude” importance.
    """
    weights = np.abs(vec)
    Z = weights.sum()
    if Z < eps:
        raise ValueError("Vector is nearly zero; cannot normalise.")
    return weights / Z


def softmax(vec: np.ndarray) -> np.ndarray:
    """
    exp(v_i) / Σ exp(v_j)  →  emphasises large positive coordinates,
    down-weights negatives, still sums to 1.
    """
    shifted = vec - vec.max()              # numerical stability
    e = np.exp(shifted)
    return e / e.sum()


# ────────────────────────────────────────────────────────────────
# 3 · TOP-k INSPECTION
# ────────────────────────────────────────────────────────────────
def topk_dims(weights: np.ndarray, k: int = 10) -> Tuple[np.ndarray, np.ndarray]:
    """
    Return (indices, weights) of the k largest coordinates.
    """
    if not (1 <= k <= weights.size):
        raise ValueError("k must be in [1, len(weights)]")
    idx = np.argpartition(-weights, k)[:k]        # fast selection
    best = weights[idx]
    order = np.argsort(-best)                     # sort descending
    return idx[order], best[order]


# ────────────────────────────────────────────────────────────────
# 4 · CLI DEMO
# ────────────────────────────────────────────────────────────────
def demo(sentence: str, k: int = 10) -> None:
    vec = embed_text(sentence)
    print("‖embedding‖₂ :", float(np.linalg.norm(vec)))

    # Choose ONE normalisation method:
    weights = l1_normalise(vec)          # sign-agnostic
    # weights = softmax(vec)             # sign-aware

    idx, w = topk_dims(weights, k)
    print(f"\nTop-{k} dimensions (index → probability weight):")
    for i, p in zip(idx, w):
        print(f"{i:3d} → {p:.5f}")

    print("\nCheck: Σ weights =", weights.sum())

if __name__ == "__main__":
    demo("The quick brown fox jumps over the lazy dog", k=10)
