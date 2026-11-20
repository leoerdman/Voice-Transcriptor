"""Screen-mode screenshots: staging → archive, retention, deletion, serving.

What these tests pin (backend/screen_sessions.py is the SSOT):

  * a staged session is MOVED beside its recording as ``<stem>.screens``
    and the paths in ``events.json`` follow it;
  * a recording's screenshot folder is kept or collected by the SAME rule
    as its audio — one policy, one ranking, one exemption (newest five
    for the Screen Sessions collection) — never by a second count;
  * deleting the archive deletes the screenshots with their recordings;
  * a staged session no save adopted ages out on the recovery schedule;
  * only names the desktop shell writes can be served.
"""

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from backend import screen_sessions

SESSION = "screen-20261120-100000-000"
NOW = 1_000_000_000.0


def _stage(data_dir: Path, session_id: str = SESSION, shots: int = 2) -> Path:
    folder = data_dir / "screen-sessions" / session_id
    folder.mkdir(parents=True)
    files = []
    for i in range(1, shots + 1):
        f = folder / f"shot-{i:02d}.png"
        f.write_bytes(b"\x89PNG fake")
        files.append(str(f))
    (folder / "events.json").write_text(json.dumps({
        "version": 1,
        "id": session_id,
        "dir": str(folder),
        "startedAt": 1,
        "events": [
            {"type": "stroke", "at": 2, "shot": 1, "xPct": 10, "yPct": 10},
            {"type": "shot", "at": 3, "shot": 1, "files": files[:1]},
        ],
    }), encoding="utf-8")
    return folder


CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "screen-session.json").read_text(encoding="utf-8")
)


class ContractTests(unittest.TestCase):
    """The names the desktop shell writes are the names this side reads."""

    def test_names_match_the_contract(self) -> None:
        self.assertEqual(screen_sessions.STAGING_DIR_NAME, CONTRACT["stagingDirName"])
        self.assertEqual(screen_sessions.SCREENS_DIR_SUFFIX, CONTRACT["screensDirSuffix"])
        self.assertEqual(screen_sessions.EVENTS_FILE_NAME, CONTRACT["eventsFileName"])
        self.assertEqual(screen_sessions.SCREEN_SESSION_ID_RE.pattern, CONTRACT["sessionIdPattern"])
        self.assertEqual(screen_sessions.SCREENSHOT_NAME_RE.pattern, CONTRACT["screenshotNamePattern"])
        self.assertTrue(screen_sessions.is_session_id(CONTRACT["exampleSessionId"]))
        for name in CONTRACT["exampleScreenshotNames"]:
            self.assertRegex(name, screen_sessions.SCREENSHOT_NAME_RE)

    def test_adoption_writes_the_contracts_archived_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data, archive = Path(tmp) / "data", Path(tmp) / "archive"
            archive.mkdir()
            _stage(data)
            manifest = screen_sessions.adopt_session(
                data, SESSION, archive, "r",
                audio_started_at=CONTRACT["archivedManifest"]["audioStartedAt"],
            )
        for key in CONTRACT["archivedManifest"]:
            if not key.startswith("_"):
                self.assertIn(key, manifest)

    def test_rehoming_keeps_every_other_field_of_the_contract_manifest(self) -> None:
        folder = Path("/archive/take.screens")
        out = screen_sessions._rehome_manifest(CONTRACT["manifest"], folder)
        self.assertEqual(out["dir"], str(folder))
        self.assertEqual(out["events"][1]["files"], [str(folder / "shot-01.png")])
        self.assertEqual(out["events"][0], CONTRACT["manifest"]["events"][0])


class AdoptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name) / "data"
        self.archive = Path(self._tmp.name) / "archive"
        self.archive.mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_a_staged_session_moves_beside_its_recording_with_rehomed_paths(self) -> None:
        staged = _stage(self.data)
        manifest = screen_sessions.adopt_session(self.data, SESSION, self.archive, "Bug report")
        dest = self.archive / "Bug report.screens"
        self.assertFalse(staged.exists(), "the staging folder is moved, not copied")
        self.assertTrue((dest / "shot-01.png").is_file())
        self.assertEqual(manifest["dir"], str(dest))
        self.assertEqual(manifest["events"][1]["files"], [str(dest / "shot-01.png")])
        on_disk = json.loads((dest / "events.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk, manifest)
        self.assertEqual(screen_sessions.list_screenshots(self.archive, "Bug report"), ["shot-01.png", "shot-02.png"])

    def test_adoption_records_the_audio_clock_origin(self) -> None:
        _stage(self.data)
        manifest = screen_sessions.adopt_session(
            self.data, SESSION, self.archive, "r", audio_started_at=1795165897712.4
        )
        self.assertEqual(manifest["audioStartedAt"], 1795165897712)
        self.assertEqual(screen_sessions.read_manifest(self.archive / "r.screens")["audioStartedAt"], 1795165897712)

    def test_a_crashed_take_gets_its_end_from_the_audio(self) -> None:
        # The app died mid-take: the shell never wrote ``endedAt``. Without
        # it the marks have no time frame and all land at the text's end.
        _stage(self.data)
        manifest = screen_sessions.adopt_session(
            self.data, SESSION, self.archive, "r",
            audio_started_at=1795165897000, audio_ended_at=1795165957000.6,
        )
        self.assertEqual(manifest["endedAt"], 1795165957000)
        self.assertEqual(screen_sessions.read_manifest(self.archive / "r.screens")["endedAt"], 1795165957000)

    def test_a_stopped_take_keeps_the_end_the_shell_wrote(self) -> None:
        staged = _stage(self.data)
        events = json.loads((staged / "events.json").read_text(encoding="utf-8"))
        events["endedAt"] = 42
        (staged / "events.json").write_text(json.dumps(events), encoding="utf-8")
        manifest = screen_sessions.adopt_session(
            self.data, SESSION, self.archive, "r", audio_ended_at=1795165957000,
        )
        self.assertEqual(manifest["endedAt"], 42)

    def test_nothing_to_adopt_for_unknown_or_malformed_ids(self) -> None:
        self.assertIsNone(screen_sessions.adopt_session(self.data, SESSION, self.archive, "x"))
        self.assertIsNone(screen_sessions.adopt_session(self.data, "../etc", self.archive, "x"))
        self.assertIsNone(screen_sessions.adopt_session(self.data, "", self.archive, "x"))

    def test_only_shell_written_names_are_served(self) -> None:
        _stage(self.data)
        screen_sessions.adopt_session(self.data, SESSION, self.archive, "r")
        self.assertIsNotNone(screen_sessions.screenshot_path(self.archive, "r", "shot-01.png"))
        self.assertIsNone(screen_sessions.screenshot_path(self.archive, "r", "events.json"))
        self.assertIsNone(screen_sessions.screenshot_path(self.archive, "r", "../r.txt"))
        self.assertIsNone(screen_sessions.screenshot_path(self.archive, "r", "shot-09.png"))

    # ── BM-05 / BM-06: adoption is all or nothing ─────────────────
    def _previous_screens(self) -> Path:
        old = self.archive / "r.screens"
        old.mkdir()
        (old / "shot-01.png").write_bytes(b"previous")
        return old

    def _no_work_dirs(self) -> None:
        self.assertEqual([p.name for p in self.archive.iterdir() if ".tmp-" in p.name], [])

    def test_a_failed_manifest_write_keeps_the_old_screenshots_and_the_staging(self) -> None:
        from unittest import mock

        old = self._previous_screens()
        staged = _stage(self.data)
        with mock.patch.object(screen_sessions, "atomic_write_json", side_effect=OSError("disk full")):
            with self.assertRaises(screen_sessions.ScreenAdoptionError):
                screen_sessions.adopt_session(self.data, SESSION, self.archive, "r")
        self.assertEqual((old / "shot-01.png").read_bytes(), b"previous")
        self.assertTrue((staged / "shot-02.png").is_file(), "the staged take must survive for a retry")
        self._no_work_dirs()

    def test_a_cross_volume_copy_failing_part_way_leaves_no_partial_folder(self) -> None:
        import errno
        from unittest import mock

        old = self._previous_screens()
        staged = _stage(self.data)
        real_replace = Path.replace

        def exdev_for_staging(path_self, target):
            if path_self == staged:
                raise OSError(errno.EXDEV, "cross-device link")
            return real_replace(path_self, target)

        def partial_copy(src, dst, **_kw):
            Path(dst).mkdir()
            (Path(dst) / "shot-01.png").write_bytes(b"half")
            raise OSError(errno.ENOSPC, "No space left on device")

        with mock.patch.object(Path, "replace", exdev_for_staging), \
                mock.patch.object(screen_sessions.shutil, "copytree", partial_copy):
            with self.assertRaises(screen_sessions.ScreenAdoptionError):
                screen_sessions.adopt_session(self.data, SESSION, self.archive, "r")
        self.assertEqual((old / "shot-01.png").read_bytes(), b"previous")
        self.assertTrue((staged / "shot-01.png").is_file())
        self._no_work_dirs()

    def test_a_cross_volume_adoption_removes_the_staging_only_once_archived(self) -> None:
        import errno
        from unittest import mock

        staged = _stage(self.data)
        real_replace = Path.replace

        def exdev_for_staging(path_self, target):
            if path_self == staged:
                raise OSError(errno.EXDEV, "cross-device link")
            return real_replace(path_self, target)

        with mock.patch.object(Path, "replace", exdev_for_staging):
            manifest = screen_sessions.adopt_session(self.data, SESSION, self.archive, "r")
        self.assertEqual(manifest["dir"], str(self.archive / "r.screens"))
        self.assertFalse(staged.exists())
        self.assertEqual(screen_sessions.list_screenshots(self.archive, "r"), ["shot-01.png", "shot-02.png"])
        self._no_work_dirs()

    def test_a_reasave_replaces_the_previous_screenshots_atomically(self) -> None:
        self._previous_screens()
        _stage(self.data)
        screen_sessions.adopt_session(self.data, SESSION, self.archive, "r")
        self.assertEqual((self.archive / "r.screens" / "shot-01.png").read_bytes(), b"\x89PNG fake")
        self._no_work_dirs()

    def test_malformed_events_do_not_fail_the_adoption(self) -> None:
        staged = _stage(self.data)
        (staged / "events.json").write_text(json.dumps({"version": 1, "id": SESSION, "events": 5}), encoding="utf-8")
        manifest = screen_sessions.adopt_session(self.data, SESSION, self.archive, "r")
        self.assertEqual(manifest["events"], [])
        self.assertEqual(screen_sessions.read_manifest(self.archive / "r.screens")["events"], [])

    def test_orphans_age_out_and_fresh_ones_stay(self) -> None:
        old = _stage(self.data, "screen-20261101-000000-000")
        fresh = _stage(self.data, "screen-20261120-000000-000")
        os.utime(old, (NOW - 10_000, NOW - 10_000))
        os.utime(fresh, (NOW - 10, NOW - 10))
        stray = self.data / "screen-sessions" / "keep-me"
        stray.mkdir()
        os.utime(stray, (NOW - 10_000, NOW - 10_000))
        removed = screen_sessions.sweep_orphan_sessions(self.data, 3600, now=NOW)
        self.assertEqual(removed, 1)
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(stray.exists(), "a folder that is not a session id is not ours")
        self.assertEqual(screen_sessions.sweep_orphan_sessions(self.data, 0, now=NOW), 0)


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


class ArchiveIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._old_home = os.environ.get("HOME")
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._home = tempfile.TemporaryDirectory()
        os.environ["HOME"] = self._home.name
        self._tmp = tempfile.TemporaryDirectory(dir=self._home.name)
        self.main = _fresh_main_module(self._tmp.name)
        self.root = (Path(self._tmp.name) / "recordings").resolve()
        self.screen_dir = self.root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_SCREEN]
        self.screen_dir.mkdir(parents=True)

    def tearDown(self) -> None:
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        for key, old in (("HOME", self._old_home), ("TRANSCRIPTOR_DATA_DIR", self._old_data_dir)):
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        self._tmp.cleanup()
        self._home.cleanup()

    def _recording(self, stem: str, mtime: float) -> None:
        (self.screen_dir / f"{stem}.txt").write_text(
            "Title: t\nSaved at: 2026-11-20 10:00:00\n\nTranscription:\nhi\n", encoding="utf-8"
        )
        audio = self.screen_dir / f"{stem}.wav"
        audio.write_bytes(b"RIFF")
        screens = self.screen_dir / f"{stem}.screens"
        screens.mkdir()
        (screens / "shot-01.png").write_bytes(b"png")
        for p in (audio, screens):
            os.utime(p, (mtime, mtime))

    def test_screenshots_follow_the_audio_rule_of_their_collection(self) -> None:
        for i in range(7):
            self._recording(f"take-{i}", NOW - (7 - i) * 60)
        self.main._prune_recording_audio(self.screen_dir, now=NOW)
        kept_screens = sorted(p.name for p in self.screen_dir.glob("*.screens"))
        kept_audio = sorted(p.name for p in self.screen_dir.glob("*.wav"))
        self.assertEqual(kept_screens, [f"take-{i}.screens" for i in range(2, 7)])
        self.assertEqual(kept_audio, [f"take-{i}.wav" for i in range(2, 7)])
        self.assertEqual(len(list(self.screen_dir.glob("*.txt"))), 7, "transcripts are never collected")

    def test_the_recording_just_saved_keeps_its_screenshots(self) -> None:
        # take-0 is the oldest of seven but the one being saved: exempt,
        # yet still ranked, so only take-1 falls past the newest five.
        for i in range(7):
            self._recording(f"take-{i}", NOW - (7 - i) * 60)
        self.main._prune_recording_audio(self.screen_dir, keep_stems=("take-0",), now=NOW)
        self.assertTrue((self.screen_dir / "take-0.screens").exists())
        self.assertFalse((self.screen_dir / "take-1.screens").exists())
        self.assertTrue((self.screen_dir / "take-2.screens").exists())

    def test_delete_all_removes_screenshots_with_their_recordings(self) -> None:
        self._recording("take", NOW)
        self.main._register_archive_dir(self.root)
        self.main._delete_all_recordings_sync()
        self.assertFalse((self.screen_dir / "take.screens").exists())

    def test_a_malformed_audio_clock_field_falls_back_instead_of_failing_the_save(self) -> None:
        self.assertEqual(self.main._form_float("1795165897712.5"), 1795165897712.5)
        self.assertEqual(self.main._form_float(""), 0.0)
        self.assertEqual(self.main._form_float("nan"), 0.0)
        self.assertEqual(self.main._form_float("x"), 0.0)

    def test_the_recording_payload_lists_its_screenshots(self) -> None:
        self._recording("take", NOW)
        payload = self.main._read_recording_payload(self.screen_dir / "take.txt", self.screen_dir)
        self.assertEqual(payload["screens"], ["shot-01.png"])
        self.assertIsNone(payload["screens_manifest"], "no events.json in this fixture")
        self.assertEqual(payload["screens_dir"], str(self.screen_dir / "take.screens"))
        self.assertEqual(payload["recording_collection"], self.main.RECORDING_COLLECTION_SCREEN)


class OneRecordingOneRuleTests(unittest.TestCase):
    """BM-07/S-05, BM-08, BM-10, BM-11/S-06: a recording's audio and its
    screenshots are one thing to retention and to "delete all"."""

    setUp = ArchiveIntegrationTests.setUp
    tearDown = ArchiveIntegrationTests.tearDown
    _recording = ArchiveIntegrationTests._recording

    def test_a_touched_screens_folder_does_not_outrank_its_recording(self) -> None:
        # Finder writing .DS_Store into the OLDEST take's folder made it the
        # "newest" screens folder: its screenshots survived while a newer
        # take's were collected, and audio/screens of one recording split.
        for i in range(6):
            self._recording(f"take-{i}", NOW - (6 - i) * 60)
        touched = self.screen_dir / "take-0.screens"
        os.utime(touched, (NOW, NOW))
        self.main._prune_recording_audio(self.screen_dir, now=NOW)
        kept_screens = sorted(p.name for p in self.screen_dir.glob("*.screens"))
        kept_audio = sorted(p.name for p in self.screen_dir.glob("*.wav"))
        self.assertEqual(kept_audio, [f"take-{i}.wav" for i in range(1, 6)])
        self.assertEqual(kept_screens, [f"take-{i}.screens" for i in range(1, 6)])

    def _app_screens_without_transcript(self, stem: str, mtime: float) -> Path:
        folder = self.screen_dir / f"{stem}.screens"
        folder.mkdir()
        (folder / "shot-01.png").write_bytes(b"png")
        (folder / "events.json").write_text(json.dumps({"version": 1, "id": SESSION, "events": []}), encoding="utf-8")
        os.utime(folder, (mtime, mtime))
        return folder

    def test_screenshots_whose_transcript_is_gone_are_collected_after_the_grace(self) -> None:
        stale = self._app_screens_without_transcript("deleted-in-finder", NOW - 10 * 24 * 3600)
        fresh = self._app_screens_without_transcript("just-now", NOW - 60)
        user = self.screen_dir / "mine.screens"
        user.mkdir()
        os.utime(user, (NOW - 10 * 24 * 3600,) * 2)
        self.main._prune_recording_audio(self.screen_dir, now=NOW)
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(user.exists(), "a folder without the app's manifest is not ours")

    def test_delete_all_removes_screenshots_whose_transcript_is_gone(self) -> None:
        orphan = self._app_screens_without_transcript("deleted-in-finder", NOW)
        self.main._register_archive_dir(self.root)
        self.main._delete_all_recordings_sync()
        self.assertFalse(orphan.exists())

    def test_delete_all_puts_everything_back_when_the_screenshots_are_locked(self) -> None:
        from unittest import mock

        self._recording("take", NOW)
        screens = self.screen_dir / "take.screens"
        real_replace = os.replace

        def locked(src, dst, *a, **kw):
            if Path(src) == screens:
                raise PermissionError("locked")
            return real_replace(src, dst, *a, **kw)

        self.main._register_archive_dir(self.root)
        with mock.patch.object(self.main.os, "replace", locked):
            result = self.main._delete_all_recordings_sync()
        self.assertEqual(result, {"deleted": 0, "failed": 1})
        self.assertTrue((self.screen_dir / "take.txt").exists())
        self.assertTrue((self.screen_dir / "take.wav").exists())
        self.assertTrue((screens / "shot-01.png").exists())
        self.assertEqual([p.name for p in self.screen_dir.iterdir() if ".tmp-" in p.name], [])

    def test_a_symlinked_screens_folder_is_neither_listed_nor_served(self) -> None:
        elsewhere = Path(self._tmp.name) / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "shot-01.png").write_bytes(b"png")
        (self.screen_dir / "take.screens").symlink_to(elsewhere, target_is_directory=True)
        self.assertEqual(screen_sessions.list_screenshots(self.screen_dir, "take"), [])
        self.assertIsNone(screen_sessions.screenshot_path(self.screen_dir, "take", "shot-01.png"))


class AdoptionFailureIsReportedTests(unittest.TestCase):
    """BM-05: a failed adoption is reported as such, not as "no screenshots",
    and a crash's work folder is collected on the next boot."""

    setUp = ArchiveIntegrationTests.setUp
    tearDown = ArchiveIntegrationTests.tearDown

    def test_the_save_says_screens_error_when_adoption_fails(self) -> None:
        from unittest import mock

        _stage(Path(self._tmp.name))
        with mock.patch.object(screen_sessions, "atomic_write_json", side_effect=OSError("disk full")):
            manifest, error = self.main._adopt_screen_session_for_recording(
                SESSION, self.screen_dir, "take", audio_started_at=None
            )
        self.assertIsNone(manifest)
        self.assertTrue(error)
        self.assertTrue((Path(self._tmp.name) / "screen-sessions" / SESSION).is_dir())

    def test_the_boot_sweep_collects_a_crashed_adoptions_work_folder(self) -> None:
        work = self.screen_dir / "take.screens.tmp-0123456789abcdef"
        work.mkdir()
        (work / "shot-01.png").write_bytes(b"png")
        old = NOW - 3600
        os.utime(work, (old, old))
        self.main._register_archive_dir(self.root)
        self.main._sweep_orphan_tmp_files()
        self.assertFalse(work.exists())


class CrashedScreenTakeRecoveryTests(unittest.TestCase):
    """H-01 / BM-04 / S-01: a screen take whose app died before the save is
    promoted from its audio spool — into Screen Sessions, WITH the
    screenshots staged for it, and those are not swept meanwhile."""

    setUp = ArchiveIntegrationTests.setUp
    tearDown = ArchiveIntegrationTests.tearDown

    SID = "c0ffee00-0000-4000-8000-000000000001"

    def _open(self, screen_session_id: str) -> dict:
        from datetime import datetime

        self.main.LIVE_RECOVERY_DIR.mkdir(parents=True, exist_ok=True)
        return self.main._open_live_recovery(
            session_id=self.SID,
            started_at=datetime.now(),
            provider="deepgram",
            model="nova-3",
            language="auto",
            archive_dir="",
            recording_collection=self.main.RECORDING_COLLECTION_SCREEN,
            screen_session_id=screen_session_id,
        )

    def _crashed_screen_take(self) -> None:
        """Spool + sidecar exactly as a screen take killed mid-way leaves
        them (the sidecar shape ``_open_live_recovery`` writes)."""
        from datetime import datetime

        self.main.LIVE_RECOVERY_DIR.mkdir(parents=True, exist_ok=True)
        _stage(Path(self._tmp.name))
        stem = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{self.SID}"
        (self.main.LIVE_RECOVERY_DIR / f"{stem}.pcm16").write_bytes(
            b"\x00\x01" * (2 * self.main.LIVE_SAMPLE_RATE_HZ)
        )
        (self.main.LIVE_RECOVERY_DIR / f"{stem}.json").write_text(json.dumps({
            "session_id": self.SID,
            "started_at": datetime.now().isoformat(),
            "finished_at": "",
            "bytes": 0,
            "status": "recording",
            "archive_dir": "",
            "recording_collection": self.main.RECORDING_COLLECTION_SCREEN,
            "screen_session_id": SESSION,
        }), encoding="utf-8")

    def test_the_sidecar_names_the_screen_session(self) -> None:
        recovery = self._open(SESSION)
        recovery["pcm_file"].close()
        meta = json.loads(recovery["meta_path"].read_text(encoding="utf-8"))
        self.assertEqual(meta["screen_session_id"], SESSION)
        self.assertEqual(meta["recording_collection"], self.main.RECORDING_COLLECTION_SCREEN)

    def test_an_invalid_screen_session_id_is_never_stored(self) -> None:
        recovery = self._open("../../etc")
        recovery["pcm_file"].close()
        meta = json.loads(recovery["meta_path"].read_text(encoding="utf-8"))
        self.assertEqual(meta["screen_session_id"], "")

    def test_promotion_files_the_take_under_screen_sessions_with_its_screenshots(self) -> None:
        self._crashed_screen_take()
        # The renderer sends no collection: the sidecar decides.
        result = self.main._promote_live_recovery(self.SID, recording_collection="")
        self.assertEqual(Path(result["archive_dir"]), self.screen_dir)
        stem = Path(result["name"]).stem
        self.assertEqual(
            self.main.screen_sessions.list_screenshots(self.screen_dir, stem),
            ["shot-01.png", "shot-02.png"],
        )
        self.assertIsNotNone(result["screens"])
        self.assertIn("audioStartedAt", result["screens"])
        self.assertFalse((Path(self._tmp.name) / "screen-sessions" / SESSION).exists())

    def test_a_crashed_screen_takes_promotion_gives_its_marks_a_time_frame(self) -> None:
        # The take never stopped, so the staged events.json has no
        # ``endedAt``; the spool's own span is the take's time frame.
        self._crashed_screen_take()
        pcm = next(self.main.LIVE_RECOVERY_DIR.glob("*.pcm16"))
        last_write = 1_795_165_957.0
        os.utime(pcm, (last_write, last_write))
        result = self.main._promote_live_recovery(self.SID, recording_collection="")
        screens = result["screens"]
        self.assertEqual(screens["endedAt"], int(last_write * 1000))
        # Two seconds of 16 kHz PCM16 in the spool.
        self.assertEqual(screens["endedAt"] - screens["audioStartedAt"], 2000)

    def test_a_promotion_says_what_it_wrote_so_the_renderer_can_complete_the_entry(self) -> None:
        # The renderer rewrites the recovered entry with the crash draft's
        # text and the marks; fields it has nothing better for are kept.
        self._crashed_screen_take()
        result = self.main._promote_live_recovery(self.SID, recording_collection="")
        text = (Path(result["archive_dir"]) / result["name"]).read_text(encoding="utf-8")
        for key in ("title", "source_text", "provider", "model", "language"):
            self.assertIsInstance(result[key], str)
        self.assertIn(result["title"], text)
        self.assertIn(result["source_text"], text)
        self.assertEqual(result["transcript_text"], "")

    def test_the_promote_route_without_a_collection_lets_the_sidecar_decide(self) -> None:
        import asyncio

        self._crashed_screen_take()
        result = asyncio.run(self.main.promote_live_recovery(self.SID, payload={}))
        self.assertEqual(Path(result["archive_dir"]), self.screen_dir)

    def test_the_orphan_sweep_keeps_a_session_a_pending_recovery_names(self) -> None:
        self._crashed_screen_take()
        staged = Path(self._tmp.name) / "screen-sessions" / SESSION
        old = NOW - 10 * 24 * 3600
        os.utime(staged, (old, old))
        self.main._last_cleanup_recovery_at = -1e12
        self.main._cleanup_live_recovery_files()
        self.assertTrue(staged.exists(), "staged screenshots of a recoverable take were swept")


if __name__ == "__main__":
    unittest.main()

