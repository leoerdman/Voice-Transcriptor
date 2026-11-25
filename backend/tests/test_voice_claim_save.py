"""The one way a track is learned now: a claim, then a name."""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from backend import main
from backend.voice_profiles import DIMENSIONS, SLOTS, VoiceProfileStore


def unit(seed: int = 1) -> np.ndarray:
    raw = np.random.default_rng(seed).normal(size=DIMENSIONS)
    return (raw / np.linalg.norm(raw)).astype(np.float64)


class ClaimSaveTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = VoiceProfileStore(Path(self._tmp.name) / "voice_profiles.json")
        self._saved_store = main.VOICE_PROFILES
        main.VOICE_PROFILES = self.store
        main._ACTIVE_VOICE_VECTOR[0] = None
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        main.VOICE_PROFILES = self._saved_store
        main._ACTIVE_VOICE_VECTOR[0] = None

    def test_a_track_cannot_be_saved_before_a_claim(self):
        with self.assertRaises(main.HTTPException) as caught:
            main.save_claimed_voice(payload={"name": "я"})
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("That is me", caught.exception.detail)

    def test_a_claim_without_a_name_is_refused(self):
        main._ACTIVE_VOICE_VECTOR[0] = unit()
        with self.assertRaises(main.HTTPException) as caught:
            main.save_claimed_voice(payload={"name": "   "})
        self.assertEqual(caught.exception.status_code, 400)

    def test_the_claimed_voice_lands_in_the_next_free_track(self):
        self.store.save(1, "taken", unit(2))
        main._ACTIVE_VOICE_VECTOR[0] = unit(3)
        payload = main.save_claimed_voice(payload={"name": "  я   сегодня "})
        self.assertEqual(payload["saved_slot"], 2)
        saved = self.store.profiles()[2]
        self.assertEqual(saved.name, "я сегодня")
        np.testing.assert_allclose(saved.as_vector(), unit(3).astype(np.float32), atol=1e-6)

    def test_a_full_store_refuses_the_save_instead_of_overwriting(self):
        for slot in range(1, SLOTS + 1):
            self.store.save(slot, f"track {slot}", unit(slot + 10))
        main._ACTIVE_VOICE_VECTOR[0] = unit(99)
        with self.assertRaises(main.HTTPException) as caught:
            main.save_claimed_voice(payload={"name": "ещё одна"})
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("remove one", caught.exception.detail)

    def test_the_claim_does_not_outlive_the_take(self):
        main._ACTIVE_VOICE_VECTOR[0] = unit()
        main.clear_active_voice_mask()
        self.assertIsNone(main._ACTIVE_VOICE_VECTOR[0])


if __name__ == "__main__":
    unittest.main()
