"""Target-speaker gate: zero the windows that are not the owner's.

Why this shape
--------------
The take is never touched. This runs on the copy handed to the provider,
so every byte leaving the gate is the same length as the byte that came
in: the sender's 1600-byte grid, ``stats.bytes_sent`` and every time
offset Deepgram reports keep describing one timeline, and no offset map
has to exist anywhere (``docs/COWORK_MASK.md`` §4.2).

The gate holds one window and emits its **first** hop, so a verdict always
describes the audio it labels — the window that scores is the window whose
head leaves (§4.7), and the label is decided *when the hop leaves*, not when
it arrived. That distinction is the whole gate. A hop that arrives at 14.0 s
is still held 2 s later, and by then the window covering it is the one that
scores; labelling it on arrival instead means labelling it with a window that
ended before it began, which is how the first 0.75 s of the owner's turn
after a stranger's was once zeroed: every window that had produced those
labels was entirely the stranger's.

Holding the window is what buys the asymmetry in §4.4: because the label is
read at release, everything still held follows the newest verdict, so the
owner's first phoneme is never cut — at the price of a neighbour's second
that sits in the same window. The reverse mistake — cutting a word — is the
one this ordering exists to make impossible.

A verdict is therefore only worth taking when the window it would describe
has a voice in it (§4.6), and *that* is the test, not whether the hop that
just closed the window is voiced. The two are not the same at the one moment
that matters: the hop ending the window a second after the owner resumes is
often a pause, no verdict was taken, and the stranger's last score stood
over the owner's first phoneme — 9 of his voiced hops zeroed on a handover
that the tail alone could not fix. Asking the window instead costs nothing:
while anyone talks the arriving hop is voiced and the test returns at once,
so the peak rate is unchanged, and the extra calls fall in pauses where the
thread was idle anyway.

A verdict inside the two thresholds (§4.5) is not a refusal, it is a shrug:
the window is neither clearly the owner nor clearly not, and zeroing on a
shrug is a cut with extra steps. Only a verdict at or below ``close_at``
zeroes while the gate is closed.

A window that is mostly room decides nothing at all, in either direction.
This is the other half of §4.4 and it is measured, not taste: 0.4 s of the
owner's own speech in a 2 s window scores 0.10-0.31 — the range a stranger
occupies — so no threshold can tell his short word from a stranger's. The
question that can is how much of the window is voice: below half, the score
describes the room, and refusing on it refused his word (8 of the 9 voiced
hops of one syllable, measured). Such a window may still be scored; it may
not refuse, open or close.

The first window is held whole when its first verdict arrives, so the very
first second of a recording is labelled by evidence, not by default: the
audio the owner started speaking into is still in the queue when the verdict
says it is his. Until such a verdict exists, what the queue releases leaves
untouched: unjudged is not refused, which is the same rule that keeps a
recording shorter than a window whole.

A scorer returning ``None`` means the window carries no voice at all
(§4.6). Such a hop is passed through untouched: it is silence already, and
zeroing silence only puts a step in the noise floor. That holds for the
first window too, whose hops are held for want of a verdict rather than in
their favour — otherwise every recording that opens on room tone starts
with a second of zeros.

A refusal is counted, not just performed (§5.3, §5.4). ``withheld_bytes``
is the total this gate has zeroed, and every byte of it is a byte the
provider never saw, so the number is the only honest thing the pane can
say about what did not arrive. Silence that the gate produced on purpose
reads, to a user, exactly like a transcript that lost his speech: the
counter is what turns the two apart, and §5.4's "a line of state costs
less than a lost utterance" is the reason it exists at all. ``state`` is
the same fact as a word, so the line can say whether the refusal is still
happening or is over.

Nothing here reads a file, a config or a model. The scorer is injected:
one callable, ``bytes -> Optional[float]``, which is the whole contract
between this gate and whatever turns audio into a similarity.
"""

from __future__ import annotations

import math
import time

from collections import deque
from typing import Callable, Deque, List, Optional, Tuple

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ

# A verdict is a similarity in [0, 1]; ``None`` says there is nothing to judge.
Scorer = Callable[[bytes], Optional[float]]

# The window is not a guess: CAM++ at 25 ms/10 ms fbank puts one speaker
# against himself at 0.554 (1 s), 0.692 (1.5 s), 0.802 (2 s) and a stranger
# at 0.01-0.11 throughout, so 0.65/0.55 only separates them from 1.5 s up.
# At the old 1 s window the owner's own score sat on close_at and the gate
# refused him. §4.1 allows 1-2 s of lookahead; this is the 2 s end.
DEFAULT_WINDOW_MS = 2000
# The hop is not a guess either, and it is deliberately not §4.1's 20-30 ms.
# One judgement of a 2 s window costs 38 ms on one ORT thread and 25 ms on
# two (measured here, CAM++ zh_en, fbank 25/10 included); at a 25 ms cadence
# the gate would spend more than a hop's own budget on every hop and fall
# behind the microphone it is reading. 50 ms judges at 20 Hz, where a 26 ms
# median fits with margin on either thread count, and it lands exactly on the
# sender's 1600-byte write (§4.2): a released hop IS one frame, so no release
# can ever split one.
DEFAULT_HOP_MS = 50
# Measured (§7.5), not guessed. On 63 s of one LibriSpeech narrator — the
# first half enrolled, the second half scored, so the profile never saw the
# audio it was asked about — his speech-bearing windows sit at 0.611 (min),
# 0.661 (p5), 0.726 (median), and two unrelated voices reach 0.116 at their
# highest. The pair keeps 0.53 of clearance above a stranger and 0.06 below
# the owner's floor; both are far outside anything the net does on noise.
# What fell under close_at in that take was not the owner being quiet: all 16
# windows under 0.55 were pause-dominated (under 40% voiced hops, median
# 21%), and a window like that is the room with a word in it, which is where
# a close belongs. Fed the real gate, the held-out take lost 0 of 434 voiced
# hops, so §4.4's "never a cut word" is measured too, not just intended.
#: The thresholds when a cohort normalises the score (AS-Norm): a trial is a
#: z against what this model scores on strangers. Calibrated 2026-11-21 on the
#: owner's desk with a 385-vector impostor cohort: the best split of 44 kept-
#: voice windows against 118 stranger windows sits at -0.3, where 14% of the
#: kept voice is cut and 12% of the stranger passes; the open threshold is a
#: full unit above it, so a window must be clearly the owner to reopen the gate.
#: These move with the cohort: rebuild it and recalibrate, never copy them.
DEFAULT_OPEN_AT_Z = 0.7
DEFAULT_CLOSE_AT_Z = -0.3
DEFAULT_OPEN_AT = 0.36
DEFAULT_CLOSE_AT = 0.30
#: How much of the profile's own floor a window must reach (§4.5). A voice
#: recorded well scores its own windows near 0.9 and a stranger near 0.4 of
#: that; measured on this desk 2026-11-21, a six-second press gave a floor of
#: 0.888 with the kept voice at 0.38 and the other at 0.24, i.e. 0.42 and 0.27
#: of the floor. The shares below sit just above those two numbers.
SELF_FLOOR_OPEN = 0.42
SELF_FLOOR_CLOSE = 0.35


def thresholds_for_floor(self_floor: float) -> Tuple[float, float]:
    """``(open, close)`` for a profile, from how alike its own windows are.

    A profile learned on one microphone cannot use another microphone's
    constants (measured: 0.65/0.55 refused both voices here). Its own floor
    carries the scale, so the same rule travels: 0.42 and 0.35 of it. A
    profile stored before floors were kept falls back to the measured pair.
    """
    if not self_floor or self_floor <= 0.0:
        return DEFAULT_OPEN_AT, DEFAULT_CLOSE_AT
    open_at = min(0.95, max(0.05, SELF_FLOOR_OPEN * self_floor))
    close_at = min(open_at - 0.01, max(0.04, SELF_FLOOR_CLOSE * self_floor))
    return open_at, close_at
# A refusal needs the arriving hop to be voiced and the standing verdict to be
# at or below ``close_at``. The voice share of the window is NOT part of that
# decision any more: measured on the owner's desk (2026-11-19) with a stranger's
# profile enabled, a share requirement left 17% of a take refused and the rest
# transcribed — Solo's whole point is that a refused voice never reaches the
# provider. Without it the same take refused 29%, which is every spoken hop,
# while the owner's own profile cost 1.5%. The share still decides WHEN a
# pause is worth a verdict (``_worth_a_verdict``), where it costs nothing.
# The tail is what protects the owner's last word (§4.3).
MIN_VOICED_SHARE = 0.5
#: How often a new verdict may cost an embedding, in milliseconds. The
#: embedding is 25-40 ms on this desk's CPU, so judging on every 50 ms hop —
#: which is what a voiced arrival asked for — spends more than the audio
#: supplies: the mask worker fell behind and the app forwarded UNMASKED
#: (measured 2026-11-21, "forwarded unmasked after falling behind", with the
#: owner's words in the transcript). Four verdicts a second is a tenth of the
#: budget and still resolves a two-second window eight times over.
VERDICT_INTERVAL_MS = 250

# §4.3 asks for a 300 ms tail, and 300 ms is right for a lookahead of a few
# hundred milliseconds. It is not right for two seconds, and the arithmetic
# is not a matter of taste: a close cannot land before the window is half the
# stranger, so it arrives ~1 s after he begins — and the hops leaving at that
# moment are the owner's last words, 2 s behind. The tail has to cover that
# smear, which is half a window. Measured on a handover (§7.5 fixture), the
# owner's voiced hops cut were 20 at 300 ms, 12 at 500, 4 at 700, none from
# 800 up; past 1000 the tail buys no cut at all and only lengthens the leak
# (0.9 s intact at 1000, 1.0 s at 1050). Half a window it is: the earliest
# point a close can possibly land, and the last point that pays.
DEFAULT_TAIL_MS = DEFAULT_WINDOW_MS // 2


def _ms_to_bytes(ms: int, rate_hz: int) -> int:
    """PCM16LE mono: two bytes per sample, never a half sample."""
    nbytes = (ms * rate_hz * 2) // 1000
    return nbytes - (nbytes % 2)


class VoiceMask:
    """One window held, one hop released, the byte count never moves.

    ``feed`` returns whatever became emittable — zero, one or many hops —
    and ``flush`` returns the rest when the recording stops. Concatenating
    everything both ever returned reproduces the input byte for byte, in
    order, whatever the scorer said.
    """

    def __init__(
        self,
        scorer: Scorer,
        *,
        voiced: Optional[Callable[[bytes], bool]] = None,
        rate_hz: int = LIVE_SAMPLE_RATE_HZ,
        window_ms: int = DEFAULT_WINDOW_MS,
        hop_ms: int = DEFAULT_HOP_MS,
        open_at: float = DEFAULT_OPEN_AT,
        close_at: float = DEFAULT_CLOSE_AT,
        tail_ms: int = DEFAULT_TAIL_MS,
        verdict_interval_ms: int = 0,
    ) -> None:
        if hop_ms <= 0 or window_ms < hop_ms:
            raise ValueError("a window holds at least one hop")
        if not close_at <= open_at:
            raise ValueError("a hysteresis needs close_at <= open_at")
        if not (math.isfinite(open_at) and math.isfinite(close_at)):
            # Not bracketed by [0, 1] any more: with an impostor cohort the
            # score is a z against the model's own strangers, and a z lives on
            # the whole line (§4.5).
            raise ValueError("a hysteresis needs finite thresholds")
        self._scorer = scorer
        # Injected, never imported: the gate must stay a pure function of
        # its arguments so it can be tested without the provider stack.
        # The wiring passes ``pcm_has_voice`` (§4.3); ``None`` treats every
        # hop as carrying voice, which is what the tests that need no
        # voicing model rely on.
        self._voiced = voiced
        self._hop_bytes = _ms_to_bytes(hop_ms, rate_hz)
        self._hop_ms = max(1, hop_ms)
        self._window_bytes = _ms_to_bytes(window_ms, rate_hz)
        self._open_at = open_at
        self._close_at = close_at
        self._tail_hops = max(0, tail_ms // hop_ms)
        # A verdict costs an embedding; one per VERDICT_INTERVAL_MS keeps the
        # thread ahead of the audio it is gating.
        self._verdict_interval_hops = (max(1, verdict_interval_ms // max(1, hop_ms)) if verdict_interval_ms > 0 else 0)
        self._hops_since_verdict = self._verdict_interval_hops

        # The queue carries audio and whether it had voice, never a label:
        # the label is read when the hop leaves (§4.7), so nothing queued
        # can go stale between arriving and being labelled.
        self._held: Deque[Tuple[bytes, bool]] = deque()
        self._held_bytes = 0
        # Counted on the way in and out, so the window's voice share is one
        # division at the moment of a decision rather than a walk of 40 hops.
        self._voiced_held = 0
        self._partial = bytearray()
        self._open = False
        self._tail_left = 0
        self._verdict: Optional[float] = None
        self._judged = False
        # Counted where the decision becomes bytes, so the number the pane
        # shows is the number that actually left as zeros (§5.3).
        self._withheld_bytes = 0

    @property
    def open(self) -> bool:
        """Whether the last verdict admitted the window."""
        return self._open

    @property
    def judged(self) -> bool:
        """Whether any window has been scored yet."""
        return self._judged

    @property
    def state(self) -> str:
        """``"idle"`` until a verdict about a voice lands, then ``"open"``
        or ``"closed"``.

        Read by the caller's report, never by the decision: the gate's own
        rules live in ``_keep`` and this is only what they amount to.

        A window the scorer found no voice in is not a closed gate. It is
        a gate with nothing to decide — the state a recording of an empty
        room sits in start to finish — and calling that "closed" would
        make the pane report a refusal over audio nobody spoke into.
        """
        if not self._judged or self._verdict is None:
            return "idle"
        return "open" if self._open else "closed"

    @property
    def verdict(self) -> Optional[float]:
        """The last similarity this gate was given, for diagnostics."""
        return self._verdict

    @property
    def withheld_bytes(self) -> int:
        """How many bytes of the forwarded copy this gate has zeroed.

        Voiced hops only — an unvoiced one is never refused (§4.6) — so
        this is the length of the audio the gate itself silenced, which is
        the exact quantity §5.4's line of state is about.
        """
        return self._withheld_bytes

    @property
    def latency_bytes(self) -> int:
        """How much audio the gate is holding right now."""
        return self._held_bytes + len(self._partial)

    def feed(self, data: bytes) -> List[bytes]:
        """Take PCM16LE, return whole hops that may now leave."""
        if not data:
            return []
        self._partial += data
        out: List[bytes] = []
        while len(self._partial) >= self._hop_bytes:
            hop = bytes(self._partial[: self._hop_bytes])
            del self._partial[: self._hop_bytes]
            voiced = True if self._voiced is None else self._voiced(hop)
            # Audio and voicing, never a label: a hop is labelled by the
            # verdict standing when it leaves (§4.7), and that verdict has
            # not been computed yet.
            self._held.append((hop, voiced))
            self._held_bytes += len(hop)
            if voiced:
                self._voiced_held += 1
            self._hops_since_verdict += 1
            if self._worth_a_verdict(voiced):
                self._hops_since_verdict = 0
                started = time.perf_counter()
                self._judge()
                # The next verdict waits for three times what this one cost:
                # the gate spends at most a third of the audio's own time on
                # embeddings, on whatever machine it is running. A fixed
                # interval either starves a fast host or falls behind on a slow
                # one — measured here at 250 ms against a 35 ms embedding, five
                # times more waiting than the hardware needed.
                self._retune_interval((time.perf_counter() - started) * 1000.0)
            out.extend(self._release())
        return out

    def flush(self) -> List[bytes]:
        """Release everything still held, verdicts as they stand.

        Called once, when the recording stops. Holding the tail back would
        cost the last second of every recording, which is a cut in another
        costume — so what is left leaves with the verdict standing now.
        """
        out: List[bytes] = []
        while self._held:
            share = self._voice_share()
            hop, voiced = self._held.popleft()
            if voiced:
                self._voiced_held -= 1
            out.append(self._hop_out(hop, voiced, share, final=True))
        self._held_bytes = 0
        self._voiced_held = 0
        if self._partial:
            out.append(bytes(self._partial))
            self._partial.clear()
        return out

    # -- internals ---------------------------------------------------------

    def _hop_out(self, hop: bytes, voiced: bool, share: float, final: bool = False) -> bytes:
        """The one place a decision becomes bytes, counted as it happens."""
        if self._keep(voiced, share, final):
            return hop
        self._withheld_bytes += len(hop)
        return _silence(len(hop))

    def _keep(self, voiced: bool, share: float, final: bool = False) -> bool:
        """Whether a hop leaving *now* goes through untouched (§4.7).

        Read at release, not at arrival: the window that scores starts at
        this hop, so the verdict standing here is the one about this audio.
        Labelling on arrival instead means labelling with a window that
        ended before the hop began — which reads a stranger's turn as the
        owner's and the owner's as a stranger's, and is how the first
        0.75 s of the owner's turn after a handover got zeroed.

        ``share`` is the voice share of the window this hop heads, taken
        before the hop leaves it: read after, the last hop of a recording
        would see an empty queue, call itself silence, and walk through a
        gate that had just refused its neighbours.
        """
        if not voiced:
            # Silence carries no verdict to give (§4.6).
            return True
        if not self._judged:
            # The opening window is spent learning who is speaking: nothing
            # leaves before the first verdict exists, so a stranger who talks
            # first is never heard. It costs the owner's first two seconds of
            # the LIVE copy and nothing else — the take keeps every byte, and
            # a press shorter than one window has no verdict to wait for, so
            # `flush` releases it as it stands (no evidence is not a refusal).
            return final
        if self._verdict is None:
            # No voice in the window covering this hop: silence already.
            return True
        if self._open:
            # The gate is standing open on the owner: keep until it closes.
            return True
        if self._verdict > self._close_at:
            # A verdict inside the band is a shrug, not a refusal: the
            # window is neither clearly the owner nor clearly not. Zeroing
            # on a shrug is a cut with extra steps (§4.4).
            return True
        if self._tail_left > 0:
            # §4.3's tail, read where it belongs: the audio leaving after a
            # close is the end of the owner's turn, not the start of the
            # stranger's.
            self._tail_left -= 1
            return True
        return False

    def _worth_a_verdict(self, arrived_voiced: bool) -> bool:
        """Whether this hop is the moment to score the window.

        The condition is *the window*, not the hop that closed it (§4.6):
        a window with no voiced frame is silence already and has nothing
        to say, and a window with one is worth its 38 ms. Asking about the
        arriving hop instead is what left a stranger's verdict standing
        over the owner's first phoneme — the hop that ends the window is
        very often a pause, because the owner's last word is a second and
        a half back, and no verdict was taken at the one instant the
        label mattered.

        It costs nothing at the worst moment. While someone is talking the
        arriving hop is voiced and this returns immediately, so the peak
        rate — one judgement per hop, which is what §4.7's lookahead
        already pays for — is unchanged; the extra calls happen in pauses,
        where the thread was idle anyway.
        """
        if self._verdict_interval_hops and self._hops_since_verdict < self._verdict_interval_hops:
            return False
        if arrived_voiced:
            return True
        return self._voice_share() >= MIN_VOICED_SHARE

    def _retune_interval(self, judgement_ms: float) -> None:
        """Keep the next verdict three judgements away, whatever they cost."""
        if judgement_ms <= 0.0:
            return
        self._verdict_interval_hops = max(1, int(round(3.0 * judgement_ms / max(1, self._hop_ms))))

    def _voice_share(self) -> float:
        """How much of the window now held carries voice, in [0, 1]."""
        if not self._held:
            return 0.0
        return self._voiced_held / len(self._held)

    def _judge(self) -> None:
        if self._held_bytes < self._window_bytes:
            return
        verdict = self._scorer(self._window())
        self._judged = True
        self._verdict = verdict
        if verdict is None:
            # §4.6: no voiced frame, nothing to refuse.
            return
        if self._voice_share() < MIN_VOICED_SHARE:
            # A window that is mostly room moves the gate neither way: it
            # is not evidence that this is a stranger, and closing on it is
            # how the owner's own quiet window gets cut.
            return
        if verdict >= self._open_at:
            self._open = True
            self._tail_left = 0
        elif verdict <= self._close_at:
            if self._open:
                self._tail_left = self._tail_hops
            self._open = False

    def _window(self) -> bytes:
        """The last ``window_bytes`` of held audio, oldest first."""
        chunks: List[bytes] = []
        want = self._window_bytes
        for hop, _voiced in reversed(self._held):
            chunks.append(hop)
            want -= len(hop)
            if want <= 0:
                break
        chunks.reverse()
        joined = b"".join(chunks)
        return joined[-self._window_bytes :]

    def _release(self) -> List[bytes]:
        """Emit hops while more than one window is held."""
        out: List[bytes] = []
        while self._held_bytes > self._window_bytes:
            share = self._voice_share()
            hop, voiced = self._held.popleft()
            self._held_bytes -= len(hop)
            if voiced:
                self._voiced_held -= 1
            out.append(self._hop_out(hop, voiced, share))
        return out


def _silence(nbytes: int) -> bytes:
    """Zeroed PCM16LE of exactly ``nbytes`` — the timeline's own length."""
    return bytes(nbytes)


__all__ = [
    "DEFAULT_CLOSE_AT",
    "DEFAULT_HOP_MS",
    "DEFAULT_OPEN_AT",
    "DEFAULT_TAIL_MS",
    "DEFAULT_WINDOW_MS",
    "Scorer",
    "VoiceMask",
]
