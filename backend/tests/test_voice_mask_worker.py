"""The gate on a thread still hands over the same bytes in the same order.

The gate itself is pinned in ``test_voice_mask``: one window held, one hop
released, the byte count never moving. What is pinned here is the seam the
call site adds — a thread boundary in the middle of a recording, a submit
that must never wait for a model, and the one flush that stands between
the last two seconds of a recording and the ``Finalize`` frame.

The scorer in every test below is a stub: a fixed verdict, or one that
sleeps. Nothing here needs a net, and nothing here is about accuracy.
"""

from __future__ import annotations

import asyncio
import array
import threading
import time
import unittest

from backend.audio_constants import LIVE_PCM_BYTES_PER_SEC
from backend.voice_mask import DEFAULT_HOP_MS, VoiceMask
from backend.voice_mask_worker import MaskWorker

HOP_BYTES = DEFAULT_HOP_MS * LIVE_PCM_BYTES_PER_SEC // 1000


def counting_pcm(ms: int, rate_hz: int = 16_000) -> bytes:
    """PCM16LE whose every sample differs from its neighbours.

    Order is the thing most easily broken by a thread boundary and the
    least visible in repeated content: a repeated tone compares equal
    after a swap, this does not. Values stay under the voice peak so a
    voicing test could still tell speech from it.
    """
    n = ms * rate_hz // 1000
    samples = array.array("h", [(i % 300) + 1 for i in range(n)])
    return samples.tobytes()


def hops(data: bytes, size: int = HOP_BYTES):
    for start in range(0, len(data), size):
        yield data[start : start + size]


def keep_everything(window: bytes):
    return 1.0


def refuse_everything(window: bytes):
    return 0.0


def slow_verdict(delay_sec: float):
    def score(window: bytes):
        time.sleep(delay_sec)
        return 1.0

    return score


class MaskWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def _drain(self, worker: MaskWorker, chunks) -> bytes:
        for chunk in chunks:
            worker.submit(chunk)
        await worker.close()
        return b"".join(self.sent)

    def setUp(self) -> None:
        self.sent: list = []

    def _emit(self, data: bytes) -> None:
        self.sent.append(data)

    async def test_the_bytes_leave_whole_and_in_order(self):
        # §4.2 and §6.3 on the seam: a thread between the receiver and the
        # queue is only allowed to change content, never length or order.
        # The counting samples make a swap visible; a tone would not.
        data = counting_pcm(4000)
        worker = MaskWorker(VoiceMask(keep_everything), self._emit)
        out = await self._drain(worker, hops(data))
        self.assertEqual(out, data)

    async def test_a_refused_recording_is_the_same_length_and_all_zeros(self):
        # The mask zeroes a window in the forwarded copy; the byte count
        # stands, because the sender's grid and every offset Deepgram
        # reports are measured on this stream (§4.2).
        data = counting_pcm(4000)
        worker = MaskWorker(VoiceMask(refuse_everything), self._emit)
        out = await self._drain(worker, hops(data))
        self.assertEqual(len(out), len(data))
        self.assertEqual(out, bytes(len(data)))

    async def test_close_flushes_the_window_the_gate_is_still_holding(self):
        # §7.3's other half. The gate holds one window, so at the stop the
        # last two seconds are still inside it — and a recording shorter
        # than a window is held whole. Without this flush the first (and,
        # for a short take, only) second of a recording never leaves, which
        # is a cut in another costume.
        data = counting_pcm(1000)
        worker = MaskWorker(VoiceMask(refuse_everything), self._emit)
        out = await self._drain(worker, hops(data))
        self.assertEqual(out, data)
        self.assertFalse(worker.mask.judged)

    async def test_nothing_reaches_the_caller_from_the_worker_thread(self):
        # ``emit`` is the receiver's ``_offer_pcm``, which touches an
        # asyncio.Queue and the session: loop thread or nothing.
        here = threading.get_ident()
        seen: list = []

        def emit(data: bytes) -> None:
            seen.append(threading.get_ident())

        worker = MaskWorker(VoiceMask(keep_everything), emit)
        for chunk in hops(counting_pcm(3000)):
            worker.submit(chunk)
        await worker.close()
        self.assertTrue(seen)
        self.assertEqual(set(seen), {here})

    async def test_submit_does_not_wait_for_a_judgement(self):
        # The whole reason the gate is not inline: one judgement is half a
        # hop's budget, so a submit that waited on one would put the model
        # straight back into the receive loop (§3.2).
        worker = MaskWorker(VoiceMask(slow_verdict(0.4)), self._emit)
        started = time.monotonic()
        for chunk in hops(counting_pcm(2000)):
            worker.submit(chunk)
        elapsed = time.monotonic() - started
        await worker.close()
        # Twelve judgements of 0.4 s each cannot have happened inside a
        # loop that returned in a fraction of one.
        self.assertLess(elapsed, 0.4)

    async def test_a_gate_that_falls_behind_stops_masking_and_never_drops(self):
        # The fallback is a leak, never a cut or a drop (§4.4, §6.3): the
        # backlog still leaves, in order, and the bytes after it leave
        # untouched rather than waiting for a model that cannot keep up.
        data = counting_pcm(4000)
        worker = MaskWorker(
            VoiceMask(slow_verdict(0.2)),
            self._emit,
            max_pending_bytes=4 * HOP_BYTES,
        )
        out = await self._drain(worker, hops(data))
        self.assertTrue(worker.degraded)
        self.assertEqual(len(out), len(data))
        # Everything after the degrade point is forwarded verbatim.
        self.assertEqual(out[-20 * HOP_BYTES :], data[-20 * HOP_BYTES :])

    async def test_a_byte_that_arrives_after_the_flush_still_leaves(self):
        # The receiver is cancelled before the worker closes, so this
        # cannot happen on the normal path — but a byte that vanished
        # would be a dropped byte, which is never the answer (§6.3).
        data = counting_pcm(200)
        worker = MaskWorker(VoiceMask(keep_everything), self._emit)
        await worker.close()
        worker.submit(data)
        self.assertEqual(b"".join(self.sent), data)

    async def test_a_closed_worker_does_not_need_a_second_close(self):
        # The teardown path can run twice (a connect failure then the
        # finally): the second close must be a no-op, not a duplicated
        # flush or a hang on a thread that is already gone.
        data = counting_pcm(1000)
        worker = MaskWorker(VoiceMask(keep_everything), self._emit)
        for chunk in hops(data):
            worker.submit(chunk)
        await worker.close()
        await worker.close()
        self.assertEqual(b"".join(self.sent), data)


class MaskStateReportTests(unittest.IsolatedAsyncioTestCase):
    """§5.3: a refusal is drawn, and §5.4 says what the line is worth.

    The gate zeroes audio the provider never sees, which in the pane is
    indistinguishable from a transcript that lost it. These tests pin the
    three things that make the difference *drawn* rather than inferred:
    a report says how much, it is a line and not a stream, and the last
    one is the recording's total.
    """

    def setUp(self) -> None:
        self.sent: list = []
        self.reports: list = []

    def _emit(self, data: bytes) -> None:
        self.sent.append(data)

    def _report(self, snapshot) -> None:
        self.reports.append((threading.get_ident(), snapshot))

    async def _play(self, worker: MaskWorker, ms: int) -> None:
        for chunk in hops(counting_pcm(ms)):
            worker.submit(chunk)
        await worker.close()

    async def _play_paced(self, worker: MaskWorker, ms: int, slice_ms: int = 100) -> None:
        """Submit at roughly the rate a microphone produces it.

        The unpaced helper below hands ten seconds over in one burst, and
        the loop never gets to run a scheduled report between them — which
        is the right behaviour (a report is a level, see the coalescing
        test) but makes it impossible to observe the pacing.
        """
        data = counting_pcm(ms)
        step = slice_ms * 16 * 2
        for start in range(0, len(data), step):
            worker.submit(data[start : start + step])
            await asyncio.sleep(0.004)
        await worker.close()

    async def test_a_refusal_says_how_much_it_withheld(self):
        worker = MaskWorker(
            VoiceMask(refuse_everything), self._emit, on_state=self._report
        )
        await self._play(worker, 4000)
        final = [s for _, s in self.reports if s.final]
        self.assertEqual(len(final), 1, "the recording gets exactly one total")
        self.assertEqual(final[0].state, "closed")
        # All four seconds: nothing this gate held was ever sent. The
        # held window leaves as zeros on the flush, so it is withheld in
        # the sense that matters — the provider read none of it (§1.4).
        self.assertAlmostEqual(final[0].withheld_sec, 4.0, places=2)

    async def test_the_final_report_is_the_last_word(self):
        # A report queued before the flush describes a moment before the
        # flush. Arriving after the total it would leave the pane saying
        # "is being withheld" over a recording that already stopped.
        worker = MaskWorker(
            VoiceMask(refuse_everything), self._emit, on_state=self._report
        )
        await self._play(worker, 4000)
        self.assertTrue(self.reports[-1][1].final)
        self.assertEqual(
            [s.final for _, s in self.reports].count(True), 1
        )

    async def test_the_report_is_a_line_not_a_stream(self):
        # One hop is 50 ms and a judgement at most one per hop: reporting
        # every one would be 20 messages a second about the gate's
        # internals. A second's worth of refused audio is the resolution
        # the counter needs, so 10 s of refusal paced like a microphone
        # is ~10 reports, not 200.
        worker = MaskWorker(
            VoiceMask(refuse_everything), self._emit, on_state=self._report
        )
        await self._play_paced(worker, 10_000)
        self.assertLessEqual(len(self.reports), 15)
        self.assertGreaterEqual(len(self.reports), 5)
        withheld = [s.withheld_sec for _, s in self.reports if not s.final]
        self.assertEqual(withheld, sorted(withheld), "a total never goes down")

    async def test_a_burst_of_audio_coalesces_into_one_report(self):
        # A report is a level, not an event: ten seconds handed over
        # faster than the model judges them is still one line of state
        # with the newest number, never ten frames queued behind the
        # socket.
        worker = MaskWorker(
            VoiceMask(refuse_everything), self._emit, on_state=self._report
        )
        await self._play(worker, 10_000)
        self.assertLessEqual(len(self.reports), 2)

    async def test_the_report_crosses_the_thread_before_it_is_read(self):
        # The pane is main-thread state, like ``emit``: a report called on
        # the worker thread would race the renderer's own writes.
        worker = MaskWorker(
            VoiceMask(refuse_everything), self._emit, on_state=self._report
        )
        await self._play(worker, 3000)
        self.assertTrue(self.reports)
        self.assertEqual({tid for tid, _ in self.reports}, {threading.get_ident()})

    async def test_an_owner_only_recording_reports_an_open_gate_and_nothing_withheld(self):
        # The other half of the line: "on and sending everything" must be
        # as sayable as "on and holding something back", or the pane can
        # only describe a recording that went wrong.
        worker = MaskWorker(
            VoiceMask(keep_everything), self._emit, on_state=self._report
        )
        await self._play(worker, 3000)
        final = self.reports[-1][1]
        self.assertEqual(final.state, "open")
        self.assertEqual(final.withheld_sec, 0.0)

    async def test_a_gate_that_gave_up_says_so(self):
        # A degrade forwards audio UNJUDGED. That is not a refusal, and a
        # silent one would be worse than the leak itself: the user has to
        # know the mask stopped masking (§5.3).
        worker = MaskWorker(
            VoiceMask(slow_verdict(0.2)),
            self._emit,
            max_pending_bytes=4 * HOP_BYTES,
            on_state=self._report,
        )
        await self._play(worker, 2000)
        self.assertTrue(worker.degraded)
        self.assertTrue(self.reports[-1][1].degraded)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
