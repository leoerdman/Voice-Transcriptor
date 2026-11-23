"""The backend owns recovery: the envelope is complete before it is sent.

Covers ``backend.deepgram_recovery`` — which spans a live reading still
fails to cover, how they are re-decoded from the session's own audio
spool, and how the words land in the envelope — plus the two places
``backend.main`` wires it in (the normal stop and the connect failure
that used to ship an empty envelope and leave the recording to the
renderer).
"""

from __future__ import annotations

import asyncio
import importlib
import io
import json
import os
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.deepgram_recovery import (
    LIVE_EMPTY_RESULT_MIN_SEC,
    RECOVERY_BUDGET_BASE_SEC,
    RECOVERY_BUDGET_MAX_SEC,
    RECOVERY_BUDGET_PER_SPAN_SEC,
    RECOVERY_SOURCE,
    RECOVERY_SPAN_PAD_SEC,
    InterimEvidence,
    RecoveryReport,
    covered_spans,
    pcm_span_wav,
    recover_spans,
    recovery_budget_sec,
    run_recovery,
    splice_recovered_words,
    uncovered_spans,
)
from backend.remote_deepgram_live import DeepgramLiveConfig, join_segment_texts


def _pcm(seconds: float, value: int = 1000) -> bytes:
    """``seconds`` of a constant-valued 16 kHz mono PCM16 buffer."""
    frames = int(seconds * LIVE_SAMPLE_RATE_HZ)
    return struct.pack(f"<{frames}h", *([value] * frames))


def _ramp_pcm(frames: int) -> bytes:
    """PCM whose every sample is distinguishable, for slicing assertions."""
    return struct.pack(f"<{frames}h", *[(i % 3000) - 1500 for i in range(frames)])


def _segment(start: float, end: float, words: list[tuple[str, float, float]]) -> dict:
    return {
        "start": start,
        "end": end,
        "text": " ".join(w for w, _s, _e in words),
        "is_final": True,
        "speech_final": True,
        "words": [
            {"word": w, "start": s, "end": e} for w, s, e in words
        ],
    }


def _rest_result(words: list[tuple[str, float, float]]) -> dict:
    """A Deepgram pre-recorded response carrying exactly these words.

    Shaped like what ``backend.remote_deepgram.deepgram_transcribe``
    RETURNS — text, duration, words and the raw payload — rather than
    like the raw payload alone. Placing the recovered words is this
    module's job; knowing where Deepgram puts them in its JSON is the
    adapter's, and it used to be spelled out on both sides.
    """
    return {
        "text": " ".join(w for w, _s, _e in words),
        "duration": max((e for _w, _s, e in words), default=0.0),
        "words": [
            {"word": w, "start": s, "end": e} for w, s, e in words
        ],
        "raw": {
            "results": {
                "channels": [
                    {
                        "alternatives": [
                            {
                                "transcript": " ".join(w for w, _s, _e in words),
                                "words": [
                                    {"word": w, "start": s, "end": e}
                                    for w, s, e in words
                                ],
                            }
                        ]
                    }
                ]
            }
        },
    }


class UncoveredSpanTests(unittest.TestCase):
    """R1 (a)-(d): what counts as a span that still needs re-decoding."""

    def test_a_word_level_hole_inside_a_covered_final_becomes_a_span(self):
        # Audit §3.4: contiguous finals leave no gap to measure, so a
        # word the final simply failed to transcribe disappears without
        # trace unless coverage is measured word by word.
        segments = [
            _segment(0.0, 10.0, [("начало", 0.0, 5.0), ("конец", 5.6, 10.0)]),
        ]
        spans = uncovered_spans(
            10.0,
            segments,
            InterimEvidence(hole_spans=((5.0, 5.6),)),
            None,
        )
        self.assertEqual(spans, [(4.7, 5.9)])

    def test_b_voiced_tail_past_the_last_final_becomes_a_span(self):
        segments = [_segment(0.0, 8.0, [("слово", 0.0, 8.0)])]
        spans = uncovered_spans(
            10.0,
            segments,
            InterimEvidence(speech_spans=((8.2, 9.0),)),
            None,
        )
        self.assertEqual(spans, [(7.7, 10.0)])

    def test_b_tail_whose_decoder_still_reaches_past_the_final_becomes_a_span(self):
        # The second kind of evidence in ``tail_needs_flush``: no
        # recognised words yet, but Deepgram's own decode window is
        # still working audio past the last final.
        segments = [_segment(0.0, 8.0, [("слово", 0.0, 8.0)])]
        spans = uncovered_spans(
            10.0,
            segments,
            InterimEvidence(interim_window_end=8.9, endpointing_sec=0.3),
            None,
        )
        self.assertEqual(spans, [(7.7, 10.0)])

    def test_b_silent_tail_is_not_a_span(self):
        # Audit §5: 83 of 84 uncovered-but-unvoiced tails produced
        # nothing when waited for. Re-decoding them would be the same
        # mistake with a REST bill attached.
        segments = [_segment(0.0, 8.0, [("слово", 0.0, 8.0)])]
        spans = uncovered_spans(
            10.0,
            segments,
            InterimEvidence(interim_window_end=7.5, endpointing_sec=0.3),
            None,
        )
        self.assertEqual(spans, [])

    def test_c_everything_after_the_socket_died_is_a_span(self):
        segments = [_segment(0.0, 6.0, [("слово", 0.0, 6.0)])]
        spans = uncovered_spans(
            6.0,
            segments,
            InterimEvidence(),
            6.0,
            audio_sec=12.0,
        )
        self.assertEqual(spans, [(5.7, 12.0)])

    def test_c_death_span_shrinks_to_nothing_once_recovery_has_covered_it(self):
        # Idempotence: re-asking after the repair must not re-decode the
        # ground the repair just filled, or the envelope's own
        # ``uncoveredSpeechSec`` would never fall to zero.
        segments = [_segment(0.0, 12.0, [("всё", 0.0, 12.0)])]
        spans = uncovered_spans(
            6.0, segments, InterimEvidence(), 6.0, audio_sec=12.0
        )
        self.assertEqual(spans, [])

    def test_d_no_finals_at_all_recovers_the_whole_recording(self):
        spans = uncovered_spans(0.0, [], InterimEvidence(), None, audio_sec=5.0)
        self.assertEqual(spans, [(0.0, 5.0)])

    def test_d_too_short_to_be_a_failure_is_left_alone(self):
        spans = uncovered_spans(
            0.0, [], InterimEvidence(), None,
            audio_sec=LIVE_EMPTY_RESULT_MIN_SEC - 0.5,
        )
        self.assertEqual(spans, [])

    def test_adjacent_spans_merge_after_padding(self):
        segments = [_segment(0.0, 10.0, [("a", 0.0, 3.0), ("b", 4.2, 10.0)])]
        spans = uncovered_spans(
            10.0,
            segments,
            InterimEvidence(hole_spans=((3.0, 3.4), (3.8, 4.2))),
            None,
        )
        self.assertEqual(spans, [(2.7, 4.5)])

    def test_padding_is_clamped_to_the_audio_at_both_ends(self):
        segments = [_segment(0.0, 4.0, [("a", 0.0, 0.05), ("b", 0.4, 4.0)])]
        spans = uncovered_spans(
            4.0,
            segments,
            InterimEvidence(hole_spans=((0.05, 0.4),)),
            None,
            audio_sec=4.0,
        )
        self.assertEqual(spans, [(0.0, 0.7)])
        self.assertGreaterEqual(spans[0][0], 0.0)

    def test_a_sliver_shorter_than_a_word_is_not_worth_a_round_trip(self):
        segments = [_segment(0.0, 10.0, [("a", 0.0, 5.0), ("b", 5.05, 10.0)])]
        spans = uncovered_spans(
            10.0,
            segments,
            InterimEvidence(hole_spans=((5.0, 5.05),)),
            None,
        )
        self.assertEqual(spans, [])

    def test_padding_constant_is_the_one_applied(self):
        segments = [_segment(0.0, 10.0, [("a", 0.0, 4.0), ("b", 5.0, 10.0)])]
        spans = uncovered_spans(
            10.0, segments, InterimEvidence(hole_spans=((4.0, 5.0),)), None
        )
        self.assertEqual(
            spans, [(round(4.0 - RECOVERY_SPAN_PAD_SEC, 3),
                     round(5.0 + RECOVERY_SPAN_PAD_SEC, 3))]
        )

    def test_a_segment_without_words_still_covers_its_own_span(self):
        # For such a segment its span is the only thing knowable about
        # what it contains, so it must not read as uncovered ground.
        segments = [{"start": 0.0, "end": 9.0, "text": "нет слов", "is_final": True}]
        self.assertEqual(covered_spans(segments), [(0.0, 9.0)])
        self.assertEqual(
            uncovered_spans(9.0, segments, InterimEvidence(), None), []
        )


class RecoveryBudgetTests(unittest.TestCase):
    def test_no_spans_costs_the_stop_nothing(self):
        self.assertEqual(recovery_budget_sec([]), 0.0)

    def test_budget_grows_with_the_audio_being_decoded(self):
        self.assertAlmostEqual(
            recovery_budget_sec([(0.0, 2.0)]),
            RECOVERY_BUDGET_BASE_SEC + 2.0 * RECOVERY_BUDGET_PER_SPAN_SEC,
        )
        self.assertAlmostEqual(
            recovery_budget_sec([(0.0, 2.0), (5.0, 7.0)]),
            RECOVERY_BUDGET_BASE_SEC + 4.0 * RECOVERY_BUDGET_PER_SPAN_SEC,
        )

    def test_budget_is_hard_capped(self):
        self.assertEqual(
            recovery_budget_sec([(0.0, 600.0)]), RECOVERY_BUDGET_MAX_SEC
        )


class PcmSliceTests(unittest.TestCase):
    def test_span_wav_carries_exactly_the_requested_samples(self):
        pcm = _ramp_pcm(LIVE_SAMPLE_RATE_HZ * 2)
        wav_bytes = pcm_span_wav(pcm, 0.5, 1.0)
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertEqual(wav.getframerate(), LIVE_SAMPLE_RATE_HZ)
            frames = wav.readframes(wav.getnframes())
        expected = pcm[
            int(0.5 * LIVE_SAMPLE_RATE_HZ) * 2: int(1.0 * LIVE_SAMPLE_RATE_HZ) * 2
        ]
        self.assertEqual(frames, expected)

    def test_span_wav_clamps_to_the_buffer(self):
        pcm = _ramp_pcm(1000)
        wav_bytes = pcm_span_wav(pcm, -5.0, 99.0)
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
            frames = wav.readframes(wav.getnframes())
        self.assertEqual(frames, pcm)

    def test_span_wav_never_produces_an_odd_data_length(self):
        # A WAV whose data length is odd shifts every sample after it by
        # one byte, which is white noise rather than audio.
        pcm = _ramp_pcm(777)
        for start, end in ((0.0, 0.0123), (0.011, 0.033), (0.0, 1.0)):
            with self.subTest(span=(start, end)):
                wav_bytes = pcm_span_wav(pcm, start, end)
                with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
                    self.assertEqual(len(wav.readframes(wav.getnframes())) % 2, 0)


class DualRecoveryTests(unittest.IsolatedAsyncioTestCase):
    """BE-11 / BL-10: a ``multi`` re-decode of a Russian speaker's hole
    returned Devanagari, Telugu and Hebrew words, with no evidence on
    them and no partner to compare against."""

    @staticmethod
    def _rest(words):
        return {"words": [
            {"word": w, "punctuated_word": w, "start": a, "end": b, "confidence": c,
             **({"language": lang} if lang else {})}
            for w, a, b, c, lang in words
        ]}

    async def test_recovered_words_keep_their_evidence(self):
        words = await recover_spans(
            _pcm(12.0), [(5.0, 6.0)], DeepgramLiveConfig(language="auto"), api_key="dg",
            transcribe=lambda **kw: self._rest([("мама", 0.1, 0.5, 0.91, "ru")]),
        )
        self.assertEqual(words[0]["confidence"], 0.91)
        self.assertEqual(words[0]["language"], "ru")

    async def test_a_dual_recording_re_decodes_in_both_languages_and_merges(self):
        calls: list[str] = []

        def fake_rest(**kwargs):
            calls.append(kwargs["language"])
            if kwargs["language"] == "multi":
                # Measured shape: ``multi`` hearing Russian as Telugu.
                return self._rest([("మా", 0.10, 0.40, 0.55, "te"), ("చివత్లో", 0.40, 0.90, 0.50, "te")])
            return self._rest([("мама", 0.10, 0.40, 0.95, None), ("читает", 0.40, 0.90, 0.93, None)])

        words = await recover_spans(
            _pcm(12.0), [(5.0, 6.0)], DeepgramLiveConfig(language="auto"), api_key="dg",
            transcribe=fake_rest, secondary_language="ru",
        )
        self.assertEqual(sorted(calls), ["multi", "ru"])
        self.assertEqual([w["word"] for w in words], ["мама", "читает"])
        self.assertTrue(all(w["source"] == RECOVERY_SOURCE for w in words))

    async def test_run_recovery_reads_the_partner_from_the_envelope(self):
        calls: list[str] = []

        def fake_rest(**kwargs):
            calls.append(kwargs["language"])
            return self._rest([("слово", 0.1, 0.5, 0.9, "ru")])

        payload = {
            "type": "final", "source": "deepgram-live", "text": "", "segments": [],
            "streamedSec": 4.0, "stats": {"dual_stream": True, "dual_secondary_language": "ru"},
        }
        await run_recovery(
            payload=payload, evidence=InterimEvidence(), stream_death_sec=0.0,
            pcm=_pcm(4.0), cfg=DeepgramLiveConfig(language="auto"), api_key="dg",
            transcribe=fake_rest,
        )
        self.assertEqual(sorted(set(calls)), ["multi", "ru"])

    async def test_the_spool_is_read_off_the_event_loop(self):
        import threading

        readers: list[str] = []

        def spool() -> bytes:
            readers.append(threading.current_thread().name)
            return _pcm(4.0)

        payload = {
            "type": "final", "source": "deepgram-live", "text": "", "segments": [],
            "streamedSec": 4.0, "stats": {},
        }
        await run_recovery(
            payload=payload, evidence=InterimEvidence(), stream_death_sec=0.0,
            pcm=spool, audio_sec=4.0, cfg=DeepgramLiveConfig(language="auto"), api_key="dg",
            transcribe=lambda **kw: _rest_result([("x", 0.1, 0.4)]),
        )
        self.assertEqual(len(readers), 1)
        self.assertNotEqual(readers[0], threading.main_thread().name, "BW-13")


class RecoverSpansTests(unittest.IsolatedAsyncioTestCase):
    async def test_words_come_back_offset_onto_the_recordings_timeline(self):
        calls: list[dict] = []

        def fake_rest(**kwargs):
            calls.append(kwargs)
            return _rest_result([("субагента", 0.2, 0.8)])

        words = await recover_spans(
            _pcm(12.0),
            [(5.0, 6.0)],
            DeepgramLiveConfig(language="auto"),
            api_key="dg",
            transcribe=fake_rest,
        )
        self.assertEqual(len(words), 1)
        self.assertEqual(words[0]["word"], "субагента")
        self.assertAlmostEqual(words[0]["start"], 5.2)
        self.assertAlmostEqual(words[0]["end"], 5.8)
        self.assertEqual(words[0]["source"], RECOVERY_SOURCE)
        self.assertEqual(len(calls), 1)

    async def test_the_live_language_decision_is_reused_verbatim(self):
        # "auto" is a UI word. The live stream sends ``language=multi``;
        # a REST re-decode that fell back to ``detect_language`` would
        # read the hole in a different language than the reading it is
        # repairing.
        seen: list[str] = []

        def fake_rest(**kwargs):
            seen.append(kwargs["language"])
            return _rest_result([])

        for configured, expected in (("auto", "multi"), ("", "multi"), ("ru", "ru")):
            with self.subTest(language=configured):
                seen.clear()
                await recover_spans(
                    _pcm(4.0),
                    [(0.0, 1.0)],
                    DeepgramLiveConfig(language=configured),
                    api_key="dg",
                    transcribe=fake_rest,
                )
                self.assertEqual(seen, [expected])

    async def test_keyterms_and_model_travel_with_the_call(self):
        seen: list[dict] = []

        def fake_rest(**kwargs):
            seen.append(kwargs)
            return _rest_result([])

        await recover_spans(
            _pcm(4.0),
            [(0.0, 1.0)],
            DeepgramLiveConfig(model="nova-3", keyterms=("Sonnet", "субагент")),
            api_key="dg",
            transcribe=fake_rest,
        )
        self.assertEqual(seen[0]["model"], "nova-3")
        self.assertEqual(seen[0]["keyterms"], ("Sonnet", "субагент"))
        self.assertFalse(seen[0]["diarize"])

    async def test_a_failing_span_costs_only_itself(self):
        def fake_rest(**kwargs):
            if kwargs["filename"].endswith("-0.wav"):
                raise RuntimeError("Deepgram API error (HTTP 503)")
            return _rest_result([("второй", 0.1, 0.4)])

        words = await recover_spans(
            _pcm(12.0),
            [(1.0, 2.0), (6.0, 7.0)],
            DeepgramLiveConfig(),
            api_key="dg",
            transcribe=fake_rest,
        )
        self.assertEqual([w["word"] for w in words], ["второй"])

    async def test_the_budget_is_a_deadline_not_a_suggestion(self):
        def slow_rest(**kwargs):
            import time as _time

            _time.sleep(1.0)
            return _rest_result([("поздно", 0.1, 0.4)])

        words = await recover_spans(
            _pcm(12.0),
            [(1.0, 2.0)],
            DeepgramLiveConfig(),
            api_key="dg",
            budget_sec=0.15,
            transcribe=slow_rest,
        )
        self.assertEqual(words, [])

    async def test_no_key_means_no_call(self):
        def fake_rest(**kwargs):  # pragma: no cover - must never run
            raise AssertionError("REST must not be called without a key")

        self.assertEqual(
            await recover_spans(
                _pcm(4.0), [(0.0, 1.0)], DeepgramLiveConfig(),
                api_key="", transcribe=fake_rest,
            ),
            [],
        )


class SpliceRecoveredWordsTests(unittest.TestCase):
    def test_a_dropped_owned_word_is_logged_by_its_span_not_its_text(self):
        # main.log never carries what the user dictated (BL-02).
        segments = [_segment(0.0, 3.0, [("секретное", 0.0, 3.0)])]
        with self.assertLogs("backend.deepgram_recovery", level="INFO") as logs:
            splice_recovered_words(
                segments,
                [{"word": "секретное", "start": 0.5, "end": 2.5, "source": RECOVERY_SOURCE}],
                [(0.2, 2.8)],
            )
        line = next(m for m in logs.output if "already owned" in m)
        self.assertNotIn("секретное", line)
        self.assertIn("0.50-2.50", line)

    def test_a_word_inside_a_final_is_put_back_at_its_time_position(self):
        segments = [
            _segment(4.91, 9.70, [("три", 4.91, 5.3), ("на", 6.4, 6.8)]),
        ]
        out, spliced = splice_recovered_words(
            segments,
            [{"word": "субагента", "start": 5.5, "end": 6.1, "source": RECOVERY_SOURCE}],
            [(5.2, 6.5)],
        )
        self.assertEqual(spliced, 1)
        self.assertEqual(out[0]["text"], "три субагента на")
        placed = [w for w in out[0]["words"] if w["word"] == "субагента"][0]
        self.assertEqual(placed["source"], RECOVERY_SOURCE)

    def test_a_word_outside_every_final_becomes_its_own_segment(self):
        segments = [_segment(0.0, 3.0, [("начало", 0.0, 3.0)])]
        out, spliced = splice_recovered_words(
            segments,
            [{"word": "хвост", "start": 6.0, "end": 6.6, "source": RECOVERY_SOURCE}],
            [(5.7, 6.9)],
        )
        self.assertEqual(spliced, 1)
        self.assertEqual(out[-1]["source"], RECOVERY_SOURCE)
        self.assertEqual(out[-1]["text"], "хвост")

    def test_a_word_the_transcript_already_owns_is_dropped(self):
        # Spans are decoded with padding, so the re-decode always
        # returns words the transcript already has. Shipping them reads
        # as a stutter.
        segments = [_segment(0.0, 3.0, [("привет", 1.0, 1.6)])]
        out, spliced = splice_recovered_words(
            segments,
            [{"word": "Привет,", "start": 1.02, "end": 1.58, "source": RECOVERY_SOURCE}],
            [(0.7, 1.9)],
        )
        self.assertEqual(spliced, 0)
        self.assertEqual(out[0]["text"], "привет")


class SpliceRecoveredWordsAlignmentTests(unittest.TestCase):
    """Which recovered words are new is decided by ORDER, not time alone.

    Real timings from take ``20261123-173222`` (2026-11-23): the
    assembled transcript around the hole, the span the recovery decoded
    (7.93-8.86) and the two words the REST re-decode returned for it.
    """

    @staticmethod
    def _transcript() -> list[dict]:
        return [_segment(5.6, 10.23, [
            ("и", 7.12, 7.2), ("он", 7.2, 7.36), ("слово", 7.36, 7.68),
            ("деплой", 7.68, 8.08), ("Посмотри,", 8.56, 9.04), ("по", 9.03, 9.19),
            ("логам", 9.19, 9.51),
        ])]

    @staticmethod
    def _rec(word: str, start: float, end: float) -> dict:
        return {"word": word, "start": start, "end": end, "source": RECOVERY_SOURCE}

    def test_a_missing_word_is_placed_between_its_neighbours(self):
        # "Потерял," came back stretched to the clip start (7.93-8.65) and
        # overlapped 37 % of "деплой", so the time-only coverage rule
        # judged it owned and dropped it. In order it sits between
        # "деплой" and "посмотрю"(="Посмотри,"), where the transcript has
        # nothing: it is the missing word, timed into that gap.
        out, spliced = splice_recovered_words(
            self._transcript(),
            [self._rec("Потерял,", 7.93, 8.65), self._rec("посмотрю.", 8.65, 9.13)],
            [(7.93, 8.86)],
        )
        self.assertEqual(spliced, 1)
        # "Потерял," opened its clip: its capital was positional, and
        # mid-sentence it is lowered (``backend.word_case``). The comma
        # stays — in the clip it stood before "посмотрю", the
        # transcript's "Посмотри,", so it describes a real boundary.
        # "Посмотри," is capitalised mid-segment in the transcript, which
        # is evidence about the word, so it keeps its capital here.
        self.assertEqual(
            out[0]["text"], "и он слово деплой потерял, Посмотри, по логам"
        )
        placed = [w for w in out[0]["words"] if w["word"] == "потерял,"][0]
        self.assertEqual((placed["start"], placed["end"]), (8.08, 8.56))
        self.assertEqual(placed["source"], RECOVERY_SOURCE)

    def test_a_word_after_an_inserted_one_takes_the_case_of_its_new_place(self):
        # As the transcript reached recovery in the single-stream shape:
        # "Посмотри," opened a final of its own, so its capital was
        # positional. With "потерял," now in front of it, it is
        # mid-sentence.
        transcript = [
            _segment(5.6, 8.08, [("и", 7.12, 7.2), ("он", 7.2, 7.36),
                                 ("слово", 7.36, 7.68), ("деплой", 7.68, 8.08)]),
            # A final starts where the previous one ended, before its
            # first word.
            _segment(8.08, 9.51, [("Посмотри,", 8.56, 9.04), ("по", 9.03, 9.19),
                                  ("логам", 9.19, 9.51)]),
        ]
        out, spliced = splice_recovered_words(
            transcript,
            [self._rec("Потерял,", 7.93, 8.65), self._rec("посмотрю.", 8.65, 9.13)],
            [(7.93, 8.86)],
        )
        self.assertEqual(spliced, 1)
        self.assertEqual(
            join_segment_texts(out), "и он слово деплой потерял, посмотри, по логам"
        )

    def test_the_mark_where_the_clip_was_cut_is_not_carried_in(self):
        # The fresh word is the clip's last: its "." closes the clip,
        # not the speaker's sentence, and the transcript goes on after
        # it. The mark is dropped; the capital the clip gave its first
        # word is lowered.
        transcript = [_segment(5.6, 7.2, [("сделай", 5.6, 6.0), ("на", 6.6, 6.8),
                                          ("сервер", 6.8, 7.2)])]
        out, spliced = splice_recovered_words(
            transcript,
            [self._rec("Сделай", 5.55, 6.0), self._rec("деплой.", 6.0, 6.58)],
            [(5.55, 6.58)],
        )
        self.assertEqual(spliced, 1)
        self.assertEqual(out[0]["text"], "сделай деплой на сервер")

    def test_a_capital_the_clip_gave_mid_sentence_is_kept(self):
        # Negative control: "Deepgram" did not open the clip; its capital
        # is the word's own.
        transcript = [_segment(1.0, 2.5, [("через", 1.0, 1.3), ("работает", 2.0, 2.5)])]
        out, spliced = splice_recovered_words(
            transcript,
            [self._rec("Через", 0.95, 1.3), self._rec("Deepgram", 1.4, 1.9),
             self._rec("работает.", 2.0, 2.5)],
            [(0.95, 2.5)],
        )
        self.assertEqual(spliced, 1)
        self.assertEqual(out[0]["text"], "через Deepgram работает")

    def test_a_word_inserted_after_a_sentence_end_is_capitalised(self):
        transcript = [_segment(1.0, 3.0, [("сервер.", 1.0, 1.5), ("на", 2.4, 2.6),
                                          ("сервер", 2.6, 3.0)])]
        out, spliced = splice_recovered_words(
            transcript,
            [self._rec("сервер.", 1.0, 1.5), self._rec("сделай", 1.6, 2.0),
             self._rec("деплой", 2.0, 2.35), self._rec("на", 2.4, 2.6)],
            [(0.9, 2.7)],
        )
        self.assertEqual(spliced, 2)
        self.assertEqual(out[0]["text"], "сервер. Сделай деплой на сервер")

    def test_the_same_place_spelled_differently_is_not_added(self):
        # Negative control: the re-decode spells the transcript's own
        # "деплой" differently ("деплоя") at the same place. The
        # transcript has its word there, so nothing is added.
        out, spliced = splice_recovered_words(
            self._transcript(),
            [self._rec("слово", 7.36, 7.70), self._rec("деплоя", 7.70, 8.10),
             self._rec("посмотри", 8.56, 9.04)],
            [(7.30, 9.10)],
        )
        self.assertEqual(spliced, 0)
        self.assertEqual(out[0]["text"], "и он слово деплой Посмотри, по логам")

    def test_a_different_word_over_a_transcript_word_is_not_added(self):
        # Negative control: the re-decode heard "деплоить" where the
        # transcript has "деплой" (different stem), between the same two
        # agreed neighbours. The transcript's reading stands.
        out, spliced = splice_recovered_words(
            self._transcript(),
            [self._rec("слово", 7.36, 7.68), self._rec("задеплоить", 7.68, 8.10),
             self._rec("посмотри", 8.56, 9.04)],
            [(7.30, 9.10)],
        )
        self.assertEqual(spliced, 0)
        self.assertEqual(out[0]["text"], "и он слово деплой Посмотри, по логам")

    def test_a_fragment_of_the_word_the_clip_starts_inside_is_not_added(self):
        # The clip starts inside "деплой" (padding); the decoder writes
        # its tail as "лой". Mostly on "деплой"'s own time — not a missing
        # word, even though nothing of the transcript is between it and
        # the next agreed word.
        out, spliced = splice_recovered_words(
            self._transcript(),
            [self._rec("лой", 7.93, 8.10), self._rec("посмотрю.", 8.56, 9.04)],
            [(7.93, 8.86)],
        )
        self.assertEqual(spliced, 0)
        self.assertEqual(out[0]["text"], "и он слово деплой Посмотри, по логам")


class RunRecoveryEnvelopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_nothing_to_do_leaves_the_envelope_untouched(self):
        payload = {
            "type": "final",
            "text": "всё на месте",
            "segments": [_segment(0.0, 4.0, [("всё", 0.0, 1.0), ("на", 1.0, 2.0),
                                             ("месте", 2.0, 4.0)])],
            "streamedSec": 4.0,
            "stats": {"bytes_sent": 1},
        }

        def fake_rest(**kwargs):  # pragma: no cover - must never run
            raise AssertionError("no recovery was needed")

        out = await run_recovery(
            payload=payload,
            evidence=InterimEvidence(),
            stream_death_sec=None,
            pcm=_pcm(4.0),
            cfg=DeepgramLiveConfig(),
            api_key="dg",
            transcribe=fake_rest,
        )
        self.assertIs(out, payload)
        self.assertNotIn("recovery", out.get("stats", {}))

    async def test_a_hole_is_re_decoded_and_reported_in_stats(self):
        payload = {
            "type": "final",
            "text": "три на",
            "segments": [_segment(4.91, 9.70, [("три", 4.91, 5.3), ("на", 6.4, 6.8)])],
            "streamedSec": 9.7,
            "stats": {"bytes_sent": 10},
        }
        announced: list[float] = []

        def fake_rest(**kwargs):
            # Placed to cover the hole exactly, so nothing is left over.
            return _rest_result([("субагента", 0.3, 0.9)])

        out = await run_recovery(
            payload=payload,
            evidence=InterimEvidence(hole_spans=((5.5, 6.1),)),
            stream_death_sec=None,
            pcm=_pcm(10.0),
            cfg=DeepgramLiveConfig(),
            api_key="dg",
            announce=announced.append,
            transcribe=fake_rest,
        )
        self.assertIn("субагента", out["text"])
        self.assertEqual(out["text"], "три субагента на")
        report = out["stats"]["recovery"]
        self.assertEqual(report["words"], 1)
        self.assertEqual(report["spans"], [[5.2, 6.4]])
        # The renderer reads spans_sec and ms, and nothing else here.
        self.assertAlmostEqual(report["spans_sec"], 1.2, places=3)
        self.assertGreaterEqual(report["ms"], 0.0)
        # The recovery budget was not part of the drain's announcement,
        # so a second one has to carry it.
        self.assertEqual(len(announced), 1)
        self.assertAlmostEqual(announced[0], recovery_budget_sec([(5.2, 6.4)]))
        # And what the envelope now reports as uncovered is what this
        # module would still call uncovered — one answer, not two.
        self.assertEqual(out["uncoveredSpeechSec"], 0.0)

    async def test_the_envelope_reports_what_recovery_could_not_reach(self):
        payload = {
            "type": "final",
            "text": "начало",
            "segments": [_segment(0.0, 3.0, [("начало", 0.0, 3.0)])],
            "streamedSec": 3.0,
            "stats": {},
        }

        def failing_rest(**kwargs):
            raise RuntimeError("Deepgram API error (HTTP 500)")

        out = await run_recovery(
            payload=payload,
            evidence=InterimEvidence(),
            stream_death_sec=3.0,
            pcm=_pcm(9.0),
            cfg=DeepgramLiveConfig(),
            api_key="dg",
            transcribe=failing_rest,
        )
        self.assertEqual(out["text"], "начало")
        self.assertEqual(out["stats"]["recovery"]["words"], 0)
        # Honest, not silent: the span that failed is still declared.
        self.assertGreater(out["uncoveredSpeechSec"], 5.0)

    async def test_an_already_announced_budget_is_not_announced_twice(self):
        payload = {
            "type": "final",
            "text": "",
            "segments": [],
            "streamedSec": 0.0,
            "stats": {},
        }
        announced: list[float] = []
        spans = uncovered_spans(0.0, [], InterimEvidence(), 0.0, audio_sec=4.0)

        out = await run_recovery(
            payload=payload,
            evidence=InterimEvidence(),
            stream_death_sec=0.0,
            pcm=_pcm(4.0),
            cfg=DeepgramLiveConfig(),
            api_key="dg",
            announce=announced.append,
            announced_recovery_sec=recovery_budget_sec(spans),
            transcribe=lambda **kw: _rest_result([("привет", 0.5, 1.0)]),
        )
        self.assertEqual(announced, [])
        # The transcript's first word opens a sentence (``backend.word_case``).
        self.assertEqual(out["text"], "Привет")

    async def test_whole_recording_recovery_produces_a_non_empty_envelope(self):
        # The connect-failure shape, at the module level: no reading, no
        # segments, and every captured byte unseen by Deepgram.
        payload = {
            "type": "final",
            "text": "",
            "segments": [],
            "durationSec": 0.0,
            "streamedSec": 0.0,
            "coveredEndSec": 0.0,
            "uncoveredSpeechSec": 0.0,
            "error": "connect failed",
            "stats": {},
        }
        out = await run_recovery(
            payload=payload,
            evidence=InterimEvidence(),
            stream_death_sec=0.0,
            pcm=_pcm(6.0),
            cfg=DeepgramLiveConfig(),
            api_key="dg",
            transcribe=lambda **kw: _rest_result(
                [("так", 0.5, 0.9), ("слушай", 1.0, 1.6)]
            ),
        )
        # The transcript's first word opens a sentence (``backend.word_case``).
        self.assertEqual(out["text"], "Так слушай")
        self.assertEqual(out["stats"]["recovery"]["words"], 2)
        self.assertEqual(out["stats"]["recovery"]["spans"], [[0.0, 6.0]])
        self.assertEqual(out["coveredEndSec"], 1.6)
        self.assertEqual(out["durationSec"], 1.6)
        self.assertEqual(
            [w.get("source") for seg in out["segments"] for w in seg["words"]],
            [RECOVERY_SOURCE, RECOVERY_SOURCE],
        )
        # The failure that produced this envelope is still declared.
        self.assertEqual(out["error"], "connect failed")


class _FakeWebSocket:
    def __init__(self):
        self.messages: "asyncio.Queue[dict]" = asyncio.Queue()
        self.sent: list[dict] = []

    async def receive(self):
        return await self.messages.get()

    async def send_text(self, text):
        self.sent.append(json.loads(text))


class _FakeStats:
    bytes_sent = 0
    bytes_offered = 0
    chunks_sent = 0
    segments_final = 0
    segments_interim = 0
    connect_ms = None
    finalize_ms = None

    def as_dict(self):
        return {}


class LiveSessionRecoveryWiringTests(unittest.IsolatedAsyncioTestCase):
    """R3: the connect-failure path recovers the recording itself.

    It used to send ``{"text": "", "segments": []}`` and return while
    the microphone was still open (audit §3.7 — a 12 s connect timeout
    with 126 s dictated into a dead stream), leaving the transcript to a
    renderer-side REST pass that no longer exists.
    """

    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        os.environ["TRANSCRIPTOR_DATA_DIR"] = self._tmp.name
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")

    def tearDown(self):
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        self._tmp.cleanup()

    def _spool(self) -> dict:
        pcm_path = Path(self._tmp.name) / "spool.pcm16"
        handle = pcm_path.open("wb", buffering=0)
        return {
            "session_id": "s",
            "pcm_path": pcm_path,
            "meta_path": Path(self._tmp.name) / "spool.json",
            "pcm_file": handle,
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

    async def test_a_failed_connect_still_delivers_a_transcript(self):
        main = self.main
        release_connect = asyncio.Event()

        class FailingConnectSession:
            def __init__(self, *_a, **_kw):
                self.stats = _FakeStats()

            async def connect(self):
                await release_connect.wait()
                raise main.DeepgramLiveError("simulated connect failure")

        ws = _FakeWebSocket()
        recovery = self._spool()
        audio = _pcm(4.0)
        rest_calls: list[dict] = []

        def fake_rest(**kwargs):
            rest_calls.append(kwargs)
            return _rest_result([("так", 0.5, 0.9), ("слушай", 1.0, 1.6)])

        try:
            with mock.patch.object(main, "DeepgramLiveSession", FailingConnectSession), \
                    mock.patch(
                        "backend.deepgram_recovery.deepgram_transcribe", fake_rest
                    ):
                task = asyncio.create_task(main._run_deepgram_live_session(
                    websocket=ws,
                    api_key="dg",
                    model="nova-3",
                    language="auto",
                    diarize=False,
                    recovery=recovery,
                ))
                await asyncio.sleep(0.01)
                await ws.messages.put(
                    {"type": "websocket.receive", "bytes": audio}
                )
                await asyncio.sleep(0.01)
                release_connect.set()
                # The user is still talking: the handler must keep
                # reading (and spooling) rather than return an empty
                # envelope the moment connect failed.
                await asyncio.sleep(0.05)
                self.assertFalse(task.done())
                await ws.messages.put({
                    "type": "websocket.receive",
                    "text": json.dumps({"type": "finalize"}),
                })
                await asyncio.wait_for(task, timeout=5.0)
        finally:
            recovery["pcm_file"].close()

        self.assertTrue(recovery["had_error"])
        self.assertEqual(recovery["bytes"], len(audio))
        types = [m["type"] for m in ws.sent]
        self.assertEqual(types[0], "error")
        self.assertEqual(types[-1], "final")
        # The renderer is told how long this stop may now take.
        self.assertIn("finalizing", types)
        envelope = ws.sent[-1]
        self.assertEqual(envelope["text"], "Так слушай")
        self.assertEqual(envelope["stats"]["recovery"]["words"], 2)
        self.assertTrue(envelope["error"])
        # Same language decision the dead live stream would have used.
        self.assertEqual(rest_calls[0]["language"], "multi")

    async def test_a_connect_failure_with_no_spool_still_answers(self):
        main = self.main
        release_connect = asyncio.Event()

        class FailingConnectSession:
            def __init__(self, *_a, **_kw):
                self.stats = _FakeStats()

            async def connect(self):
                await release_connect.wait()
                raise main.DeepgramLiveError("simulated connect failure")

        ws = _FakeWebSocket()
        recovery = {
            "pcm_file": io.BytesIO(),
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }
        with mock.patch.object(main, "DeepgramLiveSession", FailingConnectSession):
            task = asyncio.create_task(main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            ))
            await asyncio.sleep(0.01)
            release_connect.set()
            await ws.messages.put({
                "type": "websocket.receive",
                "text": json.dumps({"type": "finalize"}),
            })
            await asyncio.wait_for(task, timeout=5.0)

        self.assertEqual([m["type"] for m in ws.sent], ["error", "final"])
        self.assertEqual(ws.sent[-1]["text"], "")


class RecoverySpoolReadTests(unittest.TestCase):
    """R4: the PCM must be available and complete at finalize."""

    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        os.environ["TRANSCRIPTOR_DATA_DIR"] = self._tmp.name
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")

    def tearDown(self):
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        self._tmp.cleanup()

    def test_the_spool_is_readable_while_the_writer_still_holds_it(self):
        main = self.main
        pcm_path = Path(self._tmp.name) / "s.pcm16"
        handle = pcm_path.open("wb", buffering=0)
        recovery = {
            "pcm_path": pcm_path,
            "meta_path": Path(self._tmp.name) / "s.json",
            "pcm_file": handle,
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }
        try:
            main._record_recovery_chunk(recovery, b"\x01\x02\x03\x04")
            main._record_recovery_chunk(recovery, b"\x05\x06")
            self.assertEqual(
                main._recovery_spool_bytes(recovery), b"\x01\x02\x03\x04\x05\x06"
            )
        finally:
            handle.close()

    def test_no_spool_reads_as_no_audio(self):
        self.assertEqual(self.main._recovery_spool_bytes(None), b"")
        self.assertEqual(self.main._recovery_spool_bytes({}), b"")

    def test_an_oversized_spool_is_refused_rather_than_read(self):
        main = self.main
        pcm_path = Path(self._tmp.name) / "big.pcm16"
        pcm_path.write_bytes(b"\x00\x00")
        recovery = {"pcm_path": pcm_path}
        with mock.patch.object(main, "MAX_RECOVERY_READ_BYTES", 1):
            self.assertEqual(main._recovery_spool_bytes(recovery), b"")


class RecoveryReportWireShapeTests(unittest.TestCase):
    """``stats.recovery`` is a contract, so its shape is pinned here.

    ``frontend/src/main.tsx`` (``parseLiveFinalStats``) reads
    ``spans_sec`` and ``ms`` off this dict and states in a comment that
    those names are the contract it implements. A rename on this side
    would not fail a single other test — the renderer would simply stop
    showing the two numbers — so the names, types and derivation are
    asserted directly.
    """

    def test_the_keys_and_types_are_the_ones_the_renderer_parses(self):
        report = RecoveryReport(
            spans=[(5.2, 6.4), (9.0, 10.5)], ms=812.34, words=7
        )
        wire = report.as_dict()
        self.assertEqual(
            sorted(wire), ["ms", "spans", "spans_sec", "words"]
        )
        self.assertEqual(wire["spans"], [[5.2, 6.4], [9.0, 10.5]])
        self.assertIsInstance(wire["spans_sec"], float)
        self.assertIsInstance(wire["ms"], float)
        self.assertIsInstance(wire["words"], int)
        self.assertEqual(wire["ms"], 812.3)
        self.assertEqual(wire["words"], 7)

    def test_spans_sec_is_the_total_of_the_spans_it_reports(self):
        report = RecoveryReport(spans=[(5.2, 6.4), (9.0, 10.5)])
        self.assertAlmostEqual(report.spans_sec(), 2.7, places=3)
        self.assertAlmostEqual(report.as_dict()["spans_sec"], 2.7, places=3)

    def test_no_spans_is_zero_seconds_rather_than_absent(self):
        wire = RecoveryReport().as_dict()
        self.assertEqual(wire["spans"], [])
        self.assertEqual(wire["spans_sec"], 0.0)
        self.assertEqual(wire["words"], 0)

    def test_a_reversed_span_cannot_make_the_total_negative(self):
        # Nothing produces one today; a non-negative total is what the
        # renderer's parser accepts, so it must hold by construction.
        self.assertEqual(RecoveryReport(spans=[(4.0, 3.0)]).spans_sec(), 0.0)


class RepairedEnvelopeFieldsTests(unittest.IsolatedAsyncioTestCase):
    """A repaired envelope's numbers mean what an unrepaired one's do.

    ``deepgram_recovery`` was not in the audit's discovery snapshot;
    these are its own findings. ``run_recovery`` set ``durationSec`` and
    ``coveredEndSec`` to the same merged end, which put the pair back in
    lockstep on every repaired stop — the state B-006 fixed for the
    un-repaired one, and the pair the renderer compares to decide
    whether the envelope covers the recording.
    """

    async def test_a_spliced_interim_extends_duration_but_not_coverage(self):
        payload = {
            "type": "final",
            "text": "committed guessed",
            "segments": [
                _segment(0.0, 1.0, [("committed", 0.0, 1.0)]),
                {
                    "start": 7.0,
                    "end": 8.0,
                    "text": "guessed",
                    "source": "interim-fallback",
                    "words": [{"word": "guessed", "start": 7.0, "end": 8.0}],
                },
            ],
            "streamedSec": 10.0,
            "stats": {},
        }

        def fake_rest(**kwargs):
            return _rest_result([("восстановлено", 0.1, 0.6)])

        out = await run_recovery(
            payload=payload,
            evidence=InterimEvidence(hole_spans=((3.0, 3.6),)),
            stream_death_sec=None,
            pcm=_pcm(10.0),
            cfg=DeepgramLiveConfig(),
            api_key="dg",
            transcribe=fake_rest,
        )
        self.assertEqual(out["durationSec"], 8.0)
        self.assertLess(
            out["coveredEndSec"],
            out["durationSec"],
            "a spliced interim was reported as decoded coverage",
        )

    async def test_a_recovered_word_inside_a_wordless_final_is_dropped(self):
        # The other half of the coverage rule, which the live splice
        # applies and this one did not: a final that arrived WITHOUT a
        # word list accounts for its whole span, and there is no
        # covering WORD to name. Spans are padded before decoding, so a
        # re-decode reaches into ground such a final owns.
        payload = {
            "type": "final",
            "text": "это весь мой текст",
            "segments": [
                _segment(0.0, 2.0, [("начало", 0.0, 2.0)]),
                # No word list — only a span.
                {"start": 4.0, "end": 6.0, "text": "это весь мой текст"},
            ],
            "streamedSec": 8.0,
            "stats": {},
        }

        def fake_rest(**kwargs):
            # The span handed over is the padded hole (2.2-3.5 s); the
            # decoder places this word past its end, which is exactly
            # what padding plus decoder drift produces — squarely inside
            # the wordless final at 4.0-6.0 s.
            return _rest_result([("дубликат", 1.9, 2.3)])

        out = await run_recovery(
            payload=payload,
            evidence=InterimEvidence(hole_spans=((2.5, 3.2),)),
            stream_death_sec=None,
            pcm=_pcm(8.0),
            cfg=DeepgramLiveConfig(),
            api_key="dg",
            transcribe=fake_rest,
        )
        self.assertNotIn("дубликат", out["text"])
        self.assertEqual(out["stats"]["recovery"]["words"], 0)


class DecodedEndRuleTests(unittest.TestCase):
    def test_an_interim_hypothesis_is_not_a_decode(self):
        from backend.deepgram_recovery import decoded_end_sec

        segments = [
            {"start": 0.0, "end": 1.0, "text": "final"},
            {"start": 5.0, "end": 6.0, "text": "rest", "source": "recovery"},
            {"start": 7.0, "end": 8.0, "text": "guess", "source": "interim-fallback"},
        ]
        self.assertEqual(decoded_end_sec(segments), 6.0)

    def test_no_segments_is_zero(self):
        from backend.deepgram_recovery import decoded_end_sec

        self.assertEqual(decoded_end_sec([]), 0.0)
        self.assertEqual(decoded_end_sec(None), 0.0)


class RestWordSourceTests(unittest.TestCase):
    def test_words_come_from_the_adapter_key_not_the_payload_shape(self):
        # ``backend.remote_deepgram`` owns where Deepgram puts words in
        # its JSON. This module reached into
        # ``raw["results"]["channels"][0]["alternatives"][0]``, which is
        # that knowledge written out a second time.
        from backend.deepgram_recovery import _words_from_rest_result

        out = _words_from_rest_result(
            {"words": [{"word": "слово", "start": 0.2, "end": 0.6}]}, 5.0
        )
        self.assertEqual(
            out,
            [{"word": "слово", "start": 5.2, "end": 5.6, "source": RECOVERY_SOURCE}],
        )

    def test_a_response_without_words_yields_none(self):
        from backend.deepgram_recovery import _words_from_rest_result

        self.assertEqual(_words_from_rest_result({"text": "x"}, 0.0), [])
        self.assertEqual(_words_from_rest_result(None, 0.0), [])

if __name__ == "__main__":
    unittest.main()
