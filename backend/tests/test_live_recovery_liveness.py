"""Liveness of a live session is process state, not a field on disk.

The promote guard used to read ``status == "recording"`` out of the
recovery sidecar. That field is written when a session opens and
rewritten when it closes, so a session interrupted by a crash, a SIGKILL
or an installer leaves it saying "recording" forever.

The two endpoints then contradicted each other. ``GET
/api/live/recoveries`` offered the session (it has a spool file and
enough bytes); ``POST .../promote`` refused it with 409 "session is
still recording". The renderer promotes every listed recovery on
startup, so the pair produced a permanent, self-renewing failure —
"Could not recover 1 interrupted recording" on every launch, with the
audio permanently unreachable.

Reproduced against the running app before the fix: the list returned
session cd98fa10 with 42.92 s of audio, and promote answered 409.
"""

import importlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


SESSION = "cd98fa10-04dd-4185-a56c-df0b9d09a130"


class LiveRecoveryLivenessTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_home = os.environ.get("HOME")
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._home = tempfile.TemporaryDirectory()
        os.environ["HOME"] = self._home.name
        self._tmp = tempfile.TemporaryDirectory(dir=self._home.name)
        self.main = _fresh_main_module(self._tmp.name)
        self.main.LIVE_RECOVERY_DIR.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        self._tmp.cleanup()
        self._home.cleanup()
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home

    def _crashed_session(self, session_id: str = SESSION, seconds: float = 43.0) -> Path:
        """A spool + sidecar exactly as a killed process leaves them."""
        stem = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{session_id}"
        pcm = self.main.LIVE_RECOVERY_DIR / f"{stem}.pcm16"
        pcm.write_bytes(b"\x00\x01" * int(seconds * self.main.LIVE_SAMPLE_RATE_HZ))
        (self.main.LIVE_RECOVERY_DIR / f"{stem}.json").write_text(
            json.dumps({
                "session_id": session_id,
                "started_at": datetime.now().isoformat(),
                # The crash signature: never rewritten on close.
                "finished_at": "",
                "bytes": 0,
                "chunks": 0,
                "sample_rate": self.main.LIVE_SAMPLE_RATE_HZ,
                "status": "recording",
                "model": "nova-3",
                "language": "auto",
            }),
            encoding="utf-8",
        )
        return pcm

    # ── the registry itself ────────────────────────────────────────
    def test_no_session_is_streaming_in_a_fresh_process(self) -> None:
        # The property that makes the whole fix work: after a crash the
        # set is empty by construction, so nothing stale can claim to be
        # live.
        self.assertFalse(self.main._live_session_is_streaming(SESSION))

    def test_register_and_unregister_are_idempotent(self) -> None:
        self.main._register_live_session(SESSION)
        self.main._register_live_session(SESSION)
        self.assertTrue(self.main._live_session_is_streaming(SESSION))
        self.main._unregister_live_session(SESSION)
        self.main._unregister_live_session(SESSION)
        self.assertFalse(self.main._live_session_is_streaming(SESSION))

    def test_empty_session_id_is_never_registered(self) -> None:
        self.main._register_live_session("")
        self.assertFalse(self.main._live_session_is_streaming(""))

    # ── the contradiction that broke recovery ──────────────────────
    def test_a_crashed_session_is_listed(self) -> None:
        self._crashed_session()
        listed = [r["session_id"] for r in self.main._list_live_recoveries()]
        self.assertIn(SESSION, listed)

    def test_a_crashed_session_is_no_longer_refused_by_the_guard(self) -> None:
        # The exact regression: sidecar says "recording", nothing is
        # streaming, so the guard must not fire.
        self._crashed_session()
        self.assertFalse(self.main._live_session_is_streaming(SESSION))

    def test_list_and_guard_agree_while_a_session_streams(self) -> None:
        # Both endpoints consult the same predicate, so the list cannot
        # offer what promote would reject.
        self._crashed_session()
        self.main._register_live_session(SESSION)
        try:
            listed = [r["session_id"] for r in self.main._list_live_recoveries()]
            self.assertNotIn(SESSION, listed)
            self.assertTrue(self.main._live_session_is_streaming(SESSION))
        finally:
            self.main._unregister_live_session(SESSION)

    def test_the_session_becomes_listable_once_streaming_ends(self) -> None:
        self._crashed_session()
        self.main._register_live_session(SESSION)
        self.main._unregister_live_session(SESSION)
        listed = [r["session_id"] for r in self.main._list_live_recoveries()]
        self.assertIn(SESSION, listed)

    def test_an_unrelated_streaming_session_does_not_hide_this_one(self) -> None:
        self._crashed_session()
        self.main._register_live_session("11111111-2222-3333-4444-555555555555")
        try:
            listed = [r["session_id"] for r in self.main._list_live_recoveries()]
            self.assertIn(SESSION, listed)
        finally:
            self.main._unregister_live_session("11111111-2222-3333-4444-555555555555")

    def test_listing_uses_the_spool_size_when_the_sidecar_says_zero(self) -> None:
        # A crashed sidecar reports bytes=0 because it is only updated on
        # close; the spool on disk is the truth.
        self._crashed_session(seconds=43.0)
        record = next(
            r for r in self.main._list_live_recoveries() if r["session_id"] == SESSION
        )
        self.assertGreater(record["bytes"], 0)
        self.assertAlmostEqual(record["duration_sec"], 43.0, delta=0.5)


class SessionIdMatchingTests(unittest.TestCase):
    """BM-28: ids may contain underscores, so ``*_b`` matched ``<ts>_a_b``."""

    setUp = LiveRecoveryLivenessTests.setUp
    tearDown = LiveRecoveryLivenessTests.tearDown

    def _spool(self, stem: str) -> Path:
        pcm = self.main.LIVE_RECOVERY_DIR / f"{stem}.pcm16"
        pcm.write_bytes(b"\x00\x01" * 32000)
        pcm.with_suffix(".json").write_text("{}", encoding="utf-8")
        return pcm

    def test_discarding_b_never_touches_a_b(self) -> None:
        other = self._spool("20261120_101010_a_b")
        mine = self._spool("20261120_101011_b")
        self.main._delete_live_recovery("b")
        self.assertFalse(mine.exists())
        self.assertTrue(other.exists(), "session a_b was deleted by a discard of b")
        self.assertTrue(other.with_suffix(".json").exists())

    def test_the_paths_of_b_are_bs(self) -> None:
        self._spool("20261120_101011_b")
        self._spool("20261120_101012_a_b")
        pcm, _meta = self.main._live_recovery_paths("b")
        self.assertEqual(pcm.name, "20261120_101011_b.pcm16")


class SpoolHasOneOwnerTests(unittest.TestCase):
    """BL-01: while the WebSocket handler owns a session, a save/discard
    must not unlink the spool the finalize-time recovery still reads."""

    setUp = LiveRecoveryLivenessTests.setUp
    tearDown = LiveRecoveryLivenessTests.tearDown

    def _open(self) -> dict:
        recovery = self.main._open_live_recovery(
            session_id=SESSION,
            started_at=datetime.now(),
            provider="deepgram",
            model="nova-3",
            language="auto",
            archive_dir="",
            recording_collection="live",
        )
        self.main._record_recovery_chunk(
            recovery, b"\x00\x01" * (2 * self.main.LIVE_SAMPLE_RATE_HZ)
        )
        return recovery

    def _files(self) -> list[str]:
        return sorted(p.suffix for p in self.main.LIVE_RECOVERY_DIR.iterdir())

    def test_a_save_during_the_session_leaves_the_spool_readable(self) -> None:
        self.main._register_live_session(SESSION)
        recovery = self._open()
        try:
            self.assertTrue(self.main._safe_delete_live_recovery(SESSION))
            self.assertGreater(len(self.main._recovery_spool_bytes(recovery)), 0)
        finally:
            self.main._end_live_session_ownership(SESSION, recovery)

    def test_the_deferred_discard_runs_after_finalize_and_leaves_nothing(self) -> None:
        self.main._register_live_session(SESSION)
        recovery = self._open()
        self.main._safe_delete_live_recovery(SESSION)
        self.main._end_live_session_ownership(SESSION, recovery)
        # No spool AND no orphan "recoverable" sidecar rewritten by finalize.
        self.assertEqual(self._files(), [])

    def test_a_crash_after_the_save_does_not_offer_the_take_again(self) -> None:
        self.main._register_live_session(SESSION)
        recovery = self._open()
        self.main._safe_delete_live_recovery(SESSION)
        recovery["pcm_file"].close()
        # The process dies here: the handler never runs its last step.
        self.main._live_sessions_in_flight.clear()
        listed = [r["session_id"] for r in self.main._list_live_recoveries()]
        self.assertNotIn(SESSION, listed)
        with self.assertRaises(self.main.HTTPException) as ctx:
            self.main._promote_live_recovery(SESSION)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_without_a_request_finalize_keeps_the_recovery(self) -> None:
        self.main._register_live_session(SESSION)
        recovery = self._open()
        self.main._end_live_session_ownership(SESSION, recovery)
        self.assertEqual(self._files(), [".json", ".pcm16"])
        listed = [r["session_id"] for r in self.main._list_live_recoveries()]
        self.assertIn(SESSION, listed)


if __name__ == "__main__":
    unittest.main()
