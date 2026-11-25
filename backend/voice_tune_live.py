"""Live scoring: the microphone's last seconds, judged as they arrive.

The tuner over old recordings asked the wrong thing of the owner twice over:
he could not name the takes he had to choose from, and the number he wanted to
watch was about his own microphone, not about a file. So the tuner is live —
the browser sends the PCM it is capturing, this scores every window on the way
in, and the picture fills while he speaks.

The embedder is held for the life of the session: a press that reloaded the
weights per window would spend more time loading than listening, and the
whole point is to move a slider while a voice is still in the room.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ, pcm16_bytes_per_sec
from backend.voice_diarize import DiarizedScorer
from backend.voice_mask import DEFAULT_WINDOW_MS

logger = logging.getLogger(__name__)

#: Shorter than the gate's own window on purpose: the gate judges two seconds,
#: and a tuner that answered every two seconds could not be moved while a
#: voice is in the room. One second at a quarter-second hop answers four times
#: a second, so a slider drag and a spoken word meet in the same breath.
WINDOW_MS = 1000
HOP_MS = 250

#: A session nobody feeds is a session holding the weights for nothing.
IDLE_TIMEOUT_SEC = 120.0

#: One feed may carry at most this much audio: a caller posting more is
#: posting a file to a microphone route.
MAX_FEED_SECONDS = 30.0


def _ms_to_bytes(ms: int) -> int:
    nbytes = (ms * pcm16_bytes_per_sec(LIVE_SAMPLE_RATE_HZ)) // 1000
    return nbytes - (nbytes % 2)


def _level_db(pcm: bytes) -> float:
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float64) / 32768.0
    if samples.size == 0:
        return 0.0
    rms = float(np.sqrt(np.mean(samples**2)))
    return 20.0 * float(np.log10(rms)) if rms > 0.0 else 0.0


class LiveTuneSession:
    """One microphone, one profile, and every window scored as it lands."""

    def __init__(
        self,
        embedder: Any,
        profile_vector: Sequence[float],
        *,
        slot: int,
        near_level_db: float = 0.0,
        near_margin_db: float = 12.0,
    ) -> None:
        self.slot = slot
        self._embedder = embedder
        reference = np.asarray(profile_vector, dtype=np.float64)
        norm = float(np.linalg.norm(reference))
        self._reference = reference / norm if norm > 0.0 else reference
        # The same scorer the gate uses, so a slider dragged here means the
        # same thing there: closeness to the voice this room calls the
        # owner's, not a cosine to a profile from another session.
        self._scorer = DiarizedScorer(embedder, self._reference)
        self._near_level_db = float(near_level_db or 0.0)
        self._near_margin_db = float(near_margin_db or 12.0)
        self._lock = threading.Lock()
        self._buffer = bytearray()
        self._window_bytes = _ms_to_bytes(WINDOW_MS)
        self._hop_bytes = _ms_to_bytes(HOP_MS)
        # Audio that arrived before this window finishes is kept, not dropped:
        # a slide is 500 ms but the window is 2 s, so most of every window was
        # already in the previous one.
        self._consumed_bytes = 0
        self._window_index = 0
        self.touched_at = time.monotonic()
        self.closed = False

    @property
    def token(self) -> str:
        return self._token

    def _score_window(self, window: bytes) -> Dict[str, Any]:
        scored = self._scorer(window)
        score = 0.0 if scored is None else float(scored)
        level = _level_db(window)
        return {
            "index": self._window_index,
            "score": round(score, 4),
            "level_db": round(level, 1) if level else 0.0,
            # 0.0 means "no level was measured"; a level is always negative
            # dBFS, so a `> 0` guard here would never fire at all.
            "far": bool(
                self._near_level_db != 0.0
                and level != 0.0
                and level < self._near_level_db - self._near_margin_db
            ),
        }

    def feed(self, pcm: bytes) -> List[Dict[str, Any]]:
        """Score every window this chunk completes, oldest first."""
        if self.closed:
            return []
        data = bytes(pcm[: len(pcm) - (len(pcm) % 2)])
        if not data:
            return []
        with self._lock:
            self.touched_at = time.monotonic()
            self._buffer += data
            out: List[Dict[str, Any]] = []
            # Windows start on a 500 ms grid; each needs 2 s of audio to exist.
            while len(self._buffer) - self._consumed_bytes >= self._window_bytes:
                start = self._consumed_bytes
                window = bytes(self._buffer[start : start + self._window_bytes])
                out.append(self._score_window(window))
                self._window_index += 1
                self._consumed_bytes += self._hop_bytes
            # Everything before the next window's start is dead weight.
            if self._consumed_bytes > 0:
                del self._buffer[: self._consumed_bytes]
                self._consumed_bytes = 0
            return out

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self._embedder.close()
        except Exception:  # noqa: BLE001 - a session ends either way
            logger.debug("live tune embedder close failed", exc_info=True)
        self._buffer.clear()


class LiveTuneRegistry:
    """The sessions by token, and the sweep that keeps a dead one cheap."""

    def __init__(self, idle_timeout_sec: float = IDLE_TIMEOUT_SEC) -> None:
        self._sessions: Dict[str, LiveTuneSession] = {}
        self._lock = threading.Lock()
        self._idle_timeout = float(idle_timeout_sec)

    def start(self, session: LiveTuneSession) -> str:
        token = uuid.uuid4().hex
        session._token = token  # noqa: SLF001 - the token is the session's own id
        with self._lock:
            self._expire_locked()
            self._sessions[token] = session
        return token

    def get(self, token: str) -> Optional[LiveTuneSession]:
        with self._lock:
            self._expire_locked()
            return self._sessions.get(token)

    def stop(self, token: str) -> bool:
        with self._lock:
            session = self._sessions.pop(token, None)
        if session is None:
            return False
        session.close()
        return True

    def close_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.close()

    def _expire_locked(self) -> None:
        now = time.monotonic()
        stale = [
            token
            for token, session in self._sessions.items()
            if now - session.touched_at > self._idle_timeout
        ]
        for token in stale:
            session = self._sessions.pop(token, None)
            if session is not None:
                logger.info("live tune session %s expired after %.0f s idle", token[:8], self._idle_timeout)
                session.close()


LIVE_TUNE = LiveTuneRegistry()

__all__ = [
    "HOP_MS",
    "IDLE_TIMEOUT_SEC",
    "LIVE_TUNE",
    "LiveTuneRegistry",
    "LiveTuneSession",
    "MAX_FEED_SECONDS",
    "WINDOW_MS",
]
