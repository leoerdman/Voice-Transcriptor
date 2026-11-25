"""The live tuner: windows scored from the microphone, not from a file."""

import unittest

import numpy as np

from backend.voice_tune_live import (
    HOP_MS,
    WINDOW_MS,
    LiveTuneRegistry,
    LiveTuneSession,
)

#: 16 kHz mono PCM16.
SECOND = 32_000


class FakeEmbedder:
    """A vector that leans on loudness, so a score is readable in a test."""

    def __init__(self) -> None:
        self.calls = 0
        self.closed = False

    def embed(self, window: bytes) -> np.ndarray:
        self.calls += 1
        samples = np.frombuffer(window, dtype="<i2").astype(np.float64) / 32768.0
        loudness = float(np.sqrt(np.mean(samples**2))) if samples.size else 0.0
        vector = np.zeros(8, dtype=np.float32)
        vector[0] = 1.0
        vector[1] = loudness * 10.0
        return vector / float(np.linalg.norm(vector))

    def close(self) -> None:
        self.closed = True


def silent(seconds: float) -> bytes:
    return b"\x00\x00" * int(SECOND * seconds / 2)


def loud(seconds: float, amplitude: int = 8000) -> bytes:
    samples = int(SECOND * seconds / 2)
    return np.full(samples, amplitude, dtype="<i2").tobytes()


def session(**kwargs) -> LiveTuneSession:
    reference = np.zeros(8, dtype=np.float32)
    reference[0] = 1.0
    reference[1] = 0.5
    reference /= float(np.linalg.norm(reference))
    return LiveTuneSession(FakeEmbedder(), reference, slot=1, **kwargs)


class TheWindowGridTests(unittest.TestCase):
    def test_the_tuner_window_is_shorter_than_the_gate_s(self):
        # The gate judges two seconds; a tuner that answered every two seconds
        # could not be moved while a voice is in the room.
        self.assertEqual(WINDOW_MS, 1000)
        self.assertEqual(HOP_MS, 250)

    def test_a_feed_shorter_than_a_window_scores_nothing(self):
        self.assertEqual(session().feed(loud(0.5)), [])

    def test_the_first_window_lands_when_a_window_of_audio_has_arrived(self):
        windows = session().feed(loud(1.0))
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["index"], 0)

    def test_windows_slide_by_a_hop_not_a_window(self):
        # Two seconds at a one-second window and a quarter-second hop is five
        # windows: 0-1, .25-1.25, .5-1.5, .75-1.75, 1-2.
        windows = session().feed(loud(2.0))
        self.assertEqual(len(windows), 5)
        self.assertEqual([w["index"] for w in windows], [0, 1, 2, 3, 4])

    def test_audio_across_two_feeds_is_one_continuous_stream(self):
        # The browser posts every quarter second; a window that spans two of
        # those posts is the normal case, not an edge one.
        s = session()
        self.assertEqual(s.feed(loud(0.5)), [])
        windows = s.feed(loud(0.5))
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["index"], 0)
        self.assertEqual(s.feed(loud(0.5))[0]["index"], 1)

    def test_a_long_feed_scores_every_window_it_completes(self):
        self.assertEqual(len(session().feed(loud(6.0))), 1 + 5 * 4)

    def test_the_grid_never_repeats_a_window(self):
        indexes = [w["index"] for w in session().feed(loud(3.0))]
        self.assertEqual(indexes, sorted(set(indexes)))


class TheScoreTests(unittest.TestCase):
    def test_a_voice_further_from_the_profile_scores_lower(self):
        quiet = session().feed(loud(1.0, amplitude=800))[0]["score"]
        louder = session().feed(loud(1.0, amplitude=20000))[0]["score"]
        self.assertGreater(quiet, louder)

    def test_the_level_rule_marks_a_far_window(self):
        # A voice learned at -20 dB does not hear its owner at -60 dB.
        windows = session(near_level_db=-20.0).feed(loud(1.0, amplitude=30))
        self.assertTrue(windows[0]["far"])

    def test_a_near_window_is_not_marked_far(self):
        windows = session(near_level_db=-20.0).feed(loud(1.0, amplitude=20000))
        self.assertFalse(windows[0]["far"])

    def test_an_unmeasured_level_never_marks_anything_far(self):
        # 0.0 is "not measured". A guard that treated a negative dBFS level as
        # unmeasured is how this rule was dead on every real profile.
        windows = session(near_level_db=0.0).feed(loud(1.0, amplitude=30))
        self.assertFalse(windows[0]["far"])

    def test_silence_is_not_mistaken_for_a_voice(self):
        windows = session(near_level_db=-20.0).feed(silent(1.0))
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["level_db"], 0.0)


class TheRegistryTests(unittest.TestCase):
    def test_a_stopped_session_is_gone_and_its_weights_are_released(self):
        registry = LiveTuneRegistry()
        embedder = FakeEmbedder()
        s = LiveTuneSession(embedder, np.ones(8), slot=1)
        token = registry.start(s)
        self.assertIs(registry.get(token), s)
        self.assertTrue(registry.stop(token))
        self.assertIsNone(registry.get(token))
        self.assertTrue(embedder.closed)

    def test_an_idle_session_is_swept(self):
        registry = LiveTuneRegistry(idle_timeout_sec=-1.0)
        embedder = FakeEmbedder()
        s = LiveTuneSession(embedder, np.ones(8), slot=1)
        token = registry.start(s)
        self.assertIsNone(registry.get(token))
        self.assertTrue(embedder.closed)

    def test_a_closed_session_scores_nothing_more(self):
        s = session()
        s.close()
        self.assertEqual(s.feed(loud(4.0)), [])


if __name__ == "__main__":
    unittest.main()
