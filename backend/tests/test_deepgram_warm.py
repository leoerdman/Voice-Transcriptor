"""One Deepgram socket, opened before the user needs it (audit §2.4/§3.7).

Connecting cost p50 880 ms / p90 1.2 s / max 9.7 s at the start of every
recording, plus one 12 s timeout during which 126 s of dictation went
into a stream that never existed. The pool moves that cost off the
critical path — and every test here exists because doing so introduces
a way to be wrong that a plain ``connect()`` did not have:

* adopting a socket opened with DIFFERENT parameters would silently
  transcribe with the wrong model, language or keyterms;
* adopting one authenticated with a rotated key would fail mid-stream;
* adopting a socket that has been dead for four minutes would lose the
  recording, and nothing about a half-open TCP connection says so;
* adopting one that already carried audio would shift every timestamp
  in the transcript, which is invisible in the output.
"""

from __future__ import annotations

import asyncio
import unittest
from dataclasses import dataclass, field
from typing import Optional

from backend.deepgram_warm import (
    WARM_KEEPALIVE_INTERVAL_SEC,
    WARM_KEEPALIVE_STALE_SEC,
    DeepgramWarmPool,
    pcm_has_voice,
)
from backend.remote_deepgram_live import (
    DeepgramLiveConfig,
    DeepgramLiveError,
    DeepgramLiveSession,
)


@dataclass
class FakeStats:
    connect_ms: Optional[float] = 100.0
    bytes_sent: int = 0
    bytes_offered: int = 0
    keepalives_sent: int = 0
    last_keepalive_at: Optional[float] = None


@dataclass
class FakeSession:
    """Everything the pool touches on a session, and nothing else."""

    api_key: str
    cfg: DeepgramLiveConfig
    stats: FakeStats = field(default_factory=FakeStats)
    is_closed: bool = False
    last_fatal: bool = False
    last_error: Optional[str] = None
    connect_error: Optional[Exception] = None
    connects: int = 0
    discarded: bool = False
    connect_gate: Optional[asyncio.Event] = None
    connect_entered: bool = False

    async def connect(self) -> None:
        self.connect_entered = True
        if self.connect_gate is not None:
            await self.connect_gate.wait()
        self.connects += 1
        if self.connect_error is not None:
            raise self.connect_error

    async def discard(self) -> None:
        self.discarded = True
        self.is_closed = True


class Clock:
    """A monotonic clock the test moves by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _cfg(**kwargs) -> DeepgramLiveConfig:
    base = dict(model="nova-3", language="ru", sample_rate=16000)
    base.update(kwargs)
    return DeepgramLiveConfig(**base)


class _PoolCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.created: list[FakeSession] = []
        # Applied to the NEXT session the factory builds, so a test can
        # make one connect fail or stall without reaching into the pool.
        self.next_connect_error: Optional[Exception] = None
        self.next_connect_gate: Optional[asyncio.Event] = None
        # Applied to EVERY session, for the cases that need two connects
        # held open at the same time.
        self.connect_gate_all: Optional[asyncio.Event] = None
        self.pool = DeepgramWarmPool(
            session_factory=self._factory, clock=self.clock,
        )

    def _factory(self, api_key: str, cfg: DeepgramLiveConfig) -> FakeSession:
        session = FakeSession(
            api_key=api_key,
            cfg=cfg,
            connect_error=self.next_connect_error,
            connect_gate=self.next_connect_gate or self.connect_gate_all,
        )
        self.next_connect_error = None
        self.next_connect_gate = None
        self.created.append(session)
        return session  # type: ignore[return-value]

    async def _warm(self, key: str = "k", cfg: Optional[DeepgramLiveConfig] = None):
        self.pool.start()
        self.pool.rewarm(key, cfg or _cfg())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        return self.created[-1]


class AdoptionTests(_PoolCase):
    async def test_a_matching_warm_socket_is_adopted(self):
        warm = await self._warm()
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertIs(acquisition.session, warm)
        self.assertTrue(acquisition.adopted)
        self.assertEqual(len(self.created), 1, "no second connect was made")

    async def test_adoption_is_logged_with_the_age_and_the_saving(self):
        await self._warm()
        self.clock.advance(12.0)
        with self.assertLogs("backend.deepgram_warm", level="INFO") as logs:
            acquisition = await self.pool.acquire("k", _cfg())
        line = next(m for m in logs.output if "adopted warm socket" in m)
        self.assertIn("age=12.0s", line)
        self.assertIn("saved ~100ms connect", line)
        self.assertAlmostEqual(acquisition.warm_age_sec, 12.0, places=3)

    async def test_a_different_configuration_gets_its_own_fresh_socket(self):
        # Slots are per configuration: a recording whose parameters do
        # not match anything warm connects fresh, and does NOT take the
        # other reading's socket down with it — that socket may be the
        # dual-stream partner of a recording about to start.
        warm = await self._warm()
        acquisition = await self.pool.acquire("k", _cfg(language="en"))
        self.assertFalse(acquisition.adopted)
        self.assertIsNot(acquisition.session, warm)
        self.assertFalse(warm.discarded)
        self.assertEqual(
            [row["configKey"] for row in self.pool.status()["sockets"]],
            [_cfg().to_query_string()],
        )

    async def test_two_configurations_can_be_warm_at_once(self):
        # The dual-stream shape: two readings of one recording, two
        # keys, both adopted without a connect.
        pool = self.pool
        pool.start()
        pool.rewarm("k", _cfg())
        pool.rewarm("k", _cfg(language="ru2"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(len(self.created), 2)
        first = await pool.acquire("k", _cfg())
        second = await pool.acquire("k", _cfg(language="ru2"))
        self.assertTrue(first.adopted)
        self.assertTrue(second.adopted)
        self.assertEqual(len(self.created), 2, "neither paid a connect")

    async def test_the_oldest_socket_is_evicted_at_the_bound(self):
        # Every warm socket is billed and holds a concurrency slot, so a
        # third one is not opened — the oldest is closed instead.
        pool = self.pool
        pool.start()
        for lang in ("a", "b", "c"):
            pool.rewarm("k", _cfg(language=lang))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        status = pool.status()
        self.assertEqual(len(status["sockets"]), pool.status()["maxSockets"])
        self.assertTrue(self.created[0].discarded, "the oldest was released")
        self.assertNotIn(
            _cfg(language="a").to_query_string(),
            [row["configKey"] for row in status["sockets"]],
        )

    async def test_keyterms_are_part_of_the_key(self):
        # They are on the wire (``to_query_string``) and they change the
        # transcript, so a socket opened without them is the wrong socket.
        await self._warm(cfg=_cfg(keyterms=("субагент",)))
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)

    async def test_a_rotated_api_key_is_not_reused(self):
        warm = await self._warm(key="old")
        acquisition = await self.pool.acquire("new", _cfg())
        self.assertFalse(acquisition.adopted)
        self.assertTrue(warm.discarded)
        self.assertEqual(acquisition.session.api_key, "new")

    async def test_a_socket_that_carried_audio_is_never_adopted(self):
        # The invariant the whole no-offset design rests on: Deepgram
        # times results from the audio a connection has received, so a
        # warm socket that carried any would shift the entire transcript.
        warm = await self._warm()
        warm.stats.bytes_sent = 3200
        with self.assertLogs("backend.deepgram_warm", level="INFO") as logs:
            acquisition = await self.pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)
        self.assertIn("timestamps would be shifted", "\n".join(logs.output))

    async def test_a_closed_socket_is_not_adopted(self):
        warm = await self._warm()
        warm.is_closed = True
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)

    async def test_a_socket_that_reported_a_fatal_error_is_not_adopted(self):
        warm = await self._warm()
        warm.last_fatal = True
        warm.last_error = "upstream said no"
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)

    async def test_a_socket_past_its_lifetime_bound_is_not_adopted(self):
        await self._warm()
        self.clock.advance(self.pool.status()["idleTtlSec"] + 1.0)  # noqa: E501
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)

    async def test_a_socket_whose_keepalives_stopped_is_not_adopted(self):
        # A half-open TCP connection accepts writes into a black hole and
        # Deepgram never answers a KeepAlive, so the last frame that
        # actually reached the wire is the only pre-adoption evidence
        # there is. Stale evidence is not evidence.
        warm = await self._warm()
        warm.stats.last_keepalive_at = self.clock.now
        self.clock.advance(WARM_KEEPALIVE_STALE_SEC + 1.0)
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)

    async def test_fresh_keepalives_keep_a_socket_adoptable(self):
        warm = await self._warm()
        self.clock.advance(60.0)
        warm.stats.last_keepalive_at = self.clock.now - 1.0
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertTrue(acquisition.adopted)


class UnarmedPoolTests(_PoolCase):
    async def test_an_unarmed_pool_is_a_plain_connect(self):
        # Importing the module, or driving the WS handler from a test,
        # must never leave a socket open.
        self.pool.rewarm("k", _cfg())
        await asyncio.sleep(0)
        self.assertEqual(self.created, [])
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)
        self.assertEqual(len(self.created), 1)

    async def test_a_missing_api_key_never_warms(self):
        self.pool.start()
        self.pool.rewarm("", _cfg())
        await asyncio.sleep(0)
        self.assertEqual(self.created, [])


class FailureTests(_PoolCase):
    async def test_a_failed_prewarm_is_invisible_to_the_next_recording(self):
        self.pool.start()
        self.next_connect_error = DeepgramLiveError("boom")
        self.pool.rewarm("k", _cfg())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        acquisition = await self.pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)
        self.assertEqual(len(self.created), 2, "the failure was not reused")
        self.assertIsNone(acquisition.session.connect_error)

    async def test_a_connect_failure_still_reaches_the_caller(self):
        # The handler's failure path (error + empty final + REST
        # fallback) must be unchanged by the pool sitting in front.
        self.pool.start()
        self.next_connect_error = DeepgramLiveError("no route to host")
        with self.assertRaises(DeepgramLiveError):
            await self.pool.acquire("k", _cfg())


class InFlightWarmTests(_PoolCase):
    async def test_acquire_waits_for_a_matching_connect_already_in_flight(self):
        # Starting a second connect behind the first would double the
        # worst case the user waits, for a socket that is at best as far
        # along as the one already open.
        self.pool.start()
        gate = asyncio.Event()
        self.next_connect_gate = gate
        self.pool.rewarm("k", _cfg())
        await asyncio.sleep(0)
        acquire = asyncio.create_task(self.pool.acquire("k", _cfg()))
        await asyncio.sleep(0)
        gate.set()
        acquisition = await acquire
        self.assertTrue(acquisition.adopted)
        self.assertEqual(len(self.created), 1)


class KeytermRetargetTests(_PoolCase):
    """The self-filling vocabulary changes the keyterm list behind the
    renderer's back. A warm socket opened with the old list must never
    be adopted (that holds by construction: the list is in the key) and
    must not linger either — it is swapped for the same reading with the
    new list, so the next recording still adopts a warm socket."""

    async def test_a_socket_with_the_old_list_is_replaced_by_one_with_the_new(self):
        old = await self._warm(cfg=_cfg(keyterms=("Sonnet",)))
        await self.pool.retarget_keyterms("k", ("Sonnet", "Deepgram"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertTrue(old.discarded, "the stale socket was released")
        fresh = self.created[-1]
        self.assertEqual(fresh.cfg.keyterms, ("Sonnet", "Deepgram"))
        self.assertEqual(fresh.cfg.language, "ru", "same reading, new list")
        acquisition = await self.pool.acquire("k", _cfg(keyterms=("Sonnet", "Deepgram")))
        self.assertTrue(acquisition.adopted)
        self.assertIs(acquisition.session, fresh)

    async def test_the_old_list_is_never_adopted_after_a_change(self):
        await self._warm(cfg=_cfg(keyterms=("Sonnet",)))
        acquisition = await self.pool.acquire("k", _cfg(keyterms=("Sonnet", "Deepgram")))
        self.assertFalse(acquisition.adopted)

    async def test_an_unchanged_list_leaves_the_socket_alone(self):
        warm = await self._warm(cfg=_cfg(keyterms=("Sonnet",)))
        await self.pool.retarget_keyterms("k", ("Sonnet",))
        await asyncio.sleep(0)
        self.assertFalse(warm.discarded)
        self.assertEqual(len(self.created), 1)

    async def test_a_model_without_keyterms_on_the_wire_is_left_alone(self):
        warm = await self._warm(cfg=_cfg(model="nova-2"))
        await self.pool.retarget_keyterms("k", ("Deepgram",))
        await asyncio.sleep(0)
        self.assertFalse(warm.discarded)
        self.assertEqual(len(self.created), 1)

    async def test_both_readings_of_a_dual_stream_are_retargeted(self):
        self.pool.start()
        self.pool.rewarm("k", _cfg(language="multi"))
        self.pool.rewarm("k", _cfg(language="ru"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await self.pool.retarget_keyterms("k", ("Deepgram",))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        keys = sorted(row["configKey"] for row in self.pool.status()["sockets"])
        self.assertEqual(
            keys,
            sorted(
                _cfg(language=lang, keyterms=("Deepgram",)).to_query_string()
                for lang in ("multi", "ru")
            ),
        )

    async def test_a_connect_in_flight_with_the_old_list_is_restarted(self):
        self.pool.start()
        gate = asyncio.Event()
        self.next_connect_gate = gate
        self.pool.rewarm("k", _cfg())
        await asyncio.sleep(0)
        await self.pool.retarget_keyterms("k", ("Deepgram",))
        gate.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        keys = [row["configKey"] for row in self.pool.status()["sockets"]]
        self.assertEqual(keys, [_cfg(keyterms=("Deepgram",)).to_query_string()])

    async def test_without_an_api_key_stale_sockets_are_only_released(self):
        warm = await self._warm(cfg=_cfg(keyterms=("Sonnet",)))
        await self.pool.retarget_keyterms("", ("Deepgram",))
        await asyncio.sleep(0)
        self.assertTrue(warm.discarded)
        self.assertEqual(self.pool.status()["sockets"], [])

    async def test_an_unarmed_pool_does_nothing(self):
        await self.pool.retarget_keyterms("k", ("Deepgram",))
        self.assertEqual(self.created, [])


class LifecycleTests(_PoolCase):
    async def test_close_all_releases_the_socket_and_disarms(self):
        warm = await self._warm()
        await self.pool.close_all()
        self.assertTrue(warm.discarded)
        self.assertFalse(self.pool.status()["armed"])
        self.assertEqual(self.pool.status()["sockets"], [])

    async def test_the_ttl_reaper_closes_an_idle_socket(self):
        pool = DeepgramWarmPool(
            session_factory=self._factory, clock=self.clock, idle_ttl_sec=0.01,
        )
        pool.start()
        pool.rewarm("k", _cfg())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        warm = self.created[-1]
        await asyncio.sleep(0.05)
        self.assertTrue(warm.discarded)
        self.assertEqual(pool.status()["sockets"], [])
        await pool.close_all()

    async def test_a_recording_after_the_idle_bound_says_why_it_connected_cold(self):
        # 43 of the 49 cold second readings of 20-22.11 came more than
        # WARM_IDLE_TTL_SEC after the previous recording: by design, and
        # now said so on the line instead of a bare ``adopted=False``.
        pool = DeepgramWarmPool(
            session_factory=self._factory, clock=self.clock, idle_ttl_sec=0.01,
        )
        pool.start()
        pool.rewarm("k", _cfg())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await asyncio.sleep(0.05)
        self.clock.advance(400.0)
        with self.assertLogs("backend.deepgram_warm", level="INFO") as logs:
            acquisition = await pool.acquire("k", _cfg())
        self.assertFalse(acquisition.adopted)
        self.assertIn("400s ago: discarded: idle for 0s", acquisition.cold_reason)
        line = next(m for m in logs.output if "cold connect" in m)
        self.assertIn("[ru] cold connect in 100ms reason=last warm socket 400s ago", line)
        await pool.close_all()

    async def test_cold_reasons_name_what_became_of_the_warm_socket(self):
        cold = await self.pool.acquire("k", _cfg())
        self.assertEqual(cold.cold_reason, "warm pool not armed")

        await self._warm()
        adopted = await self.pool.acquire("k", _cfg())
        self.assertTrue(adopted.adopted)
        self.assertEqual(adopted.cold_reason, "")
        again = await self.pool.acquire("k", _cfg())
        self.assertIn("adopted by the previous recording", again.cold_reason)

        never = await self.pool.acquire("k", _cfg(language="en"))
        self.assertEqual(never.cold_reason, "no warm socket was opened for this configuration")

        warm = await self._warm(cfg=_cfg(language="ru"))
        warm.last_fatal = True
        warm.last_error = "upstream said no"
        unfit = await self.pool.acquire("k", _cfg(language="ru"))
        self.assertIn("discarded: socket reported a fatal error", unfit.cold_reason)

        self.next_connect_error = RuntimeError("dns down")
        self.pool.rewarm("k", _cfg(language="de"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        failed = await self.pool.acquire("k", _cfg(language="de"))
        self.assertIn("pre-warm connect failed: dns down", failed.cold_reason)

    async def test_a_second_rewarm_for_the_same_config_is_a_no_op(self):
        await self._warm()
        self.pool.rewarm("k", _cfg())
        await asyncio.sleep(0)
        self.assertEqual(len(self.created), 1)


class StatusTests(_PoolCase):
    async def test_status_reports_a_healthy_warm_socket(self):
        await self._warm()
        self.clock.advance(3.0)
        status = self.pool.status()
        self.assertTrue(status["armed"])
        self.assertEqual(len(status["sockets"]), 1)
        row = status["sockets"][0]
        self.assertEqual(row["state"], "warm")
        self.assertEqual(row["configKey"], _cfg().to_query_string())
        self.assertAlmostEqual(row["ageSec"], 3.0, places=3)
        self.assertTrue(row["healthy"])
        self.assertIsNone(row["unfitReason"])

    async def test_status_names_why_a_socket_would_not_be_adopted(self):
        warm = await self._warm()
        warm.is_closed = True
        row = self.pool.status()["sockets"][0]
        self.assertFalse(row["healthy"])
        self.assertEqual(row["unfitReason"], "socket already closed")

    async def test_status_on_an_empty_pool(self):
        status = self.pool.status()
        self.assertEqual(status["sockets"], [])
        self.assertFalse(status["armed"])


class VoiceDetectionTests(unittest.TestCase):
    """The probe clock starts at speech, not at the first frame."""

    def test_digital_silence_is_not_voice(self):
        self.assertFalse(pcm_has_voice(b"\x00\x00" * 800))

    def test_room_noise_is_not_voice(self):
        quiet = b"".join(int(120).to_bytes(2, "little", signed=True) for _ in range(800))
        self.assertFalse(pcm_has_voice(quiet))

    def test_speech_is_voice(self):
        loud = b"".join(
            int(8000 if i % 2 else -8000).to_bytes(2, "little", signed=True)
            for i in range(800)
        )
        self.assertTrue(pcm_has_voice(loud))

    def test_a_negative_full_scale_sample_does_not_overflow(self):
        frame = int(-32768).to_bytes(2, "little", signed=True) * 4
        self.assertTrue(pcm_has_voice(frame))

    def test_an_odd_length_frame_is_handled(self):
        self.assertFalse(pcm_has_voice(b"\x00"))
        self.assertFalse(pcm_has_voice(b""))


def _results(start: float, duration: float, text: str, words, *, is_final: bool):
    return {
        "type": "Results",
        "is_final": is_final,
        "speech_final": is_final,
        "start": start,
        "duration": duration,
        "channel": {
            "alternatives": [
                {
                    "transcript": text,
                    "words": [
                        {"word": w, "start": a, "end": b} for w, a, b in words
                    ],
                }
            ]
        },
    }


class AudioOffsetTests(unittest.IsolatedAsyncioTestCase):
    """A session that took over mid-recording reports recording time.

    The replacement socket built by ``backend.main``'s liveness swap is
    replayed a bounded ring, so it starts wherever the ring starts.
    Deepgram times its results from the audio IT received, so without a
    shift the transcript would be internally consistent and globally
    wrong — the failure mode that is invisible in the output.
    """

    OFFSET = 4.0

    def _session(self, offset: float) -> DeepgramLiveSession:
        session = DeepgramLiveSession(api_key="k", audio_offset_sec=offset)
        # 2.0 s of audio delivered to THIS socket.
        session.stats.bytes_sent = int(2.0 * 2 * session._cfg.sample_rate)
        session.stats.bytes_offered = session.stats.bytes_sent
        return session

    def test_segments_and_their_words_are_shifted(self):
        s = self._session(self.OFFSET)
        s._process_deepgram_message(
            _results(0.0, 2.0, "привет мир",
                     [("привет", 0.10, 0.90), ("мир", 1.00, 1.80)],
                     is_final=True)
        )
        seg = s._finalized_segments[0]
        self.assertAlmostEqual(seg["start"], 4.0, places=3)
        self.assertAlmostEqual(seg["end"], 6.0, places=3)
        self.assertAlmostEqual(seg["words"][0]["start"], 4.10, places=3)
        self.assertAlmostEqual(seg["words"][1]["end"], 5.80, places=3)

    def test_interim_words_and_speech_spans_are_shifted(self):
        s = self._session(self.OFFSET)
        s._process_deepgram_message(
            _results(0.0, 2.0, "услышанное но ещё не финальное",
                     [("услышанное", 0.10, 0.90)], is_final=False)
        )
        self.assertAlmostEqual(s._interim_words[0]["start"], 4.10, places=3)
        self.assertAlmostEqual(s._interim_speech_spans[0][0], 4.10, places=3)

    def test_the_utterance_end_signal_is_shifted(self):
        s = self._session(self.OFFSET)
        s._process_deepgram_message(
            {"type": "UtteranceEnd", "last_word_end": 1.5}
        )
        self.assertAlmostEqual(s._last_utterance_end, 5.5, places=3)

    def test_coverage_is_measured_on_one_timeline(self):
        # Both halves shift together, or the tail gap between them is
        # fiction: 4 s of dropped prefix plus 2 s streamed here is 6 s of
        # recording, and a final ending at 6 s covers all of it.
        s = self._session(self.OFFSET)
        s._process_deepgram_message(
            _results(0.0, 2.0, "всё покрыто", [("всё", 0.1, 0.5)], is_final=True)
        )
        streamed, covered, gap, _speech = s._tail_coverage()
        self.assertAlmostEqual(streamed, 6.0, places=3)
        self.assertAlmostEqual(covered, 6.0, places=3)
        self.assertAlmostEqual(gap, 0.0, places=3)

    async def test_the_envelope_reports_recording_time(self):
        s = self._session(self.OFFSET)
        s._process_deepgram_message(
            _results(0.0, 2.0, "всё покрыто", [("всё", 0.1, 0.5)], is_final=True)
        )
        drained = await s.drain_transcript()
        self.assertAlmostEqual(drained["streamedSec"], 6.0, places=3)
        self.assertAlmostEqual(drained["coveredEndSec"], 6.0, places=3)
        self.assertAlmostEqual(drained["durationSec"], 6.0, places=3)

    async def test_no_offset_leaves_every_number_untouched(self):
        # The normal case, and the case for an ADOPTED warm socket: it
        # carried no audio, so the recording still starts at zero.
        s = self._session(0.0)
        s._process_deepgram_message(
            _results(0.0, 2.0, "всё покрыто", [("всё", 0.1, 0.5)], is_final=True)
        )
        seg = s._finalized_segments[0]
        self.assertEqual((seg["start"], seg["end"]), (0.0, 2.0))
        self.assertEqual(seg["words"][0]["start"], 0.1)
        drained = await s.drain_transcript()
        self.assertAlmostEqual(drained["streamedSec"], 2.0, places=3)


class ConcurrentAcquireTests(_PoolCase):
    """The pool lock guards bookkeeping, never a connect (B-003).

    A dual-stream recording acquires two configurations. Held across
    ``connect()``, the pool's own lock made those two connects run back
    to back — up to 12 s each — so the feature ``WARM_MAX_SOCKETS = 2``
    was written for paid double the latency the pool exists to remove,
    and no amount of concurrency in the caller could change it.
    """

    async def test_two_configurations_connect_at_the_same_time(self):
        gate = asyncio.Event()
        self.connect_gate_all = gate
        first = asyncio.ensure_future(self.pool.acquire("k", _cfg()))
        second = asyncio.ensure_future(
            self.pool.acquire("k", _cfg(language="en"))
        )
        for _ in range(6):
            await asyncio.sleep(0)
        try:
            self.assertEqual(
                len(self.created), 2, "the second acquire never reached connect"
            )
            self.assertTrue(
                all(session.connect_entered for session in self.created),
                "one connect was still queued behind the other",
            )
        finally:
            gate.set()
            results = await asyncio.gather(first, second)
        self.assertEqual([r.adopted for r in results], [False, False])

    async def test_a_stalled_connect_does_not_block_an_adoption(self):
        # The other half of the same defect: a warm socket that is ready
        # to be adopted was unreachable while an unrelated configuration
        # was connecting.
        warm = await self._warm()
        gate = asyncio.Event()
        self.connect_gate_all = gate
        stalled = asyncio.ensure_future(
            self.pool.acquire("k", _cfg(language="en"))
        )
        for _ in range(4):
            await asyncio.sleep(0)
        acquisition = await asyncio.wait_for(
            self.pool.acquire("k", _cfg()), timeout=1.0
        )
        self.assertIs(acquisition.session, warm)
        self.assertTrue(acquisition.adopted)
        gate.set()
        await stalled


class CancelledConnectTests(_PoolCase):
    """No cancellation may leave a live, billed socket behind (B-013).

    Every warm socket is a real connection the user is billed for and
    which holds a slot against the account's concurrency limit, so a
    connect that is abandoned has to be closed rather than dropped. Two
    shapes: a warm connect cancelled by a key change, and an
    ``acquire()`` whose CALLER is cancelled while the connect runs.
    """

    async def test_a_warm_connect_cancelled_by_a_key_change_closes_its_socket(self):
        gate = asyncio.Event()
        self.next_connect_gate = gate
        self.pool.start()
        self.pool.rewarm("old-key", _cfg())
        await asyncio.sleep(0)
        warming = self.created[-1]
        gate.set()

        acquisition = await self.pool.acquire("new-key", _cfg())

        self.assertTrue(
            warming.discarded,
            "the socket of the cancelled warm connect leaked",
        )
        self.assertIsNot(acquisition.session, warming)
        self.assertEqual(acquisition.session.api_key, "new-key")

    async def test_an_acquire_cancelled_after_its_connect_returned_closes_it(self):
        # The reachable half: ``cancel()`` cannot unwind a connect that
        # has already returned, so the caller going away — uvicorn
        # shutting down, the renderer disconnecting — used to abandon a
        # connected socket for the lifetime of the process.
        gate = asyncio.Event()
        self.connect_gate_all = gate
        task = asyncio.ensure_future(self.pool.acquire("k", _cfg()))
        await asyncio.sleep(0)
        opened = self.created[-1]
        gate.set()
        # The connect completes; the awaiting acquire is cancelled
        # before it is resumed with the result.
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        for _ in range(3):
            await asyncio.sleep(0)
        self.assertTrue(opened.discarded, "the connected socket was abandoned")


class KeepAliveCadenceTests(unittest.TestCase):
    """The cadence the warm socket is opened with, per Deepgram's docs.

    "If no audio data or ``KeepAlive`` messages are sent within a
    10-second window, the connection will close with a ``NET-0001``
    error"; "Send a ``KeepAlive`` message every 3-5 seconds". A warm
    socket sends no audio at all, so the KeepAlive is the only thing
    holding it open and it must sit inside that window.
    """

    def test_the_warm_cadence_is_inside_the_documented_window(self):
        self.assertGreaterEqual(WARM_KEEPALIVE_INTERVAL_SEC, 3.0)
        self.assertLessEqual(WARM_KEEPALIVE_INTERVAL_SEC, 5.0)

    def test_the_staleness_bound_allows_two_missed_cadences(self):
        self.assertGreater(WARM_KEEPALIVE_STALE_SEC, 2 * WARM_KEEPALIVE_INTERVAL_SEC)


class DiscardTests(unittest.IsolatedAsyncioTestCase):
    """Replacing a socket on purpose is not a failure to report."""

    async def test_a_discarded_session_reports_no_error_to_the_consumer(self):
        session = DeepgramLiveSession(api_key="k")
        await session.discard()
        session._report_error("upstream closed during teardown", fatal=True)
        self.assertIsNone(session.last_error)
        self.assertFalse(session.last_fatal)

    async def test_discard_closes_the_session(self):
        session = DeepgramLiveSession(api_key="k")
        await session.discard()
        self.assertTrue(session.is_closed)


# ---------------------------------------------------------------------
# The handler half: liveness after adoption, replay, and re-warming.
# ---------------------------------------------------------------------


class _WarmFakeStats:
    def __init__(self) -> None:
        self.bytes_sent = 0
        self.bytes_offered = 0
        self.chunks_sent = 0
        self.segments_final = 1
        self.segments_interim = 0
        self.connect_ms = 1.0
        self.finalize_ms = 1.0
        self.last_keepalive_at = None
        self.keepalives_sent = 0
        # The one signal the liveness probe reads: when Deepgram last
        # said anything at all on this socket.
        self.last_recv_at: Optional[float] = None

    def as_dict(self) -> dict:
        return {}


class _WarmFakeUpstream:
    """A Deepgram session that can be made to answer, or never to."""

    instances: list["_WarmFakeUpstream"] = []

    def __init__(self, *_a, audio_offset_sec: float = 0.0, **_kw) -> None:
        self.stats = _WarmFakeStats()
        self.audio_offset_sec = audio_offset_sec
        self.sent_pcm: list[bytes] = []
        self.discarded = False
        self._closed = False
        self.last_error = None
        self.last_fatal = False
        self.drain_called = False
        self._events: "asyncio.Queue[Optional[dict]]" = asyncio.Queue()
        _WarmFakeUpstream.instances.append(self)

    async def connect(self) -> None:
        return None

    async def send_pcm(self, chunk: bytes) -> None:
        if self._closed:
            return
        self.sent_pcm.append(bytes(chunk))
        self.stats.bytes_sent += len(chunk)
        self.stats.bytes_offered += len(chunk)

    def answer(self) -> None:
        """Deepgram said something on this socket."""
        import time as _time

        self.stats.last_recv_at = _time.monotonic()

    def note_undelivered_audio(self, nbytes: int) -> None:
        self.stats.bytes_offered += nbytes

    def report_fatal(self, message: str) -> None:
        self.last_error = message
        self.last_fatal = True
        self._closed = True
        self._events.put_nowait({"type": "error", "error": message, "fatal": True})

    async def events(self):
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def drain_transcript(self, on_budget=None):
        self.drain_called = True
        return {
            "text": "ok", "segments": [], "durationSec": 0.0, "stats": {},
            "uncoveredSpeechSec": 0.0, "streamedSec": 0.0, "coveredEndSec": 0.0,
        }

    # The four coverage questions ``deepgram_recovery`` asks of any
    # session it is handed. Answered as "this reading covered
    # everything", which is what these tests are about — without them
    # every case here logged an AttributeError traceback and the
    # recovery pass was never actually exercised.
    def coverage_hole_spans(self) -> list:
        return []

    def interim_speech_spans(self) -> list:
        return []

    @property
    def interim_window_end(self) -> float:
        return 0.0

    @property
    def endpointing_sec(self) -> float:
        return 0.3

    @property
    def last_utterance_end(self):
        return None

    @property
    def utterance_end_sec(self) -> float:
        return 2.0

    @property
    def stream_death_sec(self):
        return None

    async def shutdown(self, wait_timeout: float = 3.0) -> None:
        await self.close()

    async def discard(self) -> None:
        self.discarded = True
        await self.close()

    async def close(self) -> None:
        self._closed = True
        self._events.put_nowait(None)

    @property
    def is_closed(self) -> bool:
        return self._closed

    @property
    def sent_bytes(self) -> bytes:
        return b"".join(self.sent_pcm)


class _GatedConnectUpstream(_WarmFakeUpstream):
    """Like ``_WarmFakeUpstream``, but the SECOND socket connects slowly.

    The first instance is the adopted (dead) socket; the second is the
    replacement a warm-socket swap connects, and gating it is how a swap
    is made to still be running when the stop arrives.
    """

    gate: "Optional[asyncio.Event]" = None

    async def connect(self) -> None:
        gate = _GatedConnectUpstream.gate
        if gate is not None and len(_WarmFakeUpstream.instances) > 1:
            await gate.wait()


class _WarmFakeWebSocket:
    def __init__(self) -> None:
        self.messages: "asyncio.Queue[dict]" = asyncio.Queue()
        self.sent: list[dict] = []

    async def receive(self):
        return await self.messages.get()

    async def send_text(self, text: str) -> None:
        import json as _json

        self.sent.append(_json.loads(text))


def _voiced(nbytes: int, seed: int = 1) -> bytes:
    """A PCM frame loud enough to arm the probe."""
    sample = int(9000 if seed % 2 else -9000).to_bytes(2, "little", signed=True)
    return sample * (nbytes // 2)


def _silence(nbytes: int) -> bytes:
    return b"\x00\x00" * (nbytes // 2)


class _WarmHandlerCase(unittest.IsolatedAsyncioTestCase):
    """A ``backend.main`` imported against a scratch data dir, and the
    plumbing to drive one WebSocket recording through it."""

    def setUp(self) -> None:
        import importlib
        import os
        import sys
        import tempfile

        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        os.environ["TRANSCRIPTOR_DATA_DIR"] = self._tmp.name
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")
        _WarmFakeUpstream.instances.clear()

    def tearDown(self) -> None:
        import os
        import sys

        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        self._tmp.cleanup()

    def _recovery(self) -> dict:
        import io

        return {"pcm_file": io.BytesIO(), "bytes": 0, "chunks": 0, "had_error": False}

    def _run(self, ws, recovery, dual_language: str = ""):
        return asyncio.create_task(
            self.main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
                dual_language=dual_language,
            )
        )

    async def _finish(self, ws, task) -> None:
        import json as _json

        await ws.messages.put(
            {"type": "websocket.receive", "text": _json.dumps({"type": "finalize"})}
        )
        await asyncio.wait_for(task, timeout=5.0)

    async def _armed_pool(self):
        """A pool holding one warm ``_WarmFakeUpstream``."""
        pool = self.main.DEEPGRAM_WARM_POOL
        pool.start()
        pool.rewarm("dg", self.main.live_config(
            model="nova-3", language="auto", diarize=False, keyterms=(),
        ))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(len(_WarmFakeUpstream.instances), 1)
        return pool

class WarmSessionLivenessTests(_WarmHandlerCase):
    """§3.7: an adopted socket has proven nothing until it answers.

    A socket opened four minutes ago can be dead with nothing having
    raised — writes into a half-open TCP connection succeed and Deepgram
    never answers a ``KeepAlive``. The only positive evidence is a
    message coming back, and the only moment one is owed is after audio
    that actually contains speech.
    """

    async def test_a_warm_socket_that_answers_is_kept(self):
        from unittest import mock as _mock

        ws = _WarmFakeWebSocket()
        with _mock.patch.object(self.main, "DeepgramLiveSession", _WarmFakeUpstream), \
                _mock.patch.object(self.main, "_WARM_PROBE_TIMEOUT_SEC", 0.15), \
                _mock.patch.object(self.main, "_WARM_PROBE_POLL_SEC", 0.01):
            pool = await self._armed_pool()
            warm = _WarmFakeUpstream.instances[0]
            task = self._run(ws, self._recovery())
            await asyncio.sleep(0.02)
            await ws.messages.put(
                {"type": "websocket.receive", "bytes": _voiced(1600)}
            )
            await asyncio.sleep(0.02)
            warm.answer()
            await asyncio.sleep(0.1)
            await ws.messages.put(
                {"type": "websocket.receive", "bytes": _voiced(1600, seed=2)}
            )
            await self._finish(ws, task)
            await pool.close_all()

        self.assertFalse(warm.discarded, "a live socket must not be replaced")
        # The re-warm after the recording is the only other session.
        self.assertLessEqual(len(_WarmFakeUpstream.instances), 2)
        self.assertEqual(len(warm.sent_bytes), 3200)

    async def test_a_silent_warm_socket_is_replaced_and_the_audio_replayed(self):
        from unittest import mock as _mock

        ws = _WarmFakeWebSocket()
        with _mock.patch.object(self.main, "DeepgramLiveSession", _WarmFakeUpstream), \
                _mock.patch.object(self.main, "_WARM_PROBE_TIMEOUT_SEC", 0.1), \
                _mock.patch.object(self.main, "_WARM_PROBE_POLL_SEC", 0.01):
            pool = await self._armed_pool()
            warm = _WarmFakeUpstream.instances[0]
            task = self._run(ws, self._recovery())
            await asyncio.sleep(0.02)
            first = _voiced(1600)
            await ws.messages.put({"type": "websocket.receive", "bytes": first})
            # Nothing answers: the probe expires and the sender swaps.
            await asyncio.sleep(0.3)
            second = _voiced(1600, seed=2)
            await ws.messages.put({"type": "websocket.receive", "bytes": second})
            await asyncio.sleep(0.05)
            await self._finish(ws, task)
            await pool.close_all()

        self.assertTrue(warm.discarded, "the dead socket must be discarded")
        replacement = _WarmFakeUpstream.instances[1]
        self.assertEqual(
            replacement.sent_bytes, first + second,
            "the replacement must receive the swallowed audio and then the rest",
        )
        self.assertEqual(replacement.audio_offset_sec, 0.0)
        errors = [m for m in ws.sent if m.get("type") == "error"]
        self.assertEqual(errors, [], "the swap is a recovery, not a failure")

    async def test_audio_dropped_during_a_swap_is_declared_to_the_replacement(self):
        """BW-09: audio the send queue had to drop while the replacement
        was connecting was declared to the socket about to be discarded,
        so the surviving session's coverage never counted it."""
        from unittest import mock as _mock

        release = asyncio.Event()

        class _SlowReplacement(_WarmFakeUpstream):
            undelivered = 0

            async def connect(self) -> None:
                if len(_WarmFakeUpstream.instances) > 1:
                    await release.wait()

            def note_undelivered_audio(self, nbytes: int) -> None:
                self.undelivered += nbytes
                super().note_undelivered_audio(nbytes)

        ws = _WarmFakeWebSocket()
        with _mock.patch.object(self.main, "DeepgramLiveSession", _SlowReplacement), \
                _mock.patch.object(self.main, "_WARM_PROBE_TIMEOUT_SEC", 0.1), \
                _mock.patch.object(self.main, "_WARM_PROBE_POLL_SEC", 0.01), \
                _mock.patch.object(self.main, "_SEND_QUEUE_MAX_BYTES", 2000):
            pool = await self._armed_pool()
            warm = _WarmFakeUpstream.instances[0]
            task = self._run(ws, self._recovery())
            await asyncio.sleep(0.02)
            await ws.messages.put({"type": "websocket.receive", "bytes": _voiced(1600)})
            # The probe expires and the swap starts connecting.
            for _ in range(300):
                if len(_WarmFakeUpstream.instances) > 1:
                    break
                await asyncio.sleep(0.01)
            for i in range(5):
                await ws.messages.put(
                    {"type": "websocket.receive", "bytes": _voiced(1600, seed=10 + i)}
                )
            await asyncio.sleep(0.2)
            release.set()
            await asyncio.sleep(0.1)
            await self._finish(ws, task)
            await pool.close_all()

        replacement = _WarmFakeUpstream.instances[1]
        self.assertTrue(warm.discarded)
        self.assertGreater(replacement.undelivered, 0, "the drop was not declared to the survivor")
        self.assertEqual(warm.undelivered, 0, "the drop was declared to the discarded socket")

    async def test_a_replayed_ring_that_dropped_audio_offsets_the_replacement(self):
        # A user who opens the microphone and thinks for a while streams
        # silence the ring cannot keep. What it drops is accounted for
        # as an offset, so the replacement's timestamps still describe
        # the recording rather than its own connection.
        from unittest import mock as _mock

        ws = _WarmFakeWebSocket()
        with _mock.patch.object(self.main, "DeepgramLiveSession", _WarmFakeUpstream), \
                _mock.patch.object(self.main, "_WARM_PROBE_TIMEOUT_SEC", 0.1), \
                _mock.patch.object(self.main, "_WARM_PROBE_POLL_SEC", 0.01), \
                _mock.patch.object(self.main, "_WARM_REPLAY_MAX_BYTES", 3200):
            pool = await self._armed_pool()
            task = self._run(ws, self._recovery())
            await asyncio.sleep(0.02)
            # 6400 bytes through a 3200-byte ring: 3200 fall off.
            for i in range(4):
                await ws.messages.put(
                    {"type": "websocket.receive", "bytes": _voiced(1600, seed=i)}
                )
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.3)
            with self.assertLogs("backend.main", level="INFO") as logs:
                await self._finish(ws, task)
            await pool.close_all()

        replacement = _WarmFakeUpstream.instances[1]
        # 3200 bytes of 16 kHz PCM16 is 0.1 s.
        self.assertAlmostEqual(replacement.audio_offset_sec, 0.1, places=6)
        self.assertEqual(len(replacement.sent_bytes), 3200)
        # B-010: the completion log states the number the ENVELOPE
        # carries. It used to recompute it from ``bytes_sent`` with its
        # own arithmetic, which omitted the offset the swap introduced —
        # so a socket-swapped recording was logged as having streamed
        # less than the renderer was told it had.
        envelope = next(m for m in ws.sent if m.get("type") == "final")
        complete = next(
            line for line in logs.output if "session complete" in line
        )
        self.assertIn(
            "streamed_sec=%.1f" % float(envelope["streamedSec"]), complete
        )

    async def test_silence_alone_never_arms_the_probe(self):
        # Deepgram is entitled to answer silence with nothing, so a slow
        # start must not cost a perfectly healthy socket.
        from unittest import mock as _mock

        ws = _WarmFakeWebSocket()
        with _mock.patch.object(self.main, "DeepgramLiveSession", _WarmFakeUpstream), \
                _mock.patch.object(self.main, "_WARM_PROBE_TIMEOUT_SEC", 0.05), \
                _mock.patch.object(self.main, "_WARM_PROBE_POLL_SEC", 0.01):
            pool = await self._armed_pool()
            warm = _WarmFakeUpstream.instances[0]
            task = self._run(ws, self._recovery())
            await asyncio.sleep(0.02)
            for _ in range(3):
                await ws.messages.put(
                    {"type": "websocket.receive", "bytes": _silence(1600)}
                )
                await asyncio.sleep(0.05)
            await self._finish(ws, task)
            await pool.close_all()

        self.assertFalse(warm.discarded)

    async def test_a_freshly_connected_socket_is_never_probed(self):
        # An un-armed pool means a plain connect, which has already
        # proven the path end to end by completing its handshake.
        from unittest import mock as _mock

        ws = _WarmFakeWebSocket()
        with _mock.patch.object(self.main, "DeepgramLiveSession", _WarmFakeUpstream), \
                _mock.patch.object(self.main, "_WARM_PROBE_TIMEOUT_SEC", 0.05), \
                _mock.patch.object(self.main, "_WARM_PROBE_POLL_SEC", 0.01):
            task = self._run(ws, self._recovery())
            await asyncio.sleep(0.02)
            await ws.messages.put(
                {"type": "websocket.receive", "bytes": _voiced(1600)}
            )
            await asyncio.sleep(0.2)
            await self._finish(ws, task)

        self.assertEqual(len(_WarmFakeUpstream.instances), 1, "no replacement")
        self.assertFalse(_WarmFakeUpstream.instances[0].discarded)

    async def test_the_next_socket_is_warmed_when_the_recording_ends(self):
        # The configuration this recording used is the best available
        # guess at the next one's, and the gap after a stop is when
        # there is most time to spend on a connect.
        from unittest import mock as _mock

        ws = _WarmFakeWebSocket()
        with _mock.patch.object(self.main, "DeepgramLiveSession", _WarmFakeUpstream):
            pool = self.main.DEEPGRAM_WARM_POOL
            pool.start()
            task = self._run(ws, self._recovery())
            await asyncio.sleep(0.02)
            await self._finish(ws, task)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            keys = [row["configKey"] for row in pool.status()["sockets"]]
            self.assertIn(
                self.main.live_config(
                    model="nova-3", language="auto", diarize=False, keyterms=(),
                ).to_query_string(),
                keys,
            )
            await pool.close_all()


class WarmSwapAtFinalizeTests(_WarmHandlerCase):
    """A swap in flight OWNS the session the stop is about to drain (B-012).

    ``_swap_warm_socket`` connects a replacement, rebinds ``session``
    and then ``discard()``s the old one. Its docstring justifies that by
    calling the sender "the only writer to the upstream socket" — which
    stops being true the moment the finalize path gives up waiting for
    the sender and calls ``drain_transcript()`` on whatever ``session``
    names right then.
    """

    async def test_a_swap_in_flight_is_waited_for_before_the_drain(self):
        from unittest import mock as _mock

        gate = asyncio.Event()
        _GatedConnectUpstream.gate = gate
        self.addCleanup(setattr, _GatedConnectUpstream, "gate", None)
        ws = _WarmFakeWebSocket()
        with _mock.patch.object(
            self.main, "DeepgramLiveSession", _GatedConnectUpstream
        ), _mock.patch.object(self.main, "_WARM_PROBE_TIMEOUT_SEC", 0.05), \
                _mock.patch.object(self.main, "_WARM_PROBE_POLL_SEC", 0.01), \
                _mock.patch.object(self.main, "_SEND_FLUSH_DEADLINE_SEC", 0.02), \
                _mock.patch.object(self.main, "_WARM_SWAP_GRACE_SEC", 2.0):
            pool = await self._armed_pool()
            task = self._run(ws, self._recovery())
            await asyncio.sleep(0.02)
            await ws.messages.put(
                {"type": "websocket.receive", "bytes": _voiced(1600)}
            )
            # The probe expires, the sender starts a swap, and the
            # replacement's connect does not return yet. Waited for as a
            # condition, not a fixed sleep: under a loaded full-suite run
            # 0.15 s of wall clock was sometimes not enough for the 0.05 s
            # probe to expire and the swap to start.
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 5.0
            while len(_WarmFakeUpstream.instances) < 2 and loop.time() < deadline:
                await asyncio.sleep(0.01)
            self.assertEqual(
                len(_WarmFakeUpstream.instances), 2, "no swap was started"
            )
            # Released well after the send-flush deadline, so a stop
            # that does not wait for the swap finalizes on the old
            # socket long before the replacement exists.
            releaser = asyncio.get_running_loop().create_task(
                self._release(gate, 0.5)
            )
            with self.assertNoLogs("backend.main", level="ERROR"):
                await self._finish(ws, task)
            await releaser
            await pool.close_all()

        adopted, replacement = _WarmFakeUpstream.instances[:2]
        # The discriminating pair. Before the stop waited for an
        # in-flight swap, the drain ran on ``session`` as it stood when
        # the send flush gave up — the OLD socket, the one the swap was
        # about to discard out from under it.
        self.assertFalse(
            adopted.drain_called,
            "the stop finalized on the socket the swap was about to discard",
        )
        self.assertTrue(
            replacement.drain_called, "the stop did not drain the replacement"
        )
        self.assertTrue(
            adopted.discarded,
            "the swap never completed, so the dead socket was never released",
        )
        self.assertTrue(
            replacement.sent_pcm,
            "the replay never reached the replacement the drain then used",
        )

    async def _release(self, gate: asyncio.Event, after: float) -> None:
        await asyncio.sleep(after)
        gate.set()


class DualStreamWarmingTests(_WarmHandlerCase):
    """Both readings of a dual-stream recording are warmed (B-004).

    ``WARM_MAX_SOCKETS = 2`` was introduced with a comment naming this
    exact case — two languages, two query strings, therefore two pool
    keys. Both ``rewarm`` call sites passed only the primary
    configuration, so the pool never held more than one socket, the
    bound and its eviction logic were unreachable, and the second
    reading paid a cold connect on every recording.
    """

    async def test_both_configurations_are_warmed_when_the_recording_ends(self):
        from unittest import mock as _mock

        ws = _WarmFakeWebSocket()
        with _mock.patch.object(self.main, "DeepgramLiveSession", _WarmFakeUpstream):
            pool = self.main.DEEPGRAM_WARM_POOL
            pool.start()
            task = self._run(ws, self._recovery(), dual_language="ru")
            await asyncio.sleep(0.02)
            await self._finish(ws, task)
            for _ in range(4):
                await asyncio.sleep(0)
            primary = self.main.live_config(
                model="nova-3", language="auto", diarize=False, keyterms=(),
            )
            keys = [row["configKey"] for row in pool.status()["sockets"]]
            self.assertIn(primary.to_query_string(), keys)
            self.assertIn(
                self.main.secondary_config(primary, "ru").to_query_string(),
                keys,
                "the second reading's configuration was never warmed",
            )
            await pool.close_all()


    async def test_boot_warms_both_configurations_when_dual_is_on(self):
        from unittest import mock as _mock

        cfg = {
            "providers": {"deepgram": {"key": "dg"}},
            "preferences": {
                "deepgram": {
                    "keyterms": [],
                    "dual_stream": True,
                    "dual_secondary_language": "ru",
                }
            },
        }
        with _mock.patch.object(self.main, "DeepgramLiveSession", _WarmFakeUpstream), \
                _mock.patch.object(self.main, "load_config", lambda: cfg):
            pool = self.main.DEEPGRAM_WARM_POOL
            pool.start()
            await self.main._prewarm_deepgram_at_boot()
            for _ in range(4):
                await asyncio.sleep(0)
            primary = self.main.live_config(
                model="nova-3", language="auto", diarize=False,
                keyterms=self.main.configured_keyterms(cfg, self.main.AUTO_KEYTERMS.terms()),
                language_hints=self.main.configured_language_hints(cfg),
            )
            keys = [row["configKey"] for row in pool.status()["sockets"]]
            # Built as the session builds it — hints included, since an
            # absent preference is the default — because the pool hands a
            # socket only to an identical query string.
            self.assertIn("language_hint=ru", primary.to_query_string())
            self.assertIn(primary.to_query_string(), keys)
            self.assertIn(
                self.main.secondary_config(primary, "ru").to_query_string(),
                keys,
                "boot warmed only the primary reading",
            )
            await pool.close_all()


class WarmStatusEndpointTests(unittest.TestCase):
    """``GET /api/live/warm`` is a diagnostic, behind the standard auth."""

    def setUp(self) -> None:
        import importlib
        import os
        import sys
        import tempfile

        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        os.environ["TRANSCRIPTOR_DATA_DIR"] = self._tmp.name
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")

    def tearDown(self) -> None:
        import os
        import sys

        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        self._tmp.cleanup()

    def _route(self):
        for route in self.main.app.routes:
            if getattr(route, "path", None) == "/api/live/warm":
                return route
        self.fail("GET /api/live/warm is not registered")

    def test_the_route_requires_the_standard_api_token(self):
        route = self._route()
        names = [
            dep.call for dep in route.dependant.dependencies
        ]
        self.assertIn(self.main._require_api_auth, names)

    def test_it_reports_the_pool_state(self):
        payload = self.main.get_live_warm_state(_auth=None)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["warm"], self.main.DEEPGRAM_WARM_POOL.status())
        self.assertIn("sockets", payload["warm"])

    def test_the_boot_prewarm_does_nothing_without_a_key(self):
        asyncio.run(self.main._prewarm_deepgram_at_boot())
        self.assertEqual(self.main.DEEPGRAM_WARM_POOL.status()["sockets"], [])


if __name__ == "__main__":
    unittest.main()
