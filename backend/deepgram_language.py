"""What a configured language means to each Deepgram endpoint. One owner.

"auto" is a word from this app's UI, not from Deepgram, and the two
endpoints answer it differently — which is a fact about Deepgram, not a
choice this project gets to make:

* the LIVE (streaming) endpoint has no ``detect_language``. Nova-3
  offers ``language=multi``, a single multilingual model, and that is
  what "auto" has to become there;
* the PRERECORDED endpoint does have ``detect_language``, and it is the
  better reading there: it identifies the language of the whole file and
  decodes with that model, where ``multi`` was measured (2026-09-03, on
  the trilingual evidence recording) to drop Russian clauses.

So the two really are different, and the point of this module is that
the difference is written down ONCE, with its reason, instead of being
an unexplained divergence between two files — ``remote_deepgram`` said
``detect_language=true`` and ``remote_deepgram_live`` said ``multi``,
and nothing in either connected them.

The exception, and why it is not one: the recovery pass
(``backend.deepgram_recovery``) re-decodes spans of a LIVE recording
through the prerecorded endpoint, and it deliberately passes
``resolve_live_language`` — because it is repairing a reading the live
stream made, and a hole must not come back in a different language than
the transcript around it.
"""

from __future__ import annotations


def _normalize(language: str) -> str:
    """A configured language as both endpoints read it: trimmed, lowercased.

    One spelling rule for both functions below. ``rest_language_params``
    used to skip the lowercasing its own docstring promised, so "RU"
    reached the live endpoint as "ru" and the prerecorded one as "RU"
    (BE-21).
    """
    return (language or "").strip().lower()


def resolve_live_language(language: str) -> str:
    """The Deepgram ``language`` value a configured language maps to.

    "auto" is a UI word, not a Deepgram one: Nova-3's live endpoint has
    no ``detect_language``, it has ``language=multi``. Blank and "auto"
    therefore both resolve to "multi", and anything else is passed
    through lowercased.

    A SECOND question depends on the same mapping —
    ``backend.deepgram_dual`` runs a second reading only when the
    recording is actually multilingual — and two places deciding what
    "auto" means is exactly how they would come to disagree.
    """
    lang = _normalize(language)
    return "multi" if lang in ("", "auto", "multi") else lang


def rest_language_params(language: str) -> dict[str, str]:
    """The query parameters "auto" becomes on the PRERECORDED endpoint.

    ``{"detect_language": "true"}`` for auto/blank, and an explicit
    ``{"language": <lang>}`` otherwise — the same passthrough
    ``resolve_live_language`` performs, so a configured language reaches
    both endpoints identically and only the auto case differs.
    """
    lang = _normalize(language)
    if lang in ("", "auto"):
        return {"detect_language": "true"}
    return {"language": lang}


# ---------------------------------------------------------------------
# Language hints (Nova-3 multilingual, Deepgram 2026-10-23)
# ---------------------------------------------------------------------
#
# On 2026-10-23 Deepgram replaced the model behind ``language=multi``: the
# 10-language multilingual model became a 55-language one. More languages
# to choose from is more ways to mislabel this user's Russian — Persian,
# French, Lithuanian, Ukrainian, Bulgarian, German were all observed — and
# a mislabelled stretch is decoded in the wrong language. The same release
# added ``language_hint``: repeated once per language
# (``language_hint=ru&language_hint=en``), valid only with
# ``language=multi`` (ignored otherwise), accepted by the streaming and
# prerecorded endpoints alike, and it BIASES detection toward the hinted
# languages — it does not forbid the others. An unsupported code is an
# HTTP 400 that would kill the stream, so the choice is a closed set.
#
# ``LANGUAGE_HINT_OPTIONS`` is the set Deepgram has documented for
# multilingual Nova-3 since its first release (all ten are in the 55);
# the renderer offers exactly these (published in bootstrap).

#: Codes a user may hint. Order is the picker's order.
LANGUAGE_HINT_OPTIONS: tuple[str, ...] = ("ru", "en", "es", "fr", "de", "pt", "it", "nl", "ja", "hi")

#: What this app expects when the user has not chosen: Russian and English.
DEFAULT_LANGUAGE_HINTS: tuple[str, ...] = ("ru", "en")


def normalize_language_hints(raw: object) -> tuple[str, ...]:
    """The hints a stored value names: known codes only, deduplicated, in
    the user's order. Anything else — a non-list, an unknown code — is
    dropped rather than sent, because Deepgram answers an unsupported
    hint with a 400."""
    if not isinstance(raw, (list, tuple)):
        return ()
    out: list[str] = []
    for item in raw:
        code = _normalize(item) if isinstance(item, str) else ""
        if code in LANGUAGE_HINT_OPTIONS and code not in out:
            out.append(code)
    return tuple(out)


def configured_language_hints(cfg: object) -> tuple[str, ...]:
    """``preferences.deepgram.language_hints`` from the app config.

    An ABSENT preference is the default (``DEFAULT_LANGUAGE_HINTS``); a
    present one is the user's choice, including an empty list, which
    means "no hints"."""
    prefs = cfg.get("preferences") if isinstance(cfg, dict) else None
    dg = prefs.get("deepgram") if isinstance(prefs, dict) else None
    if not isinstance(dg, dict) or "language_hints" not in dg:
        return DEFAULT_LANGUAGE_HINTS
    return normalize_language_hints(dg.get("language_hints"))


def language_hint_pairs(deepgram_language: str, hints: "tuple[str, ...] | list[str]") -> list[tuple[str, str]]:
    """The ``language_hint`` query pairs for a request whose Deepgram
    ``language`` value is *deepgram_language* — none unless it is
    ``multi``, the only value Deepgram reads them for."""
    if _normalize(deepgram_language) != "multi":
        return []
    return [("language_hint", code) for code in normalize_language_hints(list(hints))]


__all__ = [
    "resolve_live_language",
    "rest_language_params",
    "LANGUAGE_HINT_OPTIONS",
    "DEFAULT_LANGUAGE_HINTS",
    "normalize_language_hints",
    "configured_language_hints",
    "language_hint_pairs",
]
