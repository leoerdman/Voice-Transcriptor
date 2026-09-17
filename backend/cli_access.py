"""CLI access — the one owner of "may a command-line client use this backend".

The app's renderer authenticates with the API token ``backend.main``
mints at boot. A command run by an agent or a shell is a different
caller with a different life: the user turns it on in the CLI section,
and turning it off must revoke it while the app keeps running. So the
command-line client gets a token of its own, and the SWITCH is the
presence of that token file — there is no second "enabled" flag in the
config that could disagree with what the file system holds.

Files, all under ``<data dir>/cli``:

``token``
    The CLI's bearer token, owner-only. Present = CLI access is on.
``connection.json``
    What the client reads to find the backend: ``base_url`` and the
    token. Rewritten whenever the backend is reached at a different
    address (the desktop shell picks the next free port when 8321 is
    busy, so the port is not a constant).
``transcriptor`` (``transcriptor.cmd`` on Windows)
    A wrapper that runs ``backend/cli.py`` with the interpreter this
    backend runs on and points it at ``connection.json``. This is the
    command the CLI section shows; it is the whole "install".

The CLI token opens only the transcription routes (``cli_token_may_call``).
It is not the renderer's token with a different name: it cannot read or
write the config, provider keys, the archive listing or the live socket.

Pure where it can be: the wrapper text, the command cards, the route
rule, the address-from-scope reader and the defaults derivation take
their inputs as arguments and touch nothing. Only ``CliAccess`` reads
and writes files, and it is handed its directory.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shlex
import stat
import sys
from pathlib import Path
from typing import Any, Mapping, Optional

from backend.model_catalog import (
    DEFAULT_DEEPGRAM_AUDIO_MODEL,
    DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
    DEFAULT_OPENROUTER_AUDIO_MODEL,
    GIGAAM_MODELS,
    LOCAL_TRANSCRIPTION_MODELS,
    REMOTE_TRANSCRIPTION_PROVIDERS,
)
from backend.storage import atomic_write_text

logger = logging.getLogger(__name__)

CONNECTION_FILE_VERSION = 1
CLI_DIR_NAME = "cli"
TOKEN_FILE_NAME = "token"
CONNECTION_FILE_NAME = "connection.json"
POSIX_WRAPPER_NAME = "transcriptor"
WINDOWS_WRAPPER_NAME = "transcriptor.cmd"

#: The engines the CLI can name. ``local`` is Whisper or GigaAM by model
#: id (the backend dispatches on the ``gigaam-`` prefix, as the Upload
#: tab does); the other two are the remote providers, by their wire
#: names, so the CLI and the app spell a provider the same way.
CLI_ENGINES: tuple[str, ...] = ("local",) + REMOTE_TRANSCRIPTION_PROVIDERS

#: Route rule for the CLI token: method + path pattern. Everything the
#: client needs to transcribe a file and nothing that changes the app's
#: configuration. ``/api/health`` is unauthenticated and needs no entry.
_CLI_ROUTES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("GET", re.compile(r"^/api/cli$")),
    ("POST", re.compile(r"^/api/jobs/from-path$")),
    ("POST", re.compile(r"^/api/remote/jobs/from-path$")),
    ("GET", re.compile(r"^/api/jobs/[^/]+$")),
    ("POST", re.compile(r"^/api/jobs/[^/]+/cancel$")),
    ("GET", re.compile(r"^/api/jobs/[^/]+/download/[^/]+$")),
    ("POST", re.compile(r"^/api/recordings/save-from-path$")),
)


def cli_token_may_call(method: str, path: str) -> bool:
    """True when a request authenticated by the CLI token may reach *path*."""
    m = str(method or "").upper()
    p = str(path or "")
    return any(m == allowed and pattern.match(p) for allowed, pattern in _CLI_ROUTES)


def base_url_from_scope(scope: Mapping[str, Any]) -> str:
    """The address this backend was reached at, from an ASGI scope.

    uvicorn fills ``scope["server"]`` from the listening socket's own
    name, so it is the bound host and port — not a header a client
    chose, and not the port the desktop shell *asked* for before it
    discovered 8321 was taken. An IPv6 host is bracketed as a URL needs.
    Empty when the scope carries no server (a unix socket, a test
    client without one) so the caller can keep the last known address.
    """
    server = scope.get("server") if isinstance(scope, Mapping) else None
    if not isinstance(server, (tuple, list)) or len(server) != 2:
        return ""
    host, port = server
    host = str(host or "").strip()
    try:
        port_num = int(port)
    except (TypeError, ValueError):
        return ""
    if not host or port_num <= 0:
        return ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port_num}"


#: Interpreter flags, and the reason for each. ``-E`` is the one that
#: matters: this wrapper runs the app's BUNDLED interpreter from inside
#: someone else's shell, and a ``PYTHONHOME`` or ``PYTHONPATH`` left in
#: that shell's profile — pointing at a different Python entirely — is
#: enough to make it fail to start or import the wrong module. The
#: client needs nothing from those variables; it finds its own package
#: from ``__file__``. ``-B`` keeps a read-only or shared install from
#: accumulating ``__pycache__`` next to the app's own files.
_PYTHON_FLAGS = ("-E", "-B")


def render_posix_wrapper(python_executable: str, cli_script: str, connection_file: str) -> str:
    """The shell wrapper: one ``exec`` line, every path quoted."""
    flags = " ".join(_PYTHON_FLAGS)
    return (
        "#!/bin/sh\n"
        "# Transcriptor command-line client. Written by the app when the CLI\n"
        "# section is switched on; deleted when it is switched off.\n"
        f"exec {shlex.quote(python_executable)} {flags} {shlex.quote(cli_script)} "
        f"--connection {shlex.quote(connection_file)} \"$@\"\n"
    )


def render_windows_wrapper(python_executable: str, cli_script: str, connection_file: str) -> str:
    flags = " ".join(_PYTHON_FLAGS)
    return (
        "@echo off\r\n"
        "rem Transcriptor command-line client. Written by the app when the CLI\r\n"
        "rem section is switched on; deleted when it is switched off.\r\n"
        f'"{python_executable}" {flags} "{cli_script}" --connection "{connection_file}" %*\r\n'
    )


def _quote_for(platform: str, value: str) -> str:
    if platform == "win32":
        return f'"{value}"'
    return shlex.quote(value)


def command_cards(wrapper_path: str, platform: str = sys.platform) -> list[dict[str, str]]:
    """The cards the CLI section shows once access is on.

    Each is a command (or a paragraph an agent will act on) plus the one
    line that says what it is for. The renderer copies them verbatim; it
    composes nothing of its own, so what the user pastes into an agent
    is exactly what this backend can honour.
    """
    is_win = platform == "win32"
    cmd = _quote_for(platform, wrapper_path)
    example_file = "C:\\path\\to\\video.mp4" if is_win else "/path/to/video.mp4"
    example = f"{cmd} transcribe {_quote_for(platform, example_file)}"
    agent_text = (
        "Transcriptor is installed on this machine and exposes a command-line "
        "transcriber. To get the text of any audio or video file, run:\n"
        f"  {example}\n"
        "The transcript is printed to stdout; progress and errors go to stderr; "
        "exit code 0 means success. Options: --language <auto|ru|en|...>, "
        "--engine <local|deepgram|openrouter>, --model <id>, --diarize, "
        "--json (full result with segments), --out <file>, --save (keep it in "
        f"Transcriptor's History). Run {cmd} --help for everything else."
    )
    if is_win:
        install = f'setx PATH "%PATH%;{str(Path(wrapper_path).parent)}"'
        install_note = "Adds the folder to your PATH, so `transcriptor transcribe ...` works in any new shell."
    else:
        install = f"ln -sf {cmd} /usr/local/bin/transcriptor"
        install_note = (
            "Puts `transcriptor` on your PATH, so `transcriptor transcribe ...` works "
            "from any shell. Prefix with sudo if /usr/local/bin is not writable."
        )
    return [
        {
            "id": "agent",
            "title": "For an agent",
            "text": agent_text,
            "note": "Paste into the agent's chat, CLAUDE.md, AGENTS.md or any system prompt. Any agent that can run a shell command can use it as is.",
        },
        {
            "id": "transcribe",
            "title": "Transcribe a file",
            "text": example,
            "note": "Audio or video, any format the Upload tab accepts. The transcript is printed to stdout.",
        },
        {
            "id": "path",
            "title": "Add to PATH",
            "text": install,
            "note": install_note,
        },
    ]


def cli_defaults(config: Mapping[str, Any], gigaam_available: bool) -> dict[str, Any]:
    """What ``transcribe`` does when told nothing: the Upload tab's own choice.

    Read from ``preferences.ui`` — ``provider_group`` is the group the
    Upload toolbar shows, the model keys are what it would send — so the
    CLI and the app transcribe the same file the same way unless the
    command says otherwise. A group whose engine is not installed
    (GigaAM without the package) falls back to Whisper's default rather
    than failing later with a model the backend refuses.
    """
    prefs = config.get("preferences") if isinstance(config, Mapping) else None
    ui = prefs.get("ui") if isinstance(prefs, Mapping) else None
    ui = ui if isinstance(ui, Mapping) else {}
    group = str(ui.get("provider_group") or "").strip()
    language = str(ui.get("upload_language") or "auto").strip() or "auto"
    diarize = ui.get("upload_diarize") is True

    def _text(key: str) -> str:
        return str(ui.get(key) or "").strip()

    engine = "local"
    model = DEFAULT_LOCAL_TRANSCRIPTION_MODEL
    if group == "deepgram":
        engine = "deepgram"
        model = _text("remote_model_deepgram") or DEFAULT_DEEPGRAM_AUDIO_MODEL
    elif group == "openrouter":
        engine = "openrouter"
        model = _text("remote_model_openrouter") or DEFAULT_OPENROUTER_AUDIO_MODEL
    else:
        local_model = _text("local_model")
        if local_model in LOCAL_TRANSCRIPTION_MODELS:
            model = local_model
        if model in GIGAAM_MODELS and not gigaam_available:
            model = DEFAULT_LOCAL_TRANSCRIPTION_MODEL
    return {
        "engine": engine,
        "model": model,
        "language": language,
        "diarize": diarize,
        "engines": list(CLI_ENGINES),
        "local_models": [
            m for m in LOCAL_TRANSCRIPTION_MODELS if gigaam_available or m not in GIGAAM_MODELS
        ],
    }


def _wrapper_name(platform: str) -> str:
    return WINDOWS_WRAPPER_NAME if platform == "win32" else POSIX_WRAPPER_NAME


class CliAccess:
    """Reads and writes the files under ``<data dir>/cli``.

    ``load`` runs once at backend boot and puts the token, if any, in
    memory: the auth path compares against memory, never the disk.
    """

    def __init__(
        self,
        data_dir: Path,
        *,
        python_executable: str = sys.executable,
        cli_script: Optional[Path] = None,
        platform: str = sys.platform,
    ) -> None:
        self.dir = Path(data_dir) / CLI_DIR_NAME
        self.token_path = self.dir / TOKEN_FILE_NAME
        self.connection_path = self.dir / CONNECTION_FILE_NAME
        self.wrapper_path = self.dir / _wrapper_name(platform)
        self._platform = platform
        self._python = str(python_executable)
        self._cli_script = str(cli_script or (Path(__file__).resolve().parent / "cli.py"))
        self._token: str = ""
        self._base_url: str = ""

    # ── state ────────────────────────────────────────────────────────

    def load(self) -> None:
        """Adopt the on-disk state at boot. Never raises."""
        self._token = ""
        self._base_url = ""
        try:
            if self.token_path.exists():
                self._token = self.token_path.read_text(encoding="utf-8").strip()
        except OSError as e:
            logger.warning("cli token unreadable at %s: %s — CLI access off until re-enabled", self.token_path, e)
            self._token = ""
        if not self._token:
            return
        try:
            if self.connection_path.exists():
                data = json.loads(self.connection_path.read_text(encoding="utf-8"))
                self._base_url = str(data.get("base_url") or "").strip() if isinstance(data, dict) else ""
        except (OSError, ValueError) as e:
            logger.warning("cli connection file unreadable at %s: %s — will be rewritten", self.connection_path, e)

    def is_enabled(self) -> bool:
        return bool(self._token)

    @property
    def base_url(self) -> str:
        return self._base_url

    def token_matches(self, provided: str) -> bool:
        if not self._token or not provided:
            return False
        return secrets.compare_digest(str(provided).encode("utf-8"), self._token.encode("utf-8"))

    # ── transitions ──────────────────────────────────────────────────

    def enable(self, base_url: str) -> None:
        """Mint the token (if absent) and write every file the client needs.

        Raises ``OSError`` when a file cannot be written; the caller
        turns that into a response, and the in-memory state stays
        "off" — a switch that reports on while nothing was written is
        the failure this module exists to prevent.

        The rollback is why the whole transition lives here. "On" is not
        one file but three, and the failure worth naming is the middle
        one: token written, wrapper not. That leaves ``is_enabled()``
        true, the section showing a command path with no command behind
        it, and a client that authenticates against a backend it cannot
        be launched from. So a switch-on that fails half way revokes
        what it wrote and reports off. A REFRESH of an access that was
        already on (a re-enable after the port moved) keeps its token
        instead: the client's credential is still good, and dropping it
        would break a working install to report a failed rewrite.
        """
        was_enabled = bool(self._token)
        token = self._token or secrets.token_urlsafe(32)
        try:
            self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not was_enabled:
                atomic_write_text(self.token_path, token, mode=0o600)
            self._token = token
            self._write_connection(base_url or self._base_url)
            self._write_wrapper()
        except OSError:
            if not was_enabled:
                self.disable()
            raise

    def sync_connection(self, base_url: str) -> None:
        """Rewrite ``connection.json`` when the backend's address moved."""
        if not self._token:
            return
        url = str(base_url or "").strip()
        if not url or url == self._base_url:
            return
        try:
            self._write_connection(url)
        except OSError as e:
            logger.warning("cli connection file not updated at %s: %s", self.connection_path, e)

    def disable(self) -> None:
        """Revoke: forget the token and remove every file. Never raises."""
        self._token = ""
        self._base_url = ""
        for path in (self.token_path, self.connection_path, self.wrapper_path):
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            except OSError as e:
                logger.warning("cli file %s not removed: %s", path, e)

    # ── views ────────────────────────────────────────────────────────

    def status(self, *, base_url: str = "") -> dict[str, Any]:
        enabled = self.is_enabled()
        url = str(base_url or self._base_url or "").strip()
        return {
            "enabled": enabled,
            "base_url": url if enabled else "",
            "command_path": str(self.wrapper_path) if enabled else "",
            "cli_dir": str(self.dir),
            "cards": command_cards(str(self.wrapper_path), self._platform) if enabled else [],
        }

    # ── writers ──────────────────────────────────────────────────────

    def _write_connection(self, base_url: str) -> None:
        url = str(base_url or "").strip()
        payload = {
            "version": CONNECTION_FILE_VERSION,
            "base_url": url,
            "token": self._token,
        }
        atomic_write_text(
            self.connection_path,
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            mode=0o600,
        )
        self._base_url = url

    def _write_wrapper(self) -> None:
        if self._platform == "win32":
            text = render_windows_wrapper(self._python, self._cli_script, str(self.connection_path))
            atomic_write_text(self.wrapper_path, text, mode=0o600)
            return
        text = render_posix_wrapper(self._python, self._cli_script, str(self.connection_path))
        atomic_write_text(self.wrapper_path, text, mode=0o700)
        # atomic_write_text applies the mode to the temp file before the
        # rename; belt and braces for a writer that honours umask only.
        try:
            os.chmod(self.wrapper_path, stat.S_IRWXU)
        except OSError as e:
            logger.warning("cli wrapper mode not set on %s: %s", self.wrapper_path, e)
