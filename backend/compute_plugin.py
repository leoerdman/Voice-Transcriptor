"""Delegated compute: a local plugin process performs the transcription.

The app's own engine is CPU-only faster-whisper (``backend/transcribe.py``).
A machine that can do better â€” a GPU, a different runtime â€” plugs in here:
the app launches one child process and speaks the line-delimited JSON of
``docs/COMPUTE_PLUGIN.md`` to it, protocol ``transcriptor-compute/1``.

This module owns the whole seam, so nothing else in the app knows a plugin
exists:

* **No plugin configured** â†’ :func:`delegate_transcribe` returns ``None``
  immediately; the caller keeps its own engine. Zero cost on every machine
  that has no plugin.
* **Any failure** â€” a missing executable, a broken handshake, a crash, a
  timeout, a malformed answer â€” is contained here: the failure is logged
  once, the process is killed, and the seam cools down for
  :data:`_FAIL_COOLDOWN_SEC` before it is tried again. The caller still
  gets ``None`` and falls back to the local engine, so a bad plugin costs
  one slow transcription, never a failed one.

The audio contract is a path to a **16 kHz mono PCM WAV**, the same shape
the app already produces internally; array input is written to a temporary
file by the caller.
"""

import collections
import json
import logging
import os
import queue
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# The one protocol this build speaks. A plugin answering any other major
# is refused, which is what makes the seam stable across plugin releases.
PROTOCOL = "transcriptor-compute/1"

_ENV_PLUGIN = "TRANSCRIPTOR_COMPUTE_PLUGIN"
_ENV_ARGS = "TRANSCRIPTOR_COMPUTE_PLUGIN_ARGS"
_ENV_TIMEOUT = "TRANSCRIPTOR_COMPUTE_PLUGIN_TIMEOUT_SEC"

_DEFAULT_TIMEOUT_SEC = 120.0
_FAIL_COOLDOWN_SEC = 30.0
# A plugin that dies this many times in a row is not retried until the
# cooldown above expires; one crash must not become a spawn storm.
_MAX_CONSECUTIVE_FAILURES = 1


class ComputePluginError(RuntimeError):
    """The plugin refused, crashed, or answered out of contract."""


def _env_json_list(name: str) -> List[str]:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except ValueError:
        logger.warning("%s is not JSON; ignoring it", name)
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        logger.warning("%s must be a JSON array of strings; ignoring it", name)
        return []
    return value


def _env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("invalid number env %s=%r; using %s", name, raw, default)
        return default
    return value if value > 0 else default


class ComputePlugin:
    """One plugin process, one request at a time, every failure contained."""

    def __init__(self, argv: List[str], timeout_sec: float) -> None:
        self._argv = list(argv)
        self._timeout_sec = float(timeout_sec)
        self._host = _host_descriptor(self._timeout_sec)
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._lines: "queue.Queue[Optional[str]]" = queue.Queue()
        self._reader: Optional[threading.Thread] = None
        self._stderr_tail: "collections.deque[str]" = collections.deque(maxlen=40)
        self._hello: Optional[Dict[str, Any]] = None
        self._cooldown_until = 0.0
        self._failures = 0
        self._served_once = False

    # ---- lifecycle -----------------------------------------------------

    @property
    def argv(self) -> List[str]:
        return list(self._argv)

    def available(self) -> bool:
        return bool(self._argv) and time.monotonic() >= self._cooldown_until

    def hello(self) -> Optional[Dict[str, Any]]:
        """The handshake answer, or ``None`` when the plugin is unusable."""
        if not self.available():
            return None
        with self._lock:
            try:
                self._ensure_locked()
            except ComputePluginError as exc:
                self._fail_locked(str(exc))
                return None
            return dict(self._hello or {})

    def close(self) -> None:
        with self._lock:
            self._stop_locked()

    # ---- work ----------------------------------------------------------

    def transcribe(
        self,
        wav_path: str,
        model_name: str,
        language: Optional[str],
        vad_filter: bool,
        word_timestamps: bool,
        beam_size: int,
        best_of: int,
    ) -> Optional[Dict[str, Any]]:
        """The plugin's result, or ``None`` when it is unavailable or broken."""
        if not self.available():
            return None
        request = {
            "op": "transcribe",
            "audio": os.path.abspath(wav_path),
            "model": model_name,
            "language": language or "auto",
            "vad_filter": bool(vad_filter),
            "word_timestamps": bool(word_timestamps),
            "beam_size": int(beam_size),
            "best_of": int(best_of),
        }
        with self._lock:
            try:
                self._ensure_locked()
                answer = self._call_locked(request)
                result = _normalize_result(answer, word_timestamps)
            except ComputePluginError as exc:
                self._fail_locked(str(exc))
                return None
        if not self._served_once:
            # One line per process, on the only path that proves the seam is
            # live: an installation (or a reader) can tell a working plugin
            # from a silent fallback without a second instrument.
            self._served_once = True
            logger.info(
                "compute plugin served: device=%s models=%s",
                (self._hello or {}).get("device") or "?",
                ",".join(self._hello.get("models") or []) or "?",
            )
        return result

    # ---- internals -----------------------------------------------------

    def _ensure_locked(self) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        if self._process is not None:
            self._stop_locked()
        self._process = self._spawn_locked()
        # The host's configuration travels with the handshake and travels
        # ONE WAY: the plugin is told what the audio is, what ids it will
        # be asked for, and what deadline it has; nothing it answers is
        # applied back. It cannot change the host, only refuse or comply.
        hello = self._call_locked({"op": "hello", "host": dict(self._host)})
        protocol = str(hello.get("protocol") or "")
        if not protocol.startswith(PROTOCOL):
            raise ComputePluginError(
                "plugin speaks %r, this build speaks %r" % (protocol, PROTOCOL)
            )
        self._hello = hello

    def _spawn_locked(self) -> subprocess.Popen:
        creationflags = 0
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        # The protocol is UTF-8 on both sides. A Python plugin run on Windows
        # would otherwise encode its stdout with the console code page and
        # die on the first non-ASCII transcription (measured: cp1252 there);
        # a plugin in another language is unaffected by these two variables.
        environment = dict(os.environ)
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["PYTHONUTF8"] = "1"
        try:
            process = subprocess.Popen(
                self._argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                bufsize=1,
                creationflags=creationflags,
                env=environment,
            )
        except OSError as exc:
            raise ComputePluginError("plugin did not start: %s" % exc)
        self._lines = queue.Queue()
        self._stderr_tail = collections.deque(maxlen=40)
        reader = threading.Thread(
            target=_pump_lines,
            args=(process.stdout, self._lines),
            name="compute-plugin-reader",
            daemon=True,
        )
        reader.start()
        self._reader = reader
        if process.stderr is not None:
            drain = threading.Thread(
                target=_drain_stderr,
                args=(process.stderr, self._stderr_tail),
                name="compute-plugin-stderr",
                daemon=True,
            )
            drain.start()
        return process

    def _call_locked(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        process = self._process
        if process is None or process.stdin is None:
            raise ComputePluginError("plugin is not running")
        if process.poll() is not None:
            raise ComputePluginError("plugin exited with %s" % process.returncode)
        try:
            process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            process.stdin.flush()
        except (OSError, ValueError) as exc:
            raise ComputePluginError("plugin stdin closed: %s" % exc)
        deadline = time.monotonic() + self._timeout_sec
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ComputePluginError(
                    "no answer to %r within %.0fs" % (payload.get("op"), self._timeout_sec)
                )
            try:
                line = self._lines.get(timeout=remaining)
            except queue.Empty:
                continue
            if line is None:
                raise ComputePluginError("plugin closed its output")
            if not line.strip():
                continue
            try:
                answer = json.loads(line)
            except ValueError:
                raise ComputePluginError("plugin answered non-JSON: %r" % line[:120])
            if not isinstance(answer, dict):
                raise ComputePluginError("plugin answered %r, not an object" % type(answer).__name__)
            if answer.get("ok") is False and payload.get("op") != "hello":
                raise ComputePluginError("plugin reported: %s" % (answer.get("error") or "no detail"))
            return answer

    def _fail_locked(self, reason: str) -> None:
        self._failures += 1
        if self._failures >= _MAX_CONSECUTIVE_FAILURES:
            self._cooldown_until = time.monotonic() + _FAIL_COOLDOWN_SEC
        stderr_tail = " | ".join(line.strip() for line in list(self._stderr_tail)[-4:] if line.strip())
        logger.warning(
            "compute plugin unusable (%s); local engine takes over for %.0fs%s",
            reason,
            _FAIL_COOLDOWN_SEC if self._failures >= _MAX_CONSECUTIVE_FAILURES else 0,
            ("; plugin stderr: " + stderr_tail) if stderr_tail else "",
        )
        self._stop_locked()

    def _stop_locked(self) -> None:
        process, self._process = self._process, None
        self._hello = None
        if process is None:
            return
        stdin = process.stdin
        if stdin is not None:
            try:
                stdin.write(json.dumps({"op": "shutdown"}) + "\n")
                stdin.flush()
            except (OSError, ValueError):
                pass
            try:
                stdin.close()
            except (OSError, ValueError):
                pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        for stream in (process.stdout, process.stderr):
            if stream is None:
                continue
            try:
                stream.close()
            except (OSError, ValueError):
                pass


def _host_descriptor(timeout_sec: float) -> Dict[str, Any]:
    """What the host dictates to the plugin — facts, never settings to echo back.

    Every value comes from the module that already owns it: the audio
    contract from ``backend.audio_constants`` (the same constants the WAV
    writer and the live ring obey) and the ids from
    ``backend.model_catalog`` (the same catalog the API validates against).
    A plugin that reads this knows exactly what it will receive; there is
    no second place for the host to describe itself.
    """
    from backend.audio_constants import LIVE_PCM_BYTES_PER_SEC, LIVE_SAMPLE_RATE_HZ
    from backend.model_catalog import (
        DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
        WHISPER_LOCAL_MODELS,
    )

    return {
        "protocol": PROTOCOL,
        "audio": {
            "sample_rate_hz": LIVE_SAMPLE_RATE_HZ,
            "channels": 1,
            "sample_format": "pcm_s16le",
            "bytes_per_second": LIVE_PCM_BYTES_PER_SEC,
        },
        # Whisper ids only: a GigaAM id is answered by the built-in engine
        # before this seam is reached, so promising it here would describe
        # a request the plugin can never receive.
        "models": list(WHISPER_LOCAL_MODELS),
        "default_model": DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
        "capabilities": {"word_timestamps": True, "language_auto": True},
        "timeout_sec": float(timeout_sec),
    }


def _pump_lines(stream, sink: "queue.Queue[Optional[str]]") -> None:
    """Feed the plugin's stdout lines to a queue; ``None`` marks EOF."""
    try:
        for line in stream:
            sink.put(line)
    except (OSError, ValueError):
        pass
    finally:
        sink.put(None)


def _drain_stderr(stream, tail: "collections.deque[str]") -> None:
    """Keep the last lines of the plugin's stderr for the failure log.

    Drained even though nothing reads it during a healthy run: a plugin that
    logs to a full pipe would block forever, which reads as a hang.
    """
    try:
        for line in stream:
            tail.append(line)
    except (OSError, ValueError):
        pass


def _normalize_result(answer: Dict[str, Any], word_timestamps: bool) -> Dict[str, Any]:
    """The app's result shape, from the plugin's, refusing what it cannot use."""
    segments_in = answer.get("segments")
    if not isinstance(segments_in, list):
        raise ComputePluginError("plugin answered without a segments list")
    segments: List[Dict[str, Any]] = []
    parts: List[str] = []
    for raw in segments_in:
        if not isinstance(raw, dict):
            raise ComputePluginError("plugin answered a non-object segment")
        text = str(raw.get("text") or "").strip()
        start = _as_float(raw.get("start"), "segment.start")
        end = _as_float(raw.get("end"), "segment.end")
        segment: Dict[str, Any] = {"start": start, "end": end, "text": text}
        if word_timestamps and isinstance(raw.get("words"), list):
            segment["words"] = [
                {
                    "start": _as_float(word.get("start"), "word.start"),
                    "end": _as_float(word.get("end"), "word.end"),
                    "word": str(word.get("word") or ""),
                    "prob": None if word.get("prob") is None else _as_float(word.get("prob"), "word.prob"),
                }
                for word in raw["words"]
                if isinstance(word, dict)
            ]
        segments.append(segment)
        if text:
            parts.append(text)
    text = answer.get("text")
    if not isinstance(text, str) or not text.strip():
        text = " ".join(parts).strip()
    return {
        "language": answer.get("language"),
        "language_probability": _as_float(answer.get("language_probability"), "language_probability", 0.0),
        "duration": _as_float(answer.get("duration"), "duration", 0.0),
        "segments": segments,
        "text": text.strip(),
    }


def _as_float(value: Any, name: str, default: Optional[float] = None) -> float:
    if value is None:
        if default is None:
            raise ComputePluginError("plugin answered without %s" % name)
        return float(default)
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ComputePluginError("plugin answered %s=%r, not a number" % (name, value))


_PLUGIN_LOCK = threading.Lock()
_PLUGIN: Optional[ComputePlugin] = None
_PLUGIN_KEY: Optional[tuple] = None


def _configured() -> ComputePlugin:
    """The process-wide plugin, rebuilt when the environment changes it."""
    global _PLUGIN, _PLUGIN_KEY
    argv = [(os.environ.get(_ENV_PLUGIN) or "").strip()]
    if argv[0]:
        argv = [shutil.which(argv[0]) or argv[0]]
    argv += _env_json_list(_ENV_ARGS)
    timeout_sec = _env_float(_ENV_TIMEOUT, _DEFAULT_TIMEOUT_SEC)
    key = (tuple(argv), timeout_sec)
    with _PLUGIN_LOCK:
        if _PLUGIN is None or _PLUGIN_KEY != key:
            if _PLUGIN is not None:
                _PLUGIN.close()
            _PLUGIN = ComputePlugin(argv if argv[0] else [], timeout_sec)
            _PLUGIN_KEY = key
        return _PLUGIN


def delegate_available() -> bool:
    """Whether a plugin is configured and not cooling down after a failure."""
    try:
        return _configured().available()
    except Exception:  # a seam must never break the caller
        logger.exception("compute plugin configuration failed")
        return False


def delegate_transcribe(
    wav_path: str,
    model_name: str,
    language: Optional[str] = None,
    vad_filter: bool = True,
    word_timestamps: bool = False,
    beam_size: int = 1,
    best_of: int = 1,
) -> Optional[Dict[str, Any]]:
    """Transcribe through the configured plugin, or ``None`` to use the local engine."""
    if not delegate_available():
        return None
    try:
        return _configured().transcribe(
            wav_path,
            model_name,
            language,
            vad_filter,
            word_timestamps,
            beam_size,
            best_of,
        )
    except Exception:
        logger.exception("compute plugin delegation failed; using the local engine")
        return None


def reset_for_tests() -> None:
    """Drop the cached plugin so the next call reads the environment again."""
    global _PLUGIN, _PLUGIN_KEY
    with _PLUGIN_LOCK:
        if _PLUGIN is not None:
            _PLUGIN.close()
        _PLUGIN = None
        _PLUGIN_KEY = None
