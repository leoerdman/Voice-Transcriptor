"""Ending things: cancellation, control frames, and the stop's ordering.

Three defect shapes that all live in teardown code, where nothing is
observed unless it is asserted:

* ``except (asyncio.CancelledError, Exception): pass`` — thirteen sites
  that named cancellation deliberately (it is a ``BaseException``, so a
  bare ``except Exception`` would not catch it) and then discarded it,
  along with every real failure inside the task;
* ``asyncio.wait_for`` around ``ws.send`` for the three CONTROL frames,
  after the same module had documented cancelling a ``websockets`` send
  mid-frame as the cause of a run of production hangs and removed it
  from the audio path;
* a second reading cancelled and never awaited, and a warm-socket swap
  allowed to run alongside the finalize it is about to pull the socket
  out from under.
"""

from __future__ import annotations

import asyncio
import json
import unittest

from backend.async_tasks import await_cancelled, cancel_and_await
from backend.remote_deepgram_live import (
    SEND_WEDGE_SEC,
    DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC,
    DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC,
    DeepgramLiveSession,
)


class AwaitCancelledTests(unittest.IsolatedAsyncioTestCase):
    """The cancellation of the TASK is expected; ours is not."""

    async def test_the_cancellation_of_the_awaited_task_is_absorbed(self):
        async def forever():
            await asyncio.sleep(3600)

        task = asyncio.get_running_loop().create_task(forever())
        await asyncio.sleep(0)
        task.cancel()
        await await_cancelled(task, what="test task")  # must not raise

    async def test_our_own_cancellation_propagates(self):
        # The five sites in the WebSocket handler's finally block: a
        # handler cancelled by uvicorn's shutdown used to carry on to
        # the end as if nothing had happened, while the lifespan's
        # one-second budget for releasing sockets ran out around it.
        started = asyncio.Event()
        released = asyncio.Event()
        outcome: list[str] = []

        async def slow():
            try:
                await released.wait()
            except asyncio.CancelledError:
                raise

        async def waiter():
            task = asyncio.get_running_loop().create_task(slow())
            await asyncio.sleep(0)
            started.set()
            try:
                await await_cancelled(task, what="slow task")
                outcome.append("swallowed")
            except asyncio.CancelledError:
                outcome.append("propagated")
                raise

        outer = asyncio.get_running_loop().create_task(waiter())
        await started.wait()
        outer.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await outer
        self.assertEqual(outcome, ["propagated"])

    async def test_a_failure_inside_the_task_is_logged_not_dropped(self):
        async def boom():
            raise RuntimeError("socket would not close")

        task = asyncio.get_running_loop().create_task(boom())
        with self.assertLogs("backend.async_tasks", level="WARNING") as logs:
            await await_cancelled(task, what="deepgram sender")
        self.assertIn("deepgram sender ended with an error", logs.output[0])
        self.assertIn("socket would not close", logs.output[0])

    async def test_cancel_and_await_leaves_a_finished_task_alone(self):
        async def quick():
            return 7

        task = asyncio.get_running_loop().create_task(quick())
        await task
        await cancel_and_await(task, what="quick")
        self.assertEqual(task.result(), 7)

    async def test_cancel_and_await_accepts_no_task_at_all(self):
        await cancel_and_await(None, what="nothing")


class _ControlFrameSocket:
    """A websocket whose send can be made to hang until it is closed."""

    def __init__(self, *, wedge: bool = False) -> None:
        self.frames: list[dict] = []
        self.closed = False
        self.wedge = wedge
        self.send_raised: list[str] = []
        self.send_started = asyncio.Event()

    async def send(self, payload):
        self.send_started.set()
        if not self.wedge:
            self.frames.append(json.loads(payload))
            return
        try:
            while not self.closed:
                await asyncio.sleep(0.005)
        except asyncio.CancelledError:
            # If this ever runs, the write was cancelled mid-frame —
            # exactly what send_pcm's docstring forbids.
            self.send_raised.append("cancelled")
            raise
        self.send_raised.append("closed")
        raise ConnectionError("socket closed under a pending write")

    async def close(self):
        self.closed = True


def _session_with(ws) -> DeepgramLiveSession:
    session = DeepgramLiveSession(api_key="k")
    session._ws = ws  # type: ignore[assignment]
    return session


class ControlFrameSendTests(unittest.IsolatedAsyncioTestCase):
    """A control frame's write is bounded by closing, never by cancelling."""

    async def test_a_healthy_frame_reaches_the_wire(self):
        ws = _ControlFrameSocket()
        session = _session_with(ws)
        self.assertTrue(
            await session._send_control({"type": "Finalize"}, what="Finalize")
        )
        self.assertEqual(ws.frames, [{"type": "Finalize"}])

    async def test_a_wedged_write_is_released_by_closing_the_socket(self):
        ws = _ControlFrameSocket(wedge=True)
        session = _session_with(ws)
        from unittest import mock

        with mock.patch(
            "backend.remote_deepgram_live.SEND_WEDGE_SEC", 0.02
        ), self.assertLogs("backend.remote_deepgram_live", level="WARNING") as logs:
            sent = await session._send_control(
                {"type": "Finalize"}, what="Finalize"
            )
        self.assertFalse(sent)
        self.assertTrue(ws.closed, "the wedged socket was not closed")
        self.assertEqual(
            ws.send_raised,
            ["closed"],
            "the write was cancelled mid-frame instead of released by a close",
        )
        self.assertTrue(any("send wedged" in line for line in logs.output))

    async def test_our_own_cancellation_still_never_cancels_the_write(self):
        ws = _ControlFrameSocket(wedge=True)
        session = _session_with(ws)

        async def caller():
            await session._send_control({"type": "CloseStream"}, what="CloseStream")

        task = asyncio.get_running_loop().create_task(caller())
        await ws.send_started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(ws.closed)
        self.assertEqual(ws.send_raised, ["closed"])

    async def test_a_session_with_no_socket_reports_nothing_sent(self):
        session = DeepgramLiveSession(api_key="k")
        self.assertFalse(
            await session._send_control({"type": "Finalize"}, what="Finalize")
        )


class _UnclosableSocket:
    """A connection whose graceful close never completes — the close frame
    queues behind a wedged write — until its transport is aborted."""

    def __init__(self) -> None:
        self.aborted = asyncio.Event()
        self.close_calls = 0
        test = self

        class _Transport:
            def abort(self_inner) -> None:
                test.aborted.set()

        self.transport = _Transport()

    async def close(self):
        self.close_calls += 1
        await self.aborted.wait()


class BoundedCloseTests(unittest.IsolatedAsyncioTestCase):
    """BL-09 / BW-03: closing a wedged socket is bounded, and a bounded
    WAIT for the close never leaves the teardown half done."""

    async def test_a_close_that_is_never_accepted_aborts_the_connection(self):
        from unittest import mock

        ws = _UnclosableSocket()
        session = _session_with(ws)
        with mock.patch("backend.remote_deepgram_live.SEND_WEDGE_SEC", 0.05), \
                self.assertLogs("backend.remote_deepgram_live", level="WARNING") as logs:
            await asyncio.wait_for(session.close(), timeout=1.0)
        self.assertTrue(ws.aborted.is_set(), "the wedged connection was never aborted")
        self.assertTrue(any("aborting the connection" in line for line in logs.output))

    async def test_a_cancelled_close_still_finishes_the_teardown(self):
        from unittest import mock

        ws = _UnclosableSocket()
        session = _session_with(ws)

        async def recv_forever():
            await asyncio.Event().wait()

        session._recv_task = asyncio.get_running_loop().create_task(recv_forever())
        with mock.patch("backend.remote_deepgram_live.SEND_WEDGE_SEC", 0.1):
            # The send watchdog's shape: wait a little, give up waiting.
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(session.close(), timeout=0.02)
            # The "idempotent backstop" must actually finish the job.
            await asyncio.wait_for(session.close(), timeout=1.0)
        self.assertTrue(session._recv_task.done(), "the receive task outlived close()")
        self.assertEqual(ws.close_calls, 1)


class ControlWedgeBoundTests(unittest.TestCase):
    def test_the_wedge_bound_matches_the_one_the_audio_path_uses(self):
        # Same 5 s the removed ``wait_for`` used, so a stuck socket is
        # reported no later than before — only by a different means.
        self.assertEqual(SEND_WEDGE_SEC, 5.0)


class WarmSwapGraceTests(unittest.TestCase):
    def test_the_grace_is_derived_from_the_connect_budget(self):
        # A swap in flight at finalize is waiting on a CONNECT, so the
        # extra time the stop gives it is that budget and not a number
        # of its own — it cannot fall behind a change to either half.
        from backend.main import _WARM_SWAP_GRACE_SEC

        self.assertEqual(
            _WARM_SWAP_GRACE_SEC,
            DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC + DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC,
        )


if __name__ == "__main__":
    unittest.main()
