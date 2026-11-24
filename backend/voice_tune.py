"""A whole take scored window by window, so the owner can see the split.

Solo's thresholds used to be somebody else's numbers: measured on one desk,
written into the source, and then defended in prose while a user asked, over
and over, whether their own room could work. The answer is not a better
constant. It is the user dragging two lines over their own recordings until
the strip shows their voice kept and the other one cut.

Everything here is the gate's own arithmetic - the same 2 s window, the same
cosine, the same near-field level - so what the tuner draws is what the gate
will do, not an approximation of it.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

import numpy as np

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ, pcm16_bytes_per_sec
from backend.voice_embed import cosine, unit_vectors
from backend.voice_mask import DEFAULT_WINDOW_MS
from backend.voice_enrol import HOP_MS

#: How many windows one picture may hold. A ten-minute take at a one-second hop
#: is 600 bars in a strip 600 px wide: one bar per pixel, and the net spending
#: half a minute to draw it. Past this the take is thinned evenly, which keeps
#: the shape of the split - and the tuner's job is the shape.
MAX_TUNE_WINDOWS = 240


def _level_db(window: bytes) -> float:
    samples = np.frombuffer(window, dtype="<i2").astype(np.float64) / 32768.0
    if samples.size == 0:
        return 0.0
    rms = float(np.sqrt(np.mean(samples**2)))
    return 20.0 * float(np.log10(rms)) if rms > 0.0 else 0.0


def window_starts(
    nbytes: int,
    *,
    window_ms: int = DEFAULT_WINDOW_MS,
    hop_ms: int = HOP_MS,
    limit: int = MAX_TUNE_WINDOWS,
) -> List[int]:
    """Byte offsets of every window the tuner will score, evenly thinned."""
    window = window_ms * pcm16_bytes_per_sec(LIVE_SAMPLE_RATE_HZ) // 1000
    hop = hop_ms * pcm16_bytes_per_sec(LIVE_SAMPLE_RATE_HZ) // 1000
    usable = nbytes - (nbytes % 2)
    if usable < window:
        return []
    starts = list(range(0, usable - window + 1, max(1, hop)))
    if len(starts) > limit:
        picks = np.linspace(0, len(starts) - 1, limit).round().astype(int)
        starts = [starts[i] for i in sorted({int(p) for p in picks.tolist()})]
    return starts


def score_take(
    embedder,
    profile_vector: Sequence[float],
    pcm: bytes,
    *,
    near_level_db: float = 0.0,
    near_margin_db: float = 12.0,
    window_ms: int = DEFAULT_WINDOW_MS,
    hop_ms: int = HOP_MS,
) -> List[Dict[str, float]]:
    """One entry per window: where it starts, what it scored, how loud it was.

    ``far`` is the gate's own level rule, precomputed: a window this quiet is
    withheld whatever it scores, and a picture that hid that would send the
    owner tuning a number that is not in charge.
    """
    window = window_ms * pcm16_bytes_per_sec(LIVE_SAMPLE_RATE_HZ) // 1000
    starts = window_starts(len(pcm), window_ms=window_ms, hop_ms=hop_ms)
    if not starts:
        return []
    windows = [pcm[start : start + window] for start in starts]
    vectors = unit_vectors(embedder, windows)
    reference = np.asarray(profile_vector, dtype=np.float64)
    norm = float(np.linalg.norm(reference))
    if norm <= 0.0:
        return []
    reference = reference / norm
    rows: List[Dict[str, float]] = []
    for start, vector, chunk in zip(starts, vectors, windows):
        level = _level_db(chunk)
        rows.append(
            {
                "start_ms": round(start * 1000 / pcm16_bytes_per_sec(LIVE_SAMPLE_RATE_HZ)),
                "score": round(cosine(vector, reference), 4),
                "level_db": round(level, 1) if level else 0.0,
                "far": bool(
                    near_level_db > 0.0
                    and level != 0.0
                    and level < near_level_db - near_margin_db
                ),
            }
        )
    return rows


__all__ = ["MAX_TUNE_WINDOWS", "score_take", "window_starts"]
