"""Failures that were reported as something they were not.

Each case here is a place where the code answered a question it had not
actually been asked: "I do not recognise this status" became "this item
failed"; "another session owns the draft" became "cleared"; a chmod that
could not tighten permissions became "the write failed"; an unreadable
folder became "could not allocate a recording name". None of them
crashes, which is exactly why they survived — the wrong answer is
indistinguishable from the right one unless something asserts it.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from datetime import datetime
from unittest import mock


class _MainCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        os.environ["TRANSCRIPTOR_DATA_DIR"] = self._tmp.name
        for name in ("backend.main", "backend.config", "backend.storage"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")

    def tearDown(self) -> None:
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config", "backend.storage"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        self._tmp.cleanup()


class UploadQueueStatusTests(_MainCase):
    """An unknown status is neutral, not failed (B-051)."""

    def test_an_unknown_status_becomes_queued(self):
        item = self.main._normalize_upload_queue_item(
            {"id": "a", "displayName": "clip.mp4", "status": "uploading"}
        )
        self.assertEqual(item["status"], "queued")

    def test_a_known_status_is_kept(self):
        for status in sorted(self.main.UPLOAD_QUEUE_STATUSES):
            with self.subTest(status=status):
                item = self.main._normalize_upload_queue_item(
                    {"id": "a", "displayName": "clip.mp4", "status": status}
                )
                self.assertEqual(item["status"], status)


class LiveDraftTests(_MainCase):
    """The draft endpoints answer what actually happened."""

    def test_echoing_the_put_response_back_does_not_wipe_the_draft(self):
        # B-053: the shape was decided by counting keys, and the PUT
        # response has three — so the natural GET/PUT idiom read the
        # ENVELOPE as the draft, defaulted every field and persisted an
        # empty draft with HTTP 200.
        draft = {
            "session_id": "s1",
            "source_text": "половина продиктованного текста",
        }
        first = self.main.put_live_draft_state({"draft": draft}, _auth=None)
        self.assertEqual(first["draft"]["source_text"], draft["source_text"])

        second = self.main.put_live_draft_state(dict(first), _auth=None)
        self.assertEqual(
            second["draft"]["source_text"],
            draft["source_text"],
            "echoing the response back wiped the live draft",
        )

    def test_a_bare_draft_object_is_still_accepted(self):
        out = self.main.put_live_draft_state(
            {"session_id": "s2", "source_text": "напрямую"}, _auth=None
        )
        self.assertEqual(out["draft"]["source_text"], "напрямую")

    def test_clearing_someone_elses_draft_says_it_did_not_clear(self):
        # B-052: the refusal returned the current state and the endpoint
        # wrapped it in ``ok: true``, so a caller could not tell "gone"
        # from "left alone".
        self.main.put_live_draft_state(
            {"draft": {"session_id": "owner", "source_text": "чужое"}}, _auth=None
        )
        out = self.main.delete_live_draft_state(session_id="someone-else", _auth=None)
        self.assertFalse(out["cleared"])
        self.assertIsNotNone(out["draft"])

        out = self.main.delete_live_draft_state(session_id="owner", _auth=None)
        self.assertTrue(out["cleared"])
        self.assertIsNone(out["draft"])


class UnreadableRecordingsFolderTests(_MainCase):
    """An unreadable folder is not "could not allocate a name" (B-050)."""

    def test_it_answers_503_naming_the_folder(self):
        target = Path(self._tmp.name) / "recordings"
        target.mkdir()
        with mock.patch.object(
            Path, "iterdir", side_effect=OSError("disk not mounted")
        ):
            with self.assertRaises(self.main.HTTPException) as raised:
                self.main._claim_recording_text_path(target, recorded_at=datetime(2026, 11, 21, 3, 46, 11))
        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("not readable", raised.exception.detail)


class LiveRecoveryListingTests(_MainCase):
    """A half-written spool says so (B-076)."""

    def _sidecar(self, session_id: str, **extra) -> None:
        recovery_dir = self.main.LIVE_RECOVERY_DIR
        recovery_dir.mkdir(parents=True, exist_ok=True)
        pcm = recovery_dir / f"20260904_193712_{session_id}.pcm16"
        pcm.write_bytes(b"\x00\x00" * 16000)
        meta = {
            "session_id": session_id,
            "started_at": "2026-09-04T19:37:12.123456",
            "bytes": pcm.stat().st_size,
            "model": "nova-3",
            "language": "ru",
        }
        meta.update(extra)
        pcm.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")

    def test_the_listing_carries_the_status_and_the_reason(self):
        self._sidecar(
            "halfwritten", status="error", write_error="No space left on device"
        )
        rows = {r["session_id"]: r for r in self.main._list_live_recoveries()}
        row = rows["halfwritten"]
        self.assertEqual(row["status"], "error")
        self.assertIn("No space left", row["write_error"])

    def test_a_clean_session_reports_a_clean_status(self):
        self._sidecar("clean", status="recoverable")
        rows = {r["session_id"]: r for r in self.main._list_live_recoveries()}
        self.assertEqual(rows["clean"]["status"], "recoverable")
        self.assertEqual(rows["clean"]["write_error"], "")


class RetryReportingTests(unittest.TestCase):
    """The number of attempts reported is the number that happened (B-047)."""

    def test_a_non_idempotent_read_timeout_reports_one_attempt(self):
        import requests

        from backend.http_retry import RemoteError, request_with_retry

        with mock.patch(
            "backend.http_retry._SESSION.request",
            side_effect=requests.exceptions.ReadTimeout("read timed out"),
        ):
            with self.assertRaises(RemoteError) as raised:
                request_with_retry("POST", "https://example.invalid/x", attempts=3)
        self.assertIn("after 1 attempt:", str(raised.exception))

    def test_a_connection_error_reports_every_attempt_it_made(self):
        import requests

        from backend.http_retry import RemoteError, request_with_retry

        with mock.patch(
            "backend.http_retry._SESSION.request",
            side_effect=requests.exceptions.ConnectionError("refused"),
        ), mock.patch("backend.http_retry.time.sleep"):
            with self.assertRaises(RemoteError) as raised:
                request_with_retry("GET", "https://example.invalid/x", attempts=3)
        self.assertIn("after 3 attempts:", str(raised.exception))


class AtomicWriteChmodTests(unittest.TestCase):
    """A chmod that fails AFTER the rename is not a failed write (B-049)."""

    def test_the_write_is_reported_as_the_success_it_was(self):
        from backend.storage import atomic_write_bytes

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "token.txt"
            real_chmod = os.chmod

            def flaky_chmod(target, mode, *a, **kw):
                if str(target) == str(path):
                    raise OSError("operation not supported")
                return real_chmod(target, mode, *a, **kw)

            with mock.patch("backend.storage.os.chmod", flaky_chmod):
                atomic_write_bytes(path, b"secret", mode=0o600)

            self.assertEqual(path.read_bytes(), b"secret")


class OpenRouterUpscaleShapeTests(unittest.TestCase):
    """A multimodal content list is a provider error, not a 500 (B-042)."""

    def _response(self, content):
        class FakeResponse:
            status_code = 200
            text = "{}"

            def json(self):
                return {"choices": [{"message": {"content": content}}]}

        return FakeResponse()

    def test_a_list_content_is_coerced_rather_than_crashing(self):
        from backend.remote_openrouter import openrouter_upscale_text

        with mock.patch(
            "backend.remote_openrouter.request_with_retry",
            return_value=self._response([{"type": "text", "text": "готово"}]),
        ):
            out = openrouter_upscale_text(
                api_key="k", model="m", text="исходник", instruction="fix"
            )
        self.assertIn("готово", out["text"])

    def test_a_null_content_is_a_provider_error(self):
        from backend.http_retry import RemoteError
        from backend.remote_openrouter import openrouter_upscale_text

        with mock.patch(
            "backend.remote_openrouter.request_with_retry",
            return_value=self._response(None),
        ):
            with self.assertRaises(RemoteError):
                openrouter_upscale_text(
                    api_key="k", model="m", text="исходник", instruction="fix"
                )


class JobWorkerCrashTests(unittest.TestCase):
    """Nothing a worker raises may vanish (B-046)."""

    def test_an_escaped_exception_is_logged(self):
        from backend.jobs import JobStore

        store = JobStore()
        try:
            with self.assertLogs("backend.jobs", level="ERROR") as logs:
                store.submit(lambda: (_ for _ in ()).throw(RuntimeError("boom")))
                store.shutdown(timeout=2.0)
            self.assertTrue(
                any("job worker crashed" in line for line in logs.output),
                logs.output,
            )
        finally:
            store.shutdown(timeout=0.1)


class ModelDownloadClaimTests(unittest.TestCase):
    """A claim that cannot be released is a wedged model (B-045)."""

    def test_a_thread_that_will_not_start_releases_the_claim(self):
        import backend.models_manager as mm

        model_id = mm.WHISPER_LOCAL_MODELS[0]
        with mock.patch.object(mm, "whisper_downloaded", return_value=False), \
                mock.patch.object(
                    mm.threading.Thread,
                    "start",
                    side_effect=RuntimeError("can't start"),
                ):
            with self.assertRaises(RuntimeError):
                mm.start_download(model_id)
        state = mm._get_state(model_id)
        self.assertNotEqual(
            state.get("status"),
            "downloading",
            "the model is now neither downloadable nor deletable",
        )
        self.assertEqual(state.get("status"), "error")


class MaskedProviderKeyTests(unittest.TestCase):
    """Both shapes of "this is a mask" are recognised (B-055)."""

    def test_the_backend_mask_is_recognised(self):
        import backend.config as cfg_mod

        real = "sk-or-v1-abcdefghijkl"
        masked = cfg_mod._redact_provider_key_value(real)
        self.assertTrue(cfg_mod._is_masked_key_value(masked, real))

    def test_the_renderer_bullet_mask_is_recognised(self):
        import backend.config as cfg_mod

        real = "sk-or-v1-abcdefghijkl"
        # ``frontend/src/main.tsx``'s MASKED_KEY_VALUE.
        self.assertTrue(cfg_mod._is_masked_key_value("•" * 24, real))
        self.assertTrue(cfg_mod._is_masked_key_value("•" * 8, real))

    def test_a_real_key_is_not_a_mask(self):
        import backend.config as cfg_mod

        self.assertFalse(
            cfg_mod._is_masked_key_value("sk-or-v1-new", "sk-or-v1-old")
        )
        self.assertFalse(cfg_mod._is_masked_key_value("", "sk-or-v1-old"))


if __name__ == "__main__":
    unittest.main()
