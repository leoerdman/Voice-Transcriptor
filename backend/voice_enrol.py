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
from typing import Callable, List, Optional, Sequence, Tuple

import numpy as np

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ, pcm16_bytes_per_sec
from backend.voice_embed import SpeakerEmbedder, cosine, mean_direction, unit_vectors
from backend.voice_mask import DEFAULT_WINDOW_MS

logger = logging.getLogger(__name__)

#: Half a window, so neighbouring windows share half their audio and a take
#: that is "mostly the same sentence" is not one sentence counted twice.
HOP_MS = DEFAULT_WINDOW_MS // 2
#: Measured, not taste: one speaker's two halves agree at 0.59 and up on a
#: real press (the owner's, 2026-11-19, six seconds with pauses in it), while a
#: capture holding two voices — one person answering another mid-press — lands
#: far below. §4.5's own numbers say the same from the other end (a 1.5 s window
#: agrees with itself at 0.692 and a stranger sits at 0.116), so 0.5 refuses a
#: capture nobody could use while keeping a real one — a floor set at 0.6
#: refused that press by one point.
MIN_HALF_AGREEMENT = 0.5
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
            "a take shorter than Solo's window cannot make a profile; "
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
        raise EnrolmentError("no speech Solo could hear in this take")
    vectors = unit_vectors(embedder, windows)
    profile = mean_direction(vectors)
    if profile is None:
        raise EnrolmentError("this take gave the net nothing to embed")
    if len(vectors) >= 2:
        midpoint = len(vectors) // 2
        first = mean_direction(vectors[:midpoint])
        second = mean_direction(vectors[midpoint:])
        agreement = (
            cosine(first, second)
            if first is not None and second is not None
            else 0.0
        )
        if agreement < MIN_HALF_AGREEMENT:
            raise EnrolmentError(
                "the two halves of this press do not sound like one person "
                f"(agreement {agreement:.2f}, floor {MIN_HALF_AGREEMENT:.2f}): "
                "press again and speak alone, with nobody else talking"
            )
    return profile


def enrol_take_stats(
    embedder: SpeakerEmbedder,
    pcm: bytes,
    *,
    voiced: Optional[Callable[[bytes], bool]] = None,
) -> Tuple[np.ndarray, float]:
    """The profile, and the voice's own floor: how alike its windows are.

    The floor is what makes a threshold portable. A voice recorded well scores
    its own windows near 0.9 and a stranger near 0.4 of that; a voice recorded
    badly scores its own near 0.6 and a stranger near 0.25. Absolute cut-offs
    measured on one machine refused both voices on another (2026-11-21), so the
    gate's thresholds are a share of this number instead of a constant.
    """
    profile = enrol_take(embedder, pcm, voiced=voiced)
    heard = voiced if voiced is not None else _has_voice
    windows = [window for window in enrol_windows(pcm) if heard(window)]
    vectors = unit_vectors(embedder, windows)
    if not vectors:
        return profile, 0.0
    against = [cosine(vector, profile) for vector in vectors]
    return profile, float(np.median(against))

def enrol_prototypes(
    embedder: SpeakerEmbedder,
    pcm: bytes,
    *,
    count: int = 6,
    voiced: Optional[Callable[[bytes], bool]] = None,
) -> Tuple[List[np.ndarray], float]:
    """The voice as a handful of its own windows, and how well its halves agree.

    One mean vector is an average of every way the voice sounded in the take,
    and a noisy window is scored against that average rather than against the
    nearest way the voice actually sounds. A prototype set keeps several of
    them; the gate scores a window by its best match, which is what keeps a
    noisy or distant take recognisable.

    ``agreement`` is the test-retest measure this identifier has without an
    impostor set: the mean of the take's first half scored against the mean of
    its second. A voice that agrees with itself at 0.9 on this microphone gets a
    high pair; one that manages 0.6 gets a low pair, because that is all the
    evidence the recording carries.
    """
    heard = voiced if voiced is not None else _has_voice
    windows = [window for window in enrol_windows(pcm) if heard(window)]
    vectors = unit_vectors(embedder, windows)
    if not vectors:
        return [], 0.0
    agreement = 0.0
    if len(vectors) >= 2:
        midpoint = len(vectors) // 2
        first = mean_direction(vectors[:midpoint])
        second = mean_direction(vectors[midpoint:])
        if first is not None and second is not None:
            agreement = cosine(first, second)
    wanted = max(1, min(int(count), len(vectors)))
    if wanted == len(vectors):
        picks = list(vectors)
    else:
        picks = [vectors[round(index * (len(vectors) - 1) / (wanted - 1))] for index in range(wanted)]
    return picks, float(agreement)

def take_level_db(pcm: bytes, *, voiced: Optional[Callable[[bytes], bool]] = None) -> float:
    """The level this take's own voice sits at, dBFS RMS.

    A microphone hears the person at the desk first and everybody else far
    behind it: measured on this desk 2026-11-21, the neighbour's voice arrived
    10-12 dB down. The enrolled level is therefore the desk's near field, and a
    frame much below it is somebody else in the room — no voice model needed.
    """
    heard = voiced if voiced is not None else _has_voice
    levels = []
    for window in enrol_windows(pcm):
        if not heard(window):
            continue
        samples = np.frombuffer(window, dtype="<i2").astype(np.float64) / 32768.0
        rms = float(np.sqrt(np.mean(samples**2)))
        if rms > 0.0:
            levels.append(20.0 * float(np.log10(rms)))
    if not levels:
        return 0.0
    return float(np.median(levels))