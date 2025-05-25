import os
import json
import logging
import ollama
import re

from typing import Optional

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse


router = APIRouter()


logger = logging.getLogger(__name__)


@router.post("/send_message")
async def send_message(request: Request, file: Optional[UploadFile] = File(None)):
    """
    Process a chat message, handling either JSON data or form data with file upload.
    """
    try:
        model = None
        message_history = []

        # Check if a file was uploaded by inspecting the 'file' parameter
        if file is not None:
            # Assume form-data is being sent
            form = await request.form()
            model = form.get("model")
            messages_str = form.get("messages", "[]")
            try:
                message_history = json.loads(messages_str)
            except Exception as e:
                logger.error(f"Error parsing messages from form: {str(e)}")
                message_history = []

            logger.info(f"Processing message with file using model: {model}")

            try:
                file_content = (await file.read()).decode("utf-8")
                if message_history:
                    last_message = message_history[-1]
                    last_message["content"] = (
                        f"{last_message.get('content','')}\n\n"
                        f"File content from {file.filename}:\n{file_content}"
                    )
            except Exception as e:
                logger.error(f"Error reading file: {str(e)}")
                if message_history:
                    message_history[-1][
                        "content"
                    ] += f"\n\nNote: [Error reading file: {str(e)}]"
        else:
            # Regular chat without file upload; expecting JSON body
            data = await request.json()
            model = data.get("model")
            message_history = data.get("messages", [])
            user_message = (
                message_history[-1].get("content", "") if message_history else ""
            )
            websearch = data.get("websearch", False)

            logger.info(f"Processing regular chat with model: {model}")

            # Optionally add web search results if requested
            if websearch:
                from app.utils.text_utils import web_search

                webresults = (
                    "The following data is from a web search. Always tell the sources.\n"
                    + web_search(user_message, model, len(message_history))
                )
                if message_history:
                    message_history[-1]["content"] += webresults

        # Validate required parameters
        if not model:
            return JSONResponse(
                {"error": "Model parameter is required"}, status_code=400
            )
        if not message_history:
            return JSONResponse(
                {"error": "Message history is required"}, status_code=400
            )

        # Generator function to stream response chunks
        def generate_response():
            try:
                
                for chunk in ollama.chat(model=model, messages=message_history, stream=True):
                    content = chunk.get("message", {}).get("content", "")
                    if content:
                        # Remove content between <think> tags and between thought tags
                        cleaned_content = re.sub(
                            r"<think>.*?</think>", "", content, flags=re.DOTALL
                        )
                        cleaned_content = re.sub(
                            r"<\|begin_of_thought\|>.*?<\|end_of_thought\|>",
                            "",
                            cleaned_content,
                            flags=re.DOTALL,
                        )
                        # Remove solution tags but keep content
                        cleaned_content = re.sub(
                            r"<\|begin_of_solution\|>(.*?)<\|end_of_solution\|>",
                            r"\1",
                            cleaned_content,
                            flags=re.DOTALL,
                        )

                        yield cleaned_content

            except Exception as e:
                logger.error(f"Error in generate_response: {str(e)}")
                yield f"Error: {str(e)}"

        return StreamingResponse(generate_response(), media_type="text/plain")

    except Exception as e:
        logger.error(f"Error in send_message: {str(e)}")
        return JSONResponse({"error": str(e)}, status_code=500)
