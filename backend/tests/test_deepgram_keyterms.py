"""Tests for backend.deepgram_keyterms — Nova-3 Keyterm Prompting SSOT.

Covers term normalisation (separators, whitespace, dedupe, casing), the
500-token conservative cap, model-family gating (``keyterms_supported``),
and that the live query builder emits one repeated ``keyterm=`` pair per
term while never dropping any key the pre-keyterms suite
(``test_deepgram_format_ssot.py``) already pins.
"""

from __future__ import annotations

import unittest
from urllib.parse import parse_qs, parse_qsl

from backend.config import DEFAULT_CONFIG, _validate_config_shape
from backend.deepgram_keyterms import (
    MAX_KEYTERM_TOKENS,
    auto_keyterms_blocked,
    auto_keyterms_enabled,
    configured_keyterms,
    configured_merge,
    keyterm_query_pairs,
    keyterm_token_cost,
    keyterms_supported,
    merge_keyterms,
    normalize_auto_keyterms_blocked,
    normalize_keyterms,
)
from backend.remote_deepgram_live import DeepgramLiveConfig

# Every key the live query string carried before keyterms existed
# (base params ``to_query_string`` has always emitted, plus the shared
# formatting keys pinned by test_deepgram_format_ssot.SHARED_KEYS).
BASE_LIVE_KEYS = (
    "model", "encoding", "sample_rate", "channels", "interim_results",
    "smart_format", "punctuate", "filler_words",
    "endpointing", "utterance_end_ms", "language",
)


class NormalizeKeytermsTests(unittest.TestCase):
    def test_comma_separated(self):
        self.assertEqual(
            normalize_keyterms("Sonnet, Opus, Claude"), ("Sonnet", "Opus", "Claude")
        )

    def test_newline_separated(self):
        self.assertEqual(
            normalize_keyterms("Sonnet\nOpus\nClaude"), ("Sonnet", "Opus", "Claude")
        )

    def test_mixed_separators_and_whitespace(self):
        raw = "  Sonnet ,\nOpus\n , Claude  \n\n Deepgram "
        self.assertEqual(
            normalize_keyterms(raw), ("Sonnet", "Opus", "Claude", "Deepgram")
        )

    def test_empty_pieces_dropped(self):
        self.assertEqual(normalize_keyterms("Sonnet,,  ,\n\nOpus"), ("Sonnet", "Opus"))

    def test_duplicates_removed_case_insensitively_keeping_first_spelling(self):
        self.assertEqual(
            normalize_keyterms("Sonnet, sonnet, SONNET, Opus"), ("Sonnet", "Opus")
        )

    def test_empty_and_non_string_input(self):
        self.assertEqual(normalize_keyterms(""), ())
        self.assertEqual(normalize_keyterms(None), ())  # type: ignore[arg-type]

    def test_order_preserved(self):
        self.assertEqual(normalize_keyterms("z, a, m"), ("z", "a", "m"))


class TokenCapTests(unittest.TestCase):
    def test_within_budget_keeps_everything(self):
        terms = ", ".join(f"term{i}" for i in range(50))
        result = normalize_keyterms(terms)
        self.assertEqual(len(result), 50)

    def test_over_budget_truncates_and_keeps_original_order_prefix(self):
        # Each term is one word -> ceil(1 * 1.3) = 2 estimated tokens;
        # a 500-token budget fits at most 250 single-word terms.
        many = ", ".join(f"term{i}" for i in range(400))
        result = normalize_keyterms(many)
        self.assertLess(len(result), 400)
        self.assertEqual(result, tuple(f"term{i}" for i in range(len(result))))

    def test_a_pathologically_long_single_term_is_dropped_not_truncated(self):
        huge_term = " ".join(f"w{i}" for i in range(1000))
        self.assertEqual(normalize_keyterms(huge_term), ())


class KeytermsSupportedTests(unittest.TestCase):
    def test_nova3_supported(self):
        self.assertTrue(keyterms_supported("nova-3"))
        self.assertTrue(keyterms_supported("Nova-3"))

    def test_nova2_not_supported(self):
        self.assertFalse(keyterms_supported("nova-2"))

    def test_empty_or_none_not_supported(self):
        self.assertFalse(keyterms_supported(""))
        self.assertFalse(keyterms_supported(None))  # type: ignore[arg-type]


class KeytermQueryPairsTests(unittest.TestCase):
    def test_pairs_for_supported_model(self):
        pairs = keyterm_query_pairs(("Sonnet", "Opus"), "nova-3")
        self.assertEqual(pairs, [("keyterm", "Sonnet"), ("keyterm", "Opus")])

    def test_empty_for_unsupported_model(self):
        self.assertEqual(keyterm_query_pairs(("Sonnet",), "nova-2"), [])

    def test_empty_for_no_terms(self):
        self.assertEqual(keyterm_query_pairs((), "nova-3"), [])


class LiveConfigKeytermQueryStringTests(unittest.TestCase):
    def test_repeated_keyterm_pairs_present_for_nova3(self):
        cfg = DeepgramLiveConfig(model="nova-3", keyterms=("Sonnet", "Opus", "Claude"))
        pairs = parse_qsl(cfg.to_query_string())
        keyterm_values = [v for k, v in pairs if k == "keyterm"]
        self.assertEqual(keyterm_values, ["Sonnet", "Opus", "Claude"])

    def test_no_keyterm_pairs_for_non_nova3_model(self):
        cfg = DeepgramLiveConfig(model="nova-2", keyterms=("Sonnet", "Opus"))
        pairs = parse_qsl(cfg.to_query_string())
        self.assertNotIn("keyterm", [k for k, _ in pairs])

    def test_no_keyterm_pairs_when_no_terms_configured(self):
        cfg = DeepgramLiveConfig(model="nova-3")
        pairs = parse_qsl(cfg.to_query_string())
        self.assertNotIn("keyterm", [k for k, _ in pairs])

    def test_every_previously_emitted_key_still_present(self):
        # Pins the query string against the pre-keyterms shape (see
        # test_deepgram_format_ssot.py) so adding keyterms can never
        # silently drop an existing parameter.
        cfg = DeepgramLiveConfig(model="nova-3", keyterms=("Sonnet",))
        params = parse_qs(cfg.to_query_string())
        for key in BASE_LIVE_KEYS:
            self.assertIn(key, params, f"missing pre-existing key {key!r}")

    def test_language_multi_branch_unaffected_by_keyterms(self):
        cfg = DeepgramLiveConfig(model="nova-3", language="auto", keyterms=("Sonnet",))
        params = {k: v[0] for k, v in parse_qs(cfg.to_query_string()).items()}
        self.assertEqual(params["language"], "multi")


class ConfiguredKeytermsTests(unittest.TestCase):
    def test_missing_preferences_block_returns_empty(self):
        self.assertEqual(configured_keyterms({}), ())

    def test_missing_deepgram_block_returns_empty(self):
        self.assertEqual(configured_keyterms({"preferences": {}}), ())

    def test_non_dict_cfg_returns_empty(self):
        self.assertEqual(configured_keyterms("not-a-dict"), ())  # type: ignore[arg-type]
        self.assertEqual(configured_keyterms(None), ())  # type: ignore[arg-type]

    def test_non_dict_preferences_or_deepgram_block_returns_empty(self):
        self.assertEqual(configured_keyterms({"preferences": "oops"}), ())
        self.assertEqual(
            configured_keyterms({"preferences": {"deepgram": "oops"}}), ()
        )

    def test_string_value_is_normalised(self):
        cfg = {"preferences": {"deepgram": {"keyterms": "Sonnet, sonnet,  Opus "}}}
        self.assertEqual(configured_keyterms(cfg), ("Sonnet", "Opus"))


class ConfigDefaultAndValidationTests(unittest.TestCase):
    def test_default_config_has_empty_keyterms(self):
        self.assertEqual(DEFAULT_CONFIG["preferences"]["deepgram"]["keyterms"], "")

    def test_non_string_keyterms_value_resets_to_empty(self):
        fixed = _validate_config_shape(
            {"preferences": {"deepgram": {"keyterms": 12345}}}
        )
        self.assertEqual(fixed["preferences"]["deepgram"]["keyterms"], "")

    def test_non_dict_deepgram_block_resets_to_default(self):
        # Reads the defaults rather than restating them: this block has
        # grown a second setting (dual_stream) and will grow more, and a
        # test that lists them by hand only ever fails for that.
        from backend.config import DEFAULT_CONFIG

        fixed = _validate_config_shape({"preferences": {"deepgram": "oops-a-string"}})
        self.assertEqual(
            fixed["preferences"]["deepgram"],
            DEFAULT_CONFIG["preferences"]["deepgram"],
        )
        self.assertEqual(fixed["preferences"]["deepgram"]["keyterms"], "")



def _cfg(**deepgram) -> dict:
    return {"preferences": {"deepgram": deepgram}}


class MergeWithTheSelfFillingVocabularyTests(unittest.TestCase):
    """The owner's list first and whole; automatic terms only in what
    the shared budget has left."""

    def test_the_manual_list_goes_first_then_automatic_terms(self):
        merged = merge_keyterms(("Sonnet", "Opus"), ("Deepgram", "MacBook"))
        self.assertEqual(merged.terms, ("Sonnet", "Opus", "Deepgram", "MacBook"))
        self.assertEqual(merged.manual, ("Sonnet", "Opus"))
        self.assertEqual(merged.auto, ("Deepgram", "MacBook"))
        self.assertEqual(
            merged.tokens_used,
            sum(keyterm_token_cost(t) for t in merged.terms),
        )

    def test_automatic_terms_stop_at_the_budget_and_never_displace_manual_ones(self):
        manual = tuple(f"manual{i}" for i in range(200))  # 2 tokens each
        auto = tuple(f"auto{i}" for i in range(100))
        merged = merge_keyterms(manual, auto)
        self.assertEqual(merged.manual, manual)
        self.assertLessEqual(merged.tokens_used, MAX_KEYTERM_TOKENS)
        self.assertEqual(len(merged.auto), (MAX_KEYTERM_TOKENS - 400) // 2)
        self.assertEqual(merged.auto_over_budget, auto[len(merged.auto):])

    def test_a_removed_term_is_not_sent_whatever_its_casing(self):
        merged = merge_keyterms((), ("Deepgram", "MacBook"), blocked=("deepgram",))
        self.assertEqual(merged.terms, ("MacBook",))

    def test_a_term_already_in_the_manual_list_is_not_sent_twice(self):
        merged = merge_keyterms(("claude",), ("Claude", "Opus"))
        self.assertEqual(merged.terms, ("claude", "Opus"))
        self.assertEqual(merged.auto, ("Opus",))

    def test_configured_keyterms_adds_automatic_terms_by_default(self):
        self.assertEqual(
            configured_keyterms(_cfg(keyterms="Sonnet"), ("Deepgram",)),
            ("Sonnet", "Deepgram"),
        )

    def test_switched_off_only_the_manual_list_is_sent(self):
        cfg = _cfg(keyterms="Sonnet", auto_keyterms=False)
        self.assertFalse(auto_keyterms_enabled(cfg))
        self.assertEqual(configured_keyterms(cfg, ("Deepgram",)), ("Sonnet",))
        # ...while the Settings panel can still show what it WOULD send.
        self.assertEqual(
            configured_merge(cfg, ("Deepgram",), assume_enabled=True).auto,
            ("Deepgram",),
        )

    def test_the_stored_removal_list_is_applied(self):
        cfg = _cfg(keyterms="", auto_keyterms_blocked=["Deepgram"])
        self.assertEqual(configured_keyterms(cfg, ("Deepgram", "Opus")), ("Opus",))

    def test_the_removal_list_is_normalised(self):
        self.assertEqual(
            normalize_auto_keyterms_blocked([" Deepgram ", "deepgram", 3, "", "Opus"]),
            ["Deepgram", "Opus"],
        )
        self.assertEqual(auto_keyterms_blocked(_cfg(auto_keyterms_blocked="oops")), ())

    def test_the_config_repairs_malformed_automatic_settings(self):
        fixed = _validate_config_shape(
            {"preferences": {"deepgram": {
                "auto_keyterms": "yes",
                "auto_keyterms_blocked": ["Opus", 7, "opus", "Claude"],
            }}}
        )
        dg = fixed["preferences"]["deepgram"]
        self.assertIs(dg["auto_keyterms"], DEFAULT_CONFIG["preferences"]["deepgram"]["auto_keyterms"])
        self.assertEqual(dg["auto_keyterms_blocked"], ["Opus", "Claude"])

    def test_the_feature_defaults_on_with_nothing_removed(self):
        dg = DEFAULT_CONFIG["preferences"]["deepgram"]
        self.assertIs(dg["auto_keyterms"], True)
        self.assertEqual(dg["auto_keyterms_blocked"], [])


if __name__ == "__main__":
    unittest.main()
