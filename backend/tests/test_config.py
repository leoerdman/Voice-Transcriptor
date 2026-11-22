"""Tests for backend.config — the SSOT config system.

Covers the full lifecycle:

    * Fresh load returns DEFAULT_CONFIG with current schema_version
    * Save → load roundtrip preserves values and decrypts keys
    * Second save rotates previous to .bak
    * Corrupt primary → automatic recovery from .bak
    * Legacy v1 (no schema_version) → migrated to current
    * Plain-text provider keys → transparently encrypted on disk
    * Invalid shape → repaired with warning (not crash)
    * Forward-compat: newer schema_version preserved, unknown fields kept

Each test runs in an isolated TRANSCRIPTOR_DATA_DIR. Because
backend.config resolves DATA_DIR / CONFIG_PATH at module import time
from the env var, we re-import fresh in each test via ``importlib``
to get clean state.

Run with:
    python -m unittest backend.tests.test_config -v
"""

import importlib
import json
import os
import sys
import tempfile
import unittest


def _reload_config_module(data_dir: str):
    """Reimport backend.config with TRANSCRIPTOR_DATA_DIR pointing at
    *data_dir*. Returns the fresh module."""
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    # Drop the cached module so module-top-level DATA_DIR is recomputed.
    if "backend.config" in sys.modules:
        del sys.modules["backend.config"]
    return importlib.import_module("backend.config")


class TestConfigLifecycle(unittest.TestCase):
    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name
        self.config_mod = _reload_config_module(self.data_dir)

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir

    def test_fresh_load_returns_defaults(self):
        cfg = self.config_mod.load_config()
        self.assertEqual(cfg.get("schema_version"), self.config_mod.SCHEMA_VERSION)
        self.assertIn("providers", cfg)
        self.assertIn("preferences", cfg)
        # No side-effect file created.
        self.assertFalse(self.config_mod.CONFIG_PATH.exists())

    def test_save_load_roundtrip(self):
        self.config_mod.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-roundtrip-test-12345678"}},
            "preferences": {"remote_provider": "deepgram"},
        })
        cfg = self.config_mod.load_config()
        self.assertEqual(
            cfg["providers"]["openrouter"]["key"],
            "sk-or-v1-roundtrip-test-12345678",
        )
        self.assertEqual(cfg["preferences"]["remote_provider"], "deepgram")

    def test_redacted_provider_key_roundtrip_preserves_real_secret(self):
        """GET /api/config returns masked keys; posting that payload back
        must not persist the mask as the real provider key."""
        real_key = "sk-or-v1-real-secret-1234567890"
        self.config_mod.save_config({
            "providers": {"openrouter": {"key": real_key}},
            "preferences": {"remote_provider": "openrouter"},
        })
        redacted_payload = self.config_mod.redact_config(self.config_mod.load_config())
        self.assertEqual(redacted_payload["providers"]["openrouter"]["key"], "sk-...90")

        self.config_mod.save_config(redacted_payload)

        cfg = self.config_mod.load_config()
        self.assertEqual(cfg["providers"]["openrouter"]["key"], real_key)

    def test_undecryptable_encrypted_key_survives_unrelated_save(self):
        real_key = "sk-or-v1-survive-fernet-outage-1234567890"
        self.config_mod.save_config({
            "providers": {"openrouter": {"key": real_key}},
            "preferences": {"remote_provider": "openrouter"},
        })
        raw_before = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        encrypted_key = raw_before["providers"]["openrouter"]["key"]
        self.assertTrue(encrypted_key.startswith("enc:"))

        self.config_mod._FERNET = None
        unreadable = self.config_mod.load_config()
        self.assertEqual(unreadable["providers"]["openrouter"]["key"], "")

        self.config_mod.save_config({"preferences": {"remote_provider": "deepgram"}})

        raw_after = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(raw_after["providers"]["openrouter"]["key"], encrypted_key)
        self.assertEqual(raw_after["preferences"]["remote_provider"], "deepgram")

    def test_first_save_writes_no_backup(self):
        """Nothing to rotate if the file is new — .bak should only
        appear starting from the second save onward."""
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-first-12345678"}}})
        self.assertTrue(self.config_mod.CONFIG_PATH.exists())
        self.assertFalse(self.config_mod._CONFIG_BACKUP_PATH.exists())

    def test_second_save_rotates_backup(self):
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-first-12345678"}}})
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-second-87654321"}}})
        self.assertTrue(self.config_mod._CONFIG_BACKUP_PATH.exists())
        # Backup holds the FIRST (encrypted) value.
        raw = json.loads(self.config_mod._CONFIG_BACKUP_PATH.read_text(encoding="utf-8"))
        self.assertTrue(raw["providers"]["openrouter"]["key"].startswith("enc:"))

    def test_corrupt_primary_falls_back_to_backup(self):
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-survivor-key-123"}}})
        # Trigger a backup rotation.
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-overwritten-456"}}})
        # Corrupt the primary.
        self.config_mod.CONFIG_PATH.write_text("{ corrupt json", encoding="utf-8")
        cfg = self.config_mod.load_config()
        # We recover whatever the .bak held — the FIRST save's key.
        self.assertEqual(
            cfg["providers"]["openrouter"]["key"],
            "sk-survivor-key-123",
        )

    def test_legacy_v1_migration(self):
        """1.0.x configs had no schema_version and plain-text keys.
        load_config should (a) migrate to SCHEMA_VERSION and
        (b) re-encrypt the keys on disk."""
        legacy = {
            "providers": {"openrouter": {"key": "plain-legacy-key-1234567890"}},
            "preferences": {"remote_provider": "openrouter"},
        }
        self.config_mod.CONFIG_PATH.write_text(json.dumps(legacy), encoding="utf-8")
        cfg = self.config_mod.load_config()
        # In-memory view: decrypted key + current schema.
        self.assertEqual(cfg["schema_version"], self.config_mod.SCHEMA_VERSION)
        self.assertEqual(
            cfg["providers"]["openrouter"]["key"],
            "plain-legacy-key-1234567890",
        )
        # On-disk: encrypted.
        raw = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertTrue(raw["providers"]["openrouter"]["key"].startswith("enc:"))

    def test_invalid_shape_repaired(self):
        """A provider sub-tree that is not a dict should be reset to
        defaults — not crash load_config."""
        bad = {
            "schema_version": 2,
            "providers": "oops-a-string",
            "preferences": {"remote_provider": "openrouter"},
        }
        self.config_mod.CONFIG_PATH.write_text(json.dumps(bad), encoding="utf-8")
        cfg = self.config_mod.load_config()
        self.assertIsInstance(cfg["providers"], dict)
        # providers reset to defaults
        self.assertIn("openrouter", cfg["providers"])

    def test_invalid_remote_provider_resets_to_default(self):
        bad = {
            "schema_version": 2,
            "providers": {"openrouter": {"key": ""}},
            "preferences": {"remote_provider": "not-a-provider"},
        }
        self.config_mod.CONFIG_PATH.write_text(json.dumps(bad), encoding="utf-8")

        cfg = self.config_mod.load_config()

        self.assertEqual(
            cfg["preferences"]["remote_provider"],
            self.config_mod.DEFAULT_CONFIG["preferences"]["remote_provider"],
        )

    def test_forward_compat_preserves_newer_version(self):
        """A config written by a newer Transcriptor should NOT be
        downgraded. Unknown fields are preserved so no data is lost
        when the user alternates between 1.1.1 and a hypothetical
        1.2.0."""
        future = {
            "schema_version": 99,
            "providers": {"openrouter": {"key": ""}},
            "preferences": {"remote_provider": "openrouter"},
            "mystery_future_field": {"nested": 42},
        }
        self.config_mod.CONFIG_PATH.write_text(json.dumps(future), encoding="utf-8")
        cfg = self.config_mod.load_config()
        self.assertEqual(cfg["schema_version"], 99)
        self.assertEqual(cfg["mystery_future_field"], {"nested": 42})

    def test_legacy_no_schema_with_encrypted_keys_gets_stamped(self):
        """Regression for pass-23 M.

        1.1.0-beta shipped without `schema_version` in its config.
        If a user of that build had ALREADY encrypted their keys
        (or manually wrote an encrypted value), the key-migration
        branch in `load_config` did not trigger, so the stamp path
        was the only route to add `schema_version=2` to disk. But
        that branch compared `raw["schema_version"]` AFTER
        _migrate_schema mutated it to the current value — so the
        comparison was always False and the stamp never fired.
        Self-heals on the first save_config, but leaves load_config's
        idempotency contract broken: a fresh boot re-runs the
        v1→v2 migration pass (cheap but wasteful).

        After pass-23 M: the pre-migration version is captured and
        used for the comparison, so the stamp fires correctly.
        """
        # Seed a 1.1.0-beta-shaped config: encrypted keys, no
        # schema_version. Use the encrypt_value helper so the key
        # shape is legit (otherwise it'd fall into the re-encryption
        # branch, not the stamp branch, and we wouldn't exercise M).
        self.config_mod.load_config()  # initialize encryption_key
        encrypted = self.config_mod.encrypt_value("sk-pretend-encrypted-key-12345")
        legacy = {
            "providers": {"openrouter": {"key": encrypted}},
            "preferences": {"remote_provider": "openrouter"},
            # schema_version deliberately absent
        }
        self.config_mod.CONFIG_PATH.write_text(
            json.dumps(legacy),
            encoding="utf-8",
        )
        # Pre-load: on-disk has NO schema_version
        raw = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertNotIn("schema_version", raw)
        # Trigger load — should stamp the version to disk
        self.config_mod.load_config()
        # Post-load: on-disk MUST now have schema_version = SCHEMA_VERSION
        raw_after = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            raw_after.get("schema_version"),
            self.config_mod.SCHEMA_VERSION,
            "M regression — schema_version not stamped to disk",
        )

    def test_encryption_keyfile_created_atomically(self):
        """First `load_config` on a fresh data dir must persist a
        non-empty .encryption_key. A zero-length keyfile would
        silently invalidate every previously-encrypted value on next
        load — so atomicity here is shipping-critical."""
        self.config_mod.load_config()
        kf = self.config_mod._KEYFILE
        self.assertTrue(kf.exists())
        self.assertGreater(len(kf.read_bytes()), 0)

    def test_legacy_recording_migration_copies_every_canonical_audio_ext(self):
        legacy_root = tempfile.TemporaryDirectory()
        self.addCleanup(legacy_root.cleanup)
        legacy_data = os.path.join(legacy_root.name, "legacy-data")
        legacy_recordings = os.path.join(legacy_data, "recordings")
        os.makedirs(legacy_recordings)

        transcript = os.path.join(legacy_recordings, "Clip.txt")
        with open(transcript, "w", encoding="utf-8") as f:
            f.write("legacy transcript")
        for ext in self.config_mod.AUDIO_EXT_TO_MIME.keys():
            with open(os.path.join(legacy_recordings, f"Clip{ext}"), "wb") as f:
                f.write(ext.encode("ascii"))

        self.config_mod.LEGACY_DATA_DIR = self.config_mod.Path(legacy_data)
        self.config_mod._migrate_legacy_data()

        migrated_recordings = self.config_mod.DATA_DIR / "recordings"
        self.assertEqual(
            (migrated_recordings / "Clip.txt").read_text(encoding="utf-8"),
            "legacy transcript",
        )
        for ext in self.config_mod.AUDIO_EXT_TO_MIME.keys():
            with self.subTest(ext=ext):
                self.assertEqual(
                    (migrated_recordings / f"Clip{ext}").read_bytes(),
                    ext.encode("ascii"),
                )


class LegacyKeyAdoptionTests(unittest.TestCase):
    """BM-22: adopting the legacy key replaces the keyfile in one rename; a
    failed write leaves the current key on disk, matching the cipher this
    process keeps using."""

    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        self.mod = _reload_config_module(self._tmp.name)
        if not self.mod._HAS_CRYPTO:
            self.skipTest("cryptography is not installed")
        legacy = os.path.join(self._tmp.name, "legacy")
        os.makedirs(legacy)
        from cryptography.fernet import Fernet

        with open(os.path.join(legacy, ".encryption_key"), "wb") as f:
            f.write(Fernet.generate_key())
        self.mod.LEGACY_DATA_DIR = self.mod.Path(legacy)

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir

    def test_a_failed_write_keeps_the_current_keyfile(self):
        import errno
        from unittest import mock

        before = self.mod._KEYFILE.read_bytes()
        with mock.patch("os.fsync", side_effect=OSError(errno.EIO, "Input/output error")):
            self.mod._adopt_legacy_encryption_key()
        self.assertEqual(self.mod._KEYFILE.read_bytes(), before, "the key in use no longer exists on disk")
        self.assertEqual(self.mod._FERNET_KEY, before)


class SchemaStampTests(unittest.TestCase):
    """``load_config()`` is a READ (B-018).

    The stamp branch fired on ``original_schema_version != SCHEMA_VERSION``
    and wrote back ``merged``, whose ``schema_version`` came from the
    file — so for a file written by a NEWER build the condition never
    cleared. Every read rewrote ``config.json`` and rotated ``.bak``:
    four fsyncs on a path served ~120 times a minute, and the only
    automatic recovery copy of the user's settings destroyed within
    seconds of any corruption.
    """

    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name
        self.config_mod = _reload_config_module(self.data_dir)

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir

    def _write(self, payload: dict) -> None:
        self.config_mod.CONFIG_PATH.write_text(
            json.dumps(payload), encoding="utf-8"
        )

    def _mtimes(self):
        cfg = self.config_mod.CONFIG_PATH
        bak = cfg.with_suffix(cfg.suffix + ".bak")
        return (
            cfg.stat().st_mtime_ns if cfg.exists() else None,
            bak.exists(),
        )

    def test_a_newer_config_is_never_rewritten_on_read(self):
        self._write({"schema_version": self.config_mod.SCHEMA_VERSION + 1})
        first = self.config_mod.CONFIG_PATH.read_bytes()
        for _ in range(3):
            self.config_mod.load_config()
        self.assertEqual(
            self.config_mod.CONFIG_PATH.read_bytes(),
            first,
            "a read rewrote the config file",
        )
        self.assertFalse(
            self._mtimes()[1],
            "a read rotated .bak, the only recovery copy of the settings",
        )

    def test_a_config_at_this_version_is_never_rewritten_on_read(self):
        self._write({"schema_version": self.config_mod.SCHEMA_VERSION})
        first = self.config_mod.CONFIG_PATH.read_bytes()
        self.config_mod.load_config()
        self.assertEqual(self.config_mod.CONFIG_PATH.read_bytes(), first)
        self.assertFalse(self._mtimes()[1])

    def test_a_config_with_no_version_is_stamped_exactly_once(self):
        self._write({"providers": {"openrouter": {"key": ""}}})
        self.config_mod.load_config()
        stamped = json.loads(
            self.config_mod.CONFIG_PATH.read_text(encoding="utf-8")
        )
        # What is PRINTED is what is WRITTEN: the log said version=2
        # while persisting whatever the file already had.
        self.assertEqual(
            stamped["schema_version"], self.config_mod.SCHEMA_VERSION
        )
        after_first = self.config_mod.CONFIG_PATH.read_bytes()
        self.config_mod.load_config()
        self.assertEqual(
            self.config_mod.CONFIG_PATH.read_bytes(),
            after_first,
            "the one-off stamp ran again",
        )


class BluetoothBuiltinMicMigrationTests(SchemaStampTests):
    """v3: the 1.6.22-1.6.24 default ``bluetooth_builtin_mic: true`` is
    dropped, so the setting reads as the new default, off."""

    def _ui_after_load(self, ui: dict) -> dict:
        self._write({"schema_version": 2, "preferences": {"ui": ui}})
        self.config_mod.load_config()
        on_disk = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["schema_version"], 3)
        return on_disk["preferences"]["ui"]

    def test_a_stored_true_from_the_old_default_is_dropped(self):
        ui = self._ui_after_load({"bluetooth_builtin_mic": True, "screen_clicks": True})
        self.assertNotIn("bluetooth_builtin_mic", ui)
        self.assertTrue(ui["screen_clicks"], "the other preferences are kept")

    def test_a_stored_false_is_kept(self):
        self.assertIs(self._ui_after_load({"bluetooth_builtin_mic": False})["bluetooth_builtin_mic"], False)

    def test_a_true_saved_at_v3_is_the_users_and_survives(self):
        self._write({"schema_version": 3, "preferences": {"ui": {"bluetooth_builtin_mic": True}}})
        cfg = self.config_mod.load_config()
        self.assertIs(cfg["preferences"]["ui"]["bluetooth_builtin_mic"], True)


class OpenRouterPreferenceValidationTests(unittest.TestCase):
    """``preferences.openrouter`` is repaired like ``preferences.deepgram`` (B-019)."""

    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        self.config_mod = _reload_config_module(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir

    def test_a_string_where_the_block_belongs_is_reset(self):
        self.config_mod.save_config({"preferences": {"openrouter": "oops"}})
        cfg = self.config_mod.load_config()
        # The consumers do exactly this and used to raise AttributeError
        # into a 500 on every Upscale and every remote transcription,
        # permanently, with no way to undo it from the UI.
        self.assertIsInstance(cfg["preferences"]["openrouter"], dict)
        self.assertEqual(
            cfg["preferences"]["openrouter"]["model"],
            self.config_mod.DEFAULT_CONFIG["preferences"]["openrouter"]["model"],
        )

    def test_a_non_string_model_falls_back_to_the_default(self):
        self.config_mod.save_config(
            {"preferences": {"openrouter": {"model": 42}}}
        )
        cfg = self.config_mod.load_config()
        self.assertEqual(
            cfg["preferences"]["openrouter"]["model"],
            self.config_mod.DEFAULT_CONFIG["preferences"]["openrouter"]["model"],
        )

    def test_a_valid_model_is_left_alone(self):
        self.config_mod.save_config(
            {"preferences": {"openrouter": {"model": "vendor/some-model"}}}
        )
        cfg = self.config_mod.load_config()
        self.assertEqual(
            cfg["preferences"]["openrouter"]["model"], "vendor/some-model"
        )


class EmptyKeyfileTests(unittest.TestCase):
    """A 0-byte keyfile is an ABSENT keyfile (B-020).

    "Never overwrite an existing keyfile" is right for a file with
    content — something may still be decryptable with it. An empty file
    protects nothing, and refusing to replace it left ``_FERNET`` at
    ``None`` for this process and every process after it: every
    ``POST /api/config`` carrying a provider key answered 503 and the
    user could never enter one, on any restart.
    """

    def setUp(self):
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir

    def test_an_empty_keyfile_is_replaced_and_secrets_work_again(self):
        from pathlib import Path

        keyfile = Path(self.data_dir) / ".encryption_key"
        keyfile.write_bytes(b"")
        mod = _reload_config_module(self.data_dir)
        if not mod._HAS_CRYPTO:
            self.skipTest("cryptography is not installed")
        self.assertGreater(
            keyfile.stat().st_size, 0, "the empty keyfile was left in place"
        )
        mod.save_config({"providers": {"openrouter": {"key": "sk-secret"}}})
        self.assertEqual(
            mod.load_config()["providers"]["openrouter"]["key"], "sk-secret"
        )

    def test_a_whitespace_only_keyfile_is_an_empty_one(self):
        # BM-21: an editor's lone newline read as "no key" when loading and
        # as "has content" when deciding to replace — encryption off for good.
        from pathlib import Path

        keyfile = Path(self.data_dir) / ".encryption_key"
        keyfile.write_bytes(b"\n")
        mod = _reload_config_module(self.data_dir)
        if not mod._HAS_CRYPTO:
            self.skipTest("cryptography is not installed")
        self.assertIsNotNone(mod._FERNET, "a whitespace keyfile left encryption off")
        self.assertTrue(keyfile.read_bytes().strip())

    def test_a_keyfile_with_content_is_never_replaced(self):
        from pathlib import Path

        keyfile = Path(self.data_dir) / ".encryption_key"
        keyfile.write_bytes(b"not-a-valid-fernet-key")
        mod = _reload_config_module(self.data_dir)
        if not mod._HAS_CRYPTO:
            self.skipTest("cryptography is not installed")
        self.assertEqual(
            keyfile.read_bytes(),
            b"not-a-valid-fernet-key",
            "a keyfile with content was overwritten; stored secrets would be lost",
        )


class DataDirFallbackTests(unittest.TestCase):
    """Importing this module must not be able to kill the process (B-021)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_home = os.environ.get("HOME")
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        # The fallback is ``~/.transcriptor``; HOME is redirected so the
        # test cannot leave a stray key directory in the real one.
        os.environ["HOME"] = self._tmp.name

    def tearDown(self):
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home
        sys.modules.pop("backend.config", None)
        self._tmp.cleanup()

    def test_an_unusable_data_dir_degrades_instead_of_raising(self):
        # ``backend.main`` imports this module at module level, so an
        # exception here killed the backend before uvicorn started and
        # Electron could only report "backend did not start" — never
        # that one documented environment variable was the cause.
        from pathlib import Path

        blocker = Path(self._tmp.name) / "blocker"
        blocker.write_text("not a directory", encoding="utf-8")
        os.environ["TRANSCRIPTOR_DATA_DIR"] = str(blocker / "data")
        sys.modules.pop("backend.config", None)
        with self.assertLogs("backend.config", level="ERROR") as logs:
            mod = importlib.import_module("backend.config")
        self.assertTrue(
            any("is unusable" in line for line in logs.output), logs.output
        )
        self.assertEqual(
            mod.DATA_DIR, Path(self._tmp.name) / ".transcriptor"
        )
        self.assertTrue(mod.DATA_DIR.is_dir())


class EnvExampleContractTests(unittest.TestCase):
    """``.env.example`` is the SSOT for release environment variables.

    AGENTS.md paragraph 4 says so, and the file itself ends with an
    explicit list of the variables it deliberately omits — which makes
    everything else in it a claim of completeness. Four backend
    variables were read by code and named nowhere (B-029), and the file
    opened by telling the user to copy it to ``.env``, a mechanism this
    project does not have anywhere (B-023).
    """

    @staticmethod
    def _repo_root():
        from pathlib import Path

        return Path(__file__).resolve().parents[2]

    def _env_example(self) -> str:
        return (self._repo_root() / ".env.example").read_text(encoding="utf-8")

    def test_every_backend_variable_is_documented_or_declared_internal(self):
        import re
        from pathlib import Path

        backend_dir = self._repo_root() / "backend"
        used = set()
        for path in list(backend_dir.glob("*.py")) + list(
            (backend_dir / "tools").glob("*.py")
        ):
            # Every quoted TRANSCRIPTOR_* name, not just the ones passed
            # straight to ``os.environ``: three of the four missing
            # variables reached the environment through ``_env_flag``,
            # so a narrower scan would have reported the file complete.
            used.update(
                re.findall(
                    r'["\'](TRANSCRIPTOR_[A-Z0-9_]+)["\']',
                    path.read_text(encoding="utf-8"),
                )
            )
        text = self._env_example()
        undocumented = sorted(n for n in used if n not in text)
        self.assertEqual(
            undocumented,
            [],
            "the backend reads these and .env.example names none of them",
        )

    def test_the_file_does_not_promise_a_dotenv_mechanism(self):
        # Nothing loads a .env: no python-dotenv in either requirements
        # file, no load_dotenv() in the backend, and desktop/main.js
        # reads process.env directly. A user following the old first
        # line got no effect from any of the ~43 variables, silently.
        root = self._repo_root()
        for name in ("requirements.txt", "requirements.runtime-lock.txt"):
            path = root / name
            if path.exists():
                self.assertNotIn(
                    "dotenv", path.read_text(encoding="utf-8").lower(), name
                )
        backend_sources = "".join(
            p.read_text(encoding="utf-8") for p in (root / "backend").glob("*.py")
        )
        self.assertNotIn("load_dotenv", backend_sources)
        self.assertNotIn(
            "Copy to .env",
            self._env_example()[:400],
            ".env.example still tells the user to copy it to .env",
        )

    def test_the_clamped_whisper_settings_state_their_range(self):
        # A value outside the range is silently pulled into it, so a
        # user setting 16 threads and measuring no change has no way to
        # find out why.
        text = self._env_example()
        for marker in ("Clamped to 4-8", "Clamped to 1-3"):
            self.assertIn(marker, text)


class DirectDependencyTests(unittest.TestCase):
    """``requirements.txt`` is the direct-dependency SSOT (B-022).

    ``requirements.runtime-lock.txt`` states that rule in its own
    header. ``huggingface_hub`` is imported for six symbols by
    ``models_manager`` and ``main`` and was declared in neither file as
    a direct dependency — it arrived through faster-whisper, whose bound
    is ">=0.13" with no upper limit.
    """

    def test_every_third_party_module_the_backend_imports_is_declared(self):
        import re
        from pathlib import Path

        root = Path(__file__).resolve().parents[2]
        declared = (root / "requirements.txt").read_text(encoding="utf-8")
        declared_names = {
            re.split(r"[<>=!\[]", line, 1)[0].strip().replace("-", "_").lower()
            for line in declared.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        # Third-party modules this backend imports by name. Kept
        # explicit rather than inferred: an inferred list would have to
        # decide what is stdlib, and getting that wrong turns this test
        # into noise.
        third_party = {
            "fastapi",
            "uvicorn",
            "faster_whisper",
            "soundfile",
            "numpy",
            "requests",
            "cryptography",
            "websockets",
            "huggingface_hub",
        }
        missing = sorted(third_party - declared_names)
        self.assertEqual(missing, [], "imported directly, declared nowhere")

if __name__ == "__main__":
    unittest.main()
