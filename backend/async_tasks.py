"""Ending a task we started, without ending the coroutine that waits.

Why this is a module and not four lines at each call site
--------------------------------------------------------
``asyncio.CancelledError`` inherits from ``BaseException``, not from
``Exception`` — so ``except (asyncio.CancelledError, Exception): pass``
is not a broad catch that happens to include cancellation. It names
cancellation deliberately and then discards it. Thirteen places in this
backend were written that way, all of them ``pass``, and every one had
the same two consequences:

* the cancellation of the coroutine DOING THE AWAITING was swallowed.
  Five of those sites sit in the WebSocket handler's ``finally`` block,
  so a handler cancelled by uvicorn's shutdown or by a dropped
  connection carried on to the end as if nothing had happened, while
  the lifespan's 1 s budget for releasing sockets ran out around it;
* any real failure inside the task — a socket that would not close, an
  exception in a background loop — vanished without a log line, which
  is the "ownerless error" class AGENTS.md §1-2 forbids.

The distinction the idiom lost is between the cancellation of THAT
TASK, which is what we asked for and is not news, and OUR OWN, which
must propagate. Telling them apart needs two questions rather than one,
because cancelling a coroutine that is awaiting a task cancels that
task as well — see ``await_cancelled``.

The same module also owns the closing of a control frame's socket
(``send_without_cancelling``), because that is the same question one
level down: a write we must not interrupt, bounded by something other
than cancelling it.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, Optional

# ``__name__`` (``backend.async_tasks``): the one handler main.py installs is on
# the ``backend`` logger, so a hand-typed name outside that namespace is
# dropped at INFO (BL-04).
logger = logging.getLogger(__name__)


async def await_cancelled(
    task: "asyncio.Future", *, what: str, log: Optional[logging.Logger] = None
) -> None:
    """Await a task we cancelled; never swallow our own cancellation.

    ``what`` names the task in the log line a real failure produces —
    the whole point of not writing ``pass`` here.
    """
    out = log or logger
    try:
        await task
    except asyncio.CancelledError:
        # Two questions, and BOTH have to be asked. The exception object
        # is identical either way.
        #
        # ``Task.cancelling()`` on ourselves is the first and the
        # decisive one: cancelling a task that is awaiting another task
        # cancels the inner one too, so ``task.cancelled()`` becomes
        # true on OUR cancellation as well and cannot tell the two
        # apart on its own. The counter of cancellation requests can:
        # it is non-zero only when someone cancelled US.
        current = asyncio.current_task()
        if current is not None and current.cancelling() > 0:
            raise
        # And the plain case: the task ended some other way and this is
        # a cancellation that came out of it, not one aimed at us.
        if not task.cancelled():
            raise
    except Exception as e:
        out.warning("%s ended with an error: %s", what, e, exc_info=True)


async def cancel_and_await(
    task: "Optional[asyncio.Task]", *, what: str, log: Optional[logging.Logger] = None
) -> None:
    """Cancel a task if it is still running, then await it by the rule above."""
    if task is None:
        return
    if not task.done():
        task.cancel()
    await await_cancelled(task, what=what, log=log)


async def cancel_and_collect(
    task: "Optional[asyncio.Task]", *, what: str, log: Optional[logging.Logger] = None
) -> Any:
    """Cancel a task and return whatever it produced anyway, or ``None``.

    ``cancel()`` loses the race whenever the coroutine has already run
    past its last await, and what such a task returns can be a resource
    somebody must release — a connected, billed Deepgram socket, for
    instance. Same cancellation rule as ``await_cancelled``; the only
    difference is that the result is handed back instead of dropped.
    """
    if task is None:
        return None
    if not task.done():
        task.cancel()
    out = log or logger
    try:
        return await task
    except asyncio.CancelledError:
        current = asyncio.current_task()
        if current is not None and current.cancelling() > 0:
            raise
        if not task.cancelled():
            raise
        return None
    except Exception as e:
        out.info("%s ended with %s", what, e)
        return None


__all__ = ["await_cancelled", "cancel_and_await", "cancel_and_collect"]
