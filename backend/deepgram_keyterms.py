"""SSOT for Deepgram Nova-3 Keyterm Prompting — one parser, one query
builder, shared by both Deepgram paths (live WebSocket and prerecorded
REST).

Why this exists
----------------
2026-09-03 measurement (see ``docs/archive/BUGS_AUDIT_2026-09-03.md`` §1, and
``backend/tools/deepgram_live_ab.py`` — the tool that reproduces it): on
this app's own saved Russian recordings, Deepgram nova-3's
``language=multi`` mode — what "auto" maps to in
``backend.remote_deepgram_live`` — silently dropped whole clauses and
was non-deterministic between repeat runs on the SAME audio.
``language=ru`` on the same files kept every clause, byte-identical
across repeat runs. What the product does about it — Auto runs ``multi``
AND a monolingual second reading, merged at stop — is owned by
``backend.deepgram_dual``; this module only serves the monolingual
readings that measurement made part of every Auto recording.

The cost of a monolingual reading is that Deepgram
transliterates English product names phonetically instead of keeping
them in Latin script — "Sonnet" comes back "санет", "Opus" comes back
"опус", instead of the brand name. Nova-3 Keyterm Prompting
(``keyterm=<term>``, repeated once per term) is Deepgram's documented
mechanism for biasing recognition toward a vocabulary list on that reading. This module is
the one place both Deepgram paths build that list from, so a term added
once — in the user's config — reaches live streaming and prerecorded
REST identically instead of drifting into two independent
implementations, which is exactly how ``smart_format`` came to disagree
between the two paths (see ``backend.deepgram_format``).

Deepgram facts this module encodes:
  * the query parameter is ``keyterm``, repeated once per term — NOT a
    single comma-joined value;
  * Nova-3 model family only (model id starts with ``"nova-3"``);
    every other model rejects the parameter;
  * available on both the streaming and the prerecorded endpoint;
  * a combined limit of 500 tokens across all keyterms in one request.

Deepgram does not publish the tokenizer used to count that 500-token
limit, so this module approximates conservatively rather than exactly:
each term's whitespace-separated word count is multiplied by
``TOKENS_PER_WORD_ESTIMATE`` (rounded up) to estimate its token cost.
The factor is set above 1 because sub-word tokenizers commonly split a
single word into more than one token; undercounting risks a request
Deepgram silently truncates or rejects, while overcounting only means
keyterms are trimmed a little earlier than the server would actually
have required. Terms are truncated to fit, in the user's original
order, so a long pasted vocabulary list yields "the first N terms that
fit" plus a logged warning, rather than a failed transcription.

The budget is shared with the self-filling vocabulary
(``backend.auto_keyterms``): ``merge_keyterms`` sends the owner's list
first and whole, then the mined terms while the same estimate has room,
minus the ones the owner removed (``preferences.deepgram.
auto_keyterms_blocked``). ``configured_keyterms`` is the one call every
Deepgram request builder makes.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Mapping, Sequence

logger = logging.getLogger(__name__)

#: Deepgram's documented combined keyterm-token limit per request.
MAX_KEYTERM_TOKENS = 500

#: Conservative words-to-tokens estimate used to enforce the limit
#: without access to Deepgram's actual tokenizer. See module docstring.
TOKENS_PER_WORD_ESTIMATE = 1.3


def keyterm_token_cost(term: str) -> int:
    """Conservative token-cost estimate for one keyterm.

    The ONE place a keyterm's cost is counted: the manual list's
    truncation, the merge with the self-filling vocabulary
    (``merge_keyterms``) and the budget the Settings panel shows all
    spend the same number.
    """
    words = term.split()
    return max(1, math.ceil(len(words) * TOKENS_PER_WORD_ESTIMATE))


def parse_keyterms(raw: str) -> tuple[str, ...]:
    """Split the user's raw keyterms text into terms, WITHOUT the budget.

    Accepts commas and/or newlines as separators — mixed use is fine.
    Each term is stripped of surrounding whitespace; empty terms are
    dropped. Order is preserved, and duplicates are removed
    case-insensitively while keeping the FIRST spelling seen (so
    "Sonnet" followed later by "sonnet" keeps "Sonnet" — the
    capitalisation the user typed first).
    """
    if not raw or not isinstance(raw, str):
        return ()
    normalized_seps = raw.replace("\r\n", "\n").replace("\n", ",")
    seen: set[str] = set()
    terms: list[str] = []
    for piece in normalized_seps.split(","):
        term = piece.strip()
        if not term:
            continue
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        terms.append(term)
    return tuple(terms)


def _fit_to_budget(
    terms: Sequence[str], budget: int
) -> tuple[list[str], list[str], int]:
    """Keep *terms*, in order, while their cost fits *budget*.

    Returns ``(kept, dropped, tokens_spent)``. A term too expensive for
    what is left is skipped, not a stopping point — a cheaper one after
    it may still fit.
    """
    kept: list[str] = []
    dropped: list[str] = []
    spent = 0
    for term in terms:
        cost = keyterm_token_cost(term)
        if spent + cost > budget:
            dropped.append(term)
            continue
        kept.append(term)
        spent += cost
    return kept, dropped, spent


def normalize_keyterms(raw: str) -> tuple[str, ...]:
    """Parse the user's raw keyterms text into a clean term tuple.

    ``parse_keyterms`` plus the budget: enforces ``MAX_KEYTERM_TOKENS``
    conservatively — once the running token estimate would exceed the
    limit, the remaining terms are dropped and a warning is logged with
    the counts. Never raises — a misconfigured keyterms list must
    degrade to "fewer keyterms", not break dictation.
    """
    return tuple(_fit_manual(parse_keyterms(raw))[0])


def _fit_manual(terms: Sequence[str]) -> tuple[list[str], int]:
    """The manual list within the budget, warning about what it loses."""
    kept, dropped, spent = _fit_to_budget(terms, MAX_KEYTERM_TOKENS)
    if dropped:
        logger.warning(
            "deepgram-keyterms: dropped %d of %d term(s) — exceeded the "
            "conservative %d-token estimate; kept %d",
            len(dropped), len(terms), MAX_KEYTERM_TOKENS, len(kept),
        )
    return kept, spent


@dataclass(frozen=True)
class MergedKeyterms:
    """What one Deepgram request sends, and how the budget was spent."""

    #: Every term on the wire, manual first, in send order.
    terms: tuple[str, ...]
    #: The manual terms that are sent (all of them unless the manual list
    #: alone exceeds the budget).
    manual: tuple[str, ...]
    #: Self-filling vocabulary terms that made it into the request.
    auto: tuple[str, ...]
    #: Self-filling terms left out because the budget ran out.
    auto_over_budget: tuple[str, ...]
    #: Estimated tokens ``terms`` costs, against ``MAX_KEYTERM_TOKENS``.
    tokens_used: int
    token_budget: int = MAX_KEYTERM_TOKENS


def merge_keyterms(
    manual: Sequence[str],
    auto: Sequence[str],
    *,
    blocked: Sequence[str] = (),
) -> MergedKeyterms:
    """The owner's list, then the self-filling vocabulary, in budget.

    The manual list always goes first and whole — it is what the owner
    asked for, so an automatic term can never displace one. Automatic
    terms follow in their own rank order while ``MAX_KEYTERM_TOKENS``
    has room, minus anything the owner removed (*blocked*) and anything
    already in the manual list (compared case-insensitively, like
    ``parse_keyterms`` dedupes).
    """
    manual_kept, spent = _fit_manual(list(manual))
    taken = {term.lower() for term in manual}
    blocked_keys = {str(term).strip().lower() for term in blocked}
    candidates: list[str] = []
    for term in auto:
        key = term.strip().lower()
        if not key or key in taken or key in blocked_keys:
            continue
        taken.add(key)
        candidates.append(term.strip())
    auto_kept, auto_dropped, auto_spent = _fit_to_budget(
        candidates, MAX_KEYTERM_TOKENS - spent
    )
    return MergedKeyterms(
        terms=tuple(manual_kept) + tuple(auto_kept),
        manual=tuple(manual_kept),
        auto=tuple(auto_kept),
        auto_over_budget=tuple(auto_dropped),
        tokens_used=spent + auto_spent,
    )


def keyterms_supported(model: str) -> bool:
    """Whether Deepgram Keyterm Prompting is available for *model*.

    Deepgram scopes this feature to the Nova-3 model family. Every
    other model (nova-2, whisper, etc.) rejects the ``keyterm``
    parameter outright, so callers check this before adding it to a
    request rather than let the provider 400.
    """
    return str(model or "").strip().lower().startswith("nova-3")


def keyterm_query_pairs(
    terms: Sequence[str], model: str
) -> list[tuple[str, str]]:
    """Repeated ``("keyterm", term)`` pairs for *terms*, or ``[]``.

    Empty when *model* does not support the feature (see
    ``keyterms_supported``) or when *terms* is empty, so callers can
    call this unconditionally and extend their own param list/dict with
    the result rather than branch on support themselves.
    """
    if not terms or not keyterms_supported(model):
        return []
    return [("keyterm", term) for term in terms]


def _deepgram_prefs(cfg: Mapping) -> Mapping:
    """``preferences.deepgram`` of the app config, or ``{}``.

    Tolerant of a missing/non-dict ``preferences`` or
    ``preferences.deepgram`` block, matching ``normalize_keyterms``'s own
    "never break dictation" contract.
    """
    if not isinstance(cfg, Mapping):
        return {}
    preferences = cfg.get("preferences")
    dg_prefs = preferences.get("deepgram") if isinstance(preferences, Mapping) else None
    return dg_prefs if isinstance(dg_prefs, Mapping) else {}


#: Default of ``preferences.deepgram.auto_keyterms`` — the self-filling
#: vocabulary (``backend.auto_keyterms``) is on unless the owner turns
#: it off.
AUTO_KEYTERMS_DEFAULT = True


def auto_keyterms_enabled(cfg: Mapping) -> bool:
    """Whether the self-filling vocabulary joins the manual list."""
    value = _deepgram_prefs(cfg).get("auto_keyterms")
    return value if isinstance(value, bool) else AUTO_KEYTERMS_DEFAULT


#: Bounds on ``preferences.deepgram.auto_keyterms_blocked``: how many
#: removals are kept, and how long one may be. A removed term is a
#: candidate the miner produced, so both are far above anything real.
AUTO_KEYTERMS_BLOCKED_MAX = 1000
AUTO_KEYTERM_MAX_CHARS = 100


def normalize_auto_keyterms_blocked(value: Sequence[object]) -> list[str]:
    """The stored removal list in canonical form: non-empty stripped
    strings, deduplicated case-insensitively (first spelling kept),
    bounded by ``AUTO_KEYTERMS_BLOCKED_MAX`` newest-last."""
    seen: set[str] = set()
    out: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        term = item.strip()[:AUTO_KEYTERM_MAX_CHARS].strip()
        if not term or term.lower() in seen:
            continue
        seen.add(term.lower())
        out.append(term)
    return out[-AUTO_KEYTERMS_BLOCKED_MAX:]


def auto_keyterms_blocked(cfg: Mapping) -> tuple[str, ...]:
    """Automatic terms the owner removed."""
    value = _deepgram_prefs(cfg).get("auto_keyterms_blocked")
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(normalize_auto_keyterms_blocked(list(value)))


def configured_merge(
    cfg: Mapping, auto_terms: Sequence[str] = (), *, assume_enabled: bool = False
) -> MergedKeyterms:
    """The full keyterm decision for one request: the manual list from
    the config, joined by *auto_terms* (the self-filling vocabulary's
    current ranking) when the config has it on — or *assume_enabled*,
    for showing what it would send — minus what the owner removed,
    within the budget."""
    manual = parse_keyterms(str(_deepgram_prefs(cfg).get("keyterms") or ""))
    if not (assume_enabled or auto_keyterms_enabled(cfg)):
        auto_terms = ()
    return merge_keyterms(manual, auto_terms, blocked=auto_keyterms_blocked(cfg))


def configured_keyterms(
    cfg: Mapping, auto_terms: Sequence[str] = ()
) -> tuple[str, ...]:
    """The keyterms a Deepgram request built from *cfg* sends.

    Owns the one config path every Deepgram call site reads (previously
    duplicated verbatim in ``backend.main`` at the live-session and
    prerecorded-transcribe entry points) so there is exactly one
    expression that knows where the raw keyterms string lives in the
    config tree. *auto_terms* is the self-filling vocabulary's current
    ranking (``backend.auto_keyterms``); see ``configured_merge``.
    Returns ``()`` rather than raising on a malformed config.
    """
    return configured_merge(cfg, auto_terms).terms
