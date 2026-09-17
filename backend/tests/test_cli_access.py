"""Command-line access: the switch, the token's reach, and the files.

Three things must hold, and none of them are visible from the app's own
window:

    1. The SWITCH is the token file. Enabled means the files exist;
       disabled means they are gone and the token is revoked in the
       running process, not merely marked off in a config nobody reads.
    2. The CLI token is NOT the renderer's token under another name. It
       opens the transcription routes and is refused everywhere else —
       config, provider keys, the archive — so a token pasted into an
       agent's prompt cannot read the user's Deepgram key.
    3. A half-written switch-on reports OFF. Token written, wrapper
       not, is the state that shows a command path with no command
       behind it.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def _reload_backend_main(data_dir: str):
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for module_name in ("backend.main", "backend.config", "backend.storage", "backend.cli_access"):
        sys.modules.pop(module_name, None)
    return importlib.import_module("backend.main")


class _FakeUrl:
    def __init__(self, path: str) -> None:
        self.path = path


class _FakeClient:
    host = "127.0.0.1"


class _FakeRequest:
    """The three things ``_require_api_auth`` reads, and nothing else."""

    def __init__(self, method: str, path: str, token: str) -> None:
        self.method = method
        self.url = _FakeUrl(path)
        self.headers = {"x-api-token": token}
        self.client = _FakeClient()
        self.scope = {"server": ("127.0.0.1", 8321)}


class CliRouteRuleTests(unittest.TestCase):
    """``cli_token_may_call`` is pure — no app, no files."""

    def setUp(self):
        from backend import cli_access

        self.cli_access = cli_access

    def test_transcription_routes_are_open(self):
        may = self.cli_access.cli_token_may_call
        self.assertTrue(may("GET", "/api/cli"))
        self.assertTrue(may("POST", "/api/jobs/from-path"))
        self.assertTrue(may("POST", "/api/remote/jobs/from-path"))
        self.assertTrue(may("GET", "/api/jobs/abc-123"))
        self.assertTrue(may("POST", "/api/jobs/abc-123/cancel"))
        self.assertTrue(may("GET", "/api/jobs/abc-123/download/txt"))
        self.assertTrue(may("POST", "/api/recordings/save-from-path"))

    def test_everything_else_is_closed(self):
        may = self.cli_access.cli_token_may_call
        # The config and the provider keys it carries.
        self.assertFalse(may("GET", "/api/config"))
        self.assertFalse(may("POST", "/api/config"))
        # The archive: listing, reading and deleting the user's recordings.
        self.assertFalse(may("GET", "/api/recordings"))
        self.assertFalse(may("DELETE", "/api/recordings/note.txt"))
        # Its own switch — a CLI token must not be able to re-issue itself.
        self.assertFalse(may("POST", "/api/cli/enable"))
        self.assertFalse(may("POST", "/api/cli/disable"))

    def test_method_is_part_of_the_rule(self):
        may = self.cli_access.cli_token_may_call
        self.assertFalse(may("POST", "/api/cli"))
        self.assertFalse(may("DELETE", "/api/jobs/abc-123"))
        self.assertTrue(may("get", "/api/jobs/abc-123"))

    def test_paths_are_matched_whole(self):
        may = self.cli_access.cli_token_may_call
        # A prefix must not open what follows it.
        self.assertFalse(may("GET", "/api/jobs/abc/../../api/config"))
        self.assertFalse(may("GET", "/api/cli/enable"))
        self.assertFalse(may("POST", "/api/jobs/from-path/extra"))


class BaseUrlFromScopeTests(unittest.TestCase):
    def setUp(self):
        from backend import cli_access

        self.base_url_from_scope = cli_access.base_url_from_scope

    def test_reads_the_bound_socket(self):
        self.assertEqual(
            self.base_url_from_scope({"server": ("127.0.0.1", 8324)}),
            "http://127.0.0.1:8324",
        )

    def test_ipv6_host_is_bracketed(self):
        self.assertEqual(
            self.base_url_from_scope({"server": ("::1", 8321)}),
            "http://[::1]:8321",
        )

    def test_missing_or_broken_server_yields_empty(self):
        for scope in ({}, {"server": None}, {"server": ("127.0.0.1",)},
                      {"server": ("", 8321)}, {"server": ("127.0.0.1", 0)},
                      {"server": ("127.0.0.1", "nope")}):
            self.assertEqual(self.base_url_from_scope(scope), "", scope)


class CliDefaultsTests(unittest.TestCase):
    """The CLI transcribes what the Upload tab would, unless told otherwise."""

    def setUp(self):
        from backend import cli_access

        self.cli_defaults = cli_access.cli_defaults

    def test_follows_the_upload_tab_for_a_remote_group(self):
        cfg = {
            "preferences": {
                "ui": {
                    "provider_group": "deepgram",
                    "remote_model_deepgram": "nova-3",
                    "upload_language": "ru",
                    "upload_diarize": True,
                }
            }
        }
        got = self.cli_defaults(cfg, True)
        self.assertEqual(got["engine"], "deepgram")
        self.assertEqual(got["model"], "nova-3")
        self.assertEqual(got["language"], "ru")
        self.assertTrue(got["diarize"])

    def test_local_model_survives_and_gigaam_needs_the_package(self):
        from backend.model_catalog import (
            DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
            GIGAAM_MODELS,
        )

        cfg = {"preferences": {"ui": {"provider_group": "local", "local_model": "medium"}}}
        self.assertEqual(self.cli_defaults(cfg, False)["model"], "medium")

        cfg["preferences"]["ui"]["local_model"] = GIGAAM_MODELS[0]
        # Installed: the CLI may name it, and it is offered.
        self.assertEqual(self.cli_defaults(cfg, True)["model"], GIGAAM_MODELS[0])
        self.assertIn(GIGAAM_MODELS[0], self.cli_defaults(cfg, True)["local_models"])
        # Not installed: fall back rather than fail later on a model the
        # backend refuses, and do not offer what cannot run.
        self.assertEqual(
            self.cli_defaults(cfg, False)["model"], DEFAULT_LOCAL_TRANSCRIPTION_MODEL
        )
        self.assertNotIn(GIGAAM_MODELS[0], self.cli_defaults(cfg, False)["local_models"])

    def test_an_empty_config_still_yields_a_usable_answer(self):
        got = self.cli_defaults({}, False)
        self.assertEqual(got["engine"], "local")
        self.assertEqual(got["language"], "auto")
        self.assertFalse(got["diarize"])
        self.assertIn("local", got["engines"])


class CliAccessFileTests(unittest.TestCase):
    """``CliAccess`` against a real directory — the switch IS the files."""

    def setUp(self):
        from backend.cli_access import CliAccess

        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.CliAccess = CliAccess
        self.access = CliAccess(self.data_dir, python_executable="/usr/bin/python3",
                                cli_script=Path("/app/backend/cli.py"), platform="darwin")

    def tearDown(self):
        self._tmp.cleanup()

    def test_enable_writes_token_connection_and_wrapper(self):
        self.access.enable("http://127.0.0.1:8321")
        self.assertTrue(self.access.is_enabled())
        token = self.access.token_path.read_text(encoding="utf-8").strip()
        self.assertTrue(token)
        self.assertTrue(self.access.token_matches(token))
        self.assertFalse(self.access.token_matches(token + "x"))

        connection = json.loads(self.access.connection_path.read_text(encoding="utf-8"))
        self.assertEqual(connection["base_url"], "http://127.0.0.1:8321")
        self.assertEqual(connection["token"], token)

        wrapper = self.access.wrapper_path.read_text(encoding="utf-8")
        self.assertIn("/app/backend/cli.py", wrapper)
        self.assertIn(str(self.access.connection_path), wrapper)
        self.assertTrue(wrapper.startswith("#!/bin/sh"))
        # -E, because this runs the app's bundled interpreter inside
        # someone else's shell: a PYTHONHOME in their profile points it
        # at a different Python and it does not start.
        self.assertIn(" -E ", wrapper)

    def test_the_windows_wrapper_carries_the_same_flags(self):
        from backend.cli_access import render_posix_wrapper, render_windows_wrapper

        posix = render_posix_wrapper("/py", "/cli.py", "/conn.json")
        windows = render_windows_wrapper("C:\\py.exe", "C:\\cli.py", "C:\\conn.json")
        for flag in ("-E", "-B"):
            self.assertIn(flag, posix)
            self.assertIn(flag, windows)
        self.assertIn("%*", windows)

    def test_secrets_are_owner_only_and_the_wrapper_is_executable(self):
        self.access.enable("http://127.0.0.1:8321")
        for path in (self.access.token_path, self.access.connection_path):
            mode = stat.S_IMODE(path.stat().st_mode)
            self.assertEqual(mode & 0o077, 0, f"{path} is readable by others")
        self.assertTrue(os.access(self.access.wrapper_path, os.X_OK))

    def test_enabling_twice_keeps_the_token_and_moves_the_address(self):
        self.access.enable("http://127.0.0.1:8321")
        first = self.access.token_path.read_text(encoding="utf-8").strip()
        self.access.enable("http://127.0.0.1:8399")
        self.assertEqual(self.access.token_path.read_text(encoding="utf-8").strip(), first)
        self.assertEqual(self.access.base_url, "http://127.0.0.1:8399")

    def test_sync_connection_follows_a_moved_port(self):
        self.access.enable("http://127.0.0.1:8321")
        self.access.sync_connection("http://127.0.0.1:8402")
        connection = json.loads(self.access.connection_path.read_text(encoding="utf-8"))
        self.assertEqual(connection["base_url"], "http://127.0.0.1:8402")

    def test_sync_connection_does_nothing_while_disabled(self):
        self.access.sync_connection("http://127.0.0.1:8402")
        self.assertFalse(self.access.connection_path.exists())

    def test_disable_revokes_in_memory_and_on_disk(self):
        self.access.enable("http://127.0.0.1:8321")
        token = self.access.token_path.read_text(encoding="utf-8").strip()
        self.access.disable()
        self.assertFalse(self.access.is_enabled())
        self.assertFalse(self.access.token_matches(token))
        for path in (self.access.token_path, self.access.connection_path, self.access.wrapper_path):
            self.assertFalse(path.exists(), path)

    def test_load_adopts_what_is_on_disk(self):
        self.access.enable("http://127.0.0.1:8321")
        token = self.access.token_path.read_text(encoding="utf-8").strip()

        reopened = self.CliAccess(self.data_dir, platform="darwin")
        reopened.load()
        self.assertTrue(reopened.is_enabled())
        self.assertTrue(reopened.token_matches(token))
        self.assertEqual(reopened.base_url, "http://127.0.0.1:8321")

    def test_load_without_a_token_is_off_even_with_a_connection_file(self):
        self.access.enable("http://127.0.0.1:8321")
        self.access.token_path.unlink()
        reopened = self.CliAccess(self.data_dir, platform="darwin")
        reopened.load()
        self.assertFalse(reopened.is_enabled())
        self.assertFalse(reopened.token_matches("anything"))

    def test_a_half_written_switch_on_reports_off(self):
        # The failure worth naming: token written, wrapper not. Reporting
        # "on" there shows a command path with no command behind it.
        with mock.patch.object(
            self.CliAccess, "_write_wrapper", side_effect=OSError("read-only volume")
        ):
            with self.assertRaises(OSError):
                self.access.enable("http://127.0.0.1:8321")
        self.assertFalse(self.access.is_enabled())
        self.assertFalse(self.access.token_path.exists())
        self.assertFalse(self.access.connection_path.exists())
        self.assertFalse(self.access.wrapper_path.exists())

    def test_a_failed_refresh_keeps_a_working_install(self):
        # Already on: the client's credential is still good, and dropping
        # it to report a failed rewrite would break a working install.
        self.access.enable("http://127.0.0.1:8321")
        token = self.access.token_path.read_text(encoding="utf-8").strip()
        with mock.patch.object(
            self.CliAccess, "_write_wrapper", side_effect=OSError("read-only volume")
        ):
            with self.assertRaises(OSError):
                self.access.enable("http://127.0.0.1:8399")
        self.assertTrue(self.access.is_enabled())
        self.assertTrue(self.access.token_matches(token))

    def test_status_says_nothing_while_disabled(self):
        status = self.access.status(base_url="http://127.0.0.1:8321")
        self.assertFalse(status["enabled"])
        self.assertEqual(status["base_url"], "")
        self.assertEqual(status["command_path"], "")
        self.assertEqual(status["cards"], [])

        self.access.enable("http://127.0.0.1:8321")
        status = self.access.status(base_url="http://127.0.0.1:8321")
        self.assertTrue(status["enabled"])
        self.assertEqual(status["command_path"], str(self.access.wrapper_path))
        self.assertTrue(status["cards"])

    def test_cards_quote_a_path_with_spaces(self):
        from backend.cli_access import command_cards

        cards = command_cards("/Users/a b/Library/Application Support/cli/transcriptor", "darwin")
        text = "\n".join(card["text"] for card in cards)
        self.assertIn("'/Users/a b/Library/Application Support/cli/transcriptor'", text)
        self.assertEqual({card["id"] for card in cards}, {"agent", "transcribe", "path"})


class CliAuthBoundaryTests(unittest.TestCase):
    """The auth path, through ``backend.main`` with a real data dir."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self.main = _reload_backend_main(self._tmp.name)
        self.main.CLI_ACCESS.enable("http://127.0.0.1:8321")
        self.cli_token = self.main.CLI_ACCESS.token_path.read_text(encoding="utf-8").strip()

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        for module_name in ("backend.main", "backend.config", "backend.storage", "backend.cli_access"):
            sys.modules.pop(module_name, None)

    def _auth(self, method: str, path: str, token: str):
        return asyncio.run(self.main._require_api_auth(_FakeRequest(method, path, token)))

    def _status(self, method: str, path: str, token: str) -> int:
        from fastapi import HTTPException

        try:
            self._auth(method, path, token)
        except HTTPException as e:
            return e.status_code
        return 200

    def test_renderer_token_reaches_everything(self):
        self.assertEqual(self._status("GET", "/api/config", self.main.API_TOKEN), 200)
        self.assertEqual(self._status("POST", "/api/cli/disable", self.main.API_TOKEN), 200)

    def test_cli_token_reaches_the_transcription_routes(self):
        self.assertEqual(self._status("GET", "/api/cli", self.cli_token), 200)
        self.assertEqual(self._status("POST", "/api/jobs/from-path", self.cli_token), 200)
        self.assertEqual(self._status("GET", "/api/jobs/xyz", self.cli_token), 200)

    def test_cli_token_cannot_read_the_config_or_widen_itself(self):
        # 403, not 401: the token is valid — this path is closed to it.
        self.assertEqual(self._status("GET", "/api/config", self.cli_token), 403)
        self.assertEqual(self._status("POST", "/api/cli/enable", self.cli_token), 403)
        self.assertEqual(self._status("GET", "/api/recordings", self.cli_token), 403)

    def test_a_revoked_cli_token_is_refused_at_once(self):
        self.main.CLI_ACCESS.disable()
        self.assertEqual(self._status("GET", "/api/cli", self.cli_token), 401)

    def test_no_token_and_a_wrong_token_are_both_401(self):
        self.assertEqual(self._status("GET", "/api/cli", ""), 401)
        self.assertEqual(self._status("GET", "/api/cli", "not-a-token"), 401)


class CliRouteTests(unittest.TestCase):
    """The three routes, called the way FastAPI calls them."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self.main = _reload_backend_main(self._tmp.name)
        self.request = _FakeRequest("GET", "/api/cli", "")

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        for module_name in ("backend.main", "backend.config", "backend.storage", "backend.cli_access"):
            sys.modules.pop(module_name, None)

    def test_enable_then_disable_round_trip(self):
        off = self.main.get_cli_access(self.request, _auth=None)
        self.assertFalse(off["enabled"])
        self.assertIn("defaults", off)

        on = self.main.enable_cli_access(self.request, _auth=None)
        self.assertTrue(on["enabled"])
        self.assertEqual(on["base_url"], "http://127.0.0.1:8321")
        self.assertTrue(Path(on["command_path"]).exists())
        self.assertTrue(on["cards"])
        self.assertEqual(on["defaults"]["engine"], "local")

        again = self.main.disable_cli_access(self.request, _auth=None)
        self.assertFalse(again["enabled"])
        self.assertFalse(Path(on["command_path"]).exists())

    def test_status_never_carries_the_token(self):
        payload = self.main.enable_cli_access(self.request, _auth=None)
        token = self.main.CLI_ACCESS.token_path.read_text(encoding="utf-8").strip()
        self.assertNotIn(token, json.dumps(payload))

    def test_enable_reports_a_write_failure_rather_than_a_false_on(self):
        from fastapi import HTTPException
        from backend.cli_access import CliAccess

        with mock.patch.object(CliAccess, "_write_wrapper", side_effect=OSError("read-only")):
            with self.assertRaises(HTTPException) as caught:
                self.main.enable_cli_access(self.request, _auth=None)
        self.assertEqual(caught.exception.status_code, 500)
        self.assertFalse(self.main.get_cli_access(self.request, _auth=None)["enabled"])


if __name__ == "__main__":
    unittest.main()
