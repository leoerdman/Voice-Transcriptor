"""The gate, off the event loop, between the receiver and the send queue.

Why a thread
------------
One judgement of a 2 s window costs 26 ms of CPU on two ORT threads
(measured, CAM++, fbank included) and a hop is 50 ms, so the gate spends
about half of every hop's budget inside the model. Run inline in the
receive loop that would block the same loop that forwards Deepgram's
events and answers the renderer for 26 ms out of every 50 — the loop
would be, on a good machine, half asleep while a recording runs. So the
work moves to one thread and the loop keeps reading its own socket.

Why not inside the send
-----------------------
§3.2: one socket, one byte count, one owner of time. The sender batches,
flushes on a 50 ms trailing edge and is watched by a wedge clock that
starts when a byte is enqueued; putting a model in front of it would
make every one of those measurements describe the model too. The gate
therefore sits where §3.1 says: in the receive path, after the recovery
chunk, *before* ``_offer_pcm`` — the wedge clock never sees held audio
(§3.3), because a held hop is not enqueued until the gate releases it.

What it promises
----------------
* Every submitted byte leaves exactly once, in submission order, either
  untouched or zeroed to its own length (§4.2, §6.3). Concatenating
  everything ``emit`` ever received reproduces the input's LENGTH and
  ORDER whatever the model said, and reproduces its CONTENT whenever the
  mask kept it.
* ``submit`` never waits for the model and never blocks the loop.
* ``close`` returns only after the last byte has reached ``emit``, so
  the finalize sentinel cannot overtake held audio (§7.3's "flush on
  finalize").
* ``on_state`` — when a caller passes one — is told what the gate is
  doing, on the loop thread, at most once per second of refused audio
  and once more at ``close``. That is §5.3's visible refusal: the audio
  this gate zeroes never reaches a provider, and in a transcript it is
  indistinguishable from speech the app lost.
* With no mask there is no object: the caller keeps calling
  ``_offer_pcm`` directly and the path is byte-for-byte the old one
  (§3.4, §6.4). This module is never constructed to do nothing.

The one fallback
----------------
A worker that falls ``max_pending_bytes`` behind is not going to catch
up: at real-time input that is twenty seconds of audio queued, with the
model running at twice real time. Rather than let the backlog grow
unbounded — which would end in a flush that takes longer than the
recording — the gate stops masking, flushes what it holds with the
labels it has, and passes everything after it through. That is a leak,
not a cut and not a drop (§4.4's asymmetry), it is logged, and
``degraded`` says so. It cannot happen on a machine that keeps the
model within its hop.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, List, Optional

from backend.audio_constants import LIVE_PCM_BYTES_PER_SEC
from backend.voice_mask import VoiceMask

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MaskState:
    """What the gate is doing, as one fact the pane can draw (§5.3).

    ``state`` is the gate's own word (``"idle"`` before any verdict,
    ``"open"``/``"closed"`` after), ``withheld_sec`` is how much audio it
    has zeroed, and ``degraded`` says the gate gave up keeping up — the
    one case where audio was forwarded *without* a judgement, which is
    the opposite of a refusal and must not be silent either.
    """

    state: str
    withheld_sec: float
    degraded: bool = False
    final: bool = False


#: How often a standing refusal re-reports while it lasts, in bytes of
#: refused audio. One report per second: the counter is the only thing
#: that changes, the pane has no clock of its own (§2.1), and 20
#: messages a second would be a transcript of the gate rather than a
#: line of state.
REPORT_EVERY_BYTES = LIVE_PCM_BYTES_PER_SEC

#: Twenty seconds of audio. The worker runs the model at roughly twice
#: real time, so reaching this means the machine is not keeping up at
#: all rather than that a burst arrived.
DEFAULT_MAX_PENDING_BYTES = 20 * LIVE_PCM_BYTES_PER_SEC

#: How long ``close`` waits for a judgement already in flight. A 2 s
#: window is 26 ms, so seconds are three orders of magnitude of margin —
#: but the margin is not for the judgement, it is for the CPU it needs.
#: Measured on a recording that started while the local whisper model was
#: loading: eight threads took the box for six seconds, the last backlog
#: was still unjudged at five, and the held window was lost on the way
#: out. Fifteen keeps §6.3's byte count on a machine doing two heavy
#: things at once and is still far below the 30 s stop budget.
CLOSE_TIMEOUT_SEC = 15.0


class MaskWorker:
    """One thread running one gate, with an ordered hand-off both ways.

    ``emit`` is called on the loop thread, in order, with PCM16LE of the
    same total length as everything submitted. It is the receiver's
    ``_offer_pcm``; this class never touches the session, the stats or
    the socket (§3.5).
    """

    def __init__(
        self,
        mask: VoiceMask,
        emit: Callable[[bytes], None],
        *,
        loop: Optional[asyncio.AbstractEventLoop] = None,
        max_pending_bytes: int = DEFAULT_MAX_PENDING_BYTES,
        on_state: Optional[Callable[[MaskState], None]] = None,
    ) -> None:
        self._mask = mask
        self._emit = emit
        self._on_state = on_state
        self._loop = loop if loop is not None else asyncio.get_running_loop()
        self._max_pending_bytes = max(1, int(max_pending_bytes))
        # Guards the hand-off queue and the two flags. Never held while
        # the model runs: a submit that waited on a judgement would put
        # the thing this thread exists to remove straight back.
        self._cond = threading.Condition()
        self._pending: Deque[bytes] = deque()
        self._pending_bytes = 0
        self._closing = False
        self._closed = False
        self._degraded = False
        # The worker is the only writer; the loop is the only reader.
        self._out: List[bytes] = []
        self._out_lock = threading.Lock()
        self._scheduled = False
        # The same one-writer discipline for the state line: what changed
        # is decided on this thread, when the loop can hear it is decided
        # by ``_report_scheduled``.
        self._report: Optional[MaskState] = None
        self._report_scheduled = False
        self._reported: Optional[tuple] = None
        # Set once, under the same lock as the queue, when the recording's
        # total has been handed over. Nothing may be reported after it: the
        # pane reads the LAST frame as the total, and a change that landed
        # behind it would leave the line saying "is being withheld" for a
        # recording that already ended.
        self._final_sent = False
        self._thread = threading.Thread(
            target=self._run, name="voice-mask", daemon=True
        )
        self._thread.start()

    # -- the loop's side ---------------------------------------------------

    def submit(self, data: bytes) -> None:
        """Hand the gate a received chunk. Never waits, never raises."""
        if not data:
            return
        with self._cond:
            if self._closed:
                # The stop has already flushed; the receiver cannot still
                # be reading (it is cancelled first), but a byte that
                # arrives here must not vanish.
                forward = True
            else:
                forward = False
                self._pending.append(data)
                self._pending_bytes += len(data)
                if self._pending_bytes > self._max_pending_bytes and not self._degraded:
                    self._degraded = True
                    logger.warning(
                        "voice-mask: %d bytes queued and not judged; the gate "
                        "is not keeping up and the rest of this recording is "
                        "forwarded unmasked",
                        self._pending_bytes,
                    )
                self._cond.notify()
        if forward:
            self._emit(data)

    async def close(self, *, timeout: float = CLOSE_TIMEOUT_SEC) -> None:
        """Flush the gate and return once every byte has been emitted."""
        with self._cond:
            self._closing = True
            self._cond.notify_all()
        if self._thread.is_alive():
            await asyncio.to_thread(self._thread.join, timeout)
        if self._thread.is_alive():
            # A judgement is stuck in the model. Nothing is cut: the
            # held audio is the last two seconds of the forwarded copy,
            # the recording's own spool still holds every byte (§1.4),
            # and the recovery path re-processes it from there.
            logger.error(
                "voice-mask: worker did not stop within %.1fs; the window it "
                "was still holding is lost from the forwarded copy (the take "
                "on disk still has every byte)",
                timeout,
            )
        with self._cond:
            self._closed = True
            # Submitted after the thread broke out but before this line:
            # older than nothing, newer than everything drained, and a
            # dropped byte is never the answer (§6.3). Forwarded below.
            leftover = list(self._pending)
            self._pending.clear()
            self._pending_bytes = 0
        with self._out_lock:
            # Any report still in flight is about a moment before the
            # flush, and the final report below is about the recording.
            # Left queued, one of them would land after the total and
            # leave the pane saying "is being withheld" forever.
            self._report = None
            self._report_scheduled = False
        # Deterministic: the thread is joined, so nothing can be appended
        # after this, and the finalize sentinel is enqueued only once
        # this returns (§7.3).
        self._drain()
        for item in leftover:
            self._emit(item)
        # The last word on the gate, on the loop thread and therefore
        # ordered before the ``final`` envelope the caller sends next: a
        # refusal that ended with the recording is still a refusal, and
        # the pane must be able to say how much of one it was (§5.3).
        with self._out_lock:
            self._final_sent = True
        if self._on_state is not None:
            try:
                self._on_state(self._snapshot(final=True))
            except Exception as e:  # pragma: no cover - teardown is best-effort
                logger.debug("voice-mask: final state report failed: %s", e)

    # -- state the caller reads --------------------------------------------

    @property
    def degraded(self) -> bool:
        """Whether the gate gave up on this recording (see the module doc)."""
        return self._degraded

    @property
    def pending_bytes(self) -> int:
        """Audio submitted but not yet judged."""
        with self._cond:
            return self._pending_bytes

    @property
    def mask(self) -> VoiceMask:
        """The gate itself — read-only diagnostics, never the loop's path."""
        return self._mask

    # -- the thread --------------------------------------------------------

    def _run(self) -> None:
        while True:
            with self._cond:
                while not self._pending and not self._closing:
                    self._cond.wait()
                if not self._pending:
                    # Closing with nothing left: the tail is the mask's.
                    break
                data = self._pending.popleft()
                self._pending_bytes -= len(data)
                degraded = self._degraded
            with self._out_lock:
                if degraded:
                    # §4.4's asymmetry, taken to its end: the backlog is
                    # older than the byte that overflowed, so it still
                    # leaves first — untouched, because a leak is the
                    # mistake this design prefers to a cut.
                    self._out.extend(self._mask.flush())
                    self._out.append(data)
                else:
                    self._out.extend(self._mask.feed(data))
            self._publish()
            self._note_state()
        with self._out_lock:
            # ``flush`` is idempotent: after a degrade the gate is empty
            # and this adds nothing.
            self._out.extend(self._mask.flush())
        self._publish()
        self._note_state()

    # -- the line of state (§5.3, §5.4) ------------------------------------

    def _snapshot(self, *, final: bool) -> MaskState:
        return MaskState(
            state=self._mask.state,
            withheld_sec=round(self._mask.withheld_bytes / LIVE_PCM_BYTES_PER_SEC, 3),
            degraded=self._degraded,
            final=final,
        )

    def _note_state(self) -> None:
        """Queue a report if the gate's state or its count has moved.

        Runs on the worker thread, once per submitted chunk, so the
        comparison is cheap and the only thing it ever queues is a
        *change*: a verdict flipping the gate, or another whole second of
        refused audio. A standing refusal is otherwise silent between
        those seconds, which is what keeps this a line of state rather
        than a stream of gate telemetry.
        """
        if self._on_state is None:
            return
        snapshot = self._snapshot(final=False)
        key = (
            snapshot.state,
            self._mask.withheld_bytes // REPORT_EVERY_BYTES,
            snapshot.degraded,
        )
        with self._out_lock:
            if key == self._reported:
                return
            self._reported = key
            self._report = snapshot
            if self._report_scheduled:
                return
            self._report_scheduled = True
        try:
            self._loop.call_soon_threadsafe(self._flush_report)
        except RuntimeError:  # pragma: no cover - loop already gone
            with self._out_lock:
                self._report_scheduled = False

    def _flush_report(self) -> None:
        """Hand the queued report to the caller. Runs on the loop thread."""
        with self._out_lock:
            snapshot = self._report
            self._report = None
            self._report_scheduled = False
            # A callback can still be in flight when ``close`` runs; once
            # the total has gone out, the answer is "too late", never a
            # second line behind it.
            if self._final_sent:
                snapshot = None
        if snapshot is None or self._on_state is None:
            return
        try:
            self._on_state(snapshot)
        except Exception as e:  # pragma: no cover - a report never stops a recording
            logger.debug("voice-mask: state report failed: %s", e)

    def _publish(self) -> None:
        """Ask the loop to empty ``_out``; at most one ask in flight."""
        with self._out_lock:
            if not self._out or self._scheduled:
                return
            self._scheduled = True
        try:
            self._loop.call_soon_threadsafe(self._drain)
        except RuntimeError:  # pragma: no cover - loop already gone
            with self._out_lock:
                self._scheduled = False

    def _drain(self) -> None:
        """Emit everything queued, in order. Runs on the loop thread."""
        while True:
            with self._out_lock:
                if not self._out:
                    self._scheduled = False
                    return
                chunks = self._out
                self._out = []
            for chunk in chunks:
                if chunk:
                    self._emit(chunk)


__all__ = ["DEFAULT_MAX_PENDING_BYTES", "MaskState", "MaskWorker"]
