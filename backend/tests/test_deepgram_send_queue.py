"""The send path never lets Deepgram stall the renderer's socket (§3.6).

Measured failure, 2026-09-02 00:40: ``await session.send_pcm(data)`` sat
in the middle of the loop that reads the renderer's WebSocket, so a
wedged upstream stopped the app reading its own socket for the whole 5 s
send timeout — four times in one recording, 20 s in which no frame was
read and the user's ``finalize`` waited behind hundreds of binary
frames. Two of those sessions ended fatally. The timeout was also the
likely cause of the runs: ``asyncio.wait_for`` cancels ``ws.send``
mid-frame, which ``websockets`` documents as leaving the connection
undefined.

What is pinned here:

* the receiver keeps reading while the upstream refuses every write;
* ``Finalize`` is applied only after the queued audio has reached
  Deepgram — by construction, because it rides the same queue;
* a wedged upstream is detected by the AGE of unsent audio, reported
  fatally through the session, and answered by closing the socket
  (never by cancelling a write).
"""

from __future__ import annotations

import asyncio
import io
import json
import unittest
from unittest import mock

from backend.tests.test_live import IsolatedBackendMainImportMixin


class _FakeWebSocket:
    """The renderer side: a queue of ASGI messages and captured sends."""

    def __init__(self):
        self.messages: "asyncio.Queue[dict]" = asyncio.Queue()
        self.sent: list[dict] = []

    async def receive(self):
        return await self.messages.get()

    async def send_text(self, text):
        self.sent.append(json.loads(text))


class _FakeStats:
    def __init__(self):
        self.bytes_sent = 0
        self.bytes_offered = 0
        self.chunks_sent = 0
        self.segments_final = 1
        self.segments_interim = 0
        self.connect_ms = 1.0
        self.finalize_ms = 1.0

    def as_dict(self):
        return {}


class _FakeUpstream:
    """A Deepgram session whose writes can be held open indefinitely.

    ``block.set()`` is what a healthy socket does immediately; leaving it
    clear is a wedged one. ``send_pcm`` deliberately does NOT time out —
    the production one does not either any more.
    """

    instances: list["_FakeUpstream"] = []

    def __init__(self, *_a, **_kw):
        self.stats = _FakeStats()
        self.block = asyncio.Event()
        self.block.set()
        self.sent_pcm: list[bytes] = []
        self.fatal_reports: list[str] = []
        self.undelivered = 0
        self.bytes_at_drain: int | None = None
        self._closed = False
        self.last_error = None
        self.last_fatal = False
        self._events: "asyncio.Queue[dict]" = asyncio.Queue()
        _FakeUpstream.instances.append(self)

    async def connect(self):
        return None

    async def send_pcm(self, chunk):
        await self.block.wait()
        if self._closed:
            return
        self.sent_pcm.append(chunk)
        self.stats.bytes_sent += len(chunk)
        self.stats.bytes_offered += len(chunk)

    def note_undelivered_audio(self, nbytes):
        self.undelivered += nbytes
        self.stats.bytes_offered += nbytes

    def report_fatal(self, message):
        self.fatal_reports.append(message)
        self.last_error = message
        self.last_fatal = True
        self._closed = True
        self._events.put_nowait({"type": "error", "error": message, "fatal": True})

    async def events(self):
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def drain_transcript(self, on_budget=None):
        self.bytes_at_drain = sum(len(c) for c in self.sent_pcm)
        return {
            "text": "ok", "segments": [], "durationSec": 0.0, "stats": {},
            "uncoveredSpeechSec": 0.0, "streamedSec": 0.0, "coveredEndSec": 0.0,
        }

    async def shutdown(self, wait_timeout=3.0):
        await self.close()

    async def close(self):
        self._closed = True
        self.block.set()
        self._events.put_nowait(None)

    @property
    def is_closed(self):
        return self._closed


def _recovery() -> dict:
    return {"pcm_file": io.BytesIO(), "bytes": 0, "chunks": 0, "had_error": False}


class SendQueueTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        _FakeUpstream.instances.clear()

    def _run(self, ws, recovery):
        return asyncio.create_task(
            self.main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            )
        )

    async def test_receiver_keeps_reading_while_the_upstream_refuses_writes(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            upstream = _FakeUpstream.instances[0]
            upstream.block.clear()  # every write from here on hangs

            frames = [bytes([i]) * 400 for i in range(1, 21)]
            for frame in frames:
                await ws.messages.put({"type": "websocket.receive", "bytes": frame})
            await asyncio.sleep(0.05)

            # The renderer's socket was drained even though not one byte
            # could be written upstream: every frame is in the recovery
            # spool and nothing is left queued on the WebSocket.
            self.assertEqual(recovery["chunks"], len(frames))
            self.assertEqual(recovery["pcm_file"].getvalue(), b"".join(frames))
            self.assertTrue(ws.messages.empty())

            upstream.block.set()
            await ws.messages.put(
                {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
            )
            await asyncio.wait_for(task, timeout=5.0)

    async def test_finalize_is_applied_after_the_queued_audio(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            upstream = _FakeUpstream.instances[0]
            upstream.block.clear()

            frames = [bytes([i]) * 700 for i in range(1, 11)]
            for frame in frames:
                await ws.messages.put({"type": "websocket.receive", "bytes": frame})
            await asyncio.sleep(0.02)
            await ws.messages.put(
                {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
            )
            # Stop is in flight while the upstream is still refusing
            # writes; only now does it start accepting.
            await asyncio.sleep(0.02)
            self.assertIsNone(upstream.bytes_at_drain)
            upstream.block.set()

            await asyncio.wait_for(task, timeout=5.0)

        total = sum(len(f) for f in frames)
        self.assertEqual(
            upstream.bytes_at_drain, total,
            "Finalize ran before all queued audio reached Deepgram",
        )
        self.assertEqual(b"".join(upstream.sent_pcm), b"".join(frames))
        # Batched into ~50 ms writes rather than one write per frame.
        self.assertLess(len(upstream.sent_pcm), len(frames))

    async def test_a_wedged_upstream_is_detected_and_reported(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream), \
                mock.patch.object(self.main, "_SEND_WEDGE_TIMEOUT_SEC", 0.2), \
                mock.patch.object(self.main, "_SEND_WEDGE_POLL_SEC", 0.02), \
                mock.patch.object(self.main, "_SEND_FLUSH_DEADLINE_SEC", 1.0):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            upstream = _FakeUpstream.instances[0]
            upstream.block.clear()

            for i in range(1, 6):
                await ws.messages.put(
                    {"type": "websocket.receive", "bytes": bytes([i]) * 800}
                )
            # The wedge is reported, but it does NOT end the recording:
            # the user is still talking (BW-01).
            for _ in range(100):
                if upstream.fatal_reports:
                    break
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.05)
            self.assertFalse(task.done(), "a fatal upstream ended the recording")
            self.assertFalse(
                [m for m in ws.sent if m.get("type") == "final"],
                "final was sent while the microphone was still open",
            )
            # Speech after the upstream died still reaches the spool.
            await ws.messages.put({"type": "websocket.receive", "bytes": b"\x09" * 800})
            await ws.messages.put(
                {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
            )
            await asyncio.wait_for(task, timeout=5.0)
        self.assertEqual(recovery["bytes"], 6 * 800)
        self.assertEqual(ws.sent[-1]["type"], "final")

        self.assertTrue(
            upstream.fatal_reports,
            "a wedged upstream must be reported through the session",
        )
        self.assertIn("wedged", upstream.fatal_reports[0])
        self.assertTrue(upstream.is_closed)
        errors = [m for m in ws.sent if m.get("type") == "error"]
        self.assertTrue(errors, f"no error envelope reached the renderer: {ws.sent}")
        self.assertTrue(errors[0]["fatal"])
        self.assertTrue(recovery["had_error"])

    async def test_dropped_audio_is_still_counted_as_offered(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream), \
                mock.patch.object(self.main, "_SEND_QUEUE_MAX_BYTES", 2000), \
                mock.patch.object(self.main, "_SEND_WEDGE_TIMEOUT_SEC", 0.3), \
                mock.patch.object(self.main, "_SEND_WEDGE_POLL_SEC", 0.02), \
                mock.patch.object(self.main, "_SEND_FLUSH_DEADLINE_SEC", 1.0):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            upstream = _FakeUpstream.instances[0]
            upstream.block.clear()

            for i in range(1, 11):
                await ws.messages.put(
                    {"type": "websocket.receive", "bytes": bytes([i]) * 500}
                )
            for _ in range(100):
                if upstream.fatal_reports:
                    break
                await asyncio.sleep(0.02)
            await ws.messages.put(
                {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
            )
            await asyncio.wait_for(task, timeout=5.0)

        # 5000 bytes captured, at most 2000 could be queued: the rest is
        # declared undelivered so the coverage math still sees the whole
        # recording (B1 / _tail_coverage).
        self.assertGreater(upstream.undelivered, 0)
        self.assertEqual(recovery["bytes"], 5000)


class _BrokenSender(_FakeUpstream):
    """An upstream whose write raises something no handler expected."""

    async def send_pcm(self, chunk):
        raise RuntimeError("bug in the send path")


class _SlowAnnouncementSocket(_FakeWebSocket):
    """A renderer socket that is slow to accept ``finalizing`` frames."""

    async def send_text(self, text):
        if json.loads(text).get("type") == "finalizing":
            await asyncio.sleep(0.1)
        await super().send_text(text)


class StopPathTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    """BW-06 / BW-10 / BW-11 / BW-12."""

    def setUp(self):
        super().setUp()
        _FakeUpstream.instances.clear()

    def _run(self, ws, recovery):
        return asyncio.create_task(
            self.main._run_deepgram_live_session(
                websocket=ws, api_key="dg", model="nova-3", language="auto",
                diarize=False, recovery=recovery,
            )
        )

    async def test_a_failing_sender_is_reported_as_the_upstream_dying(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _BrokenSender):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            await ws.messages.put({"type": "websocket.receive", "bytes": b"\x01" * 3200})
            await asyncio.sleep(0.2)
            upstream = _FakeUpstream.instances[0]
            await ws.messages.put(
                {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
            )
            await asyncio.wait_for(task, timeout=5.0)
        self.assertTrue(upstream.fatal_reports, "the sender died silently")
        self.assertIn("sender failed", upstream.fatal_reports[0])
        self.assertTrue(recovery["had_error"])
        self.assertIn("sender failed", ws.sent[-1]["error"])

    async def test_a_client_gone_before_finalize_gets_no_paid_recovery(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        recover = mock.AsyncMock(side_effect=lambda **kw: kw["payload"])
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream), \
                mock.patch.object(self.main, "_apply_live_recovery", recover):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            await ws.messages.put({"type": "websocket.receive", "bytes": b"\x01" * 3200})
            await ws.messages.put({"type": "websocket.disconnect"})
            await asyncio.wait_for(task, timeout=5.0)
        recover.assert_not_called()
        self.assertFalse([m for m in ws.sent if m.get("type") == "final"])
        self.assertTrue(recovery["had_error"], "the spool must be kept for the renderer")

    async def test_every_finalizing_announcement_precedes_the_final(self):
        ws = _SlowAnnouncementSocket()
        recovery = _recovery()

        original = _FakeUpstream.drain_transcript

        async def drain(self_, on_budget=None):
            on_budget(1.0, True)
            return await original(self_)

        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream), \
                mock.patch.object(_FakeUpstream, "drain_transcript", drain):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            await ws.messages.put(
                {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
            )
            await asyncio.wait_for(task, timeout=5.0)
        kinds = [m["type"] for m in ws.sent]
        self.assertIn("finalizing", kinds)
        self.assertEqual(kinds[-1], "final", kinds)

    async def test_a_failing_preconnect_reader_is_logged(self):
        from backend.remote_deepgram_live import DeepgramLiveError

        class _Refused(_FakeUpstream):
            async def connect(self):
                await asyncio.sleep(0.05)
                raise DeepgramLiveError("refused")

        class _BrokenSocket(_FakeWebSocket):
            async def receive(self):
                raise RuntimeError("renderer socket broke")

        ws = _BrokenSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _Refused), \
                self.assertLogs("backend.main", level="WARNING") as logs:
            await asyncio.wait_for(self._run(ws, recovery), timeout=5.0)
        self.assertTrue(
            any("pre-connect reader failed" in line for line in logs.output), logs.output
        )


class OwnershipBeforeTheMainTryTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    """BW-15: a cancellation between the primary's acquire and the main
    ``try`` left the billed primary socket open and the second reading's
    acquire running."""

    async def test_a_cancel_while_the_second_reading_connects_releases_everything(self):
        primary = _FakeUpstream()
        primary_discarded = asyncio.Event()

        async def discard():
            primary_discarded.set()

        primary.discard = discard
        second_started = asyncio.Event()
        second_cancelled = asyncio.Event()

        async def acquire(api_key, cfg):
            if cfg.language == "ru":
                second_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    second_cancelled.set()
                    raise
            return mock.Mock(session=primary, adopted=False)

        ws = _FakeWebSocket()
        with mock.patch.object(self.main.DEEPGRAM_WARM_POOL, "acquire", acquire):
            task = asyncio.create_task(
                self.main._run_deepgram_live_session(
                    websocket=ws, api_key="dg", model="nova-3", language="auto",
                    diarize=False, recovery=_recovery(), dual_language="ru",
                )
            )
            await asyncio.wait_for(second_started.wait(), timeout=2.0)
            await asyncio.sleep(0.02)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=2.0)
        self.assertTrue(primary_discarded.is_set(), "the primary upstream was left open")
        self.assertTrue(second_cancelled.is_set(), "the second reading's acquire kept running")


if __name__ == "__main__":
    unittest.main()
