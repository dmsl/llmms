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


def _inter_similarity(model: str, emb: np.ndarray, embeddings: Dict[str, np.ndarray], models: List[str]) -> float:
    others = [m for m in models if m != model and embeddings.get(m) is not None]
    if not others:
        return 1.0
    sims = [cosine_sim(emb, embeddings[m]) for m in others]
    return float(sum(sims) / len(sims)) if sims else 1.0


def stream_llm_ms_mab(
    question: str,
    max_rounds: int = 127,
    total_token_budget: int = 2048,
    a=0.7,
    b=0.3,
    dc=0.3,
    models=None,
    embedding_model="nomic-embed-text",
    early_stopping_margin_ratio=None,
    custom_system_prompt=None,
    messages=None,
):
    alpha = float(a)
    beta = float(b)
    base_explore = float(dc)
    early_margin = float(early_stopping_margin_ratio if early_stopping_margin_ratio is not None else 0.5)
    system_prompt = custom_system_prompt or DEFAULT_SYSTEM_PROMPT

    model_list = list(models) if models else list(DEFAULT_MODELS)
    if not model_list:
        yield json.dumps({"status": "error", "error": "No models provided", "done": True})
        return

    q_emb = embed_text(embedding_model, question)
    if q_emb is None:
        yield json.dumps({"status": "error", "error": "Failed to generate query embedding", "done": True})
        return

    lambda_pull = max(1, total_token_budget // max(1, len(model_list) * 16))

    responses = {m: "" for m in model_list}
    thoughts = {m: "" for m in model_list}
    scores = {m: 0.0 for m in model_list}
    pulls = {m: 0 for m in model_list}
    reward_sums = {m: 0.0 for m in model_list}
    done_flags = {m: False for m in model_list}
    done_reasons = {m: "unknown" for m in model_list}
    last_eval_count = {m: 0 for m in model_list}

    generators = {
        m: generate_stream(m, question, lambda_pull, messages=messages, system_prompt=system_prompt)
        for m in model_list
    }

    used_tokens = 0
    total_pulls = 0
    round_no = 0

    yield json.dumps(
        {
            "status": "initialized",
            "models": model_list,
            "lambda_pull": lambda_pull,
            "max_rounds": max_rounds,
            "total_token_budget": total_token_budget,
            "alpha": alpha,
            "beta": beta,
            "base_explore": base_explore,
            "done": False,
        }
    )

    # Paper constraint: each arm explored at least once.
    for model in model_list:
        if used_tokens + lambda_pull > total_token_budget:
            break
        round_no += 1
        yield json.dumps({
            "status": "round_start",
            "round": round_no,
            "chosen_model": model,
            "used_tokens": used_tokens,
            "gamma": base_explore * (1 - used_tokens / max(1, total_token_budget)),
            "done": False,
        })

        try:
            _, chunk, thinking, eval_count, is_final, done_reason = next(generators[model])
            responses[model] = chunk
            thoughts[model] = thinking
            last_eval_count[model] = int(eval_count or 0)
            done_flags[model] = is_final or done_reason in {"stop", "length"}
            done_reasons[model] = done_reason
            used_tokens = min(total_token_budget, used_tokens + lambda_pull)
            total_pulls += 1
            pulls[model] += 1

            yield json.dumps({
                "status": "model_progress",
                "round": round_no,
                "model": model,
                "partial_output": chunk,
                "partial_thinking": thinking,
                "tokens": last_eval_count[model],
                "done": done_flags[model],
                "reason": done_reason,
            })
        except StopIteration:
            done_flags[model] = True
            done_reasons[model] = "finished"
            yield json.dumps({"status": "model_finished", "round": round_no, "model": model, "reason": "finished", "done": False})
        except Exception as ex:
            done_flags[model] = True
            done_reasons[model] = "error"
            yield json.dumps({"status": "model_error", "round": round_no, "model": model, "error": str(ex), "done": False})

        embeddings = {m: embed_text(embedding_model, responses[m]) for m in model_list if responses[m]}
        emb = embeddings.get(model)
        if emb is not None:
            qscore = cosine_sim(q_emb, emb)
            inter = _inter_similarity(model, emb, embeddings, model_list)
            reward = max(0.0, alpha * qscore + beta * inter)
            scores[model] = reward
            reward_sums[model] += reward
            yield json.dumps({
                "status": "model_scored",
                "round": round_no,
                "model": model,
                "score": reward,
                "q_similarity": qscore,
                "inter_similarity": inter,
                "pulls": pulls[model],
                "done": False,
            })

    while used_tokens + lambda_pull <= total_token_budget and round_no < max_rounds:
        available = [m for m in model_list if not done_flags[m]]
        if not available:
            break

        total_pulls = max(1, sum(pulls.values()))
        gamma = base_explore * (1 - used_tokens / max(1, total_token_budget))

        ucb_values = {}
        for m in available:
            if pulls[m] == 0:
                ucb_values[m] = float("inf")
                continue
            avg_reward = reward_sums[m] / pulls[m]
            ucb_values[m] = avg_reward + gamma * math.sqrt((2.0 * math.log(total_pulls)) / pulls[m])

        chosen = max(ucb_values, key=ucb_values.get)
        round_no += 1
        yield json.dumps({
            "status": "round_start",
            "round": round_no,
            "chosen_model": chosen,
            "ucb": ucb_values[chosen],
            "gamma": gamma,
            "used_tokens": used_tokens,
            "done": False,
        })

        try:
            _, chunk, thinking, eval_count, is_final, done_reason = next(generators[chosen])
            responses[chosen] = chunk
            thoughts[chosen] = thinking
            last_eval_count[chosen] = int(eval_count or 0)
            done_flags[chosen] = is_final or done_reason in {"stop", "length"}
            done_reasons[chosen] = done_reason
            used_tokens = min(total_token_budget, used_tokens + lambda_pull)
            pulls[chosen] += 1
            total_pulls += 1

            yield json.dumps({
                "status": "model_progress",
                "round": round_no,
                "model": chosen,
                "partial_output": chunk,
                "partial_thinking": thinking,
                "tokens": last_eval_count[chosen],
                "done": done_flags[chosen],
                "reason": done_reason,
            })
        except StopIteration:
            done_flags[chosen] = True
            done_reasons[chosen] = "finished"
            yield json.dumps({"status": "model_finished", "round": round_no, "model": chosen, "reason": "finished", "done": False})
            continue
        except Exception as ex:
            done_flags[chosen] = True
            done_reasons[chosen] = "error"
            yield json.dumps({"status": "model_error", "round": round_no, "model": chosen, "error": str(ex), "done": False})
            continue

        embeddings = {m: embed_text(embedding_model, responses[m]) for m in model_list if responses[m]}
        emb = embeddings.get(chosen)
        if emb is None:
            yield json.dumps({"status": "model_embedding_failed", "round": round_no, "model": chosen, "done": False})
            continue

        qscore = cosine_sim(q_emb, emb)
        inter = _inter_similarity(chosen, emb, embeddings, model_list)
        reward = max(0.0, alpha * qscore + beta * inter)
        scores[chosen] = reward
        reward_sums[chosen] += reward

        yield json.dumps({
            "status": "model_scored",
            "round": round_no,
            "model": chosen,
            "score": reward,
            "q_similarity": qscore,
            "inter_similarity": inter,
            "pulls": pulls[chosen],
            "done": False,
        })

        scored_models = [m for m in model_list if pulls[m] > 0]
        if scored_models:
            best_model = max(scored_models, key=lambda m: scores[m])
            sorted_scores = sorted([scores[m] for m in scored_models], reverse=True)
            second_best = sorted_scores[1] if len(sorted_scores) > 1 else -1.0
            if (scores[best_model] - second_best) > early_margin and done_reasons.get(best_model) == "stop":
                yield json.dumps({
                    "status": "final_result",
                    "round": round_no,
                    "reason": "early_stopping",
                    "best_model": best_model,
                    "output": responses[best_model],
                    "thinking": thoughts[best_model],
                    "score": scores[best_model],
                    "tokens": last_eval_count[best_model],
                    "done": True,
                })
                return

    scored_models = [m for m in model_list if pulls[m] > 0 and responses[m]]
    if not scored_models:
        yield json.dumps({"status": "error", "error": "No results produced", "done": True})
        return

    best_model = max(scored_models, key=lambda m: scores[m])
    reason = "tokens_exhausted" if used_tokens >= total_token_budget else "all_models_completed"
    yield json.dumps({
        "status": "final_result",
        "round": round_no,
        "reason": reason,
        "best_model": best_model,
        "output": responses[best_model],
        "thinking": thoughts[best_model],
        "score": scores[best_model],
        "tokens": last_eval_count[best_model],
        "done": True,
    })
