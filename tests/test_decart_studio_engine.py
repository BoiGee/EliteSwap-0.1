import unittest

from decart_studio_engine import DecartStudioEngine, DecartStudioRequest


class DecartStudioEngineTests(unittest.TestCase):
    def test_preview_mode_is_credit_safe_by_default(self) -> None:
        engine = DecartStudioEngine(api_key="test-key")
        request = DecartStudioRequest(prompt="A cinematic portrait", mode="preview")

        response = engine.submit(request)

        self.assertTrue(response.success)
        self.assertTrue(response.metadata.get("credit_safe"))
        self.assertEqual(response.data.get("mode"), "preview")

    def test_parse_response_handles_nested_and_missing_keys(self) -> None:
        engine = DecartStudioEngine(api_key="test-key")
        payload = {
            "result": {
                "items": [
                    {"output": {"url": "https://example.test/output.png"}}
                ]
            }
        }

        response = engine.parse_response(payload)

        self.assertEqual(response.output_url, "https://example.test/output.png")
        self.assertEqual(response.request_id, None)
        self.assertTrue(isinstance(response.metadata, dict))


if __name__ == "__main__":
    unittest.main()
