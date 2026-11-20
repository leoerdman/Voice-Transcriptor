"""Shared atomic-write primitives — the SSOT storage layer.

Every persistent file written by the backend goes through one of these
helpers. The goals are uniform and non-negotiable across call sites:

    1. ATOMICITY — the final file either has the OLD contents or the
       FULL NEW contents. There is no intermediate state. We write to
       a unique tmp file in the target's directory and ``os.replace()``
       in a single syscall.

    2. DURABILITY — contents are ``fsync()``'d to storage BEFORE the
       rename lands, so a kernel/power crash cannot leave an empty
       file visible at the target path. On POSIX we also ``fsync()``
       the parent directory so the rename metadata itself is durable.

    3. CRASH RECOVERY — ``rotate_backup()`` copies the current file to
       a ``.bak`` sibling BEFORE a mutating write. If the new write is
       corrupt (bug, truncation, bad migration) the caller's read
       path can fall back to ``.bak``.

    4. TEMP-FILE HYGIENE — tmp names use ``<target>.tmp-<hex>`` which
       matches the convention ``_sweep_orphan_tmp_files`` in
       backend.main expects, so a crash mid-write does not leave
       permanent clutter.

    5. SINGLE IMPLEMENTATION — NO caller opens a final persistent file
       for write directly. JSON / text / bytes writes and already-written
       tmp-file promotions route here. This keeps fsync semantics,
       tmp-naming conventions, and error handling identical across the
       whole codebase, so a future improvement (say, async writes or a
       different tmp location under a ramdisk) is a one-file change.

The helpers raise ``OSError`` on any failure. They clean up the tmp
file before re-raising so no half-written artefact lingers.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Type alias for ``atomic_write_json``'s payload. We intentionally
# accept ``Any`` because callers feed ``list`` (e.g. known_archive_dirs)
# as well as ``dict`` — both serialise fine through ``json.dumps``.
JSONData = Any


# The tmp-name CONVENTION, owned here because this module owns the
# atomic writers that produce it. ``backend.main`` has a second producer
# (``_atomic_temp_path``, which inserts the marker BEFORE every suffix)
# and the sweeper that deletes what a crashed writer left behind; all
# three now read this one pattern instead of restating it.
#
# The hex portion is always 32 chars (``uuid4().hex``) — at least 6 is
# required so a real file named "backup.tmp-x.wav" never matches. The
# trailing extension groups repeat, because a target with more than one
# dot ("Recovered 2026-09-04T19_37_12.123456.wav", which is what every
# live-recovery promote produced before recordings were named after their
# time alone — such files are still in users' archives) yields TWO of
# them; one optional group
# matched single-suffix names only and left the rest to accumulate
# forever. Anchored to ``$`` so a user file with ".tmp-" in the middle
# is not matched.
TMP_ORPHAN_RE = re.compile(
    r"\.tmp-[0-9a-f]{6,}(?:\.[A-Za-z0-9]+)*$", re.IGNORECASE
)


def _tmp_path_for(target: Path) -> Path:
    """Produce a collision-free ``.tmp-<hex>`` sibling of *target*.

    The suffix shape is recognised by ``_sweep_orphan_tmp_files`` in
    backend/main.py: a crash between the tmp write and the atomic
    rename leaves a file that the housekeeper deletes on next boot.
    """
    return target.with_name(target.name + f".tmp-{uuid.uuid4().hex}")


def _fsync_parent_dir(path: Path) -> None:
    """On POSIX, fsync the parent directory so the rename is durable.

    Windows has no public directory-fsync primitive; NTFS journalling
    handles rename durability on its own, so we no-op there.
    """
    if os.name == "nt":
        return
    try:
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError as e:
        # Dir fsync failure is non-fatal — the file's bytes are
        # already on disk. We lose only the guarantee that the
        # rename survives a power loss. Log so flaky storage is
        # visible in support bundles.
        logger.warning("parent dir fsync skipped at %s: %s", path.parent, e)


def _fsync_file(path: Path) -> None:
    # ``r+b`` (read/write) rather than ``rb``: POSIX permits fsync on a
    # read-only descriptor, but some exotic filesystems return EBADF for
    # it. The file is our own tmp artefact, so a write handle is free.
    with open(path, "r+b") as f:
        os.fsync(f.fileno())


def atomic_promote_file(tmp_path: Path, path: Path) -> None:
    """Promote an already-written tmp file into place atomically + durably."""
    tmp_path = Path(tmp_path)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        _fsync_file(tmp_path)
        os.replace(tmp_path, path)
        _fsync_parent_dir(path)
    except OSError:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def atomic_write_bytes(path: Path, data: bytes, *, mode: Optional[int] = None) -> None:
    """Write *data* to *path* atomically and durably.

    Raises ``OSError`` on disk failures; always cleans up the tmp
    file before re-raising.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path_for(path)
    try:
        # Open explicitly so we can fsync the file descriptor after
        # writing — ``Path.write_bytes`` does not expose that hook.
        if mode is None:
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
        else:
            fd: Optional[int] = None
            try:
                fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
                with os.fdopen(fd, "wb") as f:
                    fd = None
                    f.write(data)
                    f.flush()
                    os.fsync(f.fileno())
            finally:
                if fd is not None:
                    os.close(fd)
        # Atomic rename. Both POSIX (``rename(2)``) and Windows
        # (``MoveFileExW`` with MOVEFILE_REPLACE_EXISTING) guarantee
        # the target is either the old file or the new file, never a
        # torn in-between state.
        os.replace(tmp, path)
        if mode is not None:
            try:
                os.chmod(path, mode)
            except OSError as chmod_err:
                # The write LANDED. Raising here reported a failed write
                # for a write that succeeded — and the outer handler then
                # tried to unlink a tmp file that no longer exists and
                # re-raised. ``main._load_or_create_api_token`` answers
                # that by falling back to an in-memory token while a
                # DIFFERENT token sits on disk, so every client of this
                # session ends up out of sync with the next boot. The
                # file already carries the mode requested at creation
                # (``O_CREAT`` above); this chmod only re-tightens it
                # after the rename, and a filesystem that refuses it
                # (SMB, exFAT) is a warning, not a data loss.
                logger.warning(
                    "chmod %o skipped for %s: %s", mode, path, chmod_err,
                )
        _fsync_parent_dir(path)
    except OSError:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def atomic_write_text(
    path: Path,
    text: str,
    *,
    encoding: str = "utf-8",
    mode: Optional[int] = None,
) -> None:
    """UTF-8 text flavour of ``atomic_write_bytes``.

    Splits via ``text.encode()`` so callers who pass already-computed
    bytes do not double-encode.
    """
    atomic_write_bytes(path, text.encode(encoding), mode=mode)


def atomic_write_json(
    path: Path, data: JSONData, *, indent: int = 2, mode: Optional[int] = None
) -> None:
    """Serialise *data* as UTF-8 JSON and write atomically + durably.

    ``mode`` is passed through for the same reason ``atomic_write_text``
    takes it: ``config.json`` can hold provider API keys in plain text
    when ``cryptography`` is absent — a fallback this project documents
    — and it was written at the process umask (measured 0644) beside a
    keyfile written at 0600.
    """
    payload = json.dumps(data, ensure_ascii=False, indent=indent)
    atomic_write_text(path, payload, mode=mode)


def atomic_copy_file(src: Path, path: Path, *, preserve_stat: bool = True) -> None:
    """Copy *src* to *path* atomically and durably.

    Used for migration paths where the bytes already exist on disk but the
    destination must still obey the same tmp/fsync/rename contract as fresh
    writes.
    """
    src = Path(src)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path_for(path)
    try:
        with open(src, "rb") as src_f, open(tmp, "wb") as dst_f:
            shutil.copyfileobj(src_f, dst_f)
            dst_f.flush()
            os.fsync(dst_f.fileno())
        if preserve_stat:
            try:
                shutil.copystat(src, tmp)
            except OSError as stat_error:
                logger.warning("copy metadata skipped for %s -> %s: %s", src, path, stat_error)
        os.replace(tmp, path)
        _fsync_parent_dir(path)
    except OSError:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def rotate_backup(path: Path, backup: Path) -> None:
    """Copy *path* → *backup* before an overwrite.

    Non-fatal on failure — the caller may still choose to persist the
    new value rather than abort on a backup hiccup. A warning is
    logged so flaky storage remains visible to operators.

    No-op if *path* does not exist yet (first-save case).
    """
    if not path.exists():
        return
    backup.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path_for(backup)
    try:
        with open(path, "rb") as src, open(tmp, "wb") as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        try:
            shutil.copystat(path, tmp)
        except OSError as stat_error:
            logger.warning("backup metadata copy skipped for %s → %s: %s", path, backup, stat_error)
        os.replace(tmp, backup)
        _fsync_parent_dir(backup)
    except OSError as e:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        logger.warning("backup rotation failed for %s → %s: %s", path, backup, e)
