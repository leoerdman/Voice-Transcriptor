"""The case of a word placed into a transcript it was not read in
(``backend.word_case``)."""

from __future__ import annotations

import unittest

from backend.word_case import (
    capital_is_lexical,
    cased_for_place,
    ends_sentence,
    has_own_casing,
    lexical_names,
    starts_sentence,
    without_trailing_marks,
)


class SentenceBoundaryTests(unittest.TestCase):
    def test_sentence_ending_marks(self):
        for token in ("сервер.", "да?", "стоп!", "ну…", "сказал.»", "(так.)"):
            self.assertTrue(ends_sentence(token), token)
        for token in ("сервер,", "деплой", "так:", "", None):
            self.assertFalse(ends_sentence(token), token)

    def test_the_start_of_the_text_is_a_sentence_start(self):
        self.assertTrue(starts_sentence(None))
        self.assertTrue(starts_sentence("сервер."))
        self.assertFalse(starts_sentence("деплой"))


class CaseByPlaceTests(unittest.TestCase):
    def test_mid_sentence_without_evidence_is_lower_case(self):
        self.assertEqual(cased_for_place("Же", sentence_start=False, lexical=False), "же")

    def test_sentence_start_is_capitalised(self):
        self.assertEqual(cased_for_place("возможно,", sentence_start=True, lexical=False), "Возможно,")
        self.assertEqual(cased_for_place("«так", sentence_start=True, lexical=False), "«Так")

    def test_a_lexical_capital_stays_mid_sentence(self):
        self.assertEqual(cased_for_place("Claude", sentence_start=False, lexical=True), "Claude")

    def test_own_casing_is_never_touched(self):
        for token in ("API", "DeepGram", "iPhone"):
            self.assertTrue(has_own_casing(token))
            self.assertEqual(cased_for_place(token, sentence_start=False, lexical=False), token)
            self.assertEqual(cased_for_place(token, sentence_start=True, lexical=False), token)
        self.assertFalse(has_own_casing("По-хорошему"))

    def test_tokens_without_letters_are_left_alone(self):
        self.assertEqual(cased_for_place("1.", sentence_start=True, lexical=False), "1.")


class LexicalCapitalTests(unittest.TestCase):
    def test_a_capital_away_from_a_start_in_any_reading_is_a_name(self):
        self.assertTrue(capital_is_lexical([("Claude", True), ("Клод", False)]))
        # A transliteration in lower case is another spelling: no veto.
        self.assertTrue(capital_is_lexical([("Claude", False), ("клод", False)]))

    def test_capitals_every_reading_owes_to_position_are_no_name(self):
        self.assertFalse(capital_is_lexical([("Claude", True), ("Клод", True)]))
        self.assertFalse(capital_is_lexical([("Же", True), ("же,", False)]))

    def test_the_same_spelling_in_lower_case_overrules_the_capital(self):
        self.assertFalse(capital_is_lexical([("Же", False), ("же,", False)]))

    def test_one_reading_counts_only_away_from_a_sentence_start(self):
        self.assertTrue(capital_is_lexical([("Deepgram", False)]))
        self.assertFalse(capital_is_lexical([("Потерял,", True)]))
        self.assertFalse(capital_is_lexical([]))


class KeytermNameTests(unittest.TestCase):
    """The names among the keyterms a reading was decoded with
    (``lexical_names``). Keyterms are the owner's own list in Settings
    and the self-filling vocabulary, as they stood on 2026-11-23."""

    KEYTERMS = (
        "Sonnet", "Opus", "Claude", "Windows", "субагент", "single source of truth",
        "SSOT", "worktree", "коммит", "Транскриптор", "Claude Code", "Leo Erdman",
        "Лео Эрдман", "M-Code", "Пронина",
    )

    def test_capitalised_keyterms_are_names(self):
        names = lexical_names(self.KEYTERMS)
        for word in ("Claude", "Opus,", "Windows.", "Code", "Erdman", "Эрдман", "Пронина"):
            self.assertTrue(capital_is_lexical([(word, True)], names), word)

    def test_lower_case_keyterms_say_nothing(self):
        # "коммит", "worktree" and "single source of truth" were written
        # in lower case: a capital on them at a start stays positional.
        names = lexical_names(self.KEYTERMS)
        for word in ("Коммит", "Worktree", "Single", "Source", "Субагент"):
            self.assertFalse(capital_is_lexical([(word, True)], names), word)

    def test_a_sentence_cased_phrase_does_not_make_its_first_word_a_name(self):
        names = lexical_names(["Single source of truth", "заявка на Opus"])
        self.assertFalse(capital_is_lexical([("Single", True)], names))
        self.assertTrue(capital_is_lexical([("Opus", True)], names))
        self.assertFalse(capital_is_lexical([("Заявка", True)], names))

    def test_an_inflected_name_is_the_name(self):
        names = lexical_names(self.KEYTERMS)
        self.assertTrue(capital_is_lexical([("Транскриптора", True)], names))
        self.assertTrue(capital_is_lexical([("Пронину,", True)], names))

    def test_a_name_never_overrules_the_same_spelling_in_lower_case(self):
        # Two decodes of one spelling that disagree on its case are not a
        # name — whatever the vocabulary says ("Hub" / "hub").
        names = lexical_names(["Hub"])
        self.assertFalse(capital_is_lexical([("Hub", True), ("hub", False)], names))

    def test_without_keyterms_a_capital_at_a_start_stays_positional(self):
        # Negative control: the rule before the vocabulary joined it.
        self.assertFalse(capital_is_lexical([("Claude", True)]))
        self.assertFalse(capital_is_lexical([("Claude", True)], lexical_names(())))


class TrailingMarksTests(unittest.TestCase):
    def test_marks_are_stripped(self):
        self.assertEqual(without_trailing_marks("деплой."), "деплой")
        self.assertEqual(without_trailing_marks("потерял,"), "потерял")
        self.assertEqual(without_trailing_marks("..."), "...")


if __name__ == "__main__":
    unittest.main()
