"""Deepgram Nova-3 live WebSocket streaming — single source of truth.

Proxies raw PCM16 mono audio from the app's own WebSocket into Deepgram's
real streaming API (wss://api.deepgram.com/v1/listen) and normalizes the
Deepgram ``Results`` events into the app's canonical live protocol:

    {"type": "segments", "segments": [...], "is_final": bool}
    {"type": "interim",  "segment": {...}}
    {"type": "final",    "text": str, "segments": [...], "durationSec": float}
    {"type": "error",    "error": str, "fatal": bool}

Lifecycle is session-scoped: ``connect()`` opens the upstream socket and
starts a background task that drains Deepgram events into an internal
queue. ``send_pcm()`` forwards audio; ``events()`` is the async iterator
consumers iterate to receive normalized events; ``finalize()`` tells
Deepgram to flush and returns the accumulated final transcript.

Production-grade features:

* **KeepAlive frames** — a background task emits ``{"type":"KeepAlive"}``
  on the upstream every ``keepalive_interval_sec`` seconds as long as the
  socket is idle (no audio has been sent recently). This prevents
  Deepgram from auto-closing the connection during prolonged silence.
  Deepgram's documented idle timeout is ~10 s, so we default to 7 s.

* **Structured error classification** — connect failures, send failures,
  recv errors, abnormal closes, and finalize timeouts all go through
  ``_report_error`` so callers see consistent ``{"type":"error","fatal":
  bool}`` events and can decide whether to fall back.

* **Telemetry** — ``stats`` returns ``{bytes_sent, chunks_sent,
  segments_final, segments_interim, connect_ms, finalize_ms}`` so the
  caller can log upstream latency and debug stalls.

* **Single-use safety** — the class is explicitly not reentrant. All
  operations after ``close()`` are no-ops so late cleanup cannot crash
  the event loop.

This module is the ONLY place in the codebase that talks to Deepgram's
live API. Callers should never construct the URL, set headers, or parse
Results messages directly.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Iterable, Optional
from urllib.parse import parse_qsl, urlencode

import websockets
from websockets.asyncio.client import ClientConnection, connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

# All leaf modules — no import cycle, which is why these no longer sit
# 950 lines down behind six ``# noqa: E402`` markers. ``DEEPGRAM_LIVE_URL``
# comes from the same centralised host as the REST module, so a regional
# override (``TRANSCRIPTOR_DEEPGRAM_HOST``) sets both at once.
from backend.async_tasks import await_cancelled, cancel_and_await
from backend.audio_constants import LIVE_SAMPLE_RATE_HZ, pcm16_bytes_per_sec
from backend.deepgram_endpoints import DEEPGRAM_LIVE_URL
from backend.deepgram_format import shared_format_params
from backend.deepgram_keyterms import keyterm_query_pairs
from backend.deepgram_language import language_hint_pairs, resolve_live_language
from backend.deepgram_words import deepgram_word_text
from backend.model_catalog import DEFAULT_DEEPGRAM_AUDIO_MODEL

logger = logging.getLogger(__name__)


DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC = 8.0
DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC = 4.0
# How long ANY write to a Deepgram socket — audio (``backend.main``'s
# send watchdog, the dual facade's second-reading feeder) or a CONTROL
# frame (Finalize, CloseStream) — may sit unwritten before the socket
# carrying it is declared wedged and closed. One number for one idea:
# the same 5 s the old ``wait_for`` used, so a stuck socket is reported
# no later than it used to be — but by closing the connection, which
# releases the write, rather than by cancelling the write and leaving
# the connection in the undefined state ``send_pcm``'s docstring
# documents.
SEND_WEDGE_SEC = 5.0
# How long ``close()`` waits, after sending ``Finalize``, for Deepgram to
# return the transcript that Finalize flushed — before sending
# ``CloseStream``. The wait ends the moment the transcript arrives, so
# this is a ceiling, not a cost. Observed post-Finalize round trips in
# main.log land between 0.26 s and 0.73 s.
#
# 1.5 → 3.0 s (tail-truncation fix): main.log 2026-08-24 07:35 shows a
# session where the post-Finalize transcript did NOT arrive within 1.5 s
# ("no post-Finalize transcript within 1.5s; closing") and the finalize
# delta was 0 — the user's trailing clause never reached any final
# segment and the tail was lost. The ceiling only bites on exactly such
# slow/cross-region sessions; healthy ones end the wait at first
# transcript and pay nothing extra.
#
# THE one wait budget, for every shape of tail. There used to be three,
# chosen by a coverage verdict, and all three were sized on the same
# false premise: that on most stops Deepgram answers a Finalize with
# nothing at all. It always answers — with an ``is_final`` carrying an
# empty transcript when there is nothing left to flush — and that
# message was being deleted by the empty-text guard in
# ``_process_deepgram_message`` before it could arm anything (B-005).
# The 267-of-410 stops that "burned the full ceiling waiting for a
# message that was never coming", and the 9-of-9 that "waited out their
# whole window and Deepgram sent nothing", were measuring the dropped
# answer, not the provider. So the two shortened windows measured a
# symptom of a bug in this file and are gone with it.
#
# What is left is derived from the protocol rather than from a
# population: the wait ends when Deepgram has answered — words, or the
# empty final that says there are none — and this number is only the
# bound on how long that answer may take. Sized from the round trips of
# the 411 stops that did receive one (median 0.26 s, p90 0.36 s, p95
# 0.49 s) with the 2026-08-24 slow session's >1.5 s as the case the
# ceiling exists for. A healthy stop now pays its actual round trip on
# EVERY shape of tail, not just on the uncovered ones.
FINALIZE_FLUSH_WAIT_SEC = 3.0

# Tail guard: raw elapsed audio past the last finalized segment used to be
# enough, on its own, to justify a second Finalize round trip (2026-08-24
# log: 19 sessions exited on the first timeout; all benign by luck — every
# one had a flush landing exactly at Stop). That protected against a real
# loss (2026-08-24: a session with ``gap=4.01s speech_in_gap=0.00`` where
# Deepgram had gone quiet 3.7 s before Stop and never flushed a genuine
# trailing sentence) — but session f94121ae, 2026-09-04T12:26:33Z, showed
# the cost side of that trade: the ``multi`` reading logged ``0.91s of
# audio past last final (0.05s of it recognised speech)``, retried, and
# took 6010 ms to close, while the same recording's ``ru`` reading (no
# retry, tail genuinely covered) delivered the correct transcript in
# 378 ms — the merged envelope shipped 6 s after Stop because the facade
# waits for the slower reading. Audit §5 measured the retry's hit rate
# directly: 1 of 84 uncovered-but-unvoiced tails ever produced a
# transcript, at 3 s apiece.
#
# So elapsed time alone is retired as evidence. What is left is REAL
# evidence that Deepgram is sitting on unflushed speech: either an interim
# already recognised words there, or Deepgram's own decode window is still
# reaching past the last final well beyond its configured endpointing
# silence — see ``_tail_needs_flush``. ``TAIL_GUARD_MIN_SPEECH_SEC`` is the
# first of those two signals' threshold, sized from the same production
# line: one short recognised word runs about this long, and 0.05 s (the
# f94121ae case) is not a word — it is decoder noise.
TAIL_GUARD_MIN_SPEECH_SEC = 0.25


# C3 (audit §2.5): the announced budget used to describe only the flush
# wait, leaving out everything drain_transcript() still does after the
# wait resolves — the tail-guard re-measure, the interim-word splice,
# building the merged transcript. That work is CPU-bound and small, but
# a budget that omits it is not an honest upper bound on "time until the
# envelope is sent", which is the promise made to the renderer. Sized
# generously above what splice + seam-merge + dict-building take on a
# session with a few hundred segments (single-digit milliseconds) so it
# never needs revisiting for a slow machine.
FINALIZE_ASSEMBLY_ALLOWANCE_SEC = 0.15

# Seam repair: Deepgram's periodic forced flushes may cut a word in half
# across two consecutive finals ("…четыре, пя" | "ть. Далее"). When two
# finals touch within SEAM_MERGE_MAX_GAP seconds and neither side ends
# the sentence, the provider's OWN word lists decide whether the touching
# tokens are one spoken word split by the flush boundary — see
# ``_provider_split_token``. The morphological heuristic below is only
# the fallback for segments that arrived without word timings.
SEAM_MERGE_MAX_GAP_SEC = 0.05
# Splice guard (audit A/B, three real artifacts on the trilingual evidence
# recording): the number of leading alpha-core letters compared to decide
# a spliced word would sit beside a re-spelling of itself in the
# assembled text ("слушаю"/"слушай" share these five letters; "WAV"/"WAB"
# are shorter than this and so compared in full).
_SPLICE_STEM_LETTERS = 5
# Same A/B: a final that RE-TIMED a word instead of re-spelling it still
# owns that time. Requiring only 25% overlap of either word's own
# duration (not majority of the shorter one) is what stops an orphan
# interim from being spliced back in next to the final's own take on the
# same audio.
SPLICE_COVERAGE_OVERLAP_FRACTION = 0.25
# A spliced word may only land where there is room for it: the gap it
# would occupy — inside a final's own word list, or at the seam between
# two finals/fallback segments — must be at least the word's own
# duration, less this tolerance for re-decode boundary jitter.
SPLICE_GAP_SLACK_SEC = 0.05
_SEAM_VOWELS = set("аеёиоуыэюяaeiouy")
# Russian words that are a single vowel-less letter. The fallback
# heuristic ("exactly one side has no vowel ⇒ it is half a word") reads
# every one of these as a severed fragment and glues it to its
# neighbour, which is how "мы живём в" | "доме на горе" became "мы живём
# вдоме" (audit §3.3, reproduced by running the function). They are
# complete words — a preposition, a conjunction or a particle — and no
# amount of vowel counting can tell them apart from a fragment, so the
# heuristic is simply not allowed to touch them.
_SEAM_WHOLE_WORDS = frozenset(
    ("в", "с", "к", "ж", "б", "и", "у", "о", "а", "я")
)
# Interim hypotheses kept for the finalize-time hole report (§3.9). Only
# the text and the span are retained, and only the newest N, so a long
# dictation cannot grow this without bound. 40 covers several seconds of
# rolling re-decodes at the observed ~15 Hz interim rate — enough to show
# what the service was hearing around a hole.
INTERIM_HYPOTHESIS_RING_SIZE = 40
# The report never prints what the user SAID — main.log is a plain file
# users attach to support requests, and it used to hold a searchable
# three-month transcript of their dictation (BL-02). Each hypothesis is
# described by its span, its word count and its length, which is what a
# hole diagnosis reads: did Deepgram hear anything there, and how much.
# At most this many interim hypotheses are printed per hole.
_HOLE_REPORT_MAX_INTERIMS = 6
# At most this many OVERRULED words (an interim word whose audio a
# differently-spelled final word claimed) are printed. A stop with a
# handful is a diagnosis; a stop with fifty is a rule that needs
# rethinking, and the count on the header line says so without printing
# all of them. "Overruled" is deliberately not "displaced": a displaced
# word was superseded by a newer HYPOTHESIS and lives on in the orphan
# pool, an overruled one was dropped for good.
_HOLE_REPORT_MAX_OVERRULED = 12
# How many displacements are retained for that report. Bounded so a long
# dictation cannot grow the diagnostic without limit; the total is
# counted separately, so the header stays truthful when the ring wraps.
OVERRULED_WORD_RING_SIZE = 50


def _word_speech_spans(words: Iterable[dict]) -> list[tuple[float, float]]:
    """Speech spans covering ``words``, with inter-word silence bridged.

    Consecutive words closer together than ``COVERAGE_GAP_MIN_SEC`` belong
    to one run of speech; the breath between them is not a hole and must
    not be measured as one. Anything wider starts a new span, so a real
    pause inside a re-decode window stays outside the measurement.
    """
    spans: list[tuple[float, float]] = []
    for word in sorted(words, key=lambda w: (float(w["start"]), float(w["end"]))):
        start = float(word["start"])
        end = float(word["end"])
        if end <= start:
            continue
        if spans and start - spans[-1][1] <= COVERAGE_GAP_MIN_SEC:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))
    return spans


def _token_alpha_core(token: str) -> str:
    return "".join(ch for ch in token if ch.isalpha())


def _has_vowel(core: str) -> bool:
    return any(ch.lower() in _SEAM_VOWELS for ch in core)


def as_float(value: object, default: float = 0.0) -> float:
    """Numeric coercion that never raises.

    A malformed upstream message (non-numeric ``start``/``duration``)
    must not crash the receive loop, because that would terminate the
    whole recording over one stray frame.
    """
    try:
        return float(value) if value is not None else default  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def normalize_words(raw: object) -> list[dict]:
    """Parse ``alternatives[0].words`` into ``{word, start, end}`` dicts,
    plus ``confidence`` / ``language`` when Deepgram sent them.

    The ONE place a Deepgram word list becomes internal word records —
    used for interim hypotheses and for finals alike (audit §3.1). The
    display spelling comes from ``deepgram_word_text`` so the live path
    cannot disagree with the REST path about ``punctuated_word`` vs
    ``word``. Tokens without text or without a positive duration are
    dropped: they carry no evidence.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        token = deepgram_word_text(item)
        if not token:
            continue
        start = as_float(item.get("start"))
        end = as_float(item.get("end"))
        if end <= start:
            continue
        record: dict = {"word": token, "start": round(start, 3), "end": round(end, 3)}
        # Deepgram's own evidence about the word, kept when it sent it:
        # ``confidence`` on every model, ``language`` per word on
        # ``language=multi``. The dual-stream merge decides which reading
        # owns a stretch both heard differently from exactly these
        # (``backend.deepgram_dual._settle_contested_stretches``).
        if isinstance(item.get("confidence"), (int, float)):
            record["confidence"] = round(float(item["confidence"]), 3)
        language = item.get("language")
        if isinstance(language, str) and language.strip():
            record["language"] = language.strip().lower()
        out.append(record)
    return out


def word_core(word: dict) -> str:
    """Case-folded alphabetic core of a word record.

    Punctuation and capitalisation are formatting — ``punctuated_word``
    adds both — so they must not decide whether two records are the same
    spoken word ("Субагента," and "субагента" are one word).
    """
    return _token_alpha_core(str(word.get("word") or "")).casefold()


def _word_stem(word: dict) -> str:
    """First ``_SPLICE_STEM_LETTERS`` letters of a word's alpha core.

    Used only to decide whether a word about to be spliced in would sit
    beside a near-duplicate of itself in the assembled text — a stem
    match survives the kind of respelling a re-decode produces
    ("слушаю" next to "слушай", "WAV" next to "WAB") without matching
    unrelated words that merely share a prefix. Full-core equality
    (``word_core(a) == word_core(b)``) is a special case of this, so
    nothing that used to be caught stops being caught.
    """
    return word_core(word)[:_SPLICE_STEM_LETTERS]


def time_overlap(a: dict, b: dict) -> float:
    return min(as_float(a.get("end")), as_float(b.get("end"))) - max(
        as_float(a.get("start")), as_float(b.get("start"))
    )


def word_duration(word: dict) -> float:
    return max(as_float(word.get("end")) - as_float(word.get("start")), 1e-6)


def _same_spoken_word(a: dict, b: dict) -> bool:
    """Are these two word records the same spoken word?

    Identity is the alpha core plus MAJORITY temporal overlap: a rolling
    re-decode moves word boundaries by a few tens of milliseconds, so
    requiring identical times would treat every shift as a new word,
    while requiring only *some* overlap would let any neighbouring word
    stand in for this one. The rule was written once for the splice's
    orphan dedupe and is now the single definition used everywhere
    (audit §3.1/§3.2).
    """
    core = word_core(a)
    if not core or core != word_core(b):
        return False
    shortest = min(word_duration(a), word_duration(b))
    return time_overlap(a, b) > 0.5 * shortest


def word_accounted_for(word: dict, others: Iterable[dict]) -> bool:
    """Does any record in ``others`` account for ``word``?

    One predicate, three callers, because they are all asking the same
    question:

    * a final's own words vs a retained interim word — "did this final
      actually contain that word?" (the eviction, audit §3.1);
    * the newest interim's words vs an orphan — "does the newer
      hypothesis already account for this?" (the purge, audit §3.2);
    * the current interim words vs an orphan at splice time — the same
      question one last time, so a shifted re-decode is not spliced
      twice (BUG-78).

    Answering it by TIME WINDOW instead — "the final's span contains the
    word's centre" — is what deleted the word "субагента" from a
    recording whose final said "три на или если это": the span covered
    it, the transcript did not.
    """
    return any(_same_spoken_word(word, other) for other in others)


# What a segment created by the interim splice is stamped with. Read
# back by ``decoded_end_sec``: a spliced hypothesis extends the
# transcript but is not a decode, so it must never raise
# ``coveredEndSec``.
INTERIM_FALLBACK_SOURCE = "interim-fallback"


def decoded_end_sec(segments: Iterable[dict]) -> float:
    """How far a DECODER has reported on this transcript, in seconds.

    Provider finals and REST re-decodes count; interim hypotheses the
    live splice folded in (``INTERIM_FALLBACK_SOURCE``) do not — an
    interim is a guess, and this is what the envelope's
    ``coveredEndSec`` carries and the renderer reads to decide whether
    the envelope covers the recording. ``durationSec`` is the other
    number: how long the transcript IS, everything included.

    One rule, asked by the live session about its own finals and by
    ``backend.deepgram_recovery`` about the repaired transcript, so a
    stop and a repaired stop cannot mean different things by the field.
    """
    return max(
        (
            as_float(seg.get("end"))
            for seg in (segments or [])
            if seg.get("source") != INTERIM_FALLBACK_SOURCE
        ),
        default=0.0,
    )


def spanless_coverage_spans(segments: Iterable[dict]) -> list[tuple[float, float]]:
    """The merged spans of finals that arrived WITHOUT a word list.

    Their span is the only thing knowable about what they contain, so
    it is the coverage test for them — and only for them. Merged first,
    because two adjacent such finals meeting at 10.0 s cover a word
    centred exactly on the boundary that neither covers alone.
    """
    return union_spans(
        (record["start"], record["end"])
        for seg in (segments or [])
        for record in segment_word_records(seg)
        if record.get(SPANLESS_WORD_FLAG)
    )


def word_inside_spanless_final(word: dict, segments: Iterable[dict]) -> bool:
    """Is this word's CENTRE inside a final that carried no word list?

    Shared with ``backend.deepgram_recovery``: a re-decoded word landing
    inside a wordless final is already accounted for, and there is no
    covering WORD to name it — only a span. Placing it anyway would put
    the same speech in the transcript twice.
    """
    center = (as_float(word.get("start")) + as_float(word.get("end"))) / 2.0
    return any(
        c_start < center < c_end
        for c_start, c_end in spanless_coverage_spans(segments)
    )


def covering_final_word(word: dict, final_words: Iterable[dict]) -> Optional[dict]:
    """Which final word answers for ``word`` — or ``None`` if none does.

    The implementation behind ``final_words_cover``: the predicate is
    "did anything cover it", this is "what covered it", and they must
    never be able to disagree, so there is one rule and the predicate
    delegates to it.

    Naming the covering word is what makes a displacement visible. An
    interim word judged covered by a final word with a DIFFERENT
    letter core is not a recovered word and not a hole — it is the
    coverage rule deciding that the final owns that audio and spelled
    it otherwise. That decision is right for "слушаю" vs "слушай" and
    wrong for "трёх" vs "в", and telling the two apart after the fact
    needs both words and both time spans, which only this function
    knows (audit §3.4, defect "трёх").

    Two ways, and both are needed:

    * the final carries the SAME word, its boundaries shifted by the
      re-decode (``word_accounted_for``); or
    * the final's own WORDS occupy a substantial share of this word's
      time — the final heard that audio and wrote something else for
      it, whatever it spelled.

    The second clause is what a pure identity test misses, and the miss
    is visible in the output: an interim that heard "слушаю" where the
    final committed "слушай" is not a lost word, it is a disagreement,
    and splicing the loser back in ships "слушаю слушай" to the user.
    The final is the authoritative transcript for the time its words
    occupy; it is authoritative for nothing else, which is exactly why
    the gaps BETWEEN its words — where "субагента" was spoken — stay
    recoverable.

    "Substantial" is ``SPLICE_COVERAGE_OVERLAP_FRACTION`` (25%) of
    EITHER word's own duration, not a majority of the shorter one: a
    final that re-times a word — moves its boundaries enough that a
    strict majority no longer overlaps, as happened with "слушаю" vs
    "слушай" on the trilingual evidence recording — still re-decoded
    that audio and still owns it. A 0.1 s filler in the middle of a
    0.6 s word still does not amount to having transcribed it either
    way, so the fraction is checked both ways rather than dropped.
    """
    duration = word_duration(word)
    for other in final_words:
        if _same_spoken_word(word, other):
            return other
        overlap = time_overlap(word, other)
        if overlap <= 0:
            continue
        if overlap >= SPLICE_COVERAGE_OVERLAP_FRACTION * duration:
            return other
        if overlap >= SPLICE_COVERAGE_OVERLAP_FRACTION * word_duration(other):
            return other
    return None


def final_words_cover(word: dict, final_words: Iterable[dict]) -> bool:
    """Is this interim word's ground already transcribed by a final?

    See ``covering_final_word`` for the rule; this is that answer read
    as a yes/no.
    """
    return covering_final_word(word, final_words) is not None


def segment_words(segment: dict) -> list[dict]:
    words = segment.get("words")
    if not isinstance(words, list):
        return []
    return [w for w in words if isinstance(w, dict)]


# A word record synthesised from a segment that carried no word list.
# Flagged so the merge can tell "one spoken word" from "a whole clause
# we only know the span of" — see ``_same_audio`` in
# ``backend.deepgram_dual``.
SPANLESS_WORD_FLAG = "spanless"


def segment_word_records(segment: dict) -> list[dict]:
    """A segment as word records — the ONE rule for a final without words.

    Deepgram may finalize a segment with a transcript and no ``words``
    array at all. Three parts of this product have to answer "what does
    that segment account for?", and they used to answer it three ways:
    ``_spanless_coverage`` here took its span, ``covered_spans`` in
    ``backend.deepgram_recovery`` took its span, and
    ``backend.deepgram_dual.flatten_words`` took NOTHING — which deleted
    the clause from the merged transcript of every Auto recording it
    happened on (B-001, a silent, total loss of text).

    One rule, and it is the one the other two already implied: such a
    segment reads as a SINGLE word record covering its span and carrying
    its text, because the span is the only placement knowable about it
    and the text is what was said. A segment that carries real words
    reads as those words, unchanged and uncopied.

    The synthesised record is flagged ``spanless`` so a consumer that
    cares about the difference — the dual merge, which must not let one
    reading's single word stand in for the other's whole clause — can
    see it. Consumers that only ask "what ground is accounted for" do
    not need to care, and do not.
    """
    words = segment_words(segment)
    if words:
        return words
    text = str(segment.get("text") or "").strip()
    if not text:
        return []
    start = as_float(segment.get("start"))
    end = max(start, as_float(segment.get("end")))
    return [
        {
            "word": text,
            "start": start,
            "end": end,
            SPANLESS_WORD_FLAG: True,
        }
    ]


def _provider_split_token(prev: dict, nxt: dict) -> Optional[bool]:
    """Did Deepgram itself cut one spoken word across this seam?

    Returns ``None`` when either side arrived without a word list — the
    caller then falls back to the morphological heuristic, which is all
    that is knowable about a segment carrying only text.

    With both word lists in hand the question is answerable instead of
    guessable (audit §3.3). Two conditions must hold:

    * the two touching WORDS are contiguous in time (a real inter-word
      boundary inside one flush window is not a severed token), and
    * at least one of the touching text tokens is not a whole entry in
      its own segment's word list — i.e. the provider's transcript and
      its word list disagree about where that token ends, which is
      exactly what a flush cutting through a token produces.

    When both tokens ARE whole words in the provider's own list, the
    provider is telling us they are two words. Believing it is the point:
    the heuristic that did not read "в" as a word glued it to the next
    one.
    """
    p_words = segment_words(prev)
    n_words = segment_words(nxt)
    if not p_words or not n_words:
        return None
    last = p_words[-1]
    first = n_words[0]
    gap = as_float(first.get("start")) - as_float(last.get("end"))
    if abs(gap) > SEAM_MERGE_MAX_GAP_SEC:
        return False
    p_tokens = str(prev.get("text") or "").split()
    n_tokens = str(nxt.get("text") or "").split()
    if not p_tokens or not n_tokens:
        return False
    prev_whole = _token_alpha_core(p_tokens[-1]).casefold() == word_core(last)
    next_whole = _token_alpha_core(n_tokens[0]).casefold() == word_core(first)
    return not (prev_whole and next_whole)


def _looks_like_severed_pair(core_a: str, core_b: str) -> bool:
    """Fallback for segments with no word list: is this pair one word?

    Exactly one side vowel-less, both sides short, and NEITHER side a
    complete single-letter word (``_SEAM_WHOLE_WORDS``). The last clause
    is the fix: without it the rule merged "живём"+"в" → "живём в" ...
    "вдоме", i.e. it corrupted three of the most common Russian
    prepositions on every seam they happened to land on.
    """
    if not core_a or not core_b:
        return False
    if core_a.casefold() in _SEAM_WHOLE_WORDS or core_b.casefold() in _SEAM_WHOLE_WORDS:
        return False
    if max(len(core_a), len(core_b)) > 4:
        return False
    return _has_vowel(core_a) != _has_vowel(core_b)


def _fuse_word_records(head: dict, tail: dict) -> dict:
    """One word record from the two halves a final boundary severed.

    Keeps the evidence ``normalize_words`` attaches to every word: the
    dual-stream merge decides contested stretches from exactly these
    (``backend.deepgram_dual._settle_contested_stretches``), and a fused
    word without a ``language`` ends a contested run in the middle,
    sending that one word through word-by-word pairing — the
    interleaving the rule exists to stop. Confidence is the halves'
    duration-weighted mean (each half is evidence about its own share of
    the word); the language is the longer half's.
    """
    fused: dict = {
        "word": str(head.get("word") or "") + str(tail.get("word") or ""),
        "start": head.get("start"),
        "end": tail.get("end"),
    }
    halves = [w for w in (head, tail) if isinstance(w.get("confidence"), (int, float))]
    if halves:
        # ``word_duration`` is strictly positive, so the weight is too.
        fused["confidence"] = round(
            sum(float(w["confidence"]) * word_duration(w) for w in halves)
            / sum(word_duration(w) for w in halves),
            3,
        )
    tagged = [w for w in (head, tail) if isinstance(w.get("language"), str) and w["language"]]
    if tagged:
        fused["language"] = max(tagged, key=word_duration)["language"]
    return fused


def merge_seam_fragments(
    segments: list[dict],
) -> list[dict]:
    """Return ``segments`` with word fragments severed at final boundaries rejoined.

    Pure function over ``{"start", "end", "text"}`` dicts (the canonical
    finalized-segment shape), which may also carry ``words`` — the
    provider's own word list for that segment. Two adjacent segments are
    merged at the text level only when every guard below holds —
    otherwise the pair is left untouched:

    * temporal: ``next.start - prev.end <= SEAM_MERGE_MAX_GAP_SEC``
      (a real pause between utterances is never bridged);
    * prosody: ``prev.text`` does not end with sentence punctuation;
    * casing: ``next.text`` begins with a lowercase letter (a mid-sentence
      continuation, not a new sentence);
    * evidence: with word lists on both sides, ``_provider_split_token``
      decides — the provider says whether it cut a token. Without them,
      ``_looks_like_severed_pair`` falls back to morphology (exactly one
      vowel-less core, both short, neither a complete one-letter word).

    When a merge fires, the two touching WORD records are fused as well,
    so a segment's ``words`` never contradicts its own ``text``.
    """
    if len(segments) < 2:
        return segments
    out = [dict(segments[0])]
    for nxt in segments[1:]:
        prev = out[-1]
        gap = float(nxt.get("start", 0.0)) - float(prev.get("end", 0.0))
        p_text = str(prev.get("text") or "").strip()
        n_text = str(nxt.get("text") or "").strip()
        if not p_text or not n_text or gap > SEAM_MERGE_MAX_GAP_SEC:
            out.append(dict(nxt))
            continue
        if p_text[-1] in ".!?…":
            out.append(dict(nxt))
            continue
        if n_text[:1].isupper():
            out.append(dict(nxt))
            continue
        p_tokens = p_text.split()
        n_tokens = n_text.split()
        ta = _token_alpha_core(p_tokens[-1]) if p_tokens else ""
        tb = _token_alpha_core(n_tokens[0]) if n_tokens else ""
        evidence = _provider_split_token(prev, nxt)
        severed = _looks_like_severed_pair(ta, tb) if evidence is None else evidence
        if not severed:
            out.append(dict(nxt))
            continue
        # Guards passed: the two touching tokens are one spoken word.
        # Pure-function contract: edits land on the copies in ``out`` —
        # mutating ``nxt`` directly leaked changes into the caller's
        # segment list (BUG-67). The word lists are rebuilt rather than
        # mutated for the same reason: ``dict(segment)`` is shallow, so
        # the list object is still the caller's.
        prev["text"] = " ".join(p_tokens[:-1] + [p_tokens[-1] + n_tokens[0]])
        p_words = segment_words(prev)
        n_words = segment_words(nxt)
        if p_words and n_words:
            prev["words"] = [*p_words[:-1], _fuse_word_records(p_words[-1], n_words[0])]
            n_words = n_words[1:]
        nxt_rest = " ".join(n_tokens[1:])
        if nxt_rest:
            merged_nxt = dict(nxt)
            merged_nxt["text"] = nxt_rest
            if segment_words(nxt):
                merged_nxt["words"] = n_words
            out.append(merged_nxt)
        # else: next contributed only the fragment tail — fully absorbed.
    return out


# Cross-final duplicate guard: Deepgram's own endpointing documentation
# shows a word straddling an ``is_final`` boundary can be transcribed on
# BOTH sides of it ("two two" | "two two three three…"), independently
# of anything this module splices in. At most this many trailing/leading
# words are compared per seam...
CROSS_FINAL_NGRAM_MAX_WORDS = 5
# ...and only when the seam is no wider than this — a real pause means a
# genuine repeat ("да, да"), not the same word transcribed twice.
CROSS_FINAL_NGRAM_MAX_GAP_SEC = 1.0


def token_stem(token: str) -> str:
    """Same rule as ``_word_stem``, for a raw text token with no word
    record (a segment that arrived with ``text`` but no ``words``)."""
    return _token_alpha_core(token).casefold()[:_SPLICE_STEM_LETTERS]


def drop_repeated_seam_ngrams(segments: list[dict]) -> list[dict]:
    """Drop a run of words Deepgram emitted on BOTH sides of a final
    boundary.

    Nothing else in this module de-duplicates across two ALREADY-FINAL
    segments: ``merge_seam_fragments`` only rejoins one word a flush cut
    in half, and the splice guard (``insert_word_into_segment`` /
    ``fits_beside``) only stops a newly RECOVERED word from duplicating
    a final's word — neither touches two native finals that both
    transcribed the same boundary word on their own.

    Pure function over the same ``{"start", "end", "text"}`` (+ optional
    ``words``) segment shape as ``merge_seam_fragments``, meant to run
    right after it and before either ``text`` or ``segments`` is derived
    from the result — the one shared, merged list both envelope fields
    come from (audit §3.8's SSOT).

    For each consecutive pair, the LARGEST ``i`` from 1 to
    ``CROSS_FINAL_NGRAM_MAX_WORDS`` is found such that the last ``i``
    words of ``prev`` and the first ``i`` words of ``next`` match by
    STEM (``_word_stem``/``token_stem`` — the same rule the splice
    guard uses, so a re-spelling like "слушаю"/"слушай" is caught, not
    only an exact repeat). That leading run is then dropped from
    ``next``.

    A stem match alone is not enough to call it a duplicate: the same
    words spoken twice in a row are two utterances, not one straddling a
    boundary, and dropping the second occurrence would delete real
    content — measured on the trilingual evidence recording, where an
    isolated re-decode of the 57-62 s span confirmed "sub agents, sub
    agents" was said twice. So when both sides carry word timings, a
    match counts as the SAME utterance — and is dropped — only when
    EVERY matched pair of words also overlaps in TIME (by at least 25%
    of either word's own duration, the same fraction the splice guard's
    coverage rule uses): two disjoint-time occurrences of the same words
    are kept, both. Only when neither side has word timings to check
    does this fall back to the segment-level rule this function shipped
    with — the seam is no wider than ``CROSS_FINAL_NGRAM_MAX_GAP_SEC``
    — because time overlap is not answerable per word without them.
    """
    if len(segments) < 2:
        return segments
    out = [dict(segments[0])]
    for raw_nxt in segments[1:]:
        prev = out[-1]
        nxt = dict(raw_nxt)
        p_tokens = str(prev.get("text") or "").split()
        n_tokens = str(nxt.get("text") or "").split()
        p_words = segment_words(prev)
        n_words = segment_words(nxt)
        drop = 0
        if p_tokens and n_tokens:
            max_n = min(CROSS_FINAL_NGRAM_MAX_WORDS, len(p_tokens), len(n_tokens))
            if p_words and n_words:
                for i in range(max_n, 0, -1):
                    tail = [token_stem(t) for t in p_tokens[-i:]]
                    head = [token_stem(t) for t in n_tokens[:i]]
                    if not (all(tail) and tail == head):
                        continue
                    same_moment = all(
                        time_overlap(pw, nw)
                        >= SPLICE_COVERAGE_OVERLAP_FRACTION * word_duration(pw)
                        or time_overlap(pw, nw)
                        >= SPLICE_COVERAGE_OVERLAP_FRACTION * word_duration(nw)
                        for pw, nw in zip(p_words[-i:], n_words[:i])
                    )
                    if same_moment:
                        drop = i
                        break
            else:
                gap = as_float(nxt.get("start")) - as_float(prev.get("end"))
                if gap <= CROSS_FINAL_NGRAM_MAX_GAP_SEC:
                    for i in range(max_n, 0, -1):
                        tail = [token_stem(t) for t in p_tokens[-i:]]
                        head = [token_stem(t) for t in n_tokens[:i]]
                        if all(tail) and tail == head:
                            drop = i
                            break
        if drop:
            n_tokens = n_tokens[drop:]
            nxt["text"] = " ".join(n_tokens)
            if n_words:
                nxt["words"] = n_words[drop:]
        out.append(nxt)
    return out
# An interim must carry at least this much text before its span counts as
# "the service heard words here". Deepgram emits 1-2 character noise
# hypotheses during silence; those must not be mistaken for speech.
INTERIM_SPEECH_MIN_CHARS = 8
# Gaps shorter than this between consecutive finals are normal segment
# boundaries, not holes.
COVERAGE_GAP_MIN_SEC = 0.25
# When grouping retained interim words into fallback segments, a silence
# gap longer than this between two consecutive words starts a new group.
# Matches a natural inter-clause pause; smaller values would fuse words
# the user spoke several sentences apart into one run-on blob.
INTERIM_WORD_GAP_SPLIT_SEC = 1.0


# ---- Word placement: one implementation, several askers ---------------
#
# "Where does a word that the committed transcript is missing go?" is
# one question, and it now has more than one asker: the interim splice
# in this module, and the REST re-decode of an uncovered span
# (``backend.deepgram_recovery``). A second implementation would let the
# same recording be repaired two different ways depending on which path
# found the hole, so the rules live here — at module level, taking the
# segment list as an argument instead of reading ``self`` — and the
# session's own methods delegate to them.


def host_segment_for(word: dict, segments: "Iterable[dict]") -> Optional[dict]:
    """The segment a recovered word belongs INSIDE, if any.

    Word-level coverage makes holes possible in the middle of a final's
    span: "субагента" was spoken at 5.5-6.1 s inside a final covering
    4.91-9.70 s whose text omitted it. Appending such a word as a
    separate trailing segment would put it after the whole clause it
    belongs in the middle of, so it is inserted into the host segment at
    its time position instead.

    Only segments that carry a word list can host: for a segment without
    one, its span is the only thing knowable about what it contains, and
    inserting into a text we cannot position against would guess.
    """
    center = (as_float(word.get("start")) + as_float(word.get("end"))) / 2.0
    for seg in segments:
        if not segment_words(seg):
            continue
        if as_float(seg.get("start")) < center < as_float(seg.get("end")):
            return seg
    return None


def nearest_segment_word(
    segments: "Iterable[dict]", time: float, *, before: bool
) -> Optional[dict]:
    """The committed word closest to ``time`` on the requested side.

    Feeds the splice's seam guard (rule 2/3 of the A/B fix): before a
    recovered word is allowed to become — or extend — a fallback segment
    at the edge of the assembled text, this is what sits on the other
    side of the seam it would create.
    """
    best: Optional[dict] = None
    for seg in segments:
        for w in segment_words(seg):
            if before:
                if as_float(w.get("end")) <= time and (
                    best is None or as_float(w.get("end")) > as_float(best.get("end"))
                ):
                    best = w
            else:
                if as_float(w.get("start")) >= time and (
                    best is None
                    or as_float(w.get("start")) < as_float(best.get("start"))
                ):
                    best = w
    return best


def fits_beside(
    word: dict, neighbour: Optional[dict], *, neighbour_before: bool
) -> bool:
    """Same test as ``insert_word_into_segment``'s guard, for a seam
    between segments instead of a position inside one word list: no stem
    match with the word on the other side of the seam, and enough room
    for this word's own duration.
    """
    if neighbour is None:
        return True
    stem = _word_stem(word)
    if stem and stem == _word_stem(neighbour):
        return False
    gap = (
        as_float(word.get("start")) - as_float(neighbour.get("end"))
        if neighbour_before
        else as_float(neighbour.get("start")) - as_float(word.get("end"))
    )
    return gap >= word_duration(word) - SPLICE_GAP_SLACK_SEC


def insert_word_into_segment(segment: dict, word: dict) -> bool:
    """Put ``word`` into ``segment`` at its time position.

    The segment's own word list gives the position: the index is how
    many of its words start before this one. The text is edited at the
    same index so ``text`` and ``words`` keep describing one transcript;
    when the two do not have the same token count (the provider's
    transcript is not always a plain join of its words) the index is
    clamped rather than guessed at.

    Returns False, changing nothing, in two cases (audit A/B on the
    trilingual evidence recording, rules 2 and 3 of the splice guard):

    * the word would land immediately beside a word sharing its stem
      (``_word_stem`` — first ``_SPLICE_STEM_LETTERS`` letters of the
      alpha core). Such a pair is one spoken word whose boundary the
      re-decode moved, or that the two decodes spelled differently —
      "тебе тебе нужно", "посмотреть в в WAV" and "слушаю"/"слушай" are
      all this same failure. A recovery that reads as a stutter is not a
      recovery;
    * there is not enough room: the gap between this segment's own
      neighbouring words (or the segment's own start/end, at an edge) is
      shorter than the word's duration less ``SPLICE_GAP_SLACK_SEC``. A
      final that already accounts for that time in a shape the coverage
      test did not recognise must not be overwritten by force-fitting a
      word into a slot too small for it.

    ``source`` travels with the word when it carries one, so a merged or
    recovered word stays attributable in the envelope's word list.
    """
    seg_words = segment_words(segment)
    index = sum(
        1 for w in seg_words if as_float(w.get("start")) <= as_float(word.get("start"))
    )
    stem = _word_stem(word)
    neighbours = seg_words[max(0, index - 1):index + 1]
    if stem and any(_word_stem(n) == stem for n in neighbours):
        return False
    prev_word = seg_words[index - 1] if index > 0 else None
    next_word = seg_words[index] if index < len(seg_words) else None
    before_bound = (
        as_float(prev_word.get("end")) if prev_word else as_float(segment.get("start"))
    )
    after_bound = (
        as_float(next_word.get("start")) if next_word else as_float(segment.get("end"))
    )
    if after_bound - before_bound < word_duration(word) - SPLICE_GAP_SLACK_SEC:
        return False
    tokens = str(segment.get("text") or "").split()
    tokens.insert(min(index, len(tokens)), str(word.get("word") or ""))
    segment["text"] = " ".join(tokens)
    placed = {
        "word": word.get("word"),
        "start": word.get("start"),
        "end": word.get("end"),
    }
    # Deepgram's evidence about the word travels with it, exactly as on
    # the fallback-segment path below: the dual-stream merge decides who
    # owns a stretch from ``language`` and ``confidence``, and a spliced
    # word that lost them was invisible to it (measured 2026-11-20: the
    # ``uk``-tagged interim "Тобто ніби ось" survived a stretch the ``ru``
    # reading had correctly won, because the splice had dropped the tag).
    for key in ("source", "confidence", "language"):
        if word.get(key) not in (None, ""):
            placed[key] = word[key]
    seg_words.insert(index, placed)
    segment["words"] = seg_words
    # Diagnostic only (like ``source`` on the fallback segments): says
    # this segment was repaired, and by how much.
    segment["splicedWords"] = int(segment.get("splicedWords") or 0) + 1
    return True


@dataclass
class SpliceOutcome:
    """What ``splice_words_into_segments`` did, for the caller to log."""

    segments: list[dict]
    # Words put back INSIDE a segment that had omitted them.
    inserted: int = 0
    # Words that became new fallback segments of their own.
    appended: int = 0
    # How many fallback segments those words became.
    groups: int = 0

    @property
    def total(self) -> int:
        return self.inserted + self.appended


def splice_words_into_segments(
    segments: "Iterable[dict]", words: "Iterable[dict]", *, source: str
) -> SpliceOutcome:
    """Fold ``words`` into ``segments`` by time, guarded.

    Words that fall inside a segment's span go back into that segment at
    their time position; only words outside every segment become
    segments of their own, grouped at clause-length silences
    (``INTERIM_WORD_GAP_SPLIT_SEC``) and trimmed at each end until the
    boundary word both differs in stem from, and has room beside, the
    nearest committed word on that side.

    That seam guard is what stops "them" (recovered) landing next to the
    transcript's own "them", and "WAV"/"WAB" doing the same across a
    fallback-segment seam; only a group's interior is exempt, because by
    construction it is the inside of one recovered run of speech.

    The returned list is a new list; the segments themselves are the
    caller's own dicts, mutated in place where a word was inserted.
    """
    out = list(segments)
    ordered = sorted(
        words, key=lambda w: (as_float(w.get("start")), as_float(w.get("end")))
    )
    if not ordered:
        return SpliceOutcome(segments=out)

    inserted = 0
    outside: list[dict] = []
    for word in ordered:
        host = host_segment_for(word, out)
        if host is None:
            outside.append(word)
            continue
        if insert_word_into_segment(host, word):
            inserted += 1
    if not outside:
        return SpliceOutcome(segments=out, inserted=inserted)

    groups: list[list[dict]] = [[outside[0]]]
    for prev, cur in zip(outside, outside[1:]):
        if (
            as_float(cur.get("start")) - as_float(prev.get("end"))
            > INTERIM_WORD_GAP_SPLIT_SEC
        ):
            groups.append([cur])
        else:
            groups[-1].append(cur)

    trimmed_groups: list[list[dict]] = []
    for group in groups:
        group = list(group)
        while group:
            prev_word = nearest_segment_word(
                out, as_float(group[0].get("start")), before=True
            )
            if not fits_beside(group[0], prev_word, neighbour_before=True):
                group.pop(0)
                continue
            next_word = nearest_segment_word(
                out, as_float(group[-1].get("end")), before=False
            )
            if not fits_beside(group[-1], next_word, neighbour_before=False):
                group.pop()
                continue
            break
        if group:
            trimmed_groups.append(group)
    if not trimmed_groups:
        return SpliceOutcome(segments=out, inserted=inserted)

    fallback_segments = [
        {
            "start": round(as_float(group[0].get("start")), 3),
            "end": round(max(as_float(w.get("end")) for w in group), 3),
            "text": " ".join(str(w.get("word") or "") for w in group),
            "confidence": 0.0,
            "is_final": True,
            "speech_final": False,
            # The recovered words travel with the segment they became,
            # exactly like a native final's — so seam repair and coverage
            # read one shape, not two.
            "words": [dict(w) for w in group],
            # Distinguishes recovered content from native finals; the
            # frontend merges by time like any other segment, so this is
            # diagnostic metadata only.
            "source": source,
        }
        for group in trimmed_groups
    ]
    out = sorted(
        [*out, *fallback_segments],
        key=lambda s: (as_float(s.get("start")), as_float(s.get("end"))),
    )
    return SpliceOutcome(
        segments=out,
        inserted=inserted,
        appended=sum(len(group) for group in trimmed_groups),
        groups=len(fallback_segments),
    )


def join_segment_texts(segments: "Iterable[dict]") -> str:
    """SSOT join: the ONE place assembled segments become ``text``.

    ``final_text()``, ``drain_transcript()`` and the REST recovery pass
    all go through this, so ``text`` and ``segments`` in the envelope can
    never describe different transcripts (C6, audit §3.8) — they are
    built from exactly the same merged list.
    """
    parts = [str(seg.get("text") or "").strip() for seg in segments]
    return " ".join(p for p in parts if p).strip()


@dataclass
class DeepgramLiveConfig:
    """Typed configuration for a Deepgram live streaming session.

    Parameter set is restricted to what Nova-3's ``/v1/listen`` live
    endpoint actually accepts. ``detect_language`` is a pre-recorded
    endpoint feature — the live endpoint uses ``language=multi`` for
    multilingual auto-detection instead. ``numerals`` is pre-recorded
    only; the shared formatting pass covers number formatting at live
    time.

    Formatting options are not configured here — see
    ``backend.deepgram_format``, which both Deepgram paths read so the
    same recording cannot come back formatted differently depending on
    which one served it.

    Keyterm Prompting (``keyterms``) similarly comes from one shared
    parser — ``backend.deepgram_keyterms`` — for the same reason:
    both Deepgram paths must bias toward the same vocabulary.
    """

    model: str = DEFAULT_DEEPGRAM_AUDIO_MODEL
    language: str = "auto"
    # Constrained to ``LIVE_SAMPLE_RATE_HZ`` — the WS announces this
    # rate to Deepgram and the frontend downsampler targets it; any
    # override here MUST come with a matching frontend change.
    sample_rate: int = LIVE_SAMPLE_RATE_HZ
    channels: int = 1
    interim_results: bool = True
    # ``smart_format``, ``punctuate`` and ``filler_words`` are NOT fields
    # here. They are formatting, both Deepgram paths must format the same
    # way, and a per-session copy is how the two paths came to disagree.
    # ``backend.deepgram_format`` owns them; ``to_query_string`` reads
    # them from there.
    # Endpointing is the silence threshold (in ms) Deepgram uses to
    # decide a chunk is "complete enough" to seal as is_final=true.
    #
    # 1.1.18 — reverted 700 → 300 ms.
    #
    # The 700 ms bump (from the "грамматически-неточные фрагменты"
    # report) made segments grammatically richer, but the user's
    # 1.1.17 main.log showed Nova-3 multilingual on a Russian uplink
    # returning interim text continuously and NEVER emitting
    # ``is_final`` during a 14-second recording (``segments_final=0``
    # at stop time). The post-CloseStream finalize also failed to
    # arrive in time (envelope timed out at 4 s). Result: every Stop
    # fell through to the on-disk REST recovery path — a 3+ second
    # tax on every recording that the streaming path was supposed to
    # avoid.
    #
    # 300 ms matches typical conversational pause length (250–500 ms),
    # so utterance breaks reliably seal ``is_final`` segments DURING
    # streaming. The "broken fragments" concern is unrelated to this
    # window — ``punctuate`` handles sentence assembly and punctuation
    # regardless of how often individual segments are sealed. (This used
    # to credit ``smart_format``; a same-audio A/B over 280 s of Russian
    # returned byte-identical text with the flag on and off, so the
    # credit belonged to ``punctuate`` all along. See
    # ``backend.deepgram_format``.) The 700 ms bump was solving the wrong
    # axis.
    endpointing_ms: int = 300
    # Utterance end is the silence threshold that triggers
    # ``speech_final=true`` (end-of-utterance signal used downstream
    # to decide when to emit a period). 1200 ms was too aggressive
    # for conversational pauses (natural "um" breaks). 2000 ms is
    # Deepgram's recommended long-form value and prevents a thought
    # from splitting across two "final" events.
    utterance_end_ms: int = 2000
    diarize: bool = False
    # Nova-3 Keyterm Prompting terms, already normalised (see
    # ``backend.deepgram_keyterms.normalize_keyterms`` — this field
    # holds the parsed tuple, never the user's raw config string).
    # Emitted as repeated ``keyterm=`` query parameters by
    # ``to_query_string``; silently dropped for a non-Nova-3 model via
    # ``keyterm_query_pairs``.
    keyterms: tuple[str, ...] = ()
    # Nova-3 multilingual language hints (``backend.deepgram_language``),
    # sent only when ``language`` resolves to ``multi``.
    language_hints: tuple[str, ...] = ()

    def to_query_string(self) -> str:
        model = self.model or DEFAULT_DEEPGRAM_AUDIO_MODEL
        # A list of pairs, not a dict: ``keyterm`` must be repeated once
        # per term (Deepgram's documented shape for Keyterm Prompting),
        # and a dict can hold only one value per key. ``urlencode``
        # accepts a sequence of 2-tuples directly and preserves order,
        # so every existing key stays exactly where it was.
        params: list[tuple[str, str]] = [
            ("model", model),
            ("encoding", "linear16"),
            ("sample_rate", str(int(self.sample_rate))),
            ("channels", str(int(self.channels))),
            ("interim_results", _bool(self.interim_results)),
            *shared_format_params().items(),
            ("endpointing", str(int(self.endpointing_ms))),
            ("utterance_end_ms", str(int(self.utterance_end_ms))),
        ]
        if self.diarize:
            params.append(("diarize", "true"))
        # ``resolve_live_language`` is the ONE place "auto" becomes a
        # Deepgram language value; ``backend.deepgram_dual`` asks the
        # same question ("is this recording running multilingual?") and
        # must not be able to answer it differently.
        #
        # What ``multi`` measurably does to this user's Russian speech,
        # and why Auto therefore runs a second, monolingual reading, is
        # owned by ``backend.deepgram_dual``'s module docstring — the
        # module that acts on it — not restated here.
        deepgram_language = resolve_live_language(self.language)
        params.append(("language", deepgram_language))
        params.extend(language_hint_pairs(deepgram_language, self.language_hints))
        params.extend(keyterm_query_pairs(self.keyterms, model))
        return urlencode(params)


def union_spans(
    spans: "Iterable[tuple[float, float]]",
) -> list[tuple[float, float]]:
    """Merge overlapping time spans so nothing is measured twice.

    Module level because two modules measure coverage on spans now —
    this one, and ``backend.deepgram_dual``, which asks what a MERGED
    reading still fails to cover. One implementation, so the two cannot
    disagree about what "already counted" means.
    """
    merged: list[tuple[float, float]] = []
    for start, end in sorted(s for s in spans if s[1] > s[0]):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def subtract_spans(
    spans: "Iterable[tuple[float, float]]",
    covered: "Iterable[tuple[float, float]]",
) -> list[tuple[float, float]]:
    """``spans`` with every part of ``covered`` removed.

    The other half of the coverage arithmetic a merged reading needs: a
    hole one reading reported is only still a hole if the merged
    transcript put no word over it.
    """
    result: list[tuple[float, float]] = []
    blocks = union_spans(covered)
    for start, end in union_spans(spans):
        cursor = start
        for c_start, c_end in blocks:
            if c_end <= cursor:
                continue
            if c_start >= end:
                break
            if c_start > cursor:
                result.append((cursor, c_start))
            cursor = max(cursor, c_end)
            if cursor >= end:
                break
        if cursor < end:
            result.append((cursor, end))
    return result


def intersect_spans(
    spans: "Iterable[tuple[float, float]]",
    mask: "Iterable[tuple[float, float]]",
) -> list[tuple[float, float]]:
    """The parts of ``spans`` that lie inside ``mask``.

    The third of the span-arithmetic trio, kept beside the other two so
    every module that measures coverage — this one,
    ``backend.deepgram_dual``, ``backend.deepgram_recovery`` — asks the
    same implementation what "the speech inside this window" means.
    """
    blocks = union_spans(mask)
    out: list[tuple[float, float]] = []
    for start, end in union_spans(spans):
        for m_start, m_end in blocks:
            if m_end <= start:
                continue
            if m_start >= end:
                break
            lo = max(start, m_start)
            hi = min(end, m_end)
            if hi > lo:
                out.append((lo, hi))
    return union_spans(out)


def confirmed_silence_gap(
    covered_end: float,
    streamed_sec: float,
    utterance_end: Optional[float],
    speech_spans: "Iterable[tuple[float, float]]",
) -> float:
    """The trailing gap, less any silence Deepgram itself confirmed.

    C7 (audit §3.5): ``UtteranceEnd`` is Deepgram's affirmative claim
    that the utterance ended at ``last_word_end``, and it is a much
    stronger signal than "no interim has spoken up recently" — the
    absence of interims is ambiguous, because a quiet provider and a
    quiet user look identical. When one falls inside the current tail
    and nothing since has recognised speech past it, the audio beyond it
    is CONFIRMED silence rather than an unflushed tail, so the honest
    gap is only the part before the confirmation. A later interim
    carrying speech past the UtteranceEnd means the utterance resumed
    and the whole gap stands.

    Module level because the stop and the recovery pass both need it:
    the evidence would otherwise be applied on one path and ignored on
    the other, which is how a stop comes to declare a tail silent that
    the recovery then pays a REST call to re-decode.
    """
    gap = max(0.0, streamed_sec - covered_end)
    if utterance_end is None or not (covered_end <= utterance_end < streamed_sec):
        return gap
    if any(end > utterance_end for _start, end in speech_spans):
        return gap
    return max(0.0, utterance_end - covered_end)


def tail_needs_flush(
    tail_speech: float, window_overhang: float, endpointing_sec: float
) -> bool:
    """Is a trailing region worth a SECOND ``Finalize``?

    A tail is "unflushed speech" ONLY when there is actual EVIDENCE of
    it — never from elapsed time alone. Two kinds of evidence, either is
    enough: an interim already recognised at least
    ``TAIL_GUARD_MIN_SPEECH_SEC`` worth of WORDS in the uncovered span,
    or Deepgram's newest decode WINDOW still reaches past the last final
    by more than the session's configured endpointing silence.

    Both signals say the provider is still working that audio, which is
    the only condition under which asking it again can pay. Audit §5
    measured what asking on elapsed time alone cost: of 84 uncovered but
    unvoiced tails, 1 produced a transcript and 83 paid the full retry
    ceiling for nothing — session f94121ae paid 5.6 s of extra stop for
    0.05 s of decoder noise. A provider that has gone SILENT is a
    different problem with a different answer; see
    ``tail_needs_recovery``.
    """
    if tail_speech >= TAIL_GUARD_MIN_SPEECH_SEC:
        return True
    return window_overhang > endpointing_sec


def tail_needs_recovery(
    tail_gap: float,
    tail_speech: float,
    window_overhang: float,
    endpointing_sec: float,
    utterance_end_sec: float,
) -> bool:
    """Is a trailing region worth RE-DECODING from the audio spool?

    Everything ``tail_needs_flush`` fires on — the two evidence rules —
    plus the one shape neither of them can see, which is the shape that
    lost a user their last sentence.

    Rule 3, from the 2026-08-24 production session: ``gap=4.01s
    speech_in_gap=0.00``, Deepgram silent for 3.7 s before Stop, a
    genuine trailing sentence never flushed. Rules 1 and 2 both read
    signals a silent provider cannot produce, so neither of them keeps
    that case from regressing — the docstring here used to claim rule 2
    did, and a reproduction of that exact shape returned ``False``
    (B-007). What separates "the user stopped talking" from "the
    provider stopped answering" is Deepgram's own ``UtteranceEnd``: it
    owes one after ``utterance_end_ms`` of silence, so a gap longer than
    that with no UtteranceEnd inside it (``confirmed_silence_gap`` has
    already subtracted any that arrived) is the provider failing to send
    a signal it promised. That is unexplained, and the audio is sitting
    in this backend's own spool.

    The threshold is the session's configured ``utterance_end_ms`` and
    not a number of its own, because it IS that promise: below it
    Deepgram owes nothing yet, above it the silence should have been
    announced.

    Deliberately NOT the retry rule. A second ``Finalize`` to a provider
    that has gone quiet burns the full flush ceiling to be answered with
    the same silence, which is audit §5's 83-of-84. Re-decoding the span
    through the REST endpoint costs a bounded, announced budget and
    returns the words — so an unexplained gap is the recovery's business
    (``backend.deepgram_recovery`` rule (b)) and never the retry's. The
    recovery's answer is a superset of the retry's by construction, so
    the two can never disagree about a tail the stop DID wait for.
    """
    if tail_needs_flush(tail_speech, window_overhang, endpointing_sec):
        return True
    return tail_gap > max(0.0, utterance_end_sec)


def live_config(
    *,
    model: str = "",
    language: str = "",
    diarize: bool = False,
    keyterms: "Iterable[str]" = (),
    language_hints: "Iterable[str]" = (),
) -> "DeepgramLiveConfig":
    """Build a live config — the ONE builder, for every caller.

    ``DeepgramWarmPool`` keys its socket on ``to_query_string()``, so a
    second construction site that forgets a field silently hands a
    recording a socket opened with different parameters. It used to live
    in ``backend.main`` with a docstring saying "the ONE place
    backend.main constructs one" — and ``tools/deepgram_live_ab.py``,
    whose whole purpose is to measure what the app does, built its own
    through the same pool.
    """
    return DeepgramLiveConfig(
        model=model or DEFAULT_DEEPGRAM_AUDIO_MODEL,
        language=language or "auto",
        sample_rate=LIVE_SAMPLE_RATE_HZ,
        interim_results=True,
        diarize=bool(diarize),
        keyterms=tuple(keyterms or ()),
        language_hints=tuple(language_hints or ()),
    )


def _bool(value: bool) -> str:
    return "true" if value else "false"


class DeepgramLiveError(Exception):
    """Raised for unrecoverable Deepgram live session failures."""


@dataclass
class DeepgramLiveStats:
    """Telemetry for a single live session."""

    bytes_sent: int = 0
    # Bytes handed to send_pcm() for this connection, whether or not the
    # send actually reached Deepgram. ``bytes_sent`` only counts what
    # succeeded, so a mid-stream send timeout (BUG audit §3.6) silently
    # shrank it — and with it ``_tail_coverage``'s streamed_sec, which
    # made a genuinely unflushed tail look shorter than it was. This
    # field is the honest total; see ``_tail_coverage``.
    bytes_offered: int = 0
    chunks_sent: int = 0
    segments_final: int = 0
    # ``is_final`` messages with an EMPTY transcript — Deepgram's answer
    # to Finalize when nothing is buffered, and its answer to a window
    # of silence. Counted apart from ``segments_final`` on purpose: that
    # field means "committed transcript segments" and is what decides
    # whether a send failure is fatal, so an answer carrying no words
    # must not make a session that produced no transcript look like one
    # that did. See ``_note_empty_final``.
    empty_finals: int = 0
    segments_interim: int = 0
    keepalives_sent: int = 0
    connect_ms: Optional[float] = None
    finalize_ms: Optional[float] = None
    last_send_at: Optional[float] = None
    last_recv_at: Optional[float] = None
    # ``time.monotonic()`` of the last KeepAlive frame that actually
    # reached the wire. A socket held open with nothing but KeepAlives
    # (``backend.deepgram_warm``) has no other evidence that its send
    # path still works: a half-open TCP connection accepts writes into a
    # black hole, and Deepgram never answers a KeepAlive. This is the age
    # the warm pool reads before adopting a socket. Deliberately NOT in
    # ``as_dict`` — that dict is the ``stats`` field of the renderer's
    # final envelope, and this is backend liveness bookkeeping.
    last_keepalive_at: Optional[float] = None

    def as_dict(self) -> dict:
        return {
            "bytes_sent": self.bytes_sent,
            "bytes_offered": self.bytes_offered,
            "chunks_sent": self.chunks_sent,
            "segments_final": self.segments_final,
            "empty_finals": self.empty_finals,
            "segments_interim": self.segments_interim,
            "keepalives_sent": self.keepalives_sent,
            "connect_ms": self.connect_ms,
            "finalize_ms": self.finalize_ms,
        }


# Hashes of the parameter sets already written to the log this process.
_PARAMS_LOGGED: set[str] = set()


def _log_params_once(log: logging.LoggerAdapter, cfg: "DeepgramLiveConfig") -> None:
    """Log a session's parameters in full once per distinct configuration.

    The full query string, not a summary: endpointing, utterance_end_ms,
    smart_format and punctuate all change what the transcript looks like,
    and a session whose parameters are not in the log cannot be compared
    against one recorded before they were changed. But it is ~850 bytes,
    and it was written on every connection — 2.7 times a recording, 3.6 MB
    (7.4 %) of a month's log — with the user's whole personal vocabulary
    in it (BL-07). So: once per configuration in full, keyterms as a
    count only, and every later connection names the configuration by a
    short hash that points back at that line.
    """
    pairs = [(k, v) for k, v in parse_qsl(cfg.to_query_string()) if k != "keyterm"]
    redacted = urlencode(pairs)
    digest = hashlib.sha256(cfg.to_query_string().encode("utf-8")).hexdigest()[:8]
    if digest in _PARAMS_LOGGED:
        log.info("deepgram-live: params=#%s", digest)
        return
    _PARAMS_LOGGED.add(digest)
    log.info(
        "deepgram-live: params=#%s %s keyterms=%d", digest, redacted, len(cfg.keyterms)
    )


class _StreamLog(logging.LoggerAdapter):
    """Prefix every line a session writes with the reading it belongs to.

    A dual-stream recording runs two sessions in parallel, and their lines
    used to be indistinguishable — two ``is_final`` lines with the same
    times, two ``finalize ENTER`` one millisecond apart — so the log could
    not answer "which reading dropped this clause?", the very question
    the dual-stream merge exists for (BL-08). The tag is the language the
    session runs (``multi``, ``ru``, ``en``): exactly how the merge, its
    stop line and ``stats.dual_secondary_language`` name the two readings.
    """

    def process(self, msg, kwargs):
        return f"[{self.extra['stream']}] {msg}", kwargs


async def _close_socket_bounded(ws) -> None:
    """Close a Deepgram socket, never for longer than ``SEND_WEDGE_SEC``.

    The graceful close writes a close frame; on a wedged connection that
    write queues behind the one that will not complete, and
    ``websockets`` then waits out its own handshake and TCP timeouts —
    measured 73 s between "closing the socket" and the 1006 on a single
    wedged stop (2026-11-08 06:54:42 → 06:55:55, finalize_ms=81669;
    BL-09), holding the stop path, the dual partner and the re-warm the
    whole time. A close frame not accepted within the same bound any
    other write gets is a wedge: the transport is aborted, which drops
    the connection at once and makes every pending write raise. The
    graceful close is never cancelled mid-frame — the abort ends it.
    """
    closer = asyncio.ensure_future(ws.close())
    done, _pending = await asyncio.wait({closer}, timeout=SEND_WEDGE_SEC)
    if not done:
        logger.warning(
            "deepgram-live: close handshake not accepted within %.1fs; "
            "aborting the connection",
            SEND_WEDGE_SEC,
        )
        ws.transport.abort()
    for result in await asyncio.gather(closer, return_exceptions=True):
        if isinstance(result, Exception):
            logger.debug("deepgram-live: close ignored: %s", result)


class DeepgramLiveSession:
    """A single-use Deepgram streaming session.

    Not reentrant. Create one per recording, call ``connect()`` once,
    then ``send_pcm()`` for each audio chunk and iterate ``events()`` from
    a single consumer. Call ``finalize()`` at stop to drain remaining
    results and return the canonical transcript. Always ``close()`` in
    ``finally`` (``finalize()`` closes implicitly on success).
    """

    _QUEUE_SENTINEL = object()

    def __init__(
        self,
        api_key: str,
        config: Optional[DeepgramLiveConfig] = None,
        *,
        keepalive_interval_sec: float = 7.0,
        keepalive_idle_threshold_sec: float = 3.5,
        audio_offset_sec: float = 0.0,
    ):
        if not api_key:
            raise DeepgramLiveError("Deepgram API key is required")
        self._api_key = api_key
        self._cfg = config or DeepgramLiveConfig()
        self._log = _StreamLog(
            logger, {"stream": resolve_live_language(self._cfg.language)}
        )
        # Where this SOCKET's audio starts on the RECORDING's timeline
        # (B1). Deepgram times its results from the audio a connection
        # has received — "Word timings in streaming transcription
        # results are based on the audio stream itself, not the lifetime
        # of the WebSocket connection" — so a socket that is handed the
        # recording from its first byte needs no offset, and one that
        # takes over mid-recording (the warm-socket replacement in
        # ``backend.main``, which replays a bounded ring and therefore
        # starts after whatever the ring dropped) needs exactly this
        # one. Applied in ``_process_deepgram_message`` and
        # ``_streamed_seconds`` — the two points where provider numbers
        # and byte counts become session seconds — and nowhere else, so
        # segments, interim words, coverage, ``coveredEndSec`` and
        # ``streamedSec`` are all on one timeline by construction.
        self._audio_offset_sec = max(0.0, float(audio_offset_sec))
        self._keepalive_interval_sec = max(1.0, float(keepalive_interval_sec))
        self._keepalive_idle_threshold_sec = max(
            0.5, float(keepalive_idle_threshold_sec)
        )
        self._ws: Optional[ClientConnection] = None
        self._recv_task: Optional[asyncio.Task[None]] = None
        self._keepalive_task: Optional[asyncio.Task[None]] = None
        # Bounded queue: a pathological slow consumer (browser throttled,
        # renderer hung) must not be allowed to accumulate interim segments
        # unboundedly at ~15 Hz. On QueueFull, the put path drops the
        # oldest interim entry and re-enqueues; finals and errors are never
        # dropped.  See _enqueue_event below.
        self._event_queue: asyncio.Queue[object] = asyncio.Queue(maxsize=1024)
        self._queue_overflow_warned: bool = False
        self._finalized_segments: list[dict] = []
        # Spans where an interim carried real text. Deepgram can emit a
        # final that stops short of what its own interim already heard
        # and then resume the next final past the difference, leaving a
        # hole no final ever covers — words the user definitely spoke and
        # the service definitely recognised, missing from the committed
        # transcript. Keeping the interim spans lets ``finalize()``
        # measure exactly that, instead of the transcript being trusted
        # blind. Silence produces no interims, so ordinary pauses do not
        # register here.
        self._interim_speech_spans: list[tuple[float, float]] = []
        # The most recent interim's own decode window end (start +
        # duration), on the session timeline. Every ``Results`` message
        # that reaches the interim branch already carries non-empty text
        # (messages with none return earlier — see
        # ``_process_deepgram_message``), so this is exactly "the newest
        # window Deepgram reported, with non-empty text" — the raw signal
        # ``_tail_needs_flush`` rule 2 reads, distinct from
        # ``_interim_speech_spans`` (which measures RECOGNISED WORDS, not
        # the window Deepgram is still working). A final only ever
        # shrinks the gap this is compared against (``covered_end``), so a
        # stale window value from earlier in the recording harmlessly
        # stops mattering once its ground is finalized — no reset needed.
        self._latest_interim_window_end: float = 0.0
        # Retained word-level hypotheses from interims: {word, start, end}.
        #
        # Deepgram can emit a final that stops short of what its own
        # interim already heard and resume the next final past the
        # difference, leaving a hole no final ever covers (see the
        # ``_interim_speech_spans`` docstring above for a measured
        # example). The interim words are real recognitions of real
        # audio — discarding them throws away the only transcript that
        # exists for that ground. We retain them so ``finalize()`` can
        # splice exactly the words NO final covers back into the
        # committed transcript.
        #
        # Bounded by construction: each new interim supersedes prior
        # hypotheses over its own time range, and every arriving final
        # prunes the words it covers, so steady-state size tracks only
        # the currently-uncovered speech — typically near zero.
        self._interim_words: list[dict] = []
        # Orphan pool: words DISPLACED by a newer rolling hypothesis are
        # unconfirmed-but-heard speech. Deepgram occasionally never
        # re-emits such regions as finals (observed live: a 10.5 s window
        # vanished between two finals while every interim that had first
        # decoded it was itself superseded). Displaced words move here
        # instead of dying, stay subject to newer-evidence pruning, and
        # join the finalize-time hole splice.
        self._orphan_interim_words: list[dict] = []
        # Ring of the newest interim hypotheses (audit §3.9): the 1-in-5
        # sampling line records a LENGTH, so when a hole was found in a
        # shipped recording the log could not say whether the missing
        # words had ever been heard. Bounded by construction — see
        # ``INTERIM_HYPOTHESIS_RING_SIZE`` — and read only at finalize,
        # when a hole is actually being reported.
        self._interim_ring: "deque[tuple[float, float, str]]" = deque(
            maxlen=INTERIM_HYPOTHESIS_RING_SIZE
        )
        # Ring of ``(interim_word, covering_final_word)`` pairs where the
        # two are spelled differently — the drop that leaves no hole
        # behind it (see ``_note_overruled_word``). Bounded like the
        # hypothesis ring; ``_overruled_total`` keeps the count honest
        # when the ring wraps, because a report that silently caps its
        # own count is how a rule looks fine while misfiring hundreds of
        # times.
        self._overruled_words: "deque[tuple[dict, dict]]" = deque(
            maxlen=OVERRULED_WORD_RING_SIZE
        )
        self._overruled_total = 0
        self._closed = False
        # Separate "consumer-visible closed" (self._closed, flipped by
        # recv_loop.finally as soon as the upstream drops so events()
        # consumers see termination) from "close() has been called"
        # (self._close_task, the one teardown task close() shares between
        # its callers). Without this split, when recv_loop sets
        # _closed=True on its exit path and THEN a caller invokes close(),
        # the early-return at the top of close() fired, leaking the
        # upstream WebSocket socket (never sent the WS close frame) and
        # the keepalive task (never cancelled). TCP FIN-WAITs piled up
        # until OS reclaim.
        self._close_task: Optional[asyncio.Task] = None
        # Set by ``discard()``: this socket is being replaced on purpose,
        # so its teardown must not reach the consumer as an error event.
        self._discarded = False
        self._finalize_sent = False
        # Set once drain_transcript() actually enters the Finalize dance
        # (ws present, Finalize not already sent). shutdown() reads this
        # to decide whether CloseStream is its job to send — it must
        # mirror the entry condition exactly, not re-derive it from
        # ``_finalize_sent`` alone, because a Finalize send that timed
        # out leaves that flag False even though CloseStream still needs
        # to go out (see drain_transcript()/shutdown()).
        self._needs_close_stream = False
        # Set by the receive loop whenever an ``is_final`` arrives. The
        # finalize path waits on it after sending ``Finalize`` so the
        # flushed trailing transcript has a chance to come back before
        # the stream is closed. See ``FINALIZE_FLUSH_WAIT_SEC``.
        self._final_arrived = asyncio.Event()
        # ---- Deepgram's answer to Finalize when nothing is buffered ----
        #
        # It is an ``is_final`` with an EMPTY transcript, and it used to
        # be thrown away by the "no text, nothing to report" guard at the
        # top of ``_process_deepgram_message`` — above the is_final
        # branch, so it armed nothing (B-005). That is why the flush wait
        # ran to its ceiling on two thirds of all stops: the answer was
        # arriving and being deleted one line before it counted. Three
        # empirically-tuned wait windows were built on top of that
        # symptom; with the answer recorded they are not needed and are
        # gone.
        #
        # An empty final is not a transcript segment — it carries no
        # words and no text, so it must not enter ``_finalized_segments``
        # where it would extend ``durationSec`` and shadow real interim
        # words. It IS two facts: the flush has been answered, and the
        # window it names was decoded and found to contain nothing.
        # ``_empty_final_end`` is the furthest point of the second fact;
        # ``_empty_final_arrived`` is the first, cleared at each Finalize
        # so it always means "answered THIS flush".
        self._empty_final_end: float = 0.0
        self._empty_final_arrived = False
        # ``speech_final`` of the newest final of EITHER kind. The old
        # rule read it off the last finalized SEGMENT, so an empty final
        # closing the utterance after a forced-out one could not be seen.
        self._last_final_speech_final: Optional[bool] = None
        # ``last_word_end`` from the most recent Deepgram ``UtteranceEnd``
        # message (C7, audit §3.5) — an affirmative "the utterance ended
        # here" signal, fed into ``_tail_coverage`` as evidence distinct
        # from (and stronger than) mere interim silence.
        self._last_utterance_end: Optional[float] = None
        self._last_error: Optional[str] = None
        self._last_fatal: bool = False
        # ``stats.bytes_sent`` at the first FATAL error — the moment the
        # upstream stopped taking audio. Read as ``stream_death_sec``;
        # everything captured after it is recovery ground, not a hole
        # (audit §3.6/§3.7).
        self._fatal_at_bytes: Optional[int] = None
        self.stats = DeepgramLiveStats()

    # ----- Lifecycle --------------------------------------------------------

    async def connect(self, open_timeout: float = DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC) -> None:
        """Open the upstream Deepgram WebSocket and start the receive loop.

        Raises ``DeepgramLiveError`` on authentication / network failure.
        The session is unusable after a failed connect; construct a new
        one to retry.

        Default ``open_timeout`` is 8s with one 4s retry. Live capture
        cannot benefit from a 20+ second handshake: if Deepgram is not
        reachable quickly, the recording is still saved locally and the
        stop-time recovery path can decide what to do with the durable
        audio.

        On ``asyncio.TimeoutError`` we perform ONE silent retry:
          - DNS miss on attempt 1 → attempt 2 hits a warm cache.
          - Momentary TCP stall → new connection bypasses the stuck
            half-open socket.
          - Permanently dead network → attempt 2 also fails quickly,
            worst-case total 12s.
          - ``InvalidStatus`` (4xx) is NEVER retried: 401 = bad key,
            403 = no streaming entitlement, 429 = rate-limit, all
            permanent within the retry window.
          - Transport errors (OSError / WebSocketException) also not
            retried — the original error message is more actionable
            than a second identical attempt.
        """
        if self._ws is not None:
            raise DeepgramLiveError("session already connected")
        if self._closed:
            raise DeepgramLiveError("session is closed")
        url = f"{DEEPGRAM_LIVE_URL}?{self._cfg.to_query_string()}"
        headers = [("Authorization", f"Token {self._api_key}")]
        _log_params_once(self._log, self._cfg)
        self._log.info(
            "deepgram-live: connecting model=%s language=%s sr=%s timeout=%.1fs",
            self._cfg.model,
            self._cfg.language,
            self._cfg.sample_rate,
            open_timeout,
        )
        started = time.perf_counter()

        async def _attempt(budget: float):
            return await ws_connect(
                url,
                additional_headers=headers,
                open_timeout=budget,
                close_timeout=2.0,
                max_size=2 * 1024 * 1024,
                ping_interval=None,  # we manage liveness via KeepAlive frames
                ping_timeout=None,
            )

        retry_budget = DEEPGRAM_LIVE_RETRY_TIMEOUT_SEC
        try:
            try:
                self._ws = await _attempt(open_timeout)
            except asyncio.TimeoutError:
                self._log.warning(
                    "deepgram-live: connect timeout attempt=1 budget=%.1fs — retrying once with budget=%.1fs",
                    open_timeout,
                    retry_budget,
                )
                self._ws = await _attempt(retry_budget)
                self._log.info(
                    "deepgram-live: connected on retry after total_ms=%.0f",
                    (time.perf_counter() - started) * 1000.0,
                )
            except OSError as os_err:
                # 1.1.25: docstring above promised retry on "DNS miss
                # on attempt 1 -> attempt 2 hits a warm cache" but the
                # original code only retried on TimeoutError. A real
                # DNS miss raises OSError (gaierror), and TCP-RST
                # during connect raises ConnectionRefusedError (also
                # OSError). Both are transient on the post-sleep wake
                # / mobile-network-flap paths. Retry once with the
                # budget the docstring already documents.
                self._log.warning(
                    "deepgram-live: connect %s on attempt 1 (%s) — retrying once with budget=%.1fs",
                    type(os_err).__name__, os_err, retry_budget,
                )
                self._ws = await _attempt(retry_budget)
                self._log.info(
                    "deepgram-live: connected on retry after total_ms=%.0f",
                    (time.perf_counter() - started) * 1000.0,
                )
        except InvalidStatus as e:
            status = getattr(e.response, "status_code", None)
            body_text = ""
            detail = ""
            try:
                body_text = (e.response.body or b"").decode("utf-8", errors="replace")[:600]
            except Exception as body_err:
                self._log.debug("deepgram-live: failed to read error body: %s", body_err)
            # Deepgram returns structured JSON on 400: {"err_code": ...,
            # "err_msg": ..., "request_id": ...}. Parse it so the user
            # sees an actionable message instead of raw JSON.
            if body_text:
                try:
                    parsed = json.loads(body_text)
                    if isinstance(parsed, dict):
                        detail = str(
                            parsed.get("err_msg")
                            or parsed.get("message")
                            or parsed.get("reason")
                            or ""
                        ).strip()
                        if not detail and parsed.get("err_code"):
                            detail = f"code={parsed.get('err_code')}"
                        req_id = str(parsed.get("request_id") or "")
                        if req_id:
                            detail = f"{detail} (request_id={req_id[:12]})" if detail else f"request_id={req_id[:12]}"
                except (ValueError, TypeError):
                    detail = body_text
            if status == 400:
                msg = (
                    f"Deepgram rejected the live streaming parameters (HTTP 400): {detail}"
                    if detail
                    else "Deepgram rejected the live streaming parameters (HTTP 400)"
                )
            elif status == 401:
                msg = "Deepgram rejected the API key (HTTP 401)"
            elif status == 402:
                msg = "Deepgram account has insufficient credits (HTTP 402)"
            elif status == 403:
                msg = "Deepgram account does not have access to live streaming (HTTP 403)"
            elif status == 429:
                msg = "Deepgram rate limit exceeded (HTTP 429). Try again in a moment."
            elif status:
                msg = f"Deepgram handshake failed (HTTP {status}): {detail}" if detail else f"Deepgram handshake failed (HTTP {status})"
            else:
                msg = f"Deepgram handshake failed: {e}"
            self._log.error("deepgram-live: %s (raw body=%s)", msg, body_text[:200])
            raise DeepgramLiveError(msg) from e
        except asyncio.TimeoutError as e:
            # This branch fires only if BOTH the initial attempt AND the
            # retry timed out. Report the full budget we actually spent
            # so the user knows the network is genuinely unreachable,
            # not just slow.
            total_budget = open_timeout + retry_budget
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            msg = (
                f"Deepgram connect timed out after {total_budget:.1f}s "
                f"(2 attempts, elapsed={elapsed_ms:.0f}ms)"
            )
            self._log.error("deepgram-live: %s", msg)
            raise DeepgramLiveError(msg) from e
        except (WebSocketException, OSError) as e:
            msg = f"Deepgram connect failed: {e}"
            self._log.error("deepgram-live: %s", msg)
            raise DeepgramLiveError(msg) from e

        self.stats.connect_ms = (time.perf_counter() - started) * 1000.0
        # 1.1.25: socket-open + task-launch is wrapped so a
        # CancelledError fired between the two doesn't leak the open
        # WebSocket. The window is small (synchronous create_task
        # calls) but real — under heavy event-loop pressure or
        # cooperative cancellation from the caller, an open socket
        # with no recv task to drain it accumulates server-side and
        # burns the user's quota.
        try:
            self._recv_task = asyncio.create_task(
                self._recv_loop(), name="deepgram-live-recv"
            )
            self._keepalive_task = asyncio.create_task(
                self._keepalive_loop(), name="deepgram-live-keepalive"
            )
        except BaseException:
            # Cancellation or OOM between socket-open and task-launch:
            # close the orphan socket so the connection doesn't leak.
            try:
                if self._ws is not None:
                    await self._ws.close()
            except Exception:
                pass
            self._ws = None
            raise
        self._log.info(
            "deepgram-live: connected in %.0f ms", self.stats.connect_ms
        )

    def report_fatal(self, message: str) -> None:
        """Report a fatal condition the CALLER detected.

        The send pipeline lives in the caller (audit §3.6: a queue and a
        dedicated sender task, so the renderer's receive loop never
        waits on Deepgram), which means the caller is the only place
        that can notice a wedged upstream — but errors must still reach
        the consumer through the one path every other error takes, or
        the ``events()`` stream and ``last_error``/``last_fatal`` would
        disagree with what the user is told.
        """
        self._report_error(message, fatal=True)

    def note_undelivered_audio(self, nbytes: int) -> None:
        """Account for captured audio that never reached ``send_pcm``.

        ``bytes_offered`` means "audio the mic captured and the pipeline
        was asked to deliver", and coverage math reads it as the length
        of the recording (``_tail_coverage``). Bytes the caller's send
        queue had to drop — the upstream was wedged and the queue hit
        its bound — are exactly that: captured, never delivered. Without
        this they would vanish from both counters and shrink the
        measured tail, hiding a real hole behind a smaller number.
        """
        if nbytes > 0:
            self.stats.bytes_offered += int(nbytes)

    async def _send_control(self, frame: dict, *, what: str) -> bool:
        """Send a control frame, never cancelling the write.

        The rule ``send_pcm`` states and follows: ``websockets``
        documents that cancelling a ``send()`` mid-frame leaves the
        connection in an undefined state, and the 5 s ``wait_for`` that
        used to wrap the audio path is the most plausible explanation
        for the runs of consecutive hangs in audit §3.6. The same
        ``wait_for`` stayed around all three CONTROL frames, where it is
        worse: ``Finalize`` is sent at the exact moment this session
        still has to READ the transcript back off that connection.

        So a wedged write is bounded the way the audio path bounds it —
        by CLOSING the socket, which makes the pending write raise —
        rather than by cancelling the write and reading from whatever is
        left. Returns whether the frame reached the wire.
        """
        ws = self._ws
        if ws is None:
            return False
        send = asyncio.ensure_future(ws.send(json.dumps(frame)))
        guard = asyncio.ensure_future(asyncio.sleep(SEND_WEDGE_SEC))
        try:
            await asyncio.wait(
                {send, guard}, return_when=asyncio.FIRST_COMPLETED
            )
        except asyncio.CancelledError:
            # Our own cancellation. The write is still in flight and
            # must not be interrupted; close the socket so it raises,
            # and let the cancellation through.
            guard.cancel()
            await self._close_wedged_socket(ws, send, what)
            raise
        if not send.done():
            self._log.warning(
                "deepgram-live: %s send wedged (>%.1fs); closing the socket",
                what,
                SEND_WEDGE_SEC,
            )
            await self._close_wedged_socket(ws, send, what)
            return False
        guard.cancel()
        try:
            send.result()
        except ConnectionClosed:
            self._log.info("deepgram-live: %s skipped (already closed)", what)
            return False
        except (OSError, WebSocketException) as e:
            self._log.warning("deepgram-live: %s send failed: %s", what, e)
            return False
        return True

    async def _close_wedged_socket(self, ws, send: "asyncio.Future", what: str) -> None:
        """Close ``ws`` to release a write that will not complete."""
        await _close_socket_bounded(ws)
        # The write raises now that the socket is gone. Collected so it
        # is never an unretrieved task exception.
        await asyncio.gather(send, return_exceptions=True)
        self._log.info("deepgram-live: %s write released by closing the socket", what)

    async def send_pcm(self, chunk: bytes) -> None:
        """Forward a PCM16LE mono chunk to Deepgram.

        Silently no-ops when the session is already closed so callers can
        keep draining the mic until the consumer notices the close.
        Mid-stream send failures are only treated as fatal when NO final
        segments have been received yet — if we already have committed
        text, the caller will use it and a send failure just means we
        stop pushing new audio to an already-dead connection.

        The send is NEVER cancelled once started. ``websockets``
        documents that cancelling a ``send()`` mid-frame leaves the
        connection in an undefined state, and the 5-second
        ``wait_for`` that used to wrap this call did exactly that —
        which is the most plausible explanation for the observed runs of
        four consecutive hangs inside a single session (audit §3.6).
        A wedged upstream is detected by the caller instead, from the
        AGE of the audio waiting in its send queue, and answered by
        closing the socket — which makes this await raise rather than
        leaving a half-written frame behind.
        """
        if self._closed or self._ws is None:
            return
        if not chunk:
            return
        # Counted BEFORE the send is attempted (B1, audit §3.6): this is
        # audio the caller captured and offered to Deepgram, regardless
        # of whether the send below succeeds. ``bytes_sent`` below stays
        # "actually delivered" for the connect/telemetry logs; coverage
        # math needs the honest total captured, not just what got
        # through — see ``_tail_coverage``.
        self.stats.bytes_offered += len(chunk)
        try:
            await self._ws.send(chunk)
        except asyncio.TimeoutError:
            # Not ours to raise any more (see the docstring) — this is
            # the transport's own timeout surfacing as a failed send.
            # The chunk is counted as offered, never as sent.
            fatal = self.stats.segments_final == 0
            self._report_error(
                "Deepgram send timed out at the transport", fatal=fatal,
            )
            return
        except OSError as e:
            # A wedged/reset socket below the websockets layer. Same
            # policy as a protocol-level failure: fatal only while no
            # transcript has been committed.
            fatal = self.stats.segments_final == 0
            self._report_error(f"Deepgram send failed: {e}", fatal=fatal)
            return
        except ConnectionClosed as e:
            fatal = self.stats.segments_final == 0
            self._report_error(
                f"Deepgram upstream closed while sending: {e}", fatal=fatal
            )
            if not fatal:
                self._log.info(
                    "deepgram-live: send after close, degrading gracefully (%d committed segs)",
                    self.stats.segments_final,
                )
            return
        except WebSocketException as e:
            fatal = self.stats.segments_final == 0
            self._report_error(f"Deepgram send failed: {e}", fatal=fatal)
            return
        self.stats.bytes_sent += len(chunk)
        self.stats.chunks_sent += 1
        self.stats.last_send_at = time.monotonic()

    async def events(self) -> AsyncIterator[dict]:
        """Yield normalized events until the session terminates.

        The generator completes when the upstream socket closes or
        ``close()`` is called. Exactly one consumer per session.
        """
        while True:
            item = await self._event_queue.get()
            if item is self._QUEUE_SENTINEL:
                return
            assert isinstance(item, dict)
            yield item

    async def drain_transcript(
        self,
        on_budget: "Optional[Callable[[float, bool], None]]" = None,
    ) -> dict:
        """Flush Deepgram and return the final transcript — nothing else.

        This is the half of the old ``finalize()`` that produces the
        transcript: send ``Finalize``, decide and announce the wait
        budget, wait for the flush — for as many finals as it takes to
        cover the streamed tail, inside that one budget, then the
        tail-guard retry — splice uncovered interim words, merge seams
        once. It deliberately stops
        the moment the transcript is known complete — CloseStream,
        keepalive teardown and the recv-loop drain are ``shutdown()``'s
        job (C4, audit §2.4/§2.5).

        Splitting this out matters because those belong to DIFFERENT
        deadlines. Median post-Finalize round trip is a few hundred ms;
        median time from CloseStream to the socket actually closing was
        270 ms but ran as long as 5 s, spent waiting for Deepgram to tear
        down a connection whose transcript was already sitting in memory.
        A caller can now send the ``final`` envelope right after this
        returns and let ``shutdown()`` run after — the user stops paying
        for teardown, because the last thing that reaches the frontend no
        longer depends on it.

        ``on_budget`` is called once, the moment the wait budget is
        chosen and before the waiting starts, with ``(budget_sec,
        expects_more)``. The caller forwards it to the client so both
        sides of the stop share ONE deadline: the coverage analysis that
        decides how long this may take happens here, where the data is,
        and the consumer stops guessing. ``budget_sec`` is an honest upper
        bound on the time until THIS method returns (C3) — it is what the
        client should wait, not an optimistic estimate.

        Sets ``stats.finalize_ms`` to this method's own duration — the
        cost the budget promises to bound.

        Returns a dict with ``text``, ``segments``, ``durationSec``,
        ``stats``, ``uncoveredSpeechSec``, ``streamedSec`` and
        ``coveredEndSec``.
        """
        started = time.perf_counter()
        self._log.info(
            "deepgram-live: finalize ENTER segments_final=%d segments_interim=%d bytes_sent=%d",
            self.stats.segments_final, self.stats.segments_interim, self.stats.bytes_sent,
        )
        if self._ws is not None and not self._finalize_sent:
            # CloseStream is shutdown()'s responsibility, but whether it
            # is owed at all is decided by THIS entry condition — record
            # it now so shutdown() (which may run well after this method
            # returns, or not know if Finalize send itself failed) does
            # not have to re-derive it. See ``_needs_close_stream``.
            self._needs_close_stream = True
            # 1.1.25: idempotency flag is set AFTER the Finalize send
            # succeeds, NOT before. Previously a CancelledError fired
            # between the flag-set and the actual ``ws.send`` would
            # leave ``_finalize_sent=True`` even though Deepgram never
            # got the Finalize signal — a follow-up finalize() call
            # then early-returned and the trailing is_final was never
            # flushed. Moving the flag below the send-success makes
            # the flag a faithful witness of "Finalize was actually
            # delivered to Deepgram".
            # ── 1.1.19: send Finalize BEFORE CloseStream ─────────────
            #
            # Deepgram's streaming protocol supports two control msgs:
            #   • Finalize:    flushes buffered audio and emits a
            #                  final ``is_final=true`` Result message
            #                  WITHOUT closing the connection. Designed
            #                  exactly for "user pressed Stop, give me
            #                  the trailing transcript now".
            #   • CloseStream: graceful shutdown — server processes
            #                  remaining audio and closes.
            #
            # In the 1.1.18 user logs, the post-CloseStream is_final
            # was empty for EVERY long recording (env.wordCount=0)
            # despite Deepgram clearly receiving the audio (it had
            # emitted is_final segments mid-stream). Some Deepgram
            # regions appear to skip the trailing-buffer flush on
            # CloseStream alone and only emit it on an explicit
            # Finalize. Sending Finalize first guarantees that flush;
            # CloseStream then closes cleanly with the buffer already
            # emptied.
            #
            # The event is armed BEFORE the send (BUG-68): a final that
            # lands while the Finalize frame is still in flight (network
            # RTT, up to the 5 s send timeout) used to be erased by the
            # post-send clear(), forcing the full flush wait below even
            # though the answer was already in hand.
            #
            # ``_empty_final_arrived`` is armed the same way and for the
            # same reason: it must mean "Deepgram answered THIS
            # Finalize", so a mid-stream empty final (a window of
            # silence, sent while the user was still talking) cannot end
            # the wait before the flush has been answered — and an empty
            # final that lands while the frame is still in flight must
            # not be erased by a clear placed after the send.
            self._final_arrived.clear()
            self._empty_final_arrived = False
            if await self._send_control({"type": "Finalize"}, what="Finalize"):
                self._finalize_sent = True
                self._log.info(
                    "deepgram-live: Finalize sent (forces trailing is_final flush)"
                )
            elif self._ws is None or self.is_closed:
                # The socket is gone — "Finalize need not happen"; flag
                # it so a second call does not try again.
                self._finalize_sent = True

            # Give Deepgram a moment to return the transcript that
            # ``Finalize`` just flushed, BEFORE closing the stream.
            #
            # These two frames used to go out in the same millisecond, so
            # the close raced the flush. Measured across 14 sessions in
            # one main.log: sessions whose last segment arrived naturally
            # (``speech_final=true``) left 0.25 s of audio undecoded on
            # average, while sessions still mid-utterance at Stop
            # (``speech_final=false``) left 1.86 s — the trailing clause
            # the user had just spoken. That is the difference between
            # "it ended exactly where I stopped" and "the last sentence
            # is missing".
            #
            # Bounded, and short-circuited the instant the flush covers
            # the tail, so a well-behaved stream pays only its actual
            # round trip. (The clear moved ABOVE the send — BUG-68.)
            #
            # ONE ceiling, and the wait ends on Deepgram's answer rather
            # than on it. Three ceilings used to be chosen here by a
            # coverage verdict, and the two short ones existed only
            # because the answer to a Finalize with nothing buffered — an
            # ``is_final`` with an empty transcript — was being dropped
            # before it could end the wait (B-005). With that message
            # recorded there is nothing left for a shortened window to
            # buy: a covered tail is answered in a round trip and the
            # wait ends there, and a tail that needs the full ceiling is
            # exactly the one that always did.
            #
            # Coverage is still measured BEFORE the wait, because it
            # decides two other things: whether a retry is possible (and
            # so what the honest worst case is), and what the renderer is
            # told to expect.
            streamed_sec, covered_end, tail_gap, tail_speech = self._tail_coverage()
            needs_flush = self._tail_needs_flush(tail_speech, covered_end)
            flush_wait = FINALIZE_FLUSH_WAIT_SEC
            if on_budget is not None:
                # Worst case, not the expected case: an uncovered tail may
                # also pay a retry of the same ceiling. The consumer needs
                # the bound it must respect, not an optimistic estimate.
                # C3: the budget must bound the time to the ENVELOPE being
                # sent, not just the flush wait — add the fixed cost of
                # what still runs after the wait resolves (tail-guard
                # re-measure, splice, seam-merge) so the number the
                # renderer is told to trust actually covers what this
                # method obeys.
                worst_case = (
                    flush_wait * (2.0 if needs_flush else 1.0)
                    + FINALIZE_ASSEMBLY_ALLOWANCE_SEC
                )
                try:
                    on_budget(worst_case, needs_flush)
                except Exception as e:  # never let telemetry break a stop
                    self._log.warning("deepgram-live: finalize budget callback failed: %s", e)
            # ONE final is not the flush. Deepgram answers a Finalize with
            # as many ``is_final`` messages as the buffered audio needs,
            # and the first of them can cover a fraction of the tail:
            # 2026-09-03T21:42:09Z, session 62115e77 — 14.26 s streamed,
            # the first final arrived 130 ms after Finalize covering
            # 0.00-10.85 s, the wait ended there, and the second final
            # (10.85-14.26 s, "Напиши, на чем кто вас поверил.") landed
            # 2.7 s later into a transcript that had already been sent.
            #
            # So the wait ends on COVERAGE, not on arrival: after each
            # final, re-measure and keep waiting while the tail is still
            # unflushed — inside the SAME deadline computed above, which
            # is what ``on_budget`` already announced. No second Finalize
            # (the flush is in progress; another one buys nothing) and no
            # extension of the budget: the renderer was told a number and
            # this side must obey it. Exhausting it drops through to the
            # tail guard exactly as before.
            wait_started = time.perf_counter()
            deadline = wait_started + flush_wait
            finals_seen = 0
            flush_covered_tail = False
            while True:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(
                        self._final_arrived.wait(),
                        timeout=remaining,
                    )
                except asyncio.TimeoutError:
                    break
                # Re-armed BEFORE the measurement, never after it: a
                # final landing while we measure must leave the event
                # set for the next iteration rather than be erased by a
                # clear that runs after it (the BUG-68 shape, one level
                # down).
                self._final_arrived.clear()
                finals_seen += 1
                streamed_sec, covered_end, tail_gap, tail_speech = self._tail_coverage()
                if not self._tail_awaits_more_finals(tail_gap, tail_speech, covered_end):
                    flush_covered_tail = True
                    break
            waited_ms = (time.perf_counter() - wait_started) * 1000.0
            if flush_covered_tail:
                self._log.info(
                    "deepgram-live: post-Finalize finals=%d covered=%.2fs gap=%.2fs "
                    "waited=%.0fms (budget=%.2fs streamed=%.2fs speech_in_gap=%.2fs)",
                    finals_seen,
                    covered_end,
                    tail_gap,
                    waited_ms,
                    flush_wait,
                    streamed_sec,
                    tail_speech,
                )
            else:
                # The budget ran out with the tail still unflushed —
                # either nothing came at all, or the finals that came
                # did not reach the end of the streamed audio.
                # Re-measure: the reader task may have finalized more
                # segments while we were on our way here, which can
                # close a gap that was open a moment ago.
                streamed_sec, covered_end, tail_gap, tail_speech = self._tail_coverage()
                if self._tail_needs_flush(tail_speech, covered_end):
                    self._log.warning(
                        "deepgram-live: tail guard: %.2fs of audio past last final "
                        "(%.2fs of it recognised speech, window_overhang=%.2fs) "
                        "after %d post-Finalize final(s) in %.0fms; retrying "
                        "Finalize once",
                        tail_gap,
                        tail_speech,
                        self._latest_interim_window_end - covered_end,
                        finals_seen,
                        waited_ms,
                    )
                    # Armed BEFORE the retry send (BUG-68): a final
                    # landing while the frame is in flight must be seen
                    # by the wait below, not erased by a post-send clear.
                    self._final_arrived.clear()
                    self._empty_final_arrived = False
                    if await self._send_control(
                        {"type": "Finalize"}, what="tail-guard Finalize"
                    ):
                        try:
                            await asyncio.wait_for(
                                self._final_arrived.wait(),
                                timeout=FINALIZE_FLUSH_WAIT_SEC,
                            )
                            self._log.info("deepgram-live: tail guard: transcript arrived on retry")
                        except asyncio.TimeoutError:
                            self._log.warning(
                                "deepgram-live: tail guard: still silent after retry "
                                "(%.2fs uncovered, %.2fs of it speech); closing",
                                tail_gap,
                                tail_speech,
                            )
                else:
                    # State the measurement, not a conclusion. "Nothing was
                    # unflushed" was printed for any tail below the retry
                    # threshold, including half a second of real audio, and
                    # it read as proof that the tail was complete when it
                    # was nothing of the kind.
                    verdict = (
                        "nothing past the last final"
                        if tail_gap <= COVERAGE_GAP_MIN_SEC
                        else "below the retry threshold, but not empty"
                    )
                    # And say how many finals the wait actually saw:
                    # "no post-Finalize transcript" was the honest
                    # phrasing when the wait ended on the first arrival,
                    # but it now ends on coverage, so a budget can
                    # expire after several finals have landed.
                    self._log.info(
                        "deepgram-live: post-Finalize finals=%d covered=%.2fs "
                        "gap=%.2fs waited=%.0fms (budget=%.2fs streamed=%.2fs "
                        "speech_in_gap=%.2fs — %s); closing",
                        finals_seen,
                        covered_end,
                        tail_gap,
                        waited_ms,
                        flush_wait,
                        streamed_sec,
                        tail_speech,
                        verdict,
                    )
            # CloseStream, keepalive teardown, the recv-loop drain and
            # close() no longer happen here — they are shutdown()'s job,
            # run by the caller AFTER the envelope below has been sent.
            # See this method's docstring and C4.

        # Measured BEFORE the splice consumes the hypotheses: this is
        # the record of what was missing and of what was heard there
        # (audit §3.9). After the splice the words are in the
        # transcript and the evidence is gone.
        holes_before_splice = self.coverage_hole_spans()
        # BEFORE the splice, which is the only moment it can be read.
        committed_end_sec = self._committed_end_sec()
        spliced_words = self._splice_uncovered_interim_words()
        # C6 (audit §3.8): merge seams exactly once and derive BOTH
        # ``text`` and ``segments`` from the same merged list. Previously
        # ``text`` went through ``final_text()`` (which merges) while
        # ``segments`` was the raw, unmerged list — the two fields
        # described different transcripts.
        merged_segments = merge_seam_fragments(list(self._finalized_segments))
        # Deepgram can transcribe a boundary word on both sides of an
        # is_final split ("two two" | "two two three three…") with no
        # splice involved at all; this is the one place both envelope
        # fields are derived from the merged list, so it runs before
        # either is built.
        merged_segments = drop_repeated_seam_ngrams(merged_segments)
        final_text = join_segment_texts(merged_segments)
        duration_sec = 0.0
        if merged_segments:
            duration_sec = float(
                max(s.get("end", 0.0) for s in merged_segments)
            )
        self.stats.finalize_ms = (time.perf_counter() - started) * 1000.0
        # 1.1.19: explicit DELTA logging — segments_final at ENTER vs
        # EXIT shows whether the Finalize sequence actually produced
        # trailing is_final segments. If segments_final didn't increase
        # between ENTER and EXIT, we know the flush is ineffective for
        # this session (likely region/network) and recovery is the only
        # path to the trailing words. "EXIT" now marks the transcript
        # being complete and ready to send, not the socket being closed
        # (C4) — that is logged separately by shutdown().
        self._log.info(
            "deepgram-live: finalize EXIT %.0f ms text_len=%d segments_final=%d (delta from ENTER) duration_sec=%.2f bytes_sent=%d",
            self.stats.finalize_ms,
            len(final_text),
            self.stats.segments_final,
            duration_sec,
            self.stats.bytes_sent,
        )
        uncovered_speech_sec = self._uncovered_speech_sec()
        if uncovered_speech_sec > 0:
            self._log.warning(
                "deepgram-live: %.2fs of recognised speech is not covered by any "
                "final segment — the committed transcript has holes",
                uncovered_speech_sec,
            )
        # Displacements trigger the block on their own: they are the one
        # loss shape that produces neither a splice nor uncovered
        # seconds, so gating the report on those two would have kept it
        # silent for exactly the defect it was extended to explain.
        # Read after the splice, which is the second place a hypothesis
        # can be discarded for being covered.
        if spliced_words or uncovered_speech_sec > 0 or self._overruled_total:
            self._log_coverage_holes(
                holes_before_splice, spliced_words, uncovered_speech_sec
            )
        streamed_sec = self._streamed_seconds(self.stats.bytes_sent)
        return {
            "text": final_text,
            "segments": merged_segments,
            "durationSec": round(duration_sec, 3),
            "stats": self.stats.as_dict(),
            # Seconds where Deepgram's own interims recognised words that
            # no final segment ever covered — see the WS handler's field
            # documentation next to this envelope key.
            "uncoveredSpeechSec": round(uncovered_speech_sec, 3),
            # C5: bytes actually delivered to Deepgram (not merely
            # captured — see ``bytes_offered``/``_tail_coverage`` for
            # that distinction), so the renderer can tell "the mic
            # captured N seconds" from "Deepgram actually processed N
            # seconds" without guessing from ``durationSec`` alone.
            "streamedSec": round(streamed_sec, 3),
            # End of the last COMMITTED final — the point up to which
            # the transcript is a provider final, as opposed to spliced
            # interim fallback or nothing at all. Measured before the
            # splice by ``_committed_end_sec``; it is deliberately NOT
            # ``durationSec``, and the renderer compares the two.
            "coveredEndSec": round(committed_end_sec, 3),
        }

    async def shutdown(self, wait_timeout: float = 3.0) -> None:
        """Release the upstream connection after drain_transcript().

        Sends ``CloseStream`` (if drain_transcript() actually entered the
        Finalize dance — see ``_needs_close_stream``), cancels the
        keepalive task, waits up to ``wait_timeout`` for the recv loop to
        drain, then calls ``close()``. Every step is best-effort and
        independently guarded (matching ``close()``'s own idempotency),
        so this is safe to call even if drain_transcript() raised, or
        was never called at all.

        Deliberately does not touch anything drain_transcript() already
        produced — the transcript is done and, by the time a caller
        invokes this, likely already on the wire to the client (C4).
        """
        if self._ws is not None and self._needs_close_stream:
            if await self._send_control(
                {"type": "CloseStream"}, what="CloseStream"
            ):
                self._log.info("deepgram-live: CloseStream sent")

        await cancel_and_await(
            self._keepalive_task, what="deepgram keepalive loop", log=self._log
        )

        if self._recv_task is not None:
            try:
                await asyncio.wait_for(self._recv_task, timeout=wait_timeout)
            except asyncio.TimeoutError:
                self._log.warning(
                    "deepgram-live: recv drain timeout (%.2fs)", wait_timeout
                )
                await cancel_and_await(
                    self._recv_task, what="deepgram receive loop", log=self._log
                )

        await self.close()

    async def finalize(
        self,
        wait_timeout: float = 3.0,
        on_budget: "Optional[Callable[[float, bool], None]]" = None,
    ) -> dict:
        """Back-compat convenience: ``drain_transcript()`` then ``shutdown()``.

        Existing callers that want "give me the transcript and clean
        everything up, in one call" still get exactly that behaviour.
        The WS handler calls the two halves separately so it can send the
        ``final`` envelope in between — see ``drain_transcript()``'s
        docstring and C4.
        """
        result = await self.drain_transcript(on_budget=on_budget)
        await self.shutdown(wait_timeout=wait_timeout)
        return result

    def _word_covered_by_finals(self, word: dict) -> bool:
        """Is this interim word already in the committed transcript?

        Coverage is a property of WORDS, not of message windows (audit
        §3.1). A final answers for the words it carries; only a final
        that arrived without a word list falls back to its span, because
        then the span is the sole thing knowable about it.
        """
        return (
            self._covering_final_word_for(word) is not None
            or self._word_covered_by_spanless_final(word)
        )

    def _covering_final_word_for(self, word: dict) -> Optional[dict]:
        """The final WORD that answers for ``word``, across all finals.

        The first half of ``_word_covered_by_finals``, separated because
        the splice needs to NAME the word that overruled a hypothesis
        it is about to discard, not merely know that one exists.
        """
        for seg in self._finalized_segments:
            seg_words = segment_words(seg)
            if not seg_words:
                continue
            owner = covering_final_word(word, seg_words)
            if owner is not None:
                return owner
        return None

    def _word_covered_by_spanless_final(self, word: dict) -> bool:
        """The other half: finals that arrived without a word list.

        They are merged into one span first — two adjacent finals
        meeting at 10.0 s cover a word centred exactly on the boundary,
        which neither of them covers on its own. There is no covering
        WORD to name in this case, only a span.
        """
        return word_inside_spanless_final(word, self._finalized_segments)

    def _note_overruled_word(self, word: dict, owner: dict) -> None:
        """Record an interim word a DIFFERENTLY-SPELLED final answered for.

        The coverage rule's second clause: the final overlapped that
        audio by at least ``SPLICE_COVERAGE_OVERLAP_FRACTION`` of either
        word and wrote something whose letter core differs, so the
        interim word is dropped as a disagreement the final wins.

        That is right for "слушаю" vs "слушай" (one word, two
        spellings) and wrong for "трёх" vs "в" (two words, one of them
        gone) — 2026-09-03, session a9fd3fd9, where "трёх" lived only
        in an interim and never reached the user. Nothing in the log
        told the two shapes apart, so the rule could not be fixed from
        evidence. This IS that evidence and only that: the rule is
        unchanged.

        It has to be recorded at the moment of the drop, because that
        is the only moment both words exist together — the eviction
        deletes the interim word, and by finalize there is nothing left
        to notice. Copies are stored so a later splice into the host
        segment cannot rewrite the record.
        """
        core = word_core(word)
        # An owner found by identity shares the core by construction
        # (``_same_spoken_word``), so this keeps exactly the
        # overlap-clause cases — the ones where a word went missing.
        if not core or core == word_core(owner):
            return
        self._overruled_total += 1
        self._overruled_words.append((dict(word), dict(owner)))

    def _evict_words_covered_by(
        self, words: list[dict], final_words: list[dict]
    ) -> list[dict]:
        """Drop the retained words this final answers for, and say which.

        The eviction itself is unchanged (``covering_final_word`` is the
        same rule ``final_words_cover`` asks); it now names the covering
        word on its way past so a displacement leaves a trace.
        """
        kept: list[dict] = []
        for word in words:
            owner = covering_final_word(word, final_words)
            if owner is None:
                kept.append(word)
            else:
                self._note_overruled_word(word, owner)
        return kept

    def _spanless_coverage(self) -> list[tuple[float, float]]:
        """Merged spans of the finals that carry no word list.

        Their span is the only thing knowable about what they contain,
        so it stays the coverage test for them — and only for them.
        Read through ``segment_word_records``, the one rule for what such
        a final accounts for, so this module, the dual merge and the
        recovery pass cannot answer that question differently.
        """
        return spanless_coverage_spans(self._finalized_segments)

    def _host_final_for(self, word: dict) -> Optional[dict]:
        """This session's finals asked ``host_segment_for``."""
        return host_segment_for(word, self._finalized_segments)

    def _nearest_final_word(self, time: float, before: bool) -> Optional[dict]:
        """This session's finals asked ``nearest_segment_word``."""
        return nearest_segment_word(self._finalized_segments, time, before=before)

    def _splice_uncovered_interim_words(self) -> int:
        """Fold interim-recognised words no final ever covered into the
        committed transcript, in time order.

        Returns the number of words spliced. After this runs,
        ``_uncovered_speech_sec`` measures only speech Deepgram itself
        never hypothesised — the honest residual, not the recoverable
        loss it used to be.
        """
        # Orphan-vs-interim dedupe (BUG-78): a word displaced to the
        # orphan pool can be re-emitted by a LATER interim at shifted
        # times — the rolling re-decode moves word boundaries. Both
        # copies would survive the coverage test and the splice would
        # emit the same spoken word twice. ``word_accounted_for`` is the
        # same predicate the interim purge uses; the interim copy wins
        # (newer hypothesis). Legit repeats ("да, да") have disjoint
        # times and survive.
        candidates_deduped = [
            w for w in self._orphan_interim_words
            if not word_accounted_for(w, self._interim_words)
        ]
        candidates = self._interim_words + candidates_deduped
        if not candidates:
            self._orphan_interim_words = []
            return 0
        # Hypotheses are consumed exactly once: whether they were
        # spliced or judged covered-and-discarded here, keeping them
        # would let a second finalize() call splice duplicates.
        orphan_count = len(self._orphan_interim_words)
        self._interim_words = []
        self._orphan_interim_words = []
        if orphan_count:
            self._log.info(
                "deepgram-live: splice pool included %d orphaned interim words",
                orphan_count,
            )
        survivors: list[dict] = []
        for word in sorted(candidates, key=lambda w: (w["start"], w["end"])):
            owner = self._covering_final_word_for(word)
            if owner is not None:
                # The second place a hypothesis is discarded for being
                # covered — same rule, same record (``_note_overruled_word``).
                self._note_overruled_word(word, owner)
                continue
            if self._word_covered_by_spanless_final(word):
                continue
            survivors.append(word)
        if not survivors:
            return 0

        # Placement is not this method's job (``splice_words_into_segments``
        # — the ONE implementation, shared with the REST recovery pass in
        # ``backend.deepgram_recovery``). This method's job is deciding
        # WHICH hypotheses deserve placing, which is what everything
        # above does.
        outcome = splice_words_into_segments(
            self._finalized_segments, survivors, source=INTERIM_FALLBACK_SOURCE
        )
        self._finalized_segments = outcome.segments
        if outcome.appended:
            self._log.warning(
                "deepgram-live: spliced %d uncovered interim words across %d "
                "fallback segment(s) into the final transcript "
                "(+%d word(s) put back inside the finals that omitted them)",
                outcome.appended,
                outcome.groups,
                outcome.inserted,
            )
        elif outcome.inserted:
            self._log.warning(
                "deepgram-live: spliced %d uncovered interim word(s) back "
                "into the finals that omitted them",
                outcome.inserted,
            )
        return outcome.total

    def _log_coverage_holes(
        self,
        holes: list[tuple[float, float]],
        spliced_words: int,
        uncovered_sec: float,
    ) -> None:
        """One block naming every hole and what was heard over it.

        Audit §3.9: the per-interim sampling line records a LENGTH, so
        when words went missing from a shipped recording the log could
        not say whether Deepgram had ever heard them — the question that
        took a re-run of the audio to answer. This prints, once per
        stop and only when something was actually missing, each hole
        span next to the interim hypotheses that overlapped it.

        The overruled words recorded during the session
        (``_note_overruled_word``) are listed too: they are the other
        way a word goes missing, the one that leaves no hole behind
        because a differently-spelled final word claimed its audio.
        They belong in this block rather than one of their own so that
        a reader chasing a missing word has exactly one place to look.

        Bounded on every axis: the ring holds the newest
        ``INTERIM_HYPOTHESIS_RING_SIZE`` hypotheses, at most
        ``_HOLE_REPORT_MAX_INTERIMS`` are printed per hole, at most
        ``_HOLE_REPORT_MAX_OVERRULED`` overruled words are printed, and
        and no line carries the dictated words themselves — only spans,
        word counts and lengths (BL-02).
        """
        overruled = list(self._overruled_words)
        lines = [
            "deepgram-live: coverage holes at finalize "
            f"(spliced_words={spliced_words} uncovered={uncovered_sec:.2f}s "
            f"holes={len(holes)} overruled={self._overruled_total})"
        ]
        if not holes:
            lines.append("  (no hole spans — words were recovered before measuring)")
        for h_start, h_end in holes:
            lines.append(
                f"  hole {h_start:.2f}-{h_end:.2f}s ({h_end - h_start:.2f}s)"
            )
            touching = [
                (i_start, i_end, text)
                for i_start, i_end, text in self._interim_ring
                if i_end > h_start and i_start < h_end
            ]
            if not touching:
                lines.append("    interim: (none retained for this span)")
                continue
            for i_start, i_end, text in touching[-_HOLE_REPORT_MAX_INTERIMS:]:
                lines.append(
                    f"    interim [{i_start:.2f}-{i_end:.2f}] "
                    f"words={len(text.split())} chars={len(text)}"
                )
        if overruled:
            lines.append(
                "  overruled interim words — judged covered by a "
                f"DIFFERENT final word ({self._overruled_total}):"
            )
            for word, owner in overruled[:_HOLE_REPORT_MAX_OVERRULED]:
                lines.append(
                    "    overruled interim "
                    f"[{as_float(word.get('start')):.2f}-"
                    f"{as_float(word.get('end')):.2f}] "
                    f"chars={len(str(word.get('word') or ''))} → final "
                    f"[{as_float(owner.get('start')):.2f}-"
                    f"{as_float(owner.get('end')):.2f}] "
                    f"chars={len(str(owner.get('word') or ''))} "
                    f"(overlap {max(0.0, time_overlap(word, owner)):.2f}s)"
                )
            not_shown = self._overruled_total - min(
                len(overruled), _HOLE_REPORT_MAX_OVERRULED
            )
            if not_shown > 0:
                lines.append(f"    … {not_shown} more not shown")
        self._log.info("\n".join(lines))

    def _streamed_seconds(self, byte_count: int) -> float:
        """PCM bytes as a position on the RECORDING's timeline.

        The byte-count half of the one offset (see
        ``audio_offset_sec``): a socket that took over mid-recording has
        only its own bytes, so without the shift its "streamed" seconds
        would be measured from its own start while every timestamp it
        reports is measured from the recording's — and the tail-gap
        between the two would be pure fiction. One conversion, used by
        both the coverage measurement and the envelope's
        ``streamedSec``, so they cannot drift apart.
        """
        return self._audio_offset_sec + byte_count / float(
            pcm16_bytes_per_sec(self._cfg.sample_rate)
        )

    def _tail_coverage(self) -> tuple[float, float, float, float]:
        """What is unflushed at the end of the stream.

        Returns ``(streamed_sec, covered_end_sec, tail_gap_sec,
        tail_speech_sec)``.

        ``tail_gap_sec`` is raw audio past the last finalized segment.
        ``tail_speech_sec`` is the part of that gap where an interim
        actually *recognised words*.

        The distinction is the whole point. A user finishes a sentence
        and then reaches for the stop hotkey, so almost every recording
        ends with a second or two of streamed silence. Measured by audio
        alone, that silence reads as "unflushed tail" and triggers the
        retry path — a 3 s wait, a second Finalize, another 3 s wait —
        to discover that Deepgram had nothing to send, because there was
        nothing there. Observed in main.log: a 54.0 s recording whose
        last final ended at 52.08 s spent 6272 ms at finalize and
        spliced nothing, twice over in consecutive sessions.

        With ``interim_results`` on, Deepgram emits a hypothesis as it
        decodes, so a trailing region that produced no interim produced
        no words — and a Finalize cannot flush words that were never
        decoded. Speech is therefore the signal that says whether
        waiting can possibly pay.

        Derived entirely from state we already hold, so it can be
        consulted *before* deciding how long to wait rather than only
        after a wait has expired.

        ``streamed_sec`` is deliberately ``max(bytes_offered, bytes_sent)``
        rather than ``bytes_sent`` alone (B1, audit §3.6): a mid-stream
        send timeout drops the chunk from ``bytes_sent`` but the audio
        was still captured, so using the smaller, "actually delivered"
        count would shrink ``tail_gap`` and could hide a real hole. A
        session that never drops a send has ``bytes_offered ==
        bytes_sent`` and this is a no-op.
        """
        streamed_sec = self._streamed_seconds(
            max(self.stats.bytes_offered, self.stats.bytes_sent)
        )
        # Deepgram has ANSWERED for the audio up to here — with words in
        # a final, or with an empty final saying that window held none.
        # The second kind is coverage just as much as the first: audio
        # the decoder looked at and reported nothing in is not an
        # unflushed tail, and counting it as one is what kept a stop
        # waiting for words the provider had already denied (B-005).
        covered_end = max(
            max(
                (float(seg.get("end", 0.0) or 0.0) for seg in self._finalized_segments),
                default=0.0,
            ),
            self._empty_final_end,
        )
        raw_tail_gap = streamed_sec - covered_end
        # Recognised speech lying past the last final. Spans are clipped
        # to the uncovered region and merged, so overlapping interims
        # (a rolling re-decode emits many) cannot be counted twice.
        tail_speech = 0.0
        if raw_tail_gap > 0 and self._interim_speech_spans:
            clipped = sorted(
                (max(start, covered_end), min(end, streamed_sec))
                for start, end in self._interim_speech_spans
                if end > covered_end
            )
            merged_end = covered_end
            for start, end in clipped:
                if end <= start:
                    continue
                start = max(start, merged_end)
                if end > start:
                    tail_speech += end - start
                    merged_end = end
        # UtteranceEnd evidence (C7, audit §3.5) — one implementation,
        # shared with the recovery pass so a signal collected here is not
        # silently ignored there. See ``confirmed_silence_gap``.
        tail_gap = confirmed_silence_gap(
            covered_end,
            streamed_sec,
            self._last_utterance_end,
            self._interim_speech_spans,
        )
        return streamed_sec, covered_end, tail_gap, tail_speech

    def _tail_needs_flush(self, tail_speech: float, covered_end: float) -> bool:
        """Is the trailing region worth a SECOND ``Finalize``?

        A tail is "unflushed speech" ONLY when there is actual EVIDENCE of
        it — never from elapsed time alone. Two kinds of evidence, either
        is enough:

        1. an interim already recognised at least
           ``TAIL_GUARD_MIN_SPEECH_SEC`` worth of WORDS somewhere in the
           uncovered span (``tail_speech``); or
        2. the newest interim's own decode WINDOW — regardless of how many
           words it has produced — still reaches past ``covered_end`` by
           more than the session's configured endpointing silence window.
           Deepgram reporting a window that long past the last final,
           with non-empty text, is the provider itself saying it is still
           working that audio; a window that has caught up to (or fallen
           behind) the last final is not.

        This used to gate on UNCOVERED AUDIO instead — ``tail_gap`` alone,
        reasoning that with ``interim_results`` on, a region producing no
        interim produced no words, so absence of an interim was itself
        suspicious. That was true once: a 2026-08-24 production session
        showed ``gap=4.01s speech_in_gap=0.00s`` where Deepgram had gone
        quiet 3.7 s before Stop and never flushed a genuine trailing
        sentence — a provider that goes quiet and a user who stops
        talking looked identical on any speech-only signal.

        But gap-alone is a proxy, and audit §5 measured what the proxy
        actually cost across 84 such uncovered-but-unvoiced tails: 1
        produced a transcript. The other 83 paid the full retry — 3 s
        each — for nothing. Session f94121ae, 2026-09-04T12:26:33Z, is
        one of the 83: ``0.91s of audio past last final (0.05s of it
        recognised speech)``, retried, 6010 ms to close — while the same
        recording's other reading, with a genuinely covered tail, closed
        in 378 ms. The merged envelope is only as fast as the slower of
        the two, so this one retry cost the user 5.6 s of extra wait for
        a transcript the retry never improved.

        Rule 2 was CLAIMED to keep the 2026-08-24 case from regressing
        without reintroducing gap-alone, on the grounds that it does not
        require RECOGNISED words (the thing that session had none of),
        only that Deepgram's decoder is still visibly reaching into that
        audio. It does not: a provider that has gone quiet emits no
        interim either, so its decode window never overhangs and rule 2
        returns ``False`` on exactly the shape it was said to protect —
        reproduced, B-007. The ``tail_gap`` parameter this method took
        and never read was the other half of that unfinished transition.

        A silent provider is a real loss and it is answered where it can
        be answered — by re-decoding the span from this backend's own
        audio spool (``tail_needs_recovery``, rule 3), not by asking a
        mute socket a second time. This method stays the RETRY question
        and stays on evidence only.
        """
        return tail_needs_flush(
            tail_speech,
            self._latest_interim_window_end - covered_end,
            self.endpointing_sec,
        )

    def _tail_needs_recovery(
        self, tail_gap: float, tail_speech: float, covered_end: float
    ) -> bool:
        """Is the trailing region worth re-decoding? See ``tail_needs_recovery``."""
        return tail_needs_recovery(
            tail_gap,
            tail_speech,
            self._latest_interim_window_end - covered_end,
            self.endpointing_sec,
            self.utterance_end_sec,
        )

    def _last_final_ended_the_utterance(self) -> bool:
        """Did the newest final claim to end where the speaker stopped?

        ``speech_final=true`` is Deepgram saying it closed the utterance
        at an endpoint it detected; ``false`` says the final was forced
        out mid-utterance (which is exactly what ``Finalize`` does), so
        more of the same utterance may still be on its way.

        True when there is no final to judge: the caller only consults
        this to decide whether to keep waiting, and "we have heard
        nothing at all" is a question ``_tail_needs_flush`` answers on
        the audio, which is the stronger signal.

        Read off the newest final of EITHER kind, not off the newest
        finalized SEGMENT: an empty final never becomes a segment
        (``_note_empty_final``), so an utterance closed by one used to
        be judged on the forced-out final before it and read as "more is
        coming" forever.
        """
        if self._last_final_speech_final is None:
            return True
        return bool(self._last_final_speech_final)

    def _tail_awaits_more_finals(
        self, tail_gap: float, tail_speech: float, covered_end: float
    ) -> bool:
        """Is the post-Finalize flush still incomplete?

        Asked after each final that lands during the flush wait, to
        decide whether the wait has been answered or only partly
        answered. Two ways it can still be owed:

        * the tail is uncovered by the same measure the retry uses
          (``_tail_needs_flush``) — the flush has not reached the end of
          the streamed audio; or
        * the newest final was forced out mid-utterance
          (``speech_final=false``) and something, however small, still
          lies past it. Deepgram splits a forced flush across finals,
          and the continuation carries the rest of that clause.

        A gap no larger than ``COVERAGE_GAP_MIN_SEC`` is segment-boundary
        jitter, not a tail (the same floor the budget uses), so it ends
        the wait whatever ``speech_final`` said — otherwise every stop
        landing mid-utterance would burn its whole budget on a sliver.
        """
        if self._tail_needs_flush(tail_speech, covered_end):
            return True
        if self._empty_final_arrived:
            # Deepgram answered THIS Finalize with "nothing buffered".
            # That is the end of the flush, stated by the only party
            # that can state it — there is no second final still owed,
            # whatever ``speech_final`` said on the one before it. The
            # evidence test above still overrides, so a tail with real
            # unflushed speech in it is not closed by this.
            return False
        if tail_gap <= COVERAGE_GAP_MIN_SEC:
            return False
        return not self._last_final_ended_the_utterance()

    def _final_coverage(self) -> list[tuple[float, float]]:
        return union_spans(
            (as_float(s.get("start")), as_float(s.get("end")))
            for s in self._finalized_segments
        )

    def _uncovered_word_spans(self) -> list[tuple[float, float]]:
        """Spans of retained interim words no final accounts for.

        The raw evidence, unclipped: these are exactly the words the
        splice is about to recover, so the finalize report can name the
        ground they were found on even when it lies outside anything the
        span-level measurement can see (a hypothesis too short to count
        as speech still carries real words).
        """
        return union_spans(
            (as_float(w.get("start")), as_float(w.get("end")))
            for w in (*self._interim_words, *self._orphan_interim_words)
            if not self._word_covered_by_finals(w)
        )

    def _word_level_holes(self) -> list[tuple[float, float]]:
        """Spans of interim-heard words that no final WORD accounts for.

        Clipped to the ground the finals CLAIM to cover, because that is
        exactly where the span-level measurement below is structurally
        blind: contiguous finals leave no gap to measure, and a word
        they simply failed to transcribe disappears without trace
        (audit §3.4 — the 12 s recording whose finals ran 0-4.91-9.70-
        12.11 and whose metric read 0 while "субагента" was gone).

        No minimum applies here. A hole this measurement can see is a
        specific missing WORD, and one word is a few hundred
        milliseconds — the 0.25 s floor that keeps segment-boundary
        jitter out of the span measurement would discard every one of
        them.
        """
        covered = self._final_coverage()
        if not covered:
            return []
        clipped: list[tuple[float, float]] = []
        for w_start, w_end in self._uncovered_word_spans():
            for c_start, c_end in covered:
                lo = max(w_start, c_start)
                hi = min(w_end, c_end)
                if hi > lo:
                    clipped.append((lo, hi))
        return union_spans(clipped)

    def coverage_hole_spans(self) -> list[tuple[float, float]]:
        """Every span this session believes is missing from the transcript.

        Public because a second reading of the same audio
        (``backend.deepgram_dual``) has to know WHERE this one failed in
        order to say whether the merged transcript still fails there.

        The union of the word-level evidence — unclipped, so a region no
        final reached at all is named too — with the span-level holes.
        Used for the finalize report (audit §3.9), which needs the
        SPANS; ``_uncovered_speech_sec`` needs a total instead and
        charges each region to exactly one measurement.
        """
        return union_spans([*self._uncovered_word_spans(), *self._span_level_holes()])

    def _span_level_holes(self) -> list[tuple[float, float]]:
        """Spans where an interim heard speech and no final landed at all.

        The original measurement, unchanged: interim speech minus final
        coverage, with sub-``COVERAGE_GAP_MIN_SEC`` slivers dropped as
        segment-boundary jitter. It is the only thing available for a
        hypothesis that arrived without word timings, and it is what
        sees a region no final reached.
        """
        if not self._finalized_segments or not self._interim_speech_spans:
            return []
        covered = self._final_coverage()
        speech = union_spans(self._interim_speech_spans)
        holes: list[tuple[float, float]] = []

        def _add(start: float, end: float) -> None:
            if end - start >= COVERAGE_GAP_MIN_SEC:
                holes.append((start, end))

        for sp_start, sp_end in speech:
            cursor = sp_start
            for c_start, c_end in covered:
                if c_end <= cursor:
                    continue
                if c_start >= sp_end:
                    break
                if c_start > cursor:
                    _add(cursor, c_start)
                cursor = max(cursor, c_end)
                if cursor >= sp_end:
                    break
            if cursor < sp_end:
                _add(cursor, sp_end)
        return holes

    def _uncovered_speech_sec(self) -> float:
        """Seconds where an interim heard words but no final ever landed.

        Deepgram can emit a final that stops short of what its own
        interim already recognised and then resume the next final past
        the difference. Observed in main.log: a final ended at 455.78 s,
        the next started at 460.09 s, and interim #446 had covered
        452.76-457.56 s carrying 75 characters. Those words are simply
        absent from the committed transcript.

        Ordinary pauses do not register: silence produces no interims
        with text, so a gap with no overlapping speech span contributes
        nothing. This measures only holes the service itself contradicts.

        TWO measurements, over disjoint ground, added:

        * ``_span_level_holes`` — regions no final reached at all, the
          original time-difference measure with its jitter floor;
        * ``_word_level_holes`` — words no final CARRIED, inside the
          span the finals do cover, where a time difference is zero by
          construction (audit §3.4).

        Each region is charged to exactly one of the two, so a word that
        is both outside every final and unaccounted for cannot be
        counted twice.
        """
        word_total = sum(end - start for start, end in self._word_level_holes())
        span_total = sum(end - start for start, end in self._span_level_holes())
        return word_total + span_total

    async def discard(self) -> None:
        """Close a session the CALLER has decided to replace.

        Identical to ``close()`` except that the teardown is not
        reported as an error. A caller that swaps one upstream socket
        for another mid-recording (the warm-socket liveness path in
        ``backend.main``, audit §3.7) is performing the recovery, not
        suffering a failure: routing the resulting ``ConnectionClosed``
        through ``_report_error`` would push ``{"fatal": true}`` at the
        renderer and abort a recording that is about to continue on the
        replacement socket.

        Flipping ``_closed`` first also makes every in-flight
        ``send_pcm`` a silent no-op, so audio still in the caller's send
        queue is not written into a socket that is going away — it is
        replayed into the new one instead.
        """
        self._discarded = True
        self._closed = True
        await self.close()

    async def close(self) -> None:
        """Idempotently release the upstream socket and background tasks.

        The teardown runs as ONE task that every caller awaits through a
        shield. A caller that bounds its wait (``backend.main``'s send
        watchdog) or is cancelled therefore stops waiting without
        stopping the teardown halfway — it used to be gated by a single
        flag set on entry, so a cancelled first call left the receive
        task and the events sentinel undone and every later "idempotent
        backstop" call returned at once (BW-03). The teardown bounds
        itself instead (``_close_socket_bounded``).
        """
        if self._close_task is None:
            self._close_task = asyncio.get_running_loop().create_task(
                self._close_once(), name="deepgram-live-close",
            )
        await asyncio.shield(self._close_task)

    async def _close_once(self) -> None:
        self._closed = True

        await cancel_and_await(
            self._keepalive_task, what="deepgram keepalive loop", log=self._log
        )

        ws = self._ws
        self._ws = None
        if ws is not None:
            await _close_socket_bounded(ws)

        # Also cancel and await the recv task. Without this, if the
        # upstream TCP connection is wedged such that `ws.close()`
        # returns before the peer actually closes, `_recv_loop`
        # continues running until the OS-level RST eventually lands —
        # potentially seconds. During that window, _recv_task holds
        # references to the socket, queue, and closures, leaking the
        # whole session object well past the caller's lifetime.
        # Mirror finalize()'s bounded cancel pattern.
        if self._recv_task is not None and not self._recv_task.done():
            self._recv_task.cancel()
            try:
                await asyncio.wait_for(self._recv_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            except Exception as e:
                self._log.debug("deepgram-live: close() recv_task await: %s", e)

        # Ensure any consumer blocked on events() unblocks. The sentinel
        # is routed through _enqueue_event so it survives overflow — if
        # the queue is full of interim events, one is evicted to make
        # room, guaranteeing the consumer sees termination.
        self._enqueue_event(self._QUEUE_SENTINEL, is_critical=True)

    # ----- Accessors --------------------------------------------------------

    @property
    def is_closed(self) -> bool:
        return self._closed

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    @property
    def last_fatal(self) -> bool:
        return self._last_fatal

    @property
    def stream_death_sec(self) -> Optional[float]:
        """Where on the recording's timeline the upstream stopped taking audio.

        ``None`` while the socket is healthy. Once a FATAL error is
        reported, this is ``bytes_sent`` at that instant expressed in
        seconds — everything the user spoke after it was captured by the
        app and never seen by Deepgram, which is what makes it a
        recovery span rather than a hole (audit §3.6/§3.7). Recorded at
        the first fatal, not the last: a socket that dies twice died
        once as far as the audio is concerned.
        """
        if self._fatal_at_bytes is None:
            return None
        return self._streamed_seconds(self._fatal_at_bytes)

    @property
    def endpointing_sec(self) -> float:
        """The configured endpointing silence window, in seconds."""
        return self._cfg.endpointing_ms / 1000.0

    @property
    def utterance_end_sec(self) -> float:
        """After this much silence Deepgram owes an ``UtteranceEnd``.

        The configured ``utterance_end_ms``, which is what makes it the
        threshold for "this silence is unexplained" — see
        ``tail_needs_recovery`` rule 3.
        """
        return self._cfg.utterance_end_ms / 1000.0

    @property
    def last_utterance_end(self) -> Optional[float]:
        """``last_word_end`` of the newest ``UtteranceEnd``, or ``None``.

        Public because the recovery pass measures the same tail this
        session does and must subtract the same confirmed silence
        (``confirmed_silence_gap``); a signal collected on one path and
        unreadable on the other is how the two come to disagree.
        """
        return self._last_utterance_end

    @property
    def streamed_sec(self) -> float:
        """How far into the recording this reading has been fed audio.

        ``max(bytes_offered, bytes_sent)`` on the recording's timeline —
        the same quantity ``_tail_coverage`` measures the tail against
        (B1, audit §3.6): a mid-stream send timeout drops a chunk from
        ``bytes_sent`` but the audio was still captured, so the smaller
        count would shrink the tail and could hide a real hole.
        """
        return self._streamed_seconds(
            max(self.stats.bytes_offered, self.stats.bytes_sent)
        )

    def committed_segments(self) -> list[dict]:
        """The finalized segments as they stand right now.

        A snapshot for coverage arithmetic mid-stop (the recovery budget
        prediction), deliberately WITHOUT the seam merge and dedupe that
        ``drain_transcript`` applies: those change spelling and segment
        boundaries, not which audio is accounted for, and the caller is
        asking about ground, not text.
        """
        return list(self._finalized_segments)

    @property
    def interim_window_end(self) -> float:
        """End of the newest interim's own decode window, session timeline."""
        return self._latest_interim_window_end

    def interim_speech_spans(self) -> list[tuple[float, float]]:
        """Merged spans where an interim carried real recognised text.

        Public for the same reason ``coverage_hole_spans`` is: the REST
        recovery pass has to know where the service heard speech in
        order to decide whether an uncovered tail is worth re-decoding
        or is just the user reaching for the stop key.
        """
        return union_spans(self._interim_speech_spans)

    def final_text(self) -> str:
        """Best-effort transcript text independent of drain_transcript().

        Used on the error path where ``drain_transcript()`` itself raised
        and there is no merged-segment list to reuse (see the WS
        handler's exception branch) — recomputes the seam merge on
        demand. The normal path computes the merge once inside
        ``drain_transcript()`` and reuses it for both ``text`` and
        ``segments`` rather than calling this method.
        """
        return join_segment_texts(
            drop_repeated_seam_ngrams(merge_seam_fragments(list(self._finalized_segments)))
        )

    def _committed_end_sec(self) -> float:
        """Where the COMMITTED transcript ends, on the recording's timeline.

        Native finals only, and therefore read before the interim
        splice runs. This is what ``coveredEndSec`` has always been
        documented as — "the point up to which the transcript is a
        committed final, AS OPPOSED TO spliced interim fallback" — in
        its own comment, in the WS handler's field documentation and in
        this method's callers. It was never computed: the envelope put
        ``durationSec`` in both fields, so one recovered interim word in
        the tail made the two equal and the renderer's
        ``envelopeCoversRecording()`` read an incomplete envelope as
        complete, which suppresses the recovery that would have filled
        the hole. ``durationSec`` still counts everything, because the
        transcript genuinely is that long.
        """
        return decoded_end_sec(self._finalized_segments)

    def partial_result(self) -> dict:
        """Best-effort envelope from whatever is finalized RIGHT NOW.

        For a caller that cannot afford to wait for THIS session's own
        ``drain_transcript()`` to finish — the dual-stream facade
        (``backend.deepgram_dual.DualLiveSession``), when the secondary
        reading is still draining after the primary's announced budget
        has run out. The recv loop appends to ``_finalized_segments``
        independently of ``drain_transcript()``'s own Finalize/wait dance,
        so whatever has arrived by the time the caller gives up is real,
        committed transcript — not a guess — and merging it in is strictly
        better than discarding a reading that was only ever late, never
        wrong.

        Same seam-merge/dedup pipeline and same envelope shape
        ``drain_transcript()`` produces, built from a snapshot instead of
        after a flush, so a partial and a full result can never describe
        the same audio differently (C6). Never sends Finalize and never
        waits — purely a read of state already held.
        """
        merged_segments = drop_repeated_seam_ngrams(
            merge_seam_fragments(list(self._finalized_segments))
        )
        duration_sec = 0.0
        if merged_segments:
            duration_sec = float(max(s.get("end", 0.0) for s in merged_segments))
        streamed_sec = self._streamed_seconds(self.stats.bytes_sent)
        return {
            "text": join_segment_texts(merged_segments),
            "segments": merged_segments,
            "durationSec": round(duration_sec, 3),
            "stats": self.stats.as_dict(),
            "uncoveredSpeechSec": round(self._uncovered_speech_sec(), 3),
            "streamedSec": round(streamed_sec, 3),
            "coveredEndSec": round(self._committed_end_sec(), 3),
        }

    # ----- Internals --------------------------------------------------------

    def _enqueue_event(self, event: object, *, is_critical: bool) -> None:
        """Put an event on the bounded queue with smart overflow handling.

        Priority (highest → lowest):

        1. ``QUEUE_SENTINEL`` — drains the entire queue if necessary to
           land. Its whole purpose is consumer termination, so dropping
           queued data is the correct trade-off; without this guarantee
           ``events()`` would hang on pathological queue saturation.
        2. ``is_critical=True`` (finals, errors) — evicts the oldest
           interim to make room. If no interim exists the critical event
           is unavoidably dropped with an error log.
        3. ``is_critical=False`` (interim segments) — drops on overflow
           and logs a one-shot warning.
        """
        # Fast path: queue has room.
        try:
            self._event_queue.put_nowait(event)
            return
        except asyncio.QueueFull:
            pass
        except RuntimeError as e:
            self._log.debug("deepgram-live: enqueue runtime error: %s", e)
            return
        # --- Overflow path ---
        if event is self._QUEUE_SENTINEL:
            # Sentinel MUST land. Drain the queue (up to current size)
            # and re-enqueue. This only fires on close()/recv-exit, so
            # any queued interim or final is being discarded during
            # session-end anyway — consumer termination is paramount.
            for _ in range(self._event_queue.qsize() + 1):
                try:
                    self._event_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            try:
                self._event_queue.put_nowait(event)
            except (asyncio.QueueFull, RuntimeError) as e:
                self._log.error("deepgram-live: sentinel land failed after drain: %s", e)
            return
        if not is_critical:
            # Slow consumer — drop this interim.
            if not self._queue_overflow_warned:
                self._queue_overflow_warned = True
                self._log.warning(
                    "deepgram-live: event queue full (cap=%d); dropping interim segments",
                    self._event_queue.maxsize,
                )
            return
        # Critical (non-sentinel): evict the oldest queued interim to
        # make room, then append the new event at the TAIL.
        #
        # ORDER IS THE CONTRACT. Consumers merge segments in arrival
        # order, so the queue must stay FIFO across an eviction. The
        # previous implementation popped items until it found an
        # interim, then re-enqueued those popped head items — which put
        # them BEHIND everything still sitting in the queue. Committed
        # ``is_final`` segments were silently reordered and the user saw
        # scrambled sentences whenever the renderer fell behind.
        #
        # Correct approach: drain the WHOLE queue into a list (order
        # preserved), drop the first interim from that list, append the
        # new event, and push the list back in the same order.
        drained: list[object] = []
        try:
            while True:
                drained.append(self._event_queue.get_nowait())
        except asyncio.QueueEmpty:
            pass
        except RuntimeError:
            return
        victim_index = next(
            (
                i
                for i, item in enumerate(drained)
                if isinstance(item, dict) and item.get("type") == "interim"
            ),
            -1,
        )
        if victim_index >= 0:
            drained.pop(victim_index)
            drained.append(event)
        else:
            self._log.error(
                "deepgram-live: queue full with no interim to evict; "
                "critical event dropped: type=%s",
                event.get("type") if isinstance(event, dict) else type(event).__name__,
            )
        for item in drained:
            try:
                self._event_queue.put_nowait(item)
            except (asyncio.QueueFull, RuntimeError) as e:
                self._log.error("deepgram-live: re-enqueue after eviction failed: %s", e)
                break

    def _report_error(self, message: str, *, fatal: bool) -> None:
        """Record an error and push a normalized error event to the queue."""
        if self._discarded:
            # The caller replaced this socket deliberately (``discard()``).
            # Everything the teardown raises from here on is the expected
            # consequence of that decision, not a failure the user needs
            # to see — and emitting it would abort the recording that is
            # already continuing on the replacement socket.
            self._log.debug("deepgram-live: error on discarded session: %s", message)
            return
        self._last_error = message
        self._last_fatal = fatal or self._last_fatal
        if fatal and self._fatal_at_bytes is None:
            # Pin the audio position of the death BEFORE anything else
            # can move ``bytes_sent``: this is the boundary the recovery
            # pass re-decodes from.
            self._fatal_at_bytes = int(self.stats.bytes_sent)
        self._log.warning(
            "deepgram-live: error (fatal=%s): %s", fatal, message
        )
        self._enqueue_event(
            {"type": "error", "error": message, "fatal": bool(fatal)},
            is_critical=True,
        )
        if fatal:
            self._closed = True

    async def _recv_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                if isinstance(raw, (bytes, bytearray)):
                    # Deepgram may send keepalive binary frames; ignore.
                    continue
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    self._log.debug("deepgram-live: non-json frame ignored")
                    continue
                if not isinstance(msg, dict):
                    continue
                self.stats.last_recv_at = time.monotonic()
                event = self._process_deepgram_message(msg)
                if event is not None:
                    # Finals, errors, and segment events are critical;
                    # interims can be dropped under back-pressure.
                    ev_type = event.get("type") if isinstance(event, dict) else ""
                    is_interim = ev_type == "interim"
                    self._enqueue_event(event, is_critical=not is_interim)
        except ConnectionClosed as e:
            code = getattr(e, "code", None)
            reason = getattr(e, "reason", "") or ""
            if self._discarded:
                # Retired on purpose (``discard()`` — the warm pool's idle
                # TTL, a mismatched or replaced socket). Whatever close
                # code comes back is the answer to OUR close; logging it
                # as "upstream closed … did not receive audio" made 844
                # routine retirements in 18 days read like Deepgram
                # outages (BL-05). The retirement itself is logged by
                # whoever decided it.
                self._log.debug(
                    "deepgram-live: retired socket closed code=%s", code
                )
                return
            self._log.info(
                "deepgram-live: upstream closed code=%s reason=%s finalize_sent=%s final_segs=%d",
                code,
                reason,
                self._finalize_sent,
                self.stats.segments_final,
            )
            # Normal closure codes — nothing to report.
            if code in (None, 1000, 1001, 1005) or self._finalize_sent:
                pass
            elif self.stats.segments_final > 0:
                # Stream dropped mid-session, BUT we already committed
                # some final segments. Don't raise a fatal error — the
                # caller will use the committed text as the transcript.
                # This is the common case when Deepgram closes an idle
                # connection that we haven't managed to keep awake.
                self._log.warning(
                    "deepgram-live: stream ended early with %d committed segments, using them as transcript",
                    self.stats.segments_final,
                )
                self._last_error = (
                    f"stream ended early (code={code}, reason={reason or 'none'})"
                )
            else:
                # No committed text and the stream dropped — this IS a
                # fatal error the caller must surface.
                self._report_error(
                    f"Deepgram upstream closed unexpectedly (code={code}, reason={reason or 'none'})",
                    fatal=True,
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Same logic: if we have committed segments, don't scream
            # at the user — use what we have.
            if self.stats.segments_final > 0:
                self._log.warning(
                    "deepgram-live: recv error after %d committed segments: %s",
                    self.stats.segments_final,
                    e,
                )
                self._last_error = f"recv error: {e}"
            else:
                self._report_error(f"Deepgram recv error: {e}", fatal=True)
                self._log.error("deepgram-live: recv_loop exception", exc_info=True)
        finally:
            self._closed = True
            self._enqueue_event(self._QUEUE_SENTINEL, is_critical=True)

    async def _keepalive_loop(self) -> None:
        """Emit ``{"type":"KeepAlive"}`` on prolonged upstream idle.

        Deepgram auto-closes an idle WebSocket after ~10 seconds. During
        quiet moments (long pauses or end-of-sentence silence) the
        frontend still sends PCM frames, but those can shrink below the
        threshold that keeps Deepgram happy. Emitting an explicit
        KeepAlive control message costs nothing and prevents unexpected
        disconnects.

        This is also the whole mechanism keeping a PRE-WARMED socket
        open, where no audio flows at all — Deepgram documents the
        10 s idle timeout as reset by "audio data or ``KeepAlive``
        messages", so no silence-frame trickle is needed. See
        ``backend.deepgram_warm`` for the cited sentences and for the
        4 s cadence a warm socket is constructed with.
        """
        try:
            while not self._closed and self._ws is not None:
                await asyncio.sleep(self._keepalive_interval_sec)
                # 1.1.25: snapshot ``self._ws`` BEFORE the send. close()
                # on the same event loop can null ``self._ws`` after we
                # passed the guard but before ``self._ws.send(...)``
                # re-reads the attribute, raising AttributeError on
                # ``None.send``. Snapshotting under the no-await window
                # of the guard makes the send a real WebSocket reference
                # whose own send-error semantics we already handle.
                ws = self._ws
                if self._closed or ws is None:
                    return
                last = self.stats.last_send_at or 0.0
                idle_for = time.monotonic() - last if last else float("inf")
                if idle_for < self._keepalive_idle_threshold_sec:
                    continue
                try:
                    await ws.send(json.dumps({"type": "KeepAlive"}))
                    self.stats.keepalives_sent += 1
                    self.stats.last_keepalive_at = time.monotonic()
                    self._log.debug(
                        "deepgram-live: sent KeepAlive after %.1fs idle",
                        idle_for,
                    )
                except ConnectionClosed:
                    return
                except WebSocketException as e:
                    self._log.debug("deepgram-live: KeepAlive send failed: %s", e)
                    return
                except AttributeError:
                    # Race lost: close() ran between our snapshot and the
                    # send call (rare but observed under heavy load).
                    return
        except asyncio.CancelledError:
            raise

    def _note_empty_final(self, msg: dict) -> None:
        """Record Deepgram's "the flush is done, there was nothing" answer.

        An ``is_final`` with an empty transcript is the normal reply to
        ``Finalize`` when no audio is left buffered, and it is also what
        Deepgram sends for a window of silence mid-stream. It produces no
        transcript, so it is not a segment — but it is two facts worth
        exactly as much as a segment:

        * the flush has been ANSWERED (``_empty_final_arrived``), which
          is what ends the post-Finalize wait; and
        * the window it names was decoded and found empty
          (``_empty_final_end``), which is genuine coverage — the
          transcript is complete out to there, and treating it as an
          unflushed tail is what made a stop keep waiting for words
          Deepgram had already said do not exist.

        Dropping this message is B-005, the root cause the three
        empirically-sized wait windows were built to work around.
        """
        start = as_float(msg.get("start")) + self._audio_offset_sec
        end = start + as_float(msg.get("duration"))
        self.stats.empty_finals += 1
        if end > self._empty_final_end:
            self._empty_final_end = end
        self._empty_final_arrived = True
        self._last_final_speech_final = bool(msg.get("speech_final"))
        self._final_arrived.set()

    def _process_deepgram_message(self, msg: dict) -> Optional[dict]:
        mtype = msg.get("type")

        if mtype == "Metadata":
            self._log.debug(
                "deepgram-live: metadata request_id=%s",
                str(msg.get("request_id") or "")[:12],
            )
            return None

        if mtype == "SpeechStarted":
            return None

        if mtype == "UtteranceEnd":
            # C7 (audit §3.5): Deepgram's own "the utterance ended here"
            # signal — record it so ``_tail_coverage`` can tell confirmed
            # trailing silence apart from a tail that merely has no
            # recent interim (ambiguous: a quiet provider looks the same).
            last_word_end = msg.get("last_word_end")
            try:
                value = float(last_word_end) if last_word_end is not None else None
            except (TypeError, ValueError):
                value = None
            if value is not None:
                # Also a provider timestamp, so it takes the same shift
                # as every other one (see the Results branch below).
                value += self._audio_offset_sec
                self._last_utterance_end = value
                self._log.debug(
                    "deepgram-live: UtteranceEnd last_word_end=%.2f", value,
                )
            return None

        if mtype == "Error":
            err = str(msg.get("description") or msg.get("message") or msg)[:300]
            self._report_error(f"Deepgram upstream error: {err}", fatal=False)
            return None

        if mtype != "Results":
            self._log.debug("deepgram-live: unknown message type=%s", mtype)
            return None

        channel = msg.get("channel")
        if not isinstance(channel, dict):
            return None
        alts = channel.get("alternatives")
        if not isinstance(alts, list) or not alts:
            return None
        alt = alts[0]
        if not isinstance(alt, dict):
            return None
        text = str(alt.get("transcript") or "").strip()
        if not text:
            if bool(msg.get("is_final")):
                self._note_empty_final(msg)
            return None

        # Defensive numeric coercion (module-level ``as_float``): a
        # malformed upstream message (non-numeric
        # ``start``/``duration``/``confidence``) must NEVER crash the
        # recv loop, because that would terminate the whole recording
        # session over a single stray frame. Invalid numerics degrade to
        # 0.0 and the segment still renders.
        start = as_float(msg.get("start")) + self._audio_offset_sec
        duration = as_float(msg.get("duration"))
        end = start + duration
        is_final = bool(msg.get("is_final"))
        speech_final = bool(msg.get("speech_final"))
        confidence = as_float(alt.get("confidence"))

        # When diarization is enabled, Deepgram populates ``words`` with a
        # per-word ``speaker`` index (0, 1, 2, ...). We expose the
        # dominant speaker for the segment so the frontend can render
        # "Speaker 0: hello world".
        raw_words = alt.get("words")
        speaker: Optional[int] = None
        if self._cfg.diarize:
            speaker = self._dominant_speaker(raw_words)

        # Parsed on EVERY Results frame, interim and final alike (audit
        # §3.1). The word list is what a message actually CONTAINS; its
        # start/duration is only the window it was decoded over, and
        # treating the window as the content is what evicted words the
        # final never carried.
        message_words = normalize_words(raw_words)
        # THE normalisation point (B1). Every consumer downstream —
        # segments, retained interim words, the coverage measurements,
        # the splice, ``coveredEndSec`` — reads the numbers produced
        # here and none of them re-derives anything from the raw
        # message, so shifting a socket that began mid-recording onto
        # the recording's own timeline happens once, here, or not at
        # all. ``_streamed_seconds`` is the same shift for byte counts.
        if self._audio_offset_sec:
            for w in message_words:
                w["start"] = round(w["start"] + self._audio_offset_sec, 3)
                w["end"] = round(w["end"] + self._audio_offset_sec, 3)

        segment = {
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text,
            "confidence": round(confidence, 3),
            "is_final": is_final,
            "speech_final": speech_final,
        }
        if speaker is not None:
            segment["speaker"] = speaker

        if is_final:
            # The final's own words travel with it, so every later
            # coverage question ("is this interim word already in the
            # transcript?") is answered from the transcript itself
            # rather than from its time window.
            segment["words"] = message_words
            self._finalized_segments.append(segment)
            self.stats.segments_final += 1
            # Read by ``_last_final_ended_the_utterance``. Kept here as
            # well as on the segment because an EMPTY final can be the
            # newest one, and it never becomes a segment.
            self._last_final_speech_final = speech_final
            self._final_arrived.set()
            # This final is authoritative for the words it CONTAINS, not
            # for its time range. A final that says "три на или если
            # это" over 4.91-9.70 s does not account for "субагента" at
            # 5.5-6.1 s just because the span covers it — that word
            # stays retained and reaches the finalize splice (§3.1).
            #
            # A provider response with no word list at all leaves the
            # span as the only thing knowable, so that case keeps the
            # old centre rule rather than retaining everything forever.
            if message_words:
                self._interim_words = self._evict_words_covered_by(
                    self._interim_words, message_words
                )
                self._orphan_interim_words = self._evict_words_covered_by(
                    self._orphan_interim_words, message_words
                )
            else:
                self._interim_words = [
                    w for w in self._interim_words
                    if not (start < (w["start"] + w["end"]) / 2.0 < end)
                ]
                self._orphan_interim_words = [
                    w for w in self._orphan_interim_words
                    if not (start < (w["start"] + w["end"]) / 2.0 < end)
                ]
            self._log.info(
                "deepgram-live: is_final start=%.2f end=%.2f speech_final=%s "
                "textLen=%d words=%d",
                start, end, speech_final, len(text), len(message_words),
            )
            out_segment: dict[str, object] = {
                "start": segment["start"],
                "end": segment["end"],
                "text": segment["text"],
            }
            if message_words:
                # The renderer merges two readings of the same recording
                # by word time (``transcript-merge.ts``), and a segment
                # frame stripped of its word list left it with nothing
                # finer than the segment span to merge on. The words are
                # already in hand — the same list the envelope carries
                # and the same list coverage is computed from, offset
                # included — so this is the one shape, forwarded, not a
                # second one. Omitted entirely when the provider sent no
                # word list, which is the only honest way to say "not
                # known" (an empty list reads as "no words here").
                out_segment["words"] = [dict(w) for w in message_words]
            if speaker is not None:
                out_segment["speaker"] = speaker
            return {
                "type": "segments",
                "segments": [out_segment],
                "is_final": True,
                "speech_final": speech_final,
            }

        self.stats.segments_interim += 1
        # ``text`` is already guaranteed non-empty here (the empty-text
        # guard at the top of this method returns before either branch is
        # reached), so recording this window unconditionally is exactly
        # ``_tail_needs_flush`` rule 2's "an interim's window ... with
        # non-empty text" — the provider's own claim that it is still
        # decoding audio out to ``end``, independent of how many words (if
        # any) that hypothesis has produced so far.
        if end > start:
            self._latest_interim_window_end = end
        # Retain this hypothesis's words for hole-splicing at finalize.
        # An interim is a ROLLING re-decode of recent audio, so each new
        # one supersedes every stored word that overlaps its range —
        # without that, the same spoken word would pile up once per
        # interim message and the splice would duplicate it.
        new_words = message_words
        self._interim_ring.append((round(start, 3), round(end, 3), text))
        # Record where the service actually heard WORDS. The message span
        # is the re-decode window, not the speech in it: a rolling interim
        # can span five seconds and carry two words near its end, and
        # charging the whole window as "recognised speech" made every such
        # message report seconds of loss that were never spoken. Word
        # timings are the honest measure; the message span is the fallback
        # for a hypothesis that arrives without them. The length threshold
        # keeps single-character noise hypotheses out either way.
        if len(text) >= INTERIM_SPEECH_MIN_CHARS:
            if new_words:
                self._interim_speech_spans.extend(_word_speech_spans(new_words))
            elif end > start:
                self._interim_speech_spans.append((start, end))
        # ``new_words`` is non-empty only when the hypothesis carried a
        # word list, so this is the same guard the parse above applied.
        if new_words:
            def _overlaps_range(w: dict) -> bool:
                return not (w["end"] <= start or w["start"] >= end)

            displaced = [w for w in self._interim_words if _overlaps_range(w)]
            self._interim_words = [
                w for w in self._interim_words if not _overlaps_range(w)
            ]
            # Displaced ≠ wrong: the newer hypothesis merely did not
            # confirm them YET. Park them as orphans unless the NEWEST
            # words actually cover the same ground (newest wins).
            seen = {
                (o["word"], o["start"], o["end"])
                for o in self._orphan_interim_words
            }
            for w in displaced:
                key = (w["word"], w["start"], w["end"])
                if key not in seen:
                    seen.add(key)
                    self._orphan_interim_words.append(dict(w))
            # Purge by IDENTITY, not by any temporal overlap (audit
            # §3.2). A rolling re-decode nearly always puts *something*
            # on the same ground, so overlap-based purging emptied the
            # pool unless the newer hypothesis happened to leave a hole
            # in exactly that place. An orphan dies only when the newest
            # words contain the same spoken word — the same question
            # ``word_accounted_for`` answers at splice time.
            self._orphan_interim_words = [
                o
                for o in self._orphan_interim_words
                if not word_accounted_for(o, new_words)
            ]
            self._interim_words.extend(new_words)
        if self.stats.segments_interim % 5 == 1:
            # Sample 1-in-5 interim emissions to keep log volume bounded
            # while still proving Deepgram is producing output.
            self._log.info(
                "deepgram-live: interim #%d start=%.2f end=%.2f textLen=%d",
                self.stats.segments_interim, start, end, len(text),
            )
        interim_segment: dict[str, object] = {
            "start": segment["start"],
            "end": segment["end"],
            "text": segment["text"],
        }
        if speaker is not None:
            interim_segment["speaker"] = speaker
        return {
            "type": "interim",
            "segment": interim_segment,
        }

    @staticmethod
    def _dominant_speaker(words: object) -> Optional[int]:
        """Return the most common speaker index across ``words``.

        Deepgram emits one speaker id per word when ``diarize=true``.
        For a segment that belongs almost entirely to one speaker, the
        dominant index is stable; for mixed segments (rare at sentence
        granularity) we pick whichever speaker spoke most words.
        """
        if not isinstance(words, list) or not words:
            return None
        counts: dict[int, int] = {}
        for w in words:
            if not isinstance(w, dict):
                continue
            sp = w.get("speaker")
            if sp is None:
                continue
            try:
                key = int(sp)
            except (TypeError, ValueError):
                continue
            counts[key] = counts.get(key, 0) + 1
        if not counts:
            return None
        return max(counts.items(), key=lambda kv: kv[1])[0]


__all__ = [
    "DeepgramLiveConfig",
    "DeepgramLiveError",
    "DeepgramLiveSession",
    "DeepgramLiveStats",
    # Word-level coverage (audit §3.1-§3.4). Public because they are the
    # definitions the rest of the module — and its tests — reason about:
    # what a word record is, when two of them are the same spoken word,
    # and when a final already accounts for one.
    "as_float",
    "covering_final_word",
    "decoded_end_sec",
    "drop_repeated_seam_ngrams",
    "final_words_cover",
    "merge_seam_fragments",
    "normalize_words",
    "segment_word_records",
    "segment_words",
    "spanless_coverage_spans",
    "word_inside_spanless_final",
    "time_overlap",
    "token_stem",
    "word_accounted_for",
    "word_core",
    "word_duration",
    "SPANLESS_WORD_FLAG",
    # Shared with ``backend.deepgram_dual``, which merges two readings
    # of one recording: what "auto" means as a Deepgram language, and
    # the span arithmetic behind "is this still a hole?".
    "INTERIM_FALLBACK_SOURCE",
    "intersect_spans",
    "live_config",
    "resolve_live_language",
    "subtract_spans",
    "union_spans",
    # Word placement and text assembly, shared with
    # ``backend.deepgram_recovery``: one implementation of "where does a
    # missing word go" and one of "how do segments become text".
    "SpliceOutcome",
    "fits_beside",
    "host_segment_for",
    "insert_word_into_segment",
    "join_segment_texts",
    "nearest_segment_word",
    "splice_words_into_segments",
    # The tail: what a stop may retry for, what a recovery may re-decode,
    # and the UtteranceEnd subtraction both of them apply first.
    "confirmed_silence_gap",
    "tail_needs_flush",
    "tail_needs_recovery",
]
