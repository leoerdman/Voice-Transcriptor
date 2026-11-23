"""Two loss-classes from 2026-08-24 live logs, fixed and pinned.

1. Seam severing — Deepgram's periodic forced flushes can cut a word in
   half across consecutive finals ("…раз, два, три, четыре, пя" |
   "ть. …"). ``merge_seam_fragments`` re-joins such fragments in the
   canonical transcript when every guard holds.

2. Silent tail loss — when Deepgram never answers Finalize
   ("no post-Finalize transcript within 3.0s" fired 19× that day), the
   stream used to close blind. Now a retry fires only when streamed
   audio actually runs past the last finalized segment.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest import mock

from backend.remote_deepgram_live import (
    DeepgramLiveSession,
    drop_repeated_seam_ngrams,
    merge_seam_fragments,
)


class MergeSeamFragmentsTests(unittest.TestCase):
    def test_rejoins_word_severed_at_flush_boundary(self):
        segs = [
            {"start": 5.94, "end": 17.76, "text": "Вау, раз, два, четыре, пя"},
            {"start": 17.76, "end": 22.22, "text": "ть. Некоторые слова"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "Вау, раз, два, четыре, пять.")
        self.assertEqual(out[1]["text"], "Некоторые слова")

    def test_next_segment_absorbed_entirely_when_only_the_fragment(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "сказал п"},
            {"start": 3.0, "end": 6.0, "text": "ока"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["text"], "сказал пока")

    def test_trailing_content_after_the_fragment_stays_its_own_segment(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "сказал п"},
            {"start": 3.0, "end": 6.0, "text": "ока всё"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual([s["text"] for s in out], ["сказал пока", "всё"])

    def test_normal_word_boundary_is_never_merged(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "и тут"},
            {"start": 3.0, "end": 6.0, "text": "началось"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "и тут")
        self.assertEqual(out[1]["text"], "началось")

    def test_sentence_boundary_is_never_merged(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "Вот конец."},
            {"start": 3.0, "end": 6.0, "text": "дальше новое"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "Вот конец.")

    def test_real_pause_is_never_bridged(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "конец п"},
            {"start": 4.5, "end": 6.0, "text": "ока"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(len(out), 2)

    def test_new_sentence_starting_capital_is_never_merged(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "вопрос т"},
            {"start": 3.0, "end": 6.0, "text": "Так мы начали"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[1]["text"], "Так мы начали")

    def test_latin_fragment_joins(self):
        segs = [
            {"start": 0.0, "end": 2.0, "text": "say th"},
            {"start": 2.0, "end": 4.0, "text": "ink about it"},
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "say think")
        self.assertEqual(out[1]["text"], "about it")

    def test_single_segment_passthrough(self):
        segs = [{"start": 0.0, "end": 1.0, "text": "привет"}]
        self.assertEqual(merge_seam_fragments(segs)[0]["text"], "привет")

    def test_vowelless_russian_words_are_never_glued_to_the_next_token(self):
        """Audit §3.3, reproduced by running the function on real shapes.

        Deepgram's finals touch with a 0.00 s gap, so the temporal guard
        never fires; the morphology guard then read "в", "с" and "к" as
        severed syllables and glued each to the following word. They are
        complete Russian words — a preposition cannot be told from a
        fragment by counting vowels, so the heuristic is not allowed to
        judge them at all.
        """
        for prev_text, next_text in (
            ("мы живём в", "доме на горе"),
            ("поговорил с", "ней вчера"),
            ("иду к", "нему домой"),
        ):
            with self.subTest(seam=f"{prev_text}|{next_text}"):
                segs = [
                    {"start": 0.00, "end": 4.91, "text": prev_text},
                    {"start": 4.91, "end": 9.70, "text": next_text},
                ]
                out = merge_seam_fragments(segs)
                self.assertEqual([s["text"] for s in out], [prev_text, next_text])

    def test_provider_word_lists_settle_the_seam_without_guessing(self):
        # Both touching tokens are whole entries in the provider's own
        # word lists: it is telling us they are two words, and no
        # morphology is consulted.
        segs = [
            {
                "start": 0.00, "end": 4.91, "text": "мы живём в",
                "words": [
                    {"word": "мы", "start": 4.20, "end": 4.45},
                    {"word": "живём", "start": 4.45, "end": 4.80},
                    {"word": "в", "start": 4.80, "end": 4.91},
                ],
            },
            {
                "start": 4.91, "end": 9.70, "text": "доме на горе",
                "words": [
                    {"word": "доме", "start": 4.91, "end": 5.30},
                    {"word": "на", "start": 5.30, "end": 5.50},
                    {"word": "горе", "start": 5.50, "end": 5.90},
                ],
            },
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual([s["text"] for s in out], ["мы живём в", "доме на горе"])

    def test_a_token_the_provider_itself_split_still_merges(self):
        # Here the word list contradicts the text: the transcript was cut
        # at "пя" while the provider's own word entry reads "пять". That
        # disagreement IS the evidence of a severed token.
        segs = [
            {
                "start": 5.94, "end": 17.76, "text": "раз, два, четыре, пя",
                "words": [
                    {"word": "четыре,", "start": 17.10, "end": 17.50},
                    {"word": "пять", "start": 17.50, "end": 17.76},
                ],
            },
            {
                "start": 17.76, "end": 22.22, "text": "ть. Некоторые слова",
                "words": [
                    {"word": "ть.", "start": 17.76, "end": 17.90},
                    {"word": "Некоторые", "start": 17.90, "end": 18.60},
                    {"word": "слова", "start": 18.60, "end": 19.20},
                ],
            },
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual(out[0]["text"], "раз, два, четыре, пять.")
        self.assertEqual(out[1]["text"], "Некоторые слова")
        # The word lists follow the text — one segment can never say two
        # different things about what it contains.
        self.assertEqual(
            [w["word"] for w in out[0]["words"]], ["четыре,", "пятьть."],
        )
        self.assertEqual(
            [w["word"] for w in out[1]["words"]], ["Некоторые", "слова"],
        )

    def test_a_fused_word_keeps_the_evidence_of_its_halves(self):
        """BE-08: the dual merge decides contested stretches from each
        word's ``confidence``/``language``; a fused word without them ends
        a contested run in the middle of the stretch."""
        segs = [
            {
                "start": 0.0, "end": 1.0, "text": "kompiuter",
                "words": [{"word": "kompiuterių", "start": 0.4, "end": 1.0,
                           "confidence": 0.9, "language": "lt"}],
            },
            {
                "start": 1.0, "end": 2.0, "text": "ių net",
                "words": [
                    {"word": "ių", "start": 1.0, "end": 1.2, "confidence": 0.5, "language": "en"},
                    {"word": "net", "start": 1.2, "end": 1.6, "confidence": 0.8, "language": "lt"},
                ],
            },
        ]
        out = merge_seam_fragments(segs)
        fused = out[0]["words"][-1]
        self.assertEqual(fused["word"], "kompiuteriųių")
        # Duration-weighted: 0.6 s at 0.9 and 0.2 s at 0.5.
        self.assertAlmostEqual(fused["confidence"], 0.8, places=3)
        self.assertEqual(fused["language"], "lt")

    def test_words_far_apart_are_not_merged_even_when_the_text_disagrees(self):
        segs = [
            {
                "start": 0.0, "end": 3.0, "text": "сказал п",
                "words": [{"word": "пока", "start": 2.0, "end": 3.0}],
            },
            {
                "start": 3.0, "end": 6.0, "text": "ока всё",
                "words": [
                    {"word": "ока", "start": 3.9, "end": 4.2},
                    {"word": "всё", "start": 4.2, "end": 4.5},
                ],
            },
        ]
        out = merge_seam_fragments(segs)
        self.assertEqual([s["text"] for s in out], ["сказал п", "ока всё"])

    def test_the_caller_s_segments_are_never_mutated(self):
        segs = [
            {"start": 0.0, "end": 3.0, "text": "сказал п",
             "words": [{"word": "п", "start": 2.9, "end": 3.0}]},
            {"start": 3.0, "end": 6.0, "text": "ока всё",
             "words": [{"word": "ока", "start": 3.0, "end": 3.3},
                       {"word": "всё", "start": 3.3, "end": 3.6}]},
        ]
        before = [dict(s, words=[dict(w) for w in s["words"]]) for s in segs]
        merge_seam_fragments(segs)
        self.assertEqual(segs, before)


class _FakeUpstreamWs:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, payload):
        self.sent.append(json.loads(payload).get("type"))

    async def close(self):
        return None

    @property
    def types(self) -> list[str]:
        return list(self.sent)


def _session() -> DeepgramLiveSession:
    session = DeepgramLiveSession(api_key="k")
    session._ws = _FakeUpstreamWs()
    session._keepalive_task = None
    session._recv_task = None
    return session


class TailGuardTests(unittest.IsolatedAsyncioTestCase):
    """What the stop retries a Finalize for, and what it does not.

    These cases are about the DECISION, never about how long the wait
    is — so they must not pay the real ceiling. Each of the three used
    to sleep through ``FINALIZE_FLUSH_WAIT_SEC`` (3 s) twice with the
    upstream deliberately silent, which is most of this module's twelve
    seconds and the wall-clock style B-024 came out of.
    """

    def setUp(self) -> None:
        patcher = mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.02
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_retry_fires_when_recognised_speech_runs_past_last_final(self):
        session = _session()
        ws = session._ws
        assert ws is not None
        # 11 s of audio streamed, only 10 s finalized, and an interim
        # heard words through 11 s → the trailing second is real speech
        # that never reached a final. This is what the guard is for.
        session._finalized_segments = [
            {"start": 0.0, "end": 10.0, "text": "хвост", "is_final": True},
        ]
        session.stats.bytes_sent = int(11.0 * 2 * session._cfg.sample_rate)
        session._interim_speech_spans = [(10.0, 11.0)]

        async def silent():
            await asyncio.sleep(99)

        blocker = asyncio.create_task(silent())
        try:
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.2)
        finally:
            blocker.cancel()
        finalize_sends = [i for i, t in enumerate(ws.types) if t == "Finalize"]
        self.assertGreaterEqual(
            len(finalize_sends), 2,
            f"tail guard must retry Finalize; frames were {ws.types}",
        )

    async def test_uncovered_audio_with_no_interim_speech_does_not_retry(self):
        # This test used to pin the OPPOSITE behaviour — gap-alone was
        # treated as sufficient evidence, on the reasoning that a provider
        # gone quiet and a user gone silent look identical to a
        # speech-only signal (production, 2026-08-24:
        # ``streamed=20.08s covered=16.07s gap=4.01s speech_in_gap=0.00s``,
        # a genuine trailing sentence lost). That trade was reversed once
        # the cost was measured directly: audit §5 found the retry this
        # produced a transcript in 1 of 84 such uncovered-but-unvoiced
        # tails, and session f94121ae (2026-09-04T12:26:33Z) is one of the
        # 83 — ``0.91s of audio past last final (0.05s of it recognised
        # speech)``, retried, 6010 ms to close a dual-stream stop whose
        # OTHER reading had already finished in 378 ms. No interim ever
        # touched this gap at all (not even 0.05 s of it), so under the
        # current rule (``_tail_needs_flush``) there is no evidence here
        # to retry for.
        session = _session()
        ws = session._ws
        assert ws is not None
        session._finalized_segments = [
            {"start": 0.0, "end": 10.0, "text": "хвост", "is_final": True},
        ]
        session.stats.bytes_sent = int(11.0 * 2 * session._cfg.sample_rate)
        session._interim_speech_spans = []

        async def silent():
            await asyncio.sleep(99)

        blocker = asyncio.create_task(silent())
        try:
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.2)
        finally:
            blocker.cancel()
        self.assertEqual(
            ws.types.count("Finalize"), 1,
            f"no voiced evidence at all: nothing to retry for; "
            f"frames were {ws.types}",
        )
        self.assertIn("CloseStream", ws.types)

    async def test_no_retry_when_stream_fully_covered(self):
        session = _session()
        ws = session._ws
        assert ws is not None
        session._finalized_segments = [
            {"start": 0.0, "end": 10.0, "text": "полностью", "is_final": True},
        ]
        session.stats.bytes_sent = int(10.0 * 2 * session._cfg.sample_rate)

        async def silent():
            await asyncio.sleep(99)

        blocker = asyncio.create_task(silent())
        try:
            await session.drain_transcript()
            await session.shutdown(wait_timeout=0.2)
        finally:
            blocker.cancel()
        finalize_count = sum(1 for t in ws.types if t == "Finalize")
        self.assertEqual(
            finalize_count, 1,
            f"fully-covered stream must not pay the retry; frames {ws.types}",
        )


class EnvelopeTextSegmentsAgreeTests(unittest.IsolatedAsyncioTestCase):
    """C6 (audit §3.8): ``text`` and ``segments`` in the envelope must
    describe the same transcript — seams merged exactly once, both
    fields derived from that one merged list.
    """

    async def test_seam_merged_word_appears_whole_in_both_fields(self):
        session = _session()
        session._finalized_segments = [
            {"start": 5.94, "end": 17.76, "text": "раз, два, четыре, пя"},
            {"start": 17.76, "end": 22.22, "text": "ть. Некоторые слова"},
        ]
        session.stats.bytes_sent = int(22.22 * 2 * session._cfg.sample_rate)
        session.stats.bytes_offered = session.stats.bytes_sent
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.02
        ):
            result = await session.drain_transcript()

        self.assertIn("пять.", result["text"])
        self.assertNotIn("пя ть", result["text"])
        seg_texts = [seg["text"] for seg in result["segments"]]
        self.assertTrue(
            any("пять." in t for t in seg_texts),
            f"segments must carry the same merge as text; got {seg_texts}",
        )
        # The joined segment texts, in order, must equal `text` exactly —
        # the two fields are the same transcript, not independently
        # derived approximations of it.
        self.assertEqual(
            " ".join(t for t in seg_texts if t).strip(), result["text"],
        )


class DropRepeatedSeamNgramsTests(unittest.TestCase):
    """Cross-final duplicate guard: Deepgram's own endpointing docs show a
    word straddling an ``is_final`` boundary can be transcribed on BOTH
    sides of it ("two two" | "two two three three…"), with no splice
    involved at all — neither ``merge_seam_fragments`` (rejoins one word
    a flush cut in half) nor the splice guard (stops a newly RECOVERED
    word duplicating a final's word) touches this case.
    """

    @staticmethod
    def _joined(segments: list[dict]) -> str:
        return " ".join(str(seg.get("text") or "").strip() for seg in segments).strip()

    def test_single_word_repeated_across_a_final_boundary_is_dropped(self):
        segs = [
            {"start": 0.0, "end": 2.0, "text": "can fix the"},
            {"start": 2.1, "end": 4.0, "text": "the them sub agents"},
        ]
        out = drop_repeated_seam_ngrams(segs)
        joined = self._joined(out)
        self.assertEqual(joined, "can fix the them sub agents")
        self.assertEqual(joined.split().count("the"), 1, f"'the' duplicated: {joined!r}")

    def test_largest_matching_run_is_dropped_not_just_one_word(self):
        segs = [
            {"start": 0.0, "end": 1.0, "text": "two two"},
            {"start": 1.3, "end": 2.5, "text": "two two three"},
        ]
        out = drop_repeated_seam_ngrams(segs)
        self.assertEqual(self._joined(out), "two two three")

    def test_a_real_repeat_across_a_pause_is_kept(self):
        segs = [
            {"start": 0.0, "end": 1.0, "text": "да"},
            {"start": 3.5, "end": 4.0, "text": "да"},
        ]
        out = drop_repeated_seam_ngrams(segs)
        self.assertEqual(
            self._joined(out), "да да", "a genuine repeat across a pause was dropped"
        )

    def test_word_lists_travel_with_the_trimmed_segment(self):
        # Realistic straddle: a word split across an is_final boundary is
        # the SAME audio re-transcribed on both sides, so the two word
        # lists report nearly the same times for it, not disjoint ones.
        segs = [
            {
                "start": 0.0, "end": 1.0, "text": "two two",
                "words": [
                    {"word": "two", "start": 0.10, "end": 0.40},
                    {"word": "two", "start": 0.45, "end": 0.75},
                ],
            },
            {
                "start": 0.0, "end": 1.10, "text": "two two three",
                "words": [
                    {"word": "two", "start": 0.12, "end": 0.42},
                    {"word": "two", "start": 0.47, "end": 0.77},
                    {"word": "three", "start": 0.80, "end": 1.10},
                ],
            },
        ]
        out = drop_repeated_seam_ngrams(segs)
        self.assertEqual(self._joined(out), "two two three")
        self.assertEqual([w["word"] for w in out[1]["words"]], ["three"])

    def test_same_words_at_disjoint_times_are_both_kept(self):
        """"Then sub agents, sub agents, single source of..." — measured
        by isolating and re-decoding the 57-62 s span of the trilingual
        evidence recording: the speaker genuinely said "sub agents"
        twice, back to back. A stem match at a seam is not enough on its
        own; word timings 0.8 s apart (well past any re-decode boundary
        jitter) say these are two utterances, not one straddling a
        final split, and both must survive.
        """
        segs = [
            {
                "start": 0.0, "end": 0.70, "text": "sub agents",
                "words": [
                    {"word": "sub", "start": 0.00, "end": 0.30},
                    {"word": "agents", "start": 0.35, "end": 0.70},
                ],
            },
            {
                "start": 1.50, "end": 2.20, "text": "sub agents",
                "words": [
                    {"word": "sub", "start": 1.50, "end": 1.80},
                    {"word": "agents", "start": 1.85, "end": 2.20},
                ],
            },
        ]
        out = drop_repeated_seam_ngrams(segs)
        self.assertEqual(self._joined(out), "sub agents sub agents")

    def test_same_words_at_overlapping_times_collapse_to_one(self):
        """The disjoint-times case's mirror: when the two "sub agents"
        occurrences report almost the SAME audio moment — a boundary
        straddle, not two utterances — the second is dropped, same as
        "two two" | "two two three".
        """
        segs = [
            {
                "start": 0.0, "end": 0.70, "text": "sub agents",
                "words": [
                    {"word": "sub", "start": 0.00, "end": 0.30},
                    {"word": "agents", "start": 0.35, "end": 0.70},
                ],
            },
            {
                "start": 0.02, "end": 0.75, "text": "sub agents",
                "words": [
                    {"word": "sub", "start": 0.02, "end": 0.32},
                    {"word": "agents", "start": 0.37, "end": 0.72},
                ],
            },
        ]
        out = drop_repeated_seam_ngrams(segs)
        self.assertEqual(self._joined(out), "sub agents")


if __name__ == "__main__":
    unittest.main()
