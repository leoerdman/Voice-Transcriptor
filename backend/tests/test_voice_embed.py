"""The net's arithmetic and its features, not its accuracy.

Accuracy is a model on real takes, and it is in the desk log; these are the
promises around it — the features the file was trained on, a cosine that never
divides by zero, a profile that is the mean of unit vectors, and silence that
is never a judgement. The one test that needs the weights asks for them by
environment variable and skips without: no test in this repo downloads 27 MB.
"""

import array
import os
import unittest

import numpy as np

from backend.voice_embed import (
    FEATURE_DIM,
    SpeakerEmbedder,
    SpeakerScorer,
    cosine,
    fbank80,
)


def pcm(level: int, ms: int, rate_hz: int = 16_000) -> bytes:
    samples = array.array("h", [level if i % 2 else -level for i in range(ms * rate_hz // 1000)])
    return samples.tobytes()


class FakeEmbedder:
    """Ducks like ``SpeakerEmbedder``: a fixed vector, or nothing at all."""

    def __init__(self, vector=None):
        self.vector = vector
        self.calls = 0

    def embed(self, pcm_bytes):
        self.calls += 1
        return self.vector


class FeatureTests(unittest.TestCase):
    def test_a_second_of_audio_is_a_hundred_frames(self):
        # 25 ms frames every 10 ms with snip_edges=false: every sample lands
        # in a frame, so a second is (16000 + 80) / 160.
        self.assertEqual(fbank80(pcm(3000, 1000)).shape, (100, FEATURE_DIM))

    def test_the_global_mean_is_what_makes_two_takes_comparable(self):
        feats = fbank80(pcm(3000, 700))
        means = feats.mean(axis=0)
        self.assertLess(float(np.abs(means).max()), 1e-4)

    def test_digital_silence_is_a_floor_and_not_an_infinity(self):
        # A log of zero is -inf and poisons every downstream dot product.
        feats = fbank80(bytes(3200))
        self.assertTrue(np.all(np.isfinite(feats)))

    def test_audio_shorter_than_one_frame_has_no_features(self):
        self.assertEqual(fbank80(b"").shape, (0, FEATURE_DIM))
        self.assertEqual(fbank80(pcm(3000, 1)).shape, (0, FEATURE_DIM))

    def test_cosine_of_a_zero_vector_is_zero_and_not_nan(self):
        self.assertEqual(cosine(np.zeros(4, dtype=np.float32), np.ones(4, dtype=np.float32)), 0.0)


class ScorerTests(unittest.TestCase):
    def setUp(self):
        self.vector = np.array([3.0, 0.0, 4.0], dtype=np.float32)  # norm 5, on purpose

    def test_the_owner_against_his_own_profile_is_one(self):
        scorer = SpeakerScorer(FakeEmbedder(self.vector), self.vector, voiced=lambda _w: True)
        self.assertAlmostEqual(scorer("window"), 1.0, places=5)

    def test_the_profile_is_stored_at_unit_length(self):
        scorer = SpeakerScorer(FakeEmbedder(self.vector), self.vector, voiced=lambda _w: True)
        self.assertAlmostEqual(float(np.linalg.norm(scorer.profile)), 1.0, places=5)

    def test_a_profile_of_zeros_is_refused(self):
        with self.assertRaises(ValueError):
            SpeakerScorer(FakeEmbedder(self.vector), np.zeros(3, dtype=np.float32))

    def test_no_voiced_frame_is_not_a_score(self):
        # §4.6: silence is silence already, and the gate must not weigh it.
        embedder = FakeEmbedder(self.vector)
        scorer = SpeakerScorer(embedder, self.vector, voiced=lambda _w: False)
        self.assertIsNone(scorer("room tone"))
        self.assertEqual(embedder.calls, 0, "a silent window still cost an inference")

    def test_a_window_that_cannot_be_embedded_is_not_a_score(self):
        scorer = SpeakerScorer(FakeEmbedder(None), self.vector, voiced=lambda _w: True)
        self.assertIsNone(scorer("too short to carry a speaker"))


class EnrolmentTests(unittest.TestCase):
    def test_enrolment_is_the_mean_of_unit_vectors(self):
        # Averaging unnormalised vectors lets the loudest window decide who
        # the owner is: a quiet one has to count as much as a loud one.
        loud = np.array([10.0, 0.0], dtype=np.float32)
        quiet = np.array([0.0, 1.0], dtype=np.float32)
        embedder = type("E", (), {"embed": lambda _self, w: loud if w == "loud" else quiet})()
        scorer = SpeakerScorer.enrol(embedder, ["loud", "quiet"], voiced=lambda _w: True)
        expected = np.array([1.0, 1.0], dtype=np.float32) / np.sqrt(2.0)
        np.testing.assert_allclose(scorer.profile, expected, atol=1e-6)

    def test_enrolment_of_nothing_is_no_profile_at_all(self):
        scorer = SpeakerScorer.enrol(FakeEmbedder(None), ["a", "b"])
        self.assertIsNone(scorer)


@unittest.skipUnless(
    os.environ.get("TRANSCRIPTOR_VOICE_MODEL"), "set TRANSCRIPTOR_VOICE_MODEL to the ONNX file"
)
class ModelTests(unittest.TestCase):
    """The gate's numbers on a real file: owner over open_at, stranger under.

    Skipped unless the weights are on disk. When they are, this is the
    reproduction of the desk log's calibration on one take, not a tolerance:
    the thresholds only work because the gap is this wide at 2 s.
    """

    @classmethod
    def setUpClass(cls):
        import wave

        cls.embedder = SpeakerEmbedder(os.environ["TRANSCRIPTOR_VOICE_MODEL"], threads=2)

        def read(path):
            with wave.open(path, "rb") as handle:
                return handle.readframes(handle.getnframes())

        audio = os.environ.get("TRANSCRIPTOR_VOICE_AUDIO_DIR")
        cls.owner = read(os.path.join(audio, "new-home-in-the-stars-16k.wav"))
        cls.other = read(os.path.join(audio, "LDC93S1_pcms16le_1_16000.wav"))

    def test_the_owner_clears_open_at_and_the_stranger_does_not_clear_close_at(self):
        # The take is 3.6 s, so the scored window overlaps the enrolment by a
        # second; the non-overlapping numbers are the 18.5 s montage's, and
        # they are the ones in the desk log. What this pins is the gap: 0.80
        # for the owner, 0.07 for a stranger, against 0.65/0.55.
        scorer = SpeakerScorer.enrol(
            self.embedder, [self.owner[16000:80000]], voiced=lambda _w: True
        )
        self.assertGreaterEqual(scorer(self.owner[47400:111400]), 0.65)
        self.assertLessEqual(scorer(self.other[0:64000]), 0.55)
