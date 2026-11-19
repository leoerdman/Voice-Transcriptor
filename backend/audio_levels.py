"""One capture session's own level — the frame test Solo reads (§4.3).

The rule's home is `frontend/src/audio-levels.ts`, where it was measured and
where its renderer tests live: nothing there compares against a fixed
amplitude, because the gain a capture stack chooses is a property of the
machine and not of the speaker. This is the backend twin — the same constants
and the same updates — because the gate runs here and the TypeScript copy
cannot be imported. Both sides must move together; the rule is not restated.

Why it exists at all: on the owner's desk (2026-11-19) speech sat at −23…−30
dBFS peak over a −53 dBFS room. The absolute floor `pcm_has_voice` uses
(peak > 655, ≈ −34 dBFS) called so few hops voiced that the gate's share never
reached the 0.5 it needs to refuse, so with a stranger's profile enabled Solo
forwarded everything and that speech was transcribed. The same audio sits 30
to 40 times above its own room, so a relative floor refuses it as designed.
"""

from __future__ import annotations

import array
import math

#: How far above the session's room a frame must rise to count as speech,
#: and how far its PEAK must rise to count on its own (a short transient).
SPEECH_OVER_FLOOR_RATIO = 4.0
SPEECH_PEAK_CREST_RATIO = 4.0
#: The floor follows down fast and up slowly, and up only from frames that
#: are not already speech: letting a phrase feed it measures the speech
#: against itself and goes deaf halfway through a sentence.
FLOOR_FALL = 0.25
FLOOR_RISE = 0.0008
#: One 16-bit LSB. A dead pipeline reports exact zeros and four times zero
#: is still zero, so nothing would ever be speech without this anchor.
FLOOR_MIN_RMS = 1.0 / 32768.0
#: The floor may not fall below this fraction of the loudest frame seen. The
#: quietest hop of a recording is not always a room: a gate that closes between
#: phrases reports digital silence, a floor planted on it makes every other
#: frame speech, and the gate then measures the room instead of the voice —
#: measured on this desk as a voiced share of 1.00 over a −53 dBFS room. A
#: 64th of a −30 dBFS peak is −66 dBFS, an order under that room and two under
#: speech, so the anchor never hides a real voice.
FLOOR_ANCHOR_RATIO = 1.0 / 64.0


def frame_levels(pcm: bytes) -> tuple[float, float]:
    """``(rms, peak)`` of PCM16LE mono, both as a fraction of full scale."""
    usable = len(pcm) - (len(pcm) % 2)
    if usable <= 0:
        return 0.0, 0.0
    samples = array.array("h", pcm[:usable])
    peak = 0
    total = 0
    for sample in samples:
        magnitude = -sample if sample < 0 else sample
        if magnitude > peak:
            peak = magnitude
        total += sample * sample
    return math.sqrt(total / len(samples)) / 32768.0, peak / 32768.0


class SessionVoice:
    """``bytes -> bool``: did this frame rise above the session's own room?

    The same callable answers for the gate's 50 ms hops and for the two-second
    window the scorer weighs: both are frames of this signal, the floor only
    moves on frames that are not speech, and a spoken syllable clears the
    ratio at either length.
    """

    def __init__(self) -> None:
        self.frames = 0
        self.floor_rms = 0.0
        self.peak_max = 0.0
        self.speech_frames = 0

    def __call__(self, pcm: bytes) -> bool:
        rms, peak = frame_levels(pcm)
        # Taken against the floor as it stood BEFORE this frame, so a loud
        # frame cannot lift the threshold it is being judged against.
        threshold = max(
            self.floor_rms, self.peak_max * FLOOR_ANCHOR_RATIO, FLOOR_MIN_RMS
        ) * SPEECH_OVER_FLOOR_RATIO
        speech = self.frames > 0 and (
            rms >= threshold or peak >= threshold * SPEECH_PEAK_CREST_RATIO
        )
        if self.frames == 0:
            self.floor_rms = rms
        elif rms < self.floor_rms:
            self.floor_rms += (rms - self.floor_rms) * FLOOR_FALL
        elif not speech:
            self.floor_rms += (rms - self.floor_rms) * FLOOR_RISE
        self.floor_rms = max(self.floor_rms, self.peak_max * FLOOR_ANCHOR_RATIO)
        self.frames += 1
        if peak > self.peak_max:
            self.peak_max = peak
        if speech:
            self.speech_frames += 1
        return speech
