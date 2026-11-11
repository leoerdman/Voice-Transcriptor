"""The step between a take and a slot, on audio this file writes itself.

No weights here: `decode_take` and `enrol_windows` are arithmetic over a WAV
this test owns, and `enrol_take` takes an embedder that answers with a fixed
vector. The one thing that cannot be faked — CAM++'s opinion of a real voice —
is measured on real takes in the desk log, not in a unit test.
"""

import array
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

from backend.voice_enrol import (
    MAX_WINDOWS,
    EnrolmentError,
    decode_take,
    enrol_take,
    enrol_windows,
)

RATE = 16_000


def pcm(level: int, ms: int) -> bytes:
    """Alternating +/- ``level``: a tone the frame test calls voice."""
    samples = array.array("h", [level if i % 2 else -level for i in range(ms * RATE // 1000)])
    return samples.tobytes()


def write_wav(path: Path, data: bytes) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(data)


class FakeEmbedder:
    """Ducks like ``SpeakerEmbedder`` and answers with one fixed direction."""

    def __init__(self, vector=None):
        raw = np.ones(192, dtype=np.float32) if vector is None else np.asarray(vector, dtype=np.float32)
        self.vector = raw / np.linalg.norm(raw)
        self.calls = 0

    def embed(self, pcm_bytes):
        self.calls += 1
        return self.vector


class DecodeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_a_take_decodes_to_the_bytes_it_was_written_from(self):
        # 16 kHz mono PCM16 is what the app records, so the common case must
        # be a copy — no resampling, no float round trip, no moved sample.
        data = pcm(1200, 500)
        path = self.dir / "take.wav"
        write_wav(path, data)
        self.assertEqual(decode_take(path), data)

    def test_a_take_without_audio_is_refused_by_name(self):
        with self.assertRaises(EnrolmentError):
            decode_take(self.dir / "missing.wav")


class WindowTests(unittest.TestCase):
    def test_a_take_shorter_than_the_window_is_refused(self):
        # §4.1's lower bound is the gate's window; a profile shorter than the
        # thing it will be compared against is a vector of padding.
        with self.assertRaises(EnrolmentError):
            enrol_windows(pcm(1200, 1000))

    def test_every_window_is_the_gates_own_length(self):
        windows = enrol_windows(pcm(1200, 5000))
        self.assertTrue(windows)
        self.assertEqual({len(w) for w in windows}, {2 * RATE * 2}, "2 s of PCM16")

    def test_the_last_window_reaches_the_end_of_the_take(self):
        # Thinning must not quietly drop the last stretch: a take whose owner
        # only speaks at the end is still a take about the owner.
        take = pcm(1200, 5000)
        windows = enrol_windows(take)
        self.assertEqual(windows[0], take[: len(windows[0])])
        self.assertEqual(windows[-1], take[-len(windows[-1]) :])

    def test_a_long_take_is_thinned_across_the_whole_take(self):
        take = pcm(1200, 300_000)
        windows = enrol_windows(take)
        self.assertEqual(len(windows), MAX_WINDOWS, "one press, not one coffee")
        self.assertEqual(windows[0], take[: len(windows[0])])
        self.assertEqual(windows[-1], take[-len(windows[-1]) :])


class EnrolTests(unittest.TestCase):
    def test_only_voiced_windows_reach_the_net(self):
        # A silence window embeds the room, and the mean must not hold the
        # room: half this take is silence and the net must never see it.
        take = pcm(1200, 4000) + bytes(2 * RATE * 4)
        embedder = FakeEmbedder()
        enrol_take(embedder, take, voiced=lambda window: any(window))
        self.assertEqual(embedder.calls, 4, "four 2 s windows of speech at a 1 s hop")

    def test_a_silent_take_is_refused_by_name(self):
        with self.assertRaises(EnrolmentError):
            enrol_take(FakeEmbedder(), bytes(2 * RATE * 4), voiced=lambda window: False)

    def test_the_profile_is_the_unit_mean_of_its_windows(self):
        profile = enrol_take(FakeEmbedder(), pcm(1200, 4000), voiced=lambda window: True)
        self.assertEqual(profile.shape, (192,))
        self.assertAlmostEqual(float(np.linalg.norm(profile)), 1.0, places=5)


if __name__ == "__main__":
    unittest.main()
