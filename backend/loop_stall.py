"""Says so in main.log when the event loop was held up.

Every live WebSocket frame, every Deepgram reply and every HTTP request
of this backend runs on one asyncio loop. A synchronous step on it — a
TLS handshake's certificate load, an ``fsync``, a merge over a long
recording — delays all of them at once, and nothing in the log said so:
a ``save-with-audio`` that answered in ~1 s on loopback (OPTIMIZATION.md
§3.1) could be the upload, the multipart parse, the handler's own file
work, or a loop busy with something else entirely, and the log could not
tell those apart.

The watcher is a task that sleeps for ``tick_sec`` and measures how late
it woke. Lateness past ``threshold_sec`` is a stall: the loop could not
run a ready callback for that long. Each stall is one INFO line with its
length; main.log stamps it with the moment the stall ended, so it lines
up with the lines around it. Silent while the loop keeps up. Cost: one
wake-up per tick.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable, Optional

logger = logging.getLogger(__name__)

LOOP_STALL_TICK_SEC = 0.1
LOOP_STALL_THRESHOLD_SEC = 0.25


def stall_ms(expected_wake: float, woke: float, threshold_sec: float) -> Optional[float]:
    """How long the loop was held past its deadline, if that is a stall."""
    late = woke - expected_wake
    if late < threshold_sec:
        return None
    return late * 1000.0


async def watch_loop_stalls(
    *,
    tick_sec: float = LOOP_STALL_TICK_SEC,
    threshold_sec: float = LOOP_STALL_THRESHOLD_SEC,
    clock: Callable[[], float] = time.perf_counter,
    cpu_clock: Callable[[], float] = time.thread_time,
    report: Optional[Callable[[float, float], None]] = None,
) -> None:
    """Run until cancelled, reporting every stall past ``threshold_sec``.

    ``report(stall_ms, cpu_ms)``: ``cpu_ms`` is the CPU the loop's thread
    spent over the same tick (``thread_time`` — the watcher runs on that
    thread). Close to the stall: the loop was computing (a merge, JSON, a
    certificate load). Near zero: it was blocked in a system call (an
    ``fsync``, a synchronous DNS lookup) — or the OS delivered the timer
    late, which is the one case this cannot tell from a real stall.
    """
    emit = report or (
        lambda ms, cpu: logger.info("event loop stalled %.0fms (loop thread cpu %.0fms)", ms, cpu)
    )
    while True:
        expected = clock() + tick_sec
        cpu_before = cpu_clock()
        await asyncio.sleep(tick_sec)
        late = stall_ms(expected, clock(), threshold_sec)
        if late is not None:
            emit(late, (cpu_clock() - cpu_before) * 1000.0)
