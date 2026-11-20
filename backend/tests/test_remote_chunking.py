import importlib
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


class RemoteChunkingTests(unittest.TestCase):
    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
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

    def test_remote_transcribe_sends_chunks_and_merges_in_order(self):
        source = Path(self._tmp.name) / "source.mp4"
        source.write_bytes(b"source-video-bytes")
        calls = []

        def fake_compact(path_in, output_dir, *, chunk_sec, cancel_event=None):
            self.assertEqual(path_in, str(source))
            self.assertEqual(chunk_sec, self.main.REMOTE_TRANSCRIBE_CHUNK_SEC)
            out_dir = Path(output_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            paths = []
            for idx, payload in enumerate((b"one", b"two", b"three")):
                p = out_dir / f"chunk_{idx:05d}.webm"
                p.write_bytes(payload)
                paths.append(str(p))
            return paths

        def fake_deepgram_transcribe(**kwargs):
            calls.append(
                {
                    "filename": kwargs["filename"],
                    "bytes": kwargs["audio_bytes"],
                    "language": kwargs["language"],
                    "diarize": kwargs["diarize"],
                    "num_speakers": kwargs["num_speakers"],
                }
            )
            return {
                "text": f"text:{kwargs['filename']}",
                "raw": {"filename": kwargs["filename"]},
            }

        progress = []
        with mock.patch.object(
            self.main,
            "compact_audio_chunks_for_remote",
            side_effect=fake_compact,
        ), mock.patch.object(
            self.main,
            "deepgram_transcribe",
            side_effect=fake_deepgram_transcribe,
        ):
            result = self.main._run_remote_transcribe_once(
                provider_norm="deepgram",
                upload_path=source,
                orig_name="long.mp4",
                language="ru",
                diarize=True,
                num_speakers="2",
                remote_model="nova-3",
                cfg={"providers": {"deepgram": {"key": "dg-key"}}, "preferences": {}},
                progress_cb=progress.append,
            )

        self.assertEqual(
            [c["filename"] for c in calls],
            ["long.part0001.webm", "long.part0002.webm", "long.part0003.webm"],
        )
        self.assertEqual([c["bytes"] for c in calls], [b"one", b"two", b"three"])
        self.assertTrue(all(c["language"] == "ru" for c in calls))
        self.assertTrue(all(c["diarize"] for c in calls))
        self.assertTrue(all(c["num_speakers"] == "2" for c in calls))
        self.assertEqual(result["provider"], "deepgram")
        self.assertEqual(result["model"], "nova-3")
        self.assertEqual(
            result["text"],
            "text:long.part0001.webm\n\n"
            "text:long.part0002.webm\n\n"
            "text:long.part0003.webm",
        )
        self.assertTrue(result["raw"]["chunked"])
        self.assertEqual(len(result["raw"]["chunks"]), 3)
        self.assertGreaterEqual(progress[0], 0.18)
        self.assertGreaterEqual(progress[-1], 0.9)

    def test_remote_model_travels_under_model_only(self):
        source = Path(self._tmp.name) / "source.wav"
        source.write_bytes(b"source-audio-bytes")
        chunk = Path(self._tmp.name) / "chunk.webm"
        chunk.write_bytes(b"chunk")

        models = []

        def fake_deepgram_transcribe(**kwargs):
            models.append(kwargs["model"])
            return {"text": "ok", "raw": {}}

        with mock.patch.object(
            self.main,
            "compact_audio_chunks_for_remote",
            return_value=[str(chunk)],
        ), mock.patch.object(
            self.main,
            "deepgram_transcribe",
            side_effect=fake_deepgram_transcribe,
        ):
            canonical = self.main._run_remote_transcribe_once(
                provider_norm="deepgram",
                upload_path=source,
                orig_name="source.wav",
                language="en",
                diarize=False,
                num_speakers="",
                remote_model="nova-3",
                cfg={"providers": {"deepgram": {"key": "dg-key"}}, "preferences": {}},
            )

        self.assertEqual(canonical["model"], "nova-3")
        self.assertEqual(models, ["nova-3"])
        # FG-11: the "legacy aliases kept for older clients" are gone — no
        # older client exists (renderer and CLI send ``model``).
        self.assertEqual(self.main._remote_model_from_payload({"model": " nova-3 "}), "nova-3")
        self.assertEqual(
            self.main._remote_model_from_payload({"remote_model": "a", "openrouter_model": "b"}), ""
        )
        with self.assertRaises(TypeError):
            self.main._run_remote_transcribe_once(
                provider_norm="deepgram",
                upload_path=source,
                orig_name="source.wav",
                language="en",
                diarize=False,
                num_speakers="",
                openrouter_model="legacy-nova",
                cfg={"providers": {"deepgram": {"key": "dg-key"}}, "preferences": {}},
            )

    def test_live_recovery_helpers_are_optional(self):
        # A session with no recovery spool must be a NO-OP: not a crash,
        # not an implicitly created spool, and not a warning about a
        # spool nobody asked for. The test used to call both helpers and
        # assert nothing at all, so a helper that started fabricating a
        # recovery dict out of ``None`` — or swallowing a real error —
        # would have stayed green.
        self.assertIsNone(self.main._record_recovery_chunk(None, b"pcm"))
        self.assertIsNone(self.main._mark_recovery_error(None))
        with mock.patch.object(self.main.logger, "warning") as warn:
            self.main._record_recovery_chunk(None, b"pcm")
            self.main._mark_recovery_error(None)
        warn.assert_not_called()

    def test_live_recovery_write_failure_is_latched(self):
        class FailingPcmFile:
            def __init__(self):
                self.write_calls = 0

            def write(self, _data):
                self.write_calls += 1
                raise OSError("No space left on device")

        pcm = FailingPcmFile()
        recovery = {
            "pcm_file": pcm,
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

        with mock.patch.object(self.main.logger, "warning") as warn:
            self.main._record_recovery_chunk(recovery, b"first!")
            self.main._record_recovery_chunk(recovery, b"second")

        self.assertEqual(pcm.write_calls, 1)
        self.assertEqual(recovery["bytes"], 0)
        self.assertEqual(recovery["chunks"], 0)
        self.assertTrue(recovery["had_error"])
        self.assertTrue(recovery["write_failed"])
        self.assertIn("No space left", recovery["write_error"])
        warn.assert_called_once()

    def test_claiming_a_name_skips_an_existing_stem(self):
        # Through ``_claim_recording_text_path``, which is what every
        # caller uses. The check-then-use helper this test used to call
        # was dead in production and kept alive only by this test.
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        same_second = datetime(2026, 11, 21, 3, 46, 11)
        first, first_out = self.main._claim_recording_text_path(
            target, recorded_at=same_second
        )
        first_out.write_text("existing", encoding="utf-8")

        second, _second_out = self.main._claim_recording_text_path(
            target, recorded_at=same_second
        )

        self.assertEqual(first, "20261121-034611")
        self.assertRegex(second, r"^20261121-034611-[0-9a-f]{4}$")
        self.assertFalse((target / f"{second}.txt").exists())


if __name__ == "__main__":
    unittest.main()
