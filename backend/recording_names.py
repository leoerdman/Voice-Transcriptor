"""How a saved recording's files are named (SSOT).

Every recording this app files — a dictation, an uploaded file, a crash
recovery, a screen-mode take — is one stem shared by its siblings:
``<stem>.txt`` (the transcript), ``<stem>.<ext>`` (the audio) and, for a
screen-mode take, ``<stem>.screens/`` (its screenshots).

The stem is ``YYYYMMDD-HHMMSS``: the local time of the recording, digits
and one hyphen, nothing else. A second recording in the same second gets
``-`` plus four random lowercase hex digits (``20261121-034611-a3f9``).
The name says WHEN and nothing more: what was said (the title, the first
words) and what file it came from live only in the transcript's header
(``Title:`` / ``Source file:``), which is where History reads them from.

What this replaced: ``2026-11-21_03-46-11-851314__<first dictated words>``
for a dictation and ``<the uploaded file's own name>`` for an upload — a
path that ran past 160 characters, carried Cyrillic and spaces into every
shell command an agent ran against the archive, and put the dictated
words into every path that reached a log.

Recordings saved under that legacy form are NOT renamed: they keep being
listed, read, served and deleted by their names exactly as before. Code
that needs to know which form a stem is asks ``is_recording_stem`` /
``legacy_stem_parts`` here instead of parsing names itself.
"""
from __future__ import annotations

import re
import secrets
from datetime import datetime
from typing import Iterator, Optional

STEM_TIME_FORMAT = "%Y%m%d-%H%M%S"

# How many random collision suffixes are tried after the plain stem is
# taken. Four hex digits are 65 536 names per second; running out of 256
# random draws needs thousands of recordings filed in one second, which
# no path of this app produces — the caller then reports that it could
# not allocate a name rather than looping forever.
COLLISION_SUFFIX_HEX_DIGITS = 4
COLLISION_SUFFIX_ATTEMPTS = 256

_STEM_RE = re.compile(r"\d{8}-\d{6}(?:-[0-9a-f]{%d})?" % COLLISION_SUFFIX_HEX_DIGITS)
# The legacy dictation form: ``YYYY-MM-DD_HH-MM-SS[-ffffff]__<title>``.
_LEGACY_STEM_RE = re.compile(
    r"(?P<stamp>\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d{1,6})?)__(?P<title>.*)",
    re.DOTALL,
)


def recording_stem_candidates(when: datetime) -> Iterator[str]:
    """The names a new recording may take, in order of preference.

    *when* is the moment the recording BEGAN — a dictation's first audio
    sample, an upload's start, a crash-recovered take's spool start. It has
    no default: "now" is when the name is asked for, which for a take is
    its end, minutes after it began, so every caller says which moment its
    recording began. A timezone-aware value is converted to local time
    first, so the name always reads as the clock on the user's Mac did.
    The caller reserves the first free candidate
    (``_claim_recording_text_path`` in ``backend.main``).
    """
    moment = when
    if moment.tzinfo is not None:
        moment = moment.astimezone()
    base = moment.strftime(STEM_TIME_FORMAT)
    yield base
    for _ in range(COLLISION_SUFFIX_ATTEMPTS):
        yield f"{base}-{secrets.token_hex(COLLISION_SUFFIX_HEX_DIGITS // 2)}"


def is_recording_stem(stem: str) -> bool:
    """Is *stem* a name this module gives (``YYYYMMDD-HHMMSS[-xxxx]``)?"""
    return bool(_STEM_RE.fullmatch(str(stem or "")))


def legacy_stem_parts(stem: str) -> Optional[tuple[str, str]]:
    """``(timestamp, title)`` of a legacy ``<timestamp>__<title>`` stem, or
    None for any other stem (a current one, a legacy upload named after its
    source file, a file the user put in the folder)."""
    match = _LEGACY_STEM_RE.fullmatch(str(stem or ""))
    if match is None:
        return None
    return match.group("stamp"), match.group("title")
