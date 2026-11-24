"""The tuner's own arithmetic: which windows one picture is made of."""

import unittest

from backend.voice_tune import MAX_TUNE_WINDOWS, window_starts

#: 16 kHz mono PCM16: 32000 bytes a second, 64000 a window.
WINDOW_BYTES = 64_000


class WindowStartTests(unittest.TestCase):
    def test_a_take_shorter_than_one_window_has_no_picture(self):
        # Not one padded window: a strip of silence would teach the owner
        # nothing about their voice.
        self.assertEqual(window_starts(WINDOW_BYTES - 2), [])

    def test_a_take_of_one_window_is_one_bar(self):
        self.assertEqual(window_starts(WINDOW_BYTES), [0])

    def test_windows_step_by_half_a_window(self):
        starts = window_starts(WINDOW_BYTES * 3)
        self.assertEqual(starts[:3], [0, WINDOW_BYTES // 2, WINDOW_BYTES])

    def test_a_long_take_is_thinned_evenly_not_truncated(self):
        # The strip is the shape of the split, so the last second of a long
        # recording has to be on it: a first-N truncation would hide the
        # handover the owner is looking for.
        long_take = WINDOW_BYTES * 400
        starts = window_starts(long_take)
        self.assertLessEqual(len(starts), MAX_TUNE_WINDOWS)
        self.assertGreaterEqual(len(starts), MAX_TUNE_WINDOWS - 2)
        last = starts[-1]
        self.assertGreater(last, long_take // 2)
        self.assertLessEqual(last + WINDOW_BYTES, long_take)

    def test_starts_are_strictly_increasing(self):
        starts = window_starts(WINDOW_BYTES * 37)
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(len(starts), len(set(starts)))

    def test_an_odd_byte_is_not_half_a_sample(self):
        # The last byte cannot start a window: PCM16 reads two bytes at a time.
        self.assertEqual(
            window_starts(WINDOW_BYTES * 2 + 1),
            window_starts(WINDOW_BYTES * 2),
        )


if __name__ == "__main__":
    unittest.main()
