import json
import logging
from typing import Any, Dict, Iterator, List

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.metallm.LLM_MS_OUA import stream_program_stepwise
from app.metallm.LLM_MS_MAB import stream_llm_ms_mab

router = APIRouter()
logger = logging.getLogger("llmms")


DEFAULT_SYSTEM_PROMPT = """You are a concise and direct assistant. Provide brief, to-the-point answers 
with minimal elaboration. Strive to be factually correct, and explicitly state 
when you are unsure. Avoid mentioning that you are an AI model or adding 
unnecessary disclaimers. Focus on clarity, correctness, and relevance above all."""

ALLOWED_MODELS = {
    "qwen3-vl:8b",
    "gemma3n:e2b",
    # "granite4.1:8b",
    "lfm2.5:latest",
    "qwen3.5:2b",
}


def _extract_user_prompt(messages: List[Dict[str, str]]) -> str:
    if not messages:
        return ""
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            return messages[i].get("content", "")
    return ""


def stream_llm_ms_oua(system_prompt: str, messages: List[Dict[str, str]], config: Dict[Any, Any]) -> Iterator[str]:
    max_tokens = int(config.get("MAX_TOKENS", 1024))
    start_tokens = int(config.get("START_TOKENS", max(1, max_tokens // 4)))
    max_rounds = int(config.get("MAX_ROUNDS", 100))
    alpha = float(config.get("ALPHA", 0.7))
    beta = float(config.get("BETA", 0.3))
    dynamic_margin_coeff = float(config.get("DYNAMIC_MARGIN_COEFF", 0.5))
    models = config.get("MODELS", None)
    embedding_model = config.get("EMBEDDING_MODEL", "nomic-embed-text")

    question = _extract_user_prompt(messages)
    yield from stream_program_stepwise(
        question=question,
        start_tokens=start_tokens,
        max_rounds=max_rounds,
        max_tokens=max_tokens,
        custom_system_prompt=system_prompt,
        alpha=alpha,
        beta=beta,
        dc=dynamic_margin_coeff,
        models=models,
        embedding_model=embedding_model,
        messages=messages,
    )


def stream_llm_ms_mab_wrapper(system_prompt: str, messages: List[Dict[str, str]], config: Dict[Any, Any]) -> Iterator[str]:
    max_rounds = int(config.get("MAX_ROUNDS", 127))
    total_token_budget = int(config.get("MAX_TOKENS", 1024))
    alpha = float(config.get("ALPHA", 0.7))
    beta = float(config.get("BETA", 0.3))
    xplore_coeff = float(config.get("XPLORE_COEFF", 0.3))
    dynamic_margin_coeff = config.get("DYNAMIC_MARGIN_COEFF", 0.5)
    embedding_model = config.get("EMBEDDING_MODEL", "nomic-embed-text")
    models = config.get("MODELS", None)

    question = _extract_user_prompt(messages)
    yield from stream_llm_ms_mab(
        question=question,
        max_rounds=max_rounds,
        total_token_budget=total_token_budget,
        a=alpha,
        b=beta,
        dc=xplore_coeff,
        models=models,
        embedding_model=embedding_model,
        early_stopping_margin_ratio=dynamic_margin_coeff,
        custom_system_prompt=system_prompt,
        messages=messages,
    )


@router.post("/send_message_llmms")
async def send_message_llmms(request: Request):
    try:
        data = await request.json()
        messages = data.get("messages", [])
        algorithm_type = str(data.get("algorithm_type", "stepwise")).lower()
        config = data.get("config", {})
        if not isinstance(config, dict):
            return JSONResponse(status_code=400, content={"error": "Invalid LLM-MS configuration"})

        requested_models = config.get("MODELS", [])

        if (
            not isinstance(requested_models, list)
            or not requested_models
            or any(not isinstance(model, str) for model in requested_models)
        ):
            return JSONResponse(status_code=400, content={"error": "Select at least one supported model"})

        invalid_models = [model for model in requested_models if model not in ALLOWED_MODELS]
        if invalid_models:
            return JSONResponse(
                status_code=400,
                content={"error": "Unsupported model selection", "models": invalid_models},
            )

        config["MODELS"] = list(dict.fromkeys(requested_models))

        system_prompt = data.get("system_prompt", DEFAULT_SYSTEM_PROMPT)
        if not system_prompt or not str(system_prompt).strip():
            system_prompt = DEFAULT_SYSTEM_PROMPT

        if not messages and "message" in data:
            if data.get("message"):
                messages = [{"role": "user", "content": data.get("message", "")}]

        if not messages:
            return JSONResponse(status_code=400, content={"error": "No messages found in the request"})

        logger.info("Processing LLM-MS request with algorithm=%s", algorithm_type)

        if algorithm_type == "mab":
            generator = stream_llm_ms_mab_wrapper(system_prompt, messages, config)
        else:
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
    except Exception as exc:
        logger.error("Critical error in send_message_llmms endpoint: %s", str(exc), exc_info=True)

        def _error_stream():
            yield json.dumps({"status": "error", "error": f"Server error: {str(exc)}", "done": True})

        return StreamingResponse(
            _error_stream(),
            status_code=500,
            media_type="application/json",
            headers={
                "Cache-Control": "no-cache",
                "Content-Type": "application/json; charset=utf-8",
            },
        )
