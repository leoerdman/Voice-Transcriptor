"""``backend/tests/__init__.py`` guards the whole suite against writing
into the real home directory.

Item 6 of the "Швы" cross-domain task: ``backend.config`` resolves and
CREATES its data directory at import time from ``TRANSCRIPTOR_DATA_DIR``
or ``HOME``, so a test file that imports ``backend.config``/``backend.main``
at module level, before any per-test isolation runs, would otherwise
touch the developer's real ``~/Library/Application Support/Transcriptor``
or ``~/.transcriptor``. See ``backend/tests/__init__.py``'s module
docstring for the mechanism and
``docs/archive/audit-2026-09-04/backend-fix-journal.md`` ("Швы" section) for the
incident (debt D-10) that motivated it.

This suite does not re-verify that mechanism (it cannot, without
spawning a fresh interpreter for every scenario) — it pins the property
that actually matters: by the time THIS test runs, ``HOME`` and
``TRANSCRIPTOR_DATA_DIR`` are already redirected away from the real
system home directory, into a location under the OS temp dir.
"""

from __future__ import annotations

import os
import pwd
import tempfile
import unittest
from pathlib import Path


def _real_system_home() -> str:
    """The account's actual home directory, independent of ``$HOME``.

    ``Path.home()`` / ``os.path.expanduser("~")`` read the ``HOME`` env
    var first on POSIX — which is exactly the value this guard
    overrides — so asserting against it would be circular. ``pwd`` reads
    the account database directly and ignores ``HOME`` entirely.
    """
    return pwd.getpwuid(os.getuid()).pw_dir


class SuiteHomeIsolationTests(unittest.TestCase):
    def test_home_env_var_is_redirected_away_from_the_real_account_home(self):
        real_home = _real_system_home()
        self.assertNotEqual(os.environ.get("HOME"), real_home)
        self.assertTrue(
            Path(os.environ.get("HOME", "")).is_relative_to(Path(tempfile.gettempdir())),
            f"HOME={os.environ.get('HOME')!r} is not under the system temp dir",
        )

    def test_transcriptor_data_dir_env_var_is_always_a_temp_directory_between_tests(self):
        # A handful of tests deliberately pop TRANSCRIPTOR_DATA_DIR
        # WITHIN their own test body, to exercise backend.config's
        # fall-through-to-HOME behaviour (test_config.py's
        # DataDirFallbackTests) — but that is transient, inside one
        # test's own setUp/tearDown pair, and every tearDown in this
        # suite now restores whatever value setUp captured (never a
        # bare, unconditional pop — see the "Швы" journal entry for the
        # five files that had to be fixed to make that true). So BETWEEN
        # tests, which is the only place this assertion runs, the
        # variable is never genuinely absent.
        value = os.environ.get("TRANSCRIPTOR_DATA_DIR", "")
        self.assertTrue(value, "TRANSCRIPTOR_DATA_DIR must be set between tests")
        self.assertTrue(
            Path(value).is_relative_to(Path(tempfile.gettempdir())),
            f"TRANSCRIPTOR_DATA_DIR={value!r} is not under the system temp dir",
        )

    def test_a_bare_import_of_backend_config_resolves_data_dir_under_the_temp_root(self):
        # The exact failure mode this guard closes: backend.config
        # resolves (and creates) DATA_DIR as a side effect of import,
        # with whatever HOME/TRANSCRIPTOR_DATA_DIR is ambient at that
        # moment. Reload it here to exercise that import-time resolution
        # against the CURRENT (guarded) environment, the same way a
        # module-level ``from backend.config import ...`` in another
        # test file would.
        import importlib
        import sys

        sys.modules.pop("backend.config", None)
        config_mod = importlib.import_module("backend.config")
        try:
            self.assertTrue(
                config_mod.DATA_DIR.is_relative_to(Path(tempfile.gettempdir())),
                f"backend.config.DATA_DIR={config_mod.DATA_DIR} escaped the temp root",
            )
        finally:
            sys.modules.pop("backend.config", None)

    def test_userprofile_and_appdata_are_also_redirected(self):
        # The Windows branch of backend.config._default_data_dir reads
        # APPDATA (falling back to Path.home()); test_recording_names.py
        # separately exercises USERPROFILE-based path construction. Both
        # get the same treatment as HOME so neither can fall through to
        # a real Windows profile directory on a CI runner that happens
        # to have one set.
        for name in ("USERPROFILE", "APPDATA"):
            value = os.environ.get(name, "")
            self.assertTrue(value, f"{name} must be set by backend/tests/__init__.py")
            self.assertTrue(
                Path(value).is_relative_to(Path(tempfile.gettempdir())),
                f"{name}={value!r} is not under the system temp dir",
            )
