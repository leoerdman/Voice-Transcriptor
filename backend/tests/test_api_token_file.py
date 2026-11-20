"""Where the backend's API token comes from, and the stale file it retires.

Since BM-01 the desktop shell mints the token per launch and passes it in
``TRANSCRIPTOR_API_TOKEN``; the user decided on 2026-11-20 that a file
token left by earlier builds is removed at launch. A standalone backend
(no env token) keeps using its file."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend import main as backend_main



class StaleApiTokenFileTests(unittest.TestCase):
    """The user's 2026-11-20 decision: with the token supplied by the shell,
    the persisted api_token.txt is removed at launch; a standalone backend
    keeps using it."""

    def test_env_token_removes_the_stale_file(self):
        from unittest import mock

        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "api_token.txt"
            path.write_text("old-token", encoding="utf-8")
            with mock.patch.object(backend_main, "API_TOKEN_PATH", path), \
                    mock.patch.dict("os.environ", {"TRANSCRIPTOR_API_TOKEN": "launch-token"}):
                self.assertEqual(backend_main._load_or_create_api_token(), "launch-token")
            self.assertFalse(path.exists())

    def test_standalone_backend_keeps_its_file_token(self):
        from unittest import mock

        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "api_token.txt"
            path.write_text("file-token", encoding="utf-8")
            env = {k: v for k, v in __import__("os").environ.items() if k != "TRANSCRIPTOR_API_TOKEN"}
            with mock.patch.object(backend_main, "API_TOKEN_PATH", path), \
                    mock.patch.dict("os.environ", env, clear=True):
                self.assertEqual(backend_main._load_or_create_api_token(), "file-token")
            self.assertTrue(path.exists())



if __name__ == "__main__":
    unittest.main()
