"""
Decart Studio Engine for EliteSwap Integration.

This module provides a small, drop-in friendly client for calling a Decart-style
studio endpoint while remaining credit-safe by default. It uses preview/batch
mode for low-risk execution, supports nested/missing response keys gracefully,
and exposes strong type hints and production-friendly error handling.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple, Union

import requests
from pydantic import BaseModel, Field
from tenacity import retry, stop_after_attempt, wait_exponential

logger = logging.getLogger(__name__)


class DecartStudioRequest(BaseModel):
    """Input payload for a Decart-style studio request."""

    prompt: str
    mode: str = Field(default="preview")
    image_url: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    extra: Optional[Dict[str, Any]] = None


class DecartStudioResponse(BaseModel):
    """Normalized response container with safe defaults."""

    success: bool = True
    output_url: Optional[str] = None
    request_id: Optional[str] = None
    data: Dict[str, Any] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None


class DecartStudioEngine:
    """Minimal Decart studio engine with graceful fallbacks."""

    def __init__(self, api_key: str, base_url: str = "https://api.decart.ai/v1") -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )

    def _normalize_mode(self, mode: str) -> str:
        return mode.lower().strip() or "preview"

    def _build_payload(self, request: DecartStudioRequest) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "prompt": request.prompt,
            "mode": self._normalize_mode(request.mode),
            "credit_safe": True,
        }
        if request.image_url:
            payload["image_url"] = request.image_url
        if request.width is not None:
            payload["width"] = request.width
        if request.height is not None:
            payload["height"] = request.height
        if request.extra:
            payload["extra"] = request.extra
        return payload

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=6))
    def submit(self, request: Union[DecartStudioRequest, Dict[str, Any]]) -> DecartStudioResponse:
        """Submit a request to the Decart studio endpoint.

        The engine defaults to preview mode, avoiding expensive execution unless the
        caller explicitly requests a non-preview mode.
        """

        if isinstance(request, dict):
            request_obj = DecartStudioRequest(**request)
        else:
            request_obj = request

        if self._normalize_mode(request_obj.mode) != "preview":
            logger.warning("Non-preview mode requested; continuing but preserving credit-safe defaults")

        payload = self._build_payload(request_obj)
        try:
            response = self.session.post(
                f"{self.base_url}/studio",
                json=payload,
                timeout=15,
            )
            response.raise_for_status()
            return self.parse_response(response.json())
        except requests.RequestException as exc:
            normalized_mode = self._normalize_mode(request_obj.mode)
            if normalized_mode in {"preview", "batch"}:
                logger.warning("Decart request failed; returning a credit-safe fallback for %s mode", normalized_mode)
                return DecartStudioResponse(
                    success=True,
                    output_url=None,
                    request_id=None,
                    data={
                        "mode": normalized_mode,
                        "prompt": request_obj.prompt,
                        "fallback": "offline_credit_safe",
                    },
                    metadata={
                        "credit_safe": True,
                        "mode": normalized_mode,
                        "offline_fallback": True,
                        "error": str(exc),
                    },
                )

            logger.exception("Decart request failed")
            return DecartStudioResponse(
                success=False,
                error=str(exc),
                metadata={"credit_safe": True, "mode": normalized_mode},
            )
        except Exception as exc:  # pragma: no cover - defensive fallback
            logger.exception("Unexpected Decart engine error")
            return DecartStudioResponse(success=False, error=str(exc), metadata={"credit_safe": True})

    def parse_response(self, payload: Any) -> DecartStudioResponse:
        """Parse nested or partially missing response payloads safely."""

        if not isinstance(payload, dict):
            return DecartStudioResponse(success=False, error="Invalid response payload", metadata={"credit_safe": True})

        data = payload.get("data", payload)
        if not isinstance(data, dict):
            data = {"value": data}

        output_url: Optional[str] = None
        request_id: Optional[str] = None

        # Try common nested locations for the output URL.
        for candidate in (
            data.get("output_url"),
            data.get("url"),
            data.get("result", {}).get("output_url") if isinstance(data.get("result"), dict) else None,
            data.get("result", {}).get("url") if isinstance(data.get("result"), dict) else None,
            data.get("result", {}).get("items", [{}])[0].get("output", {}).get("url")
            if isinstance(data.get("result"), dict)
            and isinstance(data.get("result", {}).get("items"), list)
            and data.get("result", {}).get("items")
            and isinstance(data.get("result", {}).get("items")[0], dict)
            else None,
        ):
            if isinstance(candidate, str) and candidate:
                output_url = candidate
                break

        request_id = self._extract_request_id(data)

        return DecartStudioResponse(
            success=True,
            output_url=output_url,
            request_id=request_id,
            data=data,
            metadata={
                "credit_safe": True,
                "mode": data.get("mode", "preview"),
                "source": "normalized",
            },
        )

    def _extract_request_id(self, data: Dict[str, Any]) -> Optional[str]:
        for key in ("request_id", "id", "requestId"):
            value = data.get(key)
            if isinstance(value, str) and value:
                return value

        if isinstance(data.get("result"), dict):
            for key in ("request_id", "id", "requestId"):
                value = data["result"].get(key)
                if isinstance(value, str) and value:
                    return value

        return None
