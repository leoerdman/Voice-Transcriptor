"""Which words are whose: a transcript segment against the kept voice (Solo).

The gate decides on two-second windows, and a window holding two voices at once
cannot be either of them: measured on the owner's desk (2026-11-19) a dialogue
over one microphone scored at most 0.541 against the enabled profile — under
`close_at`, so no window was ever clearly the kept voice and the gate silenced
both speakers. The same take cut into the segments a recogniser produces splits
cleanly: the kept voice at 0.418-0.487, the other at 0.058-0.063.

So the gate stays the audio-side safeguard and this is the word-side one: each
segment is embedded from its own seconds of the take, and a segment that is not
the kept voice does not reach the transcript. The net is the one already loaded
— no API, no per-call cost (§2.4).

Cost: one embedding per segment, ~25 ms on two threads, paid after recognition
when the audio is already on disk.
"""

from __future__ import annotations

import math
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

#: Below this, a segment is not the kept voice. Measured, not chosen: the two
#: clusters of a two-voice take sat at 0.058-0.063 and 0.418-0.487, and the
#: window gate's own `close_at` (0.55) was above both. 0.30 sits between the
#: clusters with the most room on the side that matters — a stranger's word
#: must not pass.
FOREIGN_BELOW = 0.30
#: The seconds an embedding is taken from: the gate's own window, because the
#: profile was built from that length and a cosine across two lengths measures
#: the difference in length.
WINDOW_SECONDS = 2.0
RATE = 16000


def read_pcm(path: Path) -> Optional[bytes]:
    """The take as the net wants it, or ``None`` when it is not already that."""
    try:
        with wave.open(str(path), "rb") as handle:
            if handle.getframerate() != RATE or handle.getnchannels() != 1:
                return None
            return handle.readframes(handle.getnframes())
    except (wave.Error, OSError):
        return None


def _slice_for(pcm: bytes, start: float, end: float) -> Optional[bytes]:
    """The 2 s of a segment most likely to be one voice, or ``None``."""
    total = len(pcm) // 2
    first = max(0, min(total, int(start * RATE)))
    last = max(first, min(total, int(end * RATE)))
    span = int(WINDOW_SECONDS * RATE)
    if last - first < span:
        return None
    middle = (first + last) // 2
    head = max(first, min(last - span, middle - span // 2))
    return pcm[head * 2 : (head + span) * 2]


def keep_own_segments(
    segments: Sequence[Dict[str, Any]],
    pcm: bytes,
    profile: np.ndarray,
    embedder: Any,
    *,
    floor: float = FOREIGN_BELOW,
) -> Dict[str, Any]:
    """The segments that are the kept voice, and how many were dropped.

    A segment too short to embed is kept: an answer of "no" needs evidence, and
    a word shorter than two seconds has none to give (the same rule the gate
    follows at its own edges).
    """
    kept: List[Dict[str, Any]] = []
    dropped = 0
    for segment in segments:
        try:
            start = float(segment.get("start") or 0.0)
            end = float(segment.get("end") or 0.0)
        except (TypeError, ValueError):
            kept.append(segment)
            continue
        window = _slice_for(pcm, start, end)
        if window is None:
            kept.append(segment)
            continue
        vector = embedder.embed(window)
        if vector is None:
            kept.append(segment)
            continue
        norm = float(np.linalg.norm(vector)) * float(np.linalg.norm(profile))
        score = float(np.dot(vector, profile) / norm) if norm > 0.0 else 0.0
        if not math.isfinite(score) or score >= floor:
            kept.append(segment)
        else:
            dropped += 1
    return {"segments": kept, "dropped": dropped}
