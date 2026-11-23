"""The post-Finalize wait, and what actually ends it.

Measured over 410 real stops in main.log: 267 (65 %) ended with the
streamed audio ALREADY fully covered by finalized segments and burned
the full ``FINALIZE_FLUSH_WAIT_SEC`` ceiling anyway — 608 s of stop
latency, almost all of it here. The conclusion drawn at the time was
that Deepgram answers such a Finalize with nothing, and two shorter
ceilings were sized on that conclusion.

It answers. The answer to "Finalize with nothing buffered" is an
``is_final`` carrying an empty transcript, and it was being deleted by
the empty-text guard at the top of ``_process_deepgram_message``, above
the is_final branch, so it armed nothing (B-005). The 608 s measured a
bug in this backend, not a silent provider.

So there is ONE ceiling again, and the wait ends on Deepgram's answer
rather than on a timer: words, or the empty final that says there are
none. Coverage is still measured before the wait, because it decides
whether a RETRY is possible and therefore what worst case the renderer
is told to expect.
"""

from __future__ import annotations

import asyncio
import json
import time
import unittest
from unittest import mock

from backend.remote_deepgram_live import (
    COVERAGE_GAP_MIN_SEC,
    FINALIZE_ASSEMBLY_ALLOWANCE_SEC,
    FINALIZE_FLUSH_WAIT_SEC,
    TAIL_GUARD_MIN_SPEECH_SEC,
    DeepgramLiveSession,
    confirmed_silence_gap,
    tail_needs_flush,
    tail_needs_recovery,
)
from backend.deepgram_recovery import evidence_from_session


class FakeUpstreamWs:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, payload):
        self.sent.append(json.loads(payload).get("type"))

    async def close(self):
        return None

    @property
    def types(self) -> list[str]:
        return list(self.sent)


def _session(
    *,
    streamed_sec: float,
    covered_end: float,
    tail_speech_sec: float = 0.0,
    interim_window_overhang_sec: float = 0.0,
) -> DeepgramLiveSession:
    """A session whose tail is either silence or recognised speech.

    ``tail_speech_sec`` seeds an interim speech span running past
    ``covered_end`` — the difference between "the user was still talking
    when Stop landed" and "the user finished and then reached for the
    hotkey", which is what the budget now turns on (rule 1).

    ``interim_window_overhang_sec`` seeds the OTHER signal
    ``_tail_needs_flush`` reads: the newest interim's own decode window,
    regardless of recognised words, still reaching past ``covered_end``
    (rule 2) — set independently of ``tail_speech_sec`` so a test can
    exercise either signal alone.
    """
    session = DeepgramLiveSession(api_key="k")
    session._ws = FakeUpstreamWs()
    session._keepalive_task = None
    session._recv_task = None
    # bytes_sent is the only input to streamed_sec: 16 kHz, 16-bit mono.
    session.stats.bytes_sent = int(streamed_sec * 2 * session._cfg.sample_rate)
    if covered_end > 0:
        session._finalized_segments = [
            {"start": 0.0, "end": covered_end, "text": "x", "speech_final": True}
        ]
        # What the recv loop would have recorded alongside the segment.
        session._last_final_speech_final = True
    if tail_speech_sec > 0:
        session._interim_speech_spans = [
            (covered_end, covered_end + tail_speech_sec)
        ]
    if interim_window_overhang_sec > 0:
        session._latest_interim_window_end = covered_end + interim_window_overhang_sec
    return session


def _recovers_tail(
    session: DeepgramLiveSession, tail_gap: float, tail_speech: float, covered_end: float
) -> bool:
    """The recovery pass's tail rule, asked with the evidence it reads off
    *session* (``evidence_from_session``) — the question
    ``deepgram_recovery`` puts to every stopped recording."""
    evidence = evidence_from_session(session)
    return tail_needs_recovery(
        tail_gap,
        tail_speech,
        evidence.interim_window_end - covered_end,
        evidence.endpointing_sec,
        evidence.utterance_end_sec,
    )


def _deliver_final(
    session: DeepgramLiveSession,
    start: float,
    end: float,
    text: str,
    *,
    speech_final: bool = True,
) -> None:
    """Land an ``is_final`` exactly as the recv loop does.

    Appending the segment BEFORE setting the event is the ordering the
    recv loop uses, and the flush wait depends on it: it re-measures
    coverage the moment the event fires, so a test that only sets the
    event describes a message that carried no transcript.
    """
    session._finalized_segments.append(
        {
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text,
            "confidence": 0.9,
            "is_final": True,
            "speech_final": speech_final,
            "words": [],
        }
    )
    session.stats.segments_final += 1
    session._last_final_speech_final = speech_final
    session._final_arrived.set()


def _deliver_empty_final(
    session: DeepgramLiveSession,
    start: float,
    duration: float,
    *,
    speech_final: bool = True,
) -> None:
    """Deepgram's answer to a Finalize with nothing left buffered.

    Driven through ``_process_deepgram_message`` rather than by poking
    fields, because the defect this pins (B-005) was in that method: the
    message was parsed, found to have no transcript, and dropped before
    the is_final branch could see it.
    """
    session._process_deepgram_message(
        {
            "type": "Results",
            "is_final": True,
            "speech_final": speech_final,
            "start": start,
            "duration": duration,
            "channel": {"alternatives": [{"transcript": "", "words": []}]},
        }
    )


class TailCoverageTests(unittest.TestCase):
    def test_coverage_is_derived_from_bytes_and_segment_ends(self):
        session = _session(streamed_sec=10.0, covered_end=9.5)
        streamed, covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(streamed, 10.0, places=2)
        self.assertAlmostEqual(covered, 9.5, places=2)
        self.assertAlmostEqual(gap, 0.5, places=2)
        self.assertEqual(speech, 0.0)

    def test_no_finalized_segments_means_everything_is_uncovered(self):
        session = _session(streamed_sec=4.0, covered_end=0.0)
        _streamed, covered, gap, _speech = session._tail_coverage()
        self.assertEqual(covered, 0.0)
        self.assertAlmostEqual(gap, 4.0, places=2)

    def test_a_silent_session_reports_no_gap(self):
        session = _session(streamed_sec=0.0, covered_end=0.0)
        self.assertEqual(session._tail_coverage(), (0.0, 0.0, 0.0, 0.0))

    def test_trailing_silence_is_a_gap_with_no_speech_in_it(self):
        # The common shape: the user finished speaking at 52.08 s and
        # pressed Stop at 54.0 s. Almost every recording ends this way.
        session = _session(streamed_sec=54.0, covered_end=52.08)
        _streamed, _covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 1.92, places=2)
        self.assertEqual(speech, 0.0)

    def test_speech_in_the_tail_is_measured(self):
        session = _session(streamed_sec=54.0, covered_end=52.0, tail_speech_sec=1.5)
        _streamed, _covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 2.0, places=2)
        self.assertAlmostEqual(speech, 1.5, places=2)

    def test_overlapping_interims_are_not_counted_twice(self):
        # A rolling re-decode emits many hypotheses over the same audio.
        session = _session(streamed_sec=54.0, covered_end=52.0)
        session._interim_speech_spans = [(52.0, 53.5), (52.4, 53.8), (53.0, 54.0)]
        _streamed, _covered, _gap, speech = session._tail_coverage()
        self.assertAlmostEqual(speech, 2.0, places=2)

    def test_speech_before_the_last_final_does_not_count_as_tail(self):
        # Those words are already in the transcript.
        session = _session(streamed_sec=54.0, covered_end=52.0)
        session._interim_speech_spans = [(10.0, 40.0)]
        _streamed, _covered, _gap, speech = session._tail_coverage()
        self.assertEqual(speech, 0.0)

    def test_a_dropped_send_does_not_shrink_the_gap(self):
        # B1 (audit §3.6): a mid-stream send timeout drops the chunk from
        # bytes_sent, but the mic still captured it. bytes_offered is the
        # honest total; tail_gap must be measured from whichever count is
        # larger, so a drop can only ever widen the gap, never hide it.
        session = _session(streamed_sec=10.0, covered_end=9.5)
        sr = session._cfg.sample_rate
        session.stats.bytes_sent = int(9.6 * 2 * sr)  # one chunk lost
        session.stats.bytes_offered = int(10.0 * 2 * sr)  # captured in full
        streamed, _covered, gap, _speech = session._tail_coverage()
        self.assertAlmostEqual(streamed, 10.0, places=2)
        self.assertAlmostEqual(gap, 0.5, places=2)

    def test_send_pcm_tracks_offered_separately_from_sent(self):
        async def run():
            session = _session(streamed_sec=0.0, covered_end=0.0)

            class TimingOutWs:
                # Raises the same exception a wedged 5s send would
                # eventually produce via asyncio.wait_for, without
                # actually waiting 5 real seconds in the test.
                async def send(self, _payload):
                    raise asyncio.TimeoutError()

                async def close(self):
                    return None

            session._ws = TimingOutWs()
            chunk = b"\x00\x01" * 100
            await session.send_pcm(chunk)
            self.assertEqual(session.stats.bytes_offered, len(chunk))
            self.assertEqual(session.stats.bytes_sent, 0)

        asyncio.run(run())

    def test_utterance_end_shrinks_a_confirmed_silent_tail(self):
        # C7 (audit §3.5): Deepgram's own "the utterance ended here"
        # signal is stronger evidence than "no recent interim" — it
        # confirms the tail past last_word_end is silence, not merely
        # unproven. A 4 s raw gap that Deepgram itself closed at +0.3 s
        # must not be treated as a 4 s unflushed tail.
        session = _session(streamed_sec=54.0, covered_end=52.0)
        session._last_utterance_end = 52.3
        _streamed, _covered, gap, _speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 0.3, places=2)

    def test_utterance_end_is_ignored_if_speech_resumed_after_it(self):
        # The utterance ended, then the user started a new one — a later
        # interim carrying speech past last_word_end must veto the
        # shrink; that region is not confirmed silence after all.
        session = _session(streamed_sec=54.0, covered_end=52.0)
        session._last_utterance_end = 52.3
        session._interim_speech_spans = [(53.0, 53.8)]
        _streamed, _covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 2.0, places=2)
        self.assertAlmostEqual(speech, 0.8, places=2)

    def test_utterance_end_before_the_last_final_is_irrelevant(self):
        # A stale UtteranceEnd from earlier in the stream must not affect
        # a tail that opened up after it.
        session = _session(streamed_sec=54.0, covered_end=52.0)
        session._last_utterance_end = 10.0
        _streamed, _covered, gap, _speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 2.0, places=2)


class WaitBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_empty_tail_ends_the_wait_on_deepgrams_own_answer(self):
        """B-005, the root cause the two short ceilings were built over.

        0.1 s past the last final is a segment boundary, not a tail, so
        Finalize has nothing to flush — and Deepgram says so, with an
        ``is_final`` carrying an empty transcript. Dropping that message
        is what made this stop sit out its whole window; with it
        recorded the wait ends on the answer and the full ceiling (5 s
        here) is never approached.
        """
        session = _session(streamed_sec=90.0, covered_end=89.9)
        ws = session._ws

        async def answer():
            await asyncio.sleep(0.02)
            _deliver_empty_final(session, 89.9, 0.1)

        started = time.perf_counter()
        task = asyncio.create_task(answer())
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 5.0
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        await task
        elapsed = time.perf_counter() - started
        self.assertIn("CloseStream", ws.types)
        self.assertLess(
            elapsed, 1.0,
            f"the flush was answered and the wait still ran {elapsed:.2f}s",
        )
        self.assertEqual(session.stats.empty_finals, 1)

    async def test_uncovered_tail_still_gets_the_full_ceiling(self):
        # Real unflushed speech: truncating the wait here would cost the
        # user the clause they just spoke.
        session = _session(streamed_sec=90.0, covered_end=85.0, tail_speech_sec=4.0)
        ws = session._ws
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.25
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertIn("CloseStream", ws.types)
        # First wait (0.25) plus the tail-guard retry wait (0.25).
        self.assertGreaterEqual(elapsed, 0.25)
        # The retry Finalize must actually have been sent.
        self.assertEqual(ws.types.count("Finalize"), 2)

    async def test_an_early_COVERING_final_short_circuits_either_budget(self):
        """A final that reaches the end of the streamed audio ends the wait.

        It used to be enough for a final to ARRIVE. That is the bug in
        §A1: the first final of a flush can cover a fraction of the tail
        (session 62115e77: 0.00-10.85 s of 14.26 s), and ending the wait
        on its arrival threw away the rest. The wait ends on coverage,
        so this test delivers a final that actually covers.
        """
        session = _session(streamed_sec=90.0, covered_end=85.0, tail_speech_sec=4.0)

        async def deliver_now():
            await asyncio.sleep(0.02)
            _deliver_final(session, 85.0, 90.0, "the rest of it.")

        started = time.perf_counter()
        task = asyncio.create_task(deliver_now())
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 5.0
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        await task
        self.assertLess(time.perf_counter() - started, 1.0)

    async def test_a_small_but_real_tail_is_not_treated_as_jitter(self):
        """The regression that cost a user the end of a sentence.

        Production 2026-08-25 14:33:16: gap=0.50 s, no interim had
        decoded it, the stream closed 0.25 s after Finalize and the
        transcript arrived ending mid-clause. 0.50 s is below the retry
        threshold but far above boundary jitter — Finalize has real audio
        to flush there and the answer takes a round trip.
        """
        session = _session(streamed_sec=24.36, covered_end=23.86)
        _streamed, _covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 0.50, places=2)
        self.assertEqual(speech, 0.0)
        self.assertGreater(gap, COVERAGE_GAP_MIN_SEC)
        # No voiced evidence at all (no interim ever touched this ground),
        # so this tail does NOT ask for a RETRY.
        self.assertFalse(session._tail_needs_flush(speech, 23.86))

        # It does get the full round-trip ceiling, and it waits for the
        # answer: half a second of audio Finalize has to flush is exactly
        # what a truncated window used to throw away.
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.30
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertGreaterEqual(
            elapsed, 0.30,
            f"a 0.50 s tail was given a truncated window ({elapsed:.2f}s)",
        )

    async def test_empty_tail_never_triggers_the_retry(self):
        # A retry on an empty tail is a round trip that cannot produce
        # anything: every streamed second is already in a final.
        session = _session(streamed_sec=90.0, covered_end=89.95)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 1)


class TrailingSilenceTests(unittest.IsolatedAsyncioTestCase):
    """The shape almost every recording ends in."""

    async def test_uncovered_audio_with_no_voiced_evidence_does_not_retry(self):
        # session f94121ae, 2026-09-04T12:26:33Z: 0.91 s of uncovered
        # audio, 0.05 s of it recognised speech (decoder noise, not a
        # word) — this used to retry on the raw gap alone and cost 6010 ms
        # to close; audit §5 measured that shape's hit rate at 1 in 84.
        # No interim ever voiced this ground and no interim window is
        # still reaching into it, so there is nothing to wait for.
        session = _session(streamed_sec=52.99, covered_end=52.08, tail_speech_sec=0.05)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 1, "no retry — nothing was voiced")
        self.assertIn("CloseStream", ws.types)

    async def test_speech_in_the_tail_still_triggers_the_retry(self):
        # The user was mid-clause when Stop landed. This is the case the
        # guard exists for and it must be unchanged.
        session = _session(streamed_sec=54.0, covered_end=52.0, tail_speech_sec=1.5)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 2)

    async def test_the_covered_case_still_closes_fast(self):
        # The saving that remains and is safe: nothing uncovered at all,
        # so there is provably nothing to flush.
        session = _session(streamed_sec=90.0, covered_end=89.9)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 1)

    def test_only_voiced_evidence_can_ask_for_a_retry(self):
        # Uncovered audio ALONE is no longer enough — that is the exact
        # regression this test used to pin (session f94121ae: 0.91 s
        # uncovered, 0.05 s recognised, retried anyway, 6010 ms to close;
        # audit §5 measured this shape's hit rate at 1 in 84). A large
        # raw gap with no interim evidence at all is silence.
        session = _session(streamed_sec=54.0, covered_end=52.0)
        self.assertFalse(session._tail_needs_flush(0.0, 52.0))
        # Recognised speech (rule 1) is enough on its own, gap aside.
        self.assertTrue(
            session._tail_needs_flush(TAIL_GUARD_MIN_SPEECH_SEC, 52.0)
        )
        # Below the speech threshold and no interim window reaching past
        # ``covered_end``: neither rule fires.
        self.assertFalse(
            session._tail_needs_flush(TAIL_GUARD_MIN_SPEECH_SEC - 0.01, 52.0)
        )

    def test_an_interim_window_past_the_endpointing_gap_asks_for_a_retry(self):
        # Rule 2: no recognised WORDS yet, but Deepgram's own newest
        # decode window is still reaching well past ``covered_end`` — the
        # provider's own claim that it has not finished with that audio.
        endpointing_sec = 300 / 1000.0  # DeepgramLiveConfig default
        session = _session(
            streamed_sec=54.0,
            covered_end=52.0,
            interim_window_overhang_sec=endpointing_sec + 0.05,
        )
        self.assertTrue(session._tail_needs_flush(0.0, 52.0))

    def test_an_interim_window_within_the_endpointing_gap_does_not_retry(self):
        # The same signal, but the overhang is inside the configured
        # endpointing silence window — ordinary re-decode jitter, not
        # evidence the provider is still working unflushed speech.
        endpointing_sec = 300 / 1000.0
        session = _session(
            streamed_sec=54.0,
            covered_end=52.0,
            interim_window_overhang_sec=endpointing_sec - 0.05,
        )
        self.assertFalse(session._tail_needs_flush(0.0, 52.0))


class BudgetAnnouncementTests(unittest.IsolatedAsyncioTestCase):
    """The stop's deadline is published before the waiting starts.

    The renderer used to bound its own wait with a constant while this
    side could legitimately spend nine seconds; 24 % of stops measured on
    2026-08-25 ran past that constant, and everything the extra wait
    recovered arrived after the transcript had been delivered. The
    coverage analysis that decides the budget happens here, so the number
    is published from here.
    """

    async def test_an_uncovered_tail_announces_the_ceiling_and_the_retry(self):
        session = _session(streamed_sec=90.0, covered_end=85.0, tail_speech_sec=4.0)
        seen: list[tuple[float, bool]] = []
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            await session.drain_transcript(
                on_budget=lambda budget, more: seen.append((budget, more)),
            )
            await session.shutdown(wait_timeout=0.3)
        self.assertEqual(len(seen), 1, "announced exactly once")
        budget, expects_more = seen[0]
        self.assertTrue(expects_more, "an uncovered tail expects the wait to add words")
        # Worst case, not the expected case: the retry pays the ceiling
        # again, plus the fixed post-wait assembly cost (C3) — the budget
        # bounds time to the envelope, not just the flush wait.
        self.assertAlmostEqual(
            budget, 0.10 + FINALIZE_ASSEMBLY_ALLOWANCE_SEC, places=3
        )

    async def test_an_empty_tail_announces_that_waiting_buys_nothing(self):
        session = _session(streamed_sec=90.0, covered_end=89.95)
        seen: list[tuple[float, bool]] = []
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.02
        ):
            await session.drain_transcript(
                on_budget=lambda budget, more: seen.append((budget, more)),
            )
            await session.shutdown(wait_timeout=0.3)
        self.assertEqual(len(seen), 1)
        budget, expects_more = seen[0]
        # No retry is possible, so the announced bound is ONE ceiling and
        # not two. ``expects_more`` is the coverage verdict, unchanged.
        self.assertFalse(expects_more)
        self.assertAlmostEqual(
            budget, 0.02 + FINALIZE_ASSEMBLY_ALLOWANCE_SEC, places=3
        )

    async def test_a_voiceless_uncovered_tail_does_not_announce_a_retry(self):
        # (a) session f94121ae's exact shape: 0.91 s uncovered, 0.05 s of
        # it recognised — below TAIL_GUARD_MIN_SPEECH_SEC, so this is not
        # "unflushed speech" and must not announce the retry ceiling.
        session = _session(streamed_sec=52.99, covered_end=52.08, tail_speech_sec=0.05)
        seen: list[tuple[float, bool]] = []
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.10
        ):
            await session.drain_transcript(
                on_budget=lambda budget, more: seen.append((budget, more)),
            )
            await session.shutdown(wait_timeout=0.5)
        self.assertEqual(len(seen), 1)
        budget, expects_more = seen[0]
        self.assertFalse(expects_more, "no voiced evidence: nothing more is expected")
        # One ceiling, not two: the retry is what cost this exact session
        # 6010 ms in production and it is not announced here.
        self.assertAlmostEqual(
            budget, 0.10 + FINALIZE_ASSEMBLY_ALLOWANCE_SEC, places=3
        )

    async def test_a_voiced_tail_below_the_old_threshold_still_retries(self):
        # (b) 0.9 s uncovered, 0.6 s of it recognised speech — well past
        # TAIL_GUARD_MIN_SPEECH_SEC (0.25 s) even though it is well under
        # the OLD gap-alone threshold (0.75 s) that used to gate this.
        # Real recognised speech in the tail must still retry, exactly as
        # before the fix.
        session = _session(streamed_sec=90.0, covered_end=89.1, tail_speech_sec=0.6)
        ws = session._ws
        seen: list[tuple[float, bool]] = []
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            await session.drain_transcript(
                on_budget=lambda budget, more: seen.append((budget, more)),
            )
            await session.shutdown(wait_timeout=0.5)
        self.assertEqual(len(seen), 1)
        _budget, expects_more = seen[0]
        self.assertTrue(expects_more, "recognised speech in the tail expects more")
        self.assertEqual(ws.types.count("Finalize"), 2, "retry as today")

    async def test_a_throwing_consumer_cannot_break_the_stop(self):
        session = _session(streamed_sec=90.0, covered_end=89.95)
        ws = session._ws

        def explode(_budget: float, _more: bool) -> None:
            raise RuntimeError("consumer is broken")

        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.02
        ):
            await session.drain_transcript(on_budget=explode)
            await session.shutdown(wait_timeout=0.3)
        self.assertIn("CloseStream", ws.types, "the stop completed anyway")

    async def test_no_consumer_is_the_default(self):
        session = _session(streamed_sec=90.0, covered_end=89.95)
        ws = session._ws   # shutdown() releases the socket on its way out
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.02
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.3)
        self.assertIn("CloseStream", ws.types)


class BudgetIsAnHonestEnvelopeBoundTests(unittest.IsolatedAsyncioTestCase):
    """C3: ``budgetMs`` must bound wall time to the ENVELOPE, not just the
    flush wait.

    ``drain_transcript()`` is the method that now produces the envelope
    (C4 — CloseStream/recv-drain/close happen afterwards in
    ``shutdown()``), so the announced budget is checked against ITS
    wall-clock duration, in all three tail shapes: fully covered, an
    empty tail (nothing to flush) and an uncovered tail (retry paid).
    """

    async def _measure(self, *, streamed_sec, covered_end, tail_speech_sec=0.0):
        session = _session(
            streamed_sec=streamed_sec,
            covered_end=covered_end,
            tail_speech_sec=tail_speech_sec,
        )
        announced: list[float] = []

        def on_budget(budget_sec: float, _expects_more: bool) -> None:
            announced.append(budget_sec)

        started = time.perf_counter()
        await session.drain_transcript(on_budget=on_budget)
        elapsed = time.perf_counter() - started
        self.assertEqual(len(announced), 1, "budget announced exactly once")
        return announced[0], elapsed

    async def test_covered_tail_budget_covers_the_wall_time(self):
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            budget, elapsed = await self._measure(
                streamed_sec=90.0, covered_end=89.5,
            )
        self.assertGreaterEqual(budget, elapsed)

    async def test_empty_tail_budget_covers_the_wall_time(self):
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.02
        ):
            budget, elapsed = await self._measure(
                streamed_sec=90.0, covered_end=89.95,
            )
        self.assertGreaterEqual(budget, elapsed)

    async def test_uncovered_tail_budget_covers_the_wall_time_including_the_retry(self):
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            budget, elapsed = await self._measure(
                streamed_sec=90.0, covered_end=85.0, tail_speech_sec=4.0,
            )
        self.assertGreaterEqual(budget, elapsed)

    async def test_voiceless_uncovered_tail_budget_covers_the_wall_time(self):
        # (d) session f94121ae's shape: uncovered but unvoiced, so this
        # pays one ceiling and never the retry — the announced number
        # must still be an honest upper bound on
        # that shorter wait.
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            budget, elapsed = await self._measure(
                streamed_sec=52.99, covered_end=52.08, tail_speech_sec=0.05,
            )
        self.assertGreaterEqual(budget, elapsed)


class MultiFinalFlushTests(unittest.IsolatedAsyncioTestCase):
    """§A1: the flush wait ends on COVERAGE, not on the first arrival.

    Production 2026-09-03T21:42:09Z, session 62115e77. 14.26 s streamed,
    nothing finalized yet at Stop. 130 ms after ``Finalize`` the first
    final landed covering 0.00-10.85 s — the wait ended there, the
    envelope went out at ``finalize EXIT 405 ms``, and 2.7 s later
    Deepgram sent the rest of the same flush: ``10.85-14.26 'Напиши, на
    чем кто вас поверил.'``. The user lost a whole sentence to a wait
    that had a 3 s budget and spent 0.4 s of it.

    Wall-clock waits are scaled 1:10 against the real constants (0.30 s
    ceiling, second final at 0.27 s) so the suite does not sleep for
    three seconds; the audio times are the measured ones, and
    ``BudgetConstantTests`` pins that the real ceiling covers the real
    2.7 s.
    """

    FIRST_TEXT = "Слушай, я тебе скажу одну вещь."
    SECOND_TEXT = "Напиши, на чем кто вас поверил."

    def _evidence_session(self) -> DeepgramLiveSession:
        # streamed 14.26 s, not one final yet — the shape at Stop. Real
        # interims recognised words across the WHOLE recording (this is a
        # live dictation, not silence), so the speech span runs the full
        # 0.0-14.26 s — it must still show up as recognised evidence in
        # WHATEVER remains uncovered after the first final lands, or the
        # voiced-evidence rule (rule 1) has nothing to see for the second
        # final's own span (10.85-14.26) and the retry these tests exist
        # to verify would not fire.
        return _session(streamed_sec=14.26, covered_end=0.0, tail_speech_sec=14.26)

    async def _run_evidence_flush(self, session, second_final_delay: float):
        async def deliver():
            await asyncio.sleep(0.013)
            _deliver_final(session, 0.0, 10.85, self.FIRST_TEXT)
            await asyncio.sleep(second_final_delay - 0.013)
            _deliver_final(session, 10.85, 14.26, self.SECOND_TEXT)

        announced: list[float] = []
        task = asyncio.create_task(deliver())
        started = time.perf_counter()
        result = await session.drain_transcript(
            on_budget=lambda budget, _more: announced.append(budget)
        )
        elapsed = time.perf_counter() - started
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return result, elapsed, announced

    async def test_the_second_final_of_a_flush_reaches_the_envelope(self):
        session = self._evidence_session()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.30
        ):
            result, elapsed, _announced = await self._run_evidence_flush(
                session, second_final_delay=0.27
            )
        self.assertEqual(
            [seg["text"] for seg in result["segments"]],
            [self.FIRST_TEXT, self.SECOND_TEXT],
            "the sentence that arrived 2.7 s late must be in the envelope",
        )
        self.assertIn(self.SECOND_TEXT, result["text"])
        self.assertAlmostEqual(result["coveredEndSec"], 14.26, places=2)
        self.assertGreaterEqual(
            elapsed, 0.27, "the wait must have lasted until the second final"
        )
        self.assertLess(elapsed, 0.30 * 2, "and must not have paid the retry")

    async def test_the_wait_stays_inside_the_announced_budget(self):
        session = self._evidence_session()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.30
        ):
            _result, elapsed, announced = await self._run_evidence_flush(
                session, second_final_delay=0.27
            )
        self.assertEqual(len(announced), 1, "announced once, before the waiting")
        self.assertGreaterEqual(
            announced[0], elapsed,
            "the budget the renderer was told must still bound this side",
        )

    async def test_no_second_finalize_is_sent_while_the_flush_is_arriving(self):
        # Another Finalize buys nothing while Deepgram is mid-flush, and
        # a second one is what the tail guard is for.
        session = self._evidence_session()
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.30
        ):
            await self._run_evidence_flush(session, second_final_delay=0.27)
        self.assertEqual(ws.types.count("Finalize"), 1)

    async def test_a_single_covering_final_ends_the_wait_at_once(self):
        session = self._evidence_session()

        async def deliver():
            await asyncio.sleep(0.01)
            _deliver_final(session, 0.0, 14.26, "все одним финалом.")

        task = asyncio.create_task(deliver())
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 5.0
        ):
            result = await session.drain_transcript()
        elapsed = time.perf_counter() - started
        await task
        self.assertLess(elapsed, 1.0, f"a covering final waited {elapsed:.2f}s")
        self.assertEqual(len(result["segments"]), 1)

    async def test_an_exhausted_budget_falls_through_to_the_tail_guard_once(self):
        # The second final never comes. The budget is the budget: the
        # loop must stop at it and hand over to the existing tail guard,
        # which sends exactly one more Finalize.
        session = self._evidence_session()
        ws = session._ws

        async def deliver():
            await asyncio.sleep(0.01)
            _deliver_final(session, 0.0, 10.85, self.FIRST_TEXT)

        task = asyncio.create_task(deliver())
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.12
        ):
            await session.drain_transcript()
        elapsed = time.perf_counter() - started
        await task
        self.assertEqual(ws.types.count("Finalize"), 2, "tail guard retried once")
        self.assertGreaterEqual(elapsed, 0.24, "both windows were paid in full")
        self.assertLess(elapsed, 1.0)

    async def test_a_final_that_lands_during_the_measurement_is_not_lost(self):
        # The event is re-armed BEFORE coverage is re-measured, so a
        # final arriving in that window leaves the event set for the
        # next iteration instead of being erased by a later clear.
        session = self._evidence_session()

        async def deliver():
            await asyncio.sleep(0.01)
            _deliver_final(session, 0.0, 10.85, self.FIRST_TEXT)
            # Same tick as the first, i.e. inside the measurement.
            _deliver_final(session, 10.85, 14.26, self.SECOND_TEXT)

        task = asyncio.create_task(deliver())
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.30
        ):
            result = await session.drain_transcript()
        await task
        self.assertIn(self.SECOND_TEXT, result["text"])


class AwaitsMoreFinalsTests(unittest.TestCase):
    """The predicate that decides whether a flush is finished."""

    def test_an_uncovered_tail_with_evidence_in_it_is_still_owed_finals(self):
        # 3.41 s past the last final and an interim recognised words in
        # it: the flush has not reached the end of the streamed audio.
        session = _session(
            streamed_sec=14.26, covered_end=10.85, tail_speech_sec=3.41
        )
        _s, covered, gap, speech = session._tail_coverage()
        self.assertTrue(session._tail_awaits_more_finals(gap, speech, covered))

    def test_an_uncovered_but_silent_tail_after_a_closed_utterance_is_not(self):
        # The same 3.41 s with nothing recognised in it and a final that
        # said it closed the utterance. Waiting cannot produce words the
        # provider never decoded — this is audit §5's 83-of-84, and the
        # ground is the recovery pass's to re-decode, not the wait's.
        session = _session(streamed_sec=14.26, covered_end=10.85)
        _s, covered, gap, speech = session._tail_coverage()
        self.assertEqual(speech, 0.0)
        self.assertTrue(session._last_final_ended_the_utterance())
        self.assertFalse(session._tail_awaits_more_finals(gap, speech, covered))
        self.assertTrue(_recovers_tail(session, gap, speech, covered))

    def test_a_covered_tail_is_finished(self):
        session = _session(streamed_sec=14.26, covered_end=14.26)
        _s, covered, gap, speech = session._tail_coverage()
        self.assertFalse(session._tail_awaits_more_finals(gap, speech, covered))

    def test_a_forced_final_with_audio_past_it_is_still_owed(self):
        # speech_final=false is Deepgram saying "this final was pushed
        # out mid-utterance" — which is exactly what Finalize does — so
        # the continuation of that clause is still coming, even though
        # what is left has no voiced evidence of its own (rule 1/2 both
        # false — this is the OTHER reason the wait can still be owed).
        session = _session(streamed_sec=14.26, covered_end=13.86)
        session._finalized_segments = [
            {"start": 0.0, "end": 13.86, "text": "x", "speech_final": False}
        ]
        session._last_final_speech_final = False
        _s, covered, gap, speech = session._tail_coverage()
        self.assertGreater(gap, COVERAGE_GAP_MIN_SEC)
        self.assertFalse(session._tail_needs_flush(speech, covered))
        self.assertTrue(session._tail_awaits_more_finals(gap, speech, covered))

    def test_the_same_final_with_only_jitter_past_it_is_finished(self):
        # Otherwise every stop landing mid-utterance burns its whole
        # budget on a segment-boundary sliver.
        session = _session(streamed_sec=14.26, covered_end=14.16)
        session._finalized_segments = [
            {"start": 0.0, "end": 14.16, "text": "x", "speech_final": False}
        ]
        session._last_final_speech_final = False
        _s, covered, gap, speech = session._tail_coverage()
        self.assertLessEqual(gap, COVERAGE_GAP_MIN_SEC)
        self.assertFalse(session._tail_awaits_more_finals(gap, speech, covered))

    def test_a_speech_final_final_ends_the_wait_at_the_same_gap(self):
        session = _session(streamed_sec=14.26, covered_end=13.86)
        session._finalized_segments = [
            {"start": 0.0, "end": 13.86, "text": "x", "speech_final": True}
        ]
        session._last_final_speech_final = True
        _s, covered, gap, speech = session._tail_coverage()
        self.assertFalse(session._tail_awaits_more_finals(gap, speech, covered))

    def test_no_final_at_all_leaves_the_audio_to_decide(self):
        session = _session(streamed_sec=14.26, covered_end=0.0)
        self.assertTrue(session._last_final_ended_the_utterance())


class BudgetConstantTests(unittest.TestCase):
    def test_there_is_exactly_one_wait_ceiling(self):
        """The two shorter windows measured a bug in this file.

        ``FINALIZE_COVERED_WAIT_SEC`` (0.75 s) and
        ``FINALIZE_EMPTY_TAIL_WAIT_SEC`` (0.25 s) were sized on stops
        that "waited out their whole window and Deepgram sent nothing".
        Deepgram sent an empty final every time; it was dropped before
        the is_final branch (B-005). With the answer recorded, a
        shortened window can only truncate a flush that IS coming, which
        is exactly what cost a user the end of a sentence on 2026-08-25.
        """
        import backend.remote_deepgram_live as live

        self.assertFalse(hasattr(live, "FINALIZE_COVERED_WAIT_SEC"))
        self.assertFalse(hasattr(live, "FINALIZE_EMPTY_TAIL_WAIT_SEC"))

    def test_the_ceiling_covers_the_measured_round_trips(self):
        # 411 stops that received a post-Finalize transcript: median
        # 0.26 s, p95 0.49 s. The ceiling has to clear p95 with room, and
        # session 62115e77's second final arrived 2.7 s after the first,
        # so it must stay above that too.
        self.assertGreater(FINALIZE_FLUSH_WAIT_SEC, 0.49)
        self.assertGreater(FINALIZE_FLUSH_WAIT_SEC, 2.7)

    def test_the_speech_threshold_is_about_one_short_word(self):
        # session f94121ae: 0.05 s of recognised speech is decoder noise,
        # not a word — the threshold must sit above that floor. And it
        # must stay well under a real short word's worth of audio so
        # genuine speech in the tail is never mistaken for noise either.
        self.assertGreater(TAIL_GUARD_MIN_SPEECH_SEC, 0.05)
        self.assertLess(TAIL_GUARD_MIN_SPEECH_SEC, 0.5)


class EmptyFinalIsTheAnswerTests(unittest.IsolatedAsyncioTestCase):
    """B-005: an empty ``is_final`` is a protocol fact, not noise.

    ``_process_deepgram_message`` returned at ``if not text`` above the
    is_final branch, so Deepgram's normal answer to a Finalize with
    nothing buffered armed nothing, updated no coverage and ended no
    wait. Every one of the three wait budgets that used to live in
    ``remote_deepgram_live`` was sized around that missing answer.
    """

    def test_an_empty_final_arms_the_wait(self):
        session = _session(streamed_sec=10.0, covered_end=10.0)
        self.assertFalse(session._final_arrived.is_set())
        _deliver_empty_final(session, 10.0, 0.0)
        self.assertTrue(session._final_arrived.is_set())
        self.assertEqual(session.stats.empty_finals, 1)

    def test_an_empty_final_is_not_a_transcript_segment(self):
        """It carries no words, so it must not become one: a segment
        would extend ``durationSec`` and shadow real interim words."""
        session = _session(streamed_sec=10.0, covered_end=9.0)
        before = list(session._finalized_segments)
        _deliver_empty_final(session, 9.0, 1.0)
        self.assertEqual(session._finalized_segments, before)
        self.assertEqual(session.stats.segments_final, 0)

    def test_an_empty_final_covers_the_window_it_names(self):
        """Audio the decoder looked at and reported nothing in is
        covered — not an unflushed tail."""
        session = _session(streamed_sec=10.0, covered_end=9.0)
        _streamed, _covered, gap_before, _speech = session._tail_coverage()
        self.assertAlmostEqual(gap_before, 1.0, places=2)
        _deliver_empty_final(session, 9.0, 1.0)
        _streamed, covered, gap_after, _speech = session._tail_coverage()
        self.assertAlmostEqual(covered, 10.0, places=2)
        self.assertAlmostEqual(gap_after, 0.0, places=2)

    def test_an_empty_final_closes_the_utterance_it_says_it_closed(self):
        session = _session(streamed_sec=14.0, covered_end=13.0)
        session._last_final_speech_final = False
        self.assertFalse(session._last_final_ended_the_utterance())
        _deliver_empty_final(session, 13.0, 0.0, speech_final=True)
        self.assertTrue(session._last_final_ended_the_utterance())

    async def test_the_flush_wait_is_not_ended_by_a_stale_empty_final(self):
        """``_empty_final_arrived`` means "answered THIS flush".

        Deepgram sends empty finals for windows of silence while the user
        is still talking; one of those must not close a wait that has not
        been answered yet. The flag is cleared at the Finalize send, in
        front of it, so an answer in flight is still seen.
        """
        session = _session(streamed_sec=14.0, covered_end=10.0, tail_speech_sec=2.0)
        self.assertFalse(session._empty_final_arrived)
        _deliver_empty_final(session, 10.0, 0.0)   # mid-stream silence
        session._final_arrived.clear()
        ws = session._ws
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.12
        ):
            await session.drain_transcript()
        elapsed = time.perf_counter() - started
        self.assertGreaterEqual(
            elapsed, 0.12,
            "a mid-stream empty final must not answer the flush",
        )
        self.assertEqual(ws.types.count("Finalize"), 2, "the tail guard still retried")


class UnexplainedTailTests(unittest.TestCase):
    """B-007: what a silent provider looks like, and who answers it.

    The retry rule's docstring claimed rule 2 kept the 2026-08-24 loss
    from regressing. It does not — a provider that has gone quiet emits
    no interim, so its decode window never overhangs — and a
    reproduction of that exact shape returned ``False``. The ``tail_gap``
    argument the rule took and never read was the other half of the
    unfinished transition.

    The answer is split by cost. A second ``Finalize`` to a mute socket
    burns the ceiling (audit §5: 83 of 84 retries produced nothing), so
    the retry stays on evidence. Re-decoding the span from this
    backend's own spool returns the words for a bounded, announced
    budget, so the unexplained gap is the recovery's business.
    """

    # The 2026-08-24 production session, verbatim: 14.01 s streamed,
    # the last final ended at 10.00, no interim ever touched the tail,
    # and Deepgram had been silent for 3.7 s before Stop.
    EIGHT_24 = dict(streamed_sec=14.01, covered_end=10.00)

    def test_the_2026_08_24_shape_does_not_retry(self):
        session = _session(**self.EIGHT_24)
        _s, covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 4.01, places=2)
        self.assertEqual(speech, 0.0)
        self.assertFalse(session._tail_needs_flush(speech, covered))

    def test_the_2026_08_24_shape_is_recovered_instead(self):
        session = _session(**self.EIGHT_24)
        _s, covered, gap, speech = session._tail_coverage()
        self.assertTrue(
            _recovers_tail(session, gap, speech, covered),
            "the loss this rule exists for must be re-decodable",
        )

    def test_an_utterance_end_inside_the_tail_explains_the_silence(self):
        """The signal that tells a quiet user from a quiet provider.

        Deepgram owes an ``UtteranceEnd`` after ``utterance_end_ms`` of
        silence. One that arrived means the silence is announced, and
        ``confirmed_silence_gap`` shrinks the tail to it — so a user who
        finished a sentence and reached for the hotkey costs nothing.
        """
        session = _session(**self.EIGHT_24)
        session._last_utterance_end = 10.10
        _s, covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 0.10, places=2)
        self.assertFalse(_recovers_tail(session, gap, speech, covered))

    def test_the_f94121ae_shape_neither_retries_nor_recovers(self):
        # 0.91 s of audio past the last final, 0.05 s of it decoder
        # noise. This shape cost 6010 ms in production and audit §5 put
        # its hit rate at 1 in 84; it is below the utterance_end promise,
        # so nothing is unexplained about it either.
        session = _session(streamed_sec=52.99, covered_end=52.08, tail_speech_sec=0.05)
        _s, covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 0.91, places=2)
        self.assertFalse(session._tail_needs_flush(speech, covered))
        self.assertFalse(_recovers_tail(session, gap, speech, covered))

    def test_the_threshold_is_the_configured_utterance_end_promise(self):
        session = _session(streamed_sec=10.0, covered_end=0.0)
        promise = session.utterance_end_sec
        self.assertAlmostEqual(promise, 2.0, places=3)
        self.assertFalse(tail_needs_recovery(promise, 0.0, 0.0, 0.3, promise))
        self.assertTrue(tail_needs_recovery(promise + 0.01, 0.0, 0.0, 0.3, promise))

    def test_recovery_never_declines_a_tail_the_stop_waited_for(self):
        """The retry rule is a strict subset, by construction."""
        for speech, overhang in ((0.5, 0.0), (0.0, 1.0), (0.5, 1.0)):
            self.assertTrue(tail_needs_flush(speech, overhang, 0.3))
            self.assertTrue(tail_needs_recovery(0.0, speech, overhang, 0.3, 2.0))

    def test_a_confirmed_utterance_end_that_speech_outran_still_counts(self):
        # A later interim carrying words past the UtteranceEnd means the
        # utterance resumed: the whole gap stands.
        self.assertAlmostEqual(
            confirmed_silence_gap(10.0, 14.0, 10.5, [(11.0, 12.0)]), 4.0, places=3
        )
        self.assertAlmostEqual(
            confirmed_silence_gap(10.0, 14.0, 10.5, [(9.0, 10.2)]), 0.5, places=3
        )
        self.assertAlmostEqual(
            confirmed_silence_gap(10.0, 14.0, None, []), 4.0, places=3
        )



if __name__ == "__main__":
    unittest.main()
