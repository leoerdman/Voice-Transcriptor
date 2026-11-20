"""The ``final`` envelope has ONE shape, and both sides prove it (B-038).

This suite owns the BACKEND half of the contract. Its centrepiece is
``contracts/live-final-envelope.json``: a fixture PRODUCED here, by the
one envelope constructor, and CONSUMED by
``frontend/tests/live-envelope.test.ts``. Neither side writes the
example by hand, so a field renamed, dropped or re-nested on either side
turns the other side's suite red instead of turning a stop into a
silently emptier transcript.

Regenerate after an intentional shape change:

    UPDATE_CONTRACT_FIXTURES=1 python -m unittest \
        backend.tests.test_live_envelope

and run the frontend suite, which is what will tell you the renderer has
not been taught the new shape yet.
"""

from __future__ import annotations

import ast
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.live_envelope import (  # noqa: E402
    COVERAGE_KEYS,
    DEEPGRAM_LIVE_SOURCE,
    FINAL_ENVELOPE_KEYS,
    FINAL_MESSAGE_TYPE,
    LOCAL_ASSIST_SOURCE,
    envelope_from_result,
    live_coverage,
    live_final_envelope,
    live_final_stats,
)

from backend.deepgram_dual import DUAL_STATS_KEYS, MergedReading, dual_stats  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = REPO_ROOT / "contracts" / "live-final-envelope.json"


def _deepgram_stream_envelope() -> dict:
    """A dual-stream stop that needed a recovery pass — the full shape.

    Built the way ``backend.main`` builds it: from the dict
    ``DeepgramLiveSession.drain_transcript`` returns, through
    ``envelope_from_result``. Every optional fact is present here on
    purpose, so the renderer's parser is exercised against a payload
    that carries all of them at once.
    """
    drained = {
        "text": "Привет everybody. Это тест.",
        "segments": [
            {
                "start": 0.08,
                "end": 1.44,
                "text": "Привет everybody.",
                "speaker": 0,
                "source": "deepgram",
                "words": [
                    {"word": "Привет", "start": 0.08, "end": 0.62, "source": "deepgram"},
                    {"word": "everybody", "start": 0.7, "end": 1.44, "source": "deepgram"},
                ],
            },
            {
                "start": 2.1,
                "end": 3.02,
                "text": "Это тест.",
                "source": "recovery",
                "words": [
                    {"word": "Это", "start": 2.1, "end": 2.4, "source": "recovery"},
                    {"word": "тест", "start": 2.45, "end": 3.02, "source": "recovery"},
                ],
            },
        ],
        "durationSec": 3.02,
        "coveredEndSec": 3.02,
        "streamedSec": 3.5,
        "uncoveredSpeechSec": 0.0,
        "stats": live_final_stats(
            {
                "bytes_sent": 112000,
                "bytes_offered": 112000,
                "chunks_sent": 42,
                "segments_final": 2,
                "empty_finals": 1,
                "segments_interim": 17,
                "keepalives_sent": 0,
                "connect_ms": 318.4,
                "finalize_ms": 214.7,
                # Through the producer the session uses, so the contract
                # lists every dual key it actually sends (BE-13).
                **dual_stats(
                    MergedReading(
                        secondary_word_count=5,
                        filled_from_secondary=3,
                        filled_from_primary=1,
                        duplicates_removed=1,
                        contested_to_secondary=1,
                        contested_to_primary=0,
                    ),
                    secondary_language="ru",
                    secondary_failed=False,
                ),
            },
            recovery={
                "spans": [[2.0, 3.1]],
                "spans_sec": 1.1,
                "ms": 412.5,
                "words": 2,
            },
        ),
    }
    return envelope_from_result(drained, source=DEEPGRAM_LIVE_SOURCE)


def _local_assist_envelope() -> dict:
    """The local live assist — the only transport with a coverage report."""
    return live_final_envelope(
        source=LOCAL_ASSIST_SOURCE,
        text="Hello from the local assist.",
        segments=[
            {"start": 0.0, "end": 1.9, "text": "Hello from the local assist."},
        ],
        duration_sec=1.9,
        covered_end_sec=1.9,
        streamed_sec=2.0,
        coverage=live_coverage(
            complete=True,
            covered_sec=2.0,
            total_sec=2.0,
            dropped_sec=0.0,
            uncovered_tail_sec=0.0,
        ),
    )


def _connect_failure_envelope() -> dict:
    """The upstream never opened: an error and nothing else."""
    return live_final_envelope(
        source=DEEPGRAM_LIVE_SOURCE,
        error="Deepgram API key is not configured",
    )


def build_fixture() -> dict:
    return {
        "deepgramStream": _deepgram_stream_envelope(),
        "localAssist": _local_assist_envelope(),
        "connectFailure": _connect_failure_envelope(),
    }


class LiveFinalEnvelopeShapeTests(unittest.TestCase):
    def test_every_envelope_carries_every_key(self):
        """Absence is a value, never a missing key.

        A missing key cannot be told apart from a version mismatch, and
        a version mismatch read as a fact is how "complete coverage"
        gets believed for a session that never reported it.
        """
        for name, envelope in build_fixture().items():
            with self.subTest(envelope=name):
                self.assertEqual(
                    tuple(envelope.keys()),
                    FINAL_ENVELOPE_KEYS,
                    "the wire shape must be identical, in order, on every path",
                )
                self.assertEqual(envelope["type"], FINAL_MESSAGE_TYPE)
                self.assertIsInstance(envelope["stats"], dict)

    def test_coverage_is_null_rather_than_absent(self):
        stream = _deepgram_stream_envelope()
        self.assertIsNone(stream["coverage"])
        local = _local_assist_envelope()
        self.assertEqual(tuple(local["coverage"].keys()), COVERAGE_KEYS)

    def test_numbers_are_coerced_and_never_negative(self):
        env = live_final_envelope(
            source=DEEPGRAM_LIVE_SOURCE,
            duration_sec="1.23456",
            covered_end_sec=-4.0,
            streamed_sec=float("nan"),
            uncovered_speech_sec=None,
        )
        self.assertEqual(env["durationSec"], 1.235)
        self.assertEqual(env["coveredEndSec"], 0.0)
        self.assertEqual(env["streamedSec"], 0.0)
        self.assertEqual(env["uncoveredSpeechSec"], 0.0)

    def test_segments_are_copied_with_their_words_and_source(self):
        seg = {"start": 0.0, "end": 1.0, "text": "hi", "source": "recovery", "words": [{"word": "hi"}]}
        env = live_final_envelope(source=DEEPGRAM_LIVE_SOURCE, segments=[seg])
        self.assertEqual(env["segments"][0]["source"], "recovery")
        self.assertEqual(env["segments"][0]["words"], [{"word": "hi"}])
        seg["text"] = "mutated"
        self.assertEqual(env["segments"][0]["text"], "hi", "the envelope owns its own copy")

    def test_error_defaults_to_empty_string(self):
        self.assertEqual(_local_assist_envelope()["error"], "")
        self.assertTrue(_connect_failure_envelope()["error"])

    def test_envelope_from_result_reads_an_error_out_of_the_result(self):
        env = envelope_from_result({"error": "boom"}, source=DEEPGRAM_LIVE_SOURCE)
        self.assertEqual(env["error"], "boom")

    def test_the_fixture_carries_every_dual_key_the_session_sends(self):
        stats = _deepgram_stream_envelope()["stats"]
        self.assertEqual([k for k in stats if k.startswith("dual_")], list(DUAL_STATS_KEYS))

    def test_stats_is_an_object_even_when_the_session_reported_none(self):
        self.assertEqual(_connect_failure_envelope()["stats"], {})


class LiveFinalEnvelopeFixtureTests(unittest.TestCase):
    """The fixture the frontend suite reads is produced by the builder."""

    def test_fixture_matches_the_builder_output(self):
        expected = build_fixture()
        if os.environ.get("UPDATE_CONTRACT_FIXTURES") == "1":
            FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
            FIXTURE_PATH.write_text(
                json.dumps(expected, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        self.assertTrue(
            FIXTURE_PATH.exists(),
            f"{FIXTURE_PATH} is missing — regenerate with UPDATE_CONTRACT_FIXTURES=1",
        )
        actual = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            actual,
            expected,
            "contracts/live-final-envelope.json is stale. The renderer parses "
            "this file in frontend/tests/live-envelope.test.ts, so regenerate "
            "it (UPDATE_CONTRACT_FIXTURES=1) and teach the renderer the new "
            "shape in the SAME commit.",
        )


class LiveFinalEnvelopeSoleConstructorTests(unittest.TestCase):
    """No second shape may be written by hand anywhere in the backend."""

    def test_no_module_writes_a_final_message_literally(self):
        """A dict literal ``{"type": "final", ...}`` outside the builder.

        Parsed rather than grepped: the protocol is DOCUMENTED in several
        module docstrings and comments, and a scanner that cannot tell a
        sentence about the wire from the wire would either miss the real
        thing or forbid explaining it.
        """
        offenders = []
        for path in sorted((REPO_ROOT / "backend").rglob("*.py")):
            if path.name == "live_envelope.py" or "tests" in path.parts:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Dict):
                    continue
                for key, value in zip(node.keys, node.values):
                    if (
                        isinstance(key, ast.Constant)
                        and key.value == "type"
                        and isinstance(value, ast.Constant)
                        and value.value == FINAL_MESSAGE_TYPE
                    ):
                        offenders.append(
                            f"{path.relative_to(REPO_ROOT)}:{node.lineno}"
                        )
        self.assertEqual(
            offenders,
            [],
            "every ``final`` message must come from backend.live_envelope — "
            "a hand-written one is how this wire type came to have three shapes",
        )


if __name__ == "__main__":
    unittest.main()
