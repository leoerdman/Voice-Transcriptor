"""Self-filling Deepgram keyterm vocabulary, mined from the owner's archive.

Why
---
Nova-3 Keyterm Prompting (``backend.deepgram_keyterms``) only knows the
terms the owner typed into Settings, and the words that get misheard are
exactly the ones nobody thinks to type: project names, products, people,
code words that came up last week. They are, however, already written
down — in the archive of transcripts, many times over, because they are
what the owner talks about. This module reads that archive and ranks the
recurring names and jargon in it, and ``deepgram_keyterms.merge_keyterms``
appends them to the manual list while the shared token budget has room.

What counts as a candidate
--------------------------
A word or two-word phrase that recurs across at least
``MIN_RECORDINGS`` DIFFERENT recordings — frequency inside one long
recording proves nothing — and looks like a name rather than a word:

* **code-shaped**: letters with digits (``nova-3``, ``M4``), CamelCase
  (``MacBook``, ``WebSocket``) or an all-caps abbreviation (``SSOT``);
* **a proper name**: capitalised in the middle of a sentence nearly
  every time it appears there (``PROPER_CAPITAL_SHARE``). A sentence's
  first word proves nothing, and Deepgram's casing is noisy, so the test
  is a share across the whole corpus, not a single sighting;
* **Latin inside Russian speech**: a Latin word sitting next to Cyrillic
  ones (``сделай commit в worktree``) — the code-switching that the
  monolingual Russian reading transliterates;
* **a two-word name**: two adjacent capitalised words of one script with
  no punctuation between them (``Ultra Gen``, ``Claude Code``). A word
  that almost only appears inside such a phrase (``Gen``) is not offered
  on its own. The same word twice (``Claude Claude``) or a CamelCase
  name beside its own first or last part (``Deep DeepSeek``,
  ``DeepSeek Seek``) is a recognition stutter, not a name.

A plain single English word — neither CamelCase, nor all caps, nor with
digits — is jargon only when it is not everyday English: ``worktree``
is offered, ``code``, ``model``, ``main`` are not, and neither are
``Deep`` or ``Seek`` split off ``DeepSeek`` (``backend.
english_frequent_words``). Nova-3 knows everyday words already; as
keyterms they would only spend budget and pull recognition toward
themselves. The same words inside a recurring two-word name
(``Liquid Glass``) still count.

The app's own name (``BUILTIN_TERMS``) heads the list whatever the
archive says: it is what the owner dictates about all day, and its
misreadings (``транскиптер``) are exactly what the archive cannot learn
it from.

Russian inflects names (``Транскриптора``, ``Транскриптором``), so
Cyrillic forms are grouped by a light ending strip and the most frequent
spelling represents the group. Common words that pass those tests anyway
(``Okay``, ``English``, ``Вы``) are cut by a short stop list
(``_STOP_WORDS``).

Cost and freshness
------------------
Nothing here is on the recording path. ``AutoKeytermStore`` recomputes
in a worker thread — at backend start and, debounced, after the archive
changes — and the WebSocket handler only reads an immutable tuple. Each
transcript's statistics are cached by (mtime, size), so a recompute after
a save reads the one new file; only the newest ``MAX_CORPUS_RECORDINGS``
transcripts count, which bounds both the cost and how stale a term can
be. The ranking is persisted (``auto_keyterms.json`` in the data
directory, a derived cache — deleting it only costs one recompute) so a
fresh start sends the same keyterms as the last run before the first
recompute finishes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Iterable, Optional

from backend.deepgram_keyterms import AUTO_KEYTERM_MAX_CHARS, keyterm_token_cost
from backend.english_frequent_words import is_frequent_english
from backend.storage import atomic_write_json

# A child of "backend": main.py routes that tree to stderr, i.e. main.log.
logger = logging.getLogger(__name__)

#: A term must recur in at least this many different recordings.
MIN_RECORDINGS = 3

#: The app's own name, in both scripts it is dictated in: always first
#: in the vocabulary, because the archive holds it misheard and cannot
#: teach it. The one place it is spelled for recognition.
BUILTIN_TERMS: tuple[str, ...] = ("Transcriptor", "Транскриптор")

#: How many automatic terms are kept. Every keyterm biases recognition
#: toward itself, so the list stays a focused vocabulary rather than
#: filling the whole 500-token budget with marginal words.
MAX_AUTO_TERMS = 60

#: Only the newest transcripts count — bounds cost and staleness.
MAX_CORPUS_RECORDINGS = 2500

#: Share of mid-sentence sightings that must be capitalised for a word
#: to count as a proper name.
PROPER_CAPITAL_SHARE = 0.75

#: A word seen inside an accepted two-word name at least this share of
#: the times it is seen at all is not offered on its own.
PHRASE_ABSORBS_SHARE = 0.8

#: Debounce after the archive changes: a burst of saves (an upload
#: queue) is one recompute.
RECOMPUTE_DEBOUNCE_SEC = 30.0

#: Delay of the boot recompute after start-up's own archive read is
#: done (``start(boot_after=...)``). The recompute is pure-Python work
#: over up to ``MAX_CORPUS_RECORDINGS`` transcripts; run beside the
#: History list's first build it holds the GIL against it, and a fixed
#: delay from process start alone did not keep them apart: on a large
#: archive the list build was still running when the delay ran out.
BOOT_RECOMPUTE_DELAY_SEC = 5.0

#: Debounce after a keyterm-related settings change.
REFRESH_DEBOUNCE_SEC = 1.0

CACHE_FILENAME = "auto_keyterms.json"
_CACHE_VERSION = 1

_LETTERS = "A-Za-zА-Яа-яЁё"
_TOKEN_RE = re.compile(rf"[0-9{_LETTERS}]+(?:['’\-.+][0-9{_LETTERS}]+)*")
_SENTENCE_BREAK_RE = re.compile(r"[.!?…:;\n«\"“—]")
_LATIN_RE = re.compile(r"[A-Za-z]")
_CYRILLIC_RE = re.compile(r"[А-Яа-яЁё]")
_DIGIT_RE = re.compile(r"[0-9]")
_CAMEL_RE = re.compile(r"[a-zа-яё][A-ZА-ЯЁ]")
_CAMEL_PART_RE = re.compile(r"[A-ZА-ЯЁ]?[a-zа-яё]+|[A-ZА-ЯЁ]+(?![a-zа-яё])|[0-9]+")
_BRACKETED_RE = re.compile(r"\[[^\]\n]*\]")
_FILE_NAME_RE = re.compile(r"\.(?:[a-z]{2,4}[0-9]?)$")
_PATH_CHARS = frozenset("/\\@")

#: How much each kind of evidence counts toward the rank: a two-word
#: name or a code-shaped token is far more specific than an English word
#: dropped into Russian speech.
_KIND_WEIGHT = {"phrase": 2.0, "code": 1.5, "proper": 1.5, "latin": 1.0}

#: A Latin word whose Cyrillic reading recurs in this many times as many
#: recordings is Russian speech returned in the wrong script.
MIS_SCRIPTED_RATIO = 10

_TRANSLIT_DIGRAPHS = (
    ("shch", "щ"), ("sch", "щ"), ("sh", "ш"), ("ch", "ч"), ("zh", "ж"),
    ("kh", "х"), ("ts", "ц"), ("ya", "я"), ("yu", "ю"), ("yo", "е"),
)
_TRANSLIT = dict(zip(
    "abcdefghijklmnopqrstuvwxyz",
    ["а", "б", "к", "д", "е", "ф", "г", "х", "и", "ж", "к", "л", "м",
     "н", "о", "п", "к", "р", "с", "т", "у", "в", "в", "кс", "ы", "з"],
))

# Russian endings stripped (longest first, one at most) to group the
# inflected forms of one name. Only applied to words of five letters or
# more and only while four letters of stem remain.
_RU_ENDINGS = tuple(sorted((
    "ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими",
    "ах", "ях", "ом", "ем", "ой", "ей", "ов", "ев", "ам", "ям",
    "ую", "юю", "ая", "яя", "ое", "ее", "ые", "ие", "ый", "ий",
    "а", "я", "у", "ю", "е", "ы", "и", "о",
), key=len, reverse=True))

# Words that pass the shape tests without being vocabulary: function
# words, interjections, and the English words English capitalises by
# rule (days, months, languages, ``I``-forms). Lower-case.
_STOP_WORDS = frozenset("""
a an the and or but if so as at by for from in into of on onto to with without
up down out over under about after before again then than too very just only
also not no yes yeah yep nope ok okay hey hi hello bye thanks thank please sorry
oh ah uh um hmm wow well right sure cool nice good great fine
i i'm i've i'll i'd me my mine you you're your yours he she it it's we they them
their our us his her its this that that's these those there here what which who
whom whose when where why how all any some each every both few more most other
such own same can could will would shall should may might must do does did done
be is am are was were been being have has had having get got go goes going went
let let's make made say said see seen know think want like need use used
one two three four five six seven eight nine ten first second next last new old
monday tuesday wednesday thursday friday saturday sunday
january february march april may june july august september october november december
english russian ukrainian lithuanian german french spanish italian polish chinese japanese
mr mrs ms dr
вы вас вам вами ваш ваша ваше ваши вашего вашей вашему вашим
ты тебя тебе тобой твой твоя твое твои
я мы он она оно они меня мне нас нам его ее её их им ими
да нет ну вот это этот эта эти тот та те так там тут здесь как что кто где когда
окей ок ага угу ладно хорошо отлично спасибо пожалуйста привет пока здравствуйте
господи боже бог блин короче значит слушай смотри смотрите давай давайте
понедельник вторник среда четверг пятница суббота воскресенье
январь февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь
русский английский итак кстати вообще просто тоже
open free play max min top best
""".split())


def _script(token: str) -> str:
    latin = bool(_LATIN_RE.search(token))
    cyrillic = bool(_CYRILLIC_RE.search(token))
    if latin and cyrillic:
        return "mixed"
    if latin:
        return "lat"
    if cyrillic:
        return "cyr"
    return "num"


def _letters(token: str) -> str:
    return "".join(ch for ch in token if ch.isalpha())


def _is_code_shaped(token: str) -> bool:
    letters = _letters(token)
    if not letters:
        return False
    if _DIGIT_RE.search(token):
        return True
    if _CAMEL_RE.search(token):
        return True
    return len(letters) >= 2 and letters.isupper()


def _is_capitalised(token: str) -> bool:
    return token[:1].isupper()


def _is_noise_token(token: str, script: str) -> bool:
    """Tokens that are never vocabulary whatever their shape: numerals
    with a Russian case ending (``2-ой``, ``1-ая``) and file names
    (``shot-01-preview.jpg``)."""
    if script == "cyr" and _DIGIT_RE.search(token) and len(_letters(token)) <= 3:
        return True
    return bool(_FILE_NAME_RE.search(token))


def _unigram_key(token: str, script: str) -> str:
    """Grouping key: lower case, Russian inflection stripped."""
    low = token.lower().replace("ё", "е")
    if script != "cyr" or len(low) < 5:
        return low
    for ending in _RU_ENDINGS:
        if low.endswith(ending) and len(low) - len(ending) >= 4:
            return low[: -len(ending)]
    return low


def _compact_key(term: str) -> str:
    """Spelling-variant key: ``UltraGen``, ``Ultra Gen`` and ``ultra-gen``
    are one term."""
    return re.sub(r"[\s\-]+", "", term.lower().replace("ё", "е"))


def _transliterate(latin: str) -> str:
    """A rough Latin → Cyrillic reading, for the mis-scripted-word test."""
    out = latin.lower()
    for src, dst in _TRANSLIT_DIGRAPHS:
        out = out.replace(src, dst)
    return "".join(_TRANSLIT.get(ch, ch) for ch in out)


def term_key(term: str) -> str:
    """One key per term however it is inflected or spaced: a word's
    grouping key, a phrase's compact key. Also how ``backend.word_case``
    matches a transcript word ("Транскриптора") to a keyterm
    ("Транскриптор")."""
    if " " in term.strip():
        return _compact_key(term)
    return _unigram_key(term.strip(), _script(term))


def _is_stutter(phrase: str) -> bool:
    """``Claude Claude``, ``Deep DeepSeek``, ``DeepSeek Seek``: the same
    word twice, or a CamelCase name beside its own first or last part —
    the recogniser hesitating over one name, not two words that make one.
    A surname that merely starts like the first name (``Иван Иванов``)
    is not a stutter."""
    first, _space, second = phrase.partition(" ")
    if first.lower() == second.lower():
        return True
    for whole, piece in ((first, second), (second, first)):
        parts = _CAMEL_PART_RE.findall(whole)
        if len(parts) >= 2 and piece.lower() in (parts[0].lower(), parts[-1].lower()):
            return True
    return False


def _is_stop(token: str) -> bool:
    low = token.lower()
    return low in _STOP_WORDS or low.replace("’", "'") in _STOP_WORDS


@dataclass
class _UnigramStats:
    occurrences: int = 0
    capital_mid: int = 0
    lower: int = 0
    code_shaped: int = 0
    latin_in_cyrillic: int = 0
    surfaces: Counter = field(default_factory=Counter)

    def add(self, other: "_UnigramStats") -> None:
        self.occurrences += other.occurrences
        self.capital_mid += other.capital_mid
        self.lower += other.lower
        self.code_shaped += other.code_shaped
        self.latin_in_cyrillic += other.latin_in_cyrillic
        self.surfaces.update(other.surfaces)


@dataclass
class _PhraseStats:
    capitalised: int = 0
    lower: int = 0
    parts: tuple[str, str] = ("", "")
    surfaces: Counter = field(default_factory=Counter)

    def add(self, other: "_PhraseStats") -> None:
        self.capitalised += other.capitalised
        self.lower += other.lower
        self.parts = other.parts
        self.surfaces.update(other.surfaces)


@dataclass
class DocumentStats:
    """What one transcript contributes to the vocabulary."""

    unigrams: dict[str, _UnigramStats] = field(default_factory=dict)
    phrases: dict[str, _PhraseStats] = field(default_factory=dict)


@dataclass(frozen=True)
class AutoTerm:
    """One mined term and the evidence for it."""

    term: str
    recordings: int
    occurrences: int


def extract_document_stats(text: str) -> DocumentStats:
    """Tokenise one transcript and count the candidate evidence in it."""
    stats = DocumentStats()
    text = _BRACKETED_RE.sub(" ", text or "")
    # (token, starts a sentence, joined to the previous token by plain
    # spaces, script, part of a path or URL)
    tokens: list[tuple[str, bool, bool, str, bool]] = []
    prev_end = 0
    for match in _TOKEN_RE.finditer(text):
        gap = text[prev_end:match.start()]
        after = text[match.end():match.end() + 1]
        sentence_start = not tokens or bool(_SENTENCE_BREAK_RE.search(gap))
        joined = bool(tokens) and gap.strip() == "" and "\n" not in gap
        in_path = gap[-1:] in _PATH_CHARS or after in _PATH_CHARS
        token = match.group(0)
        tokens.append((token, sentence_start, joined, _script(token), in_path))
        prev_end = match.end()

    for i, (token, sentence_start, joined, script, in_path) in enumerate(tokens):
        if script in ("mixed", "num") or in_path or _is_noise_token(token, script):
            continue
        key = _unigram_key(token, script)
        uni = stats.unigrams.get(key)
        if uni is None:
            uni = stats.unigrams[key] = _UnigramStats()
        uni.occurrences += 1
        uni.surfaces[token] += 1
        code = _is_code_shaped(token)
        if code:
            uni.code_shaped += 1
        elif _is_capitalised(token):
            if not sentence_start:
                uni.capital_mid += 1
        else:
            uni.lower += 1
        if script == "lat" and not code:
            neighbours = [tokens[j][3] for j in (i - 1, i + 1) if 0 <= j < len(tokens)]
            if "cyr" in neighbours:
                uni.latin_in_cyrillic += 1

        if i == 0 or not joined:
            continue
        prev, _prev_start, _prev_joined, prev_script, prev_in_path = tokens[i - 1]
        if prev_script != script or prev_in_path or _is_stop(prev) or _is_stop(token):
            continue
        if _is_noise_token(prev, prev_script):
            continue
        prev_letters = _letters(prev)
        if len(prev_letters) < 2 and not (script == "lat" and prev.isupper()):
            continue
        if len(_letters(token)) < 2:
            continue
        if not (_is_capitalised(prev) or _is_code_shaped(prev)):
            continue
        phrase_key = f"{prev.lower()} {token.lower()}"
        phrase = stats.phrases.get(phrase_key)
        if phrase is None:
            phrase = stats.phrases[phrase_key] = _PhraseStats(
                parts=(_unigram_key(prev, prev_script), key)
            )
        if _is_capitalised(token) or code:
            phrase.capitalised += 1
            phrase.surfaces[f"{prev} {token}"] += 1
        else:
            phrase.lower += 1
    return stats


def _representative(surfaces: Counter, prefer_capitalised: bool) -> str:
    def rank(item: tuple[str, int]) -> tuple:
        surface, count = item
        capital_bonus = 1 if (prefer_capitalised and _is_capitalised(surface)) else 0
        return (-capital_bonus, -count, len(surface), surface)

    return sorted(surfaces.items(), key=rank)[0][0]


@dataclass
class _Candidate:
    term: str
    occurrences: int
    weight: float


def rank_terms(
    documents: Iterable[DocumentStats],
    *,
    min_recordings: int = MIN_RECORDINGS,
    max_terms: int = MAX_AUTO_TERMS,
    builtin: Iterable[str] = (),
) -> list[AutoTerm]:
    """Aggregate per-transcript evidence into the ranked vocabulary.

    Ranked by the number of recordings a term recurs in, weighted by how
    name-like its evidence is (``_KIND_WEIGHT``); spelling variants
    (``UltraGen`` / ``Ultra Gen``) are one term, counted once per
    recording and spelled the way it is most often spelled. *builtin*
    terms (``BUILTIN_TERMS`` in the store) come first, in their own
    spelling, with the recordings they are heard in, and replace any
    mined form of themselves.
    """
    documents = list(documents)
    unigrams: dict[str, _UnigramStats] = {}
    unigram_docs: Counter = Counter()
    latin_ctx_docs: Counter = Counter()
    phrases: dict[str, _PhraseStats] = {}
    phrase_docs: Counter = Counter()
    for doc in documents:
        for key, uni in doc.unigrams.items():
            total = unigrams.get(key)
            if total is None:
                total = unigrams[key] = _UnigramStats()
            total.add(uni)
            unigram_docs[key] += 1
            if uni.latin_in_cyrillic:
                latin_ctx_docs[key] += 1
        for key, phrase in doc.phrases.items():
            total_p = phrases.get(key)
            if total_p is None:
                total_p = phrases[key] = _PhraseStats()
            total_p.add(phrase)
            if phrase.capitalised:
                phrase_docs[key] += 1

    # Accepted evidence, by the key it is recorded under in a document.
    accepted_phrases: dict[str, _Candidate] = {}
    accepted_unigrams: dict[str, _Candidate] = {}
    absorbed: Counter = Counter()
    for key, phrase in phrases.items():
        if phrase_docs[key] < min_recordings or not phrase.surfaces:
            continue
        if phrase.capitalised < PROPER_CAPITAL_SHARE * (phrase.capitalised + phrase.lower):
            continue
        term = _representative(phrase.surfaces, prefer_capitalised=True)
        if _is_stutter(term):
            continue
        accepted_phrases[key] = _Candidate(
            term=term,
            occurrences=phrase.capitalised,
            weight=_KIND_WEIGHT["phrase"],
        )
        for part in phrase.parts:
            absorbed[part] += phrase.capitalised

    for key, uni in unigrams.items():
        docs = unigram_docs[key]
        if docs < min_recordings:
            continue
        surface = _representative(uni.surfaces, prefer_capitalised=False)
        if any(_is_stop(s) for s in uni.surfaces):
            continue
        if absorbed[key] >= PHRASE_ABSORBS_SHARE * uni.occurrences:
            continue
        script = _script(surface)
        if script == "lat":
            # Russian speech that came back in Latin script ("Tak") is a
            # recognition error, not vocabulary — and a keyterm would
            # make the error stick. Its tell: the same word in Cyrillic
            # is an everyday word of this very corpus.
            reading = _unigram_key(_transliterate(surface), "cyr")
            if unigram_docs[reading] >= MIS_SCRIPTED_RATIO * docs:
                continue
        letters = len(_letters(surface))
        mid = uni.capital_mid + uni.lower
        if uni.code_shaped >= 0.5 * uni.occurrences and letters >= 2:
            kind = "code"
            code_forms = Counter(
                {s: n for s, n in uni.surfaces.items() if _is_code_shaped(s)}
            )
            term = _representative(code_forms or uni.surfaces, prefer_capitalised=False)
        elif (
            letters >= 3
            and uni.capital_mid >= 2
            and uni.capital_mid >= PROPER_CAPITAL_SHARE * mid
        ):
            kind = "proper"
            term = _representative(uni.surfaces, prefer_capitalised=True)
        elif letters >= 3 and script == "lat" and latin_ctx_docs[key] >= min_recordings:
            kind = "latin"
            term = surface
        else:
            continue
        if kind != "code" and script == "lat" and is_frequent_english(term):
            continue
        accepted_unigrams[key] = _Candidate(
            term=term, occurrences=uni.occurrences, weight=_KIND_WEIGHT[kind]
        )

    # Spelling variants become one term: its recordings are counted once
    # per recording, its spelling is the variant seen most often.
    groups: dict[str, list[_Candidate]] = {}
    for cand in list(accepted_phrases.values()) + list(accepted_unigrams.values()):
        groups.setdefault(_compact_key(cand.term), []).append(cand)
    group_docs: Counter = Counter()
    for doc in documents:
        present = {
            _compact_key(accepted_unigrams[k].term)
            for k in doc.unigrams
            if k in accepted_unigrams
        }
        present.update(
            _compact_key(accepted_phrases[k].term)
            for k, phrase in doc.phrases.items()
            if k in accepted_phrases and phrase.capitalised
        )
        group_docs.update(present)

    ranked: list[tuple[float, AutoTerm]] = []
    for compact, members in groups.items():
        best = max(members, key=lambda c: (c.occurrences, c.weight))
        if len(best.term) > AUTO_KEYTERM_MAX_CHARS:
            continue
        docs = group_docs[compact]
        term = AutoTerm(
            term=best.term,
            recordings=docs,
            occurrences=sum(c.occurrences for c in members),
        )
        ranked.append((docs * max(c.weight for c in members), term))
    ranked.sort(key=lambda item: (-item[0], -item[1].occurrences, item[1].term.lower()))

    seeded: list[AutoTerm] = []
    for text in builtin:
        text = text.strip()
        key = term_key(text)
        if not text or any(term_key(t.term) == key for t in seeded):
            continue
        if " " in text:
            heard = [d.phrases[text.lower()].capitalised for d in documents
                     if text.lower() in d.phrases]
        else:
            heard = [d.unigrams[key].occurrences for d in documents if key in d.unigrams]
        seeded.append(AutoTerm(term=text, recordings=len(heard), occurrences=sum(heard)))
    seeded_keys = {term_key(t.term) for t in seeded}
    mined = [term for _score, term in ranked if term_key(term.term) not in seeded_keys]
    return (seeded + mined)[:max_terms]


# ---------------------------------------------------------------------
# The store: cache, recompute, scheduling
# ---------------------------------------------------------------------


@dataclass(frozen=True)
class CorpusEntry:
    """One transcript of the archive, as the store sees it.

    ``read`` returns what was SAID in it — the caller owns the archive's
    file format (``backend.main._recording_spoken_text``), this module
    only ever sees text — or ``None`` for a transcript that is not the
    owner's speech (imported media), which is then not counted.
    """

    key: str
    identity: tuple
    mtime: float
    read: Callable[[], Optional[str]]


@dataclass(frozen=True)
class AutoKeytermSnapshot:
    """The current ranking and where it came from."""

    terms: tuple[AutoTerm, ...] = ()
    computed_at: float = 0.0
    recordings: int = 0

    @property
    def term_texts(self) -> tuple[str, ...]:
        return tuple(t.term for t in self.terms)


class AutoKeytermStore:
    """Owns the mined vocabulary: compute, cache, persist, schedule.

    ``terms()`` is what request builders read — an immutable tuple, so
    the WebSocket handler never waits on, or races with, a recompute.
    Recomputes run in a worker thread; the scheduling half is bound to
    the app's event loop by ``start()`` and is a no-op before it, so
    importing the module, or driving a handler from a test, schedules
    nothing.
    """

    def __init__(
        self,
        *,
        corpus: Callable[[], Iterable[CorpusEntry]],
        cache_path: Optional[Path],
        is_enabled: Callable[[], bool] = lambda: True,
        max_recordings: int = MAX_CORPUS_RECORDINGS,
        min_recordings: int = MIN_RECORDINGS,
        max_terms: int = MAX_AUTO_TERMS,
        builtin_terms: Iterable[str] = BUILTIN_TERMS,
        recompute_debounce_sec: float = RECOMPUTE_DEBOUNCE_SEC,
        refresh_debounce_sec: float = REFRESH_DEBOUNCE_SEC,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._corpus = corpus
        self._cache_path = cache_path
        self._is_enabled = is_enabled
        self._max_recordings = max(1, int(max_recordings))
        self._min_recordings = max(1, int(min_recordings))
        self._max_terms = max(1, int(max_terms))
        self._builtin_terms = tuple(builtin_terms)
        self._recompute_debounce = float(recompute_debounce_sec)
        self._refresh_debounce = float(refresh_debounce_sec)
        self._clock = clock
        # The built-in terms are there before the first recompute or cache.
        self._snapshot = AutoKeytermSnapshot(
            terms=tuple(rank_terms((), max_terms=self._max_terms, builtin=self._builtin_terms))
        )
        self._doc_cache: dict[str, tuple[tuple, Optional[DocumentStats]]] = {}
        self._compute_lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._on_refresh: Optional[Callable[[], Awaitable[None]]] = None
        # One debounce timer per kind of request (True: recompute, False:
        # refresh only), so a quick settings refresh is never held back
        # by a recompute's longer debounce, nor the reverse.
        self._timers: dict[bool, asyncio.TimerHandle] = {}
        self._task: Optional[asyncio.Task] = None
        # Waits for ``start``'s *boot_after*, then arms the boot recompute.
        self._boot_gate: Optional[asyncio.Task] = None
        # None: nothing queued behind the running task; otherwise whether
        # the queued run recomputes.
        self._again: Optional[bool] = None

    # ----- Reading ----------------------------------------------------

    def snapshot(self) -> AutoKeytermSnapshot:
        return self._snapshot

    def terms(self) -> tuple[str, ...]:
        return self._snapshot.term_texts

    # ----- Persistence ------------------------------------------------

    def load_cached(self) -> None:
        """Adopt the ranking the previous run persisted, if readable."""
        if self._cache_path is None:
            return
        try:
            raw = json.loads(self._cache_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as e:
            logger.warning("auto-keyterms: cache unreadable, recomputing: %s", type(e).__name__)
            return
        if not isinstance(raw, dict) or raw.get("version") != _CACHE_VERSION:
            return
        terms: list[AutoTerm] = []
        for row in raw.get("terms") or []:
            if not isinstance(row, dict) or not isinstance(row.get("term"), str):
                continue
            term = row["term"].strip()
            if not term or len(term) > AUTO_KEYTERM_MAX_CHARS:
                continue
            terms.append(
                AutoTerm(
                    term=term,
                    recordings=int(row.get("recordings") or 0),
                    occurrences=int(row.get("occurrences") or 0),
                )
            )
        self._snapshot = AutoKeytermSnapshot(
            terms=tuple(terms[: self._max_terms]),
            computed_at=float(raw.get("computedAt") or 0.0),
            recordings=int(raw.get("recordings") or 0),
        )

    def _persist(self, snap: AutoKeytermSnapshot) -> None:
        if self._cache_path is None:
            return
        payload = {
            "version": _CACHE_VERSION,
            "computedAt": snap.computed_at,
            "recordings": snap.recordings,
            "terms": [
                {"term": t.term, "recordings": t.recordings, "occurrences": t.occurrences}
                for t in snap.terms
            ],
        }
        try:
            atomic_write_json(self._cache_path, payload)
        except OSError as e:
            logger.warning("auto-keyterms: cache not written: %s", type(e).__name__)

    # ----- Computing --------------------------------------------------

    def recompute(self) -> AutoKeytermSnapshot:
        """Rebuild the ranking from the archive. Blocking: run it in a
        worker thread. Only transcripts new or changed since the last
        run are read."""
        with self._compute_lock:
            started = time.monotonic()
            entries = sorted(self._corpus(), key=lambda e: e.mtime, reverse=True)
            entries = entries[: self._max_recordings]
            docs: list[DocumentStats] = []
            live: dict[str, tuple[tuple, Optional[DocumentStats]]] = {}
            read = 0
            for entry in entries:
                cached = self._doc_cache.get(entry.key)
                if cached is not None and cached[0] == entry.identity:
                    stats = cached[1]
                else:
                    try:
                        text = entry.read()
                    except Exception as e:  # one unreadable file must not stop the rest
                        logger.debug("auto-keyterms: skipped a transcript (%s)", type(e).__name__)
                        continue
                    stats = None if text is None else extract_document_stats(text)
                    read += 1
                live[entry.key] = (entry.identity, stats)
                if stats is not None:
                    docs.append(stats)
            self._doc_cache = live
            ranked = rank_terms(
                docs,
                min_recordings=self._min_recordings,
                max_terms=self._max_terms,
                builtin=self._builtin_terms,
            )
            snap = AutoKeytermSnapshot(
                terms=tuple(ranked), computed_at=self._clock(), recordings=len(docs)
            )
            self._snapshot = snap
            self._persist(snap)
            logger.info(
                "auto-keyterms: %d term(s), ~%d token(s), from %d recording(s) "
                "(%d read) in %.0f ms",
                len(snap.terms),
                sum(keyterm_token_cost(t.term) for t in snap.terms),
                snap.recordings,
                read,
                (time.monotonic() - started) * 1000.0,
            )
            return snap

    # ----- Scheduling -------------------------------------------------

    def start(
        self,
        on_refresh: Callable[[], Awaitable[None]],
        *,
        boot_delay_sec: float = BOOT_RECOMPUTE_DELAY_SEC,
        boot_after: Optional[Awaitable[object]] = None,
    ) -> None:
        """Bind to the running loop (call from it): load the persisted
        ranking now, recompute after *boot_delay_sec*. *on_refresh* runs
        after every recompute and settings refresh — the caller re-points
        whatever holds the old keyterm list (the warm socket pool).

        *boot_after* is start-up work the boot recompute must not compete
        with (the History list's first build reads the same archive):
        the *boot_delay_sec* countdown starts only once it has finished,
        whether it succeeded or not. Recomputes asked for meanwhile
        (``schedule_recompute``) are not held back by it."""
        self._loop = asyncio.get_running_loop()
        self._on_refresh = on_refresh
        self.load_cached()
        if boot_after is None:
            self._arm(boot_delay_sec, recompute=True)
        else:
            self._boot_gate = self._loop.create_task(
                self._arm_after(boot_after, boot_delay_sec),
                name="auto-keyterms-boot-gate",
            )

    async def _arm_after(self, gate: Awaitable[object], delay: float) -> None:
        try:
            # Shielded: ``stop`` cancelling this wait must not cancel the
            # caller's start-up work along with it.
            await asyncio.shield(gate)
        except asyncio.CancelledError:
            if self._loop is None:  # ``stop`` — nothing to arm
                raise
            # The gate itself was cancelled, not this task: start-up
            # work is over either way.
        except Exception as e:
            logger.warning(
                "auto-keyterms: start-up work failed (%s); boot recompute armed anyway",
                type(e).__name__,
            )
        self._boot_gate = None
        self._arm(delay, recompute=True)

    async def stop(self) -> None:
        loop, self._loop = self._loop, None
        gate, self._boot_gate = self._boot_gate, None
        if gate is not None and not gate.done():
            gate.cancel()
            try:
                await gate
            except (asyncio.CancelledError, Exception):
                pass
        for timer in self._timers.values():
            timer.cancel()
        self._timers.clear()
        task, self._task = self._task, None
        if task is not None and not task.done() and loop is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    def schedule_recompute(self, delay_sec: Optional[float] = None) -> None:
        """The archive changed (or the feature was just switched on).
        Safe from any thread; debounced by *delay_sec*, default
        ``RECOMPUTE_DEBOUNCE_SEC``."""
        delay = self._recompute_debounce if delay_sec is None else float(delay_sec)
        self._call_on_loop(lambda: self._arm(delay, recompute=True))

    def schedule_refresh(self) -> None:
        """A keyterm-related setting changed. Safe from any thread."""
        self._call_on_loop(lambda: self._arm(self._refresh_debounce, recompute=False))

    def _call_on_loop(self, fn: Callable[[], None]) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(fn)
        except RuntimeError:  # loop closing underneath us
            pass

    def _arm(self, delay: float, *, recompute: bool) -> None:
        loop = self._loop
        if loop is None:
            return
        pending = self._timers.pop(recompute, None)
        if pending is not None:
            pending.cancel()
        self._timers[recompute] = loop.call_later(
            max(0.0, delay), self._fire, recompute
        )

    def _fire(self, recompute: bool) -> None:
        self._timers.pop(recompute, None)
        if self._task is not None and not self._task.done():
            # One run at a time; whatever arrived meanwhile runs after it.
            self._again = recompute or bool(self._again)
            return
        self._task = asyncio.get_running_loop().create_task(
            self._run(recompute), name="auto-keyterms"
        )

    async def _run(self, recompute: bool) -> None:
        try:
            if recompute:
                await asyncio.to_thread(self._recompute_if_enabled)
            if self._on_refresh is not None:
                await self._on_refresh()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("auto-keyterms: refresh failed")
        finally:
            again, self._again = self._again, None
            if again is not None and self._loop is not None:
                self._arm(0.0, recompute=again)

    def _recompute_if_enabled(self) -> None:
        if self._is_enabled():
            self.recompute()

