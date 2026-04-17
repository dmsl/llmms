"""Structured LLM utilities using Instructor + Pydantic.

This module is additive and does not alter existing chat/agent endpoints.
It provides a small service for extracting typed objects from LLM output.
"""

import os
import logging
from typing import Optional, Type, TypeVar

from pydantic import BaseModel

logger = logging.getLogger("structured_llm")

T = TypeVar("T", bound=BaseModel)


class StructuredLLMError(RuntimeError):
    """Raised when structured extraction fails."""


class StructuredLLMService:
    """Thin wrapper around Instructor for structured responses."""

    def __init__(
        self,
        provider_model: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> None:
        self.provider_model = provider_model or os.getenv(
            "STRUCTURED_LLM_PROVIDER_MODEL", "openai/gpt-4.1-mini"
        )
        self.mode_name = mode or os.getenv("STRUCTURED_LLM_MODE", "RESPONSES_TOOLS")
        self._client = None

    def _get_client(self):
        if self._client is not None:
            return self._client

        try:
            import instructor
        except Exception as exc:  # pragma: no cover - runtime dependency guard
            raise StructuredLLMError(
                "Instructor is not installed. Install with: pip install instructor openai pydantic"
            ) from exc

        mode = getattr(instructor.Mode, self.mode_name, instructor.Mode.RESPONSES_TOOLS)

        # Preferred modern API.
        try:
            self._client = instructor.from_provider(self.provider_model, mode=mode)
            logger.info(
                "StructuredLLMService initialized with from_provider(model=%s, mode=%s)",
                self.provider_model,
                self.mode_name,
            )
            return self._client
        except Exception as provider_exc:
            logger.warning("from_provider failed, attempting OpenAI patch fallback: %s", provider_exc)

        # Fallback for existing OpenAI client setups.
        try:
            from openai import OpenAI

            raw = OpenAI(api_key=os.getenv("OPENAI_API_KEY"), base_url=os.getenv("OPENAI_BASE_URL"))
            self._client = instructor.from_openai(raw)
            logger.info("StructuredLLMService initialized with from_openai fallback")
            return self._client
        except Exception as fallback_exc:  # pragma: no cover - dependency/runtime path
            raise StructuredLLMError(
                f"Failed to initialize structured LLM client: {fallback_exc}"
            ) from fallback_exc

    def extract(
        self,
        prompt: str,
        response_model: Type[T],
        *,
        max_retries: int = 2,
    ) -> T:
        """Extract a typed object from plain text using Instructor."""
        client = self._get_client()

        try:
            if hasattr(client, "responses"):
                # Responses API style (documented current pattern).
                return client.responses.create(
                    input=prompt,
                    response_model=response_model,
                    max_retries=max_retries,
                )

            # Legacy chat completions style.
            return client.chat.completions.create(
                model=self.provider_model.split("/", 1)[-1],
                messages=[{"role": "user", "content": prompt}],
                response_model=response_model,
                max_retries=max_retries,
            )
        except Exception as exc:
            raise StructuredLLMError(f"Structured extraction failed: {exc}") from exc
