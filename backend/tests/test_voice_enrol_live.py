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

import tempfile
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
    """The three things the route and the payload helper touch."""

    def __init__(self):
        self.saved = []
        self._tmp = tempfile.TemporaryDirectory(prefix="vt-enrol-store-")

    def save(self, slot, name, vector, capture="", self_floor=0.0, level_db=0.0):
        self.saved.append((slot, name, np.asarray(vector), capture, self_floor, level_db))

    @property
    def captures_dir(self):
        from pathlib import Path

        return Path(self._tmp.name) / "voice_profiles"

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
        with mock.patch.object(app_main, "enrol_take_stats", return_value=(vector, 0.9)) as embed:
            payload = self.call(2, pcm(6.0))

        self.assertEqual(len(self.store.saved), 1)
        slot, name, saved, capture, floor, level = self.store.saved[0]
        self.assertEqual(slot, 2)
        # No filename reached this route, so no label was derived from one.
        self.assertEqual(name, "Voice 2")
        np.testing.assert_array_equal(saved, vector)
        self.assertEqual(embed.call_args.args[1], pcm(6.0))
        self.assertEqual(payload["slots"], [None, None, None])

    def test_the_embedder_is_closed_even_when_the_take_is_refused(self):
        with mock.patch.object(
            app_main, "enrol_take_stats", side_effect=EnrolmentError("no speech Solo could hear")
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
            app_main, "enrol_take_stats", return_value=(np.zeros(192, dtype=np.float32), 0.9)
        ) as embed:
            self.call(1, odd)

        handed = embed.call_args.args[1]
        self.assertEqual(len(handed) % 2, 0)
        self.assertEqual(len(handed), len(odd) - 1)

    def test_missing_weights_are_reported_as_the_missing_file_they_are(self):
        from pathlib import Path

        # A real path, not a mock: the refusal has to name the file it wants,
        # and a mocked `.name` would make that assertion pass on a repr.
        missing = Path("/nowhere/models/campplus_zh_en.onnx")
        with mock.patch.object(app_main, "default_model_path", return_value=missing):
            with self.assertRaises(HTTPException) as caught:
                self.call(1, pcm(6.0))

        self.assertEqual(caught.exception.status_code, 503)
        # Where it goes and what its absence costs — "not installed" on its own
        # sent the user looking for a setting that does not exist.
        self.assertIn("campplus_zh_en.onnx", caught.exception.detail)
        self.assertIn("models/", caught.exception.detail)
        self.assertIn("beside the app", caught.exception.detail)

    def test_a_store_that_refuses_the_slot_is_a_400_with_its_reason(self):
        with mock.patch.object(app_main, "enrol_take_stats", return_value=(np.zeros(192), 0.9)):
            self.store.save = mock.Mock(side_effect=ProfileError("that slot is not the store's"))
            with self.assertRaises(HTTPException) as caught:
                self.call(1, pcm(6.0))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("not the store's", caught.exception.detail)


class TheCardAndTheRouteAgreeTests(unittest.TestCase):
    """A press and the route that answers it agree on how much audio is enough."""

    def test_the_floor_is_the_number_the_button_counts(self):
        # The button counts to this number in the pane; the route refuses below
        # it. Two languages for one press, and this is the seam where they can
        # drift - a constant read, not a copy.
        self.assertEqual(app_main.CLAIM_MIN_SECONDS, 2.0)

class TheSpecAndTheCardAgreeTests(unittest.TestCase):
    """The contract file describes what runs, and says where the old design went.

    It used to check lines 5.5 and 7.4 of a document that still promised a
    six-second press in Settings and a room-derived scale - both removed. A spec
    that describes a discarded implementation is worse than no spec: it is the
    version the next reader trusts.
    """

    def setUp(self):
        from pathlib import Path

        docs = Path(__file__).resolve().parents[2] / "docs"
        self.doc = (docs / "SOLO.md").read_text(encoding="utf-8")
        self.archive = (docs / "archive" / "SOLO_FIRST_DESIGN.md").read_text(encoding="utf-8")

    def test_the_contract_names_the_press_and_its_floor(self):
        self.assertIn("That is me", self.doc)
        self.assertIn("Two seconds is the floor", self.doc)
        self.assertIn(f"{app_main.CLAIM_MIN_SECONDS:.0f}", self.doc)

    def test_the_contract_says_the_thresholds_are_derived(self):
        self.assertIn("derived, never chosen", self.doc)
        self.assertIn("thresholds_from_floor", self.doc)
        self.assertNotIn("hand-picked pair wins", self.doc)

    def test_the_contract_says_the_room_may_not_choose_the_owner(self):
        self.assertIn("The room may not choose the owner", self.doc)

    def test_the_old_design_is_archived_and_named_as_history(self):
        self.assertIn("six-second press", self.archive)
        self.assertIn("docs/archive/SOLO_FIRST_DESIGN.md", self.doc)
        self.assertIn("not** a description of what runs", self.doc)
        self.assertNotIn("six seconds recorded on the spot", self.doc)