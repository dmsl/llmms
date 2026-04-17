"""Structured output endpoints.

Additive API for Instructor + Pydantic based extraction.
Existing chat and agent paths are unaffected.
"""

from typing import Any, Dict, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, create_model

from app.core.structured_llm import StructuredLLMService, StructuredLLMError

router = APIRouter(prefix="/api/structured", tags=["structured"])


class FieldSpec(BaseModel):
    type: Literal["string", "integer", "number", "boolean"] = "string"
    description: str = ""
    required: bool = True


class StructuredExtractRequest(BaseModel):
    input_text: str = Field(..., min_length=1, description="Source text to extract from")
    schema_name: str = Field(default="ExtractedData", min_length=1)
    fields: Dict[str, FieldSpec] = Field(default_factory=dict)


class StructuredExtractResponse(BaseModel):
    model_name: str
    data: Dict[str, Any]


TYPE_MAP = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
}


def _build_dynamic_model(schema_name: str, fields: Dict[str, FieldSpec]) -> type[BaseModel]:
    if not fields:
        raise HTTPException(status_code=400, detail="'fields' must contain at least one field")

    model_fields = {}
    for field_name, spec in fields.items():
        py_type = TYPE_MAP.get(spec.type, str)
        default = ... if spec.required else None
        model_fields[field_name] = (
            py_type,
            Field(default=default, description=spec.description),
        )

    return create_model(schema_name, **model_fields)


@router.post("/extract", response_model=StructuredExtractResponse)
async def extract_structured(request: StructuredExtractRequest):
    """Extract a strictly-typed object from text using Instructor."""
    dynamic_model = _build_dynamic_model(request.schema_name, request.fields)

    field_lines = []
    for name, spec in request.fields.items():
        req_label = "required" if spec.required else "optional"
        field_lines.append(f"- {name} ({spec.type}, {req_label}): {spec.description}")

    prompt = (
        "Extract the requested structured data from the following text. "
        "Return only values that are present or strongly implied.\n\n"
        f"Schema: {request.schema_name}\n"
        f"Fields:\n{chr(10).join(field_lines)}\n\n"
        f"Text:\n{request.input_text}"
    )

    service = StructuredLLMService()

    try:
        result = service.extract(prompt, dynamic_model)
        return StructuredExtractResponse(
            model_name=request.schema_name,
            data=result.model_dump(),
        )
    except StructuredLLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
