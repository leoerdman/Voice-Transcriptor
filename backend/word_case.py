"""SSOT for the letter case of a word placed into a transcript it was not
read in.

Why
---
Deepgram capitalises a word for one of two reasons, and its token does
not say which:

* POSITION — the word opened a sentence, or opened the final or the
  re-decoded clip it came back in (a short clip is decoded as a text of
  its own, so its first word is capitalised);
* the WORD itself — a name, a brand, an abbreviation ("Deepgram",
  "Claude", "API").

Inside the reading that produced it the two are indistinguishable and
harmless. They stop being harmless the moment the word is moved into a
different text, which this product does in two places: the dual-stream
merge (``backend.deepgram_dual``) takes a word from whichever reading
won its slot, and the recovery pass (``backend.deepgram_recovery``)
inserts words a re-decode of a short clip found. A capital that came
from POSITION in the source then lands mid-sentence in the user's text.
Measured 2026-11-23: "Сразу Же как починишь" (``multi`` capitalised
"Же", ``ru`` did not) and "…слово деплой Потерял, Посмотри" (the
recovered "Потерял," opened its clip; "Посмотри," opened its final).

The rule
--------
A word whose case is in question takes the case of its PLACE in the
assembled text:

* at a sentence start (the first word, or after a word that ends a
  sentence) it is capitalised;
* elsewhere it is lower-cased — unless the capital is evidence about the
  WORD (``capital_is_lexical``): some reading capitalised it away from
  a sentence start, or capitalised a word the owner's vocabulary spells
  as a name (``lexical_names``), and no reading wrote the same spelling
  in lower case;
* a token whose casing is not a plain leading capital ("API",
  "DeepGram", "iPhone") is never touched: that casing is the word's own.

Which words are "in question" is each caller's knowledge — the merge
knows which readings a word came from and what preceded it there, the
splice (``backend.remote_deepgram_live.splice_words_into_segments``)
knows which words it inserted — so the callers decide that, and this
module owns what the answer is.

Words inserted into a transcript
--------------------------------
Every path that inserts words into the finals goes through one splice:
the live session's interim words no final carried, and the recovery
pass's re-decoded words. Both kinds were read as part of a text of their
own (an interim hypothesis, a re-decoded clip), and two of their marks
describe THAT text: the positional capital above, and the trailing
punctuation of its last word — the decoder closes every text it is
given, so that mark is where the text was cut, not where the speaker
paused. ``as_read`` records each word's place in the text it was read
in, the splice reads it back (``place_in_reading``) once the word has a
place in the transcript, and ``cased_for_place`` and
``without_trailing_marks`` decide the rest.

Names the owner declared
------------------------
One reading alone cannot tell a name from a positional capital when the
name OPENS the text it was read in: "Claude" first in an interim
hypothesis or a re-decoded clip reads exactly like "Потерял" first in
one. The product already holds the owner's statement of which words are
names — the Deepgram keyterms (``backend.deepgram_keyterms.
configured_keyterms``: the Settings list and the self-filling vocabulary
of ``backend.auto_keyterms``, which offers a word as a name only when the
archive capitalises it mid-sentence nearly every time). Those keyterms
are what the reading was decoded WITH, and Deepgram writes them in their
keyterm spelling: in the owner's archive since 2026-11-10, mid-sentence,
"Claude" 207 times against "claude" 3, "Opus" 97 against 0, "Canvas" 64
against 3. So a capital on a word that a keyterm spells with one is the
capital the decoder gives that word anywhere, and the callers pass the
very keyterms the request carried (``DeepgramLiveConfig.keyterms``) —
no second list. ``lexical_names`` reads them conservatively: it only
ever KEEPS a capital (a lower-case keyterm such as "коммит" or
"worktree" says nothing, and nothing here capitalises a word), a phrase
counts only when spelled as a name ("Claude Code", not "Single source of
truth"), and a reading that wrote the same spelling in lower case still
overrules it.
"""

from __future__ import annotations

from typing import AbstractSet, Iterable, NamedTuple, Optional, Sequence

from backend.auto_keyterms import term_key

# Marks that end a sentence, and the closing marks that may follow one
# ("…сказал.»").
_SENTENCE_END = ".!?…"
_CLOSERS = "\"'»”’)]"
# Trailing marks a token can carry; what ``without_trailing_marks``
# strips.
_TRAILING_MARKS = ",.;:!?…"


def ends_sentence(token: Optional[str]) -> bool:
    """Does this token close a sentence (its last mark is ``. ! ? …``)?"""
    text = str(token or "").rstrip().rstrip(_CLOSERS)
    return bool(text) and text[-1] in _SENTENCE_END


def starts_sentence(previous_token: Optional[str]) -> bool:
    """Is the place after ``previous_token`` a sentence start? ``None``
    — nothing before it — is the start of the text."""
    return previous_token is None or ends_sentence(previous_token)


def _first_letter(token: str) -> int:
    for i, ch in enumerate(token):
        if ch.isalpha():
            return i
    return -1


def is_capitalised(token: str) -> bool:
    """Does the token's first letter stand in upper case?"""
    i = _first_letter(token)
    return i >= 0 and token[i].isupper()


def has_own_casing(token: str) -> bool:
    """Casing that is not a plain leading capital — an upper-case letter
    after the first one ("API", "DeepGram", "iPhone"). Such casing is the
    word's own and is never re-decided."""
    i = _first_letter(token)
    return i >= 0 and any(ch.isupper() for ch in token[i + 1:])


def _core(token: str) -> str:
    return "".join(ch for ch in token if ch.isalpha()).casefold()


def _bare(token: str) -> str:
    """The token without the marks around it ("«Claude»," → "Claude")."""
    start, end = 0, len(token)
    while start < end and not token[start].isalnum():
        start += 1
    while end > start and not token[end - 1].isalnum():
        end -= 1
    return token[start:end]


def _name_key(token: str) -> str:
    """The key a word is matched to a name by: case-blind, inflection-
    blind (``backend.auto_keyterms.term_key`` — the key the vocabulary
    itself groups a word's forms under)."""
    return term_key(_bare(token))


def lexical_names(keyterms: Iterable[str]) -> frozenset[str]:
    """The words the owner's keyterms spell as names (see the module
    docstring), as the keys ``capital_is_lexical`` matches.

    A keyterm word counts when it is capitalised and that capital is not
    merely a phrase's sentence-case opening: a one-word keyterm
    ("Claude", "Транскриптор") and every word of a phrase spelled word
    by word as a name ("Claude Code", "Leo Erdman") count; the first
    word of "Single source of truth" does not, a capitalised later word
    of a phrase ("заявка на Opus") does. Lower-case keyterms ("коммит")
    contribute nothing.
    """
    names: set[str] = set()
    for term in keyterms:
        words = [w for w in (_bare(t) for t in str(term or "").split()) if w]
        if not words:
            continue
        titled = all(is_capitalised(w) for w in words)
        for index, word in enumerate(words):
            if is_capitalised(word) and (index > 0 or titled):
                names.add(_name_key(word))
    return frozenset(names)


def capital_is_lexical(
    readings: Iterable[tuple[str, bool]],
    names: AbstractSet[str] = frozenset(),
) -> bool:
    """Is a capital evidence about the WORD rather than its position?

    ``readings`` holds, per reading that has the word, its token there
    and whether the word stood at a sentence start in that reading (a
    final's or a re-decoded clip's first word counts: Deepgram formats
    each as a text of its own).

    Deepgram capitalises by position ONLY at such a start, so a capital
    anywhere else is the word's own: one reading that capitalised it
    away from a start makes it a name — "Claude" in ``multi`` keeps its
    capital against ``ru``'s transliterated "клод", which is a different
    spelling and says nothing about this one's case. At a start, a
    capital is the word's own when the word is one of ``names``
    (``lexical_names`` of the keyterms the reading was decoded with):
    "Claude" opening an interim hypothesis. The one thing that
    overrules it is a reading that wrote the SAME word in lower case:
    two decodes of one spelling that disagree on its case are not a
    name. Measured 2026-11-23 (``20261123-173206``): ``multi`` wrote
    "Сразу Же как" in one final, ``ru`` wrote "Сразу же,"; it is "же".
    """
    readings = list(readings)
    named = {
        _core(token) for token, at_start in readings
        if is_capitalised(token)
        and (not at_start or (names and _name_key(token) in names))
    }
    if not named:
        return False
    return not any(
        not is_capitalised(token) and _core(token) in named
        for token, _at_start in readings
    )


def cased_for_place(token: str, *, sentence_start: bool, lexical: bool) -> str:
    """``token`` with the case of its place (see the module docstring)."""
    i = _first_letter(token)
    if i < 0 or has_own_casing(token):
        return token
    if sentence_start:
        head = token[i].upper()
    elif lexical:
        return token
    else:
        head = token[i].lower()
    return token[:i] + head + token[i + 1:]


def without_trailing_marks(token: str) -> str:
    """The token without its trailing punctuation ("посмотрю." →
    "посмотрю"); a token that is nothing but marks is returned as is."""
    stripped = token.rstrip(_TRAILING_MARKS)
    return stripped if stripped else token


class ReadPlace(NamedTuple):
    """Where a word stood in the text it was read in."""

    # First word of that text, or after a word that ends a sentence in
    # it: a capital there may be positional.
    at_start: bool
    # The text's last word: its trailing marks are where the text was
    # cut.
    last: bool


# A word whose reading is not known: its capital is taken as its own and
# its marks as the speaker's.
UNKNOWN_PLACE = ReadPlace(at_start=False, last=False)

# The key ``as_read`` stores a word's ``ReadPlace`` under. Internal to the
# splice: it never leaves ``splice_words_into_segments``.
_READ_PLACE_KEY = "_readPlace"


def as_read(words: Sequence[dict]) -> list[dict]:
    """Copies of ONE text's words, in its order (an interim hypothesis, a
    re-decoded clip), each remembering its ``ReadPlace`` in that text."""
    out: list[dict] = []
    previous: Optional[str] = None
    for index, word in enumerate(words):
        token = str(word.get("word") or "")
        place = ReadPlace(
            at_start=starts_sentence(previous),
            last=index == len(words) - 1,
        )
        out.append({**word, _READ_PLACE_KEY: place})
        previous = token
    return out


def place_in_reading(word: dict) -> ReadPlace:
    """The ``ReadPlace`` ``as_read`` recorded on ``word`` (``UNKNOWN_PLACE``
    when it was not read through ``as_read``)."""
    place = word.get(_READ_PLACE_KEY)
    return place if isinstance(place, ReadPlace) else UNKNOWN_PLACE


def without_read_place(word: dict) -> dict:
    """``word`` without the ``as_read`` record — what goes into a
    transcript."""
    return {k: v for k, v in word.items() if k != _READ_PLACE_KEY}
