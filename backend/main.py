import json
import logging
import os
import sys
import asyncio
import base64
import binascii
import hashlib
import importlib
import socket
import uuid
import re
import secrets
import threading
import time
import subprocess
import tempfile
import unicodedata
from collections import defaultdict, deque
from dataclasses import dataclass
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Iterable, Optional
from urllib.parse import urlparse
from urllib.request import urlopen

from fastapi import (
    Body,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.async_tasks import (
    await_cancelled,
    cancel_and_await,
    cancel_and_collect,
)
from backend.audio_constants import (
    LIVE_PCM_BYTES_PER_SEC,
    LIVE_RECOVERY_MIN_BYTES,
    LIVE_SAMPLE_RATE_HZ,
)
from backend.models_manager import (
    ModelDeleteError,
    delete_model,
    list_local_models,
    start_download,
)
from backend.model_catalog import (
    DEFAULT_DEEPGRAM_AUDIO_MODEL,
    DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
    DEFAULT_OPENROUTER_AUDIO_MODEL,
    DEFAULT_OPENROUTER_UPSCALE_MODEL,
    DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER,
    DUAL_SECONDARY_LANGUAGE_DEFAULT,
    DUAL_SECONDARY_LANGUAGE_OPTIONS,
    DUAL_STREAM_DEFAULT,
    LIVE_LANGUAGE_OPTIONS,
    LOCAL_TRANSCRIPTION_MODELS,
    OPENROUTER_UPSCALE_FALLBACK_MODELS,
    REMOTE_TRANSCRIPTION_PROVIDERS,
    gigaam_available,
    health_model_catalog,
)
from backend.audio_mime import AUDIO_EXT_TO_MIME, audio_content_type
from backend.audio import (
    AudioError,
    compact_audio_chunks_for_remote,
    ensure_wav_16k,
    ensure_wav_16k_preserve_channels,
    split_channels,
    write_wav_from_pcm16_stream,
)
from backend.cli_access import (
    CliAccess,
    base_url_from_scope,
    cli_defaults,
    cli_token_may_call,
)
from backend.config import APP_ROOT, DATA_DIR, load_config, redact_config, save_config
from backend.storage import (
    TMP_ORPHAN_RE,
    atomic_promote_file,
    atomic_write_bytes,
    atomic_write_json,
    atomic_write_text,
)
from backend.live import LiveSession
from backend.live_envelope import (
    DEEPGRAM_LIVE_SOURCE,
    LOCAL_ASSIST_SOURCE,
    envelope_from_result,
    live_coverage,
    live_final_envelope,
)
from backend.jobs import JobCancelledError, JobStore
from backend.http_retry import RemoteError
from backend.remote_openrouter import OpenRouterError, openrouter_transcribe, openrouter_upscale_text
from backend.deepgram_keyterms import MAX_KEYTERM_TOKENS, configured_keyterms
from backend.remote_deepgram import DeepgramRemoteError, deepgram_transcribe
from backend.deepgram_dual import (
    DualLiveSession,
    dual_secondary_language,
    dual_stream_enabled,
    secondary_config,
)
from backend.deepgram_recovery import (
    LIVE_EMPTY_RESULT_MIN_SEC,
    InterimEvidence,
    evidence_from_session,
    recovery_budget_sec,
    run_recovery,
    uncovered_spans,
)
from backend.deepgram_warm import (
    WARM_KEEPALIVE_INTERVAL_SEC,
    DeepgramWarmPool,
    pcm_has_voice,
)
from backend.remote_deepgram_live import (
    DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC,
    DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC,
    DeepgramLiveConfig,
    DeepgramLiveError,
    DeepgramLiveSession,
    live_config,
    resolve_live_language,
)
from backend.transcribe import (
    merge_channel_transcripts,
    model_is_resident,
    start_idle_model_sweeper,
    transcribe_file,
    warm_model,
    warm_state,
)


UPLOADS_DIR = DATA_DIR / "uploads"
RESULTS_DIR = DATA_DIR / "results"
LIVE_RECOVERY_DIR = DATA_DIR / "live_recovery"
UI_STATE_DIR = DATA_DIR / "ui_state"
for d in (UPLOADS_DIR, RESULTS_DIR, LIVE_RECOVERY_DIR, UI_STATE_DIR):
    d.mkdir(parents=True, exist_ok=True)


logger = logging.getLogger(__name__)

# 1.1.21: route ``backend.*`` INFO records to a dedicated stderr
# handler so they reach the Electron main.log.
#
# Background. Module-level ``logger = logging.getLogger(__name__)``
# inherits the ROOT logger's effective threshold. By default that's
# WARNING, so every ``logger.info(...)`` line we added in 1.1.19
# (Finalize sent, finalize ENTER/EXIT, is_final per-segment, etc.)
# was silently filtered. Setting the package logger's level alone
# (1.1.20) wasn't enough either — uvicorn configures the root
# handler set at startup, and Python's logging delegates effective
# level enforcement at the HANDLER not just the logger. The active
# handler chain (root → uvicorn's stderr stream) was rejecting INFO
# even though ``backend.*`` was set to INFO.
#
# Fix: attach our OWN ``StreamHandler(sys.stderr)`` directly to the
# ``backend`` logger at INFO level, and disable propagation so
# records don't double-emit through root. This bypasses uvicorn's
# config entirely — every ``backend.*`` INFO+ record goes straight
# to stderr → ``backend.stderr.on("data")`` in desktop/main.js →
# ``[backend-stderr] …`` in main.log. The diagnostic ladder we
# need (Finalize sent / is_final emissions / finalize EXIT delta)
# is now visible by construction.
_backend_logger = logging.getLogger("backend")
_backend_logger.setLevel(logging.INFO)
if not any(
    isinstance(h, logging.StreamHandler) and getattr(h, "_transcriptor_backend", False)
    for h in _backend_logger.handlers
):
    _h = logging.StreamHandler(sys.stderr)
    _h.setLevel(logging.INFO)
    _h.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    # Sentinel attribute lets the dedup check above survive
    # multiple imports (uvicorn's --reload, test fixtures, etc.)
    # without stacking handlers per import.
    _h._transcriptor_backend = True  # type: ignore[attr-defined]
    _backend_logger.addHandler(_h)
# Stop propagation: with our own handler in place, propagating to
# root would also send the record through uvicorn's stderr handler
# and produce duplicate ``[backend-stderr]`` lines for every log.
_backend_logger.propagate = False


# ── Access-log noise floor ──────────────────────────────────────────────────
#
# main.log is the support log: the one artefact available when a user says
# "the transcript lost its ending" or "recording did not start". It has to
# be readable.
#
# Measured on a real 42 833-line archive, before this filter:
#
#     GET /api/health          12 624 lines   29.5 %
#     GET /api/network         12 621 lines   29.5 %
#     PUT /api/ui/live-draft    6 659 lines   15.5 %
#     ------------------------------------------------
#     poll/autosave noise                     ~75 %
#     recordings actually saved   135 lines    0.3 %
#
# Three-quarters of the record was the renderer confirming, every few
# seconds, that nothing had changed — while the 135 events a human would
# ever search for made up a third of one percent. It also drove rotation:
# 5 MB every ~1.5 days, so genuinely useful history aged out fast.
#
# What is muted is deliberately narrow: a SUCCESSFUL (2xx) request to a
# path the UI polls on a timer. A non-2xx on those same paths is exactly
# the signal you want — a failing /api/health is the difference between
# "the backend is up" and "the backend is wedged" — so those still print,
# as does every other endpoint, including every save, transcription,
# recovery and model operation.
_ACCESS_LOG_POLLED_PATHS: frozenset[str] = frozenset({
    "/api/health",        # renderer network pill, ~1 per 10 s
    "/api/network",       # same poll's second leg
    "/api/ui/live-draft", # live-draft autosave, ~1 per 1.2 s while recording
    "/api/models/local",  # Settings → Local models list
})


class _MutedPollingAccessFilter(logging.Filter):
    """Drop access-log records for successful polls of the paths above.

    uvicorn emits access records with
    ``args = (client_addr, method, full_path, http_version, status)``.
    Anything that does not match that shape is passed through untouched —
    a filter must never be the reason a log line disappears.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) < 5:
            return True
        raw_path, status = args[2], args[4]
        if not isinstance(raw_path, str):
            return True
        try:
            code = int(status)
        except (TypeError, ValueError):
            return True
        if not (200 <= code < 300):
            return True  # a failing poll is signal, not noise
        return raw_path.split("?", 1)[0] not in _ACCESS_LOG_POLLED_PATHS


_uvicorn_access_logger = logging.getLogger("uvicorn.access")
if not any(
    isinstance(f, _MutedPollingAccessFilter) for f in _uvicorn_access_logger.filters
):
    _uvicorn_access_logger.addFilter(_MutedPollingAccessFilter())


# ── Parent-death watchdog ───────────────────────────────────────────────────
#
# The Electron shell is our parent. When it quits cleanly it sends SIGTERM
# (via ``backend.kill("SIGTERM")``) and we exit. But when the Electron
# process is killed with SIGKILL (``kill -9``), crashes, or the OS force-
# closes it, the ``before-quit`` handler cannot run and no signal reaches
# us — we become an orphan Python process, still bound to our TCP port,
# still holding whisper models in RAM, until the user manually tracks us
# down with ``ps``.
#
# Solution: the parent opens an inherited stdin pipe to us. As long as
# the parent is alive the pipe's write end stays open. When the parent
# process table entry is reaped (normal exit, crash, SIGKILL, laptop
# shutdown mid-session — ANY path), the kernel closes every fd it owned
# including our stdin's read end. A blocking ``os.read(0, 1)`` then
# returns 0 bytes (EOF), and we exit immediately.
#
# The watchdog lives in a daemon thread so it never blocks shutdown. It
# uses ``os._exit`` (not ``sys.exit``) because uvicorn installs its own
# signal handlers and a normal exit here would race with its shutdown
# path — ``os._exit`` bypasses atexit + cleanup and is the only way to
# GUARANTEE the orphan is reaped, which is the whole point of this
# watchdog.
#
# Electron sets ``TRANSCRIPTOR_PARENT_WATCHDOG=1`` when it owns the
# backend stdin pipe. Standalone and CI runs often have a non-tty stdin
# too (pytest capture, shell pipelines, launchd), so stdin shape alone is
# not proof that EOF means "Electron parent died".
#
# ``TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG=1`` remains an emergency opt-out.
def _start_parent_death_watchdog() -> None:
    if os.environ.get("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG") == "1":
        return
    if os.environ.get("TRANSCRIPTOR_PARENT_WATCHDOG") != "1":
        return
    if not os.isatty(0):
        # Only install the watchdog when stdin is a pipe (parent-spawned).
        # An interactive terminal would have ``isatty(0) == True`` and
        # reading a byte would block forever until the user types.
        def _watch() -> None:
            try:
                while True:
                    data = os.read(0, 1)
                    if not data:
                        # EOF — parent's write end closed. Could be a
                        # graceful parent exit OR a kernel-forced close
                        # because the parent process table entry was
                        # reaped. Either way: we have no parent anymore.
                        logger.warning(
                            "parent-death-watchdog: stdin EOF, exiting immediately"
                        )
                        # Flush logging before hard exit so any pending
                        # messages reach the parent's captured stderr.
                        try:
                            logging.shutdown()
                        except Exception:
                            pass
                        os._exit(0)
            except Exception:
                # Unexpected — do NOT exit, because a read() failure on
                # stdin is not proof the parent is dead; it could be a
                # spurious EINTR or a misconfigured runtime. Just log
                # and let uvicorn keep serving.
                logger.exception("parent-death-watchdog: unexpected read error")

        threading.Thread(
            target=_watch, daemon=True, name="parent-death-watchdog"
        ).start()


_start_parent_death_watchdog()


@asynccontextmanager
async def _app_lifespan(_app: "FastAPI") -> AsyncIterator[None]:
    """FastAPI lifespan hook.

    Replaces the deprecated ``@app.on_event("startup")`` pattern
    (removed in an upcoming FastAPI release). Every startup task is
    best-effort and kicked off in a background daemon thread so it
    cannot block the event loop from serving requests.

    No local model is warmed here. Provider selection lives in the
    renderer (Settings → Transcription), so the backend cannot know
    at boot whether a local engine will be used at all. Warming the
    default Whisper model unconditionally imported faster-whisper +
    ctranslate2 + PyAV and pinned ~700 MB resident for the entire
    session even when the user transcribes exclusively through a
    remote API — the single largest source of idle memory in the app.
    ``/api/transcribe/warmup`` remains the one warm entry point, and
    the renderer calls it only when the effective provider resolves
    to ``local``.

    The retention/sweep helpers below are defined later in the module
    — Python resolves the names at call time (when this lifespan
    enters), by which point the whole module has been imported. No
    forward-declaration dance required.
    """
    # Idle-unload sweeper for the local model cache. Cheap (one wakeup
    # per minute over a dict that is empty for API-only users) and the
    # only thing that ever returns a loaded model's ~700 MB to the OS.
    start_idle_model_sweeper()

    # Audio retention: one boot sweep to catch whatever aged out while
    # the app was closed, then a timer so a long-running session keeps
    # enforcing the window without needing a save or a restart.
    def _run_boot_audio_retention() -> None:
        try:
            _sweep_recording_audio_retention()
        except Exception:
            logger.exception("boot audio retention sweep failed")

    threading.Thread(
        target=_run_boot_audio_retention,
        daemon=True,
        name="audio-retention-boot",
    ).start()
    start_audio_retention_sweeper()

    def _run_tmp_sweep() -> None:
        try:
            _sweep_orphan_tmp_files()
        except Exception:
            logger.exception("tmp-file sweep startup task failed")

    threading.Thread(
        target=_run_tmp_sweep,
        daemon=True,
        name="tmp-sweep",
    ).start()

    # Deepgram warm socket (audit §2.4/§3.7). The pool is bound to the
    # app lifetime rather than created on demand: it holds a real
    # upstream connection, so there must be exactly one owner and one
    # guaranteed release. Un-armed it retains nothing, which is why
    # importing this module — or driving the WS handler directly from a
    # test — never leaves a socket open.
    DEEPGRAM_WARM_POOL.start()
    warm_boot = asyncio.get_running_loop().create_task(
        _prewarm_deepgram_at_boot(), name="deepgram-warm-boot"
    )

    yield

    await cancel_and_await(warm_boot, what="deepgram boot pre-warm", log=logger)
    # Shutdown: drain in-flight transcription jobs before the process
    # exits so Electron's SIGTERM (killBackendHard, 1500 ms hard deadline)
    # doesn't interrupt mid-write result files. Without this, the worker
    # thread gets killed between the `open()` and the final `write()`
    # of `result.json`, leaving a half-written 0-byte file that parses
    # as corrupt on next launch and surfaces to the user as a
    # "recording is broken" error.
    #
    # Budget is tight: Electron's POSIX killBackendHard escalates
    # SIGTERM → SIGKILL at 1500 ms (see desktop/main.js), so we have
    # at most ~1.3 s after uvicorn's signal handler dispatches the
    # lifespan shutdown. 1.5 s matches that envelope — the common
    # case (no running job) drains in <50 ms; a wedged ffmpeg worker
    # won't drain either way and gets killed with the process, same
    # as before this fix. Rate-limit prune, warm-default, retroactive-
    # retention etc. are daemon threads — they die with the process.
    try:
        await asyncio.to_thread(jobs.shutdown, 1.5)
    except Exception:
        logger.exception("jobs pool shutdown failed (non-fatal)")

    # LAST, and bounded: releasing the warm socket is politeness, not
    # correctness. It must not eat into the SIGTERM budget above, where
    # the cost of running out of time is a half-written result file;
    # here the cost is a connection Deepgram tears down itself when the
    # process exits a moment later.
    try:
        await asyncio.wait_for(DEEPGRAM_WARM_POOL.close_all(), timeout=1.0)
    except (asyncio.TimeoutError, Exception):
        logger.warning("deepgram warm pool shutdown did not finish (non-fatal)")


app = FastAPI(title="Call Transcriptor", lifespan=_app_lifespan)
JOB_MAX_WORKERS = 2
UPLOAD_QUEUE_MAX_PERSISTED_ITEMS = 200
jobs = JobStore(max_workers=JOB_MAX_WORKERS)


# Paths we consider "sensitive" — present in raw exception text from
# OSError/FileNotFoundError/ffmpeg stderr and get echoed back to the
# client if we include `str(e)` verbatim in HTTP response bodies or
# persisted job errors. The redact happens BEFORE the string is handed
# to anything external; full exceptions are still written to main.log
# via `logger.exception` for operator debugging.
_ERROR_POSIX_PATH_ROOTS_RE = r"(?:Users|home|root|var|tmp|private|opt|Applications|System)"
_ERROR_WINDOWS_PATH_ROOTS_RE = r"(?:Users|Windows|Temp|ProgramData|Program Files)"
_ERROR_LOCAL_PATH_START_RE = (
    rf"(?:/{_ERROR_POSIX_PATH_ROOTS_RE}/|[A-Za-z]:[\\/]{_ERROR_WINDOWS_PATH_ROOTS_RE}[\\/])"
)
_ERROR_PATH_REDACT_RE = re.compile(
    rf"(?:"
    # POSIX user/system paths. `(?<![A-Za-z0-9:/])` look-behind prevents
    # over-redacting URL paths like ``https://example.com/home/stream`` —
    # we only strip when the slash is preceded by whitespace, quote,
    # start-of-string, or a non-URL punctuation character, so a real
    # local path gets caught while a URL path survives the redact.
    rf"(?<![A-Za-z0-9:/])/{_ERROR_POSIX_PATH_ROOTS_RE}/[^\s\"'`]*"
    rf"|"
    # Windows user/system paths — both `\` and forward-slashed variants.
    rf"[A-Za-z]:[\\/]{_ERROR_WINDOWS_PATH_ROOTS_RE}[\\/][^\s\"'`]*"
    rf")",
    re.IGNORECASE,
)
_ERROR_QUOTED_PATH_REDACT_RE = re.compile(
    rf"\"{_ERROR_LOCAL_PATH_START_RE}[^\"\r\n]*\""
    rf"|'{_ERROR_LOCAL_PATH_START_RE}[^'\r\n]*'"
    rf"|`{_ERROR_LOCAL_PATH_START_RE}[^`\r\n]*`",
    re.IGNORECASE,
)
# Crude API-key shapes that should never end up in an error body. We
# don't need to match every provider — just the ones we use.
_ERROR_TOKEN_REDACT_RE = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{20,}|[a-f0-9]{40,})\b",
    re.IGNORECASE,
)


def _safe_error_text(exc: object, *, max_len: int = 200) -> str:
    """Render an exception (or arbitrary string) safely for external reporting.

    Redacts absolute filesystem paths and obvious token shapes, then
    truncates. The full, unredacted exception should be logged
    separately via ``logger.exception`` so operators retain the detail
    needed for debugging; only what this function returns should appear
    in HTTP response bodies or stored job errors.
    """
    text = str(exc) if not isinstance(exc, str) else exc
    if not text:
        return exc.__class__.__name__ if isinstance(exc, BaseException) else "error"
    text = _ERROR_QUOTED_PATH_REDACT_RE.sub(
        lambda match: f"{match.group(0)[0]}<path>{match.group(0)[0]}",
        text,
    )
    text = _ERROR_PATH_REDACT_RE.sub("<path>", text)
    text = _ERROR_TOKEN_REDACT_RE.sub("<token>", text)
    if len(text) > max_len:
        text = text[:max_len].rstrip() + "…"
    return text

# Upload ceiling. 2 GB covers feature-film-length uploads; the whole
# pipeline is streaming end-to-end so the ceiling costs no memory:
# _save_upload_file writes 1 MB chunks to disk, ffmpeg converts with
# bounded buffers, faster-whisper decodes the WAV lazily per window,
# and the remote path re-compresses into REMOTE_TRANSCRIBE_CHUNK_SEC
# Opus/WebM chunks before any provider call.
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
# Hard ceiling on the live-recovery SPOOL. Derived from MAX_UPLOAD_BYTES
# so any file the app accepts as an upload can also exist as a recovery
# spool; at the current upload ceiling that is 4 GB, and 16 kHz mono
# PCM16 = 32 KB/s, so 4 GB ≈ 35 h of continuous audio — far beyond any
# realistic dictation session.
# Without this cap, a user who leaves a tab open and crashes Electron
# while still recording can write the spool indefinitely and fill a
# small SSD. When crossed we stop writing further chunks (logged once)
# but keep the WebSocket session alive so live transcription continues;
# recovery is best-effort, the finalized transcript is already persisted
# via the streaming path.
MAX_LIVE_RECOVERY_BYTES = 2 * MAX_UPLOAD_BYTES
# Recovery-promote ceiling, DERIVED from the spool ceiling above so the
# two can never silently drift apart again. History: the spool ceiling
# was raised to 2×MAX_UPLOAD_BYTES while this one stayed at 500 MB, so a
# dictation longer than ~4.3 h recorded fine into the spool and then
# became UNRECOVERABLE after a crash (promote answered 413) — the worst
# data-loss class in the app. Promotion now STREAMS the PCM→WAV
# conversion through write_wav_from_pcm16_stream at constant memory
# (~2 MB per chunk), so accepting the full spool size no longer costs
# RAM; the old 500 MB cap existed only to bound the previous whole-file
# float32 conversion (~3x file size in RAM).
MAX_RECOVERY_PROMOTE_BYTES = MAX_LIVE_RECOVERY_BYTES
# Rate limits are a runaway/DoS backstop for a LOOPBACK-only server, not
# a quota. They must sit far above what one healthy renderer produces, or
# they become a self-inflicted outage.
#
# Steady-state renderer traffic on a single machine already reaches
# ~120 req/min on its own: live-draft autosave (1 req / 1.2 s = 50/min)
# + backend job polling during a transcription (1 req / 0.9 s = 66/min)
# + upload-queue snapshot saves + /api/network (6/min) + recordings
# list/stats refreshes after each save. The previous ceiling of 120
# was therefore crossed during ordinary use, and the renderer started
# getting HTTP 429 mid-recording — surfacing as random "settings save
# failed" / stalled job polls / History refresh failures.
RATE_LIMIT_PER_MIN = 1200
# One WS connect per recording. A user doing rapid short dictations can
# legitimately start well over 20 recordings in a minute.
WS_CONNECT_LIMIT_PER_MIN = 120

# ── Host-header allowlist (DNS-rebinding defence) ────────────────────
#
# The backend binds to 127.0.0.1, but "bound to loopback" does NOT mean
# "only reachable by local code". A remote page can point a hostname it
# controls at 127.0.0.1 (DNS rebinding); the browser then treats
# ``http://attacker.example:<port>/`` as SAME-ORIGIN with the attacker's
# page, so CORS never applies and the attacker can read our responses.
#
# ``GET /`` injects ``window.__TRANSCRIPTOR_API_TOKEN`` into the HTML and
# is intentionally unauthenticated (the renderer has no other way to
# bootstrap the token). A rebinding attack could therefore lift the API
# token and, with it, read every transcript, recording and audio file.
#
# Requiring the Host header to be a literal loopback address closes it:
# a rebound request carries the ATTACKER's hostname in Host, never
# ``127.0.0.1`` / ``localhost``.
_ALLOWED_HOST_NAMES = frozenset({"127.0.0.1", "localhost", "::1", "[::1]"})


def _host_header_allowed(raw_host: str) -> bool:
    host = str(raw_host or "").strip()
    if not host:
        # Missing Host is HTTP/1.0 or a raw local client; uvicorn already
        # rejects HTTP/1.1 without Host. Allow so non-browser tooling on
        # the machine keeps working — such a client cannot be a rebound
        # browser, which always sends Host.
        return True
    if host.startswith("["):
        # IPv6 literal, optionally with :port after the bracket.
        hostname = host.split("]", 1)[0] + "]"
    else:
        hostname = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    return hostname.strip().lower() in _ALLOWED_HOST_NAMES
WS_AUTH_SUBPROTOCOL = "transcriptor-auth"
WS_AUTH_TOKEN_PREFIX = "transcriptor-token."


def _decode_ws_subprotocol_token(encoded: str) -> str:
    raw = str(encoded or "").strip()
    if not raw:
        return ""
    try:
        padded = raw + ("=" * (-len(raw) % 4))
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8").strip()
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return ""


def _websocket_api_token(websocket: WebSocket) -> str:
    """Extract WS auth without reading query params.

    Browser WebSocket does not allow custom headers, and query-string
    tokens are logged by common access loggers. The renderer sends the
    token as a base64url WebSocket subprotocol:

      Sec-WebSocket-Protocol: transcriptor-auth, transcriptor-token.<b64url>

    Non-browser clients may still use X-Api-Token.
    """
    header_token = (websocket.headers.get("x-api-token") or "").strip()
    if header_token:
        return header_token
    raw_protocols = websocket.headers.get("sec-websocket-protocol") or ""
    for item in raw_protocols.split(","):
        proto = item.strip()
        if proto.startswith(WS_AUTH_TOKEN_PREFIX):
            return _decode_ws_subprotocol_token(proto[len(WS_AUTH_TOKEN_PREFIX):])
    return ""


def _websocket_accept_subprotocol(websocket: WebSocket) -> Optional[str]:
    raw_protocols = websocket.headers.get("sec-websocket-protocol") or ""
    offered = {item.strip() for item in raw_protocols.split(",") if item.strip()}
    return WS_AUTH_SUBPROTOCOL if WS_AUTH_SUBPROTOCOL in offered else None


def _env_int(name: str, default: int) -> int:
    """Parse an integer env var with graceful fallback.

    A non-numeric value (e.g., ``TRANSCRIPTOR_RESULT_RETENTION_SEC=1h``)
    would otherwise crash module import with ValueError before FastAPI
    ever starts, and Electron would see the backend child die
    repeatedly with no diagnostic. Degrade to the documented default
    with a warning so the backend boots and the misconfiguration is
    visible in the log.
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("invalid integer env %s=%r; using default=%d", name, raw, default)
        return default


RESULT_RETENTION_SEC = _env_int("TRANSCRIPTOR_RESULT_RETENTION_SEC", 86400)
LIVE_RECOVERY_RETENTION_SEC = _env_int("TRANSCRIPTOR_LIVE_RECOVERY_RETENTION_SEC", 86400)
REMOTE_TRANSCRIBE_CHUNK_SEC = max(
    60,
    min(3600, _env_int("TRANSCRIPTOR_REMOTE_TRANSCRIBE_CHUNK_SEC", 15 * 60)),
)
REMOTE_RAW_FALLBACK_MAX_BYTES = max(
    1 * 1024 * 1024,
    _env_int("TRANSCRIPTOR_REMOTE_RAW_FALLBACK_MAX_BYTES", 8 * 1024 * 1024),
)
SOURCE_MEDIA_STABILITY_PROBE_SEC = max(
    0.05,
    min(2.0, _env_int("TRANSCRIPTOR_SOURCE_MEDIA_STABILITY_PROBE_MS", 450) / 1000.0),
)
BOOT_NONCE = (os.environ.get("TRANSCRIPTOR_BOOT_NONCE") or "").strip()
ALLOWED_LOCAL_MODELS = set(LOCAL_TRANSCRIPTION_MODELS)
ALLOWED_REMOTE_PROVIDERS = set(REMOTE_TRANSCRIPTION_PROVIDERS)
ALLOWED_AUDIO_EXTS = {
    # Audio containers — natively understood by Deepgram REST and the
    # OpenRouter audio-input pipeline.
    ".wav", ".mp3", ".m4a", ".flac", ".ogg", ".oga", ".opus",
    ".aac", ".webm", ".wma",
    # Video containers — accepted because the Upload UI's accept attr
    # is ``audio/*,video/*`` and users routinely drop screen recordings.
    # Deepgram natively understands mp4/m4v; other containers fall
    # through to the ffmpeg path in audio.ensure_wav_16k for remote
    # transcription. Without these the validator returned HTTP 400
    # before the audio extraction code even saw the file.
    ".mp4", ".m4v", ".mov", ".mkv", ".avi", ".mpg", ".mpeg", ".3gp",
}
LIVE_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

COMMON_STOPWORDS = {
    "и", "в", "на", "что", "как", "это", "я", "ты", "мы", "вы", "он", "она", "оно", "они",
    "а", "но", "же", "ли", "не", "да", "нет", "к", "у", "по", "с", "со", "из", "от", "за",
    "вот", "то", "все", "меня", "там", "есть", "так", "ну", "нас", "чтобы", "когда", "сейчас",
    "очень", "нужно", "сделать", "почему", "если", "еще", "вообще", "просто", "быть", "давай",
    "какой", "грамотно", "только", "тебе", "типа", "нормально", "или", "для", "до", "уже",
    "потому", "потом", "значит", "короче", "прям", "тут", "мне", "его", "ее", "их", "вас",
    "вам", "нам", "там", "здесь", "где", "куда", "откуда", "зачем", "почему", "поэтому",
    "чтоб", "будет", "был", "была", "были", "тоже", "может", "надо", "один", "два", "три",
    "to", "the", "a", "an", "and", "or", "for", "of", "in", "on", "is", "it", "that", "this",
    "i", "you", "we", "they", "he", "she", "be", "are", "was", "were", "do", "does", "did",
}

UPSCALE_PRESETS_DIR = DATA_DIR / "upscale_presets"
UPSCALE_MAX_CUSTOM_PRESETS = 3

# Persistent registry of every archive directory ever used for an
# audio-bearing save.  Written atomically each time a new custom dir
# is first encountered so ``_sweep_recording_audio_retention`` can clean
# up *all* archives on the next startup, not just the current default.
_ARCHIVE_DIR_REGISTRY_PATH = DATA_DIR / "known_archive_dirs.json"
UPSCALE_PRESET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Windows reserved device names — case-insensitive, regardless of
# extension. Creating ``con.json`` / ``prn.json`` etc. on a Windows
# filesystem opens the corresponding character device instead of a
# regular file; the open(...) call returns a handle that hangs
# read/write/stat in unpredictable ways. The regex above accepts
# every one of these tokens, so we add an explicit reject list that
# fires before the path leaves this helper.
_WINDOWS_RESERVED_BASENAMES = frozenset({
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
})

DEFAULT_UPSCALE_PRESET_KEY = "clean"
DEFAULT_UPSCALE_PRESET_ID = f"builtin_{DEFAULT_UPSCALE_PRESET_KEY}"
MAX_UPSCALE_INPUT_CHARS = 120_000

# The built-in presets. Their ids used to be written out a second time
# as a bare set (``UPSCALE_PRESETS``) for the legacy ``preset`` field's
# validation, with nothing connecting the two — so adding a fifth
# built-in would have answered "unsupported upscale preset" to a legacy
# client asking for a preset that exists.
BUILTIN_UPSCALE_PRESETS: dict[str, dict[str, str]] = {
    "clean": {
        "name": "Clean",
        "instruction": (
            "Improve transcript readability: fix punctuation and grammar, remove fillers and stutters, "
            "preserve full meaning. Keep output in the same language as input. "
            "Return only final improved transcript text. No quotes, no comments, no markdown."
        ),
    },
    "business": {
        "name": "Business",
        "instruction": (
            "Rewrite transcript into clear business style: concise, professional, structured, grammar-correct. "
            "Keep all essential facts. Keep output in the same language as input. "
            "Return only final improved transcript text. No quotes, no comments, no markdown."
        ),
    },
    "ai_code": {
        "name": "AI & Code",
        "instruction": (
            "Improve transcript quality for software engineering context. Remove filler words, stutters, interjections, "
            "and speech noise. Preserve all technical terms exactly: frameworks, libraries, APIs, SDKs, model names, "
            "product names, file paths, commands, code tokens, identifiers, acronyms, and versions. "
            "Do not simplify, replace, or transliterate programming terminology. Do not translate code, commands, "
            "or proper technical names. Keep variable/function/class names exactly as spoken if recognizable. "
            "Preserve keywords like Upscale/Upskill exactly as spoken. Keep full meaning and original sequence. "
            "Structure output into readable short paragraphs and clean sentence boundaries without adding new facts. "
            "Keep output in the same language as input. "
            "Return only final improved transcript text. No quotes, no comments, no markdown."
        ),
    },
    "refine": {
        "name": "Refine",
        "instruction": (
            "Refine transcript readability without rewriting the content. Preserve the original language, meaning, order, "
            "facts, and important wording. Do not summarize, shorten, paraphrase, or add new information. "
            "Fix obvious punctuation and grammar issues only when needed for readability. "
            "Split the text into natural, readable paragraphs at topic or sentence-group boundaries. "
            "Return only final refined transcript text. No quotes, no comments, no markdown."
        ),
    },
}


frontend_dir = APP_ROOT / "frontend"
frontend_dist_dir_candidate = frontend_dir / "dist"
if (frontend_dist_dir_candidate / "index.html").exists():
    frontend_dist_dir = frontend_dist_dir_candidate
elif (frontend_dir / "index.html").exists():
    # Desktop packaged layout: resources/frontend/{index.html,assets/...}
    frontend_dist_dir = frontend_dir
else:
    # Default dev layout; index handler will return a clear error if still missing.
    frontend_dist_dir = frontend_dist_dir_candidate

frontend_assets_dir = frontend_dist_dir / "assets"
API_TOKEN_PATH = DATA_DIR / "api_token.txt"
_rate_lock = threading.Lock()
_request_windows: dict[str, deque[float]] = defaultdict(deque)
_archive_dir_registry_lock = threading.Lock()
_ws_windows: dict[str, deque[float]] = defaultdict(deque)

# Per-session recovery promotion serialization + idempotency cache.
# Promotion reads the PCM, writes a WAV+text pair, then deletes the
# PCM. A retry (double-click, UI refresh, transient 502) can land
# while the first call is still running — without a lock both calls
# race on the same WAV/text paths and pruning; without a cache the
# retry returns 404 because the PCM has been deleted. The cache keeps
# the successful result for ``_LIVE_PROMOTE_CACHE_TTL_SEC`` so retries
# observe the same response.
_live_promote_lock = threading.Lock()
# session id -> (lock, number of callers currently holding a reference).
# The count is what makes an entry safe to remove: see
# _acquire_session_promote_lock.
_live_promote_session_locks: dict[str, tuple[threading.Lock, int]] = {}
_live_promote_cache: dict[str, tuple[float, dict]] = {}
_LIVE_PROMOTE_CACHE_TTL_SEC = 60.0


def _load_or_create_api_token() -> str:
    env_token = os.environ.get("TRANSCRIPTOR_API_TOKEN", "").strip()
    if env_token:
        return env_token
    # The token path lives under DATA_DIR; if the user has permission or
    # filesystem issues (read-only mount, sandbox denial, anti-virus
    # lock), a bare read/write would raise OSError at module import
    # time and the backend would never start. Guard each FS op so we
    # degrade to an in-memory-only token for this session — recordings
    # still work, only the persistence of the token across restarts is
    # lost until the filesystem recovers.
    if API_TOKEN_PATH.exists():
        try:
            token = API_TOKEN_PATH.read_text(encoding="utf-8").strip()
        except OSError as e:
            logger.warning(
                "api token unreadable at %s: %s — regenerating",
                API_TOKEN_PATH, e,
            )
            token = ""
        if token:
            return token
    token = secrets.token_urlsafe(32)
    try:
        # SSOT atomic write: prevents torn state where the token file
        # exists but is empty/partial after a crash during generation.
        # A zero-length token file would pass the `API_TOKEN_PATH.exists()`
        # probe on next boot, read as empty, and the auth guard would
        # lock the user out until the file is manually deleted.
        atomic_write_text(API_TOKEN_PATH, token, mode=0o600)
    except OSError as e:
        logger.error(
            "api token persist failed at %s: %s — using in-memory token "
            "for this session only (will re-generate on restart)",
            API_TOKEN_PATH, e,
        )
        return token
    return token


API_TOKEN = _load_or_create_api_token()

# ── The command-line client's access ────────────────────────────────
#
# A second caller with a second life. The renderer's token is minted at
# boot and lives as long as the process; a command run by a shell or an
# agent is authorised separately, stays authorised across restarts, and
# must be revocable while the app keeps running. ``CliAccess`` owns
# every file behind that — the token, the connection file the client
# reads, the wrapper script — and ``cli_token_may_call`` owns what the
# token opens. Loaded once here so the auth path compares against
# memory and never touches the disk per request.
CLI_ACCESS = CliAccess(DATA_DIR)
CLI_ACCESS.load()


# The tmp-name convention lives with the atomic writers that produce it
# (``backend.storage.TMP_ORPHAN_RE``). Both producers are covered:
#
#   storage._tmp_path_for   → "recording.txt.tmp-<hex>"
#   _atomic_temp_path       → "recording.tmp-<hex>.wav" / ".txt" / ".m4a"
#   _write_upscale_preset   → "builtin_clean.tmp-<hex>.json"
#
# It used to be restated here with ONE optional extension group, which
# does not match what ``_atomic_temp_path`` produces for a name with
# more than one dot — see the pattern's own comment.
_TMP_ORPHAN_RE = TMP_ORPHAN_RE


def _sweep_orphan_tmp_files() -> None:
    """Delete orphan ``*.tmp-*`` files from DATA_DIR and every archive dir.

    Runs once at backend startup. Tmp files from the current process
    (still being written) have not yet been renamed into place, so their
    mtime is very recent — we skip anything modified in the last 60 s
    to avoid racing with a concurrent write from a parallel worker.
    """
    cutoff = time.time() - 60.0
    # Every directory an atomic writer touches must be swept. UI_STATE_DIR
    # (live_draft.json / upload_queue.json), RESULTS_DIR (job result
    # .json/.txt), UPLOADS_DIR and LIVE_RECOVERY_DIR all receive
    # ``<name>.tmp-<hex>`` siblings from storage.atomic_write_*; a crash
    # mid-write previously left them there permanently because the sweep
    # only looked at DATA_DIR and the presets dir.
    targets: list[Path] = [
        DATA_DIR,
        UPSCALE_PRESETS_DIR,
        UI_STATE_DIR,
        RESULTS_DIR,
        UPLOADS_DIR,
        LIVE_RECOVERY_DIR,
    ]
    try:
        targets.extend(_recordings_storage_dirs_for_roots(_get_known_archive_dirs()))
    except Exception:
        pass
    removed = 0
    for root in targets:
        try:
            if not root.exists() or not root.is_dir():
                continue
            for p in root.iterdir():
                if not p.is_file():
                    continue
                if not _TMP_ORPHAN_RE.search(p.name):
                    continue
                try:
                    if p.stat().st_mtime > cutoff:
                        continue
                    p.unlink()
                    removed += 1
                except OSError:
                    continue
        except OSError:
            continue
    if removed > 0:
        logger.info("tmp-sweep: removed %d orphan *.tmp-* files", removed)


def _origin_allowed(origin: str, request: Request) -> bool:
    try:
        parsed = urlparse(origin)
        if parsed.scheme not in {"http", "https"}:
            return False
        if parsed.hostname not in {"127.0.0.1", "localhost"}:
            return False
        req_port = request.url.port
        if req_port is None:
            req_port = 443 if request.url.scheme == "https" else 80
        origin_port = parsed.port
        if origin_port is None:
            origin_port = 443 if parsed.scheme == "https" else 80
        return origin_port == req_port
    except ValueError:
        return False


_RATE_BUCKET_MAX_KEYS = 2048
_rate_prune_watermark: dict[int, float] = {}


def _prune_rate_bucket(bucket: dict[str, deque[float]], cutoff: float) -> None:
    """Garbage-collect a rate-limit bucket.

    Called under ``_rate_lock``. Walks every key and drops entries
    whose deque is empty after the cutoff prune. Bounded work —
    runs at most once per 30s per bucket, or immediately if the
    bucket exceeds the hard-cap size.

    Root cause for the previous leak: ``defaultdict(deque)`` created
    a new entry for every unique IP address, but empty deques were
    never removed. Over a long-running server, this grew unboundedly
    (slow memory leak, DoS vector via flood of unique clients).
    """
    stale_keys: list[str] = []
    for k, q in bucket.items():
        while q and q[0] < cutoff:
            q.popleft()
        if not q:
            stale_keys.append(k)
    for k in stale_keys:
        bucket.pop(k, None)

    # If after pruning we're still over the hard cap, evict the
    # oldest-touched keys. This bounds peak memory even under a burst
    # of unique clients that haven't timed out yet.
    if len(bucket) > _RATE_BUCKET_MAX_KEYS:
        # Sort by most-recent timestamp ascending; drop the oldest
        # until we're back under the cap.
        ordered = sorted(
            bucket.items(),
            key=lambda kv: kv[1][-1] if kv[1] else 0.0,
        )
        excess = len(bucket) - _RATE_BUCKET_MAX_KEYS
        for k, _ in ordered[:excess]:
            bucket.pop(k, None)


def _touch_rate_limit(bucket: dict[str, deque[float]], key: str, limit_per_min: int) -> bool:
    # Use monotonic() — rate limiting is an internal-only TTL check,
    # and ``time.time()`` can jump backward on NTP correction or DST
    # transitions, making a recent hit look "old" and briefly
    # disabling the limiter. monotonic() is guaranteed to increase.
    now = time.monotonic()
    cutoff = now - 60.0
    with _rate_lock:
        q = bucket[key]
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= limit_per_min:
            return False
        q.append(now)

        # Opportunistic GC: runs at most once per 30s per bucket, or
        # immediately if the bucket is over-full. O(n) in the number
        # of tracked clients, amortized down to a few microseconds
        # per touch even at cap size.
        bucket_id = id(bucket)
        last_prune = _rate_prune_watermark.get(bucket_id, 0.0)
        if now - last_prune > 30.0 or len(bucket) > _RATE_BUCKET_MAX_KEYS:
            _prune_rate_bucket(bucket, cutoff)
            _rate_prune_watermark[bucket_id] = now
        return True


_last_cleanup_expired_at = 0.0
_last_cleanup_recovery_at = 0.0
_CLEANUP_DEBOUNCE_SEC = 60.0


def _cleanup_expired_files() -> None:
    global _last_cleanup_expired_at
    if RESULT_RETENTION_SEC <= 0:
        return
    # Debounce uses monotonic (clock-skew immune). File ``st_mtime``
    # lives in wall-clock epoch seconds, so the cutoff for the actual
    # age check uses ``time.time()`` separately.
    debounce_now = time.monotonic()
    if debounce_now - _last_cleanup_expired_at < _CLEANUP_DEBOUNCE_SEC:
        return
    _last_cleanup_expired_at = debounce_now
    cutoff = time.time() - RESULT_RETENTION_SEC
    for base in (RESULTS_DIR, UPLOADS_DIR):
        for p in base.glob("*"):
            try:
                if not p.is_file():
                    continue
                if p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
            except OSError as e:
                logger.debug("cleanup skipped for %s: %s", p, e)


def _cleanup_live_recovery_files() -> None:
    global _last_cleanup_recovery_at
    if LIVE_RECOVERY_RETENTION_SEC <= 0:
        return
    # Same split as ``_cleanup_expired_files``: monotonic for debounce,
    # wall-clock for the mtime comparison.
    debounce_now = time.monotonic()
    if debounce_now - _last_cleanup_recovery_at < _CLEANUP_DEBOUNCE_SEC:
        return
    _last_cleanup_recovery_at = debounce_now
    cutoff = time.time() - LIVE_RECOVERY_RETENTION_SEC
    for p in LIVE_RECOVERY_DIR.glob("*"):
        try:
            if not p.is_file():
                continue
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except OSError as e:
            logger.debug("live recovery cleanup skipped for %s: %s", p, e)


def _normalize_live_session_id(value: str) -> str:
    raw = (value or "").strip()
    if raw and LIVE_SESSION_ID_RE.fullmatch(raw):
        return raw
    return str(uuid.uuid4())


def _live_recovery_paths(session_id: str) -> tuple[Optional[Path], Optional[Path]]:
    safe_session_id = (session_id or "").strip()
    if not safe_session_id or not LIVE_SESSION_ID_RE.fullmatch(safe_session_id):
        return None, None
    matches = sorted(LIVE_RECOVERY_DIR.glob(f"*_{safe_session_id}.pcm16"))
    if not matches:
        return None, None
    pcm_path = matches[-1]
    meta_path = pcm_path.with_suffix(".json")
    return pcm_path, meta_path


def _delete_live_recovery(session_id: str) -> bool:
    """Remove a session's spool AND its sidecar. Returns True if anything went.

    Both halves are deleted independently. ``_live_recovery_paths``
    resolves the pair by globbing for the ``.pcm16``, so once the spool
    is gone it answers "no such recovery" and the previous form returned
    immediately — leaving the ``.json`` sidecar behind with nothing that
    could ever name it again. Measured on this machine: 207 orphan
    sidecars against a single live spool, one per recording of the past
    day, cleared only by the 24 h retention sweep long after they stopped
    meaning anything.

    Deleting a session's remains must not depend on which half of it
    still happens to exist.
    """
    stem_glob = f"*_{session_id}" if LIVE_SESSION_ID_RE.fullmatch(session_id or "") else ""
    if not stem_glob:
        return False
    removed = False
    # Sidecar BEFORE spool, and the order is load-bearing — for the
    # opposite reason to the one recorded here before. An orphan
    # ``.json`` advertises nothing: ``_list_live_recoveries`` globs the
    # ``.pcm16`` files and tolerates a missing sidecar, so a recovery
    # whose PCM is gone is simply not listed. The failure that DOES
    # matter is the other one — sidecar removed, spool unlink failed —
    # because the ``.pcm16`` is what makes a recovery visible and
    # promotable, so the "discard" the user asked for would silently not
    # have happened. Removing the sidecar first means that shape ends
    # with the spool still present and the entry still offered, which is
    # the honest outcome; removing the spool first would end with a
    # discarded recording that still has a sidecar and looks discarded.
    for suffix in (".json", ".pcm16"):
        for path in LIVE_RECOVERY_DIR.glob(f"{stem_glob}{suffix}"):
            path.unlink(missing_ok=True)
            removed = True
    return removed


def _safe_delete_live_recovery(session_id: str) -> bool:
    try:
        return _delete_live_recovery(session_id)
    except OSError as exc:
        logger.warning("live recovery delete failed for %s: %s", session_id, exc)
        return False


def _session_id_from_recovery_stem(stem: str) -> str:
    """Recover the session id from a ``<prefix>_<session_id>`` stem (BUG-52).

    ``LIVE_SESSION_ID_RE`` allows underscores INSIDE an id, so a blind
    ``stem.split("_")[-1]`` truncated ids like ``a_b`` to ``b`` — producing
    mislabelled or duplicated recovery rows whenever the meta JSON was
    lost. Walk suffixes shortest-first and take the first that is itself
    a valid session id; if none matches, fall back to the last segment so
    downstream validation still gets to decide.
    """
    parts = stem.split("_")
    for cut in range(1, len(parts)):
        candidate = "_".join(parts[cut:])
        if LIVE_SESSION_ID_RE.fullmatch(candidate):
            return candidate
    return parts[-1] if parts else ""


# ── Live-session registry ───────────────────────────────────────────────────
#
# The one authority for "is this session streaming RIGHT NOW". It is
# in-process state with a process lifetime, which is exactly the claim
# being made — and exactly why the previous answer was wrong.
#
# The promote guard used to read ``status == "recording"`` out of the
# recovery sidecar on disk. That field is written once when the session
# opens and rewritten when it closes, so a session interrupted by a
# crash, a SIGKILL or an installer leaves it saying "recording" forever.
# The list endpoint offered such a session as recoverable (it has a spool
# file and enough bytes); the promote endpoint then refused it with
# 409 "session is still recording". The renderer promotes every listed
# recovery on startup, so the pair produced a permanent failure loop:
# "Could not recover 1 interrupted recording. Check the Recordings folder
# manually." on every single launch, with no way for the user to clear it.
#
# A persisted flag cannot express liveness across a process boundary. A
# set that is empty at startup by construction can: after a crash nothing
# is registered, so every stale "recording" sidecar is correctly seen as
# what it is — the crash this whole subsystem exists to recover from.
#
# Both endpoints consult this, so the list can no longer offer something
# the promote will reject.
_live_sessions_in_flight: set[str] = set()
_live_sessions_lock = threading.Lock()


def _register_live_session(session_id: str) -> None:
    if not session_id:
        return
    with _live_sessions_lock:
        _live_sessions_in_flight.add(session_id)


def _unregister_live_session(session_id: str) -> None:
    if not session_id:
        return
    with _live_sessions_lock:
        _live_sessions_in_flight.discard(session_id)


def _live_session_is_streaming(session_id: str) -> bool:
    with _live_sessions_lock:
        return session_id in _live_sessions_in_flight


def _list_live_recoveries() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for pcm_path in sorted(LIVE_RECOVERY_DIR.glob("*.pcm16"), reverse=True):
        try:
            meta_path = pcm_path.with_suffix(".json")
            raw = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
            session_id = (
                str(raw.get("session_id") or "").strip()
                or _session_id_from_recovery_stem(pcm_path.stem)
            )
            if not LIVE_SESSION_ID_RE.fullmatch(session_id):
                continue
            # Never offer a session that is streaming right now: promoting
            # it would truncate the WAV and unlink the spool from under the
            # live writer. Same predicate the promote guard uses, so the
            # two endpoints cannot disagree.
            if _live_session_is_streaming(session_id):
                continue
            bytes_count = int(raw.get("bytes") or pcm_path.stat().st_size or 0)
            if bytes_count < LIVE_RECOVERY_MIN_BYTES:
                continue
            records.append(
                {
                    "session_id": session_id,
                    "started_at": str(raw.get("started_at") or ""),
                    "finished_at": str(raw.get("finished_at") or ""),
                    "sample_rate": int(raw.get("sample_rate") or LIVE_SAMPLE_RATE_HZ),
                    "bytes": bytes_count,
                    "model": str(raw.get("model") or DEFAULT_LOCAL_TRANSCRIPTION_MODEL),
                    "language": str(raw.get("language") or "auto"),
                    "duration_sec": round(bytes_count / float(LIVE_PCM_BYTES_PER_SEC), 2),
                    # The sidecar's own account of how the spool ended.
                    # ``_finalize_live_recovery`` records ``status`` and a
                    # ``write_error`` reason when the spool could not take
                    # a chunk, and nothing read either field — so a
                    # half-written session was offered to the user exactly
                    # like a clean one, and promoting it silently produced
                    # truncated audio.
                    "status": str(raw.get("status") or ""),
                    "write_error": str(raw.get("write_error") or ""),
                }
            )
        except Exception as _list_err:
            logger.warning(
                "_list_live_recoveries: skipping %s — %s", pcm_path, _list_err
            )
            continue
    return records


def _acquire_session_promote_lock(session_id: str) -> threading.Lock:
    """Return a stable per-session lock, and count this holder.

    The registry dict is protected by ``_live_promote_lock`` so two
    concurrent callers never race to create their own lock instance.

    The COUNT is what makes the registry entry safe to remove. It used
    to be popped unconditionally when a caller finished, while a second
    caller could still be blocked on that very object — so a THIRD
    caller found nothing, created a fresh ``Lock`` and entered the body
    beside the second. The idempotency cache hides that on the happy
    path; the paths that cache nothing (404/400/413/409) do not, and two
    promotes of one session could then run at once.
    """
    with _live_promote_lock:
        lock, waiters = _live_promote_session_locks.get(
            session_id, (None, 0)
        )
        if lock is None:
            lock = threading.Lock()
        _live_promote_session_locks[session_id] = (lock, waiters + 1)
        return lock


def _release_session_promote_lock(session_id: str) -> None:
    """Drop this holder, and the registry entry once nobody is left.

    The idempotency cache entry survives either way, so retries still
    hit the fast path.
    """
    with _live_promote_lock:
        entry = _live_promote_session_locks.get(session_id)
        if entry is None:
            return
        lock, waiters = entry
        if waiters <= 1:
            _live_promote_session_locks.pop(session_id, None)
        else:
            _live_promote_session_locks[session_id] = (lock, waiters - 1)


def _lookup_live_promote_cache(session_id: str) -> Optional[dict]:
    now = time.monotonic()
    with _live_promote_lock:
        # Opportunistic GC so the cache cannot grow without bound.
        stale = [
            sid
            for sid, (ts, _) in _live_promote_cache.items()
            if now - ts > _LIVE_PROMOTE_CACHE_TTL_SEC
        ]
        for sid in stale:
            _live_promote_cache.pop(sid, None)
        entry = _live_promote_cache.get(session_id)
        if entry is None:
            return None
        ts, payload = entry
        if now - ts > _LIVE_PROMOTE_CACHE_TTL_SEC:
            _live_promote_cache.pop(session_id, None)
            return None
        # Validate that the promoted files still exist on disk. If the
        # user ran DELETE /api/recordings between the original promote
        # and this retry, returning the cached success would claim a
        # nonexistent recording and the frontend's audio fetch would
        # 404. Treat a missing file as a cache miss so the promoter
        # re-runs and recreates the entry.
        name = str(payload.get("name") or "")
        audio_name = str(payload.get("audio_name") or "")
        archive_dir_str = str(payload.get("archive_dir") or "")
        if name and archive_dir_str:
            try:
                archive_dir = Path(archive_dir_str)
                if not (archive_dir / name).exists():
                    _live_promote_cache.pop(session_id, None)
                    return None
                if audio_name and not (archive_dir / audio_name).exists():
                    _live_promote_cache.pop(session_id, None)
                    return None
            except OSError:
                # Path computation failed (invalid chars, permission);
                # treat as cache miss and re-run promoter.
                _live_promote_cache.pop(session_id, None)
                return None
        return dict(payload)


def _store_live_promote_cache(session_id: str, payload: dict) -> None:
    # Mirror the opportunistic GC from ``_lookup_live_promote_cache``.
    # Without it, a workload that only writes (recovery promotions with
    # fresh session_ids never revisited by the client) grows the cache
    # without bound — each entry survives until a lookup eventually
    # walks over it. Adding the purge here makes the cache bounded by
    # the recent-activity window regardless of read/write mix.
    now = time.monotonic()
    with _live_promote_lock:
        stale = [
            sid
            for sid, (ts, _) in _live_promote_cache.items()
            if now - ts > _LIVE_PROMOTE_CACHE_TTL_SEC
        ]
        for sid in stale:
            _live_promote_cache.pop(sid, None)
        _live_promote_cache[session_id] = (now, dict(payload))


def _promote_live_recovery(
    session_id: str,
    archive_dir: str = "",
    recording_collection: str = "live",
) -> dict[str, Any]:
    # Fast path: a freshly cached success means we served this promotion
    # recently. Return the stored result so UI retries are idempotent
    # instead of producing a 404 or a duplicate WAV.
    cached = _lookup_live_promote_cache(session_id)
    if cached is not None:
        return cached

    session_lock = _acquire_session_promote_lock(session_id)
    try:
        with session_lock:
            # Re-check under the lock — a racing caller may have completed
            # the promotion while we were waiting for the lock.
            cached = _lookup_live_promote_cache(session_id)
            if cached is not None:
                return cached

            pcm_path, meta_path = _live_recovery_paths(session_id)
            if pcm_path is None or meta_path is None or not pcm_path.exists():
                raise HTTPException(status_code=404, detail="live recovery not found")
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
            # TOCTOU guard: promoting a session that is STILL recording
            # would produce a truncated WAV and then unlink the PCM out
            # from under the live WS writer — every subsequent second of
            # the session streams into an unlinked inode and is lost
            # silently at finalize.
            #
            # The question is asked of the live-session registry, not of
            # ``meta["status"]``. A sidecar saying "recording" with no
            # live session behind it is not a session in progress; it is
            # the crash signature this endpoint exists to recover from,
            # and refusing it made every such recording permanently
            # unrecoverable.
            if _live_session_is_streaming(session_id):
                raise HTTPException(
                    status_code=409,
                    detail="session is still recording; stop it before promoting",
                )
            # Refuse an oversized spool BEFORE touching it. The
            # conversion below streams (``write_wav_from_pcm16_stream``,
            # ~2 MB per chunk), so this is a bound on how much of the
            # user's disk one promote may turn into a WAV — not the RAM
            # bound the old whole-file float32 conversion needed. The
            # ceiling is ``MAX_RECOVERY_PROMOTE_BYTES``, derived from
            # the spool ceiling so the two cannot drift.
            pcm_size = pcm_path.stat().st_size
            readable_pcm_size = pcm_size - (pcm_size % 2)
            if pcm_size != readable_pcm_size:
                logger.warning(
                    "live recovery %s has odd byte length (%d); ignoring trailing byte",
                    session_id,
                    pcm_size,
                )
            if readable_pcm_size < LIVE_RECOVERY_MIN_BYTES:
                raise HTTPException(status_code=400, detail="live recovery too short")
            if pcm_size > MAX_RECOVERY_PROMOTE_BYTES:
                # Do NOT interpolate `pcm_path` into the response body —
                # the absolute filesystem path (containing the user's OS
                # profile name + data dir layout) would leak to any API
                # consumer. Log the path locally; clients get the session
                # id only and can retrieve the spool via the authenticated
                # session-metadata endpoint if needed.
                logger.warning(
                    "live recovery too large (%d B, max %d B); spool left at %s",
                    pcm_size, MAX_RECOVERY_PROMOTE_BYTES, pcm_path,
                )
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"live recovery too large (max "
                        f"{MAX_RECOVERY_PROMOTE_BYTES // (1024 * 1024)} MB)"
                    ),
                )
            # Stream PCM16 → WAV at constant memory (BUG-01): the spool
            # may now be as large as the promote ceiling (4 GB); reading
            # it whole into a float32 array cost ~3x its size in RAM and
            # OOM-killed 8-16 GB hosts.
            started_at = str(meta.get("started_at") or "").strip()
            model = str(meta.get("model") or DEFAULT_LOCAL_TRANSCRIPTION_MODEL).strip() or DEFAULT_LOCAL_TRANSCRIPTION_MODEL
            language = str(meta.get("language") or "auto").strip() or "auto"
            pinned_archive_dir = str(meta.get("archive_dir") or "").strip()
            collection = _normalize_recording_collection(
                recording_collection
                or meta.get("recording_collection")
                or RECORDING_COLLECTION_LIVE
            )
            title = f"Recovered {started_at or datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            target_dir = _resolve_recordings_collection_target_dir(
                archive_dir or pinned_archive_dir,
                collection=collection,
            )
            # The SAME reservation the save endpoints use. This used to
            # be ``_unique_recording_stem`` — check the name, then use
            # it — while the reservation primitive (``O_EXCL``) already
            # existed and was applied on the neighbouring path. Two
            # answers to "is this name free", one of them able to lose a
            # race with the other and overwrite the .txt/.wav it picked.
            stem, text_out = _claim_recording_text_path(
                target_dir, _recording_stem_candidates(title)
            )
            audio_out = target_dir / f"{stem}.wav"
            tmp_audio = _atomic_temp_path(audio_out)
            try:
                write_wav_from_pcm16_stream(str(pcm_path), str(tmp_audio), LIVE_SAMPLE_RATE_HZ)
                atomic_promote_file(tmp_audio, audio_out)
                _write_recording_text_file(
                    out=text_out,
                    title=title,
                    source_text="[Recovered live audio capture]",
                    transcript_text="",
                    provider="local",
                    model=model,
                    language=language,
                )
                # 1.1.25 fix: register the archive AFTER writes succeed.
                # Previously called before write_wav; if the write
                # failed, the archive dir was already registered for
                # nothing, polluting ``_known_archive_dirs.json`` with
                # paths that contain no user data and slowing every
                # subsequent retention sweep.
                _register_archive_dir(target_dir)
            except Exception:
                # Roll back: if the text write failed after the audio was
                # already placed at its final path, delete the orphaned
                # audio so it doesn't leak on disk with no .txt sibling.
                _best_effort_unlink(audio_out, context="live recovery promotion rollback")
                # And give the NAME back — the claim marker outlives the
                # files, and ``_write_recording_text_file`` only releases
                # it on the paths that reach it (B-016).
                _release_recording_text_claim(
                    text_out, "live recovery promotion claim rollback"
                )
                raise
            finally:
                _best_effort_unlink(tmp_audio, context="live recovery tmp cleanup")
            # Same retention policy as ``save_recording_with_audio``. The
            # freshly promoted stem is exempt so a clock skew can never
            # collect the audio we just recovered.
            _prune_recording_audio(target_dir, keep_stems=(stem,))
            _invalidate_recordings_cache()
            result = {
                "name": text_out.name,
                "audio_name": audio_out.name,
                "archive_dir": str(target_dir),
            }
            _safe_delete_live_recovery(session_id)
            _store_live_promote_cache(session_id, result)
    finally:
        # Always release the per-session lock entry so the dict does not
        # grow unbounded when callers hit 404/400 and never retry.
        _release_session_promote_lock(session_id)
    return result


async def _require_api_auth(request: Request) -> None:
    # ``/api/health`` is unauthenticated because it declares no
    # ``Depends(_require_api_auth)``, and that route declaration is the
    # only place the exemption should live. A path check here was
    # unreachable — and would have silently exempted the endpoint the
    # day someone added the dependency, which is the opposite of what
    # adding it means.
    provided = (request.headers.get("x-api-token") or "").strip()
    # Constant-time comparison — prevents a timing-attack-based byte-by-byte
    # recovery of API_TOKEN over the loopback/LAN. secrets.compare_digest
    # requires both operands to be the same type; encode to bytes so a
    # unicode-only user input cannot panic the comparison.
    if not provided:
        raise HTTPException(status_code=401, detail="unauthorized")
    if not secrets.compare_digest(provided.encode("utf-8"), API_TOKEN.encode("utf-8")):
        # Not the renderer. The command-line client holds a token of its
        # own, and it is NOT the renderer's under another name: it opens
        # the transcription routes and nothing else, so a leaked CLI
        # token cannot read the config, the provider keys or the
        # archive. The route list is ``cli_access._CLI_ROUTES``; a route
        # that is not on it answers 403 rather than 401, because the
        # token IS valid — it is this path that is closed to it.
        if not CLI_ACCESS.token_matches(provided):
            raise HTTPException(status_code=401, detail="unauthorized")
        if not cli_token_may_call(request.method, request.url.path):
            raise HTTPException(
                status_code=403,
                detail="the command-line token may not call this endpoint",
            )
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if origin and not _origin_allowed(origin, request):
            raise HTTPException(status_code=403, detail="forbidden origin")
    client_key = request.client.host if request.client else "unknown"
    if not _touch_rate_limit(_request_windows, client_key, RATE_LIMIT_PER_MIN):
        raise HTTPException(status_code=429, detail="rate limit exceeded")


if frontend_assets_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(frontend_assets_dir)), name="assets")


# Cache-control policy:
#   /           → no-store (HTML entry changes on every rebuild; clients must
#                 always fetch the latest bundle hashes).
#   /assets/*   → immutable, 1 year (Vite emits hashed filenames).
#   /api/*      → no caching headers (let FastAPI responses decide).
_INDEX_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}
_ASSETS_CACHE_HEADERS = {
    "Cache-Control": "public, max-age=31536000, immutable",
}


@app.middleware("http")
async def guard_host_and_set_cache_control(request: Request, call_next):
    # Host allowlist runs BEFORE the route so the unauthenticated
    # token-bearing ``GET /`` is covered too. See _host_header_allowed
    # for the DNS-rebinding rationale.
    if not _host_header_allowed(request.headers.get("host")):
        logger.warning(
            "rejected request with non-loopback Host header path=%s",
            request.url.path,
        )
        return JSONResponse(status_code=421, content={"detail": "misdirected request"})
    # The address this backend was actually reached at, recorded for the
    # command-line client. The desktop shell asks for 8321 and takes the
    # next free port when it is busy, so the port is not a constant and
    # the connection file would otherwise point at a backend that moved.
    # A no-op unless CLI access is on AND the address changed (see
    # CliAccess.sync_connection), so the common request pays a bool and
    # a string compare. Placed after the Host allowlist so a rejected
    # request can never rewrite the recorded address.
    if CLI_ACCESS.is_enabled():
        CLI_ACCESS.sync_connection(base_url_from_scope(request.scope))
    response = await call_next(request)
    path = request.url.path or ""
    if path.startswith("/assets/"):
        for k, v in _ASSETS_CACHE_HEADERS.items():
            response.headers[k] = v
    return response


@app.get("/", response_class=HTMLResponse)
def index():
    index_path = frontend_dist_dir / "index.html"
    if not index_path.exists():
        return "frontend/dist/index.html not found. Run `npm --prefix frontend run build`."
    html = index_path.read_text(encoding="utf-8")
    bootstrap_payload = _frontend_runtime_payload()
    injected = (
        "<script>"
        f'window.__TRANSCRIPTOR_API_TOKEN={json.dumps(API_TOKEN)};'
        f'window.__TRANSCRIPTOR_BOOTSTRAP={json.dumps(bootstrap_payload)};'
        "</script>"
    )
    if "</body>" in html:
        html = html.replace("</body>", injected + "</body>")
    else:
        html = html + injected
    return HTMLResponse(html, headers=_INDEX_CACHE_HEADERS)


def _frontend_runtime_payload() -> dict[str, Any]:
    """What the renderer is told about this backend, before it asks.

    Injected into ``GET /`` and repeated by ``/api/health``. Everything
    here is a fact the BACKEND owns and the renderer would otherwise have
    to restate — and a restated fact is one that drifts. The dual-stream
    defaults are the clearest case (B-027 / R-016): the renderer resolves
    an absent preference to *something* in order to show a control, that
    resolution is what the next debounced autosave writes to disk, and a
    renderer guessing "off" would therefore switch a backend default off
    behind the user's back, permanently and silently.
    """
    return {
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "accepted_audio_exts": sorted(ext.lstrip(".") for ext in ALLOWED_AUDIO_EXTS),
        # The canonical Content-Type for each accepted extension. The
        # renderer inverts it to name a downloaded/played file when the
        # backend's ``Content-Disposition`` is missing (S-04); it used to
        # keep its own 12-entry map against these 19, missing every video
        # container and inventing four MIME spellings this backend cannot
        # produce — an import-time assert below guarantees every accepted
        # extension is mapped, so the inverse of this map is complete.
        # Declaration order is preserved deliberately: several MIMEs are
        # shared by two extensions (``audio/ogg`` by ogg and oga,
        # ``video/mp4`` by mp4 and m4v, ``video/mpeg`` by mpg and mpeg),
        # and the map lists the canonical one FIRST, so "first wins" is
        # the rule that gives the renderer's inverse the right answer.
        "audio_ext_to_mime": {
            ext.lstrip("."): mime for ext, mime in AUDIO_EXT_TO_MIME.items()
        },
        "live_sample_rate_hz": LIVE_SAMPLE_RATE_HZ,
        # What the live path defaults to and what it can offer. The
        # renderer fills its LANG picker from ``languages`` (and from
        # that picker, the Upload and dual-stream pickers), resolves an
        # absent preference with ``dual_stream``/``dual_secondary_language``
        # instead of a constant of its own, and states the keyterm budget
        # this backend actually enforces rather than a number copied into
        # the markup.
        "live_defaults": {
            "languages": list(LIVE_LANGUAGE_OPTIONS),
            "dual_stream": DUAL_STREAM_DEFAULT,
            "dual_secondary_language": DUAL_SECONDARY_LANGUAGE_DEFAULT,
            "dual_secondary_languages": list(DUAL_SECONDARY_LANGUAGE_OPTIONS),
            "keyterm_token_budget": MAX_KEYTERM_TOKENS,
        },
        "model_catalog": health_model_catalog(),
        "runtime_limits": {
            "upload_queue_max_parallel": jobs.max_workers,
            "upload_queue_max_persisted_items": UPLOAD_QUEUE_MAX_PERSISTED_ITEMS,
        },
    }


@app.get("/api/health")
def health():
    return {
        "ok": True,
        **_frontend_runtime_payload(),
        "boot_nonce": BOOT_NONCE,
    }


@app.get("/api/ui/upload-queue")
def get_upload_queue_state(_auth: None = Depends(_require_api_auth)):
    return _read_upload_queue_state()


@app.put("/api/ui/upload-queue")
def put_upload_queue_state(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    state = _normalize_upload_queue_state(payload)
    atomic_write_json(UPLOAD_QUEUE_STATE_PATH, state)
    return {"ok": True, **state}


@app.get("/api/ui/live-draft")
def get_live_draft_state(_auth: None = Depends(_require_api_auth)):
    return _read_live_draft_state()


@app.put("/api/ui/live-draft")
def put_live_draft_state(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    state = _write_live_draft_state(payload)
    return {"ok": True, **state}


@app.delete("/api/ui/live-draft")
def delete_live_draft_state(session_id: str = "", _auth: None = Depends(_require_api_auth)):
    state = _clear_live_draft_state(session_id)
    return {"ok": True, **state}


def _hub_offline_error_types() -> tuple[type[BaseException], ...]:
    """Exception types that mean "the model host is unreachable".

    Collected by import rather than by matching message text: the type
    is the fact, the message is prose. Each import is optional because
    the runtime that ships with the app is not the only one this backend
    runs under (a dev venv may lack ``requests``); a missing module
    simply contributes no types.
    """
    types: list[type[BaseException]] = []
    for module_name, names in (
        # httpx.TransportError covers ConnectError/ConnectTimeout/
        # ReadTimeout/ProxyError — every way its transport can fail to
        # reach the host, and the class in the 2026-09-01 tracebacks.
        ("httpx", ("TransportError",)),
        ("httpcore", ("NetworkError", "TimeoutException", "ProxyError")),
        ("requests.exceptions", ("ConnectionError", "Timeout")),
        # The hub's own way of saying "not cached and I cannot reach the
        # network to fetch it".
        ("huggingface_hub.errors", ("LocalEntryNotFoundError", "OfflineModeIsEnabled")),
    ):
        try:
            module = importlib.import_module(module_name)
        except Exception:  # pragma: no cover - depends on the environment
            continue
        for name in names:
            candidate = getattr(module, name, None)
            if isinstance(candidate, type) and issubclass(candidate, BaseException):
                types.append(candidate)
    # DNS failure below every client library.
    types.append(socket.gaierror)
    return tuple(types)


_HUB_OFFLINE_ERRORS = _hub_offline_error_types()
_hub_offline_warned = False


def _is_hub_offline_error(exc: BaseException) -> bool:
    """Is this failure "the network is not there" rather than a bug?

    Walks the cause/context chain because ``huggingface_hub`` re-raises
    transport errors wrapped in its own, the same way
    ``_is_broken_pipe_error`` walks it for ASGI disconnects.
    """
    seen: set[int] = set()
    current: Optional[BaseException] = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, _HUB_OFFLINE_ERRORS):
            return True
        current = current.__cause__ or current.__context__
    return False


@app.post("/api/transcribe/warmup")
async def transcribe_warmup(
    _auth: None = Depends(_require_api_auth),
    model: str = Form(DEFAULT_LOCAL_TRANSCRIPTION_MODEL),
):
    model = _form_text(model, DEFAULT_LOCAL_TRANSCRIPTION_MODEL)
    if model not in ALLOWED_LOCAL_MODELS:
        raise HTTPException(status_code=400, detail="unsupported model")
    # Already-warm short circuit. ``warm_model(probe=True)`` re-runs two
    # full transcriptions of synthetic audio on every call; the renderer
    # fires this endpoint on startup, on provider change AND on every
    # network-state flip, so without this guard a single session paid
    # the probe cost repeatedly for a model that was already resident.
    # ``model_is_resident`` is the authority — a warm-state entry whose
    # model has since been evicted by the idle sweeper must re-warm.
    cached = warm_state(model)
    if cached and model_is_resident(model):
        return {"ok": True, "model": model, "state": cached, "cached": True}
    loop = asyncio.get_running_loop()
    # ``probe=True``: only loading the weights leaves the lazy VAD load
    # and the first encoder/decoder pass to be paid by the user's first
    # live window, which is exactly the stall that makes the assist fall
    # behind and then have to catch up with an oversized (slower still)
    # window. Callers fire this in the background, so the extra probe
    # never sits on an interactive path.
    try:
        state = await loop.run_in_executor(None, lambda: warm_model(model, probe=True))
    except Exception as e:
        # Loading weights goes through the Hugging Face hub even for a
        # model already in the local cache, so a machine with no network
        # — or a user who works entirely through an API provider and
        # never needs the local model — made this endpoint answer 500
        # (five times on 2026-09-01, httpx connection errors in every
        # traceback; audit §7). An unreachable host is a STATE of the
        # environment, not a server fault: the renderer fires this on
        # startup, on provider change and on every network-state flip,
        # and a 500 there is noise it cannot act on. Anything that is
        # NOT a transport failure still raises — a genuinely broken
        # loader must not hide behind "offline".
        if not _is_hub_offline_error(e):
            raise
        global _hub_offline_warned
        detail = _safe_error_text(e)
        if not _hub_offline_warned:
            _hub_offline_warned = True
            logger.warning(
                "model warmup: model host unreachable (%s) — reporting state=offline; "
                "local transcription will need the network on first use",
                detail,
            )
        return {"ok": False, "model": model, "state": "offline", "detail": detail}
    return {"ok": True, "model": model, "state": warm_state(model) or state, "cached": False}


@app.get("/api/network")
async def network_status(_auth: None = Depends(_require_api_auth)):
    """Probe public URLs for connectivity.

    Runs in a thread pool via asyncio.to_thread so the blocking
    urllib calls never stall the FastAPI event loop — without this,
    3 × 2.5 s sequential probes would freeze all concurrent WS
    frames and recording saves for up to 7.5 s.
    """
    probes = (
        "https://openrouter.ai",
        "https://www.google.com/generate_204",
        "https://www.cloudflare.com/cdn-cgi/trace",
    )

    def _probe_sync() -> dict:
        best_latency_ms: Optional[int] = None
        online = False
        for url in probes:
            started = time.perf_counter()
            try:
                with urlopen(url, timeout=2.5) as resp:
                    code = getattr(resp, "status", 200) or 200
                    ok = int(code) < 500
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                if ok:
                    online = True
                    if best_latency_ms is None or elapsed_ms < best_latency_ms:
                        best_latency_ms = elapsed_ms
            except Exception:
                continue
        return {"online": online, "latency_ms": best_latency_ms if online else None}

    return await asyncio.to_thread(_probe_sync)


async def _save_upload_file(upload: UploadFile, target: Path) -> int:
    """Stream an UploadFile to disk with a hard MAX_UPLOAD_BYTES ceiling.

    If the request exceeds the ceiling OR any other exception bubbles
    out of the copy loop, the partially-written target is unlinked
    before the exception propagates. Without the cleanup, a client
    uploading a 2 GB file would leave up to 500 MB of orphaned bytes
    on disk on every attempt, eventually filling the data volume.

    The partial file is rendered unusable anyway (it's truncated at
    the ceiling), and FastAPI endpoints always retry with a fresh
    tmp path if needed, so deleting it here is safe.
    """
    total = 0
    try:
        with target.open("wb") as f:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
                    )
                f.write(chunk)
        return total
    except BaseException:
        # Partial upload cleanup. BaseException covers HTTPException,
        # asyncio.CancelledError (client disconnected mid-upload), and
        # unexpected OSErrors (disk full, permission change). In every
        # case the file on disk is either truncated or incomplete —
        # deleting it is the correct contract. ``missing_ok`` guards
        # against the (rare) case where ``target.open`` itself threw
        # before the file was ever created.
        try:
            target.unlink(missing_ok=True)
        except OSError as cleanup_err:
            logger.warning(
                "partial upload cleanup failed for %s: %s", target, cleanup_err
            )
        raise


def _atomic_write_text(path: Path, content: str) -> None:
    """Thin wrapper — delegates to the shared SSOT atomic writer.

    Kept as a module-local alias so the many call sites inside
    backend.main that already use this name don't need a refactor.
    The shared ``storage.atomic_write_text`` adds ``fsync()`` of the
    file descriptor AND ``fsync()`` of the parent directory on POSIX,
    making writes crash-durable in addition to atomic. The prior
    implementation was atomic in the rename-landing sense only —
    contents could be lost to page cache on a power loss.
    """
    atomic_write_text(path, content)


def _safe_user_filename_part(value: str, *, fallback: str = "recording", max_len: int = 120) -> str:
    raw = unicodedata.normalize("NFC", str(value or ""))
    raw = raw.replace("\\", "/")
    raw = os.path.basename(raw).strip()
    chars: list[str] = []
    for ch in raw:
        if ch.isalnum() or ch in {" ", ".", "_", "-"}:
            chars.append(ch)
        else:
            chars.append("_")
    cleaned = "".join(chars)
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned)
    cleaned = cleaned[:max_len].strip(" ._-")
    if not cleaned:
        cleaned = fallback
    reserved_probe = cleaned.split(".", 1)[0].lower()
    if reserved_probe in _WINDOWS_RESERVED_BASENAMES:
        cleaned = f"_{cleaned}"
    return cleaned


def _normalize_filename(name: str) -> str:
    # 1.1.25: strip BOTH POSIX and NT path separators regardless of host
    # OS, so a Windows-style filename submitted to a POSIX backend can't
    # keep its backslashes through ``os.path.basename`` (POSIX
    # ``basename`` does NOT split on backslash). Defence-in-depth.
    raw = unicodedata.normalize("NFC", str(name or "audio.wav")).replace("\\", "/")
    base = os.path.basename(raw).strip()
    raw_ext = Path(base).suffix.lower()
    ext = raw_ext if re.fullmatch(r"\.[A-Za-z0-9]{1,12}", raw_ext or "") else ".wav"
    stem = Path(base).stem if base else "audio"
    cleaned_stem = _safe_user_filename_part(stem, fallback="audio", max_len=120)
    cleaned = f"{cleaned_stem}{ext}"
    # 1.1.25: previous form returned ``cleaned`` even when it lacked an
    # extension entirely (e.g. input "audio." → cleaned "audio" → no
    # extension), letting downstream content-type / retention paths
    # treat it as an unknown format. Always ensure a fallback ``.wav``
    # extension when the user-supplied name didn't produce one.
    return cleaned


def _recording_text_name_leaf(name: str) -> str:
    raw = unicodedata.normalize("NFC", str(name or "")).replace("\\", "/")
    leaf = os.path.basename(raw).strip()
    if "\x00" in raw or leaf in {"", ".", ".."} or not leaf.lower().endswith(".txt"):
        raise HTTPException(status_code=400, detail="invalid recording name")
    reserved_probe = Path(leaf).stem.lower()
    if reserved_probe in _WINDOWS_RESERVED_BASENAMES:
        raise HTTPException(status_code=400, detail="invalid recording name")
    return leaf


def _best_effort_unlink(path: Path, *, context: str) -> bool:
    try:
        path.unlink(missing_ok=True)
        return True
    except OSError as exc:
        logger.warning("%s: failed to remove %s: %s", context, path, exc)
        return False


# ── The upload-snapshot name convention ─────────────────────────────
#
# Every file the backend parks in UPLOADS_DIR is named
# ``<job or request id>.<original filename>``. Five call sites wrote
# that shape by hand and nothing read it back, which is why a recording
# saved from a snapshot was filed under the job's UUID: the archive
# names a recording after its source file, and the source file's name
# had a UUID glued to the front of it.
#
# Stated here once, with the reader that inverts it, so the two cannot
# drift — the failure mode of a private convention with two authors is
# a name that is right on the way in and wrong on the way back.
_UPLOAD_SNAPSHOT_PREFIX_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.",
    re.IGNORECASE,
)


def _upload_snapshot_path(owner_id: str, orig_name: str) -> Path:
    """Where a snapshot of *orig_name* for job/request *owner_id* lives."""
    return UPLOADS_DIR / f"{owner_id}.{orig_name}"


def _source_media_original_name(source_path: Path) -> str:
    """The name the USER knows the file by.

    For a file the user picked, that is its own name. For a snapshot the
    backend made, it is the name underneath the id prefix — the archive
    is the user's, and "meeting.mp4" is what belongs in it, not
    "9f2c….meeting.mp4". A path outside UPLOADS_DIR is never stripped,
    so a real file whose name merely starts with something UUID-shaped
    keeps every character of it.
    """
    name = source_path.name
    if not _is_backend_owned_upload_path(source_path):
        return name
    return _UPLOAD_SNAPSHOT_PREFIX_RE.sub("", name, count=1) or name


def _is_backend_owned_upload_path(path: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(UPLOADS_DIR.resolve(strict=False))
        return True
    except (OSError, ValueError):
        return False


def _validate_audio_filename(name: str) -> None:
    # 1.1.25: previous form was ``if ext and ext not in ALLOWED_...``
    # which silently passed when the filename had NO extension. A POST
    # with ``filename="evil"`` (no ext) bypassed the audio-format
    # whitelist entirely and was saved as ``{job_id}.evil``, then
    # routed to ffmpeg / soundfile which threw a confusing "invalid
    # data" error deep in the pipeline instead of a clean 400 at the
    # validator boundary. Now: empty extension is itself rejected.
    ext = Path(name).suffix.lower()
    if not ext or ext not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(status_code=400, detail="unsupported audio file extension")


def _resolve_source_media_path(source_path: object) -> Path:
    """Resolve a user-selected source media path for retry-by-path flows.

    The frontend can only persist a path after Electron's file picker or
    drag-drop grants a File object. The backend still owns the trust
    boundary: it accepts only an absolute, existing, regular media file
    within the same size/extension contract as UploadFile endpoints.
    """
    hint = str(source_path or "").strip()
    if not hint:
        raise HTTPException(status_code=400, detail="source_path is required")
    candidate = Path(hint).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="source_path must be an absolute path")
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="source file is no longer available") from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail="source file path is not accessible") from exc
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="source_path must point to a file")
    orig_name = _normalize_filename(resolved.name)
    _validate_audio_filename(orig_name)
    try:
        size = resolved.stat().st_size
    except OSError as exc:
        raise HTTPException(status_code=400, detail="source file is not accessible") from exc
    if size <= 0:
        raise HTTPException(status_code=400, detail="source file is empty")
    if size > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
        )
    suffixes = {suffix.lower() for suffix in resolved.suffixes}
    if suffixes & {".crdownload", ".download", ".part", ".tmp"}:
        raise HTTPException(status_code=409, detail="source file is still downloading")
    try:
        stat_before = resolved.stat()
        time.sleep(SOURCE_MEDIA_STABILITY_PROBE_SEC)
        stat_after = resolved.stat()
    except OSError as exc:
        raise HTTPException(status_code=400, detail="source file is not accessible") from exc
    if (
        stat_before.st_size != stat_after.st_size
        or int(stat_before.st_mtime_ns) != int(stat_after.st_mtime_ns)
    ):
        raise HTTPException(status_code=409, detail="source file is still being written; wait for it to finish and retry")
    return resolved


def _copy_source_media_file(source_path: Path, target: Path) -> int:
    total = 0
    digest = hashlib.sha256()
    try:
        stat_before = source_path.stat()
    except OSError as exc:
        raise HTTPException(status_code=400, detail="source file is not accessible") from exc
    try:
        with source_path.open("rb") as src, target.open("wb") as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
                    )
                digest.update(chunk)
                dst.write(chunk)
        try:
            stat_after = source_path.stat()
        except OSError as exc:
            raise HTTPException(status_code=400, detail="source file changed during copy") from exc
        if (
            stat_before.st_dev != stat_after.st_dev
            or stat_before.st_ino != stat_after.st_ino
            or total != stat_before.st_size
            or stat_after.st_size != stat_before.st_size
        ):
            raise HTTPException(status_code=409, detail="source file changed during copy; wait for it to finish and retry")
        source_total = 0
        source_digest = hashlib.sha256()
        with source_path.open("rb") as verify:
            while True:
                chunk = verify.read(1024 * 1024)
                if not chunk:
                    break
                source_total += len(chunk)
                if source_total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"file too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
                    )
                source_digest.update(chunk)
        if source_total != total or source_digest.digest() != digest.digest():
            raise HTTPException(status_code=409, detail="source file changed during copy; wait for it to finish and retry")
        return total
    except BaseException:
        try:
            target.unlink(missing_ok=True)
        except OSError as cleanup_err:
            logger.warning(
                "partial source media copy cleanup failed for %s: %s",
                target,
                cleanup_err,
            )
        raise


def _snapshot_source_media_for_job(source_path: Path, job_id: str) -> Path:
    orig_name = _normalize_filename(source_path.name)
    target = _upload_snapshot_path(job_id, orig_name)
    _copy_source_media_file(source_path, target)
    return target


def _normalize_language(value: str) -> Optional[str]:
    language = (value or "auto").strip()
    if language.lower() in {"", "auto"}:
        return None
    # ISO-like tags (en, ru, pt-BR, etc.)
    if not re.fullmatch(r"[A-Za-z]{2,8}(-[A-Za-z]{2,8}){0,2}", language):
        raise HTTPException(status_code=400, detail="invalid language code")
    return language


def _payload_bool(payload: Optional[dict], key: str, default: bool = False) -> bool:
    """Parse JSON boolean fields with the same semantics as form booleans."""
    if not isinstance(payload, dict) or key not in payload or payload.get(key) is None:
        return bool(default)
    value = payload.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        if value in (0, 1):
            return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off", ""}:
            return False
    raise HTTPException(status_code=400, detail=f"{key} must be a boolean")


def _form_default_value(value: Any, default: Any) -> Any:
    """Return FastAPI Form defaults when endpoint helpers are called directly.

    HTTP requests arrive here as parsed Python values. Unit tests and internal
    callers can omit optional form params, in which case Python passes the
    FastAPI ``Form(...)`` object itself as the default value.
    """
    if value is None:
        return default
    if value.__class__.__module__ == "fastapi.params" and hasattr(value, "default"):
        return getattr(value, "default")
    return value


def _form_text(value: Any, default: str = "") -> str:
    raw = _form_default_value(value, default)
    if raw is None:
        return default
    return str(raw)


def _first_nonempty_text(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _remote_model_from_payload(payload: Optional[dict]) -> str:
    data = payload or {}
    return _first_nonempty_text(
        data.get("model"),
        data.get("remote_model"),
        data.get("openrouter_model"),  # legacy alias kept for older clients
    )


def _form_bool(value: Any, default: bool = False) -> bool:
    raw = _form_default_value(value, default)
    if isinstance(raw, bool):
        return raw
    return _payload_bool({"value": raw}, "value", default)


def _collect_ws_closed_exc_types() -> tuple:
    """Exception types that mean "the peer already went away".

    Resolved defensively: the ``websockets`` package is only present
    because the Deepgram upstream needs it, and its exception module has
    moved between major versions. A missing import must degrade to the
    string matching below, never break startup.
    """
    types: list = [WebSocketDisconnect]
    try:
        from websockets.exceptions import ConnectionClosed  # type: ignore

        types.append(ConnectionClosed)
    except Exception:  # pragma: no cover - depends on installed version
        pass
    return tuple(types)


_WS_CLOSED_EXC_TYPES = _collect_ws_closed_exc_types()


def _exception_chain(exc: BaseException, depth: int = 6):
    """Yield ``exc`` and its ``__cause__``/``__context__`` ancestors.

    uvicorn re-raises a client disconnect wrapped in its own error, so the
    interesting type is rarely the outermost one. Depth-bounded and
    cycle-guarded because ``__context__`` can loop.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and depth > 0 and id(current) not in seen:
        seen.add(id(current))
        yield current
        depth -= 1
        current = current.__cause__ or current.__context__


def _is_broken_pipe_error(exc: Exception) -> bool:
    """Return True if the exception is a harmless broken-pipe or WebSocket shutdown race.

    These errors occur when the client disconnects mid-stream (e.g., tab close,
    network drop) and the server tries to write to a closed pipe. They are
    transient and safe to ignore — the recording data has already been captured.

    Classification is type-first. The string checks below were written for
    specific wordings and missed ``ConnectionClosedOK``, whose message is
    ``received 1000 (no status received [internal]); then sent 1000 …`` —
    so an ordinary client disconnect was logged as a WARNING with a full
    multi-frame traceback, thirteen times in one session's main.log. The
    exception also reaches us wrapped by uvicorn/Starlette, so the cause
    chain is walked rather than only the outermost object.
    """
    for cause in _exception_chain(exc):
        if _WS_CLOSED_EXC_TYPES and isinstance(cause, _WS_CLOSED_EXC_TYPES):
            return True
    msg = str(exc or "").lower()
    if isinstance(exc, BrokenPipeError):
        return True
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 32:
        return True
    if "broken pipe" in msg or "errno 32" in msg:
        return True
    # Harmless race on websocket shutdown: sender tries to push after close.
    if "unexpected asgi message 'websocket.send'" in msg:
        return True
    if "after sending 'websocket.close'" in msg:
        return True
    # ``websockets`` library (used for the upstream Deepgram connection)
    # raises this when ``send()`` fires after ``close()`` has already
    # gone out. It's the same class of post-close race as the Starlette
    # "after sending 'websocket.close'" message above, just from the
    # opposite side of the socket. Treating it as harmless keeps
    # production logs clean — previously it surfaced as a WARNING
    # (``ws send failed: Cannot call "send" once a close message has
    # been sent``) several times per recording during finalize.
    if 'cannot call "send" once a close message has been sent' in msg:
        return True
    # Same class, different phrasing used by some websockets versions
    # and by the ``ConnectionClosedOK``/``ConnectionClosedError``
    # exception chain.
    if "no close frame received or sent" in msg:
        return True
    return False


def _transcribe_with_retry(
    audio_path: str,
    model: str,
    *,
    language: Optional[str],
    word_timestamps: bool,
    retries: int = 1,
):
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            return transcribe_file(
                audio_path,
                model,
                language=language,
                word_timestamps=word_timestamps,
            )
        except Exception as e:
            last_exc = e
            if not _is_broken_pipe_error(e) or attempt >= retries:
                raise
            # Short backoff before retrying transient pipe failures.
            logger.warning("transcribe retry: broken pipe on attempt %d, retrying...", attempt + 1)
            time.sleep(0.35)
    if last_exc:
        raise last_exc
    raise RuntimeError("transcribe_with_retry failed without exception")


def _run_local_transcribe_once(
    *,
    run_id: str,
    upload_path: Path,
    model: str,
    language: Optional[str],
    split_stereo: bool,
    word_timestamps: bool,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> dict[str, Any]:
    temp_paths: list[str] = []

    def set_progress(value: float) -> None:
        if progress_cb is None:
            return
        try:
            progress_cb(value)
        except Exception as e:
            logger.debug("progress callback raised: %s", e)

    try:
        if split_stereo:
            wav_path = str(RESULTS_DIR / f"{run_id}.16k.wav")
            temp_paths.append(wav_path)
            ensure_wav_16k_preserve_channels(str(upload_path), wav_path)
            set_progress(0.15)
            # Register the channel files BEFORE split_channels writes
            # them (BUG-64): the paths are deterministic, and if the ch2
            # write fails the already-written ch1 would otherwise never
            # be cleaned up. The cleanup below tolerates absent files.
            _split_base = os.path.splitext(wav_path)[0]
            temp_paths.extend([
                f"{_split_base}.ch1.wav",
                f"{_split_base}.ch2.wav",
            ])
            ch1, ch2 = split_channels(wav_path)
        else:
            ch1, ch2 = (None, None)
            set_progress(0.15)

        if ch1 and ch2:
            set_progress(0.2)
            t1 = _transcribe_with_retry(
                ch1, model, language=language, word_timestamps=word_timestamps
            )
            set_progress(0.6)
            t2 = _transcribe_with_retry(
                ch2, model, language=language, word_timestamps=word_timestamps
            )
            set_progress(0.9)
            return merge_channel_transcripts(t1, t2)

        set_progress(0.25)
        mono_wav = str(RESULTS_DIR / f"{run_id}.mono16k.wav")
        temp_paths.append(mono_wav)
        ensure_wav_16k(str(upload_path), mono_wav, channels=1)
        return _transcribe_with_retry(
            mono_wav, model, language=language, word_timestamps=word_timestamps
        )
    finally:
        for p in temp_paths:
            try:
                os.remove(p)
            except OSError as e:
                logger.debug("temp file removal skipped for %s: %s", p, e)


def _submit_local_transcription_job(
    *,
    job_id: str,
    upload_path: Path,
    model: str,
    language: Optional[str],
    split_stereo: bool,
    word_timestamps: bool,
    cleanup_upload_path: bool,
) -> None:
    def run():
        try:
            jobs.raise_if_cancelled(job_id)
            jobs.set_running(job_id)

            def _on_local_progress(value: float) -> None:
                jobs.raise_if_cancelled(job_id)
                jobs.set_progress(job_id, value)

            result = _run_local_transcribe_once(
                run_id=job_id,
                upload_path=upload_path,
                model=model,
                language=language,
                split_stereo=split_stereo,
                word_timestamps=word_timestamps,
                progress_cb=_on_local_progress,
            )
            jobs.raise_if_cancelled(job_id)

            result_json_path = RESULTS_DIR / f"{job_id}.json"
            result_txt_path = RESULTS_DIR / f"{job_id}.txt"
            # SSOT atomic write — the lifespan shutdown hook exists to
            # prevent half-written result files on SIGTERM, but bare
            # ``Path.write_text`` is NOT atomic nor fsync'd: a kill
            # between open() and final flush leaves a zero-byte
            # result.json that parses as corrupt on next boot.
            atomic_write_json(result_json_path, result)
            atomic_write_text(result_txt_path, result.get("text", ""))
            jobs.set_done(
                job_id,
                result,
                {
                    "json": str(result_json_path),
                    "txt": str(result_txt_path),
                },
            )
        except JobCancelledError:
            jobs.cancel(job_id)
        except AudioError as e:
            jobs.set_error(job_id, _safe_error_text(e))
        except Exception as e:
            # Log the full exception locally so operators still have
            # the trace (paths, ffmpeg stderr, etc.), but redact before
            # persisting to the job store — job errors are returned
            # verbatim to the renderer.
            logger.exception("local transcription job failed (job_id=%s)", job_id)
            jobs.set_error(job_id, f"Transcription failed: {_safe_error_text(e)}")
        finally:
            if cleanup_upload_path:
                try:
                    os.remove(upload_path)
                except OSError as e:
                    logger.debug("upload cleanup skipped for %s: %s", upload_path, e)

    jobs.submit(run)


def _validate_config_payload(payload: dict) -> None:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid config")
    providers = payload.get("providers")
    if providers is not None and not isinstance(providers, dict):
        raise HTTPException(status_code=400, detail="providers must be an object")
    preferences = payload.get("preferences")
    if preferences is not None and not isinstance(preferences, dict):
        raise HTTPException(status_code=400, detail="preferences must be an object")
    if isinstance(preferences, dict):
        rec_dir = preferences.get("recordings_dir")
        if rec_dir is not None and not isinstance(rec_dir, str):
            raise HTTPException(status_code=400, detail="recordings_dir must be a string")


UPLOAD_QUEUE_STATE_PATH = UI_STATE_DIR / "upload_queue.json"
UPLOAD_QUEUE_STATE_VERSION = 1
UPLOAD_QUEUE_STATUSES = frozenset({"queued", "transcribing", "done", "error", "cancelled"})


def _default_upload_queue_state() -> dict[str, Any]:
    return {
        "version": UPLOAD_QUEUE_STATE_VERSION,
        "hideFinished": False,
        "items": [],
    }


def _upload_queue_str(value: object, max_len: int = 200_000) -> str:
    return str(value or "").strip()[:max_len]


def _upload_queue_number(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if 0 <= parsed < float("inf") else None


def _normalize_upload_queue_item(raw: object) -> Optional[dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    display_name = _upload_queue_str(raw.get("displayName"), 512)
    if not display_name:
        return None
    status = _upload_queue_str(raw.get("status"), 32)
    if status not in UPLOAD_QUEUE_STATUSES:
        # "I do not recognise this" is not "this failed". A client that
        # adds a status — a newer renderer against an older backend —
        # got every such item back from the persisted snapshot marked as
        # a failure it never had. ``queued`` is the neutral answer: the
        # item is still there and nothing is claimed about it.
        status = "queued"
    item: dict[str, Any] = {
        "id": _upload_queue_str(raw.get("id"), 128) or uuid.uuid4().hex,
        "displayName": display_name,
        "sizeBytes": int(_upload_queue_number(raw.get("sizeBytes")) or 0),
        "sourcePath": _upload_queue_str(raw.get("sourcePath"), 4096),
        "status": status,
        "text": _upload_queue_str(raw.get("text")),
        "error": _upload_queue_str(raw.get("error"), 4096),
        "provider": _upload_queue_str(raw.get("provider"), 32),
        "model": _upload_queue_str(raw.get("model"), 256),
        "language": _upload_queue_str(raw.get("language"), 32),
        "audioDurationSec": _upload_queue_number(raw.get("audioDurationSec")) or 0,
        "requestedProvider": _upload_queue_str(raw.get("requestedProvider"), 32),
        "requestedLanguage": _upload_queue_str(raw.get("requestedLanguage"), 32),
        "requestedModel": _upload_queue_str(raw.get("requestedModel"), 256),
        "requestedDiarize": bool(raw.get("requestedDiarize") is True),
        "savedName": _upload_queue_str(raw.get("savedName"), 512),
        "savedArchiveDir": _upload_queue_str(raw.get("savedArchiveDir"), 4096),
    }
    for field in ("startedAt", "endedAt", "completedAt"):
        value = _upload_queue_number(raw.get(field))
        if value is not None:
            item[field] = value
    return item


def _normalize_upload_queue_state(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="upload queue state must be an object")
    raw_items = payload.get("items")
    items_src = raw_items if isinstance(raw_items, list) else []
    items: list[dict[str, Any]] = []
    for raw in items_src[:UPLOAD_QUEUE_MAX_PERSISTED_ITEMS]:
        item = _normalize_upload_queue_item(raw)
        if item:
            items.append(item)
    return {
        "version": UPLOAD_QUEUE_STATE_VERSION,
        "hideFinished": payload.get("hideFinished") is True,
        "items": items,
    }


def _read_upload_queue_state() -> dict[str, Any]:
    if not UPLOAD_QUEUE_STATE_PATH.exists():
        return _default_upload_queue_state()
    try:
        raw = json.loads(UPLOAD_QUEUE_STATE_PATH.read_text(encoding="utf-8"))
        return _normalize_upload_queue_state(raw)
    except Exception as exc:
        logger.warning("upload queue state read failed: %s", _safe_error_text(exc))
        return _default_upload_queue_state()


LIVE_DRAFT_STATE_PATH = UI_STATE_DIR / "live_draft.json"
LIVE_DRAFT_STATE_VERSION = 1
LIVE_DRAFT_MAX_TEXT_CHARS = 200_000


def _default_live_draft_state() -> dict[str, Any]:
    return {
        "version": LIVE_DRAFT_STATE_VERSION,
        "draft": None,
    }


def _live_draft_str(value: object, max_len: int = 4096) -> str:
    return str(value or "").strip()[:max_len]


def _live_draft_number(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if 0 <= parsed < float("inf") else None


def _normalize_live_draft(payload: object) -> Optional[dict[str, Any]]:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="live draft state must be an object")
    # Decide on the SCHEMA, not on how many keys the caller happened to
    # send. ``put_live_draft_state`` answers with
    # ``{"ok", "version", "draft"}`` — three keys — so echoing that
    # response back, which is the natural idiom a GET/PUT pair teaches,
    # took the ``else`` branch: the envelope was read AS the draft, every
    # field fell to its default, and an empty draft was persisted with
    # HTTP 200. The live draft is the safety net against a crash during
    # dictation, so that failure is both silent and expensive.
    if isinstance(payload.get("draft"), dict) or (
        "draft" in payload and payload["draft"] is None
    ):
        draft_src = payload["draft"]
    else:
        draft_src = payload
    if draft_src is None:
        return None
    if not isinstance(draft_src, dict):
        raise HTTPException(status_code=400, detail="live draft must be an object")
    return {
        "session_id": _live_draft_str(draft_src.get("session_id"), 128),
        "started_at": _live_draft_number(draft_src.get("started_at")) or 0,
        "updated_at": _live_draft_number(draft_src.get("updated_at")) or int(time.time() * 1000),
        "recording": bool(draft_src.get("recording") is True),
        "timer": _live_draft_str(draft_src.get("timer"), 32),
        "title": _live_draft_str(draft_src.get("title"), 512),
        "source_text": _live_draft_str(draft_src.get("source_text"), LIVE_DRAFT_MAX_TEXT_CHARS),
        "transcript_text": _live_draft_str(draft_src.get("transcript_text"), LIVE_DRAFT_MAX_TEXT_CHARS),
        "provider": _live_draft_str(draft_src.get("provider"), 32),
        "model": _live_draft_str(draft_src.get("model"), 256),
        "language": _live_draft_str(draft_src.get("language"), 32),
        "archive_dir": _live_draft_str(draft_src.get("archive_dir"), 4096),
        "recording_collection": _live_draft_str(draft_src.get("recording_collection"), 64),
    }


def _normalize_live_draft_state(payload: object) -> dict[str, Any]:
    return {
        "version": LIVE_DRAFT_STATE_VERSION,
        "draft": _normalize_live_draft(payload),
    }


def _read_live_draft_state() -> dict[str, Any]:
    if not LIVE_DRAFT_STATE_PATH.exists():
        return _default_live_draft_state()
    try:
        raw = json.loads(LIVE_DRAFT_STATE_PATH.read_text(encoding="utf-8"))
        return _normalize_live_draft_state(raw)
    except Exception as exc:
        logger.warning("live draft state read failed: %s", _safe_error_text(exc))
        return _default_live_draft_state()


def _write_live_draft_state(payload: object) -> dict[str, Any]:
    state = _normalize_live_draft_state(payload)
    atomic_write_json(LIVE_DRAFT_STATE_PATH, state)
    return state


def _clear_live_draft_state(session_id: str = "") -> dict[str, Any]:
    """Clear the live draft, unless it belongs to another session.

    The returned state carries ``cleared``: a caller that trusted the
    endpoint's ``ok: true`` could not tell "the draft is gone" from
    "another session owns it and I left it alone", and both answered
    the same. ``ok`` in this API means the request was handled; whether
    the draft was actually removed is a separate fact and is now stated.
    """
    current = _read_live_draft_state()
    draft = current.get("draft") if isinstance(current.get("draft"), dict) else None
    expected_owner = _live_draft_str(session_id, 128)
    actual_owner = _live_draft_str(draft.get("session_id"), 128) if draft else ""
    if expected_owner and actual_owner and actual_owner != expected_owner:
        logger.info(
            "live draft not cleared: owned by session %s, not %s",
            actual_owner, expected_owner,
        )
        return {**current, "cleared": False}
    state = _default_live_draft_state()
    atomic_write_json(LIVE_DRAFT_STATE_PATH, state)
    return {**state, "cleared": True}


_rec_dir_cache: Optional[Path] = None
_rec_dir_cache_at = 0.0
_REC_DIR_CACHE_TTL = 10.0
# Guard the (cache, timestamp) pair atomically. The list/stats
# caches at line 1248 already use a shared lock for the same reason —
# concurrent readers can otherwise see fresh cache + stale timestamp 0.0
# (defeats the cache) or fresh timestamp + None cache (crash on
# `.resolve()`). Keep the critical section minimal: one read, one write.
_rec_dir_cache_lock = threading.Lock()


# Single lock guards all three (result, timestamp, key) triples for the
# list/stats caches below. The GIL makes each individual assignment
# atomic, but the three-write mutation sequence can interleave across
# concurrent FastAPI workers, leaving cache globals in an inconsistent
# state (new data + old key → persistent cache miss until TTL). Each
# cache's read/write paths acquire this lock; contention is minimal
# because the critical sections are a handful of scalar writes.
_recordings_caches_lock = threading.Lock()


def _invalidate_recordings_cache() -> None:
    global _list_cache, _list_cache_at, _list_cache_key
    global _stats_cache, _stats_cache_at, _stats_cache_key
    with _recordings_caches_lock:
        _list_cache = None
        _list_cache_at = 0.0
        _list_cache_key = None
        _stats_cache = None
        _stats_cache_at = 0.0
        _stats_cache_key = None


def _invalidate_recordings_dir_cache() -> None:
    global _rec_dir_cache, _rec_dir_cache_at
    with _rec_dir_cache_lock:
        _rec_dir_cache = None
        _rec_dir_cache_at = 0.0


def _resolve_recordings_dir(cfg: Optional[dict] = None) -> Path:
    global _rec_dir_cache, _rec_dir_cache_at
    # SSOT cache invariant: the global cache reflects the implicit
    # ``load_config()`` path ONLY. When the caller supplies an explicit
    # ``cfg`` we compute the result for THAT config but never write it
    # into the cache — otherwise a one-off call with a fabricated cfg
    # would poison subsequent implicit-load callers with a value
    # disconnected from what's on disk. Tracked with a local flag
    # rather than splitting the function so the security/migration
    # logic stays in one spot.
    cache_writes_enabled = cfg is None
    # monotonic for TTL — internal cache check, immune to clock skew.
    now = time.monotonic()
    # Atomic (cache, timestamp) read — see lock note above.
    if cache_writes_enabled:
        with _rec_dir_cache_lock:
            if _rec_dir_cache is not None and (now - _rec_dir_cache_at) < _REC_DIR_CACHE_TTL:
                return _rec_dir_cache

    cfg = cfg or load_config()
    prefs = cfg.get("preferences") or {}
    custom = (prefs.get("recordings_dir") or "").strip()
    default_dir = DATA_DIR / "recordings"
    default_dir.mkdir(parents=True, exist_ok=True)
    if custom:
        p = Path(custom).expanduser()
        if not p.is_absolute():
            p = (DATA_DIR / p).resolve()
        else:
            p = p.resolve()

        # Prevent storing recordings inside app bundle resources.
        volatile_app_path = False
        try:
            p.relative_to(APP_ROOT.resolve())
            volatile_app_path = True
        except Exception:
            volatile_app_path = False

        if volatile_app_path:
            try:
                if p.exists() and p.is_dir():
                    for txt in _iter_recording_text_files(p):
                        dst = default_dir / txt.name
                        if not dst.exists():
                            # SSOT atomic copy: bare `write_bytes`
                            # leaves a zero-byte dst on crash mid-copy,
                            # and the subsequent `dst.exists()` check
                            # blocks any retry — so a single power loss
                            # during first-run migration permanently
                            # drops the user's transcript.
                            atomic_write_bytes(dst, txt.read_bytes())
            except OSError as e:
                logger.warning("volatile recordings migration failed: %s", e)
            try:
                prefs["recordings_dir"] = ""
                cfg["preferences"] = prefs
                save_config(cfg)
            except OSError as e:
                logger.warning("volatile config reset failed: %s", e)
            if cache_writes_enabled:
                with _rec_dir_cache_lock:
                    _rec_dir_cache = default_dir
                    _rec_dir_cache_at = now
            return default_dir

        # Security: mirror the containment check in
        # _resolve_recordings_target_dir. A config-driven path outside
        # the user's home dir (manual edit, migration bug, attacker
        # with write access to config.json) would otherwise let the
        # backend create directories under /tmp, /var, /etc — anywhere
        # the process can write. Fall back to the default when unsafe.
        try:
            p.relative_to(Path.home().resolve())
        except ValueError:
            logger.warning(
                "recordings_dir %s is outside home; falling back to default %s",
                p, default_dir,
            )
            if cache_writes_enabled:
                with _rec_dir_cache_lock:
                    _rec_dir_cache = default_dir
                    _rec_dir_cache_at = now
            return default_dir

        # A configured archive can become unusable between runs: external
        # drive ejected, network share offline, folder renamed, perms
        # changed. Previously the OSError from mkdir escaped
        # ``_resolve_recordings_dir`` — which is on the path of
        # /api/recordings, /api/recordings/stats, the retention sweep and
        # every save — turning a recoverable misconfiguration into an
        # HTTP 500 that made the whole History tab (and saving!) fail.
        # Degrade to the default dir instead, exactly like the
        # outside-home case above.
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            logger.warning(
                "recordings_dir %s is not usable (%s); falling back to default %s",
                p, e, default_dir,
            )
            if cache_writes_enabled:
                with _rec_dir_cache_lock:
                    _rec_dir_cache = default_dir
                    _rec_dir_cache_at = now
            return default_dir
        if cache_writes_enabled:
            with _rec_dir_cache_lock:
                _rec_dir_cache = p
                _rec_dir_cache_at = now
        return p
    if cache_writes_enabled:
        with _rec_dir_cache_lock:
            _rec_dir_cache = default_dir
            _rec_dir_cache_at = now
    return default_dir


def _sanitize_name(value: str) -> str:
    return _safe_user_filename_part(value, fallback="recording", max_len=120)


def _recording_stem(name_or_title: str) -> str:
    raw = os.path.basename(str(name_or_title or "").replace("\\", "/")).strip()
    if raw.lower().endswith(".txt"):
        return _sanitize_name(Path(raw).stem)
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S-%f")
    return f"{ts}__{_sanitize_name(raw or 'recording')}"


def _recording_stem_available(target_dir: Path, stem: str) -> bool:
    """Is this stem free in ``target_dir``?

    An unreadable directory is NOT "the name is taken". Answering False
    there rejected every candidate in turn and the caller ended with
    ``500 could not allocate unique recording name`` — a message about
    naming for a problem that is an archive on a disconnected drive or a
    permissions change, with the real cause nowhere in the response.
    """
    stem_key = str(stem or "").casefold()
    try:
        for entry in target_dir.iterdir():
            if entry.stem.casefold() == stem_key:
                return False
    except OSError as exc:
        logger.error(
            "recordings folder %s is not readable: %s", target_dir, exc,
        )
        raise HTTPException(
            status_code=503,
            detail=f"recordings folder is not readable: {target_dir}",
        ) from exc
    return True


# The names a recording may be given, in order of preference. Three
# "pick a free name" functions used to sit beside these generators —
# check the directory, then use the winner — and every production caller
# now goes through ``_claim_recording_text_path``, which RESERVES the
# name with O_EXCL instead. They were kept alive only by the tests that
# covered them, while the path the app actually takes was not.
def _recording_stem_candidates_from_base(base: str, *, collision_suffix: str = "timestamp") -> Iterable[str]:
    safe_base = _sanitize_name(base)
    yield safe_base
    if collision_suffix == "timestamp":
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S-%f")
        yield f"{safe_base}__{ts}"
    for _ in range(128):
        yield f"{safe_base}-{uuid.uuid4().hex[:8]}"


def _recording_stem_candidates(title: str) -> Iterable[str]:
    base = _recording_stem(title)
    yield base
    for _ in range(128):
        yield f"{base}-{uuid.uuid4().hex[:8]}"


def _recording_text_claim_path(out: Path) -> Path:
    # Deterministic per-stem marker: O_EXCL reserves the name without creating
    # a visible empty .txt. The suffix matches _TMP_ORPHAN_RE, so a process
    # crash before _write_recording_text_file is swept on next startup.
    return out.with_name(f"{out.name}.tmp-000000.claim")


NO_SPEECH_PLACEHOLDER = "[No speech captured]"


def _placeholder_source_text(
    source_text: str, transcript_text: str, provider: str
) -> str:
    """The ONE rule for what an empty recognition writes to the file.

    Both save endpoints wrote this rule out, and they had already
    drifted: only one of them exempted ``provider="none"`` — the
    renderer's marker for "the user saved a recording without asking for
    any transcription at all" — so the same empty result produced a
    different file depending on which endpoint the renderer happened to
    call.
    """
    if source_text or transcript_text:
        return source_text
    if str(provider or "").strip().lower() == "none":
        return source_text
    return NO_SPEECH_PLACEHOLDER


def _release_recording_text_claim(out: Path, context: str) -> None:
    """Give back a name reservation a failed save is abandoning.

    ``_write_recording_text_file`` releases it in its own ``finally``,
    which covers every path that reaches it. A save that fails BEFORE
    it — an oversized upload, a broken connection, a full disk while
    writing the audio — never does, and the reservation is a real file
    with a deterministic name, so it also redirects every later attempt
    at the same title to a timestamped one.
    """
    _best_effort_unlink(_recording_text_claim_path(out), context=context)


def _claim_recording_text_path(target_dir: Path, candidates: Iterable[str]) -> tuple[str, Path]:
    target_dir.mkdir(parents=True, exist_ok=True)
    for stem in candidates:
        if not _recording_stem_available(target_dir, stem):
            continue
        out = target_dir / f"{stem}.txt"
        claim = _recording_text_claim_path(out)
        try:
            fd = os.open(str(claim), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        try:
            os.close(fd)
        except OSError:
            pass
        return stem, out
    raise HTTPException(status_code=500, detail="could not allocate unique recording name")


def _is_generic_capture_filename(filename: str) -> bool:
    stem = Path(_normalize_filename(filename or "recording.wav")).stem.lower()
    if stem in {"audio", "recording", "microphone", "session-audio", "session_audio"}:
        return True
    return bool(re.fullmatch(r"live[-_]\d{8,}", stem))


def _source_recording_display_name(filename: str) -> str:
    normalized = _normalize_filename(filename or "")
    if not normalized or _is_generic_capture_filename(normalized):
        return ""
    return normalized


def _recording_stem_candidates_for_source_file(filename: str, fallback_title: str) -> Iterable[str]:
    source_name = _source_recording_display_name(filename)
    if source_name:
        return _recording_stem_candidates_from_base(Path(source_name).stem, collision_suffix="timestamp")
    return _recording_stem_candidates(fallback_title)


def _atomic_temp_path(final_path: Path) -> Path:
    suffix = "".join(final_path.suffixes)
    stem = final_path.name[: -len(suffix)] if suffix else final_path.name
    return final_path.with_name(f"{stem}.tmp-{uuid.uuid4().hex}{suffix}")


def _recording_path_or_404(name: str, target_dir: Optional[Path] = None) -> Path:
    # Canonical leaf extraction is shared with save/update/audio lookup
    # so Windows-style names behave the same on POSIX and Windows hosts.
    safe = _recording_text_name_leaf(name)
    p = (target_dir or _resolve_recordings_dir()) / safe
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail="recording not found")
    return p


def _resolve_recordings_target_dir(archive_dir: str = "", *, create: bool = True) -> Path:
    """Validate + resolve a user-supplied recordings archive path.

    Security invariant: the *resolved* path (with symlinks followed
    via ``Path.resolve()``) must be inside the user's home directory.
    This blocks the classic symlink-escape bug where a path like
    ``~/evil -> /etc/shadow`` looks innocuous but actually targets a
    system file: ``resolve()`` returns ``/etc/shadow``, the
    ``relative_to(home_dir)`` check then raises ``ValueError`` and
    we surface a 403. The same logic also handles macOS's ``/var``
    → ``/private/var`` symlinks safely.

    Note that for a local Electron app the threat model is "protect
    the app from misconfiguration", not "protect the user from
    themselves" — this is defence against typos and stale paths, not
    against a malicious local user.
    """
    hint = str(archive_dir or "").strip()
    if not hint:
        resolved = _resolve_recordings_dir()
        if create:
            resolved.mkdir(parents=True, exist_ok=True)
        return resolved
    candidate = Path(hint).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="archive_dir must be an absolute path")
    resolved = candidate.resolve()
    home_dir = Path.home().resolve()
    try:
        resolved.relative_to(home_dir)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="archive_dir is outside allowed directories") from exc
    if create:
        resolved.mkdir(parents=True, exist_ok=True)
    elif not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=409, detail="archive directory is no longer available")
    return resolved


RECORDING_COLLECTION_LIVE = "live"
RECORDING_COLLECTION_UPLOADS = "uploads"
RECORDING_COLLECTION_DIR_NAMES: dict[str, str] = {
    RECORDING_COLLECTION_LIVE: "Live Capsule",
    RECORDING_COLLECTION_UPLOADS: "Uploaded Media",
}
_RECORDING_COLLECTION_DIR_NAME_TO_KEY: dict[str, str] = {
    folder_name: key for key, folder_name in RECORDING_COLLECTION_DIR_NAMES.items()
}


# ── Recorded-audio retention ────────────────────────────────────────
#
# SSOT for how long each collection keeps the audio sitting beside its
# transcripts. ``.txt`` transcripts are NEVER subject to retention at
# any age or count — they are the durable record and stay forever.
#
# The two collections have genuinely different economics, so the policy
# is keyed by collection rather than being one global rule:
#
#   Live Capsule   — voice notes dictated all day. Dozens accumulate,
#                    and the user only ever replays the last couple of
#                    takes, so this is a *count* rule.
#   Uploaded Media — the audio track extracted from a file the user
#                    brought in. Worth keeping around while they are
#                    still working with that material, but not forever,
#                    so this is an *age* rule.
#
# What this replaced: a single global "keep audio only for the newest
# recording in the archive" rule, written twice (once for the per-save
# path, once re-derived from the newest transcript for the startup
# sweep). It discarded a take's audio the moment the next one was
# saved, and applied the same wrong answer to both collections.


@dataclass(frozen=True)
class AudioRetentionPolicy:
    """Retention limits for one collection's audio files.

    Two independent dimensions; an audio file is collected when it
    fails EITHER. ``0`` disables that dimension, so one type expresses
    "age only", "count only", "both", or "keep everything" without any
    special-casing at the call sites.

    ``max_items`` counts audio files, newest first — the transcripts
    they belong to are never part of the count.
    """

    max_age_sec: int = 0
    max_items: int = 0

    @property
    def enabled(self) -> bool:
        return self.max_age_sec > 0 or self.max_items > 0


AUDIO_RETENTION_POLICIES: dict[str, AudioRetentionPolicy] = {
    RECORDING_COLLECTION_LIVE: AudioRetentionPolicy(
        # 3 → 100. A keep-count of three meant the audio behind a
        # transcript was gone within hours of a working day: the four
        # recordings the 2026-09-03 word-loss audit was built on were
        # deleted while it was being written, and the comparison could
        # only be reproduced because copies had been taken by hand
        # (BUGS_AUDIT_2026-09-03.md, addendum (a)). The audio IS the
        # evidence — without it a report of missing words cannot be
        # checked against what was said.
        #
        # The cost is bounded and small: live capture is 16 kHz mono
        # PCM16, ~1.9 MB per minute, so 100 takes of a minute each is
        # under 200 MB. The count is still a limit, not "keep
        # everything", and the env var below still overrides it.
        max_items=max(0, _env_int("TRANSCRIPTOR_LIVE_AUDIO_KEEP_COUNT", 100)),
    ),
    RECORDING_COLLECTION_UPLOADS: AudioRetentionPolicy(
        max_age_sec=max(
            0, _env_int("TRANSCRIPTOR_UPLOAD_AUDIO_RETENTION_SEC", 7 * 24 * 3600)
        ),
    ),
}
# The archive ROOT predates the collection subfolders: everything saved
# before they existed landed there, and those were voice recordings.
# It therefore inherits the Live policy rather than a third, invented one.
DEFAULT_AUDIO_RETENTION_POLICY = AUDIO_RETENTION_POLICIES[RECORDING_COLLECTION_LIVE]

# A long-running app must not depend on a save or a restart to enforce
# an AGE limit: without a periodic sweep, a machine left running for a
# fortnight keeps every file that aged out while it was up. (Count
# limits are naturally enforced on every save.) Hourly is far finer
# than a 7-day window needs and costs one directory listing per dir.
AUDIO_RETENTION_SWEEP_INTERVAL_SEC = max(
    60, _env_int("TRANSCRIPTOR_AUDIO_RETENTION_SWEEP_SEC", 3600)
)
_audio_retention_sweeper_lock = threading.Lock()
_audio_retention_sweeper_thread: Optional[threading.Thread] = None


def _audio_retention_policy_for_dir(directory: Path) -> AudioRetentionPolicy:
    """Resolve the retention policy governing *directory*.

    Collections live in fixed-name subfolders of an archive root, so the
    folder name is the key. Anything that is not a known collection
    folder — the archive root itself, or a user-chosen custom dir — gets
    the default policy.
    """
    key = _RECORDING_COLLECTION_DIR_NAME_TO_KEY.get(directory.name)
    if key is None:
        return DEFAULT_AUDIO_RETENTION_POLICY
    return AUDIO_RETENTION_POLICIES.get(key, DEFAULT_AUDIO_RETENTION_POLICY)


def _normalize_recording_collection(value: object) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    aliases = {
        "live": RECORDING_COLLECTION_LIVE,
        "capsule": RECORDING_COLLECTION_LIVE,
        "live_capsule": RECORDING_COLLECTION_LIVE,
        "live-capsule": RECORDING_COLLECTION_LIVE,
        "uploads": RECORDING_COLLECTION_UPLOADS,
        "upload": RECORDING_COLLECTION_UPLOADS,
        "uploaded": RECORDING_COLLECTION_UPLOADS,
        "uploaded_media": RECORDING_COLLECTION_UPLOADS,
        "uploaded-media": RECORDING_COLLECTION_UPLOADS,
    }
    normalized = aliases.get(raw, raw)
    if normalized not in RECORDING_COLLECTION_DIR_NAMES:
        raise HTTPException(status_code=400, detail="unsupported recording collection")
    return normalized


def _recording_collection_for_dir(path: Path) -> str:
    return _RECORDING_COLLECTION_DIR_NAME_TO_KEY.get(path.name, "")


def _resolve_recordings_collection_target_dir(
    archive_dir: str = "",
    *,
    collection: str = "",
    create: bool = True,
) -> Path:
    """Resolve the physical archive dir for a semantic recording source.

    Callers pass a stable collection id (``live`` / ``uploads``), never a
    folder name. The backend is the SSOT for the on-disk layout, and the
    helper is idempotent when an existing child archive_dir is supplied
    back during a later metadata update.
    """
    target_dir = _resolve_recordings_target_dir(archive_dir, create=create)
    normalized = _normalize_recording_collection(collection)
    if not normalized:
        return target_dir

    folder_name = RECORDING_COLLECTION_DIR_NAMES[normalized]
    known_collection_names = set(RECORDING_COLLECTION_DIR_NAMES.values())
    if target_dir.name == folder_name:
        return target_dir
    if target_dir.name in known_collection_names:
        raise HTTPException(status_code=409, detail="archive_dir points to a different recording collection")

    collection_dir = target_dir / folder_name
    if create:
        collection_dir.mkdir(parents=True, exist_ok=True)
    elif not collection_dir.exists() or not collection_dir.is_dir():
        raise HTTPException(status_code=409, detail="archive directory is no longer available")
    resolved_collection_dir = collection_dir.resolve()
    home_dir = Path.home().resolve()
    try:
        resolved_collection_dir.relative_to(home_dir)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="archive_dir is outside allowed directories") from exc
    return resolved_collection_dir


def _recordings_scan_dirs(root: Path) -> list[Path]:
    """Return archive dirs visible in the active History surface."""
    candidates = [root]
    for folder_name in RECORDING_COLLECTION_DIR_NAMES.values():
        child = root / folder_name
        if child.exists() and child.is_dir():
            candidates.append(child)
    seen: set[str] = set()
    dirs: list[Path] = []
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            key = str(resolved)
        except OSError:
            resolved = candidate
            key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        dirs.append(resolved)
    return dirs


def _iter_recording_files_by_suffix(directory: Path, suffixes: set[str]) -> list[Path]:
    files: list[Path] = []
    try:
        entries = list(directory.iterdir())
    except OSError:
        return files
    for entry in entries:
        if entry.suffix.lower() not in suffixes:
            continue
        try:
            if entry.is_file():
                files.append(entry)
        except OSError:
            continue
    return files


def _iter_recording_text_files(directory: Path) -> list[Path]:
    return _iter_recording_files_by_suffix(directory, {".txt"})


def _recordings_scan_cache_key(root: Path) -> tuple:
    parts: list[tuple[str, float, int, int, int]] = []
    tracked_exts = {".txt", *_RECORDING_AUDIO_EXTS}
    for d in _recordings_scan_dirs(root):
        try:
            dir_mtime = d.stat().st_mtime
            file_count = 0
            newest_file_mtime_ns = 0
            total_file_size = 0
            for entry in _iter_recording_files_by_suffix(d, tracked_exts):
                try:
                    st = entry.stat()
                except OSError:
                    continue
                file_count += 1
                newest_file_mtime_ns = max(newest_file_mtime_ns, int(st.st_mtime_ns))
                total_file_size += int(st.st_size)
        except Exception:
            dir_mtime = 0.0
            file_count = -1
            newest_file_mtime_ns = 0
            total_file_size = -1
        parts.append((str(d), dir_mtime, file_count, newest_file_mtime_ns, total_file_size))
    return tuple(parts)


def _recordings_storage_dirs_for_roots(roots: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    dirs: list[Path] = []
    for root in roots:
        for d in _recordings_scan_dirs(root):
            try:
                key = str(d.resolve())
            except OSError:
                key = str(d)
            if key in seen:
                continue
            seen.add(key)
            dirs.append(d)
    return dirs


# SSOT: audio extensions a saved recording can carry alongside its
# .txt transcript. Both ``_recording_audio_path`` (retrieval lookup
# for the History tab's audio player and Re-transcribe path) AND
# ``_prune_recording_audio`` (retention sweeper) AND
# ``delete_all_recordings`` walk this tuple.
#
# Derived directly from ``ALLOWED_AUDIO_EXTS`` so video containers
# (mp4, m4v, mov, mkv, avi, mpg, mpeg, 3gp) that are accepted at the
# upload validator gate ALSO round-trip through retrieval / retention
# / delete. The previous static tuple omitted every video extension —
# a user uploading a .mov file via save-with-audio would be unable to
# play it back in History, the audio file would never be pruned by
# the retention sweep, AND ``delete_all_recordings`` would orphan it
# on disk forever (deleting only the .txt transcript). SSOT drift
# between ALLOWED_AUDIO_EXTS (validator scope) and
# _RECORDING_AUDIO_EXTS (lifecycle scope) was a silent data-leak bug.
#
# Sorting is purely for deterministic iteration order in tests.
_RECORDING_AUDIO_EXTS: tuple[str, ...] = tuple(sorted(ALLOWED_AUDIO_EXTS))


# 1.1.25 SSOT invariant: every accepted extension MUST have an
# explicit MIME mapping. Falling back to ``mimetypes.guess_type``
# for an unmapped extension produces wrong MIMEs for our actual
# formats (the whole reason ``AUDIO_EXT_TO_MIME`` exists). An
# import-time assert prevents drift from compiling at all: adding
# a new ext to ``ALLOWED_AUDIO_EXTS`` without adding the matching
# MIME entry now fails on backend startup instead of silently
# falling through to ``application/octet-stream``.
_missing_mime_exts = ALLOWED_AUDIO_EXTS - AUDIO_EXT_TO_MIME.keys()
if _missing_mime_exts:
    raise RuntimeError(
        f"ALLOWED_AUDIO_EXTS / AUDIO_EXT_TO_MIME drift: missing MIME "
        f"mapping for {sorted(_missing_mime_exts)}"
    )


def _audio_content_type(filename: str) -> str:
    """Return the canonical Content-Type for an audio/video filename.

    Always prefer the explicit ``AUDIO_EXT_TO_MIME`` map over Python's
    ``mimetypes.guess_type`` (which returns ``video/webm`` for an Opus
    audio container, ``audio/ogg`` for ``.opus``, ``audio/mp4a-latm``
    for ``.m4a``, etc. — all of which break wire-level routing).
    """
    return audio_content_type(filename)


def _recording_audio_path(name: str, target_dir: Optional[Path] = None) -> Optional[Path]:
    try:
        stem = Path(_recording_text_name_leaf(name)).stem
    except HTTPException:
        return None
    if not stem:
        return None
    root_dir = target_dir or _resolve_recordings_dir()
    for ext in _RECORDING_AUDIO_EXTS:
        candidate = root_dir / f"{stem}{ext}"
        if candidate.exists() and candidate.is_file():
            return candidate
    return None


def _prune_recording_audio(
    target_dir: Path,
    *,
    keep_stems: Iterable[str] = (),
    now: Optional[float] = None,
    policy: Optional[AudioRetentionPolicy] = None,
) -> int:
    """Apply *directory*'s audio-retention policy. Returns files deleted.

    The single implementation of the rule. Every schedule that enforces
    it — the per-save call and the boot / periodic sweeps — goes through
    this function, so the policy cannot drift between them, and the
    policy itself is data (``AUDIO_RETENTION_POLICIES``) rather than
    branching logic repeated per call site.

    Invariants, in the order they are decided per entry:

    * ``.txt`` transcripts are never candidates. They are the durable
      record and are not subject to retention at any age or count.
    * An audio file with no sibling transcript is left alone: it is
      either an orphan or a save still in flight in another process,
      and neither is ours to collect.
    * ``keep_stems`` is an unconditional exemption, used by the save
      path for the recording it has just written. Exempt files still
      occupy a slot in the ``max_items`` ranking — the take the user
      just made IS one of the N most recent — they simply cannot be
      deleted. Without the exemption a clock skew could let a save
      collect its own audio before the user ever played it.
    * ``max_items``: rank surviving candidates newest-first and collect
      everything past the Nth. Ties on mtime break on name, descending,
      so the outcome is deterministic rather than filesystem-order.
    * ``max_age_sec``: collect anything whose mtime is at or past the
      cutoff. A file dated in the future (clock moved backwards, or a
      copy that preserved a future timestamp) yields a negative age and
      is kept — "not older than the window" is the safe reading.

    ``now`` and ``policy`` are injectable so the rule can be exercised
    without touching the system clock or the module-level table.
    """
    effective = policy if policy is not None else _audio_retention_policy_for_dir(target_dir)
    if not effective.enabled:
        return 0
    try:
        entries = list(target_dir.iterdir())
    except OSError as e:
        logger.warning("audio retention scan failed for %s: %s", target_dir, e)
        return 0
    # Build the transcript-stem index ONCE. The previous form called
    # ``_recording_text_sibling_exists`` inside the loop, and that helper
    # re-listed the whole directory on every iteration — O(N²) syscalls.
    # On an archive with a few thousand entries this turned every save
    # (and every startup retention sweep) into seconds of blocking I/O,
    # which the user experiences as the app stalling right after Stop.
    text_stems = {p.stem for p in _iter_recording_text_files(target_dir)}
    candidates: list[tuple[float, str, Path]] = []
    for entry in entries:
        try:
            if not entry.is_file():
                continue
            if entry.suffix.lower() not in _RECORDING_AUDIO_EXTS:
                continue
            if entry.stem not in text_stems:
                continue
            candidates.append((entry.stat().st_mtime, entry.name, entry))
        except OSError as e:
            logger.debug("audio retention: skip %s: %s", entry, e)
    if not candidates:
        return 0

    # Newest first. Name descending is only a deterministic tiebreak for
    # files that share an mtime (same-second saves are common).
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    exempt = {stem for stem in keep_stems if stem}
    stamp = time.time() if now is None else now
    age_cutoff = stamp - effective.max_age_sec if effective.max_age_sec > 0 else None

    deleted = 0
    for index, (mtime, _name, entry) in enumerate(candidates):
        if entry.stem in exempt:
            continue
        over_count = effective.max_items > 0 and index >= effective.max_items
        over_age = age_cutoff is not None and mtime <= age_cutoff
        if not (over_count or over_age):
            continue
        reason = "beyond newest %d" % effective.max_items if over_count else (
            "older than %d s" % effective.max_age_sec
        )
        try:
            entry.unlink()
            deleted += 1
            logger.info("audio retention: removed %s (%s)", entry.name, reason)
        except OSError as e:
            logger.warning("audio retention: failed to remove %s: %s", entry, e)
    return deleted


def _register_archive_dir(path: Path) -> None:
    """Persist *path* in the known-archive-dirs registry.

    Only custom dirs (those that differ from the current default) need
    to be registered — the default dir is always scanned by
    ``_sweep_recording_audio_retention`` without any registry entry.

    The registry file is a JSON array of absolute path strings stored
    at ``_ARCHIVE_DIR_REGISTRY_PATH``.  Writes are serialised by
    ``_archive_dir_registry_lock`` and executed atomically via a
    temp-file rename so a crash mid-write never produces a corrupt
    registry.
    """
    try:
        default = _resolve_recordings_dir()
        if path.resolve() == default.resolve():
            return  # Default dir always included — no need to register
    except Exception:
        pass  # Can't compare; register defensively
    abs_str = str(path.resolve())
    with _archive_dir_registry_lock:
        try:
            parsed = (
                json.loads(_ARCHIVE_DIR_REGISTRY_PATH.read_text(encoding="utf-8"))
                if _ARCHIVE_DIR_REGISTRY_PATH.exists()
                else []
            )
            # Defend against a corrupted registry (manual edit, partial
            # write from an old build): anything other than a list of
            # strings is treated as empty and rewritten from scratch on
            # the next append. We never raise on bad data — retention
            # sweeps must not crash because one JSON file is malformed.
            existing: list[str] = (
                [str(x) for x in parsed if isinstance(x, str)]
                if isinstance(parsed, list)
                else []
            )
        except Exception:
            existing = []
        if abs_str in existing:
            return  # Already known — no write needed
        existing.append(abs_str)
        try:
            # SSOT: every other JSON persistence site in the backend
            # uses atomic_write_json directly (config.json, recovery
            # meta, upscale presets, job result.json). The previous
            # ``_atomic_write_text(path, json.dumps(...))`` here was
            # functionally equivalent but inconsistent: missed the
            # ``ensure_ascii=False`` + ``indent=2`` shape produced by
            # atomic_write_json, so a Cyrillic recordings_dir landed
            # as ``\\u041a\\u043e...`` escapes in the registry while
            # every other JSON file held it as readable UTF-8.
            atomic_write_json(_ARCHIVE_DIR_REGISTRY_PATH, sorted(existing))
        except Exception as exc:
            logger.warning("register_archive_dir: write failed for %s: %s", abs_str, exc)


def _get_known_archive_dirs() -> list[Path]:
    """Return all archive dirs that should be scanned for audio retention.

    Always includes the current default recordings dir.  Additionally
    includes every custom dir persisted by ``_register_archive_dir``,
    filtering out entries that no longer exist on disk (e.g. removable
    drives that are not currently mounted).  Duplicates (resolved) are
    deduplicated.
    """
    candidates: list[Path] = []
    try:
        candidates.append(_resolve_recordings_dir())
    except Exception as exc:
        logger.warning("known_archive_dirs: default dir resolve failed: %s", exc)
    with _archive_dir_registry_lock:
        try:
            parsed = (
                json.loads(_ARCHIVE_DIR_REGISTRY_PATH.read_text(encoding="utf-8"))
                if _ARCHIVE_DIR_REGISTRY_PATH.exists()
                else []
            )
            # Defend against a corrupted registry — see _register_archive_dir.
            raw_list: list[str] = (
                [str(x) for x in parsed if isinstance(x, str)]
                if isinstance(parsed, list)
                else []
            )
        except Exception:
            raw_list = []
    for s in raw_list:
        try:
            p = Path(s)
            if p.exists() and p.is_dir():
                candidates.append(p)
        except Exception:
            continue
    # Deduplicate by resolved absolute path.
    seen: set[str] = set()
    result: list[Path] = []
    for d in candidates:
        try:
            key = str(d.resolve())
        except Exception:
            key = str(d)
        if key not in seen:
            seen.add(key)
            result.append(d)
    return result


def _sweep_recording_audio_retention(
    target_dir: Optional[Path] = None,
    *,
    now: Optional[float] = None,
) -> int:
    """Apply audio retention across the archive. Returns files deleted.

    With no ``target_dir``, sweeps every known archive dir — the default
    one plus every custom dir persisted via ``_register_archive_dir`` —
    each expanded into its collection subfolders, and each governed by
    its own policy. With ``target_dir``, sweeps exactly that directory.

    This used to re-derive the retention rule for itself: it scanned for
    the newest ``.txt`` and asked the per-save helper to keep only that
    stem. That was the same policy expressed a second time, in terms of
    the wrong thing (which recording is newest) rather than the actual
    rule. It now just runs the one evaluator; the rule lives in
    ``AUDIO_RETENTION_POLICIES`` and nowhere else.

    ``now`` is threaded through so the whole fan-out — not merely the
    leaf evaluator — can be tested against an injected clock.

    Safe to call repeatedly — a no-op once nothing is over its limits.
    """
    if target_dir is not None:
        return _prune_recording_audio(target_dir, now=now)
    total = 0
    for d in _recordings_storage_dirs_for_roots(_get_known_archive_dirs()):
        total += _prune_recording_audio(d, now=now)
    if total > 0:
        logger.info("audio retention sweep: removed %d audio file(s)", total)
    return total


def _any_audio_retention_enabled() -> bool:
    """True when at least one collection has a limit worth sweeping for."""
    if DEFAULT_AUDIO_RETENTION_POLICY.enabled:
        return True
    return any(policy.enabled for policy in AUDIO_RETENTION_POLICIES.values())


def start_audio_retention_sweeper() -> None:
    """Run the audio-retention sweep on a timer, once per process.

    Boot-time and per-save enforcement alone leave a gap for AGE-based
    policies: an app left running past the window never revisits files
    that aged out while it was up. Idempotent — a second call is
    ignored, so a test harness re-entering the lifespan cannot stack
    threads.
    """
    global _audio_retention_sweeper_thread
    if not _any_audio_retention_enabled():
        return
    with _audio_retention_sweeper_lock:
        if (
            _audio_retention_sweeper_thread is not None
            and _audio_retention_sweeper_thread.is_alive()
        ):
            return

        def _loop() -> None:
            while True:
                time.sleep(AUDIO_RETENTION_SWEEP_INTERVAL_SEC)
                try:
                    _sweep_recording_audio_retention()
                except Exception:
                    logger.exception("periodic audio retention sweep failed")

        _audio_retention_sweeper_thread = threading.Thread(
            target=_loop, daemon=True, name="audio-retention-sweep"
        )
        _audio_retention_sweeper_thread.start()


def _recording_audio_payload(name: str, target_dir: Optional[Path] = None) -> dict[str, Any]:
    audio_path = _recording_audio_path(name, target_dir=target_dir)
    if audio_path is None:
        return {
            "has_audio": False,
            "audio_name": "",
            "audio_size_bytes": 0,
            "audio_mime": "",
        }
    mime = _audio_content_type(audio_path.name)
    try:
        size_bytes = audio_path.stat().st_size
    except Exception:
        size_bytes = 0
    return {
        "has_audio": True,
        "audio_name": audio_path.name,
        "audio_size_bytes": size_bytes,
        "audio_mime": mime,
    }


def _render_recording_content(
    *,
    title: str,
    source_file: str = "",
    source_text: str,
    transcript_text: str,
    provider: str,
    model: str,
    language: str,
) -> str:
    lines = [
        f"Title: {title}",
        f"Saved at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Language: {language or 'auto'}",
        f"Provider: {provider or 'local'}",
        f"Model: {model or '-'}",
    ]
    if source_file:
        lines.append(f"Source file: {source_file}")
    lines.append("")
    if source_text:
        lines.extend(["Original:", source_text, ""])
    if transcript_text:
        lines.extend(["Transcription:", transcript_text, ""])
    return "\n".join(lines).strip() + "\n"


def _write_recording_text_file(
    *,
    out: Path,
    title: str,
    source_file: str = "",
    source_text: str,
    transcript_text: str,
    provider: str,
    model: str,
    language: str,
) -> None:
    claim = _recording_text_claim_path(out)
    try:
        _atomic_write_text(
            out,
            _render_recording_content(
                title=title,
                source_file=source_file,
                source_text=source_text,
                transcript_text=transcript_text,
                provider=provider,
                model=model,
                language=language,
            ),
        )
    finally:
        _best_effort_unlink(claim, context="recording text claim cleanup")


def _extract_stats_text(content: str) -> str:
    text = (content or "").strip()
    if not text:
        return ""
    # Prefer Transcription section (clean text) over Original (raw live)
    m_trans = re.search(r"Transcription:\s*(.*)", text, flags=re.DOTALL | re.IGNORECASE)
    if m_trans:
        result = m_trans.group(1).strip()
        # Strip any trailing sections that might follow
        result = re.split(r"\n\s*Original:", result, maxsplit=1, flags=re.IGNORECASE)[0].strip()
        if result:
            return result
    m_orig = re.search(r"Original:\s*(.*)", text, flags=re.DOTALL | re.IGNORECASE)
    if m_orig:
        result = m_orig.group(1).strip()
        result = re.split(r"\n\s*Transcription:", result, maxsplit=1, flags=re.IGNORECASE)[0].strip()
        if result:
            return result
    return text


def _extract_transcript_text(content: str) -> str:
    """Extract transcript text specifically for display name generation.
    Prefers Transcription section, falls back to Original."""
    text = (content or "").strip()
    if not text:
        return ""
    m_trans = re.search(r"Transcription:\s*(.*?)(?:\n\s*$|\nOriginal:|$)", text, flags=re.DOTALL | re.IGNORECASE)
    if m_trans and m_trans.group(1).strip():
        return m_trans.group(1).strip()
    m_orig = re.search(r"Original:\s*(.*?)(?:\n\s*$|\nTranscription:|$)", text, flags=re.DOTALL | re.IGNORECASE)
    if m_orig and m_orig.group(1).strip():
        return m_orig.group(1).strip()
    return ""


def _first_words(content: str, max_words: int = 8) -> str:
    """Extract first N meaningful words from recording file content for display name."""
    text = _extract_transcript_text(content)
    if not text:
        return ""
    # Strip bracketed markers like [Silence]
    text = re.sub(r"\[.*?\]", "", text).strip()
    if not text:
        return ""
    # Collapse whitespace and take first N words
    words = text.split()
    preview = " ".join(words[:max_words])
    if len(words) > max_words:
        preview += "..."
    # Limit total length for UI
    if len(preview) > 80:
        preview = preview[:77] + "..."
    return preview


def _recording_source_file(content: str) -> str:
    return _extract_meta_field(content, "Source file")


def _recording_display_name_from_content(content: str, fallback_stem: str) -> str:
    source_file = _recording_source_file(content)
    if source_file:
        return source_file
    first = _first_words(content)
    if first:
        return first
    title = _extract_meta_field(content, "Title")
    if title and title.lower() not in {"recording", "uploaded file"}:
        return title
    return fallback_stem


def _tokenize_words(text: str) -> list[str]:
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9]{2,}", (text or "").lower())
    return [w for w in words if w not in COMMON_STOPWORDS]


def _extract_meta_field(content: str, field: str) -> str:
    # 1.1.25 fix: previous form ran the regex MULTILINE over the whole
    # file. If a transcript contained a line starting with "Provider:"
    # / "Language:" (entirely possible in spoken text), the user content
    # was returned as the recording's metadata — corrupting the stats
    # endpoint's provider histogram and the filter
    # UI. Header lines live BEFORE the first blank line in the on-disk
    # format produced by ``_render_recording_content``; restrict the
    # regex search to that prefix so transcript content cannot match a
    # fake header.
    text = content or ""
    header_end = text.find("\n\n")
    header = text[:header_end] if header_end >= 0 else text
    pattern = rf"^{re.escape(field)}:\s*(.+)$"
    m = re.search(pattern, header, flags=re.IGNORECASE | re.MULTILINE)
    return (m.group(1).strip() if m else "")


def _upscale_preset_path(preset_id: str) -> Path:
    raw = (preset_id or "").strip()
    if not UPSCALE_PRESET_ID_RE.fullmatch(raw):
        raise HTTPException(status_code=400, detail="invalid preset id")
    # Block Windows reserved device names BEFORE we try to open the
    # path. Without this check ``raw="con"`` produces ``con.json``
    # which opens the character console device on every Windows
    # filesystem, hanging subsequent atomic_write_json calls. The
    # check is cross-platform — refusing these names on POSIX too
    # keeps the regex's accepted-character set the only contract
    # callers need to know.
    if raw.lower() in _WINDOWS_RESERVED_BASENAMES:
        raise HTTPException(status_code=400, detail="invalid preset id (reserved name)")
    return UPSCALE_PRESETS_DIR / f"{raw}.json"


def _write_upscale_preset(path: Path, payload: dict[str, Any]) -> None:
    """Persist an upscale preset via the shared SSOT JSON writer.

    Previously used a local tmp+replace without fsync. The shared
    writer adds durability (``f.flush() + os.fsync(fd)`` + parent
    dir fsync on POSIX) so a crash mid-write cannot leave a
    zero-length preset file that would silently vanish from the UI
    on next launch. Crash cleanup of orphan tmps is still handled
    by ``_sweep_orphan_tmp_files`` — the tmp naming convention is
    shared (``<name>.tmp-<hex>``).
    """
    atomic_write_json(path, payload)


def _ensure_builtin_upscale_presets() -> None:
    UPSCALE_PRESETS_DIR.mkdir(parents=True, exist_ok=True)
    # Remove deprecated builtin presets that are no longer supported.
    for p in UPSCALE_PRESETS_DIR.glob("builtin_*.json"):
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            pid = str(raw.get("id") or p.stem).strip()
            if not pid.startswith("builtin_"):
                continue
            short = pid.removeprefix("builtin_")
            if short not in BUILTIN_UPSCALE_PRESETS:
                p.unlink(missing_ok=True)
        except Exception:
            # Keep file if unreadable; it will be ignored later.
            pass
    for pid, meta in BUILTIN_UPSCALE_PRESETS.items():
        path = UPSCALE_PRESETS_DIR / f"builtin_{pid}.json"
        payload = {
            "id": f"builtin_{pid}",
            "name": meta["name"],
            "instruction": meta["instruction"],
            "default_instruction": meta["instruction"],
            "builtin": True,
        }
        if not path.exists():
            _write_upscale_preset(path, payload)
            continue
        try:
            cur = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(cur, dict):
                _write_upscale_preset(path, payload)
                continue
            current_instruction = str(cur.get("instruction") or "").strip() or payload["instruction"]
            next_payload = {
                "id": payload["id"],
                "name": payload["name"],
                "instruction": current_instruction,
                "default_instruction": payload["default_instruction"],
                "builtin": True,
            }
            if (
                str(cur.get("id") or "").strip() != next_payload["id"]
                or str(cur.get("name") or "").strip() != next_payload["name"]
                or str(cur.get("instruction") or "").strip() != next_payload["instruction"]
                or str(cur.get("default_instruction") or "").strip() != next_payload["default_instruction"]
                or bool(cur.get("builtin")) is not True
            ):
                _write_upscale_preset(path, next_payload)
        except Exception:
            _write_upscale_preset(path, payload)


def _load_upscale_preset(path: Path) -> Optional[dict[str, Any]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return None
        pid = str(raw.get("id") or "").strip()
        name = str(raw.get("name") or "").strip()
        instruction = str(raw.get("instruction") or "").strip()
        if not pid or not name or not instruction:
            return None
        default_instruction = str(raw.get("default_instruction") or "").strip() or instruction
        return {
            "id": pid,
            "name": name,
            "instruction": instruction,
            "default_instruction": default_instruction,
            "builtin": bool(raw.get("builtin")),
        }
    except Exception:
        return None


def _list_upscale_presets() -> list[dict[str, Any]]:
    _ensure_builtin_upscale_presets()
    items: list[dict[str, Any]] = []
    for p in sorted(UPSCALE_PRESETS_DIR.glob("*.json")):
        item = _load_upscale_preset(p)
        if not item:
            continue
        items.append(item)
    builtins = [x for x in items if x.get("builtin")]
    customs = [x for x in items if not x.get("builtin")]
    builtins.sort(key=lambda x: str(x.get("name") or "").lower())
    customs.sort(key=lambda x: str(x.get("name") or "").lower())
    return builtins + customs


def _resolve_upscale_preset(preset_id: str) -> dict[str, Any]:
    pid = (preset_id or "").strip()
    path = _upscale_preset_path(pid)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="upscale preset not found")
    item = _load_upscale_preset(path)
    if not item:
        raise HTTPException(status_code=500, detail="invalid upscale preset file")
    return item


@app.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket):
    """Provider-aware live transcription WebSocket.

    Protocol (client → server):
        - Binary PCM16LE mono frames at the configured sample rate.
        - Text JSON control messages, e.g. ``{"type": "finalize"}`` which
          flushes the upstream session and causes the server to emit a
          canonical ``{"type": "final", ...}`` event before closing.

    Protocol (server → client):
        - ``{"type": "segments", "segments": [...], "is_final": bool}`` —
          a committed chunk of transcript ready to merge into the SSOT.
        - ``{"type": "interim", "segment": {...}}`` — (Deepgram only) a
          non-committed partial hypothesis for the tail of the stream.
        - ``{"type": "final", "text": str, "segments": [...],
             "durationSec": float}`` — the canonical transcript at end
          of session.
        - ``{"type": "error", "error": str}`` — unrecoverable failure.
    """
    # Kick the recovery cleanup off the event loop — the websocket
    # handshake must not wait for a directory scan on slow filesystems.
    # Attach a done-callback so exceptions (permission denied, disk full)
    # surface in the log instead of being silently lost by the executor.
    _cleanup_future = asyncio.get_running_loop().run_in_executor(
        None, _cleanup_live_recovery_files
    )

    def _log_cleanup_error(fut: "asyncio.Future[None]") -> None:
        exc = fut.exception()
        if exc is not None:
            logger.warning("live recovery cleanup failed: %s", exc)

    _cleanup_future.add_done_callback(_log_cleanup_error)
    # HTTP middleware does not run for the WebSocket scope, so the
    # loopback Host guard is applied explicitly here. Without it the WS
    # endpoint stays reachable through a DNS-rebound origin even after
    # the HTTP surface is locked down.
    if not _host_header_allowed(websocket.headers.get("host")):
        logger.warning("rejected websocket with non-loopback Host header")
        await websocket.close(code=4421, reason="misdirected request")
        return
    token = _websocket_api_token(websocket)
    # Constant-time comparison — matches the HTTP auth path (see
    # `_require_api_auth`). Without this a local attacker can recover
    # API_TOKEN one byte at a time by measuring WS close latency.
    if not token or not secrets.compare_digest(token.encode("utf-8"), API_TOKEN.encode("utf-8")):
        await websocket.close(code=4401, reason="unauthorized")
        return
    client_key = websocket.client.host if websocket.client else "unknown"
    if not _touch_rate_limit(_ws_windows, client_key, WS_CONNECT_LIMIT_PER_MIN):
        await websocket.close(code=4429, reason="rate limit exceeded")
        return
    await websocket.accept(subprotocol=_websocket_accept_subprotocol(websocket))

    qp = websocket.query_params
    provider = _normalize_live_provider(qp.get("provider"))
    model = (qp.get("model") or "").strip()
    language = (qp.get("language") or "auto").strip()
    lang_opt: Optional[str] = None if language in ("", "auto", "Auto") else language
    session_id = _normalize_live_session_id(qp.get("session_id") or "")
    archive_dir = str(qp.get("archive_dir") or "").strip()
    # In WebSocket scope an ``HTTPException`` has no handler: the client
    # gets an unhandled server error and a 1011 close instead of a
    # protocol message it can act on. Same normaliser, protocol-shaped
    # answer.
    try:
        recording_collection = _normalize_recording_collection(
            qp.get("recording_collection") or RECORDING_COLLECTION_LIVE
        )
    except HTTPException as e:
        await _ws_send_json(
            websocket,
            {"type": "error", "error": str(e.detail), "fatal": True},
        )
        await websocket.close(code=4400, reason="unsupported recording collection")
        return
    diarize = str(qp.get("diarize") or "").strip().lower() in ("1", "true", "yes", "on")

    started_at = datetime.now()
    recovery_ctx: Optional[dict] = None
    # Registered before anything can fail, released in the finally below,
    # so the window in which this session counts as "streaming" is exactly
    # the window in which a writer could be holding the spool open.
    _register_live_session(session_id)
    try:
        try:
            recovery_ctx = _open_live_recovery(
                session_id=session_id,
                started_at=started_at,
                provider=provider,
                model=model or (DEFAULT_DEEPGRAM_AUDIO_MODEL if provider == "deepgram" else DEFAULT_LOCAL_TRANSCRIPTION_MODEL),
                language=lang_opt or "auto",
                archive_dir=archive_dir,
                recording_collection=recording_collection,
            )
        except Exception as e:
            recovery_ctx = None
            logger.warning(
                "live recovery disabled for session_id=%s: %s",
                session_id,
                e,
                exc_info=True,
            )
        if provider == "deepgram":
            dg_cfg = load_config()
            dg_key = _configured_deepgram_key(dg_cfg)
            if not dg_key:
                await _ws_send_json(
                    websocket,
                    {
                        "type": "error",
                        "error": "Deepgram API key is not configured",
                        "fatal": True,
                    },
                )
                await _ws_send_json(
                    websocket,
                    live_final_envelope(
                        source=DEEPGRAM_LIVE_SOURCE,
                        error="Deepgram API key is not configured",
                    ),
                )
                _mark_recovery_error(recovery_ctx)
                return
            dg_keyterms = configured_keyterms(dg_cfg)
            # The dual-reading decision is made HERE, where the config
            # has just been read, and passed down — the session runner
            # takes resolved inputs, not a config to re-interpret.
            await _run_deepgram_live_session(
                websocket=websocket,
                api_key=dg_key,
                model=model or DEFAULT_DEEPGRAM_AUDIO_MODEL,
                language=language,
                diarize=diarize,
                keyterms=dg_keyterms,
                recovery=recovery_ctx,
                dual_language=(
                    dual_secondary_language(dg_cfg)
                    if dual_stream_enabled(dg_cfg, language)
                    else ""
                ),
            )
        else:
            await _run_local_live_session(
                websocket=websocket,
                model=model or DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
                language=lang_opt,
                recovery=recovery_ctx,
            )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        if not _is_broken_pipe_error(e):
            _mark_recovery_error(recovery_ctx)
            logger.error("ws/transcribe fatal error: %s", e, exc_info=True)
            await _ws_send_json(
                websocket,
                # Redact: OSError during recovery-ctx open / disk-full
                # mid-write embeds the live_recovery absolute path
                # into str(e). _safe_error_text strips POSIX/Windows
                # paths + token-shaped substrings before the WS frame
                # forwards anything to the renderer.
                {"type": "error", "error": _safe_error_text(e), "fatal": True},
            )
        else:
            logger.warning("ws/transcribe transient broken pipe: %s", e)
    finally:
        _unregister_live_session(session_id)
        if recovery_ctx is not None:
            _finalize_live_recovery(recovery_ctx)


def _normalize_live_provider(raw: Optional[str]) -> str:
    """Return the provider to use for a live WebSocket session.

    Only providers with genuine streaming support (``deepgram``) take a
    dedicated path; everything else runs the local ``LiveSession``
    assist pipeline.
    """
    value = (raw or "").strip().lower()
    if value == "deepgram":
        return "deepgram"
    return "local"


def _open_live_recovery(
    *,
    session_id: str,
    started_at: datetime,
    provider: str,
    model: str,
    language: str,
    archive_dir: str,
    recording_collection: str,
) -> dict:
    """Create a recovery PCM file + metadata for a live session.

    Ordering is critical for leak-freedom:
      1. Build ``meta_payload`` in memory (infallible).
      2. Write metadata JSON to disk (cheap, fails fast on ENOSPC /
         permission denied / etc.).
      3. Only NOW open the PCM file for append. If any step before
         this raises, there is no file handle to close.
      4. If the function is about to succeed but a later step inside
         this function raises, the local ``pcm_file`` is closed
         before re-raising. Callers receive either a fully-usable
         recovery context or an exception with nothing leaked.
    """
    stem = f"{started_at.strftime('%Y%m%d_%H%M%S')}_{session_id}"
    pcm_path = LIVE_RECOVERY_DIR / f"{stem}.pcm16"
    meta_path = LIVE_RECOVERY_DIR / f"{stem}.json"
    meta_payload = {
        "session_id": session_id,
        "started_at": started_at.isoformat(),
        "finished_at": "",
        "sample_rate": LIVE_SAMPLE_RATE_HZ,
        "format": "pcm16le_mono",
        "bytes": 0,
        "chunks": 0,
        "model": model,
        "language": language,
        "archive_dir": archive_dir,
        "recording_collection": recording_collection,
        "status": "recording",
        "provider": provider,
    }
    # Metadata first — if this fails there is no file handle to leak.
    # SSOT atomic write: bare `write_text` produces a zero-byte file on
    # crash mid-write, and `_list_live_recoveries` silently skips
    # unparseable metas → user loses the recovery entry even though
    # the PCM itself is intact.
    atomic_write_json(meta_path, meta_payload)

    try:
        pcm_file = pcm_path.open("wb", buffering=0)
    except BaseException:
        _best_effort_unlink(pcm_path, context="live recovery open rollback")
        _best_effort_unlink(meta_path, context="live recovery open rollback")
        raise
    try:
        return {
            "session_id": session_id,
            "started_at": started_at,
            "pcm_path": pcm_path,
            "meta_path": meta_path,
            "pcm_file": pcm_file,
            "meta": meta_payload,
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }
    except BaseException:
        # Closing the file before propagating so no FD leaks on an
        # unexpected error constructing the return dict.
        try:
            pcm_file.close()
        except OSError:
            pass
        raise


def _mark_recovery_error(recovery: Optional[dict]) -> None:
    if recovery is not None:
        recovery["had_error"] = True


def _record_recovery_chunk(recovery: Optional[dict], data: bytes) -> None:
    if recovery is None:
        return
    if recovery.get("write_failed"):
        return
    if not data:
        return
    chunk = bytes(data)
    if len(chunk) % 2:
        logger.warning(
            "live recovery received odd PCM16 chunk (%d B); dropping trailing byte",
            len(chunk),
        )
        chunk = chunk[:-1]
        if not chunk:
            return
    # Hard cap on the per-session recovery spool. Without this a user
    # who leaves a tab streaming overnight (or a runaway reconnect loop)
    # can fill a small SSD. We stop writing silently once the ceiling is
    # reached — the live-transcription stream itself is unaffected and
    # the finalized transcript lands in recordings/ normally.
    if recovery["bytes"] >= MAX_LIVE_RECOVERY_BYTES:
        if not recovery.get("over_limit"):
            recovery["over_limit"] = True
            logger.warning(
                "live recovery byte cap reached (%d B >= %d B); "
                "dropping further recovery writes for this session",
                recovery["bytes"], MAX_LIVE_RECOVERY_BYTES,
            )
        return
    remaining = MAX_LIVE_RECOVERY_BYTES - int(recovery["bytes"])
    if len(chunk) > remaining:
        chunk = chunk[: remaining - (remaining % 2)]
        if not chunk:
            return
    # Counter increment MUST follow a successful write — otherwise an
    # OSError on the very chunk that wins (full disk, EBADF, EIO) still
    # bumps ``bytes`` and ``chunks``. Subsequent comparisons against
    # MAX_LIVE_RECOVERY_BYTES then trip earlier than reality, the meta
    # JSON written on finalize overstates how much PCM actually landed,
    # and downstream duration math (``bytes / 32000.0``) reports a
    # longer recording than truly recoverable.
    try:
        written = recovery["pcm_file"].write(chunk)
    except OSError as e:
        recovery["write_failed"] = True
        recovery["had_error"] = True
        recovery["write_error"] = _safe_error_text(e)
        logger.warning(
            "live recovery write failed; disabling recovery writes for this session "
            "(bytes=%d chunks=%d): %s",
            int(recovery.get("bytes") or 0),
            int(recovery.get("chunks") or 0),
            e,
        )
        return
    if written is None:
        written = len(chunk)
    if written <= 0:
        return
    if written != len(chunk):
        recovery["had_error"] = True
        recovery["partial_write"] = True
        logger.warning(
            "live recovery partial write (%d/%d B); marking recovery degraded",
            written,
            len(chunk),
        )
    recovery["chunks"] += 1
    recovery["bytes"] += int(written)


def _finalize_live_recovery(recovery: dict) -> None:
    # Flush + fsync inside try/finally so ``close()`` is GUARANTEED to
    # run on every error path. Previous form had ``f.flush()`` outside
    # the inner try, so an OSError from flush (disk full, EIO mid-
    # write) jumped to the outer except WITHOUT closing the file —
    # leaking one PCM file descriptor per failed session. On a
    # consistently-failing disk the per-process FD limit is reached in
    # minutes and the entire backend stops accepting WS connections.
    f = recovery["pcm_file"]
    try:
        try:
            # Flush Python buffers and fsync the kernel buffer to disk
            # BEFORE closing — close alone does not call fsync, so a
            # power cut between close and the next syscall can leave
            # the recovery spool with the last batch of writes only
            # in the kernel page cache. This file's whole purpose is
            # crash recovery, so the one place we MUST be durable is
            # at finalize.
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError as fsync_err:
                # Non-POSIX filesystems can refuse fsync; the data is
                # already flushed out of Python into the OS, which is
                # all we can promise on those platforms.
                logger.debug("live recovery fsync skipped: %s", fsync_err)
        except OSError as flush_err:
            logger.warning("live recovery flush/fsync failed: %s", flush_err)
    finally:
        # Close ALWAYS runs — even on flush() failure. FD never leaks.
        try:
            f.close()
        except OSError as close_err:
            logger.warning("live recovery close failed: %s", close_err)
    try:
        if recovery["bytes"] < LIVE_RECOVERY_MIN_BYTES:  # ~1s at LIVE_SAMPLE_RATE_HZ mono pcm16
            recovery["pcm_path"].unlink(missing_ok=True)
            recovery["meta_path"].unlink(missing_ok=True)
            return
        meta = dict(recovery["meta"])
        meta.update(
            {
                "finished_at": datetime.now().isoformat(),
                "bytes": recovery["bytes"],
                "chunks": recovery["chunks"],
                "status": "error" if recovery["had_error"] else "recoverable",
                "write_error": str(recovery.get("write_error") or ""),
            }
        )
        # SSOT atomic write — finalize path. Same rationale as the
        # recovery-start write above.
        atomic_write_json(recovery["meta_path"], meta)
    except OSError as e:
        logger.warning("live recovery meta write failed: %s", e)


# How much spool PCM the finalize-time recovery pass will hold in memory
# at once. 128 MB is 68 minutes of 16 kHz mono PCM16 — an order of
# magnitude past the longest dictation this app is built for, and the
# point past which reading a whole spool to repair a few seconds of it
# costs more than the repair is worth. Above it the recovery is skipped
# with a warning and the spans it would have covered stay declared in
# the envelope's ``uncoveredSpeechSec``, which is what makes the skip
# visible rather than silent.
MAX_RECOVERY_READ_BYTES = 128 * 1024 * 1024


def _recovery_spool_bytes(recovery: Optional[dict]) -> bytes:
    """The PCM this recording captured, read back from its own spool.

    The backend now owns recovery (audit §2.2/§3.7): the ``final``
    envelope is completed from this audio before it is sent, instead of
    the renderer racing its own REST pass against it. That is only
    possible because the spool is complete and readable AT FINALIZE:

    * every binary frame is written to it as it arrives — by the
      pre-connect reader, by the receiver, and by the finalize drain, so
      audio captured while ``connect()`` was still in flight (or after
      the upstream died) is in it too;
    * the file is opened UNBUFFERED (``_open_live_recovery``), so
      everything ``_record_recovery_chunk`` accepted is already visible
      to this read even though the writer still holds the handle;
    * it is deleted only by ``_finalize_live_recovery``, which the
      WebSocket handler runs in its ``finally`` — strictly after the
      envelope has been sent.

    Returns ``b""`` — never raises — when there is no spool, when it is
    unreadable, or when it is larger than this process will read at
    once. The caller then ships the envelope unrepaired, with the
    uncovered spans still declared.
    """
    if not recovery:
        return b""
    pcm_path = recovery.get("pcm_path")
    if pcm_path is None:
        return b""
    try:
        size = Path(pcm_path).stat().st_size
    except OSError as e:
        logger.warning("live recovery spool not readable at finalize: %s", e)
        return b""
    if size > MAX_RECOVERY_READ_BYTES:
        logger.warning(
            "live recovery spool is %d B (> %d B); skipping finalize-time "
            "recovery for this session",
            size,
            MAX_RECOVERY_READ_BYTES,
        )
        return b""
    try:
        data = Path(pcm_path).read_bytes()
    except OSError as e:
        logger.warning("live recovery spool read failed at finalize: %s", e)
        return b""
    if len(data) % 2:
        # A 16-bit sample split across the read boundary would shift
        # every sample after it; drop the odd trailing byte instead.
        data = data[:-1]
    return data


def _recovery_spool_seconds(recovery: Optional[dict]) -> float:
    """How much audio the spool holds, without reading it.

    The size on disk rather than the ``bytes`` counter: a partial write
    (``_record_recovery_chunk`` marks the session degraded and keeps
    going) leaves the two disagreeing, and the recovery pass must
    measure the audio it can actually read.
    """
    if not recovery:
        return 0.0
    pcm_path = recovery.get("pcm_path")
    if pcm_path is None:
        return 0.0
    try:
        size = Path(pcm_path).stat().st_size
    except OSError:
        return 0.0
    return (size - size % 2) / float(LIVE_PCM_BYTES_PER_SEC)


def _finalizing_payload(budget_sec: float, expects_more: bool) -> dict:
    """The ``finalizing`` announcement, built in ONE place.

    Both announcements a stop can make — the drain's budget and the
    extension the recovery pass may need — are the same message with the
    same meaning to the renderer (a re-armable deadline measured from
    the start of its wait), so they are built by one function rather
    than typed out twice with a chance of diverging.
    """
    return {
        "type": "finalizing",
        "budgetMs": int(round(max(0.0, budget_sec) * 1000)),
        "expectsMore": bool(expects_more),
    }


def _predicted_recovery_budget_sec(session: Any, spool_sec: float) -> float:
    """The recovery budget this stop looks like it will need, announced early.

    Asked at the moment the drain announces its own budget, from
    coverage the session already holds, so the number the renderer is
    told bounds the time until the ENVELOPE is sent rather than only the
    time until the provider flush resolves (C3, audit §2.5).

    Deliberately the PESSIMISTIC estimate: it reads the readings'
    committed segments as they stand mid-stop, before the flush that is
    about to land and (for a dual recording) before the merge that may
    fill a hole from the other reading — so it over-announces rather
    than under-announces. Over-announcing costs nothing: the renderer's
    wait ends when the envelope arrives, not when the budget does.
    Under-announcing costs the user their last clause.
    """
    try:
        spans = uncovered_spans(
            session.streamed_sec,
            session.committed_segments(),
            evidence_from_session(session),
            session.stream_death_sec,
            audio_sec=spool_sec,
        )
    except Exception as e:
        # A prediction is not worth a failed stop.
        logger.warning("recovery: budget prediction failed: %s", e)
        return 0.0
    return recovery_budget_sec(spans)


async def _apply_live_recovery(
    *,
    payload: dict,
    session: Any,
    recovery: Optional[dict],
    cfg: DeepgramLiveConfig,
    api_key: str,
    announce: Optional[Callable[[float], None]] = None,
    announced_recovery_sec: float = 0.0,
) -> dict:
    """Complete a ``final`` envelope from this backend's own audio spool.

    The ONE place the recovery pass is wired in. Both stop shapes reach
    it: the normal one, with the drained envelope and the session that
    produced it, and the connect-failure one, with a skeleton envelope
    and no session at all — which is exactly the case that used to send
    an empty envelope and leave the recording to the renderer.

    Never raises and never blocks the envelope: anything that goes wrong
    here leaves the payload as it arrived, with the spans it could not
    cover still counted in ``uncoveredSpeechSec``.
    """
    if not api_key:
        return payload
    try:
        if session is None:
            # The upstream never opened: no reading exists, nothing was
            # heard, and every captured byte is unseen by Deepgram —
            # which is what ``stream_death_sec=0`` says.
            evidence = InterimEvidence()
            stream_death_sec: Optional[float] = 0.0
        else:
            evidence = evidence_from_session(session)
            stream_death_sec = session.stream_death_sec
        return await run_recovery(
            payload=payload,
            evidence=evidence,
            stream_death_sec=stream_death_sec,
            # Lazily: the overwhelming majority of stops need no
            # recovery, and reading a long recording's spool into memory
            # to be told so would put that cost on every one of them.
            # The byte count answers "how much audio is there" without
            # the read.
            pcm=lambda: _recovery_spool_bytes(recovery),
            audio_sec=_recovery_spool_seconds(recovery),
            cfg=cfg,
            api_key=api_key,
            sample_rate=LIVE_SAMPLE_RATE_HZ,
            announce=announce,
            announced_recovery_sec=announced_recovery_sec,
        )
    except Exception as e:
        logger.error(
            "live recovery failed; envelope sent unrepaired: %s", e, exc_info=True
        )
        return payload


# 1.1.25: hard timeout for the per-message WS send.
# A misbehaving / paused client (background tab, slow renderer) would
# otherwise let Starlette's send buffer back up and the await would
# suspend indefinitely. The Deepgram forwarder calls _ws_send_json on
# every event; one stalled send wedges the entire forwarder loop and
# prevents stop.set() from being honoured. 5 s is generous for a
# loopback websocket — anything beyond is a stalled client we should
# treat as a broken pipe and let recovery proceed.
_WS_SEND_TIMEOUT_SEC = 5.0


async def _ws_send_json(websocket: WebSocket, payload: dict) -> bool:
    """Send a JSON payload on a WebSocket, swallowing harmless shutdown races.

    Returns ``True`` on success. Logs transient broken-pipe errors and
    returns ``False`` without raising so the caller can continue its
    cleanup. A send that exceeds ``_WS_SEND_TIMEOUT_SEC`` is treated as
    a broken pipe — the sender returns False and the caller's normal
    "client gone" cleanup path runs.
    """
    try:
        await asyncio.wait_for(
            websocket.send_text(json.dumps(payload, ensure_ascii=False)),
            timeout=_WS_SEND_TIMEOUT_SEC,
        )
        return True
    except asyncio.TimeoutError:
        # Same return-False semantics as broken-pipe — caller's loop
        # treats this as "client gone" and shuts the session down,
        # rather than wedging on a paused renderer indefinitely.
        logger.warning(
            "ws send timed out after %.1fs (treating as broken pipe)",
            _WS_SEND_TIMEOUT_SEC,
        )
        return False
    except Exception as e:
        if _is_broken_pipe_error(e):
            logger.debug("ws send skipped (pipe closed): %s", e)
        else:
            # 1.1.25: include traceback for non-pipe failures so a
            # JSON-encoding error (e.g. numpy.float32 leak into a
            # segment dict) doesn't hide its call site.
            logger.warning("ws send failed: %s", e, exc_info=True)
        return False


async def _ws_recv_next(websocket: WebSocket) -> dict:
    """Receive the next WebSocket message as a normalized dict.

    Returns ``{"kind": "bytes", "data": bytes}`` for binary frames,
    ``{"kind": "control", "payload": dict}`` for JSON text frames
    (e.g., ``{"type": "finalize"}``), ``{"kind": "text", "data": str}``
    for text frames that fail to parse as JSON, or
    ``{"kind": "disconnect"}`` when the client closed the socket.
    """
    try:
        message = await websocket.receive()
    except WebSocketDisconnect:
        return {"kind": "disconnect"}
    mtype = message.get("type")
    if mtype == "websocket.disconnect":
        return {"kind": "disconnect"}
    if "bytes" in message and message["bytes"] is not None:
        return {"kind": "bytes", "data": message["bytes"]}
    text = message.get("text")
    if text is None:
        return {"kind": "disconnect"}
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return {"kind": "control", "payload": parsed}
    except (ValueError, TypeError) as e:
        logger.debug("ws recv: non-json text frame ignored: %s", e)
    return {"kind": "text", "data": text}


async def _run_local_live_session(
    *,
    websocket: WebSocket,
    model: str,
    language: Optional[str],
    recovery: Optional[dict],
) -> None:
    """Drive the local faster-whisper assist pipeline for a live session."""
    if model not in ALLOWED_LOCAL_MODELS:
        model = DEFAULT_LOCAL_TRANSCRIPTION_MODEL
    session = LiveSession(model_name=model, language=language)
    stop = asyncio.Event()

    async def receiver() -> None:
        try:
            while not stop.is_set():
                msg = await _ws_recv_next(websocket)
                kind = msg["kind"]
                if kind == "disconnect":
                    stop.set()
                    return
                if kind == "bytes":
                    data = msg["data"]
                    _record_recovery_chunk(recovery, data)
                    await session.append_pcm16le(data)
                    continue
                if kind == "control":
                    if msg["payload"].get("type") == "finalize":
                        stop.set()
                        return
        except Exception as e:
            if _is_broken_pipe_error(e):
                logger.warning("ws local receiver broken pipe: %s", e)
            else:
                _mark_recovery_error(recovery)
                logger.error("ws local receiver error: %s", e, exc_info=True)
            stop.set()

    async def transcriber() -> None:
        try:
            while not stop.is_set():
                out = await session.maybe_transcribe()
                if out:
                    if not await _ws_send_json(websocket, out):
                        stop.set()
                        return
                    # A fatal error envelope from LiveSession means the
                    # pipeline exceeded its retry budget and cannot
                    # produce more segments. Mark the session as errored
                    # so `_finalize_live_recovery` retains the PCM for
                    # offline recovery, then let the receiver drain.
                    if (
                        isinstance(out, dict)
                        and out.get("type") == "error"
                        and out.get("fatal")
                    ):
                        _mark_recovery_error(recovery)
                        stop.set()
                        return
                try:
                    await asyncio.wait_for(stop.wait(), timeout=0.2)
                except asyncio.TimeoutError:
                    pass
        except Exception as e:
            if _is_broken_pipe_error(e):
                logger.warning("ws local transcriber broken pipe: %s", e)
            else:
                _mark_recovery_error(recovery)
                logger.error("ws local transcriber error: %s", e, exc_info=True)
            stop.set()

    rx = asyncio.create_task(receiver(), name="ws-local-rx")
    tx = asyncio.create_task(transcriber(), name="ws-local-tx")
    try:
        await asyncio.wait({rx, tx}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        stop.set()
        for task in (rx, tx):
            if not task.done():
                task.cancel()
        for task, what in ((rx, "local live receiver"), (tx, "local live transcriber")):
            await await_cancelled(task, what=what, log=logger)
        # Best-effort final emit in case transcriber missed the tail.
        # Bounded (BUG-69): maybe_transcribe(force=True) awaits any
        # in-flight pass, and a wedged inference thread has no internal
        # ceiling — without an outer bound a hung pass stalled the whole
        # WS close path for minutes. 30 s covers the slowest legitimate
        # CPU pass over a ≤17 s window.
        try:
            tail = await asyncio.wait_for(
                session.maybe_transcribe(force=True), timeout=30.0
            )
            if tail:
                await _ws_send_json(websocket, tail)
        except asyncio.TimeoutError:
            logger.warning("ws local tail emit skipped: forced flush exceeded 30s")
        except Exception as e:
            if not _is_broken_pipe_error(e):
                logger.debug("ws local tail emit failed: %s", e)
        # 1.1.25: final envelope now reports the cumulative transcript
        # accumulated across the session. Previously this always sent
        # text="" / segments=[] / durationSec=0.0 — causing the frontend
        # to mis-classify a successful local-assist session as empty
        # and trigger an unnecessary recovery REST round-trip on every
        # local-provider stop.
        final_state = session.finalize_envelope()
        await _ws_send_json(
            websocket,
            live_final_envelope(
                source=LOCAL_ASSIST_SOURCE,
                text=final_state["text"],
                segments=final_state["segments"],
                duration_sec=final_state["duration_sec"],
                # How far a decoder reported. For the local assist that
                # is exactly its covered window: everything it emitted
                # came out of a Whisper pass, never an interim.
                covered_end_sec=final_state["covered_sec"],
                streamed_sec=final_state["total_sec"],
                # ``uncoveredSpeechSec`` is left at its "nothing to
                # report" value on purpose: it means "seconds where the
                # provider's own INTERIMS recognised speech no final
                # covered", and the local assist has no interims. What
                # this transport genuinely knows about its gaps is in
                # ``coverage`` below — the report the renderer's
                # adoption policy actually reads.
                # Coverage truth for this session. ``complete`` certifies
                # that every captured second reached the model, which lets
                # the frontend adopt this transcript instead of paying for
                # a full re-transcription of the saved recording. See
                # ``LiveSession.finalize_envelope`` for the definition.
                #
                # B-038: these five numbers used to be FLAT keys on this
                # envelope and on no other, which is what made ``final``
                # three shapes instead of one. They are one report about
                # one transport, so they travel as one object — and the
                # transports that have no windows send ``null``, not
                # nothing.
                coverage=live_coverage(
                    complete=final_state["complete"],
                    covered_sec=final_state["covered_sec"],
                    total_sec=final_state["total_sec"],
                    dropped_sec=final_state["dropped_sec"],
                    uncovered_tail_sec=final_state["uncovered_tail_sec"],
                ),
            ),
        )


# B2 (audit §3.7): frames buffered while ``session.connect()`` is still
# in flight, so they can be replayed into Deepgram once it succeeds.
# Every such frame is ALSO recorded into the recovery spool unconditio-
# nally as it arrives — this cap only bounds the in-memory replay queue
# against a pathologically slow/hung connect, it never bounds what the
# spool retains. At 16 kHz/16-bit mono a live renderer chunk is small
# (observed: tens to low hundreds of ms of audio per frame), so this
# comfortably covers the observed 1-12 s connect window.
_PRECONNECT_FRAME_BUFFER_MAX = 4096

# C2: the tail-preserving drain after ``finalize`` — 250 ms was always
# spent in full because the mic is already stopped by the time the
# control message arrives, so there is usually nothing left to wait
# for. When the renderer's ``finalize`` carries the counts it actually
# sent (C1), the drain instead stops the moment those counts are
# matched, still bounded by the same ceiling for older renderers or a
# genuinely stalled connection.
_FINALIZE_DRAIN_CEILING_SEC = 0.25

# ---- Send path (audit §3.6) ------------------------------------------
#
# The renderer's frames used to be pushed to Deepgram from inside the
# receive loop: ``await session.send_pcm(data)`` between two
# ``websocket.receive()`` calls. One slow send therefore stopped the
# app reading its own socket, and a wedged one stopped it for the whole
# 5 s timeout — four times in a row in one recorded session, 20 s of a
# user's dictation with nothing being read, their ``finalize`` queued
# behind hundreds of binary frames. The timeout itself made it worse:
# cancelling ``ws.send`` mid-frame leaves a ``websockets`` connection in
# an undefined state, which is the most plausible explanation for those
# hangs arriving in runs.
#
# So: the receiver hands frames to a queue and returns to reading; one
# sender task owns the upstream socket, batches frames and never has its
# send cancelled; a watchdog decides the upstream is wedged from the AGE
# of the audio waiting to go out, and answers by closing the socket
# (which makes the pending send raise) instead of cancelling the write.

# 1600 bytes = 50 ms at 16 kHz mono PCM16. The renderer emits frames far
# smaller than this (observed ~85 bytes at ~375 frames/s); one WebSocket
# message per frame is 375 sends per second of syscalls, framing and
# TLS records for 32 kB/s of audio. Deepgram's own guidance is 20-250 ms
# per message.
_SEND_BATCH_BYTES = 1600
# How long a partial batch may wait for more audio before going out
# anyway. Bounds the latency this batching can add to the live
# transcript; a talking user fills 50 ms of audio in 50 ms, so this only
# fires at the trailing edge of speech.
_SEND_BATCH_MAX_WAIT_SEC = 0.05
# Hard cap on the queue. Both bounds exist: the frame count keeps a
# pathological renderer from making the queue itself the leak, and the
# byte count is the meaningful one — 320 kB is 10 s of audio, twice the
# wedge deadline below, so a healthy session never comes close and a
# wedged one is detected long before the bound bites.
_SEND_QUEUE_MAX_FRAMES = 8192
_SEND_QUEUE_MAX_BYTES = 320_000
# Audio still waiting this long after it was captured means the upstream
# is not accepting writes. Sized well above any plausible network hiccup
# (a 1600-byte write on a live socket completes in microseconds) and at
# the same 5 s the old per-send timeout used, so the failure is reported
# no later than it used to be — but by closing the socket rather than by
# cancelling a write.
_SEND_WEDGE_TIMEOUT_SEC = 5.0
_SEND_WEDGE_POLL_SEC = 0.5
# At stop: how long the queued audio may take to drain before Finalize
# goes out anyway. A wedged upstream is detected at
# _SEND_WEDGE_TIMEOUT_SEC and releases this wait early, so the full
# budget is only ever spent by a stream that is slow rather than dead.
_SEND_FLUSH_DEADLINE_SEC = _SEND_WEDGE_TIMEOUT_SEC + 1.0
# Extra grace given to the send flush when a warm-socket swap is already
# running: the swap is inside the sender, and what it is waiting on is a
# connect. Derived from the connect budget itself
# (``DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC`` + one retry) rather than picked, so
# it cannot fall behind a change to either. Only ever spent on the rare
# stop that lands in the middle of a replacement.
_WARM_SWAP_GRACE_SEC = (
    DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC + DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC
)
# Rides the same queue as the audio, so "Finalize is applied after every
# byte already captured" holds by construction rather than by a sleep.
_SEND_FINALIZE_SENTINEL = object()

# ---- Warm upstream socket (audit §2.4 / §3.7) -------------------------
#
# Connecting to Deepgram cost p50 880 ms / p90 1.2 s / max 9.7 s at the
# start of every recording, plus one 12 s timeout that swallowed 126 s of
# dictation. ``backend.deepgram_warm`` keeps one socket open ahead of the
# hotkey so that cost is paid before the user starts speaking; see that
# module for the KeepAlive-vs-silence decision, the timestamp invariant
# and the billing bound.

# How long an ADOPTED warm socket has to prove it is alive. A socket can
# die silently — a half-open TCP connection accepts writes into a black
# hole and Deepgram never answers a KeepAlive — and the only positive
# evidence is a message coming back. Measured against the first frame
# that actually carries speech, not the first frame: a user who presses
# the hotkey and pauses to think sends only silence, which Deepgram is
# entitled to answer with nothing.
_WARM_PROBE_TIMEOUT_SEC = 2.5
_WARM_PROBE_POLL_SEC = 0.1
# Audio kept for replay while the probe is unresolved: everything
# already written to the adopted socket, so a replacement starts from
# the true beginning of the recording rather than from the moment the
# swap completed. Bounded at 8 s of 16 kHz PCM16 — the probe window plus
# a worst-case connect, with room to spare.
_WARM_REPLAY_MAX_BYTES = 8 * LIVE_PCM_BYTES_PER_SEC


# The live-config builder now lives with the config type
# (``remote_deepgram_live.live_config``) so the A/B tool, which drives
# the same warm pool, builds the same query string this handler does —
# the pool keys its socket on that string. Bound to the old private name
# because this module and its tests refer to it by that name.
_live_config = live_config


def _new_live_session(
    api_key: str, cfg: DeepgramLiveConfig, *, audio_offset_sec: float = 0.0
) -> DeepgramLiveSession:
    """Construct a live session — the ONE place backend.main makes one.

    Both the warm pool and the mid-stream replacement go through here,
    so the KeepAlive cadence a warm socket needs is configured once, and
    a test that patches ``DeepgramLiveSession`` still sees every session
    the WebSocket handler uses. Resolved through the module global on
    purpose (not captured at import time) for exactly that reason.
    """
    return DeepgramLiveSession(
        api_key=api_key,
        config=cfg,
        keepalive_interval_sec=WARM_KEEPALIVE_INTERVAL_SEC,
        audio_offset_sec=audio_offset_sec,
    )


# Armed by the app lifespan and released there; un-armed it retains
# nothing and ``acquire()`` is a plain connect, so importing this module
# never leaves a socket open.
DEEPGRAM_WARM_POOL = DeepgramWarmPool(session_factory=_new_live_session)


def _configured_deepgram_key(cfg: Any) -> str:
    """Read the Deepgram API key out of the app config, or ``""``.

    One expression for the config path both Deepgram live entry points
    read — the WebSocket handler and the boot pre-warm — matching what
    ``configured_keyterms`` already does for the other half of the same
    settings block.
    """
    providers = cfg.get("providers") if isinstance(cfg, dict) else None
    deepgram = providers.get("deepgram") if isinstance(providers, dict) else None
    key = deepgram.get("key") if isinstance(deepgram, dict) else None
    return str(key or "").strip()


async def _discard_secondary_acquire(task: "Optional[asyncio.Task]") -> None:
    """Release a second-reading acquire the recording no longer needs.

    The two acquires of a dual-stream recording are started together, so
    the second one can still be connecting — or already connected — when
    the first one fails. Cancelling is not enough on either side of that
    race: a cancel that arrives after ``connect()`` returned leaves a
    live, billed socket holding a slot against the account's
    concurrency limit, which is the same hole the warm pool's
    ``_cancel_pending`` had.
    """
    acquisition = await cancel_and_collect(
        task, what="dual-stream second reading acquire", log=logger
    )
    if acquisition is None:
        return
    try:
        await acquisition.session.discard()
    except Exception as e:  # pragma: no cover - teardown is best-effort
        logger.debug("dual-stream: second reading close ignored: %s", e)


async def _prewarm_deepgram_at_boot() -> None:
    """Open the first warm socket at backend start, if a key is set.

    The live model and language are renderer settings that arrive as
    query parameters, so at boot the only honest guess is the default
    the renderer sends when the user has not chosen otherwise. A wrong
    guess is self-correcting and cheap: ``acquire()`` discards the
    mismatched socket with a logged reason and connects fresh, and the
    re-warm after that recording uses the configuration actually used.
    """
    try:
        cfg = await asyncio.to_thread(load_config)
    except Exception:
        logger.exception("boot deepgram pre-warm: config read failed")
        return
    api_key = _configured_deepgram_key(cfg)
    if not api_key:
        return
    primary_cfg = _live_config(
        model=DEFAULT_DEEPGRAM_AUDIO_MODEL,
        language="auto",
        diarize=False,
        keyterms=configured_keyterms(cfg),
    )
    DEEPGRAM_WARM_POOL.rewarm(api_key, primary_cfg)
    # Both readings, when this configuration runs two. The second one is
    # a different query string and therefore a different pool key, so
    # warming only the primary left ``WARM_MAX_SOCKETS = 2`` — a bound
    # introduced for exactly this case — describing a pool that never
    # held more than one socket, and the second reading paying a cold
    # connect on every single recording.
    if dual_stream_enabled(cfg, "auto"):
        DEEPGRAM_WARM_POOL.rewarm(
            api_key, secondary_config(primary_cfg, dual_secondary_language(cfg))
        )


async def _run_deepgram_live_session(
    *,
    websocket: WebSocket,
    api_key: str,
    model: str,
    language: str,
    diarize: bool,
    keyterms: tuple[str, ...] = (),
    recovery: Optional[dict],
    dual_language: str = "",
) -> None:
    """Drive the Deepgram live streaming proxy for one recording.

    On a hard Deepgram failure (connect error, mid-stream fatal error,
    socket drop) we do NOT swallow the failure — we surface it to the
    frontend via ``{"type":"error","fatal":true}`` and the subsequent
    ``{"type":"final","error":...}``. The frontend then falls back to
    the Deepgram REST endpoint on the saved canonical WAV. This gives
    us two independent paths into Deepgram (WS + REST) without coupling
    the server state machine to either one.

    Stop-chain wire protocol (wave 2, audit §2/§3.5-3.7):

    * The renderer's ``finalize`` control message may carry
      ``framesSent``/``bytesSent`` — the count of binary frames/bytes it
      has sent on THIS connection, tail-hold frames included. When
      present, the post-finalize drain waits for exactly the frames
      still in flight instead of a blind 250 ms; an older renderer that
      omits them gets the previous behaviour unchanged (C1/C2).
    * ``finalizing`` is announced (unchanged shape) the instant the wait
      budget is chosen, before any waiting starts (C3) — see
      ``DeepgramLiveSession.drain_transcript``.
    * The ``final`` envelope is sent as soon as the transcript is known
      complete, BEFORE ``CloseStream``/the recv drain/``close()`` (C4) —
      those no longer gate delivery.
    * The envelope carries ``uncoveredSpeechSec``, ``streamedSec`` and
      ``coveredEndSec`` (C5) — see
      ``DeepgramLiveSession.drain_transcript`` for their definitions.

    ``dual_language`` non-empty asks for a SECOND reading of the same
    audio in that language, merged into one envelope at stop (see
    ``backend.deepgram_dual``). The decision is the caller's; everything
    below is written against one session object either way, because the
    dual facade presents the interface of one.
    """
    dg_cfg = _live_config(
        model=model,
        language=language,
        diarize=diarize,
        keyterms=keyterms,
    )
    # Rebound (once, by ``_swap_warm_socket``) if an adopted warm socket
    # turns out to be dead. Every closure below reads this name rather
    # than capturing the object, so the swap is invisible to them.
    session: DeepgramLiveSession

    # C1/C2 shared state: total binary frames/bytes received on this
    # connection, from before connect() even starts, so the finalize
    # drain always has an honest baseline to match the renderer's counts
    # against — a frame buffered during connect() and later replayed
    # still counts toward what the renderer says it sent.
    frames_received = 0
    bytes_received = 0

    # B2 (audit §3.7): consume renderer frames into the recovery spool
    # WHILE session.connect() is still running, instead of only starting
    # once it returns. The renderer streams audio the moment its mic
    # opens, independent of how long connect() takes (measured up to
    # 12 s) — without a reader running here, that audio sits unconsumed,
    # and on a connect FAILURE (the return path right below) it was
    # never recorded anywhere: the recovery spool held 0 bytes for a
    # session the user spoke 126 s into. Bytes are recorded to recovery
    # unconditionally as they arrive; the bounded queue is only for
    # replaying them into Deepgram once (if) connect succeeds.
    pending_frames: "deque[bytes]" = deque(maxlen=_PRECONNECT_FRAME_BUFFER_MAX)
    preconnect_finalize_payload: Optional[dict] = None
    preconnect_disconnected = False

    async def _preconnect_reader() -> None:
        nonlocal frames_received, bytes_received
        nonlocal preconnect_finalize_payload, preconnect_disconnected
        while True:
            msg = await _ws_recv_next(websocket)
            kind = msg["kind"]
            if kind == "disconnect":
                preconnect_disconnected = True
                return
            if kind == "bytes":
                data = msg["data"]
                frames_received += 1
                bytes_received += len(data)
                _record_recovery_chunk(recovery, data)
                pending_frames.append(data)
                continue
            if kind == "control" and msg["payload"].get("type") == "finalize":
                # Rare (Stop pressed before connect() even resolved), but
                # must not be lost: receiver() below checks this and
                # replays it through the same drain path as normal.
                preconnect_finalize_payload = msg["payload"]
                return
            # Any other control/text frame arriving before connect() is
            # unexpected from this renderer and is ignored; audio and
            # finalize are the only pre-connect traffic it sends.

    pre_task = asyncio.create_task(
        _preconnect_reader(), name="ws-dg-preconnect-rx",
    )

    # The stop's deadline is decided once, by the coverage analysis, and
    # told to the client before the waiting starts. A strong reference
    # until the send completes: asyncio holds only a weak one, so a
    # fire-and-forget task can be collected mid-flight.
    #
    # Declared HERE rather than in the finally block because the
    # connect-failure path below also announces one: that path now
    # re-decodes the whole recording itself, and a wait the renderer was
    # never told about is not a bounded wait.
    budget_sends: set[asyncio.Task] = set()

    def _send_finalizing(budget_sec: float, expects_more: bool) -> None:
        task = asyncio.get_running_loop().create_task(
            _ws_send_json(websocket, _finalizing_payload(budget_sec, expects_more))
        )
        budget_sends.add(task)
        task.add_done_callback(budget_sends.discard)

    # Both readings are asked for at once. The pool no longer holds its
    # lock across a connect, so two cold connects for a dual-stream
    # recording overlap instead of running back to back — the difference
    # between one connect budget before the first byte and two.
    secondary_task: Optional[asyncio.Task] = None
    if dual_language:
        secondary_task = asyncio.get_running_loop().create_task(
            DEEPGRAM_WARM_POOL.acquire(
                api_key, secondary_config(dg_cfg, dual_language)
            ),
            name="deepgram-secondary-acquire",
        )

    try:
        # Adopts the pre-opened socket when one matches this exact
        # configuration and is healthy; otherwise this is the same
        # connect() the handler always did, with the same failure mode.
        acquisition = await DEEPGRAM_WARM_POOL.acquire(api_key, dg_cfg)
        session = acquisition.session
    except DeepgramLiveError as e:
        logger.warning("ws deepgram connect failed: %s", e)
        _mark_recovery_error(recovery)
        await _ws_send_json(
            websocket,
            # Redact: Deepgram error messages can include API path
            # fragments / response bodies that may carry the user's
            # API key prefix or upstream IP.
            {"type": "error", "error": _safe_error_text(e), "fatal": True},
        )
        # The upstream never opened, so nothing will transcribe this
        # recording unless this side does — the renderer's own REST
        # recovery is gone, the envelope is the only transcript there is.
        # This used to return an EMPTY envelope here and leave the user
        # to the frontend's fallback while the microphone was still open
        # (audit §3.7: a 12 s connect timeout with 126 s dictated into a
        # dead stream). Keep the pre-connect reader running instead — it
        # already records every frame into the spool — until the renderer
        # finalizes or disconnects, then re-decode the whole recording.
        try:
            await pre_task
        except asyncio.CancelledError:
            # THIS session is being torn down (server shutdown, client
            # gone). Unlike everywhere else in this handler, the wait
            # above can legitimately last as long as the user keeps
            # talking, so swallowing a cancellation here would keep a
            # dead session running and pretend to deliver an envelope
            # nobody can receive.
            raise
        except Exception:
            pass
        # The primary never opened, so the second reading has nothing to
        # read alongside. Its socket is a billed connection against the
        # account's concurrency limit, so it is disposed of rather than
        # abandoned.
        await _discard_secondary_acquire(secondary_task)
        # 1.1.25: route through ``_safe_error_text`` so this final
        # envelope matches the redaction policy applied to the ``error``
        # event a few lines above. Previously this path leaked raw
        # Deepgram error bodies (which can include the upstream URL +
        # token prefix) into the renderer payload.
        connect_error = _safe_error_text(e)
        # The skeleton the recovery pass repairs: no reading exists, so
        # every field takes its "nothing to report" value and the whole
        # transcript comes from the re-decode below. Built through the
        # same constructor as a successful stop — this used to be the
        # THIRD of B-038's three shapes.
        final_payload = live_final_envelope(
            source=DEEPGRAM_LIVE_SOURCE,
            error=connect_error,
        )
        final_payload = await _apply_live_recovery(
            payload=final_payload,
            session=None,
            recovery=recovery,
            cfg=dg_cfg,
            api_key=api_key,
            announce=lambda budget: _send_finalizing(budget, True),
        )
        await _ws_send_json(websocket, final_payload)
        return

    # The second reading, if this recording is running two. Its failure
    # is not the recording's: everything it would have added is what the
    # user got before this feature existed, so it degrades to one
    # reading with a warning and never to an aborted recording.
    if secondary_task is not None:
        try:
            secondary = await secondary_task
            primary_language = resolve_live_language(language)
            session = DualLiveSession(
                primary=session,
                secondary=secondary.session,
                secondary_language=dual_language,
                primary_language=primary_language,
            )
            logger.info(
                "dual-stream: second reading opened primary=%s secondary=%s "
                "(adopted=%s)",
                primary_language,
                dual_language,
                secondary.adopted,
            )
        except Exception as e:
            logger.warning(
                "dual-stream: second reading (%s) could not be opened, "
                "continuing single-stream: %s",
                dual_language,
                e,
            )

    await cancel_and_await(pre_task, what="deepgram pre-connect reader", log=logger)

    stop = asyncio.Event()
    upstream_fatal = False

    # ---- Warm-socket liveness (audit §3.7) ---------------------------
    #
    # A socket that was opened minutes ago can be dead without anything
    # having raised: writes into a half-open TCP connection succeed, and
    # Deepgram never answers a KeepAlive, so the pool's pre-adoption
    # checks cannot prove liveness — only a message coming back can. The
    # clock starts at the first frame carrying actual speech; if nothing
    # has arrived by then, the socket is replaced and every byte already
    # written to it is replayed into the replacement.
    #
    # Armed only for an adopted socket: a connect that just completed its
    # handshake has proven the path end to end.
    warm_probe_active = acquisition.adopted
    # ``time.monotonic()`` of the first frame that carried speech — the
    # moment the socket owes an answer. ``None`` until then.
    warm_probe_armed_at: Optional[float] = None
    warm_swap_requested = False
    warm_swap_in_progress = False
    # Audio already written to the adopted socket, kept so a replacement
    # can be given it. A RING, not a growing buffer: a user who opens
    # the microphone and thinks for a minute streams a minute of silence
    # before the probe can even arm, and the bytes worth replaying are
    # the recent ones. What the ring drops off the front is counted, and
    # becomes the replacement session's ``audio_offset_sec`` so its
    # timestamps still land on the recording's timeline.
    warm_replay = bytearray()
    warm_replay_dropped = 0

    # ---- Send path: queue, sender task, wedge watchdog (audit §3.6) ---
    send_queue: "asyncio.Queue[object]" = asyncio.Queue(
        maxsize=_SEND_QUEUE_MAX_FRAMES
    )
    queued_bytes = 0
    # Capture time of the oldest byte that has not yet been handed to
    # Deepgram — the age the watchdog judges. ``None`` means everything
    # captured has been written.
    pending_since: Optional[float] = None
    send_dropped_warned = False

    def _offer_pcm(data: bytes) -> None:
        """Hand captured audio to the sender. Never awaits, never blocks.

        Dropping is the correct behaviour at the bound: the queue only
        fills when the upstream has stopped accepting writes, the audio
        is already in the recovery spool by the time this is called, and
        a blocking put here would put the renderer's socket right back
        behind Deepgram — the thing this queue exists to prevent. Every
        dropped byte is declared to the session so coverage math still
        sees the honest length of the recording.
        """
        nonlocal queued_bytes, send_dropped_warned, warm_probe_armed_at
        if not data:
            return
        if (
            warm_probe_active
            and warm_probe_armed_at is None
            and pcm_has_voice(data)
        ):
            warm_probe_armed_at = time.monotonic()
        if queued_bytes + len(data) > _SEND_QUEUE_MAX_BYTES:
            dropped = True
        else:
            try:
                send_queue.put_nowait((time.monotonic(), data))
                queued_bytes += len(data)
                dropped = False
            except asyncio.QueueFull:
                dropped = True
        if not dropped:
            return
        session.note_undelivered_audio(len(data))
        if not send_dropped_warned:
            send_dropped_warned = True
            logger.warning(
                "deepgram send queue full (%d bytes queued); dropping audio "
                "— upstream is not accepting writes",
                queued_bytes,
            )

    async def _flush_frame(buf: bytearray, size: int) -> None:
        nonlocal pending_since, warm_replay_dropped
        frame = bytes(buf[:size])
        del buf[:size]
        if warm_probe_active:
            # Kept until the adopted socket has proven itself, so a
            # replacement can be handed the audio the dead one
            # swallowed. Oldest bytes fall off the front rather than
            # newest being refused: the probe fires 2.5 s after the
            # first VOICED frame, so the ring is always long enough to
            # hold every voiced byte, and what it drops is leading
            # silence — which the offset then accounts for exactly.
            warm_replay.extend(frame)
            if len(warm_replay) > _WARM_REPLAY_MAX_BYTES:
                excess = len(warm_replay) - _WARM_REPLAY_MAX_BYTES
                excess += excess % 2  # never split a 16-bit sample
                del warm_replay[:excess]
                warm_replay_dropped += excess
        # NOT wrapped in wait_for: cancelling a websockets send mid-frame
        # leaves the connection undefined. The watchdog closes the socket
        # instead, which makes this raise inside send_pcm's own handler.
        await session.send_pcm(frame)
        pending_since = time.monotonic() if buf else None

    async def _swap_warm_socket() -> None:
        """Replace a silent adopted socket and replay what it swallowed.

        Runs inside the sender, which is the only writer to the upstream
        socket — so the old session is never being written to while it
        is torn down, and the replayed bytes reach the new one before
        anything still sitting in the send queue. ``discard()`` keeps the
        teardown from reaching the renderer as a fatal error: the swap IS
        the recovery.

        The replacement is constructed with ``audio_offset_sec`` equal to
        the audio the replay ring dropped, so everything it reports —
        segments, interim words, coverage, ``coveredEndSec``,
        ``streamedSec`` — is measured from the start of the RECORDING
        and not from the start of this second socket.
        """
        nonlocal session, warm_probe_active
        nonlocal warm_swap_requested, warm_swap_in_progress
        warm_swap_requested = False
        warm_swap_in_progress = True
        old = session
        replay = bytes(warm_replay)
        offset_sec = warm_replay_dropped / float(LIVE_PCM_BYTES_PER_SEC)
        logger.warning(
            "deepgram-live: discarded warm socket after adoption reason=no "
            "results within %.1fs of the first voiced audio; reconnecting "
            "and replaying %d bytes (offset=%.2fs)",
            _WARM_PROBE_TIMEOUT_SEC,
            len(replay),
            offset_sec,
        )
        try:
            fresh = _new_live_session(
                api_key, dg_cfg, audio_offset_sec=offset_sec
            )
            await fresh.connect()
        except Exception as e:
            # The recording continues on the old socket. It is probably
            # dead, but keeping it can only do better than guaranteeing
            # failure, and the local recovery spool already holds every
            # byte for the REST fallback.
            logger.error(
                "deepgram-live: warm socket replacement failed, staying on "
                "the adopted socket: %s", e,
            )
            warm_probe_active = False
            warm_replay.clear()
            warm_swap_in_progress = False
            return
        if isinstance(session, DualLiveSession):
            # Only the PRIMARY is probed, so only the primary is
            # replaced; the second reading is still on its own socket
            # and still being fed.
            old = session.replace_primary(fresh)
        else:
            session = fresh
        await old.discard()
        warm_probe_active = False
        warm_replay.clear()
        for pos in range(0, len(replay), _SEND_BATCH_BYTES):
            await fresh.send_pcm(replay[pos:pos + _SEND_BATCH_BYTES])
        logger.info(
            "deepgram-live: warm socket replaced; %d bytes replayed into a "
            "fresh connection (connect=%sms)",
            len(replay),
            f"{fresh.stats.connect_ms:.0f}" if fresh.stats.connect_ms else "?",
        )
        warm_swap_in_progress = False

    async def warm_probe_watchdog() -> None:
        """Give an adopted socket 2.5 s to answer, then ask for a swap.

        An adopted socket has never carried audio, so nothing about it
        has been proven end to end: a half-open TCP connection accepts
        writes silently and Deepgram never answers a ``KeepAlive``. The
        only positive evidence is a message coming back, and the only
        moment one is owed is after audio that actually contains speech
        — Deepgram is entitled to answer silence with nothing.

        The swap itself is performed by the SENDER (the single writer to
        the upstream socket); this task only asks for it, so the
        replacement can never race a send in flight.
        """
        nonlocal warm_probe_active, warm_swap_requested
        while warm_probe_active:
            await asyncio.sleep(_WARM_PROBE_POLL_SEC)
            armed_at = warm_probe_armed_at
            if not warm_probe_active or armed_at is None:
                continue
            last_recv = session.stats.last_recv_at
            if last_recv is not None and last_recv >= armed_at:
                warm_probe_active = False
                warm_replay.clear()
                logger.info(
                    "deepgram-live: adopted warm socket answered %.0fms "
                    "after the first voiced audio",
                    (last_recv - armed_at) * 1000.0,
                )
                return
            if time.monotonic() - armed_at >= _WARM_PROBE_TIMEOUT_SEC:
                warm_swap_requested = True
                return

    async def sender() -> None:
        """Own the upstream socket: batch queued audio, write it, stop
        at the finalize sentinel."""
        nonlocal queued_bytes, pending_since
        buf = bytearray()
        try:
            while True:
                if warm_swap_requested:
                    await _swap_warm_socket()
                try:
                    item = await asyncio.wait_for(
                        send_queue.get(), timeout=_SEND_BATCH_MAX_WAIT_SEC
                    )
                except asyncio.TimeoutError:
                    # Trailing edge of speech: send the partial batch
                    # rather than hold it for audio that isn't coming.
                    if buf:
                        await _flush_frame(buf, len(buf))
                    continue
                if item is _SEND_FINALIZE_SENTINEL:
                    if buf:
                        await _flush_frame(buf, len(buf))
                    pending_since = None
                    return
                enqueued_at, data = item  # type: ignore[misc]
                queued_bytes -= len(data)
                if pending_since is None:
                    pending_since = enqueued_at
                buf.extend(data)
                while len(buf) >= _SEND_BATCH_BYTES:
                    await _flush_frame(buf, _SEND_BATCH_BYTES)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error("deepgram sender failed: %s", e, exc_info=True)

    async def send_watchdog() -> None:
        """Declare the upstream wedged from the age of unsent audio."""
        nonlocal upstream_fatal
        while True:
            await asyncio.sleep(_SEND_WEDGE_POLL_SEC)
            if warm_swap_in_progress:
                # The upstream is being replaced on purpose. Audio waits
                # in the queue for the length of one connect, which is
                # not evidence of a wedge — and declaring one here would
                # kill the recording the swap is rescuing.
                continue
            since = pending_since
            if since is None:
                continue
            age = time.monotonic() - since
            if age < _SEND_WEDGE_TIMEOUT_SEC:
                continue
            logger.error(
                "deepgram upstream wedged: audio captured %.1fs ago has not "
                "been accepted (%d bytes queued); closing the stream",
                age,
                queued_bytes,
            )
            # Reported through the session so ``events()``, ``last_error``
            # and the final envelope all tell the same story.
            session.report_fatal(
                f"Deepgram upstream wedged: audio queued {age:.1f}s ago was "
                "never accepted"
            )
            upstream_fatal = True
            stop.set()
            try:
                # Closing is what unblocks the pending write — the write
                # itself is never cancelled. Bounded because this is the
                # one path where the socket is known to be sick.
                await asyncio.wait_for(session.close(), timeout=3.0)
            except (asyncio.TimeoutError, Exception) as e:
                logger.warning("deepgram wedge close failed: %s", e)
            return

    snd = asyncio.create_task(sender(), name="ws-dg-send")
    wd = asyncio.create_task(send_watchdog(), name="ws-dg-send-watchdog")
    # Only an ADOPTED socket needs proving: a connect that just
    # completed its handshake has already demonstrated the path.
    warm_probe: Optional[asyncio.Task] = (
        asyncio.create_task(warm_probe_watchdog(), name="ws-dg-warm-probe")
        if warm_probe_active
        else None
    )

    # Replay everything captured while connecting, IN ORDER, before any
    # newly arriving frame is forwarded — Deepgram must see this audio
    # first or the transcript's word timings would be shifted. The queue
    # is FIFO, so enqueueing here preserves that order by construction.
    for _chunk in pending_frames:
        _offer_pcm(_chunk)
    pending_frames.clear()

    if preconnect_disconnected:
        stop.set()

    async def _drain_finalize_tail(payload: dict) -> None:
        """C1/C2: drain in-flight binary frames on ``finalize``.

        The frontend stops the microphone BEFORE sending ``finalize``,
        so on a healthy connection there should be no more bytes in
        flight — but the wire still has in-transit frames, and if we
        returned immediately any bytes that arrived AFTER the finalize
        text frame but BEFORE we drained the receive buffer would be
        silently dropped.

        ``payload`` may carry ``framesSent``/``bytesSent`` — the exact
        count of binary frames/bytes the renderer sent on this
        connection (C1). When both are present, the drain stops the
        moment ``frames_received``/``bytes_received`` reach them instead
        of always spending the full ceiling — which used to run to
        completion on EVERY stop, because the mic is already stopped and
        nothing more is coming. An older renderer that omits the counts
        gets the previous unconditional timed drain, unchanged.
        """
        nonlocal frames_received, bytes_received
        target_frames = payload.get("framesSent")
        target_bytes = payload.get("bytesSent")
        has_counts = isinstance(target_frames, int) and isinstance(target_bytes, int)

        def _matched() -> bool:
            return (
                has_counts
                and frames_received >= target_frames
                and bytes_received >= target_bytes
            )

        drain_start = time.monotonic()
        drain_deadline = drain_start + _FINALIZE_DRAIN_CEILING_SEC
        while time.monotonic() < drain_deadline and not _matched():
            try:
                tail_msg = await asyncio.wait_for(
                    _ws_recv_next(websocket),
                    timeout=max(0.0, drain_deadline - time.monotonic()),
                )
            except asyncio.TimeoutError:
                break
            tail_kind = tail_msg["kind"]
            if tail_kind == "bytes":
                tail_data = tail_msg["data"]
                frames_received += 1
                bytes_received += len(tail_data)
                if session.is_closed:
                    _record_recovery_chunk(recovery, tail_data)
                    continue
                _record_recovery_chunk(recovery, tail_data)
                _offer_pcm(tail_data)
                continue
            if tail_kind == "disconnect":
                break
            # Any non-bytes non-disconnect frame (stray control msg,
            # text, etc.) ends the drain.
            break
        elapsed_ms = (time.monotonic() - drain_start) * 1000.0
        if has_counts:
            logger.info(
                "finalize drain: %s after %.0f ms (frames %d/%d)",
                "matched" if _matched() else "timed out",
                elapsed_ms,
                frames_received,
                target_frames,
            )
        else:
            logger.info(
                "finalize drain: timed out after %.0f ms (no counts; frames=%d)",
                elapsed_ms,
                frames_received,
            )

    async def receiver() -> None:
        nonlocal frames_received, bytes_received
        try:
            if preconnect_finalize_payload is not None:
                # Stop was pressed before connect() even resolved (rare)
                # — the finalize control frame was consumed by the
                # preconnect reader, so replay it through the same drain
                # path a normally-timed finalize takes.
                await _drain_finalize_tail(preconnect_finalize_payload)
                stop.set()
                return
            while not stop.is_set():
                msg = await _ws_recv_next(websocket)
                kind = msg["kind"]
                if kind == "disconnect":
                    stop.set()
                    return
                if kind == "bytes":
                    data = msg["data"]
                    frames_received += 1
                    bytes_received += len(data)
                    if session.is_closed:
                        # Upstream already died; keep recording the
                        # PCM locally so the REST fallback has the full
                        # audio but don't waste cycles pushing it.
                        _record_recovery_chunk(recovery, data)
                        continue
                    _record_recovery_chunk(recovery, data)
                    # Hand off and go straight back to reading the
                    # renderer's socket — the whole point of the queue.
                    _offer_pcm(data)
                    continue
                if kind == "control":
                    if msg["payload"].get("type") == "finalize":
                        await _drain_finalize_tail(msg["payload"])
                        stop.set()
                        return
        except Exception as e:
            if _is_broken_pipe_error(e):
                logger.warning("ws deepgram receiver broken pipe: %s", e)
            else:
                _mark_recovery_error(recovery)
                logger.error("ws deepgram receiver error: %s", e, exc_info=True)
            stop.set()

    async def forwarder() -> None:
        """Pump upstream events to the renderer, across a socket swap.

        The event stream belongs to a SESSION, and the warm-socket
        liveness path replaces the session mid-recording. Iterating one
        stream and returning when it ends would make the swap look like
        the upstream ending: this task completing is what the join below
        reads as "the session is over", so a recovery would have killed
        the recording it was recovering. The outer loop follows the
        recording onto its replacement instead, and still returns the
        moment a stream ends without one.
        """
        nonlocal upstream_fatal
        try:
            while True:
                current = session
                async for event in current.events():
                    if not await _ws_send_json(websocket, event):
                        stop.set()
                        return
                    if event.get("type") == "error":
                        _mark_recovery_error(recovery)
                        if event.get("fatal"):
                            upstream_fatal = True
                            stop.set()
                            return
                if session is current or stop.is_set():
                    return
        except Exception as e:
            if not _is_broken_pipe_error(e):
                _mark_recovery_error(recovery)
                logger.error("ws deepgram forwarder error: %s", e, exc_info=True)
            stop.set()

    rx = asyncio.create_task(receiver(), name="ws-dg-rx")
    fw = asyncio.create_task(forwarder(), name="ws-dg-fw")
    try:
        done, _pending = await asyncio.wait({rx, fw}, return_when=asyncio.FIRST_COMPLETED)
        if fw in done and not rx.done() and session.is_closed and not session.last_fatal:
            # Deepgram can close the upstream WS before the user presses Stop,
            # especially on long idle/unstable links. Keep consuming client PCM
            # until finalize/disconnect so REST/local recovery has the complete
            # audio instead of only the prefix sent before upstream closed.
            _mark_recovery_error(recovery)
            await rx
    finally:
        stop.set()
        await cancel_and_await(rx, what="deepgram websocket receiver", log=logger)

        # Finalize must reach Deepgram AFTER every byte the renderer
        # sent (audit §3.6). The receiver has now stopped, so everything
        # it captured is already in the queue; the sentinel goes in
        # behind it and the sender returns only once it has been
        # reached, which makes the ordering a property of the queue
        # rather than of a timer.
        try:
            send_queue.put_nowait(_SEND_FINALIZE_SENTINEL)
        except asyncio.QueueFull:
            # Only reachable with a wedged upstream and a full queue;
            # the audio behind the bound is already accounted for as
            # undelivered, and the sender is cancelled below.
            logger.warning("deepgram send queue full at finalize; sentinel dropped")
        # A swap OWNS the session object: it connects a replacement,
        # rebinds ``session`` and then ``discard()``s the old one — the
        # very socket ``drain_transcript`` is about to send ``Finalize``
        # on. ``_swap_warm_socket``'s docstring calls the sender "the
        # only writer to the upstream socket", and that stops being true
        # the moment the wait below gives up on the sender. So the
        # request is withdrawn FIRST (the watchdog used to be cancelled
        # after this wait, which is too late to prevent one starting),
        # and a swap already running is given the connect budget it can
        # legitimately need before the stop proceeds without it.
        await cancel_and_await(warm_probe, what="deepgram warm probe", log=logger)
        warm_swap_requested = False
        send_flush_deadline = _SEND_FLUSH_DEADLINE_SEC + (
            _WARM_SWAP_GRACE_SEC if warm_swap_in_progress else 0.0
        )
        # Deliberately not ``wait_for``: that cancels the task, and the
        # task may be inside ``ws.send``.
        _done, _still = await asyncio.wait({snd}, timeout=send_flush_deadline)
        if _still:
            logger.warning(
                "deepgram send queue did not drain within %.1fs "
                "(%d bytes still queued); finalizing anyway",
                send_flush_deadline,
                queued_bytes,
            )
        if warm_swap_in_progress:
            # The replacement is still being connected. Whatever
            # ``session`` names now is what the drain runs on, and the
            # swap may still discard it under the drain — say so, rather
            # than reporting a lost transcript as an unexplained one.
            logger.error(
                "deepgram warm-socket swap still running at finalize after "
                "%.1fs; the drain may lose the socket under it",
                send_flush_deadline,
            )
        await cancel_and_await(wd, what="deepgram stop watchdog", log=logger)

        final_payload: dict
        finalize_error: Optional[str] = None

        # The stop's deadline is decided once, by the coverage analysis
        # inside drain_transcript(), and told to the client before the
        # waiting starts. The renderer used to guess it with a constant
        # while this side could legitimately spend nine seconds; a
        # quarter of stops exceeded that constant, and everything the
        # extra wait recovered arrived after the transcript had already
        # been delivered. One number, produced where it is decided.
        #
        # That number must now bound the REST recovery too, because the
        # envelope is sent AFTER it. The drain's own budget and the
        # recovery's are tracked separately so the extension announcement
        # below can replace one without re-deriving the other.
        announced_drain_sec = 0.0
        announced_recovery_sec = 0.0

        def _announce_budget(budget_sec: float, expects_more: bool) -> None:
            nonlocal announced_drain_sec, announced_recovery_sec
            announced_drain_sec = budget_sec
            announced_recovery_sec = _predicted_recovery_budget_sec(
                session, _recovery_spool_seconds(recovery)
            )
            _send_finalizing(
                announced_drain_sec + announced_recovery_sec,
                expects_more or announced_recovery_sec > 0.0,
            )

        def _announce_recovery_extension(budget_sec: float) -> None:
            """A second announcement, when the drain changed the answer.

            The prediction above is made before the post-Finalize flush
            lands, so a hole that only becomes visible once the flush is
            in (or a socket that dies during it) can need more time than
            was announced. The renderer's deadline is re-armable and is
            always measured from the start of ITS wait, so the honest
            second number is the whole stop's bound, not the remainder.
            """
            nonlocal announced_recovery_sec
            announced_recovery_sec = budget_sec
            _send_finalizing(announced_drain_sec + budget_sec, True)

        try:
            # C4: drain_transcript() produces the transcript and returns —
            # it does NOT touch CloseStream, the recv drain, or close().
            # Those are shutdown()'s job, run AFTER the envelope below is
            # already on the wire, so the socket teardown (median 270 ms,
            # observed up to 5 s waiting for Deepgram to close) no longer
            # sits between the user and their transcript.
            drained = await session.drain_transcript(on_budget=_announce_budget)
            # ``drain_transcript`` and ``partial_result`` return the same
            # dict (C6), so both stop shapes reach the wire through one
            # adapter. Field meanings live with the constructor
            # (``backend.live_envelope``) rather than being restated at
            # each call site in a slightly different subset.
            final_payload = envelope_from_result(
                drained, source=DEEPGRAM_LIVE_SOURCE
            )
        except Exception as e:
            # ``str(e)`` can carry the upstream provider's raw error body
            # (Deepgram disconnect with "WebSocket: HTTP 401 Unauthorized
            # — token=tok_AbC...") which leaks the API token prefix or
            # absolute paths in the renderer payload. Route through
            # ``_safe_error_text`` which strips paths + token-shaped
            # substrings, matching every other error envelope on this
            # endpoint.
            finalize_error = _safe_error_text(e)
            _mark_recovery_error(recovery)
            logger.error("deepgram finalize failed: %s", e, exc_info=True)
            # ``partial_result()``, not ``final_text()`` with an empty
            # segment list: this envelope is now the input to the
            # recovery pass, which needs to know what ground IS covered
            # in order to ask for the rest — and a payload whose text and
            # segments describe different transcripts is the C6 defect
            # (audit §3.8) on the error path.
            try:
                partial = session.partial_result()
            except Exception as snapshot_error:
                # This is already the failure path; a snapshot that also
                # fails must not replace the error the user is owed with
                # a second one.
                logger.warning(
                    "deepgram partial snapshot failed: %s", snapshot_error
                )
                partial = {}
            final_payload = envelope_from_result(
                partial, source=DEEPGRAM_LIVE_SOURCE, error=finalize_error
            )

        if upstream_fatal and session.last_error:
            final_payload["error"] = _safe_error_text(session.last_error)

        # The envelope is complete BY CONSTRUCTION or it is not complete
        # at all: whatever the live reading (or the dual merge) still
        # fails to cover is re-decoded from this backend's own audio
        # spool and spliced in by time, HERE, before the envelope is
        # sent. The renderer has no second reading to fall back on any
        # more, which is the point — two owners of one transcript is
        # what produced every duplication defect of 2026-09-03/04.
        final_payload = await _apply_live_recovery(
            payload=final_payload,
            session=session,
            recovery=recovery,
            cfg=dg_cfg,
            api_key=api_key,
            announce=_announce_recovery_extension,
            announced_recovery_sec=announced_recovery_sec,
        )

        # Envelope out FIRST (C4) — everything below is teardown the
        # client no longer waits on.
        await _ws_send_json(websocket, final_payload)

        try:
            await session.shutdown(wait_timeout=3.0)
        except Exception as e:
            # The envelope is already delivered; a teardown failure here
            # cannot un-deliver it, only leak the socket if it goes
            # unnoticed. Log and move on — close() below is the backstop.
            logger.error(
                "deepgram shutdown failed (envelope already sent): %s",
                e, exc_info=True,
            )
        # Idempotent backstop: shutdown() calls close() on every path it
        # takes, but if shutdown() itself raised before reaching it (see
        # above), this guarantees the socket and background tasks are
        # still released.
        await session.close()

        # Open the next warm socket now, with the configuration this
        # recording actually used — the strongest available guess at
        # what the next one will use, and the moment with the most time
        # before it (a user reads the transcript they just dictated
        # before starting another). Fire-and-forget by contract: a
        # failed pre-warm must never be visible on the path of the
        # recording that triggered it.
        DEEPGRAM_WARM_POOL.rewarm(api_key, dg_cfg)
        if dual_language:
            DEEPGRAM_WARM_POOL.rewarm(
                api_key, secondary_config(dg_cfg, dual_language)
            )

        # The sender only outlives the drain when the upstream never
        # took the last frame. The socket is closed by now, so the
        # pending write has already raised inside ``send_pcm`` and this
        # cancel cannot land mid-frame.
        await cancel_and_await(snd, what="deepgram sender", log=logger)

        if not fw.done():
            try:
                await asyncio.wait_for(fw, timeout=0.25)
            except asyncio.TimeoutError:
                await cancel_and_await(
                    fw, what="deepgram event forwarder", log=logger
                )

        # The number the ENVELOPE carries, not a second computation of
        # it. ``DeepgramLiveSession._streamed_seconds`` is the one
        # conversion — it is also the only one that applies
        # ``audio_offset_sec``, so recomputing it here from
        # ``bytes_sent`` logged every socket-swapped recording as having
        # streamed less than it did, and logged a different number from
        # the one the renderer was sent (B-010).
        streamed_sec = float(final_payload.get("streamedSec") or 0.0)
        logger.info(
            "ws deepgram session complete: bytes=%d streamed_sec=%.1f chunks=%d "
            "final_segs=%d interim_segs=%d connect_ms=%s finalize_ms=%s text_len=%d",
            session.stats.bytes_sent,
            streamed_sec,
            session.stats.chunks_sent,
            session.stats.segments_final,
            session.stats.segments_interim,
            f"{session.stats.connect_ms:.0f}" if session.stats.connect_ms else "?",
            f"{session.stats.finalize_ms:.0f}" if session.stats.finalize_ms else "?",
            len(final_payload.get("text") or ""),
        )
        # A session that streamed real audio and produced no final segment
        # is a silently lost transcription: the recording exists, the user
        # spoke into it, and the live path returned nothing. The renderer
        # then falls back to the REST endpoint, so the user usually still
        # gets their text — but the live path having failed is invisible
        # in the log unless we say so, and it was: measured at 29 of 706
        # sessions (4.1 %), 21 of them with more than 2 s of audio, none
        # of which left any trace above INFO.
        #
        # Logged at WARNING so it stands out from the per-session INFO
        # summary, and carries the two facts that separate the causes:
        # ``interim_segs=0`` means Deepgram never recognised anything at
        # all (dead microphone input, wrong language, upstream refusal),
        # while interims without finals means recognition worked and only
        # the flush failed.
        if (
            session.stats.segments_final == 0
            and streamed_sec >= LIVE_EMPTY_RESULT_MIN_SEC
        ):
            logger.warning(
                "ws deepgram produced NO final segments for %.1fs of audio "
                "(interim_segs=%d connect_ms=%s finalize_ms=%s error=%s) — "
                "renderer will fall back to REST",
                streamed_sec,
                session.stats.segments_interim,
                f"{session.stats.connect_ms:.0f}" if session.stats.connect_ms else "?",
                f"{session.stats.finalize_ms:.0f}" if session.stats.finalize_ms else "?",
                _safe_error_text(session.last_error) if session.last_error else "none",
            )


@app.get("/api/live/warm")
def get_live_warm_state(_auth: None = Depends(_require_api_auth)):
    """What the Deepgram warm socket is doing right now.

    Diagnostic, not control: there is no way to force a warm socket
    open or closed from here, because the two moments worth warming at
    (backend boot and the end of a recording) are the two the backend
    already knows about, and a third trigger would be a second source
    of truth for the same decision.

    Answers the questions a stop-latency investigation actually asks —
    is a socket warm, how old is it, would it be adopted right now and
    if not why not — without exposing anything about the key or the
    audio. The configuration key is the query string the socket was
    opened with, which is what makes a mismatch legible.
    """
    return {"ok": True, "warm": DEEPGRAM_WARM_POOL.status()}


@app.get("/api/live/recoveries")
def list_live_recoveries(_auth: None = Depends(_require_api_auth)):
    _cleanup_live_recovery_files()
    return {"items": _list_live_recoveries()}


@app.get("/api/models/local")
def api_models_local(_auth: None = Depends(_require_api_auth)):
    return {"ok": True, "models": list_local_models()}


@app.post("/api/models/local/{model_id}/download")
def api_model_download(
    model_id: str,
    _auth: None = Depends(_require_api_auth),
):
    try:
        result = start_download(model_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown local model {model_id}")
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "model_id": model_id, **result}


@app.delete("/api/models/local/{model_id}")
def api_model_delete(
    model_id: str,
    _auth: None = Depends(_require_api_auth),
):
    """Remove a downloaded local model's weights from disk.

    The inverse of the download route, and the only way the user can
    reclaim the multi-gigabyte cache a model leaves behind without
    hunting through ~/.cache/huggingface by hand.
    """
    try:
        result = delete_model(model_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown local model {model_id}")
    except ModelDeleteError as e:
        # 409: the request is well-formed but the resource is not in a
        # state that allows deletion (download in flight, engine-managed
        # model). The message is written to be shown to the user as-is.
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "model_id": model_id, **result}


@app.post("/api/live/recoveries/{session_id}/discard")
def discard_live_recovery(session_id: str, _auth: None = Depends(_require_api_auth)):
    deleted = _safe_delete_live_recovery(session_id)
    return {"ok": True, "deleted": deleted}


@app.post("/api/live/recoveries/{session_id}/promote")
async def promote_live_recovery(
    session_id: str,
    payload: dict = Body(default_factory=dict),
    _auth: None = Depends(_require_api_auth),
):
    # Async + offload: ``_promote_live_recovery`` streams the spool
    # through ``write_wav_from_pcm16_stream`` and writes a WAV —
    # multi-second blocking I/O either way. A sync def pinned an
    # executor thread for the whole run and serialised concurrent
    # promotions; on the threadpool the event loop stays free to keep
    # WS frames flowing. (This comment used to describe a whole-file
    # numpy conversion and a 500 MB cap; both are gone, and the real
    # ceiling is ``MAX_RECOVERY_PROMOTE_BYTES``.)
    archive_dir = str((payload or {}).get("archive_dir") or "").strip()
    recording_collection = str((payload or {}).get("recording_collection") or "live").strip()
    result = await asyncio.to_thread(
        _promote_live_recovery,
        session_id,
        archive_dir,
        recording_collection,
    )
    return {"ok": True, **result}


@app.post("/api/jobs")
async def create_job(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    language: str = Form("auto"),
    model: str = Form(DEFAULT_LOCAL_TRANSCRIPTION_MODEL),
    split_stereo: bool = Form(True),
    word_timestamps: bool = Form(False),
):
    _cleanup_expired_files()
    language = _form_text(language, "auto")
    model = _form_text(model, DEFAULT_LOCAL_TRANSCRIPTION_MODEL)
    split_stereo = _form_bool(split_stereo, True)
    word_timestamps = _form_bool(word_timestamps, False)
    if model not in ALLOWED_LOCAL_MODELS:
        raise HTTPException(status_code=400, detail="unsupported model")
    lang_opt = _normalize_language(language)

    orig_name = _normalize_filename(file.filename or "audio.wav")
    _validate_audio_filename(orig_name)
    job_id = str(uuid.uuid4())
    upload_path = _upload_snapshot_path(job_id, orig_name)
    await _save_upload_file(file, upload_path)

    jobs.create(job_id)
    _submit_local_transcription_job(
        job_id=job_id,
        upload_path=upload_path,
        model=model,
        language=lang_opt,
        split_stereo=split_stereo,
        word_timestamps=word_timestamps,
        cleanup_upload_path=True,
    )
    return {"job_id": job_id}


@app.post("/api/jobs/from-path")
async def create_job_from_path(
    payload: dict = Body(...),
    _auth: None = Depends(_require_api_auth),
):
    _cleanup_expired_files()
    model = str((payload or {}).get("model") or DEFAULT_LOCAL_TRANSCRIPTION_MODEL).strip()
    if model not in ALLOWED_LOCAL_MODELS:
        raise HTTPException(status_code=400, detail="unsupported model")

    source_path = await asyncio.to_thread(
        _resolve_source_media_path,
        (payload or {}).get("source_path") or (payload or {}).get("path"),
    )
    lang_opt = _normalize_language(str((payload or {}).get("language") or "auto"))
    split_stereo = _payload_bool(payload, "split_stereo", True)
    word_timestamps = _payload_bool(payload, "word_timestamps", False)

    job_id = str(uuid.uuid4())
    upload_path = await asyncio.to_thread(_snapshot_source_media_for_job, source_path, job_id)
    jobs.create(job_id)
    _submit_local_transcription_job(
        job_id=job_id,
        upload_path=upload_path,
        model=model,
        language=lang_opt,
        split_stereo=split_stereo,
        word_timestamps=word_timestamps,
        cleanup_upload_path=False,
    )
    return {"job_id": job_id, "audio_source_path": str(upload_path)}


@app.post("/api/transcribe-sync")
async def transcribe_sync(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    language: str = Form("auto"),
    model: str = Form(DEFAULT_LOCAL_TRANSCRIPTION_MODEL),
    split_stereo: bool = Form(True),
    word_timestamps: bool = Form(False),
):
    language = _form_text(language, "auto")
    model = _form_text(model, DEFAULT_LOCAL_TRANSCRIPTION_MODEL)
    split_stereo = _form_bool(split_stereo, True)
    word_timestamps = _form_bool(word_timestamps, False)
    if model not in ALLOWED_LOCAL_MODELS:
        raise HTTPException(status_code=400, detail="unsupported model")
    lang_opt = _normalize_language(language)

    request_id = str(uuid.uuid4())
    orig_name = _normalize_filename(file.filename or "audio.wav")
    _validate_audio_filename(orig_name)
    upload_path = _upload_snapshot_path(request_id, orig_name)
    await _save_upload_file(file, upload_path)
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: _run_local_transcribe_once(
                run_id=request_id,
                upload_path=upload_path,
                model=model,
                language=lang_opt,
                split_stereo=split_stereo,
                word_timestamps=word_timestamps,
            ),
        )
        return {"ok": True, "result": result}
    except AudioError as e:
        raise HTTPException(status_code=400, detail=_safe_error_text(e))
    except Exception as e:
        # Log the full trace locally; redact the response so the
        # HTTP body never carries absolute paths or ffmpeg stderr.
        logger.exception("transcribe_sync failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {_safe_error_text(e)}")
    finally:
        try:
            os.remove(upload_path)
        except OSError as e:
            logger.debug("sync upload cleanup skipped for %s: %s", upload_path, e)


def _run_remote_transcribe_once(
    *,
    provider_norm: str,
    upload_path: Optional[Path] = None,
    audio_bytes: Optional[bytes] = None,
    orig_name: str,
    language: Optional[str],
    diarize: bool,
    num_speakers: str,
    remote_model: str = "",
    openrouter_model: str = "",
    cfg: Optional[dict] = None,
    cancel_event: Optional[threading.Event] = None,
    progress_cb: Optional[Callable[[float], None]] = None,
) -> dict[str, Any]:
    def _remote_result_duration_sec(result: dict[str, Any]) -> float:
        """Seconds of audio the provider says it decoded.

        Read off the ADAPTER's ``duration`` key. This used to dig into
        ``raw["metadata"]["duration"]`` — Deepgram's payload shape —
        and was applied to the OpenRouter result too, where no such key
        exists, so every OpenRouter transcription reported zero.
        """
        try:
            return max(0.0, float(result.get("duration") or 0.0))
        except (TypeError, ValueError):
            return 0.0

    def _raise_if_cancelled() -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise JobCancelledError("job cancelled")

    def _set_progress(value: float) -> None:
        if progress_cb is None:
            return
        try:
            progress_cb(value)
        except JobCancelledError:
            raise
        except Exception as e:
            logger.debug("remote progress callback raised: %s", e)

    _raise_if_cancelled()
    if cfg is None:
        cfg = load_config()
    # Defensive `or {}` — `cfg.get("preferences", {})` returns None when
    # the key IS present with a null value (hand-edited config.json).
    # The rest of the module uses the `or {}` pattern; mirror it here
    # so a ``"preferences": null`` config doesn't crash with AttributeError.
    prov = (
        provider_norm
        or ((cfg.get("preferences") or {}).get("remote_provider"))
        or DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER
    ).strip()
    explicit_model = _first_nonempty_text(remote_model, openrouter_model)

    _raise_if_cancelled()
    if prov == "openrouter":
        or_key = ((cfg.get("providers") or {}).get("openrouter") or {}).get("key") or ""
        pref = (cfg.get("preferences") or {}).get("openrouter") or {}
        model = (
            explicit_model or pref.get("model") or DEFAULT_OPENROUTER_AUDIO_MODEL
        ).strip()

        def _provider_call(payload: bytes, filename: str) -> dict[str, Any]:
            out = openrouter_transcribe(
                api_key=or_key,
                model=model,
                audio_bytes=payload,
                filename=filename,
            )
            return {
                "provider": "openrouter",
                "model": model,
                "text": (out.get("text") or "").strip(),
                "duration": _remote_result_duration_sec(out),
                "raw": out.get("raw"),
            }

    elif prov == "deepgram":
        dg_key = ((cfg.get("providers") or {}).get("deepgram") or {}).get("key") or ""
        model = (explicit_model or DEFAULT_DEEPGRAM_AUDIO_MODEL).strip()
        dg_keyterms = configured_keyterms(cfg)

        def _provider_call(payload: bytes, filename: str) -> dict[str, Any]:
            out = deepgram_transcribe(
                api_key=dg_key,
                audio_bytes=payload,
                filename=filename,
                model=model,
                language=language,
                diarize=bool(diarize),
                num_speakers=num_speakers,
                keyterms=dg_keyterms,
            )
            return {
                "provider": "deepgram",
                "model": model,
                "text": (out.get("text") or "").strip(),
                "duration": _remote_result_duration_sec(out),
                "raw": out.get("raw"),
            }

    else:
        # Bad input → ValueError (translates to HTTP 400 at the endpoints).
        # Bare Exception would have been caught by the generic "Remote
        # transcription failed" branch and surfaced as 500, misleading
        # the client into retrying an unrecoverable validation error.
        raise ValueError(f"Unknown provider: {prov!r}")

    if audio_bytes is None and upload_path is None:
        raise ValueError("audio input is required")

    _raise_if_cancelled()
    with tempfile.TemporaryDirectory(prefix="transcribe_remote_") as _td:
        work_dir = Path(_td)
        orig_ext = orig_name.rsplit(".", 1)[-1].lower() if "." in orig_name else ""
        source_path = upload_path
        source_size = 0
        if source_path is not None:
            try:
                source_size = source_path.stat().st_size
            except OSError:
                source_size = 0
        else:
            source_size = len(audio_bytes or b"")
            source_path = work_dir / f"src.{orig_ext or 'bin'}"
            source_path.write_bytes(audio_bytes or b"")

        chunks_dir = work_dir / "chunks"
        stem = orig_name.rsplit(".", 1)[0] if "." in orig_name else orig_name
        try:
            _set_progress(0.18)
            chunk_paths = compact_audio_chunks_for_remote(
                str(source_path),
                str(chunks_dir),
                chunk_sec=REMOTE_TRANSCRIBE_CHUNK_SEC,
                cancel_event=cancel_event,
            )
            _raise_if_cancelled()
            _set_progress(0.30)
        except AudioError as e:
            err_text = str(e).lower()
            native_exts = {"wav", "mp3", "m4a", "mp4", "aac"}
            if "ffmpeg is not installed" not in err_text:
                raise RemoteError(f"audio compression failed: {e}") from e
            if orig_ext not in native_exts or source_size > REMOTE_RAW_FALLBACK_MAX_BYTES:
                raise RemoteError(
                    "ffmpeg is required for reliable remote transcription of "
                    f".{orig_ext or 'unknown'} files over "
                    f"{REMOTE_RAW_FALLBACK_MAX_BYTES // (1024 * 1024)} MB; "
                    "install ffmpeg and retry, or switch Provider to local."
                ) from e
            logger.warning(
                "ffmpeg missing — sending small raw audio body "
                "(%d bytes, ext=%s) without compression",
                source_size,
                orig_ext,
            )
            payload = audio_bytes if audio_bytes is not None else source_path.read_bytes()
            result = _provider_call(payload or b"", orig_name)
            _raise_if_cancelled()
            _set_progress(0.92)
            return result

        total_chunk_bytes = 0
        chunk_sizes: list[int] = []
        for p in chunk_paths:
            try:
                size = os.path.getsize(p)
            except OSError:
                size = 0
            total_chunk_bytes += size
            chunk_sizes.append(size)
        logger.info(
            "remote_transcribe: provider=%s model=%s source_bytes=%d chunks=%d "
            "chunk_sec=%d compact_bytes=%d max_chunk_bytes=%d",
            prov,
            model,
            source_size,
            len(chunk_paths),
            REMOTE_TRANSCRIBE_CHUNK_SEC,
            total_chunk_bytes,
            max(chunk_sizes or [0]),
        )

        if len(chunk_paths) == 1:
            payload = Path(chunk_paths[0]).read_bytes()
            result = _provider_call(payload, f"{stem}.webm")
            _raise_if_cancelled()
            _set_progress(0.92)
            return result

        text_parts: list[str] = []
        raw_chunks: list[dict[str, Any]] = []
        total_duration_sec = 0.0
        for idx, chunk_path in enumerate(chunk_paths):
            _raise_if_cancelled()
            payload = Path(chunk_path).read_bytes()
            chunk_name = f"{stem}.part{idx + 1:04d}.webm"
            logger.info(
                "remote_transcribe: chunk %d/%d provider=%s bytes=%d",
                idx + 1,
                len(chunk_paths),
                prov,
                len(payload),
            )
            result = _provider_call(payload, chunk_name)
            _raise_if_cancelled()
            text = (result.get("text") or "").strip()
            if text:
                text_parts.append(text)
            chunk_duration_sec = max(0.0, float(result.get("duration") or 0.0))
            total_duration_sec += chunk_duration_sec
            raw_chunks.append(
                {
                    "index": idx,
                    "filename": chunk_name,
                    "bytes": len(payload),
                    "duration": chunk_duration_sec,
                    "raw": result.get("raw"),
                }
            )
            _set_progress(0.30 + ((idx + 1) / max(1, len(chunk_paths))) * 0.62)

        return {
            "provider": prov,
            "model": model,
            "text": "\n\n".join(text_parts).strip(),
            "duration": total_duration_sec,
            "raw": {
                "chunked": True,
                "chunk_seconds": REMOTE_TRANSCRIBE_CHUNK_SEC,
                "source_bytes": source_size,
                "compact_bytes": total_chunk_bytes,
                "chunks": raw_chunks,
            },
        }


def _submit_remote_transcription_job(
    *,
    job_id: str,
    provider_norm: str,
    upload_path: Path,
    orig_name: str,
    language: Optional[str],
    diarize: bool,
    num_speakers: str,
    remote_model: str,
    cleanup_upload_path: bool,
) -> None:
    cancel_event = jobs.cancel_event(job_id)

    def run():
        def _check_cancelled() -> None:
            if jobs.is_cancelled(job_id):
                raise JobCancelledError("job cancelled")

        try:
            _check_cancelled()
            jobs.set_running(job_id)
            jobs.set_progress(job_id, 0.05)
            _check_cancelled()
            jobs.set_progress(job_id, 0.15)
            def _on_remote_progress(value: float) -> None:
                jobs.raise_if_cancelled(job_id)
                jobs.set_progress(job_id, value)

            result = _run_remote_transcribe_once(
                provider_norm=provider_norm,
                upload_path=upload_path,
                orig_name=orig_name,
                language=language,
                diarize=diarize,
                num_speakers=num_speakers,
                remote_model=remote_model,
                cancel_event=cancel_event,
                progress_cb=_on_remote_progress,
            )

            _check_cancelled()
            jobs.set_progress(job_id, 0.95)
            result_json_path = RESULTS_DIR / f"{job_id}.remote.json"
            result_txt_path = RESULTS_DIR / f"{job_id}.remote.txt"
            # SSOT atomic write (same rationale as local job result
            # above). Previously bare `write_text` left torn files
            # on SIGTERM — exactly the failure the lifespan drain
            # was designed to avoid.
            atomic_write_json(result_json_path, result)
            atomic_write_text(result_txt_path, result.get("text", ""))
            jobs.set_done(
                job_id,
                result,
                {
                    "json": str(result_json_path),
                    "txt": str(result_txt_path),
                },
            )
        except JobCancelledError:
            cancel_event.set()
            jobs.cancel(job_id)
        except ValueError as e:
            jobs.set_error(job_id, f"bad_request: {_safe_error_text(e)}")
        except RemoteError as e:
            # Catches BOTH provider-specific subclasses (OpenRouterError,
            # DeepgramRemoteError raised inside their respective modules)
            # AND the bare base RemoteError raised by http_retry.request_
            # with_retry on network-layer failures (DNS, TCP reset, TLS,
            # HTTP timeout). Listing only subclasses here would miss
            # network errors and surface them as opaque HTTP 500s.
            logger.warning(
                "remote transcription provider error (job_id=%s provider=%s): %s",
                job_id,
                provider_norm or "config-default",
                e,
            )
            jobs.set_error(job_id, _safe_error_text(e))
        except Exception as e:
            logger.exception("remote transcription job failed (job_id=%s)", job_id)
            jobs.set_error(job_id, f"Remote transcription failed: {_safe_error_text(e)}")
        finally:
            if cleanup_upload_path:
                try:
                    os.remove(upload_path)
                except OSError as e:
                    logger.debug("upload cleanup skipped for %s: %s", upload_path, e)

    jobs.submit(run)


@app.post("/api/remote/jobs")
async def create_remote_job(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    provider: str = Form(""),
    language: str = Form("auto"),
    diarize: bool = Form(False),
    num_speakers: str = Form(""),
    model: str = Form(""),
    remote_model: str = Form(""),
    openrouter_model: str = Form(""),
):
    _cleanup_expired_files()
    provider_norm = _form_text(provider, "").strip()
    if provider_norm and provider_norm not in ALLOWED_REMOTE_PROVIDERS:
        raise HTTPException(status_code=400, detail="unsupported provider")
    lang_opt = _normalize_language(_form_text(language, "auto"))

    orig_name = _normalize_filename(file.filename or "audio.wav")
    _validate_audio_filename(orig_name)
    job_id = str(uuid.uuid4())
    upload_path = _upload_snapshot_path(job_id, orig_name)
    await _save_upload_file(file, upload_path)

    jobs.create(job_id)
    _submit_remote_transcription_job(
        job_id=job_id,
        provider_norm=provider_norm,
        upload_path=upload_path,
        orig_name=orig_name,
        language=lang_opt,
        diarize=_form_bool(diarize, False),
        num_speakers=_form_text(num_speakers, ""),
        remote_model=_first_nonempty_text(
            _form_text(model, ""),
            _form_text(remote_model, ""),
            _form_text(openrouter_model, ""),
        ),
        cleanup_upload_path=True,
    )
    return {"job_id": job_id}


@app.post("/api/remote/jobs/from-path")
async def create_remote_job_from_path(
    payload: dict = Body(...),
    _auth: None = Depends(_require_api_auth),
):
    _cleanup_expired_files()
    provider_norm = str((payload or {}).get("provider") or "").strip()
    if provider_norm and provider_norm not in ALLOWED_REMOTE_PROVIDERS:
        raise HTTPException(status_code=400, detail="unsupported provider")

    source_path = await asyncio.to_thread(
        _resolve_source_media_path,
        (payload or {}).get("source_path") or (payload or {}).get("path"),
    )
    orig_name = _normalize_filename(source_path.name)
    lang_opt = _normalize_language(str((payload or {}).get("language") or "auto"))

    job_id = str(uuid.uuid4())
    upload_path = await asyncio.to_thread(_snapshot_source_media_for_job, source_path, job_id)
    jobs.create(job_id)
    _submit_remote_transcription_job(
        job_id=job_id,
        provider_norm=provider_norm,
        upload_path=upload_path,
        orig_name=orig_name,
        language=lang_opt,
        diarize=_payload_bool(payload, "diarize", False),
        num_speakers=str((payload or {}).get("num_speakers") or ""),
        remote_model=_remote_model_from_payload(payload),
        cleanup_upload_path=False,
    )
    return {"job_id": job_id, "audio_source_path": str(upload_path)}


@app.post("/api/remote/transcribe-sync")
async def remote_transcribe_sync(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    provider: str = Form(""),
    language: str = Form("auto"),
    diarize: bool = Form(False),
    num_speakers: str = Form(""),
    model: str = Form(""),
    remote_model: str = Form(""),
    openrouter_model: str = Form(""),
):
    provider_norm = _form_text(provider, "").strip()
    if provider_norm and provider_norm not in ALLOWED_REMOTE_PROVIDERS:
        raise HTTPException(status_code=400, detail="unsupported provider")
    lang_opt = _normalize_language(_form_text(language, "auto"))

    orig_name = _normalize_filename(file.filename or "audio.wav")
    _validate_audio_filename(orig_name)
    request_id = str(uuid.uuid4())
    upload_path = _upload_snapshot_path(request_id, orig_name)
    await _save_upload_file(file, upload_path)

    cfg = load_config()
    loop = asyncio.get_running_loop()
    try:
        # CRITICAL: run in thread pool so synchronous requests.request()
        # does NOT block the event loop. Without this, parallel chunk
        # requests from the frontend serialize (5×3s = 15-60s).
        result = await loop.run_in_executor(
            None,
            lambda: _run_remote_transcribe_once(
                provider_norm=provider_norm,
                upload_path=upload_path,
                orig_name=orig_name,
                language=lang_opt,
                diarize=_form_bool(diarize, False),
                num_speakers=_form_text(num_speakers, ""),
                remote_model=_first_nonempty_text(
                    _form_text(model, ""),
                    _form_text(remote_model, ""),
                    _form_text(openrouter_model, ""),
                ),
                cfg=cfg,
            ),
        )
        return {"ok": True, "result": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_safe_error_text(e))
    except RemoteError as e:
        # See create_remote_job's matching handler for the hierarchy
        # rationale — base RemoteError covers http_retry network errors
        # that the typed subclasses miss.
        raise HTTPException(status_code=502, detail=_safe_error_text(e))
    except Exception as e:
        logger.exception("remote_transcribe_sync failed")
        raise HTTPException(status_code=500, detail=f"Remote transcription failed: {_safe_error_text(e)}")
    finally:
        try:
            os.remove(upload_path)
        except OSError as e:
            logger.debug("remote sync upload cleanup skipped for %s: %s", upload_path, e)


@app.post("/api/recordings/{recording_name}/transcribe-on-disk")
async def transcribe_recording_on_disk(
    recording_name: str,
    payload: dict = Body(default_factory=dict),
    _auth: None = Depends(_require_api_auth),
):
    """Transcribe an already-saved recording WITHOUT a re-upload.

    Recovery path optimization. The frontend's previous "tail-gap"
    fallback chain went:
        frontend GET /api/recordings/<name>/audio        # loopback fetch
        frontend POST /api/remote/transcribe-sync (FormData)  # loopback upload
        backend reads UploadFile into memory             # extra copy
        backend ffmpeg-recompresses                      # extra encode
        backend → Deepgram REST                          # actual work
    On a 1 MB recording + 100 ms loopback latency the redundant
    GET+POST round-trip costs ~500 ms-1 s. This endpoint short-
    circuits both: the audio bytes are already on disk, the backend
    reads them directly, no upload boundary involved.

    Body shape (all optional, defaulted):
        provider:        "deepgram" | "openrouter" (default: deepgram)
        language:        ISO-639-1 / "auto" (default: auto)
        diarize:         bool (default: false)
        num_speakers:    str (deepgram only)
        model/remote_model: str (legacy alias: openrouter_model)
        archive_dir:     str — same as the GET endpoint

    Returns same shape as ``/api/remote/transcribe-sync``.
    """
    provider_norm = str(payload.get("provider") or "").strip()
    if provider_norm and provider_norm not in ALLOWED_REMOTE_PROVIDERS:
        raise HTTPException(status_code=400, detail="unsupported provider")
    archive_dir = str(payload.get("archive_dir") or "").strip()
    target_dir = (
        _resolve_recordings_target_dir(archive_dir, create=False)
        if archive_dir
        else None
    )
    p = _recording_path_or_404(recording_name, target_dir=target_dir)
    audio_path = _recording_audio_path(p.name, target_dir=target_dir)
    if audio_path is None:
        raise HTTPException(status_code=404, detail="recording audio not found")
    try:
        audio_size = audio_path.stat().st_size
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to stat audio: {_safe_error_text(e)}")
    if audio_size == 0:
        raise HTTPException(status_code=500, detail="audio file is empty")
    if audio_size > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"audio too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
        )
    lang_opt = _normalize_language(str(payload.get("language") or "auto"))
    cfg = load_config()
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: _run_remote_transcribe_once(
                provider_norm=provider_norm,
                upload_path=audio_path,
                orig_name=audio_path.name,
                language=lang_opt,
                diarize=_payload_bool(payload, "diarize", False),
                num_speakers=str(payload.get("num_speakers") or ""),
                remote_model=_remote_model_from_payload(payload),
                cfg=cfg,
            ),
        )
        return {"ok": True, "result": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_safe_error_text(e))
    except RemoteError as e:
        raise HTTPException(status_code=502, detail=_safe_error_text(e))
    except Exception as e:
        logger.exception("transcribe_recording_on_disk failed")
        raise HTTPException(status_code=500, detail=f"On-disk transcription failed: {_safe_error_text(e)}")


@app.post("/api/upscale")
async def upscale_text(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    trimmed_chars = 0
    if len(text) > MAX_UPSCALE_INPUT_CHARS:
        trimmed_chars = len(text) - MAX_UPSCALE_INPUT_CHARS
        text = text[trimmed_chars:]
        logger.warning(
            "upscale input trimmed: leading_chars=%s max_chars=%s",
            trimmed_chars,
            MAX_UPSCALE_INPUT_CHARS,
        )
    _ensure_builtin_upscale_presets()
    preset_id = str(payload.get("preset_id") or "").strip()
    if not preset_id:
        legacy = str(payload.get("preset") or DEFAULT_UPSCALE_PRESET_KEY).strip().lower()
        if legacy not in BUILTIN_UPSCALE_PRESETS:
            raise HTTPException(status_code=400, detail="unsupported upscale preset")
        preset_id = f"builtin_{legacy}"
    preset = _resolve_upscale_preset(preset_id)

    cfg = load_config()
    providers = cfg.get("providers") or {}
    prefs = cfg.get("preferences") or {}
    key = ((providers.get("openrouter") or {}).get("key") or "").strip()
    model = str((payload.get("model") or (prefs.get("openrouter") or {}).get("model") or DEFAULT_OPENROUTER_UPSCALE_MODEL)).strip()
    if not key:
        raise HTTPException(status_code=400, detail="OpenRouter key is not configured")
    instruction = str(preset.get("instruction") or "").strip()
    candidates: list[str] = []
    for m in [
        model,
        str((prefs.get("openrouter") or {}).get("model") or "").strip(),
        *OPENROUTER_UPSCALE_FALLBACK_MODELS,
    ]:
        mm = str(m or "").strip()
        if mm and mm not in candidates:
            candidates.append(mm)
    used_model = candidates[0] if candidates else model
    out: Optional[dict[str, Any]] = None
    last_err: Optional[Exception] = None
    loop = asyncio.get_running_loop()
    try:
        for cand in candidates:
            used_model = cand
            try:
                out = await loop.run_in_executor(
                    None,
                    lambda c=cand: openrouter_upscale_text(
                        api_key=key,
                        model=c,
                        text=text,
                        instruction=instruction,
                    ),
                )
                break
            except OpenRouterError as e:
                last_err = e
                msg = str(e)
                # Retry with fallback models only for invalid/non-existing model issues.
                if ("HTTP 404" in msg) or ("not found" in msg.lower()):
                    continue
                raise
            except RemoteError as e:
                last_err = e
                raise
        if out is None:
            if last_err is not None:
                raise last_err
            # 1.1.25: previously raised a bare RuntimeError that
            # escaped the OpenRouterError handler below and surfaced
            # as a generic FastAPI 500 with no actionable message.
            raise HTTPException(status_code=502, detail="upscale failed: no candidate model succeeded")
    except RemoteError as e:
        # 1.1.25: route through ``_safe_error_text`` so the 502 body
        # never leaks raw upstream URL fragments / response bodies
        # into the renderer.
        raise HTTPException(status_code=502, detail=_safe_error_text(e))
    return {
        "ok": True,
        "preset_id": preset.get("id"),
        "preset_name": preset.get("name"),
        "model": used_model,
        "trimmed_chars": trimmed_chars,
        "text": (out.get("text") or "").strip(),
    }


@app.get("/api/upscale/presets")
def list_upscale_presets(_auth: None = Depends(_require_api_auth)):
    items = _list_upscale_presets()
    return {
        "default_preset_id": DEFAULT_UPSCALE_PRESET_ID,
        "items": [
            {
                "id": x["id"],
                "name": x["name"],
                "builtin": bool(x["builtin"]),
                "instruction": str(x.get("instruction") or ""),
                "default_instruction": str(x.get("default_instruction") or x.get("instruction") or ""),
            }
            for x in items
        ]
    }


@app.post("/api/upscale/presets")
def create_upscale_preset(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    _ensure_builtin_upscale_presets()
    name = str(payload.get("name") or "").strip()
    instruction = str(payload.get("instruction") or "").strip()
    if len(instruction) > 20_000:
        raise HTTPException(status_code=413, detail="instruction too long (max 20000 chars)")
    if not name:
        raise HTTPException(status_code=400, detail="preset name is required")
    if not instruction:
        raise HTTPException(status_code=400, detail="preset instruction is required")

    custom_count = 0
    for item in _list_upscale_presets():
        if not bool(item.get("builtin")):
            custom_count += 1
    if custom_count >= UPSCALE_MAX_CUSTOM_PRESETS:
        raise HTTPException(status_code=400, detail=f"maximum {UPSCALE_MAX_CUSTOM_PRESETS} custom presets")

    base_slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not base_slug:
        base_slug = "custom"
    preset_id = f"custom_{base_slug}"
    suffix = 2
    while (_upscale_preset_path(preset_id)).exists():
        preset_id = f"custom_{base_slug}_{suffix}"
        suffix += 1

    payload_out = {
        "id": preset_id,
        "name": name[:60],
        "instruction": instruction,
        "default_instruction": instruction,
        "builtin": False,
    }
    _write_upscale_preset(_upscale_preset_path(preset_id), payload_out)
    return {
        "ok": True,
        "item": {
            "id": payload_out["id"],
            "name": payload_out["name"],
            "builtin": False,
            "instruction": payload_out["instruction"],
            "default_instruction": payload_out["default_instruction"],
        },
    }


@app.put("/api/upscale/presets/{preset_id}")
def update_upscale_preset(preset_id: str, payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    _ensure_builtin_upscale_presets()
    item = _resolve_upscale_preset(preset_id)
    instruction = str(payload.get("instruction") or "").strip()
    if len(instruction) > 20_000:
        raise HTTPException(status_code=413, detail="instruction too long (max 20000 chars)")
    if not instruction:
        raise HTTPException(status_code=400, detail="preset instruction is required")
    next_payload = {
        "id": item["id"],
        "name": str(item.get("name") or "").strip()[:60],
        "instruction": instruction,
        "default_instruction": str(item.get("default_instruction") or item.get("instruction") or instruction).strip() or instruction,
        "builtin": bool(item.get("builtin")),
    }
    _write_upscale_preset(_upscale_preset_path(item["id"]), next_payload)
    return {"ok": True, "item": next_payload}


@app.post("/api/upscale/presets/{preset_id}/reset-default")
def reset_upscale_preset_default(preset_id: str, _auth: None = Depends(_require_api_auth)):
    _ensure_builtin_upscale_presets()
    item = _resolve_upscale_preset(preset_id)
    default_instruction = str(item.get("default_instruction") or item.get("instruction") or "").strip()
    if not default_instruction:
        raise HTTPException(status_code=500, detail="preset default instruction is empty")
    next_payload = {
        "id": item["id"],
        "name": str(item.get("name") or "").strip()[:60],
        "instruction": default_instruction,
        "default_instruction": default_instruction,
        "builtin": bool(item.get("builtin")),
    }
    _write_upscale_preset(_upscale_preset_path(item["id"]), next_payload)
    return {"ok": True, "item": next_payload}


@app.delete("/api/upscale/presets/{preset_id}")
def delete_upscale_preset(preset_id: str, _auth: None = Depends(_require_api_auth)):
    _ensure_builtin_upscale_presets()
    item = _resolve_upscale_preset(preset_id)
    if bool(item.get("builtin")):
        raise HTTPException(status_code=400, detail="built-in presets cannot be deleted")
    p = _upscale_preset_path(preset_id)
    try:
        p.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("upscale preset delete failed for %s: %s", preset_id, exc)
        raise HTTPException(status_code=500, detail="could not delete preset") from exc
    return {"ok": True}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, _auth: None = Depends(_require_api_auth)):
    _cleanup_expired_files()
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "job_id": job.id,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "result": job.result if job.status == "done" else None,
        "result_files": job.result_files if job.status == "done" else None,
    }


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, _auth: None = Depends(_require_api_auth)):
    job = jobs.cancel(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "job_id": job.id,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
    }


@app.get("/api/jobs/{job_id}/download/{kind}")
def download(job_id: str, kind: str, _auth: None = Depends(_require_api_auth)):
    if kind not in {"txt", "json"}:
        raise HTTPException(status_code=400, detail="unsupported file kind")
    job = jobs.get(job_id)
    if not job or job.status != "done":
        raise HTTPException(status_code=404, detail="job not found")
    path = job.result_files.get(kind)
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="file not found")
    media_type = "application/json" if kind == "json" else "text/plain"
    filename = f"{job_id}.{kind}"
    return FileResponse(path, media_type=media_type, filename=filename)


# ── Command-line access ─────────────────────────────────────────────
#
# Three routes, one owner. ``GET /api/cli`` is the only one the CLI
# token itself may call: the client reads it to learn what the app would
# do by default, so a bare ``transcriptor transcribe file.mp4``
# transcribes exactly as the Upload tab would. Enable and disable are
# renderer-only — they are not on ``cli_access._CLI_ROUTES``, so a
# command holding the CLI token cannot widen its own access.


def _cli_status_payload(request: Request) -> dict[str, Any]:
    """The CLI section's whole view: switch state, paths, cards, defaults."""
    payload = CLI_ACCESS.status(base_url=base_url_from_scope(request.scope))
    payload["defaults"] = cli_defaults(load_config(), gigaam_available())
    return payload


@app.get("/api/cli")
def get_cli_access(request: Request, _auth: None = Depends(_require_api_auth)):
    return _cli_status_payload(request)


@app.post("/api/cli/enable")
def enable_cli_access(request: Request, _auth: None = Depends(_require_api_auth)):
    try:
        CLI_ACCESS.enable(base_url_from_scope(request.scope))
    except OSError as e:
        # The switch reports what the file system holds, so a failed
        # write must surface as a failure — not as an "on" the next
        # boot would contradict. CliAccess rolls its own state back.
        logger.exception("cli access could not be enabled")
        raise HTTPException(
            status_code=500,
            detail=f"command-line access not enabled: {_safe_error_text(e)}",
        )
    logger.info("cli access enabled; files under %s", CLI_ACCESS.dir)
    return _cli_status_payload(request)


@app.post("/api/cli/disable")
def disable_cli_access(request: Request, _auth: None = Depends(_require_api_auth)):
    CLI_ACCESS.disable()
    logger.info("cli access disabled; token revoked")
    return _cli_status_payload(request)


@app.get("/api/config")
def get_config(_auth: None = Depends(_require_api_auth)):
    # Deliberately omit config_path — we do not expose internal filesystem
    # layout to the renderer (user explicitly requested this).
    cfg = redact_config(load_config())
    return cfg


@app.post("/api/config")
def set_config(payload: dict = Body(...), _auth: None = Depends(_require_api_auth)):
    _validate_config_payload(payload)
    try:
        save_config(payload)
    except OSError as e:
        # save_config logs the underlying reason; surface a clean 500 so
        # the renderer can show a meaningful toast instead of hanging on
        # an uncaught server exception. Redact: OSError.__str__ formats
        # as "[Errno 13] Permission denied: '/Users/<name>/Library/...
        # /config.json'" — the full path leaks the user's profile name.
        logger.exception("save_config failed")
        raise HTTPException(
            status_code=500,
            detail=f"failed to persist config: {_safe_error_text(e)}",
        )
    except RuntimeError as e:
        # encrypt_value's documented loud-fail (crypto present but keyfile
        # unusable): persisting provider keys in the clear is forbidden by
        # design, so the save must fail — as a clean envelope, not a raw
        # 500 (BUG-54, the save-side twin of BUG-41).
        logger.error("save_config refused: encryption unavailable: %s", e)
        raise HTTPException(
            status_code=503,
            detail="config not saved: encryption is unavailable (key file unusable); fix the key file and retry",
        )
    _invalidate_recordings_dir_cache()
    _invalidate_recordings_cache()
    return {"ok": True}


def _resolve_picker_command() -> tuple[list[str], str]:
    """Pick a folder-selection command for the current platform.

    Returns (cmd_list, platform_kind). The "platform_kind" tag lets the
    caller parse the output correctly — osascript prints the path raw,
    zenity/kdialog print it newline-terminated, PowerShell's
    FolderBrowserDialog prints it with Windows-style line endings.
    """
    if sys.platform == "darwin":
        return (
            ["osascript", "-e",
             'POSIX path of (choose folder with prompt "Select folder for recordings")'],
            "mac",
        )
    if sys.platform == "win32":
        # PowerShell FolderBrowserDialog — ships with Windows, no external
        # deps. The script prints the selected path or "CANCEL" on cancel.
        ps_script = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$f = New-Object System.Windows.Forms.FolderBrowserDialog;"
            "$f.Description = 'Select folder for recordings';"
            "$f.ShowNewFolderButton = $true;"
            "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
            "{ Write-Output $f.SelectedPath } else { Write-Output 'CANCEL' }"
        )
        return (
            ["powershell", "-NoProfile", "-STA", "-Command", ps_script],
            "win",
        )
    # Linux: prefer zenity (GNOME/most distros), fall back to kdialog (KDE).
    import shutil as _sh
    if _sh.which("zenity"):
        return (
            ["zenity", "--file-selection", "--directory",
             "--title=Select folder for recordings"],
            "linux",
        )
    if _sh.which("kdialog"):
        return (
            ["kdialog", "--getexistingdirectory", str(Path.home()),
             "--title", "Select folder for recordings"],
            "linux",
        )
    # No picker tool found — caller handles this.
    return ([], "none")


def _ensure_directory_for_user_path(path: Path, action: str) -> None:
    try:
        path.mkdir(parents=True, exist_ok=True)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="folder path exists but is not a directory")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"{action} failed: {_safe_error_text(e)}")
    try:
        if not path.is_dir():
            raise HTTPException(status_code=409, detail="folder path exists but is not a directory")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"{action} failed: {_safe_error_text(e)}")


def _require_existing_directory_for_user_path(path: Path, action: str) -> None:
    try:
        if not path.exists():
            raise HTTPException(status_code=404, detail="folder path does not exist")
        if not path.is_dir():
            raise HTTPException(status_code=409, detail="folder path exists but is not a directory")
    except HTTPException:
        raise
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"{action} failed: {_safe_error_text(e)}")


@app.post("/api/recordings/pick-folder")
async def pick_recordings_folder(_auth: None = Depends(_require_api_auth)):
    cmd, kind = _resolve_picker_command()
    if kind == "none":
        raise HTTPException(
            status_code=400,
            detail="No folder picker available. Install 'zenity' or 'kdialog' "
                   "(sudo apt install zenity) and try again, or type the path manually.",
        )
    # Force UTF-8 encoding on Windows. PowerShell's default stdout
    # encoding is the system OEM/ANSI codepage (cp1252/cp1251/cp932)
    # unless $OutputEncoding is set. Without forcing UTF-8 on BOTH the
    # producer (PowerShell) and consumer (subprocess.run) sides, a
    # folder path containing Cyrillic/CJK/accented chars is mojibaked
    # into unreadable bytes — Path().resolve() then either raises or
    # points at a phantom directory.
    if kind == "win":
        cmd = list(cmd)
        cmd[-1] = (
            "$OutputEncoding = [System.Text.Encoding]::UTF8; "
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
            + cmd[-1]
        )
    try:
        # Async + offload: the user-interactive picker dialog can stay
        # open for tens of seconds. Sync def pinned an executor thread
        # for the whole modal; concurrent picker invocations + heavy
        # background work could exhaust the threadpool.
        result = await asyncio.to_thread(
            lambda: subprocess.run(
                cmd, check=True, capture_output=True, text=True, timeout=120,
                encoding="utf-8", errors="replace",
            )
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="folder picker timed out")
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        # zenity returns exit code 1 on Cancel — treat as "no folder selected".
        if kind == "linux" and e.returncode == 1:
            raise HTTPException(status_code=400, detail="selection canceled")
        if "User canceled" in stderr:
            raise HTTPException(status_code=400, detail="selection canceled")
        # Redact: stderr from PowerShell/zenity/osascript routinely
        # contains absolute paths (C:\Users\..., /home/...) — strip
        # via _safe_error_text before echoing to HTTP body.
        raise HTTPException(
            status_code=500,
            detail=f"folder picker failed: {_safe_error_text(stderr or 'unknown error')}",
        )
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=500,
            detail=f"folder picker command missing: {_safe_error_text(e)}",
        )

    selected = (result.stdout or "").strip()
    # PowerShell FolderBrowserDialog encodes cancel as literal "CANCEL".
    if not selected or selected == "CANCEL":
        raise HTTPException(status_code=400, detail="no folder selected")
    p = Path(selected).expanduser().resolve()
    # Containment invariant: recordings must live inside the user's home
    # directory. _resolve_recordings_target_dir enforces this at load time;
    # the picker enforces it at write time so a user can't persist a path
    # the resolver will later silently reject.
    home_dir = Path.home().resolve()
    try:
        p.relative_to(home_dir)
    except ValueError:
        raise HTTPException(
            status_code=403,
            detail="recordings folder must live inside your home directory",
        )
    _ensure_directory_for_user_path(p, "folder picker")
    return {"path": str(p)}


@app.post("/api/recordings/open-folder")
async def open_recordings_folder(payload: dict = Body(default_factory=dict), _auth: None = Depends(_require_api_auth)):
    requested = str((payload or {}).get("path") or "").strip()
    if requested:
        d = Path(requested).expanduser()
        if not d.is_absolute():
            d = (_resolve_recordings_dir() / d).resolve()
        else:
            d = d.resolve()
        # Safety: only allow opening the recordings dir or its subdirectories,
        # or well-known user-accessible directories.
        recordings_root = _resolve_recordings_dir().resolve()
        home_dir = Path.home().resolve()
        try:
            d.relative_to(recordings_root)
        except ValueError:
            try:
                d.relative_to(home_dir)
            except ValueError:
                raise HTTPException(status_code=403, detail="path outside allowed directories")
        _require_existing_directory_for_user_path(d, "open folder")
    else:
        d = _resolve_recordings_dir()
    # Pick the right open-folder command per platform.
    if sys.platform == "darwin":
        open_cmd = ["open", str(d)]
    elif sys.platform == "win32":
        # os.startfile is the canonical Explorer opener on Windows.
        # It returns immediately and raises OSError on failure.
        try:
            await asyncio.to_thread(lambda: os.startfile(str(d)))  # type: ignore[attr-defined]
            return {"ok": True, "path": str(d)}
        except OSError as e:
            raise HTTPException(
                status_code=500,
                detail=f"open folder failed: {_safe_error_text(e)}",
            )
    elif sys.platform.startswith("linux"):
        open_cmd = ["xdg-open", str(d)]
    else:
        raise HTTPException(status_code=400, detail=f"open folder not implemented for platform {sys.platform}")
    try:
        await asyncio.to_thread(
            lambda: subprocess.run(open_cmd, check=True, capture_output=True, text=True, timeout=15)
        )
        return {"ok": True, "path": str(d)}
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="open folder timed out")
    except FileNotFoundError:
        tool = open_cmd[0]
        raise HTTPException(status_code=500, detail=f"open folder failed: '{tool}' not found")
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        # Redact: xdg-open / explorer stderr can include user paths.
        raise HTTPException(
            status_code=500,
            detail=f"open folder failed: {_safe_error_text(stderr or 'unknown error')}",
        )


_list_cache: Optional[dict] = None
_list_cache_at = 0.0
_list_cache_key: Optional[tuple] = None
_LIST_CACHE_TTL = 5.0
# Serialises concurrent rebuilds of the /api/recordings cache so two
# simultaneous cache misses run ONE scan instead of N. The previous
# implementation held the sync `_recordings_caches_lock` only when
# READING and WRITING the cache globals — the scan itself ran fully
# unserialised, so on a cold-cache burst every worker ran a full
# duplicate scan (each ~300 ms on 5 k recordings), which multiplied
# disk I/O and blocked threadpool slots.
#
# `asyncio.Lock` cooperates with the event loop — waiters yield to
# other awaitables while a single rebuild runs. Double-checked
# locking pattern: first look wakes up the fast path, second look
# inside the lock confirms another waiter didn't just populate it.
_list_cache_rebuild_lock: Optional[asyncio.Lock] = None


# ── Recordings-list scan cache ──────────────────────────────────────
#
# Rebuilding the History list used to cost, per transcript: one full
# ``read_text`` to parse four metadata fields out of the header, plus a
# probe of every accepted audio/video extension to find the sibling
# audio file. On a real archive (~5900 transcripts, 3 collection dirs)
# that is ~12 MB of reads and ~100k stat() calls — measured at 4.1 s.
#
# And it ran often: ``_invalidate_recordings_cache`` drops the whole
# list after every single save, so the first History load after each
# recording paid the full rescan.
#
# Two structural fixes, no change to the response contract:
#
#   * Per-file metadata cache keyed by identity + (mtime_ns, size). A
#     saved transcript is immutable, so after the first scan every
#     unchanged file is a dict lookup instead of a read + parse. The
#     cache is pruned to exactly the set of files seen by each scan, so
#     deletions cannot make it grow without bound and it needs no LRU.
#   * One directory listing builds a stem -> audio-path index, replacing
#     the per-item extension probe. O(entries) once, not O(items x exts).
_recordings_entry_cache: dict[str, tuple[tuple[int, int], dict]] = {}
_recordings_entry_cache_lock = threading.Lock()


def _recording_audio_index(archive_dir: Path) -> dict[str, Path]:
    """Map transcript stem -> its audio file, from ONE directory listing.

    Replaces ``_recording_audio_path``'s per-item probe of every
    accepted extension. Deterministic when a stem somehow has more than
    one audio sibling: ``_RECORDING_AUDIO_EXTS`` is sorted, and the
    earliest extension wins, matching the probe's first-match order.
    """
    index: dict[str, Path] = {}
    rank = {ext: i for i, ext in enumerate(_RECORDING_AUDIO_EXTS)}
    try:
        entries = list(archive_dir.iterdir())
    except OSError:
        return index
    for entry in entries:
        ext = entry.suffix.lower()
        if ext not in rank:
            continue
        try:
            if not entry.is_file():
                continue
        except OSError:
            continue
        current = index.get(entry.stem)
        if current is None or rank[ext] < rank[current.suffix.lower()]:
            index[entry.stem] = entry
    return index


def _audio_payload_from_index(
    stem: str, audio_index: dict[str, Path]
) -> dict[str, Any]:
    """``_recording_audio_payload`` for an already-listed directory."""
    audio_path = audio_index.get(stem)
    if audio_path is None:
        return {
            "has_audio": False,
            "audio_name": "",
            "audio_size_bytes": 0,
            "audio_mime": "",
        }
    try:
        size_bytes = audio_path.stat().st_size
    except OSError:
        size_bytes = 0
    return {
        "has_audio": True,
        "audio_name": audio_path.name,
        "audio_size_bytes": size_bytes,
        "audio_mime": _audio_content_type(audio_path.name),
    }


def _prune_recordings_entry_cache(live_keys: set[str]) -> None:
    """Drop cache entries for transcripts the latest scan did not see.

    Keeps the cache exactly the size of the archive — a deleted or moved
    recording releases its entry on the next scan, so no eviction policy
    is required.
    """
    with _recordings_entry_cache_lock:
        for stale in [k for k in _recordings_entry_cache if k not in live_keys]:
            _recordings_entry_cache.pop(stale, None)


def _build_recordings_list_payload(d: "Path") -> dict:
    """Expensive sync scan — runs in a thread pool via asyncio.to_thread.

    Extracted so the async route above can offload it cleanly. Kept
    sync because Path.glob / stat / read_text are synchronous and
    there's no async stdlib equivalent.

    Per transcript the scan needs four header fields and the identity of
    the sibling audio file. Both are cached: header parsing behind a
    (mtime_ns, size) identity check, audio lookup behind one directory
    listing per archive dir. See the cache block above for the numbers
    that motivated it.
    """
    items = []
    live_keys: set[str] = set()
    for archive_dir in _recordings_scan_dirs(d):
        collection = _recording_collection_for_dir(archive_dir)
        audio_index = _recording_audio_index(archive_dir)
        for p in _iter_recording_text_files(archive_dir):
            try:
                st = p.stat()
                cache_key = str(p)
                live_keys.add(cache_key)
                # A saved transcript never changes in place, so identity
                # plus (mtime_ns, size) is a sound freshness test — and
                # a rewritten file changes at least one of them.
                identity = (int(st.st_mtime_ns), int(st.st_size))
                with _recordings_entry_cache_lock:
                    cached = _recordings_entry_cache.get(cache_key)
                if cached is not None and cached[0] == identity:
                    parsed = cached[1]
                else:
                    raw = p.read_text(encoding="utf-8", errors="replace")
                    parsed = {
                        "display_name": _recording_display_name_from_content(raw, p.stem),
                        "source_file": _recording_source_file(raw),
                        "provider": _extract_meta_field(raw, "Provider").lower() or "",
                        "language": _extract_meta_field(raw, "Language").lower() or "",
                    }
                    with _recordings_entry_cache_lock:
                        _recordings_entry_cache[cache_key] = (identity, parsed)
                items.append(
                    {
                        "name": p.name,
                        "display_name": parsed["display_name"],
                        "source_file": parsed["source_file"],
                        "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
                        "size_bytes": st.st_size,
                        "provider": parsed["provider"],
                        "language": parsed["language"],
                        "archive_dir": str(archive_dir),
                        "recording_collection": collection,
                        # Audio fields come from the directory index built
                        # once above. The previous form called
                        # ``_recording_audio_payload`` per item, which
                        # probed every accepted extension with exists() —
                        # ~17 stat() calls per recording.
                        **_audio_payload_from_index(p.stem, audio_index),
                    }
                )
            except Exception as e:
                # Silent skip used to be a black box: a corrupt recording
                # disappeared from the list with no log, no UI signal, no
                # way for the user to know why a file they can see in
                # Finder is missing from History. ``debug``-level so a
                # routine truncated-during-save won't spam ops, but the
                # name and exception class are still in the support log.
                logger.debug("recordings list: skipped %s (%s: %s)", p.name, type(e).__name__, e)
                continue
    _prune_recordings_entry_cache(live_keys)
    items.sort(key=lambda x: x["modified_at"], reverse=True)
    return {"items": items, "directory": str(d)}


@app.get("/api/recordings")
async def list_recordings(_auth: None = Depends(_require_api_auth)):
    """Return the current recordings list, cached with mtime+count key.

    Now ``async`` so FastAPI does NOT silently dispatch the route to
    a thread pool worker. On cache hit the response returns within
    microseconds (lock + dict lookup, no I/O). On miss the scan runs
    via ``asyncio.to_thread`` so the event loop stays responsive for
    other requests; concurrent misses all await the same rebuild via
    ``_list_cache_rebuild_lock`` (double-checked).
    """
    global _list_cache, _list_cache_at, _list_cache_key, _list_cache_rebuild_lock
    d = _resolve_recordings_dir()
    now = time.monotonic()

    # Cache key probe (BUG-51): the key is an O(N) stat over every tracked
    # file of every active storage dir — NOT cheap for a library of
    # thousands of recordings, and this route runs on the event loop, so
    # computing it inline stalled WS transcription frames on every poll.
    # Same worker-thread hop as the rebuild below; the fast path still
    # avoids the full scan.
    cache_key = await asyncio.to_thread(_recordings_scan_cache_key, d)

    # Fast path: cache hit.
    with _recordings_caches_lock:
        if (
            _list_cache is not None
            and _list_cache_key == cache_key
            and (now - _list_cache_at) < _LIST_CACHE_TTL
        ):
            return _list_cache

    # Lazy-init the async lock — cannot live at module scope because
    # some stdlib versions bind it to the loop at creation time, and
    # module import may predate loop creation in certain test harnesses.
    if _list_cache_rebuild_lock is None:
        _list_cache_rebuild_lock = asyncio.Lock()

    async with _list_cache_rebuild_lock:
        # Double-checked: another awaiter may have populated the cache
        # while we waited for the lock.
        now = time.monotonic()
        with _recordings_caches_lock:
            if (
                _list_cache is not None
                and _list_cache_key == cache_key
                and (now - _list_cache_at) < _LIST_CACHE_TTL
            ):
                return _list_cache
        # Genuine miss — run the scan in a worker thread so other
        # awaitables (WS transcription frames, /api/health, etc.) keep
        # making progress during the ~300 ms scan.
        result = await asyncio.to_thread(_build_recordings_list_payload, d)
        with _recordings_caches_lock:
            _list_cache = result
            _list_cache_at = time.monotonic()
            _list_cache_key = cache_key
        return result


# Graph is intentionally dormant. The frontend sidebar/view markup and TS/CSS
# implementation are removed, and the backend route is not registered
# so no graph scan can be triggered by OpenAPI or direct HTTP calls.


def _delete_all_recordings_sync() -> dict:
    """Bulk-delete sweep across known archive dirs. Sync helper so
    the async route can offload via `asyncio.to_thread` — bare
    `def` previously pinned an executor thread for seconds when
    purging thousands of files."""
    deleted = 0
    failed = 0
    for d in _recordings_storage_dirs_for_roots(_get_known_archive_dirs()):
        for p in _iter_recording_text_files(d):
            audio_path = _recording_audio_path(p.name, target_dir=d)
            audio_backup: Optional[Path] = None
            try:
                if audio_path is not None:
                    audio_backup = audio_path.with_name(f"{audio_path.name}.tmp-{uuid.uuid4().hex}")
                    os.replace(audio_path, audio_backup)
                p.unlink()
                if audio_backup is not None:
                    _best_effort_unlink(audio_backup, context="delete-all audio cleanup")
                deleted += 1
            except Exception as exc:
                if audio_backup is not None and audio_backup.exists():
                    try:
                        os.replace(audio_backup, audio_path)
                    except OSError as restore_err:
                        logger.warning(
                            "delete-all audio rollback failed for %s: %s",
                            audio_path,
                            restore_err,
                        )
                logger.warning("delete-all recording failed for %s: %s", p, exc)
                failed += 1
    return {"deleted": deleted, "failed": failed}


@app.delete("/api/recordings")
async def delete_all_recordings(_auth: None = Depends(_require_api_auth)):
    # Scan ALL known archive dirs — not just the default one — so that
    # recordings saved to custom directories are fully removed. Without
    # this, only the TXT files in the default dir were deleted while
    # audio files and TXT files in custom dirs were left on disk.
    # Invalidate the list/stats caches BEFORE the delete loop AND
    # after — a concurrent GET /api/recordings landing mid-delete would
    # otherwise repopulate the cache with stale entries that survive
    # until the next invalidation. Double-invalidate is cheap and
    # closes the race window entirely.
    _invalidate_recordings_cache()
    result = await asyncio.to_thread(_delete_all_recordings_sync)
    _invalidate_recordings_cache()
    return result


def _read_recording_payload(p: "Path", target_dir: Optional["Path"] = None) -> dict:
    """Sync helper that does the per-recording stat + read + parse.
    Offloaded by the async route so a multi-MB transcript read does
    not pin an executor thread."""
    st = p.stat()
    raw = p.read_text(encoding="utf-8", errors="replace")
    display = _extract_transcript_text(raw)
    source_file = _recording_source_file(raw)
    archive_dir = target_dir or p.parent
    return {
        "name": p.name,
        "source_file": source_file,
        "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
        "size_bytes": st.st_size,
        "content": raw,
        "display_text": display or raw,
        "archive_dir": str(archive_dir),
        "recording_collection": _recording_collection_for_dir(archive_dir),
        # 1.1.25 fix: thread the resolved directory through so a
        # call against a non-default archive correctly looks up the
        # audio within that archive instead of falling back to
        # ``_resolve_recordings_dir()`` and reporting has_audio=false
        # for every entry in custom archives.
        **_recording_audio_payload(p.name, target_dir=archive_dir),
    }


@app.get("/api/recordings/{recording_name}")
async def get_recording(
    recording_name: str,
    archive_dir: str = "",
    _auth: None = Depends(_require_api_auth),
):
    # ``display_text`` strips the file header (Title/Saved at/Language/
    # Provider/Model) and returns only the transcript body. The raw
    # ``content`` is still returned for backwards compat / export.
    target_dir = _resolve_recordings_target_dir(archive_dir, create=False) if str(archive_dir or "").strip() else None
    p = _recording_path_or_404(recording_name, target_dir=target_dir)
    return await asyncio.to_thread(_read_recording_payload, p, target_dir)


@app.get("/api/recordings/{recording_name}/audio")
def get_recording_audio(
    recording_name: str,
    archive_dir: str = "",
    _auth: None = Depends(_require_api_auth),
):
    target_dir = _resolve_recordings_target_dir(archive_dir, create=False) if str(archive_dir or "").strip() else None
    p = _recording_path_or_404(recording_name, target_dir=target_dir)
    audio_path = _recording_audio_path(p.name, target_dir=target_dir)
    if audio_path is None:
        raise HTTPException(status_code=404, detail="recording audio not found")
    media_type = _audio_content_type(audio_path.name)
    return FileResponse(str(audio_path), media_type=media_type, filename=audio_path.name)


_stats_cache: Optional[dict] = None
_stats_cache_at = 0.0
_stats_cache_key: Optional[tuple] = None
_STATS_CACHE_TTL = 30.0
_stats_cache_rebuild_lock: Optional[asyncio.Lock] = None


def _build_recordings_stats_payload(d: "Path") -> dict:
    """Heavy sync stats scan extracted for `asyncio.to_thread` offload.
    Reads + tokenises every transcript in the archive — O(N) on file
    count and O(M) on transcript size; pinning an executor thread for
    seconds is the previous regression."""
    files: list[Path] = []
    for archive_dir in _recordings_scan_dirs(d):
        files.extend(_iter_recording_text_files(archive_dir))
    files.sort()
    total_recordings = len(files)
    total_words = 0
    total_chars = 0
    durations_sec: list[int] = []
    word_freq: dict[str, int] = defaultdict(int)
    providers: dict[str, int] = defaultdict(int)
    languages: dict[str, int] = defaultdict(int)

    for p in files:
        try:
            raw = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        provider = _extract_meta_field(raw, "Provider").lower() or "unknown"
        language = _extract_meta_field(raw, "Language").lower() or "auto"
        providers[provider] += 1
        languages[language] += 1
        text = _extract_stats_text(raw)
        total_chars += len(text)
        tokens = _tokenize_words(text)
        total_words += len(tokens)
        # Lightweight estimate: speech pace ~150 words/min.
        dur = int(round((len(tokens) / 150.0) * 60.0)) if tokens else 0
        durations_sec.append(dur)
        for w in tokens:
            word_freq[w] += 1

    top_words = sorted(word_freq.items(), key=lambda kv: kv[1], reverse=True)[:25]
    avg_duration_sec = int(round(sum(durations_sec) / len(durations_sec))) if durations_sec else 0
    max_duration_sec = max(durations_sec) if durations_sec else 0
    min_duration_sec = min(durations_sec) if durations_sec else 0
    avg_words_per_recording = round(total_words / total_recordings, 1) if total_recordings else 0.0
    avg_chars_per_recording = round(total_chars / total_recordings, 1) if total_recordings else 0.0
    return {
        "total_recordings": total_recordings,
        "total_words": total_words,
        "total_chars": total_chars,
        "avg_words_per_recording": avg_words_per_recording,
        "avg_chars_per_recording": avg_chars_per_recording,
        "avg_duration_sec": avg_duration_sec,
        "min_duration_sec": min_duration_sec,
        "max_duration_sec": max_duration_sec,
        "top_words": [{"word": w, "count": c} for w, c in top_words],
        "providers": [{"name": k, "count": v} for k, v in sorted(providers.items(), key=lambda kv: kv[1], reverse=True)],
        "languages": [{"name": k, "count": v} for k, v in sorted(languages.items(), key=lambda kv: kv[1], reverse=True)],
    }


@app.get("/api/recordings/stats/summary")
async def get_recordings_stats(_auth: None = Depends(_require_api_auth)):
    """Return aggregate transcript statistics; cached for 30 s.

    Async + offload pattern matches list_recordings.
    On cold cache the scan is offloaded to a worker thread; concurrent
    misses serialise on a per-cache asyncio.Lock so the heaviest
    workload (full archive read + tokenise) runs ONCE per invalidation.
    """
    global _stats_cache, _stats_cache_at, _stats_cache_key, _stats_cache_rebuild_lock
    d = _resolve_recordings_dir()
    now = time.monotonic()

    # BUG-51 (same reasoning as list_recordings): the O(N) stat probe
    # belongs on a worker thread, not the event loop.
    cache_key = await asyncio.to_thread(_recordings_scan_cache_key, d)

    with _recordings_caches_lock:
        if (
            _stats_cache is not None
            and _stats_cache_key == cache_key
            and (now - _stats_cache_at) < _STATS_CACHE_TTL
        ):
            return _stats_cache

    if _stats_cache_rebuild_lock is None:
        _stats_cache_rebuild_lock = asyncio.Lock()

    async with _stats_cache_rebuild_lock:
        now = time.monotonic()
        with _recordings_caches_lock:
            if (
                _stats_cache is not None
                and _stats_cache_key == cache_key
                and (now - _stats_cache_at) < _STATS_CACHE_TTL
            ):
                return _stats_cache
        result = await asyncio.to_thread(_build_recordings_stats_payload, d)
        with _recordings_caches_lock:
            _stats_cache = result
            _stats_cache_at = time.monotonic()
            _stats_cache_key = cache_key
        return result


@app.post("/api/recordings/save")
def save_recording(
    payload: dict = Body(...),
    _auth: None = Depends(_require_api_auth),
):
    raw_existing_name = str(payload.get("name") or "").strip()
    existing_name = _recording_text_name_leaf(raw_existing_name) if raw_existing_name else ""
    archive_dir = str(payload.get("archive_dir") or "").strip()
    recording_collection = _normalize_recording_collection(payload.get("recording_collection") or "")
    require_existing = _payload_bool(payload, "require_existing", False)
    title = _sanitize_name(str(payload.get("title") or "recording"))
    source_text = str(payload.get("source_text") or "").strip()
    transcript_text = str(payload.get("transcript_text") or "").strip()
    provider = str(payload.get("provider") or "").strip()
    model = str(payload.get("model") or "").strip()
    language = str(payload.get("language") or "").strip()
    source_text = _placeholder_source_text(source_text, transcript_text, provider)

    target_dir = _resolve_recordings_collection_target_dir(
        archive_dir,
        collection=recording_collection,
        create=not require_existing,
    )
    claimed_new_text = False
    if existing_name:
        out = target_dir / existing_name
        if require_existing and not out.exists():
            raise HTTPException(status_code=409, detail="recording no longer exists in the target archive")
    else:
        if require_existing:
            raise HTTPException(status_code=400, detail="require_existing needs an existing recording name")
        _stem, out = _claim_recording_text_path(target_dir, _recording_stem_candidates(title))
        claimed_new_text = True
    try:
        _write_recording_text_file(
            out=out,
            title=title,
            source_text=source_text,
            transcript_text=transcript_text,
            provider=provider,
            model=model,
            language=language,
        )
    except Exception:
        if claimed_new_text:
            _best_effort_unlink(out, context="recording save rollback")
            _release_recording_text_claim(out, "recording save rollback")
        raise
    # Register only after durable user data exists. A failed save should
    # not pollute the archive registry with an empty or invalid target dir.
    _register_archive_dir(target_dir)
    _invalidate_recordings_cache()
    return {"ok": True, "name": out.name, "archive_dir": str(target_dir)}


async def _save_recording_audio_source(
    *,
    orig_name: str,
    write_tmp_audio: Callable[[Path], Awaitable[Any]],
    name: str = "",
    archive_dir: str = "",
    recording_collection: str = "",
    require_existing: bool = False,
    title: str = "recording",
    source_text: str = "",
    transcript_text: str = "",
    provider: str = "",
    model: str = "",
    language: str = "",
    live_session_id: str = "",
) -> dict[str, Any]:
    raw_existing_name = str(name or "").strip()
    existing_name = _recording_text_name_leaf(raw_existing_name) if raw_existing_name else ""
    safe_title = _sanitize_name(str(title or "recording"))
    safe_source_text = str(source_text or "").strip()
    safe_transcript_text = str(transcript_text or "").strip()
    safe_provider = str(provider or "").strip()
    safe_model = str(model or "").strip()
    safe_language = str(language or "").strip()
    safe_source_text = _placeholder_source_text(
        safe_source_text, safe_transcript_text, safe_provider
    )

    safe_orig_name = _normalize_filename(orig_name or "recording.wav")
    _validate_audio_filename(safe_orig_name)
    ext = Path(safe_orig_name).suffix.lower() or ".wav"
    source_file_name = _source_recording_display_name(safe_orig_name)

    target_dir = _resolve_recordings_collection_target_dir(
        archive_dir,
        collection=recording_collection,
        create=not bool(require_existing),
    )
    claimed_new_text = False
    if existing_name:
        stem = Path(existing_name).stem
        text_name = existing_name
        if require_existing and not (target_dir / existing_name).exists():
            raise HTTPException(status_code=409, detail="recording no longer exists in the target archive")
    else:
        if require_existing:
            raise HTTPException(status_code=400, detail="require_existing needs an existing recording name")
        stem, out_text = _claim_recording_text_path(
            target_dir,
            _recording_stem_candidates_for_source_file(safe_orig_name, safe_title),
        )
        text_name = out_text.name
        claimed_new_text = True

    if existing_name:
        out_text = target_dir / text_name
    out_audio = target_dir / f"{stem}{ext}"
    tmp_audio = _atomic_temp_path(out_audio)
    existing_audio = _recording_audio_path(f"{stem}.txt", target_dir=target_dir)
    # Backup the pre-existing audio at out_audio (if any) so the
    # text-write-failure rollback can restore it instead of destroying
    # user data on the edit-existing-recording path. The rollback
    # previously did `out_audio.unlink()` unconditionally, which for
    # the edit path erased audio the user ALREADY had.
    audio_backup: Optional[Path] = None
    if out_audio.exists():
        try:
            # Use the canonical ``.tmp-<hex>`` convention so a crash
            # between the rename and the rollback's cleanup is handled
            # automatically by ``_sweep_orphan_tmp_files`` on next boot.
            # The previous ``.backup-<hex>`` form was NOT matched by
            # ``_TMP_ORPHAN_RE`` — every crashed save_with_audio left a
            # permanent backup of the prior audio on disk forever.
            audio_backup = out_audio.with_name(f"{out_audio.name}.tmp-{uuid.uuid4().hex}")
            os.replace(out_audio, audio_backup)
        except OSError as backup_err:
            logger.warning(
                "recording audio backup failed for %s: %s",
                out_audio,
                backup_err,
            )
            raise HTTPException(
                status_code=500,
                detail="could not preserve existing recording audio before replacement",
            ) from backup_err
    new_audio_placed = False
    save_completed = False
    try:
        await write_tmp_audio(tmp_audio)
        atomic_promote_file(tmp_audio, out_audio)
        new_audio_placed = True
        _write_recording_text_file(
            out=out_text,
            title=safe_title,
            source_file=source_file_name,
            source_text=safe_source_text,
            transcript_text=safe_transcript_text,
            provider=safe_provider,
            model=safe_model,
            language=safe_language,
        )
        save_completed = True
    except BaseException:
        # Any failure after the prior audio backup was moved aside must
        # restore it. This covers write_tmp_audio/os.replace failures as
        # well as text-write failures.
        if new_audio_placed:
            _best_effort_unlink(out_audio, context="recording audio save rollback")
        if audio_backup is not None and audio_backup.exists():
            try:
                os.replace(audio_backup, out_audio)
                audio_backup = None
            except OSError as restore_err:
                logger.warning("audio rollback restore failed; backup left at %s: %s", audio_backup, restore_err)
        if claimed_new_text:
            _best_effort_unlink(out_text, context="recording text save rollback")
            # The CLAIM marker is what reserves the name; releasing only
            # the text file leaves the reservation standing forever. On
            # this path the text file may never have been created at all
            # — ``write_tmp_audio`` raises before it — so the unlink
            # above is a no-op and the marker was the whole rollback.
            # Left behind it costs the user twice: an undeletable file in
            # their recordings folder (the archive is only registered
            # after a SUCCESSFUL save, so the sweeper never looks there),
            # and every retry of the same title pushed to a timestamped
            # name because ``_claim_recording_text_path`` sees the marker.
            _release_recording_text_claim(
                out_text, "recording text claim rollback"
            )
        raise
    finally:
        _best_effort_unlink(tmp_audio, context="recording tmp audio cleanup")
        # Remove any orphaned backup after a successful save. The
        # backup only survives here on the happy path (no rollback).
        if save_completed and audio_backup is not None and audio_backup.exists():
            _best_effort_unlink(audio_backup, context="recording audio backup cleanup")
    if existing_audio is not None and existing_audio.resolve() != out_audio.resolve():
        _best_effort_unlink(existing_audio, context="recording superseded audio cleanup")
    # Persist this dir only after transcript + audio are durable so startup
    # retroactive retention does not learn failed/empty archive targets.
    _register_archive_dir(target_dir)
    # Audio retention, per the collection's own policy (voice notes keep
    # the newest N, uploaded media ages out); transcripts stay forever.
    # The stem we just wrote is exempt — a save must never be able to
    # delete its own audio — but it still counts toward a count limit.
    pruned = _prune_recording_audio(target_dir, keep_stems=(stem,))
    _invalidate_recordings_cache()
    # Atomically discard the live recovery spool now that the audio is
    # safely on disk. This closes the race window between a successful
    # save and the separate /api/live/recoveries/{id}/discard call that
    # the frontend makes — if the app crashes between those two events,
    # the recovery would otherwise be promoted at next startup and create
    # a duplicate archive entry.
    # Only delete a recovery when the client actually supplied a session
    # id. _normalize_live_session_id would otherwise mint a fresh uuid4,
    # and while the subsequent _delete_live_recovery no-ops for a
    # non-existent session, the contract should be explicit: empty ⇒
    # skip.  This also closes a vanishingly small but real risk that the
    # fresh uuid collides with a concurrent live recovery and nukes it.
    raw_sid = str(live_session_id or "").strip()
    if raw_sid and LIVE_SESSION_ID_RE.fullmatch(raw_sid):
        _safe_delete_live_recovery(raw_sid)
    return {
        "ok": True,
        "name": out_text.name,
        "audio_name": out_audio.name,
        "archive_dir": str(target_dir),
        "pruned_audio_count": pruned,
    }


@app.post("/api/recordings/save-with-audio")
async def save_recording_with_audio(
    _auth: None = Depends(_require_api_auth),
    file: UploadFile = File(...),
    name: str = Form(""),
    archive_dir: str = Form(""),
    recording_collection: str = Form(""),
    require_existing: bool = Form(False),
    title: str = Form("recording"),
    source_text: str = Form(""),
    transcript_text: str = Form(""),
    provider: str = Form(""),
    model: str = Form(""),
    language: str = Form(""),
    live_session_id: str = Form(""),
):
    orig_name = _normalize_filename(file.filename or "recording.wav")
    return await _save_recording_audio_source(
        orig_name=orig_name,
        write_tmp_audio=lambda tmp_audio: _save_upload_file(file, tmp_audio),
        name=_form_text(name, ""),
        archive_dir=_form_text(archive_dir, ""),
        recording_collection=_form_text(recording_collection, ""),
        require_existing=_form_bool(require_existing, False),
        title=_form_text(title, "recording"),
        source_text=_form_text(source_text, ""),
        transcript_text=_form_text(transcript_text, ""),
        provider=_form_text(provider, ""),
        model=_form_text(model, ""),
        language=_form_text(language, ""),
        live_session_id=_form_text(live_session_id, ""),
    )


@app.post("/api/recordings/save-from-path")
async def save_recording_from_path(
    payload: dict = Body(...),
    _auth: None = Depends(_require_api_auth),
):
    source_path = await asyncio.to_thread(
        _resolve_source_media_path,
        (payload or {}).get("source_path") or (payload or {}).get("path"),
    )

    async def write_tmp_audio(tmp_audio: Path) -> None:
        await asyncio.to_thread(_copy_source_media_file, source_path, tmp_audio)

    consume_source_path = _payload_bool(payload, "consume_source_path", False)
    result = await _save_recording_audio_source(
        orig_name=_normalize_filename(_source_media_original_name(source_path)),
        write_tmp_audio=write_tmp_audio,
        name=str((payload or {}).get("name") or ""),
        archive_dir=str((payload or {}).get("archive_dir") or ""),
        recording_collection=str((payload or {}).get("recording_collection") or ""),
        require_existing=_payload_bool(payload, "require_existing", False),
        title=str((payload or {}).get("title") or "recording"),
        source_text=str((payload or {}).get("source_text") or ""),
        transcript_text=str((payload or {}).get("transcript_text") or ""),
        provider=str((payload or {}).get("provider") or ""),
        model=str((payload or {}).get("model") or ""),
        language=str((payload or {}).get("language") or ""),
        live_session_id="",
    )
    if consume_source_path and _is_backend_owned_upload_path(source_path):
        _best_effort_unlink(source_path, context="recording consumed upload source cleanup")
    return result
