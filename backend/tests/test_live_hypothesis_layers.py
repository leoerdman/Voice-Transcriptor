"""One stretch of audio, several interim spellings: only one may reach
the text.

Real Deepgram messages of the owner's take ``20261123-191519``
(2026-11-23, nova-3, the app's 68 keyterms, hints ru+en), captured
from both live readings of the dual mode and replayed offline through
the shipped ``DeepgramLiveSession`` and ``merge_readings``. Live, the
user got "Так таката это тестова тестовой речь. Речки … в 1 вход?
Ход?": ``multi``'s three rolling re-decodes of 0.96-3.68 s
("Таката тестова", "Tak atatestomoje riečiai aš atdavariu", "Так это
тестовой речки я сейчас говорю говорю очень") all survived in the
orphan pool, its final there came back empty, and the splice placed
every spelling; ``ru``'s "вход?" re-decoded as "ход?" did the same.
"""

import json
import unittest
from pathlib import Path

from backend.deepgram_dual import merge_readings
from backend.remote_deepgram_live import (
    DeepgramLiveConfig,
    DeepgramLiveSession,
    covering_word,
    segment_words,
)

_FIXTURE = Path(__file__).parent / "fixtures" / "deepgram_live_20261123_191519.json"


def _readings() -> dict[str, list[dict]]:
    sessions: dict[str, DeepgramLiveSession] = {}
    for m in json.loads(_FIXTURE.read_text(encoding="utf-8")):
        reading = m["reading"]
        session = sessions.setdefault(
            reading,
            DeepgramLiveSession(api_key="k", config=DeepgramLiveConfig(language=reading)),
        )
        session._process_deepgram_message({
            "type": "Results",
            "is_final": m["is_final"],
            "speech_final": m["speech_final"],
            "start": m["start"],
            "duration": m["duration"],
            "channel": {"alternatives": [{"transcript": m["transcript"], "words": m["words"]}]},
        })
    out = {}
    for reading, session in sessions.items():
        session._splice_uncovered_interim_words()
        out[reading] = session._finalized_segments
    return out


def _words(segments: list[dict]) -> list[dict]:
    return [w for seg in segments for w in segment_words(seg)]


def _places(words: list[dict]) -> int:
    """How many distinct places of the audio these words occupy: a word
    another one already covers (``covering_word``) is the same place."""
    seen: list[dict] = []
    for w in sorted(words, key=lambda w: (w["start"], w["end"])):
        if covering_word(w, seen) is None:
            seen.append(w)
    return len(seen)


def _norm(words: list[dict]) -> list[str]:
    return [str(w["word"]).strip(",.?!").lower() for w in words]


class HypothesisLayersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.readings = _readings()
        cls.merged = merge_readings(
            cls.readings["multi"],
            cls.readings["ru"],
            primary_language="multi",
            secondary_language="ru",
            expected_languages=["ru", "en"],
        )

    def test_no_reading_holds_two_words_of_one_place(self):
        for reading, segments in self.readings.items():
            words = _words(segments)
            for i, w in enumerate(words):
                others = words[:i] + words[i + 1:]
                self.assertIsNone(
                    covering_word(w, others),
                    f"{reading}: {w['word']!r} {w['start']}-{w['end']} shares its place",
                )

    def test_multi_keeps_only_its_newest_spelling(self):
        multi = _norm(_words(self.readings["multi"]))
        self.assertEqual(
            multi[:9],
            ["так", "это", "тестовой", "речки", "я", "сейчас", "говорю", "говорю", "очень"],
        )

    def test_the_merge_is_no_longer_than_the_places_both_readings_heard(self):
        union = _words(self.readings["multi"]) + _words(self.readings["ru"])
        self.assertLessEqual(len(self.merged.words), _places(union))

    def test_merged_text_has_one_spelling_per_place(self):
        merged = _norm(self.merged.words)
        joined = " ".join(merged)
        self.assertIn("так это тестовая речь я сейчас говорю говорю очень", joined)
        self.assertIn("в 1 ход ну она и так", joined)
        # "быстро" re-read by the next window's interim at the final
        # boundary (4.16 s) is the same spoken word, not a second one.
        self.assertEqual(merged.count("быстро"), 1)
        for gone in ("таката", "тестова", "тестовой", "речки", "вход"):
            self.assertNotIn(gone, merged)
        # Said twice (the REST re-decode of 9.5-11.2 s alone hears the
        # phrase again; a full-file REST pass skips it): both stay.
        self.assertEqual(joined.count("вдвоем говорить"), 2)


if __name__ == "__main__":
    unittest.main()
