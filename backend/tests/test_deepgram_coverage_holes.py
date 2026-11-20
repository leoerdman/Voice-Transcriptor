"""Detect words Deepgram recognised but never committed to a final.

Observed in main.log, session ending 21:25:43 (520 s of dictation):

    is_final  start=452.76 end=455.78  textLen=50
    interim   start=452.76 end=457.56  textLen=75      <- heard more
    is_final  start=460.09 end=463.86  textLen=42      <- resumed past it

Nothing ever covered 455.78-457.56. Those words are gone from the
committed transcript, and the streaming fast path cannot recover them:
it delivers committed segments plus the *current* interim, so an interim
from the middle of a recording is overwritten by the next one long
before Stop.

``_uncovered_speech_sec`` measures exactly this — and only this. An
ordinary pause produces no interims carrying text, so it must never
register, or every recording with a breath in it would be flagged.
"""

from __future__ import annotations

import unittest

from backend.remote_deepgram_live import (
    COVERAGE_GAP_MIN_SEC,
    INTERIM_SPEECH_MIN_CHARS,
    DeepgramLiveSession,
)


def _interim(start: float, end: float, text: str, words: list[tuple[str, float, float]] | None = None) -> dict:
    alt: dict = {"transcript": text}
    if words is not None:
        alt["words"] = [{"word": w, "start": a, "end": b} for w, a, b in words]
    return {
        "type": "Results",
        "is_final": False,
        "speech_final": False,
        "start": start,
        "duration": end - start,
        "channel": {"alternatives": [alt]},
    }


def _final(start: float, end: float, text: str, words: list[tuple[str, float, float]]) -> dict:
    return {
        "type": "Results",
        "is_final": True,
        "speech_final": True,
        "start": start,
        "duration": end - start,
        "channel": {
            "alternatives": [
                {
                    "transcript": text,
                    "words": [{"word": w, "start": a, "end": b} for w, a, b in words],
                }
            ]
        },
    }


def _session(finals, speech_spans) -> DeepgramLiveSession:
    s = DeepgramLiveSession(api_key="k")
    s._finalized_segments = [{"start": a, "end": b} for a, b in finals]
    s._interim_speech_spans = list(speech_spans)
    return s


class UncoveredSpeechTests(unittest.TestCase):
    def test_reproduces_the_observed_hole(self):
        s = _session(
            [(449.44, 452.76), (452.76, 455.78), (460.09, 463.86)],
            [(449.44, 453.29), (452.76, 457.56), (460.09, 463.19)],
        )
        # 455.78 -> 457.56 is heard but never finalised.
        self.assertAlmostEqual(s._uncovered_speech_sec(), 1.78, places=2)

    def test_a_silent_pause_is_not_a_hole(self):
        """The 15 s gap here carries no speech — it is the user thinking."""
        s = _session([(0, 10), (25, 30)], [(0, 10), (25, 30)])
        self.assertEqual(s._uncovered_speech_sec(), 0.0)

    def test_overlapping_interims_are_not_counted_twice(self):
        s = _session([(0, 10), (20, 30)], [(10, 15), (11, 16), (12, 18)])
        self.assertAlmostEqual(s._uncovered_speech_sec(), 8.0, places=3)

    def test_segment_boundary_jitter_is_not_a_hole(self):
        """Sub-threshold slivers between adjacent finals are boundaries."""
        tiny = COVERAGE_GAP_MIN_SEC / 2
        s = _session([(0, 10), (10 + tiny, 20)], [(0, 20)])
        self.assertEqual(s._uncovered_speech_sec(), 0.0)

    def test_speech_after_the_last_final_counts(self):
        """Deepgram stopped finalising while its interims kept hearing."""
        s = _session([(0, 10)], [(0, 10), (10, 14)])
        self.assertAlmostEqual(s._uncovered_speech_sec(), 4.0, places=3)

    def test_noise_hypotheses_do_not_register_as_speech(self):
        """Deepgram emits 1-2 character interims during silence; those
        must not turn every pause into a reported hole."""
        s = DeepgramLiveSession(api_key="k")
        s._finalized_segments = [{"start": 0, "end": 10}, {"start": 25, "end": 30}]
        s._interim_speech_spans = []  # short interims were never recorded
        self.assertEqual(s._uncovered_speech_sec(), 0.0)
        self.assertGreater(INTERIM_SPEECH_MIN_CHARS, 2)

    def test_no_finals_or_no_speech_is_zero(self):
        self.assertEqual(_session([], [(0, 5)])._uncovered_speech_sec(), 0.0)
        self.assertEqual(_session([(0, 5)], [])._uncovered_speech_sec(), 0.0)

    def test_fully_covered_session_reports_nothing(self):
        s = _session([(0, 10), (10, 20)], [(0, 9), (10, 19)])
        self.assertEqual(s._uncovered_speech_sec(), 0.0)


class SpeechSpanSourceTests(unittest.TestCase):
    """What counts as "the service heard words here"."""

    def test_the_re_decode_window_is_not_charged_as_speech(self):
        # A rolling interim spans five seconds and carries two words at
        # its end. Charging the window made this message report ~4 s of
        # recognised speech that was never spoken — and every such
        # message inflated the hole warning shown to the user.
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(
            _interim(10.0, 15.0, "последнее слово", [("последнее", 14.2, 14.6), ("слово", 14.6, 15.0)])
        )
        self.assertEqual(s._interim_speech_spans, [(14.2, 15.0)])
        s._finalized_segments = [{"start": 0.0, "end": 10.0}]
        self.assertAlmostEqual(s._uncovered_speech_sec(), 0.8, places=6)

    def test_breath_between_words_is_not_a_hole(self):
        # Words closer together than the boundary threshold are one run
        # of speech; the silence between them is not measurable loss.
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(
            _interim(0.0, 3.0, "раз два три", [("раз", 0.0, 0.4), ("два", 0.6, 1.0), ("три", 1.1, 1.5)])
        )
        self.assertEqual(s._interim_speech_spans, [(0.0, 1.5)])

    def test_a_real_pause_inside_the_window_splits_the_span(self):
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(
            _interim(0.0, 9.0, "начало и конец", [("начало", 0.0, 0.5), ("и", 0.6, 0.8), ("конец", 8.0, 8.6)])
        )
        self.assertEqual(s._interim_speech_spans, [(0.0, 0.8), (8.0, 8.6)])

    def test_a_hypothesis_without_word_timings_still_reports_its_span(self):
        # Fallback: no word list means the message span is all we know,
        # and going blind would be worse than over-reporting.
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(_interim(4.0, 6.0, "без таймингов слов"))
        self.assertEqual(s._interim_speech_spans, [(4.0, 6.0)])

    def test_noise_hypotheses_are_still_excluded(self):
        s = DeepgramLiveSession(api_key="k")
        short = "ой"
        self.assertLess(len(short), INTERIM_SPEECH_MIN_CHARS)
        s._process_deepgram_message(_interim(1.0, 2.0, short, [("ой", 1.0, 1.2)]))
        self.assertEqual(s._interim_speech_spans, [])


def _session_with_the_measured_hole() -> DeepgramLiveSession:
    """The 12 s recording of audit §3.4: three contiguous finals, and
    one word ("субагента", 5.5-6.1 s) that the interim heard and no
    final ever carried."""
    s = DeepgramLiveSession(api_key="k")
    s._process_deepgram_message(
        _interim(
            4.90, 9.70, "три субагента на или если это",
            [
                ("три", 4.91, 5.30),
                ("субагента", 5.50, 6.10),
                ("на", 6.30, 6.55),
                ("или", 6.60, 6.90),
            ],
        )
    )
    s._process_deepgram_message(
        _final(0.0, 4.91, "можешь взять себе в одну два и",
               [("одну", 4.10, 4.50), ("два", 4.55, 4.91)])
    )
    s._process_deepgram_message(
        _final(4.91, 9.70, "три на или если это",
               [("три", 4.91, 5.30), ("на", 6.30, 6.55), ("или", 6.60, 6.90)])
    )
    s._process_deepgram_message(
        _final(9.70, 12.11, "будет нужно.", [("будет", 9.80, 10.2), ("нужно.", 10.2, 10.8)])
    )
    return s


class WordLevelHoleTests(unittest.TestCase):
    """§3.4: a lost WORD inside contiguous finals is a hole too.

    The time-difference measure cannot see it — the finals run
    0-4.91-9.70-12.11 with no gap at all — so the envelope reported
    ``uncoveredSpeechSec=0`` for a transcript that was provably missing
    a word, and every consumer downstream was told the reading was
    complete.
    """

    def test_a_single_missing_word_is_reported(self):
        s = _session_with_the_measured_hole()
        self.assertEqual([w["word"] for w in s._interim_words], ["субагента"])
        self.assertAlmostEqual(s._uncovered_speech_sec(), 0.6, places=3)

    def test_the_word_level_measure_has_no_quarter_second_floor(self):
        # One word is a few hundred milliseconds; the floor that keeps
        # segment-boundary jitter out of the SPAN measure would discard
        # every word-level hole there is.
        s = _session_with_the_measured_hole()
        self.assertLess(0.6, COVERAGE_GAP_MIN_SEC * 3)
        self.assertGreater(s._uncovered_speech_sec(), 0.0)

    def test_a_word_the_finals_do_carry_is_not_a_hole(self):
        s = _session_with_the_measured_hole()
        # Give the middle final the word it had omitted: nothing is
        # missing any more.
        s._process_deepgram_message(
            _final(4.91, 9.70, "три субагента на",
                   [("три", 4.91, 5.30), ("субагента", 5.50, 6.10)])
        )
        self.assertEqual(s._interim_words, [])
        self.assertEqual(s._uncovered_speech_sec(), 0.0)

    def test_the_splice_closes_the_measured_hole(self):
        s = _session_with_the_measured_hole()
        self.assertEqual(s._splice_uncovered_interim_words(), 1)
        self.assertEqual(s._uncovered_speech_sec(), 0.0)
        self.assertIn(
            "три субагента на или если это",
            " ".join(str(seg.get("text") or "") for seg in s._finalized_segments),
        )


class HoleReportTests(unittest.IsolatedAsyncioTestCase):
    """§3.9: when a hole is found, the log must say what was heard there."""

    async def test_finalize_logs_the_hole_spans_and_the_interim_texts(self):
        s = _session_with_the_measured_hole()
        s.stats.bytes_offered = int(12.11 * 2 * s._cfg.sample_rate)
        with self.assertLogs("backend.remote_deepgram_live", level="INFO") as logs:
            await s.drain_transcript()
        block = next(
            (m for m in logs.output if "coverage holes at finalize" in m), "",
        )
        self.assertTrue(block, f"no hole block logged; got {logs.output}")
        self.assertIn("hole 5.50-6.10s", block)
        # What Deepgram heard there is described by size, never by the
        # dictated words: main.log is the file users attach for support
        # (BL-02).
        self.assertNotIn("субагента", block)
        self.assertRegex(block, r"interim \[[0-9.]+-[0-9.]+\] words=\d+ chars=\d+")
        self.assertIn("spliced_words=1", block)

    async def test_a_clean_session_logs_no_hole_block(self):
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(
            _final(0.0, 2.0, "всё на месте", [("всё", 0.1, 0.5), ("на", 0.5, 0.7)])
        )
        s.stats.bytes_offered = int(2.0 * 2 * s._cfg.sample_rate)
        with self.assertLogs("backend.remote_deepgram_live", level="INFO") as logs:
            await s.drain_transcript()
        self.assertFalse([m for m in logs.output if "coverage holes at finalize" in m])


def _session_with_the_overruled_word() -> DeepgramLiveSession:
    """The "трёх" shape of 2026-09-03, session a9fd3fd9.

    The interim heard "…в трёх…"; the final that followed carried "в"
    (the same word, re-timed) and "одном", and "одном" overlaps the
    ground "трёх" was spoken on by more than
    ``SPLICE_COVERAGE_OVERLAP_FRACTION`` of it. The coverage rule
    therefore treats "трёх" as a disagreement the final wins, evicts it,
    and the word reaches neither the splice nor the user — leaving no
    hole to measure, because the finals are contiguous and carry words
    over the whole span.
    """
    s = DeepgramLiveSession(api_key="k")
    s._process_deepgram_message(
        _interim(
            4.07, 6.10, "в одном из трёх последних сообщений",
            [("в", 5.20, 5.40), ("трёх", 5.55, 5.85)],
        )
    )
    s._process_deepgram_message(
        _final(
            4.07, 7.66, "в одном из",
            [("в", 5.22, 5.42), ("одном", 5.60, 6.00), ("из", 6.10, 6.30)],
        )
    )
    return s


class ForwardedSegmentShapeTests(unittest.TestCase):
    """A forwarded final segment carries its word list.

    The renderer merges two readings of the same recording by word time
    (``frontend/src/transcript-merge.ts``). Stripping the words out of
    the live ``segments`` frame left it merging on segment spans alone,
    which is the wrong resolution for the seam it is trying to repair —
    and the words were already in hand: the same list the final envelope
    carries, and the same one coverage is computed from.
    """

    def test_a_final_segment_frame_carries_word_times(self):
        s = DeepgramLiveSession(api_key="k")
        event = s._process_deepgram_message(
            _final(0.0, 2.0, "можешь взять",
                   [("можешь", 0.10, 0.55), ("взять", 0.60, 1.10)])
        )
        self.assertEqual(event["type"], "segments")
        self.assertTrue(event["is_final"])
        self.assertEqual(
            event["segments"][0]["words"],
            [
                {"word": "можешь", "start": 0.1, "end": 0.55},
                {"word": "взять", "start": 0.6, "end": 1.1},
            ],
        )

    def test_the_forwarded_words_are_the_envelope_words(self):
        # One shape, not two: whatever the renderer merges on must be
        # the list the backend itself reasons about.
        s = DeepgramLiveSession(api_key="k")
        event = s._process_deepgram_message(
            _final(0.0, 2.0, "можешь взять", [("можешь", 0.10, 0.55)])
        )
        self.assertEqual(
            event["segments"][0]["words"],
            s._finalized_segments[0]["words"],
        )

    def test_a_provider_response_without_words_omits_the_key(self):
        # An empty list would read as "no words were spoken here"; the
        # honest statement is that the provider did not say.
        s = DeepgramLiveSession(api_key="k")
        event = s._process_deepgram_message(
            {
                "type": "Results",
                "is_final": True,
                "speech_final": True,
                "start": 0.0,
                "duration": 1.0,
                "channel": {"alternatives": [{"transcript": "без слов"}]},
            }
        )
        self.assertNotIn("words", event["segments"][0])

    def test_an_interim_frame_is_unchanged(self):
        s = DeepgramLiveSession(api_key="k")
        event = s._process_deepgram_message(
            _interim(0.0, 2.0, "ещё не финал", [("ещё", 0.10, 0.40)])
        )
        self.assertFalse(event.get("is_final"))
        self.assertNotIn("segments", event)


class OverruledWordReportTests(unittest.IsolatedAsyncioTestCase):
    """§A1.4: a word dropped for being "covered" by a DIFFERENT word.

    This loss shape leaves no hole and no splice, so every existing
    measurement reads zero and the log said nothing at all. The rule
    itself is unchanged here — only the evidence needed to judge it.
    """

    def test_the_eviction_records_both_words(self):
        s = _session_with_the_overruled_word()
        self.assertEqual(s._overruled_total, 1)
        word, owner = list(s._overruled_words)[0]
        self.assertEqual(word["word"], "трёх")
        self.assertEqual(owner["word"], "одном")
        self.assertAlmostEqual(word["start"], 5.55, places=2)
        self.assertAlmostEqual(owner["end"], 6.00, places=2)

    def test_the_word_really_is_gone_from_the_transcript(self):
        # Without this the diagnostic would be describing a word the
        # user did receive.
        s = _session_with_the_overruled_word()
        self.assertEqual(s._interim_words, [])
        self.assertNotIn("трёх", s.final_text())

    def test_a_re_timed_same_word_is_not_overruled(self):
        # "в" at 5.20-5.40 became "в" at 5.22-5.42 in the final. Same
        # spoken word, nothing lost, nothing to report — otherwise the
        # report would be noise on every session.
        s = _session_with_the_overruled_word()
        self.assertNotIn(
            "в", [w["word"] for w, _owner in s._overruled_words],
        )

    async def test_finalize_logs_the_pair_with_both_times(self):
        s = _session_with_the_overruled_word()
        s.stats.bytes_offered = int(7.66 * 2 * s._cfg.sample_rate)
        with self.assertLogs("backend.remote_deepgram_live", level="INFO") as logs:
            await s.drain_transcript()
        block = next(
            (m for m in logs.output if "coverage holes at finalize" in m), "",
        )
        self.assertTrue(block, f"no block logged; got {logs.output}")
        self.assertIn("overruled=1", block)
        self.assertNotIn("трёх", block)
        self.assertNotIn("одном", block)
        self.assertIn("[5.55-5.85] chars=4", block)
        self.assertIn("[5.60-6.00] chars=5", block)

    async def test_the_block_is_printed_even_with_no_hole_and_no_splice(self):
        # The gate used to be "spliced or uncovered seconds", both of
        # which are zero here — exactly the defect this exists to make
        # visible.
        s = _session_with_the_overruled_word()
        s.stats.bytes_offered = int(7.66 * 2 * s._cfg.sample_rate)
        with self.assertLogs("backend.remote_deepgram_live", level="INFO") as logs:
            result = await s.drain_transcript()
        self.assertEqual(result["uncoveredSpeechSec"], 0.0)
        self.assertTrue(
            [m for m in logs.output if "coverage holes at finalize" in m]
        )

    async def test_the_splice_path_records_overruled_words_too(self):
        # Second drop site: a hypothesis that survives every eviction
        # can still be discarded at splice time by the same rule, and it
        # must leave the same trace. Here the covering final arrives
        # only AFTER the interim has been parked in the orphan pool by a
        # newer hypothesis, so no eviction ever saw the pair.
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(
            _interim(4.00, 6.00, "в трёх последних сообщениях",
                     [("трёх", 5.55, 5.85)])
        )
        s._process_deepgram_message(
            _interim(4.00, 6.00, "в одном последних сообщениях",
                     [("одном", 5.62, 5.98)])
        )
        self.assertEqual([w["word"] for w in s._orphan_interim_words], ["трёх"])
        # A final with no word list evicts nothing word-wise; the words
        # are attached afterwards, so the splice is the first thing to
        # apply word coverage to the orphan.
        s._finalized_segments.append(
            {
                "start": 4.00,
                "end": 6.10,
                "text": "в одном",
                "words": [{"word": "одном", "start": 5.60, "end": 6.00}],
            }
        )
        self.assertEqual(s._splice_uncovered_interim_words(), 0)
        self.assertEqual(s._overruled_total, 1)
        word, owner = list(s._overruled_words)[0]
        self.assertEqual((word["word"], owner["word"]), ("трёх", "одном"))


if __name__ == "__main__":
    unittest.main()
