"""One warm Deepgram live socket, opened before the user needs it.

Why
---
``BUGS_AUDIT_2026-09-03.md`` §2.4 measured the Deepgram connect on the
user's own log: **p50 880 ms, p90 1.2 s, max 9.7 s**, plus one 12 s
timeout during which 126 s of dictation went into a stream that never
existed (§3.7). That cost sits at the very start of every recording —
the renderer opens the microphone and streams immediately, so the first
second of speech is buffered instead of transcribed, and the whole stop
chain inherits the delay. Opening the socket ahead of time removes it
from the critical path entirely.

Keeping it warm: ``KeepAlive``, not silence
-------------------------------------------
The two candidate mechanisms are a text ``KeepAlive`` control frame and
a trickle of silent PCM. Deepgram's documentation settles it — from
https://developers.deepgram.com/docs/keep-alive:

    "If no audio data or ``KeepAlive`` messages are sent within a
    10-second window, the connection will close with a ``NET-0001``
    error."

    "Send a ``KeepAlive`` message every 3-5 seconds to prevent the
    10-second timeout that triggers a ``NET-0001`` error and closes the
    connection."

and from https://developers.deepgram.com/docs/audio-keep-alive:

    "Ensure the message is sent as a text WebSocket frame—sending it as
    binary may result in incorrect handling."

So the idle timeout is reset by *either* audio *or* a ``KeepAlive``
text frame; silence frames are not required. ``KeepAlive`` is therefore
the mechanism used here, and no new machinery is needed for it:
``DeepgramLiveSession._keepalive_loop`` already sends exactly that frame.
The only adjustment is cadence — a warm socket sends no audio at all, so
it is opened with ``WARM_KEEPALIVE_INTERVAL_SEC`` (4 s, inside the
documented 3-5 s window) rather than the 7 s that suffices for a session
with audio already flowing.

Timestamps: why warming costs no offset, and where an offset is real
--------------------------------------------------------------------
The same page settles the timestamp question outright:

    "Word timings in streaming transcription results are based on the
    audio stream itself, not the lifetime of the WebSocket connection."

    "If you send ``KeepAlive`` messages without any audio payloads for a
    period of time, then resume sending audio, the timestamps will
    continue from where the audio left off—not from when the
    ``KeepAlive`` messages were sent."

So choosing ``KeepAlive`` over silence frames is also what makes
adoption free of timestamp arithmetic: a warm socket has received zero
audio bytes, so the recording that adopts it still starts at t=0.

That is enforced rather than assumed — ``acquire()`` refuses to adopt a
socket whose ``stats.bytes_sent`` is non-zero. Had we kept it warm with
silence frames instead, every adopted recording would have been shifted
by the warm duration, and the shift would have been invisible: a
transcript is just as readable at the wrong times.

The offset that IS real belongs to the other half of the design. When an
adopted socket turns out to be dead (``backend.main``'s liveness probe),
the recording moves to a fresh connection which is replayed a BOUNDED
ring of the audio the dead one swallowed. That session starts wherever
the ring starts, which is why ``DeepgramLiveSession`` takes
``audio_offset_sec`` and applies it in exactly one place. See its
docstring.

Cost
----
Deepgram bills streaming by the audio it processes and a ``KeepAlive``
frame carries no audio — the documentation files the message under
"preventing timeouts and optimizing costs". A warm socket is still a
real connection holding a slot against the account's concurrency limit,
so its lifetime is bounded: ``WARM_IDLE_TTL_SEC`` after it goes warm it
is closed, and the next recording pays the connect it would have paid
anyway. Warming is demand-driven — backend start and the end of each
recording — never a timer, so an app left open overnight ends up
holding nothing.
"""

from __future__ import annotations

import array
import asyncio
import logging
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Callable, Optional

from backend.async_tasks import cancel_and_collect
from backend.deepgram_language import resolve_live_language
from backend.remote_deepgram_live import (
    DeepgramLiveConfig,
    DeepgramLiveError,
    DeepgramLiveSession,
)

# Under ``backend``: that logger owns the stderr handler main.log is fed
# from, and a hand-typed name outside it ("transcriptor.deepgram_warm")
# had every pool decision — ready, adopted, discarded and why — dropped
# at INFO, so a recording that did not adopt a warm socket could not say
# why (audit BL-04).
logger = logging.getLogger(__name__)


# Cadence for a socket that sends no audio. Inside Deepgram's documented
# 3-5 s window (see the module docstring); the session default of 7 s is
# for a stream that is already carrying audio, where every frame resets
# the same 10 s timer.
WARM_KEEPALIVE_INTERVAL_SEC = 4.0

# How long a warm socket may sit unused before it is closed. Bounds the
# concurrency slot it occupies; the next recording simply pays the
# connect it would have paid without any warm pool at all.
WARM_IDLE_TTL_SEC = 300.0

# How many warm sockets may be held at once. Two, because a dual-stream
# recording (``backend.deepgram_dual``) reads the same audio in two
# languages and those are two configurations; warming one of them would
# leave the other paying exactly the connect this module removes. Each
# is a billed, concurrency-limited connection, so a third is evicted
# rather than opened.
WARM_MAX_SOCKETS = 2

# How many configurations' "where did the last warm socket go" the pool
# remembers, for the reason on a cold connect. A configuration's key
# changes with its keyterm list, so the memory is bounded.
WARM_GONE_MEMORY = 8

# A warm socket proves it is alive by getting its KeepAlive frames onto
# the wire. Two missed cadences (plus slack) means the send path is no
# longer working even though nothing raised — discard rather than adopt.
WARM_KEEPALIVE_STALE_SEC = 12.0

# Peak sample (of int16 full scale) above which a PCM frame counts as
# speech rather than room noise. ≈0.02 FS: comfortably above a quiet
# room and far below any voiced audio, especially given that Chromium's
# AGC starts a capture near full scale (audit §4.3). Used only to decide
# WHEN to start the liveness clock on an adopted socket, never to drop
# audio.
WARM_VOICE_PEAK = 655


def pcm_has_voice(data: bytes) -> bool:
    """Does this PCM16LE frame carry anything louder than room noise?

    The warm-socket liveness check (``main._run_deepgram_live_session``)
    measures "no results within 2.5 s of the first non-silent audio". It
    has to be the first *non-silent* frame: a user who presses the
    hotkey and then thinks for three seconds sends only silence, and
    Deepgram is entitled to answer silence with nothing at all — timing
    the probe from the first frame instead would throw away a perfectly
    healthy socket on every slow start.
    """
    usable = len(data) - (len(data) % 2)
    if usable < 2:
        return False
    samples = array.array("h")
    samples.frombytes(bytes(data[:usable]))
    if sys.byteorder != "little":
        samples.byteswap()
    return max(max(samples), -min(samples)) >= WARM_VOICE_PEAK


@dataclass(frozen=True)
class WarmAcquisition:
    """What ``DeepgramWarmPool.acquire()`` handed back.

    ``connect_ms`` is the measured connect time of THIS socket, whether
    it was paid now (``adopted`` false) or ahead of time (``adopted``
    true, in which case it is the latency the recording did not pay).
    """

    session: DeepgramLiveSession
    adopted: bool
    warm_age_sec: float
    connect_ms: Optional[float]
    # Why this socket was connected cold, empty when ``adopted``. The
    # common answer is by design: a recording more than
    # ``WARM_IDLE_TTL_SEC`` after the previous one finds its warm socket
    # retired by the idle bound (measured 20-22.11: 43 of the 49 cold
    # second readings; the other 6 were the first recording after start).
    cold_reason: str = ""


def _default_factory(
    api_key: str, cfg: DeepgramLiveConfig
) -> DeepgramLiveSession:
    return DeepgramLiveSession(
        api_key=api_key,
        config=cfg,
        keepalive_interval_sec=WARM_KEEPALIVE_INTERVAL_SEC,
    )


@dataclass
class _WarmSlot:
    """One warm socket and everything the pool knows about it."""

    session: DeepgramLiveSession
    key: str
    api_key: str
    # The configuration the socket was opened with — kept so a keyterm
    # change can re-open the SAME reading with the new list
    # (``retarget_keyterms``) instead of guessing model and language.
    cfg: DeepgramLiveConfig
    warmed_at: float
    reaper: Optional[asyncio.Task] = None


class DeepgramWarmPool:
    """Warm ``DeepgramLiveSession``s, at most one per configuration.

    The key is ``DeepgramLiveConfig.to_query_string()`` — the exact
    string that goes on the wire. Model, language, keyterms, diarize,
    endpointing and the shared formatting flags all feed it, so a
    configuration change invalidates the warm socket by construction
    rather than by anyone remembering to list the fields that matter.
    The API key is compared alongside it: rotating the key must not
    hand a recording a socket authenticated with the old one.

    ONE PER KEY, and at most ``WARM_MAX_SOCKETS`` of them. A dual-stream
    recording (``backend.deepgram_dual``) opens two readings of the same
    audio in two languages, which are two configurations and therefore
    two keys; warming only one of them would leave the other paying the
    connect this module exists to remove. Every warm socket is a real
    connection against the user's Deepgram concurrency limit and billed
    for the time it is held, so the count is bounded and the oldest slot
    is evicted rather than a third being opened.

    Bound to the app lifespan: ``start()`` arms it, ``close_all()``
    releases it. Un-armed, ``rewarm()`` is a no-op and ``acquire()``
    degrades to exactly what the caller did before this module existed
    — construct a session and connect it — so nothing retains a socket
    outside a running application.
    """

    def __init__(
        self,
        *,
        session_factory: Callable[
            [str, DeepgramLiveConfig], DeepgramLiveSession
        ] = _default_factory,
        idle_ttl_sec: float = WARM_IDLE_TTL_SEC,
        keepalive_stale_sec: float = WARM_KEEPALIVE_STALE_SEC,
        max_sockets: int = WARM_MAX_SOCKETS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._factory = session_factory
        self._idle_ttl_sec = float(idle_ttl_sec)
        self._keepalive_stale_sec = float(keepalive_stale_sec)
        self._max_sockets = max(1, int(max_sockets))
        self._clock = clock
        self._lock = asyncio.Lock()
        self._armed = False
        # Insertion-ordered, and kept that way: the oldest slot is the
        # first one out when the bound is reached.
        self._slots: "OrderedDict[str, _WarmSlot]" = OrderedDict()
        # key -> (connect task, api key, configuration being connected).
        self._pending: dict[str, tuple[asyncio.Task, str, DeepgramLiveConfig]] = {}
        # key -> (what happened to the last warm socket for it, when).
        self._gone: "OrderedDict[str, tuple[str, float]]" = OrderedDict()

    # ----- Lifecycle --------------------------------------------------

    def start(self) -> None:
        """Arm the pool. Called once, from the app lifespan."""
        self._armed = True

    async def close_all(self) -> None:
        """Release every warm socket and every task the pool owns."""
        self._armed = False
        async with self._lock:
            for key in list(self._pending):
                await self._cancel_pending(key)
            for key in list(self._slots):
                await self._drop_slot(key, "pool closed")

    # ----- Acquisition ------------------------------------------------

    async def acquire(
        self, api_key: str, cfg: DeepgramLiveConfig
    ) -> WarmAcquisition:
        """Return a connected session for ``cfg``.

        Adopts the warm socket for this exact configuration when there
        is one and it is healthy; otherwise connects a fresh one.
        Sockets held for OTHER configurations are left alone — they
        belong to another reading, not to this one. Raises
        ``DeepgramLiveError`` exactly where a plain
        ``DeepgramLiveSession.connect()`` would, so the caller's failure
        path is unchanged.
        """
        key = cfg.to_query_string()
        # Under the lock: pool BOOKKEEPING only. The connect itself — up
        # to ``DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC`` plus one retry, so 12 s
        # of network wait — is awaited outside it. Held across the
        # connect, this lock serialised the two acquires of a
        # dual-stream recording, which is precisely the case
        # ``WARM_MAX_SOCKETS = 2`` exists for: the second reading paid a
        # full connect AFTER the first one's, back to back, and no
        # amount of concurrency in the caller could change that.
        async with self._lock:
            pending = self._pending.get(key)
            if pending is not None and pending[1] == api_key:
                # A re-warm for exactly this configuration is already in
                # flight and is, at worst, as far along as a fresh
                # connect started now. Taking it over also keeps the
                # worst case at ONE connect budget: a failure is raised,
                # not retried behind a second 12 s attempt.
                #
                # Popped here, so ``_warm_connect`` sees the entry gone
                # and hands the session to this caller instead of
                # storing it in a slot.
                task = self._pending.pop(key)[0]
                in_flight = True
            else:
                if pending is not None:
                    await self._cancel_pending(key)

                slot = self._slots.get(key)
                if slot is not None:
                    reason = self._unfit_reason(slot, api_key)
                    if reason is None:
                        self._release_slot(key)
                        self._note_gone(key, "adopted by the previous recording")
                        return self._adopt(
                            slot.session,
                            age=max(0.0, self._clock() - slot.warmed_at),
                        )
                    await self._drop_slot(key, reason)

                cold_reason = self._cold_reason(key)
                task = asyncio.get_running_loop().create_task(
                    self._connect_only(self._factory(api_key, cfg)),
                    name="deepgram-acquire-connect",
                )
                in_flight = False

        session = await self._await_connect(task)
        if in_flight:
            if session is None:
                raise DeepgramLiveError(
                    "Deepgram connect failed (warm connect in flight)"
                )
            return self._adopt(session, age=0.0)
        # ``_connect_only`` re-raises what ``connect()`` raised, so this
        # caller's failure path is exactly what it was before the pool
        # existed; ``session is None`` cannot happen on this branch.
        connect_ms = session.stats.connect_ms
        logger.info(
            "deepgram-live: [%s] cold connect in %sms reason=%s",
            resolve_live_language(cfg.language),
            f"{connect_ms:.0f}" if connect_ms is not None else "?",
            cold_reason,
        )
        return WarmAcquisition(
            session=session,
            adopted=False,
            warm_age_sec=0.0,
            connect_ms=connect_ms,
            cold_reason=cold_reason,
        )

    @staticmethod
    async def _connect_only(session: DeepgramLiveSession) -> DeepgramLiveSession:
        """Connect one session and return it, closing it if cancelled."""
        try:
            await session.connect()
        except asyncio.CancelledError:
            await _quiet_close(session)
            raise
        return session

    async def _await_connect(
        self, task: "asyncio.Task"
    ) -> Optional[DeepgramLiveSession]:
        """Await a connect task without leaving a live socket behind.

        The task runs outside the pool lock, so a caller cancelled while
        waiting on it (uvicorn shutdown, the renderer disconnecting)
        would otherwise abandon a task that may be about to return a
        real, billed connection. Cancelling it is not enough on its own:
        ``cancel()`` loses the race whenever the connect has already
        returned, which is the same hole ``_cancel_pending`` had
        (B-013). So the socket is closed from a done-callback, on the
        loop, after this coroutine is gone.
        """
        try:
            return await task
        except asyncio.CancelledError:
            task.cancel()
            task.add_done_callback(_close_orphaned_connect)
            raise
        except DeepgramLiveError:
            raise
        except Exception:
            return None

    def _adopt(
        self, session: DeepgramLiveSession, *, age: float
    ) -> WarmAcquisition:
        connect_ms = session.stats.connect_ms
        logger.info(
            "deepgram-live: adopted warm socket age=%.1fs (saved ~%sms connect)",
            age,
            f"{connect_ms:.0f}" if connect_ms is not None else "?",
        )
        return WarmAcquisition(
            session=session,
            adopted=True,
            warm_age_sec=age,
            connect_ms=connect_ms,
        )

    # ----- Warming ----------------------------------------------------

    def rewarm(self, api_key: str, cfg: DeepgramLiveConfig) -> None:
        """Start connecting a warm socket for ``cfg`` in the background.

        Never awaits and never raises: a failed pre-warm must not be
        visible to the recording that triggered it. The next
        ``acquire()`` simply connects and surfaces its own error, as it
        did before this pool existed.
        """
        if not self._armed or not api_key:
            return
        key = cfg.to_query_string()
        slot = self._slots.get(key)
        if slot is not None and slot.api_key == api_key:
            return
        if key in self._pending:
            # One connect in flight per configuration. A second would
            # buy nothing: this one is at worst as far along.
            return
        task = asyncio.get_running_loop().create_task(
            self._warm_connect(api_key, cfg, key), name="deepgram-warm-connect"
        )
        self._pending[key] = (task, api_key, cfg)

    async def retarget_keyterms(
        self, api_key: str, keyterms: tuple[str, ...]
    ) -> None:
        """Re-open every warm socket whose keyterms are no longer current.

        The keyterm list is part of the query string and therefore of
        the slot key, so a socket opened before the list changed can
        never be ADOPTED by a recording that uses the new list — that
        much holds by construction. What construction alone does not do
        is release it: the stale socket would sit out its idle TTL
        holding a concurrency slot, and the next recording would pay the
        cold connect this pool exists to remove. The keyterm list
        changes behind the renderer's back (the self-filling vocabulary,
        ``backend.auto_keyterms``, recomputes after a recording is
        saved), so the pool is told, and swaps each affected socket —
        and each affected connect still in flight — for one opened with
        the same configuration and the new list.

        A configuration on which keyterms are not on the wire (a
        non-Nova-3 model) keeps its key and is left alone. Without an
        API key the stale sockets are only released. Never raises.
        """
        if not self._armed:
            return
        keyterms = tuple(keyterms)
        reopen: list[DeepgramLiveConfig] = []
        async with self._lock:
            for key, slot in list(self._slots.items()):
                fresh = replace(slot.cfg, keyterms=keyterms)
                if fresh.to_query_string() == key:
                    continue
                await self._drop_slot(key, "keyterms changed")
                reopen.append(fresh)
            for key, (_task, _pending_key, cfg) in list(self._pending.items()):
                fresh = replace(cfg, keyterms=keyterms)
                if fresh.to_query_string() == key:
                    continue
                await self._cancel_pending(key)
                reopen.append(fresh)
        for cfg in reopen:
            self.rewarm(api_key, cfg)

    async def _warm_connect(
        self, api_key: str, cfg: DeepgramLiveConfig, key: str
    ) -> Optional[DeepgramLiveSession]:
        session = self._factory(api_key, cfg)
        try:
            await session.connect()
        except asyncio.CancelledError:
            await _quiet_close(session)
            raise
        except Exception as e:
            logger.info("deepgram-live: pre-warm connect failed: %s", e)
            await _quiet_close(session)
            if self._pending.pop(key, None) is not None:
                self._note_gone(key, f"pre-warm connect failed: {e}")
            return None
        # ``acquire()`` may already have taken this task over (it pops
        # the pending entry before awaiting), in which case the session
        # belongs to that caller and must not be stored.
        if key in self._pending:
            self._pending.pop(key, None)
            await self._store_warm(session, key, api_key, cfg)
        return session

    async def _store_warm(
        self,
        session: DeepgramLiveSession,
        key: str,
        api_key: str,
        cfg: DeepgramLiveConfig,
    ) -> None:
        # Every mutation happens before the first await, so a concurrent
        # ``acquire()`` can never observe a half-swapped slot. This runs
        # WITHOUT the pool lock on purpose: ``acquire()`` may be awaiting
        # this very task, and it releases the lock before it does.
        previous = self._slots.pop(key, None)
        if previous is not None:
            self._cancel_reaper(previous)
        evicted: list[_WarmSlot] = []
        while len(self._slots) >= self._max_sockets:
            oldest_key, oldest = self._slots.popitem(last=False)
            self._cancel_reaper(oldest)
            evicted.append(oldest)
            self._note_gone(
                oldest_key, f"oldest of more than {self._max_sockets} warm sockets"
            )
        self._gone.pop(key, None)
        slot = _WarmSlot(
            session=session,
            key=key,
            api_key=api_key,
            cfg=cfg,
            warmed_at=self._clock(),
        )
        self._slots[key] = slot
        connect_ms = session.stats.connect_ms
        logger.info(
            "deepgram-live: warm socket ready in %sms (ttl=%.0fs, %d/%d held)",
            f"{connect_ms:.0f}" if connect_ms is not None else "?",
            self._idle_ttl_sec,
            len(self._slots),
            self._max_sockets,
        )
        slot.reaper = asyncio.get_running_loop().create_task(
            self._expire_when_idle(key, session), name="deepgram-warm-ttl"
        )
        for stale in ([previous] if previous is not None else []) + evicted:
            if stale.session is session:
                continue
            logger.info(
                "deepgram-live: discarded warm socket age=%.1fs reason=%s",
                max(0.0, self._clock() - stale.warmed_at),
                "replaced by a newer warm socket"
                if stale is previous
                else f"oldest of more than {self._max_sockets} warm sockets",
            )
            await _quiet_close(stale.session)

    async def _expire_when_idle(
        self, key: str, session: DeepgramLiveSession
    ) -> None:
        try:
            await asyncio.sleep(self._idle_ttl_sec)
        except asyncio.CancelledError:
            return
        async with self._lock:
            slot = self._slots.get(key)
            if slot is None or slot.session is not session:
                return
            await self._drop_slot(
                key, f"idle for {self._idle_ttl_sec:.0f}s (billing/concurrency bound)"
            )

    # ----- Internals --------------------------------------------------

    def _unfit_reason(self, slot: _WarmSlot, api_key: str) -> Optional[str]:
        """Why this warm socket must NOT be adopted, or ``None``."""
        session = slot.session
        if slot.api_key != api_key:
            return "API key changed"
        if session.is_closed:
            return "socket already closed"
        if session.last_fatal:
            return f"socket reported a fatal error ({session.last_error})"
        if session.stats.bytes_sent:
            # The invariant that makes a warm socket timestamp-safe:
            # Deepgram counts from the audio it has received, so a warm
            # socket that carried audio would shift every timestamp of
            # the adopted recording. See the module docstring.
            return "socket already carried audio (timestamps would be shifted)"
        now = self._clock()
        age = now - slot.warmed_at
        if age > self._idle_ttl_sec:
            return f"warm for {age:.0f}s, past the {self._idle_ttl_sec:.0f}s bound"
        last_ka = session.stats.last_keepalive_at
        if last_ka is None:
            if age > self._keepalive_stale_sec:
                return f"no KeepAlive has landed in {age:.0f}s"
        elif now - last_ka > self._keepalive_stale_sec:
            return f"last KeepAlive was {now - last_ka:.0f}s ago"
        return None

    def _release_slot(self, key: str) -> Optional[_WarmSlot]:
        """Take a slot out of the pool without closing its socket."""
        slot = self._slots.pop(key, None)
        if slot is not None:
            self._cancel_reaper(slot)
        return slot

    def _note_gone(self, key: str, what: str) -> None:
        """Remember what became of the last warm socket for ``key``."""
        self._gone.pop(key, None)
        self._gone[key] = (what, self._clock())
        while len(self._gone) > WARM_GONE_MEMORY:
            self._gone.popitem(last=False)

    def _cold_reason(self, key: str) -> str:
        """Why a recording for ``key`` finds no warm socket to adopt."""
        if not self._armed:
            return "warm pool not armed"
        gone = self._gone.get(key)
        if gone is not None:
            what, at = gone
            return f"last warm socket {max(0.0, self._clock() - at):.0f}s ago: {what}"
        return "no warm socket was opened for this configuration"

    async def _drop_slot(self, key: str, reason: str) -> None:
        slot = self._release_slot(key)
        if slot is None:
            return
        self._note_gone(key, f"discarded: {reason}")
        logger.info(
            "deepgram-live: discarded warm socket age=%.1fs reason=%s",
            max(0.0, self._clock() - slot.warmed_at),
            reason,
        )
        await _quiet_close(slot.session)

    @staticmethod
    def _cancel_reaper(slot: _WarmSlot) -> None:
        if slot.reaper is not None and not slot.reaper.done():
            slot.reaper.cancel()
        slot.reaper = None

    async def _cancel_pending(self, key: str) -> None:
        entry = self._pending.pop(key, None)
        if entry is None:
            return
        self._note_gone(key, "warm connect cancelled")
        task = entry[0]
        if task.done():
            session = None
            try:
                session = task.result()
            except Exception:
                session = None
            if session is not None:
                await _quiet_close(session)
            return
        session = await cancel_and_collect(
            task, what="deepgram warm connect", log=logger
        )
        if session is not None:
            # ``cancel()`` lost the race: the connect had already
            # returned past its last await, so this is a live, billed
            # socket holding a slot against the concurrency limit. The
            # ``task.done()`` branch above closes it; this one used to
            # drop it on the floor for the lifetime of the process.
            await _quiet_close(session)

    # ----- Introspection ----------------------------------------------

    def status(self) -> dict:
        """Debug snapshot for ``GET /api/live/warm``.

        One row per warm socket, plus the configurations currently being
        connected — a stop-latency investigation asks "was anything warm
        for this recording, and if not why not", and both answers live
        here.
        """
        now = self._clock()
        sockets = []
        for key, slot in self._slots.items():
            reason = self._unfit_reason(slot, slot.api_key)
            sockets.append(
                {
                    "state": "warm",
                    "configKey": key,
                    "ageSec": round(max(0.0, now - slot.warmed_at), 3),
                    "healthy": reason is None,
                    "unfitReason": reason,
                    "connectMs": slot.session.stats.connect_ms,
                    "keepalivesSent": slot.session.stats.keepalives_sent,
                }
            )
        for key in self._pending:
            sockets.append(
                {
                    "state": "connecting",
                    "configKey": key,
                    "ageSec": None,
                    "healthy": None,
                    "unfitReason": None,
                    "connectMs": None,
                    "keepalivesSent": None,
                }
            )
        return {
            "armed": self._armed,
            "idleTtlSec": self._idle_ttl_sec,
            "maxSockets": self._max_sockets,
            "sockets": sockets,
        }


def _close_orphaned_connect(task: "asyncio.Task") -> None:
    """Close a connect whose awaiter was cancelled out from under it."""
    if task.cancelled():
        return
    try:
        session = task.result()
    except Exception:
        return
    if session is None:
        return
    asyncio.get_running_loop().create_task(
        _quiet_close(session), name="deepgram-orphaned-connect-close"
    )


async def _quiet_close(session: DeepgramLiveSession) -> None:
    """Close a session nobody is listening to, swallowing teardown noise."""
    try:
        # ``discard`` rather than ``close``: nobody is consuming this
        # session's events, and the teardown of a socket the pool is
        # retiring on purpose is not an error anyone needs to hear about.
        await session.discard()
    except Exception as e:  # pragma: no cover - teardown is best-effort
        logger.debug("deepgram-live: warm socket close ignored: %s", e)


__all__ = [
    "DeepgramWarmPool",
    "WarmAcquisition",
    "WARM_IDLE_TTL_SEC",
    "WARM_MAX_SOCKETS",
    "WARM_KEEPALIVE_INTERVAL_SEC",
    "WARM_KEEPALIVE_STALE_SEC",
    "WARM_VOICE_PEAK",
    "pcm_has_voice",
]
