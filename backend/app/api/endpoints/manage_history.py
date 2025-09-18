import json
import logging
import time
import asyncio
from functools import lru_cache

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

import ollama
from app.utils.text_utils import get_token_count, summarize_text
from app.utils.file_extraction import handle_text_extraction  # if used elsewhere

logger = logging.getLogger(__name__)

router = APIRouter()


# LRU cache for summarizations to avoid redundant processing
@lru_cache(maxsize=128)
def cached_summarize(text: str, model: str):
    """Cache summarization results to avoid redundant processing."""
    return summarize_text(text.strip(), model=model)


async def model_summarize(text: str, model: str, max_length: int = 150) -> str:
    """
    Use the LLM directly to generate a summary of the conversation.
    This is more accurate but potentially slower than template-based summarization.

    Args:
        text: The text to summarize.
        model: The model name to use.
        max_length: Target maximum length for the summary.

    Returns:
        A concise summary of the text.
    """
    try:
        # Limit input size to avoid unnecessary processing
        if len(text) > 12000:  # Approximate cutoff to avoid excessive tokens
            text = text[:12000] + "..."

        prompt = (
            f"Summarize the following conversation very concisely in {max_length} words or less. "
            f"Focus on key points, decisions, and questions. Keep factual information intact:\n\n"
            f"{text}\n\nConcise summary:"
        )

        # Call to Ollama API (assuming synchronous API call)
        response = ollama.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            options={"temperature": 0.3, "top_p": 0.9},
        )

        if response and "message" in response and "content" in response["message"]:
            summary = response["message"]["content"].strip()
            # Truncate if still too long
            if len(summary) > max_length * 7:  # Approximate character count
                summary = summary[: max_length * 7] + "..."
            return summary
        else:
            logger.warning(f"Unexpected response format from model: {response}")
            return cached_summarize(text, model)
    except Exception as e:
        logger.error(f"Error in model summarization: {str(e)}", exc_info=True)
        return cached_summarize(text, model)


@router.post("/manage_history")
async def manage_history(request: Request):
    """
    Manage conversation history by recursively summarizing older messages until
    the total token count fits within the model's maximum context window.
    """
    start_time = time.time()

    try:
        data = await request.json()
        if not data:
            return JSONResponse({"error": "Invalid JSON data"}, status_code=400)

        model = data.get("model")
        if not model:
            return JSONResponse({"error": "Model name not provided"}, status_code=400)

        max_context_tokens = data.get("max_tokens")
        if not max_context_tokens:
            return JSONResponse(
                {"error": "Could not retrieve model context length"}, status_code=501
            )

        message_history = data.get("messages", [])
        if not message_history:
            return JSONResponse(
                {"error": "No message history provided"}, status_code=400
            )

        # Use performance mode flag if provided, otherwise default to True
        performance_mode = data.get("performance_mode", True)

        # Recursively summarize history until it fits within max_context_tokens.
        updated_history, metrics = adaptive_summarize_history(
            message_history, max_context_tokens, model, performance_mode
        )

        # Add processing time to metrics
        metrics["processing_time_ms"] = round((time.time() - start_time) * 1000, 2)

        return JSONResponse(
            {
                "messages": updated_history,
                "metrics": metrics,
                "summarized_index": len(message_history),
            },
            status_code=200,
        )
    except Exception as e:
        logger.error(f"Error in manage_history: {str(e)}", exc_info=True)
        return JSONResponse({"error": f"Server error: {str(e)}"}, status_code=500)


def adaptive_summarize_history(
    message_history, max_tokens, model, performance_mode=True
):
    """
    Enhanced version of recursive summarization with adaptive batching and metrics.
    """
    # Initialize metrics
    metrics = {
        "original_token_count": 0,
        "final_token_count": 0,
        "summarization_rounds": 0,
        "messages_summarized": 0,
    }

    # Make a copy to avoid modifying the original
    messages = message_history.copy()

    # Calculate initial token count
    total_tokens = sum(get_token_count(msg["content"]) for msg in messages)
    metrics["original_token_count"] = total_tokens

    # If within limits, return as is
    if total_tokens <= max_tokens:
        metrics["final_token_count"] = total_tokens
        return messages, metrics

    # Separate system messages as they typically contain important context
    system_messages = [msg for msg in messages if msg["role"] == "system"]
    non_system_messages = [msg for msg in messages if msg["role"] != "system"]

    # Calculate tokens in system messages
    system_tokens = sum(get_token_count(msg["content"]) for msg in system_messages)

    # Reserve space for system messages
    available_tokens = max_tokens - system_tokens

    # If we can't even fit system messages, we need to summarize them too
    if available_tokens <= 0:
        logger.warning(
            f"System messages exceed token limit: {system_tokens} > {max_tokens}"
        )
        messages_to_process = messages
    else:
        messages_to_process = non_system_messages

    # Process until we fit within available tokens
    while (
        sum(get_token_count(msg["content"]) for msg in messages_to_process)
        > available_tokens
    ):
        metrics["summarization_rounds"] += 1

        # Identify batch size - prioritize older messages
        batch = []
        batch_token_count = 0
        target_batch_size = min(max(available_tokens // 3, 1000), max_tokens // 2)

        while messages_to_process and batch_token_count < target_batch_size:
            msg = messages_to_process.pop(0)
            msg_tokens = get_token_count(msg["content"])
            batch.append(msg)
            batch_token_count += msg_tokens
            metrics["messages_summarized"] += 1

        if not batch:
            logger.error("Failed to create a batch for summarization")
            break

        # Create text for summarization
        batch_text = "\n".join([f"{msg['role']}: {msg['content']}" for msg in batch])

        if performance_mode:
            summary = cached_summarize(batch_text, model)
        else:
            # Use model-based summarization synchronously (or wrap with asyncio.to_thread)
            summary = ollama.chat(
                model=model,
                messages=[
                    {
                        "role": "user",
                        "content": f"Summarize this conversation concisely: {batch_text[:8000]}",
                    }
                ],
            )["message"]["content"]

        if not summary:
            summary = "Summary not available due to processing error."
            logger.warning("Summarization failed, using fallback summary")

        summary_message = {
            "role": "system",
            "content": f"Conversation summary (from {len(batch)} messages): {summary}",
        }

        messages_to_process.insert(0, summary_message)

    # Recombine system messages with processed messages
    if available_tokens > 0 and system_messages:
        final_messages = system_messages + messages_to_process
    else:
        final_messages = messages_to_process

    metrics["final_token_count"] = sum(
        get_token_count(msg["content"]) for msg in final_messages
    )
    return final_messages, metrics


@router.post("/update_session")
async def update_session(request: Request):
    """
    Update the conversation session by adaptively summarizing the history.
    """
    start_time = time.time()

    try:
        data = await request.json()
        if not data:
            return JSONResponse({"error": "Invalid JSON data"}, status_code=400)

        model = data.get("model")
        if not model:
            return JSONResponse({"error": "Model name not provided"}, status_code=400)

        max_context_tokens = data.get("max_tokens")
        if not max_context_tokens:
            return JSONResponse(
                {"error": "Could not retrieve model context length"}, status_code=501
            )

        message_history = data.get("messages", [])
        if not message_history:
            return JSONResponse(
                {"error": "No message history provided"}, status_code=400
            )

        # If max_tokens is very small, assume session naming is required
        if max_context_tokens <= 10 and "generate_name" not in data:
            return await generate_session_name(message_history, model)

        performance_mode = data.get("performance_mode", True)
        updated_history, metrics = adaptive_summarize_history(
            message_history, max_context_tokens, model, performance_mode
        )
        metrics["processing_time_ms"] = round((time.time() - start_time) * 1000, 2)

        return JSONResponse(
            {
                "messages": updated_history,
                "metrics": metrics,
                "status": "success",
                "summarized_index": len(message_history),
            },
            status_code=200,
        )
    except Exception as e:
        logger.error(f"Error in update_session: {str(e)}", exc_info=True)
        return JSONResponse({"error": f"Server error: {str(e)}"}, status_code=500)


@router.post("/generate_session_name")
async def generate_session_name_endpoint(request: Request):
    """
    Generate a concise, descriptive name for a chat session based on its content.
    Returns plain text.
    """
    try:
        data = await request.json()
        if not data:
            return JSONResponse({"error": "Invalid JSON data"}, status_code=400)

        model = data.get("model")
        if not model:
            return JSONResponse({"error": "Model name not provided"}, status_code=400)

        message_history = data.get("messages", [])
        if not message_history:
            return JSONResponse(
                {"error": "No message history provided"}, status_code=400
            )

        return await generate_session_name(message_history, model)
    except Exception as e:
        logger.error(f"Error generating session name: {str(e)}", exc_info=True)
        return JSONResponse({"error": f"Server error: {str(e)}"}, status_code=500)


async def generate_session_name(messages, model):
    """
    Generate a concise, descriptive name for a chat session based on its content.
    Returns a plain text response.
    """
    try:
        # Use the last few messages for context
        context_messages = messages[-min(5, len(messages)) :]
        formatted_text = "\n".join(
            [
                f"{msg['role']}: {msg['content'][:100] + '...' if len(msg['content']) > 100 else msg['content']}"
                for msg in context_messages
            ]
        )

        prompt = (
            "Based on this conversation snippet, generate a very short, concise title (3-5 words max) "
            "that captures the main topic. Don't use quotes in your answer, just return the title itself:\n\n"
            f"{formatted_text}\n\nTitle:"
        )

        response = ollama.chat(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            options={"temperature": 0.7, "top_p": 0.9, "max_tokens": 15},
        )
        session_name = response["message"]["content"].strip()

        session_name = session_name.replace('"', "").replace("'", "").strip()
        if ":" in session_name:
            session_name = session_name.split(":", 1)[1].strip()

        if len(session_name) > 30:
            session_name = session_name[:27] + "..."
        if len(session_name) < 3:
            session_name = f"Chat {time.strftime('%b %d, %H:%M')}"

        return Response(session_name, media_type="text/plain")
    except Exception as e:
        logger.error(f"Error in session name generation: {str(e)}", exc_info=True)
        fallback_name = f"Chat {time.strftime('%b %d, %H:%M')}"
        return Response(fallback_name, media_type="text/plain")


def optimize_message_batch(messages, remaining_budget=None):
    """
    Optimize which messages to keep based on importance and recency.
    """
    if not messages:
        return []

    scored_messages = []
    for i, msg in enumerate(messages):
        score = 0
        if msg["role"] == "system":
            score += 100
        score += i * 0.5
        content_len = len(msg["content"])
        score += min(content_len / 200, 5)
        scored_messages.append((score, msg))

    scored_messages.sort(reverse=True)

    if remaining_budget:
        result = []
        current_tokens = 0
        for _, msg in scored_messages:
            msg_tokens = get_token_count(msg["content"])
            if current_tokens + msg_tokens <= remaining_budget:
                result.append(msg)
                current_tokens += msg_tokens
            else:
                break
        return result
    else:
        return [
            msg
            for _, msg in sorted(scored_messages, key=lambda x: messages.index(x[1]))
        ]
