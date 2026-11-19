"""The word-side filter, on audio this file writes itself.

`keep_own_segments` asks the take's windows about each segment — the median of a
distribution, not one number — so the fake embedder answers per window by what
the window is made of. CAM++'s opinion of a real voice is measured by the
skill's `assets/solo/probe.py` on real takes, not here.
"""

import array
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

from backend.voice_filter import FOREIGN_BELOW, keep_own_segments, read_pcm

RATE = 16_000
LOUD, QUIET = 1200, 200


def tone(level: int, ms: int) -> bytes:
    samples = array.array("h", [level if i % 2 else -level for i in range(ms * RATE // 1000)])
    return samples.tobytes()


class LevelEmbedder:
    """Own voice for a loud window, a stranger for a quiet one."""

    def __init__(self):
        self.own = np.zeros(192, dtype=np.float32)
        self.own[0] = 1.0
        self.other = np.zeros(192, dtype=np.float32)
        self.other[1] = 1.0

    def embed(self, window):
        first = int.from_bytes(window[:2], "little", signed=True)
        return self.own if abs(first) == LOUD else self.other


class FilterTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "take.wav"
        with wave.open(str(self.path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(RATE)
            out.writeframes(tone(LOUD, 4000) + tone(QUIET, 4000))
        self.pcm = read_pcm(self.path)

    def test_a_take_that_is_not_16k_mono_is_not_guessed_at(self):
        other = Path(self._tmp.name) / "stereo.wav"
        with wave.open(str(other), "wb") as out:
            out.setnchannels(2)
            out.setsampwidth(2)
            out.setframerate(RATE)
            out.writeframes(bytes(4000))
        self.assertIsNone(read_pcm(other))

    def test_the_kept_voice_stays_and_the_stranger_goes(self):
        segments = [
            {"start": 0.0, "end": 4.0, "text": "kept"},
            {"start": 4.0, "end": 8.0, "text": "stranger"},
        ]
        embedder = LevelEmbedder()
        result = keep_own_segments(segments, self.pcm, embedder.own, embedder)
        self.assertEqual([s["text"] for s in result["segments"]], ["kept"])
        self.assertEqual(result["dropped"], 1)

    def test_a_segment_with_no_window_inside_it_is_kept(self):
        # "No" needs evidence: a word shorter than the window has none to give.
        segment = {"start": 7.6, "end": 8.0, "text": "short"}
        embedder = LevelEmbedder()
        result = keep_own_segments([segment], self.pcm, embedder.own, embedder)
        self.assertEqual(result["segments"], [segment])
        self.assertEqual(result["dropped"], 0)

    def test_a_take_shorter_than_the_window_filters_nothing(self):
        short = Path(self._tmp.name) / "short.wav"
        with wave.open(str(short), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(RATE)
            out.writeframes(tone(LOUD, 500))
        segment = {"start": 0.0, "end": 0.5, "text": "short"}
        embedder = LevelEmbedder()
        result = keep_own_segments([segment], read_pcm(short), embedder.own, embedder)
        self.assertEqual(result["segments"], [segment])

    def test_the_floor_is_the_measured_one(self):
        self.assertAlmostEqual(FOREIGN_BELOW, 0.35)


if __name__ == "__main__":
    unittest.main()
