"""The delegated-compute seam: contract, containment, and fallback.

These tests drive a real child process (this interpreter running a generated
plugin script), so they cover the transport, not a mock of it.
"""

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

import numpy as np
import soundfile as sf

from backend import compute_plugin
from backend import transcribe as transcribe_module
from backend.audio_constants import LIVE_SAMPLE_RATE_HZ

GOOD_PLUGIN = '''
import json, sys

for line in sys.stdin:
    request = json.loads(line)
    op = request.get("op")
    if op == "hello":
        answer = {"ok": True, "protocol": "transcriptor-compute/1", "device": "test",
                  "host": request.get("host")}
    elif op == "transcribe":
        answer = {
            "ok": True,
            "language": "ru",
            "language_probability": 0.9,
            "duration": 2.0,
            "segments": [{"start": 0.0, "end": 2.0, "text": "привет"}],
        }
    elif op == "shutdown":
        print(json.dumps({"ok": True}), flush=True)
        break
    else:
        answer = {"ok": False, "error": "unknown op %r" % op}
    print(json.dumps(answer, ensure_ascii=False), flush=True)
'''

OTHER_PROTOCOL_PLUGIN = '''
import json, sys

for line in sys.stdin:
    request = json.loads(line)
    if request.get("op") == "hello":
        print(json.dumps({"ok": True, "protocol": "transcriptor-compute/2"}), flush=True)
    else:
        print(json.dumps({"ok": True, "segments": [], "text": ""}), flush=True)
'''

CRASHING_PLUGIN = '''
import sys
sys.exit(3)
'''

SILENT_PLUGIN = '''
import time
time.sleep(60)
'''

MUTATING_PLUGIN = '''
import json, sys

for line in sys.stdin:
    request = json.loads(line)
    op = request.get("op")
    if op == "hello":
        answer = {"ok": True, "protocol": "transcriptor-compute/1",
                  "host": {"audio": {"sample_rate_hz": 8000, "channels": 2},
                           "models": ["large-v3"]}}
    elif op == "transcribe":
        answer = {"ok": True, "language": "en", "duration": 1.0,
                  "segments": [{"start": 0.0, "end": 1.0, "text": "kept"}]}
    elif op == "shutdown":
        break
    else:
        answer = {"ok": False, "error": "unknown op"}
    print(json.dumps(answer), flush=True)
'''

BROKEN_SEGMENT_PLUGIN = '''
import json, sys

for line in sys.stdin:
    request = json.loads(line)
    if request.get("op") == "hello":
        print(json.dumps({"ok": True, "protocol": "transcriptor-compute/1"}), flush=True)
    elif request.get("op") == "shutdown":
        break
    else:
        print(json.dumps({"ok": True, "segments": [{"start": 0.0, "text": "no end"}]}), flush=True)
'''


class ComputePluginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="vt-plugin-test-")
        self.addCleanup(shutil.rmtree, self.tmpdir, True)
        self.wav_path = os.path.join(self.tmpdir, "audio.wav")
        sf.write(self.wav_path, np.zeros(LIVE_SAMPLE_RATE_HZ, dtype=np.float32), LIVE_SAMPLE_RATE_HZ, subtype="PCM_16")
        compute_plugin.reset_for_tests()
        self.addCleanup(compute_plugin.reset_for_tests)
        for name in (
            "TRANSCRIPTOR_COMPUTE_PLUGIN",
            "TRANSCRIPTOR_COMPUTE_PLUGIN_ARGS",
            "TRANSCRIPTOR_COMPUTE_PLUGIN_TIMEOUT_SEC",
        ):
            self.addCleanup(os.environ.pop, name, None)

    def _install(self, body: str, timeout: str = "10") -> None:
        script = os.path.join(self.tmpdir, "plugin.py")
        with open(script, "w", encoding="utf-8") as stream:
            stream.write(body)
        os.environ["TRANSCRIPTOR_COMPUTE_PLUGIN"] = sys.executable
        os.environ["TRANSCRIPTOR_COMPUTE_PLUGIN_ARGS"] = json.dumps([script])
        os.environ["TRANSCRIPTOR_COMPUTE_PLUGIN_TIMEOUT_SEC"] = timeout
        compute_plugin.reset_for_tests()

    # ---- the contract --------------------------------------------------

    def test_no_plugin_configured_means_none(self) -> None:
        self.assertFalse(compute_plugin.delegate_available())
        self.assertIsNone(compute_plugin.delegate_transcribe(self.wav_path, "small"))

    def test_plugin_answers_a_transcription(self) -> None:
        self._install(GOOD_PLUGIN)
        self.assertTrue(compute_plugin.delegate_available())
        result = compute_plugin.delegate_transcribe(self.wav_path, "small", language="ru")
        self.assertIsNotNone(result)
        self.assertEqual(result["text"], "привет")
        self.assertEqual(result["language"], "ru")
        self.assertEqual(len(result["segments"]), 1)
        self.assertEqual(result["segments"][0]["end"], 2.0)

    def test_handshake_reports_the_plugin(self) -> None:
        self._install(GOOD_PLUGIN)
        hello = compute_plugin._configured().hello()
        self.assertEqual(hello["protocol"], compute_plugin.PROTOCOL)
        self.assertEqual(hello["device"], "test")

    def test_the_host_dictates_its_configuration_in_the_handshake(self) -> None:
        self._install(GOOD_PLUGIN, timeout="10")
        host = compute_plugin._configured().hello()["host"]
        self.assertEqual(host["audio"]["sample_rate_hz"], LIVE_SAMPLE_RATE_HZ)
        self.assertEqual(host["audio"]["channels"], 1)
        self.assertEqual(host["audio"]["sample_format"], "pcm_s16le")
        self.assertEqual(host["default_model"], "small")
        self.assertIn("small", host["models"])
        self.assertEqual(host["timeout_sec"], 10.0)

    def test_a_plugin_cannot_change_the_host_configuration(self) -> None:
        self._install(MUTATING_PLUGIN)
        plugin = compute_plugin._configured()
        hello = plugin.hello()
        self.assertEqual(hello["host"]["audio"]["sample_rate_hz"], 8000)
        self.assertEqual(plugin._host["audio"]["sample_rate_hz"], LIVE_SAMPLE_RATE_HZ)
        self.assertEqual(plugin._host["audio"]["channels"], 1)
        result = compute_plugin.delegate_transcribe(self.wav_path, "small")
        self.assertEqual(result["text"], "kept")

    # ---- containment ---------------------------------------------------

    def test_other_protocol_major_is_refused(self) -> None:
        self._install(OTHER_PROTOCOL_PLUGIN)
        self.assertIsNone(compute_plugin.delegate_transcribe(self.wav_path, "small"))

    def test_crashing_plugin_falls_back(self) -> None:
        self._install(CRASHING_PLUGIN)
        self.assertIsNone(compute_plugin.delegate_transcribe(self.wav_path, "small"))

    def test_silent_plugin_times_out(self) -> None:
        self._install(SILENT_PLUGIN, timeout="1")
        started = time.monotonic()
        self.assertIsNone(compute_plugin.delegate_transcribe(self.wav_path, "small"))
        self.assertLess(time.monotonic() - started, 20.0)

    def test_off_contract_segment_is_refused(self) -> None:
        self._install(BROKEN_SEGMENT_PLUGIN)
        self.assertIsNone(compute_plugin.delegate_transcribe(self.wav_path, "small"))

    def test_failure_cools_down_before_a_retry(self) -> None:
        self._install(CRASHING_PLUGIN)
        self.assertIsNone(compute_plugin.delegate_transcribe(self.wav_path, "small"))
        self.assertFalse(compute_plugin.delegate_available())

    # ---- the two entry points ------------------------------------------

    def test_file_entry_point_uses_the_plugin_and_skips_the_local_engine(self) -> None:
        self._install(GOOD_PLUGIN)
        with mock.patch.object(
            transcribe_module, "_model", side_effect=AssertionError("local engine must not run")
        ):
            result = transcribe_module.transcribe_file(self.wav_path, "small", language="ru")
        self.assertEqual(result["text"], "привет")

    def test_file_entry_point_falls_back_to_the_local_engine(self) -> None:
        self._install(OTHER_PROTOCOL_PLUGIN)
        with mock.patch.object(
            transcribe_module, "_model", side_effect=RuntimeError("local engine used")
        ):
            with self.assertRaisesRegex(RuntimeError, "local engine used"):
                transcribe_module.transcribe_file(self.wav_path, "small")

    def test_audio_entry_point_uses_the_plugin(self) -> None:
        self._install(GOOD_PLUGIN)
        audio = np.zeros(LIVE_SAMPLE_RATE_HZ, dtype=np.float32)
        with mock.patch.object(
            transcribe_module, "_model", side_effect=AssertionError("local engine must not run")
        ):
            result = transcribe_module.transcribe_audio(audio, "small", language="ru")
        self.assertEqual(result["text"], "привет")

    def test_audio_entry_point_falls_back_to_the_local_engine(self) -> None:
        self._install(OTHER_PROTOCOL_PLUGIN)
        audio = np.zeros(LIVE_SAMPLE_RATE_HZ, dtype=np.float32)
        with mock.patch.object(
            transcribe_module, "_model", side_effect=RuntimeError("local engine used")
        ):
            with self.assertRaisesRegex(RuntimeError, "local engine used"):
                transcribe_module.transcribe_audio(audio, "small")

    def test_gigaam_ids_never_reach_the_plugin(self) -> None:
        self._install(GOOD_PLUGIN)
        with mock.patch(
            "backend.transcribe_gigaam.transcribe_gigaam",
            return_value={"language": "ru", "language_probability": 0.0, "duration": 1.0, "segments": [], "text": ""},
        ) as gigaam:
            result = transcribe_module.transcribe_file(self.wav_path, "gigaam-v3-e2e-rnnt")
        self.assertEqual(result["text"], "")
        self.assertTrue(gigaam.called)


if __name__ == "__main__":
    unittest.main()
