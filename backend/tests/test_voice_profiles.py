"""Three slots on disk: what the store refuses, and what it must never lose.

The interesting cases are the refusals (§5.1's fourth profile, a vector of
the wrong width, a name that is nothing) and the broken file — an app that
cannot boot because its profile file has a stray byte is worse than a mask
with nobody enrolled.
"""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from backend.voice_profiles import (
    DIMENSIONS,
    ProfileError,
    VoiceProfileStore,
)


def vector(seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    raw = rng.normal(size=DIMENSIONS).astype(np.float32)
    return raw / np.linalg.norm(raw)


def plain(raw: np.ndarray) -> list:
    """A vector as JSON would hold it — numpy floats are not serialisable."""
    return [float(v) for v in raw]


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "voice_profiles.json"
        self.store = VoiceProfileStore(self.path)


class RoundTripTests(StoreTestCase):
    def test_a_profile_survives_a_reload(self):
        self.store.save(1, "  Leo   himself ", vector(3))
        again = VoiceProfileStore(self.path).profiles()[1]
        self.assertEqual(again.name, "Leo himself", "the name is not whitespace-tolerant")
        self.assertEqual(again.slot, 1)
        self.assertEqual(len(again.vector), DIMENSIONS)
        np.testing.assert_allclose(again.as_vector(), vector(3), atol=1e-6)

    def test_the_file_holds_vectors_and_no_audio(self):
        # §1.3: profiles persist, audio does not. Anything that could be a
        # take in here is a recording the store has no business keeping.
        self.store.save(1, "Leo", vector())
        entry = json.loads(self.path.read_text(encoding="utf-8"))["profiles"]["1"]
        self.assertEqual(set(entry), {"name", "vector", "created_at"})

    def test_three_slots_are_always_drawn(self):
        self.store.save(2, "Second", vector(2))
        slots = self.store.slots()
        self.assertEqual(len(slots), 3)
        self.assertIsNone(slots[0])
        self.assertEqual(slots[1].name, "Second")
        self.assertIsNone(slots[2])

    def test_saving_the_same_slot_replaces_it_and_keeps_three(self):
        self.store.save(1, "Before", vector(1))
        self.store.save(1, "After", vector(2))
        profiles = self.store.profiles()
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[1].name, "After")


class RefusalTests(StoreTestCase):
    def test_a_fourth_profile_is_refused(self):
        # §5.1, and §6.3 lists it among the never: a fourth profile.
        for slot in (4, 0, -1, "many"):
            with self.subTest(slot=slot):
                with self.assertRaises(ProfileError):
                    self.store.save(slot, "Overflow", vector())

    def test_a_vector_of_the_wrong_width_is_refused(self):
        # A 191-dim vector is not a slightly worse profile, it is a different
        # model's output, and the cosine would be a shape error at 3 a.m.
        with self.assertRaises(ProfileError):
            self.store.save(1, "Short", np.zeros(DIMENSIONS - 1, dtype=np.float32))

    def test_a_profile_of_zeros_is_refused(self):
        with self.assertRaises(ProfileError):
            self.store.save(1, "Nobody", np.zeros(DIMENSIONS, dtype=np.float32))

    def test_a_profile_of_nans_is_refused(self):
        bad = vector()
        bad[7] = np.nan
        with self.assertRaises(ProfileError):
            self.store.save(1, "NaN", bad)

    def test_a_nameless_profile_is_refused(self):
        for name in ("", "   ", None):
            with self.subTest(name=name):
                with self.assertRaises(ProfileError):
                    self.store.save(1, name, vector())


class OwnershipTests(StoreTestCase):
    def test_the_first_profile_is_the_owner(self):
        # A room with one known voice and no owner is a mask that can never
        # open; the store does not leave that state on purpose.
        self.store.save(2, "Leo", vector())
        self.assertEqual(self.store.enabled_slot(), 2)

    def test_the_owner_can_be_switched_or_cleared(self):
        self.store.save(1, "One", vector(1))
        self.store.save(2, "Two", vector(2))
        self.store.set_enabled(2)
        self.assertEqual(self.store.enabled().name, "Two")
        self.store.set_enabled(None)
        self.assertIsNone(self.store.enabled())

    def test_naming_an_empty_slot_as_owner_is_refused(self):
        with self.assertRaises(ProfileError):
            self.store.set_enabled(3)

    def test_deleting_the_owner_hands_over_to_a_remaining_slot(self):
        self.store.save(1, "One", vector(1))
        self.store.save(3, "Three", vector(3))
        self.store.set_enabled(3)
        self.assertTrue(self.store.delete(3))
        self.assertEqual(self.store.enabled_slot(), 1)

    def test_deleting_an_empty_slot_reports_it(self):
        self.assertFalse(self.store.delete(2))


class BrokenFileTests(StoreTestCase):
    def test_a_half_written_file_reads_as_no_profiles(self):
        # An app that cannot boot because of a stray byte is worse than a
        # mask with nobody enrolled.
        self.path.write_text('{"profiles": {"1": {"name": "Le', encoding="utf-8")
        self.assertEqual(self.store.profiles(), {})
        self.assertIsNone(self.store.enabled())

    def test_one_bad_entry_does_not_take_the_others_with_it(self):
        self.path.write_text(
            json.dumps(
                {
                    "enabled": 1,
                    "profiles": {
                        "1": {"name": "Good", "vector": plain(vector()), "created_at": ""},
                        "2": {"name": "Short", "vector": [0.1, 0.2], "created_at": ""},
                    },
                }
            ),
            encoding="utf-8",
        )
        profiles = self.store.profiles()
        self.assertEqual(sorted(profiles), [1])
        self.assertEqual(self.store.enabled_slot(), 1)

    def test_an_enabled_slot_that_holds_nothing_is_not_an_owner(self):
        self.path.write_text(
            json.dumps({"enabled": 2, "profiles": {"1": {"name": "Good", "vector": plain(vector()), "created_at": ""}}}),
            encoding="utf-8",
        )
        self.assertIsNone(self.store.enabled())
