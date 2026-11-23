"""``CloseStream`` must not race the transcript ``Finalize`` flushes.

Both frames used to be written in the same millisecond, so the stream
could be torn down before Deepgram returned the audio that Finalize had
just flushed. Measured across 14 sessions in one main.log: sessions whose
last segment arrived naturally (``speech_final=true``) left 0.25 s of
audio undecoded on average, while sessions still mid-utterance at Stop
(``speech_final=false``) left 1.86 s — the clause the user had just
spoken. That is the difference the user described between "it ended
exactly where I stopped" and "the last sentence is missing".

The stop now waits for the flushed transcript before closing,
bounded by ``FINALIZE_FLUSH_WAIT_SEC`` and short-circuited the moment it
arrives.
"""

from __future__ import annotations

import asyncio
import json
import time
import unittest
from unittest import mock

from backend.remote_deepgram_live import DeepgramLiveSession


class FakeUpstreamWs:
    """Records the frames finalize writes, with arrival order preserved."""

    def __init__(self):
        self.sent: list[str] = []

    async def send(self, payload):
        self.sent.append(json.loads(payload).get("type"))

    async def close(self):
        return None

    @property
    def types(self) -> list[str]:
        return list(self.sent)


def _session() -> DeepgramLiveSession:
    session = DeepgramLiveSession(api_key="k")
    session._ws = FakeUpstreamWs()
    # shutdown() drains background work it never started in this harness.
    session._keepalive_task = None
    session._recv_task = None
    return session


class FinalizeFlushOrderingTests(unittest.IsolatedAsyncioTestCase):
    async def test_close_stream_waits_for_the_flushed_transcript(self):
        session = _session()
        arrival: dict[str, float] = {}

        async def deliver_final_after(delay: float):
            await asyncio.sleep(delay)
            arrival["final"] = time.perf_counter()
            session._final_arrived.set()

        ws = session._ws  # shutdown() releases the reference on close
        started = time.perf_counter()
        task = asyncio.create_task(deliver_final_after(0.20))
        await session.drain_transcript()
        await session.shutdown(wait_timeout=0.5)
        await task

        self.assertIn("Finalize", ws.types)
        self.assertIn("CloseStream", ws.types)
        self.assertLess(
            ws.types.index("Finalize"),
            ws.types.index("CloseStream"),
            "Finalize must precede CloseStream",
        )
        # The close must land after the transcript, not race it.
        self.assertGreaterEqual(time.perf_counter() - started, 0.20)

    async def test_wait_short_circuits_when_the_transcript_lands_early(self):
        """A prompt Deepgram must not be made to pay the full ceiling."""
        session = _session()

        async def deliver_now():
            await asyncio.sleep(0.02)
            session._final_arrived.set()

        started = time.perf_counter()
        task = asyncio.create_task(deliver_now())
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 5.0
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        await task
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 1.0, f"finalize waited {elapsed:.2f}s despite an early final")

    async def test_silent_upstream_still_closes_within_the_ceiling(self):
        """No transcript ever arrives — the stream must still close."""
        session = _session()
        ws = session._ws  # shutdown() releases the reference on close
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.15
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertIn("CloseStream", ws.types)
        self.assertGreaterEqual(elapsed, 0.15)
        self.assertLess(elapsed, 2.0)

    async def test_a_stale_final_from_earlier_does_not_satisfy_the_wait(self):
        """The event is cleared before waiting, so a final that arrived
        mid-recording cannot be mistaken for the flushed one."""
        session = _session()
        session._final_arrived.set()  # as if a mid-stream final had landed
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.15
        ):
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.5)
        self.assertGreaterEqual(time.perf_counter() - started, 0.15)


class DrainTranscriptShutdownSplitTests(unittest.IsolatedAsyncioTestCase):
    """C4: the transcript-producing half and the socket-teardown half are
    two methods now, and the WS handler is meant to send the envelope
    between them. These tests pin the split itself, independent of the
    WS handler in backend/main.py.
    """

    async def test_drain_transcript_does_not_touch_the_socket_at_all(self):
        """CloseStream — and everything after it — is shutdown()'s job.

        A caller that only calls drain_transcript() must be able to
        build and send the envelope with the socket still fully alive;
        nothing about producing the transcript should have written to
        it beyond the Finalize frame itself.
        """
        session = _session()
        ws = session._ws
        assert ws is not None
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.02
        ):
            result = await session.drain_transcript()
        self.assertEqual(ws.types, ["Finalize"], "CloseStream must not be sent yet")
        self.assertFalse(session.is_closed, "the session must still be usable")
        self.assertIn("streamedSec", result)
        self.assertIn("coveredEndSec", result)

        await session.shutdown(wait_timeout=0.3)
        self.assertIn("CloseStream", ws.types)
        self.assertTrue(session.is_closed)

    async def test_a_wedged_upstream_does_not_delay_the_envelope(self):
        """The whole point of the split (audit §2.4): a socket that never
        closes must not hold up the transcript. drain_transcript() must
        return within the flush budget, not the much larger
        ``wait_timeout`` that only bounds shutdown()'s recv drain.
        """
        session = _session()
        # A recv loop stuck forever — e.g. Deepgram accepted CloseStream
        # but never actually closed the TCP connection.
        session._recv_task = asyncio.create_task(asyncio.sleep(999))
        try:
            started = time.perf_counter()
            with mock.patch(
                "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
            ):
                await session.drain_transcript()
            elapsed = time.perf_counter() - started
            # Well under the 3s wait_timeout a stuck recv task would cost
            # if drain_transcript() waited on it.
            self.assertLess(elapsed, 0.5, f"envelope delayed by {elapsed:.2f}s")

            # shutdown() still resolves, bounded by its own wait_timeout,
            # by cancelling the stuck task rather than hanging forever.
            shutdown_started = time.perf_counter()
            await session.shutdown(wait_timeout=0.2)
            shutdown_elapsed = time.perf_counter() - shutdown_started
            self.assertLess(shutdown_elapsed, 1.0)
            self.assertTrue(session._recv_task.cancelled() or session._recv_task.done())
        finally:
            if not session._recv_task.done():
                session._recv_task.cancel()

    async def test_shutdown_awaits_a_real_recv_drain(self):
        """All three existing finalize test files set ``_recv_task =
        None`` — this exercises the drain for real: a background task
        that is still finishing up (simulating in-flight Deepgram
        messages still being processed) must be awaited, not skipped,
        and shutdown() must not return before it completes.
        """
        session = _session()
        drained_at: dict[str, float] = {}

        async def real_recv_drain():
            await asyncio.sleep(0.08)
            drained_at["t"] = time.perf_counter()

        session._recv_task = asyncio.create_task(real_recv_drain())
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.02
        ):
            await session.drain_transcript()
        await session.shutdown(wait_timeout=1.0)
        shutdown_returned_at = time.perf_counter()
        self.assertIn("t", drained_at, "recv task must have been awaited to completion")
        # shutdown() must not return before the drain it awaited finished.
        self.assertGreaterEqual(shutdown_returned_at, drained_at["t"])
        self.assertTrue(session._recv_task.done())
        self.assertFalse(session._recv_task.cancelled())


if __name__ == "__main__":
    unittest.main()
