from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from backend.deepgram_dual import merge_readings
from backend.tools.dual_dump import build_dump, write_dump
from backend.tools.dual_replay import merge_dump, replay


class DualDumpReplayTests(unittest.TestCase):
    def test_dump_replay_matches_live_merge_and_keeps_keyterm_case(self):
        fixture = Path(__file__).parent / "fixtures/deepgram_live_20261123_191519.json"
        messages = json.loads(fixture.read_text(encoding="utf-8"))
        result = next(
            message for message in messages
            if message.get("reading") == "ru" and message.get("is_final")
            and any(word.get("word", "").lower() == "jarvis" for word in message.get("words", []))
        )
        words_by_text = {word.get("word", "").lower(): word for word in result["words"]}
        source = words_by_text["jarvis"]
        before = words_by_text["сейчас"]
        primary = [
            {"start": before["start"], "end": before["end"], "text": "сейчас",
             "words": [{"word": "сейчас", "start": before["start"], "end": before["end"]}]},
            {"start": source["start"], "end": source["end"], "text": "Jarvis",
             "words": [{"word": "Jarvis", "start": source["start"], "end": source["end"]}]},
        ]
        secondary = [{
            "start": before["start"], "end": source["end"], "text": "сейчас клод",
            "words": [
                {"word": "сейчас", "start": before["start"], "end": before["end"]},
                {"word": "клод", "start": source["start"], "end": source["end"]},
            ],
        }]
        dump = build_dump(
            file=fixture.name,
            primary_language="multi",
            secondary_language="ru",
            expected_languages=["ru", "en"],
            keyterms=["Jarvis"],
            primary_segments=primary,
            secondary_segments=secondary,
            messages={"multi": [result], "ru": [result]},
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "take.json"
            write_dump(path, dump)
            replayed = merge_dump(json.loads(path.read_text(encoding="utf-8")))
        live = merge_readings(
            primary, secondary, primary_language="multi",
            secondary_language="ru", expected_languages=["ru", "en"],
            keyterms=["Jarvis"],
        )
        self.assertEqual(replayed, live)
        self.assertIn("Jarvis", live.text)
        self.assertEqual(merge_readings(primary, secondary).text, "сейчас jarvis")

    def test_legacy_dump_without_keyterms_is_accepted(self):
        from backend.tools.dual_dump import load_dump

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.json"
            path.write_text(json.dumps({"primary_segments": [], "secondary_segments": []}))
            self.assertEqual(load_dump(path).get("keyterms") or [], [])
            self.assertIn("merged=0 words", replay(path, words=False))


if __name__ == "__main__":
    unittest.main()
