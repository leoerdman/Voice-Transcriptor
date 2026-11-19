"""The word-side filter, on audio this file writes itself.

`keep_own_segments` is arithmetic over a WAV and a fake embedder that answers a
direction per window: what is being tested is the slicing and the decision, not
CAM++'s opinion of a voice, which is measured on real takes by
`assets/solo/probe.py` in the skill's installer.
"""

import array
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

from backend.voice_filter import FOREIGN_BELOW, keep_own_segments, read_pcm

RATE = 16_000


def pcm(level: int, ms: int) -> bytes:
    samples = array.array("h", [level if i % 2 else -level for i in range(ms * RATE // 1000)])
    return samples.tobytes()


class DirectionEmbedder:
    """Answers one unit direction per window, in the order windows arrive."""

    def __init__(self, *directions):
        self.directions = [np.asarray(d, dtype=np.float32) / np.linalg.norm(d) for d in directions]
        self.calls = 0

    def embed(self, _window):
        direction = self.directions[min(self.calls, len(self.directions) - 1)]
        self.calls += 1
        return direction


class FilterTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "take.wav"
        with wave.open(str(self.path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(RATE)
            out.writeframes(pcm(1200, 8000))

    def test_a_take_that_is_not_16k_mono_is_not_guessed_at(self):
        other = Path(self._tmp.name) / "stereo.wav"
        with wave.open(str(other), "wb") as out:
            out.setnchannels(2)
            out.setsampwidth(2)
            out.setframerate(RATE)
            out.writeframes(bytes(4000))
        self.assertIsNone(read_pcm(other))

    def test_the_kept_voice_stays_and_the_stranger_goes(self):
        own = np.zeros(192)
        own[0] = 1.0
        stranger = np.zeros(192)
        stranger[1] = 1.0
        segments = [
            {"start": 0.0, "end": 2.0, "text": "kept"},
            {"start": 2.0, "end": 5.0, "text": "stranger"},
            {"start": 5.0, "end": 7.0, "text": "kept again"},
        ]
        result = keep_own_segments(
            segments, read_pcm(self.path), own, DirectionEmbedder(own, stranger, own)
        )
        self.assertEqual([s["text"] for s in result["segments"]], ["kept", "kept again"])
        self.assertEqual(result["dropped"], 1)

    def test_a_segment_shorter_than_the_window_is_kept(self):
        # "No" needs evidence: a one-word answer has none to give.
        segment = {"start": 0.0, "end": 0.5, "text": "short"}
        result = keep_own_segments([segment], read_pcm(self.path), np.ones(192), DirectionEmbedder(np.ones(192)))
        self.assertEqual(result["segments"], [segment])
        self.assertEqual(result["dropped"], 0)

    def test_the_floor_is_the_measured_one(self):
        self.assertAlmostEqual(FOREIGN_BELOW, 0.35)


if __name__ == "__main__":
    unittest.main()
