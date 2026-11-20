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
        (self.screen_dir / f"{stem}.txt").write_text("Title: t\n\nTranscription:\nhi\n", encoding="utf-8")
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


if __name__ == "__main__":
    unittest.main()

