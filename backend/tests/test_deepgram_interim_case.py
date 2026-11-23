"""Case and punctuation of interim words the live splice puts into the
finals (``backend.word_case`` through ``splice_words_into_segments``).

An interim hypothesis is formatted as a text of its own: Deepgram
capitalises its first word and closes its last one by POSITION. When the
finalize splice puts such a word into the transcript, those marks
described the hypothesis, not the transcript — "…деплой Потерял,
Посмотри" (measured 2026-11-23 on the recovery path, which inserts
re-decoded words through the same splice). One rule decides both for
every inserted word; these tests pin it on the single-stream interim
path.
"""

from __future__ import annotations

import unittest

from backend.remote_deepgram_live import DeepgramLiveSession


def _words(words: list[tuple[str, float, float]]) -> list[dict]:
    return [
        {"word": w.strip(",.!?").lower(), "punctuated_word": w, "start": a, "end": b}
        for w, a, b in words
    ]


def _results(words: list[tuple[str, float, float]], *, final: bool) -> dict:
    start, end = words[0][1] - 0.05, words[-1][2] + 0.05
    return {
        "type": "Results",
        "is_final": final,
        "speech_final": final,
        "start": start,
        "duration": end - start,
        "channel": {
            "alternatives": [
                {"transcript": " ".join(w for w, _a, _b in words), "words": _words(words)}
            ]
        },
    }


class InterimWordCaseTests(unittest.TestCase):
    def _transcript(self, *messages: tuple[str, list[tuple[str, float, float]]]) -> str:
        session = DeepgramLiveSession(api_key="k")
        for kind, words in messages:
            session._process_deepgram_message(_results(words, final=kind == "final"))
        session._splice_uncovered_interim_words()
        return " ".join(
            str(seg.get("text") or "") for seg in session._finalized_segments
        )

    def test_positional_capital_and_cut_mark_of_an_interim_are_dropped(self):
        # The interim heard one word no final carried; it opened that
        # hypothesis ("Потерял,"), and the next final opened with
        # "Посмотри,". Mid-sentence in the transcript, both are lower-case,
        # and the comma that closed the hypothesis goes.
        text = self._transcript(
            ("final", [("Я", 0.0, 0.2), ("проверил", 0.3, 0.8), ("деплой", 0.9, 1.4)]),
            ("interim", [("Потерял,", 1.8, 2.1)]),
            ("final", [("Посмотри,", 2.5, 2.9), ("что", 3.0, 3.2), ("там.", 3.3, 3.6)]),
        )
        self.assertEqual(text, "Я проверил деплой потерял посмотри, что там.")

    def test_names_keep_their_capital_and_abbreviations_their_casing(self):
        # "Claude" and "Deepgram" were capitalised mid-hypothesis — that is
        # the word's own capital. "API" opened its hypothesis, but casing
        # beyond a leading capital is never re-decided.
        text = self._transcript(
            ("final", [("Я", 0.0, 0.2), ("спросил", 0.3, 0.8)]),
            ("interim", [("спросил", 0.3, 0.8), ("Claude", 1.2, 1.5)]),
            ("final", [("про", 1.9, 2.1)]),
            ("interim", [("про", 1.9, 2.1), ("Deepgram", 2.6, 2.9)]),
            ("interim", [("API", 3.3, 3.6)]),
            ("final", [("ключ.", 4.0, 4.4)]),
        )
        self.assertEqual(text, "Я спросил Claude про Deepgram API ключ.")

    def test_an_interim_word_at_a_sentence_start_is_capitalised(self):
        # Read mid-hypothesis in lower case; in the transcript it follows
        # a sentence end.
        text = self._transcript(
            ("interim", [("так", 0.0, 0.3), ("что", 0.4, 0.6), ("потом", 1.0, 1.3)]),
            ("final", [("Так", 0.0, 0.3), ("что.", 0.4, 0.6)]),
            ("final", [("Сделаем", 1.7, 2.1), ("это.", 2.2, 2.5)]),
        )
        self.assertEqual(text, "Так что. Потом сделаем это.")

    def test_marks_inside_a_hypothesis_stay_and_the_last_word_keeps_them_at_the_end(self):
        # The comma between two words of one hypothesis is the decoder's
        # reading of a real boundary; the period of a hypothesis that
        # ends the whole transcript is where the speaker stopped.
        text = self._transcript(
            ("final", [("Я", 0.0, 0.2), ("проверил", 0.3, 0.8)]),
            ("interim", [("Потерял,", 1.2, 1.5), ("посмотрю.", 1.7, 2.0)]),
        )
        self.assertEqual(text, "Я проверил потерял, посмотрю.")


if __name__ == "__main__":
    unittest.main()
