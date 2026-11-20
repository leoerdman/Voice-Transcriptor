import tempfile
import unittest
import io
import numpy as np
import soundfile as sf
from pathlib import Path
from unittest import mock

from backend.audio import (
    AudioError,
    _compact_audio_chunks_for_remote_cmd,
    _ffmpeg_stderr_has_decode_error,
    _run_ffmpeg,
    compact_audio_chunks_for_remote,
    ensure_wav_16k,
)
from backend.audio_constants import (
    LIVE_PCM_BYTES_PER_SEC,
    LIVE_SAMPLE_RATE_HZ,
    pcm16_bytes_per_sec,
)


class AudioCommandTests(unittest.TestCase):
    def test_remote_compaction_extracts_audio_only_from_video_inputs(self):
        # Pointed at the chunked builder — the only remote-compaction
        # command this backend runs. It used to assert the argv of a
        # single-file counterpart with no production caller at all, so
        # the rule looked covered while the live command was not (B-072).
        cmd = _compact_audio_chunks_for_remote_cmd(
            "/tmp/input.mp4", "/tmp/chunk_%05d.webm", 900
        )

        self.assertEqual(cmd[0], "ffmpeg")
        self.assertIn("-nostdin", cmd)
        self.assertEqual(cmd[cmd.index("-i") + 1], "/tmp/input.mp4")
        self.assertEqual(cmd[cmd.index("-map") + 1], "0:a:0")
        self.assertIn("-vn", cmd)
        self.assertIn("-sn", cmd)
        self.assertIn("-dn", cmd)
        self.assertEqual(cmd[cmd.index("-map_metadata") + 1], "-1")
        self.assertEqual(cmd[cmd.index("-ar") + 1], str(LIVE_SAMPLE_RATE_HZ))
        self.assertEqual(cmd[cmd.index("-ac") + 1], "1")
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "libopus")
        self.assertEqual(cmd[cmd.index("-f") + 1], "segment")
        self.assertEqual(cmd[-1], "/tmp/chunk_%05d.webm")

    def test_remote_compaction_command_has_no_video_encoder(self):
        cmd = _compact_audio_chunks_for_remote_cmd(
            "/tmp/input.mov", "/tmp/chunk_%05d.webm", 900
        )

        self.assertNotIn("-c:v", cmd)
        self.assertNotIn("-vcodec", cmd)

    def test_remote_chunk_compaction_segments_audio_only(self):
        cmd = _compact_audio_chunks_for_remote_cmd(
            "/tmp/input.mp4",
            "/tmp/chunk_%05d.webm",
            900,
        )

        self.assertEqual(cmd[0], "ffmpeg")
        self.assertIn("-nostdin", cmd)
        self.assertEqual(cmd[cmd.index("-i") + 1], "/tmp/input.mp4")
        self.assertEqual(cmd[cmd.index("-map") + 1], "0:a:0")
        self.assertIn("-vn", cmd)
        self.assertIn("-sn", cmd)
        self.assertIn("-dn", cmd)
        self.assertEqual(cmd[cmd.index("-ar") + 1], str(LIVE_SAMPLE_RATE_HZ))
        self.assertEqual(cmd[cmd.index("-ac") + 1], "1")
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "libopus")
        self.assertEqual(cmd[cmd.index("-f") + 1], "segment")
        self.assertEqual(cmd[cmd.index("-segment_time") + 1], "900")
        self.assertEqual(cmd[cmd.index("-segment_format") + 1], "webm")
        self.assertEqual(cmd[-1], "/tmp/chunk_%05d.webm")

    def test_remote_chunk_compaction_rejects_empty_ffmpeg_output(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch("backend.audio._has_ffmpeg", return_value=True), \
                 mock.patch("backend.audio._run_ffmpeg", return_value=None):
                with self.assertRaisesRegex(AudioError, "no audio chunks"):
                    compact_audio_chunks_for_remote(
                        "/tmp/input.mp4",
                        td,
                        chunk_sec=900,
                    )

    def test_ffmpeg_decode_error_stderr_is_detected_even_when_rc_is_zero(self):
        stderr = (
            "[mov,mp4,m4a,3gp,3g2,mj2] stream 0, offset 0x40013a: partial file\n"
            "[aac] decode_band_types: Input buffer exhausted before END element found\n"
            "Error submitting packet to decoder: Invalid data found when processing input"
        )

        self.assertTrue(_ffmpeg_stderr_has_decode_error(stderr))

    def test_run_ffmpeg_fails_on_decode_error_stderr_even_when_rc_is_zero(self):
        proc = mock.Mock()
        proc.stderr = io.StringIO(
            "stream 0, offset 0x40013a: partial file\n"
            "Error submitting packet to decoder: Invalid data found when processing input\n"
        )
        proc.returncode = 0
        proc.wait.return_value = None

        with mock.patch("backend.audio.subprocess.Popen", return_value=proc):
            with self.assertRaisesRegex(AudioError, "decoded only part"):
                _run_ffmpeg(["ffmpeg", "-i", "broken.m4a", "out.wav"], timeout_sec=1, fail_on_decode_error=True)

    def test_remote_chunk_compaction_enables_decode_error_failure(self):
        with tempfile.TemporaryDirectory() as td:
            def fake_run_ffmpeg(_cmd, **kwargs):
                self.assertTrue(kwargs.get("fail_on_decode_error"))
                Path(td, "chunk_00000.webm").write_bytes(b"ok")

            with mock.patch("backend.audio._has_ffmpeg", return_value=True), \
                 mock.patch("backend.audio._run_ffmpeg", side_effect=fake_run_ffmpeg):
                chunks = compact_audio_chunks_for_remote(
                    "/tmp/input.mp4",
                    td,
                    chunk_sec=900,
                )

        self.assertEqual(len(chunks), 1)

    def test_local_wav_conversion_enables_decode_error_failure(self):
        calls = []

        def fake_run_ffmpeg(_cmd, **kwargs):
            calls.append(kwargs)

        with tempfile.TemporaryDirectory() as td:
            mono_out = str(Path(td) / "mono.wav")
            stereo_out = str(Path(td) / "stereo.wav")
            with mock.patch("backend.audio._has_ffmpeg", return_value=True), \
                 mock.patch("backend.audio._run_ffmpeg", side_effect=fake_run_ffmpeg):
                ensure_wav_16k("/tmp/input.m4a", mono_out, channels=1)
                ensure_wav_16k("/tmp/input.m4a", stereo_out, channels=None)

        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call.get("fail_on_decode_error") for call in calls))

    def test_no_ffmpeg_fallback_rejects_non_pcm16_wav_instead_of_copying(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "float.wav"
            dst = Path(td) / "out.wav"
            sf.write(
                src,
                np.zeros((LIVE_SAMPLE_RATE_HZ, 1), dtype=np.float32),
                LIVE_SAMPLE_RATE_HZ,
                subtype="FLOAT",
            )

            with mock.patch("backend.audio._has_ffmpeg", return_value=False):
                with self.assertRaisesRegex(AudioError, "PCM_16"):
                    ensure_wav_16k(str(src), str(dst), channels=1)

            self.assertFalse(dst.exists())

    def test_no_ffmpeg_preserve_channels_rejects_non_pcm16_wav(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "float-stereo.wav"
            dst = Path(td) / "out.wav"
            sf.write(
                src,
                np.zeros((LIVE_SAMPLE_RATE_HZ, 2), dtype=np.float32),
                LIVE_SAMPLE_RATE_HZ,
                subtype="FLOAT",
            )

            with mock.patch("backend.audio._has_ffmpeg", return_value=False):
                with self.assertRaisesRegex(AudioError, "PCM_16"):
                    ensure_wav_16k(str(src), str(dst), channels=None)

            self.assertFalse(dst.exists())




class PcmBytesPerSecondTests(unittest.TestCase):
    """One conversion from PCM bytes to seconds (B-026).

    ``audio_constants``'s own docstring forbids the form this replaces:
    "the bytes/sec value (16000 x 2 = 32000) ... appeared at four
    different sites in main.py alone". The constant it introduced was
    imported and used once while the expression came back to all four,
    plus a fifth site that needs an arbitrary rate.
    """

    def test_the_constant_is_the_helper_at_the_live_rate(self):
        self.assertEqual(
            LIVE_PCM_BYTES_PER_SEC, pcm16_bytes_per_sec(LIVE_SAMPLE_RATE_HZ)
        )

    def test_an_arbitrary_rate_is_two_bytes_a_sample(self):
        self.assertEqual(pcm16_bytes_per_sec(8000), 16000)
        self.assertEqual(pcm16_bytes_per_sec(48000), 96000)

    def test_a_nonsense_rate_never_divides_by_zero(self):
        # This feeds a division in ``_streamed_seconds``; a config that
        # somehow carried 0 must not take the stop down with it.
        self.assertEqual(pcm16_bytes_per_sec(0), 2)
        self.assertEqual(pcm16_bytes_per_sec(-5), 2)

    def test_the_expression_is_no_longer_written_out_by_hand(self):
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parents[1]
        offenders = []
        for path in sorted(root.glob("*.py")):
            text = path.read_text(encoding="utf-8")
            if re.search(r"2 \* LIVE_SAMPLE_RATE_HZ|2 \* max\(1, int\(", text):
                offenders.append(path.name)
        self.assertEqual(offenders, [])


class FfmpegStdinTests(unittest.TestCase):
    """No ffmpeg this backend starts may read the parent's stdin (B-014).

    ffmpeg reads its interactive console from stdin. Inherited, that is
    the stdio channel Electron uses to talk to this backend, and a
    backgrounded process reading an inherited terminal takes SIGTTIN on
    POSIX. ``-nostdin`` was on the two remote-compaction commands and
    missing from the two conversion commands every LOCAL transcription
    runs — so the rule was stated by the tests above and applied to half
    the callers.
    """

    def test_every_ffmpeg_process_is_started_with_stdin_closed(self):
        from unittest import mock

        import backend.audio as audio_mod

        captured = {}

        class _Proc:
            stderr = io.StringIO("")
            returncode = 0

            def wait(self, timeout=None):
                return 0

            def poll(self):
                return 0

            def kill(self):
                pass

        def _fake_popen(cmd, **kwargs):
            captured.update(kwargs)
            return _Proc()

        with mock.patch.object(audio_mod.subprocess, "Popen", _fake_popen):
            audio_mod._run_ffmpeg(["ffmpeg", "-i", "a", "b"], timeout_sec=1)

        self.assertEqual(
            captured.get("stdin"),
            audio_mod.subprocess.DEVNULL,
            "ffmpeg inherited the backend's stdin",
        )

    def test_the_conversion_commands_carry_the_flag_too(self):
        # Belt and braces beside the Popen setting, and the form the two
        # remote commands already assert.
        import inspect

        import backend.audio as audio_mod

        for channels in (1, None):
            with self.subTest(channels=channels):
                self.assertIn("-nostdin", audio_mod._wav16k_cmd("in.m4a", "out.wav", channels))


class ConversionTimeoutTests(unittest.TestCase):
    def test_the_local_conversion_ceiling_is_named_once(self):
        # It was the literal 300 in two calls, beside a NAMED ceiling for
        # the remote path — so changing one left the other behind.
        import inspect

        import backend.audio as audio_mod

        self.assertEqual(audio_mod._LOCAL_CONVERT_TIMEOUT_SEC, 300)
        for fn in (audio_mod.ensure_wav_16k,):
            with self.subTest(fn=fn.__name__):
                src = inspect.getsource(fn)
                self.assertIn("_LOCAL_CONVERT_TIMEOUT_SEC", src)
                self.assertNotIn("timeout_sec=300", src)


class OneConversionTests(unittest.TestCase):
    """BM-14: the mono and the channel-preserving conversion are one
    function with one argv, and both read the FIRST audio track."""

    def test_both_paths_map_the_first_audio_track(self):
        import backend.audio as audio_mod

        argvs = []
        with tempfile.TemporaryDirectory() as td, \
                mock.patch("backend.audio._has_ffmpeg", return_value=True), \
                mock.patch("backend.audio._run_ffmpeg", side_effect=lambda cmd, **kw: argvs.append(cmd)):
            audio_mod.ensure_wav_16k("/tmp/talk.mp4", str(Path(td) / "m.wav"), channels=1)
            audio_mod.ensure_wav_16k("/tmp/talk.mp4", str(Path(td) / "s.wav"), channels=None)
        for argv in argvs:
            self.assertEqual(argv[argv.index("-map") + 1], "0:a:0")
            self.assertIn("-vn", argv)
        self.assertIn("-ac", argvs[0])
        self.assertNotIn("-ac", argvs[1])


class FfmpegMissingIsATypeTests(unittest.TestCase):
    """BM-13: "ffmpeg is missing" is decided on a type, not on prose."""

    def test_missing_ffmpeg_raises_its_own_type(self):
        from backend.audio import FfmpegMissingError

        with tempfile.TemporaryDirectory() as td, \
                mock.patch("backend.audio._has_ffmpeg", return_value=False):
            with self.assertRaises(FfmpegMissingError):
                ensure_wav_16k("/tmp/talk.m4a", str(Path(td) / "o.wav"))
            with self.assertRaises(FfmpegMissingError):
                compact_audio_chunks_for_remote("/tmp/talk.m4a", td, chunk_sec=900)


if __name__ == "__main__":
    unittest.main()
