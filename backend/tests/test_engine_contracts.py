"""Small engine contracts found by the 2026-11-20 audit (BE-20/21/22).

Each one is a value that reached the user or a provider in a different
shape than its own docstring promised.
"""

from __future__ import annotations

import os
import struct
import tempfile
import unittest
import wave
from unittest import mock

from backend.deepgram_language import resolve_live_language, rest_language_params


class LanguageSpellingTests(unittest.TestCase):
    def test_both_endpoints_receive_the_same_spelling(self):
        """BE-21: "RU" reached the live endpoint as "ru" and REST as "RU"."""
        self.assertEqual(resolve_live_language(" RU "), "ru")
        self.assertEqual(rest_language_params(" RU "), {"language": "ru"})
        self.assertEqual(rest_language_params("AUTO"), {"detect_language": "true"})


class _Response:
    status_code = 200

    def __init__(self, content):
        self._js = {"choices": [{"message": {"content": content}}]}
        self.text = str(self._js)

    def json(self):
        return self._js


class OpenRouterContentTests(unittest.TestCase):
    """BE-20: a multimodal ``content`` list was delivered as its Python repr."""

    def test_multimodal_content_is_read_as_its_text_parts(self):
        from backend.remote_openrouter import openrouter_transcribe, openrouter_upscale_text

        parts = [{"type": "text", "text": "Привет, "}, {"type": "text", "text": "мир"}]
        with mock.patch("backend.remote_openrouter.request_with_retry", return_value=_Response(parts)):
            out = openrouter_transcribe(
                api_key="sk-or-test", model="google/gemini-2.5-flash",
                audio_bytes=b"wav", filename="a.wav",
            )
            up = openrouter_upscale_text(
                api_key="sk-or-test", model="m", text="x", instruction="fix",
            )
        self.assertEqual(out["text"], "Привет, мир")
        self.assertEqual(up["text"], "Привет, мир")

    def test_content_of_an_unknown_shape_is_a_provider_error(self):
        from backend.remote_openrouter import OpenRouterError, openrouter_upscale_text

        with mock.patch("backend.remote_openrouter.request_with_retry", return_value=_Response({"odd": 1})):
            with self.assertRaises(OpenRouterError):
                openrouter_upscale_text(api_key="sk-or-test", model="m", text="x", instruction="fix")

    def test_both_calls_post_to_the_one_endpoint(self):
        import backend.remote_openrouter as ro

        with open(ro.__file__, encoding="utf-8") as fh:
            self.assertEqual(fh.read().count("https://openrouter.ai/api/v1/chat/completions"), 1)


class WhisperCpuThreadsTests(unittest.TestCase):
    def _threads(self, value):
        import backend.transcribe as t

        env = dict(os.environ)
        env.pop("TRANSCRIPTOR_WHISPER_CPU_THREADS", None)
        if value is not None:
            env["TRANSCRIPTOR_WHISPER_CPU_THREADS"] = value
        with mock.patch.dict(os.environ, env, clear=True):
            return t._cpu_threads()

    def test_an_explicit_low_thread_count_is_honoured(self):
        """BE-22: a user's ``=2`` was silently raised to 4."""
        self.assertEqual(self._threads("2"), 2)

    def test_the_default_stays_within_four_to_eight(self):
        self.assertTrue(4 <= self._threads(None) <= 8)


class EmptyRecognitionDurationTests(unittest.TestCase):
    def test_an_empty_recognition_of_a_file_reports_the_files_duration(self):
        """BE-22: ``transcribe_file``'s empty-sequence path said 0.0 s."""
        import backend.transcribe as t

        class _Model:
            def transcribe(self, *a, **kw):
                raise ValueError("max() iterable argument is empty")

        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "a.wav")
            with wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(16000)
                w.writeframes(struct.pack("<16000h", *([0] * 16000)))
            with mock.patch.object(t, "_model", return_value=_Model()):
                result = t.transcribe_file(path, "small")
        self.assertAlmostEqual(result["duration"], 1.0, places=3)
        self.assertEqual(result["segments"], [])


class RecoveryEvidenceDefaultsTests(unittest.TestCase):
    def test_a_configured_zero_is_read_as_zero(self):
        """BE-17: ``or 0.3`` turned a configured 0 ms endpointing into 300."""
        from backend.deepgram_recovery import evidence_from_session
        from backend.remote_deepgram_live import DeepgramLiveConfig, DeepgramLiveSession

        session = DeepgramLiveSession(
            api_key="k", config=DeepgramLiveConfig(endpointing_ms=0, utterance_end_ms=1000)
        )
        evidence = evidence_from_session(session)
        self.assertEqual(evidence.endpointing_sec, 0.0)
        self.assertEqual(evidence.utterance_end_sec, 1.0)

    def test_the_defaults_are_the_live_configs(self):
        from backend.deepgram_recovery import InterimEvidence
        from backend.remote_deepgram_live import DeepgramLiveConfig

        cfg = DeepgramLiveConfig()
        self.assertEqual(InterimEvidence().endpointing_sec, cfg.endpointing_ms / 1000.0)
        self.assertEqual(InterimEvidence().utterance_end_sec, cfg.utterance_end_ms / 1000.0)


class GigaamCacheLockTests(unittest.TestCase):
    def test_the_idle_sweep_never_holds_the_whisper_lock_while_asking_gigaam(self):
        """BE-24: ``release_idle_models`` read the GigaAM cache under
        ``_MODEL_LOCK``, right below a comment forbidding that nesting."""
        import backend.transcribe as t

        held: list[bool] = []

        class _Gigaam:
            def resident_gigaam_models(self):
                held.append(t._MODEL_LOCK.locked())
                return []

            def release_gigaam(self, name):
                return False

        with mock.patch.object(t, "_gigaam_module", return_value=_Gigaam()), \
                mock.patch.object(t, "_MODEL_IDLE_UNLOAD_SEC", 60.0):
            t.release_idle_models(now=0.0)
        self.assertEqual(held, [False])

    def test_cache_reads_and_writes_share_one_lock(self):
        import backend.transcribe_gigaam as g

        seen: list[bool] = []
        original = g._MODEL_CACHE

        class _Cache(type(original)):
            def __setitem__(self, key, value):
                seen.append(g._MODEL_LOCKS_GUARD.locked())
                super().__setitem__(key, value)

        fake_gigaam = mock.Mock()
        fake_gigaam.load_model.return_value = object()
        with mock.patch.object(g, "_MODEL_CACHE", _Cache()), \
                mock.patch.dict("sys.modules", {"gigaam": fake_gigaam}):
            g._load_model("gigaam-v3-rnnt")
        self.assertEqual(seen, [True])


if __name__ == "__main__":
    unittest.main()
