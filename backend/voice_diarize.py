"""Who is speaking, decided by comparing voices in the room to each other.

Absolute similarity to an enrolled voice fails across sessions: measured here
2026-11-24, the owner's own windows scored 0.336 against his profile in one
recording and 0.318 for a different speaker in another — a gap of 0.018,
inside the noise. Every threshold built on that number cuts the owner and
keeps the stranger in roughly equal measure, which is exactly what the owner
kept reporting.

The same audio, judged *relatively*, separates perfectly: clustering one
recording's windows into two voices put 100% of each speaker in their own
cluster, and the margin between the two centroids — how much closer a window
is to the voice nearest the enrolment than to the other one — splits them at
+0.38 for the owner against −0.43 for the other speaker, with no overlap.

That is also how a person does it: nobody compares a voice to an absolute
template in their head. They hear the voices of a room against one another,
and the familiar one wins.

So this module keeps the recent windows of a recording, clusters them, and
answers with that margin. It degrades honestly: before there are enough
windows to see two voices it says so, and the caller keeps its old rule.
"""

from __future__ import annotations

from collections import deque
from typing import Any, Deque, List, Optional, Sequence, Tuple

import numpy as np

#: How many recent windows the clustering looks at — about a minute at a 1 s
#: hop. Long enough for both voices to appear, short enough that a voice which
#: left the room stops shaping the decision.
DEFAULT_WINDOW_LIMIT = 60

#: Below this many windows a two-way split is a coin toss, not a measurement.
MIN_WINDOWS = 6

#: Two centroids this close are one voice, not two: a room with a single
#: speaker must not be split into "owner" and "noise" and have half withheld.
SAME_VOICE_COSINE = 0.75

#: The first windows of a recording are the owner starting to talk. That many
#: make a session-local model he can be compared with straight away, so a
#: stranger who speaks at the fifth second is judged then rather than after the
#: twenty seconds a two-way split would have waited for. Measured on the desk
#: 2026-11-24: from two windows the other voice already peaks at 0.30 against
#: the owner's 0.65, so three is the safe floor.
BOOTSTRAP_WINDOWS = 3

#: Two clusters this close in similarity to the enrolment cannot be told
#: apart by it: the roles stay as they are rather than swapping mid-take.
TIE_MARGIN = 0.06

#: How close a window must sit to a learned track before the room is allowed
#: to say anything about it. Without this floor the session owner was simply
#: whoever dominated the room: measured on the desk 2026-11-25, a take of a
#: voice that scored 0.21-0.25 against the owner's track was held OPEN for
#: 27.7 of its 34.5 seconds, because the gate let the room pick its owner and
#: then asked how close each window was to that pick. His own windows sit at
#: 0.50-0.87 against the same track, so 0.45 is inside the gap and closer to
#: the lower half of it: cutting his own words costs him a sentence, and
#: passing a stranger's words costs him the feature.
TRACK_FLOOR = 0.45

#: The margin a window must reach to count as the owner's own voice. Measured
#: on the desk 2026-11-24: the owner's windows never fell below +0.23 and the
#: other speaker's never rose above −0.23, so zero sits in the middle of a
#: half-unit gap rather than on its edge.
#: Where the gate opens and closes on that similarity. Measured on the desk
#: 2026-11-24 over a mixed take: at 0.50 the owner kept 84% of his windows and
#: the other speaker kept none (his own never rose above 0.419); at 0.45 the
#: owner kept 87% but 7% of the stranger leaked in.
DEFAULT_OPEN_MARGIN = 0.50
DEFAULT_CLOSE_MARGIN = 0.42


def _pairs(profile: Any) -> Optional[list]:
    """The ``[(slot, vector), …]`` form, when that is what was handed in."""
    if (
        isinstance(profile, (list, tuple))
        and profile
        and isinstance(profile[0], (tuple, list))
        and len(profile[0]) == 2
    ):
        return list(profile)
    return None


def _as_profiles(profile: Any) -> list[np.ndarray]:
    """One voice or several, as unit vectors.

    Several tracks are versions of the owner's voice — one learned at the desk,
    one in a quiet room — so a window matching any of them is his. That is why
    the gate takes a list instead of a slot: the owner should not have to pick
    the version that happens to fit today's room.
    """
    pairs = _pairs(profile)
    if pairs is not None:
        return [_unit(np.asarray(vector, dtype=np.float64).reshape(-1)) for _, vector in pairs]
    array = np.asarray(profile, dtype=np.float64)
    if array.ndim == 1:
        return [_unit(array.reshape(-1))]
    return [_unit(row.reshape(-1)) for row in array]


def _slots_for(profile: Any, count: int) -> list[int]:
    """The slot each vector belongs to, so a row can be lit by name."""
    pairs = _pairs(profile)
    if pairs is not None:
        return [int(slot) for slot, _ in pairs]
    return list(range(1, count + 1))


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0.0 else vector


def _kmeans2(matrix: np.ndarray, iterations: int = 25) -> Tuple[np.ndarray, np.ndarray]:
    """Two centroids, deterministic on purpose.

    Seeded from the two windows furthest apart, not at random: a decision that
    flips between runs on the same audio is a decision nobody can trust, and
    the spread of a recording's own windows starts the split where it belongs.
    """
    if len(matrix) < 2:
        return matrix.copy(), np.zeros(len(matrix), dtype=int)
    # The furthest pair from a fixed anchor: cheap, deterministic, and it picks
    # the two ends of the recording rather than two neighbouring windows.
    anchor = matrix[0]
    first = int(np.argmin(matrix @ anchor))
    second = int(np.argmin(matrix @ matrix[first]))
    centroids = np.stack([_unit(matrix[first]), _unit(matrix[second])])
    labels = np.zeros(len(matrix), dtype=int)
    for _ in range(iterations):
        labels = np.argmax(matrix @ centroids.T, axis=1)
        moved = False
        for index in (0, 1):
            members = matrix[labels == index]
            if len(members) == 0:
                continue
            updated = _unit(members.mean(axis=0))
            if not np.allclose(updated, centroids[index], atol=1e-6):
                moved = True
            centroids[index] = updated
        if not moved:
            break
    return centroids, labels


class SessionDiarizer:
    """The recent windows of one recording, and the margin between two voices."""

    def __init__(
        self,
        profile: Sequence[float],
        *,
        window_limit: int = DEFAULT_WINDOW_LIMIT,
        min_windows: int = MIN_WINDOWS,
        same_voice_cosine: float = SAME_VOICE_COSINE,
    ) -> None:
        self._profiles = _as_profiles(profile)
        self._profile = self._profiles[0]
        self._windows: Deque[np.ndarray] = deque(maxlen=max(2, int(window_limit)))
        self._bootstrap: List[np.ndarray] = []
        self._boot_centroid: Optional[np.ndarray] = None
        self._min_windows = max(4, int(min_windows))
        self._same_voice = float(same_voice_cosine)
        self._ready = False
        self._one_voice = False
        self._owner_centroid: Optional[np.ndarray] = None
        self._other_centroid: Optional[np.ndarray] = None
        self._owner_closeness: float = 0.0
        self._closeness_gap: float = 0.0
        #: A voice the owner claimed by hand for this recording. It outranks
        #: everything inferred: when the room holds two voices and neither the
        #: enrolment nor the majority can say which one is his, one press can.
        self._claimed: Optional[np.ndarray] = None

    @property
    def ready(self) -> bool:
        """Whether the split is a measurement rather than a guess."""
        return self._ready

    def claim_recent(self, count: int = 8) -> bool:
        """Fix this recording's owner to the voice of the last windows heard.

        The windows the gate has already embedded are the honest source for
        this: they are the same audio, through the same pipeline, at the same
        level as every decision it will make — while a spool file on disk is
        written with a lag and was empty at the moment the owner pressed.
        Returns False when too little has been heard to mean anything.
        """
        windows = list(self._diarizer.recent_windows(count))
        if not windows:
            return False
        centre = np.stack(windows).mean(axis=0)
        self._diarizer.set_owner(centre)
        return True
    def set_owner(self, vector: Sequence[float] | np.ndarray) -> None:
        """Fix this recording's owner to a voice the person claimed by hand."""
        self._claimed = _unit(np.asarray(vector, dtype=np.float64).reshape(-1))

    @property
    def claimed(self) -> bool:
        """Whether the owner was claimed rather than inferred."""
        return self._claimed is not None

    @property
    def one_voice(self) -> bool:
        """True when the windows hold a single speaker, not two."""
        return self._one_voice

    def observe(self, vector: np.ndarray) -> None:
        """Take one window's direction into the rolling picture."""
        unit_vector = _unit(np.asarray(vector, dtype=np.float64).reshape(-1))
        self._windows.append(unit_vector)
        if len(self._bootstrap) < BOOTSTRAP_WINDOWS:
            self._bootstrap.append(unit_vector)
            self._boot_centroid = _unit(np.stack(self._bootstrap).mean(axis=0))
        if len(self._windows) < self._min_windows:
            self._ready = False
            return
        matrix = np.stack(self._windows)
        centroids, _ = _kmeans2(matrix)
        # Every version of the owner's voice counts: a track learned in a
        # quiet room and one learned at the desk are the same person, and a
        # cluster that matches either of them is his.
        closeness = [
            max(float(np.dot(centroid, profile)) for profile in self._profiles)
            for centroid in centroids
        ]
        owner = int(np.argmax(closeness))
        # A tie is not a decision. When both voices sit equally far from the
        # enrolled profile — which is what a profile from another room gives —
        # the split keeps the roles it already had instead of flipping them:
        # a recording whose first voice was the neighbour had the owner cut out
        # of it while the neighbour's words went through.
        if self._ready and self._owner_centroid is not None:
            if abs(closeness[0] - closeness[1]) < TIE_MARGIN:
                keep = int(np.argmax([float(np.dot(c, self._owner_centroid)) for c in centroids]))
                owner = keep
        other = 1 - owner
        self._owner_centroid = centroids[owner]
        self._other_centroid = centroids[other]
        self._ready = True
        self._owner_closeness = closeness[owner]
        self._closeness_gap = abs(closeness[0] - closeness[1])
        self._one_voice = float(np.dot(centroids[owner], centroids[other])) >= self._same_voice

    def margin(self, vector: np.ndarray) -> Optional[float]:
        """How much closer this window is to the owner's voice than to the other.

        ``None`` until the picture is a measurement: an answer invented before
        two voices have been heard is the failure this whole module replaces.
        """
        if not self._ready or self._owner_centroid is None or self._other_centroid is None:
            return None
        unit = _unit(np.asarray(vector, dtype=np.float64).reshape(-1))
        return float(np.dot(unit, self._owner_centroid) - np.dot(unit, self._other_centroid))

    def owner_similarity(self, vector: np.ndarray) -> Optional[float]:
        """How close this window is to the voice this session calls the owner's.

        Before two voices have been heard there is no split to trust, but there
        is something better than nothing: the opening seconds of the recording,
        which are the owner starting to talk. That is a session-local model, so
        it already separates by the same margin the full split does — which is
        what lets a stranger who speaks at the fifth second be judged then,
        instead of twenty seconds later.
        """
        unit = _unit(np.asarray(vector, dtype=np.float64).reshape(-1))
        if self._claimed is not None:
            # A claimed voice outranks everything inferred: it is the one fact
            # no guess on this desk has produced reliably.
            return float(np.dot(unit, self._claimed))
        if self._owner_centroid is not None:
            return float(np.dot(unit, self._owner_centroid))
        if self._boot_centroid is not None:
            return float(np.dot(unit, self._boot_centroid))
        return None

    def recent_windows(self, count: int) -> List[np.ndarray]:
        """The last ``count`` windows, oldest first."""
        if count <= 0:
            return []
        return list(self._windows)[-count:]
    def snapshot(self) -> dict:
        """The state, for a report or a test."""
        return {
            "ready": self._ready,
            "one_voice": self._one_voice,
            "windows": len(self._windows),
        }


class DiarizedScorer:
    """``bytes -> Optional[float]`` for the gate, with the room as its scale.

    Returns a similarity in [0, 1] where 0.5 is "as close to the owner's voice
    as to the other one": the margin, shifted. The gate's thresholds then mean
    the same thing in every room, because the scale is the room's own spread
    instead of a number somebody measured on another desk.

    Before the picture is ready the score falls back to the plain cosine to the
    enrolled profile — the old rule, which is wrong across sessions but never
    wilder than the enrolment it came from.
    """

    def __init__(
        self,
        embedder,
        profile: Sequence[float],
        *,
        window_limit: int = DEFAULT_WINDOW_LIMIT,
        open_margin: float = DEFAULT_OPEN_MARGIN,
        close_margin: float = DEFAULT_CLOSE_MARGIN,
        closes: Optional[dict[int, float]] = None,
    ) -> None:
        self._embedder = embedder
        self._profiles = _as_profiles(profile)
        self._track_slots = _slots_for(profile, len(self._profiles))
        self._diarizer = SessionDiarizer([*self._profiles], window_limit=window_limit)
        self.open_margin = float(open_margin)
        self.close_margin = float(close_margin)
        #: How close a window must sit to a track before the room may say
        #: anything about it, per slot. Each track brings its own number from its
        #: own take (``voice_profiles.thresholds_from_floor``); TRACK_FLOOR is
        #: only the answer for a track that predates that derivation.
        self._closes: dict[int, float] = dict(closes or {})
        self._last_margin: Optional[float] = None
        #: Score against every learned track, by slot, for the last window:
        #: the card draws these as the tracks matching right now.
        self.last_tracks: dict[int, float] = {}

    def claim_recent(self, count: int = 8) -> bool:
        """Fix this recording's owner to the voice of the last windows heard.

        The windows the gate has already embedded are the honest source for
        this: they are the same audio, through the same pipeline, at the same
        level as every decision it will make — while a spool file on disk is
        written with a lag and was empty at the moment the owner pressed.
        Returns False when too little has been heard to mean anything.
        """
        windows = list(self._diarizer.recent_windows(count))
        if not windows:
            return False
        centre = np.stack(windows).mean(axis=0)
        self._diarizer.set_owner(centre)
        return True
    def set_owner(self, vector: Sequence[float] | np.ndarray) -> None:
        """Take a voice the owner claimed by hand as this recording's reference.

        Everything else here infers the owner, and on this desk inference has
        failed every time it mattered: the first speaker of a recording was the
        neighbour, the majority speaker of another was the neighbour, and the
        enrolled profile could not tell the two voices apart across takes
        (0.29 for the owner against 0.35 for the stranger). One press during
        the recording settles it, and a settled reference separates by 0.4.
        """
        self._diarizer.set_owner(vector)

    @property
    def claimed(self) -> bool:
        return self._diarizer.claimed

    @property
    def diarizer(self) -> SessionDiarizer:
        return self._diarizer

    @property
    def last_margin(self) -> Optional[float]:
        return self._last_margin

    def __call__(self, window: bytes) -> Optional[float]:
        vector = self._embedder.embed(window)
        if vector is None:
            return None
        self._diarizer.observe(vector)
        # Nobody in this room is a version of the owner: the gate has nothing to
        # keep and everything is a stranger. The room's own scale cannot decide
        # this - it would make whoever dominates the room the owner, which is how
        # a being that scored 0.21 against the track stayed open for 27.7 of 34.5
        # seconds (measured 2026-11-25). The absolute cosine to the tracks is the
        # one measure that does not move with who else is talking.
        best_slot, best = self._best_profile(vector)
        if best < self._closes.get(best_slot, TRACK_FLOOR):
            self._last_margin = None
            return best
        margin = self._diarizer.margin(vector)
        if margin is None:
            return self._best_profile_similarity(vector)
        self._last_margin = margin
        # The score is closeness to the VOICE THIS ROOM CALLS THE OWNER'S, not
        # a margin between two moving centroids: a margin changes when the
        # other speaker leaves or arrives, and a gate whose scale moves with
        # the room measures the room, not the voice. Measured on the desk
        # 2026-11-24 with a session-owned centroid: his windows sat at 0.700
        # (10th percentile 0.647) and the other speaker's at 0.345 (90th 0.470)
        # — no overlap at all, where the cross-session cosine gave 0.018.
        similarity = self._diarizer.owner_similarity(vector)
        if similarity is None:
            return self._best_profile_similarity(vector)
        return float(np.clip(similarity, 0.0, 1.0))


    def _best_profile(self, vector: np.ndarray) -> tuple[int, float]:
        """The closest of the owner's versions, by slot - every track counts."""
        unit = _unit(np.asarray(vector, dtype=np.float64).reshape(-1))
        scores = {
            slot: float(np.dot(unit, profile))
            for slot, profile in zip(self._track_slots, self._profiles)
        }
        # Kept for the card: these are the rows that light up while a take runs.
        self.last_tracks = scores
        if not scores:
            return (0, 0.0)
        slot = max(scores, key=lambda key: scores[key])
        return (slot, scores[slot])

    def _best_profile_similarity(self, vector: np.ndarray) -> float:
        """The closest of the owner's versions, as one number."""
        return self._best_profile(vector)[1]

__all__ = [
    "DEFAULT_CLOSE_MARGIN",
    "DEFAULT_OPEN_MARGIN",
    "DEFAULT_WINDOW_LIMIT",
    "DiarizedScorer",
    "MIN_WINDOWS",
    "SAME_VOICE_COSINE",
    "TRACK_FLOOR",
    "SessionDiarizer",
]
