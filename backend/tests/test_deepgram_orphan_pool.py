"""Orphan pool for displaced interim hypotheses (BUG-24).

Live evidence 2026-08-24 session 14:32Z: Deepgram's rolling interims
first decoded a 10.5 s span, then newer hypotheses superseded it, and no
final ever covered it — the supersede rule deleted the only existing
word record and the finalize-time splice had nothing to restore. Words
displaced by a newer hypothesis now move to an orphan pool: still pruned
by finals and by the NEWEST words' coverage, but available to the
finalize splice when nothing better ever arrives.
"""

import unittest

from backend.remote_deepgram_live import DeepgramLiveSession


def _msg(start: float, end: float, text: str, words: list[dict] | None = None) -> dict:
    alt: dict = {"transcript": text}
    if words is not None:
        alt["words"] = [
            {"word": w["word"], "start": w["start"], "end": w["end"]} for w in words
        ]
    return {
        "type": "Results",
        "is_final": False,
        "speech_final": False,
        "start": start,
        "duration": end - start,
        "channel": {"alternatives": [alt]},
    }


def _final_msg(
    start: float, end: float, text: str, words: list[dict] | None = None
) -> dict:
    alt: dict = {"transcript": text}
    if words is not None:
        alt["words"] = [
            {"word": w["word"], "start": w["start"], "end": w["end"]} for w in words
        ]
    return {
        "type": "Results",
        "is_final": True,
        "speech_final": True,
        "start": start,
        "duration": end - start,
        "channel": {"alternatives": [alt]},
    }


def _w(word: str, start: float, end: float) -> dict:
    return {"word": word, "start": start, "end": end}


def _finals(session: DeepgramLiveSession) -> list[tuple[float, float, str]]:
    return [
        (float(s.get("start", 0.0)), float(s.get("end", 0.0)), str(s.get("text", "")))
        for s in session._finalized_segments
    ]


class OrphanPoolTests(unittest.TestCase):
    def _session(self) -> DeepgramLiveSession:
        return DeepgramLiveSession(api_key="k")

    def test_superseded_words_survive_to_splice_when_never_confirmed(self):
        s = self._session()
        # Rolling hypothesis #1 decodes a span...
        s._process_deepgram_message(
            _msg(15.0, 31.5, "я не знаю что это за", [_w("что", 30.9, 31.45)])
        )
        # ...a newer hypothesis supersedes it WITHOUT re-decoding that word.
        s._process_deepgram_message(_msg(31.28, 35.0, "добавим ещё", [_w("добавим", 32.0, 33.0)]))
        # And no final ever covers 30.9..31.45; a later final lands beyond it.
        s._process_deepgram_message(_final_msg(41.74, 43.99, "Гигаам."))

        # finalize() is async; exercise the sync splice path directly:
        spliced = s._splice_uncovered_interim_words()
        texts = [str(seg.get("text") or "") for seg in s._finalized_segments]
        # Case-blind: the word opens the transcript, so it is capitalised.
        self.assertIn("что", " ".join(texts).lower())
        self.assertGreaterEqual(spliced, 1)

    def test_newest_hypothesis_still_wins_no_duplicates(self):
        """The purge is by IDENTITY, not by temporal overlap (§3.2).

        A rolling re-decode almost always puts *some* word on the ground
        an orphan occupies, so purging by overlap emptied the pool
        unless the newer hypothesis happened to leave a hole in exactly
        that place — which is why the pool almost never held anything.
        """
        s = self._session()
        s._process_deepgram_message(_msg(0.0, 2.0, "хеллоу", [_w("хеллоу", 1.0, 1.8)]))
        # A DIFFERENT word on the same ground is not the same word: the
        # newer hypothesis simply did not re-decode "хеллоу".
        s._process_deepgram_message(_msg(0.5, 3.0, "мир", [_w("мир", 1.2, 1.6)]))
        self.assertEqual(
            [o["word"] for o in s._orphan_interim_words],
            ["хеллоу"],
            "a different word at the same time must not evict an orphan",
        )
        # The SAME word, re-decoded at a slightly shifted boundary, IS
        # the newer hypothesis accounting for it — the orphan goes.
        s._process_deepgram_message(
            _msg(0.5, 3.0, "хеллоу мир", [_w("Хеллоу,", 1.05, 1.85), _w("мир", 1.2, 1.6)])
        )
        self.assertEqual(
            [o["word"] for o in s._orphan_interim_words],
            [],
            "the same word re-decoded by the newest hypothesis must evict its orphan",
        )

    def test_a_final_only_clears_the_words_it_actually_contains(self):
        """Inverted from the old ``test_final_confirming_region_clears_orphans``.

        That test pinned the loss the audit measured (§3.1): a final
        whose SPAN covered an orphan deleted it even when the final's
        own words never mentioned it. Coverage is a property of words.
        """
        s = self._session()
        s._process_deepgram_message(_msg(0.0, 2.0, "альфа бета", [_w("бета", 1.0, 1.8)]))
        s._process_deepgram_message(_msg(1.5, 4.0, "гамма", [_w("гамма", 2.2, 3.0)]))
        self.assertEqual(len(s._orphan_interim_words), 1)

        # A final spanning the whole region, whose words do NOT include
        # "бета": the span says covered, the transcript says otherwise.
        s._process_deepgram_message(
            _final_msg(
                0.0, 4.0, "альфа гамма",
                [_w("альфа", 0.2, 0.8), _w("гамма", 2.2, 3.0)],
            )
        )
        self.assertEqual(
            [o["word"] for o in s._orphan_interim_words],
            ["бета"],
            "a final that omits a word must leave it spliceable",
        )

        # A final that DOES contain it clears it.
        s._process_deepgram_message(
            _final_msg(0.0, 4.0, "альфа бета гамма", [_w("бета", 1.0, 1.8)])
        )
        self.assertEqual(s._orphan_interim_words, [])

    def test_a_final_that_spells_the_audio_differently_still_covers_it(self):
        """A disagreement is not a lost word.

        Measured on the 72.7 s trilingual recording while this wave was
        being written: an identity-only coverage rule left every interim
        spelling that a final had re-decoded ("слушаю" where the final
        committed "слушай") in the pool, and the splice put both in the
        transcript — "Так, слушаю слушай." The final owns the time its
        own words occupy; it owns nothing between them, which is where a
        genuinely dropped word lives.
        """
        s = self._session()
        s._process_deepgram_message(
            _msg(0.0, 2.0, "так слушаю", [_w("Так,", 0.40, 0.60), _w("слушаю", 0.70, 1.20)])
        )
        s._process_deepgram_message(
            _final_msg(
                0.0, 2.0, "Так, слушай.",
                [_w("Так,", 0.40, 0.62), _w("слушай.", 0.72, 1.18)],
            )
        )
        self.assertEqual(s._interim_words, [])
        self.assertEqual(s._splice_uncovered_interim_words(), 0)
        self.assertEqual(
            [text for _s, _e, text in _finals(s)], ["Так, слушай."],
        )

    def test_a_shifted_copy_of_a_word_the_final_has_is_not_spliced_beside_it(self):
        """"тебе тебе нужно" — measured, and not a recovery.

        The re-decode moved the boundary further than the majority-
        overlap test tolerates, so the coverage check saw a word the
        final did not carry. Landing it next to the identical word the
        final DOES carry reads as a stutter.
        """
        s = self._session()
        s._process_deepgram_message(
            _msg(48.0, 52.0, "тебе нужно", [_w("тебе", 50.10, 50.30)])
        )
        s._process_deepgram_message(
            _final_msg(
                48.63, 53.33, "тебе нужно",
                [_w("тебе", 50.40, 50.70), _w("нужно", 50.70, 51.10)],
            )
        )
        self.assertEqual([w["word"] for w in s._interim_words], ["тебе"])
        self.assertEqual(s._splice_uncovered_interim_words(), 0)
        self.assertEqual([text for _s, _e, text in _finals(s)], ["тебе нужно"])

    def test_word_the_final_omitted_is_spliced_back_in_time_order(self):
        """The measured case, end to end (audit §3.1, addendum (c)).

        Deepgram's final for 4.91-9.70 s read "три на или если это"
        while its own interim had heard "субагента" at 5.5-6.1 s. The
        eviction by time window deleted the word; the word-level rule
        keeps it, and the splice puts it back between "три" and "на" —
        where it was spoken — instead of after the whole clause.
        """
        s = self._session()
        s._process_deepgram_message(
            _msg(
                4.9, 9.7, "три субагента на или если это",
                [
                    _w("три", 4.91, 5.30),
                    _w("субагента", 5.5, 6.1),
                    _w("на", 6.30, 6.55),
                    _w("или", 6.60, 6.90),
                    _w("если", 7.00, 7.40),
                    _w("это", 7.50, 7.90),
                ],
            )
        )
        s._process_deepgram_message(
            _final_msg(
                4.91, 9.70, "три на или если это",
                [
                    _w("три", 4.91, 5.30),
                    _w("на", 6.30, 6.55),
                    _w("или", 6.60, 6.90),
                    _w("если", 7.00, 7.40),
                    _w("это", 7.50, 7.90),
                ],
            )
        )
        self.assertEqual(
            [w["word"] for w in s._interim_words],
            ["субагента"],
            "the word the final omitted must survive its span",
        )

        self.assertEqual(s._splice_uncovered_interim_words(), 1)
        self.assertEqual(
            [text for _s, _e, text in _finals(s)],
            ["три субагента на или если это"],
        )
        # And it is not merely appended: the recovered word travels with
        # the segment's own word list, in time order.
        self.assertEqual(
            [w["word"] for w in s._finalized_segments[0]["words"]],
            ["три", "субагента", "на", "или", "если", "это"],
        )

    def test_splice_dedupes_shifted_orphan_copy_against_new_interim(self):
        # BUG-78: a word displaced to the orphan pool, then re-decoded by
        # a newer interim at SHIFTED times (boundary moved beyond the
        # range-overlap purge), must not be spliced twice.
        s = self._session()
        s._process_deepgram_message(
            _msg(0.0, 2.0, "привет", [_w("привет", 1.0, 1.8)])
        )
        # Newer hypothesis re-decodes the same spoken word at a shifted
        # boundary (1.35..2.05 does not overlap 1.0..1.8 by enough for
        # the interim-handler purge to drop the orphan copy).
        s._process_deepgram_message(
            _msg(0.5, 3.0, "привет мир", [_w("привет", 1.35, 2.05), _w("мир", 2.2, 2.6)])
        )
        spliced = s._splice_uncovered_interim_words()
        texts = [str(seg.get("text") or "") for seg in s._finalized_segments]
        joined = " ".join(texts)
        # Case-blind: the word opens the transcript, so it is capitalised.
        self.assertEqual(joined.lower().count("привет"), 1, f"word duplicated in splice: {joined!r}")
        # Legit repeat with DISJOINT times is not deduped away.
        self.assertIn("мир", joined)
        self.assertGreaterEqual(spliced, 2)

    def test_a_re_timed_word_below_the_old_majority_threshold_still_covers_it(self):
        """"Так, слушаю слушай." — an A/B artifact on the trilingual
        evidence recording (splice-guard fix, rule 1).

        The final re-timed "слушай" far enough that only a third of the
        interim word's 0.6 s duration overlaps it — below the old
        "majority of the interim word's own duration" rule, so the old
        coverage test called "слушаю" uncovered and the splice
        duplicated it next to the final's own "слушай.". The 0.20 s
        overlap here is still >= 25% of both words' own durations,
        which is the ground the fix stands on: a final that re-decoded
        that audio into "слушай" owns the time it occupies, whatever it
        spelled — the disagreement is not a hole.
        """
        s = self._session()
        s._process_deepgram_message(
            _msg(
                0.0, 2.0, "так слушаю",
                [_w("Так,", 0.40, 0.65), _w("слушаю", 0.70, 1.30)],
            )
        )
        s._process_deepgram_message(
            _final_msg(
                0.0, 2.0, "Так, слушай.",
                [_w("Так,", 0.40, 0.65), _w("слушай.", 1.10, 1.40)],
            )
        )
        self.assertEqual(s._interim_words, [])
        self.assertEqual(s._splice_uncovered_interim_words(), 0)
        self.assertEqual(
            [text for _s, _e, text in _finals(s)], ["Так, слушай."],
        )

    def test_a_stem_matching_neighbour_at_a_fallback_seam_is_not_spliced(self):
        """"...can fix them | them sub agents" — an A/B artifact on the
        trilingual evidence recording (splice-guard fix, rule 3).

        The recovered "them" landed just past the final's OWN "them"
        (0.05 s gap, no time overlap, so rule 1 leaves it genuinely
        uncovered — same word, re-decoded a beat later) and became the
        first word of a brand-new fallback segment right after it. The
        per-final neighbour guard on ``insert_word_into_segment`` never
        saw this pair, because the recovered word has no host final —
        it is a NEW segment sitting at a seam, not an insertion into an
        existing one. The seam guard closes exactly that gap: the
        duplicate "them" is dropped, and the genuinely new words after
        it ("sub agents") still get spliced in.
        """
        s = self._session()
        s._process_deepgram_message(
            _final_msg(
                10.0, 12.85, "истинные причины и can fix them",
                [
                    _w("истинные", 10.00, 10.40),
                    _w("причины", 10.45, 10.90),
                    _w("и", 10.95, 11.05),
                    _w("can", 11.60, 11.80),
                    _w("fix", 12.20, 12.50),
                    _w("them", 12.55, 12.85),
                ],
            )
        )
        s._process_deepgram_message(
            _msg(
                12.9, 14.0, "them sub agents",
                [
                    _w("them", 12.90, 13.20),
                    _w("sub", 13.25, 13.55),
                    _w("agents", 13.60, 13.90),
                ],
            )
        )
        self.assertEqual(
            [w["word"] for w in s._interim_words],
            ["them", "sub", "agents"],
            "the re-decoded 'them' has no time overlap with the final's own "
            "'them', so rule 1 leaves it uncovered",
        )
        self.assertEqual(s._splice_uncovered_interim_words(), 2)
        texts = [text for _s, _e, text in _finals(s)]
        joined = " ".join(texts)
        self.assertEqual(
            joined.count("them"), 1, f"duplicated 'them' at the seam: {joined!r}"
        )
        self.assertIn("sub agents", joined)

    def test_insufficient_room_at_a_fallback_seam_is_not_spliced(self):
        """"посмотреть в WAV | WAB файлы" — an A/B artifact on the
        trilingual evidence recording (splice-guard fix, rule 2).

        "WAB" does not share a stem with the final's "WAV" (rule 3 does
        not fire here in isolation), but it lands only 0.02 s after it —
        far less room than its own 0.35 s duration needs. The genuinely
        new word after it ("файлы"), with a real gap, still gets
        spliced in.
        """
        s = self._session()
        s._process_deepgram_message(
            _final_msg(
                20.0, 22.30, "посмотреть в WAV",
                [
                    _w("посмотреть", 20.00, 20.60),
                    _w("в", 21.80, 21.90),
                    _w("WAV", 21.95, 22.30),
                ],
            )
        )
        s._process_deepgram_message(
            _msg(
                22.3, 23.5, "WAB файлы",
                [_w("WAB", 22.32, 22.67), _w("файлы", 22.75, 23.10)],
            )
        )
        self.assertEqual(
            [w["word"] for w in s._interim_words], ["WAB", "файлы"],
        )
        self.assertEqual(s._splice_uncovered_interim_words(), 1)
        texts = [text for _s, _e, text in _finals(s)]
        joined = " ".join(texts)
        self.assertNotIn("WAB", joined, f"no room for it at the seam: {joined!r}")
        self.assertIn("файлы", joined)

    def test_splice_keeps_legitimate_disjoint_repeats(self):
        s = self._session()
        s._process_deepgram_message(
            _msg(0.0, 2.0, "да", [_w("да", 1.0, 1.4)])
        )
        s._process_deepgram_message(
            _msg(5.0, 7.0, "да", [_w("да", 6.0, 6.4)])
        )
        s._splice_uncovered_interim_words()
        joined = " ".join(
            str(seg.get("text") or "") for seg in s._finalized_segments
        )
        # Case-blind: the first "да" opens the transcript ("Да да").
        self.assertEqual(joined.lower().count("да"), 2, "a genuinely repeated word was wrongly deduped")


if __name__ == "__main__":
    unittest.main()
