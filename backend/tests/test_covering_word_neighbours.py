"""A later decode's word that is this word's NEIGHBOUR is not its spelling.

``covering_word`` lets a later word "own" an older word's time when it
overlaps a quarter of either. Overlap says two records touch, not that
they are one word, and the shape it gets wrong is a later decode that
stretched the word's neighbour over it (the "трёх"/"в" defect of session
a9fd3fd9; the dual merge measured the same thing on "он не должен").
Every case here is Deepgram's own messages from a stand recording.
"""

from __future__ import annotations

import unittest

from backend.remote_deepgram_live import DeepgramLiveSession, word_core


def _message(is_final: bool, start: float, duration: float, words) -> dict:
    return {
        "type": "Results",
        "is_final": is_final,
        "speech_final": is_final,
        "start": start,
        "duration": duration,
        "channel": {
            "alternatives": [
                {
                    "transcript": " ".join(w for w, _a, _b in words),
                    "words": [
                        {"word": w, "punctuated_word": w, "start": a, "end": b}
                        for w, a, b in words
                    ],
                }
            ]
        },
    }


def _words(session: DeepgramLiveSession) -> list[str]:
    return [
        str(w["word"])
        for seg in session._finalized_segments
        for w in seg.get("words") or []
    ]


class StretchedNeighbourTests(unittest.TestCase):
    """2026-09-03 23:49:57, ``multi``: the interim heard "text lab"
    (28.45-29.17, 29.49-29.73); the final kept "text." and stretched it
    to 29.81 over "lab". The full-pass transcript saved with that
    recording reads "inside my text lab de la capitale" — "lab" was
    spoken, and the final's "text." is the interim's "text", not a
    spelling of "lab"."""

    def _session(self) -> DeepgramLiveSession:
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(_message(False, 26.85, 1.05, [
            ("Inside", 27.01, 27.57), ("my", 27.57, 27.73)]))
        s._process_deepgram_message(_message(False, 26.85, 2.05, [
            ("Inside", 27.01, 27.57), ("my", 27.57, 28.21), ("text.", 28.37, 28.85)]))
        s._process_deepgram_message(_message(False, 26.85, 3.05, [
            ("Inside", 27.01, 27.57), ("my", 27.57, 28.29), ("text", 28.45, 29.17),
            ("lab", 29.49, 29.73)]))
        s._process_deepgram_message(_message(False, 26.85, 4.05, [
            ("Inside", 27.01, 27.57), ("my", 27.57, 28.29), ("text.", 28.45, 29.81)]))
        s._process_deepgram_message(_message(True, 26.85, 4.10, [
            ("Inside", 27.01, 27.57), ("my", 27.57, 28.29), ("text.", 28.45, 29.81)]))
        return s

    def test_the_stretched_neighbour_does_not_overrule_the_word(self):
        s = self._session()
        self.assertEqual(
            [word_core(w) for w in s._orphan_interim_words + s._interim_words],
            ["lab"],
        )
        self.assertEqual(s._overruled_total, 0)

    def test_the_word_reaches_the_transcript_without_internal_stamps(self):
        s = self._session()
        self.assertEqual(s._splice_uncovered_interim_words(), 1)
        self.assertEqual(
            [word_core({"word": w}) for w in _words(s)],
            ["inside", "my", "text", "lab"],
        )
        for seg in s._finalized_segments:
            for w in seg.get("words") or []:
                self.assertFalse(
                    [k for k in w if str(k).startswith("_")], w,
                )


class ReTimedWordBesideStretchedNeighbourTests(unittest.TestCase):
    """2026-11-23 ``20261123-173438``, ``multi``: one hypothesis read
    "песню" 1.28-1.68 "в" 1.68-1.76, the next stretched "песню" to 1.76
    and moved "в" to 1.76-1.84. The two "в" do not overlap at all, so
    identity cannot pair them; ORDER does — the newer "в" is the word on
    the old one's side of its neighbour — and the reading has one "в"."""

    def test_one_word_stands_in_the_slot(self):
        s = DeepgramLiveSession(api_key="k")
        s._process_deepgram_message(_message(False, 0.0, 1.0, [("Maybe", 0.08, 0.64)]))
        s._process_deepgram_message(_message(False, 0.0, 2.0, [
            ("Найди", 0.16, 0.88), ("эту", 0.88, 1.28), ("песню", 1.28, 1.68),
            ("в", 1.68, 1.76)]))
        s._process_deepgram_message(_message(False, 0.0, 4.1, [
            ("Найди", 0.16, 0.88), ("эту", 0.88, 1.28), ("песню", 1.28, 1.76),
            ("в", 1.76, 1.84), ("интернете,", 1.84, 2.32), ("скачайте", 2.32, 2.72)]))
        standing = [word_core(w) for w in s._standing_hypothesis_words()]
        self.assertEqual(
            standing, ["найди", "эту", "песню", "в", "интернете", "скачайте"],
        )


if __name__ == "__main__":
    unittest.main()
