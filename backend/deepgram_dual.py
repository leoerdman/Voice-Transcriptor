"""Two readings of one recording, merged by word timestamps.

Why
---
``BUGS_AUDIT_2026-09-03.md`` §1 measured ``language=multi`` dropping
whole clauses of Russian speech, non-deterministically, on this app's
own recordings — and ``language=ru`` on the identical audio keeping
every one of them while losing the French and English ones instead.
Neither reading is complete on a recording that switches language, and
no Deepgram parameter fixes either: the two fail in DIFFERENT places.

The dual-stream measurement (2026-09-04, 11 files x 2 languages x 2
repeats = 44 sessions; report and prototype under
``evidence-2026-09-03/session-2026-09-04-dual-stream/``) ran both
readings on the same audio and merged their FINAL segments by word
time. On the 72.7 s trilingual recording that closed both holes,
verbatim and in both directions:

* ``multi`` emitted nothing at all between 21.82 s and 25.99 s — 4.17 s
  of speech — and ``ru`` had every word of it ("говорю просто большую
  кучу разных слов, довольно долго. И ты можешь detect and find"),
  code-switch included;
* ``ru`` skipped the French clause entirely, and ``multi`` had it
  ("lab de la capitale de la France.").

9 of 11 merged transcripts were byte-identical across repeat runs; the
other 2 differed only in punctuation and capitalisation, with no word
added or lost. Two concurrent sockets did not slow the connect (p50
871 ms across 44 sessions, against 880 ms measured single-stream in
production) — the cost is money, not latency: twice the Deepgram
streaming seconds.

What this module owns
---------------------
1. The DECISION (``dual_stream_enabled``): one preference, and the one
   condition that makes it meaningful — the recording must actually be
   running multilingual, because a second reading in the language the
   user already chose reads the same audio the same way and buys
   nothing for double the money.
2. The MERGE (``merge_readings``): the rules the measurement validated,
   with the one defect it found closed (see ``_pairs``), and one owner
   for every stretch the two readings hear in different languages (see
   ``_settle_contested_stretches``).
3. The FACADE (``DualLiveSession``): two sessions behind the interface
   of one, so the WebSocket handler drives the same object either way.
"""

from __future__ import annotations

import asyncio
import bisect
import heapq
import logging
import time
from collections import deque
from dataclasses import dataclass, field, replace
from typing import Any, Iterable, Optional

from backend.async_tasks import cancel_and_await
# The shipped defaults, from the one module that owns them —
# ``backend.config`` builds ``DEFAULT_CONFIG`` from the same two names,
# so "dual is on, and its partner is ru" cannot mean different things on
# the two sides of the preference.
from backend.model_catalog import (
    DUAL_SECONDARY_LANGUAGE_DEFAULT,
    DUAL_SECONDARY_LANGUAGE_OPTIONS,
    DUAL_STREAM_DEFAULT,
)
# The merge has to answer the same questions the single-stream splice
# already answers — "are these two records the same spoken word?", "how
# much of this word's time does that one occupy?" — and answering them
# a second way is how two parts of one product come to disagree about
# what a duplicate is. These are that module's own rules, imported
# rather than restated; ``word_core``/``word_duration``/``time_overlap``/
# ``token_stem`` are part of its public API for exactly that reason
# (they used to be imported through their leading underscore, which
# said the opposite of what the import was doing).
from backend.remote_deepgram_live import (
    CROSS_FINAL_NGRAM_MAX_WORDS,
    INTERIM_WORD_GAP_SPLIT_SEC,
    SPLICE_COVERAGE_OVERLAP_FRACTION,
    DeepgramLiveConfig,
    DeepgramLiveSession,
    DeepgramLiveStats,
    FINALIZE_FLUSH_WAIT_SEC,
    SEND_WEDGE_SEC,
    SPANLESS_WORD_FLAG,
    resolve_live_language,
    segment_word_records,
    subtract_spans,
    time_overlap,
    token_stem,
    union_spans,
    word_core,
    word_duration,
)
from backend.word_case import (
    capital_is_lexical,
    cased_for_place,
    lexical_names,
    ends_sentence,
    is_capitalised,
    starts_sentence,
)

logger =logging.getLogger(__name__)


# Two words with the same stem, this close in time, are one spoken word
# whose boundaries the two decoders placed differently.
#
# This is the defect the measurement found and named. On the 10.6 s
# recording "Очень важно починить", ``multi``'s word "truth," swallowed
# the pause after it (ending at 7.35 s where ``ru``'s "truth" ended at
# 7.11 s), which pushed ``multi``'s next word "без" to 7.75-7.99 while
# ``ru``'s "без" sat at 7.11-7.59. The two do not overlap AT ALL — the
# gap is 0.16 s — so a rule that only knows about overlap saw two
# different words and shipped "без без" to the user. Reproducible in
# both repeat runs.
#
# 0.3 s is a pause a decoder can absorb into the preceding word without
# the next word being a different utterance; it is comfortably over the
# few tens of ms a re-decode normally shifts a boundary by, and well
# under any real inter-word pause.
ADJACENT_SAME_STEM_MAX_GAP_SEC = 0.3

_LATIN = set("abcdefghijklmnopqrstuvwxyz")


def _has_latin(token: str) -> bool:
    return any(ch in _LATIN for ch in token.casefold())


# ---------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------


def _deepgram_prefs(cfg: Any) -> dict:
    prefs = cfg.get("preferences") if isinstance(cfg, dict) else None
    dg = prefs.get("deepgram") if isinstance(prefs, dict) else None
    return dg if isinstance(dg, dict) else {}


def dual_applies(language: str) -> bool:
    """Is a second reading meaningful for a recording in ``language``?

    Only when the recording resolves to Deepgram's multilingual mode
    (``resolve_live_language`` — the same function that decides what
    goes on the wire). The preference half of the decision is
    ``dual_stream_enabled``'s; this half is shared with the A/B tool,
    which must not measure a configuration the app never runs.
    """
    return resolve_live_language(language) == "multi"


def dual_stream_enabled(cfg: Any, language: str) -> bool:
    """Should this recording open a second Deepgram reading?

    Two conditions, and both are load-bearing:

    * the preference is on (``preferences.deepgram.dual_stream``,
      default ``True``); and
    * the recording resolves to Deepgram's multilingual mode
      (``resolve_live_language`` — the same function that decides what
      goes on the wire, so the two cannot disagree).

    The second is what keeps the cost honest. A user who has chosen
    ``ru`` is already getting the reading the merge would add; running
    it twice would double the bill for an identical transcript.
    """
    if not dual_applies(language):
        return False
    value = _deepgram_prefs(cfg).get("dual_stream")
    if value is None:
        return DUAL_STREAM_DEFAULT
    return bool(value)


def dual_secondary_language(cfg: Any) -> str:
    """The language of the second reading — one place, one answer.

    Validated against ``DUAL_SECONDARY_LANGUAGE_OPTIONS``, not merely
    lowercased. The renderer's picker can only offer those codes and its
    autosave writes back what the picker shows, so a stored value outside
    the list is a leftover from an older build or a hand-edited config —
    and accepting it here made the two sides disagree in the one way the
    user cannot see: Settings displayed the default while the stream ran
    something else.
    """
    value = _deepgram_prefs(cfg).get("dual_secondary_language")
    if isinstance(value, str):
        code = value.strip().lower()
        if code in DUAL_SECONDARY_LANGUAGE_OPTIONS:
            return code
    return DUAL_SECONDARY_LANGUAGE_DEFAULT


def secondary_config(cfg: DeepgramLiveConfig, language: str) -> DeepgramLiveConfig:
    """The primary config, re-read in another language.

    Everything else — model, keyterms, sample rate, endpointing — is
    deliberately identical: the merge pairs words by TIME, and two
    readings decoded with different endpointing would place their
    boundaries differently for reasons that have nothing to do with
    what was said.
    """
    return replace(cfg, language=language)


# ---------------------------------------------------------------------
# The merge
# ---------------------------------------------------------------------


@dataclass
class MergedReading:
    """One transcript assembled from two readings of the same audio."""

    words: list[dict] = field(default_factory=list)
    segments: list[dict] = field(default_factory=list)
    text: str = ""
    primary_word_count: int = 0
    secondary_word_count: int = 0
    filled_from_secondary: int = 0
    filled_from_primary: int = 0
    duplicates_removed: int = 0
    # Contested stretches (``_settle_contested_stretches``) and which
    # reading each one went to.
    contested_to_secondary: int = 0
    contested_to_primary: int = 0

    def covered_end_sec(self) -> float:
        return max((float(w["end"]) for w in self.words), default=0.0)

    def covered_spans(self) -> list[tuple[float, float]]:
        return union_spans((float(w["start"]), float(w["end"])) for w in self.words)


def flatten_words(segments: Iterable[dict], source: str) -> list[dict]:
    """Finalized segments to one time-ordered word list, tagged.

    Reads every segment through ``segment_word_records`` — the ONE rule
    for a final that arrived without a word list (B-001). This function
    used to take ``segment_words`` alone, so such a final contributed
    nothing at all: since ``merged.text`` is built from words, the whole
    clause disappeared from the transcript of a recording running the
    default Auto mode, with no error and no log line. The single-stream
    path had named that case three times over (``_spanless_coverage``,
    ``_word_covered_by_spanless_final``, the wordless branch of
    ``_process_deepgram_message``); the merge is the fourth asker and
    now shares their answer instead of inventing a fourth.
    """
    out: list[dict] = []
    for seg in segments or []:
        for w in segment_word_records(seg):
            token = str(w.get("word") or "")
            if not token:
                continue
            record = {
                "word": token,
                "start": float(w.get("start") or 0.0),
                "end": float(w.get("end") or 0.0),
                "source": source,
            }
            # Deepgram's evidence about the word (``normalize_words``):
            # what the contested-stretch rule decides from.
            if isinstance(w.get("confidence"), (int, float)):
                record["confidence"] = float(w["confidence"])
            if isinstance(w.get("language"), str) and w["language"]:
                record["language"] = w["language"]
            if w.get(SPANLESS_WORD_FLAG):
                record[SPANLESS_WORD_FLAG] = True
            out.append(record)
    out.sort(key=lambda w: (w["start"], w["end"]))
    return out


# How much of a clause-level record's span the OTHER reading has to
# transcribe with real words before that clause is dropped in its
# favour. Half: below it the clause is the only reading of most of that
# ground and dropping it would lose text (which is B-001 all over
# again); above it the other reading is the same audio, positioned word
# by word, and keeping the blob beside it would print the clause twice.
SPANLESS_SHADOW_MIN_FRACTION = 0.5


def _reconcile_spanless(
    primary: list[dict], secondary: list[dict]
) -> tuple[list[dict], list[dict]]:
    """Decide, per span of ground, between a clause blob and real words.

    A final without a word list becomes ONE record spanning its whole
    segment (``segment_word_records``). That record is a real reading of
    that ground — dropping it outright is B-001, a whole clause deleted
    from the transcript — but it is the coarsest possible one, and it
    cannot be merged word by word with anything. So exactly one of the
    two readings owns any ground a blob covers, and it is decided here,
    once, before any pairing:

    1. A blob whose span the OTHER reading transcribes with real words
       over at least ``SPANLESS_SHADOW_MIN_FRACTION`` of it loses: those
       words are the same audio, positioned, and the blob beside them
       would print the clause twice.
    2. Under any blob that survives, the other reading's real words lose
       instead — the blob already says what was spoken there, and
       keeping both is the same double-printing from the other side.
       "Inside" is the centre rule ``_word_covered_by_spanless_final``
       uses on the single-stream path, so "this word is answered for by
       a wordless final" means one thing in this product.
    """
    if not any(
        w.get(SPANLESS_WORD_FLAG) for w in (*primary, *secondary)
    ):
        # The common case by far: both readings came with word timings,
        # and there is no blob for either side to lose ground to.
        return primary, secondary
    kept_primary = _drop_shadowed_spanless(primary, secondary)
    kept_secondary = _drop_shadowed_spanless(secondary, kept_primary)
    return (
        _drop_words_under_spanless(kept_primary, kept_secondary),
        _drop_words_under_spanless(kept_secondary, kept_primary),
    )


def _spanless_spans(words: Iterable[dict]) -> list[tuple[float, float]]:
    return union_spans(
        (w["start"], w["end"]) for w in words if w.get(SPANLESS_WORD_FLAG)
    )


def _drop_shadowed_spanless(
    words: list[dict], other: list[dict]
) -> list[dict]:
    """Step 1 of ``_reconcile_spanless``: blobs the other reading beat."""
    covered = union_spans(
        (w["start"], w["end"]) for w in other if not w.get(SPANLESS_WORD_FLAG)
    )
    if not covered:
        return words
    kept: list[dict] = []
    for word in words:
        if not word.get(SPANLESS_WORD_FLAG):
            kept.append(word)
            continue
        if word["end"] <= word["start"]:
            kept.append(word)
            continue
        if _covered_fraction(covered, word["start"], word["end"]) < SPANLESS_SHADOW_MIN_FRACTION:
            kept.append(word)
    return kept


def _drop_words_under_spanless(
    words: list[dict], other: list[dict]
) -> list[dict]:
    """Step 2 of ``_reconcile_spanless``: words a surviving blob answers for."""
    blobs = _spanless_spans(other)
    if not blobs:
        return words
    kept: list[dict] = []
    for word in words:
        if word.get(SPANLESS_WORD_FLAG):
            kept.append(word)
            continue
        center = (word["start"] + word["end"]) / 2.0
        if not any(start < center < end for start, end in blobs):
            kept.append(word)
    return kept


def _same_audio(a: dict, b: dict) -> bool:
    """Do these two words describe the same moment of the recording?

    The yes/no reading of ``_pair_overlap``; see it for the rules.
    """
    return _pair_overlap(a, b) is not None


def _pair_overlap(a: dict, b: dict) -> Optional[float]:
    """Their time overlap when they are the same moment, else ``None``.

    Overlap first — the measured rule, ``SPLICE_COVERAGE_OVERLAP_FRACTION``
    of EITHER word, the same threshold the single-stream splice uses.

    Then the fix for the "без без" case: two words whose stems match and
    which sit within ``ADJACENT_SAME_STEM_MAX_GAP_SEC`` of each other
    are the same word even with no overlap at all, because one decoder
    let the previous word swallow the pause and pushed this one late.
    Requiring the STEM to match is what keeps this from merging genuine
    consecutive words: "да да" said twice stays two words only if the
    times really are disjoint by more than the gap, and a real repeat
    ("subagents, subagents") is spoken over a longer span than 0.3 s.

    A clause-level record (``SPANLESS_WORD_FLAG`` — a final that arrived
    without word timings) is not a spoken word, so it is never paired
    with one: doing so would let a single word's spelling win
    ``_resolve`` against a whole clause and delete the clause. Which of
    the two survives is decided before any pairing, by
    ``_drop_shadowed_spanless``. Two clause records of the same ground
    ARE comparable, and are compared on overlap alone — a stem match
    between two multi-word blobs means nothing.

    Returns the overlap rather than a boolean because ``_pairs`` needs
    both the verdict and the same number as its ranking key, and
    computing it twice was a measurable share of the merge on a long
    dictation.
    """
    a_spanless = bool(a.get(SPANLESS_WORD_FLAG))
    b_spanless = bool(b.get(SPANLESS_WORD_FLAG))
    if a_spanless != b_spanless:
        return None
    overlap = time_overlap(a, b)
    if overlap > 0 and (
        overlap >= SPLICE_COVERAGE_OVERLAP_FRACTION * word_duration(a)
        or overlap >= SPLICE_COVERAGE_OVERLAP_FRACTION * word_duration(b)
    ):
        return overlap
    if a_spanless:
        return None
    stem = token_stem(a["word"])
    if not stem or stem != token_stem(b["word"]):
        return None
    gap = max(a["start"], b["start"]) - min(a["end"], b["end"])
    return overlap if gap <= ADJACENT_SAME_STEM_MAX_GAP_SEC else None


def _pairs(
    primary: list[dict], secondary: list[dict]
) -> tuple[list[tuple[dict, dict]], list[dict], list[dict]]:
    """Pair words across readings, greedily, strongest evidence first.

    Two kinds of evidence, ranked in this order:

    1. AGREEMENT — the two readings wrote the same word (same stem).
       Every agreeing candidate claims its words before any disagreeing
       one may; among agreeing candidates the larger overlap wins, so a
       same-stem neighbour with no overlap at all (the "без без" rule in
       ``_pair_overlap``) still yields to a real overlap.
    2. DISAGREEMENT — the two readings wrote different words over the
       same time, and ``_resolve`` picks one spelling. Ranked by overlap.

    Agreement must come first because a disagreeing pair REPLACES a word,
    and a word is only a rival spelling of another when neither has its
    own counterpart in the other reading. Measured 2026-11-23 on "сделай
    деплой на сервер" (``20261123-173206``): ``ru`` skipped "деплой" and
    stretched its "на" back over it (2.24-2.80 s), so its "на" overlapped
    ``multi``'s "деплой" (2.16-2.64, 0.40 s) more than ``multi``'s own
    "на" (2.64-2.80, 0.16 s). Ranked by overlap alone, "на" claimed
    "деплой", ``_resolve`` let the Cyrillic secondary win, and the user
    got "сделай на сервер" — the one word only ``multi`` heard was
    deleted, and ``multi``'s orphaned "на" then had to be removed as a
    duplicate.

    Disagreement must be mutual. A disagreeing pair is admitted only
    when each word is the other's largest overlap among every candidate
    the other reading offers — agreeing candidates included. Overlap
    against EITHER word's length is evidence that two records touch, not
    that they are one word: a short word clears the fraction against a
    long neighbour it merely abuts. Measured 2026-09-03 23:28:42 on
    "слова он не должен": ``multi`` heard "он" 33.51-33.59 and "должен"
    33.62-34.10, ``ru`` heard "не" 33.54-33.86 and "должен" 33.86-34.18.
    "не" and "он" share 0.05 s — 62 % of "он", so the pair qualified —
    yet 0.24 s of "не" lies under ``multi``'s "должен": the time "не"
    occupies is best explained by a word that already has its own
    counterpart, so "не" is no rival spelling of "он", and pairing them
    deleted one of two spoken words ("слова не должен"). Under the
    mutual rule both stay, each filling the slot its reading heard.
    The "деплой"/"на" case passes the same test: ``ru``'s stretched "на"
    is best matched by "деплой" (0.40 s), but "на" already agrees with
    ``multi``'s own "на", so "деплой" stays unpaired either way.

    After the greedy pass, ``_pair_same_slot_neighbours`` pairs the
    words the time rules cannot see as one because one reading
    mis-timed them (see there).

    Linear in the number of words, by a time sweep. This used to rescan
    the WHOLE secondary list from index 0 for every primary word — the
    early ``break`` bounded the tail of the scan but not its head — which
    is O(P x S) on a path that runs synchronously between the user's
    Stop and their text: measured 2.8 s for a 7-minute dictation and
    30.8 s for a 20-minute one, all of it inside the event loop, and all
    of it outside the budget this stop had already announced to the
    renderer (B-002).

    Both lists are time-sorted, so a secondary word can only match a
    window of primary words that moves forward with the cursor. The
    active set holds exactly the secondary words whose span can still
    reach the current primary word: anything ending more than
    ``ADJACENT_SAME_STEM_MAX_GAP_SEC`` before it can match neither this
    primary word nor any later one (later ones start no earlier), so it
    is retired for good — a heap keyed on ``end`` is what makes "the
    earliest-ending word still in play" the only one that has to be
    examined to decide that. Words are admitted by ``start``, in order,
    and never re-examined once retired, so every word enters and leaves
    once.
    """
    candidates: list[tuple[float, int, int]] = []
    active: list[tuple[float, int]] = []  # heap of (end, secondary index)
    next_secondary = 0
    total_secondary = len(secondary)
    for pi, pw in enumerate(primary):
        admit_until = pw["end"] + ADJACENT_SAME_STEM_MAX_GAP_SEC
        while (
            next_secondary < total_secondary
            and secondary[next_secondary]["start"] <= admit_until
        ):
            heapq.heappush(
                active,
                (secondary[next_secondary]["end"], next_secondary),
            )
            next_secondary += 1
        retire_before = pw["start"] - ADJACENT_SAME_STEM_MAX_GAP_SEC
        while active and active[0][0] < retire_before:
            heapq.heappop(active)
        for _end, si in active:
            overlap = _pair_overlap(pw, secondary[si])
            if overlap is not None:
                candidates.append(
                    (not _agree(pw, secondary[si]), overlap, pi, si)
                )
    # A disagreeing pair says "these two records are one spoken word";
    # that holds only when each is the other's strongest time match
    # among ALL of the other reading's words — agreeing ones included.
    # See "Disagreement must be mutual" in the docstring.
    best_p: dict[int, float] = {}
    best_s: dict[int, float] = {}
    for _disagrees, overlap, pi, si in candidates:
        best_p[pi] = max(best_p.get(pi, 0.0), overlap)
        best_s[si] = max(best_s.get(si, 0.0), overlap)
    candidates = [
        c for c in candidates
        if not c[0] or (c[1] >= best_p[c[2]] and c[1] >= best_s[c[3]])
    ]
    # Explicit tie-break on (pi, si) rather than sort stability: the
    # sweep visits the active set in heap order, so insertion order is
    # no longer the source order, and two candidates with identical
    # evidence have to resolve the same way every run.
    candidates.sort(key=lambda t: (t[0], -t[1], t[2], t[3]))
    p_to_s: dict[int, int] = {}
    used_s: set[int] = set()
    for _disagrees, _overlap, pi, si in candidates:
        if pi in p_to_s or si in used_s:
            continue
        p_to_s[pi] = si
        used_s.add(si)
    _pair_same_slot_neighbours(primary, secondary, p_to_s, used_s)
    return (
        [(primary[pi], secondary[si]) for pi, si in sorted(p_to_s.items())],
        [w for i, w in enumerate(primary) if i not in p_to_s],
        [w for i, w in enumerate(secondary) if i not in used_s],
    )


def _agree(a: dict, b: dict) -> bool:
    """Did the two readings write the same word? The stem test
    ``_pair_overlap`` and ``_drop_duplicate_runs`` already use. Clause
    records (``SPANLESS_WORD_FLAG``) carry a whole clause, not a word, so
    they never "agree" — they pair on overlap alone."""
    if a.get(SPANLESS_WORD_FLAG) or b.get(SPANLESS_WORD_FLAG):
        return False
    stem = token_stem(a["word"])
    return bool(stem) and stem == token_stem(b["word"])


def _pair_same_slot_neighbours(
    primary: list[dict],
    secondary: list[dict],
    p_to_s: dict[int, int],
    used_s: set[int],
) -> None:
    """Pair the same word both readings put in the same place in the
    sentence, when one of them mis-timed it.

    Time is the merge's evidence everywhere else, but a reading's time
    can be wrong for a whole word. Measured 2026-11-23 on "Я сейчас
    записывал …" (``20261123-173222``): the audio is silent until 1.12 s
    and ``multi`` placed "Я" at 1.20-1.44 s, but ``ru`` — whose first
    word of the stream it was — stretched it back to the stream start,
    0.00-0.64 s. 0.56 s apart, the two "Я" neither overlap nor fall
    within ``ADJACENT_SAME_STEM_MAX_GAP_SEC``, so both survived and the
    user got "Я Я сейчас".

    The evidence the time rules miss is ORDER. Both "Я" are the word
    right before "сейчас", and the two "сейчас" are already paired: two
    readings of one stretch that agree on a word and on its neighbour
    heard one word there, not two. So a pair (p, s) — any pair, agreeing
    or not — extends to its immediate neighbours on the same side,
    ``p±1`` with ``s±1``, when both are still unpaired, are words (not
    clause records), write the same stem, and sit no further apart than
    ``INTERIM_WORD_GAP_SPLIT_SEC`` — the pause beyond which this product
    already treats speech as a different clause. A new pair is itself an
    anchor, so a run of mis-timed words is walked word by word.

    The anchor is what keeps this from merging a genuine repeat: "да"
    said twice is two words in the reading that heard both, so the
    second "да" is not the neighbour of the anchor the other reading's
    single "да" is next to. With no anchor at all (two isolated words)
    nothing changes — ``ADJACENT_SAME_STEM_MAX_GAP_SEC`` alone decides.

    Linear: one sweep each way over the pairs in primary order; mutates
    ``p_to_s``/``used_s``.
    """

    def _try(pi: int, si: int) -> bool:
        if not (0 <= pi < len(primary) and 0 <= si < len(secondary)):
            return False
        if pi in p_to_s or si in used_s:
            return False
        pw, sw = primary[pi], secondary[si]
        if not _agree(pw, sw):
            return False
        gap = max(pw["start"], sw["start"]) - min(pw["end"], sw["end"])
        if gap > INTERIM_WORD_GAP_SPLIT_SEC:
            return False
        p_to_s[pi] = si
        used_s.add(si)
        return True

    # Rightward: an anchor at pi claims (pi+1, si+1); visiting pi in
    # increasing order lets a fresh pair anchor the next one.
    for pi in range(len(primary)):
        si = p_to_s.get(pi)
        if si is not None:
            _try(pi + 1, si + 1)
    # Leftward, mirror image.
    for pi in range(len(primary) - 1, -1, -1):
        si = p_to_s.get(pi)
        if si is not None:
            _try(pi - 1, si - 1)


def _mean_confidence(words: list[dict]) -> Optional[float]:
    values = [float(w["confidence"]) for w in words if isinstance(w.get("confidence"), (int, float))]
    return sum(values) / len(values) if values else None


def _covered_fraction(
    covered: list[tuple[float, float]], start: float, end: float
) -> float:
    """How much of ``[start, end)`` the (unioned) ``covered`` spans cover.

    The one measure behind both "does the other reading actually read
    this ground?" questions in this module — a clause blob against real
    words (``_drop_shadowed_spanless``) and a contested stretch against
    its rivals (``_settle_contested_stretches``) — both judged against
    ``SPANLESS_SHADOW_MIN_FRACTION``.
    """
    span = end - start
    if span <= 0.0:
        return 0.0
    # ``covered`` is unioned — sorted and disjoint, so its ends are sorted
    # too — and the first block that can reach ``start`` is found by
    # bisection: asked once per contested stretch, a scan from the first
    # block would be O(stretches x words) on the stop path.
    total = 0.0
    for a, b in covered[bisect.bisect_right(covered, start, key=lambda blk: blk[1]):]:
        if a >= end:
            break
        total += min(b, end) - max(a, start)
    return total / span


def _word_spans(words: Iterable[dict]) -> list[tuple[float, float]]:
    return union_spans((w["start"], w["end"]) for w in words)


def _contested_runs(
    primary: list[dict], secondary_language: str, expected: "frozenset[str]" = frozenset()
) -> list[list[dict]]:
    """Runs of primary words the primary itself attributes to a language
    other than the secondary reading's. A word with no (or an empty)
    language tag, a word in the secondary's language, a clause-level
    record, or a pause longer than a clause break ends a run.

    With declared languages (``expected``) a run also ends where the tags
    cross between declared and undeclared: each run is then one kind, so
    the rule deciding it (``_settle_contested_stretches``) never lets a
    mislabelled word hand a neighbouring real-English clause to the
    monolingual reading, or the other way round.

    Runs whose time spans overlap are returned as ONE stretch. Within one
    reading words follow one another; two that cover the same time are
    contradictory takes of the same audio, delivered side by side when a
    stretch had no final and was rebuilt from interim snapshots
    (``interim-fallback``, see ``_drop_self_shadowed``). Measured on the
    2026-09-03 23:49:57 evidence take: ``multi`` delivered "Tai" (lt)
    22.72-23.04, "Ти" (en) 22.80-23.12, "mažaš mažeš" (lt) 22.96-23.92 and
    "можеш detect" (en) 23.12-24.64 for ``ru``'s "И ты можешь detect".
    Split by kind, those were four stretches over one stretch of ground:
    each claimed the ``ru`` words its span reached, so "И" and "ты" were
    settled twice ("И И ты ты") and "можешь" went to ``ru`` in one
    stretch while ``multi``'s "можеш" was settled in the next. One
    stretch per piece of ground is what makes every word of either
    reading belong to at most one stretch — and be decided once."""
    runs: list[list[dict]] = []
    run: list[dict] = []
    for word in primary:
        language = word.get("language")
        contested = (
            isinstance(language, str)
            and bool(language.strip())
            and language != secondary_language
            and not word.get(SPANLESS_WORD_FLAG)
        )
        if contested and run and (
            word["start"] - run[-1]["end"] > INTERIM_WORD_GAP_SPLIT_SEC
            or (
                expected
                and (_language_base(language) in expected)
                != (_language_base(run[-1].get("language")) in expected)
            )
        ):
            runs.append(run)
            run = []
        if contested:
            run.append(word)
        elif run:
            runs.append(run)
            run = []
    if run:
        runs.append(run)
    # ``primary`` is in start order, so the runs are too: a run that
    # starts before the ground gathered so far ends belongs to it.
    stretches: list[list[dict]] = []
    stretch_end = 0.0
    for run in runs:
        if stretches and run[0]["start"] < stretch_end:
            stretches[-1].extend(run)
        else:
            stretches.append(list(run))
            stretch_end = run[0]["start"]
        stretch_end = max(stretch_end, max(w["end"] for w in run))
    return stretches


def _language_base(tag: object) -> str:
    """``"en-US"`` → ``"en"``: the language a tag names, for comparing a
    word's tag with the user's declared languages."""
    return str(tag or "").strip().lower().split("-", 1)[0]


def _settle_contested_stretches(
    primary: list[dict],
    secondary: list[dict],
    secondary_language: str,
    expected_languages: "Iterable[str]" = (),
) -> tuple[list[dict], list[dict], list[dict], int, int]:
    """One owner for every stretch the readings hear in different languages.

    The word-by-word rules below (``_pairs`` + ``_resolve``) assume both
    readings heard the same LANGUAGE and differ only in spelling. Where
    the multilingual reading decides a stretch is in another language,
    that assumption is gone, and pairing word by word interleaves two
    transcripts of the same audio — measured 2026-11-20 on a screen-mode
    take: ``multi`` heard Russian speech as Lithuanian ("Ir galgenas
    žamanas tačiau kompiuterių net", tagged ``lt``), ``ru`` heard it
    correctly, and the merge delivered "Ir galgenas я žamanas tačiau
    kompiuterių у net" — the Latin rule kept every Lithuanian word and
    the unpaired Russian ones fell in between.

    A stretch is a run of primary words tagged with a language other than
    the secondary's (``_contested_runs``). The evidence that decides it is
    each reading's own confidence over that stretch — not a list of
    languages: on this user's trilingual recording (2026-09-03 23:49:57)
    ``multi`` also labelled Russian speech ``uk``, ``bg`` and ``de``, and
    it labelled the genuinely English "Agents workflow" ``en``. Measured
    mean confidences, primary vs secondary over the same stretch:

    * Lithuanian hallucination  0.85 vs 0.89 → secondary
    * German hallucination      0.64 vs 0.95 → secondary
    * Bulgarian mix             0.80 vs 0.85 → secondary
    * real English              0.98 vs 0.84 → primary

    A reading cannot be confident about speech in a language it was not
    reading, which is what makes the comparison the right question. It
    holds for the other partner the picker offers too: with ``en`` as
    the secondary (``--dual en`` on the same trilingual take, 2026-11-20)
    the contested stretches are ``multi``'s Russian ones, and over the
    four of them ``en`` reached 0.39 / 0.77 / 0.36 / 0.67 against
    ``multi``'s 0.76 / 0.85 / 0.68 / 0.70 while covering 92 / 17 / 86 /
    12 % of their ground — every one stayed with ``multi``. Replay any
    such measurement offline with ``backend.tools.dual_replay``.

    * The secondary has no words there → the primary keeps the stretch:
      it is the only reading of it (the French clause ``ru`` skipped in
      the September measurement).
    * Either side carries no confidence at all → undecided, the stretch
      is left to the word-by-word rules exactly as before.
    * The secondary's words (all of them, not only those whose midpoint
      falls inside) cover less than
      ``SPANLESS_SHADOW_MIN_FRACTION`` of the stretch → the primary owns
      it, and those few words are dropped. This is the limit case above
      seen from one word further: a reading that skipped a clause but
      emitted one fragment inside it has still not READ that clause, and
      the mean confidence of one word is no evidence about six seconds
      of speech. The same fraction ``_drop_shadowed_spanless`` already
      requires before one reading's words may stand in for the other's
      clause — "the other reading actually covers this ground" means
      one thing in this module.
    * Otherwise the more confident reading owns the stretch (a tie goes
      to the secondary — the language the user chose): the other
      reading's words inside it are dropped, and the owner's words are
      SETTLED — final, kept out of the word-by-word pairing, because that
      pairing would otherwise match a settled word against a neighbour
      just outside the stretch and drop the neighbour (measured: "Да,"
      lost to "workflow." once ``ru``'s own "workflow." was gone).

    The user's declared languages (``expected_languages`` — the language
    hints, ``backend.deepgram_language``) are evidence the confidence
    comparison cannot replace. Since Deepgram's 2026-10-23 switch to a
    55-language ``multi`` model it labels this user's Russian as Latvian,
    Ukrainian, Persian with confidence up to 0.99 — higher than ``ru``'s
    correct reading of the same words (measured 2026-11-20: "Так, так,
    так" → ``lv`` "tak, tak, tak" 0.90 vs ``ru`` 0.85; "Так, а ещё у нас
    пропали звуки" → ``uk`` "Так а йшов у нас пропали звуки" 0.82 vs
    ``ru`` 0.96). The ``language_hint`` itself only biases ``multi``; it
    did not change either reading. So: a stretch tagged with a language
    the user did NOT declare goes to the secondary whenever the secondary
    covers it (the coverage rule below still applies — a clause the
    secondary skipped stays with the only reading of it). A stretch in a
    declared language (real English) is decided by confidence exactly as
    before, and with no declared languages nothing changes.

    Returns the unsettled remainder of each reading, the settled words,
    and how many stretches went to each reading.
    """
    expected = {_language_base(code) for code in (expected_languages or ()) if _language_base(code)}
    to_secondary = 0
    to_primary = 0
    removed_primary: set[int] = set()
    removed_secondary: set[int] = set()
    settled: list[dict] = []
    # Candidate rivals, ordered by midpoint once, so each stretch finds its
    # own by bisection instead of rescanning the whole secondary reading
    # — the O(runs x words) shape B-002 removed from ``_pairs``.
    by_mid = sorted(
        ((w["start"] + w["end"]) / 2, i)
        for i, w in enumerate(secondary)
        if not w.get(SPANLESS_WORD_FLAG)
    )
    mids = [mid for mid, _i in by_mid]
    # What the secondary reading's words cover at all — the ground it
    # actually READ. Every word counts here, not only the midpoint
    # rivals: a long secondary word that starts inside the stretch and
    # ends after it (measured: ``ru``'s "слушай." 1.52-4.48 s against
    # ``multi``'s ``uk``-tagged "Так, слушай" 1.20-2.24 s) is ground the
    # partner heard, even though its midpoint lies outside.
    secondary_ground = _word_spans(
        w for w in secondary if not w.get(SPANLESS_WORD_FLAG)
    )
    for run in _contested_runs(primary, secondary_language, frozenset(expected)):
        # A stretch that gathered overlapping takes (``_contested_runs``)
        # ends where its longest word does, not where its last one does.
        start, end = run[0]["start"], max(w["end"] for w in run)
        # A word belongs to the stretch its midpoint falls in, half-open
        # [start, end): no overlap threshold to tune, and a word that only
        # grazes an edge (the "Да," after "Agents workflow.") stays out.
        lo = bisect.bisect_left(mids, start)
        hi = bisect.bisect_left(mids, end)
        rivals = [secondary[i] for _mid, i in sorted(by_mid[lo:hi], key=lambda t: t[1])]
        if not rivals:
            continue
        primary_conf = _mean_confidence(run)
        secondary_conf = _mean_confidence(rivals)
        if primary_conf is None or secondary_conf is None:
            continue
        coverage = _covered_fraction(secondary_ground, start, end)
        removed_primary.update(id(w) for w in run)
        removed_secondary.update(id(w) for w in rivals)
        # One kind per run (``_contested_runs`` splits at the boundary),
        # except where the reading's own overlapping takes of one ground
        # were gathered into a single stretch. Only a stretch EVERY take
        # of which is in an undeclared language is the mislabelling the
        # rule overrides confidence for; where the reading also offered
        # a declared-language take of the same ground, confidence decides.
        undeclared = bool(expected) and all(
            _language_base(w.get("language")) not in expected for w in run
        )
        to_secondary_here = coverage >= SPANLESS_SHADOW_MIN_FRACTION and (
            undeclared or secondary_conf >= primary_conf
        )
        if to_secondary_here:
            settled.extend(rivals)
            to_secondary += 1
        else:
            settled.extend(run)
            to_primary += 1
        logger.info(
            "dual-stream contested %.2f-%.2fs %s(%s)=%.3f vs %s=%.3f "
            "coverage=%.2f undeclared=%s → %s",
            start, end,
            run[0].get("source", "primary"), run[0].get("language", "?"), primary_conf,
            secondary_language, secondary_conf, coverage, undeclared,
            secondary_language if to_secondary_here else run[0].get("source", "primary"),
        )
    return (
        [w for w in primary if id(w) not in removed_primary],
        [w for w in secondary if id(w) not in removed_secondary],
        settled,
        to_secondary,
        to_primary,
    )


def _resolve(primary_word: dict, secondary_word: dict) -> dict:
    """Which spelling wins when both readings heard the same moment.

    * Same alpha core — no disagreement at all. The primary's token
      carries the formatting the app renders, so it wins.
    * Different cores, and either token has Latin letters — the
      multilingual reading wins: it keeps "Sonnet" as "Sonnet" where a
      monolingual Russian reading transliterates it.
    * Different cores, both Cyrillic — the secondary wins, because that
      is the measured stronger reading on Cyrillic content (audit §1).
      Measured side effect: this is what deleted the documented "Локи"
      hallucination from the 83 s recording.
    """
    core_p = word_core(primary_word)
    if core_p and core_p == word_core(secondary_word):
        return dict(primary_word)
    if _has_latin(primary_word["word"]) or _has_latin(secondary_word["word"]):
        winner = (
            primary_word
            if _has_latin(primary_word["word"])
            else secondary_word
        )
        return dict(winner)
    return dict(secondary_word)


def _drop_duplicate_runs(words: list[dict]) -> tuple[list[dict], int]:
    """Remove a run transcribed twice across a provenance junction.

    Where the merged sequence switches from one reading to the other, up
    to ``CROSS_FINAL_NGRAM_MAX_WORDS`` words on each side are compared by
    stem; a match counts as a duplicate only when every matched pair also
    describes the same audio (``_same_audio``). Without that second test
    a deliberate repeat — "subagents, subagents", confirmed by listening
    — would be silently halved.

    Mirrors ``drop_repeated_seam_ngrams``, which does the same job for
    the seam between two finals of ONE reading.
    """
    out = list(words)
    dropped = 0
    i = 1
    while i < len(out):
        if out[i]["source"] == out[i - 1]["source"]:
            i += 1
            continue
        matched = 0
        for n in range(min(CROSS_FINAL_NGRAM_MAX_WORDS, i, len(out) - i), 0, -1):
            tail = out[i - n:i]
            head = out[i:i + n]
            tail_stems = [token_stem(w["word"]) for w in tail]
            head_stems = [token_stem(w["word"]) for w in head]
            if not all(tail_stems) or tail_stems != head_stems:
                continue
            if all(_same_audio(t, h) for t, h in zip(tail, head)):
                matched = n
                break
        if not matched:
            i += 1
            continue
        tail = out[i - matched:i]
        head = out[i:i + matched]
        dropped += matched
        if tail[0]["start"] <= head[0]["start"]:
            del out[i:i + matched]
        else:
            del out[i - matched:i]
            i -= matched
        i += 1
    return out, dropped


def _drop_self_shadowed(
    unpaired: list[dict], paired_own: list[dict]
) -> tuple[list[dict], int]:
    """Drop unpaired words whose ground their OWN reading already gave
    to a paired word.

    An unpaired word is a hole fill — speech the other reading missed —
    only where its own reading has no other word for that time. Within
    one reading words follow one another; two that cover the same time
    are two contradictory takes the reading delivered side by side,
    which happens when a stretch had no final and was rebuilt from
    interim snapshots (``interim-fallback``). Measured on the 2026-09-04
    02:45:13 evidence take: ``multi`` delivered "открытая" 12.42-13.94
    and, inside it, "Причем" 13.38-13.54 (confidence 0.46) from another
    snapshot; ``ru`` had "Причем" at 11.54 and "открыта" 13.38-13.94.
    Once "открытая" pairs with its counterpart "открыта" (``_pairs``),
    the stray "Причем" is no unheard word — the reading itself already
    accounted for that ground — and filling it in printed "Причем"
    twice.

    "Already accounted for" is the module's one coverage measure:
    the paired words of the same reading cover at least
    ``SPANLESS_SHADOW_MIN_FRACTION`` of the word (``_covered_fraction``).
    A word only the other reading's words overlap is untouched — that is
    "деплой" under ``ru``'s stretched "на", the case agreement-first
    pairing exists for. Clause records are left to
    ``_reconcile_spanless``, which owns them.
    """
    if not unpaired or not paired_own:
        return unpaired, 0
    ground = _word_spans(w for w in paired_own if not w.get(SPANLESS_WORD_FLAG))
    kept = [
        w for w in unpaired
        if w.get(SPANLESS_WORD_FLAG)
        or _covered_fraction(ground, w["start"], w["end"]) < SPANLESS_SHADOW_MIN_FRACTION
    ]
    return kept, len(unpaired) - len(kept)


def _word_key(word: dict) -> tuple:
    """A reading record's identity across the merge's copies of it."""
    return (word["source"], word["start"], word["end"], word["word"])


def _reading_context(
    segments: list[dict], source: str
) -> dict[tuple, tuple[Optional[tuple], bool, bool]]:
    """Per record of one reading: the key of the record before it in
    that reading (``None`` for its first); whether it stood at a
    position Deepgram capitalises for — first of its final (Deepgram
    formats every final as a text of its own) or after a sentence-ending
    word; and whether it followed a sentence-ending word, i.e. the
    reading itself says a sentence begins with it.

    Built from ``flatten_words`` one final at a time, so the records are
    the ones the merge itself works on."""
    context: dict[tuple, tuple[Optional[tuple], bool, bool]] = {}
    previous: Optional[dict] = None
    for segment in segments:
        for i, record in enumerate(flatten_words([segment], source)):
            # The reading's first word opens only the reading's text; where
            # the merge puts it, that is the merge's start or not.
            opens = previous is not None and ends_sentence(previous["word"])
            context[_word_key(record)] = (
                _word_key(previous) if previous is not None else None,
                i == 0 or previous is None or opens,
                opens,
            )
            previous = record
    return context


def _settle_case(
    merged: list[dict],
    readings_of: dict[int, tuple[dict, ...]],
    context: dict[tuple, tuple[Optional[tuple], bool, bool]],
    names: "frozenset[str]" = frozenset(),
) -> None:
    """Give a merged word whose case is in question the case of its
    place (``backend.word_case``); mutates ``merged`` in place.
    ``names`` are the keyterms' names (``backend.word_case.
    lexical_names``): a capital on one of them is the word's own even
    where every reading had the word at a start.

    A word's case is in question when the readings it stands for
    disagree on it ("Же" against "же,") or when it no longer follows
    the word it followed in any reading that has it — then its capital
    may have been its old position's ("Иногда" opening a ``ru`` final,
    now after a ``multi`` word). A word that agrees with every reading
    that has it and keeps a neighbour it had is left exactly as read.
    Clause records (``SPANLESS_WORD_FLAG``) are a whole clause, not a
    word, and are left as read.

    The place is a sentence start when the merged word before it ends a
    sentence — or when every reading that has the word says a sentence
    begins with it. The second is the readings' own punctuation outliving
    the merge's word order: 2026-09-04 02:43:24, both readings wrote
    "31. Посмотри", and the merge put ``multi``'s "2" between them.
    """
    merged_index: dict[tuple, int] = {}
    for i, word in enumerate(merged):
        for record in readings_of.get(id(word), ()):
            merged_index[_word_key(record)] = i
    for i, word in enumerate(merged):
        records = readings_of.get(id(word), ())
        if not records or word.get(SPANLESS_WORD_FLAG):
            continue
        own = [context.get(_word_key(r), (None, True, False)) for r in records]
        agree = len({is_capitalised(r["word"]) for r in records}) == 1
        kept_neighbour = any(
            (merged_index.get(prev) if prev is not None else None)
            == (i - 1 if i > 0 else None)
            for prev, _start, _opens in own
        )
        if agree and kept_neighbour:
            continue
        word["word"] = cased_for_place(
            word["word"],
            sentence_start=(
                starts_sentence(merged[i - 1]["word"] if i > 0 else None)
                or all(opens for _prev, _start, opens in own)
            ),
            lexical=capital_is_lexical(
                ((r["word"], at_start) for r, (_prev, at_start, _opens) in zip(records, own)),
                names,
            ),
        )


def _speaker_turns(segments: list[dict]) -> list[tuple[float, float, int]]:
    """``(start, end, speaker)`` for every primary segment that has one.

    The PRIMARY's diarization is the only one this product shows: it is
    the reading whose interims and finals the live preview rendered, and
    the two readings are two independent Deepgram sessions, so their
    speaker indices are numbered independently — the secondary's
    "speaker 0" is not the primary's. One owner of who-spoke-when, read
    by time, is the only labelling that cannot contradict itself.
    """
    turns: list[tuple[float, float, int]] = []
    for seg in segments:
        speaker = seg.get("speaker")
        if isinstance(speaker, bool) or not isinstance(speaker, int):
            continue
        turns.append((float(seg.get("start") or 0.0), float(seg.get("end") or 0.0), speaker))
    turns.sort()
    return turns


def _label_speakers(words: list[dict], turns: list[tuple[float, float, int]]) -> None:
    """Give every merged word the speaker of the primary turn it falls in.

    A word inside a turn (by its midpoint) takes that turn's speaker; a
    word in no turn — a stretch only the secondary heard — takes the
    nearest turn's. Nothing is labelled when the primary carried no
    speakers (diarization off), so the merged envelope keeps exactly the
    shape a single reading would have.
    """
    if not turns:
        return
    starts = [t[0] for t in turns]
    for word in words:
        mid = (word["start"] + word["end"]) / 2.0
        i = bisect.bisect_right(starts, mid) - 1
        candidates = [turns[j] for j in (i, i + 1) if 0 <= j < len(turns)]

        def _distance(turn: tuple[float, float, int]) -> float:
            if turn[0] <= mid <= turn[1]:
                return 0.0
            return min(abs(mid - turn[0]), abs(mid - turn[1]))

        word["speaker"] = min(candidates, key=_distance)[2]


def _segments_from_words(words: list[dict]) -> list[dict]:
    """Group merged words into segments at clause-length silences
    (``INTERIM_WORD_GAP_SPLIT_SEC`` — the number the single-stream splice
    groups recovered words by, so "these words belong to one clause"
    means one thing in this product) and,
    when the words carry speakers, at every change of speaker — the same
    per-segment ``speaker`` the single-reading path delivers."""
    segments: list[dict] = []
    for word in words:
        if (
            segments
            and word["start"] - segments[-1]["end"] <= INTERIM_WORD_GAP_SPLIT_SEC
            and word.get("speaker") == segments[-1].get("speaker")
        ):
            segment = segments[-1]
            segment["end"] = round(max(segment["end"], word["end"]), 3)
            segment["words"].append(word)
            continue
        segment = {
            "start": round(word["start"], 3),
            "end": round(word["end"], 3),
            "text": "",
            "confidence": 0.0,
            "is_final": True,
            "speech_final": False,
            "words": [word],
            "source": "dual-merge",
        }
        if "speaker" in word:
            segment["speaker"] = word["speaker"]
        segments.append(segment)
    for segment in segments:
        segment["text"] = " ".join(w["word"] for w in segment["words"])
        segment["words"] = [dict(w) for w in segment["words"]]
    return segments


def merge_readings(
    primary_segments: Iterable[dict],
    secondary_segments: Iterable[dict],
    *,
    primary_language: str = "multi",
    secondary_language: str = DUAL_SECONDARY_LANGUAGE_DEFAULT,
    expected_languages: "Iterable[str]" = (),
    keyterms: "Iterable[str]" = (),
) -> MergedReading:
    """Merge two readings of one recording into one transcript.

    Pure: takes the two finalized segment lists, returns the merged
    words (each carrying the ``source`` it came from), the segments they
    group into, and the counts the stop line reports.

    ``primary_language`` / ``secondary_language`` are the Deepgram
    language codes each reading ran in. They are what the contested-
    stretch rule compares per-word language tags against, and they are
    also the ``source`` label each word carries — named for the first
    job so a caller cannot pass a free-form provenance string and
    silently change which stretches count as contested.

    ``keyterms`` are the ones both readings were decoded with
    (``DeepgramLiveConfig.keyterms``): the names among them keep their
    capital wherever a merged word lands (``backend.word_case``).
    """
    primary_segments = list(primary_segments or [])
    # Read twice — flattened for the merge, and per segment for the case
    # evidence — so a one-shot iterable must not be consumed by the first.
    secondary_segments = list(secondary_segments or [])
    turns =_speaker_turns(primary_segments)
    primary = flatten_words(primary_segments, primary_language)
    secondary = flatten_words(secondary_segments, secondary_language)
    if not secondary:
        # Single-stream degradation, and the common case when the
        # secondary socket failed: the primary reading, untouched.
        merged = [dict(w) for w in primary]
        _label_speakers(merged, turns)
        return MergedReading(
            words=merged,
            segments=_segments_from_words(merged),
            text=" ".join(w["word"] for w in merged),
            primary_word_count=len(primary),
            secondary_word_count=0,
        )

    # What each reading actually delivered, before the merge starts
    # discarding from either — the stop line reports the readings, not
    # the merge's working set.
    primary_count = len(primary)
    secondary_count = len(secondary)
    # Clause-level records first, before anything is paired: a final
    # that arrived without word timings cannot be merged word by word,
    # so exactly one reading owns the ground it covers.
    primary, secondary = _reconcile_spanless(primary, secondary)
    primary, secondary, settled, contested_to_secondary, contested_to_primary = (
        _settle_contested_stretches(primary, secondary, secondary_language, expected_languages)
    )
    paired, only_primary, only_secondary = _pairs(primary, secondary)
    only_primary, shadowed_primary = _drop_self_shadowed(
        only_primary, [pw for pw, _sw in paired]
    )
    only_secondary, shadowed_secondary = _drop_self_shadowed(
        only_secondary, [sw for _pw, sw in paired]
    )
    # Which reading records each merged word stands for — the evidence
    # ``_settle_case`` reads. Keyed by the merged dict's identity: the
    # sort and the duplicate drop below move and delete words but never
    # copy them.
    readings_of: dict[int, tuple[dict, ...]] = {}
    merged = []
    for pw, sw in paired:
        word = _resolve(pw, sw)
        readings_of[id(word)] = (pw, sw)
        merged.append(word)
    for w in (*settled, *only_primary, *only_secondary):
        word = dict(w)
        readings_of[id(word)] = (w,)
        merged.append(word)
    merged.sort(key=lambda w: (w["start"], w["end"]))
    merged, duplicates = _drop_duplicate_runs(merged)
    _settle_case(
        merged,
        readings_of,
        {
            **_reading_context(primary_segments, primary_language),
            **_reading_context(secondary_segments, secondary_language),
        },
        lexical_names(keyterms),
    )
    _label_speakers(merged, turns)
    return MergedReading(
        words=merged,
        segments=_segments_from_words(merged),
        text=" ".join(w["word"] for w in merged),
        primary_word_count=primary_count,
        secondary_word_count=secondary_count,
        filled_from_secondary=len(only_secondary),
        filled_from_primary=len(only_primary),
        duplicates_removed=duplicates + shadowed_primary + shadowed_secondary,
        contested_to_secondary=contested_to_secondary,
        contested_to_primary=contested_to_primary,
    )


#: Every key ``dual_stats`` adds to a ``final`` envelope's ``stats``. The
#: contract fixture (``contracts/live-final-envelope.json``) is built
#: through ``dual_stats`` too, so producer and contract cannot disagree.
DUAL_STATS_KEYS = (
    "dual_stream",
    "dual_secondary_language",
    "dual_secondary_failed",
    "dual_filled_from_secondary",
    "dual_filled_from_primary",
    "dual_duplicates_removed",
    "dual_contested_to_secondary",
    "dual_contested_to_primary",
)


def dual_stats(
    merged: MergedReading, *, secondary_language: str, secondary_failed: bool
) -> dict:
    """The dual-stream half of a ``final`` envelope's ``stats``.

    ``dual_stream`` — the boolean the renderer reads — says whether the
    TEXT is a merge of two readings: true exactly when the secondary
    contributed words to it. A second reading that was dropped mid-
    recording still delivered what it had committed before it died, and
    that is merged; whether it failed is a separate fact
    (``dual_secondary_failed``), so neither number misdescribes the other.
    """
    return {
        "dual_stream": merged.secondary_word_count > 0,
        "dual_secondary_language": secondary_language,
        "dual_secondary_failed": bool(secondary_failed),
        "dual_filled_from_secondary": merged.filled_from_secondary,
        "dual_filled_from_primary": merged.filled_from_primary,
        "dual_duplicates_removed": merged.duplicates_removed,
        "dual_contested_to_secondary": merged.contested_to_secondary,
        "dual_contested_to_primary": merged.contested_to_primary,
    }


# ---------------------------------------------------------------------
# The facade
# ---------------------------------------------------------------------


class DualLiveSession:
    """Two ``DeepgramLiveSession``s behind the interface of one.

    The WebSocket handler drives this exactly as it drives a single
    session — one ``send_pcm``, one ``events()``, one
    ``drain_transcript``, one envelope — so there is one stop chain in
    this product, not two.

    Three asymmetries, all deliberate:

    * EVENTS come only from the primary — and ``events()`` follows a
      ``replace_primary`` swap transparently, so that stays true across
      the whole recording, not just up to the first replacement. The
      live preview and every renderer buffer downstream of it are built
      for one stream of interims and finals; two would interleave into
      nonsense, and the secondary's value is in the merge at stop, not
      on screen.
    * ERRORS are the primary's alone. A secondary that dies takes the
      recording's completeness back to where it was without this
      feature, which is not a failure worth aborting a recording for —
      it is logged once and the merge sees an empty reading.
    * AUDIO goes to both, but only the primary's write is on the
      caller's path. The secondary is fed by its own task from its own
      queue (``_feed_secondary_loop``): a half-open second socket whose
      write blocks used to stop the primary's audio too, and the send
      watchdog in ``backend.main`` then reported the RECORDING wedged
      (BE-05). A write is never cancelled (cancelling one mid-frame
      leaves that connection undefined); a secondary that holds audio
      unwritten for ``SEND_WEDGE_SEC`` is dropped to one reading and its
      socket closed, which is what releases the write.
    """

    def __init__(
        self,
        primary: DeepgramLiveSession,
        secondary: DeepgramLiveSession,
        *,
        secondary_language: str = DUAL_SECONDARY_LANGUAGE_DEFAULT,
        primary_language: str = "multi",
        expected_languages: "Iterable[str]" = (),
    ) -> None:
        self.primary = primary
        self.secondary: Optional[DeepgramLiveSession] = secondary
        self._secondary_language = secondary_language
        self._primary_language = primary_language
        # The user's declared languages (the language hints): evidence the
        # contested-stretch rule weighs (``_settle_contested_stretches``).
        self._expected_languages = tuple(expected_languages or ())
        self._secondary_failed = False
        # The last merge this facade produced. Coverage questions
        # asked AFTER the stop ("what is still missing?") must be
        # answered against the merged transcript, not against either
        # reading alone — a hole the primary reported is not a hole in
        # what the user receives if the secondary's words went into it.
        self._last_merged: Optional[MergedReading] = None
        # The two readings that merge was built from, exactly as each
        # session delivered them. Read by ``backend.tools.deepgram_live_ab
        # --dump-readings`` so a change to the merge rules can be replayed
        # against a real recording's readings offline, instead of paying
        # Deepgram again for every variant of the rule.
        self.last_readings: Optional[tuple[dict, Optional[dict]]] = None
        # The second reading's own audio path (see the class docstring):
        # ``(monotonic enqueue time, chunk)`` waiting for the feeder task.
        self._secondary_queue: "deque[tuple[float, bytes]]" = deque()
        self._secondary_wakeup = asyncio.Event()
        self._secondary_feeder: Optional[asyncio.Task] = None
        self._secondary_closing: Optional[asyncio.Task] = None

    # ----- The single-session interface --------------------------------

    @property
    def expected_languages(self) -> "tuple[str, ...]":
        """The user's declared languages this merge weighs."""
        return self._expected_languages

    @property
    def stats(self) -> DeepgramLiveStats:
        return self.primary.stats

    @property
    def is_closed(self) -> bool:
        return self.primary.is_closed

    @property
    def last_error(self) -> Optional[str]:
        return self.primary.last_error

    @property
    def last_fatal(self) -> bool:
        return self.primary.last_fatal

    @property
    def stream_death_sec(self) -> Optional[float]:
        """When the recording's upstream died — the PRIMARY's answer.

        The secondary owns nothing the user would notice losing (see the
        class docstring), so the moment THIS recording stopped reaching
        Deepgram is the moment the primary stopped reaching it.
        """
        return self.primary.stream_death_sec

    @property
    def endpointing_sec(self) -> float:
        return self.primary.endpointing_sec

    @property
    def utterance_end_sec(self) -> float:
        """Both readings run the same config (``secondary_config``)."""
        return self.primary.utterance_end_sec

    @property
    def last_utterance_end(self) -> Optional[float]:
        """The furthest point EITHER reading has confirmed as an utterance end.

        Same shape as ``interim_window_end``: either decoder saying "the
        utterance ended here" is evidence about the recording, and the
        later claim is the one that describes the tail. A reading that
        never sent one contributes nothing rather than ``None`` for both.
        """
        ends = [
            value
            for value in (
                self.primary.last_utterance_end,
                self.secondary.last_utterance_end if self.secondary is not None else None,
            )
            if value is not None
        ]
        return max(ends) if ends else None

    @property
    def streamed_sec(self) -> float:
        """The recording's streamed position — both readings are fed the
        same bytes, so the furthest either got is the recording's."""
        values = [self.primary.streamed_sec]
        if self.secondary is not None:
            values.append(self.secondary.streamed_sec)
        return max(values)

    def committed_segments(self) -> list[dict]:
        """Both readings' committed segments, for coverage only.

        Not a transcript: overlapping segments from the two readings
        would read as a doubled one. It is the union of the GROUND the
        two readings account for, which is what the recovery budget
        prediction asks about — the merge that turns them into one
        transcript happens at stop, in ``_merged_envelope``.
        """
        out = list(self.primary.committed_segments())
        if self.secondary is not None:
            out.extend(self.secondary.committed_segments())
        return out

    @property
    def interim_window_end(self) -> float:
        """The furthest either reading's decoder has reached.

        Evidence that SOMETHING is still working the tail — and either
        reading still working it is evidence, so this is a max and not
        the primary's alone.
        """
        ends = [self.primary.interim_window_end]
        if self.secondary is not None:
            ends.append(self.secondary.interim_window_end)
        return max(ends)

    def interim_speech_spans(self) -> list[tuple[float, float]]:
        """Where EITHER reading heard words. Merged, so nothing counts twice."""
        spans = list(self.primary.interim_speech_spans())
        if self.secondary is not None:
            spans.extend(self.secondary.interim_speech_spans())
        return union_spans(spans)

    def coverage_hole_spans(self) -> list[tuple[float, float]]:
        """What the MERGED transcript still fails to cover.

        Both readings' holes taken together, minus whatever the merged
        words actually cover. Before the merge exists (the recovery
        budget is estimated at announce time, mid-stop) the honest
        answer is the union of both readings' holes.
        """
        holes = list(self.primary.coverage_hole_spans())
        if self.secondary is not None:
            holes.extend(self.secondary.coverage_hole_spans())
        if self._last_merged is None:
            return union_spans(holes)
        return subtract_spans(holes, self._last_merged.covered_spans())

    def report_fatal(self, message: str) -> None:
        self.primary.report_fatal(message)

    def note_undelivered_audio(self, nbytes: int) -> None:
        self.primary.note_undelivered_audio(nbytes)
        if self.secondary is not None:
            self.secondary.note_undelivered_audio(nbytes)

    async def events(self):
        """Yield the CURRENT primary's events, across any number of swaps.

        ``DeepgramLiveSession.events()`` promises "exactly one consumer,
        for the life of the session" — a caller gets one generator and
        drives it until the recording ends. This facade has to keep that
        same promise even though ITS primary can be replaced mid-flight
        (``replace_primary``, the warm-socket liveness path in
        ``backend.main``): a caller that took a snapshot of
        ``self.primary.events()`` at construction time would silently
        stop receiving anything the moment the old primary's socket was
        torn down (``discard()`` pushes the sentinel that ends its
        generator), even though a fresh primary is now live and still
        producing finals. That is exactly the failure this method exists
        to prevent — read ``self.primary`` fresh each time the previous
        primary's stream ends, and only stop once it truly is the same
        primary that started this leg.
        """
        while True:
            current_primary = self.primary
            async for event in current_primary.events():
                yield event
            if self.primary is current_primary:
                return

    def final_text(self) -> str:
        return self.primary.final_text()

    def partial_result(self) -> dict:
        """A merged envelope from whatever both readings hold RIGHT NOW.

        Same promise ``DeepgramLiveSession.partial_result`` makes — a
        read of committed state, no Finalize, no waiting — kept for a
        dual recording so a caller that cannot wait for
        ``drain_transcript`` (the WS handler's error path, whose payload
        is now the input to the REST recovery pass) gets the MERGED
        transcript rather than one reading of it.
        """
        return self._merged_envelope(
            self.primary.partial_result(),
            self.secondary.partial_result() if self.secondary is not None else None,
        )

    async def send_pcm(self, chunk: bytes) -> None:
        # The primary's exception is the caller's, unchanged: it owns
        # the recording. The secondary only gets the chunk queued — its
        # write happens on its own task and can never hold this one up.
        await self.primary.send_pcm(chunk)
        self._offer_secondary(chunk)

    def _offer_secondary(self, chunk: bytes) -> None:
        """Queue a chunk for the second reading. Never awaits."""
        if self.secondary is None or self._secondary_failed:
            return
        now = time.monotonic()
        if self._secondary_queue and now - self._secondary_queue[0][0] >= SEND_WEDGE_SEC:
            self._fail_secondary(
                "not accepting audio: oldest queued chunk is "
                f"{now - self._secondary_queue[0][0]:.1f}s old"
            )
            return
        self._secondary_queue.append((now, chunk))
        self._secondary_wakeup.set()
        if self._secondary_feeder is None:
            self._secondary_feeder = asyncio.get_running_loop().create_task(
                self._feed_secondary_loop(), name="deepgram-dual-secondary-feed",
            )

    async def _feed_secondary_loop(self) -> None:
        """The second reading's only writer: queued chunks, in order."""
        while not self._secondary_failed:
            if not self._secondary_queue:
                self._secondary_wakeup.clear()
                await self._secondary_wakeup.wait()
                continue
            secondary = self.secondary
            if secondary is None:
                return
            _enqueued_at, chunk = self._secondary_queue[0]
            try:
                await secondary.send_pcm(chunk)
            except Exception as e:
                self._fail_secondary(f"send failed: {e}")
                return
            if self._secondary_queue:
                self._secondary_queue.popleft()
            if not self._secondary_queue:
                # ``_secondary_flushed`` waits on exactly this.
                self._secondary_wakeup.set()

    async def _secondary_flushed(self) -> None:
        """Return once every queued chunk reached the second socket (or
        the second reading was dropped) — Finalize must follow the audio."""
        while self._secondary_queue and not self._secondary_failed:
            self._secondary_wakeup.clear()
            await self._secondary_wakeup.wait()

    def _fail_secondary(self, reason: str) -> None:
        """Drop to one reading, once, loudly enough to find later.

        Also releases the second socket: its queued audio is discarded
        and the socket is closed, which makes a write the feeder may be
        blocked in raise — the only way a write is ever unblocked here.
        """
        if self._secondary_failed:
            return
        self._secondary_failed = True
        self._secondary_queue.clear()
        self._secondary_wakeup.set()
        logger.warning(
            "dual-stream: secondary reading (%s) dropped, continuing "
            "single-stream: %s",
            self._secondary_language,
            reason,
        )
        secondary = self.secondary
        if secondary is not None and self._secondary_closing is None:
            self._secondary_closing = asyncio.get_running_loop().create_task(
                secondary.close(), name="deepgram-dual-secondary-close",
            )

    @property
    def secondary_failed(self) -> bool:
        return self._secondary_failed

    def replace_primary(self, fresh: DeepgramLiveSession) -> DeepgramLiveSession:
        """Swap the primary socket, returning the one replaced.

        The warm-socket liveness path in ``backend.main`` replaces a
        socket that never answered. Only the primary is probed — it is
        the one whose silence the user would notice — so this is where
        that swap lands when the recording is running two readings.

        Mutates ``self.primary`` in place rather than handing back a new
        facade, which is exactly why ``events()`` has to notice the swap
        itself instead of relying on a caller's identity check: the
        facade object a WS handler holds never changes, only what it
        wraps does.
        """
        old = self.primary
        self.primary = fresh
        return old

    # ----- Stop --------------------------------------------------------

    async def drain_transcript(self, on_budget=None) -> dict:
        """Drain both readings under ONE budget and merge them.

        The budget is announced by the PRIMARY, once — it is the same
        recording, the same stop, and the renderer is owed one deadline.
        The secondary is drained concurrently so it costs no extra wall
        time, and is given the primary's own budget as a hard ceiling:
        it must never be the reason a stop runs long. That budget is
        already the honest one for BOTH shapes of stop — an uncovered
        primary tail announces a larger ceiling (``on_budget``'s
        ``worst_case``, which includes the retry) than a covered one, so
        this method does not need to ask separately whether the primary's
        own tail was covered before deciding how long the secondary may
        run: the ceiling already says so.
        """
        secondary = None if self._secondary_failed else self.secondary
        secondary_task: Optional[asyncio.Task] = None
        announced: list[float] = []
        loop = asyncio.get_running_loop()
        # The announced budget is counted from the stop, so the secondary's
        # ceiling is too: measured from HERE, not from whenever the
        # primary's drain happened to return (BE-04).
        started = loop.time()

        def _on_budget(budget_sec: float, expects_more: bool) -> None:
            announced.append(budget_sec)
            if on_budget is not None:
                on_budget(budget_sec, expects_more)

        async def _drain_secondary(session: DeepgramLiveSession) -> dict:
            # Finalize must reach the second socket after every chunk
            # queued for it, exactly as the primary's sentinel guarantees.
            await self._secondary_flushed()
            return await session.drain_transcript()

        if secondary is not None:
            secondary_task = loop.create_task(
                _drain_secondary(secondary), name="deepgram-dual-secondary-drain",
            )
        try:
            primary_result = await self.primary.drain_transcript(on_budget=_on_budget)
        except BaseException:
            # Never orphan the second drain: it would keep writing
            # Finalize/CloseStream on a socket the caller is about to shut
            # down, with an exception nobody retrieves (BE-06).
            await cancel_and_await(
                secondary_task, what="dual-stream secondary drain", log=logger
            )
            raise

        secondary_result: Optional[dict] = None
        if secondary_task is not None:
            # The primary's own announced budget, again: whatever the
            # secondary still owes, the user has already been told how
            # long this stop may take.
            ceiling = announced[0] if announced else FINALIZE_FLUSH_WAIT_SEC
            remaining = ceiling - (loop.time() - started)
            try:
                secondary_result = await asyncio.wait_for(
                    secondary_task, timeout=max(0.1, remaining)
                )
            except asyncio.TimeoutError:
                # Wait for the cancellation to LAND before snapshotting.
                # The abandoned ``drain_transcript`` is still mutating
                # the secondary's ``_finalized_segments`` (its interim
                # splice appends fallback segments), and the caller runs
                # ``shutdown()`` the moment this method returns — two
                # coroutines writing one socket, one of them sending
                # ``Finalize`` while the other sends ``CloseStream``.
                await cancel_and_await(
                    secondary_task, what="dual-stream secondary drain", log=logger
                )
                # The secondary is LATE, not WRONG: its own recv loop has
                # been appending finalized segments the whole time,
                # independently of its (now-abandoned) drain_transcript()
                # call, so whatever it committed before the primary's
                # announced budget ran out is real transcript — discarding
                # it would throw away words the user actually gets to keep
                # under the single-stream path. Snapshotting it is what
                # keeps the envelope inside the announced bound without
                # also reverting to "drop the secondary entirely" for a
                # reading that only ran long, never failed — that is
                # ``_fail_secondary``'s case, not this one, so it is not
                # called here and ``stats.dual_stream`` stays true.
                secondary_result = secondary.partial_result()
                logger.warning(
                    "dual-stream: secondary late, merged partial "
                    "(budget=%.2fs, secondary reached %.2fs of %.2fs streamed)",
                    ceiling,
                    float(secondary_result.get("coveredEndSec") or 0.0),
                    float(secondary_result.get("streamedSec") or 0.0),
                )
            except Exception as e:
                self._fail_secondary(f"drain failed: {e}")
        elif self.secondary is not None:
            # Dropped mid-recording (``_fail_secondary``): its socket is
            # gone, so there is nothing to drain — but every final it
            # committed before it died is real transcript, the same as
            # a reading that merely ran late.
            try:
                secondary_result = self.secondary.partial_result()
            except Exception as e:
                logger.warning("dual-stream: dropped secondary snapshot failed: %s", e)

        return self._merged_envelope(primary_result, secondary_result)

    def _merged_envelope(
        self, primary_result: dict, secondary_result: Optional[dict]
    ) -> dict:
        secondary_segments = (secondary_result or {}).get("segments") or []
        merged = merge_readings(
            primary_result.get("segments") or [],
            secondary_segments,
            primary_language=self._primary_language,
            secondary_language=self._secondary_language,
            expected_languages=self._expected_languages,
            keyterms=self.primary.keyterms,
        )
        self._last_merged = merged
        self.last_readings = (primary_result, secondary_result)
        logger.info(
            "dual-stream merge: %s=%d words %s=%d words merged=%d "
            "filled_from_%s=%d filled_from_%s=%d dups_removed=%d "
            "contested_to_%s=%d contested_to_%s=%d",
            self._primary_language,
            merged.primary_word_count,
            self._secondary_language,
            merged.secondary_word_count,
            len(merged.words),
            self._secondary_language,
            merged.filled_from_secondary,
            self._primary_language,
            merged.filled_from_primary,
            merged.duplicates_removed,
            self._secondary_language,
            merged.contested_to_secondary,
            self._primary_language,
            merged.contested_to_primary,
        )
        streamed_sec = max(
            float(primary_result.get("streamedSec") or 0.0),
            float((secondary_result or {}).get("streamedSec") or 0.0),
        )
        envelope = dict(primary_result)
        envelope["text"] = merged.text
        # The merged words, grouped at clause-length silences in one place
        # (``_segments_from_words``); each segment carries its words and
        # every word the ``source`` it came from, which is what makes a
        # merge auditable after the fact. There is no separate flat word
        # list: ``envelope_from_result`` copies the named envelope fields
        # only, so one never reached the wire (BE-14).
        envelope["segments"] = merged.segments
        envelope["durationSec"] = round(merged.covered_end_sec(), 3)
        # NOT the merged end: the merge includes each reading's spliced
        # interim fallback, and ``coveredEndSec`` means "committed
        # provider finals up to here" on both sides of the wire. Each
        # reading already measures its own (``_committed_end_sec``), so
        # the merged answer is the further of the two — a hole one
        # reading committed past is committed ground for this envelope.
        envelope["coveredEndSec"] = round(
            max(
                float(primary_result.get("coveredEndSec") or 0.0),
                float((secondary_result or {}).get("coveredEndSec") or 0.0),
            ),
            3,
        )
        envelope["streamedSec"] = round(streamed_sec, 3)
        envelope["uncoveredSpeechSec"] = round(
            self._merged_uncovered_speech_sec(), 3
        )
        stats = dict(primary_result.get("stats") or {})
        stats.update(
            dual_stats(
                merged,
                secondary_language=self._secondary_language,
                secondary_failed=self._secondary_failed,
            )
        )
        envelope["stats"] = stats
        return envelope

    def _merged_uncovered_speech_sec(self) -> float:
        """Seconds neither reading committed and the merge could not fill.

        The total of ``coverage_hole_spans`` — one implementation of
        "what is still missing", read here as a number and by the
        recovery pass as spans, so the envelope's figure and the spans
        that get re-decoded can never describe different ground.
        """
        return sum(end - start for start, end in self.coverage_hole_spans())

    async def shutdown(self, wait_timeout: float = 3.0) -> None:
        await self._both("shutdown", wait_timeout=wait_timeout)

    async def close(self) -> None:
        await self._both("close")

    async def discard(self) -> None:
        await self._both("discard")

    async def _both(self, method: str, **kwargs) -> None:
        """Run a teardown step on both sockets AT ONCE.

        The two sockets are independent upstream connections: closing one
        neither needs nor affects the other. Run back to back, each waits
        out its own ``CloseStream`` round trip to Deepgram (~250–300 ms),
        so the session ended — and the next recording's warm sockets
        started connecting — a whole round trip later than needed
        (OPTIMIZATION.md §5 1.2: the second socket's close landed 235 ms
        after the first). The envelope is already on the wire before this
        runs (C4); what the overlap buys is the next take's warm sockets.

        The secondary's failure stays ignored (the primary carries the
        recording); the primary's is raised, after both have finished.
        """
        secondary = self.secondary

        async def _secondary_step() -> None:
            if secondary is None:
                return
            try:
                await getattr(secondary, method)(**kwargs)
            except Exception as e:
                logger.debug("dual-stream: secondary %s ignored: %s", method, e)
            # The second socket is closed now, so a write the feeder is
            # blocked in has already raised: cancelling it cannot land
            # mid-frame.
            await cancel_and_await(
                self._secondary_feeder, what="dual-stream secondary feeder", log=logger
            )
            await cancel_and_await(
                self._secondary_closing, what="dual-stream secondary close", log=logger
            )

        secondary_result, primary_result = await asyncio.gather(
            _secondary_step(),
            getattr(self.primary, method)(**kwargs),
            return_exceptions=True,
        )
        if isinstance(secondary_result, BaseException):
            # Only a cancellation of the feeder/closing joins can land here.
            raise secondary_result
        if isinstance(primary_result, BaseException):
            raise primary_result


__all__ = [
    "ADJACENT_SAME_STEM_MAX_GAP_SEC",
    "DUAL_SECONDARY_LANGUAGE_DEFAULT",
    "DUAL_SECONDARY_LANGUAGE_OPTIONS",
    "DUAL_STATS_KEYS",
    "DUAL_STREAM_DEFAULT",
    "DualLiveSession",
    "MergedReading",
    "dual_applies",
    "dual_secondary_language",
    "dual_stats",
    "dual_stream_enabled",
    "flatten_words",
    "merge_readings",
    "secondary_config",
]
