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
   in main.py, the Screen Sessions entry).

A take whose app died before the save is recovered from its audio spool:
the spool's sidecar names the screen session, and the crash-time promotion
adopts the staged folder exactly as the save does (``_promote_live_recovery``
in main.py). A staging folder nothing adopted and no pending recovery names
(the take was discarded, the save failed twice) is an orphan;
``sweep_orphan_sessions`` collects it on the live-recovery schedule.

This module depends only on the stdlib and ``backend.storage`` (the SSOT
atomic writer, itself stdlib-only), so it can be tested without the
FastAPI app.
"""

from __future__ import annotations

import errno
import json
import logging
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from backend.storage import atomic_write_json

logger = logging.getLogger(__name__)


class ScreenAdoptionError(Exception):
    """Adoption of a staged session failed. The staged folder is left (or
    put back) where it was and any previous ``<stem>.screens`` is intact,
    so a retry finds exactly what the first attempt found."""


def _reason(exc: BaseException) -> str:
    """An error's reason without its paths: an archive path ends in the
    recording's name, which is the first words dictated, and the log is
    the artefact users attach for support."""
    return getattr(exc, "strerror", None) or type(exc).__name__

STAGING_DIR_NAME = "screen-sessions"
SCREENS_DIR_SUFFIX = ".screens"
EVENTS_FILE_NAME = "events.json"
SCREEN_SESSION_ID_RE = re.compile(r"^screen-\d{8}-\d{6}-\d{3}$")
SCREENSHOT_NAME_RE = re.compile(r"^shot-\d{2,}(-display\d+)?\.png$")
# The agent's cheap copies the shell writes beside the screenshots: a
# shot's downscaled preview (``shot-NN-preview.jpg``) and one close-up per
# stroke (``shot-NN-n<number>.jpg``). They live, move and are deleted with
# the folder and are served like the screenshots, but they are not
# screenshots: ``screenshots_in`` (the history's list) never names them.
DERIVED_IMAGE_NAME_RE = re.compile(r"^shot-\d{2,}-(preview|n\d+)\.jpg$")


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


def recording_screens_dir(target_dir: Path, stem: str) -> Optional[Path]:
    """Recording *stem*'s screenshots folder, or None — the ONE answer to
    "does this recording have screenshots, and where" (BM-10). Listing,
    serving and the recording payload all ask here, so a symlinked
    ``<stem>.screens`` cannot be listed as empty by one and served by
    another."""
    d = screens_dir(target_dir, stem)
    return d if is_screens_dir(d) else None


def screenshots_in(folder: Path) -> list[str]:
    """Screenshot file names in a screens folder, in shot order."""
    try:
        return sorted(p.name for p in folder.iterdir() if p.is_file() and SCREENSHOT_NAME_RE.fullmatch(p.name))
    except OSError:
        return []


def is_served_image_name(file_name: object) -> bool:
    """A screenshot or one of its cheap copies — the image names the shell
    writes into a screens folder, and the only ones ever served."""
    leaf = str(file_name or "")
    return bool(SCREENSHOT_NAME_RE.fullmatch(leaf) or DERIVED_IMAGE_NAME_RE.fullmatch(leaf))


def image_media_type(file_name: str) -> str:
    return "image/jpeg" if str(file_name).lower().endswith(".jpg") else "image/png"


def screenshot_path(target_dir: Path, stem: str, file_name: str) -> Optional[Path]:
    """The path of one screenshot (or one of its cheap copies), or None.
    Only a name the desktop shell writes is accepted — never a path, never
    anything else in the folder."""
    leaf = str(file_name or "")
    if not is_served_image_name(leaf):
        return None
    d = recording_screens_dir(target_dir, stem)
    if d is None:
        return None
    p = d / leaf
    return p if p.is_file() and not p.is_symlink() else None


def read_manifest(folder: Path) -> Optional[dict[str, Any]]:
    try:
        data = json.loads((Path(folder) / EVENTS_FILE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def is_app_screens_dir(path: Path) -> bool:
    """A screens folder this app made: its manifest names a screen session
    (the shell writes ``id`` into every ``events.json``). What lets a
    folder whose transcript is gone be recognised as ours."""
    if not is_screens_dir(path):
        return False
    manifest = read_manifest(path)
    return bool(manifest) and is_session_id(manifest.get("id"))


# A ``<stem>.screens`` folder being assembled or retired: ``.tmp-<hex>``
# like every other atomic writer's leftovers, so the boot sweep in main.py
# (``_sweep_orphan_tmp_files``) recognises a crash's debris.
SCREENS_WORK_DIR_RE = re.compile(re.escape(SCREENS_DIR_SUFFIX) + r"\.tmp-[0-9a-f]{6,}$")


def _work_dir_for(dest: Path) -> Path:
    return dest.with_name(f"{dest.name}.tmp-{uuid.uuid4().hex}")


def is_screens_work_dir(path: Path) -> bool:
    return bool(SCREENS_WORK_DIR_RE.search(path.name)) and path.is_dir() and not path.is_symlink()


def _rehome_image(value: object, folder: Path) -> Optional[str]:
    """One cheap copy's path (a shot's ``preview``, a stroke's ``crop``)
    pointed at ``folder``; None for anything that is not a name the shell
    writes for one."""
    if not isinstance(value, str):
        return None
    leaf = Path(value).name
    return str(folder / leaf) if DERIVED_IMAGE_NAME_RE.fullmatch(leaf) else None


def _rehome_manifest(manifest: dict[str, Any], folder: Path) -> dict[str, Any]:
    """Point every image path in the manifest — a shot's ``files`` and
    ``preview``, a stroke's ``crop`` (manifest v2; v1 has only ``files``)
    — at ``folder``. Fields of the wrong shape (the shell wrote ``events``
    as something other than a list, a ``crop`` that is not one of its
    names) are dropped, never trusted."""
    out = dict(manifest)
    out["dir"] = str(folder)
    events = []
    raw_events = manifest.get("events")
    for event in raw_events if isinstance(raw_events, list) else []:
        if not isinstance(event, dict):
            continue
        e = dict(event)
        files = e.get("files")
        if isinstance(files, list):
            e["files"] = [str(folder / Path(str(f)).name) for f in files if isinstance(f, str)]
        for key in ("preview", "crop"):
            if key in e:
                rehomed = _rehome_image(e[key], folder)
                if rehomed is None:
                    del e[key]
                else:
                    e[key] = rehomed
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
    audio_ended_at: Optional[float] = None,
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

    ``audio_ended_at`` (epoch ms of the recording's last audio sample) is
    stored as ``endedAt`` only when the manifest has none. The shell
    writes ``endedAt`` when the take stops; a take whose app died never
    stopped, and without an end its marks have no time frame to be placed
    in (``screenSessionDurationMs`` in frontend/src/screen-annotations.ts)
    — every one of them would land at the end of the text.

    All or nothing: the folder is assembled beside its destination under
    a work name (moved there — a copy when the archive is on another
    volume — and its manifest rewritten with the SSOT atomic writer), and
    only a complete folder is renamed over the old one. Any failure puts
    the staged folder back, removes the work copy, leaves the previous
    ``<stem>.screens`` untouched and raises ``ScreenAdoptionError``. The
    previous form deleted the old screenshots first, could leave a
    half-copied folder that was listed as the recording's, and answered
    a failed manifest rewrite with a manifest that existed only in memory.
    """
    if not is_session_id(session_id):
        return None
    source = staging_root(data_dir) / session_id
    if not source.is_dir() or source.is_symlink():
        return None
    dest = screens_dir(target_dir, stem)
    work = _work_dir_for(dest)
    moved = False
    try:
        # A rename when both are on one volume. A custom archive on another
        # disk needs a copy; the staged source is then removed only once
        # the archived folder is complete and in place.
        try:
            source.replace(work)
            moved = True
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
            shutil.copytree(source, work, symlinks=True)
        manifest = _rehome_manifest(
            read_manifest(work) or {"version": 1, "id": session_id, "events": []}, dest
        )
        if audio_started_at is not None and audio_started_at > 0:
            manifest["audioStartedAt"] = int(audio_started_at)
        if audio_ended_at is not None and audio_ended_at > 0 and not manifest.get("endedAt"):
            manifest["endedAt"] = int(audio_ended_at)
        atomic_write_json(work / EVENTS_FILE_NAME, manifest)
    except (OSError, ValueError, TypeError) as exc:
        _undo_adoption(work, source, moved, session_id)
        raise ScreenAdoptionError(f"screen session {session_id}: adoption failed: {_reason(exc)}") from exc
    retired: Optional[Path] = None
    try:
        if dest.exists():
            retired = _work_dir_for(dest)
            dest.replace(retired)
        work.replace(dest)
    except OSError as exc:
        if retired is not None and not dest.exists():
            try:
                retired.replace(dest)
                retired = None
            except OSError as restore_exc:
                logger.error(
                    "screen session %s: previous screenshots left at %s: %s",
                    session_id, retired, restore_exc,
                )
        _undo_adoption(work, source, moved, session_id)
        raise ScreenAdoptionError(f"screen session {session_id}: adoption failed: {_reason(exc)}") from exc
    if not moved:
        try:
            shutil.rmtree(source)
        except OSError as exc:
            # Archived copy is complete; the staged one ages out with the
            # orphan sweep.
            logger.warning("screen session %s: staged copy not removed: %s", session_id, _reason(exc))
    if retired is not None:
        try:
            shutil.rmtree(retired)
        except OSError as exc:
            # The new folder is in place; the old one is debris the boot
            # sweep recognises by its work name.
            logger.warning("screen session %s: old screenshots not removed: %s", session_id, _reason(exc))
    logger.info("screen session %s adopted", session_id)
    return manifest


def _undo_adoption(work: Path, source: Path, moved: bool, session_id: str) -> None:
    """Put a failed adoption back: the staged folder where it was, no work
    copy left in the archive."""
    if not work.exists():
        return
    try:
        if moved:
            work.replace(source)
        else:
            # A cross-volume copy: the source was never touched; the
            # (possibly partial) copy is just debris.
            shutil.rmtree(work)
    except OSError as exc:
        logger.error("screen session %s: could not undo a failed adoption (%s): %s", session_id, work, exc)


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
