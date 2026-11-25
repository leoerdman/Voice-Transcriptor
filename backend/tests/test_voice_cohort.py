"""The cohort: a ruler of other voices, and the z it turns a cosine into."""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from backend import voice_cohort
from backend.voice_cohort import (
    CLOSE_Z,
    COHORT_LIMIT,
    OPEN_Z,
    load,
    pair_from_z,
    save,
    score_from_z,
    zscore,
)


def unit(seed: int, size: int = 192) -> np.ndarray:
    raw = np.random.default_rng(seed).normal(size=size)
    return raw / np.linalg.norm(raw)


def ruler(count: int = 60) -> np.ndarray:
    return np.stack([unit(1000 + index) for index in range(count)])


class TheRulerTests(unittest.TestCase):
    def test_a_round_trip_keeps_unit_vectors(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "voice_cohort.json"
            kept = save(path, [unit(1), unit(2)])
            loaded = load(path)
            self.assertEqual(kept, 2)
            self.assertEqual(loaded.shape, (2, 192))
            self.assertAlmostEqual(float(np.linalg.norm(loaded[0])), 1.0, places=5)

    def test_it_keeps_the_newest_and_no_more(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "voice_cohort.json"
            kept = save(path, [unit(index) for index in range(COHORT_LIMIT + 25)])
            self.assertEqual(kept, COHORT_LIMIT)
            self.assertEqual(load(path).shape[0], COHORT_LIMIT)

    def test_a_missing_file_is_an_empty_ruler_not_an_error(self):
        with TemporaryDirectory() as tmp:
            loaded = load(Path(tmp) / "nothing.json")
            self.assertEqual(loaded.size, 0)

    def test_a_ruler_below_twenty_voices_answers_nothing(self):
        owner = unit(1)
        self.assertIsNone(zscore(owner, owner, np.stack([unit(9)])))

    def test_the_owner_is_far_above_the_ruler_and_a_stranger_is_not(self):
        owner = unit(1)
        cohort = np.stack([unit(1000 + index) for index in range(40)])
        # A window that IS the owner: close to the track, unrelated to the
        # ruler, so many spreads above the average stranger.
        own_z = zscore(owner, owner, cohort)
        stranger = unit(2001)
        other_z = zscore(stranger, owner, cohort)
        self.assertIsNotNone(own_z)
        self.assertIsNotNone(other_z)
        self.assertGreater(own_z, OPEN_Z)
        self.assertLess(other_z, CLOSE_Z)

    def test_the_pair_keeps_its_order_on_the_gate_scale(self):
        open_at, close_at = pair_from_z()
        self.assertGreater(open_at, close_at)
        self.assertGreater(open_at, 0.5)
        self.assertAlmostEqual(score_from_z(0.0), 0.5, places=6)


if __name__ == "__main__":
    unittest.main()
