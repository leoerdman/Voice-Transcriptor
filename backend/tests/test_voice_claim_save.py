"""The one way a track is learned now: a claim, then a name."""

import unittest
from unittest import mock
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from backend import main
from backend.voice_profiles import DIMENSIONS, SLOTS, VoiceProfileStore


def unit(seed: int = 1) -> np.ndarray:
    raw = np.random.default_rng(seed).normal(size=DIMENSIONS)
    return (raw / np.linalg.norm(raw)).astype(np.float64)


def claimed(vector=None, self_floor=0.72, level_db=-31.0) -> dict:
    """What a press leaves behind for the name step."""
    return {
        "vector": unit() if vector is None else vector,
        "self_floor": self_floor,
        "level_db": level_db,
    }


class ClaimSaveTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = VoiceProfileStore(Path(self._tmp.name) / "voice_profiles.json")
        self._saved_store = main.VOICE_PROFILES
        main.VOICE_PROFILES = self.store
        main._ACTIVE_VOICE_CLAIM[0] = None
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        main.VOICE_PROFILES = self._saved_store
        main._ACTIVE_VOICE_CLAIM[0] = None

    def test_a_track_cannot_be_saved_before_a_claim(self):
        with self.assertRaises(main.HTTPException) as caught:
            main.save_claimed_voice(payload={"name": "я"})
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("That is me", caught.exception.detail)

    def test_a_claim_without_a_name_is_refused(self):
        main._ACTIVE_VOICE_CLAIM[0] = claimed()
        with self.assertRaises(main.HTTPException) as caught:
            main.save_claimed_voice(payload={"name": "   "})
        self.assertEqual(caught.exception.status_code, 400)

    def test_the_claimed_voice_lands_in_the_next_free_track(self):
        self.store.save(1, "taken", unit(2))
        main._ACTIVE_VOICE_CLAIM[0] = claimed(unit(3))
        payload = main.save_claimed_voice(payload={"name": "  я   сегодня "})
        self.assertEqual(payload["saved_slot"], 2)
        saved = self.store.profiles()[2]
        self.assertEqual(saved.name, "я сегодня")
        np.testing.assert_allclose(saved.as_vector(), unit(3).astype(np.float32), atol=1e-6)

    def test_a_full_store_refuses_the_save_instead_of_overwriting(self):
        for slot in range(1, SLOTS + 1):
            self.store.save(slot, f"track {slot}", unit(slot + 10))
        main._ACTIVE_VOICE_CLAIM[0] = claimed(unit(99))
        with self.assertRaises(main.HTTPException) as caught:
            main.save_claimed_voice(payload={"name": "ещё одна"})
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("remove one", caught.exception.detail)

    def test_the_claim_does_not_outlive_the_take(self):
        main._ACTIVE_VOICE_CLAIM[0] = claimed()
        main.clear_active_voice_mask()
        self.assertIsNone(main._ACTIVE_VOICE_CLAIM[0])


class ClaimPressTests(unittest.TestCase):
    """The press itself: what it keeps for the name step.

    It reached `np.asarray` without numpy in scope on 2026-11-25 and answered
    500 to a real press in the running window; and it stored zeros for the
    floor and the level, which made every track it saved impossible to switch
    on. Both are pinned here.
    """

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = VoiceProfileStore(Path(self._tmp.name) / "voice_profiles.json")
        self._saved_store = main.VOICE_PROFILES
        self._saved_mask = main._ACTIVE_VOICE_MASK
        main.VOICE_PROFILES = self.store
        main._ACTIVE_VOICE_CLAIM[0] = None
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        main.VOICE_PROFILES = self._saved_store
        main._ACTIVE_VOICE_MASK = self._saved_mask
        main._ACTIVE_VOICE_CLAIM[0] = None

    def _mask(self, seconds: float):
        class Scorer:
            def __init__(self):
                self.owner = None

            def set_owner(self, vector):
                self.owner = vector

        class Mask:
            def __init__(self):
                self.scorer = Scorer()

            def recent_audio(self, _seconds):
                return b"\x00\x00" * int(main.LIVE_SAMPLE_RATE_HZ * seconds)

        return Mask()

    def test_the_press_keeps_a_claim_the_name_step_can_store(self):
        mask = self._mask(3.0)
        main._ACTIVE_VOICE_MASK = mask
        with mock.patch.object(main, "enrol_take_stats", lambda embedder, pcm: (unit(7), 0.71)), \
                mock.patch.object(main, "take_level_db", lambda pcm: -32.5):
            answer = main.claim_voice_for_recording()

        self.assertTrue(answer["claimed"])
        self.assertGreaterEqual(answer["seconds"], main.CLAIM_MIN_SECONDS)
        self.assertIsNotNone(mask.scorer.owner)
        claim = main._ACTIVE_VOICE_CLAIM[0]
        self.assertEqual(len(claim["vector"]), DIMENSIONS)
        self.assertAlmostEqual(claim["self_floor"], 0.71)
        self.assertAlmostEqual(claim["level_db"], -32.5)

    def test_the_track_the_press_saves_can_be_switched_on(self):
        main._ACTIVE_VOICE_MASK = self._mask(3.0)
        with mock.patch.object(main, "enrol_take_stats", lambda embedder, pcm: (unit(7), 0.71)), \
                mock.patch.object(main, "take_level_db", lambda pcm: -32.5):
            main.claim_voice_for_recording()
            # Saved while the take still runs: the claim is what the name step
            # stores, and it is dropped when the recording ends.
            saved = main.save_claimed_voice(payload={"name": "take"})
        slot = saved["saved_slot"]
        main.clear_active_voice_mask()
        # The enable route is the judge: a voice "learned before Solo could
        # measure it" is refused there, and that is exactly what zeros made.
        main.enable_voice_profile(slot, _auth=None)
        self.assertEqual(self.store.enabled_slot(), slot)

    def test_the_press_refuses_a_take_it_has_not_heard(self):
        main._ACTIVE_VOICE_MASK = self._mask(0.5)
        with self.assertRaises(main.HTTPException) as caught:
            main.claim_voice_for_recording()
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("keep speaking", caught.exception.detail)
        self.assertIsNone(main._ACTIVE_VOICE_CLAIM[0])

