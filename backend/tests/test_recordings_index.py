"""The persistent recordings metadata index (``backend.recordings_index``).

The History list parses a few fields out of every transcript. The index
keeps them on disk so a launch re-parses only what changed. These tests
go through ``backend.main``'s real scan (``_build_recordings_list_payload``)
with a counter on the parser, and restart the backend by re-importing
``backend.main`` over the same data dir.
"""

import json
import os
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from backend import recordings_index
from backend.tests.test_recording_names import _IsolatedMainCase, _fresh_main_module


class RecordingsIndexScanTests(_IsolatedMainCase):
    def _root(self) -> Path:
        return Path(self.main._resolve_recordings_dir())

    def _save(self, name: str, text: str) -> Path:
        path = self._root() / name
        path.write_text(text, encoding="utf-8")
        return path

    def _index_path(self) -> Path:
        return self.main.DATA_DIR / recordings_index.INDEX_FILENAME

    def _restart(self):
        """A new backend process over the same data dir."""
        self.main = _fresh_main_module(self._tmp.name)

    def _scan(self):
        """Scan, returning (payload, names of the transcripts parsed)."""
        parsed: list[str] = []
        real = self.main._parse_recording_entry

        def counting(raw, stem, *, screen_take):
            parsed.append(stem)
            return real(raw, stem, screen_take=screen_take)

        with mock.patch.object(self.main, "_parse_recording_entry", side_effect=counting):
            payload = self.main._build_recordings_list_payload(self._root())
        return payload, sorted(parsed)

    def _seed(self):
        self._save("20261122-101010.txt", "Provider: Deepgram\nLanguage: RU\n\nПривет мир")
        self._save("20261122-111111.txt", "Title: Звонок\nSource file: call.m4a\n\nтекст")
        self._save("20261122-121212.txt", "Provider: openrouter\n\nhello there")

    def test_cold_start_parses_everything_and_writes_the_index(self):
        self._seed()
        self.assertFalse(self._index_path().exists())

        payload, parsed = self._scan()

        self.assertEqual(parsed, ["20261122-101010", "20261122-111111", "20261122-121212"])
        self.assertTrue(self._index_path().exists())
        doc = json.loads(self._index_path().read_bytes())
        self.assertEqual(doc["format"], recordings_index.INDEX_FORMAT)
        self.assertEqual(len(doc["entries"]), 3)
        by_name = {i["name"]: i for i in payload["items"]}
        self.assertEqual(by_name["20261122-101010.txt"]["provider"], "deepgram")
        self.assertEqual(by_name["20261122-101010.txt"]["language"], "ru")
        self.assertEqual(by_name["20261122-111111.txt"]["display_name"], "call.m4a")

    def test_warm_start_parses_nothing_and_returns_the_same_list(self):
        self._seed()
        cold, _ = self._scan()
        self._restart()

        with mock.patch.object(Path, "read_text", side_effect=AssertionError("transcript read")):
            warm, parsed = self._scan()

        self.assertEqual(parsed, [])
        self.assertEqual(warm, cold)

    def test_a_changed_transcript_alone_is_parsed_again(self):
        self._seed()
        self._scan()
        changed = self._save("20261122-121212.txt", "Provider: deepgram\nLanguage: en\n\nhello again, longer")
        self._restart()

        payload, parsed = self._scan()

        self.assertEqual(parsed, ["20261122-121212"])
        item = {i["name"]: i for i in payload["items"]}[changed.name]
        self.assertEqual((item["provider"], item["language"]), ("deepgram", "en"))
        # And the re-parse is persisted: the next launch parses nothing.
        self._restart()
        self.assertEqual(self._scan()[1], [])

    def test_a_deleted_transcript_leaves_the_index(self):
        self._seed()
        self._scan()
        gone = self._root() / "20261122-111111.txt"
        gone.unlink()
        self._restart()

        payload, parsed = self._scan()

        self.assertEqual(parsed, [])
        self.assertNotIn(gone.name, {i["name"] for i in payload["items"]})
        entries = json.loads(self._index_path().read_bytes())["entries"]
        self.assertNotIn(str(gone), entries)
        self.assertEqual(len(entries), 2)

    def test_a_new_transcript_in_a_running_backend_goes_through_the_index(self):
        self._seed()
        self._scan()
        self._save("20261122-131313.txt", "Language: de\n\nhallo")
        self.main._invalidate_recordings_cache()

        _, parsed = self._scan()

        self.assertEqual(parsed, ["20261122-131313"])
        self.assertEqual(len(json.loads(self._index_path().read_bytes())["entries"]), 4)

    def test_changed_parsing_rules_rebuild_the_whole_index(self):
        self._seed()
        self._scan()
        self._restart()

        with mock.patch.object(self.main.RECORDINGS_INDEX, "_rules_version", "other rules"):
            _, parsed = self._scan()

        self.assertEqual(len(parsed), 3)
        self.assertEqual(json.loads(self._index_path().read_bytes())["rules"], "other rules")

    def test_a_corrupt_index_is_rebuilt_without_failing(self):
        self._seed()
        cold, _ = self._scan()
        for damage in (b"", b"{\"format\": 1, \"rules\": \"x\", \"entr", b"\xff\xfe not json", b"[1, 2]"):
            with self.subTest(damage=damage):
                self._index_path().write_bytes(damage)
                self._restart()

                payload, parsed = self._scan()

                self.assertEqual(len(parsed), 3)
                self.assertEqual(payload, cold)
                # Rewritten whole: the following launch is warm again.
                self._restart()
                self.assertEqual(self._scan()[1], [])

    def test_a_malformed_entry_is_re_parsed_alone(self):
        self._seed()
        self._scan()
        doc = json.loads(self._index_path().read_bytes())
        key = str(self._root().resolve() / "20261122-101010.txt")
        self.assertIn(key, doc["entries"])
        doc["entries"][key] = ["not", "a", "record"]
        self._index_path().write_text(json.dumps(doc), encoding="utf-8")
        self._restart()

        _, parsed = self._scan()

        self.assertEqual(parsed, ["20261122-101010"])

    def test_an_unwritable_index_does_not_break_the_list(self):
        self._seed()
        with mock.patch.object(recordings_index, "atomic_write_bytes", side_effect=OSError("disk full")):
            payload, parsed = self._scan()
        self.assertEqual(len(payload["items"]), 3)
        self.assertEqual(len(parsed), 3)
        # Still dirty, so the next scan writes it.
        self._scan()
        self.assertTrue(self._index_path().exists())

    def test_the_index_lives_in_the_data_dir_and_leaves_no_tmp_file(self):
        self._seed()
        self._scan()
        self.assertEqual(self._index_path().parent, self.main.DATA_DIR)
        leftovers = [p.name for p in self.main.DATA_DIR.iterdir() if ".tmp-" in p.name]
        self.assertEqual(leftovers, [])


def _module(source: str, name: str = "backend._fingerprint_probe") -> types.ModuleType:
    module = types.ModuleType(name)
    module.__dict__["re"] = re
    exec(compile(source, f"<{name}>", "exec"), module.__dict__)
    return module


class RulesFingerprintTests(unittest.TestCase):
    """The rules version follows the parser without a hand-bumped constant."""

    BASE = (
        "LABEL = 'Provider'\n"
        "PATTERN = re.compile(r'^x$')\n"
        "def helper(text):\n"
        "    return text.lower()\n"
        "def parse(raw):\n"
        "    return {'provider': helper(raw) + LABEL, 'hit': bool(PATTERN.search(raw))}\n"
    )

    def _fp(self, source: str) -> str:
        return recordings_index.code_fingerprint(_module(source).parse)

    def test_the_fingerprint_is_stable_and_ignores_line_positions(self):
        self.assertEqual(self._fp(self.BASE), self._fp(self.BASE))
        self.assertEqual(self._fp(self.BASE), self._fp("\n\n\n" + self.BASE))

    def test_a_change_anywhere_in_the_rules_changes_the_fingerprint(self):
        base = self._fp(self.BASE)
        changes = {
            "the parser": self.BASE.replace("bool(PATTERN", "not (PATTERN"),
            "a helper it calls": self.BASE.replace("text.lower()", "text.upper()"),
            "a constant it reads": self.BASE.replace("'Provider'", "'Language'"),
            "a regex it reads": self.BASE.replace("r'^x$'", "r'^y$'"),
        }
        for what, source in changes.items():
            with self.subTest(what):
                self.assertNotEqual(self._fp(source), base)

    def test_the_fingerprint_is_the_same_in_another_process(self):
        # Set and frozenset order is hash-seeded per process; the digest
        # must not depend on it or every launch would rebuild the index.
        import subprocess

        code = (
            "import backend.main as m, backend.recordings_index as r;"
            "print(r.code_fingerprint(m._parse_recording_entry))"
        )
        root = Path(__file__).resolve().parents[2]
        digests = set()
        for seed in ("1", "2"):
            with tempfile.TemporaryDirectory() as home:
                env = dict(
                    os.environ,
                    PYTHONHASHSEED=seed,
                    HOME=home,
                    USERPROFILE=home,
                    TRANSCRIPTOR_DATA_DIR=str(Path(home) / "data"),
                    TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG="1",
                )
                out = subprocess.run(
                    [sys.executable, "-c", code], cwd=root, env=env, capture_output=True, text=True, check=True
                )
            digests.add(out.stdout.strip().splitlines()[-1])
        self.assertEqual(len(digests), 1)


class RealParserFingerprintTests(_IsolatedMainCase):
    def test_the_real_parser_reaches_every_helper_it_uses(self):
        main = self.main
        seen: list[str] = []
        real = recordings_index._Fingerprinter.function

        def recording(fp, fn):
            seen.append(fn.__qualname__)
            return real(fp, fn)

        with mock.patch.object(recordings_index._Fingerprinter, "function", recording):
            recordings_index.code_fingerprint(main._parse_recording_entry)
        for helper in (
            "_recording_display_name_from_content",
            "_recording_source_file",
            "_extract_meta_field",
            "_first_words",
            "_recording_section",
            "_legacy_screen_spoken_text",
            "is_recording_stem",
        ):
            self.assertIn(helper, seen)


if __name__ == "__main__":
    unittest.main()
