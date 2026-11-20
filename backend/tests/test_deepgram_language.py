"""What "auto" means, and to which endpoint (B-039).

"auto" is a word from this app's UI, not from Deepgram, and the two
endpoints answer it differently — which is a fact about Deepgram, not a
choice: the live endpoint has no ``detect_language`` and offers
``language=multi``; the prerecorded one has ``detect_language``, and on
the 2026-09-03 trilingual evidence recording ``multi`` was measured to
drop Russian clauses, so it is the better reading there.

The defect was not that they differ. It was that they differed with
nothing connecting them — one file said ``detect_language=true``, the
other said ``multi``, and neither mentioned the other — so a change to
either would have silently made the recovery of a hole read in a
different language than the transcript around it.
"""

from __future__ import annotations

import unittest
from unittest import mock

from backend.deepgram_language import rest_language_params, resolve_live_language


class LiveLanguageTests(unittest.TestCase):
    def test_auto_and_blank_become_multi(self):
        for value in ("auto", "AUTO", "", "   ", None):
            with self.subTest(value=value):
                self.assertEqual(resolve_live_language(value), "multi")

    def test_an_explicit_language_passes_through_lowercased(self):
        self.assertEqual(resolve_live_language("RU"), "ru")
        self.assertEqual(resolve_live_language(" en "), "en")

    def test_multi_is_already_the_answer(self):
        self.assertEqual(resolve_live_language("multi"), "multi")


class RestLanguageTests(unittest.TestCase):
    def test_auto_and_blank_ask_the_endpoint_to_detect(self):
        for value in ("auto", "AUTO", "", "  ", None):
            with self.subTest(value=value):
                self.assertEqual(
                    rest_language_params(value), {"detect_language": "true"}
                )

    def test_an_explicit_language_is_sent_as_itself(self):
        self.assertEqual(rest_language_params("ru"), {"language": "ru"})
        self.assertEqual(rest_language_params(" en "), {"language": "en"})

    def test_an_explicit_language_reaches_both_endpoints_the_same(self):
        # Only the auto case may differ between the two.
        for lang in ("ru", "en", "de"):
            with self.subTest(lang=lang):
                self.assertEqual(
                    rest_language_params(lang)["language"],
                    resolve_live_language(lang),
                )


class RestRequestTests(unittest.TestCase):
    """The prerecorded adapter asks the shared module, not itself."""

    def _params_for(self, language: str) -> dict:
        from backend.remote_deepgram import deepgram_transcribe

        payload = {
            "metadata": {"duration": 1.0},
            "results": {"channels": [{"alternatives": [{"transcript": "x"}]}]},
        }

        class FakeResponse:
            status_code = 200
            text = "{}"

            def json(self):
                return payload

        with mock.patch(
            "backend.remote_deepgram.request_with_retry", return_value=FakeResponse()
        ) as req:
            deepgram_transcribe(
                api_key="dg",
                audio_bytes=b"wav",
                filename="a.wav",
                language=language,
            )
        return req.call_args.kwargs["params"]

    def test_auto_sends_detect_language(self):
        params = self._params_for("auto")
        self.assertEqual(params.get("detect_language"), "true")
        self.assertNotIn("language", params)

    def test_an_explicit_language_is_sent_and_detection_is_not(self):
        params = self._params_for("ru")
        self.assertEqual(params.get("language"), "ru")
        self.assertNotIn("detect_language", params)


class LiveConfigBuilderTests(unittest.TestCase):
    """One builder for the live config (B-041).

    The warm pool keys its socket on ``to_query_string()``, so a second
    construction site that forgets a field hands a recording a socket
    opened with different parameters. ``tools/deepgram_live_ab.py``,
    whose whole job is to measure what the app does, built its own.
    """

    def test_the_tool_and_the_handler_produce_the_same_query_string(self):
        import backend.tools.deepgram_live_ab as ab
        from backend.remote_deepgram_live import live_config

        self.assertIs(ab.live_config, live_config)
        self.assertFalse(
            hasattr(ab, "DeepgramLiveConfig"),
            "the tool can still build a config of its own",
        )

    def test_the_builder_fills_the_fields_the_pool_keys_on(self):
        from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
        from backend.model_catalog import DEFAULT_DEEPGRAM_AUDIO_MODEL
        from backend.remote_deepgram_live import live_config

        cfg = live_config()
        self.assertEqual(cfg.model, DEFAULT_DEEPGRAM_AUDIO_MODEL)
        self.assertEqual(cfg.language, "auto")
        self.assertEqual(cfg.sample_rate, LIVE_SAMPLE_RATE_HZ)
        self.assertTrue(cfg.interim_results)
        self.assertFalse(cfg.diarize)
        self.assertEqual(cfg.keyterms, ())

    def test_backend_main_uses_that_same_builder(self):
        import importlib
        import os
        import sys
        import tempfile

        from backend.remote_deepgram_live import live_config

        with tempfile.TemporaryDirectory() as td:
            old = os.environ.get("TRANSCRIPTOR_DATA_DIR")
            os.environ["TRANSCRIPTOR_DATA_DIR"] = td
            os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
            for name in ("backend.main", "backend.config"):
                sys.modules.pop(name, None)
            try:
                main = importlib.import_module("backend.main")
                self.assertIs(main.live_config, live_config)
            finally:
                try:
                    main.jobs.shutdown(timeout=0.1)
                except Exception:
                    pass
                for name in ("backend.main", "backend.config"):
                    sys.modules.pop(name, None)
                os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
                if old is None:
                    os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
                else:
                    os.environ["TRANSCRIPTOR_DATA_DIR"] = old


class SharedWordApiTests(unittest.TestCase):
    """The word predicates two other modules use are PUBLIC (B-033).

    ``deepgram_dual`` imported five names through their leading
    underscore. The underscore declares them private, which means a
    refactor of ``remote_deepgram_live`` is entitled to change them —
    and would silently break the merge of two readings.
    """

    def test_they_are_exported(self):
        import backend.remote_deepgram_live as live

        for name in (
            "as_float",
            "segment_words",
            "time_overlap",
            "token_stem",
            "word_core",
            "word_duration",
        ):
            with self.subTest(name=name):
                self.assertIn(name, live.__all__)
                self.assertTrue(hasattr(live, name))

    def test_no_module_imports_a_private_name_from_it(self):
        import re
        from pathlib import Path

        backend_dir = Path(__file__).resolve().parents[1]
        offenders = []
        for path in backend_dir.glob("*.py"):
            if path.name == "remote_deepgram_live.py":
                continue
            text = path.read_text(encoding="utf-8")
            for block in re.findall(
                r"from backend\.remote_deepgram_live import \(([^)]*)\)", text
            ) + re.findall(
                r"from backend\.remote_deepgram_live import ([^(\n]+)", text
            ):
                for name in block.replace("\n", " ").split(","):
                    name = name.strip().split("#")[0].strip()
                    if name.startswith("_"):
                        offenders.append(f"{path.name}: {name}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
