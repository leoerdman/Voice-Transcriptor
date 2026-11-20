"""Which writing systems a transcript may contain. One table, one rule.

Why
---
Deepgram's 55-language ``language=multi`` model (2026-10-23) hears this
user's Russian as Persian, Hebrew, Lithuanian, Ukrainian… and writes it
in THAT language's alphabet. Measured on the screen take of 2026-11-20
22:52:38: ``multi`` turned the opening "Должны быть" into
``که دارم بویت`` (tagged ``fa``) while the request carried
``language_hint=ru&language_hint=en``. The hint only BIASES detection —
Deepgram documents it so and the log proves it — and there is no
parameter that forbids a language on the multilingual model. The
dual-stream merge (``backend.deepgram_dual``) replaces most such
stretches with the ``ru`` reading, but it decides on the per-word
language TAG, and a word whose tag and alphabet disagree slips past it.

The user has already told the app which languages they speak: the
"Expected languages" setting (``preferences.deepgram.language_hints``,
read by ``backend.deepgram_language.configured_language_hints`` — the
one owner of that preference). This module turns that setting into the
one rule every delivered transcript obeys: a word written only in
alphabets none of the expected languages use is not speech this user
produced, and it is removed.

The rule
--------
* Each supported language maps to the script(s) it is written in
  (``LANGUAGE_SCRIPTS``; its keys are exactly the codes the setting can
  hold, ``LANGUAGE_HINT_OPTIONS`` — a test pins the two together).
* Only LETTERS have a script. Digits, punctuation, symbols, emoji,
  whitespace, combining diacritics (the Russian stress mark), emoji
  variation selectors and modifier letters (ʼ) belong to every language,
  so screen mode's marks (``[✏️3 синий, вверху по центру]``, ``[/3]``,
  ``### Скрин 7 · …``) are never touched.
* A word (a whitespace-delimited token) is removed when it contains a
  letter of a foreign script and NO letter of an allowed one. A word that
  mixes scripts ("Claudeدر", "α-версия") is kept whole: it holds speech
  in an expected language, and cutting letters out of a word would
  invent a spelling nobody said.
* Nothing is removed when the setting is empty (the user declared no
  languages), or when the request itself names a language this table
  does not know — the app never deletes text in a language it was ASKED
  to transcribe. A concrete request language (``ru``/``en``/a CLI
  ``--language``) is allowed alongside the expected ones for the same
  reason.

How a script is identified
--------------------------
By the character's Unicode NAME (``LATIN SMALL LETTER A``, ``ARABIC
LETTER KEHEH``, ``CJK UNIFIED IDEOGRAPH-4E00``). Unicode guarantees names
never change once assigned, the standard library carries them, and the
rule only has to recognise the scripts of the supported languages: any
other letter — Arabic, Hebrew, Greek, Georgian, Armenian, Thai, Hangul,
or a script nobody listed — is foreign by not being allowed.

Removing a word leaves clean text: no doubled spaces, no space before
punctuation, no empty line where a removed line stood. The punctuation
a removed word carried moves to the word before it ("пошли در." →
"пошли.", "Привет در, мир" → "Привет, мир"); at the start of a line
there is no word to carry it, and it goes with the word. A segment whose
text becomes empty disappears.
"""

from __future__ import annotations

import unicodedata
from functools import lru_cache
from types import MappingProxyType
from typing import Any, Iterable, Mapping, Optional

from backend.deepgram_language import LANGUAGE_HINT_OPTIONS, configured_language_hints

SCRIPT_LATIN = "Latin"
SCRIPT_CYRILLIC = "Cyrillic"
SCRIPT_DEVANAGARI = "Devanagari"
SCRIPT_HAN = "Han"
SCRIPT_HIRAGANA = "Hiragana"
SCRIPT_KATAKANA = "Katakana"

_LATIN = frozenset({SCRIPT_LATIN})

#: The script(s) each supported language is written in. ONE table; its
#: keys are the codes ``normalize_language_hints`` accepts.
LANGUAGE_SCRIPTS: Mapping[str, frozenset[str]] = MappingProxyType({
    "ru": frozenset({SCRIPT_CYRILLIC}),
    "en": _LATIN,
    "es": _LATIN,
    "fr": _LATIN,
    "de": _LATIN,
    "pt": _LATIN,
    "it": _LATIN,
    "nl": _LATIN,
    "ja": frozenset({SCRIPT_HAN, SCRIPT_HIRAGANA, SCRIPT_KATAKANA}),
    "hi": frozenset({SCRIPT_DEVANAGARI}),
})

# Unicode-name prefixes of the scripts above. Longest first where one
# prefix contains another ("KATAKANA-HIRAGANA " before "KATAKANA ").
_NAME_PREFIX_SCRIPTS: tuple[tuple[str, str], ...] = (
    ("LATIN ", SCRIPT_LATIN),
    ("FULLWIDTH LATIN ", SCRIPT_LATIN),
    ("CYRILLIC ", SCRIPT_CYRILLIC),
    ("DEVANAGARI ", SCRIPT_DEVANAGARI),
    ("CJK ", SCRIPT_HAN),
    ("IDEOGRAPHIC ", SCRIPT_HAN),
    ("HIRAGANA ", SCRIPT_HIRAGANA),
    # The prolonged sound mark (ー) and its kin are shared by both kana.
    ("KATAKANA-HIRAGANA ", SCRIPT_KATAKANA),
    ("KATAKANA ", SCRIPT_KATAKANA),
    ("HALFWIDTH KATAKANA ", SCRIPT_KATAKANA),
)

# Latin-1 letters whose names carry no script word.
_NAMED_LATIN = frozenset({"FEMININE ORDINAL INDICATOR", "MASCULINE ORDINAL INDICATOR"})

# Letter-category characters that belong to every script: diacritics
# that combine with any base letter, the emoji presentation selector
# (✏️ is U+270F U+FE0F), and modifier letters used as apostrophes.
_NEUTRAL_NAME_PREFIXES = ("COMBINING ", "VARIATION SELECTOR", "MODIFIER LETTER ")

# Punctuation that ends a sentence, and punctuation that only separates
# clauses — the two strengths ``_attach`` weighs against each other.
_SENTENCE_END = frozenset(".!?…")
_SOFT_TRAILING = ",;:"


@lru_cache(maxsize=4096)
def letter_script(ch: str) -> Optional[str]:
    """The script of one character, or ``None`` when it has none.

    ``None`` for everything that is not a letter or a mark, and for the
    marks/letters every script shares. A letter outside the scripts this
    module names returns the first word of its Unicode name ("ARABIC",
    "HEBREW", …) — a script id that is never allowed, which is all the
    rule needs to know about it.
    """
    if not unicodedata.category(ch).startswith(("L", "M")):
        return None
    name = unicodedata.name(ch, "")
    if not name:
        return "UNNAMED"
    if name.startswith(_NEUTRAL_NAME_PREFIXES):
        return None
    if name in _NAMED_LATIN:
        return SCRIPT_LATIN
    for prefix, script in _NAME_PREFIX_SCRIPTS:
        if name.startswith(prefix):
            return script
    return name.split(" ", 1)[0]


def allowed_scripts(languages: Iterable[str]) -> Optional[frozenset[str]]:
    """The scripts a transcript in *languages* may contain.

    ``None`` means unrestricted: no languages at all, or one this table
    cannot answer for (never delete text in a language we cannot read).
    Region suffixes are ignored ("en-US" is "en").
    """
    scripts: set[str] = set()
    for raw in languages or ():
        code = str(raw or "").strip().lower().split("-", 1)[0]
        if not code:
            continue
        known = LANGUAGE_SCRIPTS.get(code)
        if known is None:
            return None
        scripts |= known
    return frozenset(scripts) if scripts else None


def transcript_scripts(cfg: object, language: Optional[str] = None) -> Optional[frozenset[str]]:
    """The scripts a transcript may contain under the user's settings.

    The expected languages (the SSOT preference) plus the language the
    request itself asked for, when it names one; ``None`` (keep
    everything) when the user declared no expected languages.
    """
    hints = configured_language_hints(cfg)
    if not hints:
        return None
    lang = str(language or "").strip().lower()
    requested = () if lang in ("", "auto", "multi") else (lang,)
    return allowed_scripts((*hints, *requested))


def is_foreign_word(token: str, allowed: Optional[frozenset[str]]) -> bool:
    """Is *token* written only in scripts outside *allowed*?

    True when it has at least one foreign letter and no allowed letter.
    """
    if allowed is None:
        return False
    foreign = False
    for ch in token:
        script = letter_script(ch)
        if script is None:
            continue
        if script in allowed:
            return False
        foreign = True
    return foreign


def _trailing_punctuation(token: str) -> str:
    end = len(token)
    while end > 0 and unicodedata.category(token[end - 1]).startswith("P"):
        end -= 1
    return token[end:]


def _attach(previous: str, removed: str) -> str:
    """*previous* (the kept word before a removed one) with the removed
    word's trailing punctuation moved onto it, so the clause structure
    survives the word: "Привет در, мир" → "Привет, мир", "пошли در." →
    "пошли.", "«Привет در»" → "«Привет»".

    The stronger mark wins rather than both standing side by side: a
    sentence end replaces a comma the kept word already carries ("Да,
    در." → "Да."), and after a sentence end a comma or a second sentence
    end is dropped ("Конец. در, и" → "Конец. и"). Closing quotes and
    brackets are always kept.
    """
    carried = _trailing_punctuation(removed)
    if not carried:
        return previous
    base = previous
    if base[-1:] in _SENTENCE_END:
        carried = "".join(ch for ch in carried if ch not in _SENTENCE_END and ch not in _SOFT_TRAILING)
    elif any(ch in _SENTENCE_END or ch in _SOFT_TRAILING for ch in carried):
        base = base.rstrip(_SOFT_TRAILING) or base
    if not carried or base.endswith(carried):
        return base
    return base + carried


def _filter_line(line: str, allowed: frozenset[str]) -> Optional[str]:
    """One line with its foreign words removed; ``None`` when the line had
    words and none survived."""
    tokens = line.split()
    if not any(is_foreign_word(t, allowed) for t in tokens):
        return line
    indent = line[: len(line) - len(line.lstrip(" \t"))]
    kept: list[str] = []
    for token in tokens:
        if not is_foreign_word(token, allowed):
            kept.append(token)
        elif kept:
            kept[-1] = _attach(kept[-1], token)
    if not kept:
        return None
    return indent + " ".join(kept)


def strip_foreign_script(text: str, allowed: Optional[frozenset[str]]) -> str:
    """*text* without the words written in scripts outside *allowed*.

    Lines whose words were all removed disappear, and so does the blank
    line that would otherwise double up where they stood; every untouched
    line is returned byte for byte.
    """
    if allowed is None or not text:
        return text
    # A final newline terminates the last line; it is not a blank line.
    terminated = text.endswith("\n")
    body = text[:-1] if terminated else text
    out: list[str] = []
    removed_since_content = False
    for line in body.split("\n"):
        filtered = _filter_line(line, allowed)
        if filtered is None:
            removed_since_content = True
            continue
        if not filtered.strip():
            if removed_since_content and (not out or not out[-1].strip()):
                continue
        else:
            removed_since_content = False
        out.append(filtered)
    if removed_since_content and out and not out[-1].strip():
        out.pop()
    result = "\n".join(out)
    return result + "\n" if terminated and result else result


def _filter_words(words: Any, allowed: frozenset[str]) -> Any:
    if not isinstance(words, list):
        return words
    return [
        w for w in words
        if not (isinstance(w, Mapping) and is_foreign_word(str(w.get("word") or ""), allowed))
    ]


def _filter_segment(segment: Any, allowed: frozenset[str]) -> Any:
    if not isinstance(segment, Mapping):
        return segment
    out = dict(segment)
    if isinstance(out.get("text"), str):
        out["text"] = strip_foreign_script(out["text"], allowed)
    if "words" in out:
        out["words"] = _filter_words(out["words"], allowed)
    return out


def _emptied(before: Any, after: Any) -> bool:
    return (
        isinstance(before, Mapping)
        and str(before.get("text") or "").strip() != ""
        and isinstance(after, Mapping)
        and str(after.get("text") or "").strip() == ""
    )


def strip_foreign_script_payload(payload: Mapping[str, Any], allowed: Optional[frozenset[str]]) -> Any:
    """A transcript payload with the rule applied to every text it carries.

    The shapes the backend hands out: ``text``, a ``segments`` list (each
    with its own ``text`` and ``words``), or one ``segment`` (a live
    interim). A segment in a list whose text the rule empties is dropped;
    a lone ``segment`` keeps its place with empty text. Everything else —
    timings, stats, the provider's ``raw`` evidence — is passed through.
    Returns *payload* itself when nothing is restricted, a copy otherwise.
    """
    if allowed is None or not isinstance(payload, Mapping):
        return payload
    out = dict(payload)
    if isinstance(out.get("text"), str):
        out["text"] = strip_foreign_script(out["text"], allowed)
    if isinstance(out.get("segments"), list):
        kept = []
        for seg in out["segments"]:
            filtered = _filter_segment(seg, allowed)
            if not _emptied(seg, filtered):
                kept.append(filtered)
        out["segments"] = kept
    if isinstance(out.get("segment"), Mapping):
        out["segment"] = _filter_segment(out["segment"], allowed)
    return out


__all__ = [
    "LANGUAGE_SCRIPTS",
    "SCRIPT_CYRILLIC",
    "SCRIPT_DEVANAGARI",
    "SCRIPT_HAN",
    "SCRIPT_HIRAGANA",
    "SCRIPT_KATAKANA",
    "SCRIPT_LATIN",
    "allowed_scripts",
    "is_foreign_word",
    "letter_script",
    "strip_foreign_script",
    "strip_foreign_script_payload",
    "transcript_scripts",
]
