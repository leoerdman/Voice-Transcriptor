"""The session-relative frame test had to work on a quiet microphone.

Measured on the owner's desk, 2026-11-19: speech at −23…−30 dBFS peak over a
−53 dBFS room, where the absolute `pcm_has_voice` floor left the gate with a
voiced share of 0.25 — never the 0.5 a refusal needs. These cases are the rule
the renderer already tests; the numbers here are the ones the desk produced.
"""

import array
import unittest

from backend.audio_levels import SessionVoice, frame_levels

RATE = 16_000
HOP_MS = 50
HOP_SAMPLES = RATE * HOP_MS // 1000


def tone(level: float, samples: int = HOP_SAMPLES) -> bytes:
    """A PCM16LE frame whose peak is ``level`` of full scale."""
    amplitude = int(round(level * 32767))
    return array.array("h", [amplitude if i % 2 else -amplitude for i in range(samples)]).tobytes()


ROOM = tone(0.0008)     # −62 dBFS: this desk's room between words
QUIET_SPEECH = tone(0.03)  # −30 dBFS: this desk's speech, the quiet end


class FrameLevelsTests(unittest.TestCase):
    def test_a_frame_reports_its_own_rms_and_peak(self):
        rms, peak = frame_levels(QUIET_SPEECH)
        self.assertAlmostEqual(peak, 0.03, places=3)
        self.assertAlmostEqual(rms, 0.03, places=3)

    def test_an_empty_or_odd_frame_is_silence_not_an_error(self):
        self.assertEqual(frame_levels(b""), (0.0, 0.0))
        self.assertEqual(frame_levels(b"\x00"), (0.0, 0.0))


class SessionVoiceTests(unittest.TestCase):
    def test_speech_well_below_half_scale_is_still_speech(self):
        # The whole point: 0.03 of full scale is the quiet end here, and the
        # absolute floor that Solo used to read called it nothing.
        session = SessionVoice()
        for _ in range(6):
            self.assertFalse(session(ROOM))
        self.assertTrue(session(QUIET_SPEECH))

    def test_a_steady_tone_never_becomes_speech_by_arriving(self):
        # A constant signal is a machine, not a person: the floor settles on
        # it and stops calling it speech.
        session = SessionVoice()
        verdicts = [session(ROOM) for _ in range(60)]
        self.assertFalse(any(verdicts[1:]))

    def test_a_phrase_does_not_lift_the_floor_it_is_judged_against(self):
        session = SessionVoice()
        for _ in range(20):
            session(ROOM)
        floor_before = session.floor_rms
        for _ in range(40):
            session(QUIET_SPEECH)
        self.assertAlmostEqual(session.floor_rms, floor_before, places=6)
        self.assertEqual(session.speech_frames, 40)

    def test_a_dead_pipeline_carries_no_speech(self):
        session = SessionVoice()
        silent = array.array("h", [0] * HOP_SAMPLES).tobytes()
        self.assertFalse(any(session(silent) for _ in range(10)))
        self.assertEqual(session.peak_max, 0.0)


if __name__ == "__main__":
    unittest.main()
