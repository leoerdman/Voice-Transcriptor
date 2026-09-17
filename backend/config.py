"""Application configuration — the single source of truth.

Configuration is stored as JSON in ~/Library/Application Support/Transcriptor/config.json
(macOS) or ~/.config/Transcriptor/config.json (Linux). API keys are encrypted at rest
using Fernet symmetric encryption when the cryptography package is available; otherwise
keys are stored in plain text with a warning logged at startup.

SSOT (Single Source of Truth) guarantees provided by this module:

    1.  ATOMICITY — writes are crash-safe. ``_atomic_write_json`` writes
        to a unique temp file, ``fsync()``s its contents, ``replace()``s
        the target in one syscall, then ``fsync()``s the parent dir on
        POSIX so the rename survives a power loss. The previous
        implementation was atomic in the rename-only sense but could
        land an empty file after a kernel crash because the temp's
        payload was never flushed.

    2.  RECOVERY — every save rotates the previous on-disk config to
        ``config.json.bak`` BEFORE writing the new version. ``load_config``
        falls back to ``.bak`` on parse failure, so a corrupt write
        (disk I/O error mid-fsync, malformed future-version, or a bug
        in a migration) never loses the user's API keys.

    3.  SCHEMA VERSIONING — every config carries an integer
        ``schema_version`` field. Configs from older versions are
        migrated through a deterministic pipeline on read. New-version
        fields are always present; missing or invalid subtrees are
        dropped-with-warning and replaced from ``DEFAULT_CONFIG``
        (valid existing subtrees survive untouched).

    4.  ENCAPSULATION — all mutation flows through ``save_config``.
        Direct file writes from elsewhere in the backend are forbidden.
        Callers never see the raw disk format; they see the decrypted,
        migrated, validated structure only.

    5.  ENCRYPTION AT REST — provider keys are Fernet-encrypted with
        a per-machine key file (``chmod 0600``). Plain-text legacy keys
        are transparently re-encrypted on first load.
"""

import copy
import json
import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict

from backend.audio_mime import AUDIO_EXT_TO_MIME
from backend.data_dir import default_data_dir
from backend.model_catalog import (
    DEFAULT_OPENROUTER_AUDIO_MODEL,
    DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER,
    DUAL_SECONDARY_LANGUAGE_DEFAULT,
    DUAL_STREAM_DEFAULT,
    REMOTE_TRANSCRIPTION_PROVIDERS,
)
from backend.storage import atomic_copy_file, atomic_write_bytes, atomic_write_json, rotate_backup

logger = logging.getLogger(__name__)

# Bump this integer whenever a breaking schema change is introduced,
# AND add a `_migrate_vN_to_vM` branch in `_migrate_schema` to upgrade
# older configs. Never re-use a previously-shipped version number —
# downgrade detection relies on this being monotonic.
SCHEMA_VERSION = 2

try:
    from cryptography.fernet import Fernet, InvalidToken
    _HAS_CRYPTO = True
except ImportError:
    _HAS_CRYPTO = False
    Fernet = None  # type: ignore[assignment,misc]
    InvalidToken = Exception  # type: ignore[assignment,misc]
    logger.warning(
        "cryptography package not installed — API keys will be stored in plain text. "
        "Run: pip3 install 'cryptography>=42.0.0' to enable encryption."
    )


APP_ROOT = Path(__file__).resolve().parent.parent
LEGACY_DATA_DIR = APP_ROOT / "data"

_ENC_PREFIX = "enc:"


# The rule itself lives in ``backend.data_dir`` so the command-line
# client can apply it without importing this module (and its crypto
# stack and directory-creating side effects). This alias keeps the
# existing readers and the tests that patch it.
_default_data_dir = default_data_dir


def _resolve_data_dir() -> Path:
    """The data directory, degrading to a fallback instead of killing boot.

    This runs at IMPORT — ``backend.main`` imports this module at module
    level — so an exception here kills the process before uvicorn ever
    starts, and Electron sees nothing but an immediate child exit,
    retries eight times and shows "backend did not start". No part of
    that says the cause was one environment variable
    (``TRANSCRIPTOR_DATA_DIR``, a documented user setting), a read-only
    home directory, or a sandbox refusal.

    The house policy for bad environment input is already written down
    in ``backend.deepgram_endpoints`` and followed by
    ``backend.main._env_int``: warn, use a documented default, keep the
    app bootable and the misconfiguration visible in the log. This was
    the one place that raised instead.
    """
    candidate = _default_data_dir()
    try:
        candidate.mkdir(parents=True, exist_ok=True, mode=0o700)
        return candidate
    except OSError as e:
        fallback = Path.home() / ".transcriptor"
        logger.error(
            "data dir %s is unusable (%s); falling back to %s. Set "
            "TRANSCRIPTOR_DATA_DIR to a writable path to choose another.",
            candidate, e, fallback,
        )
        try:
            fallback.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError as e2:
            # Home itself is unwritable. Still do not raise: the app can
            # serve a session with no persisted config, and the log now
            # says why every save will fail.
            logger.error(
                "fallback data dir %s is unusable too (%s); config will not "
                "persist this session",
                fallback, e2,
            )
        return fallback


DATA_DIR = _resolve_data_dir()
CONFIG_PATH = DATA_DIR / "config.json"

# ---------------------------------------------------------------------------
# Fernet encryption key — one per machine, stored with strict permissions.
# ---------------------------------------------------------------------------
_KEYFILE = DATA_DIR / ".encryption_key"


def _load_or_create_fernet_key() -> bytes:
    """Return a 32-byte URL-safe base64-encoded Fernet key.

    Created once per machine and stored in the user data directory with
    ``chmod 0600`` so that only the file owner can read it.
    Returns ``b""`` when the cryptography package is not installed.
    """
    if not _HAS_CRYPTO:
        return b""

    def _read_existing_keyfile() -> bytes:
        try:
            raw = _KEYFILE.read_bytes().strip()
        except OSError as e:
            logger.error(
                "encryption keyfile unreadable at %s: %s — regenerating",
                _KEYFILE, e,
            )
            return b""
        if raw:
            try:
                # Validate it is a real Fernet key.
                Fernet(raw)
                return raw
            except Exception as e:
                logger.warning(
                    "encryption keyfile at %s is corrupted (%s) — regenerating "
                    "(previously-encrypted values will become unreadable)",
                    _KEYFILE, e,
                )
        return b""

    def _clear_empty_keyfile() -> bool:
        """Remove a 0-byte keyfile so a real one can be written.

        The "never overwrite an existing keyfile" rule below is right for
        a file WITH CONTENT: something may still be decryptable with it.
        A zero-byte file protects nothing, and refusing to replace it
        guarantees permanent breakage instead — ``_FERNET`` stays
        ``None`` for the life of the process and for every process
        after it, so every ``POST /api/config`` carrying a provider key
        answers 503 and the user can never enter one.
        ``main._load_or_create_api_token`` regenerates an empty token
        file for exactly this reason; this was the one secret that did
        not.
        """
        try:
            if _KEYFILE.stat().st_size != 0:
                return False
        except OSError:
            return False
        try:
            _KEYFILE.unlink()
        except OSError as e:
            logger.error("could not clear the empty keyfile at %s: %s", _KEYFILE, e)
            return False
        logger.warning(
            "encryption keyfile at %s was empty (0 bytes); replacing it with "
            "a fresh key", _KEYFILE,
        )
        return True

    if _KEYFILE.exists():
        raw = _read_existing_keyfile()
        if raw:
            return raw
        _clear_empty_keyfile()
    key = Fernet.generate_key()
    # Direct write through ``os.open`` with O_CREAT | O_EXCL | mode=0o600
    # so the file is NEVER readable by other users on the system, not
    # even briefly. The previous ``atomic_write_bytes`` + ``os.chmod``
    # sequence left a window between the rename (default 0o644 perms
    # via os.replace) and the chmod where the encryption key was
    # world-readable. On a multi-user Linux / macOS host this is a
    # real exposure for the milliseconds between the two syscalls.
    #
    # O_EXCL fails if the file already exists. We checked existence
    # at the top of the function; a TOCTOU race here would only
    # produce an OSError, which we handle below.
    if os.name == "nt":
        # Windows doesn't honor mode bits on os.open the same way;
        # NTFS ACL is what protects user data and the file lands in
        # %APPDATA%\Transcriptor\ which is already user-private. The
        # atomic primitive is good enough on Win.
        if _KEYFILE.exists():
            # Mirror the POSIX contract exactly: an existing keyfile is
            # NEVER replaced. Reaching generate-key here means the file
            # exists but was unreadable/corrupt; overwriting it would
            # permanently destroy decryptability of every stored `enc:`
            # value (e.g. an AV/ACL lock clearing after we clobbered the
            # key). Refusing keeps old values readable on the next boot.
            logger.error(
                "keyfile at %s exists but yielded no usable key — REFUSING "
                "to overwrite it (existing encrypted values stay "
                "decryptable once the file becomes readable again)",
                _KEYFILE,
            )
            return b""
        try:
            atomic_write_bytes(_KEYFILE, key)
        except OSError as e:
            # See POSIX branch comment below for rationale: returning
            # an in-memory key causes silent permanent data loss on
            # the next boot (different key generated, all encrypted
            # values become garbage). Refusing to use any key keeps
            # existing on-disk encrypted values readable.
            logger.error(
                "failed to persist encryption keyfile at %s: %s — "
                "REFUSING to use a session-only key (existing encrypted "
                "values stay decryptable on next successful boot)",
                _KEYFILE, e,
            )
            return b""
    else:
        try:
            _KEYFILE.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(
                str(_KEYFILE),
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            try:
                os.write(fd, key)
                os.fsync(fd)
            finally:
                os.close(fd)
            # Belt-and-braces chmod in case the umask masked our mode.
            try:
                os.chmod(_KEYFILE, 0o600)
            except OSError:
                pass
        except FileExistsError:
            # Another Transcriptor process won the first-start race after
            # our initial existence check. Re-read the persisted key instead
            # of truncating it and silently splitting encryption state.
            raced_key = _read_existing_keyfile()
            if raced_key:
                return raced_key
            if _clear_empty_keyfile():
                # The file that appeared is empty, so it is not another
                # process's key — retry once rather than giving up on
                # encryption for the life of this install.
                return _load_or_create_fernet_key()
            logger.error(
                "encryption keyfile appeared during creation but is not usable at %s; "
                "REFUSING to use a session-only key.",
                _KEYFILE,
            )
            return b""
        except OSError as e:
            # 1.1.25 fix: previously returned the in-memory ``key`` here.
            # That looked safe ("encryption keeps working this session")
            # but caused catastrophic SILENT data loss at the next boot:
            # the keyfile was never persisted, so the next boot's
            # ``_load_or_create_fernet_key()`` generated a DIFFERENT key
            # → every value the user encrypted in this session became
            # undecryptable garbage → ``decrypt_value`` swallowed
            # InvalidToken and returned "" → user saw all their API
            # keys empty with NO warning.
            #
            # New behaviour: refuse to use any Fernet key this session.
            # Existing on-disk encrypted values stay readable on the
            # next boot ONCE the keyfile path becomes writable. A
            # session that runs without a keyfile cannot encrypt new
            # values, but that's strictly better than encrypting them
            # with a doomed in-memory key.
            logger.error(
                "failed to persist encryption keyfile at %s: %s — "
                "REFUSING to use a session-only key; existing encrypted "
                "values stay decryptable on next boot once the keyfile "
                "directory is writable.",
                _KEYFILE, e,
            )
            return b""
    return key


_FERNET_KEY = _load_or_create_fernet_key()
_FERNET = Fernet(_FERNET_KEY) if _HAS_CRYPTO and _FERNET_KEY else None


def encrypt_value(plain: str) -> str:
    """Encrypt a string and return it with the ``enc:`` prefix.
    Returns the plain string unchanged when cryptography is unavailable.
    """
    if not plain:
        return ""
    if _FERNET is None:
        if not _HAS_CRYPTO:
            return plain  # documented no-crypto fallback
        # Library present but the KEY is unavailable (persist failure /
        # refusal above). Silently writing plaintext API tokens beside
        # existing `enc:` values would be a silent at-rest regression
        # exactly when protection is already degraded — fail loudly so
        # save_config surfaces it instead of storing secrets in the clear.
        raise RuntimeError(
            "encryption key unavailable; refusing to store secret as plaintext"
        )
    token = _FERNET.encrypt(plain.encode("utf-8"))
    return _ENC_PREFIX + token.decode("ascii")


def decrypt_value(stored: str) -> str:
    """Decrypt a value previously encrypted by :func:`encrypt_value`.

    If *stored* does not carry the ``enc:`` prefix it is returned as-is so
    that plain-text values written before encryption was enabled still work
    (transparent migration).
    """
    if not stored:
        return ""
    if not stored.startswith(_ENC_PREFIX):
        return stored  # plain-text (legacy / not encrypted yet)
    if _FERNET is None:
        return ""  # encrypted value but no crypto — can't decrypt
    token = stored[len(_ENC_PREFIX):]
    try:
        return _FERNET.decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        # 1.1.25: distinguish "wrong key / corrupted token" from
        # transient decryption errors. The first is expected after
        # keyfile rotation; the second is a real fault that must be
        # logged loudly so a user-visible "API key disappeared"
        # symptom can be traced back to its cause.
        logger.warning("decrypt_value: token corrupted or wrong key — treating as empty")
        return ""
    except Exception as e:
        logger.error(
            "decrypt_value: unexpected decryption error: %s — "
            "treating as empty (potential silent secret loss)",
            e, exc_info=True,
        )
        return ""


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def _encrypt_provider_keys(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Return a deep copy of *cfg* with all ``providers.*.key`` values encrypted."""
    cfg = json.loads(json.dumps(cfg))
    providers = cfg.get("providers")
    if isinstance(providers, dict):
        for name in list(providers.keys()):
            prov = providers.get(name)
            if isinstance(prov, dict) and "key" in prov:
                raw = str(prov.get("key") or "").strip()
                if raw and not raw.startswith(_ENC_PREFIX):
                    prov["key"] = encrypt_value(raw)
    return cfg


def _decrypt_provider_keys(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Return a deep copy of *cfg* with all ``providers.*.key`` values decrypted."""
    cfg = json.loads(json.dumps(cfg))
    providers = cfg.get("providers")
    if isinstance(providers, dict):
        for name in list(providers.keys()):
            prov = providers.get(name)
            if isinstance(prov, dict) and "key" in prov:
                stored = str(prov.get("key") or "").strip()
                if stored:
                    prov["key"] = decrypt_value(stored)
    return cfg


def _encrypted_provider_keys_from_config(cfg: Dict[str, Any]) -> Dict[str, str]:
    """Return provider keys that are still encrypted in a raw config tree."""
    out: Dict[str, str] = {}
    providers = cfg.get("providers")
    if not isinstance(providers, dict):
        return out
    for name, prov in providers.items():
        if not isinstance(prov, dict):
            continue
        key = str(prov.get("key") or "").strip()
        if key.startswith(_ENC_PREFIX):
            out[str(name)] = key
    return out


def _load_raw_encrypted_provider_keys_unlocked() -> Dict[str, str]:
    """Read encrypted provider keys from the persisted SSOT without decrypting.

    This is used by ``save_config`` to avoid destructive partial saves when a
    Fernet key is missing/rotated/corrupt. In that state ``load_config`` must
    expose an empty runtime key because the secret is unusable, but unrelated
    preference saves must still preserve the encrypted disk value.
    """
    for path in (CONFIG_PATH, _CONFIG_BACKUP_PATH):
        if not path.exists():
            continue
        try:
            raw = _read_json_file(path)
            raw = _migrate_schema(raw)
            raw = _validate_config_shape(raw)
            merged = _deep_merge(DEFAULT_CONFIG, raw)
            return _encrypted_provider_keys_from_config(merged)
        except (OSError, json.JSONDecodeError, ValueError, TypeError) as e:
            logger.warning("could not inspect raw provider keys at %s: %s", path, e)
    return {}


def _update_has_provider_key(update: Dict[str, Any], provider_name: str) -> bool:
    providers = update.get("providers")
    if not isinstance(providers, dict):
        return False
    provider = providers.get(provider_name)
    return isinstance(provider, dict) and "key" in provider


def _preserve_undecryptable_provider_keys(
    merged: Dict[str, Any],
    current: Dict[str, Any],
    update: Dict[str, Any],
    raw_encrypted_keys: Dict[str, str],
) -> Dict[str, Any]:
    """Keep raw encrypted keys when this process cannot decrypt them.

    A partial config save should not turn an unreadable encrypted secret into
    an empty string. Non-empty incoming keys still replace the old encrypted
    value; empty/missing keys preserve the disk SSOT until decryption works or
    the user provides a new key.
    """
    if not raw_encrypted_keys:
        return merged

    providers = merged.get("providers")
    current_providers = current.get("providers")
    if not isinstance(providers, dict) or not isinstance(current_providers, dict):
        return merged

    for name, raw_key in raw_encrypted_keys.items():
        provider = providers.get(name)
        current_provider = current_providers.get(name)
        if not isinstance(provider, dict) or not isinstance(current_provider, dict):
            continue
        if str(current_provider.get("key") or "").strip():
            continue
        incoming_key_present = _update_has_provider_key(update, name)
        incoming_key = str(provider.get("key") or "").strip()
        if incoming_key_present and incoming_key and not incoming_key.startswith(_ENC_PREFIX):
            continue
        provider["key"] = raw_key
    return merged


def _redact_provider_key_value(key: str) -> str:
    return "" if not key else (key[:3] + "..." + key[-2:])


# What the RENDERER shows in a provider-key field once a key is stored:
# a run of U+2022 bullets (``frontend/src/main.tsx``'s
# ``MASKED_KEY_VALUE``). It is not what this module produces
# (``abc...yz``), so the two sides of one contract described the same
# value differently — and ``_preserve_redacted_provider_keys``, whose
# whole job is to stop a mask being saved AS the key, recognised only
# its own form. Today the renderer guards its own input, which means
# the protection stands on the opposite side from where it was designed;
# any other client posting back what it was shown would have written a
# string of bullets into the config as an API key.
_UI_MASK_CHAR = "\u2022"


def _is_masked_key_value(incoming: str, current: str) -> bool:
    """Is ``incoming`` a MASK of ``current`` rather than a new key?"""
    if not incoming:
        return False
    if incoming == _redact_provider_key_value(current):
        return True
    # A field showing nothing but bullets carries no key material, so it
    # can never be one — whatever length the UI chose to render.
    return set(incoming) == {_UI_MASK_CHAR}


def _preserve_redacted_provider_keys(update: Dict[str, Any], current: Dict[str, Any]) -> Dict[str, Any]:
    """Treat redacted provider keys posted back by the UI as unchanged."""
    providers = update.get("providers")
    current_providers = current.get("providers")
    if not isinstance(providers, dict) or not isinstance(current_providers, dict):
        return update

    for name, prov in providers.items():
        if not isinstance(prov, dict) or "key" not in prov:
            continue
        incoming_key = prov.get("key")
        if not isinstance(incoming_key, str):
            continue
        current_provider = current_providers.get(name)
        if not isinstance(current_provider, dict):
            continue
        current_key = current_provider.get("key")
        if not isinstance(current_key, str) or not current_key:
            continue
        if _is_masked_key_value(incoming_key, current_key):
            prov.pop("key", None)
    return update


def _adopt_legacy_encryption_key() -> None:
    """Take the legacy install's Fernet key, when ours protects nothing.

    Called only from ``_migrate_legacy_data``, and only on the branch
    where there is no local ``config.json`` — so the key this process
    generated at import has not encrypted anything yet and losing it
    loses nothing. Everything else about the keyfile rule is unchanged:
    a key with local data behind it is never replaced.
    """
    global _FERNET_KEY, _FERNET

    if not _HAS_CRYPTO:
        return
    legacy_key_path = LEGACY_DATA_DIR / _KEYFILE.name
    try:
        raw = legacy_key_path.read_bytes().strip()
    except OSError:
        return
    if not raw:
        return
    try:
        cipher = Fernet(raw)
    except Exception as e:
        logger.warning(
            "legacy encryption keyfile at %s is not usable (%s); the migrated "
            "config's provider keys will not decrypt",
            legacy_key_path, e,
        )
        return
    try:
        _KEYFILE.unlink(missing_ok=True)
        fd = os.open(str(_KEYFILE), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as e:
        logger.error(
            "could not adopt the legacy encryption keyfile at %s: %s — the "
            "migrated config's provider keys will not decrypt",
            legacy_key_path, e,
        )
        return
    _FERNET_KEY = raw
    _FERNET = cipher
    logger.info("adopted the legacy encryption key from %s", LEGACY_DATA_DIR)


def _migrate_legacy_data() -> None:
    # Packaged app previously stored data inside app resources; migrate once
    # to a stable user directory.
    if DATA_DIR.resolve() == LEGACY_DATA_DIR.resolve():
        return
    if not LEGACY_DATA_DIR.exists() or not LEGACY_DATA_DIR.is_dir():
        return
    try:
        # Copy config if new config is missing — AND the key that
        # decrypts it. ``config.json`` stores provider keys as ``enc:``
        # ciphertext, so moving the config alone produced one whose
        # secrets decrypt to "" on the first read: the user migrates and
        # silently finds every API key blank.
        #
        # The keyfile at this point is one THIS boot generated moments
        # ago (``_load_or_create_fernet_key`` runs at import), and since
        # there is no local ``config.json`` yet it protects nothing —
        # which is the one condition under which the "never replace an
        # existing keyfile" rule has nothing to protect. The legacy key
        # is adopted only then, only if it is a real Fernet key, and the
        # module's cipher is rebuilt from it before the config lands.
        legacy_cfg = LEGACY_DATA_DIR / "config.json"
        if legacy_cfg.exists() and not CONFIG_PATH.exists():
            _adopt_legacy_encryption_key()
            atomic_copy_file(legacy_cfg, CONFIG_PATH)

        # Copy recordings if destination is empty.
        legacy_rec = LEGACY_DATA_DIR / "recordings"
        new_rec = DATA_DIR / "recordings"
        if legacy_rec.exists() and legacy_rec.is_dir():
            new_rec.mkdir(parents=True, exist_ok=True)
            has_new_txt = any(new_rec.glob("*.txt"))
            if not has_new_txt:
                for p in legacy_rec.glob("*.txt"):
                    dst = new_rec / p.name
                    if not dst.exists():
                        atomic_copy_file(p, dst)
                    stem = p.stem
                    for ext in sorted(AUDIO_EXT_TO_MIME.keys()):
                        audio_src = legacy_rec / f"{stem}{ext}"
                        audio_dst = new_rec / audio_src.name
                        if audio_src.exists() and not audio_dst.exists():
                            atomic_copy_file(audio_src, audio_dst)
    except OSError as e:
        # Non-fatal: app should continue even if migration fails, but the
        # user deserves a breadcrumb in the logs so they can recover data
        # manually if needed.
        logger.warning(
            "legacy data migration from %s failed: %s", LEGACY_DATA_DIR, e,
        )


_migrate_legacy_data()


DEFAULT_CONFIG: Dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    # Skeleton keys derive from the same SSOT tuple that validation and
    # the health catalog use — adding a provider there now automatically
    # provisions its config slot.
    "providers": {name: {"key": ""} for name in REMOTE_TRANSCRIPTION_PROVIDERS},
    "preferences": {
        "remote_provider": DEFAULT_REMOTE_TRANSCRIPTION_PROVIDER,
        "recordings_dir": "",
        "openrouter": {
            "model": DEFAULT_OPENROUTER_AUDIO_MODEL,
        },
        # Raw text, exactly as the user typed it — comma- or
        # newline-separated. Parsed into a normalised term tuple by
        # ``backend.deepgram_keyterms.normalize_keyterms`` at the point
        # each Deepgram request is built, so the config always holds
        # what the user wrote rather than a lossy pre-parsed form.
        "deepgram": {
            "keyterms": "",
            # Dual-stream reading (``backend.deepgram_dual``): run a
            # second Deepgram session in ``dual_secondary_language`` on
            # the same audio and merge the two by word timestamps.
            # Defaults ON — it exists because ``language=multi`` drops
            # whole clauses on language switches (BUGS_AUDIT §1) and the
            # loss is silent — and applies ONLY when the recording
            # actually resolves to multilingual, so a user who picked a
            # single language is never billed twice for one reading.
            "dual_stream": DUAL_STREAM_DEFAULT,
            "dual_secondary_language": DUAL_SECONDARY_LANGUAGE_DEFAULT,
        },
    },
}


# On-disk filenames associated with the config's SSOT contract. All of
# them live under DATA_DIR; changes touch ALL three in sync via
# `_atomic_write_json` + backup-rotation so a crash at any point
# leaves the system recoverable from at least one of {config, .bak}.
_CONFIG_BACKUP_PATH = CONFIG_PATH.with_suffix(".json.bak")
_CONFIG_IO_LOCK = threading.RLock()


def _deep_merge(base: Dict[str, Any], overlay: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k, v in (overlay or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


# Atomic writer primitives live in ``backend.storage`` — shared across
# every persistence site in the backend (config, upscale presets,
# archive registry, API token, encryption key, recording .txt/.json).
# Keeping them module-level private aliases in this file preserves
# the existing call sites and lets a future migration to a different
# implementation (say, an async writer or a WAL-style journal) be a
# one-line change here rather than a grep across the whole module.
_atomic_write_json = atomic_write_json

# ``config.json`` is written owner-only. In the normal case its provider
# keys are ``enc:`` ciphertext, but this module documents a plaintext
# fallback for a runtime without ``cryptography`` — and the file sat at
# the process umask (measured 0644) beside a keyfile at 0600. The mode a
# secret-bearing file of this class gets is already demonstrated by
# ``main._load_or_create_api_token``.
CONFIG_FILE_MODE = 0o600
_rotate_backup = rotate_backup


def _validate_config_shape(cfg: Any) -> Dict[str, Any]:
    """Return *cfg* reduced to a well-typed canonical shape.

    Unknown top-level keys are preserved (forward-compatibility with
    older backends reading newer configs), but known-but-wrongly-typed
    subtrees are DROPPED with a warning and replaced from
    ``DEFAULT_CONFIG`` so a buggy writer cannot poison the config by
    writing e.g. ``"providers": "oops-a-string"``.

    This function is deliberately defensive because the on-disk
    config is the boundary between users / external tools / bugs and
    the running backend — rejecting the whole file on first type
    error (the "strict" stance) would punish the user for a minor
    malformation; silently merging anything (the "permissive" stance)
    lets bad data propagate forever. We take a middle path: invalid
    subtree → reset that subtree to default, keep the rest.
    """
    if not isinstance(cfg, dict):
        logger.warning("config is not a JSON object (got %s) — using defaults", type(cfg).__name__)
        return copy.deepcopy(DEFAULT_CONFIG)
    out: Dict[str, Any] = dict(cfg)  # preserve unknown keys
    # providers block
    providers = out.get("providers")
    if providers is None:
        out["providers"] = dict(DEFAULT_CONFIG["providers"])
    elif not isinstance(providers, dict):
        logger.warning("config.providers has invalid type (%s); resetting", type(providers).__name__)
        out["providers"] = dict(DEFAULT_CONFIG["providers"])
    else:
        fixed_providers: Dict[str, Any] = {}
        for name, prov in providers.items():
            if not isinstance(prov, dict):
                logger.warning("config.providers.%s is not an object (got %s); dropping", name, type(prov).__name__)
                continue
            key_val = prov.get("key")
            if key_val is not None and not isinstance(key_val, str):
                logger.warning("config.providers.%s.key is not a string (got %s); dropping key", name, type(key_val).__name__)
                prov = dict(prov)
                prov["key"] = ""
            fixed_providers[name] = prov
        out["providers"] = fixed_providers
    # preferences block
    preferences = out.get("preferences")
    if preferences is None:
        out["preferences"] = dict(DEFAULT_CONFIG["preferences"])
    elif not isinstance(preferences, dict):
        logger.warning("config.preferences has invalid type (%s); resetting", type(preferences).__name__)
        out["preferences"] = dict(DEFAULT_CONFIG["preferences"])
    else:
        # Narrow checks on individual preference fields.
        rec_dir = preferences.get("recordings_dir")
        if rec_dir is not None and not isinstance(rec_dir, str):
            logger.warning("config.preferences.recordings_dir must be string; resetting")
            preferences = dict(preferences)
            preferences["recordings_dir"] = ""
            out["preferences"] = preferences
        remote_provider = preferences.get("remote_provider")
        if remote_provider is not None and not isinstance(remote_provider, str):
            logger.warning("config.preferences.remote_provider must be string; resetting")
            preferences = dict(preferences)
            preferences["remote_provider"] = DEFAULT_CONFIG["preferences"]["remote_provider"]
            out["preferences"] = preferences
        elif (
            isinstance(remote_provider, str)
            and remote_provider
            and remote_provider not in REMOTE_TRANSCRIPTION_PROVIDERS
        ):
            logger.warning("config.preferences.remote_provider=%r is unsupported; resetting", remote_provider)
            preferences = dict(preferences)
            preferences["remote_provider"] = DEFAULT_CONFIG["preferences"]["remote_provider"]
            out["preferences"] = preferences
        dg_prefs = preferences.get("deepgram")
        if dg_prefs is not None and not isinstance(dg_prefs, dict):
            logger.warning("config.preferences.deepgram must be an object; resetting")
            preferences = dict(preferences)
            preferences["deepgram"] = dict(DEFAULT_CONFIG["preferences"]["deepgram"])
            out["preferences"] = preferences
        elif isinstance(dg_prefs, dict):
            dg_defaults = DEFAULT_CONFIG["preferences"]["deepgram"]
            # One repair pass over the Deepgram preference block: each
            # key that is present but of the wrong type falls back to
            # its documented default, and the block is copied exactly
            # once whatever went wrong.
            repaired: dict = {}
            keyterms_raw = dg_prefs.get("keyterms")
            if keyterms_raw is not None and not isinstance(keyterms_raw, str):
                logger.warning("config.preferences.deepgram.keyterms must be a string; resetting")
                repaired["keyterms"] = dg_defaults["keyterms"]
            dual_raw = dg_prefs.get("dual_stream")
            if dual_raw is not None and not isinstance(dual_raw, bool):
                logger.warning(
                    "config.preferences.deepgram.dual_stream must be a boolean; resetting"
                )
                repaired["dual_stream"] = dg_defaults["dual_stream"]
            secondary_raw = dg_prefs.get("dual_secondary_language")
            if secondary_raw is not None and (
                not isinstance(secondary_raw, str) or not secondary_raw.strip()
            ):
                # A blank string is as unusable as a number here: the
                # second reading needs a language to open a socket with,
                # and "" would silently resolve to multilingual — i.e.
                # two identical readings at twice the price.
                logger.warning(
                    "config.preferences.deepgram.dual_secondary_language must be a "
                    "non-empty string; resetting"
                )
                repaired["dual_secondary_language"] = dg_defaults["dual_secondary_language"]
            if repaired:
                preferences = dict(preferences)
                dg_prefs = {**dg_prefs, **repaired}
                preferences["deepgram"] = dg_prefs
                out["preferences"] = preferences
        # The same repair for the OTHER provider preference block. This
        # module's own docstring promises that "a missing
        # preferences.openrouter branch shouldn't crash a caller that
        # reads cfg['preferences']['openrouter']['model']" — but only
        # ``deepgram`` was ever checked, so one authenticated
        # ``POST /api/config`` with ``{"preferences":{"openrouter":"x"}}``
        # persisted a string there and every later Upscale and remote
        # transcription answered 500, across restarts, with no way to
        # undo it from the UI.
        or_prefs = preferences.get("openrouter")
        or_defaults = DEFAULT_CONFIG["preferences"]["openrouter"]
        if or_prefs is not None and not isinstance(or_prefs, dict):
            logger.warning("config.preferences.openrouter must be an object; resetting")
            preferences = dict(preferences)
            preferences["openrouter"] = dict(or_defaults)
            out["preferences"] = preferences
        elif isinstance(or_prefs, dict):
            model_raw = or_prefs.get("model")
            if model_raw is not None and not isinstance(model_raw, str):
                logger.warning(
                    "config.preferences.openrouter.model must be a string; resetting"
                )
                preferences = dict(preferences)
                preferences["openrouter"] = {
                    **or_prefs, "model": or_defaults["model"],
                }
                out["preferences"] = preferences
    # schema_version: must be a positive int if present.
    sv = out.get("schema_version")
    if sv is not None and not (isinstance(sv, int) and sv > 0 and not isinstance(sv, bool)):
        logger.warning("config.schema_version must be positive int; resetting to 1 (pre-schema legacy)")
        out["schema_version"] = 1
    return out


def _migrate_schema(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Upgrade *cfg* through every schema version up to ``SCHEMA_VERSION``.

    Runs each ``_migrate_vN_to_vM`` transformation deterministically in
    order. Any migration failure is surfaced via log + a return of the
    unchanged input so the caller can still boot (missing migrations
    manifest as "newer fields are absent" rather than "config lost").

    Contract:
      * ``schema_version`` absent ⇒ treated as v1 (1.0.x configs).
      * Target version always ``SCHEMA_VERSION``; downgrades (cfg
        written by a NEWER client) are left untouched — we preserve
        forward-compat by not clobbering unknown future-version fields.
    """
    cfg = dict(cfg)
    try:
        version = int(cfg.get("schema_version") or 1)
    except (TypeError, ValueError):
        version = 1
    if version > SCHEMA_VERSION:
        # Newer-than-us config — do NOT downgrade. Running 1.1.0 over
        # a config written by a hypothetical 1.2.0 build just means
        # we read the fields we know and ignore the rest. The
        # `_deep_merge` with DEFAULT_CONFIG later ensures all v=current
        # fields are present.
        logger.info(
            "config schema_version=%d is newer than this build's %d; "
            "preserving unknown fields, using known fields as-is",
            version, SCHEMA_VERSION,
        )
        return cfg
    while version < SCHEMA_VERSION:
        try:
            if version == 1:
                cfg = _migrate_v1_to_v2(cfg)
            # Future: `elif version == 2: cfg = _migrate_v2_to_v3(cfg)`
            # — keep branches in ascending order, one per version step.
            else:
                logger.error(
                    "no migration registered from schema v%d to v%d; "
                    "config will be written with v=%d and may lose newer-format-specific data",
                    version, version + 1, version,
                )
                break
        except Exception as e:  # noqa: BLE001 — migration bugs must not kill boot
            logger.exception("migration v%d → v%d failed: %s (keeping config at v%d)", version, version + 1, e, version)
            break
        version += 1
        cfg["schema_version"] = version
    return cfg


def _migrate_v1_to_v2(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Migrate 1.0.x (implicit v1) configs to v2 (1.1.0+).

    1.0.x had no ``schema_version`` field at all. v2 is structurally
    identical — the bump is a soft barrier so future breaking changes
    (splitting providers into a list, moving upscale presets inline,
    etc.) can key off the version field rather than ad-hoc shape
    probes. This migration therefore just stamps the version and is
    a no-op otherwise; future migrations will do the real work.
    """
    out = dict(cfg)
    out["schema_version"] = 2
    return out


def _read_json_file(path: Path) -> Dict[str, Any]:
    """Read and parse a JSON file, raising specific errors the caller handles.

    Separated from ``load_config`` so the ``.bak`` fallback path can
    reuse the same read+parse with identical error semantics.
    """
    raw_text = path.read_text(encoding="utf-8")
    obj = json.loads(raw_text)
    if not isinstance(obj, dict):
        raise ValueError(f"JSON root must be an object (got {type(obj).__name__})")
    return obj


def _rotate_backup_if_primary_valid() -> None:
    """Rotate config backup only when the current primary is readable JSON.

    ``load_config`` can recover from ``config.json.bak`` while leaving a
    corrupt ``config.json`` in place for diagnostics. The next save must not
    copy that corrupt primary over the last good backup.
    """
    if not CONFIG_PATH.exists():
        return
    try:
        _read_json_file(CONFIG_PATH)
    except (OSError, json.JSONDecodeError, ValueError) as e:
        logger.warning(
            "skipping config backup rotation because primary config is unusable at %s: %s",
            CONFIG_PATH, e,
        )
        return
    _rotate_backup(CONFIG_PATH, _CONFIG_BACKUP_PATH)


def _load_config_unlocked() -> Dict[str, Any]:
    """Load config and return a migrated, validated, decrypted view.

    Pipeline (in order):
      1. Read ``config.json``; on read / JSON / shape failure, fall
         back to ``config.json.bak`` (the pre-previous-save snapshot).
         If both are unusable, return ``DEFAULT_CONFIG`` so the app
         still boots — the user can re-enter their keys.
      2. Schema-migrate through every registered version step up to
         ``SCHEMA_VERSION``.
      3. Structurally validate (``_validate_config_shape``): wrongly-
         typed subtrees get reset to defaults with a log warning;
         unknown top-level keys are preserved for forward-compat.
      4. Deep-merge with ``DEFAULT_CONFIG`` so every current-version
         field is guaranteed present (a missing ``preferences.openrouter``
         branch shouldn't crash a caller that reads ``cfg["preferences"]["openrouter"]["model"]``).
      5. Transparently re-encrypt any plain-text legacy provider keys
         on disk (no-op if already encrypted). Uses the same atomic +
         backup-rotating writer as ``save_config``.
      6. Decrypt provider keys for the returned view (on-disk stays
         encrypted; callers never see the on-disk form).

    Returns ``DEFAULT_CONFIG`` on catastrophic failure. Never raises.
    """
    raw: Dict[str, Any] = {}
    source: str = "defaults"
    # Capture the ORIGINAL on-disk ``schema_version`` BEFORE ``_migrate_schema``
    # mutates it. The stamp-back-to-disk branch below (`elif source ==
    # "primary":`) compares this value to ``SCHEMA_VERSION`` to decide
    # whether the on-disk file needs re-writing with the current version
    # field. Previously the check read `raw.get("schema_version")` AFTER
    # migration, which always returned SCHEMA_VERSION and made the stamp
    # path inert — so a 1.1.0-beta config written without a version field
    # but with encrypted keys (no key-migration triggers) would stay
    # unstamped forever. Self-heals on the first save_config, but leaves
    # load_config's idempotency invariant broken.
    original_schema_version: int | None = None
    if not CONFIG_PATH.exists() and _CONFIG_BACKUP_PATH.exists():
        # Divergent-reader guard: the provider-key loader treats a valid
        # backup as authoritative when the primary is gone; without this
        # mirror branch load_config returned bare DEFAULTS while keys
        # still resolved from .bak — two readers disagreeing about the
        # SSOT in one process.
        try:
            raw = _read_json_file(_CONFIG_BACKUP_PATH)
            source = "backup"
            logger.warning(
                "primary config missing at %s — recovered from backup %s",
                CONFIG_PATH, _CONFIG_BACKUP_PATH,
            )
        except (OSError, json.JSONDecodeError, ValueError):
            pass  # fall through to the default empty-start path below
    if CONFIG_PATH.exists():
        try:
            raw = _read_json_file(CONFIG_PATH)
            source = "primary"
            _v = raw.get("schema_version")
            # Accept ints only — invalid shapes (str, float, bool) are
            # treated as "missing" so they go through the same migration
            # path a legacy-v1 config does.
            if isinstance(_v, int) and not isinstance(_v, bool) and _v > 0:
                original_schema_version = _v
        except (OSError, json.JSONDecodeError, ValueError) as e:
            logger.error(
                "primary config at %s is unusable (%s); trying backup",
                CONFIG_PATH, e,
            )
            if _CONFIG_BACKUP_PATH.exists():
                try:
                    raw = _read_json_file(_CONFIG_BACKUP_PATH)
                    source = "backup"
                    logger.warning(
                        "recovered config from backup at %s — the primary "
                        "file is corrupt and will be overwritten on the next save",
                        _CONFIG_BACKUP_PATH,
                    )
                except (OSError, json.JSONDecodeError, ValueError) as e2:
                    logger.error(
                        "backup config at %s is also unusable (%s); using defaults",
                        _CONFIG_BACKUP_PATH, e2,
                    )
                    return copy.deepcopy(DEFAULT_CONFIG)
            else:
                logger.error(
                    "no backup available at %s — using defaults. The user's "
                    "API keys and preferences are lost; the corrupt primary "
                    "file is left on disk for manual recovery.",
                    _CONFIG_BACKUP_PATH,
                )
                return copy.deepcopy(DEFAULT_CONFIG)
    else:
        return copy.deepcopy(DEFAULT_CONFIG)

    # 2. Migrate schema (v1 → v2 → …). Never crashes boot — a
    # migration bug reverts to the pre-bump config and logs.
    raw = _migrate_schema(raw)
    # 3. Validate + repair shape.
    raw = _validate_config_shape(raw)
    # 4. Fill in missing defaults so callers can rely on a full tree.
    merged = _deep_merge(DEFAULT_CONFIG, raw)

    # 5. Plain-text → encrypted migration for legacy (pre-Fernet) configs.
    needs_key_migration = False
    providers = merged.get("providers")
    if isinstance(providers, dict):
        for prov in providers.values():
            if isinstance(prov, dict) and "key" in prov:
                k = str(prov.get("key") or "").strip()
                if k and not k.startswith(_ENC_PREFIX):
                    needs_key_migration = True
                    break
    if needs_key_migration:
        try:
            encrypted_cfg = _encrypt_provider_keys(merged)
            _rotate_backup_if_primary_valid()
            _atomic_write_json(CONFIG_PATH, encrypted_cfg, mode=CONFIG_FILE_MODE)
            logger.info(
                "migrated plain-text provider keys to Fernet-encrypted form at %s",
                CONFIG_PATH,
            )
        except (OSError, ValueError, TypeError, RuntimeError) as e:
            # RuntimeError is encrypt_value's documented loud-fail when the
            # crypto library is present but the keyfile is unusable. It MUST
            # be caught here: load_config's contract is "never raises", and
            # an escaped RuntimeError turned a degraded-but-working session
            # into a raw 500 on every config-reading endpoint (BUG-41). The
            # in-memory view below stays valid; on-disk keys stay plain-text
            # and the next successful save re-encrypts.
            logger.warning(
                "provider-key encryption migration write failed at %s: %s — "
                "keys remain usable this session",
                CONFIG_PATH, e,
            )
    elif source == "primary":
        # If we're on current-version schema but the on-disk file
        # lacked schema_version (an older 1.1.0-beta that shipped
        # without the field), write it back WITH the new field so the
        # next boot doesn't re-run the v1→v2 migration unnecessarily.
        #
        # ``original_schema_version`` is the PRE-migration value captured
        # above. Do NOT read `raw["schema_version"]` here — _migrate_schema
        # has already mutated it to SCHEMA_VERSION, so the comparison
        # would always be False and the stamp would never run.
        # Only a config OLDER than this build (or one with no version
        # field at all) needs stamping. ``!=`` also fired for a NEWER
        # file — a downgrade, or a hand-edit — and since the value
        # written came from the deep merge with the raw file it was
        # still the newer number, so the condition never cleared. Every
        # single ``load_config()`` then rewrote ``config.json`` and
        # rotated ``.bak``: four fsyncs on a READ path called from
        # ``GET /api/config``, ``POST /api/upscale``, remote
        # transcription and the live path, and — far worse — ``.bak``,
        # the only automatic recovery copy of the user's settings,
        # overwritten with the current file seconds after any corruption.
        needs_stamp = CONFIG_PATH.exists() and (
            original_schema_version is None
            or original_schema_version < SCHEMA_VERSION
        )
        if needs_stamp:
            try:
                # Write the version we are about to claim we wrote. The
                # value in ``merged`` came from the file, so stamping
                # without this logged "stamped with version=2" while
                # persisting something else.
                stamped = dict(merged)
                stamped["schema_version"] = SCHEMA_VERSION
                _rotate_backup_if_primary_valid()
                _atomic_write_json(
                    CONFIG_PATH,
                    _encrypt_provider_keys(stamped),
                    mode=CONFIG_FILE_MODE,
                )
                merged["schema_version"] = SCHEMA_VERSION
                logger.info(
                    "config schema stamped with version=%d at %s (was: %r)",
                    SCHEMA_VERSION, CONFIG_PATH, original_schema_version,
                )
            except (OSError, RuntimeError) as e:
                # Same BUG-41 reasoning as above: the stamp is an
                # optimisation, not a precondition for serving config.
                logger.warning("schema-version stamp write failed at %s: %s", CONFIG_PATH, e)

    # 6. Return the decrypted view (keys are plain-text for callers;
    # on-disk always encrypted).
    try:
        return _decrypt_provider_keys(merged)
    except (ValueError, TypeError) as e:
        logger.error(
            "config key decryption failed: %s — falling back to defaults", e,
        )
        return copy.deepcopy(DEFAULT_CONFIG)


def load_config() -> Dict[str, Any]:
    with _CONFIG_IO_LOCK:
        return _load_config_unlocked()


def save_config(cfg: Dict[str, Any]) -> None:
    """Merge *cfg* into the current config and persist it atomically.

    Contract:
      * Input is a PARTIAL config — only the keys to update need be
        present (same shape as what the frontend POSTs). Missing keys
        keep their current on-disk values via deep-merge.
      * The result is validated, schema-stamped, encrypted, and
        written via ``_atomic_write_json`` with crash-safe fsync +
        parent-dir fsync (POSIX).
      * The existing config is rotated to ``.bak`` BEFORE the new
        write, so a corrupt new save can be recovered automatically
        by the next ``load_config``.
      * Raises ``OSError`` on disk failures so API endpoints can
        surface a meaningful 500.
    """
    with _CONFIG_IO_LOCK:
        raw_encrypted_keys = _load_raw_encrypted_provider_keys_unlocked()
        current = _load_config_unlocked()
        update = _preserve_redacted_provider_keys(json.loads(json.dumps(cfg or {})), current)
        merged_current = _deep_merge(current, update)
        merged = _deep_merge(DEFAULT_CONFIG, merged_current)
        merged = _preserve_undecryptable_provider_keys(merged, current, update, raw_encrypted_keys)
        # Always stamp the current schema version on write — callers may
        # POST partial configs without it; _deep_merge already inserted
        # DEFAULT_CONFIG['schema_version'], but explicit is safer.
        merged["schema_version"] = SCHEMA_VERSION
        # Shape-validate merged result so we never persist a structurally
        # broken config just because a migration or caller went wrong.
        merged = _validate_config_shape(merged)
        encrypted = _encrypt_provider_keys(merged)
        # Rotate the current on-disk file to .bak BEFORE the write. If the
        # new write fails mid-flight, load_config's fallback recovers from
        # the backup on the next boot.
        _rotate_backup_if_primary_valid()
        try:
            _atomic_write_json(CONFIG_PATH, encrypted, mode=CONFIG_FILE_MODE)
        except OSError as e:
            logger.error("failed to persist config at %s: %s", CONFIG_PATH, e)
            raise


def redact_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Return a deep copy of *cfg* with every provider key redacted.

    Iterates ``providers.keys()`` rather than a hardcoded
    ``("openrouter", "deepgram")`` tuple so any future provider added
    to DEFAULT_CONFIG / config.json is automatically redacted on every
    log + diagnostic dump. The previous tuple meant a hypothetical
    ``elevenlabs`` / ``assemblyai`` provider's key would leak through
    every redact site (logs, support bundles, error envelopes) until
    someone remembered to add the new name to this list.
    """
    cfg = json.loads(json.dumps(cfg))
    providers = cfg.get("providers")
    if not isinstance(providers, dict):
        return cfg
    for name, prov in list(providers.items()):
        if not isinstance(prov, dict) or "key" not in prov:
            continue
        k = prov.get("key") or ""
        prov["key"] = _redact_provider_key_value(k)
    return cfg
