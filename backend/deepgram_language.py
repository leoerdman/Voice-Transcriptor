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


__all__ = ["resolve_live_language", "rest_language_params"]
