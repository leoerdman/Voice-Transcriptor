import importlib
import asyncio
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


TEST_WORKSPACE_ROOT = Path(__file__).resolve().parents[2]

# What ``_require_api_auth`` leaves on a request the renderer's token let in.
_RENDERER_REQUEST = SimpleNamespace(state=SimpleNamespace(api_caller="renderer"))


def _frozen_recording_clock(main, moment: datetime):
    """Hold the naming rule's "now" at *moment*: every new recording asks
    for the same ``YYYYMMDD-HHMMSS`` name."""

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment if tz is None else moment.astimezone(tz)

    return mock.patch.object(main.recording_names, "datetime", _Frozen)


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


class _IsolatedMainCase(unittest.TestCase):
    """A fresh backend.main with HOME and its data dir in throwaway folders."""

    def setUp(self):
        self._old_home = os.environ.get("HOME")
        self._old_userprofile = os.environ.get("USERPROFILE")
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._home = tempfile.TemporaryDirectory()
        os.environ["HOME"] = self._home.name
        os.environ["USERPROFILE"] = self._home.name
        self._tmp = tempfile.TemporaryDirectory(dir=self._home.name)
        self.main = _fresh_main_module(self._tmp.name)

    def tearDown(self):
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
        if self._old_userprofile is None:
            os.environ.pop("USERPROFILE", None)
        else:
            os.environ["USERPROFILE"] = self._old_userprofile


class RecordingNameTests(_IsolatedMainCase):
    def test_upload_is_named_by_time_and_keeps_its_source_name_as_metadata(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()

        source_name = self.main._normalize_filename(r"C:\input\2 Эфир - Часть 2.mp4")
        self.assertEqual(source_name, "2 Эфир - Часть 2.mp4")

        # Through the path the app actually takes: the O_EXCL reservation,
        # which names every new recording by the one rule.
        stem, _out = self.main._claim_recording_text_path(target)
        self.assertRegex(stem, r"^\d{8}-\d{6}$")

        out = target / f"{stem}.txt"
        self.main._write_recording_text_file(
            out=out,
            title="2 Эфир - Часть 2",
            source_file=source_name,
            source_text="исходный текст",
            transcript_text="готовая транскрипция",
            provider="deepgram",
            model="nova-3",
            language="ru",
        )

        payload = self.main._build_recordings_list_payload(target)
        self.assertEqual(len(payload["items"]), 1)
        item = payload["items"][0]
        self.assertEqual(item["name"], f"{stem}.txt")
        self.assertEqual(item["display_name"], source_name)
        self.assertEqual(item["source_file"], source_name)

    def test_recording_stem_availability_is_case_insensitive(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        (target / "meeting.TXT").write_text("existing", encoding="utf-8")
        (target / "audio.WEBM").write_bytes(b"existing audio")

        self.assertFalse(self.main._recording_stem_available(target, "Meeting"))
        self.assertFalse(self.main._recording_stem_available(target, "AUDIO"))
        self.assertTrue(self.main._recording_stem_available(target, "Another"))

    def test_user_filename_part_cannot_bypass_windows_reserved_names(self):
        self.assertEqual(self.main._safe_user_filename_part("con.txt"), "_con.txt")

    def test_existing_recording_leaf_rejects_windows_reserved_names(self):
        for raw_name in ("CON.txt", "aux.TXT", r"C:\notes\nul.txt"):
            with self.subTest(raw_name=raw_name):
                with self.assertRaises(self.main.HTTPException) as cm:
                    self.main._recording_text_name_leaf(raw_name)
                self.assertEqual(cm.exception.status_code, 400)

    def test_safe_error_text_redacts_quoted_paths_with_spaces(self):
        text = (
            "failed to open '/Users/alice/Library/Application Support/Voice Transcriptor/config.json' "
            "with token sk-abcdefghijklmnopqrstuvwxyz123456"
        )

        redacted = self.main._safe_error_text(text, max_len=500)

        self.assertIn("'<path>'", redacted)
        self.assertIn("<token>", redacted)
        self.assertNotIn("Application Support", redacted)
        self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz123456", redacted)

    def test_origin_allowed_rejects_malformed_origin_without_500(self):
        request = SimpleNamespace(url=SimpleNamespace(port=8765, scheme="http"))

        self.assertFalse(self.main._origin_allowed("http://localhost:not-a-port", request))

    def test_open_recordings_folder_rejects_existing_file_path(self):
        existing_file = Path(self._home.name) / "not-a-folder"
        existing_file.write_text("file, not directory", encoding="utf-8")

        with self.assertRaises(self.main.HTTPException) as cm:
            asyncio.run(self.main.open_recordings_folder({"path": str(existing_file)}, _auth=None))

        self.assertEqual(cm.exception.status_code, 409)
        self.assertEqual(cm.exception.detail, "folder path exists but is not a directory")

    def test_open_recordings_folder_does_not_create_missing_requested_path(self):
        missing_dir = Path(self._home.name) / "missing-open-target"

        with self.assertRaises(self.main.HTTPException) as cm:
            asyncio.run(self.main.open_recordings_folder({"path": str(missing_dir)}, _auth=None))

        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(cm.exception.detail, "folder path does not exist")
        self.assertFalse(missing_dir.exists())

    def test_recording_collection_rejects_symlink_escape_after_resolve(self):
        root = Path(self._tmp.name) / "recordings"
        root.mkdir()
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        live_name = self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_LIVE]
        (root / live_name).symlink_to(outside.name, target_is_directory=True)

        with self.assertRaises(self.main.HTTPException) as cm:
            self.main._resolve_recordings_collection_target_dir(
                str(root),
                collection=self.main.RECORDING_COLLECTION_LIVE,
                create=True,
            )

        self.assertEqual(cm.exception.status_code, 403)

    def test_live_promote_cache_misses_when_cached_audio_is_missing(self):
        archive_dir = Path(self._tmp.name) / "recordings"
        archive_dir.mkdir()
        (archive_dir / "Recovered.txt").write_text("ok", encoding="utf-8")

        self.main._store_live_promote_cache(
            "session-with-missing-audio",
            {
                "name": "Recovered.txt",
                "audio_name": "Recovered.wav",
                "archive_dir": str(archive_dir),
            },
        )

        self.assertIsNone(self.main._lookup_live_promote_cache("session-with-missing-audio"))

    def test_create_job_invalid_language_does_not_save_upload_or_create_job(self):
        fake_file = SimpleNamespace(filename="audio.wav")

        with mock.patch.object(self.main, "_save_upload_file", new=mock.AsyncMock()) as save_upload:
            with mock.patch.object(self.main.jobs, "create") as create_job:
                with self.assertRaises(self.main.HTTPException) as cm:
                    asyncio.run(self.main.create_job(file=fake_file, language="not a language", _auth=None))

        self.assertEqual(cm.exception.status_code, 400)
        save_upload.assert_not_awaited()
        create_job.assert_not_called()

    def test_source_media_path_rejects_file_that_changes_during_probe(self):
        source = Path(self._tmp.name) / "growing.wav"
        source.write_bytes(b"RIFF")

        def mutate_during_probe(_seconds):
            source.write_bytes(b"RIFF-growing")

        with mock.patch.object(self.main.time, "sleep", side_effect=mutate_during_probe):
            with self.assertRaises(self.main.HTTPException) as cm:
                self.main._resolve_source_media_path(str(source))

        self.assertEqual(cm.exception.status_code, 409)

    def test_a_saved_snapshot_is_named_after_the_user_s_file(self):
        # The archive names a recording after its source file, and a
        # snapshot's name is "<job id>.<original>". Saving one straight
        # filed the user's meeting under a UUID — through the Upload tab
        # and through `transcriptor transcribe --save` alike.
        job_id = "9f2c1d4e-6a7b-4c8d-9e0f-1a2b3c4d5e6f"
        snapshot = self.main._upload_snapshot_path(job_id, "Team meeting.mp4")
        self.assertEqual(snapshot.name, f"{job_id}.Team meeting.mp4")
        self.assertEqual(
            self.main._source_media_original_name(snapshot), "Team meeting.mp4"
        )

    def test_a_users_own_file_keeps_every_character_of_its_name(self):
        # Same shape, but outside UPLOADS_DIR: nothing is stripped.
        outside = Path(self._tmp.name) / "9f2c1d4e-6a7b-4c8d-9e0f-1a2b3c4d5e6f.wav"
        self.assertEqual(
            self.main._source_media_original_name(outside),
            "9f2c1d4e-6a7b-4c8d-9e0f-1a2b3c4d5e6f.wav",
        )
        # And a snapshot whose name is ONLY an id keeps it rather than
        # becoming the empty string.
        bare = self.main.UPLOADS_DIR / "9f2c1d4e-6a7b-4c8d-9e0f-1a2b3c4d5e6f."
        self.assertEqual(self.main._source_media_original_name(bare), bare.name)

    def test_local_from_path_uses_backend_owned_snapshot(self):
        source = Path(self._tmp.name) / "clip.wav"
        source.write_bytes(b"RIFF")
        snapshot = self.main.UPLOADS_DIR / "snapshot.clip.wav"
        snapshot.write_bytes(b"RIFF")

        with mock.patch.object(self.main, "_snapshot_source_media_for_job", return_value=snapshot) as make_snapshot, \
             mock.patch.object(self.main.jobs, "create") as create_job, \
             mock.patch.object(self.main, "_submit_local_transcription_job") as submit_job:
            out = asyncio.run(
                self.main.create_job_from_path(
                    payload={"source_path": str(source), "model": "small"},
                    _auth=None,
                )
            )

        make_snapshot.assert_called_once()
        create_job.assert_called_once_with(out["job_id"])
        submit_job.assert_called_once()
        self.assertEqual(submit_job.call_args.kwargs["upload_path"], snapshot)
        self.assertFalse(submit_job.call_args.kwargs["cleanup_upload_path"])
        self.assertEqual(out["audio_source_path"], str(snapshot))

    def test_remote_from_path_uses_backend_owned_snapshot(self):
        source = Path(self._tmp.name) / "clip.wav"
        source.write_bytes(b"RIFF")
        snapshot = self.main.UPLOADS_DIR / "snapshot.clip.wav"
        snapshot.write_bytes(b"RIFF")

        with mock.patch.object(self.main, "_snapshot_source_media_for_job", return_value=snapshot) as make_snapshot, \
             mock.patch.object(self.main.jobs, "create") as create_job, \
             mock.patch.object(self.main, "_submit_remote_transcription_job") as submit_job:
            out = asyncio.run(
                self.main.create_remote_job_from_path(
                    payload={"source_path": str(source), "provider": "deepgram"},
                    _auth=None,
                )
            )

        make_snapshot.assert_called_once()
        create_job.assert_called_once_with(out["job_id"])
        submit_job.assert_called_once()
        self.assertEqual(submit_job.call_args.kwargs["upload_path"], snapshot)
        self.assertFalse(submit_job.call_args.kwargs["cleanup_upload_path"])
        self.assertEqual(out["audio_source_path"], str(snapshot))

    def test_live_recovery_drops_odd_pcm16_trailing_byte(self):
        recovery = self.main._open_live_recovery(
            session_id="oddpcm",
            started_at=self.main.datetime.now(),
            provider="local",
            model="small",
            language="auto",
            archive_dir="",
            recording_collection=self.main.RECORDING_COLLECTION_LIVE,
        )
        try:
            self.main._record_recovery_chunk(recovery, b"\x01\x02\x03")

            self.assertEqual(recovery["bytes"], 2)
            # Read through the spool reader, which flushes the writer's
            # buffer first (BW-13) — the way finalize-time recovery reads it.
            self.assertEqual(self.main._recovery_spool_bytes(recovery), b"\x01\x02")
        finally:
            try:
                recovery["pcm_file"].close()
            except OSError:
                pass
            Path(recovery["pcm_path"]).unlink(missing_ok=True)
            Path(recovery["meta_path"]).unlink(missing_ok=True)

    def test_live_recovery_open_failure_rolls_back_metadata(self):
        started_at = self.main.datetime.now()
        session_id = "openfail"
        stem = f"{started_at.strftime('%Y%m%d_%H%M%S')}_{session_id}"
        pcm_path = self.main.LIVE_RECOVERY_DIR / f"{stem}.pcm16"
        meta_path = self.main.LIVE_RECOVERY_DIR / f"{stem}.json"
        real_open = Path.open

        def fail_pcm_open(path_obj: Path, *args, **kwargs):
            if path_obj.resolve() == pcm_path.resolve():
                raise OSError("pcm open failed")
            return real_open(path_obj, *args, **kwargs)

        with mock.patch.object(Path, "open", fail_pcm_open):
            with self.assertRaises(OSError):
                self.main._open_live_recovery(
                    session_id=session_id,
                    started_at=started_at,
                    provider="local",
                    model="small",
                    language="auto",
                    archive_dir="",
                    recording_collection=self.main.RECORDING_COLLECTION_LIVE,
                )

        self.assertFalse(pcm_path.exists())
        self.assertFalse(meta_path.exists())

    def test_recording_collections_save_into_source_specific_folders(self):
        live = self.main.save_recording({
            "title": "Live note",
            "source_text": "live source",
            "transcript_text": "live transcript",
            "provider": "local",
            "model": "small",
            "language": "ru",
            "recording_collection": "live",
        })
        upload = self.main.save_recording({
            "title": "Upload note",
            "source_text": "upload source",
            "transcript_text": "upload transcript",
            "provider": "deepgram",
            "model": "nova-3",
            "language": "ru",
            "recording_collection": "uploads",
        })

        root = (Path(self._tmp.name) / "recordings").resolve()
        live_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_LIVE]
        uploads_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_UPLOADS]

        self.assertTrue((live_dir / live["name"]).exists())
        self.assertTrue((uploads_dir / upload["name"]).exists())
        self.assertEqual(Path(live["archive_dir"]), live_dir)
        self.assertEqual(Path(upload["archive_dir"]), uploads_dir)

        payload = self.main._build_recordings_list_payload(root)
        # A name is unique within its folder only — two saves in the same
        # second into two collections are both ``YYYYMMDD-HHMMSS.txt`` —
        # so an entry is identified by folder AND name, as the renderer
        # does (``recordingItemKey``).
        by_key = {(Path(item["archive_dir"]), item["name"]): item for item in payload["items"]}
        self.assertEqual(by_key[(live_dir, live["name"])]["recording_collection"], "live")
        self.assertEqual(by_key[(uploads_dir, upload["name"])]["recording_collection"], "uploads")

        stats = self.main._build_recordings_stats_payload(root)
        self.assertEqual(stats["total_recordings"], 2)
        # BM-29: a word-count estimate travels under an ``estimated_`` name.
        for key in ("avg", "min", "max"):
            self.assertNotIn(f"{key}_duration_sec", stats)
            self.assertIsInstance(stats[f"estimated_{key}_duration_sec"], int)
        words_per_rec = stats["total_words"] / stats["total_recordings"]
        self.assertAlmostEqual(
            stats["estimated_avg_duration_sec"],
            words_per_rec / self.main.STATS_SPEECH_WORDS_PER_MIN * 60.0,
            delta=1.0,
        )

    def test_json_boolean_parser_matches_form_semantics(self):
        self.assertFalse(self.main._payload_bool({"enabled": "false"}, "enabled", True))
        self.assertFalse(self.main._payload_bool({"enabled": "0"}, "enabled", True))
        self.assertTrue(self.main._payload_bool({"enabled": "true"}, "enabled", False))
        self.assertTrue(self.main._payload_bool({}, "enabled", True))
        with self.assertRaises(self.main.HTTPException):
            self.main._payload_bool({"enabled": "definitely"}, "enabled", False)

    def test_save_recording_accepts_case_insensitive_txt_extension(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        (target / "Existing.TXT").write_text("old", encoding="utf-8")

        result = self.main.save_recording({
            "name": "Existing.TXT",
            "archive_dir": str(target),
            "require_existing": "true",
            "title": "Existing",
            "source_text": "source",
            "transcript_text": "updated",
        })

        self.assertEqual(result["name"], "Existing.TXT")
        self.assertIn("updated", (target / "Existing.TXT").read_text(encoding="utf-8"))

    def test_recording_text_lookup_normalizes_windows_path_leaf(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.TXT"
        existing.write_text("old", encoding="utf-8")
        audio = target / "Existing.wav"
        audio.write_bytes(b"audio")

        path = self.main._recording_path_or_404(r"C:\archive\Existing.TXT", target_dir=target)
        audio_path = self.main._recording_audio_path(r"C:\archive\Existing.TXT", target_dir=target)

        self.assertEqual(path, existing)
        self.assertEqual(audio_path, audio)

    def test_save_recording_existing_name_normalizes_windows_path_leaf(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.TXT"
        existing.write_text("old", encoding="utf-8")

        result = self.main.save_recording({
            "name": r"C:\archive\Existing.TXT",
            "archive_dir": str(target),
            "require_existing": "true",
            "title": "Existing",
            "source_text": "source",
            "transcript_text": "updated",
        })

        self.assertEqual(result["name"], "Existing.TXT")
        self.assertTrue(existing.exists())
        self.assertFalse((target / r"C:\archive\Existing.TXT").exists())
        self.assertIn("updated", existing.read_text(encoding="utf-8"))

    def test_failed_text_save_does_not_register_archive_dir(self):
        target = Path(self._tmp.name) / "custom-recordings"
        target.mkdir()

        with mock.patch.object(self.main, "_atomic_write_text", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.main.save_recording({
                    "archive_dir": str(target),
                    "title": "Will fail",
                    "source_text": "source",
                    "transcript_text": "transcript",
                })

        registry = self.main._ARCHIVE_DIR_REGISTRY_PATH
        registered = registry.read_text(encoding="utf-8") if registry.exists() else ""
        self.assertNotIn(str(target.resolve()), registered)

    def test_get_recording_uses_archive_dir_for_duplicate_names(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        live_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_LIVE]
        uploads_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_UPLOADS]
        live_dir.mkdir(parents=True)
        uploads_dir.mkdir(parents=True)
        self.main._write_recording_text_file(
            out=live_dir / "same.txt",
            title="same",
            source_text="live source",
            transcript_text="live transcript",
            provider="local",
            model="small",
            language="ru",
        )
        self.main._write_recording_text_file(
            out=uploads_dir / "same.txt",
            title="same",
            source_text="upload source",
            transcript_text="upload transcript",
            provider="deepgram",
            model="nova-3",
            language="ru",
        )

        payload = asyncio.run(
            self.main.get_recording("same.txt", archive_dir=str(uploads_dir))
        )

        self.assertIn("upload transcript", payload["content"])
        self.assertEqual(Path(payload["archive_dir"]), uploads_dir)
        self.assertEqual(payload["recording_collection"], "uploads")

    def test_recordings_cache_key_changes_when_existing_file_changes(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "note.txt"
        recording.write_text("Title: note\nTranscription:\none\n", encoding="utf-8")
        os.utime(recording, (1_700_000_000, 1_700_000_000))

        first_key = self.main._recordings_scan_cache_key(root)

        recording.write_text("Title: note\nTranscription:\ntwo changed\n", encoding="utf-8")
        os.utime(recording, (1_700_000_010, 1_700_000_010))
        second_key = self.main._recordings_scan_cache_key(root)

        self.assertNotEqual(first_key, second_key)

    def test_recordings_cache_key_tracks_audio_sidecars_and_uppercase_txt(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Existing.TXT"
        recording.write_text("Title: Existing\nTranscription:\none\n", encoding="utf-8")
        os.utime(recording, (1_700_000_000, 1_700_000_000))

        first_key = self.main._recordings_scan_cache_key(root)

        audio = root / "Existing.webm"
        audio.write_bytes(b"audio-v1")
        os.utime(audio, (1_700_000_010, 1_700_000_010))
        second_key = self.main._recordings_scan_cache_key(root)

        audio.write_bytes(b"audio-v2-longer")
        os.utime(audio, (1_700_000_020, 1_700_000_020))
        third_key = self.main._recordings_scan_cache_key(root)

        self.assertNotEqual(first_key, second_key)
        self.assertNotEqual(second_key, third_key)

    def test_uppercase_txt_recording_is_visible_in_history_and_stats(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Existing.TXT"
        self.main._write_recording_text_file(
            out=recording,
            title="Existing",
            source_text="source words",
            transcript_text="visible transcript",
            provider="local",
            model="small",
            language="ru",
        )

        list_payload = self.main._build_recordings_list_payload(root)
        stats_payload = self.main._build_recordings_stats_payload(root)

        self.assertEqual([item["name"] for item in list_payload["items"]], ["Existing.TXT"])
        self.assertEqual(stats_payload["total_recordings"], 1)

    def test_delete_all_removes_uppercase_txt_recordings(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Existing.TXT"
        audio = root / "Existing.webm"
        recording.write_text("Title: Existing\nSaved at: 2026-11-20 10:00:00\nTranscription:\none\n", encoding="utf-8")
        audio.write_bytes(b"audio")

        result = self.main._delete_all_recordings_sync()

        self.assertEqual(result["deleted"], 1)
        self.assertFalse(recording.exists())
        self.assertFalse(audio.exists())

    def test_delete_all_restores_audio_when_transcript_delete_fails(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Locked.TXT"
        audio = root / "Locked.webm"
        recording.write_text("Title: Locked\nSaved at: 2026-11-20 10:00:00\nTranscription:\none\n", encoding="utf-8")
        audio.write_bytes(b"audio")
        original_unlink = Path.unlink

        def locked_transcript_unlink(path_self, *args, **kwargs):
            if path_self == recording:
                raise PermissionError("locked transcript")
            return original_unlink(path_self, *args, **kwargs)

        with mock.patch.object(Path, "unlink", locked_transcript_unlink):
            result = self.main._delete_all_recordings_sync()

        self.assertEqual(result["deleted"], 0)
        self.assertEqual(result["failed"], 1)
        self.assertTrue(recording.exists())
        self.assertTrue(audio.exists())
        self.assertEqual(audio.read_bytes(), b"audio")
        self.assertFalse(list(root.glob("Locked.webm.tmp-*")))

    def test_audio_retention_matches_uppercase_txt_siblings(self):
        # The sibling-transcript guard must be case-insensitive: a
        # ``.TXT`` sibling still marks its audio as a real recording and
        # therefore a retention candidate. Without this, the audio of
        # every uppercase-suffixed transcript would look like an orphan
        # and be kept forever.
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        (root / "Keep.TXT").write_text("Title: Keep\nSaved at: 2026-11-20 10:00:00\n", encoding="utf-8")
        keep_audio = root / "Keep.webm"
        keep_audio.write_bytes(b"keep")
        (root / "Old.TXT").write_text("Title: Old\nSaved at: 2026-11-20 10:00:00\n", encoding="utf-8")
        old_audio = root / "Old.webm"
        old_audio.write_bytes(b"old")

        now = 1_000_000_000.0
        os.utime(keep_audio, (now - 60, now - 60))
        os.utime(old_audio, (now - 600, now - 600))

        # Explicit single-slot policy so this test asserts the sibling
        # matching only, independent of the shipped per-collection
        # numbers (which test_audio_retention.py owns).
        pruned = self.main._prune_recording_audio(
            root,
            now=now,
            policy=self.main.AudioRetentionPolicy(max_items=1),
        )

        self.assertEqual(pruned, 1)
        self.assertTrue(keep_audio.exists())
        self.assertFalse(old_audio.exists())

    def test_save_with_audio_upload_collection_writes_uploaded_media_folder(self):
        upload_file = self.main.UploadFile(
            io.BytesIO(b"tiny mp3 payload"),
            filename="lecture.mp3",
            size=len(b"tiny mp3 payload"),
        )

        result = asyncio.run(self.main.save_recording_with_audio(
            file=upload_file,
            name="",
            archive_dir="",
            require_existing=False,
            title="Lecture",
            source_text="source",
            transcript_text="transcript",
            provider="deepgram",
            model="nova-3",
            language="ru",
            recording_collection="uploads",
            live_session_id="",
        ))

        target_dir = Path(result["archive_dir"])
        self.assertEqual(
            target_dir.name,
            self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_UPLOADS],
        )
        self.assertTrue((target_dir / result["name"]).exists())
        self.assertTrue((target_dir / result["audio_name"]).exists())

    def test_save_with_audio_provider_none_keeps_audio_only_metadata(self):
        upload_file = self.main.UploadFile(
            io.BytesIO(b"tiny wav payload"),
            filename="audio-only.wav",
            size=len(b"tiny wav payload"),
        )

        result = asyncio.run(self.main.save_recording_with_audio(
            file=upload_file,
            name="",
            archive_dir="",
            require_existing=False,
            title="Audio Only",
            source_text="",
            transcript_text="",
            provider="none",
            model="",
            language="auto",
            recording_collection="live",
            live_session_id="",
        ))

        target_dir = Path(result["archive_dir"])
        content = (target_dir / result["name"]).read_text(encoding="utf-8")
        self.assertIn("Provider: none", content)
        self.assertNotIn("[No speech captured]", content)
        self.assertNotIn("Original:", content)
        self.assertTrue((target_dir / result["audio_name"]).exists())

    def test_save_with_audio_preserves_existing_txt_extension_casing(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.TXT"
        existing.write_text("old", encoding="utf-8")
        upload_file = self.main.UploadFile(
            io.BytesIO(b"tiny wav payload"),
            filename="replacement.wav",
            size=len(b"tiny wav payload"),
        )

        result = asyncio.run(self.main.save_recording_with_audio(
            file=upload_file,
            name="Existing.TXT",
            archive_dir=str(target),
            require_existing=True,
            title="Existing",
            source_text="source",
            transcript_text="updated",
            provider="local",
            model="small",
            language="ru",
            recording_collection="",
            live_session_id="",
        ))

        self.assertEqual(result["name"], "Existing.TXT")
        self.assertTrue(existing.exists())
        self.assertIn("Existing.TXT", {p.name for p in target.iterdir()})
        self.assertEqual(
            sum(1 for p in target.iterdir() if p.name.lower() == "existing.txt"),
            1,
        )
        self.assertIn("updated", existing.read_text(encoding="utf-8"))

    def test_save_with_audio_existing_name_normalizes_windows_path_leaf(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.TXT"
        existing.write_text("old", encoding="utf-8")
        upload_file = self.main.UploadFile(
            io.BytesIO(b"tiny wav payload"),
            filename="replacement.wav",
            size=len(b"tiny wav payload"),
        )

        result = asyncio.run(self.main.save_recording_with_audio(
            file=upload_file,
            name=r"C:\archive\Existing.TXT",
            archive_dir=str(target),
            require_existing=True,
            title="Existing",
            source_text="source",
            transcript_text="updated",
            provider="local",
            model="small",
            language="ru",
            recording_collection="",
            live_session_id="",
        ))

        self.assertEqual(result["name"], "Existing.TXT")
        self.assertTrue(existing.exists())
        self.assertTrue((target / "Existing.wav").exists())
        self.assertFalse((target / r"C:\archive\Existing.TXT").exists())
        self.assertIn("updated", existing.read_text(encoding="utf-8"))

    def test_save_with_audio_restores_existing_audio_when_new_upload_fails(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.txt"
        existing.write_text("old", encoding="utf-8")
        old_audio = target / "Existing.wav"
        old_audio.write_bytes(b"old audio")

        async def failing_writer(_tmp_audio: Path) -> None:
            raise OSError("simulated write failure")

        with self.assertRaises(OSError):
            asyncio.run(self.main._save_recording_audio_source(
                orig_name="replacement.wav",
                write_tmp_audio=failing_writer,
                name="Existing.txt",
                archive_dir=str(target),
                require_existing=True,
                title="Existing",
                source_text="source",
                transcript_text="updated",
                provider="local",
                model="small",
                language="ru",
                recording_collection="",
                live_session_id="",
            ))

        self.assertEqual(old_audio.read_bytes(), b"old audio")
        self.assertEqual(existing.read_text(encoding="utf-8"), "old")

    def test_save_with_audio_aborts_if_existing_audio_backup_fails(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.txt"
        existing.write_text("old", encoding="utf-8")
        old_audio = target / "Existing.wav"
        old_audio.write_bytes(b"old audio")

        async def writer(tmp_audio: Path) -> None:
            tmp_audio.write_bytes(b"new audio")

        real_replace = os.replace

        def fail_backup_replace(src, dst):
            if Path(src).resolve() == old_audio.resolve():
                raise OSError("locked old audio")
            return real_replace(src, dst)

        with mock.patch.object(self.main.os, "replace", side_effect=fail_backup_replace):
            with self.assertRaises(self.main.HTTPException) as cm:
                asyncio.run(self.main._save_recording_audio_source(
                    orig_name="replacement.wav",
                    write_tmp_audio=writer,
                    name="Existing.txt",
                    archive_dir=str(target),
                    require_existing=True,
                    title="Existing",
                    source_text="source",
                    transcript_text="updated",
                    provider="local",
                    model="small",
                    language="ru",
                    recording_collection="",
                    live_session_id="",
                ))

        self.assertEqual(cm.exception.status_code, 500)
        self.assertEqual(old_audio.read_bytes(), b"old audio")
        self.assertEqual(existing.read_text(encoding="utf-8"), "old")

    def test_save_with_audio_does_not_fail_when_old_sidecar_cleanup_fails(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        existing = target / "Existing.txt"
        existing.write_text("old", encoding="utf-8")
        old_audio = target / "Existing.webm"
        old_audio.write_bytes(b"old audio")

        async def writer(tmp_audio: Path) -> None:
            tmp_audio.write_bytes(b"new audio")

        real_unlink = Path.unlink

        def flaky_unlink(path_obj: Path, *args, **kwargs):
            if path_obj.resolve() == old_audio.resolve():
                raise OSError("locked old audio")
            return real_unlink(path_obj, *args, **kwargs)

        with mock.patch.object(Path, "unlink", flaky_unlink):
            result = asyncio.run(self.main._save_recording_audio_source(
                orig_name="replacement.wav",
                write_tmp_audio=writer,
                name="Existing.txt",
                archive_dir=str(target),
                require_existing=True,
                title="Existing",
                source_text="source",
                transcript_text="updated",
                provider="local",
                model="small",
                language="ru",
                recording_collection="",
                live_session_id="",
            ))

        self.assertEqual(result["name"], "Existing.txt")
        self.assertTrue((target / "Existing.wav").exists())
        self.assertTrue(old_audio.exists())
        self.assertIn("updated", existing.read_text(encoding="utf-8"))

    def test_failed_audio_save_does_not_register_archive_dir(self):
        target = Path(self._tmp.name) / "custom-audio-recordings"
        target.mkdir()

        async def failing_writer(_tmp_audio: Path) -> None:
            raise OSError("disk full")

        with self.assertRaises(OSError):
            asyncio.run(self.main._save_recording_audio_source(
                orig_name="replacement.wav",
                write_tmp_audio=failing_writer,
                name="",
                archive_dir=str(target),
                require_existing=False,
                title="Will fail",
                source_text="source",
                transcript_text="transcript",
                provider="local",
                model="small",
                language="ru",
                recording_collection="",
                live_session_id="",
            ))

        registry = self.main._ARCHIVE_DIR_REGISTRY_PATH
        registered = registry.read_text(encoding="utf-8") if registry.exists() else ""
        self.assertNotIn(str(target.resolve()), registered)

    def test_claim_recording_text_path_is_atomic_for_parallel_new_saves(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        barrier = threading.Barrier(2)
        results: list[str] = []
        errors: list[BaseException] = []

        def claim() -> None:
            try:
                barrier.wait(timeout=2)
                # The same second for both: one takes the plain name, the
                # other a collision suffix — never the same name.
                _stem, out = self.main._claim_recording_text_path(
                    target, recorded_at=datetime(2026, 11, 21, 3, 46, 11)
                )
                results.append(out.name)
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=claim) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)

        self.assertFalse(errors)
        self.assertEqual(len(results), 2)
        self.assertEqual(len(set(results)), 2)
        self.assertEqual(len(list(target.glob("*.tmp-*.claim"))), 2)
        self.assertEqual(len(list(target.glob("*.txt"))), 0)

        for name in results:
            self.main._write_recording_text_file(
                out=target / name,
                title=Path(name).stem,
                source_text="source",
                transcript_text="transcript",
                provider="local",
                model="small",
                language="ru",
            )

        self.assertEqual(list(target.glob("*.tmp-*.claim")), [])
        self.assertEqual(len(list(target.glob("*.txt"))), 2)

    def test_claim_cleanup_failure_does_not_mask_successful_text_write(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        out = target / "note.txt"
        claim = self.main._recording_text_claim_path(out)
        claim.mkdir()

        self.main._write_recording_text_file(
            out=out,
            title="note",
            source_text="source",
            transcript_text="transcript",
            provider="local",
            model="small",
            language="ru",
        )

        self.assertTrue(out.exists())
        self.assertTrue(claim.exists())
        self.assertIn("transcript", out.read_text(encoding="utf-8"))

    def test_failed_upload_validation_does_not_leave_queued_jobs(self):
        before = set(self.main.jobs._jobs)
        bad_file = self.main.UploadFile(
            io.BytesIO(b"not audio"),
            filename="bad.exe",
            size=len(b"not audio"),
        )

        with self.assertRaises(self.main.HTTPException):
            asyncio.run(self.main.create_job(file=bad_file))

        bad_remote = self.main.UploadFile(
            io.BytesIO(b"not audio"),
            filename="bad.exe",
            size=len(b"not audio"),
        )
        with self.assertRaises(self.main.HTTPException):
            asyncio.run(self.main.create_remote_job(file=bad_remote))

        self.assertEqual(set(self.main.jobs._jobs), before)

    def test_delete_all_recordings_removes_uppercase_txt_and_audio(self):
        root = (Path(self._tmp.name) / "recordings").resolve()
        root.mkdir(parents=True)
        recording = root / "Existing.TXT"
        recording.write_text("Title: Existing\nSaved at: 2026-11-20 10:00:00\n", encoding="utf-8")
        audio = root / "Existing.wav"
        audio.write_bytes(b"old audio")

        result = self.main._delete_all_recordings_sync()

        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["deleted"], 1)
        self.assertFalse(recording.exists())
        self.assertFalse(audio.exists())

    def test_save_from_path_upload_collection_copies_source_without_deleting_it(self):
        source = Path(self._tmp.name) / "lecture source.mp3"
        payload = b"tiny mp3 payload"
        source.write_bytes(payload)

        result = asyncio.run(self.main.save_recording_from_path(request=_RENDERER_REQUEST, payload={
            "source_path": str(source),
            "title": "Lecture",
            "source_text": "source",
            "transcript_text": "transcript",
            "provider": "deepgram",
            "model": "nova-3",
            "language": "ru",
            "recording_collection": "uploads",
        }))

        target_dir = Path(result["archive_dir"])
        self.assertTrue(source.exists())
        self.assertEqual(source.read_bytes(), payload)
        self.assertEqual(
            target_dir.name,
            self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_UPLOADS],
        )
        self.assertEqual((target_dir / result["audio_name"]).read_bytes(), payload)
        raw = (target_dir / result["name"]).read_text(encoding="utf-8")
        self.assertIn("Source file: lecture source.mp3", raw)

    def test_save_from_path_consumes_backend_owned_upload_snapshot_after_success(self):
        source = self.main.UPLOADS_DIR / "job.lecture.mp3"
        payload = b"tiny mp3 payload"
        source.write_bytes(payload)

        result = asyncio.run(self.main.save_recording_from_path(request=_RENDERER_REQUEST, payload={
            "source_path": str(source),
            "title": "Lecture",
            "source_text": "source",
            "transcript_text": "transcript",
            "provider": "deepgram",
            "model": "nova-3",
            "language": "ru",
            "recording_collection": "uploads",
            "consume_source_path": True,
        }))

        target_dir = Path(result["archive_dir"])
        self.assertFalse(source.exists())
        self.assertEqual((target_dir / result["audio_name"]).read_bytes(), payload)
        self.assertIn("transcript", (target_dir / result["name"]).read_text(encoding="utf-8"))

    def test_save_from_path_does_not_consume_user_source_path(self):
        source = Path(self._tmp.name) / "lecture source.mp3"
        payload = b"tiny mp3 payload"
        source.write_bytes(payload)

        result = asyncio.run(self.main.save_recording_from_path(request=_RENDERER_REQUEST, payload={
            "source_path": str(source),
            "title": "Lecture",
            "source_text": "source",
            "transcript_text": "transcript",
            "provider": "deepgram",
            "model": "nova-3",
            "language": "ru",
            "recording_collection": "uploads",
            "consume_source_path": True,
        }))

        target_dir = Path(result["archive_dir"])
        self.assertTrue(source.exists())
        self.assertEqual(source.read_bytes(), payload)
        self.assertEqual((target_dir / result["audio_name"]).read_bytes(), payload)

    def test_local_job_from_path_does_not_delete_source_file(self):
        source = Path(self._tmp.name) / "source.mp3"
        source.write_bytes(b"tiny mp3 payload")

        with mock.patch.object(
            self.main,
            "_run_local_transcribe_once",
            return_value={"text": "ok", "duration": 0, "segments": []},
        ) as run_once:
            created = asyncio.run(self.main.create_job_from_path({
                "source_path": str(source),
                "language": "ru",
                "model": "small",
                "split_stereo": True,
                "word_timestamps": False,
            }))
            job_id = created["job_id"]
            deadline = time.time() + 5
            job = None
            while time.time() < deadline:
                job = self.main.jobs.get(job_id)
                if job and job.status in {"done", "error", "cancelled"}:
                    break
                time.sleep(0.02)

        self.assertIsNotNone(job)
        self.assertEqual(job.status, "done")
        self.assertTrue(source.exists())
        run_once.assert_called_once()

    def test_safe_delete_live_recovery_swallow_cleanup_error(self):
        with mock.patch.object(
            self.main,
            "_delete_live_recovery",
            side_effect=OSError("locked recovery sidecar"),
        ):
            self.assertFalse(self.main._safe_delete_live_recovery("session-1"))

    def test_delete_live_recovery_preserves_pcm_when_metadata_delete_fails(self):
        session_id = "preservepcm"
        pcm_path = self.main.LIVE_RECOVERY_DIR / f"20260101_000000_{session_id}.pcm16"
        meta_path = pcm_path.with_suffix(".json")
        pcm_path.write_bytes(b"\x00\x00" * self.main.LIVE_SAMPLE_RATE_HZ)
        meta_path.write_text('{"session_id":"preservepcm"}', encoding="utf-8")
        real_unlink = Path.unlink

        def fail_meta_unlink(path_obj: Path, *args, **kwargs):
            if path_obj.resolve() == meta_path.resolve():
                raise OSError("locked metadata")
            return real_unlink(path_obj, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_meta_unlink):
            with self.assertRaises(OSError):
                self.main._delete_live_recovery(session_id)

        self.assertTrue(pcm_path.exists())
        self.assertTrue(meta_path.exists())

    def test_delete_live_recovery_removes_an_orphan_sidecar(self):
        # ``_live_recovery_paths`` resolves the pair by globbing for the
        # ``.pcm16``, so once the spool is gone it answered "no such
        # recovery" and the delete returned immediately — leaving the
        # ``.json`` behind with nothing that could ever name it again.
        # Measured on a real machine: 207 orphan sidecars against a
        # single live spool. Deleting a session's remains must not depend
        # on which half of it still happens to exist.
        session_id = "orphansidecar"
        meta_path = (
            self.main.LIVE_RECOVERY_DIR / f"20260101_000000_{session_id}.json"
        )
        meta_path.write_text('{"session_id":"orphansidecar"}', encoding="utf-8")

        self.assertTrue(self.main._delete_live_recovery(session_id))
        self.assertFalse(meta_path.exists())

    def test_delete_live_recovery_reports_false_when_nothing_exists(self):
        self.assertFalse(self.main._delete_live_recovery("nothinghere"))

    def test_delete_live_recovery_rejects_a_malformed_session_id(self):
        # The glob is built from the id, so a path-ish id must never
        # reach it.
        self.assertFalse(self.main._delete_live_recovery("../../etc"))
        self.assertFalse(self.main._delete_live_recovery(""))

    def test_discard_live_recovery_uses_safe_delete_path(self):
        with mock.patch.object(
            self.main,
            "_delete_live_recovery",
            side_effect=OSError("locked recovery sidecar"),
        ):
            self.assertEqual(
                self.main.discard_live_recovery("session-1", _auth=None),
                {"ok": True, "deleted": False},
            )

    def test_delete_upscale_preset_reports_controlled_error_on_unlink_failure(self):
        preset_path = self.main._upscale_preset_path("custom_delete")
        self.main._write_upscale_preset(
            preset_path,
            {
                "id": "custom_delete",
                "name": "Custom",
                "instruction": "Clean this transcript.",
                "builtin": False,
            },
        )
        real_unlink = Path.unlink

        def flaky_unlink(path_obj: Path, *args, **kwargs):
            if path_obj.resolve() == preset_path.resolve():
                raise OSError("locked preset")
            return real_unlink(path_obj, *args, **kwargs)

        with mock.patch.object(Path, "unlink", flaky_unlink):
            with self.assertRaises(self.main.HTTPException) as cm:
                self.main.delete_upscale_preset("custom_delete", _auth=None)

        self.assertEqual(cm.exception.status_code, 500)
        self.assertEqual(cm.exception.detail, "could not delete preset")


    def test_a_failed_new_save_releases_the_name_it_reserved(self):
        # B-016: the claim marker is what reserves the NAME, and the
        # rollback removed only the text file — which on this path was
        # never created, because ``write_tmp_audio`` raises first. The
        # marker survived, so the folder kept a file the sweeper never
        # visits (the archive is registered only after a SUCCESSFUL
        # save) and every retry in the same second was pushed to a
        # suffixed name. The clock is held in one second throughout, so
        # every attempt below asks for the same name.
        self.enterContext(_frozen_recording_clock(self.main, datetime(2026, 11, 21, 3, 46, 11)))
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()

        async def failing_writer(_tmp_audio: Path) -> None:
            raise OSError("upload larger than MAX_UPLOAD_BYTES")

        for _ in range(2):
            with self.assertRaises(OSError):
                asyncio.run(self.main._save_recording_audio_source(
                    orig_name="lecture.wav",
                    write_tmp_audio=failing_writer,
                    archive_dir=str(target),
                    title="lecture",
                    source_text="source",
                    transcript_text="transcript",
                    provider="local",
                    model="small",
                    language="ru",
                    recording_collection="",
                    live_session_id="",
                ))

        self.assertEqual(
            list(target.glob("*.claim")),
            [],
            "the failed save kept its name reservation",
        )
        self.assertEqual(list(target.glob("*.txt")), [])

        # And the natural name is still available afterwards.
        async def ok_writer(tmp_audio: Path) -> None:
            tmp_audio.write_bytes(b"audio")

        asyncio.run(self.main._save_recording_audio_source(
            orig_name="lecture.wav",
            write_tmp_audio=ok_writer,
            archive_dir=str(target),
            title="lecture",
            source_text="source",
            transcript_text="transcript",
            provider="local",
            model="small",
            language="ru",
            recording_collection="",
            live_session_id="",
        ))
        saved = [p.name for p in target.glob("*.txt")]
        self.assertEqual(saved, ["20261121-034611.txt"], saved)


    def test_the_empty_recognition_placeholder_is_one_rule(self):
        # B-031: both save endpoints wrote this rule out, and they had
        # already drifted — only one exempted provider="none", the
        # renderer's marker for "saved without asking for any
        # transcription". The same empty result produced a different
        # file depending on which endpoint was called.
        placeholder = self.main._placeholder_source_text
        self.assertEqual(
            placeholder("", "", "deepgram"), self.main.NO_SPEECH_PLACEHOLDER
        )
        self.assertEqual(placeholder("", "", ""), self.main.NO_SPEECH_PLACEHOLDER)
        # provider="none" means the user never asked for a transcript,
        # so an empty one is not a failed recognition.
        self.assertEqual(placeholder("", "", "none"), "")
        self.assertEqual(placeholder("", "", " NONE "), "")
        # Anything actually recognised is left exactly as it came.
        self.assertEqual(placeholder("сказанное", "", "deepgram"), "сказанное")
        self.assertEqual(placeholder("", "готово", "deepgram"), "")

    def test_both_save_endpoints_write_the_same_placeholder(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()

        self.main.save_recording({
            "title": "silent-a",
            "source_text": "",
            "transcript_text": "",
            "provider": "deepgram",
            "archive_dir": str(target),
        })

        async def writer(tmp_audio: Path) -> None:
            tmp_audio.write_bytes(b"audio")

        asyncio.run(self.main._save_recording_audio_source(
            orig_name="silent-b.wav",
            write_tmp_audio=writer,
            archive_dir=str(target),
            title="silent-b",
            source_text="",
            transcript_text="",
            provider="deepgram",
            model="nova-3",
            language="ru",
            recording_collection="",
            live_session_id="",
        ))

        bodies = {
            p.name: p.read_text(encoding="utf-8") for p in target.glob("*.txt")
        }
        self.assertEqual(len(bodies), 2, sorted(bodies))
        for name, body in bodies.items():
            with self.subTest(name=name):
                self.assertIn(self.main.NO_SPEECH_PLACEHOLDER, body)

    def test_the_promote_reserves_its_name_like_every_other_save(self):
        # B-032: the promote used check-then-use while the reservation
        # primitive existed and was used on the neighbouring path — two
        # answers to "is this name free", one able to lose a race with
        # the other and overwrite the .txt/.wav it picked.
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        seen: list = []
        real = self.main._claim_recording_text_path

        def spy(target_dir, **kwargs):
            out = real(target_dir, **kwargs)
            seen.append(out[0])
            return out

        session_id = "promote-claim"
        recovery_dir = self.main.LIVE_RECOVERY_DIR
        recovery_dir.mkdir(parents=True, exist_ok=True)
        # The spool name ``_open_live_recovery`` writes: ``YYYYmmdd_HHMMSS_<session>``.
        pcm = recovery_dir / f"20260904_193712_{session_id}.pcm16"
        pcm.write_bytes(b"\x00\x00" * 16000)
        pcm.with_suffix(".json").write_text(
            json.dumps({
                "session_id": session_id,
                "started_at": "2026-09-04T19:37:12.123456",
                "bytes": pcm.stat().st_size,
                "model": "nova-3",
                "language": "ru",
            }),
            encoding="utf-8",
        )

        with mock.patch.object(self.main, "_claim_recording_text_path", spy):
            result = self.main._promote_live_recovery(
                session_id, archive_dir=str(target), recording_collection=""
            )

        self.assertEqual(len(seen), 1, "the promote did not reserve its name")
        # Named by the one rule, after when the take STARTED.
        self.assertEqual(seen[0], "20260904-193712")
        self.assertEqual(result["name"], "20260904-193712.txt")
        self.assertEqual(result["audio_name"], "20260904-193712.wav")
        promoted_dir = Path(result["archive_dir"])
        self.assertTrue((promoted_dir / result["name"]).exists())
        self.assertTrue((promoted_dir / result["audio_name"]).exists())
        self.assertEqual(list(promoted_dir.glob("*.claim")), [])
        # The title lives in the header only.
        self.assertIn(
            "Title: Recovered 2026-09-04T19:37:12.123456",
            (promoted_dir / result["name"]).read_text(encoding="utf-8"),
        )


class ShortRecordingNameTests(_IsolatedMainCase):
    """Every save path names a recording by the one rule
    (``backend/recording_names.py``), the title stays in the header, and
    recordings saved under the legacy ``<timestamp>__<title>`` form keep
    working beside the new ones."""

    NEW_NAME = re.compile(r"^\d{8}-\d{6}(-[0-9a-f]{4})?\.txt$")
    TITLE = "Первые слова диктовки: план на завтра, v2.1"

    def _root(self) -> Path:
        return (Path(self._tmp.name) / "recordings").resolve()

    def test_every_collection_saves_under_the_time_name(self):
        for collection in ("live", "uploads", "screen"):
            with self.subTest(collection=collection):
                result = self.main.save_recording({
                    "title": self.TITLE,
                    "source_text": "source",
                    "transcript_text": "transcript",
                    "provider": "deepgram",
                    "model": "nova-3",
                    "language": "ru",
                    "recording_collection": collection,
                })
                self.assertRegex(result["name"], self.NEW_NAME)
                text = (Path(result["archive_dir"]) / result["name"]).read_text(encoding="utf-8")
                self.assertTrue(text.startswith(f"Title: {self.TITLE}\nSaved at: "), text[:200])

    def test_a_save_with_audio_names_text_and_audio_by_time_not_by_the_file(self):
        upload_file = self.main.UploadFile(
            io.BytesIO(b"tiny mp4 payload"),
            filename="Team meeting - итоги.mp4",
            size=len(b"tiny mp4 payload"),
        )
        result = asyncio.run(self.main.save_recording_with_audio(
            file=upload_file,
            name="",
            archive_dir="",
            require_existing=False,
            title="Team meeting - итоги",
            source_text="source",
            transcript_text="transcript",
            provider="deepgram",
            model="nova-3",
            language="ru",
            recording_collection="uploads",
            live_session_id="",
        ))
        self.assertRegex(result["name"], self.NEW_NAME)
        target_dir = Path(result["archive_dir"])
        stem = Path(result["name"]).stem
        self.assertTrue((target_dir / f"{stem}.mp4").is_file())
        # The source file's own name is metadata: History shows it.
        text = (target_dir / result["name"]).read_text(encoding="utf-8")
        self.assertIn("Source file: Team meeting - итоги.mp4", text)
        item = self.main._build_recordings_list_payload(target_dir)["items"][0]
        self.assertEqual(item["display_name"], "Team meeting - итоги.mp4")
        self.assertEqual(item["audio_name"], f"{stem}.mp4")

    def test_saves_in_the_same_second_get_a_collision_suffix(self):
        self.enterContext(_frozen_recording_clock(self.main, datetime(2026, 11, 21, 3, 46, 11)))
        names = [
            self.main.save_recording({
                "title": self.TITLE,
                "source_text": "s",
                "transcript_text": f"take {i}",
                "provider": "local",
                "recording_collection": "live",
            })["name"]
            for i in range(3)
        ]
        self.assertEqual(names[0], "20261121-034611.txt")
        for name in names[1:]:
            self.assertRegex(name, r"^20261121-034611-[0-9a-f]{4}\.txt$")
        self.assertEqual(len(set(names)), 3)

    def test_history_names_a_new_recording_from_its_header_not_its_file_name(self):
        root = self._root()
        root.mkdir(parents=True)
        # No words in the transcript and a generic title: the header is
        # still a better name than ``20261121-034611``.
        (root / "20261121-034611.txt").write_text(
            "Title: recording\nSaved at: 2026-11-21 03:46:11\nLanguage: ru\n\n", encoding="utf-8",
        )
        (root / "20261121-034612.txt").write_text(
            f"Title: {self.TITLE}\nSaved at: 2026-11-21 03:46:12\nLanguage: ru\n\n", encoding="utf-8",
        )
        by_name = {i["name"]: i for i in self.main._build_recordings_list_payload(root)["items"]}
        self.assertEqual(by_name["20261121-034611.txt"]["display_name"], "recording")
        self.assertEqual(by_name["20261121-034612.txt"]["display_name"], self.TITLE)
        # And the viewer's own payload names it the same way.
        payload = self.main._read_recording_payload(root / "20261121-034612.txt", root)
        self.assertEqual(payload["display_name"], self.TITLE)

    def test_a_legacy_recording_without_a_title_keeps_its_stem_as_the_fallback(self):
        root = self._root()
        root.mkdir(parents=True)
        legacy = "2026-11-21_03-46-11-851314__первые слова"
        (root / f"{legacy}.txt").write_text("no header at all\n", encoding="utf-8")
        item = self.main._build_recordings_list_payload(root)["items"][0]
        # ``_first_words`` finds nothing outside an Original/Transcription
        # section, so the stem is what it showed before.
        self.assertEqual(item["display_name"], legacy)

    def test_legacy_and_new_names_list_read_serve_and_delete_side_by_side(self):
        root = self._root()
        live_dir = root / self.main.RECORDING_COLLECTION_DIR_NAMES[self.main.RECORDING_COLLECTION_SCREEN]
        live_dir.mkdir(parents=True)
        stems = {
            "legacy": "2026-11-21_03-46-11-851314__первые слова диктовки",
            "new": "20261121-034611",
        }
        for kind, stem in stems.items():
            (live_dir / f"{stem}.txt").write_text(
                f"Title: {kind} title\nSaved at: 2026-11-21 03:46:11\nLanguage: ru\n"
                f"Provider: deepgram\nModel: nova-3\n\nTranscription:\n{kind} words\n",
                encoding="utf-8",
            )
            (live_dir / f"{stem}.wav").write_bytes(b"RIFF" + kind.encode())
            screens = live_dir / f"{stem}.screens"
            screens.mkdir()
            (screens / "shot-01.png").write_bytes(b"\x89PNG" + kind.encode())

        items = self.main._build_recordings_list_payload(root)["items"]
        by_name = {i["name"]: i for i in items}
        self.assertEqual(set(by_name), {f"{s}.txt" for s in stems.values()})
        for kind, stem in stems.items():
            with self.subTest(kind=kind):
                name = f"{stem}.txt"
                item = by_name[name]
                self.assertEqual(item["display_name"], f"{kind} words")
                self.assertTrue(item["has_audio"])
                self.assertEqual(item["audio_name"], f"{stem}.wav")
                self.assertEqual(item["recording_collection"], "screen")

                read = asyncio.run(self.main.get_recording(name, archive_dir=str(live_dir), _auth=None))
                self.assertEqual(read["display_text"], f"{kind} words")
                self.assertEqual(read["display_name"], f"{kind} words")
                self.assertEqual(read["screens"], ["shot-01.png"])

                audio = self.main._recording_audio_file_or_404(name, str(live_dir))
                self.assertEqual(audio.read_bytes(), b"RIFF" + kind.encode())
                shot = self.main.get_recording_screenshot(
                    name, "shot-01.png", archive_dir=str(live_dir), _auth=None
                )
                self.assertTrue(str(shot.path).endswith(f"{stem}.screens/shot-01.png"))

        self.main._register_archive_dir(live_dir)
        result = self.main._delete_all_recordings_sync()
        self.assertEqual(result["deleted"], 2)
        self.assertEqual(sorted(p.name for p in live_dir.iterdir()), [])

    def test_the_log_shows_a_new_name_as_is_and_hides_a_legacy_title(self):
        safe = self.main._log_safe_recording_name
        self.assertEqual(safe("20261121-034611.txt"), "20261121-034611.txt")
        self.assertEqual(safe("20261121-034611-a3f9.screens"), "20261121-034611-a3f9.screens")
        legacy = safe("2026-11-21_03-46-11-851314__секретный план.wav")
        self.assertTrue(legacy.startswith("2026-11-21_03-46-11-851314#"), legacy)
        self.assertTrue(legacy.endswith(".wav"))
        self.assertNotIn("секретный", legacy)


if __name__ == "__main__":
    unittest.main()
