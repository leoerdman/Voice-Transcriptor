"""The one rule a new recording's files are named by (backend/recording_names.py).

``YYYYMMDD-HHMMSS`` — the local time of the recording, digits and one
hyphen — plus ``-`` and four random lowercase hex digits on a collision.
The integration side (every save path goes through it, legacy names keep
working) is in ``test_recording_names.py``.
"""

from __future__ import annotations

import re
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from backend import recording_names


class RecordingStemFormatTests(unittest.TestCase):
    def test_the_first_candidate_is_the_local_time_digits_and_one_hyphen(self):
        stem = next(recording_names.recording_stem_candidates(datetime(2026, 11, 21, 3, 46, 11, 851314)))
        self.assertEqual(stem, "20261121-034611")
        self.assertRegex(stem, r"^[0-9]{8}-[0-9]{6}$")

    def test_there_is_no_now_in_place_of_the_recording_start(self):
        # "Now" at save time is the take's END: every caller must say when
        # its recording began.
        with self.assertRaises(TypeError):
            next(recording_names.recording_stem_candidates())  # type: ignore[call-arg]

    def test_an_aware_time_is_named_in_local_time(self):
        aware = datetime(2026, 11, 21, 0, 46, 11, tzinfo=timezone(timedelta(hours=-3)))
        expected = aware.astimezone().strftime("%Y%m%d-%H%M%S")
        self.assertEqual(next(recording_names.recording_stem_candidates(aware)), expected)

    def test_a_collision_appends_four_random_lowercase_hex_digits(self):
        candidates = list(recording_names.recording_stem_candidates(datetime(2026, 11, 21, 3, 46, 11)))
        self.assertEqual(candidates[0], "20261121-034611")
        suffixed = candidates[1:]
        self.assertEqual(len(suffixed), recording_names.COLLISION_SUFFIX_ATTEMPTS)
        for stem in suffixed:
            self.assertRegex(stem, r"^20261121-034611-[0-9a-f]{4}$")
        # Random, not a counter: the draws are not all the same.
        self.assertGreater(len(set(suffixed)), 1)

    def test_the_candidates_are_finite(self):
        # A folder where every name is taken ends in an error, not a hang.
        count = sum(1 for _ in recording_names.recording_stem_candidates(datetime(2026, 11, 21)))
        self.assertEqual(count, 1 + recording_names.COLLISION_SUFFIX_ATTEMPTS)

    def test_every_candidate_is_shell_safe(self):
        for stem in recording_names.recording_stem_candidates(datetime(2026, 11, 21, 23, 59, 59)):
            self.assertTrue(re.fullmatch(r"[0-9a-f-]+", stem), stem)
            self.assertLessEqual(len(stem), len("20261121-235959-ffff"))


class StemFormRecognitionTests(unittest.TestCase):
    def test_current_stems_are_recognised(self):
        for stem in ("20261121-034611", "20261121-034611-a3f9"):
            with self.subTest(stem=stem):
                self.assertTrue(recording_names.is_recording_stem(stem))
                self.assertIsNone(recording_names.legacy_stem_parts(stem))

    def test_other_stems_are_not_current_ones(self):
        for stem in (
            "2026-11-21_03-46-11-851314__первые слова",
            "20261121-034611-A3F9",
            "20261121-034611-a3f",
            "20261121_034611",
            "meeting",
            "",
        ):
            with self.subTest(stem=stem):
                self.assertFalse(recording_names.is_recording_stem(stem))

    def test_legacy_stems_split_into_timestamp_and_title(self):
        self.assertEqual(
            recording_names.legacy_stem_parts("2026-11-21_03-46-11-851314__первые слова диктовки"),
            ("2026-11-21_03-46-11-851314", "первые слова диктовки"),
        )
        self.assertEqual(
            recording_names.legacy_stem_parts("2026-09-04_19-37-12__Recovered 2026-09-04T19_37_12.123456"),
            ("2026-09-04_19-37-12", "Recovered 2026-09-04T19_37_12.123456"),
        )

    def test_a_name_that_merely_contains_a_double_underscore_is_not_legacy(self):
        self.assertIsNone(recording_names.legacy_stem_parts("my__secret plan"))
        self.assertIsNone(recording_names.legacy_stem_parts("demo"))


if __name__ == "__main__":
    unittest.main()
