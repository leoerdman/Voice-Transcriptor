"""A take becomes a profile by an act (§5.5), and never by inference.

`voice_embed` ends at "here is a vector for this audio"; `voice_profiles`
begins at "here is the vector for this slot". The step between them is a
recording the user already has: decoded to the one format the net was
trained on, cut into the same windows the gate will later compare, and
averaged.

Nothing here listens on its own, and nothing here is called by the capture
path. §5.5 is explicit that a profile is made in Settings by a press; this
module exists so that press has one place to land, and so that "what counts
as a take" is testable without a microphone.

The window is the gate's window, imported rather than repeated: a profile
measured over 1 s and compared over 2 s is two different acoustics wearing
one cosine, and the threshold would mean neither of them.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Callable, List, Optional, Sequence

import numpy as np

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ, pcm16_bytes_per_sec
from backend.voice_embed import SpeakerEmbedder, SpeakerScorer
from backend.voice_mask import DEFAULT_WINDOW_MS

logger = logging.getLogger(__name__)

#: Half a window, so neighbouring windows share half their audio and a take
#: that is "mostly the same sentence" is not one sentence counted twice.
HOP_MS = DEFAULT_WINDOW_MS // 2
#: A mean over 40 s of speech is as good as a mean over ten minutes, and this
#: keeps enrolment at one press rather than one coffee: 20 windows is ~0.5 s
#: of net time (a 2 s window costs ~25 ms on two threads, see
#: `voice_mask.DEFAULT_HOP_MS`).
MAX_WINDOWS = 20


class EnrolmentError(ValueError):
    """A take the app will not turn into a profile, with the reason why."""


def _has_voice(window: bytes) -> bool:
    """§4.3's frame test, from where it already lives — imported late.

    Same reasoning as `voice_embed._has_voice`: the module that slices bytes
    should not drag the live Deepgram stack in behind it.
    """
    from backend.deepgram_warm import pcm_has_voice

    return pcm_has_voice(window)


def decode_take(path: Path) -> bytes:
    """A take as the net wants it: 16 kHz, mono, PCM16 little-endian.

    The recording archive holds what the app wrote (already 16 kHz mono
    PCM16) and whatever a user imported (anything soundfile or ffmpeg can
    read). `ensure_wav_16k` is the app's one answer to that range, and its
    fast path is a copy, so the common case pays nothing for the generality.
    """
    import soundfile as sf

    from backend.audio import AudioError, ensure_wav_16k

    source = Path(path)
    if not source.is_file():
        raise EnrolmentError("this take has no audio beside it")

    # A directory, not a NamedTemporaryFile: ensure_wav_16k writes to a path
    # of its own choosing (copy-and-rename), so it needs somewhere to choose
    # from rather than a handle Windows would hold open.
    with tempfile.TemporaryDirectory(prefix="vt-enrol-") as tmp:
        target = Path(tmp) / "take.wav"
        try:
            ensure_wav_16k(str(source), str(target), channels=1)
        except AudioError as e:
            raise EnrolmentError(str(e)) from None
        if not target.is_file():
            raise EnrolmentError("this take could not be decoded")
        # int16, never float: soundfile's float path divides PCM16 by 32768,
        # and multiplying back by 32767 would move every sample by a bit.
        data, rate = sf.read(str(target), dtype="int16", always_2d=True)

    if rate != LIVE_SAMPLE_RATE_HZ:
        raise EnrolmentError(
            f"this take decoded to {rate} Hz, not the {LIVE_SAMPLE_RATE_HZ} Hz the net expects"
        )
    return np.ascontiguousarray(data[:, 0], dtype="<i2").tobytes()


def enrol_windows(
    pcm: bytes,
    *,
    window_ms: int = DEFAULT_WINDOW_MS,
    hop_ms: int = HOP_MS,
    limit: int = MAX_WINDOWS,
) -> List[bytes]:
    """Full windows across the take, evenly thinned to ``limit``.

    Every window is the gate's own length and on its own grid, because the
    vector is going to be compared against exactly those windows. A take
    shorter than one window is refused rather than padded: padding a profile
    with silence is how a stranger ends up inside it.
    """
    window = window_ms * pcm16_bytes_per_sec(LIVE_SAMPLE_RATE_HZ) // 1000
    hop = hop_ms * pcm16_bytes_per_sec(LIVE_SAMPLE_RATE_HZ) // 1000
    usable = len(pcm) - (len(pcm) % 2)
    if usable < window:
        raise EnrolmentError(
            "a take shorter than the mask's window cannot make a profile; "
            "record at least two seconds of speech"
        )

    starts = list(range(0, usable - window + 1, hop))
    if len(starts) > limit:
        # Evenly across the whole take, not the first N seconds: a press at
        # the top of a long recording would otherwise enrol its throat-clearing.
        picks = np.linspace(0, len(starts) - 1, limit).round().astype(int)
        starts = [starts[i] for i in sorted({int(p) for p in picks.tolist()})]
    return [pcm[start : start + window] for start in starts]


def enrol_take(
    embedder: SpeakerEmbedder,
    pcm: bytes,
    *,
    voiced: Optional[Callable[[bytes], bool]] = None,
) -> np.ndarray:
    """The mean of the take's voiced windows, unit length.

    Unvoiced windows are dropped before the net sees them. A silence window
    still embeds — it embeds the room — and averaging the room into a voice
    pulls the profile toward every stranger who ever sat in it. The gate
    will never score such a window anyway (§4.6), so the profile should not
    be made of them either.
    """
    heard = voiced if voiced is not None else _has_voice
    windows: Sequence[bytes] = [w for w in enrol_windows(pcm) if heard(w)]
    if not windows:
        raise EnrolmentError("no speech the mask could hear in this take")
    scorer = SpeakerScorer.enrol(embedder, windows)
    if scorer is None:
        raise EnrolmentError("this take gave the net nothing to embed")
    return scorer.profile
