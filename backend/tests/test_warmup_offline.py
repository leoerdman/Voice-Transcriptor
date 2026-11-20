"""An unreachable model host is a state, not a server error (audit §7).

``POST /api/transcribe/warmup`` answered 500 five times on 2026-09-01,
every traceback an httpx connection error raised inside the loader:
warming a local model goes through the Hugging Face hub even when the
weights are already cached. The user was working entirely through an API
provider and never needed the local model at all, and the renderer fires
this endpoint on startup, on provider change and on every network-state
flip — so a missing network produced a stream of 500s nobody could act
on.

The endpoint now reports it: HTTP 200, ``ok=false``, ``state="offline"``.
A loader that fails for any OTHER reason must still fail loudly.
"""

from __future__ import annotations

import unittest
from unittest import mock

import httpx

from backend.tests.test_live import IsolatedBackendMainImportMixin


class WarmupOfflineTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    def _model(self) -> str:
        return self.main.DEFAULT_LOCAL_TRANSCRIPTION_MODEL

    async def _warmup(self):
        return await self.main.transcribe_warmup(_auth=None, model=self._model())

    async def test_connection_error_reports_offline_instead_of_raising(self):
        boom = httpx.ConnectError("[Errno 8] nodename nor servname provided")
        with mock.patch.object(self.main, "warm_model", side_effect=boom):
            with self.assertLogs("backend.main", level="WARNING") as logs:
                result = await self._warmup()

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["state"], "offline")
        self.assertEqual(result["model"], self._model())
        self.assertTrue(result["detail"])
        self.assertTrue(
            any("unreachable" in line for line in logs.output),
            f"the condition must be logged once: {logs.output}",
        )

    async def test_the_offline_warning_is_logged_once_not_per_call(self):
        boom = httpx.ConnectError("no route to host")
        with mock.patch.object(self.main, "warm_model", side_effect=boom):
            with self.assertLogs("backend.main", level="WARNING") as logs:
                await self._warmup()
                await self._warmup()
                await self._warmup()
        warnings = [line for line in logs.output if "unreachable" in line]
        self.assertEqual(len(warnings), 1, warnings)

    async def test_a_transport_error_wrapped_by_the_hub_is_still_offline(self):
        # huggingface_hub re-raises transport failures inside its own
        # error types; the cause chain is what carries the fact.
        try:
            raise httpx.ConnectTimeout("timed out")
        except httpx.ConnectTimeout as cause:
            wrapped = OSError("Consistency check failed")
            wrapped.__cause__ = cause
        with mock.patch.object(self.main, "warm_model", side_effect=wrapped):
            result = await self._warmup()
        self.assertEqual(result["state"], "offline")

    async def test_a_real_loader_failure_still_fails(self):
        with mock.patch.object(
            self.main, "warm_model", side_effect=RuntimeError("CUDA kernel missing")
        ):
            with self.assertRaises(RuntimeError):
                await self._warmup()

    async def test_a_successful_warmup_is_unchanged(self):
        with mock.patch.object(
            self.main, "warm_model", return_value={"load_ms": 12, "probe_ms": 3}
        ):
            result = await self._warmup()
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["model"], self._model())
        self.assertNotIn("detail", result)

    async def test_an_expired_certificate_on_the_model_cdn_is_unreachable_not_500(self):
        # BL-11, verbatim from main.log 2026-11-19: GigaAM's checkpoint is
        # fetched with urllib, and its CDN's certificate had expired.
        import ssl
        import urllib.error

        cert = ssl.SSLCertVerificationError(1, "certificate verify failed: certificate has expired")
        boom = urllib.error.URLError(cert)
        with mock.patch.object(self.main, "warm_model", side_effect=boom):
            result = await self._warmup()
        self.assertEqual(result["state"], "offline")

    async def test_a_host_answering_with_an_http_error_still_fails(self):
        import urllib.error

        boom = urllib.error.HTTPError("https://cdn.example/model.ckpt", 404, "Not Found", {}, None)
        with mock.patch.object(self.main, "warm_model", side_effect=boom):
            with self.assertRaises(urllib.error.HTTPError):
                await self._warmup()


if __name__ == "__main__":
    unittest.main()
