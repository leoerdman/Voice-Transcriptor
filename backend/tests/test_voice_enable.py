"""A measured voice can always be switched on; that is what "measured" means.

The defect these tests pin was reported from the desk as "everything was fine,
then I turned Solo off and could not turn it back on": the enable route refused
any profile whose level was not positive, and a level is a negative dBFS number,
so it refused every profile ever measured. The gate had the same sign error,
fixed the same day.
"""

import unittest

import numpy as np

from backend import main as app_main
from backend.voice_profiles import VoiceProfile


def _profile(level_db: float, self_floor: float = 0.8) -> VoiceProfile:
    return VoiceProfile(
        slot=1,
        name="Owner",
        vector=tuple([1.0] + [0.0] * 191),
        created_at="2026-11-25T00:00:00+00:00",
        self_floor=self_floor,
        level_db=level_db,
    )


class TheSwitchTests(unittest.TestCase):
    def _enable(self, profile):
        saved = {}

        class Store:
            def profiles(self):
                return {1: profile}

            def set_enabled(self, slot):
                saved["enabled"] = slot
                return True

            def slots(self):
                return [profile, None, None]

            def enabled_slot(self):
                return saved.get("enabled")

            def enabled(self):
                return profile if saved.get("enabled") else None

        original_store = app_main.VOICE_PROFILES
        app_main.VOICE_PROFILES = Store()
        try:
            app_main.enable_voice_profile(1, _auth=None)
        finally:
            app_main.VOICE_PROFILES = original_store
        return saved

    def test_a_negative_level_is_a_measurement_not_a_refusal(self):
        # The reported failure: −53 dBFS is a real, quiet, measured level.
        saved = self._enable(_profile(level_db=-53.0))
        self.assertEqual(saved.get("enabled"), 1)

    def test_a_quiet_room_level_is_accepted_too(self):
        saved = self._enable(_profile(level_db=-78.5))
        self.assertEqual(saved.get("enabled"), 1)

    def test_an_unmeasured_level_is_still_refused(self):
        # 0.0 means "never measured"; 0 dBFS is full scale and no room gives it.
        with self.assertRaises(Exception):
            self._enable(_profile(level_db=0.0))

    def test_an_unmeasured_floor_is_still_refused(self):
        with self.assertRaises(Exception):
            self._enable(_profile(level_db=-40.0, self_floor=0.0))


if __name__ == "__main__":
    unittest.main()
