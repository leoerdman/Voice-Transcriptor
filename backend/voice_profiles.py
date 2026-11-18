"""Three slots, one kept voice, vectors and nothing else.

§5.1: three profiles, a fourth refused, and whichever is enabled is the one
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

SLOTS = 3
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
        raise ProfileError(f"a fourth profile is refused: slots are 1-{SLOTS}")
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
                }
                for slot, profile in sorted(profiles.items())
            },
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(self._path, payload)

    def save(
        self, slot: int, name: str, vector: Sequence[float] | np.ndarray
    ) -> VoiceProfile:
        """Put a profile in a slot, replacing whatever was there."""
        profile = VoiceProfile(
            slot=_clean_slot(slot),
            name=_clean_name(name),
            vector=_clean_vector(vector),
            created_at=_now(),
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
