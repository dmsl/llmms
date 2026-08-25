import json
import math
from typing import Dict, List, Optional

import numpy as np
import ollama
from sklearn.metrics.pairwise import cosine_similarity


DEFAULT_SYSTEM_PROMPT = """You are a concise and direct assistant. Provide brief, to-the-point answers 
with minimal elaboration. Strive to be factually correct, and explicitly state 
when you are unsure. Avoid mentioning that you are an AI model or adding 
unnecessary disclaimers. Focus on clarity, correctness, and relevance above all."""

DEFAULT_MODELS = ["llama3.1", "qwen2.5", "mistral"]


def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    a_2d = a.reshape(1, -1)
    b_2d = b.reshape(1, -1)
    return float(cosine_similarity(a_2d, b_2d)[0][0])


def embed_text(embedding_model: str, text: str) -> Optional[np.ndarray]:
    if not text or not text.strip():
        return None
    emb_res = ollama.embed(model=embedding_model, input=text)
    vectors = emb_res.get("embeddings", [])
    if not vectors:
        return None
    first = vectors[0] if isinstance(vectors[0], list) else vectors
    return np.array(first, dtype=np.float32)


def generate_stream(model_name: str, question: str, num_predict: int, messages=None, system_prompt=None):
    num_predict = max(1, int(num_predict))
    if messages:
        response = ollama.chat(
            model=model_name,
            messages=messages,
            stream=True,
            options={"num_predict": num_predict},
        )
    else:
        response = ollama.generate(
            model=model_name,
            prompt=question,
            system=system_prompt or DEFAULT_SYSTEM_PROMPT,
            stream=True,
            options={"num_predict": num_predict},
        )

    output = ""
    thinking = ""
    last_eval_count = 0
    for chunk in response:
        eval_count = chunk.get("eval_count", last_eval_count)
        done_reason = chunk.get("done_reason", "unknown")

        if "message" in chunk:
            output += chunk["message"].get("content", "")
            thinking += chunk["message"].get("thinking", "")
        elif "response" in chunk:
            output += chunk.get("response", "")
            thinking += chunk.get("thinking", "")

        is_done = bool(chunk.get("done", False)) or done_reason == "stop"
        yield model_name, output, thinking, eval_count, is_done, done_reason
        if is_done:
            break
        last_eval_count = eval_count


def _inter_model_similarity(model: str, emb: np.ndarray, embeddings: Dict[str, np.ndarray], active_models: List[str]) -> float:
    others = [m for m in active_models if m != model and embeddings.get(m) is not None]
    if not others:
        return 1.0
    sims = [cosine_sim(emb, embeddings[m]) for m in others]
    return float(sum(sims) / len(sims)) if sims else 1.0


def stream_program_stepwise(
    question: str,
    start_tokens: int = 64,
    max_rounds: int = 10,
    max_tokens: int = 2048,
    custom_system_prompt: str = None,
    alpha: float = 0.7,
    beta: float = 0.3,
    dc: float = 0.5,
    models: list = None,
    embedding_model: str = "nomic-embed-text",
    messages=None,
):
    model_list = list(models) if models else list(DEFAULT_MODELS)
    if not model_list:
        yield json.dumps({"status": "error", "error": "No models provided", "done": True})
        return

    system_prompt = custom_system_prompt or DEFAULT_SYSTEM_PROMPT
    threshold = float(dc if dc is not None else 0.5)
    alpha = float(alpha)
    beta = float(beta)

    q_emb = embed_text(embedding_model, question)
    if q_emb is None:
        yield json.dumps({"status": "error", "error": "Failed to generate query embedding", "done": True})
        return

    # Paper-aligned: token chunk per model per round starts from max_tokens / N unless caller chooses smaller.
    per_model_chunk = max(1, int(start_tokens if start_tokens > 0 else max_tokens // len(model_list)))

    active_models = list(model_list)
    responses = {m: "" for m in model_list}
    thoughts = {m: "" for m in model_list}
    done_reasons = {m: "unknown" for m in model_list}
    finished = {m: False for m in model_list}
    last_eval_count = {m: 0 for m in model_list}
    generators = {
        m: generate_stream(m, question, per_model_chunk, messages=messages, system_prompt=system_prompt)
        for m in model_list
    }

    # Track paper-level budget globally.
    used_tokens_budget = 0

    yield json.dumps(
        {
            "status": "initialized",
            "models": model_list,
            "per_model_chunk_tokens": per_model_chunk,
            "max_tokens": max_tokens,
            "alpha": alpha,
            "beta": beta,
            "early_margin": threshold,
            "done": False,
        }
    )

    round_no = 0
    last_scores = {m: 0.0 for m in model_list}

    while active_models and round_no < max_rounds and used_tokens_budget < max_tokens:
        round_no += 1
        yield json.dumps(
            {
                "status": "round_start",
                "round": round_no,
                "active_models": list(active_models),
                "token_allocation": per_model_chunk,
                "used_tokens": used_tokens_budget,
                "done": False,
            }
        )

        # Strict round-robin: exactly one pull attempt per active model in this round.
        pulled_models = []
        for model in list(active_models):
            try:
                _, chunk, thinking, eval_count, is_final, done_reason = next(generators[model])
                responses[model] = chunk
                thoughts[model] = thinking
                done_reasons[model] = done_reason
                finished[model] = is_final or done_reason in {"stop", "length"}
                last_eval_count[model] = int(eval_count or 0)
                used_tokens_budget = min(max_tokens, used_tokens_budget + per_model_chunk)

                yield json.dumps(
                    {
                        "status": "model_progress",
                        "round": round_no,
                        "model": model,
                        "partial_output": chunk,
                        "partial_thinking": thinking,
                        "tokens": last_eval_count[model],
                        "done": finished[model],
                        "reason": done_reason,
                    }
                )

                pulled_models.append(model)
            except StopIteration:
                finished[model] = True
                done_reasons[model] = "finished"
                yield json.dumps(
                    {
                        "status": "model_finished",
                        "round": round_no,
                        "model": model,
                        "reason": "finished",
                        "tokens": last_eval_count[model],
                        "done": False,
                    }
                )
            except Exception as ex:
                finished[model] = True
                done_reasons[model] = "error"
                yield json.dumps(
                    {
                        "status": "model_error",
                        "round": round_no,
                        "model": model,
                        "error": str(ex),
                        "done": False,
                    }
                )

        if not pulled_models:
            break

        embeddings = {}
        scores = {}
        for model in list(active_models):
            emb = embed_text(embedding_model, responses.get(model, ""))
            if emb is None:
                scores[model] = 0.0
                yield json.dumps(
                    {
                        "status": "model_embedding_failed",
                        "round": round_no,
                        "model": model,
                        "reason": "embedding_generation_failed",
                        "done": False,
                    }
                )
                continue
            embeddings[model] = emb

        for model in list(active_models):
            emb = embeddings.get(model)
            if emb is None:
                continue
            qscore = cosine_sim(q_emb, emb)
            inter = _inter_model_similarity(model, emb, embeddings, active_models)
            score = max(0.0, alpha * qscore + beta * inter)
            scores[model] = score
            last_scores[model] = score
            yield json.dumps(
                {
                    "status": "model_scored",
                    "round": round_no,
                    "model": model,
                    "score": score,
                    "q_similarity": qscore,
                    "inter_similarity": inter,
                    "metrics": {
                        "tokens": last_eval_count.get(model, 0),
                        "done": finished.get(model, False),
                    },
                    "done": False,
                }
            )

        scored_models = [m for m in active_models if m in scores]
        if scored_models:
            best_model = max(scored_models, key=lambda m: scores[m])
            sorted_scores = sorted([scores[m] for m in scored_models], reverse=True)
            second_best = sorted_scores[1] if len(sorted_scores) > 1 else -1.0
            best_gap = scores[best_model] - second_best

            # Paper early stop: best ahead by threshold AND finished with stop.
            if best_gap > threshold and done_reasons.get(best_model) == "stop":
                yield json.dumps(
                    {
                        "status": "final_result",
                        "round": round_no,
                        "reason": "early_stopping",
                        "best_model": best_model,
                        "output": responses[best_model],
                        "thinking": thoughts[best_model],
                        "score": scores[best_model],
                        "tokens": last_eval_count[best_model],
                        "done": True,
                    }
                )
                return

            # Paper pruning: remove worst if clearly behind.
            if len(scored_models) > 1:
                worst_model = min(scored_models, key=lambda m: scores[m])
                sorted_asc = sorted([scores[m] for m in scored_models])
                second_worst = sorted_asc[1]
                if (second_worst - scores[worst_model]) > threshold:
                    active_models = [m for m in active_models if m != worst_model]
                    yield json.dumps(
                        {
                            "status": "model_pruned",
                            "round": round_no,
                            "model": worst_model,
                            "reason": "underperformer_pruned",
                            "done": False,
                        }
                    )

        # Remove finished models from active set after scoring/pruning.
        active_models = [m for m in active_models if not finished.get(m, False)]

        yield json.dumps(
            {
                "status": "round_summary",
                "round": round_no,
                "active_models": list(active_models),
                "scores": {m: last_scores.get(m, 0.0) for m in model_list},
                "used_tokens": used_tokens_budget,
                "done": False,
            }
        )

    candidate_scores = {m: last_scores.get(m, 0.0) for m in model_list if responses.get(m)}
    if candidate_scores:
        best_model = max(candidate_scores, key=lambda m: candidate_scores[m])
        reason = "tokens_or_rounds_exhausted"
        if all(done_reasons.get(m) in {"stop", "finished", "length"} for m in model_list):
            reason = "all_models_completed"
        yield json.dumps(
            {
                "status": "final_result",
                "round": round_no,
                "reason": reason,
                "best_model": best_model,
                "output": responses[best_model],
                "thinking": thoughts[best_model],
                "score": candidate_scores[best_model],
                "tokens": last_eval_count.get(best_model, 0),
                "done": True,
            }
        )
    else:
        yield json.dumps({"status": "error", "error": "No valid model responses", "done": True})
