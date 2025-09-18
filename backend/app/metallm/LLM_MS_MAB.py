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
    max_rounds: int = 50,
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
    # Set the constants for this function run
    global ALPHA, BETA, XPLORE_COEFF, EMBEDDING_MODEL, MODELS, EARLY_STOPPING_MARGIN_RATIO, system_prompt
    # Store original values to restore later
    original_alpha = ALPHA
    original_beta = BETA
    original_xplore_coeff = XPLORE_COEFF
    original_embedding_model = EMBEDDING_MODEL
    original_models = MODELS
    original_early_stopping_ratio = EARLY_STOPPING_MARGIN_RATIO
    original_system_prompt = system_prompt
    # Set new values for this run
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

    # Handle messages parameter properly
    if messages is None:
        # If no messages provided, create a new list with system and user messages
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ]
    else:
        # If messages were provided, ensure system message is at the top
        # Find if there's already a system message
        has_system_message = False
        for msg in messages:
            if msg.get("role") == "system":
                has_system_message = True
                # Update the system message content
                msg["content"] = system_prompt
                break

        # If no system message found, insert one at the beginning
        if not has_system_message:
            messages.insert(0, {"role": "system", "content": system_prompt})

    # Flag to track if we've seen a final completion
    complete_response_received = False
    final_response = None

    try:
        # Embed the question once.
        q_emb = embed_text(question)
        if q_emb is None:
            yield json.dumps(
                {"status": "error", "error": "Empty question embedding", "done": True}
            )
            return
        q_emb = q_emb.reshape(1, -1)
        arms = MODELS
        # Initialize per-arm state.
        stats = {}  # For each arm: pulls count, cumulative reward, average reward.
        outputs = {}  # Cumulative output from each model.
        generators = {}  # Generator per model.
        done_flags = {}  # Whether a model is finished.
        last_eval_count = {}  # Tokens used per model.
        scores = {}  # Current score for each model.
        done_reasons = {}  # Reason for completion.
        tracking = {m: 0 for m in arms}  # Count how many times each model is chosen.
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
        # Initial status update
        yield json.dumps(
            {
                "status": "initialized",
                "models": arms,
                "done": False,
                "config": {
                    "total_budget": total_token_budget,
                    "max_rounds": max_rounds,
                    "alpha": ALPHA,
                    "beta": BETA,
                    "explore_coeff": XPLORE_COEFF,
                },
            }
        )
        # --- INITIAL PULL: one chunk per model ---
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
                # Update tokens only if eval_count is present.
                if eval_count:
                    tokens_used += eval_count
                total_pulls += 1
                # Yield updated state after each model's initial pull
                yield json.dumps(
                    {
                        "status": "initial_pull",
                        "model": m,
                        "partial_output": chunk,
                        "score": score,
                        "tokens": eval_count,
                        "done": is_final,
                        "models_state": {
                            model: {
                                "score": scores.get(model, 0.0),
                                "tokens": last_eval_count.get(model, 0),
                                "done": done_flags.get(model, False),
                            }
                            for model in arms
                        },
                    }
                )
            except StopIteration:
                done_flags[m] = True
                yield json.dumps(
                    {
                        "status": "initial_pull_failed",
                        "model": m,
                        "error": "Failed to get initial output",
                        "done": False,
                    }
                )
        round_count = 0
        # --- MAIN LOOP: pull one arm at a time based on UCB ---
        while (
            tokens_used < total_token_budget
            and round_count < max_rounds
            and not all(done_flags.values())
        ):
            progress = tokens_used / total_token_budget
            dynamic_xplore = XPLORE_COEFF * (1 - progress)
            # Compute UCB for active arms.
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
            tracking[chosen_model] += 1  # Count this selection.
            try:
                nm, chunk, eval_count, is_final, done_reason = next(
                    generators[chosen_model]
                )
                outputs[chosen_model] = chunk
                last_eval_count[chosen_model] = eval_count
                done_reasons[chosen_model] = done_reason
                if done_reason == "stop":
                    done_flags[chosen_model] = True
            except StopIteration:
                done_flags[chosen_model] = True
                yield json.dumps(
                    {
                        "status": "model_finished",
                        "model": chosen_model,
                        "done": False,
                        "tokens": last_eval_count[chosen_model],
                        "reason": "StopIteration",
                    }
                )
                continue
            # Update tokens only if eval_count is present.
            if eval_count:
                tokens_used += eval_count
            round_count += 1
            total_pulls += 1
            # Update score and stats.
            emb = embed_text(outputs[chosen_model])
            new_score = (
                compute_base_score_for_mab(chosen_model, emb, q_emb, outputs, arms)
                if emb is not None
                else 0.0
            )
            scores[chosen_model] = new_score
            reward = new_score
            stats[chosen_model]["n"] += 1
            stats[chosen_model]["cumulative_reward"] += reward
            stats[chosen_model]["avg"] = (
                stats[chosen_model]["cumulative_reward"] / stats[chosen_model]["n"]
            )

            # Add models_outputs to include all current model outputs
            models_outputs = {m: outputs[m] for m in arms if outputs[m]}

            # Yield status update after this round
            yield json.dumps(
                {
                    "status": "round_update",
                    "round": round_count,
                    "chosen_model": chosen_model,
                    "partial_output": chunk,
                    "score": new_score,
                    "tokens": eval_count,
                    "total_tokens": tokens_used,
                    "progress": f"{int(progress * 100)}%",
                    "done": False,
                    "models_state": {
                        model: {
                            "score": scores.get(model, 0.0),
                            "tokens": last_eval_count.get(model, 0),
                            "done": done_flags.get(model, False),
                        }
                        for model in arms
                    },
                    "models_outputs": models_outputs,
                }
            )
            # --- Optional Early Stopping with Completion ---
            active_scores = [scores[m] for m in arms if not done_flags[m]]
            if len(active_scores) > 1:
                best_active_score = max(active_scores)
                sorted_scores = sorted(active_scores)
                second_best = sorted_scores[-2]
                if (
                    second_best > 0
                    and (best_active_score - second_best) / second_best
                    > EARLY_STOPPING_MARGIN_RATIO
                ):
                    best_model = max(arms, key=lambda m: scores[m])
                    yield json.dumps(
                        {
                            "status": "early_stopping",
                            "best_model": best_model,
                            "score": scores[best_model],
                            "reason": "margin_exceeded",
                            "done": False,
                            "partial_output": outputs[best_model],
                        }
                    )
                    while (
                        not done_flags[best_model] and tokens_used < total_token_budget
                    ):
                        try:
                            nm, chunk, eval_count, is_final, done_reason = next(
                                generators[best_model]
                            )
                            outputs[best_model] = chunk
                            last_eval_count[best_model] = eval_count
                            done_reasons[best_model] = done_reason
                            # Stream updates during completion
                            yield json.dumps(
                                {
                                    "status": "completing_best",
                                    "model": best_model,
                                    "partial_output": chunk,
                                    "tokens": eval_count,
                                    "done": is_final,
                                }
                            )
                            if done_reason == "stop":
                                done_flags[best_model] = True
                        except StopIteration:
                            done_flags[best_model] = True
                            break
                        if eval_count:
                            tokens_used += eval_count
                    # Final result after early stopping and completion
                    yield json.dumps(
                        {
                            "status": "final_result",
                            "model": best_model,
                            "output": outputs[best_model],
                            "score": scores[best_model],
                            "tokens": last_eval_count[best_model],
                            "done": True,
                            "early_stopped": True,
                        }
                    )
                    return
            if tokens_used >= total_token_budget:
                for m in arms:
                    if not done_flags[m]:
                        done_reasons[m] = "length"
                break
        # Final results at end of all rounds
        results = []
        for m in arms:
            results.append(
                (
                    m,
                    outputs[m].strip(),
                    scores[m],
                    last_eval_count[m],
                    done_flags[m],
                    done_reasons[m],
                )
            )
        # Sort by score and return the best
        sorted_results = sorted(results, key=lambda x: x[2], reverse=True)
        # Find model that completed with "stop" reason
        best_complete_model = None
        for r in sorted_results:
            if r[5] == "stop":  # If this model completed successfully
                best_complete_model = r
                break
        # If we found a model that completed successfully, return it
        if best_complete_model:
            model, output, score, tokens_used, done_flag, done_reason = (
                best_complete_model
            )
            yield json.dumps(
                {
                    "status": "final_result",
                    "model": model,
                    "output": output,
                    "score": score,
                    "tokens": tokens_used,
                    "done": True,
                    "reason": done_reason,
                }
            )
            complete_response_received = True
            final_response = json.dumps(
                {
                    "status": "final_result",
                    "model": model,
                    "output": output,
                    "score": score,
                    "tokens": tokens_used,
                    "done": True,
                    "reason": done_reason,
                }
            )
        else:
            # Otherwise return the highest scoring one
            if sorted_results:
                model, output, score, tokens_used, done_flag, done_reason = (
                    sorted_results[0]
                )
                yield json.dumps(
                    {
                        "status": "final_result",
                        "model": model,
                        "output": output,
                        "score": score,
                        "tokens": tokens_used,
                        "done": True,
                        "reason": "highest_score",
                    }
                )
                complete_response_received = True
                final_response = json.dumps(
                    {
                        "status": "final_result",
                        "model": model,
                        "output": output,
                        "score": score,
                        "tokens": tokens_used,
                        "done": True,
                        "reason": "highest_score",
                    }
                )
            else:
                yield json.dumps(
                    {"status": "error", "error": "No results available", "done": True}
                )
                complete_response_received = True
                final_response = json.dumps(
                    {"status": "error", "error": "No results available", "done": True}
                )
    finally:
        # Restore original values
        ALPHA = original_alpha
        BETA = original_beta
        XPLORE_COEFF = original_xplore_coeff
        EMBEDDING_MODEL = original_embedding_model
        MODELS = original_models
        EARLY_STOPPING_MARGIN_RATIO = original_early_stopping_ratio
        system_prompt = original_system_prompt

        # If we somehow exited the loop without a complete response, yield a final output
        if not complete_response_received:
            yield json.dumps(
                {
                    "status": "final_result",
                    "reason": "generator_completed",
                    "message": "Generation complete but no final result was explicitly marked",
                    "done": True,
                }
            )
        elif final_response:
            # Re-yield the final response to ensure it wasn't missed
            yield final_response
