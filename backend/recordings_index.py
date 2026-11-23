"""Persistent per-transcript metadata index behind the History list.

Building the History list needs, per transcript, a few fields parsed out
of the file (display name, source file, provider, language). Parsing
means reading the whole transcript: on the user's archive (~10.7k
transcripts, 58 MB, 2026-11-23) a cold build took 2-5 s, more under
load, and it was paid on every launch because the per-file cache lived
in memory only.

This module keeps that per-file cache on disk, in the app data dir, so a
launch re-reads only what changed since the last one.

* Entry key: the transcript's absolute path. Entry freshness: its
  ``(mtime_ns, size)``. A transcript rewritten in place changes at least
  one of them, so a stale entry is never served.
* Entry value: exactly the dict the parser returned (``fields``).
* Rules version: the index records the version of the parsing rules it
  was built with, and is discarded whole when it differs from the
  running code's. The version is computed from the parser itself
  (``code_fingerprint``) — the bytecode of the parse function and of
  every project function, regex and constant it reaches — so a change to
  the parsing rules changes the version without anyone having to
  remember to bump a constant.
* Durability: written atomically (``storage.atomic_write_bytes``: tmp
  file, fsync, ``os.replace``). A missing, truncated, unparsable or
  foreign file is treated as an empty index — the next scan rebuilds
  it — never as an error. A single malformed entry is dropped alone.
* Pruning: the scan reports the set of transcripts it saw
  (``retain_only``); everything else leaves the index, so deletions and
  renames cannot make it grow.

The index is the ONE per-file metadata cache: ``backend.main`` has no
second in-memory copy beside it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import types
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from backend.storage import atomic_write_bytes

logger = logging.getLogger(__name__)

INDEX_FILENAME = "recordings_index.json"

# Layout of the index FILE (not of the parsing rules — those are versioned
# by ``code_fingerprint``). Bump when the JSON shape below changes.
INDEX_FORMAT = 1

Identity = tuple[int, int]


# ── Rules version ───────────────────────────────────────────────────


def code_fingerprint(root: Callable[..., Any], *, package: str = "backend") -> str:
    """A stable digest of what *root* computes.

    Covers the bytecode, constants, names and default arguments of
    *root* and, transitively, of every function of *package* it refers
    to (directly, through a default argument, or as ``module.attr`` of a
    *package* module), plus the value of every module-level constant and
    compiled regex those functions read. Line numbers and file names are
    left out, so moving code around does not invalidate anything.

    Stable across processes: nothing hash-randomised (set/frozenset
    order, ``id``) reaches the digest. It does change with the Python
    version's bytecode — at worst one full rebuild after an interpreter
    upgrade, which is the safe direction.

    What it cannot see: the internals of classes and of code outside
    *package* (stdlib, third-party) — those are named, not hashed.
    ``INDEX_FORMAT`` remains for changes to the file layout itself.
    """
    h = hashlib.sha256()
    _Fingerprinter(h, package).function(root)
    return h.hexdigest()


class _Fingerprinter:
    def __init__(self, h: "hashlib._Hash", package: str) -> None:
        self._h = h
        self._package = package
        self._seen: set[int] = set()

    def _feed(self, *parts: object) -> None:
        for part in parts:
            data = part if isinstance(part, bytes) else str(part).encode("utf-8", "surrogatepass")
            self._h.update(len(data).to_bytes(8, "little"))
            self._h.update(data)

    def _own(self, obj: object) -> bool:
        module = getattr(obj, "__module__", None) or ""
        return module == self._package or module.startswith(self._package + ".")

    def function(self, fn: types.FunctionType) -> None:
        self._feed("fn", fn.__module__, fn.__qualname__)
        if id(fn) in self._seen:
            return
        self._seen.add(id(fn))
        names: list[str] = []
        self._code(fn.__code__, names)
        self._feed("defaults")
        for value in fn.__defaults__ or ():
            self.value(value, fn.__globals__, names)
        for key in sorted(fn.__kwdefaults__ or {}):
            self._feed(key)
            self.value(fn.__kwdefaults__[key], fn.__globals__, names)
        self._feed("globals")
        for name in names:
            if name in fn.__globals__:
                self._feed(name)
                self.value(fn.__globals__[name], fn.__globals__, names)

    def _code(self, code: types.CodeType, names: list[str]) -> None:
        self._feed("code", code.co_code, code.co_argcount, code.co_kwonlyargcount, code.co_flags)
        self._feed(*code.co_names)
        for name in code.co_names:
            if name not in names:
                names.append(name)
        for const in code.co_consts:
            if isinstance(const, types.CodeType):
                self._code(const, names)
            else:
                self._literal(const)

    def _literal(self, value: object) -> None:
        if isinstance(value, (frozenset, set)):
            self._feed("set", *sorted(repr(v) for v in value))
        elif isinstance(value, (tuple, list)):
            self._feed(type(value).__name__, len(value))
            for item in value:
                self._literal(item)
        elif isinstance(value, dict):
            self._feed("dict", len(value))
            for key in sorted(value, key=repr):
                self._literal(key)
                self._literal(value[key])
        elif isinstance(value, re.Pattern):
            self._feed("re", value.pattern, value.flags)
        else:
            self._feed(type(value).__name__, repr(value))

    def value(self, value: object, scope: dict, names: list[str]) -> None:
        """A global (or default argument) the code reads."""
        if isinstance(value, types.FunctionType):
            if self._own(value):
                self.function(value)
            else:
                self._feed("extfn", value.__module__, value.__qualname__)
        elif isinstance(value, types.ModuleType):
            self._feed("module", value.__name__)
            if value.__name__ == self._package or value.__name__.startswith(self._package + "."):
                # ``recording_names.is_recording_stem``: the attribute
                # name is in the same ``co_names`` as the module's.
                for attr in list(names):
                    target = getattr(value, attr, None)
                    if isinstance(target, types.FunctionType) and self._own(target):
                        self._feed("attr", attr)
                        self.function(target)
        elif isinstance(value, type) or callable(value):
            self._feed("callable", getattr(value, "__module__", ""), getattr(value, "__qualname__", type(value).__name__))
        elif isinstance(value, (str, bytes, int, float, bool, type(None), tuple, list, frozenset, set, dict, re.Pattern)):
            self._literal(value)
        else:
            self._feed("object", type(value).__module__, type(value).__qualname__)


# ── The index ───────────────────────────────────────────────────────


class RecordingsMetadataIndex:
    """Thread-safe, lazily loaded, atomically persisted per-file cache.

    ``rules_version`` is a zero-argument callable so the fingerprint is
    computed once, on first use, after every function it reaches exists.
    """

    def __init__(
        self,
        path: Path,
        *,
        rules_version: Callable[[], str],
        fields: Iterable[str],
    ) -> None:
        self.path = Path(path)
        self._rules_version_fn = rules_version
        self._rules_version: Optional[str] = None
        self._fields = tuple(fields)
        self._lock = threading.Lock()
        self._entries: Optional[dict[str, tuple[Identity, dict[str, str]]]] = None
        self._dirty = False

    # Loading ----------------------------------------------------------

    def _version(self) -> str:
        if self._rules_version is None:
            self._rules_version = self._rules_version_fn()
        return self._rules_version

    def _ensure_loaded(self) -> dict[str, tuple[Identity, dict[str, str]]]:
        # Caller holds ``self._lock``.
        if self._entries is None:
            self._entries, self._dirty = self._read()
        return self._entries

    def _read(self) -> tuple[dict[str, tuple[Identity, dict[str, str]]], bool]:
        """The entries on disk, and whether the file must be rewritten.

        Never raises: anything unusable is logged and yields an empty
        (dirty) index so the next scan rebuilds and rewrites it."""
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return {}, True
        except OSError as e:
            logger.warning("recordings index: unreadable (%s), rebuilding", type(e).__name__)
            return {}, True
        try:
            doc = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            logger.warning("recordings index: corrupt (%d bytes), rebuilding", len(raw))
            return {}, True
        if not isinstance(doc, dict) or doc.get("format") != INDEX_FORMAT:
            logger.info("recordings index: other file format, rebuilding")
            return {}, True
        if doc.get("rules") != self._version():
            logger.info("recordings index: parsing rules changed, rebuilding")
            return {}, True
        stored = doc.get("entries")
        if not isinstance(stored, dict):
            logger.warning("recordings index: no entries table, rebuilding")
            return {}, True
        entries: dict[str, tuple[Identity, dict[str, str]]] = {}
        dropped = 0
        for key, record in stored.items():
            parsed = self._entry_from_json(record)
            if parsed is None:
                dropped += 1
                continue
            entries[key] = parsed
        if dropped:
            logger.warning("recordings index: dropped %d malformed entries", dropped)
        return entries, bool(dropped)

    def _entry_from_json(self, record: object) -> Optional[tuple[Identity, dict[str, str]]]:
        if not isinstance(record, list) or len(record) != 3:
            return None
        mtime_ns, size, entry = record
        if type(mtime_ns) is not int or type(size) is not int:
            return None
        if not isinstance(entry, dict) or set(entry) != set(self._fields):
            return None
        if not all(isinstance(v, str) for v in entry.values()):
            return None
        return (mtime_ns, size), entry

    # Access -----------------------------------------------------------

    def lookup(self, key: str, identity: Identity) -> Optional[dict[str, str]]:
        """The parsed entry for *key* if it was parsed at *identity*."""
        with self._lock:
            hit = self._ensure_loaded().get(key)
        if hit is not None and hit[0] == identity:
            return hit[1]
        return None

    def store(self, key: str, identity: Identity, entry: dict[str, str]) -> None:
        if set(entry) != set(self._fields):
            raise ValueError(f"recordings index entry must have fields {self._fields}")
        with self._lock:
            self._ensure_loaded()[key] = (identity, dict(entry))
            self._dirty = True

    def retain_only(self, live_keys: set[str]) -> None:
        """Drop every entry the latest scan did not see."""
        with self._lock:
            entries = self._ensure_loaded()
            stale = [k for k in entries if k not in live_keys]
            for k in stale:
                del entries[k]
            if stale:
                self._dirty = True

    def flush(self) -> None:
        """Write the index if it changed. A failed write is logged and
        kept dirty — the in-memory entries stay valid either way."""
        with self._lock:
            if self._entries is None or not self._dirty:
                return
            doc = {
                "format": INDEX_FORMAT,
                "rules": self._version(),
                "entries": {
                    key: [identity[0], identity[1], entry]
                    for key, (identity, entry) in self._entries.items()
                },
            }
            data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            try:
                atomic_write_bytes(self.path, data)
            except OSError as e:
                logger.warning("recordings index: write failed (%s)", type(e).__name__)
                return
            self._dirty = False

    def __len__(self) -> int:
        with self._lock:
            return len(self._ensure_loaded())
