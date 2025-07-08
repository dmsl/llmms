import json
import asyncio
import ollama
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
import math

###############################################################################
# CONFIGURATION AND GLOBAL VARIABLES
###############################################################################
MODELS = ["llama3.1", "qwen2.5", "mistral"]
EARLY_STOPPING_MARGIN_RATIO = 1 * math.log2(len(MODELS))
EMBEDDING_MODEL = "nomic-embed-text"
# VERBOSITY_PENALTY = 0.05  # Penalty for being too verbose
XPLORE_COEFF = 0.3  # Exploration coefficient for UCB
ALPHA = 0.7  # weight for question similarity
BETA = 0.3  # weight for inter-model consensus
system_prompt = """You are a concise and direct assistant. Provide brief, to-the-point answers 
with minimal elaboration. Strive to be factually correct, and explicitly state 
when you are unsure. Avoid mentioning that you are an AI model or adding 
unnecessary disclaimers. Focus on clarity, correctness, and relevance above all."""


###############################################################################
# UTILITY FUNCTIONS
###############################################################################
def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two 1-D NumPy arrays."""
    a_2d = a.reshape(1, -1)
    b_2d = b.reshape(1, -1)
    return float(cosine_similarity(a_2d, b_2d)[0][0])


def embed_text(txt: str) -> np.ndarray or None:  # type: ignore
    """
    Embed the given text using the Ollama embedding model.
    Returns a NumPy array or None if no embeddings were returned.
    """
    emb_res = ollama.embed(model=EMBEDDING_MODEL, input=txt)
    e_list = emb_res.get("embeddings", [])
    if not e_list:
        return None
    return np.array(e_list, dtype=np.float32)


###############################################################################
# STREAMING GENERATOR (SINGLE MODEL)
###############################################################################
def generate_stream(model_name: str, question: str, num_predict: int, messages=None):
    """
    Synchronous generator for streaming partial outputs from a single model.
    Yields tuples of (model_name, cumulative_output, eval_count, is_final, done_reason).

    Args:
        model_name (str): Name of the model to use
        question (str): The question to answer
        num_predict (int): Maximum number of tokens to predict
        messages (list, optional): List of conversation messages in chat format. Defaults to None.
    """
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
            system=system_prompt,
            stream=True,
            options={"num_predict": num_predict},
        )

    output = ""
    last_eval_count = 0
    for chunk in response:
        eval_count = chunk.get("eval_count", last_eval_count)
        done_reason = chunk.get("done_reason", "unknown")
        if "message" in chunk:
            output += chunk["message"]["content"]
            if done_reason == "stop":
                yield model_name, output, eval_count, True, done_reason
                break
            yield model_name, output, eval_count, False, done_reason
        elif "response" in chunk:
            output += chunk["response"]
            if done_reason == "stop":
                yield model_name, output, eval_count, True, done_reason
                break
            yield model_name, output, eval_count, False, done_reason
        if chunk.get("done") == "True":
            yield model_name, output, eval_count, True, done_reason
            break
        last_eval_count = eval_count


###############################################################################
# HELPER: Compute Score (Reward) for MAB
###############################################################################
def compute_base_score_for_mab(
    model: str, emb: np.ndarray, q_emb: np.ndarray, outputs: dict, arms: list
) -> float:
    """
    Compute a score for the model output using a weighted combination of:
      - qscore: cosine similarity between the question and the model's output embedding,
      - inter_score: average similarity between this model’s embedding and other models’ embeddings.
    """
    qscore = cosine_sim(q_emb, emb)
    other_embeddings = []
    for m in arms:
        if m != model and outputs[m]:
            emb_other = embed_text(outputs[m])
            if emb_other is not None:
                other_embeddings.append(emb_other)
    inter_score = (
        sum(cosine_sim(emb, oe) for oe in other_embeddings) / len(other_embeddings)
        if other_embeddings
        else 1.0
    )
    return ALPHA * qscore + BETA * inter_score


###############################################################################
# STREAMING FUNCTION FOR MAB APPROACH
###############################################################################
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
    """
    Streaming version of the Multi-Armed Bandit approach.
    Yields partial results after each round as JSON strings.
    Args:
        question: The user's question
        max_rounds: Maximum number of rounds to run
        total_token_budget: Total token budget to allocate
        a: Alpha weight for question similarity (default: 0.7)
        b: Beta weight for inter-model consensus (default: 0.3)
        dc: Exploration coefficient for UCB (default: 0.3)
        models: List of model names to use (default: ["llama3.1", "qwen2.5", "mistral"])
        embedding_model: Model to use for embeddings (default: "nomic-embed-text")
        early_stopping_margin_ratio: Ratio for early stopping (default: 1 * math.log2(len(models)))
        custom_system_prompt: Custom system prompt to use (default: None)
        messages: Optional pre-existing messages list
    Yields:
        JSON strings containing the current state and partial results
    """
    global ALPHA, BETA, XPLORE_COEFF, EMBEDDING_MODEL, MODELS, EARLY_STOPPING_MARGIN_RATIO, system_prompt
    original_alpha = ALPHA
    original_beta = BETA
    original_xplore_coeff = XPLORE_COEFF
    original_embedding_model = EMBEDDING_MODEL
    original_models = MODELS
    original_early_stopping_ratio = EARLY_STOPPING_MARGIN_RATIO
    original_system_prompt = system_prompt

    ALPHA = a
    BETA = b
    XPLORE_COEFF = dc
    EMBEDDING_MODEL = embedding_model
    MODELS = models if models is not None else ["llama3.1", "qwen2.5", "mistral"]
    EARLY_STOPPING_MARGIN_RATIO = (
        early_stopping_margin_ratio
        if early_stopping_margin_ratio is not None
        else 1 * math.log2(len(MODELS))
    )
    if custom_system_prompt is not None:
        system_prompt = custom_system_prompt

    if messages is None:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ]
    else:
        has_system_message = False
        for msg in messages:
            if msg.get("role") == "system":
                has_system_message = True
                msg["content"] = system_prompt
                break
        if not has_system_message:
            messages.insert(0, {"role": "system", "content": system_prompt})

    complete_response_received = False
    final_response = None

    q_emb = embed_text(question)
    if q_emb is None:
        yield json.dumps(
            {"status": "error", "error": "Failed to generate embedding for question", "done": True}
        )
        return
    q_emb = q_emb.reshape(1, -1)
    arms = MODELS
    stats = {}
    outputs = {}
    generators = {}
    done_flags = {}
    last_eval_count = {}
    scores = {}
    done_reasons = {}
    tracking = {m: 0 for m in arms}
    for m in arms:
        stats[m] = {"n": 0, "cumulative_reward": 0.0, "avg": 0.0}
        outputs[m] = ""
        generators[m] = generate_stream(
            m, question, total_token_budget // len(arms), messages
        )
        done_flags[m] = False
        scores[m] = 0.0
        last_eval_count[m] = 0
        done_reasons[m] = "unknown"
    total_pulls = 0
    tokens_used = 0
    yield json.dumps(
        {
            "status": "initialized",
            "models": arms,
            "current_tokens": total_token_budget // len(arms),
            "max_total_tokens": total_token_budget,
            "done": False,
        }
        
    )
    for m in arms:
        try:
            nm, chunk, eval_count, is_final, done_reason = next(generators[m])
            outputs[m] = chunk
            last_eval_count[m] = eval_count
            done_reasons[m] = done_reason
            if done_reason == "stop":
                done_flags[m] = True
            emb = embed_text(outputs[m])
            score = (
                compute_base_score_for_mab(m, emb, q_emb, outputs, arms)
                if emb is not None
                else 0.0
            )
            scores[m] = score
            stats[m]["n"] = 1
            stats[m]["cumulative_reward"] = score
            stats[m]["avg"] = score
            if eval_count:
                tokens_used += eval_count
            total_pulls += 1
            yield json.dumps(
                {
                    "status": "model_progress",
                    "round": 1,
                    "model": m,
                    "partial_output": chunk,
                    "tokens": eval_count,
                    "done": is_final,
                     "reason": done_reason if is_final else "unknown",  # Change this line
                }
            )
            # Send scoring update
            yield json.dumps(
                {
                    "status": "model_scored",
                    "round": 1,
                    "model": m,
                    "score": scores[m],
                    "metrics": {
                        "tokens": eval_count,
                        "done": is_final,
                    },
                }
            )
            if is_final:
                yield json.dumps(
                    {
                        "status": "model_finished",
                        "round": 1,
                        "model": m,
                        "reason": done_reason,
                        "tokens": eval_count,
                        "done": False,
                    }
                )
        except StopIteration:
            done_flags[m] = True
            yield json.dumps(
                {
                    "status": "model_exhausted",
                    "round": 1,
                    "model": m,
                }
            )
    round_count = 1
    round_start_sent = False
    
    # Only send round_start once at the beginning
    if not round_start_sent:
        yield json.dumps(
            {
                "status": "round_start",
                "round": round_count,
                "token_allocation": total_token_budget // len(arms),
                "models": arms,
                "cumulative_tokens": tokens_used,
                "done": False,
            }
        )
        round_start_sent = True
    progress = tokens_used / total_token_budget
    dynamic_xplore = XPLORE_COEFF * (1 - progress)
    ucb_values = {}
    for m in arms:
        if done_flags[m]:
            ucb_values[m] = -float("inf")
        else:
            n = stats[m]["n"]
            avg = stats[m]["avg"]
            ucb = (
                avg + dynamic_xplore * math.sqrt(2 * math.log(total_pulls) / n)
                if n > 0
                else float("inf")
            )
            ucb_values[m] = ucb
    chosen_model = max(ucb_values, key=ucb_values.get)
    non_selected_models = [m for m in arms if m != chosen_model and not done_flags[m]]
    for model in non_selected_models:
        scores[model] = 0.0  # Reset scores for non-selected models
        model_ucb = ucb_values[model] if model in ucb_values else 0.0
          # Also send model_scored update with 0 score
        yield json.dumps(
            {
                "status": "model_scored",
                "round": round_count,
                "model": model,
                "score": 0.0,  # Reset score to 0
                "selectivity": model_ucb,
                "metrics": {
                    "tokens": last_eval_count[model],
                    "done": done_flags[model],
                },
            })

    tracking[chosen_model] += 1
    
    # Check if chosen model is already done or no models are available
    if done_flags[chosen_model] or all(done_flags.values()):
        # All models are done, finish immediately
        if scores:
            best_model = max(scores.keys(), key=lambda m: scores[m])
            yield json.dumps(
                {
                    "status": "final_result",
                    "reason": "all_models_finished",
                    "best_model": best_model,
                    "output": outputs[best_model],
                    "score": scores[chosen_model],
                    "tokens": last_eval_count[best_model],
                    "done": True,
                }
            )
        else:
            yield json.dumps(
                {
                    "status": "error",
                    "error": "No results produced - all models finished",
                    "done": True,
                }
            )
        return  # Exit the function completely
    else:
        # Pull from the chosen model until it's done or tokens are exhausted
        while not done_flags[chosen_model] and tokens_used < total_token_budget:
            try:
                nm, chunk, eval_count, is_final, done_reason = next(
                    generators[chosen_model]
                )
                outputs[chosen_model] = chunk
                last_eval_count[chosen_model] = eval_count
                done_reasons[chosen_model] = done_reason
                
                # Update score immediately
                emb = embed_text(outputs[chosen_model])
                new_score = (
                    compute_base_score_for_mab(chosen_model, emb, q_emb, outputs, arms)
                    if emb is not None
                    else 0.0
                )
                scores[chosen_model] = new_score
                
                yield json.dumps(
                    {
                        "status": "model_progress",
                        "round": round_count,
                        "model": chosen_model,
                        "partial_output": chunk,
                        "tokens": eval_count,
                        "done": is_final,
                       "reason": done_reason if is_final else "unknown",  # Change this line
                    }
                )
                # Send metrics for each pull
                yield json.dumps(
                    {
                        "status": "model_scored",
                        "round": round_count,
                        "model": chosen_model,
                        "score": scores[chosen_model],
                        "selectivity": tracking[chosen_model],
                       "metrics": {
                            "tokens": last_eval_count[chosen_model],
                            "done": done_flags[chosen_model],
                        },
                    }

                )
                
                
                if eval_count:
                    tokens_used += eval_count
                total_pulls += 1
                
                if done_reason == "stop" or is_final:
                    done_flags[chosen_model] = True
                    # If this model is done, yield final result and exit
                    if scores:
                        best_model = max(scores.keys(), key=lambda m: scores[m])
                        yield json.dumps(
                            {
                                "status": "final_result",
                                "reason": "model_completed",
                                "best_model": best_model,
                                "output": outputs[best_model],
                                "score": scores[best_model],
                                "selectivity": tracking[chosen_model],
                                "tokens": last_eval_count[best_model],
                                "done": True,
                            }
                        )
                    return  # Exit the function completely
                    
            except StopIteration:
                done_flags[chosen_model] = True
                yield json.dumps(
                    {
                        "status": "model_exhausted",
                        "round": round_count,
                        "model": chosen_model,
                    }
                )
                # If model is exhausted, yield final result and exit
                if scores:
                    best_model = max(scores.keys(), key=lambda m: scores[m])
                    yield json.dumps(
                        {
                            "status": "final_result",
                            "reason": "model_exhausted",
                            "best_model": best_model,
                            "output": outputs[best_model],
                            "score": scores[best_model],
                            "selectivity": tracking[chosen_model],
                            "tokens": last_eval_count[best_model],
                            "done": True,
                        }
                    )
                return  # Exit the function completely
    if scores:
        best_model = max(scores.keys(), key=lambda m: scores[m])
        yield json.dumps(
            {
                "status": "final_result",
                "reason": "tokens_exhausted",
                "best_model": best_model,
                "output": outputs[best_model],
                "score": scores[best_model],
                "selectivity": tracking[chosen_model],
                "tokens": last_eval_count[best_model],
                "done": True,
            }
        )
    else:
        yield json.dumps(
            {
                "status": "error",
                "error": "No results produced",
                "done": True,
            }
        )
    
    # Restore original global variables
    ALPHA = original_alpha
    BETA = original_beta
    XPLORE_COEFF = original_xplore_coeff
    EMBEDDING_MODEL = original_embedding_model
    MODELS = original_models
    EARLY_STOPPING_MARGIN_RATIO = original_early_stopping_ratio
    system_prompt = original_system_prompt
