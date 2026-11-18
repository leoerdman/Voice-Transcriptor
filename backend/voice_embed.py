"""The net behind the gate: an 80-dim fbank, one ONNX file, a cosine.

§2.3 asks for nothing new in requirements, and this adds none: onnxruntime
arrives with faster-whisper (`Requires: av, ctranslate2, huggingface-hub,
onnxruntime, tokenizers, tqdm`), numpy with the same, and the filterbank is
written here — kaldi-native-fbank is not in requirements, and one mel bank is
cheaper than a wheel no other module needs.

§2.5 asks for a cosine over embeddings and not a judgement: no text, no
prompt, no model call. That is the whole of what `SpeakerScorer` returns.

The weights are a file the caller names. `default_model_path()` is where the
app looks for the one that ships beside it, and whether that file ships at all
is the owner's decision (§6.2), not this module's.

The features are Kaldi's, because the model was trained on them: 25 ms hann
frames every 10 ms, mean removed per frame, power spectrum at 512, 80
triangular mel filters from 20 Hz to Nyquist, natural log, then the global
mean subtracted per dimension (`feature_normalize_type=global-mean` in the
file's own metadata). The numbers this produces were checked against
kaldi-native-fbank on real takes: same scores to three digits.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence

import numpy as np

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ

logger = logging.getLogger(__name__)

FEATURE_DIM = 80
FRAME_MS = 25.0
HOP_MS = 10.0
MEL_LOW_HZ = 20.0
#: Kaldi's `Log()` clips to float epsilon; a zero-energy bin is a real thing
#: in digital silence and must not become -inf.
_LOG_FLOOR = 1e-10


def default_model_path() -> Path:
    """Where the app looks for the one ONNX file it ships beside itself."""
    return Path(__file__).resolve().parent.parent / "models" / "campplus_zh_en.onnx"


@lru_cache(maxsize=8)
def _mel_bank(
    rate_hz: int = LIVE_SAMPLE_RATE_HZ,
    n_fft: int = 512,
    bins: int = FEATURE_DIM,
    low_hz: float = MEL_LOW_HZ,
    high_hz: float = 0.0,
) -> np.ndarray:
    """Kaldi's triangular bank: ``bins`` triangles, evenly spaced in mel.

    ``high_hz == 0`` means Nyquist, the same convention the extractor uses.
    Triangles are built in the mel domain and read back on the FFT's own
    frequency grid, which is what Kaldi does — building them in Hz instead
    shifts every centre slightly and the scores drift with them.
    """
    high = high_hz if high_hz > 0 else rate_hz / 2.0
    mel = lambda f: 1127.0 * np.log(1.0 + np.asarray(f, dtype=np.float64) / 700.0)  # noqa: E731
    inverse = lambda m: 700.0 * (np.exp(np.asarray(m, dtype=np.float64) / 1127.0) - 1.0)  # noqa: E731

    mel_low, mel_high = float(mel(low_hz)), float(mel(high))
    delta = (mel_high - mel_low) / (bins + 1)

    freqs = np.linspace(0.0, rate_hz / 2.0, n_fft // 2 + 1)
    fft_mel = mel(freqs)

    bank = np.zeros((bins, freqs.size), dtype=np.float32)
    for i in range(bins):
        left = mel_low + i * delta
        centre = left + delta
        right = centre + delta
        rising = (fft_mel - left) / (centre - left)
        falling = (right - fft_mel) / (right - centre)
        bank[i] = np.clip(np.minimum(rising, falling), 0.0, None)
    return bank


def _frame_count(n_samples: int, frame: int, shift: int) -> int:
    """Kaldi's count for ``snip_edges=false``: every sample lands in a frame."""
    return max(0, (n_samples + shift // 2) // shift)


def _frames(x: np.ndarray, frame: int, shift: int) -> np.ndarray:
    """Overlapping frames, edges mirrored — Kaldi's `snip_edges=false` rule.

    Frame ``i`` is centred on ``i*shift + shift/2``; the first one therefore
    starts before zero, and Kaldi reflects the waveform at both ends rather
    than dropping the frame. Keeping that matters at the head of a window:
    the gate's first verdict is exactly that frame.
    """
    count = _frame_count(x.size, frame, shift)
    if count == 0:
        return np.empty((0, frame), dtype=np.float32)
    starts = np.arange(count) * shift + shift // 2 - frame // 2
    idx = starts[:, None] + np.arange(frame)
    # One reflection at each edge is all Kaldi ever needs, and all this can
    # do: a window is always longer than a frame.
    idx = np.where(idx < 0, -idx, idx)
    idx = np.where(idx >= x.size, 2 * (x.size - 1) - idx, idx)
    return x[np.clip(idx, 0, x.size - 1)].astype(np.float32)


def fbank80(pcm: bytes, rate_hz: int = LIVE_SAMPLE_RATE_HZ) -> np.ndarray:
    """PCM16LE mono -> (frames, 80) log-mel, globally mean-normalised.

    An empty array when the audio is shorter than one frame: "there is
    nothing to embed" is a real answer, and the caller turns it into the
    ``None`` the gate reads as *no voice here*.
    """
    usable = len(pcm) - (len(pcm) % 2)
    if usable < 2:
        return np.empty((0, FEATURE_DIM), dtype=np.float32)
    x = np.frombuffer(bytes(pcm[:usable]), dtype="<i2").astype(np.float32) / 32768.0

    frame = int(round(FRAME_MS * rate_hz / 1000.0))
    shift = int(round(HOP_MS * rate_hz / 1000.0))
    frames = _frames(x, frame, shift)
    if frames.shape[0] == 0:
        return np.empty((0, FEATURE_DIM), dtype=np.float32)

    # hann as Kaldi builds it, then DC removal on the windowed frame.
    window = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(frame) / (frame - 1))
    frames = frames * window
    frames -= frames.mean(axis=1, keepdims=True)

    n_fft = 1 << int(np.ceil(np.log2(frame)))
    spectrum = np.fft.rfft(frames, n=n_fft, axis=1)
    power = spectrum.real**2 + spectrum.imag**2

    bank = _mel_bank(rate_hz, n_fft, FEATURE_DIM)
    feats = np.log(np.maximum(power @ bank.T, _LOG_FLOOR))

    # global-mean: the model's own metadata asks for it, and it is what makes
    # a quiet take and a loud one comparable at all.
    feats -= feats.mean(axis=0, keepdims=True)
    return feats.astype(np.float32)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine between two vectors, with the guard a zero vector needs."""
    na, nb = float(np.linalg.norm(a)), float(np.linalg.norm(b))
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _has_voice(window: bytes) -> bool:
    """The frame test §4.3 names, imported where it already lives.

    Deferred on purpose: `backend.deepgram_warm` pulls the live Deepgram
    stack behind it, and this module is imported by the gate, which is
    imported by tests that want none of that. By the time a gate runs, the
    live session has long since loaded it and the import is a dict lookup.
    """
    from backend.deepgram_warm import pcm_has_voice

    return pcm_has_voice(window)


class SpeakerEmbedder:
    """One ONNX file, loaded on first use, unloaded on request (§2.2).

    The session is created lazily because a profile can exist without a
    recording ever being made, and 27 MB of weights do not need to be mapped
    to answer a settings page. `close()` is what the owner of the stage calls
    when the channel goes idle; the policy lives there, not here.
    """

    def __init__(self, model_path: Optional[Path] = None, *, threads: int = 2) -> None:
        self._path = Path(model_path) if model_path is not None else default_model_path()
        self._threads = max(1, int(threads))
        self._session = None
        self._input_name = ""
        self._output_name = ""

    @property
    def model_path(self) -> Path:
        return self._path

    def _load(self):
        import onnxruntime as ort

        options = ort.SessionOptions()
        # Two threads is the measured sweet spot for a 2 s window: 25 ms
        # median against 38 ms on one (see DEFAULT_HOP_MS).
        options.intra_op_num_threads = self._threads
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        session = ort.InferenceSession(
            str(self._path), options, providers=["CPUExecutionProvider"]
        )
        self._input_name = session.get_inputs()[0].name
        outputs = [o.name for o in session.get_outputs()]
        # CAM++ answers `embedding`; the same family sometimes carries a
        # classifier head beside it, and that one is never the answer.
        self._output_name = (
            "embedding" if "embedding" in outputs else ("embs" if "embs" in outputs else outputs[0])
        )
        return session

    def close(self) -> None:
        self._session = None

    def embed(self, pcm: bytes) -> Optional[np.ndarray]:
        """A unit-length embedding, or ``None`` when the audio cannot carry one."""
        feats = fbank80(pcm)
        if feats.shape[0] == 0:
            return None
        if self._session is None:
            self._session = self._load()
        out = self._session.run([self._output_name], {self._input_name: feats[None]})[0][0]
        vector = np.asarray(out, dtype=np.float32)
        norm = float(np.linalg.norm(vector))
        if norm <= 0.0:
            return None
        return vector / norm


class SpeakerScorer:
    """``bytes -> Optional[float]``: the one callable the gate wants.

    ``None`` is not a low score, it is the absence of a judgement: a window
    with no voiced frame (§4.6) is silence already, and the gate leaves it
    alone rather than weighing it.
    """

    def __init__(
        self,
        embedder: SpeakerEmbedder,
        profile: np.ndarray,
        *,
        voiced: Optional[Callable[[bytes], bool]] = None,
    ) -> None:
        vector = np.asarray(profile, dtype=np.float32)
        norm = float(np.linalg.norm(vector))
        if vector.ndim != 1 or norm <= 0.0:
            raise ValueError("a profile is a non-zero vector")
        self._embedder = embedder
        self._profile = vector / norm
        # Same injection the gate already takes, for the same reason: a test
        # of the arithmetic should not have to load a live audio stack.
        self._voiced = voiced if voiced is not None else _has_voice

    @property
    def profile(self) -> np.ndarray:
        """The enrolled vector, unit length — what a store persists (§1.3)."""
        return self._profile

    def __call__(self, window: bytes) -> Optional[float]:
        if not self._voiced(window):
            return None
        embedding = self._embedder.embed(window)
        if embedding is None:
            return None
        # A cosine, not a dot: the embedder is expected to hand back unit
        # vectors, but a score that silently scales with someone else's norm
        # is a threshold nobody can reason about.
        return cosine(embedding, self._profile)

    @classmethod
    def enrol(
        cls,
        embedder: SpeakerEmbedder,
        windows: Sequence[bytes],
        *,
        voiced: Optional[Callable[[bytes], bool]] = None,
    ) -> Optional["SpeakerScorer"]:
        """A take becomes a profile by an act (§5.5), never by inference.

        The mean of the unit embeddings and nothing else: averaging
        unnormalised vectors lets the loudest window decide who the owner is.
        ``None`` when not one window could be embedded — an empty profile is
        a stranger to everyone, including its owner.
        """
        vectors: Iterable[np.ndarray] = (
            v for v in (embedder.embed(w) for w in windows) if v is not None
        )
        stacked = []
        for vector in vectors:
            norm = float(np.linalg.norm(vector))
            if norm <= 0.0:
                continue
            stacked.append(np.asarray(vector, dtype=np.float32) / norm)
        if not stacked:
            return None
        return cls(embedder, np.mean(np.stack(stacked), axis=0), voiced=voiced)
