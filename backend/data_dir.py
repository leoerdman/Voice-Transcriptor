"""Where this installation keeps its data — the one answer, dependency-free.

``backend.config`` resolves ``DATA_DIR`` from this at import time and
creates it. The command-line client (``backend/cli.py``) needs the same
answer to find the connection file the app writes for it, and it must
not import ``backend.config`` to get it: that module pulls in the
crypto stack and creates directories as a side effect, while the CLI
has to start in milliseconds inside any shell with nothing but the
standard library. So the rule lives here, imported by both.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def default_data_dir() -> Path:
    """The platform data directory, or ``TRANSCRIPTOR_DATA_DIR`` when set."""
    env_dir = (os.environ.get("TRANSCRIPTOR_DATA_DIR") or "").strip()
    if env_dir:
        return Path(env_dir).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Transcriptor"
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home())
        return base / "Transcriptor"
    return Path.home() / ".local" / "share" / "transcriptor"
