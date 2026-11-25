"""The gate's invariants, not its accuracy.

Every test here is about a promise the mask makes regardless of what any
model says: the byte count never moves, a scored window labels its own
head, a flip to open repairs what is still held, and off is an absent
object rather than a filter that does nothing. Accuracy is §7.5's problem,
on real takes; these are the ones a regression can silently break.
"""

import array
import random
import unittest

from backend.audio_constants import LIVE_PCM_BYTES_PER_SEC
from backend.voice_mask import (
    DEFAULT_CLOSE_AT,
    DEFAULT_HOP_MS,
    DEFAULT_OPEN_AT,
    DEFAULT_WINDOW_MS,
    VoiceMask,
)

OWNER_LEVEL = 3000
OTHER_LEVEL = 900
ROOM_LEVEL = 100  # under the repo's voice peak: not speech at all


def pcm(level: int, ms: int, rate_hz: int = 16_000) -> bytes:
    """A square wave at ``level`` — enough to be audible, cheap to build."""
    samples = array.array("h", [level if i % 2 else -level for i in range(ms * rate_hz // 1000)])
    return samples.tobytes()


def peak_of(data: bytes) -> int:
    usable = len(data) - (len(data) % 2)
    if usable < 2:
        return 0
    samples = array.array("h")
    samples.frombytes(bytes(data[:usable]))
    return max(max(samples), -min(samples))


def peak_scorer(high: float, low: float, voice_peak: int = 655):
    """Judge by the window's peak: loud is the owner, quiet is a stranger."""

    def score(window: bytes):
        peak = peak_of(window)
        if peak < voice_peak:
            return None
        return high if peak >= OWNER_LEVEL else low

    return score


def constant_scorer(value):
    """A gate that never changes its mind: every window scores ``value``."""

    def score(window: bytes):
        if peak_of(window) < 655:
            return None
        return value

    return score

def drain(mask: VoiceMask, data: bytes, chunk: int) -> bytes:
    out = b""
    for start in range(0, len(data), chunk):
        for hop in mask.feed(data[start : start + chunk]):
            out += hop
    for hop in mask.flush():
        out += hop
    return out


class MaskTimelineTests(unittest.TestCase):
    def test_open_stream_is_byte_identical(self):
        data = pcm(OWNER_LEVEL, 2500)
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        self.assertEqual(drain(mask, data, 1600), data)

    def test_refused_stream_is_silence_of_the_same_length(self):
        data = pcm(OTHER_LEVEL, 2500)
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        out = drain(mask, data, 1600)
        self.assertEqual(len(out), len(data))
        self.assertEqual(out, bytes(len(data)))

    def test_arbitrary_chunking_preserves_every_byte(self):
        data = pcm(OWNER_LEVEL, 1200)
        rng = random.Random(7)
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        out = b""
        position = 0
        while position < len(data):
            step = rng.choice([1, 7, 800, 1600, 3201])
            for hop in mask.feed(data[position : position + step]):
                out += hop
            position += step
        for hop in mask.flush():
            out += hop
        self.assertEqual(out, data)

    def test_held_audio_never_exceeds_a_window_plus_a_hop(self):
        window_bytes = DEFAULT_WINDOW_MS * LIVE_PCM_BYTES_PER_SEC // 1000
        hop_bytes = DEFAULT_HOP_MS * LIVE_PCM_BYTES_PER_SEC // 1000
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        data = pcm(OWNER_LEVEL, 3000)
        for start in range(0, len(data), 1600):
            mask.feed(data[start : start + 1600])
            self.assertLessEqual(mask.latency_bytes, window_bytes + hop_bytes)

    def test_the_release_grid_is_the_senders_own_write(self):
        # §4.2: the sender writes 1600-byte chunks and a released hop must be
        # one of them. A hop that is not a whole chunk would hand the send
        # path frames nobody asked for, and would judge faster than the model
        # can answer (see DEFAULT_HOP_MS).
        self.assertEqual(DEFAULT_HOP_MS * LIVE_PCM_BYTES_PER_SEC // 1000, 1600)

    def test_a_recording_shorter_than_a_window_is_never_silenced(self):
        data = pcm(OWNER_LEVEL, 400)
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        self.assertFalse(mask.judged)
        self.assertEqual(drain(mask, data, 1600), data)


class VerdicRateTests(unittest.TestCase):
    def test_the_gate_spends_at_most_a_third_of_the_audio_on_verdicts(self):
        # A fixed interval either starves a fast host or falls behind a slow
        # one. The gate re-tunes from what a judgement actually costs, so the
        # time it spends stays a fraction of the time it gates.
        import time

        def scorer(_window):
            time.sleep(0.010)  # a 10 ms embedding
            return 0.9

        mask = VoiceMask(scorer)
        data = pcm(OWNER_LEVEL, 3000)  # 3 s of audio
        started = time.perf_counter()
        drain(mask, data, 1600)
        spent = time.perf_counter() - started
        self.assertLess(spent, 3.0 / 3.0, "the gate spent more than a third of realtime")
        self.assertGreaterEqual(mask._verdict_interval_hops, 1)


class MaskBoundaryTests(unittest.TestCase):
    def test_the_first_syllable_survives_a_late_verdict(self):
        other = pcm(OTHER_LEVEL, 1000)
        owner = pcm(OWNER_LEVEL, 1000)
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        out = drain(mask, other + owner, 1600)
        tail = out[len(other) :]
        self.assertEqual(tail, owner, "the owner's onset was zeroed")

    def test_silence_is_passed_through_untouched(self):
        voiced = lambda hop: peak_of(hop) >= 655  # noqa: E731 — the repo's own peak test
        mask = VoiceMask(peak_scorer(0.95, 0.10), voiced=voiced)
        drain(mask, pcm(OTHER_LEVEL, 1500), 1600)  # closed and judged
        room = pcm(ROOM_LEVEL, 500)
        out = b""
        for hop in mask.feed(room):
            out += hop
        for hop in mask.flush():
            out += hop
        self.assertEqual(out, room)

    def test_a_quiet_opening_is_released_by_its_own_verdict(self):
        # §4.6 meets §4.4 on the first window: the gate holds it refused for
        # want of a verdict, and the verdict says there is nothing in it to
        # refuse. Before this, a recording that opened on room tone began
        # with exactly one second of zeros.
        data = pcm(ROOM_LEVEL, 2500)
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        self.assertEqual(drain(mask, data, 1600), data)

    def test_an_opening_burst_is_held_back_until_a_verdict_exists(self):
        # The lead-in: nothing voiced leaves before the first verdict, so a
        # stranger who speaks first is never heard. The take keeps every byte;
        # the live copy loses its opening window, which is the price of not
        # leaking. Room is still room (§4.6): only voiced hops wait.
        voiced = lambda hop: peak_of(hop) >= 655  # noqa: E731 — the repo's own peak test
        burst = pcm(OWNER_LEVEL, 400)  # 8 whole hops, so the slice below is a hop boundary
        room = pcm(200, 4000)  # under the peak test's floor: unvoiced, §4.6
        mask = VoiceMask(peak_scorer(0.95, 0.10), voiced=voiced)
        out = drain(mask, burst + room, 1600)
        self.assertFalse(mask.judged, "this take never completes a window of voice")
        self.assertEqual(len(out), len(burst) + len(room), "the byte grid stands")
        self.assertEqual(out[: len(burst)], bytes(len(burst)), "the opening is withheld")
        self.assertEqual(out[len(burst) :], room, "room leaves untouched")

    def test_a_press_shorter_than_a_window_is_released_whole(self):
        # No verdict can ever exist for it, and "no evidence" is not a refusal:
        # the flush is what tells a short press apart from an opening window.
        voiced = lambda hop: peak_of(hop) >= 655  # noqa: E731
        data = pcm(OWNER_LEVEL, 300)
        mask = VoiceMask(peak_scorer(0.95, 0.10), voiced=voiced)
        out = drain(mask, data, 600)
        self.assertFalse(mask.judged)
        self.assertEqual(out, data, "a press shorter than the window is not a stranger")

    def test_the_tail_holds_the_verdict_back_for_its_hops(self):
        # window 100 ms, hop 25 ms == four hops; tail 100 ms == four more.
        verdicts = iter([0.95] * 40 + [0.10] * 200)
        mask = VoiceMask(
            lambda _window: next(verdicts),
            window_ms=100,
            hop_ms=25,
            tail_ms=100,
        )
        data = pcm(OWNER_LEVEL, 2000)
        out = b""
        for start in range(0, len(data), 800):
            for hop in mask.feed(data[start : start + 800]):
                out += hop
        for hop in mask.flush():
            out += hop
        hop_bytes = 800
        first_zero = next(
            (i for i in range(0, len(out), hop_bytes) if out[i : i + hop_bytes] == bytes(hop_bytes)),
            None,
        )
        # A verdict is read when a hop leaves (§4.7), so the close verdict
        # that lands at hop 44 arrives with hop 44 while hop 40 is leaving.
        # The 100 ms tail then covers hops 40-43 leaving, and the first
        # refused hop is 44's own head — the index the close was computed
        # at, which is the whole point of labelling at release.
        self.assertIsNotNone(first_zero)
        self.assertEqual(first_zero // hop_bytes, 43)

    def test_a_pause_that_closes_the_window_still_gets_a_verdict(self):
        # The bug this pins: verdicts were taken only when the *arriving*
        # hop was voiced, so a pause at the window's end left the previous
        # score standing — and the hop released at that instant (the owner's
        # first phoneme, 2 s behind) was labelled with a stranger's verdict.
        # 9 of his voiced hops went to zeros on a handover. §4.6 is about the
        # window: one voiced hop in it is still worth the 38 ms.
        voiced = lambda hop: peak_of(hop) >= 655  # noqa: E731 — the repo's own peak test
        calls: list[int] = []

        def scorer(_window):
            calls.append(len(calls))
            return 0.10

        mask = VoiceMask(scorer, voiced=voiced, window_ms=100, hop_ms=25)
        mask.feed(pcm(OWNER_LEVEL, 100))
        self.assertEqual(len(calls), 1, "one full window of speech is one verdict")
        before = len(calls)
        mask.feed(pcm(ROOM_LEVEL, 75))
        # Three hops of pause close three windows: one at 80% voice, one at
        # 60% — both worth a verdict — and one at 40%, which is mostly room
        # and is left alone.
        self.assertEqual(
            len(calls) - before,
            2,
            "the pause closed two windows that still held the owner's voice",
        )

    def test_a_word_in_a_window_of_room_is_refused_when_the_voice_is_a_stranger(self):
        # §4.4 the other way round, by the owner's decision of 2026-11-19: with
        # Solo on, a window at or below close_at zeroes its hops even when it is
        # mostly room. Measured then: a stranger's profile refused 29% of a take
        # — every spoken hop — against 1.5% for the owner's own profile. The
        # cost is the one this test used to defend: a short word of the owner's
        # inside a window of room can be cut; the tail, not the share, is what
        # protects the end of his turn.
        voiced = lambda hop: peak_of(hop) >= 655  # noqa: E731 — the repo's own peak test
        stranger = pcm(OTHER_LEVEL, 400)
        word = pcm(OWNER_LEVEL, 25)
        room = pcm(ROOM_LEVEL, 1000)
        data = stranger + word + room
        mask = VoiceMask(lambda _w: 0.10, voiced=voiced, window_ms=100, hop_ms=25)
        out = drain(mask, data, 800)
        self.assertTrue(mask.judged, "the stranger's window should have closed the gate")
        at = len(stranger)
        self.assertEqual(
            out[at : at + len(word)],
            bytes(len(word)),
            "a stranger's word must not reach the provider, room or no room",
        )

    def test_a_shrug_band_verdict_still_keeps_a_thin_window(self):
        # 0.55 < 0.6 < 0.65: the window is neither clearly the owner nor
        # clearly not, and zeroing on a shrug is a cut with extra steps.
        voiced = lambda hop: peak_of(hop) >= 655  # noqa: E731
        stranger = pcm(OTHER_LEVEL, 400)
        word = pcm(OWNER_LEVEL, 25)
        room = pcm(ROOM_LEVEL, 1000)
        mask = VoiceMask(lambda _w: 0.60, voiced=voiced, window_ms=100, hop_ms=25)
        out = drain(mask, stranger + word + room, 800)
        at = len(stranger)
        self.assertEqual(out[at : at + len(word)], word, "a shrug is not a refusal")

    def test_a_handover_never_cuts_the_arriving_voice(self):
        # The stranger talks, then the owner does, and the window that
        # straddles the change lands in the band — neither clearly his nor
        # clearly not. Measured on a handover: 0.62, with half the window
        # still the stranger, and the old rule zeroed the owner's first
        # 0.75 s of that sentence. §4.4 spends uncertainty as a leak.
        script = iter([0.10] * 60 + [0.33] * 300)
        mask = VoiceMask(lambda _window: next(script), window_ms=100, hop_ms=25)
        data = pcm(OWNER_LEVEL, 3000)
        out = b""
        for start in range(0, len(data), 400):
            for hop in mask.feed(data[start : start + 400]):
                out += hop
        for hop in mask.flush():
            out += hop

        hop_bytes = 400
        zeroed = [not any(out[i : i + hop_bytes]) for i in range(0, len(out), hop_bytes)]
        self.assertTrue(any(zeroed), "the stranger's audio was not refused at all")
        first_kept = zeroed.index(False)
        self.assertFalse(mask.open, "an unclear verdict must not open the gate either")
        self.assertFalse(
            any(zeroed[first_kept:]),
            "the gate refused audio again after an unclear verdict",
        )


class MaskConfigurationTests(unittest.TestCase):
    def test_a_window_shorter_than_a_hop_is_refused(self):
        with self.assertRaises(ValueError):
            VoiceMask(peak_scorer(0.95, 0.10), window_ms=10, hop_ms=25)

    def test_hysteresis_must_close_below_where_it_opens(self):
        with self.assertRaises(ValueError):
            VoiceMask(peak_scorer(0.95, 0.10), open_at=0.4, close_at=0.6)

    def test_a_verdict_between_the_thresholds_keeps_the_state(self):
        script = iter([0.95] + [0.60] * 200)
        mask = VoiceMask(lambda _w: next(script), window_ms=100, hop_ms=25)
        mask.feed(pcm(OWNER_LEVEL, 200))
        self.assertTrue(mask.open)
        mask.feed(pcm(OWNER_LEVEL, 400))
        self.assertTrue(mask.open, "a verdict inside the band closed the gate")


class MeasuredThresholdTests(unittest.TestCase):
    """§7.5: the pair stopped being a guess, and this is where it is kept.

    Measured held out — the profile from the first half of one narrator's
    63 s, the scores from the second half, so the net never recognised its
    own input: his speech-bearing windows floor at 0.611, and two unrelated
    voices peak at 0.116. What sat below `close_at` in that take was all
    pause-dominated (under 40% voiced hops), which is the room with a word
    in it and where a close belongs.

    The numbers themselves are not re-asserted here: reproducing them needs
    the 27 MB net and a minute of audio, which is a smoke, not a unit test.
    What is pinned is the pair they chose, and the margin that makes it a
    choice rather than a coin toss — so a later edit has to argue with the
    measurement instead of nudging a constant.
    """

    def test_the_thresholds_are_the_measured_pair(self):
        # Re-measured 2026-11-21 on the desk's own references with a six-second
        # press: the kept voice's windows scored 0.32-0.53 (median 0.39), the
        # other voice's 0.09-0.33 (median 0.24). A pair 0.03 apart keeps the
        # kept voice and refuses the rest, where 0.65/0.55 refused both.
        self.assertEqual((DEFAULT_OPEN_AT, DEFAULT_CLOSE_AT), (0.36, 0.30))

    def test_the_owner_floor_clears_the_close_threshold(self):
        # 0.611 is the floor of a window with more than half its hops voiced
        # on the take §7.5 measured. Five points of room, not one: a cold or
        # tired voice moves this number, and the pair must survive that.
        self.assertGreater(0.611, DEFAULT_CLOSE_AT + 0.05)


class TurnDecisionTests(unittest.TestCase):
    def test_a_turn_of_four_windows_decides_on_its_median(self):
        # The factory asks for four windows when the profile was learned in this
        # room. That path crashed on numpy never being imported while every test
        # ran the single-window rule, so the gate died on the first judgement in
        # the app and nothing was gated at all. This is that path, exercised.
        mask = VoiceMask(lambda _window: 0.9, turn_windows=4)
        data = pcm(OWNER_LEVEL, 6000)
        out = b""
        for start in range(0, len(data), 1600):
            for hop in mask.feed(data[start : start + 1600]):
                out += hop
        for hop in mask.flush():
            out += hop
        self.assertTrue(mask.judged)
        self.assertEqual(len(out), len(data))

class WithheldAccountingTests(unittest.TestCase):
    """§5.3/§5.4: what the gate silenced is a number, not a silence.

    The pane has nothing to draw unless the gate can say how much it
    took, and the only trustworthy count is the one kept where the
    decision becomes bytes. These pin that it is counted there, that it
    counts voice rather than length, and that "nothing withheld" is a
    real answer rather than an unknown.
    """

    def test_a_kept_stream_withholds_nothing(self):
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        drain(mask, pcm(OWNER_LEVEL, 2500), 1600)
        self.assertEqual(mask.withheld_bytes, 0)
        self.assertEqual(mask.state, "open")

    def test_a_refused_stream_withholds_all_of_it(self):
        data = pcm(OTHER_LEVEL, 2500)
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        drain(mask, data, 1600)
        self.assertEqual(mask.withheld_bytes, len(data))
        self.assertEqual(mask.state, "closed")

    def test_unvoiced_audio_is_never_counted_as_withheld(self):
        # §4.6: room tone is silence already and the gate does not touch
        # it, so it must not appear in a line that says "we held this
        # back" — the count is about the owner's neighbours, not about
        # the recording's length.
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        drain(mask, pcm(ROOM_LEVEL, 3000), 1600)
        self.assertEqual(mask.withheld_bytes, 0)
        self.assertEqual(mask.state, "idle", "nothing was scored, nothing was decided")

    def test_the_count_matches_the_zeros_actually_emitted(self):
        # The number the pane prints and the audio the provider got have
        # to be the same fact. Counted per released hop, over voiced hops
        # only — a hop that was silence to begin with is not "withheld".
        hop = DEFAULT_HOP_MS * LIVE_PCM_BYTES_PER_SEC // 1000
        other = pcm(OTHER_LEVEL, 3000)
        owner = pcm(OWNER_LEVEL, 2000)
        data = other + owner + other
        mask = VoiceMask(peak_scorer(0.95, 0.10))
        out = drain(mask, data, 1600)
        self.assertEqual(len(out), len(data))
        zeroed_hops = 0
        for start in range(0, len(data) - hop + 1, hop):
            source = data[start : start + hop]
            if peak_of(source) >= 655 and out[start : start + hop] == bytes(hop):
                zeroed_hops += 1
        self.assertGreater(zeroed_hops, 0, "the fixture must refuse something")
        self.assertEqual(mask.withheld_bytes, zeroed_hops * hop)


if __name__ == "__main__":
    unittest.main()


class TheUnidentifiableTakeTests(unittest.TestCase):
    """An audio that carries no reliable identity is an ERROR, not a verdict.

    The owner's rule, in his words: if the identifier cannot be extracted
    reliably, that is an error. So a take whose windows sit between the pair -
    neither clearly the owner nor clearly anybody else - is withheld from
    nothing and reported, instead of being guessed at.
    """

    def test_a_take_of_shrugs_says_it_cannot_identify(self):
        # open 0.50 / close 0.42, a scorer that always answers 0.46: every
        # window is a shrug, and enough of them make the take unidentifiable.
        mask = VoiceMask(constant_scorer(0.46), open_at=0.50, close_at=0.42)
        data = pcm(OWNER_LEVEL, 3000)
        out = drain(mask, data, 1600)
        self.assertTrue(mask.unverified)
        self.assertEqual(out, data)

    def test_a_clear_stranger_is_still_refused_not_unverified(self):
        mask = VoiceMask(constant_scorer(0.10), open_at=0.50, close_at=0.42)
        data = pcm(OTHER_LEVEL, 3000)
        out = drain(mask, data, 1600)
        self.assertFalse(mask.unverified)
        self.assertEqual(out, bytes(len(data)))

    def test_a_clear_owner_is_still_forwarded(self):
        mask = VoiceMask(constant_scorer(0.90), open_at=0.50, close_at=0.42)
        data = pcm(OWNER_LEVEL, 3000)
        out = drain(mask, data, 1600)
        self.assertFalse(mask.unverified)
        self.assertEqual(out, data)


if __name__ == "__main__":
    unittest.main()