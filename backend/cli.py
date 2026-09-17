#!/usr/bin/env python3
"""The command-line client — the app's transcriber, reachable from a shell.

Any program that can run a command can use Transcriptor through this:
give it an audio or video file, get the text. It is the same pipeline
the Upload tab drives — same engines, same models, same archive — asked
for over the same HTTP API the renderer uses, with a token of its own.

It talks to a RUNNING app. There is no second backend here: the app owns
the models, the provider keys, the job queue and the archive, and this
file is a client. When the app is not running, or command-line access is
switched off, every command says so and exits non-zero rather than doing
half the job somewhere else.

    transcriptor transcribe talk.mp4            # wait, print the text
    transcriptor transcribe talk.mp4 --out t.txt --save
    transcriptor submit talk.mp4                # queue it, print the id
    transcriptor status <job-id>
    transcriptor result <job-id> --json --out t.json
    transcriptor cancel <job-id>
    transcriptor info                           # address, defaults, engines

Two rules shape the code below.

STANDARD LIBRARY ONLY, and a cold start measured in milliseconds. This
runs inside someone else's shell loop, possibly once per file over a
directory, and an agent that has to wait a second for ``--help`` will
stop reaching for it. So: no ``requests``, no import of
``backend.config`` (which pulls in the crypto stack and creates
directories as a side effect) — only ``backend.data_dir``, which is the
data-directory rule and nothing else.

STDOUT IS THE TRANSCRIPT. Progress, warnings and errors go to stderr,
the transcript alone goes to stdout, and the exit code says what
happened. ``$(transcriptor transcribe x.mp4)`` is therefore the text,
with nothing to strip — the property that makes this usable from a
script or an agent without parsing prose.

Exit codes:

    0   done
    1   the job failed, or the app refused the request
    2   the command line itself was wrong
    3   the app is not reachable, or command-line access is off
    4   the job was cancelled
    130 interrupted (Ctrl-C); a job already queued is cancelled first
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

try:  # Run as ``python -m backend.cli`` — the package is importable.
    from backend.data_dir import default_data_dir
except ImportError:  # Run as ``python /abs/path/backend/cli.py`` — it is not.
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from backend.data_dir import default_data_dir

PROGRAM = "transcriptor"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_UNREACHABLE = 3
EXIT_CANCELLED = 4
EXIT_INTERRUPTED = 130

#: How often the client asks the app how a job is doing. Half a second
#: is below the threshold where a progress bar looks stuck and far above
#: anything the backend's rate limit (1200/min) minds.
POLL_INTERVAL_SEC = 0.5
#: Per-request socket timeout. Job creation is the slow one: the backend
#: copies and verifies the source file before answering, which for a
#: multi-gigabyte video is minutes, not seconds.
REQUEST_TIMEOUT_SEC = 900.0
#: The status poll asks a tiny question and must not hang on a wedged
#: socket for a quarter of an hour.
POLL_TIMEOUT_SEC = 30.0

TERMINAL_STATUSES = frozenset({"done", "error", "cancelled"})


class CliError(Exception):
    """Anything the user can act on. Carries the exit code to use."""

    def __init__(self, message: str, code: int = EXIT_FAILED) -> None:
        super().__init__(message)
        self.code = code


# ── connection ──────────────────────────────────────────────────────


class Connection:
    """Where the app is and how to prove we may call it."""

    def __init__(self, base_url: str, token: str, source: str = "") -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.source = source


def default_connection_path() -> Path:
    return default_data_dir() / "cli" / "connection.json"


def load_connection(
    connection_file: str = "",
    base_url: str = "",
    token: str = "",
) -> Connection:
    """Resolve the address and token, explicit flags first.

    ``--base-url``/``--token`` exist for the case the connection file
    cannot cover: a wrapper invoked from another machine's shell, a test
    harness, an app started with ``TRANSCRIPTOR_API_TOKEN``. Given both,
    the file is not read at all — so a stale file cannot quietly win
    over what the command said.
    """
    if base_url and token:
        return Connection(base_url, token, source="--base-url/--token")
    path = Path(connection_file).expanduser() if connection_file else default_connection_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise CliError(
            f"command-line access is off (no {path}).\n"
            "Open Transcriptor → Settings → Command line and switch it on.",
            EXIT_UNREACHABLE,
        ) from None
    except OSError as e:
        raise CliError(f"cannot read {path}: {e}", EXIT_UNREACHABLE) from None
    try:
        data = json.loads(raw)
    except ValueError:
        raise CliError(
            f"{path} is not valid JSON. Switch command-line access off and on "
            "again in Transcriptor → Settings → Command line to rewrite it.",
            EXIT_UNREACHABLE,
        ) from None
    if not isinstance(data, dict):
        raise CliError(f"{path} does not hold a connection object", EXIT_UNREACHABLE)
    resolved_url = base_url or str(data.get("base_url") or "").strip()
    resolved_token = token or str(data.get("token") or "").strip()
    if not resolved_url or not resolved_token:
        raise CliError(
            f"{path} is incomplete (base_url and token are both required). "
            "Switch command-line access off and on again in Transcriptor.",
            EXIT_UNREACHABLE,
        )
    return Connection(resolved_url, resolved_token, source=str(path))


# ── HTTP ────────────────────────────────────────────────────────────


def _request(
    conn: Connection,
    method: str,
    path: str,
    payload: Optional[dict] = None,
    *,
    timeout: float = REQUEST_TIMEOUT_SEC,
    raw: bool = False,
) -> Any:
    """One HTTP call. Returns parsed JSON, or bytes when *raw*.

    Every failure that reaches the user is translated here, because the
    urllib exception it comes from names none of the three things worth
    knowing: whether the app is running, whether this client is still
    authorised, and what the app said about the request.
    """
    url = f"{conn.base_url}{path}"
    body = None
    headers = {"x-api-token": conn.token, "accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content = resp.read()
    except urllib.error.HTTPError as e:
        detail = _http_error_detail(e)
        if e.code in (401, 403):
            raise CliError(
                f"the app refused this client ({e.code}): {detail}\n"
                "Command-line access may have been switched off or re-issued. "
                "Open Transcriptor → Settings → Command line and switch it on again.",
                EXIT_UNREACHABLE,
            ) from None
        raise CliError(f"{method} {path} failed ({e.code}): {detail}", EXIT_FAILED) from None
    except urllib.error.URLError as e:
        raise CliError(
            f"cannot reach Transcriptor at {conn.base_url} ({e.reason}).\n"
            "Start the app, or check Settings → Command line for its current address.",
            EXIT_UNREACHABLE,
        ) from None
    except TimeoutError:
        raise CliError(
            f"Transcriptor did not answer within {timeout:.0f}s ({method} {path})",
            EXIT_UNREACHABLE,
        ) from None
    if raw:
        return content
    if not content:
        return {}
    try:
        return json.loads(content.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise CliError(f"{method} {path} returned a body that is not JSON", EXIT_FAILED) from None


def _http_error_detail(e: urllib.error.HTTPError) -> str:
    """FastAPI's ``detail``, when the error body carries one."""
    try:
        payload = json.loads(e.read().decode("utf-8"))
    except Exception:
        return e.reason or "no detail"
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
        if detail is not None:
            return json.dumps(detail, ensure_ascii=False)
    return e.reason or "no detail"


# ── the app's own defaults ──────────────────────────────────────────


def fetch_settings(conn: Connection) -> dict:
    payload = _request(conn, "GET", "/api/cli", timeout=POLL_TIMEOUT_SEC)
    return payload if isinstance(payload, dict) else {}


def resolve_job_options(args: argparse.Namespace, settings: dict) -> dict:
    """What to transcribe with: the command's words over the app's.

    Anything the command did not say is taken from ``/api/cli``, which
    reports what the Upload tab would do right now. That is the whole
    reason the endpoint exists: a bare ``transcribe file.mp4`` must
    produce what the user would get by dropping the file into the app,
    not what this file happens to hardcode.
    """
    defaults = settings.get("defaults") if isinstance(settings, dict) else None
    defaults = defaults if isinstance(defaults, dict) else {}
    engines = [str(e) for e in (defaults.get("engines") or []) if str(e).strip()]
    engine = str(args.engine or defaults.get("engine") or "local").strip()
    if engines and engine not in engines:
        raise CliError(
            f"unknown engine {engine!r}; this app offers: {', '.join(engines)}",
            EXIT_USAGE,
        )
    model = str(args.model or "").strip()
    if not model and engine == str(defaults.get("engine") or ""):
        # Only inherit the app's model when the engine is also the
        # app's. A Deepgram model id means nothing to Whisper, and
        # sending one produces a 400 the user did not ask for; leaving
        # it empty lets the backend pick that engine's own default.
        model = str(defaults.get("model") or "").strip()
    language = str(args.language or defaults.get("language") or "auto").strip() or "auto"
    diarize = bool(args.diarize) if args.diarize is not None else bool(defaults.get("diarize"))
    return {
        "engine": engine,
        "model": model,
        "language": language,
        "diarize": diarize,
    }


# ── jobs ────────────────────────────────────────────────────────────


def resolve_source_path(value: str) -> str:
    """Absolute, existing, readable — checked here so the error is local.

    The backend re-checks all of this (it owns the trust boundary), but
    a typo'd filename should not become an HTTP round trip and a 404
    phrased for a renderer. It should say the file is not there.
    """
    raw = str(value or "").strip()
    if not raw:
        raise CliError("a file is required", EXIT_USAGE)
    path = Path(raw).expanduser()
    try:
        resolved = path.resolve()
    except OSError as e:
        raise CliError(f"{raw}: {e}", EXIT_USAGE) from None
    if not resolved.exists():
        raise CliError(f"{resolved}: no such file", EXIT_USAGE)
    if not resolved.is_file():
        raise CliError(f"{resolved}: not a file", EXIT_USAGE)
    return str(resolved)


def create_job(conn: Connection, source_path: str, options: dict, args: argparse.Namespace) -> dict:
    """Queue the file. Returns the backend's ``{job_id, audio_source_path}``."""
    engine = options["engine"]
    if engine == "local":
        payload: dict[str, Any] = {
            "source_path": source_path,
            "language": options["language"],
            "split_stereo": not args.no_split_stereo,
            "word_timestamps": bool(args.word_timestamps),
        }
        if options["model"]:
            payload["model"] = options["model"]
        route = "/api/jobs/from-path"
    else:
        payload = {
            "source_path": source_path,
            "provider": engine,
            "language": options["language"],
            "diarize": options["diarize"],
        }
        if options["model"]:
            payload["model"] = options["model"]
        if args.speakers:
            payload["num_speakers"] = str(args.speakers)
        route = "/api/remote/jobs/from-path"
    created = _request(conn, "POST", route, payload)
    job_id = str((created or {}).get("job_id") or "").strip()
    if not job_id:
        raise CliError("the app accepted the file but returned no job id", EXIT_FAILED)
    return {
        "job_id": job_id,
        "audio_source_path": str((created or {}).get("audio_source_path") or ""),
    }


def get_job(conn: Connection, job_id: str) -> dict:
    payload = _request(conn, "GET", f"/api/jobs/{job_id}", timeout=POLL_TIMEOUT_SEC)
    return payload if isinstance(payload, dict) else {}


def cancel_job(conn: Connection, job_id: str) -> dict:
    payload = _request(conn, "POST", f"/api/jobs/{job_id}/cancel", timeout=POLL_TIMEOUT_SEC)
    return payload if isinstance(payload, dict) else {}


def wait_for_job(
    conn: Connection,
    job_id: str,
    *,
    timeout: float = 0.0,
    on_progress: Optional[Callable[[str, float], None]] = None,
) -> dict:
    """Poll until the job reaches a terminal state, or *timeout* elapses.

    A timeout does NOT cancel the job — it stops waiting. The work is
    the app's and may well be nearly done; the id is printed so the
    caller can come back with ``result``. Cancelling on the caller's
    impatience would throw away a transcription nobody asked to lose.
    """
    started = time.monotonic()
    while True:
        job = get_job(conn, job_id)
        status = str(job.get("status") or "")
        if on_progress is not None:
            try:
                progress = float(job.get("progress") or 0.0)
            except (TypeError, ValueError):
                progress = 0.0
            on_progress(status, progress)
        if status in TERMINAL_STATUSES:
            return job
        if timeout > 0 and (time.monotonic() - started) >= timeout:
            raise CliError(
                f"still {status or 'queued'} after {timeout:.0f}s; the job is still "
                f"running in the app.\nCome back with: {PROGRAM} result {job_id}",
                EXIT_FAILED,
            )
        time.sleep(POLL_INTERVAL_SEC)


def job_result_or_raise(job: dict) -> dict:
    """The finished result, or the reason there isn't one."""
    status = str(job.get("status") or "")
    if status == "error":
        raise CliError(str(job.get("error") or "transcription failed"), EXIT_FAILED)
    if status == "cancelled":
        raise CliError("the job was cancelled", EXIT_CANCELLED)
    if status != "done":
        raise CliError(f"the job is not finished (status: {status or 'unknown'})", EXIT_FAILED)
    result = job.get("result")
    if not isinstance(result, dict):
        raise CliError("the job finished without a result", EXIT_FAILED)
    return result


def fetch_result_bytes(conn: Connection, job_id: str, kind: str) -> bytes:
    """The result file the app wrote, byte for byte.

    Falls back to re-rendering from the job's in-memory result when the
    file is gone — results are swept on a retention timer, and a job
    whose text the app still holds should not answer "file not found".
    """
    try:
        return _request(
            conn, "GET", f"/api/jobs/{job_id}/download/{kind}", timeout=POLL_TIMEOUT_SEC, raw=True
        )
    except CliError as e:
        if e.code != EXIT_FAILED:
            raise
        result = job_result_or_raise(get_job(conn, job_id))
        if kind == "json":
            return (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        return str(result.get("text") or "").encode("utf-8")


# ── output ──────────────────────────────────────────────────────────


def emit(data: bytes, out_path: str, *, what: str, quiet: bool) -> None:
    """Write the deliverable: a file when asked, stdout otherwise."""
    if not out_path:
        sys.stdout.buffer.write(data)
        if data and not data.endswith(b"\n"):
            sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()
        return
    target = Path(out_path).expanduser()
    try:
        if target.parent and not target.parent.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    except OSError as e:
        raise CliError(f"cannot write {target}: {e}", EXIT_FAILED) from None
    if not quiet:
        note(f"{what} written to {target}")


def note(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class Progress:
    """Job progress on stderr, and only where it can be erased.

    A terminal gets a single line rewritten in place. A pipe, a log file
    or a CI job gets nothing at all: ``2>&1`` into a file must not
    accumulate a thousand carriage-returned copies of the same line.
    """

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled and sys.stderr.isatty()
        self._width = 0

    def __call__(self, status: str, progress: float) -> None:
        if not self.enabled:
            return
        pct = max(0, min(100, int(round(progress * 100))))
        line = f"  {status or 'queued'} {pct:3d}%"
        pad = max(0, self._width - len(line))
        self._width = len(line)
        sys.stderr.write("\r" + line + " " * pad)
        sys.stderr.flush()

    def done(self) -> None:
        if not self.enabled or not self._width:
            return
        sys.stderr.write("\r" + " " * self._width + "\r")
        sys.stderr.flush()
        self._width = 0


# ── commands ────────────────────────────────────────────────────────


def cmd_transcribe(conn: Connection, args: argparse.Namespace) -> int:
    source_path = resolve_source_path(args.file)
    settings = fetch_settings(conn)
    options = resolve_job_options(args, settings)
    if not args.quiet:
        engine_label = options["engine"] + (f"/{options['model']}" if options["model"] else "")
        note(f"{Path(source_path).name} → {engine_label} ({options['language']})")
    created = create_job(conn, source_path, options, args)
    job_id = created["job_id"]
    progress = Progress(not args.quiet)
    try:
        job = wait_for_job(conn, job_id, timeout=args.timeout, on_progress=progress)
    except KeyboardInterrupt:
        progress.done()
        _cancel_on_interrupt(conn, job_id)
        return EXIT_INTERRUPTED
    finally:
        progress.done()
    result = job_result_or_raise(job)

    if args.json:
        payload = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        emit(payload.encode("utf-8"), args.out, what="Result", quiet=args.quiet)
    else:
        emit(str(result.get("text") or "").encode("utf-8"), args.out, what="Transcript", quiet=args.quiet)

    if args.save:
        saved = save_to_archive(conn, created, options, result, args)
        if saved and not args.quiet:
            note(f"saved to the archive as {saved}")
    return EXIT_OK


def _cancel_on_interrupt(conn: Connection, job_id: str) -> None:
    """Ctrl-C stops the job too, not just the waiting.

    Without this the process exits and the app keeps decoding a file
    nobody is waiting for — burning a CPU core, or paid provider
    minutes, until it finishes into a result no one will read.
    """
    note("")
    try:
        cancel_job(conn, job_id)
        note(f"cancelled {job_id}")
    except CliError as e:
        note(f"could not cancel {job_id}: {e}")


def save_to_archive(
    conn: Connection,
    created: dict,
    options: dict,
    result: dict,
    args: argparse.Namespace,
) -> str:
    """Put the finished transcription in the app's History.

    Uses the snapshot the backend already made of the source file, and
    consumes it: without ``--save`` that copy is a temp file the app
    sweeps, and with it, it becomes the recording's audio. Nothing is
    re-uploaded, and the user's own file is never touched.
    """
    audio_source_path = str(created.get("audio_source_path") or "")
    if not audio_source_path:
        note("not saved: the app returned no audio snapshot for this job")
        return ""
    title = str(args.title or "").strip() or Path(args.file).stem
    payload = {
        "source_path": audio_source_path,
        "title": title,
        "transcript_text": str(result.get("text") or ""),
        "provider": options["engine"],
        "model": options["model"],
        "language": options["language"],
        "consume_source_path": True,
    }
    try:
        saved = _request(conn, "POST", "/api/recordings/save-from-path", payload)
    except CliError as e:
        # The transcript is already on stdout. Failing to file a copy is
        # worth saying, but it is not worth turning a delivered
        # transcription into a failed command.
        note(f"not saved to the archive: {e}")
        return ""
    return str((saved or {}).get("name") or "")


def cmd_submit(conn: Connection, args: argparse.Namespace) -> int:
    source_path = resolve_source_path(args.file)
    settings = fetch_settings(conn)
    options = resolve_job_options(args, settings)
    created = create_job(conn, source_path, options, args)
    if args.json:
        emit(
            (json.dumps(created, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
            args.out,
            what="Job",
            quiet=args.quiet,
        )
    else:
        emit(created["job_id"].encode("utf-8"), args.out, what="Job id", quiet=args.quiet)
    if not args.quiet:
        note(f"queued. Follow it with: {PROGRAM} result {created['job_id']} --wait")
    return EXIT_OK


def cmd_status(conn: Connection, args: argparse.Namespace) -> int:
    job = get_job(conn, args.job_id)
    if args.json:
        emit((json.dumps(job, ensure_ascii=False, indent=2) + "\n").encode("utf-8"), args.out,
             what="Status", quiet=args.quiet)
        return EXIT_OK
    status = str(job.get("status") or "unknown")
    try:
        pct = int(round(float(job.get("progress") or 0.0) * 100))
    except (TypeError, ValueError):
        pct = 0
    line = f"{status} {pct}%"
    error = str(job.get("error") or "").strip()
    if error:
        line += f" — {error}"
    print(line, flush=True)
    return EXIT_OK


def cmd_result(conn: Connection, args: argparse.Namespace) -> int:
    if args.wait:
        progress = Progress(not args.quiet)
        try:
            job = wait_for_job(conn, args.job_id, timeout=args.timeout, on_progress=progress)
        except KeyboardInterrupt:
            progress.done()
            note("")
            note(f"stopped waiting; {args.job_id} is still running in the app")
            return EXIT_INTERRUPTED
        finally:
            progress.done()
        job_result_or_raise(job)
    else:
        job_result_or_raise(get_job(conn, args.job_id))
    kind = "json" if args.json else "txt"
    data = fetch_result_bytes(conn, args.job_id, kind)
    emit(data, args.out, what="Result" if args.json else "Transcript", quiet=args.quiet)
    return EXIT_OK


def cmd_cancel(conn: Connection, args: argparse.Namespace) -> int:
    job = cancel_job(conn, args.job_id)
    if not args.quiet:
        note(f"{args.job_id}: {job.get('status') or 'cancelled'}")
    return EXIT_OK


def cmd_info(conn: Connection, args: argparse.Namespace) -> int:
    settings = fetch_settings(conn)
    if args.json:
        payload = dict(settings)
        payload["connection_source"] = conn.source
        emit((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
             args.out, what="Info", quiet=args.quiet)
        return EXIT_OK
    defaults = settings.get("defaults") if isinstance(settings, dict) else {}
    defaults = defaults if isinstance(defaults, dict) else {}
    lines = [
        f"app:        {conn.base_url}",
        f"connection: {conn.source}",
        f"engine:     {defaults.get('engine') or '-'}",
        f"model:      {defaults.get('model') or '-'}",
        f"language:   {defaults.get('language') or 'auto'}",
        f"diarize:    {'yes' if defaults.get('diarize') else 'no'}",
        f"engines:    {', '.join(str(e) for e in (defaults.get('engines') or [])) or '-'}",
        f"local:      {', '.join(str(m) for m in (defaults.get('local_models') or [])) or '-'}",
    ]
    print("\n".join(lines), flush=True)
    return EXIT_OK


# ── argument parsing ────────────────────────────────────────────────


def _add_common(parser: argparse.ArgumentParser, *, top_level: bool) -> None:
    """The options that mean the same thing on both sides of the command.

    They are declared TWICE — once on the top-level parser and once on
    every subcommand — because the wrapper the app writes puts
    ``--connection <file>`` before the command word, while a person
    types it after. argparse has no notion of an option that may appear
    on either side, and a subcommand's copy would normally overwrite the
    global one with its own default the moment the subcommand parses.

    ``default=argparse.SUPPRESS`` is what makes the pair safe: the
    subcommand's copy writes to the namespace only when it was actually
    given, so the global value survives, and an option repeated after
    the command wins over one given before it. Only the top-level copy
    carries the real defaults, so there is still exactly one place each
    default is written.
    """
    default = (lambda value: value) if top_level else (lambda _value: argparse.SUPPRESS)
    parser.add_argument("--connection", default=default(""), metavar="FILE",
                        help="connection file written by the app (default: the app's data dir)")
    parser.add_argument("--base-url", default=default(""), metavar="URL",
                        help="the app's address, overriding the connection file")
    parser.add_argument("--token", default=default(""), metavar="TOKEN",
                        help="command-line token, overriding the connection file")
    parser.add_argument("--out", default=default(""), metavar="FILE",
                        help="write the output to FILE instead of stdout")
    parser.add_argument("--json", action="store_true", default=default(False),
                        help="emit the full result as JSON (segments, timings, provider payload)")
    parser.add_argument("--quiet", "-q", action="store_true", default=default(False),
                        help="no progress or notes on stderr")


def _add_job_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--language", "-l", default="", metavar="CODE",
                        help="auto, ru, en, ... (default: whatever the app is set to)")
    parser.add_argument("--engine", default="", metavar="NAME",
                        help="local, deepgram or openrouter (default: the app's)")
    parser.add_argument("--model", default="", metavar="ID",
                        help="engine-specific model id (default: the app's)")
    diarize = parser.add_mutually_exclusive_group()
    diarize.add_argument("--diarize", dest="diarize", action="store_true", default=None,
                         help="label speakers (remote engines)")
    diarize.add_argument("--no-diarize", dest="diarize", action="store_false",
                         help="do not label speakers")
    parser.add_argument("--speakers", default="", metavar="N",
                        help="how many speakers to expect, when diarizing")
    parser.add_argument("--no-split-stereo", action="store_true",
                        help="local engine: transcribe as one channel, not per-channel")
    parser.add_argument("--word-timestamps", action="store_true",
                        help="local engine: per-word timings in the JSON result")
    parser.add_argument("--timeout", type=float, default=0.0, metavar="SEC",
                        help="stop waiting after SEC (the job keeps running; 0 = wait)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROGRAM,
        description=(
            "Transcribe audio and video through the running Transcriptor app. "
            "The transcript goes to stdout; progress and errors go to stderr."
        ),
        epilog=(
            f"examples:\n"
            f"  {PROGRAM} transcribe talk.mp4\n"
            f"  {PROGRAM} transcribe talk.mp4 --engine deepgram --diarize --out talk.txt\n"
            f"  {PROGRAM} submit long-call.wav\n"
            f"  {PROGRAM} result <job-id> --wait --json --out call.json\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    _add_common(parser, top_level=True)
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")

    p = sub.add_parser("transcribe", help="transcribe a file and print the text")
    p.add_argument("file", help="audio or video file")
    _add_common(p, top_level=False)
    _add_job_options(p)
    p.add_argument("--save", action="store_true", help="keep the result in Transcriptor's History")
    p.add_argument("--title", default="", metavar="TEXT", help="title to save it under (with --save)")
    p.set_defaults(handler=cmd_transcribe)

    p = sub.add_parser("submit", help="queue a file and print the job id")
    p.add_argument("file", help="audio or video file")
    _add_common(p, top_level=False)
    _add_job_options(p)
    p.set_defaults(handler=cmd_submit)

    p = sub.add_parser("status", help="print a job's state")
    p.add_argument("job_id")
    _add_common(p, top_level=False)
    p.set_defaults(handler=cmd_status)

    p = sub.add_parser("result", help="print or save a finished job's transcript")
    p.add_argument("job_id")
    _add_common(p, top_level=False)
    p.add_argument("--wait", action="store_true", help="wait for the job to finish first")
    p.add_argument("--timeout", type=float, default=0.0, metavar="SEC",
                   help="with --wait: stop waiting after SEC (0 = wait)")
    p.set_defaults(handler=cmd_result)

    p = sub.add_parser("cancel", help="cancel a queued or running job")
    p.add_argument("job_id")
    _add_common(p, top_level=False)
    p.set_defaults(handler=cmd_cancel)

    p = sub.add_parser("info", help="show the app's address and current defaults")
    _add_common(p, top_level=False)
    p.set_defaults(handler=cmd_info)

    return parser


def _detach_output_from_the_shell_s_locale() -> None:
    """Neither stream may fail on a character the shell cannot spell.

    A shell with ``LC_ALL=C`` gives Python an ASCII stdio encoding, and
    a Russian transcript or a path with an accent in it then raises
    ``UnicodeEncodeError`` mid-write — losing a transcription that had
    already been produced, to a locale setting.

    The transcript itself is already safe: ``emit`` writes bytes
    straight to ``sys.stdout.buffer``. This covers the text writes
    around it — the notes on stderr, and the one-line summaries that go
    through ``print`` — by replacing what cannot be encoded instead of
    raising. Best effort: an ancient stream object without
    ``reconfigure`` simply keeps its own behaviour.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]
        except (AttributeError, OSError, ValueError):
            continue


def main(argv: Optional[list[str]] = None) -> int:
    _detach_output_from_the_shell_s_locale()
    parser = build_parser()
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])
    if not getattr(args, "handler", None):
        parser.print_help(sys.stderr)
        return EXIT_USAGE
    try:
        conn = load_connection(args.connection, args.base_url, args.token)
        return int(args.handler(conn, args))
    except CliError as e:
        note(f"{PROGRAM}: {e}")
        return e.code
    except KeyboardInterrupt:
        note("")
        return EXIT_INTERRUPTED
    except BrokenPipeError:
        # ``transcriptor transcribe x.mp4 | head`` closes stdout early.
        # Silence the interpreter's shutdown-time "Exception ignored"
        # noise by pointing the remaining writes at the void.
        try:
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        except OSError:
            pass
        return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
