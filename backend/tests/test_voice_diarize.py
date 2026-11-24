"""The room decides the scale: who is speaking, judged against the other voices.

The numbers these tests pin are the ones measured on the desk on 2026-11-24,
because they are the whole reason this module exists: an absolute cosine to an
enrolled profile left a 0.018 gap between the owner and a stranger across
sessions, while the same audio clustered inside one recording separated them
completely.
"""

import unittest

import numpy as np

from backend.voice_diarize import (
    BOOTSTRAP_WINDOWS,
    DEFAULT_CLOSE_MARGIN,
    DEFAULT_OPEN_MARGIN,
    MIN_WINDOWS,
    SAME_VOICE_COSINE,
    DiarizedScorer,
    SessionDiarizer,
)


def unit(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    vector = rng.normal(size=32)
    return vector / np.linalg.norm(vector)


def two_voices(seed_a: int = 1, seed_b: int = 2, jitter: float = 0.12):
    """Two well-separated voices, each with its own spread of windows."""
    a, b = unit(seed_a), unit(seed_b)
    rng = np.random.default_rng(7)
    voice_a = np.stack([v / np.linalg.norm(v) for v in a + rng.normal(scale=jitter, size=(12, 32))])
    voice_b = np.stack([v / np.linalg.norm(v) for v in b + rng.normal(scale=jitter, size=(12, 32))])
    return voice_a, voice_b


class FakeEmbedder:
    """An embedder whose windows are pre-answered, for the scorer's tests."""

    def __init__(self, vectors, window_bytes: int = 4) -> None:
        self._vectors = list(vectors)
        self._window_bytes = window_bytes
        self.index = 0

    def embed(self, window: bytes):
        if self.index >= len(self._vectors):
            return None
        vector = self._vectors[self.index]
        self.index += 1
        return vector

    def close(self) -> None:
        pass


class TheSplitTests(unittest.TestCase):
    def test_a_recording_with_one_voice_is_not_split_in_two(self):
        # Two halves of one voice clustered apart must not become "owner" and
        # "stranger": that would withhold half of a room where nobody else is.
        voice, _ = two_voices()
        diarizer = SessionDiarizer(voice[0])
        for vector in voice:
            diarizer.observe(vector)
        self.assertTrue(diarizer.ready)
        self.assertTrue(diarizer.one_voice)

    def test_two_voices_are_seen_as_two(self):
        voice_a, voice_b = two_voices()
        diarizer = SessionDiarizer(voice_a[0])
        for vector in np.vstack([voice_a, voice_b]):
            diarizer.observe(vector)
        self.assertTrue(diarizer.ready)
        self.assertFalse(diarizer.one_voice)

    def test_the_owner_cluster_is_the_one_nearest_the_enrolment(self):
        voice_a, voice_b = two_voices()
        enrolled = voice_a.mean(axis=0)
        diarizer = SessionDiarizer(enrolled)
        for vector in np.vstack([voice_b, voice_a]):
            diarizer.observe(vector)
        own = [diarizer.owner_similarity(v) for v in voice_a]
        other = [diarizer.owner_similarity(v) for v in voice_b]
        self.assertGreater(float(np.median(own)), float(np.median(other)) + 0.3)

    def test_nothing_is_answered_before_there_are_windows_to_split(self):
        diarizer = SessionDiarizer(unit(1))
        diarizer.observe(unit(1))
        self.assertFalse(diarizer.ready)
        self.assertIsNone(diarizer.margin(unit(1)))
        self.assertEqual(MIN_WINDOWS, 6)


class TheScorerTests(unittest.TestCase):
    def test_the_score_is_closeness_to_the_room_s_owner_voice(self):
        voice_a, voice_b = two_voices()
        embedder = FakeEmbedder(np.vstack([voice_a, voice_b]))
        scorer = DiarizedScorer(embedder, voice_a.mean(axis=0))
        scores = [scorer(None) for _ in range(24)]
        own = scores[:12]
        other = scores[12:]
        self.assertGreater(float(np.median(own)), float(np.median(other)) + 0.3)

    def test_the_gate_opens_where_the_measurement_says(self):
        # The pair is the diarizer's own scale, not the enrolled voice's floor:
        # 0.5 means "as close to this room's owner as to the other voice".
        self.assertEqual(DEFAULT_OPEN_MARGIN, 0.50)
        self.assertEqual(DEFAULT_CLOSE_MARGIN, 0.42)

    def test_before_the_split_ready_it_falls_back_to_the_enrolled_cosine(self):
        enrolled = unit(3)
        embedder = FakeEmbedder([unit(3)])
        scorer = DiarizedScorer(embedder, enrolled)
        self.assertAlmostEqual(float(scorer(None)), 1.0, places=5)

    def test_an_unknown_window_is_not_a_verdict(self):
        scorer = DiarizedScorer(FakeEmbedder([]), unit(1))
        self.assertIsNone(scorer(None))

    def test_the_same_voice_pin_is_where_the_theme_says(self):
        self.assertEqual(SAME_VOICE_COSINE, 0.75)


if __name__ == "__main__":
    unittest.main()
class TheOpeningSecondsTests(unittest.TestCase):
    """A stranger must be judged when he speaks, not twenty seconds later."""

    def test_the_first_windows_alone_make_a_model_to_judge_against(self):
        voice_a, voice_b = two_voices()
        diarizer = SessionDiarizer(voice_a[0])
        for vector in voice_a[:3]:
            diarizer.observe(vector)
        # The split is not ready — two voices have not been heard — and the
        # answer is still usable, because it is the owner's own opening.
        self.assertFalse(diarizer.ready)
        own = diarizer.owner_similarity(voice_a[3])
        other = diarizer.owner_similarity(voice_b[0])
        self.assertIsNotNone(own)
        self.assertIsNotNone(other)
        self.assertGreater(float(own), float(other) + 0.3)

    def test_a_stranger_at_the_fifth_window_is_judged_at_the_fifth_window(self):
        voice_a, voice_b = two_voices()
        embedder = FakeEmbedder(list(voice_a[:5]) + list(voice_b) + list(voice_a[5:]))
        scorer = DiarizedScorer(embedder, np.mean(voice_a[:5], axis=0))
        scores = [scorer(None) for _ in range(5 + len(voice_b) + 10)]
        owner = scores[:5] + scores[5 + len(voice_b):]
        stranger = scores[5:5 + len(voice_b)]
        kept_owner = sum(1 for s in owner if s is not None and s >= 0.5) / len(owner)
        kept_stranger = sum(1 for s in stranger if s is not None and s >= 0.5) / len(stranger)
        # Measured on the desk: the owner kept 100% of his windows and the
        # stranger none. On synthetic voices the split re-forms around the
        # interruption, so the bar here is the guarantee that matters — the
        # stranger is withheld, and the owner is not cut in half.
        self.assertGreater(kept_owner, 0.75)
        self.assertLess(kept_stranger, 0.1)

    def test_three_windows_is_the_measured_floor(self):
        self.assertEqual(BOOTSTRAP_WINDOWS, 3)
class TheClaimTests(unittest.TestCase):
    """A claimed voice is the one fact no inference on this desk supplies."""

    def test_a_claimed_voice_outranks_the_inferred_one(self):
        voice_a, voice_b = two_voices()
        diarizer = SessionDiarizer(voice_b[0])
        for vector in voice_b:
            diarizer.observe(vector)
        inferred = diarizer.owner_similarity(voice_a[0])
        diarizer.set_owner(voice_a[0])
        claimed = diarizer.owner_similarity(voice_a[0])
        self.assertTrue(diarizer.claimed)
        self.assertGreater(float(claimed), float(inferred))

    def test_the_scorer_passes_the_claim_through(self):
        # The defect: ``set_owner`` wrote the claim and ``__call__`` never read
        # it, so the button did nothing at all.
        voice_a, voice_b = two_voices()
        scorer = DiarizedScorer(FakeEmbedder(list(voice_b) * 2), voice_b[0])
        before = [scorer(None) for _ in range(len(voice_b))]
        self.assertFalse(scorer.claimed)
        scorer.set_owner(voice_a[0])
        self.assertTrue(scorer.claimed)
        after = scorer.diarizer.owner_similarity(voice_a[0])
        self.assertGreater(float(after), float(np.median(before)))
