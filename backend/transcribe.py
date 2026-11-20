"""Local Whisper transcription: audio array → segments + text.

Thread-safe model cache, empty-sequence error handling, stereo channel merge.
"""

import logging
import os
import sys
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf
# WhisperModel is imported lazily inside `_model()` so the faster_whisper
# cold-import (ctranslate2 + tokenizers + huggingface_hub, ~1 s) does NOT
# block backend startup. /api/health becomes responsive seconds earlier,
# and any crash-restart loop pays the import only on first transcription.
from backend.audio_constants import LIVE_PCM_BYTES_PER_SEC, LIVE_SAMPLE_RATE_HZ
from backend.model_catalog import GIGAAM_MODEL_PREFIX

logger = logging.getLogger(__name__)

# Per-model locks: loading model A must not serialise with loading
# model B. A global lock caused a first-time large-v3 request to block
# every concurrent transcription (even for already-loaded models) for
# the 10+ seconds of the large model load. Double-checked locking: fast
# path reads the cache dict directly (atomic under the GIL), slow path
# acquires a per-name lock to prevent duplicate loads of the SAME model.
#
# LRU eviction: without a size cap, a user who switches between
# tiny/base/small/medium/large-v3 (5 models) keeps ~5 GB resident in
# RSS forever, which OOM-kills on 8 GB hosts. We use an OrderedDict
# so `move_to_end` on hit promotes the model to most-recently-used
# in a single atomic op (OrderedDict ops hold the GIL for the call's
# duration → no torn state for concurrent readers) and evictions on
# insert pop the LRU entry. Cap defaulted at 2 — most real users
# stabilise on at most 2 hot models (fast + accurate); one env var
# override for power users.
_MODEL_LOCK = threading.Lock()  # Guards name→lock registry + cache mutations.
_MODEL_NAME_LOCKS: Dict[str, threading.Lock] = {}
_MODEL_CACHE: "OrderedDict[str, WhisperModel]" = OrderedDict()
_MODEL_WARM_STATE: Dict[str, Dict[str, float]] = {}
# monotonic timestamp of the last `_model()` hand-out per model name.
# Guarded by _MODEL_LOCK together with the cache itself.
_MODEL_LAST_USED: Dict[str, float] = {}
_CPU_COUNT = max(1, os.cpu_count() or 1)


def _env_int(name: str, default: int) -> int:
    """Parse an integer env var with graceful fallback — the backend's one
    parser for it (``main`` and ``transcribe_gigaam`` import this; BE-22).

    A non-numeric value (e.g. ``TRANSCRIPTOR_RESULT_RETENTION_SEC=1h``)
    would otherwise crash module import with ValueError before FastAPI
    ever starts, and Electron would see the backend child die repeatedly
    with no diagnostic. Degrade to the documented default with a warning
    so the backend boots and the misconfiguration is visible in the log.
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("invalid integer env %s=%r; using default=%d", name, raw, default)
        return default


def _cpu_threads() -> int:
    """Whisper's CPU thread count: the user's explicit choice, else a default.

    The default is half the cores, kept within 4..8. An explicit
    ``TRANSCRIPTOR_WHISPER_CPU_THREADS`` is honoured as given (at least
    one): the outer ``max(4, …)`` used to apply to it too, so a user who
    set 2 to keep the machine responsive silently got 4 (BE-22).
    """
    explicit = os.environ.get("TRANSCRIPTOR_WHISPER_CPU_THREADS")
    if explicit is not None and explicit.strip():
        return max(1, _env_int("TRANSCRIPTOR_WHISPER_CPU_THREADS", 4))
    return max(4, min(8, _CPU_COUNT // 2))


_DEFAULT_CPU_THREADS = _cpu_threads()
_DEFAULT_NUM_WORKERS = max(
    1,
    min(3, _env_int("TRANSCRIPTOR_WHISPER_NUM_WORKERS", 2 if _CPU_COUNT >= 8 else 1)),
)
# Max simultaneously-resident Whisper models. 2 fits typical
# dual-purpose usage (e.g. small for speed + medium for accuracy)
# while capping worst-case RSS at ~2 GB (small + medium int8). Bumping
# past 3 is unsafe on 8 GB hosts.
_MODEL_CACHE_MAX = max(1, _env_int("TRANSCRIPTOR_WHISPER_CACHE_SIZE", 2))
# Idle unload. A resident `small` model pins ~700 MB (weights +
# ctranslate2 arenas + the Silero VAD session) for the whole process
# lifetime. The LRU cap alone never releases anything when the user
# stops transcribing, so a single local transcription made the app
# carry that footprint until quit. Drop a model that has not served a
# request for this many seconds; the next request pays one reload
# (~3-9 s for `small`, already off the interactive path via the
# renderer's warmup call). 0 or negative disables the sweeper.
_MODEL_IDLE_UNLOAD_SEC = _env_int("TRANSCRIPTOR_WHISPER_IDLE_UNLOAD_SEC", 600)
_MODEL_IDLE_SWEEP_INTERVAL_SEC = 60
_idle_sweeper_thread: Optional[threading.Thread] = None


def _is_empty_sequence_transcribe_error(exc: Exception) -> bool:
    msg = str(exc or "").lower()
    # 1.1.25: cover BOTH Python wordings of the same error.
    # • Python <=3.11 / faster-whisper raises:
    #     "max() arg is an empty sequence"
    # • Python 3.12+ raises:
    #     "max() iterable argument is empty"
    # Previously matched only the 3.11 form, so on Python 3.12 (the
    # bundled runtime), the warm probe (which intentionally feeds
    # a silent buffer) re-raised this signature instead of returning
    # an empty result, producing a spurious stack trace in main.log
    # on every cold start.
    if "max()" not in msg:
        return False
    return ("empty sequence" in msg) or ("iterable argument is empty" in msg)


# A WAV this small holds no decodable audio: a 44-byte RIFF header plus
# a handful of samples. Named because the number decided the same thing
# in two places, and moved ABOVE the model load because paying up to a
# 3 GB model load to be told a 12-byte file is empty is the whole cost
# of asking in the wrong order.
_MIN_DECODABLE_WAV_BYTES = 64


def _undecodable_wav_result(path: str) -> Optional[Dict[str, Any]]:
    """An empty result for a WAV too small to decode, else ``None``.

    Reports the file's REAL duration rather than a hard 0.0: the two
    file entry points returned zero while ``transcribe_audio`` computed
    it, so the same empty recognition described a different recording
    depending on which door it came through.
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    if size > _MIN_DECODABLE_WAV_BYTES:
        return None
    return _empty_transcribe_result(size / float(LIVE_PCM_BYTES_PER_SEC))


def _empty_transcribe_result(duration: float = 0.0) -> Dict[str, Any]:
    return {
        "language": None,
        "language_probability": 0.0,
        "duration": float(duration or 0.0),
        "segments": [],
        "text": "",
    }


def _model(model_name: str) -> "WhisperModel":
    from faster_whisper import WhisperModel
    # CPU default tuned for typical laptops.
    # Fast path: hot cache hit with no lock held (dict reads are
    # atomic under the GIL). Prevents parallel users of model A from
    # blocking on a concurrent first-time load of model B.
    m = _MODEL_CACHE.get(model_name)
    if m is not None:
        # Promote to MRU so the oldest idle model gets evicted first
        # when a new one is loaded. `move_to_end` is a single atomic
        # C-call under the GIL — safe concurrently with other readers,
        # no torn state. Two threads both promoting the same key is
        # idempotent (both land it at the end).
        try:
            _MODEL_CACHE.move_to_end(model_name)
        except KeyError:
            # Concurrent eviction dropped this model between `get` and
            # `move_to_end` — the caller still holds a reference, so
            # their transcription succeeds; the next call reloads.
            pass
        _touch_model(model_name)
        return m
    # Per-name lock registry. The registry dict itself is guarded by
    # _MODEL_LOCK so two callers can't race to create the per-name lock.
    with _MODEL_LOCK:
        per_lock = _MODEL_NAME_LOCKS.setdefault(model_name, threading.Lock())
    # Slow path: serialise only duplicate loads of the SAME model.
    with per_lock:
        m = _MODEL_CACHE.get(model_name)
        if m is not None:
            try:
                _MODEL_CACHE.move_to_end(model_name)
            except KeyError:
                pass
            _touch_model(model_name)
            return m
        started = time.perf_counter()
        m = WhisperModel(
            model_name,
            device="cpu",
            compute_type="int8",
            cpu_threads=_DEFAULT_CPU_THREADS,
            num_workers=_DEFAULT_NUM_WORKERS,
        )
        # Insert + LRU eviction under the global lock. Without the lock
        # two concurrent slow-path loads (for different model names)
        # could both observe `len < MAX` and both insert, transiently
        # breaching the cap. Holding `_MODEL_LOCK` briefly here is
        # harmless — we do NOT hold it during the `WhisperModel(...)`
        # load above (that's the per-name lock's job).
        with _MODEL_LOCK:
            _MODEL_CACHE[model_name] = m
            _MODEL_LAST_USED[model_name] = time.monotonic()
            while len(_MODEL_CACHE) > _MODEL_CACHE_MAX:
                # Pop from the FRONT (oldest insertion / least-recently
                # promoted). Dropping the reference frees the
                # ctranslate2 model; callers that still hold the
                # reference finish their transcription, then the GC
                # reclaims once their ref drops too.
                evicted_name, _evicted_model = _MODEL_CACHE.popitem(last=False)
                # Keep warm-state dict in sync — otherwise a user who
                # loads the evicted model again sees stale warm stats
                # that don't correspond to the fresh instance.
                _MODEL_WARM_STATE.pop(evicted_name, None)
                _MODEL_LAST_USED.pop(evicted_name, None)
                logger.info(
                    "whisper model evicted: model=%s (cache_size=%d, cap=%d)",
                    evicted_name, len(_MODEL_CACHE), _MODEL_CACHE_MAX,
                )
        logger.info(
            "whisper model loaded: model=%s cpu_threads=%d num_workers=%d load_ms=%d",
            model_name,
            _DEFAULT_CPU_THREADS,
            _DEFAULT_NUM_WORKERS,
            int((time.perf_counter() - started) * 1000),
        )
        return m


def _touch_model(model_name: str) -> None:
    """Record that ``model_name`` was just handed to a caller.

    Called on every cache hit and on insert. The idle sweeper reads
    these timestamps to decide what may be released. Cheap enough for
    the hot path: one dict store under a lock held for a single
    statement.
    """
    with _MODEL_LOCK:
        # GigaAM ids are recorded too: their weights live in the other
        # engine's cache, but the idle window is one policy for both and
        # ``release_idle_models`` needs an age for anything it may drop.
        if model_name in _MODEL_CACHE or model_name.startswith(GIGAAM_MODEL_PREFIX):
            _MODEL_LAST_USED[model_name] = time.monotonic()


def _gigaam_module():
    """The GigaAM adapter IF it has already been imported, else ``None``.

    Never imports it: the whole point of the lazy engine is that a user
    who does not run GigaAM never pays for its (torch) import, and a
    residency or release question must not be what triggers it. A module
    that was never imported holds no models, which is the correct answer
    to both questions.
    """
    return sys.modules.get("backend.transcribe_gigaam")


def model_is_resident(model_name: str) -> bool:
    """True when ``model_name`` is loaded right now.

    ``warm_state`` alone is not proof of residency: the idle sweeper
    drops the model but callers may still hold a stale warm record, so
    the warmup endpoint must consult this before short-circuiting.
    """
    if model_name.startswith(GIGAAM_MODEL_PREFIX):
        # The GigaAM engine keeps its own cache and is only importable
        # when the optional stack is installed. Importing it here just
        # to answer a residency question would defeat the purpose of
        # lazy loading, so treat "module never imported" as "not
        # resident" without touching sys.modules ordering.
        module = _gigaam_module()
        if module is None:
            return False
        return model_name in module.resident_gigaam_models()
    with _MODEL_LOCK:
        return model_name in _MODEL_CACHE


def release_model(model_name: str) -> bool:
    """Drop one model from the resident cache. Returns True if it was there.

    Used when the model's weights are removed from disk: leaving the
    loaded instance in memory would keep serving transcriptions for a
    model the rest of the app reports as absent.
    """
    if model_name.startswith(GIGAAM_MODEL_PREFIX):
        # The same dispatch ``model_is_resident`` makes. Without it this
        # function answered "it was not loaded" for a model that was,
        # and the deleted-from-disk model kept serving transcriptions.
        module = _gigaam_module()
        existed = bool(module and module.release_gigaam(model_name))
        with _MODEL_LOCK:
            _MODEL_LAST_USED.pop(model_name, None)
            _MODEL_WARM_STATE.pop(model_name, None)
        if existed:
            logger.info("gigaam model released on request: model=%s", model_name)
        return existed
    with _MODEL_LOCK:
        existed = _MODEL_CACHE.pop(model_name, None) is not None
        _MODEL_LAST_USED.pop(model_name, None)
        _MODEL_WARM_STATE.pop(model_name, None)
    if existed:
        logger.info("whisper model released on request: model=%s", model_name)
    return existed


def release_idle_models(now: Optional[float] = None) -> List[str]:
    """Drop every cached model idle for longer than the unload window.

    Returns the names released. Dropping the ``OrderedDict`` reference
    is enough: an in-flight transcription still holds its own reference
    and finishes normally, and the ctranslate2 allocation is reclaimed
    once that reference goes away.
    """
    if _MODEL_IDLE_UNLOAD_SEC <= 0:
        return []
    stamp = time.monotonic() if now is None else now
    gigaam = _gigaam_module()
    released: List[str] = []
    gigaam_expired: List[str] = []
    # Snapshotted BEFORE ``_MODEL_LOCK``: the GigaAM cache has its own
    # lock, and taking one while holding the other is how two locks
    # become a deadlock — the rule restated just below, which this read
    # used to break (BE-24).
    gigaam_resident = gigaam.resident_gigaam_models() if gigaam is not None else []
    with _MODEL_LOCK:
        # BOTH engines. ``model_is_resident`` already knew about the
        # GigaAM cache while this function did not, so the ~1 GB torch
        # model — the heaviest thing this app loads, and the reason
        # ``_MODEL_IDLE_UNLOAD_SEC`` exists — was the one model that
        # never came back out of memory until the process exited.
        resident = list(_MODEL_CACHE.keys())
        resident.extend(gigaam_resident)
        for name in resident:
            last = _MODEL_LAST_USED.get(name)
            if last is None:
                # No timestamp recorded (model inserted by an older code
                # path) — stamp it now rather than releasing a model we
                # cannot age, so the next sweep can decide on real data.
                _MODEL_LAST_USED[name] = stamp
                continue
            if stamp - last < _MODEL_IDLE_UNLOAD_SEC:
                continue
            _MODEL_LAST_USED.pop(name, None)
            _MODEL_WARM_STATE.pop(name, None)
            if name.startswith(GIGAAM_MODEL_PREFIX):
                gigaam_expired.append(name)
            else:
                _MODEL_CACHE.pop(name, None)
            released.append(name)
    # Outside ``_MODEL_LOCK``: the GigaAM cache has its own lock, and
    # taking one while holding the other is how two locks become a
    # deadlock.
    for name in gigaam_expired:
        if gigaam is not None:
            gigaam.release_gigaam(name)
    for name in released:
        logger.info(
            "%s model released after %ds idle: model=%s",
            "gigaam" if name.startswith(GIGAAM_MODEL_PREFIX) else "whisper",
            _MODEL_IDLE_UNLOAD_SEC,
            name,
        )
    return released


def start_idle_model_sweeper() -> None:
    """Start the background idle-unload sweeper exactly once.

    Idempotent: repeated calls (test harnesses re-entering the FastAPI
    lifespan, uvicorn reload) do not stack threads.
    """
    global _idle_sweeper_thread
    if _MODEL_IDLE_UNLOAD_SEC <= 0:
        return
    with _MODEL_LOCK:
        if _idle_sweeper_thread is not None and _idle_sweeper_thread.is_alive():
            return

        def _sweep() -> None:
            while True:
                time.sleep(_MODEL_IDLE_SWEEP_INTERVAL_SEC)
                try:
                    release_idle_models()
                except Exception:
                    logger.exception("idle model sweep failed")

        _idle_sweeper_thread = threading.Thread(
            target=_sweep, daemon=True, name="whisper-idle-unload"
        )
        _idle_sweeper_thread.start()


def _probe_tone(seconds: float = 0.5) -> np.ndarray:
    """Deterministic low-level tone used to warm the decode path.

    Silence is not enough: with ``vad_filter=True`` the VAD discards a
    silent buffer before the encoder ever runs, so a silence-only probe
    warms the VAD model but leaves the first *real* inference paying the
    encoder/decoder initialisation cost. A quiet tone passes the VAD gate
    and forces that work to happen off the critical path.
    """
    n = max(1, int(seconds * LIVE_SAMPLE_RATE_HZ))
    t = np.arange(n, dtype=np.float32) / float(LIVE_SAMPLE_RATE_HZ)
    return (0.05 * np.sin(2.0 * np.pi * 220.0 * t)).astype(np.float32)


def warm_model(model_name: str, probe: bool = False) -> Dict[str, float]:
    started = time.perf_counter()
    # Engine dispatch (same SSOT branch as transcribe_audio/transcribe_file):
    # warmup is part of the model-catalog contract, so gigaam ids must warm
    # the GigaAM engine instead of reaching WhisperModel.
    if model_name.startswith(GIGAAM_MODEL_PREFIX):
        from backend.transcribe_gigaam import warm_gigaam

        warm_gigaam(model_name)
        # ``_model()`` records the whisper side; the GigaAM adapter has
        # no view of the idle window, so warming is recorded here. Left
        # unrecorded, a warmed model reached the sweeper with no age and
        # spent one whole window being stamped instead of aged.
        _touch_model(model_name)
    else:
        _model(model_name)
    load_ms = int((time.perf_counter() - started) * 1000)
    probe_ms = 0
    if probe:
        probe_started = time.perf_counter()
        # Two passes, because the two costly lazy initialisations sit on
        # different code paths: the Silero VAD model is loaded on the
        # first ``vad_filter=True`` call, the encoder/decoder kernels on
        # the first call that actually reaches the model.
        for kwargs in (
            {"audio": np.zeros((LIVE_SAMPLE_RATE_HZ,), dtype=np.float32), "vad_filter": True},
            {"audio": _probe_tone(), "vad_filter": False},
        ):
            try:
                transcribe_audio(
                    kwargs["audio"],
                    model_name,
                    language=None,
                    vad_filter=bool(kwargs["vad_filter"]),
                    word_timestamps=False,
                    beam_size=1,
                    best_of=1,
                )
            except Exception:
                logger.exception(
                    "whisper warm probe failed: model=%s vad=%s",
                    model_name,
                    kwargs["vad_filter"],
                )
        probe_ms = int((time.perf_counter() - probe_started) * 1000)
    state = {
        "loaded_ms": float(load_ms),
        "probe_ms": float(probe_ms),
        "warmed_at": float(time.time()),
    }
    with _MODEL_LOCK:
        _MODEL_WARM_STATE[model_name] = state
    return state


def warm_state(model_name: str) -> Dict[str, float]:
    with _MODEL_LOCK:
        return dict(_MODEL_WARM_STATE.get(model_name) or {})


def _build_result(
    segments,
    info,
    word_timestamps: bool,
) -> Dict[str, Any]:
    """Convert faster-whisper segment iterator + info into a result dict.

    Shared by both transcribe_audio and transcribe_file to avoid duplication.
    """
    out_segments: List[Dict[str, Any]] = []
    text_parts: List[str] = []
    for s in segments:
        seg: Dict[str, Any] = {
            "start": float(s.start),
            "end": float(s.end),
            "text": (s.text or "").strip(),
        }
        words = getattr(s, "words", None)
        if word_timestamps and words:
            seg["words"] = [
                {
                    "start": float(w.start),
                    "end": float(w.end),
                    "word": w.word,
                    "prob": float(w.probability) if w.probability is not None else None,
                }
                for w in words
            ]
        out_segments.append(seg)
        if seg["text"]:
            text_parts.append(seg["text"])

    return {
        "language": getattr(info, "language", None),
        "language_probability": float(
            getattr(info, "language_probability", 0.0) or 0.0
        ),
        "duration": float(getattr(info, "duration", 0.0) or 0.0),
        "segments": out_segments,
        "text": " ".join(text_parts).strip(),
    }


# SSOT for the faster-whisper transcribe kwargs we apply to every
# inference call (live + upload-sync + file). Centralized so a future
# tuning change is a one-place edit and so the live path can't drift
# from the upload-sync path.
#
# ``condition_on_previous_text=False`` is the critical bit. faster-
# whisper defaults it to ``True``: each segment is decoded with the
# PREVIOUS segment's text as context. The trade-off:
#
#   * True  →  slightly more coherent transitions between adjacent
#              sentences (~1-2 % BLEU bump on benchmark corpora).
#   * False →  every segment is decoded independently, immune to a
#              well-documented "hallucination loop" failure mode where
#              one weird/empty segment poisons every subsequent one
#              and the tail of long audio comes back as empty
#              transcripts.
#
# User report: "не полностью транскрибирует на локальной модели"
# (uploaded audio came back with only the first portion transcribed).
# That symptom is a textbook hallucination-loop manifestation; the
# affected fraction grows with audio duration. We accept the tiny
# coherence loss in exchange for reliable transcription of arbitrary
# user-supplied audio.
_WHISPER_TRANSCRIBE_DEFAULTS = {
    "condition_on_previous_text": False,
}


def transcribe_audio(
    audio_16k_mono: np.ndarray,
    model_name: str,
    language: Optional[str] = None,
    vad_filter: bool = True,
    word_timestamps: bool = False,
    beam_size: int = 1,
    best_of: int = 1,
) -> Dict[str, Any]:
    """Transcribe 16kHz mono audio (float32 numpy array)."""

    if audio_16k_mono is None:
        raise ValueError("audio_16k_mono is required")

    # Accept either (n,) or (n,1)
    if audio_16k_mono.ndim == 2 and audio_16k_mono.shape[1] == 1:
        audio_16k_mono = audio_16k_mono[:, 0]

    # Engine dispatch: GigaAM ids share the local-model catalog but run
    # on Sber's Conformer stack, not faster-whisper.
    if model_name.startswith(GIGAAM_MODEL_PREFIX):
        from backend.transcribe_gigaam import transcribe_gigaam

        result = transcribe_gigaam(
            audio_16k_mono,
            model_name,
            word_timestamps=word_timestamps,
        )
        _touch_model(model_name)
        return result

    model = _model(model_name)
    try:
        segments, info = model.transcribe(
            audio_16k_mono,
            language=language or None,
            vad_filter=vad_filter,
            word_timestamps=word_timestamps,
            beam_size=beam_size,
            best_of=best_of,
            **_WHISPER_TRANSCRIBE_DEFAULTS,
        )
    except Exception as e:
        if _is_empty_sequence_transcribe_error(e):
            # ``audio_16k_mono is not None`` was a leftover defensive
            # ternary — line 245 above already raises ValueError on
            # None, so by the time control reaches this except branch
            # ``audio_16k_mono`` is guaranteed to be a real ndarray.
            duration = float(audio_16k_mono.shape[0]) / float(LIVE_SAMPLE_RATE_HZ)
            return _empty_transcribe_result(duration)
        raise

    return _build_result(segments, info, word_timestamps)


def transcribe_file(
    path_wav_16k_mono: str,
    model_name: str,
    language: Optional[str] = None,
    vad_filter: bool = True,
    word_timestamps: bool = False,
    beam_size: int = 1,
    best_of: int = 1,
) -> Dict[str, Any]:
    if not os.path.exists(path_wav_16k_mono):
        raise FileNotFoundError(path_wav_16k_mono)

    # Asked BEFORE the engine dispatch and before any model load: a file
    # too small to hold audio needs neither.
    empty = _undecodable_wav_result(path_wav_16k_mono)
    if empty is not None:
        return empty

    # Engine dispatch (same SSOT branch as transcribe_audio): file jobs,
    # sync transcribe and re-transcribe accept every catalog id, so a
    # gigaam id must reach the GigaAM engine instead of WhisperModel.
    if model_name.startswith(GIGAAM_MODEL_PREFIX):
        result = _transcribe_file_gigaam(
            path_wav_16k_mono, model_name, word_timestamps=word_timestamps
        )
        _touch_model(model_name)
        return result

    model = _model(model_name)
    try:
        segments, info = model.transcribe(
            path_wav_16k_mono,
            language=language or None,
            vad_filter=vad_filter,
            word_timestamps=word_timestamps,
            beam_size=beam_size,
            best_of=best_of,
            **_WHISPER_TRANSCRIBE_DEFAULTS,
        )
    except Exception as e:
        if _is_empty_sequence_transcribe_error(e):
            # The file's REAL duration, as every other door reports it
            # (``_undecodable_wav_result``, ``transcribe_audio``): the
            # same empty recognition must describe the same recording
            # whichever entry point it came through (BE-22).
            return _empty_transcribe_result(sf.info(path_wav_16k_mono).duration)
        raise

    return _build_result(segments, info, word_timestamps)


def _transcribe_file_gigaam(
    path_wav_16k_mono: str,
    model_name: str,
    *,
    word_timestamps: bool,
) -> Dict[str, Any]:
    """GigaAM side of the file-path entry point.

    The file pipeline (backend/audio.py) hands over a 16 kHz mono WAV —
    the same contract ``path_wav_16k_mono`` names. Read it back to the
    adapter's float32-PCM input instead of duplicating engine logic here;
    a rate outside the contract is a pipeline bug and must fail loudly
    rather than be silently resampled with lossy math.
    """
    audio, sr = sf.read(path_wav_16k_mono, dtype="float32", always_2d=True)
    if sr != LIVE_SAMPLE_RATE_HZ:
        raise ValueError(
            f"expected {LIVE_SAMPLE_RATE_HZ} Hz mono WAV, got {sr} Hz: "
            f"{path_wav_16k_mono}"
        )
    from backend.transcribe_gigaam import transcribe_gigaam

    return transcribe_gigaam(
        audio.mean(axis=1),
        model_name,
        word_timestamps=word_timestamps,
    )


def merge_channel_transcripts(t1: Dict[str, Any], t2: Dict[str, Any]) -> Dict[str, Any]:
    merged = []
    for seg in t1.get("segments", []):
        merged.append({**seg, "speaker": "A"})
    for seg in t2.get("segments", []):
        merged.append({**seg, "speaker": "B"})
    merged.sort(key=lambda s: (s.get("start", 0.0), s.get("speaker", "")))
    text = []
    for s in merged:
        t = (s.get("text") or "").strip()
        if t:
            text.append(f"{s.get('speaker', '?')}: {t}")
    # Preserve the full result-dict shape so callers can rely on
    # ``duration`` and ``language_probability`` being present whether
    # the file was mono or stereo. The mono path (via _build_result)
    # already sets both keys; stereo merge must match to prevent
    # caller-side KeyError / None fallthroughs for duration-based
    # telemetry and auto-detect confidence.
    return {
        "language": t1.get("language") or t2.get("language"),
        "language_probability": max(
            float(t1.get("language_probability") or 0.0),
            float(t2.get("language_probability") or 0.0),
        ),
        "duration": max(
            float(t1.get("duration") or 0.0),
            float(t2.get("duration") or 0.0),
        ),
        "channel_mode": "stereo_split",
        "segments": merged,
        "text": "\n".join(text).strip(),
    }
