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
logger = logging.getLogger("new_chat")
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
    start_tokens = config.get("START_TOKENS", 64)
    max_rounds = config.get("MAX_ROUNDS", 10)
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
                "start_tokens": start_tokens,
                "max_rounds": max_rounds,
                "max_tokens": max_tokens,
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
    # Stream results directly from OUA streamer
    try:
        for result in stream_program_stepwise(
            question=user_prompt,
            start_tokens=start_tokens,
            max_rounds=max_rounds,
            max_tokens=max_tokens,
            custom_system_prompt=system_prompt,
            alpha=alpha,
            beta=beta,
            dc=dynamic_margin_coeff,
            models=models,
            embedding_model=embedding_model,
            messages=messages,  # Pass the full messages array
        ):
            # Already a JSON string, so return directly
            yield result
            # Check if this is a final result
            try:
                result_obj = json.loads(result)
                if (
                    result_obj.get("done", False)
                    and result_obj.get("status") == "final_result"
                    and result_obj.get("reason")
                    in [
                        "stop",
                        "all_models_completed",
                        "tokens_or_rounds_exhausted",
                        "length_limited",
                    ]
                ):
                    logger.debug(
                        f"Final OUA result received with reason: {result_obj.get('reason', 'unknown')}"
                    )
                    stream_ended_with_final_result = True
                    break
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON in OUA stream: {result[:200]}...")
            except Exception as e_inner: 
                logger.warning(f"Error processing OUA stream chunk: {e_inner} - Result: {result[:200]}...")
        
        if not stream_ended_with_final_result:
            logger.info("OUA stream loop (new_chat) finished without a recognized final_result. Yielding generic completion.")
            yield json.dumps({"status": "completed_stream_end", "message": "Stream ended.", "done": True, "reason": "loop_completed"})

    except Exception as e:
        logger.error(f"Error in stream_llm_ms_oua (new_chat): {str(e)}", exc_info=True)
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
    early_stopping_margin_ratio = config.get("EARLY_STOPPING_MARGIN_RATIO", None)
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
    # Stream directly from MAB streamer
    try:
        # Import the correct function from LLM_MS_MAB module
        from app.metallm.LLM_MS_MAB import stream_llm_ms_mab as mab_function

        # Log the configuration for debugging
        logger.debug(
            f"MAB config: max_rounds={max_rounds}, tokens={total_token_budget}, models={models}"
        )

        for result in mab_function(
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
        ):
            # Ensure result is valid JSON
            try:
                # Validate JSON by parsing and re-serializing
                result_obj = json.loads(result)
                validated_result = json.dumps(result_obj)
                # Add additional metrics processing if needed
                if "score" in result_obj and "metrics" not in result_obj:
                    # Add a metrics object if score exists but no metrics object
                    result_obj["metrics"] = {"score": result_obj["score"]}
                    # Re-encode with added metrics
                    validated_result = json.dumps(result_obj)
                
                yield validated_result

                # Check if this is a final result
                if result_obj.get("done", False) and (
                    result_obj.get("status") == "final_result"
                    and result_obj.get("reason")
                    in ["stop", "all_models_completed", "tokens_or_rounds_exhausted"]
                ):
                    logger.debug(
                        "Final MAB result (new_chat) received with reason: "
                        + result_obj.get("reason", "unknown")
                    )
                    stream_ended_with_final_result = True
                    break

                # Handle length-limited final results separately
                if (
                    result_obj.get("status") == "final_result"
                    and result_obj.get("reason") == "length_limited"
                    and result_obj.get("done", False)
                ):
                    logger.debug("Stream (new_chat) completed with length limitation")
                    stream_ended_with_final_result = True
                    break
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON received from MAB (new_chat): {result[:200]}...")
                yield json.dumps(
                    {
                        "status": "error",
                        "message": "Invalid result format from MAB (new_chat)",
                        "done": False,
                    }
                )
            except Exception as e_inner:
                 logger.warning(f"Error processing MAB stream chunk (new_chat): {e_inner} - Result: {result[:200]}...")
        
        if not stream_ended_with_final_result:
            logger.info("MAB stream loop (new_chat) finished without a recognized final_result. Yielding generic completion.")
            yield json.dumps({"status": "completed_stream_end", "message": "Stream ended.", "done": True, "reason": "loop_completed"})

    except Exception as e:
        logger.error(f"Error in stream_llm_ms_mab (new_chat): {str(e)}", exc_info=True)
        yield json.dumps({"status": "error", "error": str(e), "done": True})


@router.post("/send_message_llmms_dev") # Matches the endpoint in new_chat.html if it uses this
async def send_message_llmms_dev_endpoint(request: Request): # Renamed function to avoid conflict if imported elsewhere
    """
    Endpoint to handle message sending and return streaming responses from LLM-MS algorithms.
    (This is the version in new_chat.py, potentially for development or a different UI)
    """
    try:
        # Parse the request data
        data = await request.json()
        # Extract messages array, algorithm type, and configuration
        messages = data.get("messages", [])
        algorithm_type = data.get("algorithm_type", "stepwise")
        config = data.get("config", {})

        default_system_prompt = """You are a concise and direct assistant. Provide brief, to-the-point answers 
with minimal elaboration. Strive to be factually correct, and explicitly state 
when you are unsure. Avoid mentioning that you are an AI model or adding 
unnecessary disclaimers. Focus on clarity, correctness, and relevance above all."""
        system_prompt = data.get("system_prompt", default_system_prompt)
        if (
            not system_prompt or not system_prompt.strip()
        ):  # Ensure it's not empty or just whitespace
            system_prompt = default_system_prompt

        # Check if any messages are available
        if not messages and "message" in data:
            message = data.get("message", "")
            if message:
                messages = [{"role": "user", "content": message}]

        if not messages:
            return JSONResponse(
                status_code=400,
                content={"error": "No messages found in the request"},
            )

        logger.info(f"Processing request (new_chat) with algorithm type: {algorithm_type}")
        logger.debug(f"Messages count (new_chat): {len(messages)}")
        logger.debug(f"Config (new_chat): {config}")

        async def error_stream_generator(error_msg: str):
            error_json = json.dumps(
                {"status": "error", "error": error_msg, "done": True}
            )
            yield error_json

        if algorithm_type.lower() == "mab":
            logger.info("Using MAB algorithm (new_chat)")
            generator = stream_llm_ms_mab(system_prompt, messages, config)
        else:  # Default to stepwise
            logger.info("Using Stepwise (OUA) algorithm (new_chat)")
            generator = stream_llm_ms_oua(system_prompt, messages, config)
            
        return StreamingResponse(
            generator,
            media_type="application/json",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                "Content-Type": "application/json; charset=utf-8",
            },
        )
    except Exception as e:
        logger.error(f"Critical error in send_message_llmms_dev endpoint: {str(e)}", exc_info=True)
        return StreamingResponse(
            error_stream_generator(f"Server error: {str(e)}"),
            status_code=500,
            media_type="application/json",
            headers={"Cache-Control": "no-cache", "Content-Type": "application/json; charset=utf-8"},
        )
