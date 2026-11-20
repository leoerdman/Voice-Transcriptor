"""Housekeeping of the archive and the job scratch space (Ultra-Audit 2026-11-20).

  * BM-12 — a save's file work runs off the event loop.
  * BM-19 — a from-path job deletes its source snapshot when nobody will use it.
  * BL-18 — job results and snapshots age out on the timer, not only when
            another job happens to be created.
  * BL-14 — one archive dir spelled two ways is one dir.
  * BM-25 — the network probe stops at the first host that answers.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


class _MainCase(unittest.TestCase):
    def setUp(self) -> None:
        self._old = {k: os.environ.get(k) for k in ("HOME", "TRANSCRIPTOR_DATA_DIR")}
        self._home = tempfile.TemporaryDirectory()
        os.environ["HOME"] = self._home.name
        self._tmp = tempfile.TemporaryDirectory(dir=self._home.name)
        self.main = _fresh_main_module(self._tmp.name)

    def tearDown(self) -> None:
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        for key, old in self._old.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        self._tmp.cleanup()
        self._home.cleanup()


class SaveRunsOffTheEventLoopTests(_MainCase):
    def test_the_retention_scan_of_a_save_runs_on_a_worker_thread(self) -> None:
        threads: list[bool] = []
        real = self.main._prune_recording_audio

        def spy(*args, **kwargs):
            threads.append(threading.current_thread() is threading.main_thread())
            return real(*args, **kwargs)

        async def write_tmp(tmp: Path) -> None:
            tmp.write_bytes(b"RIFF" + b"\x00" * 64)

        with mock.patch.object(self.main, "_prune_recording_audio", spy):
            asyncio.run(self.main._save_recording_audio_source(
                orig_name="take.wav", write_tmp_audio=write_tmp, title="take",
            ))
        self.assertEqual(threads, [False], "the save scanned the archive on the event loop thread")


class JobSnapshotTests(_MainCase):
    def _source(self) -> Path:
        src = Path(self._home.name) / "talk.wav"
        src.write_bytes(b"RIFF" + b"\x00" * 64)
        return src

    def _local_job(self, **extra) -> tuple[dict, dict]:
        captured: dict = {}
        with mock.patch.object(self.main, "_submit_local_transcription_job",
                               side_effect=lambda **kw: captured.update(kw)):
            out = asyncio.run(self.main.create_job_from_path(
                {"source_path": str(self._source()), **extra}
            ))
        return out, captured

    def test_a_job_nobody_will_save_deletes_its_snapshot(self) -> None:
        out, captured = self._local_job(keep_source=False)
        self.assertTrue(captured["cleanup_upload_path"])
        self.assertEqual(out["audio_source_path"], "")

    def test_by_default_the_snapshot_is_kept_for_the_save(self) -> None:
        out, captured = self._local_job()
        self.assertFalse(captured["cleanup_upload_path"])
        self.assertTrue(out["audio_source_path"])

    def test_the_cli_asks_to_keep_it_only_with_save(self) -> None:
        from types import SimpleNamespace

        from backend import cli

        sent: list[dict] = []

        def fake_request(_conn, _method, _route, payload=None, **_kw):
            sent.append(payload)
            return {"job_id": "j", "audio_source_path": ""}

        options = {"engine": "local", "language": "auto", "model": "", "diarize": False}
        args = SimpleNamespace(no_split_stereo=False, word_timestamps=False, speakers=0, save=False)
        with mock.patch.object(cli, "_request", fake_request):
            cli.create_job(None, "/x.wav", options, args)
            cli.create_job(None, "/x.wav", options, SimpleNamespace(**{**vars(args), "save": True}))
        self.assertEqual([p["keep_source"] for p in sent], [False, True])


class ResultsAgeOutOnTheTimerTests(_MainCase):
    def test_a_tick_removes_results_past_the_window(self) -> None:
        self.main.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        old = self.main.RESULTS_DIR / "abc.remote.json"
        old.write_text("{}", encoding="utf-8")
        stamp = time.time() - self.main.RESULT_RETENTION_SEC - 60
        os.utime(old, (stamp, stamp))
        self.main._last_cleanup_expired_at = -1e12
        self.main._periodic_housekeeping()
        self.assertFalse(old.exists())


class ArchiveDirIdentityTests(_MainCase):
    def test_one_dir_spelled_two_ways_is_one_dir(self) -> None:
        # The user's registry holds ".../Transcriptor/recordings/Live Capsule"
        # AND ".../transcriptor/...": one folder on a case-insensitive volume.
        real = Path(self._home.name) / "Archive"
        real.mkdir()
        other_case = Path(self._home.name) / "ARCHIVE"
        if not other_case.exists():
            self.skipTest("case-sensitive file system")
        dirs = self.main._recordings_storage_dirs_for_roots([real, other_case])
        self.assertEqual(len(dirs), 1, dirs)


class NetworkProbeTests(_MainCase):
    def test_the_probe_stops_at_the_first_host_that_answers(self) -> None:
        calls: list[str] = []

        class _Resp:
            status = 204

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(url, timeout):
            calls.append(url)
            return _Resp()

        with mock.patch.object(self.main, "urlopen", fake_urlopen):
            result = asyncio.run(self.main.network_status(_auth=None))
        self.assertTrue(result["online"])
        self.assertEqual(len(calls), 1, calls)


class OneNormalisationTests(_MainCase):
    """BM-15 / BM-16: one clamp for persisted UI state, one normalisation
    of a save's text fields."""

    def test_both_ui_states_clamp_with_the_same_helpers(self) -> None:
        self.assertEqual(self.main._bounded_text("  abc  ", 2), "ab")
        self.assertIsNone(self.main._nonneg_finite(-1))
        self.assertIsNone(self.main._nonneg_finite(float("inf")))
        self.assertEqual(self.main._nonneg_finite("2.5"), 2.5)
        for gone in ("_upload_queue_str", "_live_draft_str", "_upload_queue_number", "_live_draft_number"):
            self.assertFalse(hasattr(self.main, gone), gone)

    def test_both_save_routes_normalise_through_one_function(self) -> None:
        fields = self.main._normalize_save_fields(
            title=" a/b:\n c\x00 ", source_text="", transcript_text="  hi  ",
            provider=" deepgram ", model=None, language=" ru ",
        )
        self.assertEqual(fields.transcript_text, "hi")
        self.assertEqual(fields.provider, "deepgram")
        self.assertEqual(fields.model, "")
        self.assertEqual(fields.language, "ru")
        # The title is metadata, not a file name: punctuation stays, and
        # only what would break the one-line ``Title:`` header goes.
        self.assertEqual(fields.title, "a/b: c")


class UploadCeilingBeforeTheBodyTests(_MainCase):
    """BM-26: a declared body past the upload ceiling is refused before the
    multipart parser spools it to the temp volume."""

    def test_an_oversized_declared_body_is_413_before_auth_or_parsing(self) -> None:
        from fastapi.testclient import TestClient

        client = TestClient(self.main.app, base_url="http://127.0.0.1:8321")
        r = client.post(
            "/api/jobs",
            content=b"x",
            headers={
                "content-length": str(self.main.MAX_UPLOAD_BYTES * 2),
                "x-api-token": self.main.API_TOKEN,
            },
        )
        self.assertEqual(r.status_code, 413, r.text)


if __name__ == "__main__":
    unittest.main()
