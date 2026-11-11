"""The route a six-second capture lands on, without a microphone or a net.

The card records the press and posts the bytes; this module is the other end.
Everything here is the route called as a function, because what it has to get
right is arithmetic and refusal order, not URL parsing:

* a body shorter than the mask's window is refused *before* the embedder is
  built, so a press held for half a second does not pay for a model load;
* a body that is not even-length is trimmed to whole samples instead of being
  embedded a byte out of phase;
* the store's label is the slot's own name — there is no filename here to
  derive one from, and a label must never be why a press fails;
* the embedder is closed on every path, including the refusals.
"""

from __future__ import annotations

import unittest
from unittest import mock

import numpy as np
from fastapi import HTTPException

from backend import main as app_main
from backend.voice_enrol import EnrolmentError
from backend.voice_profiles import ProfileError


def pcm(seconds: float, level: int = 6000) -> bytes:
    """Alternating ±level at 16 kHz: the shape the mock embedder accepts."""
    samples = int(16_000 * seconds)
    return np.tile(np.array([level, -level], dtype="<i2"), samples // 2).tobytes()


class FakeEmbedder:
    """Counts builds and closes so a leak is visible in the test, not in prod."""

    built = 0
    closed = 0

    def __init__(self):
        FakeEmbedder.built += 1

    def close(self):
        FakeEmbedder.closed += 1


class FakeStore:
    """The two methods the route and the payload helper touch."""

    def __init__(self):
        self.saved = []

    def save(self, slot, name, vector):
        self.saved.append((slot, name, np.asarray(vector)))

    def slots(self):
        return [None, None, None]

    def enabled_slot(self):
        return None


class EnrolLiveRouteTests(unittest.TestCase):
    def setUp(self):
        FakeEmbedder.built = 0
        FakeEmbedder.closed = 0
        self.store = FakeStore()
        self.weights = mock.patch.object(
            app_main, "default_model_path", return_value=mock.MagicMock(is_file=lambda: True)
        )
        self.weights.start()
        self.addCleanup(self.weights.stop)
        for name, value in (
            ("SpeakerEmbedder", FakeEmbedder),
            ("VOICE_PROFILES", self.store),
        ):
            patcher = mock.patch.object(app_main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def call(self, slot: int = 1, audio: bytes = b"") -> dict:
        return app_main.enrol_voice_profile_live(slot, audio=audio, _auth=None)

    def test_a_capture_is_embedded_and_saved_under_the_slots_name(self):
        vector = np.ones(192, dtype=np.float32)
        with mock.patch.object(app_main, "enrol_take", return_value=vector) as embed:
            payload = self.call(2, pcm(6.0))

        self.assertEqual(len(self.store.saved), 1)
        slot, name, saved = self.store.saved[0]
        self.assertEqual(slot, 2)
        # No filename reached this route, so no label was derived from one.
        self.assertEqual(name, "Voice 2")
        np.testing.assert_array_equal(saved, vector)
        self.assertEqual(embed.call_args.args[1], pcm(6.0))
        self.assertEqual(payload["slots"], [None, None, None])

    def test_the_embedder_is_closed_even_when_the_take_is_refused(self):
        with mock.patch.object(
            app_main, "enrol_take", side_effect=EnrolmentError("no speech the mask could hear")
        ):
            with self.assertRaises(HTTPException) as caught:
                self.call(1, pcm(6.0))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("no speech", caught.exception.detail)
        self.assertEqual(FakeEmbedder.closed, FakeEmbedder.built)

    def test_a_body_under_two_seconds_is_refused_before_the_net_is_built(self):
        with self.assertRaises(HTTPException) as caught:
            self.call(1, pcm(1.5))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("two seconds", caught.exception.detail)
        # The refusal is arithmetic; paying for a model load to discover it
        # would make the shortest possible mistake the most expensive one.
        self.assertEqual(FakeEmbedder.built, 0)

    def test_a_body_longer_than_an_enrolment_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.call(1, pcm(app_main.ENROL_LIVE_MAX_SECONDS + 1))

        self.assertEqual(caught.exception.status_code, 400)
        # The message names the ceiling it enforces. Naming the card's six
        # seconds here was wrong: a body past thirty is not six seconds short
        # of an enrolment, it is a recording posted to the wrong route.
        self.assertIn(f"{app_main.ENROL_LIVE_MAX_SECONDS} seconds", caught.exception.detail)

    def test_a_half_sample_is_trimmed_rather_than_embedded_out_of_phase(self):
        odd = pcm(6.0) + b"\x01"
        with mock.patch.object(
            app_main, "enrol_take", return_value=np.zeros(192, dtype=np.float32)
        ) as embed:
            self.call(1, odd)

        handed = embed.call_args.args[1]
        self.assertEqual(len(handed) % 2, 0)
        self.assertEqual(len(handed), len(odd) - 1)

    def test_missing_weights_are_reported_as_the_missing_file_they_are(self):
        with mock.patch.object(
            app_main, "default_model_path", return_value=mock.MagicMock(is_file=lambda: False)
        ):
            with self.assertRaises(HTTPException) as caught:
                self.call(1, pcm(6.0))

        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("weights", caught.exception.detail)

    def test_a_store_that_refuses_the_slot_is_a_400_with_its_reason(self):
        with mock.patch.object(app_main, "enrol_take", return_value=np.zeros(192)):
            self.store.save = mock.Mock(side_effect=ProfileError("that slot is not the store's"))
            with self.assertRaises(HTTPException) as caught:
                self.call(1, pcm(6.0))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("not the store's", caught.exception.detail)


class TheCardAndTheRouteAgreeTests(unittest.TestCase):
    """Six seconds in the card, six seconds the route will take."""

    def test_the_span_the_card_offers_is_inside_what_the_route_accepts(self):
        # The number in `voice-enrol-prompt.ts` and the ceiling here are two
        # languages describing one press; this is the seam where they could
        # drift, and it is a file read rather than a copy.
        from pathlib import Path

        source = Path(__file__).resolve().parents[2] / "frontend" / "src" / "voice-enrol-prompt.ts"
        text = source.read_text(encoding="utf-8")
        self.assertIn("export const ENROL_SECONDS = 6;", text)
        self.assertEqual(app_main.ENROL_LIVE_SECONDS, 6)
        self.assertLessEqual(app_main.ENROL_LIVE_SECONDS, app_main.ENROL_LIVE_MAX_SECONDS)


class TheSpecAndTheCardAgreeTests(unittest.TestCase):
    """The document is what the reviewer reads first; it drifted twice.

    §5.5 said "a take becomes one by an act" and §7.4 said the press learned
    "from the latest take that still has audio" — both true of the first
    implementation, both false of the one that records. A spec that describes
    a discarded behaviour is worse than no spec: it is the version a reviewer
    trusts.
    """

    def setUp(self):
        from pathlib import Path

        self.doc = (
            Path(__file__).resolve().parents[2] / "docs" / "COWORK_MASK.md"
        ).read_text(encoding="utf-8")

    def test_the_press_is_described_as_a_recording_of_six_seconds(self):
        line = next(l for l in self.doc.splitlines() if l.startswith("5.5 "))
        self.assertIn("six seconds are recorded", line)
        self.assertNotIn("take becomes one", line)

    def test_the_settings_line_no_longer_learns_from_an_existing_take(self):
        line = next(l for l in self.doc.splitlines() if l.startswith("7.4 "))
        self.assertIn("records six seconds", line)
        self.assertNotIn("latest take", line)
        # What the user sees while it runs is part of the promise, so it is
        # part of the spec.
        self.assertIn("countdown", line)
        self.assertIn("Learning…", line)
        self.assertIn("thrown away", line)

    def test_the_numbers_in_the_spec_are_the_numbers_the_gate_runs(self):
        """§4.1 and §4.3 drifted from the code in opposite directions.

        The document said "a decision each 20-30 ms" and "300 ms tail"; the
        gate judges every 50 ms and holds half a window, because a 25 ms
        cadence cannot pay for a 38 ms judgement and a 300 ms tail cut 20 of
        the owner's own hops at a handover. Both sentences were true of an
        earlier build. They are pinned to constants now, so the next retune
        fails a test instead of quietly leaving the document behind.
        """
        from backend.voice_mask import (
            DEFAULT_CLOSE_AT,
            DEFAULT_HOP_MS,
            DEFAULT_OPEN_AT,
            DEFAULT_TAIL_MS,
            DEFAULT_WINDOW_MS,
        )

        window = next(l for l in self.doc.splitlines() if l.startswith("4.1 "))
        self.assertIn(f"{DEFAULT_WINDOW_MS // 1000} s", window)
        self.assertIn(f"{DEFAULT_HOP_MS} ms", window)

        tail = next(l for l in self.doc.splitlines() if l.startswith("4.3 "))
        self.assertIn("half a window", tail)
        self.assertEqual(DEFAULT_TAIL_MS * 2, DEFAULT_WINDOW_MS)

        thresholds = next(l for l in self.doc.splitlines() if l.startswith("4.5 "))
        self.assertIn(f"{DEFAULT_OPEN_AT:g}", thresholds)
        self.assertIn(f"{DEFAULT_CLOSE_AT:g}", thresholds)
        self.assertIn("measured", thresholds)
        self.assertNotIn("guesses until", thresholds)

    def test_the_spec_does_not_still_describe_the_room_that_was_removed(self):
        """COWORK_VOICE and its `voice-channel` frame are gone.

        The mask's state rides its own `voice-mask` frame now, and the room
        modules were deleted when the feature was cut back to the gate. A
        spec line naming a frame that no longer exists sends the next reader
        looking for a file that is not in the tree.
        """
        line = next(l for l in self.doc.splitlines() if l.startswith("2.1 "))
        self.assertIn("voice-mask", line)
        self.assertNotIn("channel event", line)

    def test_the_embedder_line_names_the_file_that_ships(self):
        """§7.2 said "when the survey lands"; the survey landed."""
        line = next(l for l in self.doc.splitlines() if l.startswith("7.2 "))
        self.assertIn("CAM++", line)
        self.assertNotIn("when the survey lands", line)
