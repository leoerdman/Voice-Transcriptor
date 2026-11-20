"""Sber GigaAM-v3 ASR engine — Russian-only local transcription.

Why an adapter: ``transcribe_audio`` is the SSOT entry point used by
file jobs, live assist and recovery paths. Faster-whisper stays the
default engine; models whose id starts with the catalog prefix
``gigaam-`` dispatch here.

Contract with upstream (github.com/salute-developers/GigaAM):
* ``gigaam.load_model("<v3_e2e_rnnt|v3_rnnt>")`` — weights download on
  first use into the package's own cache;
* ``model.transcribe(path, word_timestamps=True)`` accepts **≤25 s** of
  audio — anything longer is sliced here into sequential chunks and
  stitched back by absolute time;
* results expose ``.text`` and, with timestamps, ``.words[i].start/end/
  text`` — mapped onto the same segment/word shape faster-whisper
  produces so every downstream consumer (live trim, coverage math,
  frontend merge) works unchanged.

The engine is Russian-only: the language parameter is accepted for
signature compatibility and pinned to ru semantics upstream.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import OrderedDict
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
import soundfile as sf

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.transcribe import _env_int

logger = logging.getLogger(__name__)

# Upstream hard limit is 25 s; stay clear of it so encoder padding and
# rounding never push a request past the boundary.
GIGAAM_MAX_CHUNK_SEC = 20.0
# Sequential chunks overlap so a word straddling a cut is decoded whole
# by at least one chunk; the stitcher then keeps the best (longest)
# copy and drops truncated fragments and duplicates.
GIGAAM_CHUNK_OVERLAP_SEC = 1.2
# Two word timings closer than this are the same word seen from two
# chunks; anything less is RNNT boundary jitter between distinct words.
GIGAAM_WORD_DEDUPE_EPSILON_SEC = 0.05

_MODEL_CACHE: "OrderedDict[str, Any]" = OrderedDict()
# Per-model locks (SSOT with backend/transcribe.py's documented policy):
# loading model A must not serialise with loading model B — the single
# global lock that sat here made the first v3_rnnt load block a
# concurrent v3_e2e_rnnt load for the whole multi-second weight read.
#
# ``_MODEL_LOCKS_GUARD`` guards the lock registry AND every read or write
# of ``_MODEL_CACHE``, held only for the dict operation itself (never
# across a load). The cache used to be mutated under the per-model lock
# and read under the guard — two locks for one dict — so two loads of
# different models could both pass the cap check and evict each other's
# fresh model (BE-24).
_MODEL_LOCKS_GUARD = threading.Lock()
_MODEL_LOCKS: "dict[str, threading.Lock]" = {}

# Max simultaneously-resident GigaAM models. Torch weights are large
# (~1 GB each); a user who tried both catalog entries must not keep both
# resident forever — mirror the whisper-side LRU policy
# (backend/transcribe.py ``_MODEL_CACHE_MAX``) with a tighter default.
# ``_env_int``, not a bare ``int()``: the house policy for bad
# environment input is "warn and use the documented default", and it is
# already implemented once, next to the whisper cache bound this one
# mirrors. A bare int() made a typo in this variable a ValueError at
# import — i.e. the GigaAM engine unavailable, reported as an import
# failure with no mention of the variable.
_GIGAAM_CACHE_MAX = max(1, _env_int("TRANSCRIPTOR_GIGAAM_CACHE_SIZE", 1))

def gigaam_import_error() -> Optional[str]:
    """Return why the engine is unavailable, or None when usable.

    The answer is computed fresh each time and returned. It used to be
    stashed in a module global first — one that nothing ever read, and
    that was never cleared when a later import succeeded, so the only
    thing the global could have done was answer a stale question.
    """
    try:
        import gigaam  # noqa: F401
        return None
    except Exception as e:  # pragma: no cover - environment-dependent
        return f"{type(e).__name__}: {e}"


def _model_lock(model_id: str) -> threading.Lock:
    """One lock per model id: same-name loads serialise, cross-name
    loads stay parallel. The guard dict itself is only touched under
    ``_MODEL_LOCKS_GUARD``."""
    with _MODEL_LOCKS_GUARD:
        lock = _MODEL_LOCKS.get(model_id)
        if lock is None:
            lock = threading.Lock()
            _MODEL_LOCKS[model_id] = lock
        return lock


def _load_model(model_id: str) -> Any:
    with _model_lock(model_id):
        with _MODEL_LOCKS_GUARD:
            model = _MODEL_CACHE.get(model_id)
            if model is not None:
                # LRU bookkeeping: a hit promotes the entry to most-
                # recently-used so the eviction below always drops the
                # coldest model.
                _MODEL_CACHE.move_to_end(model_id)
                return model
        import gigaam

        upstream_name = model_id.removeprefix("gigaam-").replace("-", "_")
        logger.info("gigaam: loading %s (upstream name %s)", model_id, upstream_name)
        model = gigaam.load_model(upstream_name)
        with _MODEL_LOCKS_GUARD:
            _MODEL_CACHE[model_id] = model
            _MODEL_CACHE.move_to_end(model_id)
            evicted = []
            while len(_MODEL_CACHE) > _GIGAAM_CACHE_MAX:
                evicted.append(_MODEL_CACHE.popitem(last=False)[0])
        for evicted_id in evicted:
            logger.info(
                "gigaam: evicted %s from cache (cap=%d)",
                evicted_id, _GIGAAM_CACHE_MAX,
            )
        return model


def release_gigaam(model_id: str) -> bool:
    """Drop one GigaAM model from the resident cache.

    The release point ``backend.transcribe`` needs. ``model_is_resident``
    already reaches into this cache to answer "is it loaded", while both
    releasing functions knew only about the whisper cache — so the
    heaviest engine in the app (a ~1 GB torch model) was the one thing
    the idle-unload window could never reclaim, and the deletion of a
    model's weights left its instance serving transcriptions.
    """
    with _MODEL_LOCKS_GUARD:
        dropped = _MODEL_CACHE.pop(model_id, None) is not None
    if dropped:
        logger.info("gigaam: released %s from cache", model_id)
    return dropped


def resident_gigaam_models() -> list:
    """The GigaAM model ids currently held in memory."""
    with _MODEL_LOCKS_GUARD:
        return list(_MODEL_CACHE)


def warm_gigaam(model_id: str) -> None:
    """Preload the engine weights without running inference.

    Part of the model-catalog warmup contract (``backend.transcribe.
    warm_model`` dispatches here for ``gigaam-`` ids): the download +
    load cost must land on the warmup call, not on the first utterance.
    """
    _load_model(model_id)


def _write_wav(audio_16k_mono: np.ndarray) -> Path:
    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.close()
    path = Path(handle.name)
    try:
        sf.write(
            str(path),
            np.asarray(audio_16k_mono, dtype=np.float32),
            LIVE_SAMPLE_RATE_HZ,
            subtype="PCM_16",
        )
    except BaseException:
        # The file EXISTS from the moment NamedTemporaryFile returns, so
        # a write that raises (disk full, a bad dtype) leaves it behind
        # with no caller holding a path to unlink — and it does not match
        # this project's ``.tmp-<hex>`` convention, so no sweeper finds
        # it either. One zero-byte file in the system temp per failure.
        path.unlink(missing_ok=True)
        raise
    return path


def _chunk_bounds(total_sec: float) -> list[tuple[float, float]]:
    if total_sec <= GIGAAM_MAX_CHUNK_SEC:
        return [(0.0, total_sec)]
    bounds: list[tuple[float, float]] = []
    t = 0.0
    while t < total_sec - 1e-6:
        end = min(t + GIGAAM_MAX_CHUNK_SEC, total_sec)
        bounds.append((t, end))
        if end >= total_sec - 1e-6:
            break
        # The next chunk starts one overlap back from where this one
        # ended — NOT one fixed step from where it started, which is
        # what a ``step`` variable computed here and never used would
        # have implied. The two differ on the last chunk, which is short.
        t = end - GIGAAM_CHUNK_OVERLAP_SEC
    return bounds


def _merge_overlapping_words(chunk_word_lists: list[list[dict]]) -> list[dict]:
    """Stitch absolute-time words across overlapped chunks.

    A word cut by a chunk boundary is decoded whole by at least one of
    the overlapping chunks; truncated fragments and re-decoded copies
    overlap it in time. Greedy accept in (start, longest-duration) order
    keeps the best copy and drops everything temporally overlapping an
    already-accepted word. Words that merely touch (end == next start)
    are distinct and survive the epsilon guard.
    """
    tagged: list[tuple[float, float, float, int, dict]] = []
    for chunk_idx, words in enumerate(chunk_word_lists):
        for w in words:
            w["_chunk"] = chunk_idx
            start = float(w["start"])
            end = float(w["end"])
            tagged.append((start, -(end - start), end, chunk_idx, w))
    # (start, -duration) sorts full words ahead of truncated copies at
    # the same onset; the trailing end/chunk_idx keep the sort total.
    tagged.sort(key=lambda t: (t[0], t[1], t[2], t[3]))

    # Accepted words are kept sorted by start. A candidate can only
    # overlap words that START inside [start - max_word_len, end]; the
    # max word length is bounded by the chunk length, which bounds the
    # bisect window and keeps the stitch near-linear in practice.
    accepted_starts: list[float] = []
    accepted_ends: list[float] = []
    accepted: list[dict] = []
    for start, _neg, end, _idx, w in tagged:
        lo = bisect_left(accepted_starts, start - GIGAAM_MAX_CHUNK_SEC)
        hi = bisect_right(accepted_starts, end)
        overlap = False
        for i in range(lo, hi):
            a_start = accepted_starts[i]
            a_end = accepted_ends[i]
            if min(a_end, end) - max(a_start, start) > GIGAAM_WORD_DEDUPE_EPSILON_SEC:
                overlap = True
                break
        if overlap:
            continue
        pos = bisect_left(accepted_starts, start)
        accepted.insert(pos, w)
        accepted_starts.insert(pos, start)
        accepted_ends.insert(pos, end)
    return accepted


def _words_from_result(result: Any, offset: float) -> list[dict]:
    words = getattr(result, "words", None)
    if not words:
        return []
    out: list[dict] = []
    for w in words:
        try:
            w_start = float(w.start) + offset
            w_end = float(w.end) + offset
            text = str(getattr(w, "text", "") or "").strip()
        except Exception:
            continue
        if not text or w_end <= w_start:
            continue
        # faster-whisper word convention (the shape this adapter promises):
        # the segment's first token is bare, every later token carries a
        # LEADING space. Upstream GigaAM strips token text, so rebuild the
        # convention here — live trim (backend/live.py) reconstructs
        # trimmed segment text by plain concatenation and every other
        # consumer (frontend merge, text-match) normalises on top of it.
        out.append({
            "word": text if not out else f" {text}",
            "start": round(w_start, 3),
            "end": round(w_end, 3),
        })
    return out


def transcribe_gigaam(
    audio_16k_mono: np.ndarray,
    model_id: str,
    word_timestamps: bool = True,
) -> Dict[str, Any]:
    """Transcribe 16 kHz mono float32 PCM with a GigaAM-v3 model.

    Return shape matches :func:`backend.transcribe.transcribe_audio`
    (segments with absolute times; ``words`` when requested) so callers
    need no engine branching beyond dispatch.
    """
    if audio_16k_mono.ndim == 2 and audio_16k_mono.shape[1] == 1:
        audio_16k_mono = audio_16k_mono[:, 0]
    audio = np.ascontiguousarray(audio_16k_mono, dtype=np.float32)
    total_sec = len(audio) / float(LIVE_SAMPLE_RATE_HZ)
    if total_sec <= 0:
        # Same full result contract as the normal path below: callers
        # read ``text``/``language_probability`` directly (BUG-38 class),
        # so an early return may not omit them.
        return {
            "segments": [],
            "language": "ru",
            "language_probability": 1.0,
            "duration": 0.0,
            "text": "",
        }

    model = _load_model(model_id)
    bounds = _chunk_bounds(total_sec)
    chunk_word_lists: list[list[dict]] = []
    chunk_texts: list[str] = []
    for start, end in bounds:
        lo = int(start * LIVE_SAMPLE_RATE_HZ)
        hi = int(end * LIVE_SAMPLE_RATE_HZ)
        chunk_path = _write_wav(audio[lo:hi])
        try:
            result = model.transcribe(str(chunk_path), word_timestamps=True)
        finally:
            try:
                chunk_path.unlink(missing_ok=True)
            except OSError:
                pass
        # Words are requested from the model UNCONDITIONALLY (they
        # are cheap for RNNT): the stitcher needs absolute times to
        # dedupe the overlapped chunk boundaries even when the
        # caller asked for text only.
        chunk_word_lists.append(_words_from_result(result, offset=start))
        chunk_texts.append(str(getattr(result, "text", "") or "").strip())

    accepted = _merge_overlapping_words(chunk_word_lists)
    by_chunk: dict[int, list[dict]] = {}
    for w in accepted:
        by_chunk.setdefault(w.pop("_chunk"), []).append(w)

    segments: list[dict[str, Any]] = []
    for idx, owned in by_chunk.items():
        seg_text = "".join(str(w["word"]) for w in owned).strip()
        if not seg_text:
            continue
        segments.append({
            "start": owned[0]["start"],
            "end": max(float(w["end"]) for w in owned),
            "text": seg_text,
            **({"words": owned} if word_timestamps else {}),
        })
    # Defensive: a chunk that returned text but no word timings cannot
    # take part in time-based dedupe. Its verbatim text INCLUDES the
    # 1.2 s overlap already covered by the neighbours' accepted words,
    # so keeping it next to word-bearing segments duplicates the seam
    # (BUG-55). The fallback is therefore only meaningful when NO chunk
    # produced usable words — a words-less engine response — and is
    # dropped as seam noise whenever any accepted words exist.
    if not by_chunk:
        for idx, text in enumerate(chunk_texts):
            if text:
                start, end = bounds[idx]
                segments.append({
                    "start": round(start, 3),
                    "end": round(min(end, total_sec), 3),
                    "text": text,
                })
    segments.sort(key=lambda seg: float(seg["start"]))

    # Full transcribe_audio result contract: callers read ``text`` and
    # ``language_probability`` directly (sync route, jobs, telemetry), so
    # the adapter must carry them exactly like ``_build_result`` does —
    # not leave them to ``.get()``-shaped Nones downstream.
    joined_text = " ".join(
        str(seg["text"]) for seg in segments if seg.get("text")
    ).strip()
    return {
        "segments": segments,
        "language": "ru",
        # The engine is Russian-only by design: the language decision is
        # deterministic, hence probability 1.0 (whisper semantics).
        "language_probability": 1.0,
        "duration": round(total_sec, 3),
        "text": joined_text,
    }
