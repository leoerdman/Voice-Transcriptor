"""SSOT for Deepgram Nova-3 Keyterm Prompting — one parser, one query
builder, shared by both Deepgram paths (live WebSocket and prerecorded
REST).

Why this exists
----------------
2026-09-03 measurement (see ``BUGS_AUDIT_2026-09-03.md`` §1, and
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
"""

from __future__ import annotations

import logging
import math
from typing import Mapping, Sequence

logger = logging.getLogger(__name__)

#: Deepgram's documented combined keyterm-token limit per request.
MAX_KEYTERM_TOKENS = 500

#: Conservative words-to-tokens estimate used to enforce the limit
#: without access to Deepgram's actual tokenizer. See module docstring.
TOKENS_PER_WORD_ESTIMATE = 1.3


def _approx_token_count(term: str) -> int:
    """Conservative token-cost estimate for one keyterm."""
    words = term.split()
    return max(1, math.ceil(len(words) * TOKENS_PER_WORD_ESTIMATE))


def normalize_keyterms(raw: str) -> tuple[str, ...]:
    """Parse the user's raw keyterms text into a clean term tuple.

    Accepts commas and/or newlines as separators — mixed use is fine.
    Each term is stripped of surrounding whitespace; empty terms are
    dropped. Order is preserved, and duplicates are removed
    case-insensitively while keeping the FIRST spelling seen (so
    "Sonnet" followed later by "sonnet" keeps "Sonnet" — the
    capitalisation the user typed first).

    Enforces ``MAX_KEYTERM_TOKENS`` conservatively: once the running
    token estimate would exceed the limit, the remaining terms are
    dropped and a warning is logged with the counts. Never raises — a
    misconfigured keyterms list must degrade to "fewer keyterms", not
    break dictation.
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

    kept: list[str] = []
    budget = MAX_KEYTERM_TOKENS
    dropped = 0
    for term in terms:
        cost = _approx_token_count(term)
        if cost > budget:
            dropped += 1
            continue
        kept.append(term)
        budget -= cost
    if dropped:
        logger.warning(
            "deepgram-keyterms: dropped %d of %d term(s) — exceeded the "
            "conservative %d-token estimate; kept %d",
            dropped, len(terms), MAX_KEYTERM_TOKENS, len(kept),
        )
    return tuple(kept)


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


def configured_keyterms(cfg: Mapping) -> tuple[str, ...]:
    """Read ``preferences.deepgram.keyterms`` out of the app config and
    normalise it.

    Owns the one config path both Deepgram call sites read (previously
    duplicated verbatim in ``backend.main`` at the live-session and
    prerecorded-transcribe entry points) so there is exactly one
    expression that knows where the raw keyterms string lives in the
    config tree. Tolerant of a missing/non-dict ``preferences`` or
    ``preferences.deepgram`` block — returns ``()`` rather than raising,
    matching ``normalize_keyterms``'s own "never break dictation"
    contract.
    """
    if not isinstance(cfg, Mapping):
        return ()
    preferences = cfg.get("preferences")
    dg_prefs = preferences.get("deepgram") if isinstance(preferences, Mapping) else None
    raw = dg_prefs.get("keyterms") if isinstance(dg_prefs, Mapping) else None
    return normalize_keyterms(str(raw or ""))
