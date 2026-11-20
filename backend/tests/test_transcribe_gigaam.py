"""GigaAM engine dispatch and chunking, with the upstream package faked.

The real ``gigaam`` package (torch + ~1 GB weights) cannot run in CI;
these tests inject a minimal stand-in module into ``sys.modules`` and
verify the parts we own: id mapping, ≤25 s chunking, absolute-time word
stitching, temp-file hygiene, and catalog/dispatch wiring.
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

import numpy as np

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.model_catalog import (
    GIGAAM_MODELS,
    GIGAAM_MODEL_PREFIX,
    LOCAL_TRANSCRIPTION_MODELS,
)


class _FakeWords:
    def __init__(self, items):
        self._items = items

    def __bool__(self):
        return bool(self._items)

    def __iter__(self):
        return iter(self._items)


class _FakeWord:
    def __init__(self, start: float, end: float, text: str):
        self.start = start
        self.end = end
        self.text = text


class _FakeResult:
    def __init__(self, text: str, words):
        self.text = text
        self.words = _FakeWords(words)


class _FakeModel:
    def __init__(self, calls: list):
        self._calls = calls

    def transcribe(self, path, word_timestamps=True):
        self._calls.append(path)
        # Deterministic per-call payload; the caller slices audio, so we
        # just echo one word per invocation.
        n = len(self._calls)
        return _FakeResult(
            f"слово{n}",
            [_FakeWord(0.1, 0.5, f"слово{n}")],
        )


def _install_fake_gigaam(monkeypatched_calls: list, model=None) -> None:
    fake_pkg = types.ModuleType("gigaam")

    def load_model(name):
        assert name in ("v3_e2e_rnnt", "v3_rnnt"), name
        return model if model is not None else _FakeModel(monkeypatched_calls)

    fake_pkg.load_model = load_model  # type: ignore[attr-defined]
    sys.modules.setdefault("gigaam", fake_pkg)


class _ScriptedModel:
    """Returns a preprogrammed result per transcribe() call."""

    def __init__(self, results: list):
        self._results = results
        self.calls: list = []

    def transcribe(self, path, word_timestamps=True):
        self.calls.append(path)
        idx = len(self.calls) - 1
        if idx >= len(self._results):
            return _FakeResult("", [])
        return self._results[idx]


class GigaAMChunkStitchTests(unittest.TestCase):
    """Overlapped chunks must stitch without duplicated or truncated
    boundary words (BUG-28)."""

    def setUp(self):
        self._prev = sys.modules.get("gigaam")

    def tearDown(self):
        if self._prev is None:
            sys.modules.pop("gigaam", None)
        else:
            sys.modules["gigaam"] = self._prev
        from backend import transcribe_gigaam

        transcribe_gigaam._MODEL_CACHE.clear()

    def _install(self, model):
        sys.modules.pop("gigaam", None)
        _install_fake_gigaam([], model=model)
        # setdefault above may keep a pre-existing module; force ours.
        sys.modules["gigaam"].load_model = lambda name: model  # type: ignore[attr-defined]
        from backend import transcribe_gigaam

        transcribe_gigaam._MODEL_CACHE.clear()

    def _scripted_results(self):
        # 50 s audio → chunks [0,20], [18.8,38.8], [37.6,50]. Word times
        # are chunk-relative, exactly like upstream returns them.
        return [
            _FakeResult("привет ми", [
                _FakeWord(1.0, 1.5, "привет"),
                _FakeWord(19.6, 20.0, "ми"),        # truncated at the cut
            ]),
            _FakeResult("мир как де", [
                _FakeWord(0.8, 1.6, "мир"),          # abs 19.6-20.4, full
                _FakeWord(2.2, 2.7, " как"),         # abs 21.0-21.5
                _FakeWord(19.6, 20.0, "де"),         # abs 38.4-38.8, cut
            ]),
            _FakeResult("дела конец", [
                _FakeWord(0.8, 1.4, " дела"),        # abs 38.4-39.0, full
                _FakeWord(7.4, 7.9, " конец"),       # abs 45.0-45.5
            ]),
        ]

    def test_boundary_words_dedupe_to_full_copies(self):
        from backend.transcribe import transcribe_audio

        self._install(_ScriptedModel(self._scripted_results()))
        audio = np.zeros(int(50.0 * LIVE_SAMPLE_RATE_HZ), dtype=np.float32)
        out = transcribe_audio(audio, "gigaam-v3-e2e-rnnt", word_timestamps=True)
        self.assertEqual(out["text"], "привет мир как дела конец")
        words = [w["word"].strip() for seg in out["segments"] for w in seg["words"]]
        self.assertEqual(words, ["привет", "мир", "как", "дела", "конец"])
        # The full copy won over the truncated fragment at each boundary.
        мир = [w for seg in out["segments"] for w in seg["words"]
               if w["word"].strip() == "мир"][0]
        self.assertAlmostEqual(мир["end"] - мир["start"], 0.8, places=6)
        дела = [w for seg in out["segments"] for w in seg["words"]
                if w["word"].strip() == "дела"][0]
        self.assertAlmostEqual(дела["end"] - дела["start"], 0.6, places=6)

    def test_text_only_mode_still_stitches_clean_text(self):
        from backend.transcribe import transcribe_audio

        self._install(_ScriptedModel(self._scripted_results()))
        audio = np.zeros(int(50.0 * LIVE_SAMPLE_RATE_HZ), dtype=np.float32)
        out = transcribe_audio(audio, "gigaam-v3-e2e-rnnt", word_timestamps=False)
        self.assertEqual(out["text"], "привет мир как дела конец")
        for seg in out["segments"]:
            self.assertNotIn("words", seg)

    def test_touching_words_are_not_deduped(self):
        from backend.transcribe_gigaam import _merge_overlapping_words

        a = {"word": "раз", "start": 1.0, "end": 1.5, "_chunk": 0}
        b = {"word": " два", "start": 1.5, "end": 2.0, "_chunk": 0}
        merged = _merge_overlapping_words([[a, b]])
        self.assertEqual([w["word"] for w in merged], ["раз", " два"])


class GigaAMDispatchTests(unittest.TestCase):
    def setUp(self):
        self._calls: list = []
        self._prev = sys.modules.get("gigaam")
        _install_fake_gigaam(self._calls)

    def tearDown(self):
        if self._prev is None:
            sys.modules.pop("gigaam", None)
        else:
            sys.modules["gigaam"] = self._prev
        from backend import transcribe_gigaam

        transcribe_gigaam._MODEL_CACHE.clear()

    def test_catalog_contains_gigaam_ids_with_prefix(self):
        gigaam_ids = [m for m in LOCAL_TRANSCRIPTION_MODELS if m.startswith(GIGAAM_MODEL_PREFIX)]
        # The prefix is the dispatch key, so every GigaAM entry must carry
        # it — asserted over whatever the catalog offers rather than a
        # hardcoded list, which is what broke when the line was cut to one
        # variant.
        self.assertTrue(gigaam_ids)
        self.assertEqual(gigaam_ids, list(GIGAAM_MODELS))
        # The end-to-end head is the one a dictation app wants: it emits
        # punctuated, normalised text. Plain `rnnt` returns lowercase with
        # no punctuation and exists for WER scoring.
        self.assertIn("gigaam-v3-e2e-rnnt", gigaam_ids)

    def test_dispatch_produces_absolute_time_segments(self):
        from backend.transcribe import transcribe_audio

        audio = np.zeros(int(3.0 * LIVE_SAMPLE_RATE_HZ), dtype=np.float32)
        out = transcribe_audio(audio, "gigaam-v3-e2e-rnnt", word_timestamps=True)
        self.assertEqual(out["language"], "ru")
        self.assertEqual(len(out["segments"]), 1)
        seg = out["segments"][0]
        self.assertEqual(seg["text"], "слово1")
        self.assertEqual(seg["words"][0]["word"], "слово1")
        self.assertGreaterEqual(seg["words"][0]["start"], 0.0)

    def test_long_audio_is_chunked_under_the_25s_upstream_limit(self):
        from backend.transcribe_gigaam import (
            GIGAAM_CHUNK_OVERLAP_SEC,
            _chunk_bounds,
        )

        bounds = _chunk_bounds(68.9)
        for start, end in bounds:
            self.assertLessEqual(end - start, 20.0 + 1e-6)
        # Overlapped coverage: starts at zero, ends at the total, every
        # step makes forward progress, neighbours share the overlap.
        self.assertEqual(bounds[0][0], 0.0)
        self.assertAlmostEqual(bounds[-1][1], 68.9, places=6)
        for (s1, e1), (s2, e2) in zip(bounds, bounds[1:]):
            self.assertAlmostEqual(e1 - s2, GIGAAM_CHUNK_OVERLAP_SEC, places=6)
            self.assertGreater(s2, s1)

        from backend.transcribe import transcribe_audio

        audio = np.zeros(int(45.0 * LIVE_SAMPLE_RATE_HZ), dtype=np.float32)
        out = transcribe_audio(audio, "gigaam-v3-rnnt")
        self.assertEqual(len(out["segments"]), 3)
        starts = [s["start"] for s in out["segments"]]
        self.assertEqual(starts, sorted(starts))
        # Chunks now overlap (BUG-28): [0,20], [18.8,38.8], [37.6,45];
        # the echoed word of each chunk sits 0.1 s into its chunk.
        self.assertAlmostEqual(starts[1], 18.9, places=6)
        self.assertAlmostEqual(starts[2], 37.7, places=6)

    def test_unavailable_engine_reports_reason_not_crash(self):
        # Forced, not hoped for. Popping ``sys.modules`` does not stop an
        # import from disk, so on a machine WITH the package installed
        # this asked ``assertIsInstance(None, str)`` and failed; on a
        # machine without it, an empty string would have satisfied
        # "reports a reason". ``{"gigaam": None}`` makes the import
        # raise, which is the state under test.
        from unittest import mock as _mock

        from backend import transcribe_gigaam

        with _mock.patch.dict(sys.modules, {"gigaam": None}):
            reason = transcribe_gigaam.gigaam_import_error()
        self.assertIsInstance(reason, str)
        self.assertTrue(reason.strip(), "no reason was reported")
        self.assertIn("Error", reason)

    def test_an_available_engine_reports_no_reason(self):
        from unittest import mock as _mock

        from backend import transcribe_gigaam

        with _mock.patch.dict(sys.modules, {"gigaam": _mock.Mock()}):
            self.assertIsNone(transcribe_gigaam.gigaam_import_error())


class GigaAMWordConventionTests(unittest.TestCase):
    """The adapter must emit faster-whisper's word-spacing shape.

    live.py reconstructs trimmed segment text by plain concatenation,
    which is only correct when every non-first token carries a LEADING
    space (upstream GigaAM strips token text — BUG-26).
    """

    def setUp(self):
        self._prev = sys.modules.get("gigaam")
        self._calls: list = []
        _install_fake_gigaam(self._calls)
        from backend import transcribe_gigaam

        transcribe_gigaam._MODEL_CACHE.clear()

    def tearDown(self):
        if self._prev is None:
            sys.modules.pop("gigaam", None)
        else:
            sys.modules["gigaam"] = self._prev
        from backend import transcribe_gigaam

        transcribe_gigaam._MODEL_CACHE.clear()

    def test_words_follow_whisper_leading_space_convention(self):
        from backend.transcribe_gigaam import _words_from_result

        result = _FakeResult(
            "привет как дела",
            [
                _FakeWord(0.0, 0.5, "привет"),
                _FakeWord(0.5, 0.9, " как"),
                _FakeWord(0.9, 1.4, " дела"),
            ],
        )
        words = _words_from_result(result, offset=10.0)
        self.assertEqual(
            [w["word"] for w in words],
            ["привет", " как", " дела"],
        )
        # Upstream text arrives pre-spaced (" как"); after strip() the
        # adapter re-adds the leading space itself — concatenation-safe.
        self.assertEqual("".join(w["word"] for w in words), "привет как дела")

    def test_result_carries_full_transcribe_audio_shape(self):
        from backend.transcribe import transcribe_audio

        audio = np.zeros(int(2.0 * LIVE_SAMPLE_RATE_HZ), dtype=np.float32)
        out = transcribe_audio(audio, "gigaam-v3-e2e-rnnt", word_timestamps=True)
        # BUG-38: sync route and jobs read result["text"] and
        # language_probability directly — the adapter must not drop them.
        self.assertIn("text", out)
        self.assertIn("language_probability", out)
        self.assertEqual(out["text"], "слово1")
        self.assertEqual(out["language_probability"], 1.0)

    def test_empty_audio_early_return_keeps_full_contract(self):
        # BUG-48: the zero-length shortcut must satisfy the same result
        # contract as the normal path — callers read text and
        # language_probability unconditionally.
        from backend.transcribe import transcribe_audio

        out = transcribe_audio(
            np.zeros(0, dtype=np.float32), "gigaam-v3-e2e-rnnt"
        )
        self.assertEqual(out["segments"], [])
        self.assertEqual(out["text"], "")
        self.assertEqual(out["language_probability"], 1.0)
        self.assertEqual(out["duration"], 0.0)


class GigaAMCacheTests(unittest.TestCase):
    """BUG-47: torch weights are ~GB each — the cache must evict LRU."""

    def setUp(self):
        self._prev = sys.modules.get("gigaam")
        _install_fake_gigaam([])
        from backend import transcribe_gigaam

        self._mod = transcribe_gigaam
        self._saved_cap = transcribe_gigaam._GIGAAM_CACHE_MAX
        transcribe_gigaam._MODEL_CACHE.clear()
        transcribe_gigaam._GIGAAM_CACHE_MAX = 1

    def tearDown(self):
        self._mod._GIGAAM_CACHE_MAX = self._saved_cap
        self._mod._MODEL_CACHE.clear()
        if self._prev is None:
            sys.modules.pop("gigaam", None)
        else:
            sys.modules["gigaam"] = self._prev

    def test_cache_evicts_lru_entry_beyond_cap(self):
        self._mod._load_model("gigaam-v3-e2e-rnnt")
        self._mod._load_model("gigaam-v3-rnnt")
        self.assertEqual(list(self._mod._MODEL_CACHE), ["gigaam-v3-rnnt"])
        # A hit re-promotes: touching e2e again then loading rnnt must
        # evict rnnt (the new LRU tail), not the just-used e2e.
        self._mod._load_model("gigaam-v3-e2e-rnnt")
        self._mod._load_model("gigaam-v3-rnnt")
        self.assertEqual(list(self._mod._MODEL_CACHE), ["gigaam-v3-rnnt"])


class GigaAMFileDispatchTests(unittest.TestCase):
    """transcribe_file / warm_model must route gigaam ids to the adapter.

    File jobs, sync transcribe and re-transcribe accept every catalog id
    (ALLOWED_LOCAL_MODELS ⊇ gigaam ids), so a gigaam id reaching
    WhisperModel is a confusing crash (BUG-24/BUG-25).
    """

    def setUp(self):
        self._prev = sys.modules.get("gigaam")
        self._calls: list = []
        _install_fake_gigaam(self._calls)
        from backend import transcribe_gigaam

        transcribe_gigaam._MODEL_CACHE.clear()

    def tearDown(self):
        if self._prev is None:
            sys.modules.pop("gigaam", None)
        else:
            sys.modules["gigaam"] = self._prev
        from backend import transcribe_gigaam

        transcribe_gigaam._MODEL_CACHE.clear()

    def _write_wav(self, directory, rate=LIVE_SAMPLE_RATE_HZ, seconds=0.5):
        import soundfile as sf

        path = os.path.join(directory, f"clip-{rate}.wav")
        tone = 0.05 * np.sin(
            2.0 * np.pi * 220.0 * np.arange(int(seconds * rate)) / rate
        ).astype(np.float32)
        sf.write(path, tone, rate, subtype="PCM_16")
        return path

    def test_transcribe_file_dispatches_gigaam_without_whisper_model(self):
        import tempfile

        from backend import transcribe
        from backend.transcribe import transcribe_file

        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_wav(tmp)
            with mock.patch.object(
                transcribe, "_model",
                side_effect=AssertionError("WhisperModel must not load for gigaam ids"),
            ):
                out = transcribe_file(path, "gigaam-v3-e2e-rnnt", word_timestamps=True)
        self.assertEqual(out["text"], "слово1")
        self.assertEqual(out["segments"][0]["words"][0]["word"], "слово1")

    def test_transcribe_file_gigaam_rejects_off_contract_sample_rate(self):
        import tempfile

        from backend.transcribe import transcribe_file

        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_wav(tmp, rate=48_000)
            with self.assertRaises(ValueError):
                transcribe_file(path, "gigaam-v3-rnnt")

    def test_warm_model_dispatches_gigaam_without_whisper_model(self):
        from backend import transcribe
        from backend.transcribe import warm_model

        with mock.patch.object(
            transcribe, "_model",
            side_effect=AssertionError("WhisperModel must not load for gigaam ids"),
        ):
            stats = warm_model("gigaam-v3-e2e-rnnt")
        self.assertIn("loaded_ms", stats)
        self.assertGreaterEqual(stats["loaded_ms"], 0)


class SampleRateAndThresholdSsotTests(unittest.TestCase):
    """16000 and 64 are named, once each (B-034, B-036).

    ``audio_constants``'s docstring names duplicated sample rates as the
    reason that module exists; the GigaAM adapter wrote 16000 out four
    times while its own caller validated the input against the constant.
    The "too small to decode" threshold was a bare 64 in two places, and
    in one of them it was asked AFTER the model load — so a 12-byte WAV
    paid a multi-second, up-to-3 GB model load to be told it was empty.
    """

    def test_the_adapter_writes_wavs_at_the_shared_rate(self):
        import inspect

        import backend.transcribe_gigaam as gigaam
        from backend.audio_constants import LIVE_SAMPLE_RATE_HZ

        self.assertIs(gigaam.LIVE_SAMPLE_RATE_HZ, LIVE_SAMPLE_RATE_HZ)
        source = inspect.getsource(gigaam)
        self.assertNotIn("16000", source, "the rate is written out by hand")

    def test_the_undecodable_threshold_is_named_once(self):
        import inspect

        from backend import transcribe

        self.assertEqual(transcribe._MIN_DECODABLE_WAV_BYTES, 64)
        source = inspect.getsource(transcribe)
        self.assertNotIn("<= 64", source)

    def test_a_tiny_wav_is_refused_before_any_model_is_loaded(self):
        import tempfile
        from pathlib import Path
        from unittest import mock

        from backend import transcribe

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "tiny.wav"
            path.write_bytes(b"RIFF" + b"\x00" * 8)
            with mock.patch.object(
                transcribe, "_model", side_effect=AssertionError("model loaded")
            ):
                out = transcribe.transcribe_file(str(path), "small")
        self.assertEqual(out["text"], "")
        self.assertEqual(out["segments"], [])

    def test_the_empty_result_reports_the_files_real_duration(self):
        # Both file entry points hard-coded 0.0 while ``transcribe_audio``
        # computed it, so the same empty recognition described a
        # different recording depending on which door it came through.
        import tempfile
        from pathlib import Path

        from backend import transcribe
        from backend.audio_constants import LIVE_PCM_BYTES_PER_SEC

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "tiny.wav"
            payload = b"\x00" * 64
            path.write_bytes(payload)
            out = transcribe.transcribe_file(str(path), "small")
        self.assertAlmostEqual(
            out["duration"], len(payload) / float(LIVE_PCM_BYTES_PER_SEC), places=6
        )

    def test_a_gigaam_id_is_also_refused_before_the_engine_is_reached(self):
        import tempfile
        from pathlib import Path

        from backend import transcribe

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "tiny.wav"
            path.write_bytes(b"RIFF")
            out = transcribe.transcribe_file(str(path), "gigaam-v3-rnnt")
        self.assertEqual(out["text"], "")


class EnginePrefixSsotTests(unittest.TestCase):
    """The engine prefix is a constant, not a literal (B-035)."""

    def test_models_manager_reads_the_catalog_prefix(self):
        import inspect

        import backend.models_manager as mm
        from backend.model_catalog import GIGAAM_MODEL_PREFIX

        self.assertIs(mm.GIGAAM_MODEL_PREFIX, GIGAAM_MODEL_PREFIX)
        source = inspect.getsource(mm)
        self.assertNotIn('startswith("gigaam-")', source)

    def test_it_no_longer_imports_a_name_it_does_not_use(self):
        import inspect

        import backend.models_manager as mm

        source = inspect.getsource(mm)
        self.assertNotIn("GIGAAM_MODELS", source)


class GigaAMUnreachableHostTests(unittest.TestCase):
    """BL-11: a load that failed because the checkpoint host was out of
    reach is not retried on every warm-up trigger."""

    def setUp(self):
        import ssl
        import urllib.error

        from backend import transcribe_gigaam

        self._mod = transcribe_gigaam
        self._prev = sys.modules.get("gigaam")
        self.calls = 0
        self.error: BaseException = urllib.error.URLError(
            ssl.SSLCertVerificationError("certificate verify failed: certificate has expired")
        )

        def load_model(name):
            self.calls += 1
            raise self.error

        fake = types.ModuleType("gigaam")
        fake.load_model = load_model  # type: ignore[attr-defined]
        self.addCleanup(self._restore_gigaam)
        sys.modules["gigaam"] = fake
        self.clock = [1000.0]
        self._saved_memory = transcribe_gigaam._UNREACHABLE
        transcribe_gigaam._UNREACHABLE = transcribe_gigaam._UnreachableMemory(
            600, clock=lambda: self.clock[0]
        )
        transcribe_gigaam._MODEL_CACHE.clear()

    def tearDown(self):
        self._mod._UNREACHABLE = self._saved_memory
        self._mod._MODEL_CACHE.clear()

    def _restore_gigaam(self):
        if self._prev is None:
            sys.modules.pop("gigaam", None)
        else:
            sys.modules["gigaam"] = self._prev

    def test_an_unreachable_host_is_not_tried_again_until_the_window_passes(self):
        mid = "gigaam-v3-e2e-rnnt"
        with self.assertRaises(OSError):
            self._mod._load_model(mid)
        self.assertEqual(self.calls, 1)
        # The next triggers inside the window do not download again; the
        # refusal is chained to the original transport failure.
        self.clock[0] += 300
        with self.assertRaises(self._mod.GigaamHostUnreachableError) as raised:
            self._mod._load_model(mid)
        self.assertIs(raised.exception.__cause__, self.error)
        self.assertEqual(self.calls, 1)
        # After the window the load is attempted again.
        self.clock[0] += 301
        with self.assertRaises(OSError):
            self._mod._load_model(mid)
        self.assertEqual(self.calls, 2)

    def test_other_failures_are_not_remembered(self):
        import urllib.error

        mid = "gigaam-v3-rnnt"
        for error in (
            RuntimeError("bad checkpoint"),
            urllib.error.HTTPError("https://cdn.example/x", 500, "boom", {}, None),
        ):
            with self.subTest(error=type(error).__name__):
                self.error = error
                before = self.calls
                with self.assertRaises(Exception):
                    self._mod._load_model(mid)
                with self.assertRaises(Exception):
                    self._mod._load_model(mid)
                self.assertEqual(self.calls, before + 2)

    def test_the_backend_reports_the_refusal_as_unreachable_not_as_a_crash(self):
        import importlib
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with mock.patch.dict(os.environ, {
            "TRANSCRIPTOR_DATA_DIR": tmp.name,
            "TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG": "1",
        }):
            for name in ("backend.main", "backend.config", "backend.storage"):
                sys.modules.pop(name, None)
            main = importlib.import_module("backend.main")
        self.addCleanup(lambda: [sys.modules.pop(n, None) for n in ("backend.main", "backend.config", "backend.storage")])
        mid = "gigaam-v3-e2e-rnnt"
        with self.assertRaises(OSError):
            self._mod._load_model(mid)
        with self.assertRaises(self._mod.GigaamHostUnreachableError) as raised:
            self._mod._load_model(mid)
        self.assertTrue(main._is_hub_offline_error(raised.exception))


if __name__ == "__main__":
    unittest.main()
