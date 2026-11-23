"""Resources this backend holds, and the bounds it claims to hold them by.

Each case is a place where the module had already written down the rule
— "stream it, do not load it"; "the cap is soft, but memory is cheaper
than losing a transcription"; "the registry dict is protected so two
callers never race" — and applied it to everything except one path.
"""

from __future__ import annotations

import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import soundfile as sf

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ


def _stereo_wav(path: Path, seconds: float = 0.5) -> None:
    frames = int(seconds * LIVE_SAMPLE_RATE_HZ)
    sig = np.zeros((frames, 2), dtype=np.float32)
    sig[:, 0] = 0.5
    sig[:, 1] = -0.25
    sf.write(str(path), sig, LIVE_SAMPLE_RATE_HZ, subtype="PCM_16")


class SplitChannelsTests(unittest.TestCase):
    """The split streams instead of loading the whole file (B-060)."""

    def test_the_two_channels_come_out_intact(self):
        from backend.audio import split_channels

        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "stereo.wav"
            _stereo_wav(src)
            ch1, ch2 = split_channels(str(src))
            left, sr1 = sf.read(ch1)
            right, sr2 = sf.read(ch2)

        self.assertEqual((sr1, sr2), (LIVE_SAMPLE_RATE_HZ, LIVE_SAMPLE_RATE_HZ))
        self.assertEqual(len(left), len(right))
        self.assertAlmostEqual(float(left[0]), 0.5, places=3)
        self.assertAlmostEqual(float(right[0]), -0.25, places=3)

    def test_a_mono_file_is_left_alone(self):
        from backend.audio import split_channels

        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "mono.wav"
            sf.write(
                str(src),
                np.zeros((LIVE_SAMPLE_RATE_HZ // 4,), dtype=np.float32),
                LIVE_SAMPLE_RATE_HZ,
                subtype="PCM_16",
            )
            self.assertEqual(split_channels(str(src)), (None, None))

    def test_it_never_materialises_the_whole_file(self):
        # A whole-file ``sf.read`` returns float32 for the entire
        # recording: a two-hour 16 kHz stereo file is 921 MB resident,
        # plus a contiguous copy per channel. Every other path in this
        # module was converted to streaming, with a docstring saying why.
        from backend import audio

        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "stereo.wav"
            _stereo_wav(src)
            with mock.patch.object(
                audio.sf, "read", side_effect=AssertionError("whole file read")
            ):
                audio.split_channels(str(src))

    def test_a_failed_write_leaves_no_temporary_behind(self):
        from backend import audio

        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "stereo.wav"
            _stereo_wav(src)
            real_soundfile = sf.SoundFile
            calls = {"n": 0}

            def flaky(*args, **kwargs):
                calls["n"] += 1
                if calls["n"] >= 3:  # the second output file
                    raise OSError("disk full")
                return real_soundfile(*args, **kwargs)

            with mock.patch.object(audio.sf, "SoundFile", flaky):
                with self.assertRaises(OSError):
                    audio.split_channels(str(src))
            leftovers = sorted(p.name for p in Path(td).glob("*.tmp-*"))
            self.assertEqual(leftovers, [])

    def test_a_wrong_sample_rate_is_refused(self):
        from backend.audio import AudioError, split_channels

        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "wrong.wav"
            sf.write(
                str(src),
                np.zeros((8000, 2), dtype=np.float32),
                8000,
                subtype="PCM_16",
            )
            with self.assertRaises(AudioError):
                split_channels(str(src))


class GigaAmTempFileTests(unittest.TestCase):
    """A temp file that outlives its writer is a leak (B-062)."""

    def test_a_failed_write_removes_the_file_it_created(self):
        import backend.transcribe_gigaam as gigaam

        created: list[Path] = []
        real_write = gigaam.sf.write

        def boom(path, *a, **kw):
            created.append(Path(path))
            raise OSError("no space left on device")

        with mock.patch.object(gigaam.sf, "write", boom):
            with self.assertRaises(OSError):
                gigaam._write_wav(np.zeros((16000,), dtype=np.float32))

        self.assertEqual(len(created), 1)
        self.assertFalse(
            created[0].exists(),
            "the temp WAV survived the failed write, and no sweeper knows its name",
        )
        self.assertIs(gigaam.sf.write, real_write)


class EngineAvailabilityCacheTests(unittest.TestCase):
    """A question with an unchanging answer is asked once (B-064)."""

    def test_find_spec_runs_once_however_often_it_is_asked(self):
        import backend.model_catalog as catalog

        catalog.gigaam_available.cache_clear()
        self.addCleanup(catalog.gigaam_available.cache_clear)
        with mock.patch.object(
            catalog, "find_spec", return_value=None
        ) as find_spec:
            for _ in range(20):
                catalog.gigaam_available()
        # /api/health polls roughly every ten seconds, and find_spec for
        # an absent module walks the whole sys.path before answering.
        self.assertEqual(find_spec.call_count, 1)


class JobStoreCeilingTests(unittest.TestCase):
    """The soft cap has a hard one behind it (B-066)."""

    def _store(self):
        from backend.jobs import JobStore

        store = JobStore(max_jobs=4)
        self.addCleanup(store.shutdown, 0.1)
        return store

    def test_unobserved_terminal_jobs_are_evicted_above_the_ceiling(self):
        store = self._store()
        for i in range(40):
            store.create(f"job-{i}")
            store.set_done(f"job-{i}", {"text": "x"}, [])
        # Nothing ever polled, so nothing is "observed" and the soft cap
        # could evict none of it — each job holding its full result,
        # raw provider payload included, for the life of the process.
        # _prune runs before the insert, so the ceiling is reached
        # plus at most the job being created.
        self.assertLessEqual(len(store._jobs), store.max_jobs * 3 + 1)

    def test_a_running_job_is_never_evicted(self):
        store = self._store()
        store.create("running")
        for i in range(40):
            store.create(f"job-{i}")
            store.set_done(f"job-{i}", {"text": "x"}, [])
        self.assertIsNotNone(store.get("running"))


class PromoteLockRegistryTests(unittest.TestCase):
    """A lock is not removed while somebody is still on it (B-067)."""

    def setUp(self) -> None:
        import importlib
        import sys

        self._tmp = tempfile.TemporaryDirectory()
        self._old = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        os.environ["TRANSCRIPTOR_DATA_DIR"] = self._tmp.name
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")

    def tearDown(self) -> None:
        import sys

        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        if self._old is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old
        self._tmp.cleanup()

    def test_a_second_holder_keeps_the_entry_alive(self):
        first = self.main._acquire_session_promote_lock("s")
        second = self.main._acquire_session_promote_lock("s")
        self.assertIs(first, second)

        self.main._release_session_promote_lock("s")
        # Still one holder: a THIRD caller must get the SAME lock, not a
        # fresh one it can enter the body beside.
        third = self.main._acquire_session_promote_lock("s")
        self.assertIs(third, first)

        self.main._release_session_promote_lock("s")
        self.main._release_session_promote_lock("s")
        self.assertNotIn("s", self.main._live_promote_session_locks)

    def test_the_registry_does_not_grow_without_bound(self):
        for i in range(50):
            self.main._acquire_session_promote_lock(f"s{i}")
            self.main._release_session_promote_lock(f"s{i}")
        self.assertEqual(self.main._live_promote_session_locks, {})

    def test_two_holders_really_do_exclude_each_other(self):
        lock = self.main._acquire_session_promote_lock("s")
        self.addCleanup(self.main._release_session_promote_lock, "s")
        entered = threading.Event()
        released = threading.Event()

        def hold():
            with lock:
                entered.set()
                released.wait(timeout=2)

        t = threading.Thread(target=hold)
        t.start()
        try:
            entered.wait(timeout=2)
            other = self.main._acquire_session_promote_lock("s")
            self.addCleanup(self.main._release_session_promote_lock, "s")
            self.assertFalse(other.acquire(blocking=False))
        finally:
            released.set()
            t.join(timeout=2)


class LegacyMigrationTests(unittest.TestCase):
    """Moving a config without its key moves nothing readable (B-056)."""

    def test_the_encryption_key_travels_with_the_config(self):
        import importlib
        import sys

        with tempfile.TemporaryDirectory() as legacy, \
                tempfile.TemporaryDirectory() as fresh:
            legacy_dir = Path(legacy)
            (legacy_dir / "config.json").write_text("{}", encoding="utf-8")
            from cryptography.fernet import Fernet

            legacy_key = Fernet.generate_key()
            (legacy_dir / ".encryption_key").write_bytes(legacy_key)

            old = os.environ.get("TRANSCRIPTOR_DATA_DIR")
            os.environ["TRANSCRIPTOR_DATA_DIR"] = fresh
            sys.modules.pop("backend.config", None)
            try:
                cfg_mod = importlib.import_module("backend.config")
                with mock.patch.object(cfg_mod, "LEGACY_DATA_DIR", legacy_dir):
                    cfg_mod._migrate_legacy_data()
                self.assertTrue((Path(fresh) / "config.json").exists())
                self.assertEqual(
                    (Path(fresh) / ".encryption_key").read_bytes(),
                    legacy_key,
                    "the config migrated without the key that decrypts it",
                )
                # And the module's live cipher is the legacy one, so the
                # very first read of the migrated config decrypts.
                self.assertEqual(cfg_mod._FERNET_KEY, legacy_key)
            finally:
                sys.modules.pop("backend.config", None)
                if old is None:
                    os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
                else:
                    os.environ["TRANSCRIPTOR_DATA_DIR"] = old


if __name__ == "__main__":
    unittest.main()
