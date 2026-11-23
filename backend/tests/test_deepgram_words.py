"""Reading a word out of a Deepgram response is one decision, made once.

Deepgram returns both spellings for every word:

    {"word": "четыре", "punctuated_word": "Четыре,", ...}

``punctuated_word`` is the same token after the ``smart_format`` /
``punctuate`` options we request have applied capitalisation and
punctuation. The two providers disagreed about which to prefer:

    remote_deepgram.py       punctuated_word or word     correct
    remote_deepgram_live.py  word or punctuated_word     backwards

The live form was not a fallback chain at all — ``word`` is populated on
every word Deepgram returns, so ``punctuated_word`` was unreachable.

It mattered on the path that exists to improve quality: the live
provider keeps interim words so `_splice_uncovered_interim_words` can
fold back speech no final ever covered (43 such repairs across the
shipped logs), and every rescued word entered the transcript raw —
unpunctuated, uncapitalised — inside otherwise punctuated prose.
"""

import unittest

from backend.deepgram_words import deepgram_word_text


class DeepgramWordTextTests(unittest.TestCase):
    def test_the_punctuated_spelling_wins(self) -> None:
        # The regression: `word` is always present, so a `word`-first
        # chain made the formatted spelling unreachable.
        self.assertEqual(
            deepgram_word_text({"word": "четыре", "punctuated_word": "Четыре,"}),
            "Четыре,",
        )

    def test_raw_word_is_the_fallback_when_formatting_is_absent(self) -> None:
        # smart_format/punctuate disabled, or a provider-side shape change.
        self.assertEqual(deepgram_word_text({"word": "четыре"}), "четыре")

    def test_an_empty_punctuated_field_is_a_token_the_formatter_folded(self) -> None:
        # Real ``ru`` response, take 20261123-145412: smart_format folds
        # "все" into the next token's "все-таки" and leaves it empty.
        self.assertEqual(
            deepgram_word_text({"word": "все", "punctuated_word": ""}), ""
        )
        self.assertEqual(
            deepgram_word_text({"word": "-таки", "punctuated_word": "все-таки"}),
            "все-таки",
        )
        self.assertEqual(
            deepgram_word_text({"word": "четыре", "punctuated_word": "   "}), ""
        )

    def test_surrounding_whitespace_is_trimmed(self) -> None:
        self.assertEqual(
            deepgram_word_text({"punctuated_word": "  Да.  "}), "Да."
        )
        self.assertEqual(deepgram_word_text({"word": "\tда\n"}), "да")

    def test_a_word_with_no_usable_spelling_yields_empty(self) -> None:
        # Callers skip falsy tokens, so "" is the contract for "nothing
        # here" — never None, never a placeholder.
        self.assertEqual(deepgram_word_text({}), "")
        self.assertEqual(deepgram_word_text({"word": "", "punctuated_word": ""}), "")
        self.assertEqual(deepgram_word_text({"word": None}), "")

    def test_non_mapping_input_yields_empty_instead_of_raising(self) -> None:
        # Both call sites iterate a list that came off the wire; a
        # malformed element must not take down the transcript.
        for bad in (None, "четыре", 42, ["четыре"]):
            with self.subTest(value=bad):
                self.assertEqual(deepgram_word_text(bad), "")

    def test_non_string_spellings_are_ignored(self) -> None:
        self.assertEqual(deepgram_word_text({"punctuated_word": 5, "word": "пять"}), "пять")
        self.assertEqual(deepgram_word_text({"punctuated_word": 5, "word": 5}), "")


class ProviderAgreementTests(unittest.TestCase):
    def test_both_providers_read_words_through_this_module(self) -> None:
        # The point of the module: one precedence, not two. If either
        # provider grows its own extraction again this fails.
        import backend.remote_deepgram as batch
        import backend.remote_deepgram_live as live

        self.assertIs(batch.deepgram_word_text, deepgram_word_text)
        self.assertIs(live.deepgram_word_text, deepgram_word_text)


if __name__ == "__main__":
    unittest.main()
