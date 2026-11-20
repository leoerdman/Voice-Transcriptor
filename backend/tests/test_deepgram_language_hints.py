"""Nova-3 multilingual language hints (Deepgram 2026-10-23).

Since 2026-10-23 ``language=multi`` is a 55-language model and it labels
this user's Russian as Persian, French, Lithuanian... ``language_hint``
biases it toward the languages actually spoken. These tests pin where the
hints go (only ``language=multi``, live and prerecorded), what an absent
or broken preference means, and that an unsupported code — a Deepgram 400
that would kill the stream — is never sent.
"""

from __future__ import annotations

import unittest
from unittest import mock
from urllib.parse import parse_qsl

from backend.config import DEFAULT_CONFIG, _validate_config_shape
from backend.deepgram_dual import secondary_config
from backend.deepgram_language import (
    DEFAULT_LANGUAGE_HINTS,
    LANGUAGE_HINT_OPTIONS,
    configured_language_hints,
    language_hint_pairs,
    normalize_language_hints,
)
from backend.remote_deepgram_live import live_config


def _pairs(cfg) -> list[tuple[str, str]]:
    return parse_qsl(cfg.to_query_string())


class HintRuleTests(unittest.TestCase):
    def test_default_is_russian_and_english(self):
        self.assertEqual(DEFAULT_LANGUAGE_HINTS, ("ru", "en"))
        self.assertTrue(set(DEFAULT_LANGUAGE_HINTS) <= set(LANGUAGE_HINT_OPTIONS))

    def test_hints_only_for_multi(self):
        self.assertEqual(
            language_hint_pairs("multi", ("ru", "en")),
            [("language_hint", "ru"), ("language_hint", "en")],
        )
        self.assertEqual(language_hint_pairs("ru", ("ru", "en")), [])
        self.assertEqual(language_hint_pairs("", ("ru", "en")), [])

    def test_unknown_codes_are_dropped_not_sent(self):
        self.assertEqual(normalize_language_hints(["RU", "fa", "en", "ru", 7]), ("ru", "en"))
        self.assertEqual(normalize_language_hints("ru,en"), ())

    def test_absent_preference_is_the_default_and_empty_means_none(self):
        self.assertEqual(configured_language_hints({}), DEFAULT_LANGUAGE_HINTS)
        self.assertEqual(
            configured_language_hints({"preferences": {"deepgram": {"keyterms": ""}}}),
            DEFAULT_LANGUAGE_HINTS,
        )
        self.assertEqual(
            configured_language_hints({"preferences": {"deepgram": {"language_hints": []}}}),
            (),
        )
        self.assertEqual(
            configured_language_hints({"preferences": {"deepgram": {"language_hints": ["en", "de"]}}}),
            ("en", "de"),
        )


class LiveQueryTests(unittest.TestCase):
    def test_auto_stream_carries_repeated_hints_after_language(self):
        pairs = _pairs(live_config(language="auto", language_hints=("ru", "en")))
        self.assertIn(("language", "multi"), pairs)
        self.assertEqual([v for k, v in pairs if k == "language_hint"], ["ru", "en"])
        lang_at = pairs.index(("language", "multi"))
        self.assertEqual(pairs[lang_at + 1], ("language_hint", "ru"))

    def test_the_monolingual_second_reading_carries_none(self):
        primary = live_config(language="auto", language_hints=("ru", "en"))
        pairs = _pairs(secondary_config(primary, "ru"))
        self.assertIn(("language", "ru"), pairs)
        self.assertFalse([p for p in pairs if p[0] == "language_hint"])

    def test_hints_change_the_warm_pool_key(self):
        # The pool keys sockets on the query string: a socket opened
        # without hints must never be adopted by a session that wants them.
        self.assertNotEqual(
            live_config(language_hints=("ru", "en")).to_query_string(),
            live_config().to_query_string(),
        )


class RestQueryTests(unittest.TestCase):
    def _params(self, language: str, hints) -> dict:
        from backend.remote_deepgram import deepgram_transcribe

        payload = {"metadata": {"duration": 1.0}, "results": {"channels": [{"alternatives": [{"transcript": "x"}]}]}}

        class FakeResponse:
            status_code = 200
            text = "{}"

            def json(self):
                return payload

        with mock.patch("backend.remote_deepgram.request_with_retry", return_value=FakeResponse()) as req:
            deepgram_transcribe(api_key="dg", audio_bytes=b"wav", filename="a.wav", language=language, language_hints=hints)
        return req.call_args.kwargs["params"]

    def test_recovery_reading_in_multi_sends_hints(self):
        self.assertEqual(self._params("multi", ("ru", "en")).get("language_hint"), ["ru", "en"])

    def test_detect_language_and_explicit_language_send_none(self):
        self.assertNotIn("language_hint", self._params("auto", ("ru", "en")))
        self.assertNotIn("language_hint", self._params("ru", ("ru", "en")))


class ConfigTests(unittest.TestCase):
    def test_default_config_holds_the_default(self):
        self.assertEqual(DEFAULT_CONFIG["preferences"]["deepgram"]["language_hints"], ["ru", "en"])

    def test_broken_stored_value_keeps_only_valid_codes(self):
        cfg = {"preferences": {"deepgram": {"language_hints": ["ru", "xx", "EN"]}}}
        repaired = _validate_config_shape(cfg)
        self.assertEqual(repaired["preferences"]["deepgram"]["language_hints"], ["ru", "en"])
        cfg = {"preferences": {"deepgram": {"language_hints": "ru"}}}
        self.assertEqual(_validate_config_shape(cfg)["preferences"]["deepgram"]["language_hints"], [])


if __name__ == "__main__":
    unittest.main()


class DeclaredLanguageMergeTests(unittest.TestCase):
    """The dual merge reads the declared languages as evidence.

    Shapes from the 2026-11-20 measurement: ``multi`` heard "Так, так,
    так" as Latvian with HIGHER confidence than ``ru``'s correct reading,
    so the confidence rule alone kept the Latvian."""

    @staticmethod
    def _seg(words):
        return [{"start": words[0]["start"], "end": words[-1]["end"],
                 "text": " ".join(w["word"] for w in words), "words": words}]

    def _readings(self, tag="lv"):
        primary = [
            {"word": "tak,", "start": 1.0, "end": 1.4, "confidence": 0.99, "language": tag},
            {"word": "tak.", "start": 1.4, "end": 1.8, "confidence": 0.95, "language": tag},
            {"word": "Еще", "start": 2.0, "end": 2.3, "confidence": 1.0, "language": "ru"},
        ]
        secondary = [
            {"word": "Так,", "start": 1.0, "end": 1.4, "confidence": 0.80},
            {"word": "так.", "start": 1.4, "end": 1.8, "confidence": 0.80},
            {"word": "Еще", "start": 2.0, "end": 2.3, "confidence": 0.99},
        ]
        return self._seg(primary), self._seg(secondary)

    def _text(self, expected, tag="lv"):
        from backend.deepgram_dual import merge_readings

        p, s = self._readings(tag)
        return merge_readings(p, s, expected_languages=expected).text

    def test_undeclared_language_goes_to_the_monolingual_reading(self):
        self.assertEqual(self._text(("ru", "en")), "Так, так. Еще")

    def test_without_declared_languages_confidence_still_decides(self):
        self.assertEqual(self._text(()), "tak, tak. Еще")

    def test_a_declared_language_keeps_the_confidence_rule(self):
        # Real English stays with ``multi`` when it is the more confident.
        self.assertEqual(self._text(("ru", "en"), tag="en"), "tak, tak. Еще")

    def test_regional_tags_compare_by_base_language(self):
        self.assertEqual(self._text(("ru", "en"), tag="en-US"), "tak, tak. Еще")


class SplicedWordEvidenceTests(unittest.TestCase):
    def test_a_word_spliced_into_a_final_keeps_language_and_confidence(self):
        from backend.remote_deepgram_live import splice_words_into_segments

        segment = {"start": 0.0, "end": 3.0, "text": "Так нас",
                   "words": [{"word": "Так", "start": 0.0, "end": 0.4},
                             {"word": "нас", "start": 2.0, "end": 2.4}]}
        word = {"word": "ось", "start": 1.0, "end": 1.3, "confidence": 0.6, "language": "uk"}
        out = splice_words_into_segments([segment], [word], source="interim")
        placed = [w for w in out.segments[0]["words"] if w["word"] == "ось"][0]
        self.assertEqual(placed.get("language"), "uk")
        self.assertEqual(placed.get("confidence"), 0.6)
