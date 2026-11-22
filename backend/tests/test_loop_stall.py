"""The event-loop stall watcher (backend.loop_stall)."""

from __future__ import annotations

import asyncio
import time
import unittest

from backend.loop_stall import stall_ms, watch_loop_stalls


class StallMathTests(unittest.TestCase):
    def test_lateness_below_the_threshold_is_not_a_stall(self):
        self.assertIsNone(stall_ms(10.0, 10.2, 0.25))

    def test_lateness_past_the_threshold_is_reported_in_ms(self):
        self.assertAlmostEqual(stall_ms(10.0, 10.8, 0.25), 800.0, places=6)


class WatcherTests(unittest.IsolatedAsyncioTestCase):
    async def _run(self, body) -> list[tuple[float, float]]:
        stalls: list[tuple[float, float]] = []
        watcher = asyncio.create_task(
            watch_loop_stalls(
                tick_sec=0.02, threshold_sec=0.15,
                report=lambda ms, cpu: stalls.append((ms, cpu)),
            )
        )
        await asyncio.sleep(0.05)
        await body()
        watcher.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await watcher
        return stalls

    async def test_a_blocking_step_on_the_loop_is_reported_once_with_its_length(self):
        async def block():
            time.sleep(0.3)  # synchronous on purpose: this is the stall
            await asyncio.sleep(0.05)

        stalls = await self._run(block)
        self.assertEqual(len(stalls), 1, stalls)
        self.assertGreaterEqual(stalls[0][0], 150.0)
        # time.sleep blocks without computing: the thread's CPU stays low,
        # which is how a blocked syscall is told from a busy loop.
        self.assertLess(stalls[0][1], 30.0)

    async def test_a_computing_loop_is_told_apart_by_its_cpu(self):
        async def spin():
            end = time.perf_counter() + 0.3
            while time.perf_counter() < end:
                pass
            await asyncio.sleep(0.05)

        stalls = await self._run(spin)
        self.assertEqual(len(stalls), 1, stalls)
        # Not the full 300 ms: a loaded machine deschedules the spin too.
        self.assertGreaterEqual(stalls[0][1], 30.0)

    async def test_a_loop_that_keeps_up_is_silent(self):
        async def idle():
            await asyncio.sleep(0.2)

        self.assertEqual(await self._run(idle), [])


if __name__ == "__main__":
    unittest.main()
