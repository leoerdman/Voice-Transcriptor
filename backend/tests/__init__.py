"""Suite-wide safety net: no backend test may touch the real home directory.

``backend.config`` resolves ``DATA_DIR`` at IMPORT TIME
(``DATA_DIR = _resolve_data_dir()``, module level) from
``TRANSCRIPTOR_DATA_DIR`` or, absent that, ``Path.home()`` — and
CREATES that directory as a side effect of importing the module
(``candidate.mkdir(parents=True, exist_ok=True, ...)``). Most tests
redirect ``TRANSCRIPTOR_DATA_DIR``/``HOME`` themselves, in their own
``setUp``, before touching ``backend.config`` — but ``unittest
discover`` IMPORTS every test module (which is when a module-level
``from backend.main import ...`` or ``from backend.config import ...``
runs) before it RUNS any test's ``setUp``. A test file that imports
either module at the top, with no per-test guard of its own, resolves
``DATA_DIR`` against whatever ``TRANSCRIPTOR_DATA_DIR``/``HOME`` the
invoking shell happens to have — on a developer machine with the real
app installed, that is the real
``~/Library/Application Support/Transcriptor`` (macOS) or
``~/.transcriptor`` fallback, both of which hold the user's actual
config, API keys and recordings archive. This already happened once
(the encryption key was created on a developer's real ``~/.transcriptor``
by an early version of a test, before it redirected ``HOME`` — see
``docs/archive/audit-2026-09-04/backend-fix-journal.md``, "Швы" section, debt
D-10) and is exactly what running the suite must never risk again.

``backend/tests/__init__.py`` is imported before ANY module inside this
package — that is how Python resolves ``backend.tests.test_x`` — so
setting the guard here, rather than depending on every test file to set
it correctly, closes the gap for good: by the time the first
``test_*.py`` file's top-level ``import`` runs, ``TRANSCRIPTOR_DATA_DIR``
and ``HOME`` (and, for the Windows branch of
``backend.config._default_data_dir``, ``USERPROFILE``/``APPDATA``)
already point into a directory this process created under the system
temp dir — never the developer's real home.

Individual tests remain free to redirect these further (most already
do, into their OWN per-test ``tempfile.TemporaryDirectory()``) — this
module only replaces what a real shell would otherwise have left in
place for the FIRST import, and every later override still lands in
some ``tempfile``-issued directory rather than falling through to a
real one.

Does NOT delete anything under the real ``~/.transcriptor`` or
``~/Library/Application Support/Transcriptor`` — this module only
stops FUTURE test runs from writing there. The stray
``~/.transcriptor/.encryption_key`` from before this guard existed is
the user's file to remove, per the same debt entry above.
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile
from pathlib import Path

_SUITE_TMP_ROOT = tempfile.mkdtemp(prefix="transcriptor-backend-tests-")


def _redirected(*, name: str, subdir: str) -> str:
    """Point *name* at ``_SUITE_TMP_ROOT/subdir``, creating it, and return it.

    Unconditional, not ``setdefault``: the whole point is that a shell's
    ambient ``HOME``/``TRANSCRIPTOR_DATA_DIR`` (which, unlike an unset
    var, is present in essentially every real environment) must never be
    the value a test module sees on import.
    """
    path = os.path.join(_SUITE_TMP_ROOT, subdir)
    Path(path).mkdir(parents=True, exist_ok=True)
    os.environ[name] = path
    return path


# Order matters only in that all four must be set before the first
# ``test_*.py`` submodule of this package is imported — which, being a
# sibling import inside the same package, cannot happen before this
# module finishes running. No test in this suite legitimately needs the
# real home directory, so this is a plain override for the life of the
# process, not a default.
_redirected(name="TRANSCRIPTOR_DATA_DIR", subdir="data")
_redirected(name="HOME", subdir="home")
_redirected(name="USERPROFILE", subdir="home")
_redirected(name="APPDATA", subdir="appdata")


@atexit.register
def _cleanup_suite_tmp_root() -> None:
    shutil.rmtree(_SUITE_TMP_ROOT, ignore_errors=True)
