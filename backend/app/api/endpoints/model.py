import os
import json
import tempfile
from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import JSONResponse
import ollama

from app.utils.text_utils import get_context_length
from app.utils.file_extraction import handle_text_extraction

router = APIRouter()

ALLOWED_MODELS = [
    "qwen3-vl:8b",
    "gemma3n:e2b",
    # "granite4.1:8b",
    "lfm2.5:latest",
    "qwen3.5:2b",
]


@router.get("/get_models")
async def get_models():
    try:
        # List available models via ollama
        models = ollama.list().get("models", [])
        if not models:
            return JSONResponse({"error": "No models found"}, status_code=404)

        models_by_name = {
            getattr(model, "model", None): model
            for model in models
            if getattr(model, "model", None)
        }

        formatted_models = []
        for model_name in ALLOWED_MODELS:
            if model_name not in models_by_name:
                continue
            try:
                # Get model details and determine context length
                model_details = ollama.show(model_name)
                context_length = get_context_length(model_details)
                capabilities = list(model_details.get("capabilities", []) or [])
            except Exception:
                context_length = -1
                capabilities = []

            # Format model name for display
            model_id = model_name
            model_name_formatted = model_name.split(":")[0].replace("-", " ").title()

            formatted_models.append(
                {
                    "id": model_id,
                    "name": model_name_formatted,
                    "context_length": context_length,
                    "capabilities": capabilities,
                }
            )

        return JSONResponse({"models": formatted_models}, status_code=200)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/create_model")
async def create_model(request: Request):
    try:
        # Retrieve form data from the request (multipart/form-data)
        form = await request.form()
        data = dict(form)
        base_model = data.get("from")
        model_name = data.get("name")
        num_ctx = data.get("num_ctx")
        template = data.get("template")
        system_message = data.get("system")
        adapter = data.get("adapter")
        license_text = data.get("license")
        parameters_str = data.get("parameters", "{}")
        messages_str = data.get("messages", "[]")

        parameters = json.loads(parameters_str)
        messages = json.loads(messages_str)

        # Check if a file was uploaded
        file = form.get("file")
        behavioral_text = ""
        if file is not None and hasattr(file, "read"):
            # Use the file extraction utility; adjust if your function should be async
            behavioral_text = handle_text_extraction(file)

        # Combine system_message with behavioral_text if present
        if behavioral_text and not behavioral_text.startswith("Error"):
            if system_message:
                system_message += f"\n\nBehavioral Laws:\n{behavioral_text}"
            else:
                system_message = f"Behavioral Laws:\n{behavioral_text}"

        # Build the modelfile content
        modelfile_content = f"FROM {base_model}\n"
        if num_ctx:
            modelfile_content += f"PARAMETER num_ctx {num_ctx}\n"
        if system_message:
            modelfile_content += f'SYSTEM """\n{system_message}\n"""\n'
        if template:
            modelfile_content += f'TEMPLATE """\n{template}\n"""\n'
        if adapter:
            modelfile_content += f'ADAPTER "{adapter}"\n'
        if license_text:
            modelfile_content += f'LICENSE """\n{license_text}\n"""\n'
        for param, value in parameters.items():
            modelfile_content += f"PARAMETER {param} {value}\n"
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            modelfile_content += f'MESSAGE {role} "{content}"\n'

        # Write the modelfile to a temporary file
        with tempfile.NamedTemporaryFile(
            mode="w", delete=False, suffix=".modelfile"
        ) as tmp:
            tmp.write(modelfile_content)
            tmp_modelfile_path = tmp.name

        # Create the model via ollama and remove the temporary file
        ollama.create(model_name, tmp_modelfile_path)
        os.unlink(tmp_modelfile_path)

        return JSONResponse(
            {"message": f"Model {model_name} created successfully"}, status_code=200
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
