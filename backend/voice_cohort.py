"""The ruler the score is read against: other people's voices, as a fixed set.

This is AS-Norm's cohort, the one piece of a verification system that turns a
cosine into a number with a meaning: how many spreads above the average stranger
a window sits. Measured on this desk 2026-11-25 over nineteen takes - twelve of
the owner, seven not - the equal error rate of the raw cosine at 0 dB of added
noise was unusable, and 3.5% once read against a cohort of 87 vectors built from
the takes that were not his.

The set is finite and small on purpose: a hundred-odd voices are enough to say
what "average stranger" means. It is not a model of every person alive, and it
does not need to be - it is a ruler, not a judgement.
"""

import json
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np

#: How many vectors the ruler keeps. Above a few hundred the mean and the spread
#: stop moving, and the file stops being a thing the desk can rebuild in a second.
COHORT_LIMIT = 400

#: A recording whose windows sit this far from a track is somebody else's voice,
#: and its windows may join the ruler. Measured: the owner's own takes sit at
#: 0.70-0.83 against his track and the ones that are not him at 0.30-0.45.
IMPOSTOR_BELOW = 0.55

#: The z at which the gate opens and closes, from the measured equal error rate
#: on this desk (1.2% dry, 3.5% at 0 dB, threshold z between 1.1 and 1.8). It is
#: the model's calibration, not a per-desk taste, and it moves only with the
#: cohort - which is why it is checked by a test against the cohort's own data.
OPEN_Z = 1.8
CLOSE_Z = 1.2


def _unit(vector: Sequence[float] | np.ndarray) -> np.ndarray:
    array = np.asarray(vector, dtype=np.float64).reshape(-1)
    norm = float(np.linalg.norm(array))
    return array / norm if norm > 0 else array


def load(path: Path) -> np.ndarray:
    """Every vector in the ruler, as a matrix of unit rows (empty when unset)."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return np.zeros((0, 0), dtype=np.float64)
    rows = raw.get("vectors") if isinstance(raw, dict) else raw
    if not isinstance(rows, list) or not rows:
        return np.zeros((0, 0), dtype=np.float64)
    matrix = np.stack([_unit(row) for row in rows if row])
    return matrix


def save(path: Path, vectors: Iterable[Sequence[float] | np.ndarray]) -> int:
    """Keep at most COHORT_LIMIT of the newest vectors, and say how many."""
    rows = [_unit(vector).tolist() for vector in vectors]
    rows = rows[-COHORT_LIMIT:]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(
        json.dumps({"vectors": rows}, ensure_ascii=False),
        encoding="utf-8",
    )
    return len(rows)


def zscore(vector: Sequence[float] | np.ndarray, track: Sequence[float], cohort: np.ndarray) -> Optional[float]:
    """How many spreads this window sits above the average stranger.

    ``None`` when the ruler is too short to mean anything: a z from five vectors
    is a guess wearing a number's clothes.
    """
    if cohort.size == 0 or cohort.shape[0] < 20:
        return None
    unit = _unit(vector)
    raw = float(np.dot(unit, _unit(track)))
    against = cohort @ unit
    spread = float(against.std())
    if spread <= 1e-6:
        return None
    return (raw - float(against.mean())) / spread


def score_from_z(z: float) -> float:
    """The gate's [0, 1] scale, from the z: monotonic, so the pair keeps its order."""
    return float(1.0 / (1.0 + np.exp(-float(z))))


def pair_from_z() -> tuple[float, float]:
    """The open/close pair on that scale, from the measured z."""
    return score_from_z(OPEN_Z), score_from_z(CLOSE_Z)
