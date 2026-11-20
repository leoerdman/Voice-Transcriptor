import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from unittest import mock


def _reload_backend_main(data_dir: str):
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for module_name in ("backend.main", "backend.config", "backend.storage"):
        sys.modules.pop(module_name, None)
    return importlib.import_module("backend.main")


class UpscalePresetContractTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self.main = _reload_backend_main(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        for module_name in ("backend.main", "backend.config", "backend.storage"):
            sys.modules.pop(module_name, None)

    def test_presets_endpoint_exposes_backend_default_preset(self):
        response = self.main.list_upscale_presets(_auth=None)

        self.assertEqual(response["default_preset_id"], self.main.DEFAULT_UPSCALE_PRESET_ID)
        self.assertIn(
            self.main.DEFAULT_UPSCALE_PRESET_ID,
            {item["id"] for item in response["items"]},
        )

    def test_empty_upscale_preset_uses_backend_default(self):
        self.main.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-test-upscale-key-12345678"}},
            "preferences": {},
        })

        with mock.patch.object(
            self.main,
            "openrouter_upscale_text",
            return_value={"text": "Improved transcript"},
        ) as upscale:
            response = asyncio.run(self.main.upscale_text({"text": "raw transcript"}, _auth=None))

        self.assertTrue(response["ok"])
        self.assertEqual(response["preset_id"], self.main.DEFAULT_UPSCALE_PRESET_ID)
        self.assertEqual(response["text"], "Improved transcript")
        self.assertIn("Improve transcript readability", upscale.call_args.kwargs["instruction"])

    def test_upscale_trims_oversized_input_in_backend(self):
        self.main.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-test-upscale-key-12345678"}},
            "preferences": {},
        })
        oversized = "a" * (self.main.MAX_UPSCALE_INPUT_CHARS + 11)

        with mock.patch.object(
            self.main,
            "openrouter_upscale_text",
            return_value={"text": "Trimmed transcript"},
        ) as upscale:
            response = asyncio.run(self.main.upscale_text({"text": oversized}, _auth=None))

        self.assertEqual(response["trimmed_chars"], 11)
        self.assertEqual(len(upscale.call_args.kwargs["text"]), self.main.MAX_UPSCALE_INPUT_CHARS)
        self.assertEqual(upscale.call_args.kwargs["text"], oversized[11:])

    def test_model_fallback_is_decided_by_the_http_status_not_the_wording(self):
        # BM-13: "HTTP 404" / "not found" in the message used to decide it.
        from backend.remote_openrouter import OpenRouterError

        self.main.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-test-upscale-key-12345678"}},
            "preferences": {},
        })
        gone = OpenRouterError("no endpoints for this model", status_code=404)
        with mock.patch.object(
            self.main, "openrouter_upscale_text",
            side_effect=[gone, {"text": "From the fallback"}],
        ) as upscale:
            response = asyncio.run(self.main.upscale_text({"text": "raw"}, _auth=None))
        self.assertEqual(response["text"], "From the fallback")
        self.assertEqual(upscale.call_count, 2)

        # A non-404 failure whose prose says "not found" is not a missing model.
        worded = OpenRouterError("openrouter upscale failed: HTTP 400 audio file not found", status_code=400)
        with mock.patch.object(
            self.main, "openrouter_upscale_text",
            side_effect=[worded, {"text": "must not be reached"}],
        ) as upscale:
            with self.assertRaises(self.main.HTTPException) as raised:
                asyncio.run(self.main.upscale_text({"text": "raw"}, _auth=None))
        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(upscale.call_count, 1)

    def test_an_http_failure_carries_its_status(self):
        from backend import remote_openrouter

        class _Resp:
            status_code = 404
            text = "model gone"

        with mock.patch.object(remote_openrouter, "request_with_retry", return_value=_Resp()):
            with self.assertRaises(remote_openrouter.OpenRouterError) as raised:
                remote_openrouter.openrouter_upscale_text(
                    api_key="k", model="m", text="t", instruction="i"
                )
        self.assertEqual(raised.exception.status_code, 404)


class BuiltinPresetIdSsotTests(unittest.TestCase):
    """One list of built-in presets (B-030).

    Their ids were written out a second time as a bare set, used in
    exactly one place: validating the legacy ``preset`` field. Nothing
    connected the two, so a fifth built-in would have answered
    "unsupported upscale preset" to a legacy client asking for a preset
    that exists.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self.main = _reload_backend_main(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        for module_name in ("backend.main", "backend.config", "backend.storage"):
            sys.modules.pop(module_name, None)

    def test_there_is_no_second_list_of_builtin_ids(self):
        self.assertFalse(hasattr(self.main, "UPSCALE_PRESETS"))

    def test_every_builtin_is_accepted_as_a_legacy_preset(self):
        # The legacy field's validation and the presets themselves must
        # answer from the same list.
        for pid in self.main.BUILTIN_UPSCALE_PRESETS:
            with self.subTest(preset=pid):
                self.assertIn(pid, self.main.BUILTIN_UPSCALE_PRESETS)
        self.assertNotIn("no-such-preset", self.main.BUILTIN_UPSCALE_PRESETS)

    def test_the_default_preset_is_one_of_them(self):
        self.assertIn(
            self.main.DEFAULT_UPSCALE_PRESET_KEY, self.main.BUILTIN_UPSCALE_PRESETS
        )


class DefaultRemoteProviderTests(unittest.TestCase):
    """"Which provider serves a request that names none" has one answer (B-028)."""

    def test_the_default_is_the_first_of_the_supported_tuple(self):
        from backend.model_catalog import (
            DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER,
            REMOTE_TRANSCRIPTION_PROVIDERS,
        )

        self.assertEqual(
            DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER, REMOTE_TRANSCRIPTION_PROVIDERS[0]
        )

    def test_the_config_default_is_that_same_value(self):
        import tempfile as _tempfile

        with _tempfile.TemporaryDirectory() as td:
            old = os.environ.get("TRANSCRIPTOR_DATA_DIR")
            os.environ["TRANSCRIPTOR_DATA_DIR"] = td
            sys.modules.pop("backend.config", None)
            try:
                import backend.config as cfg_mod
                from backend.model_catalog import (
                    DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER,
                )

                self.assertEqual(
                    cfg_mod.DEFAULT_CONFIG["preferences"]["remote_provider"],
                    DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER,
                )
            finally:
                sys.modules.pop("backend.config", None)
                if old is None:
                    os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
                else:
                    os.environ["TRANSCRIPTOR_DATA_DIR"] = old

if __name__ == "__main__":
    unittest.main()
