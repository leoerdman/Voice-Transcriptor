"""The call site's own promise: off is no object at all (§3.4, §6.4).

The gate can be perfect and still ship the wrong thing if the receive
path runs a filter that copies its input when the switch is off — that is
a whole extra pass over every byte of every recording, and it makes the
"off" recordings a different code path from the ones the tests pinned.
These cases are the whole of what the wiring decides: whether a gate
exists at all, what it reports, and where in the receive loop it sits.
"""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.tests.test_live import IsolatedBackendMainImportMixin
from backend.voice_mask import VoiceMask


def unit_vector(dim: int = 192) -> list[float]:
    return [0.0] * (dim - 1) + [1.0]


class RecordingGateTests(IsolatedBackendMainImportMixin, unittest.TestCase):
    def _store(self):
        return self.main.VOICE_PROFILES

    def test_off_is_no_object_at_all(self):
        # Nothing enabled, so nothing is built: the receive loop keeps
        # calling ``_offer_pcm`` and never allocates a gate (§6.4's "no
        # object to switch").
        self.assertIsNone(self._store().enabled_slot())
        self.assertIsNone(self.main.recording_voice_mask())

    def test_a_missing_file_turns_the_switch_into_nothing(self):
        # §6.2: whether the weights ship is the owner's decision, so a
        # store that names an owner and an install that has no file must
        # still record — unmasked, and loudly, never refused.
        self._store().save(1, "me", unit_vector())
        self._store().set_enabled(1)
        with mock.patch.object(
            self.main, "default_model_path", return_value=Path("no-such.onnx")
        ):
            with self.assertLogs("backend.main", level="WARNING") as logs:
                self.assertIsNone(self.main.recording_voice_mask())
        self.assertIn("unmasked", " ".join(logs.output))

    def test_an_owner_and_a_file_make_one_gate(self):
        self._store().save(3, "me", unit_vector())
        self._store().set_enabled(3)
        with tempfile.NamedTemporaryFile(suffix=".onnx") as weights:
            with mock.patch.object(
                self.main, "default_model_path", return_value=Path(weights.name)
            ):
                gate = self.main.recording_voice_mask()
        # Constructing the gate must not load the net: §2.2's laziness is
        # what keeps a recording that never reaches a window free, and the
        # file here is deliberately not a model.
        self.assertIsInstance(gate, VoiceMask)


class VoiceMaskEventTests(unittest.TestCase):
    """§5.3's line of state, as the wire sees it.

    The pane can only draw what this message says, so the shape is
    pinned here rather than left to whatever the session happened to
    pass along: a state, a total, the degrade flag, and whether the
    recording is over.
    """

    def _event(self, **kwargs):
        from backend.main import _voice_mask_event
        from backend.voice_mask_worker import MaskState

        return _voice_mask_event(MaskState(**kwargs))

    def test_a_refusal_carries_the_state_and_the_total(self):
        event = self._event(state="closed", withheld_sec=2.35)
        self.assertEqual(event["type"], "voice-mask")
        self.assertEqual(event["state"], "closed")
        self.assertAlmostEqual(event["withheldSec"], 2.35)
        self.assertFalse(event["degraded"])
        self.assertFalse(event["final"])

    def test_the_shape_is_exactly_these_five_fields(self):
        # The renderer parses this message and nothing else; a field that
        # appears later without a reader is a contract nobody checked,
        # and one that disappears breaks the pane silently.
        self.assertEqual(
            set(self._event(state="idle", withheld_sec=0.0)),
            {"type", "state", "withheldSec", "degraded", "final"},
        )

    def test_the_final_report_says_the_recording_is_over(self):
        event = self._event(state="closed", withheld_sec=4.0, degraded=True, final=True)
        self.assertTrue(event["final"])
        self.assertTrue(event["degraded"])


class TheTakeOnDiskIsNotMaskedTests(unittest.TestCase):
    """§1.3/§1.4: the gate sits AFTER the spool, never in front of it.

    Measured on the live socket: the three 12 s takes of ``uat_mask_live``
    left three 384000-byte files in ``live_recovery`` while only ~8 s of
    each reached whisper. The archive is the whole room — that is what
    makes the mask safe to use, and what makes the recovery pass able to
    re-process a take the gate cut.

    It is one line of ordering in each receive loop, which is exactly the
    kind of thing a later refactor moves without noticing: move the spool
    after ``_forward_pcm`` and every masked recording is archived with its
    neighbours erased, silently, and no test of the gate would fail.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.source = (Path(__file__).resolve().parents[2] / "backend" / "main.py").read_text(
            encoding="utf-8"
        )

    def _loop(self, name: str) -> str:
        start = self.source.index(f"async def {name}(")
        end = self.source.index("\nasync def ", start + 1)
        return self.source[start:end]

    def _assert_spooled_before_masked(self, loop: str) -> None:
        # Every hand-off in the loop carries bytes that reached the
        # spool first. ``_chunk`` is the one exception and it is not
        # really one: those frames were spooled by ``_preconnect_reader``
        # before they were ever put in ``pending_frames``, and the replay
        # only drains that deque — checked at the end.
        forwarded = re.findall(r"_forward_pcm\((\w+)\)", loop)
        self.assertTrue(forwarded, "the loop must hand audio on somewhere")
        for name in forwarded:
            if name == "_chunk":
                continue
            spool = f"_record_recovery_chunk(recovery, {name})"
            self.assertIn(spool, loop, "the raw chunk must reach the spool")
            self.assertLess(
                loop.index(spool),
                loop.index(f"_forward_pcm({name})"),
                "the raw chunk must reach the spool before the gate sees it",
            )
        # And the spool must be given the raw frame, not what the gate
        # returned: a masked copy in the archive is §1.4 inverted.
        self.assertNotIn("_record_recovery_chunk(recovery, masked", loop)
        # The replay may only drain what was already spooled on arrival.
        if "_forward_pcm(_chunk)" in loop:
            self.assertLess(
                loop.index("_record_recovery_chunk(recovery, data)"),
                loop.index("pending_frames.append(data)"),
                "pre-connect audio must be spooled before it is buffered",
            )

    def test_the_local_loop_spools_before_it_masks(self):
        self._assert_spooled_before_masked(self._loop("_run_local_live_session"))

    def test_the_provider_loop_spools_before_it_masks(self):
        self._assert_spooled_before_masked(self._loop("_run_deepgram_live_session"))

    def test_both_transports_run_the_same_gate(self):
        for name in ("_run_local_live_session", "_run_deepgram_live_session"):
            loop = self._loop(name)
            self.assertEqual(
                loop.count("gate = recording_voice_mask()"),
                1,
                f"{name} must build the one gate, not a second kind of it",
            )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
