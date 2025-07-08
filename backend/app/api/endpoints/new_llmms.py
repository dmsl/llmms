# app/api/new_llmms.py

import uuid
import json
import asyncio
import logging
from typing import List, Dict
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect, BackgroundTasks
from fastapi.responses import JSONResponse

from app.metallmws.LLM_MS_OUA import stream_llm_ms_oua
from app.metallmws.LLM_MS_MAB import stream_llm_ms_mab

router = APIRouter()
logger = logging.getLogger("llmms")

# In-memory registries of active WebSocket connections
active_llm_conns: Dict[str, Dict[str, List[WebSocket]]] = {}
active_metrics_conns: Dict[str, List[WebSocket]] = {}

### ─── WebSocket endpoints ─────────────────────────────────────────────

@router.websocket("/ws/llm/{stream_id}/{model_name}")
async def ws_llm_model(websocket: WebSocket, stream_id: str, model_name: str):
    await websocket.accept()
    logger.info(f"LLM WS connected: {stream_id}/{model_name}")
    active_llm_conns.setdefault(stream_id, {}).setdefault(model_name, []).append(websocket)
    try:
        while True:
            await asyncio.sleep(10)
    except WebSocketDisconnect:
        conns = active_llm_conns.get(stream_id, {}).get(model_name, [])
        if websocket in conns:
            conns.remove(websocket)
        logger.info(f"LLM WS disconnected: {stream_id}/{model_name}")


@router.websocket("/ws/metrics/{stream_id}")
async def ws_metrics(websocket: WebSocket, stream_id: str):
    await websocket.accept()
    logger.info(f"Metrics WS connected: {stream_id}")
    active_metrics_conns.setdefault(stream_id, []).append(websocket)
    try:
        while True:
            await asyncio.sleep(10)
    except WebSocketDisconnect:
        lst = active_metrics_conns.get(stream_id, [])
        if websocket in lst:
            lst.remove(websocket)
        logger.info(f"Metrics WS disconnected: {stream_id}")


def broadcast_llm(stream_id: str, model: str, message: str):
    """Send message to all LLM WebSockets."""
    for ws in active_llm_conns.get(stream_id, {}).get(model, []):
        logger.debug(f"Broadcasting to LLM WS {stream_id}/{model}: {message}")
        asyncio.create_task(ws.send_text(message))


def broadcast_metrics(stream_id: str, message: str):
    """Send message to all metrics WebSockets."""
    for ws in active_metrics_conns.get(stream_id, []):
        logger.debug(f"Broadcasting to metrics WS {stream_id}: {message}")
        asyncio.create_task(ws.send_text(message))


### ─── Kickoff endpoint ───────────────────────────────────────────────

@router.post("/start")
async def start_llmms(request: Request, background: BackgroundTasks):
    """
    Starts a new LLM-MS run and returns a stream_id.
    """
    payload = await request.json()

    # These fields come from your frontend:
    messages      = payload["messages"]
    algo          = payload.get("algorithm_type", "stepwise").lower()
    config        = payload.get("config", {})
    system_prompt = payload.get("system_prompt", "")

    # 1) Generate a unique stream_id
    stream_id = uuid.uuid4().hex
    logger.info(f"Starting new LLM-MS session: {stream_id} (algorithm={algo})")

    # 2) Schedule background work
    background.add_task(
        run_and_broadcast,
        stream_id,
        system_prompt,
        messages,
        config,
        algo
    )

    # 3) Return the chosen stream_id
    return JSONResponse({"stream_id": stream_id})


async def run_and_broadcast(
    stream_id: str,
    system_prompt: str,
    messages: list,
    config: dict,
    algo: str
):
    """
    Background task: invokes LLM-MS algorithm and pushes
    chunks into either metrics or LLM WebSockets.
    """

    # Build the combined prompt
    merged_prompt = build_prompt(system_prompt, messages)

    # Pick your algorithm
    if algo == "mab":
        gen = stream_llm_ms_mab(
            prompt=merged_prompt,
            start_tokens=config.get("start_tokens", 64),
            max_rounds=config.get("max_rounds", 10)
        )
    else:
        gen = stream_llm_ms_oua(
            prompt=merged_prompt,
            start_tokens=config.get("start_tokens", 64),
            max_rounds=config.get("max_rounds", 10)
        )

    try:
        async for chunk in _aiter(gen):
            if isinstance(chunk, str) and chunk.strip().startswith("{"):
                # JSON chunk → parse it
                try:
                    data = json.loads(chunk)
                except Exception as ex:
                    logger.warning(f"[{stream_id}] Bad JSON chunk: {chunk[:200]!r} | {ex}")
                    continue

                # broadcast all metrics JSON
                broadcast_metrics(stream_id, chunk)

                # additionally, if it contains final LLM output:
                if data.get("type") == "llm" and "output" in data:
                    model = data.get("model")
                    text = data.get("output") or ""
                    if model:
                        broadcast_llm(stream_id, model, text)

                if data.get("done") or data.get("status") in ("final_result", "error"):
                    logger.info(f"Ending stream {stream_id}")
                    break

            elif isinstance(chunk, tuple) and len(chunk) == 2:
                # tuple from generator: (model, text)
                model, text = chunk
                if model and text:
                    broadcast_llm(stream_id, model, text)

            else:
                logger.warning(f"[{stream_id}] Unexpected chunk type: {chunk!r}")

    except Exception as e:
        err = json.dumps({
            "type": "metrics",
            "status": "error",
            "error": str(e),
            "done": True
        })
        broadcast_metrics(stream_id, err)
        logger.exception(f"Error in LLM-MS runner for {stream_id}")


def build_prompt(system_prompt: str, messages: list) -> str:
    """
    Helper to merge system prompt and chat history
    into a single string prompt for the LLM.
    """
    prompt_lines = []
    if system_prompt:
        prompt_lines.append(system_prompt)

    for msg in messages:
        role = msg.get("role", "unknown").upper()
        content = msg.get("content", "")
        prompt_lines.append(f"{role}: {content}")

    return "\n".join(prompt_lines)


async def _aiter(sync_iter):
    """
    Wrap a synchronous generator into an async generator.
    """
    for x in sync_iter:
        yield x
        await asyncio.sleep(0)
