"""§5.3 at the call site: the refusal reaches the renderer, in order.

``test_voice_mask_worker`` pins that the gate reports, and
``test_voice_mask_call_site`` pins the message's shape. Neither touches
the thing that actually matters to a user: whether the frame leaves the
session at all, and whether it leaves *before* the envelope that says
what the provider heard.

So this drives the real ``_run_deepgram_live_session`` over the fake
socket the send-queue tests already use, with the gate patched in. What
is pinned:

* a refusing gate puts a ``voice-mask`` frame with ``final: true`` and a
  non-zero total on the renderer's socket, ahead of ``final``;
* a gate that withheld nothing still says so (state, zero) — the pane
  decides not to draw, the backend does not decide not to tell;
* with no gate there is no frame at all (§3.5: the switch off runs the
  bytes and the protocol it always ran).
"""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest import mock

from backend.tests.test_deepgram_send_queue import _FakeUpstream, _FakeWebSocket
from backend.tests.test_live import IsolatedBackendMainImportMixin
from backend.voice_mask import VoiceMask

HOP = 1600  # one 50 ms write of 16 kHz mono PCM16


def _frames(seconds: float) -> list[bytes]:
    """PCM16LE hops, each sample non-zero so 'voiced' is unambiguous."""
    return [bytes([1, 0]) * (HOP // 2) for _ in range(int(seconds / 0.05))]


class VoiceMaskFrameTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        _FakeUpstream.instances.clear()

    async def _play(self, gate, seconds: float = 5.0) -> _FakeWebSocket:
        ws = _FakeWebSocket()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream):
            with mock.patch.object(
                self.main, "recording_voice_mask", return_value=gate
            ):
                task = asyncio.create_task(
                    self.main._run_deepgram_live_session(
                        websocket=ws,
                        api_key="dg",
                        model="nova-3",
                        language="auto",
                        diarize=False,
                        recovery=None,
                    )
                )
                await asyncio.sleep(0.02)
                for frame in _frames(seconds):
                    await ws.messages.put(
                        {"type": "websocket.receive", "bytes": frame}
                    )
                await asyncio.sleep(0.05)
                await ws.messages.put(
                    {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
                )
                await asyncio.wait_for(task, timeout=10.0)
        return ws

    def _frames_of(self, ws: _FakeWebSocket, kind: str) -> list[dict]:
        return [m for m in ws.sent if m.get("type") == kind]

    async def test_a_refusal_reaches_the_pane_before_the_envelope(self):
        ws = await self._play(VoiceMask(lambda _w: 0.0))
        reports = self._frames_of(ws, "voice-mask")
        self.assertTrue(reports, "a refused recording must be drawn, not silent")

        finals = [r for r in reports if r["final"]]
        self.assertEqual(len(finals), 1, "one total per recording")
        self.assertGreater(finals[0]["withheldSec"], 0.0)
        self.assertFalse(finals[0]["degraded"])

        # Ordering is the point of awaiting the report queue at finalize:
        # an envelope that arrives first makes the pane say "no transcript
        # for this audio" and then, a frame later, "because we held it".
        last_report = max(i for i, m in enumerate(ws.sent) if m.get("type") == "voice-mask")
        envelope = min(i for i, m in enumerate(ws.sent) if m.get("type") == "final")
        self.assertLess(last_report, envelope)

    async def test_the_total_is_what_the_provider_did_not_get(self):
        # 5 s in, the first 2 s fill the window and one more is the tail
        # (§4.3): ~2 s of held audio leaves zeroed with the rest of the
        # stream, so the honest total is around 4 s — and the assertion
        # is one-sided because the last window's release depends on where
        # the flush lands.
        ws = await self._play(VoiceMask(lambda _w: 0.0))
        final = [r for r in self._frames_of(ws, "voice-mask") if r["final"]][0]
        self.assertGreater(final["withheldSec"], 3.0)
        self.assertLessEqual(final["withheldSec"], 5.0)

        upstream = _FakeUpstream.instances[0]
        forwarded = b"".join(upstream.sent_pcm)
        self.assertEqual(len(forwarded), len(b"".join(_frames(5.0))))
        zeroed = sum(1 for i in range(0, len(forwarded), HOP) if not any(forwarded[i : i + HOP]))
        self.assertEqual(
            round(zeroed * HOP / 32000, 3), final["withheldSec"], "the count is the audio"
        )

    async def test_a_gate_that_withheld_nothing_still_reports(self):
        # The pane draws nothing when the total is zero — but it can only
        # draw that conclusion from a report, so the backend must send
        # one. A missing frame would be indistinguishable from "mask off".
        ws = await self._play(VoiceMask(lambda _w: 1.0))
        reports = self._frames_of(ws, "voice-mask")
        self.assertTrue(reports)
        final = [r for r in reports if r["final"]][0]
        self.assertEqual(final["state"], "open")
        self.assertEqual(final["withheldSec"], 0.0)

    async def test_off_puts_nothing_on_the_wire(self):
        # §3.5/§6.4: with the switch off the loop runs the bytes and the
        # protocol it always ran. No gate, no frame, no new field for a
        # client that never asked for one.
        ws = await self._play(None, seconds=2.0)
        self.assertEqual(self._frames_of(ws, "voice-mask"), [])
        self.assertTrue(self._frames_of(ws, "final"))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
