"""Recovery of the spans a live reading failed to cover — one owner.

Why
---
Until now the ``final`` envelope was allowed to be incomplete and the
RENDERER made up the difference: it raced a REST re-decode of the saved
recording against the envelope, unioned the two texts, and grafted a
"recovered tail" on. Two owners of one transcript is how every
duplication defect of 2026-09-03/04 happened — the preview restates
ground the envelope already covers, in slightly different words, and no
alignment can reliably tell that apart from new speech
(``docs/archive/BUGS_AUDIT_2026-09-03.md`` §2.2/§2.3/§4.8).

So the envelope becomes complete BY CONSTRUCTION and the renderer
becomes a consumer. After the live drain — single stream or dual — the
backend asks what it still fails to cover, re-decodes exactly those
spans from its OWN audio spool through the Deepgram REST endpoint,
splices the words in by time, and only then sends the envelope.

What is a "span this reading failed to cover"
---------------------------------------------
Four shapes, and they are different failures, not four guesses at one:

(a) HOLES the reading itself reports — interim-heard words no final
    carried, and regions no final reached at all
    (``DeepgramLiveSession.coverage_hole_spans``, audit §3.1-§3.4);
(b) an unflushed TAIL past the last final, when there is evidence
    something is in it — everything the stop retries a ``Finalize`` for
    (``tail_needs_flush``), plus the one shape a second Finalize cannot
    help with: a provider that went silent without sending the
    ``UtteranceEnd`` it owes (``tail_needs_recovery`` rule 3, the
    2026-08-24 loss). The retry rule is a strict subset of this one, so
    a tail the stop waited for is always a tail this re-decodes;
(c) everything after the upstream socket DIED (``stream_death_sec``).
    Those bytes were captured by the app and never seen by Deepgram, so
    no amount of waiting can produce them (audit §3.6/§3.7);
(d) NOTHING AT ALL: no finals for a recording long enough that silence
    is not the explanation (``LIVE_EMPTY_RESULT_MIN_SEC``). Measured at
    29 of 706 sessions, 21 of them past 2 s of audio.

Every candidate is then reduced by what the assembled transcript
ACTUALLY covers, word by word — so a hole the dual-stream merge already
filled is not re-decoded, and re-running this function on the repaired
envelope reports what is genuinely still missing rather than the same
spans again.

What it costs
-------------
Bounded by construction: the spans are padded and merged, the whole
pass runs under ``recovery_budget_sec`` (a base plus a share of the
audio being re-decoded, hard-capped), and a REST call that fails or
runs long is logged once and dropped. The spans it could not recover
stay in the envelope's ``uncoveredSpeechSec`` — honest, not silent.
"""

from __future__ import annotations

import asyncio
import bisect
import io
import logging
import time
import wave
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional, Sequence

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ, pcm16_bytes_per_sec
from backend.deepgram_dual import merge_readings
from backend.live_envelope import envelope_from_result, live_final_stats
from backend.model_catalog import DEFAULT_DEEPGRAM_AUDIO_MODEL
from backend.remote_deepgram import deepgram_transcribe
from backend.remote_deepgram_live import (
    DeepgramLiveConfig,
    as_float,
    confirmed_silence_gap,
    intersect_spans,
    join_segment_texts,
    normalize_words,
    resolve_live_language,
    segment_word_records,
    segment_words,
    splice_words_into_segments,
    subtract_spans,
    token_stem,
    word_duration,
    decoded_end_sec,
    tail_needs_recovery,
    union_spans,
    word_inside_spanless_final,
)
from backend.word_case import as_read

logger = logging.getLogger(__name__)


# A live session that streamed at least this much audio and produced no
# final segment at all did not record silence — it failed. Below it, a
# recording with no transcript is most likely a hotkey misfire, and
# re-decoding it would cost a REST round trip to be told the same
# nothing. Lives here rather than in ``backend.main`` because the
# recovery pass is now the first reader of it: the WS handler's
# "produced NO final segments" warning and rule (d) below must fire on
# exactly the same threshold, or the log would announce a failure the
# recovery declined to act on.
LIVE_EMPTY_RESULT_MIN_SEC = 2.0

# Each span is widened by this much on both sides before it is decoded.
# A hole's edges are where two decoders disagreed about a word boundary,
# so the word that is missing usually starts slightly before the span
# that betrays it; and a decoder handed 0.4 s of speech with no lead-in
# has no context to decode it with. The overlap this creates with
# already-transcribed audio is not a duplication risk: the splice aligns
# the re-decode with the transcript's own words and keeps only what the
# transcript is missing (``splice_recovered_words``), and guards both
# seams (``fits_beside``).
RECOVERY_SPAN_PAD_SEC = 0.3

# A candidate span shorter than this is not a missing word. The shortest
# real word runs about 0.15 s; anything under 0.1 s is a boundary the
# two measurements rounded differently, and paying a network round trip
# for it would make every healthy stop slower for nothing.
RECOVERY_MIN_SPAN_SEC = 0.1

# The recovery budget: one REST round trip's fixed cost, plus a share of
# the audio being decoded.
#
# Measured 2026-09-04 against the live Deepgram REST endpoint, five
# 1.8-2.9 s spans of the 72.7 s trilingual evidence recording, in one
# process: the FIRST call cost 2078 ms and the four after it 331, 355,
# 369 and 636 ms. The difference is connection setup — ``http_retry``
# pools the socket, so every call but the first is a warm POST — and the
# recovery pass is very often the first REST call this process makes.
# A 1.5 s base was tried first and timed out the whole pass on exactly
# that cold call, which is the worst possible failure: the stop pays the
# wait and the user gets nothing for it. 2.5 s clears the measured cold
# call with margin and costs a healthy stop nothing at all, because no
# recovery is announced when there are no spans.
#
# The hard cap is what makes this safe to promise the renderer: a stop
# can never run longer because the recovery had a lot of ground to cover.
RECOVERY_BUDGET_BASE_SEC = 2.5
RECOVERY_BUDGET_PER_SPAN_SEC = 0.25
RECOVERY_BUDGET_MAX_SEC = 8.0

# What a recovered word is labelled with, in the envelope's per-word
# ``source`` and on any segment it creates.
RECOVERY_SOURCE = "recovery"


@dataclass(frozen=True)
class InterimEvidence:
    """What a live reading knows about its own gaps, as plain data.

    Deliberately a value object rather than a session reference: the
    span computation is pure and testable, and the dual-stream facade
    can answer these four questions for two sessions at once without
    this module knowing there were two.
    """

    # Spans the reading reports as missing from its committed transcript.
    hole_spans: tuple[tuple[float, float], ...] = ()
    # Spans where an interim carried real recognised text.
    speech_spans: tuple[tuple[float, float], ...] = ()
    # End of the newest interim's own decode window, session timeline.
    interim_window_end: float = 0.0
    # The session's configured endpointing silence window, in seconds.
    # Defaults are the live config's own, not a second copy of them
    # (BE-17).
    endpointing_sec: float = DeepgramLiveConfig.endpointing_ms / 1000.0
    # ``last_word_end`` of the newest ``UtteranceEnd``, or ``None``.
    # Deepgram's affirmative "the utterance ended here" — the only signal
    # that tells a user who stopped talking apart from a provider that
    # stopped answering, which is what rule (b)'s third clause turns on.
    # Collected by the live session and, before this carried it, unread
    # anywhere but there (B-007).
    utterance_end: Optional[float] = None
    # After this much silence Deepgram OWES an ``UtteranceEnd``; a gap
    # longer than it with none inside is the unexplained one.
    utterance_end_sec: float = DeepgramLiveConfig.utterance_end_ms / 1000.0


def evidence_from_session(session: Any) -> InterimEvidence:
    """Read a live session's (or the dual facade's) coverage evidence.

    Duck-typed on purpose — ``DeepgramLiveSession`` and
    ``DualLiveSession`` both answer these four, and this module must not
    have to know which one it was handed.
    """
    return InterimEvidence(
        hole_spans=tuple(session.coverage_hole_spans()),
        speech_spans=tuple(session.interim_speech_spans()),
        # Read as given: ``or <default>`` turned a legitimately
        # configured 0 into the default, and restated the defaults a
        # third time (BE-17).
        interim_window_end=float(session.interim_window_end),
        endpointing_sec=float(session.endpointing_sec),
        utterance_end=session.last_utterance_end,
        utterance_end_sec=float(session.utterance_end_sec),
    )


def covered_spans(segments: Iterable[dict]) -> list[tuple[float, float]]:
    """The audio the assembled transcript actually accounts for.

    Word spans where a segment carries words — coverage is a property of
    WORDS, not of message windows, which is the whole finding of audit
    §3.1 — and the segment's own span where it does not, because for
    such a segment its span is the only thing knowable about what it
    contains. Both halves come from ``segment_word_records``, the one
    rule for what a final without a word list accounts for, shared with
    the live session's own coverage and with the dual-stream merge.
    """
    return union_spans(
        (as_float(w.get("start")), as_float(w.get("end")))
        for seg in (segments or [])
        for w in segment_word_records(seg)
    )


def missing_spans(
    streamed_sec: float,
    segments: Sequence[dict],
    evidence: InterimEvidence,
    stream_death_sec: Optional[float] = None,
    *,
    audio_sec: Optional[float] = None,
    min_span_sec: float = RECOVERY_MIN_SPAN_SEC,
) -> list[tuple[float, float]]:
    """The ground this recording's transcript does not account for.

    The MEASUREMENT — exactly the audio no word covers, with no decode
    padding on it. ``uncovered_spans`` is this same answer widened into
    something worth handing a decoder; the envelope's
    ``uncoveredSpeechSec`` is this one, because padding is a decoding
    concern and reporting it as missing speech would overstate the loss
    by 0.6 s per hole.

    ``segments`` is the ASSEMBLED transcript — post seam-merge, post
    interim splice, post dual-stream merge — because what matters is
    what the user is about to receive, not what any one reading
    committed. ``audio_sec`` is how much audio the spool actually holds;
    it exceeds ``streamed_sec`` exactly when the upstream stopped
    accepting bytes, which is the case rules (c) and (d) exist for.

    Idempotent by construction: every candidate is reduced by
    ``covered_spans(segments)``, so calling this again on a repaired
    envelope reports what is genuinely still missing rather than the
    spans that were just filled.
    """
    limit = max(0.0, float(streamed_sec or 0.0), float(audio_sec or 0.0))
    if limit <= 0.0:
        return []
    covered = covered_spans(segments)
    covered_end = max((end for _s, end in covered), default=0.0)
    # Where the reading stopped REPORTING — the end of the last committed
    # segment, which is the same measure ``_tail_coverage`` takes on the
    # live side. The tail begins there and not at the last committed
    # WORD: audio inside a segment the provider did finalize is not an
    # unflushed tail, it is at most a word-level hole, and that is rule
    # (a)'s business. Measuring the tail from the last word instead made
    # every final whose closing words were quiet look like a provider
    # that had stopped answering.
    reported_end = max(
        covered_end,
        max((as_float(seg.get("end")) for seg in segments or []), default=0.0),
    )

    candidates: list[tuple[float, float]] = []

    # (a) What the reading itself says it missed.
    candidates.extend(evidence.hole_spans)

    # (b) The tail past the last committed segment, when there is
    #     evidence something is in it — the stop's own retry rule, plus
    #     the silent-provider shape a second Finalize cannot answer.
    tail = (reported_end, min(limit, max(reported_end, float(streamed_sec or 0.0))))
    if tail[1] > tail[0]:
        tail_speech = sum(
            end - start
            for start, end in intersect_spans(evidence.speech_spans, [tail])
        )
        # The same UtteranceEnd subtraction the stop applies before it
        # judges its own tail (``confirmed_silence_gap``): silence
        # Deepgram itself announced is not an unexplained gap, and
        # measuring it here without that subtraction would send a REST
        # call after every recording that ends with the user pausing
        # before the hotkey.
        tail_gap = confirmed_silence_gap(
            reported_end, tail[1], evidence.utterance_end, evidence.speech_spans
        )
        if tail_needs_recovery(
            tail_gap,
            tail_speech,
            evidence.interim_window_end - reported_end,
            evidence.endpointing_sec,
            evidence.utterance_end_sec,
        ):
            candidates.append(tail)

    # (c) Everything after the socket died. Those bytes were never
    #     offered to Deepgram at all, so there is no "wait longer" that
    #     could have produced them.
    if stream_death_sec is not None:
        death = max(0.0, float(stream_death_sec))
        if limit > death:
            candidates.append((death, limit))

    # (d) Nothing at all, for a recording too long to be silence.
    if not covered and limit >= LIVE_EMPTY_RESULT_MIN_SEC:
        candidates.append((0.0, limit))

    return [
        (round(start, 3), round(end, 3))
        for start, end in subtract_spans(candidates, covered)
        if end - start >= min_span_sec
    ]


def uncovered_spans(
    streamed_sec: float,
    segments: Sequence[dict],
    evidence: InterimEvidence,
    stream_death_sec: Optional[float] = None,
    *,
    audio_sec: Optional[float] = None,
    pad_sec: float = RECOVERY_SPAN_PAD_SEC,
    min_span_sec: float = RECOVERY_MIN_SPAN_SEC,
) -> list[tuple[float, float]]:
    """The spans to hand a decoder: ``missing_spans`` widened and merged.

    Each missing span is padded by ``pad_sec`` on both sides, clamped to
    the audio, and overlapping results are merged — so two holes half a
    second apart become one decode instead of two, and a decoder is
    never handed a fragment with no lead-in. The overlap with
    already-transcribed audio that padding creates is not a duplication
    risk: ``splice_recovered_words`` keeps only the recovered words the
    transcript's own words do not already account for.
    """
    limit = max(0.0, float(streamed_sec or 0.0), float(audio_sec or 0.0))
    missing = missing_spans(
        streamed_sec,
        segments,
        evidence,
        stream_death_sec,
        audio_sec=audio_sec,
        min_span_sec=min_span_sec,
    )
    if not missing:
        return []
    padded = [
        (max(0.0, start - pad_sec), min(limit, end + pad_sec))
        for start, end in missing
    ]
    return [(round(a, 3), round(b, 3)) for a, b in union_spans(padded) if b > a]


def recovery_budget_sec(spans: Sequence[tuple[float, float]]) -> float:
    """How long the recovery pass may take, for these spans.

    Zero for no spans — the announced stop budget must not grow by a
    penny on a recording that needs no recovery, which is the
    overwhelming majority of them.
    """
    total = sum(max(0.0, end - start) for start, end in spans)
    if total <= 0.0:
        return 0.0
    return min(
        RECOVERY_BUDGET_MAX_SEC,
        RECOVERY_BUDGET_BASE_SEC + RECOVERY_BUDGET_PER_SPAN_SEC * total,
    )


def pcm_span_wav(
    pcm: bytes, start_sec: float, end_sec: float, sample_rate: int = LIVE_SAMPLE_RATE_HZ
) -> bytes:
    """One span of the mono 16 kHz PCM16 spool as a self-contained WAV.

    The spool is headerless raw samples, and the REST endpoint needs a
    container. Offsets are clamped to the buffer and snapped to whole
    samples — a WAV whose data length is odd would shift every sample
    after it by one byte, which is white noise, not audio.
    """
    frame_bytes = 2
    total_frames = len(pcm) // frame_bytes
    lo = max(0, int(round(max(0.0, start_sec) * sample_rate)))
    hi = min(total_frames, int(round(max(0.0, end_sec) * sample_rate)))
    payload = pcm[lo * frame_bytes:max(lo, hi) * frame_bytes]
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(frame_bytes)
        wav.setframerate(int(sample_rate))
        wav.writeframes(payload)
    return buf.getvalue()


def _words_from_rest_result(result: Any, offset_sec: float) -> list[dict]:
    """The word list of a REST response, on the RECORDING's timeline.

    Deepgram times a pre-recorded decode from the start of the audio it
    was given, and it was given one span — so every word comes back
    ``offset_sec`` early. Applied here, in the one place a REST word
    becomes an internal word record, exactly as ``audio_offset_sec``
    does for a socket that took over mid-recording.

    The words come off the ADAPTER's ``words`` key, not out of
    ``raw["results"]["channels"][0]["alternatives"][0]`` — that path is
    the provider's payload shape, which is ``backend.remote_deepgram``'s
    business and was spelled out here as well. Normalising them is this
    side's rule, so the adapter hands them over raw.
    """
    raw = result if isinstance(result, dict) else {}
    words = normalize_words(raw.get("words"))
    out: list[dict] = []
    for word in words:
        record = {
            "word": word["word"],
            "start": round(word["start"] + offset_sec, 3),
            "end": round(word["end"] + offset_sec, 3),
            "source": RECOVERY_SOURCE,
        }
        # Deepgram's evidence about the word, kept exactly as the live
        # path keeps it: a re-decode in ``multi`` is the same reading
        # that hears Russian as Telugu or Hebrew, and the rule that
        # catches that (``merge_readings``' contested stretches) decides
        # from these two fields (BE-11).
        for key in ("confidence", "language"):
            if key in word:
                record[key] = word[key]
        out.append(record)
    return out


async def recover_spans(
    pcm_bytes: bytes,
    spans: Sequence[tuple[float, float]],
    cfg: DeepgramLiveConfig,
    *,
    api_key: str,
    sample_rate: int = LIVE_SAMPLE_RATE_HZ,
    budget_sec: Optional[float] = None,
    transcribe: Optional[Callable[..., dict]] = None,
    secondary_language: str = "",
) -> list[dict]:
    """Re-decode ``spans`` of the spool and return the words, time-shifted.

    ``secondary_language`` non-empty — a dual-stream recording, whose
    live transcript is a merge of ``multi`` and that language — decodes
    every span in BOTH and merges the two by the same rules the live
    readings were merged by (``backend.deepgram_dual.merge_readings``).
    A ``multi``-only re-decode let back in exactly what the merge exists
    to keep out: logged recoveries of a Russian/English speaker returned
    Devanagari, Telugu and Hebrew words (BL-10). Both decodes of a span
    run concurrently under the same deadline, so this costs REST seconds,
    not stop time.

    The REST call is made with the SAME language decision the live
    stream made — ``resolve_live_language``, so "auto" reaches the
    pre-recorded endpoint as ``language=multi`` and never as
    ``detect_language``, which would let the re-decode of a hole read
    the recording in a different language than the reading it is
    repairing. Model, key terms and the shared formatting parameters
    come from the same session config and the same shared modules for
    the same reason.

    Every span is decoded concurrently under ONE deadline: they are
    independent uploads of a few dozen kilobytes each, and the budget
    the renderer was told about bounds the whole pass, not each call.
    Failure — HTTP error, malformed payload, the budget expiring — is
    logged once and costs only the spans it touched: the caller ships
    the envelope without them, and reports them as uncovered.
    """
    if not spans or not pcm_bytes or not api_key:
        return []
    call = transcribe or deepgram_transcribe
    language = resolve_live_language(cfg.language)
    model = cfg.model or DEFAULT_DEEPGRAM_AUDIO_MODEL
    keyterms = tuple(cfg.keyterms or ())
    language_hints = tuple(cfg.language_hints or ())
    deadline = budget_sec if budget_sec is not None else recovery_budget_sec(spans)

    languages = [language]
    if secondary_language and language == "multi" and secondary_language != language:
        languages.append(secondary_language)

    def _decode(index: int, start: float, end: float, lang: str) -> list[dict]:
        wav = pcm_span_wav(pcm_bytes, start, end, sample_rate)
        result = call(
            api_key=api_key,
            audio_bytes=wav,
            filename=f"recovery-{index}.wav",
            model=model,
            language=lang,
            diarize=False,
            keyterms=keyterms,
            language_hints=language_hints,
        )
        return _words_from_rest_result(result, start)

    async def _one(index: int, start: float, end: float) -> list[dict]:
        readings = await asyncio.gather(
            *(asyncio.to_thread(_decode, index, start, end, lang) for lang in languages),
            return_exceptions=True,
        )
        if isinstance(readings[0], BaseException):
            raise readings[0]
        if len(readings) == 1:
            return readings[0]
        partner = readings[1]
        if isinstance(partner, BaseException):
            logger.warning(
                "recovery: %s re-decode of a span failed; keeping the %s reading: %s",
                languages[1], language, partner,
            )
            return readings[0]
        return _merge_recovery_readings(
            readings[0],
            partner,
            language,
            languages[1],
            expected_languages=language_hints,
            keyterms=keyterms,
        )

    tasks = [
        asyncio.ensure_future(_one(i, start, end))
        for i, (start, end) in enumerate(spans)
    ]
    try:
        results = await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=max(0.1, deadline),
        )
    except asyncio.TimeoutError:
        for task in tasks:
            task.cancel()
        # Collected, so a decode that raised inside its thread after the
        # deadline is not an unretrieved task exception on the loop.
        # ``asyncio.to_thread`` cannot interrupt a running thread, so
        # these settle when their HTTP call returns; nothing waits for
        # them and their words are not used.
        asyncio.ensure_future(
            asyncio.gather(*tasks, return_exceptions=True)
        )
        logger.warning(
            "recovery: %d span(s) did not decode within %.2fs; the envelope "
            "reports them as uncovered",
            len(spans),
            max(0.1, deadline),
        )
        return []

    words: list[dict] = []
    failures = 0
    for result in results:
        if isinstance(result, BaseException):
            failures += 1
            continue
        words.extend(result)
    if failures:
        logger.warning(
            "recovery: %d of %d span(s) failed to decode; the envelope "
            "reports them as uncovered",
            failures,
            len(spans),
        )
    words.sort(key=lambda w: (w["start"], w["end"]))
    return words


def _merge_recovery_readings(
    primary: list[dict],
    secondary: list[dict],
    primary_language: str,
    secondary_language: str,
    *,
    expected_languages: "tuple[str, ...]" = (),
    keyterms: "tuple[str, ...]" = (),
) -> list[dict]:
    """Two re-decodes of one span, merged by the live readings' own rules."""
    def _as_segment(words: list[dict]) -> list[dict]:
        if not words:
            return []
        return [{
            "start": words[0]["start"],
            "end": words[-1]["end"],
            "text": " ".join(w["word"] for w in words),
            "words": words,
        }]

    merged = merge_readings(
        _as_segment(primary),
        _as_segment(secondary),
        primary_language=primary_language,
        secondary_language=secondary_language,
        expected_languages=expected_languages,
        keyterms=keyterms,
    )
    # Provenance on the wire is "recovery" whichever reading a word came
    # from — that is what the envelope's segment ``source`` promises.
    return [dict(w, source=RECOVERY_SOURCE) for w in merged.words]


def splice_recovered_words(
    segments: Sequence[dict],
    words: Sequence[dict],
    spans: Sequence[tuple[float, float]],
    *,
    keyterms: Sequence[str] = (),
) -> tuple[list[dict], int]:
    """Place recovered words into the assembled transcript.

    ``spans`` are the spans the words were decoded from (``recover_spans``
    was handed them). A re-decode returns a SEQUENCE of words over its
    span, and the transcript already has a sequence of words over the
    same ground, so which recovered words are new is decided by aligning
    the two sequences (``_fresh_recovered_words``) — not by time alone.
    ``keyterms`` are the ones the re-decode ran with (``cfg.keyterms``):
    the splice keeps the capital of the names among them.

    Time alone is what lost a spoken word (2026-11-23, take
    ``20261123-173222``): the span 7.93-8.86 s re-decoded as "Потерял,"
    7.93-8.65 and "посмотрю." 8.65-9.13, around the transcript's
    "деплой" 7.68-8.08 and "Посмотри," 8.56-9.04. A REST decode of a
    short clip stretches its first word back to the clip start, so
    "Потерял," overlapped 37 % of "деплой", and the time-only coverage
    rule (``covering_word``, 25 % of either word) judged its ground
    owned and dropped it. In order, though, the re-decode says "<X>
    посмотрю" where the transcript says "деплой Посмотри": "посмотрю" is
    the transcript's "Посмотри", and nothing of the transcript lies
    between "деплой" and it — "Потерял," is the missing word, and it
    belongs in that gap.

    Two filters stay as they were, both rules this product already has:
    a word inside a final that carried no word list is accounted for by
    that final (``word_inside_spanless_final``), and placement itself is
    ``splice_words_into_segments`` — the same implementation the interim
    splice uses, stutter and room guards included.
    """
    committed = sorted(
        (w for seg in segments for w in segment_words(seg)),
        key=lambda w: (as_float(w.get("start")), as_float(w.get("end"))),
    )
    candidates = [
        word for word in words
        # A final that arrived WITHOUT a word list accounts for its whole
        # span, and there is no word to align against — only a span.
        # Spans are padded before decoding, so a re-decode reaches into
        # ground such a final owns, and without this the same speech went
        # into the transcript twice.
        if not word_inside_spanless_final(word, segments)
    ]
    fresh = _fresh_recovered_words(committed, candidates, spans)
    # Said out loud, both times. A recovery that decodes ten words and
    # ships none is either working exactly as intended (the padding
    # returned words the transcript already had) or misfiring, and the
    # difference is invisible unless the two reasons are counted apart.
    if len(fresh) != len(words):
        kept = {id(w.get(_RECOVERED_FROM, w)) for w in fresh}
        # Spans, not the words: main.log is a support artefact and never
        # carries what the user dictated (BL-02). The span is what a
        # reader matches against ``coverage holes`` anyway.
        logger.info(
            "recovery: %d decoded word(s) already owned by the transcript: %s",
            len(words) - len(fresh),
            [
                f"{as_float(w.get('start')):.2f}-{as_float(w.get('end')):.2f}"
                for w in words
                if id(w) not in kept
            ][:12],
        )
    fresh = [{k: v for k, v in w.items() if k != _RECOVERED_FROM} for w in fresh]
    if not fresh:
        return list(segments), 0
    # Placement, and the case and marks each word takes from its place,
    # are the splice's (``backend.word_case`` — one rule for every
    # inserted word, the live interim splice's too).
    outcome = splice_words_into_segments(
        segments, fresh, source=RECOVERY_SOURCE, keyterms=keyterms
    )
    if outcome.total != len(fresh):
        logger.info(
            "recovery: %d decoded word(s) had no room beside the transcript",
            len(fresh) - outcome.total,
        )
    return outcome.segments, outcome.total


# Internal back-reference from a re-timed copy to the decoded word it was
# made from, so the "already owned" log can name the decoded spans. Never
# leaves this module.
_RECOVERED_FROM = "_recovered_from"


def _stem_lcs(a: Sequence[str], b: Sequence[str]) -> list[tuple[int, int]]:
    """Index pairs of a longest common subsequence of two stem lists.

    Empty stems (punctuation, digits-only tokens) never match. Quadratic
    in the words of ONE span — a padded hole is a handful of words.
    """
    n, m = len(a), len(b)
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if a[i] and a[i] == b[j]:
                table[i][j] = table[i + 1][j + 1] + 1
            else:
                table[i][j] = max(table[i + 1][j], table[i][j + 1])
    pairs: list[tuple[int, int]] = []
    i = j = 0
    while i < n and j < m:
        if a[i] and a[i] == b[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif table[i + 1][j] >= table[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def _fresh_recovered_words(
    committed: list[dict],
    words: Sequence[dict],
    spans: Sequence[tuple[float, float]],
) -> list[dict]:
    """The recovered words the transcript does not have, each timed into
    the gap it fills.

    Per decoded span:

    1. The transcript's words OF that span are those whose midpoint lies
       in it; the span's recovered words are those that start in it (a
       REST word is timed from the clip start, so it can run past the
       clip end but never start before it — "посмотрю." 8.65-9.13 came
       from the 7.93-8.86 span).
    2. The two sequences are aligned by stem — ``token_stem``, the same
       "one spoken word" rule the splice guard and the dual merge use, so
       "слушаю"/"слушай" are one word here exactly as they are there.
       A matched recovered word is already in the transcript.
    3. Every run of unmatched recovered words sits between two matched
       neighbours (or a span edge). Between the transcript's partners of
       those neighbours there is either something or nothing:

       * something — the transcript has its own words for that ground,
         spelled differently. The transcript's reading stands (a
         re-decode does not overrule a final word by word: the "трёх"/
         "в" and stutter cases of the splice guard);
       * nothing — the run is speech the transcript is missing. Its
         words belong in the gap between those two transcript words,
         and that gap is where they are put: the run's own times are
         mapped linearly onto the part of the gap they reach.

    A recovered word with less than half of its own time in that gap is
    not put there: at a span edge the clip starts or ends inside a
    transcript word (the decode is padded), and a fragment of that word
    ("…лой" of "деплой") is the transcript's word, not a missing one.
    """
    if not words:
        return []
    ordered_spans = sorted((float(a), float(b)) for a, b in spans)
    if not ordered_spans:
        return []
    span_starts = [a for a, _b in ordered_spans]
    by_span: list[list[dict]] = [[] for _ in ordered_spans]
    for word in sorted(words, key=lambda w: (as_float(w.get("start")), as_float(w.get("end")))):
        index = max(0, bisect.bisect_right(span_starts, as_float(word.get("start"))) - 1)
        by_span[index].append(word)
    # Each span was decoded as a text of its own: every word remembers
    # its place in it, which is what its capital and its trailing marks
    # owe to the clip rather than to the transcript (the splice settles
    # both — ``backend.word_case``). Copies, each pointing back at the
    # decoded word it is.
    by_span = [
        [dict(read, **{_RECOVERED_FROM: word}) for read, word in zip(as_read(clip), clip)]
        for clip in by_span
    ]

    mids = [(as_float(w.get("start")) + as_float(w.get("end"))) / 2.0 for w in committed]
    fresh: list[dict] = []
    for (span_start, span_end), recovered in zip(ordered_spans, by_span):
        if not recovered:
            continue
        lo_index = bisect.bisect_left(mids, span_start)
        hi_index = bisect.bisect_left(mids, span_end)
        inside = list(range(lo_index, hi_index))
        matches = _stem_lcs(
            [token_stem(str(w.get("word") or "")) for w in recovered],
            [token_stem(str(committed[c].get("word") or "")) for c in inside],
        )
        # Anchors as (recovered index, committed index in the FULL list),
        # bracketed by the span edges: before the span's first transcript
        # word and after its last.
        anchors = [(-1, lo_index - 1)]
        anchors += [(r, inside[c]) for r, c in matches]
        anchors.append((len(recovered), hi_index))
        for (r_left, c_left), (r_right, c_right) in zip(anchors, anchors[1:]):
            run = recovered[r_left + 1:r_right]
            if not run or c_right - c_left > 1:
                # Nothing unmatched here, or the transcript has its own
                # words for this ground.
                continue
            lo = as_float(committed[c_left].get("end")) if c_left >= 0 else float("-inf")
            hi = (
                as_float(committed[c_right].get("start"))
                if c_right < len(committed) else float("inf")
            )
            fresh.extend(_timed_into_gap(run, lo, hi))
    return fresh


def _timed_into_gap(run: list[dict], lo: float, hi: float) -> list[dict]:
    """``run`` placed in the transcript gap ``[lo, hi]`` (see
    ``_fresh_recovered_words``): words mostly outside it dropped, the
    rest re-timed by one linear map onto the part of the gap they reach.
    Copies; each remembers the decoded word it came from."""
    if hi <= lo:
        return []
    kept = []
    for word in run:
        start, end = as_float(word.get("start")), as_float(word.get("end"))
        inside = min(end, hi) - max(start, lo)
        if inside >= 0.5 * word_duration(word):
            kept.append(word)
    if not kept:
        return []
    src_start = as_float(kept[0].get("start"))
    src_end = max(as_float(w.get("end")) for w in kept)
    dst_start, dst_end = max(lo, src_start), min(hi, src_end)
    if dst_end <= dst_start:
        return []
    scale = (dst_end - dst_start) / max(src_end - src_start, 1e-6)

    def _map(t: float) -> float:
        return round(dst_start + (t - src_start) * scale, 3)

    return [
        dict(
            word,
            start=_map(as_float(word.get("start"))),
            end=_map(as_float(word.get("end"))),
            **{_RECOVERED_FROM: word.get(_RECOVERED_FROM, word)},
        )
        for word in kept
    ]


@dataclass
class RecoveryReport:
    """What the recovery pass did, as it appears in ``stats.recovery``.

    ``as_dict`` is the WIRE SHAPE of ``stats.recovery`` — the one place
    it is built. The renderer's stop trace reads ``spans_sec`` (how many
    seconds of the recording were re-decoded) and ``ms`` (what that
    cost); ``frontend/src/main.tsx`` names both as the contract it
    implements. ``spans_sec`` is DERIVED from ``spans`` here rather than
    carried alongside it, so the total and the list it totals cannot
    drift apart. ``spans`` and ``words`` are the diagnostic detail the
    log line and the tests read.
    """

    spans: list[tuple[float, float]] = field(default_factory=list)
    ms: float = 0.0
    words: int = 0

    def spans_sec(self) -> float:
        """Total duration of the re-decoded spans, in seconds."""
        return sum(max(0.0, end - start) for start, end in self.spans)

    def as_dict(self) -> dict:
        return {
            "spans": [[round(s, 3), round(e, 3)] for s, e in self.spans],
            "spans_sec": round(self.spans_sec(), 3),
            "ms": round(self.ms, 1),
            "words": int(self.words),
        }


async def run_recovery(
    *,
    payload: dict,
    evidence: InterimEvidence,
    stream_death_sec: Optional[float],
    pcm: "bytes | Callable[[], bytes]",
    audio_sec: Optional[float] = None,
    cfg: DeepgramLiveConfig,
    api_key: str,
    sample_rate: int = LIVE_SAMPLE_RATE_HZ,
    announce: Optional[Callable[[float], None]] = None,
    announced_recovery_sec: float = 0.0,
    transcribe: Optional[Callable[..., dict]] = None,
) -> dict:
    """Complete a ``final`` envelope before it is sent. The ONE entry point.

    Takes the envelope the live drain produced (or the skeleton the
    connect-failure path produced, which has no segments at all),
    re-decodes whatever it still fails to cover, splices the words in,
    and returns the envelope with ``text``, ``segments``,
    ``durationSec``, ``coveredEndSec``, ``uncoveredSpeechSec`` and
    ``stats.recovery`` all describing the SAME repaired transcript.

    ``announce`` is called with the recovery budget when it exceeds what
    the stop already announced — the renderer's deadline is re-armable,
    and a bound it was never told about is not a bound.

    ``pcm`` may be a callable, and then it is only invoked once spans
    are known to exist. That is what keeps the common stop — the one
    with nothing to recover — from reading a whole recording's spool
    into memory to be told it was not needed; pass ``audio_sec``
    alongside it (from the spool's byte count) so the decision itself
    costs nothing. Passing the bytes directly is equivalent and is what
    a caller that already holds the audio does.

    Failures INSIDE the pass are absorbed here — a span that will not
    decode, a budget that runs out — and cost only the spans they
    touched. Failures of the pass itself are not: the guarantee that a
    broken recovery still ships the envelope unrepaired belongs to the
    caller, and ``backend.main._apply_live_recovery`` is where it is
    implemented and stated. Saying "never raises" here as well described
    a try/except this function does not have.
    """
    started = time.perf_counter()
    segments = list(payload.get("segments") or [])
    streamed_sec = float(payload.get("streamedSec") or 0.0)
    audio: Optional[bytes] = None if callable(pcm) else bytes(pcm)
    if audio_sec is None:
        if audio is None:
            # Off the event loop: a spool read is up to
            # ``MAX_RECOVERY_READ_BYTES`` of disk I/O (BW-13).
            audio = await asyncio.to_thread(pcm)  # type: ignore[arg-type]
        audio_sec = len(audio) / float(pcm16_bytes_per_sec(sample_rate))

    spans = uncovered_spans(
        streamed_sec,
        segments,
        evidence,
        stream_death_sec,
        audio_sec=audio_sec,
    )
    if not spans:
        logger.info("recovery: none needed")
        return payload
    if audio is None:
        audio = await asyncio.to_thread(pcm)  # type: ignore[arg-type]
    if not audio:
        logger.info("recovery: no audio spool for this session; envelope unchanged")
        return payload

    budget = recovery_budget_sec(spans)
    if announce is not None and budget > announced_recovery_sec:
        try:
            announce(budget)
        except Exception as e:  # never let an announcement break a stop
            logger.warning("recovery: budget announcement failed: %s", e)

    # The recording's own statement of how it was read: the dual facade
    # stamps its partner language on every envelope it produces.
    stats = payload.get("stats") if isinstance(payload.get("stats"), dict) else {}
    secondary_language = str(stats.get("dual_secondary_language") or "")
    words = await recover_spans(
        audio,
        spans,
        cfg,
        api_key=api_key,
        sample_rate=sample_rate,
        budget_sec=budget,
        transcribe=transcribe,
        secondary_language=secondary_language,
    )
    segments, spliced = splice_recovered_words(
        segments, words, spans, keyterms=cfg.keyterms
    )
    report = RecoveryReport(
        spans=list(spans),
        ms=(time.perf_counter() - started) * 1000.0,
        words=spliced,
    )
    logger.info(
        "recovery: spans=%d total=%.2fs → words=%d in %.0fms",
        len(report.spans),
        report.spans_sec(),
        report.words,
        report.ms,
    )

    out = dict(payload)
    out["segments"] = segments
    out["text"] = join_segment_texts(segments)
    # ``durationSec`` is how long the transcript IS — every segment,
    # including the interim hypotheses the live splice folded in.
    out["durationSec"] = round(
        max((as_float(seg.get("end")) for seg in segments), default=0.0), 3
    )
    # NOTE: the repaired payload is rebuilt through the one envelope
    # constructor at the end of this function, so a field this pass
    # forgets to carry over cannot silently disappear from the wire.
    # ``coveredEndSec`` is how far a DECODER reported: provider finals
    # and the REST re-decodes this pass just spliced, never an interim
    # hypothesis. Taking the merged end for both put them back in
    # lockstep on every repaired stop, which is the state B-006 fixed
    # for the un-repaired one — and the renderer compares exactly this
    # pair to decide whether the envelope covers the recording.
    out["coveredEndSec"] = round(decoded_end_sec(segments), 3)
    # Re-asked, not adjusted: whatever this function would still call
    # uncovered IS what is still uncovered, so the number the envelope
    # reports and the decision the recovery made can never drift apart.
    residual = missing_spans(
        streamed_sec, segments, evidence, stream_death_sec, audio_sec=audio_sec
    )
    out["uncoveredSpeechSec"] = round(
        sum(end - start for start, end in residual), 3
    )
    out["stats"] = live_final_stats(payload.get("stats"), recovery=report.as_dict())
    # One shape out, whatever came in: this pass is the last thing that
    # touches a ``final`` envelope before it is sent, so it hands the
    # wire the same constructor's output as an unrepaired stop (B-038).
    return envelope_from_result(out, source=str(payload.get("source") or ""))


__all__ = [
    "LIVE_EMPTY_RESULT_MIN_SEC",
    "RECOVERY_BUDGET_MAX_SEC",
    "RECOVERY_MIN_SPAN_SEC",
    "RECOVERY_SOURCE",
    "RECOVERY_SPAN_PAD_SEC",
    "InterimEvidence",
    "RecoveryReport",
    "covered_spans",
    "decoded_end_sec",
    "evidence_from_session",
    "missing_spans",
    "pcm_span_wav",
    "recover_spans",
    "recovery_budget_sec",
    "run_recovery",
    "splice_recovered_words",
    "uncovered_spans",
]
