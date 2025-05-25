import os
import json
import logging
import ollama
import re
import sys
from starlette.background import BackgroundTask
from typing import Optional, Dict, Any, Iterator, List, Union
from fastapi import APIRouter, Request, Response
from fastapi.responses import StreamingResponse, JSONResponse


# Use standard logger
logger = logging.getLogger("llmms")
# Import LLM-MS modules from the local app directory
from app.metallm.LLM_MS_OUA import stream_program_stepwise
from app.metallm.LLM_MS_MAB import stream_llm_ms_mab

router = APIRouter()


def stream_llm_ms_oua(
    system_prompt: str, messages: List[Dict[str, str]], config: Dict[Any, Any]
) -> Iterator[str]:
    """
    Stream responses from LLM-MS-OUA algorithm in chunks.
    Returns a generator that yields partial results.
    """
    # Extract config parameters or use defaults
    # start_tokens = config.get("START_TOKENS", 64)
    # max_rounds = config.get("MAX_ROUNDS", 10)
    max_tokens = config.get("MAX_TOKENS", 1024)
    alpha = config.get("ALPHA", 0.7)
    beta = config.get("BETA", 0.3)
    dynamic_margin_coeff = config.get("DYNAMIC_MARGIN_COEFF", 0.5)
    models = config.get("MODELS", None)
    embedding_model = config.get("EMBEDDING_MODEL", "nomic-embed-text")

    # Add initialization message with full config info for tracking
    yield json.dumps(
        {
            "status": "initialized",
            "message": "Starting OUA algorithm",
            "config": {
                "start_tokens": int(
                    max_tokens / len(models) if models and len(models) > 0 else max_tokens / 4
                ),
              
                "alpha": alpha,
                "beta": beta,
                "dynamic_margin_coeff": dynamic_margin_coeff,
                "models": models,
                "embedding_model": embedding_model,
            },
        }
    )

    # Extract the last user message for the question parameter
    user_prompt = ""
    if messages:
        # Iterate backwards to find the last user message efficiently
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                user_prompt = messages[i].get("content", "")
                break

    stream_ended_with_final_result = False
    active_models = set(models) if models else set()  # Track active models to handle pruning events safely
    pruned_models = set()  # Keep track of pruned models explicitly
  
    

    # We'll create our own wrapper around the algorithm to inject pruning awareness
    def handle_stream_results():
        try:
            # Create a safe generator to avoid iteration errors
            generator = stream_program_stepwise(
                question=user_prompt,
                start_tokens=int(max_tokens / len(models) if models and len(models) > 0 else max_tokens / 4),
                max_rounds=10,
                max_tokens=max_tokens,
                custom_system_prompt=system_prompt,
                alpha=alpha,
                beta=beta,
                dc=dynamic_margin_coeff,
                models=models,
                embedding_model=embedding_model,
                messages=messages,  # Pass the full messages array
            )
            
            # First yield each result, then track any pruning
            for result in generator:
                # First update our tracking
              
                # Then yield the result
                yield result
                try:
                    obj = json.loads(result)
                    if obj.get("status") == "initialized" and "models" in obj:
                        active_models = set(obj["models"])
                        pruned_models = set()
                    if obj.get("status") == "model_pruned" and "model" in obj:
                        model = obj["model"]
                        pruned_models.add(model)
                        if model in active_models:
                            active_models.remove(model)
                except Exception:
                    pass
                
        except RuntimeError as re:
            if "Set changed size during iteration" in str(re):
                logger.warning("Caught set iteration error. Returning graceful error message.")
                # Include information about which models were pruned in our error
                yield json.dumps({
                    "status": "error", 
                    "error": "Model pruning conflict detected.",
                    "details": f"Set changed during iteration. Pruned models: {list(pruned_models)}",
                    "pruned_models": list(pruned_models),
                    "active_models": list(active_models),
                    "done": True,
                    "reason": "pruning_conflict",
                    "response": "Unfortunately, the response was incomplete due to a technical issue with model pruning."
                })
            else:
                raise re

    try:
        # Use our pruning-aware generator wrapper
        for result in handle_stream_results():
            # Yield the result directly
            yield result
            
            # Check if this is a final result
            try:
                result_obj = json.loads(result)
                
                # Detect final result conditions
                if result_obj.get("done", False) and (
                    result_obj.get("status") in ["final_result", "error"] or
                    (result_obj.get("status") == "final_result" and
                     result_obj.get("reason") in ["stop", "all_models_completed", "tokens_or_rounds_exhausted", "pruning_conflict"])
                ):
                    logger.debug(f"Stream completed with status: {result_obj.get('status')} reason: {result_obj.get('reason', 'unknown')}")
                    stream_ended_with_final_result = True
                    break
                
                # Don't break for length-limited completions unless it's the final result
                if (
                    result_obj.get("status") == "final_result"
                    and result_obj.get("reason") == "length_limited"
                    and result_obj.get("done", False)
                ):
                    logger.debug("Stream completed with length limitation")
                    stream_ended_with_final_result = True
                    break
                
                # Detect if all models have been pruned
                if result_obj.get("status") == "model_pruned" and len(active_models) == 0:
                    logger.warning("All models have been pruned, ending stream gracefully")
                    yield json.dumps({
                        "status": "final_result",
                        "message": "All models have been pruned, ending generation.",
                        "response": "Generation incomplete: all models were pruned during processing.",
                        "done": True,
                        "reason": "all_models_pruned"
                    })
                    stream_ended_with_final_result = True
                    break
                    
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON in OUA stream chunk: {result[:200]}...")
            except Exception as e_inner:
                logger.warning(f"Error processing OUA stream chunk: {e_inner} - Result: {result[:200]}...")
        
        if not stream_ended_with_final_result:
            logger.info("OUA stream loop finished without a recognized final_result chunk. Yielding generic completion.")
            yield json.dumps({"status": "completed_stream_end", "message": "Stream ended.", "done": True, "reason": "loop_completed"})

    except Exception as e:
        logger.error(f"Error in stream_llm_ms_oua: {str(e)}", exc_info=True)
        yield json.dumps({"status": "error", "error": str(e), "done": True})


def stream_llm_ms_mab(
    system_prompt: str, messages: List[Dict[str, str]], config: Dict[Any, Any]
) -> Iterator[str]:
    """
    Stream responses from LLM-MS-MAB algorithm in chunks.
    Returns a generator that yields partial results.
    """
    # Extract config parameters or use defaults
    max_rounds = config.get("MAX_ROUNDS", 50)
    total_token_budget = config.get("MAX_TOKENS", 1024)
    # Get MAB-specific parameters
    alpha = config.get("ALPHA", 0.7)
    beta = config.get("BETA", 0.3)
    xplore_coeff = config.get("XPLORE_COEFF", 0.3)
    embedding_model = config.get("EMBEDDING_MODEL", "nomic-embed-text")
    early_stopping_margin_ratio = config.get("DYNAMIC_MARGIN_COEFF", None) # Note: DYNAMIC_MARGIN_COEFF used here
    models = config.get("MODELS", None)
    # Add initialization message with full configuration
    yield json.dumps(
        {
            "status": "initialized",
            "message": "Starting MAB algorithm",
            "config": {
                "max_rounds": max_rounds,
                "total_token_budget": total_token_budget,
                "alpha": alpha,
                "beta": beta,
                "xplore_coeff": xplore_coeff,
                "embedding_model": embedding_model,
                "early_stopping_margin_ratio": early_stopping_margin_ratio,
                "models": models,
            },
        }
    )

    # Extract the last user message for the question parameter
    user_prompt = ""
    if messages:
        # Iterate backwards to find the last user message efficiently
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                user_prompt = messages[i].get("content", "")
                break

    stream_ended_with_final_result = False
    active_models = set()  # Track active models to handle pruning events safely
    pruned_models = set()  # Keep track of pruned models explicitly
    
    # Capture the model pruning in our wrapper function
    def track_pruning(models_json):
        try:
            # Process the result to track model pruning
            obj = json.loads(models_json)
            
            # Initialize model set if we're starting
            if obj.get("status") == "initialized" and "models" in obj:
                active_models.update(obj.get("models", []))
                
            # Handle model pruning
            if obj.get("status") == "model_pruned" and "model" in obj:
                pruned_model = obj.get("model")
                if pruned_model in active_models:
                    active_models.remove(pruned_model)
                    pruned_models.add(pruned_model)
                    logger.info(f"MAB: Tracking pruned model: {pruned_model}")
            
            # Always pass through the original JSON
            return models_json
        except Exception as e:
            logger.warning(f"Error tracking MAB model pruning: {e}")
            return models_json

    # We'll create our own wrapper around the algorithm to inject pruning awareness
    def yield_with_pruning_awareness():
        try:
            # Import the correct function from LLM_MS_MAB module
            from app.metallm.LLM_MS_MAB import stream_llm_ms_mab as mab_function

            # Log the configuration for debugging
            logger.debug(f"MAB config: max_rounds={max_rounds}, tokens={total_token_budget}, models={models}")

            # Create a generator with the appropriate parameters
            algorithm_generator = mab_function(
                question=user_prompt,
                max_rounds=max_rounds,
                total_token_budget=total_token_budget,
                a=alpha,
                b=beta,
                dc=xplore_coeff,
                models=models,
                embedding_model=embedding_model,
                early_stopping_margin_ratio=early_stopping_margin_ratio,
                custom_system_prompt=system_prompt,
                messages=messages,  # Pass the full messages array
            )
            
            # First yield each result, then track any pruning
            for result in algorithm_generator:
                # First update our tracking
                result = track_pruning(result)
                # Then yield the result
                yield result
                
        except RuntimeError as re:
            if "Set changed size during iteration" in str(re):
                logger.warning("Caught set iteration error in MAB. Returning graceful error message.")
                # Include information about which models were pruned in our error
                yield json.dumps({
                    "status": "error", 
                    "error": "Model pruning conflict detected in MAB algorithm.",
                    "details": f"Set changed during iteration. Pruned models: {list(pruned_models)}",
                    "pruned_models": list(pruned_models),
                    "active_models": list(active_models),
                    "done": True,
                    "reason": "pruning_conflict",
                    "response": "Unfortunately, the response was incomplete due to a technical issue with model pruning."
                })
            else:
                raise re

    try:
        # Use our pruning-aware generator wrapper
        for result in yield_with_pruning_awareness():
            # Process metrics if needed
            try:
                result_obj = json.loads(result)
                
                # Add metrics processing if needed
                if "score" in result_obj and "metrics" not in result_obj:
                    # Create a new dictionary rather than modifying in place
                    new_result_obj = dict(result_obj)
                    new_result_obj["metrics"] = {"score": result_obj["score"]}
                    result = json.dumps(new_result_obj)
                
                # Detect if this is a final result
                if result_obj.get("done", False) and (
                    result_obj.get("status") in ["final_result", "error"] or
                    (result_obj.get("status") == "final_result" and
                     result_obj.get("reason") in ["stop", "all_models_completed", "tokens_or_rounds_exhausted", "pruning_conflict"])
                ):
                    logger.debug(f"MAB stream completed with status: {result_obj.get('status')} reason: {result_obj.get('reason', 'unknown')}")
                    stream_ended_with_final_result = True
                    yield result
                    break
                
                # Handle length-limited final results
                if (
                    result_obj.get("status") == "final_result"
                    and result_obj.get("reason") == "length_limited"
                    and result_obj.get("done", False)
                ):
                    logger.debug("MAB stream completed with length limitation")
                    stream_ended_with_final_result = True
                    yield result
                    break
                
                # Detect if all models have been pruned
                if result_obj.get("status") == "model_pruned" and len(active_models) == 0:
                    logger.warning("All MAB models have been pruned, ending stream gracefully")
                    yield json.dumps({
                        "status": "final_result",
                        "message": "All models have been pruned, ending generation.",
                        "response": "Generation incomplete: all models were pruned during processing.",
                        "done": True,
                        "reason": "all_models_pruned"
                    })
                    stream_ended_with_final_result = True
                    break
                
                # If no special conditions, just yield the result
                yield result
                    
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON received from MAB, cannot parse: {result[:200]}...")
                # Yield an error message for this specific chunk
                yield json.dumps({
                    "status": "error",
                    "message": "Invalid JSON chunk received from MAB",
                    "details": f"Problematic data: {result[:50]}...",
                    "done": False,  # Stream itself is not necessarily done
                })
            except Exception as e_inner:
                logger.warning(f"Error processing MAB stream chunk: {e_inner} - Result: {result[:200]}...")
                # Just yield the original result if we couldn't process it
                yield result
        
        # Only yield the completion message if we didn't end with a final result
        if not stream_ended_with_final_result:
            logger.info("MAB stream loop finished without a recognized final_result chunk. Yielding generic completion.")
            yield json.dumps({"status": "completed_stream_end", "message": "Stream ended.", "done": True, "reason": "loop_completed"})

    except Exception as e:
        logger.error(f"Error in stream_llm_ms_mab: {str(e)}", exc_info=True)
        yield json.dumps({"status": "error", "error": str(e), "done": True})


@router.post("/send_message_llmms")
async def send_message_llmms(request: Request):
    """
    Endpoint to handle message sending and return streaming responses from LLM-MS algorithms.
    """
    try:
        # Parse the request data
        data = await request.json()
        # Extract messages array, algorithm type, and configuration
        messages = data.get("messages", [])
        algorithm_type = data.get("algorithm_type", "stepwise") # Default to stepwise (OUA)
        config = data.get("config", {})
        
        # Use a more robust default system prompt
        default_system_prompt = """You are a concise and direct assistant. Provide brief, to-the-point answers 
with minimal elaboration. Strive to be factually correct, and explicitly state 
when you are unsure. Avoid mentioning that you are an AI model or adding 
unnecessary disclaimers. Focus on clarity, correctness, and relevance above all."""
        system_prompt = data.get("system_prompt", default_system_prompt)
        if not system_prompt or not system_prompt.strip(): # Ensure it's not empty or just whitespace
            system_prompt = default_system_prompt


        # Check if any messages are available
        if not messages and "message" in data:
            # Handle legacy format where "message" might be directly provided
            message = data.get("message", "")
            if message:
                # Convert single message to messages array format
                messages = [{"role": "user", "content": message}]

        if not messages:
            return JSONResponse(
                status_code=400,
                content={"error": "No messages found in the request"},
            )

        logger.info(f"Processing request with algorithm type: {algorithm_type}")
        logger.debug(f"Messages count: {len(messages)}")
        logger.debug(f"Config: {config}")

        # Enhanced error handling function for the stream itself
        async def error_stream_generator(error_msg: str):
            error_json = json.dumps(
                {"status": "error", "error": error_msg, "done": True}
            )
            yield error_json

        # Select the appropriate algorithm based on the request
        if algorithm_type.lower() == "mab":
            logger.info("Using MAB algorithm")
            generator = stream_llm_ms_mab(system_prompt, messages, config)
        else:  # Default to stepwise (OUA)
            logger.info("Using OUA (stepwise) algorithm")
            generator = stream_llm_ms_oua(system_prompt, messages, config)
            
        # Return a streaming response with headers that ensure proper streaming
        return StreamingResponse(
            generator,
            media_type="application/json", # Ensure correct media type for JSON streaming
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # Helpful for Nginx proxying
                "Content-Type": "application/json; charset=utf-8", # Explicitly set Content-Type
            },
        )
    except Exception as e:
        logger.error(f"Critical error in send_message_llmms endpoint: {str(e)}", exc_info=True)
        # Return error as a streaming response so the client can handle it properly
        return StreamingResponse(
            error_stream_generator(f"Server error: {str(e)}"), # Use the async generator
            status_code=500,
            media_type="application/json",
            headers={"Cache-Control": "no-cache", "Content-Type": "application/json; charset=utf-8"},
        )
