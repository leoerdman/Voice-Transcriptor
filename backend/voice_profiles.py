"""Three slots, one kept voice, vectors and nothing else.

§5.1: a track per version of a voice, and whichever is enabled is the one
that is let through while the rest is a stranger. §5.5: a take becomes a
profile by an act — the Settings tab calls `save` with a vector it took from
`SpeakerScorer.enrol`, and nothing here infers a profile from audio on its
own.

§1.3: the take is untouched, profiles and thresholds persist, audio does not.
That is why this file holds vectors: a vector is a fact about a voice, an
audio file is the user's recording, and the recordings archive is the one
place that owns those. `load`/`save` cannot even see bytes.

A store that cannot read its own file is a store that stops the app from
booting, so a broken or half-written file reads as *no profiles*: a stranger
in the room is the same failure as a rejected mask, and §4.4 already prefers
the harmless side.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

logger = logging.getLogger(__name__)

SLOTS = 7
#: CAM++'s embedding width. Stored rather than inferred: a file whose vectors
#: are a different size is a file from a different model, and a cosine across
#: two widths is not a smaller number, it is an error.
DIMENSIONS = 192
NAME_MAX_CHARS = 40
FILE_NAME = "voice_profiles.json"


class ProfileError(ValueError):
    """A profile the store refuses to hold, with the reason it refuses."""


@dataclass(frozen=True)
class VoiceProfile:
    slot: int
    name: str
    vector: Tuple[float, ...]
    created_at: str
    #: Where the seconds this profile was learned from are kept, relative to
    #: nothing but itself: an absolute path under DATA_DIR, empty when the
    #: profile predates captures being kept.
    capture: str = ""
    #: How alike this voice's own windows are (median cosine to its mean). The
    #: gate's thresholds are a share of it, so a profile carries its own scale
    #: instead of borrowing one from another machine.
    self_floor: float = 0.0
    #: The level this voice spoke at when it was learned, dBFS RMS: the desk's
    #: own near field. Anything far below it is somebody else in the room.
    level_db: float = 0.0
    #: A threshold pair the owner set by hand in the tuner (0.0 = derive it from
    #: the floor). Kept on the profile because it measures THIS voice on THIS
    #: microphone, which is exactly what the tuner was dragged against.
    open_at: float = 0.0
    close_at: float = 0.0

    def as_vector(self) -> np.ndarray:
        return np.asarray(self.vector, dtype=np.float32)


def default_profiles_path() -> Path:
    """``DATA_DIR/voice_profiles.json`` — imported late, on purpose.

    `backend.config` builds an encryption key and reads the config on import;
    a store that is constructed in a test with its own path must not pay for
    that, and a store in the app has already paid for it.
    """
    from backend.config import DATA_DIR

    return Path(DATA_DIR) / FILE_NAME


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clean_vector(vector: Sequence[float] | np.ndarray) -> Tuple[float, ...]:
    array = np.asarray(vector, dtype=np.float64).reshape(-1)
    if array.size != DIMENSIONS:
        raise ProfileError(f"a profile is {DIMENSIONS}-dimensional, got {array.size}")
    if not np.all(np.isfinite(array)):
        raise ProfileError("a profile holds finite numbers")
    if float(np.linalg.norm(array)) <= 0.0:
        raise ProfileError("a profile of zeros is a stranger to everyone")
    return tuple(float(v) for v in array)


def _clean_name(name: str) -> str:
    cleaned = " ".join(str(name or "").split())
    if not cleaned:
        raise ProfileError("a profile needs a name")
    if len(cleaned) > NAME_MAX_CHARS:
        raise ProfileError(f"a profile name is at most {NAME_MAX_CHARS} characters")
    return cleaned


def _clean_slot(slot: int) -> int:
    try:
        value = int(slot)
    except (TypeError, ValueError):
        raise ProfileError("a slot is a number") from None
    if not 1 <= value <= SLOTS:
        raise ProfileError(f"one more profile is refused: slots are 1-{SLOTS}")
    return value


class VoiceProfileStore:
    """The three slots on disk, read whole and written whole.

    Every write is one atomic replace of one small file: a profile is a few
    hundred floats, and a per-slot file would only add a way for the three to
    disagree about who is enabled.
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self._path = Path(path) if path is not None else default_profiles_path()

    @property
    def path(self) -> Path:
        return self._path

    # ---- reading -----------------------------------------------------

    def _read(self) -> Dict[str, Any]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as e:
            logger.warning("voice profiles unreadable (%s); treating as none", e)
            return {}
        try:
            data = json.loads(raw)
        except ValueError:
            logger.warning("voice profiles file is not JSON; treating as none")
            return {}
        return data if isinstance(data, dict) else {}

    def profiles(self) -> Dict[int, VoiceProfile]:
        """Everything the file holds, junk skipped rather than raised."""
        stored = self._read().get("profiles")
        if not isinstance(stored, dict):
            return {}
        found: Dict[int, VoiceProfile] = {}
        for key, entry in stored.items():
            try:
                slot = _clean_slot(key)
                if not isinstance(entry, dict):
                    continue
                found[slot] = VoiceProfile(
                    slot=slot,
                    name=_clean_name(entry.get("name")),
                    vector=_clean_vector(entry.get("vector") or []),
                    created_at=str(entry.get("created_at") or ""),
                    capture=str(entry.get("capture") or ""),
                    self_floor=float(entry.get("self_floor") or 0.0),
                    level_db=float(entry.get("level_db") or 0.0),
                    open_at=float(entry.get("open_at") or 0.0),
                    close_at=float(entry.get("close_at") or 0.0),
                )
            except ProfileError as e:
                logger.warning("voice profile slot %r skipped: %s", key, e)
        return found

    def enabled_slot(self) -> Optional[int]:
        """Which slot is let through right now, if any."""
        stored = self._read().get("enabled")
        try:
            slot = _clean_slot(stored) if stored is not None else None
        except ProfileError:
            return None
        return slot if slot in self.profiles() else None

    def enabled(self) -> Optional[VoiceProfile]:
        slot = self.enabled_slot()
        return self.profiles().get(slot) if slot is not None else None

    @property
    def captures_dir(self) -> Path:
        """Where the presses a profile was learned from are kept (7.4).

        Beside the store rather than in a path of its own: a test that gives the
        store a temporary file must give its captures the same neighbourhood,
        and the two can never drift apart.
        """
        return self._path.parent / "voice_profiles"

    # ---- writing -----------------------------------------------------

    def _write(self, profiles: Dict[int, VoiceProfile], enabled: Optional[int]) -> None:
        from backend.storage import atomic_write_json

        payload = {
            "version": 1,
            "enabled": enabled,
            "profiles": {
                str(slot): {
                    "name": profile.name,
                    "vector": list(profile.vector),
                    "created_at": profile.created_at,
                    "capture": profile.capture,
                    "self_floor": profile.self_floor,
                    "level_db": profile.level_db,
                    "open_at": profile.open_at,
                    "close_at": profile.close_at,
                }
                for slot, profile in sorted(profiles.items())
            },
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self._path, payload)

    def set_thresholds(self, slot: int, open_at: float, close_at: float) -> VoiceProfile:
        """Keep a threshold pair the owner tuned by hand (0, 0 clears it).

        Refused rather than repaired when the pair cannot open a gate: a close
        above the open is not a small mistake, it is a mask that lets everybody
        through, and the store is the last place that can say so.
        """
        target = _clean_slot(slot)
        profiles = self.profiles()
        profile = profiles.get(target)
        if profile is None:
            raise ProfileError("there is no voice in that slot to tune")
        opened = float(open_at or 0.0)
        closed = float(close_at or 0.0)
        if opened or closed:
            if not (0.0 < closed <= opened < 1.0):
                raise ProfileError(
                    "a tuned pair needs 0 < close <= open < 1: "
                    f"got close {closed:.3f} and open {opened:.3f}"
                )
        tuned = VoiceProfile(
            slot=profile.slot,
            name=profile.name,
            vector=profile.vector,
            created_at=profile.created_at,
            capture=profile.capture,
            self_floor=profile.self_floor,
            level_db=profile.level_db,
            open_at=opened,
            close_at=closed,
        )
        profiles[target] = tuned
        self._write(profiles, self.enabled_slot())
        return tuned

    def save(
        self,
        slot: int,
        name: str,
        vector: Sequence[float] | np.ndarray,
        capture: str = "",
        # How alike this voice's own windows are (median cosine to its mean).
        # The gate's thresholds are a share of it, so a profile carries its own
        # scale instead of borrowing one from another machine.
        self_floor: float = 0.0,
        # The level this voice spoke at, dBFS RMS (0.0 when unknown).
        level_db: float = 0.0,
    ) -> VoiceProfile:
        """Put a profile in a slot, replacing whatever was there.

        A hand-tuned pair is dropped here on purpose: the thresholds were tuned
        against the old vector and the old floor, and a new take is a new scale.
        """
        profile = VoiceProfile(
            slot=_clean_slot(slot),
            name=_clean_name(name),
            vector=_clean_vector(vector),
            created_at=_now(),
            capture=str(capture or ""),
            self_floor=float(self_floor or 0.0),
            level_db=float(level_db or 0.0),
        )
        profiles = self.profiles()
        profiles[profile.slot] = profile
        # A slot that already exists keeps its enabled flag; the first profile
        # in an empty store becomes the kept one, because a room with one known
        # voice and nothing kept is a mask that can never open.
        enabled = self.enabled_slot()
        if enabled is None:
            enabled = profile.slot
        self._write(profiles, enabled)
        return profile

    def delete(self, slot: int) -> bool:
        """Remove a slot. Returns whether there was one to remove."""
        target = _clean_slot(slot)
        profiles = self.profiles()
        if target not in profiles:
            return False
        del profiles[target]
        enabled = self.enabled_slot()
        if enabled == target:
            enabled = min(profiles) if profiles else None
        self._write(profiles, enabled)
        return True

    def set_enabled(self, slot: Optional[int]) -> None:
        """Keep one slot, or keep nobody (``None``) — never a missing slot."""
        profiles = self.profiles()
        if slot is None:
            self._write(profiles, None)
            return
        target = _clean_slot(slot)
        if target not in profiles:
            raise ProfileError(f"slot {target} holds no profile")
        self._write(profiles, target)

    def slots(self) -> List[Optional[VoiceProfile]]:
        """The three slots in order, ``None`` where one is empty.

        Settings draws three rows whatever is in the file; a list that
        shrinks when a slot is empty is how a UI ends up renumbering them.
        """
        profiles = self.profiles()
        return [profiles.get(slot) for slot in range(1, SLOTS + 1)]
