"""The ``final`` WebSocket envelope — ONE shape, ONE constructor.

Why this module exists (B-038)
------------------------------
``{"type": "final", ...}`` is the single message the renderer delivers a
transcript from: since the "one owner of the text" change the backend
envelope IS the transcript, and the renderer's only remaining decision
is whether an envelope arrived at all. That message used to be written
out by hand at five call sites in ``backend.main`` in THREE mutually
incompatible shapes:

* the Deepgram drain — ``text/segments/durationSec/source/stats/
  uncoveredSpeechSec/streamedSec/coveredEndSec``;
* the local assist — ``text/segments/durationSec/source`` plus FLAT
  ``complete/coveredSec/totalSec/droppedSec/uncoveredTailSec`` and none
  of the four diagnostics above;
* the two error paths (no API key, connect failure) — a third subset,
  one of them with the diagnostics and one without.

The renderer's parser then had to be a union of the three, and every
field added on one side was a silent no-op on the other. This module is
the answer: every ``final`` message is built HERE, so there is exactly
one shape on the wire and every key is always present.

The shape
---------
Every key below is ALWAYS present. Absence is expressed by a value
(``""``, ``0.0``, ``null``), never by a missing key, because a missing
key is indistinguishable from a version mismatch — and a version
mismatch read as a fact is how a "complete" coverage report gets
believed for a session that never reported one.

===================== ========================================
``type``              always ``"final"``
``source``            who read the audio: ``deepgram-live`` or
                      ``local-assist`` (the constants below)
``text``              the delivered transcript, verbatim
``segments``          committed segments, each carrying its own
                      ``words`` and ``source``
``durationSec``       how long the transcript IS (last segment end)
``coveredEndSec``     how far a DECODER reported (never an interim)
``streamedSec``       audio actually handed to the provider
``uncoveredSpeechSec`` speech still not covered after recovery
``error``             ``""`` when the stop succeeded
``stats``             always an object — see ``live_final_stats``
``coverage``          the local assist's window report, or ``null``
                      for a transport that has no notion of windows
===================== ========================================

``coverage`` is ``null`` rather than absent for the same reason: the
renderer's adoption policy (``frontend/src/live-coverage.ts``) refuses
to adopt a transcript whose coverage it cannot read, and "the field is
null" and "this build does not send the field" must not be two
different-looking answers to that question.

The mirror of this module on the other side is
``frontend/src/live-envelope.ts``. Neither is allowed to drift: the
committed fixture ``contracts/live-final-envelope.json`` is PRODUCED by
this module's builder in ``backend/tests/test_live_envelope.py`` and
CONSUMED by ``frontend/tests/live-envelope.test.ts``, so a field added
or renamed on one side fails the other side's suite.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

#: The wire ``type`` this module builds. Named so no caller writes it.
FINAL_MESSAGE_TYPE = "final"

#: ``source`` for a recording read by the Deepgram streaming endpoint —
#: one stream or two, repaired or not. The renderer prints it on the
#: stop trace and ``live-coverage`` compares against ``local-assist``.
DEEPGRAM_LIVE_SOURCE = "deepgram-live"

#: ``source`` for a recording read by the local live assist.
LOCAL_ASSIST_SOURCE = "local-assist"

#: Every key a ``final`` message carries, in wire order. The tests on
#: both sides read this rather than restating the list.
FINAL_ENVELOPE_KEYS = (
    "type",
    "source",
    "text",
    "segments",
    "durationSec",
    "coveredEndSec",
    "streamedSec",
    "uncoveredSpeechSec",
    "error",
    "stats",
    "coverage",
)

#: Every key ``coverage`` carries when it is not ``null``.
COVERAGE_KEYS = (
    "complete",
    "coveredSec",
    "totalSec",
    "droppedSec",
    "uncoveredTailSec",
)


def _as_float(value: Any, default: float = 0.0) -> float:
    """Coerce a wire number, never raising and never producing NaN."""
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if out != out or out in (float("inf"), float("-inf")):  # NaN / ±inf
        return default
    return out


def _non_negative(value: Any) -> float:
    return round(max(0.0, _as_float(value)), 3)


def live_final_stats(
    raw: Optional[Mapping[str, Any]] = None,
    *,
    recovery: Optional[Mapping[str, Any]] = None,
) -> dict:
    """Normalise the ``stats`` object of a ``final`` envelope.

    The session's own ``DeepgramLiveStats.as_dict`` and the dual reader's
    additions (``backend.deepgram_dual.dual_stats`` — every key it adds is
    listed in ``DUAL_STATS_KEYS``) pass through unchanged — this backend
    owns what it reports about itself, and the renderer reads only the
    keys it documents (``connect_ms``, ``finalize_ms``, ``dual_stream``,
    ``dual_secondary_language``, ``dual_filled_from_secondary``,
    ``dual_filled_from_primary``, ``recovery``). The one guarantee made
    here is that ``stats`` is an OBJECT on every path, including the two
    error paths that used to omit it entirely, so the renderer never has
    to distinguish "no stats" from "a stop that reported none".
    """
    stats: dict = dict(raw or {})
    if recovery is not None:
        stats["recovery"] = dict(recovery)
    return stats


def live_coverage(
    *,
    complete: bool,
    covered_sec: Any,
    total_sec: Any,
    dropped_sec: Any,
    uncovered_tail_sec: Any,
) -> dict:
    """The local assist's window report, as it travels on the wire.

    Its five numbers used to be FLAT top-level keys on the local-assist
    envelope only — the second of the three shapes B-038 names. They are
    one fact about one transport, so they travel as one object.
    """
    return {
        "complete": bool(complete),
        "coveredSec": _non_negative(covered_sec),
        "totalSec": _non_negative(total_sec),
        "droppedSec": _non_negative(dropped_sec),
        "uncoveredTailSec": _non_negative(uncovered_tail_sec),
    }


def live_final_envelope(
    *,
    source: str,
    text: str = "",
    segments: Optional[Sequence[Mapping[str, Any]]] = None,
    duration_sec: Any = 0.0,
    covered_end_sec: Any = 0.0,
    streamed_sec: Any = 0.0,
    uncovered_speech_sec: Any = 0.0,
    error: str = "",
    stats: Optional[Mapping[str, Any]] = None,
    coverage: Optional[Mapping[str, Any]] = None,
) -> dict:
    """Build the ONE ``final`` message shape. The only constructor.

    Callers pass what they know; everything else takes its documented
    "nothing to report" value rather than vanishing from the payload.
    Segments are passed through as they were built (each carries its own
    ``words`` and ``source``) — placing a word by its time is the
    backend's job and the renderer does not re-derive it.
    """
    return {
        "type": FINAL_MESSAGE_TYPE,
        "source": str(source or ""),
        "text": str(text or ""),
        "segments": [dict(seg) for seg in (segments or [])],
        "durationSec": _non_negative(duration_sec),
        "coveredEndSec": _non_negative(covered_end_sec),
        "streamedSec": _non_negative(streamed_sec),
        "uncoveredSpeechSec": _non_negative(uncovered_speech_sec),
        "error": str(error or ""),
        "stats": live_final_stats(stats),
        "coverage": dict(coverage) if coverage is not None else None,
    }


def envelope_from_result(
    result: Mapping[str, Any],
    *,
    source: str,
    error: str = "",
    coverage: Optional[Mapping[str, Any]] = None,
) -> dict:
    """Build the envelope from a session result dict.

    ``DeepgramLiveSession.drain_transcript`` and ``.partial_result``
    return the SAME dict shape (C6: a partial and a full result may never
    describe the same audio differently), and so does the repaired
    payload ``backend.deepgram_recovery.run_recovery`` produces. One
    adapter for all three keeps the field-by-field copying that used to
    stand at each call site — and used to differ between them — in one
    place.
    """
    return live_final_envelope(
        source=source,
        text=result.get("text", ""),
        segments=result.get("segments") or [],
        duration_sec=result.get("durationSec", 0.0),
        covered_end_sec=result.get("coveredEndSec", 0.0),
        streamed_sec=result.get("streamedSec", 0.0),
        uncovered_speech_sec=result.get("uncoveredSpeechSec", 0.0),
        error=error or str(result.get("error") or ""),
        stats=result.get("stats"),
        coverage=coverage if coverage is not None else result.get("coverage"),
    )


__all__ = [
    "COVERAGE_KEYS",
    "DEEPGRAM_LIVE_SOURCE",
    "FINAL_ENVELOPE_KEYS",
    "FINAL_MESSAGE_TYPE",
    "LOCAL_ASSIST_SOURCE",
    "envelope_from_result",
    "live_coverage",
    "live_final_envelope",
    "live_final_stats",
]
