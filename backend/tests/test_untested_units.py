"""The pure helpers nothing was asking about (B-090).

Every function here is small, deterministic and load-bearing, and none
of them had a caller in the test suite:

* ``audio_mime.audio_content_type`` — its whole reason for existing is
  that ``mimetypes.guess_type`` gives provider-hostile answers for the
  formats this app uses most, and two callers put its result in a
  ``Content-Type`` header for Deepgram and OpenRouter. Only the dict's
  KEYS were asserted anywhere, never the values it maps to and never
  the fallback;
* ``http_retry._exponential_backoff`` / ``_parse_retry_after`` — the
  retry ladder and the header a provider uses to tell us how long to
  wait. Only the LOGGING around them was covered;
* ``transcribe``'s result shape and channel merge;
* ``tools/deepgram_live_ab``'s argument parser and row formatter — the
  A/B tool is what measurements in this repo's journals are made with.
"""

from __future__ import annotations

import unittest
from unittest import mock


class AudioContentTypeTests(unittest.TestCase):
    def test_the_formats_this_module_exists_for_get_their_override(self):
        from backend.audio_mime import audio_content_type

        # Python answers video/webm, audio/ogg and (sometimes)
        # audio/mp4a-latm for these three. All three are what the
        # module docstring calls provider-hostile.
        self.assertEqual(audio_content_type("clip.webm"), "audio/webm")
        self.assertEqual(audio_content_type("clip.opus"), "audio/opus")
        self.assertEqual(audio_content_type("clip.m4a"), "audio/mp4")

    def test_every_mapped_extension_round_trips(self):
        from backend.audio_mime import AUDIO_EXT_TO_MIME, audio_content_type

        for ext, mime in AUDIO_EXT_TO_MIME.items():
            with self.subTest(ext=ext):
                self.assertEqual(audio_content_type(f"recording{ext}"), mime)
                self.assertEqual(audio_content_type(f"RECORDING{ext.upper()}"), mime)

    def test_an_unmapped_extension_falls_back(self):
        from backend.audio_mime import audio_content_type

        self.assertEqual(audio_content_type("notes.txt"), "text/plain")

    def test_no_extension_at_all_is_a_byte_stream(self):
        from backend.audio_mime import audio_content_type

        self.assertEqual(audio_content_type("recording"), "application/octet-stream")
        self.assertEqual(audio_content_type(""), "application/octet-stream")


class BackoffTests(unittest.TestCase):
    def test_the_ladder_is_exponential_not_linear(self):
        from backend.http_retry import _exponential_backoff

        # base, 2*base, 4*base — the docstring's own promise, and the
        # thing a previous linear implementation silently broke.
        for attempt, factor in ((0, 1), (1, 2), (2, 4), (3, 8)):
            with self.subTest(attempt=attempt):
                delay = _exponential_backoff(attempt, 0.5)
                self.assertGreaterEqual(delay, 0.5 * factor)
                self.assertLessEqual(delay, 0.5 * factor * 1.1)

    def test_it_adds_jitter_rather_than_a_fixed_wait(self):
        from backend.http_retry import _exponential_backoff

        # Concurrent clients must not synchronise their retry waves.
        delays = {_exponential_backoff(2, 1.0) for _ in range(50)}
        self.assertGreater(len(delays), 1)


class RetryAfterTests(unittest.TestCase):
    def test_delta_seconds_are_taken_as_they_are(self):
        from backend.http_retry import _parse_retry_after

        self.assertEqual(_parse_retry_after("5"), 5.0)
        self.assertEqual(_parse_retry_after(" 12 "), 12.0)

    def test_an_http_date_becomes_the_seconds_until_it(self):
        import datetime as _dt
        from email.utils import format_datetime

        from backend.http_retry import _parse_retry_after

        when = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=30)
        parsed = _parse_retry_after(format_datetime(when))
        self.assertGreater(parsed, 25.0)
        self.assertLess(parsed, 35.0)

    def test_a_date_in_the_past_is_zero_not_negative(self):
        import datetime as _dt
        from email.utils import format_datetime

        from backend.http_retry import _parse_retry_after

        when = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=30)
        self.assertEqual(_parse_retry_after(format_datetime(when)), 0.0)

    def test_missing_or_unparseable_is_zero(self):
        from backend.http_retry import _parse_retry_after

        for raw in (None, "", "   ", "soon", "-1"):
            with self.subTest(raw=raw):
                self.assertEqual(_parse_retry_after(raw), 0.0)


class TranscribeResultShapeTests(unittest.TestCase):
    def test_the_empty_result_has_every_key_a_caller_reads(self):
        from backend.transcribe import _empty_transcribe_result

        out = _empty_transcribe_result(2.5)
        self.assertEqual(
            sorted(out),
            ["duration", "language", "language_probability", "segments", "text"],
        )
        self.assertEqual(out["duration"], 2.5)
        self.assertEqual(out["segments"], [])
        self.assertEqual(out["text"], "")

    def test_the_probe_tone_is_audible_enough_to_pass_a_vad(self):
        # Silence is discarded by ``vad_filter=True`` before the encoder
        # runs, which is the whole reason this is a tone and not zeros.
        from backend.transcribe import _probe_tone
        from backend.audio_constants import LIVE_SAMPLE_RATE_HZ

        tone = _probe_tone(0.25)
        self.assertEqual(tone.shape[0], int(0.25 * LIVE_SAMPLE_RATE_HZ))
        self.assertGreater(float(abs(tone).max()), 0.01)

    def test_channel_transcripts_merge_in_time_order_and_are_labelled(self):
        from backend.transcribe import merge_channel_transcripts

        left = {"segments": [{"start": 0.0, "end": 1.0, "text": "first"}]}
        right = {"segments": [{"start": 0.5, "end": 1.5, "text": "second"}]}
        merged = merge_channel_transcripts(left, right)
        starts = [seg["start"] for seg in merged["segments"]]
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(
            [seg["speaker"] for seg in merged["segments"]], ["A", "B"]
        )
        self.assertEqual(merged["text"], "A: first\nB: second")


class AbToolTests(unittest.TestCase):
    """The A/B tool produces the measurements this repo's journals cite."""

    def test_the_parser_accepts_the_documented_invocation(self):
        from backend.tools.deepgram_live_ab import build_parser

        from backend.model_catalog import DUAL_SECONDARY_LANGUAGE_DEFAULT

        args = build_parser().parse_args(
            ["--language", "multi", "--dual", "--runs", "2", "--full", "/tmp/a.wav"]
        )
        # ``--dual`` with no value means the shipped secondary language,
        # from the same constant the app reads.
        self.assertEqual(args.dual, DUAL_SECONDARY_LANGUAGE_DEFAULT)
        self.assertEqual(args.language, ["multi"])
        self.assertEqual(args.runs, 2)
        self.assertTrue(args.full)
        self.assertEqual(args.wavs, ["/tmp/a.wav"])

    def test_the_parser_requires_a_language(self):
        from backend.tools.deepgram_live_ab import build_parser

        with self.assertRaises(SystemExit):
            build_parser().parse_args(["/tmp/a.wav"])

    def test_dual_is_refused_for_a_configuration_the_app_never_runs(self):
        """BE-25: the app opens a second reading only for a multilingual
        recording; the tool measured ``--language ru --dual`` anyway."""
        import contextlib
        import io

        from backend.tools import deepgram_live_ab as ab

        err = io.StringIO()
        with contextlib.redirect_stderr(err), mock.patch.object(ab, "_load_api_key") as key:
            code = ab.main(["/nonexistent.wav", "--language", "ru", "--dual"])
        self.assertEqual(code, 3)
        self.assertIn("--dual applies only to a multilingual recording", err.getvalue())
        key.assert_not_called()

    def test_a_run_that_raises_still_shuts_its_session_down(self):
        """BE-25: ``shutdown()`` was outside the ``finally``."""
        import asyncio

        from backend.tools import deepgram_live_ab as ab

        class _Session:
            stream_death_sec = None
            shut = False

            async def events(self):
                return
                yield

            async def send_pcm(self, chunk):
                raise RuntimeError("socket died")

            async def shutdown(self, wait_timeout: float = 3.0):
                _Session.shut = True

        acquisition = mock.Mock(session=_Session())
        with mock.patch.object(ab._POOL, "acquire", mock.AsyncMock(return_value=acquisition)):
            with self.assertRaises(RuntimeError):
                asyncio.run(ab._run_one(
                    api_key="k", model="nova-3", pcm=b"\0" * 6400, language="multi",
                    keyterms=(), chunk_ms=100, speed=1000.0, file_label="a.wav",
                    run_index=1,
                ))
        self.assertTrue(_Session.shut)

    def test_dumped_readings_replay_offline_through_the_shipped_merge(self):
        import json
        import tempfile
        from pathlib import Path

        from backend.tools.dual_replay import replay

        word = {"word": "Когда", "start": 1.0, "end": 1.4, "confidence": 0.9}
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "take.multi+ru.run1.json"
            path.write_text(json.dumps({
                "file": "take.wav", "primary_language": "multi", "secondary_language": "ru",
                "primary_segments": [{"start": 1.0, "end": 1.4, "text": "Ir", "words": [
                    {"word": "Ir", "start": 1.0, "end": 1.4, "confidence": 0.5, "language": "lt"}]}],
                "secondary_segments": [{"start": 1.0, "end": 1.4, "text": "Когда", "words": [word]}],
            }), encoding="utf-8")
            out = replay(path, words=True)
        self.assertIn("contested_to_secondary=1", out)
        self.assertIn("\nКогда\n", out)
        self.assertIn("src=ru", out)

    def test_pcm_is_read_as_mono_16k_int16(self):
        import struct
        import tempfile
        import wave
        from pathlib import Path

        from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
        from backend.tools.deepgram_live_ab import _load_pcm16_mono

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "a.wav"
            frames = struct.pack("<8000h", *([1000] * 8000))
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(LIVE_SAMPLE_RATE_HZ)
                wav.writeframes(frames)
            pcm = _load_pcm16_mono(str(path))
        self.assertEqual(len(pcm), len(frames))


if __name__ == "__main__":
    unittest.main()
