import asyncio
import ollama
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
import math
import json

###############################################################################
# CONFIGURATION AND GLOBAL VARIABLES
###############################################################################
system_prompt = """You are a concise and direct assistant. Provide brief, to-the-point answers 
with minimal elaboration. Strive to be factually correct, and explicitly state 
when you are unsure. Avoid mentioning that you are an AI model or adding 
unnecessary disclaimers. Focus on clarity, correctness, and relevance above all."""
MODELS = ["llama3.1", "qwen2.5", "mistral"]
EMBEDDING_MODEL = "nomic-embed-text"
EMBED_EVERY_N_TOKENS = 1  # Embed partial output every N tokens (performance knob)
EARLY_STOPPING_MARGIN_RATIO = 1 * math.log2(len(MODELS))  # Margin for early stopping
ALPHA = 0.7  # weight for question similarity
BETA = 0.3  # weight for inter-model consensus


###############################################################################
# UTILITY FUNCTIONS
###############################################################################
def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    """
    Compute cosine similarity between two 1-D NumPy arrays.
    """
    a_2d = a.reshape(1, -1)
    b_2d = b.reshape(1, -1)
    return float(cosine_similarity(a_2d, b_2d)[0][0])


def embed_text(txt: str) -> np.ndarray or None:  # type: ignore
    """
    Embeds the given text using the Ollama embedding model.
    Returns a NumPy array or None if no embeddings were returned.
    """
    emb_res = ollama.embed(model=EMBEDDING_MODEL, input=txt)
    e_list = emb_res.get("embeddings", [])
    if not e_list:
        return None
    return np.array(e_list, dtype=np.float32)


###############################################################################
# ASYNC GENERATOR: STREAM PARTIAL OUTPUTS FROM A SINGLE MODEL
###############################################################################
def generate_stream(model_name: str, question: str, num_predict: int, messages=None):
    """
    Synchronous generator for streaming partial outputs from a single model.
    Yields: (model_name, partial_output, eval_count, is_final, done_reason)

    Args:
        model_name: Name of the model to use
        question: The user's question
        num_predict: Maximum number of tokens to predict
        messages: Optional pre-existing conversation history in messages format
    """
    if messages:
        # Use messages format if provided
        response = ollama.chat(
            model=model_name,
            messages=messages,
            stream=True,
            options={"num_predict": num_predict},
        )
    else:
        # Use prompt and system prompt if no messages provided
        response = ollama.generate(
            model=model_name,
            prompt=question,
            system=system_prompt,
            stream=True,
            options={"num_predict": num_predict},
        )

    output = ""
    last_eval_count = 0
    done_reason = "unknown"
    for chunk in response:
        eval_count = chunk.get("eval_count", last_eval_count)
        done_reason = chunk.get("done_reason", "unknown")
        if "message" in chunk:
            output += chunk["message"]["content"]
            done_reason = chunk.get("done_reason", "unknown")
            if done_reason == "stop":
                yield model_name, output, eval_count, True, done_reason
                break
            yield model_name, output, eval_count, False, done_reason
        elif "response" in chunk:
            output += chunk["response"]
            done_reason = chunk.get("done_reason", "unknown")
            if done_reason == "stop":
                yield model_name, output, eval_count, True, done_reason
                break
            yield model_name, output, eval_count, False, done_reason
        if chunk.get("done") == "True":
            done_reason = chunk.get("done_reason", "unknown")
            yield model_name, output, eval_count, True, done_reason
            break
        last_eval_count = eval_count


###############################################################################
# STREAMING FUNCTION FOR OUA APPROACH
###############################################################################
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
    """
    Streaming version of the Stepwise Token Allocation algorithm.
    Yields partial results after each stage as JSON strings.
    Args:
        question: The user's question
        start_tokens: Initial token allocation per model
        max_rounds: Maximum number of rounds to run
        max_tokens: Maximum total tokens to allocate
        custom_system_prompt: Override default system prompt
        alpha: Weight for question similarity
        beta: Weight for inter-model consensus
        dc: Dynamic margin coefficient
        models: List of models to use (defaults to global MODELS)
        embedding_model: Embedding model to use
    Yields:
        JSON strings containing the current state and partial results
    """
    global system_prompt, EMBEDDING_MODEL, ALPHA, BETA, EARLY_STOPPING_MARGIN_RATIO

    # Apply custom system prompt if provided
    if custom_system_prompt is not None:
        system_prompt = custom_system_prompt

    # Apply custom parameters if provided
    if alpha is not None:
        ALPHA = alpha
    if beta is not None:
        BETA = beta
    if dc is not None:
        EARLY_STOPPING_MARGIN_RATIO = dc
    else:
        EARLY_STOPPING_MARGIN_RATIO = 1 * math.log2(len(MODELS))

    # Apply custom embedding model if provided
    if embedding_model is not None:
        EMBEDDING_MODEL = embedding_model

    # Use provided models or default to global MODELS
    run_these_models = models if models else MODELS

    # Divide initial tokens among models
    start_tokens = math.floor(start_tokens / len(run_these_models))

    cumulative_tokens = 0
    current_tokens = start_tokens
    rounds = 0
    num_models = len(run_these_models)
    max_total_tokens = max_tokens // num_models  # Maximum allowable total tokens

    # Initial status update
    yield json.dumps(
        {
            "status": "initialized",
            "models": run_these_models,
            "current_tokens": current_tokens,
            "max_total_tokens": max_total_tokens,
            "done": False,
        }
    )

    # Get question embedding
    q_emb = embed_text(question)
    if q_emb is None:
        yield json.dumps(
            {
                "status": "error",
                "error": "Failed to generate embedding for question",
                "done": True,
            }
        )
        return
    q_emb = q_emb.reshape(1, -1)

    # Add metrics object to track performance scores over time
    metrics = {
        "scores_history": [],
        "round_metrics": {},
        "best_score": 0.0,
        "best_model": None,
    }

    # Main loop - iterate until we hit max tokens or rounds
    while (
        cumulative_tokens + current_tokens <= max_total_tokens and rounds < max_rounds
    ):
        per_model_predict = max(1, current_tokens)
        # Update on round start
        rounds += 1
        yield json.dumps(
            {
                "status": "round_start",
                "round": rounds,
                "token_allocation": per_model_predict,
                "models": run_these_models,
                "cumulative_tokens": cumulative_tokens,
                "done": False,
            }
        )

        # Initialize tracking dictionaries for this round
        responses = {m: "" for m in run_these_models}
        model_embeddings = {m: None for m in run_these_models}
        scores = {m: 0.0 for m in run_these_models}
        done_reasons = {m: None for m in run_these_models}
        last_eval_count = {m: 0 for m in run_these_models}
        active_models = set(run_these_models)

        # Create a generator for each model
        model_generators = {
            m: generate_stream(m, question, per_model_predict, messages)
            for m in run_these_models
        }

        # Main round-robin loop: each active model produces exactly one chunk per round
        while active_models:
            # Process one chunk from each active model
            for model in list(active_models):
                try:
                    # Get one chunk from the model's generator
                    nm, chunk, eval_count, is_final, done_reason = next(
                        model_generators[model]
                    )
                    # Store the chunk as the model's response
                    responses[model] = chunk
                    last_eval_count[model] = eval_count
                    done_reasons[model] = done_reason

                    # Stream the partial progress
                    yield json.dumps(
                        {
                            "status": "model_progress",
                            "round": rounds,
                            "model": model,
                            "partial_output": chunk,
                            "tokens": eval_count,
                            "done": is_final,
                            "reason": done_reason,
                        }
                    )

                    if is_final:
                        # If this model has finished, mark it appropriately
                        yield json.dumps(
                            {
                                "status": "model_finished",
                                "round": rounds,
                                "model": model,
                                "reason": done_reason,
                                "tokens": eval_count,
                                "done": False,  # Not done with the full stream yet, just this model
                            }
                        )

                except StopIteration:
                    # Remove the model if its generator has been exhausted
                    active_models.discard(model)
                    yield json.dumps(
                        {
                            "status": "model_exhausted",
                            "round": rounds,
                            "model": model,
                        }
                    )
                except Exception as e:
                    # Handle errors for individual models
                    active_models.discard(model)
                    yield json.dumps(
                        {
                            "status": "model_error",
                            "round": rounds,
                            "model": model,
                            "error": str(e),
                        }
                    )

            # After getting one chunk from each model, compute embeddings and scores
            for model in list(active_models):
                model_response = responses[model]
                emb = embed_text(model_response)
                if emb is not None:
                    model_embeddings[model] = emb

                    # Use compute_base_score logic directly here
                    # Compute similarity between the question and the model's output
                    qscore = cosine_sim(q_emb, emb)

                    # Gather embeddings from other active models (exclude the current one)
                    active_other_embeddings = [
                        e
                        for m2, e in model_embeddings.items()
                        if m2 != model and m2 in active_models and e is not None
                    ]

                    # Maximum possible comparisons from the initial pool
                    max_possible = len(run_these_models) - 1

                    if not active_other_embeddings:
                        inter_score = 1.0  # Only one active model
                    else:
                        inter_sims = [
                            cosine_sim(emb, oe) for oe in active_other_embeddings
                        ]
                        raw_avg = sum(inter_sims) / len(inter_sims)
                        current_count = len(active_other_embeddings)

                        # Scale the average if we have fewer comparisons than originally possible
                        if current_count < max_possible:
                            inter_score = raw_avg * (max_possible / current_count)
                        else:
                            inter_score = raw_avg

                    # Combine the question similarity and inter-model consensus using weights
                    base_score = ALPHA * qscore + BETA * inter_score
                    scores[model] = max(0.0, base_score)

                    # Track detailed metrics for this model
                    metrics["round_metrics"][model] = {
                        "score": scores[model],
                        "q_similarity": qscore,
                        "inter_similarity": inter_score,
                        "tokens": last_eval_count[model],
                        "done": done_reasons.get(model, False),
                    }

                    # Update best score if this model has a higher score
                    if scores[model] > metrics["best_score"]:
                        metrics["best_score"] = scores[model]
                        metrics["best_model"] = model

                    # Send model score update with detailed metrics
                    yield json.dumps(
                        {
                            "status": "model_scored",
                            "round": rounds,
                            "model": model,
                            "score": scores[model],
                            "q_similarity": qscore,
                            "inter_similarity": inter_score,
                            "metrics": {
                                "tokens": last_eval_count[model],
                                "done": done_reasons.get(model, False),
                            },
                        }
                    )

                    # Add early stopping check: if a model completed with "stop" and it's the current best
                    if (
                        done_reasons.get(model)
                        == "stop"  # Check if the current model finished
                        and model
                        == metrics[
                            "best_model"
                        ]  # Check if it's the best one found so far
                    ):
                        # Early stop: The best model has finished generating.
                        yield json.dumps(
                            {
                                "status": "early_stopping",
                                "message": f"Best model ({model}) completed successfully - stopping early.",
                                "round": rounds,
                                "best_model": model,
                                "output": responses[model],
                                "score": scores[model],
                                "tokens": last_eval_count[model],
                            }
                        )
                        # Send final result notification
                        yield json.dumps(
                            {
                                "status": "final_result",
                                "reason": "best_model_completed",
                                "round": rounds,
                                "model": model,
                                "output": responses[model],
                                "score": scores[model],
                                "tokens": last_eval_count[model],
                                "done": True,
                            }
                        )
                        return  # Explicitly stop the generator
                    # prune worst model if worst than dc
                    worst_model = min(scores.keys(), key=lambda m: scores[m])

                    std_dev = np.std(list(scores.values()))
                    if scores[worst_model] > std_dev * EARLY_STOPPING_MARGIN_RATIO:

                        # Prune the worst model
                        active_models.discard(worst_model)
                        yield json.dumps(
                            {
                                "status": "model_pruned",
                                "round": rounds,
                                "model": worst_model,
                                "reason": "early_stopping",
                            }
                        )
                    # if best model is better than the rest by dc then keep only that generating
                    if (
                        scores[metrics["best_model"]]
                        > EARLY_STOPPING_MARGIN_RATIO * std_dev
                    ):
                        # Prune all other models
                        for m in active_models:
                            if m != metrics["best_model"]:
                                active_models.discard(m)
                                yield json.dumps(
                                    {
                                        "status": "model_pruned",
                                        "round": rounds,
                                        "model": m,
                                        "reason": "early_stopping",
                                    }
                                )

                else:
                    # No valid embedding for this model's output
                    active_models.discard(model)
                    yield json.dumps(
                        {
                            "status": "model_embedding_failed",
                            "round": rounds,
                            "model": model,
                        }
                    )

            # Check if all models are finished with "stop" reason - similar to run_program_stepwise
            if all(done_reasons.get(m) == "stop" for m in run_these_models):
                # Find best model by score
                best_model = max(scores.keys(), key=lambda m: scores[m])
                yield json.dumps(
                    {
                        "status": "final_result",
                        "round": rounds,
                        "reason": "all_models_completed",
                        "best_model": best_model,
                        "output": responses[best_model],
                        "score": scores[best_model],
                        "tokens": last_eval_count[best_model],
                        "done": True,  # Explicitly mark as done
                    }
                )
                return  # End the generator

            # Check if all models have finished (for any reason) - we only want to continue if any model hit length limit
            if all(done_reasons.get(m) in ["stop", "length"] for m in run_these_models):
                # If any model hit length limit but not max tokens, we should continue to next round
                length_limited_models = [
                    m for m in run_these_models if done_reasons.get(m) == "length"
                ]
                if (
                    length_limited_models
                    and cumulative_tokens + current_tokens < max_total_tokens
                    and rounds < max_rounds
                ):
                    # Will continue to next round for more tokens
                    break  # Break out of the inner loop to continue to next round

                # Otherwise, all models have completed or we hit token/round limits
                best_model = max(scores.keys(), key=lambda m: scores[m])

                reason = (
                    "all_models_completed"
                    if all(done_reasons.get(m) == "stop" for m in run_these_models)
                    else "length_limited"
                )
                yield json.dumps(
                    {
                        "status": "final_result",
                        "round": rounds,
                        "reason": reason,
                        "best_model": best_model,
                        "output": responses[best_model],
                        "score": scores[best_model],
                        "tokens": last_eval_count[best_model],
                        "completion_type": done_reasons.get(best_model, "unknown"),
                        "done": True,
                    }
                )
                return  # End the generator

        # Update model list for next round - keep only active models
        run_these_models = list(active_models)

        # If no models left, end
        if not run_these_models:
            if scores:
                best_model = max(scores.keys(), key=lambda m: scores[m])
                yield json.dumps(
                    {
                        "status": "final_result",
                        "reason": "all_models_removed",
                        "best_model": best_model,
                        "output": responses[best_model],
                        "score": scores[best_model],
                        "tokens": last_eval_count[best_model],
                        "done": True,
                    }
                )
            else:
                yield json.dumps(
                    {
                        "status": "error",
                        "error": "No models left and no valid scores",
                        "done": True,
                    }
                )
            return

        # Round summary with metrics
        yield json.dumps(
            {
                "status": "round_summary",
                "round": rounds,
                "metrics": {
                    "scores": {m: scores[m] for m in scores},
                    "best_model": metrics["best_model"],
                    "best_score": metrics["best_score"],
                    "details": metrics["round_metrics"],
                },
                "done": False,
            }
        )

        # Update tokens for next round - double the token count for next iteration
        cumulative_tokens += current_tokens
        next_tokens = current_tokens * 2
        if cumulative_tokens + next_tokens > max_total_tokens:
            next_tokens = max_total_tokens - cumulative_tokens
        current_tokens = max(1, next_tokens)

    # If we've exhausted all tokens or rounds
    if scores:
        best_model = max(scores.keys(), key=lambda m: scores[m])
        yield json.dumps(
            {
                "status": "final_result",
                "reason": "tokens_or_rounds_exhausted",
                "best_model": best_model,
                "output": responses[best_model],
                "score": scores[best_model],
                "tokens": last_eval_count[best_model],
                "done": True,  # Explicitly mark as done
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


###############################################################################
# STREAMING FUNCTION FOR EXTERNAL CALLS
###############################################################################
def stream_oua_results(
    system: str,
    prompt: str,
    token_budget: int = 2048,
    alpha: float = 0.7,
    beta: float = 0.3,
    dc: float = 0.5,
    models: list = None,
    embedding_model: str = "nomic-embed-text",
    messages=None,
):
    """
    Generator function that streams the results from the OUA algorithm.
    Yields JSON strings containing the partial results.
    Args:
        system: System prompt
        prompt: User prompt
        token_budget: Maximum tokens to use
        alpha: Weight for question similarity
        beta: Weight for inter-model consensus
        dc: Dynamic margin coefficient
        models: Custom list of models to use
        embedding_model: Custom embedding model
        messages: Optional pre-existing messages list
    Yields:
        JSON strings with partial results
    """
    global system_prompt, ALPHA, BETA, EARLY_STOPPING_MARGIN_RATIO, EMBEDDING_MODEL
    system_prompt = system

    # Handle messages parameter properly
    if messages is None:
        # If no messages provided, create a new list with system and user messages
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
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

    for result in stream_program_stepwise(
        question=prompt,
        start_tokens=64,
        max_rounds=10,
        max_tokens=token_budget,
        custom_system_prompt=system,
        alpha=alpha,
        beta=beta,
        dc=dc,
        models=models,
        embedding_model=embedding_model,
        messages=messages,
    ):
        # Pass through the result
        yield result

        # Check if this is a final result
        try:
            result_obj = json.loads(result)
            if result_obj.get("status") == "final_result" and result_obj.get(
                "done", False
            ):
                complete_response_received = True
                final_response = result
                # Don't break - let the generator complete naturally

            # Handle models hitting length limit but not final result yet
            if (
                result_obj.get("status") == "model_finished"
                or result_obj.get("status") == "model_progress"
            ) and result_obj.get("reason") == "length":
                # Just pass through, we'll handle this in the stream_program_stepwise function
                pass
        except json.JSONDecodeError:
            pass  # Ignore JSON parsing errors

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
