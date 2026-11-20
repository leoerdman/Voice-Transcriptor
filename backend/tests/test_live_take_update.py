"""A take's collection can change after the live socket opened (S-04).

A screen take whose screen session could not start is a voice take; the
renderer says so on the live socket and the recovery sidecar is re-filed,
so a crash after the demotion recovers the take under Live, not under
Screen Sessions with no screenshots."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from backend import main as backend_main


def _recovery(tmp: Path, collection: str = "screen", sid: str = "screen-20261120-161137-697") -> dict:
    meta = {"session_id": "s1", "recording_collection": collection, "screen_session_id": sid, "status": "recording"}
    meta_path = tmp / "s1.json"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return {"meta": dict(meta), "meta_path": meta_path}


class FakeSocket:
    def __init__(self, frames):
        self._frames = list(frames)

    async def receive(self):
        return self._frames.pop(0)


class TakeUpdateTests(unittest.TestCase):
    def test_demotion_refiles_the_sidecar_as_live_and_drops_the_screen_session(self):
        with tempfile.TemporaryDirectory() as d:
            rec = _recovery(Path(d))
            backend_main._apply_live_take_update(rec, {"type": "take", "recording_collection": "live"})
            on_disk = json.loads(rec["meta_path"].read_text(encoding="utf-8"))
            self.assertEqual(on_disk["recording_collection"], "live")
            self.assertEqual(on_disk["screen_session_id"], "")
            self.assertEqual(on_disk["status"], "recording")
            self.assertEqual(rec["meta"]["recording_collection"], "live")

    def test_an_unsupported_collection_changes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            rec = _recovery(Path(d))
            backend_main._apply_live_take_update(rec, {"type": "take", "recording_collection": "nope"})
            on_disk = json.loads(rec["meta_path"].read_text(encoding="utf-8"))
            self.assertEqual(on_disk["recording_collection"], "screen")
            self.assertTrue(on_disk["screen_session_id"])

    def test_no_recovery_context_is_harmless(self):
        backend_main._apply_live_take_update(None, {"type": "take", "recording_collection": "live"})

    def test_the_live_receiver_applies_take_updates_and_never_returns_them(self):
        with tempfile.TemporaryDirectory() as d:
            rec = _recovery(Path(d))
            ws = FakeSocket([
                {"type": "websocket.receive", "text": json.dumps({"type": "take", "recording_collection": "live"})},
                {"type": "websocket.receive", "bytes": b"\x00\x01"},
            ])
            msg = asyncio.run(backend_main._ws_recv_live(ws, rec))
            self.assertEqual(msg, {"kind": "bytes", "data": b"\x00\x01"})
            self.assertEqual(rec["meta"]["recording_collection"], "live")

    def test_finalize_still_reaches_the_session(self):
        ws = FakeSocket([{"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}])
        msg = asyncio.run(backend_main._ws_recv_live(ws, None))
        self.assertEqual(msg["payload"]["type"], "finalize")


if __name__ == "__main__":
    unittest.main()


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
