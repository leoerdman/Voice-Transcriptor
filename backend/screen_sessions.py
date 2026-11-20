"""Screen-mode screenshots: where they live and who owns them — SSOT.

A screen-mode recording is a voice recording plus the screenshots the user
took while dictating (desktop/screen-mode.js describes the session, the
desktop shell draws and captures). Their life has two stages:

1. **Staging** — while the take runs, the desktop shell writes every
   screenshot and an ``events.json`` into
   ``<data dir>/screen-sessions/<session id>/``. The shell writes there and
   nowhere else; it never deletes anything except a session whose take was
   itself discarded.

2. **Archive** — when the take's audio is saved
   (``/api/recordings/save-with-audio`` with ``screen_session_id``), the
   backend MOVES that folder next to the recording as
   ``<stem>.screens/`` and rewrites the paths inside ``events.json`` to
   their new home. From then on the screenshots are part of the recording:
   listed with it, served with it, deleted with it, and kept or collected
   by the SAME retention rule as its audio (``AUDIO_RETENTION_POLICIES``
   in main.py — newest five for the Screen Sessions collection).

A take whose app died before the save is recovered from its audio spool:
the spool's sidecar names the screen session, and the crash-time promotion
adopts the staged folder exactly as the save does (``_promote_live_recovery``
in main.py). A staging folder nothing adopted and no pending recovery names
(the take was discarded, the save failed twice) is an orphan;
``sweep_orphan_sessions`` collects it on the live-recovery schedule.

This module is dependency-free (stdlib only) so it can be tested without
the FastAPI app.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

STAGING_DIR_NAME = "screen-sessions"
SCREENS_DIR_SUFFIX = ".screens"
EVENTS_FILE_NAME = "events.json"
SCREEN_SESSION_ID_RE = re.compile(r"^screen-\d{8}-\d{6}-\d{3}$")
SCREENSHOT_NAME_RE = re.compile(r"^shot-\d{2,}(-display\d+)?\.png$")


def staging_root(data_dir: Path) -> Path:
    return Path(data_dir) / STAGING_DIR_NAME


def is_session_id(value: object) -> bool:
    return bool(SCREEN_SESSION_ID_RE.fullmatch(str(value or "")))


def screens_dir_name(stem: str) -> str:
    return f"{stem}{SCREENS_DIR_SUFFIX}"


def screens_dir(target_dir: Path, stem: str) -> Path:
    return Path(target_dir) / screens_dir_name(stem)


def is_screens_dir(path: Path) -> bool:
    return path.name.endswith(SCREENS_DIR_SUFFIX) and path.is_dir() and not path.is_symlink()


def screens_stem(path: Path) -> str:
    return path.name[: -len(SCREENS_DIR_SUFFIX)]


def list_screenshots(target_dir: Path, stem: str) -> list[str]:
    """Screenshot file names of one recording, in shot order."""
    d = screens_dir(target_dir, stem)
    if not d.is_dir() or d.is_symlink():
        return []
    try:
        return sorted(p.name for p in d.iterdir() if p.is_file() and SCREENSHOT_NAME_RE.fullmatch(p.name))
    except OSError:
        return []


def screenshot_path(target_dir: Path, stem: str, file_name: str) -> Optional[Path]:
    """The path of one screenshot, or None. Only a name the desktop shell
    writes is accepted — never a path, never anything else in the folder."""
    leaf = str(file_name or "")
    if not SCREENSHOT_NAME_RE.fullmatch(leaf):
        return None
    p = screens_dir(target_dir, stem) / leaf
    return p if p.is_file() and not p.is_symlink() else None


def read_manifest(folder: Path) -> Optional[dict[str, Any]]:
    try:
        data = json.loads((Path(folder) / EVENTS_FILE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_manifest(folder: Path, manifest: dict[str, Any]) -> None:
    out = Path(folder) / EVENTS_FILE_NAME
    tmp = out.with_name(f"{out.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, out)


def _rehome_manifest(manifest: dict[str, Any], folder: Path) -> dict[str, Any]:
    """Point every screenshot path in the manifest at ``folder``."""
    out = dict(manifest)
    out["dir"] = str(folder)
    events = []
    for event in manifest.get("events") or []:
        if not isinstance(event, dict):
            continue
        e = dict(event)
        files = e.get("files")
        if isinstance(files, list):
            e["files"] = [str(folder / Path(str(f)).name) for f in files if isinstance(f, str)]
        events.append(e)
    out["events"] = events
    return out


def adopt_session(
    data_dir: Path,
    session_id: str,
    target_dir: Path,
    stem: str,
    *,
    audio_started_at: Optional[float] = None,
) -> Optional[dict[str, Any]]:
    """Move a staged session next to recording ``stem`` and return its
    manifest with the new paths. ``None`` when there is nothing to adopt
    (unknown id, no folder). Re-saving the same recording replaces its
    previous screenshots folder — the staged one is the newer truth.

    ``audio_started_at`` (epoch ms of the recording's first audio sample,
    the renderer's recording clock) is stored as ``audioStartedAt``: it is
    what turns an event's epoch time into a position in THIS recording's
    audio, so every later transcript of it — a re-transcription months
    on — places the marks from the archive alone.
    """
    if not is_session_id(session_id):
        return None
    source = staging_root(data_dir) / session_id
    if not source.is_dir() or source.is_symlink():
        return None
    dest = screens_dir(target_dir, stem)
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    # os.replace when both are on one volume; a custom archive on another
    # disk needs a copy, which shutil.move does and then removes the source.
    shutil.move(str(source), str(dest))
    manifest = _rehome_manifest(read_manifest(dest) or {"version": 1, "id": session_id, "events": []}, dest)
    if audio_started_at is not None and audio_started_at > 0:
        manifest["audioStartedAt"] = int(audio_started_at)
    try:
        _write_manifest(dest, manifest)
    except OSError as e:
        logger.warning("screen session %s: events.json rewrite failed: %s", session_id, e)
    logger.info("screen session %s adopted as %s", session_id, dest)
    return manifest


def sweep_orphan_sessions(
    data_dir: Path,
    max_age_sec: int,
    *,
    now: Optional[float] = None,
    keep_ids: Optional[set[str]] = None,
) -> int:
    """Remove staged sessions no save ever adopted, once older than
    ``max_age_sec``. ``0`` disables the sweep. ``keep_ids`` are sessions a
    pending crash recovery still names (its promotion adopts them).
    Returns folders removed."""
    keep = keep_ids or set()
    if max_age_sec <= 0:
        return 0
    root = staging_root(data_dir)
    try:
        entries = list(root.iterdir())
    except OSError:
        return 0
    cutoff = (time.time() if now is None else now) - max_age_sec
    removed = 0
    for entry in entries:
        try:
            if not is_session_id(entry.name) or not entry.is_dir() or entry.is_symlink():
                continue
            if entry.name in keep:
                continue
            if entry.stat().st_mtime > cutoff:
                continue
            shutil.rmtree(entry)
            removed += 1
            logger.info("screen session orphan removed: %s", entry.name)
        except OSError as e:
            logger.warning("screen session orphan sweep failed for %s: %s", entry, e)
    return removed
