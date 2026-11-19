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
#: clusters of a two-voice take sat at 0.058-0.063 and 0.418-0.487, and one segment in between scored 0.188-0.289, and the
#: window gate's own `close_at` (0.55) was above both. 0.35 sits above the ambiguous band (0.188-0.289 measured) and below the kept cluster, with the most room on the side that matters
#: clusters with the most room on the side that matters — a stranger's word
#: must not pass.
FOREIGN_BELOW = 0.35
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


def window_scores(
    pcm: bytes,
    profile: np.ndarray,
    embedder: Any,
    *,
    hop_seconds: float = 0.5,
) -> List[tuple[float, float]]:
    """``(centre_seconds, score)`` for a 2 s window every ``hop_seconds``.

    A recogniser hands out two-second segments, so a decision taken from one
    window per segment is one sample of a timbre — and one sample is what a
    plosive, a breath, or the seam between two voices can decide. The take's
    windows are measured here instead, and a segment is judged by the median
    of the windows it covers.
    """
    span = int(WINDOW_SECONDS * RATE) * 2  # bytes
    hop = max(1, int(hop_seconds * RATE)) * 2
    profile_norm = float(np.linalg.norm(profile))
    rows: List[tuple[float, float]] = []
    if len(pcm) < span:
        return rows
    for start in range(0, len(pcm) - span + 1, hop):
        vector = embedder.embed(pcm[start : start + span])
        if vector is None:
            continue
        norm = float(np.linalg.norm(vector)) * profile_norm
        if norm <= 0.0:
            continue
        score = float(np.dot(vector, profile) / norm)
        if math.isfinite(score):
            rows.append(((start + span // 2) / (RATE * 2), score))
    return rows


def keep_own_segments(
    segments: Sequence[Dict[str, Any]],
    pcm: bytes,
    profile: np.ndarray,
    embedder: Any,
    *,
    floor: float = FOREIGN_BELOW,
) -> Dict[str, Any]:
    """The segments that are the kept voice, and how many were dropped.

    Each segment is judged by the median score of the windows covering it: a
    distribution instead of one sample. A segment with no window inside it —
    shorter than the window, or outside the take — is kept, because an answer
    of "no" needs evidence.
    """
    covered = window_scores(pcm, profile, embedder)
    kept: List[Dict[str, Any]] = []
    dropped = 0
    for segment in segments:
        try:
            start = float(segment.get("start") or 0.0)
            end = float(segment.get("end") or 0.0)
        except (TypeError, ValueError):
            kept.append(segment)
            continue
        inside = [score for centre, score in covered if start <= centre <= end]
        if not inside:
            kept.append(segment)
            continue
        if float(np.median(inside)) >= floor:
            kept.append(segment)
        else:
            dropped += 1
    return {"segments": kept, "dropped": dropped}
