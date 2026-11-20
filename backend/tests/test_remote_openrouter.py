import unittest
from unittest import mock

from backend.remote_openrouter import (
    OpenRouterError,
    _openrouter_audio_format,
    openrouter_transcribe,
    openrouter_upscale_text,
)


class OpenRouterJsonTests(unittest.TestCase):
    def test_transcribe_invalid_json_raises_provider_error(self):
        class FakeResponse:
            status_code = 200
            text = "<html>not json</html>"

            def json(self):
                raise ValueError("not json")

        with mock.patch("backend.remote_openrouter.request_with_retry", return_value=FakeResponse()):
            with self.assertRaises(OpenRouterError) as raised:
                openrouter_transcribe(
                    api_key="sk-or-test",
                    model="google/gemini-2.5-flash",
                    audio_bytes=b"wav",
                    filename="audio.wav",
                )

        self.assertIn("invalid JSON response", str(raised.exception))

    def test_transcribe_short_audio_uses_interactive_timeout_and_canonical_mime(self):
        class FakeResponse:
            status_code = 200
            text = '{"choices":[{"message":{"content":"hello"}}]}'

            def json(self):
                return {"choices": [{"message": {"content": "hello"}}]}

        with mock.patch("backend.remote_openrouter.request_with_retry", return_value=FakeResponse()) as req:
            out = openrouter_transcribe(
                api_key="sk-or-test",
                model="google/gemini-2.5-flash",
                audio_bytes=b"opus",
                filename="clip.opus",
            )

        self.assertEqual(out["text"], "hello")
        kwargs = req.call_args.kwargs
        self.assertEqual(kwargs["timeout"], (10, 45))
        self.assertEqual(kwargs["attempts"], 2)
        audio_part = kwargs["json"]["messages"][0]["content"][1]
        self.assertEqual(audio_part["input_audio"]["format"], "opus")

    def test_openrouter_audio_format_uses_provider_tokens_not_mime_subtypes(self):
        self.assertEqual(_openrouter_audio_format("clip.mp3"), "mp3")
        self.assertEqual(_openrouter_audio_format("clip.m4a"), "m4a")
        self.assertEqual(_openrouter_audio_format("clip.webm"), "webm")

    def test_upscale_invalid_json_raises_provider_error(self):
        class FakeResponse:
            status_code = 200
            text = "<html>not json</html>"

            def json(self):
                raise ValueError("not json")

        with mock.patch("backend.remote_openrouter.request_with_retry", return_value=FakeResponse()):
            with self.assertRaises(OpenRouterError) as raised:
                openrouter_upscale_text(
                    api_key="sk-or-test",
                    model="google/gemini-2.5-flash",
                    text="hello",
                    instruction="clean",
                )

        self.assertIn("invalid JSON response", str(raised.exception))


class AdapterDurationContractTests(unittest.TestCase):
    """``duration`` belongs to the adapter, not to the caller (B-084).

    ``main._remote_result_duration_sec`` dug into
    ``raw["metadata"]["duration"]`` — Deepgram's payload shape — and was
    applied to the OpenRouter result too, where no such key exists, so
    every OpenRouter transcription reported zero seconds of audio.
    """

    def test_openrouter_reports_a_duration_of_its_own(self):
        class FakeResponse:
            status_code = 200
            text = '{"choices":[{"message":{"content":"hello"}}]}'

            def json(self):
                return {"choices": [{"message": {"content": "hello"}}]}

        with mock.patch(
            "backend.remote_openrouter.request_with_retry",
            return_value=FakeResponse(),
        ):
            out = openrouter_transcribe(
                api_key="sk-or-test",
                model="google/gemini-2.5-flash",
                audio_bytes=b"opus",
                filename="clip.opus",
            )
        # A chat completion carries no audio duration; 0.0 because this
        # provider says so, not because the caller read the wrong shape.
        self.assertIn("duration", out)
        self.assertEqual(out["duration"], 0.0)

    def test_deepgram_reports_the_duration_from_its_own_metadata(self):
        from backend.remote_deepgram import deepgram_transcribe

        payload = {
            "metadata": {"duration": 12.5},
            "results": {
                "channels": [{"alternatives": [{"transcript": "привет"}]}]
            },
        }

        class FakeResponse:
            status_code = 200
            text = "{}"

            def json(self):
                return payload

        with mock.patch(
            "backend.remote_deepgram.request_with_retry", return_value=FakeResponse()
        ):
            out = deepgram_transcribe(
                api_key="dg", audio_bytes=b"wav", filename="a.wav"
            )
        self.assertEqual(out["duration"], 12.5)

    def test_a_malformed_duration_is_zero_rather_than_a_crash(self):
        from backend.remote_deepgram import deepgram_transcribe

        payload = {
            "metadata": {"duration": "twelve"},
            "results": {"channels": [{"alternatives": [{"transcript": "x"}]}]},
        }

        class FakeResponse:
            status_code = 200
            text = "{}"

            def json(self):
                return payload

        with mock.patch(
            "backend.remote_deepgram.request_with_retry", return_value=FakeResponse()
        ):
            out = deepgram_transcribe(
                api_key="dg", audio_bytes=b"wav", filename="a.wav"
            )
        self.assertEqual(out["duration"], 0.0)

if __name__ == "__main__":
    unittest.main()
