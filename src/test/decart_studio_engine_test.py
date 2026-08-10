"""
Unit tests for Decart Studio Engine (EliteSwap integration).

Covers all relevant edge cases including preview mode, non-preview modes,
retry logic, malformed responses, request ID extraction, and metadata fields.
"""

from __future__ import annotations

import logging
import unittest
from typing import Any, Dict, List, Optional, Union

# Import the module under test (adjust path if needed)
from decart_studio_engine import DecartStudioEngine, DecartStudioRequest, DecartStudioResponse


class DecartStudioEngineTests(unittest.TestCase):
    """Test suite for DecartStudioEngine."""

    def setUp(self) -> None:
        self.engine = DecartStudioEngine(api_key="test-key")

    def test_preview_mode_is_credit_safe_by_default(self) -> None:
        engine = DecartStudioEngine(api_key="test-key")
        request = DecartStudioRequest(prompt="A cinematic portrait", mode="preview")

        response = self.engine.submit(request)

        self.assertTrue(response.success)
        self.assertTrue(response.metadata.get("credit_safe"))
        self.assertEqual(response.data.get("mode"), "preview")

    def test_parse_response_handles_nested_and_missing_keys(self) -> None:
        engine = DecartStudioEngine(api_key="test-key")
        payload = {
            "result": {
                "output_url": "https://cdn.example.com/output.png",
                "request_id": "req-12345",
            }
        }

        response = self.engine.parse_response(payload)

        self.assertTrue(response.success)
        self.assertEqual(response.output_url, "https://cdn.example.com/output.png")
        self.assertEqual(response.request_id, "req-12345")

    def test_parse_response_handles_flat_payload(self) -> None:
        payload = {
            "output_url": "https://cdn.example.com/flat.png",
            "request_id": "req-flat",
            "mode": "preview",
        }

        response = self.engine.parse_response(payload)

        self.assertTrue(response.success)
        self.assertEqual(response.output_url, "https://cdn.example.com/flat.png")
        self.assertEqual(response.request_id, "req-flat")

    def test_parse_response_handles_missing_data_key(self) -> None:
        payload = {
            "value": {"output_url": "https://cdn.example.com/value.png"},
        }

        response = self.engine.parse_response(payload)

        self.assertTrue(response.success)
        self.assertEqual(response.output_url, "https://cdn.example.com/value.png")

    def test_parse_response_handles_empty_payload(self) -> None:
        payload = {}

        response = self.engine.parse_response(payload)

        self.assertFalse(response.success)
        self.assertIn("Invalid", response.error or "")

    def test_parse_response_handles_non_dict_payload(self) -> None:
        payload = "not a dict"

        response = self.engine.parse_response(payload)

        self.assertFalse(response.success)
        self.assertIn("Invalid", response.error or "")

    def test_extract_request_id_from_nested_result(self) -> None:
        payload = {
            "result": {
                "id": "nested-id-123",
            }
        }

        request_id = self.engine._extract_request_id(payload)

        self.assertEqual(request_id, "nested-id-123")

    def test_extract_request_id_from_top_level(self) -> None:
        payload = {
            "requestId": "top-level-id",
        }

        request_id = self.engine._extract_request_id(payload)

        self.assertEqual(request_id, "top-level-id")

    def test_build_payload_includes_extra_fields(self) -> None:
        request = DecartStudioRequest(
            prompt="Test prompt",
            mode="preview",
            image_url="https://example.com/image.png",
            width=512,
            height=512,
            extra={"seed": 42},
        )

        payload = self.engine._build_payload(request)

        self.assertEqual(payload["prompt"], "Test prompt")
        self.assertEqual(payload["mode"], "preview")
        self.assertEqual(payload["image_url"], "https://example.com/image.png")
        self.assertEqual(payload["width"], 512)
        self.assertEqual(payload["height"], 512)
        self.assertEqual(payload["extra"]["seed"], 42)

    def test_normalize_mode_lowercases_and_strips(self) -> None:
        self.assertEqual(self.engine._normalize_mode("PREVIEW"), "preview")
        self.assertEqual(self.engine._normalize_mode(" preview "), "preview")
        self.assertEqual(self.engine._normalize_mode(""), "preview")

    def test_non_preview_mode_logs_warning(self) -> None:
        with self.assertLogs(level=logging.WARNING) as cm:
            request = DecartStudioRequest(prompt="Test", mode="execute")
            self.engine.submit(request)

            self.assertIn("Non-preview mode requested", cm.output[0])

    def test_retry_on_network_error(self) -> None:
        # Mock requests.Session.post to raise a network error
        original_post = self.engine.session.post

        call_count = [0]

        def mock_post(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] < 3:
                raise requests.RequestException("Network error")
            return original_post(*args, **kwargs)

        self.engine.session.post = mock_post

        request = DecartStudioRequest(prompt="Retry test", mode="preview")
        response = self.engine.submit(request)

        self.assertTrue(response.success)
        self.assertEqual(call_count[0], 3)


if __name__ == "__main__":
    unittest.main()