"""Two readings of one recording, merged by word timestamps.

Covers the three things ``backend.deepgram_dual`` owns (see its module
docstring for the measurement this is built on):

* the DECISION — when a second reading is worth opening at all;
* the MERGE — pairing, hole-filling, provenance, and the "без без"
  defect the 2026-09-04 measurement found and named;
* the FACADE — fan-out to two sockets behind the interface of one.
"""

from __future__ import annotations

import asyncio
import time
import unittest
from dataclasses import dataclass, field
from typing import Optional

from backend.config import DEFAULT_CONFIG, _validate_config_shape
from backend.deepgram_dual import (
    ADJACENT_SAME_STEM_MAX_GAP_SEC,
    DUAL_SECONDARY_LANGUAGE_DEFAULT,
    DUAL_STREAM_DEFAULT,
    DualLiveSession,
    dual_secondary_language,
    dual_stream_enabled,
    flatten_words,
    merge_readings,
    secondary_config,
)
from backend.remote_deepgram_live import DeepgramLiveConfig, DeepgramLiveSession


def _cfg(**over) -> dict:
    cfg = {"preferences": {"deepgram": {}}}
    cfg["preferences"]["deepgram"].update(over)
    return cfg


def _w(word: str, start: float, end: float) -> dict:
    return {"word": word, "start": start, "end": end}


def _segment(words: list[dict], text: Optional[str] = None) -> dict:
    return {
        "start": words[0]["start"] if words else 0.0,
        "end": words[-1]["end"] if words else 0.0,
        "text": text if text is not None else " ".join(w["word"] for w in words),
        "words": words,
    }


# ---------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------


class DualStreamEnabledTests(unittest.TestCase):
    def test_on_by_default_when_the_recording_is_multilingual(self):
        self.assertTrue(dual_stream_enabled({}, "auto"))
        self.assertTrue(dual_stream_enabled({}, "multi"))
        self.assertTrue(dual_stream_enabled({}, ""))

    def test_off_for_a_monolingual_recording_regardless_of_the_preference(self):
        # A user who already picked "ru" is getting the reading the
        # merge would add; a second identical reading buys nothing for
        # double the money.
        self.assertFalse(dual_stream_enabled({}, "ru"))
        self.assertFalse(dual_stream_enabled(_cfg(dual_stream=True), "ru"))
        self.assertFalse(dual_stream_enabled(_cfg(dual_stream=True), "en"))

    def test_the_preference_can_turn_it_off(self):
        self.assertFalse(dual_stream_enabled(_cfg(dual_stream=False), "multi"))

    def test_the_preference_can_turn_it_on_explicitly(self):
        self.assertTrue(dual_stream_enabled(_cfg(dual_stream=True), "auto"))

    def test_a_non_dict_config_does_not_raise_and_reads_as_default(self):
        self.assertEqual(dual_stream_enabled(None, "multi"), DUAL_STREAM_DEFAULT)
        self.assertEqual(dual_stream_enabled("oops", "multi"), DUAL_STREAM_DEFAULT)


class DualSecondaryLanguageTests(unittest.TestCase):
    def test_defaults_to_ru(self):
        self.assertEqual(dual_secondary_language({}), DUAL_SECONDARY_LANGUAGE_DEFAULT)
        self.assertEqual(DUAL_SECONDARY_LANGUAGE_DEFAULT, "ru")

    def test_reads_and_normalizes_the_configured_value(self):
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language="EN")), "en")
        self.assertEqual(
            dual_secondary_language(_cfg(dual_secondary_language="  ru  ")), "ru"
        )

    def test_a_blank_or_wrong_typed_value_falls_back_to_the_default(self):
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language="")), "ru")
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language=3)), "ru")

    def test_a_value_this_build_cannot_offer_falls_back_to_the_default(self):
        # Validated against DUAL_SECONDARY_LANGUAGE_OPTIONS, not merely
        # lowercased (B-027 / R-016): a stored code the live-language
        # picker cannot show would otherwise stream something the user
        # never chose while Settings displayed the default.
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language="es")), "ru")
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language="auto")), "ru")
        self.assertEqual(dual_secondary_language(_cfg(dual_secondary_language="fr")), "ru")


class ConfigDefaultsTests(unittest.TestCase):
    """SSOT: the renderer's autosave sends exactly these keys (deepgram-dual.ts)."""

    def test_default_config_declares_both_keys(self):
        dg = DEFAULT_CONFIG["preferences"]["deepgram"]
        self.assertIs(dg["dual_stream"], True)
        self.assertEqual(dg["dual_secondary_language"], "ru")

    def test_validation_repairs_a_non_boolean_dual_stream(self):
        fixed = _validate_config_shape(
            {"preferences": {"deepgram": {"dual_stream": "yes"}}}
        )
        self.assertIs(fixed["preferences"]["deepgram"]["dual_stream"], True)

    def test_validation_repairs_a_blank_secondary_language(self):
        fixed = _validate_config_shape(
            {"preferences": {"deepgram": {"dual_secondary_language": "   "}}}
        )
        self.assertEqual(
            fixed["preferences"]["deepgram"]["dual_secondary_language"], "ru"
        )

    def test_validation_leaves_a_well_typed_block_untouched(self):
        fixed = _validate_config_shape(
            {
                "preferences": {
                    "deepgram": {"dual_stream": False, "dual_secondary_language": "es"}
                }
            }
        )
        self.assertIs(fixed["preferences"]["deepgram"]["dual_stream"], False)
        self.assertEqual(fixed["preferences"]["deepgram"]["dual_secondary_language"], "es")


class SecondaryConfigTests(unittest.TestCase):
    def test_only_the_language_changes(self):
        cfg = DeepgramLiveConfig(
            model="nova-3", language="multi", keyterms=("foo",), diarize=True,
            sample_rate=16000,
        )
        secondary = secondary_config(cfg, "ru")
        self.assertEqual(secondary.language, "ru")
        self.assertEqual(secondary.model, cfg.model)
        self.assertEqual(secondary.keyterms, cfg.keyterms)
        self.assertEqual(secondary.diarize, cfg.diarize)
        self.assertEqual(secondary.sample_rate, cfg.sample_rate)


# ---------------------------------------------------------------------
# The merge
# ---------------------------------------------------------------------


class FlattenWordsTests(unittest.TestCase):
    def test_words_are_tagged_with_their_source_and_time_ordered(self):
        segs = [
            _segment([_w("two", 2.0, 2.5)]),
            _segment([_w("one", 0.0, 0.5)]),
        ]
        out = flatten_words(segs, "primary")
        self.assertEqual([w["word"] for w in out], ["one", "two"])
        self.assertTrue(all(w["source"] == "primary" for w in out))

    def test_a_wordless_segment_reads_as_one_record_over_its_span(self):
        """B-001: a final without a word list is still a reading.

        This used to assert the opposite — that such a segment
        contributes nothing — which is exactly the defect: since
        ``merged.text`` is built from words, a wordless final deleted
        its whole clause from the transcript of an Auto recording, with
        no error and no log line. The single-stream path had already
        named this case three times (``_spanless_coverage``,
        ``_word_covered_by_spanless_final``, the wordless branch of
        ``_process_deepgram_message``): its span is the only placement
        knowable and its text is what was said.
        """
        out = flatten_words([{"text": "hi there", "start": 0, "end": 1}], "primary")
        self.assertEqual(
            out,
            [
                {
                    "word": "hi there",
                    "start": 0.0,
                    "end": 1.0,
                    "source": "primary",
                    "spanless": True,
                }
            ],
        )

    def test_a_wordless_segment_with_no_text_contributes_nothing(self):
        """Nothing said, nothing known — the one case that IS empty."""
        self.assertEqual(
            flatten_words([{"text": "", "start": 0, "end": 1}], "primary"), []
        )


class MergeReadingsTests(unittest.TestCase):
    def test_the_bez_bez_case_is_not_duplicated(self):
        # Reproduces the measured defect verbatim (REPORT.md, the
        # "single source of truth, без без костылей" file): multi's
        # "без" sits at 7.75-7.99 because the preceding word swallowed
        # the pause; ru's "без" sits at 7.11-7.59. The two spans do not
        # overlap at all (gap 0.16s), so a pure-overlap rule sees two
        # different words and both survive as hole-fills — the visible
        # duplicate. Isolated from any neighbouring word so only the
        # без/без pairing is under test.
        primary = [_segment([_w("без", 7.75, 7.99)])]
        secondary = [_segment([_w("без", 7.11, 7.59)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual([w["word"] for w in merged.words], ["без"])
        self.assertEqual(merged.filled_from_primary, 0)
        self.assertEqual(merged.filled_from_secondary, 0)

    def test_the_gap_bound_is_load_bearing(self):
        # Same shape, but push the gap just past the bound: now they are
        # two different spoken words and must NOT merge into one.
        gap = ADJACENT_SAME_STEM_MAX_GAP_SEC + 0.2
        primary = [_segment([_w("без", 7.75, 7.99)])]
        secondary = [_segment([_w("без", 7.75 - gap - 0.24, 7.99 - gap - 0.24)])]
        merged = merge_readings(primary, secondary)
        bez_count = sum(1 for w in merged.words if w["word"] == "без")
        self.assertEqual(bez_count, 2)

    def test_a_hole_in_the_primary_is_filled_from_the_secondary(self):
        # The measured 21.82-25.99s hole: multi has nothing there, ru
        # has every word of it. Both readings agree on the surrounding
        # words (so those pair off cleanly) and only the hole words are
        # unpaired secondary — an unambiguous "filled from ru".
        primary = [
            _segment([_w("before", 0.0, 1.0)]),
            _segment([_w("after", 10.0, 11.0)]),
        ]
        secondary = [
            _segment([_w("before", 0.0, 1.0)]),
            _segment(
                [_w("говорю", 2.0, 2.5), _w("просто", 2.6, 3.0), _w("кучу", 3.1, 3.5)]
            ),
            _segment([_w("after", 10.0, 11.0)]),
        ]
        merged = merge_readings(primary, secondary)
        words = [w["word"] for w in merged.words]
        self.assertEqual(words, ["before", "говорю", "просто", "кучу", "after"])
        self.assertEqual(merged.filled_from_secondary, 3)
        self.assertEqual(merged.filled_from_primary, 0)
        filled = [w for w in merged.words if w["word"] == "говорю"][0]
        self.assertEqual(filled["source"], "ru")

    def test_a_hole_in_the_secondary_is_filled_from_the_primary(self):
        # Mirror: ru skipped a French clause entirely, multi had it.
        primary = [
            _segment([_w("before", 0.0, 1.0)]),
            _segment([_w("lab", 5.0, 5.3), _w("de", 5.3, 5.5), _w("la", 5.5, 5.7)]),
            _segment([_w("after", 10.0, 11.0)]),
        ]
        secondary = [
            _segment([_w("before", 0.0, 1.0)]),
            _segment([_w("after", 10.0, 11.0)]),
        ]
        merged = merge_readings(primary, secondary)
        words = [w["word"] for w in merged.words]
        self.assertEqual(words, ["before", "lab", "de", "la", "after"])
        self.assertEqual(merged.filled_from_primary, 3)
        self.assertEqual(merged.filled_from_secondary, 0)
        filled = [w for w in merged.words if w["word"] == "lab"][0]
        self.assertEqual(filled["source"], "multi")

    def test_every_merged_word_carries_provenance(self):
        primary = [_segment([_w("hello", 0.0, 0.5)])]
        secondary = [_segment([_w("мир", 5.0, 5.5)])]
        merged = merge_readings(primary, secondary)
        self.assertTrue(all("source" in w for w in merged.words))
        sources = {w["word"]: w["source"] for w in merged.words}
        self.assertEqual(sources["hello"], "multi")
        self.assertEqual(sources["мир"], "ru")

    def test_same_core_overlap_prefers_the_primarys_spelling(self):
        primary = [_segment([_w("Sonnet,", 1.0, 1.5)])]
        secondary = [_segment([_w("sonnet", 1.05, 1.45)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual([w["word"] for w in merged.words], ["Sonnet,"])

    def test_different_core_overlap_with_latin_prefers_multi(self):
        # A monolingual Russian reading transliterates "Sonnet"; the
        # multilingual reading keeps it as written.
        primary = [_segment([_w("Sonnet", 1.0, 1.5)])]
        secondary = [_segment([_w("Соннет", 1.05, 1.45)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual([w["word"] for w in merged.words], ["Sonnet"])

    def test_different_core_both_cyrillic_prefers_the_secondary(self):
        # The measured stronger reading on Cyrillic content.
        primary = [_segment([_w("Локи", 1.0, 1.5)])]
        secondary = [_segment([_w("который", 1.05, 1.45)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual([w["word"] for w in merged.words], ["который"])

    def test_ngram_guard_keeps_a_genuine_disjoint_time_repeat(self):
        # "subagents, subagents" — spoken twice, far apart in time. Must
        # survive as two words, not be halved by the seam de-duplicator.
        primary = [
            _segment([_w("subagents,", 1.0, 1.5)]),
            _segment([_w("subagents", 40.0, 40.6)]),
        ]
        secondary = [
            _segment([_w("субагенты,", 1.0, 1.5)]),
            _segment([_w("субагенты", 40.0, 40.6)]),
        ]
        merged = merge_readings(primary, secondary)
        count = sum(1 for w in merged.words if w["word"].lower().startswith("subagents"))
        self.assertEqual(count, 2)
        self.assertEqual(merged.duplicates_removed, 0)

    def test_no_secondary_words_degrades_to_the_primary_reading_unchanged(self):
        primary = [_segment([_w("only", 0.0, 0.5), _w("primary", 0.6, 1.0)])]
        merged = merge_readings(primary, [])
        self.assertEqual([w["word"] for w in merged.words], ["only", "primary"])
        self.assertEqual(merged.secondary_word_count, 0)
        self.assertEqual(merged.filled_from_secondary, 0)
        self.assertEqual(merged.filled_from_primary, 0)
        self.assertTrue(all(w["source"] == "multi" for w in merged.words))

    def test_covered_end_sec_and_text_reflect_the_merge(self):
        primary = [_segment([_w("a", 0.0, 1.0)])]
        secondary = [_segment([_w("b", 5.0, 6.0)])]
        merged = merge_readings(primary, secondary)
        self.assertAlmostEqual(merged.covered_end_sec(), 6.0)
        self.assertEqual(merged.text, "a b")


class DiarizedMergeTests(unittest.TestCase):
    """BE-03: Auto + diarize runs the dual merge, and the merge used to
    rebuild segments with no ``speaker`` at all — diarization silently
    did nothing on the default path."""

    def _diarized(self, words, speaker):
        seg = _segment(words)
        seg["speaker"] = speaker
        return seg

    def test_segments_carry_the_primarys_speakers_and_split_at_a_turn(self):
        primary = [
            self._diarized([_w("hello", 0.0, 0.4), _w("there", 0.4, 0.8)], 0),
            self._diarized([_w("hi", 0.9, 1.2), _w("back", 1.2, 1.5)], 1),
        ]
        secondary = [
            _segment([_w("hello", 0.0, 0.4), _w("there", 0.4, 0.8),
                      _w("hi", 0.9, 1.2), _w("back", 1.2, 1.5)])
        ]
        merged = merge_readings(primary, secondary)
        self.assertEqual(
            [(seg["text"], seg.get("speaker")) for seg in merged.segments],
            [("hello there", 0), ("hi back", 1)],
        )

    def test_a_word_only_the_secondary_heard_takes_the_nearest_turn(self):
        primary = [
            self._diarized([_w("one", 0.0, 0.4)], 0),
            self._diarized([_w("three", 3.0, 3.4)], 1),
        ]
        secondary = [_segment([_w("one", 0.0, 0.4), _w("два", 2.5, 2.9), _w("three", 3.0, 3.4)])]
        merged = merge_readings(primary, secondary)
        speakers = {w["word"]: w.get("speaker") for w in merged.words}
        self.assertEqual(speakers, {"one": 0, "два": 1, "three": 1})

    def test_without_diarization_no_speaker_appears(self):
        merged = merge_readings(
            [_segment([_w("hello", 0.0, 0.4)])], [_segment([_w("hello", 0.0, 0.4)])]
        )
        self.assertNotIn("speaker", merged.segments[0])
        self.assertNotIn("speaker", merged.words[0])


class ForwardedSegmentWireShapeTests(unittest.TestCase):
    """Pin the wire shape a final ``segments`` frame sends the renderer.

    ``backend.deepgram_dual`` merges two readings by word time, and the
    words it needs are exactly the ones a final segment frame already
    carries (``remote_deepgram_live.py``, the ``out_segment["words"]``
    comment). If that ever grows extra keys or loses ``start``/``end``,
    the merge silently loses its only join key — pinned here so a
    refactor of the single-stream forwarding path cannot drift out from
    under the dual-stream feature that depends on it.
    """

    def test_a_final_segment_carries_word_start_end_and_deepgrams_evidence(self):
        # ``confidence`` (every model) and ``language`` (``multi``, per
        # word) travel with the word since 2026-11-20: they are what the
        # contested-stretch rule decides from (``_settle_contested_stretches``).
        session = DeepgramLiveSession(api_key="k")
        msg = {
            "type": "Results",
            "is_final": True,
            "speech_final": True,
            "start": 1.0,
            "duration": 1.5,
            "channel": {
                "alternatives": [
                    {
                        "transcript": "hello world",
                        "confidence": 0.9,
                        "words": [
                            {
                                "word": "hello",
                                "start": 1.0,
                                "end": 1.4,
                                "confidence": 0.95,
                                "language": "en",
                                "punctuated_word": "Hello",
                            },
                            {
                                "word": "world",
                                "start": 1.4,
                                "end": 2.5,
                                "confidence": 0.88,
                                "punctuated_word": "world.",
                            },
                        ],
                    }
                ]
            },
        }
        event = session._process_deepgram_message(msg)
        self.assertEqual(event["type"], "segments")
        self.assertEqual(len(event["segments"]), 1)
        words = event["segments"][0]["words"]
        self.assertEqual(
            words,
            [
                {"word": "Hello", "start": 1.0, "end": 1.4, "confidence": 0.95, "language": "en"},
                {"word": "world.", "start": 1.4, "end": 2.5, "confidence": 0.88},
            ],
        )
        for w in words:
            self.assertTrue({"word", "start", "end"} <= set(w.keys()))

    def test_a_final_with_no_word_list_omits_the_key_entirely(self):
        # An empty list would read as "no words here"; omitting the key
        # is the only honest way to say "not known" (module comment).
        session = DeepgramLiveSession(api_key="k")
        msg = {
            "type": "Results",
            "is_final": True,
            "speech_final": True,
            "start": 0.0,
            "duration": 1.0,
            "channel": {"alternatives": [{"transcript": "hi", "confidence": 0.5}]},
        }
        event = session._process_deepgram_message(msg)
        self.assertNotIn("words", event["segments"][0])


# ---------------------------------------------------------------------
# The facade
# ---------------------------------------------------------------------


@dataclass
class _FakeStats:
    connect_ms: Optional[float] = 50.0


@dataclass
class _FakeLiveSession:
    """The surface ``DualLiveSession`` actually touches, and nothing else."""

    name: str
    drain_result: dict = field(default_factory=dict)
    holes: list = field(default_factory=list)
    sent: list = field(default_factory=list)
    send_error: Optional[Exception] = None
    drain_error: Optional[Exception] = None
    drain_delay: float = 0.0
    # What ``partial_result()`` returns — the facade's fallback when this
    # session's own ``drain_transcript()`` is still running past the
    # primary's announced budget. Defaults to the full ``drain_result``
    # so a test that doesn't care about the partial-vs-full distinction
    # doesn't have to set it twice; tests exercising the timeout path set
    # this to something genuinely SHORTER than ``drain_result`` to prove
    # the facade used the snapshot, not the (never-returned) full drain.
    partial_result_data: Optional[dict] = None
    stats: _FakeStats = field(default_factory=_FakeStats)
    is_closed: bool = False
    last_error: Optional[str] = None
    last_fatal: bool = False
    shutdown_called: bool = False
    close_called: bool = False
    discard_called: bool = False
    undelivered: list = field(default_factory=list)
    drain_running: bool = False
    drain_running_at_snapshot: Optional[bool] = None

    async def send_pcm(self, chunk: bytes) -> None:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append(chunk)

    async def drain_transcript(self, on_budget=None) -> dict:
        if on_budget is not None:
            on_budget(2.0, False)
        self.drain_running = True
        try:
            if self.drain_delay:
                await asyncio.sleep(self.drain_delay)
        finally:
            # Set only once the coroutine has actually unwound — the
            # facade must not snapshot or shut down while it is still
            # between these two lines.
            self.drain_running = False
        if self.drain_error is not None:
            raise self.drain_error
        return dict(self.drain_result)

    def coverage_hole_spans(self):
        return list(self.holes)

    def partial_result(self) -> dict:
        self.drain_running_at_snapshot = self.drain_running
        return dict(
            self.partial_result_data
            if self.partial_result_data is not None
            else self.drain_result
        )

    def report_fatal(self, message: str) -> None:
        self.last_fatal = True
        self.last_error = message

    def note_undelivered_audio(self, nbytes: int) -> None:
        self.undelivered.append(nbytes)

    def events(self):
        async def _gen():
            yield {"type": "marker", "from": self.name}
        return _gen()

    def final_text(self) -> str:
        return str(self.drain_result.get("text") or "")

    async def shutdown(self, wait_timeout: float = 3.0) -> None:
        self.shutdown_called = True

    async def close(self) -> None:
        self.close_called = True

    async def discard(self) -> None:
        self.discard_called = True


def _primary(**over) -> _FakeLiveSession:
    base = dict(
        name="primary",
        drain_result={
            "text": "before after",
            "segments": [_segment([_w("before", 0.0, 1.0), _w("after", 10.0, 11.0)])],
            "streamedSec": 11.0,
        },
    )
    base.update(over)
    return _FakeLiveSession(**base)


def _secondary(**over) -> _FakeLiveSession:
    # Agrees with ``_primary``'s "before"/"after" (so those pair off
    # cleanly) and additionally caught the word in the gap between them
    # that the primary reading missed — the one thing this fixture
    # exists to test: a hole filled from the secondary.
    base = dict(
        name="secondary",
        drain_result={
            "text": "before hole after",
            "segments": [
                _segment(
                    [_w("before", 0.0, 1.0), _w("hole", 2.0, 2.5), _w("after", 10.0, 11.0)]
                )
            ],
            "streamedSec": 11.0,
        },
    )
    base.update(over)
    return _FakeLiveSession(**base)


class DualLiveSessionFanOutTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_pcm_reaches_both_sockets(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        await dual.send_pcm(b"abc")
        self.assertEqual(primary.sent, [b"abc"])
        self.assertEqual(secondary.sent, [b"abc"])

    async def test_events_come_only_from_the_primary(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        events = [e async for e in dual.events()]
        self.assertEqual(events, [{"type": "marker", "from": "primary"}])

    async def test_events_follow_a_primary_replacement(self):
        # The warm-socket liveness path (``backend.main``) replaces the
        # primary mid-recording without ever handing out a new facade —
        # ``replace_primary`` mutates ``dual.primary`` in place. A
        # consumer that started iterating ``dual.events()`` before the
        # swap must keep receiving events from the NEW primary
        # afterward, never see the secondary's, and must not be cut off
        # just because the old primary's own generator ended.
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        fresh = _primary(name="fresh-primary")
        collected = []
        async for event in dual.events():
            collected.append(event)
            if event["from"] == "primary":
                old = dual.replace_primary(fresh)
                self.assertIs(old, primary)
        self.assertEqual(
            collected,
            [
                {"type": "marker", "from": "primary"},
                {"type": "marker", "from": "fresh-primary"},
            ],
        )
        self.assertTrue(all(e["from"] != "secondary" for e in collected))

    async def test_a_secondary_send_failure_degrades_without_touching_the_primary(self):
        primary = _primary()
        secondary = _secondary(send_error=RuntimeError("boom"))
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        with self.assertLogs("backend.deepgram_dual", level="WARNING") as logs:
            await dual.send_pcm(b"xyz")
        self.assertEqual(primary.sent, [b"xyz"])
        self.assertTrue(dual.secondary_failed)
        self.assertEqual(len(logs.output), 1, "logged once")
        # A second failing send does not log again.
        await dual.send_pcm(b"more")
        self.assertEqual(primary.sent, [b"xyz", b"more"])

    async def test_note_undelivered_audio_reaches_both(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        dual.note_undelivered_audio(42)
        self.assertEqual(primary.undelivered, [42])
        self.assertEqual(secondary.undelivered, [42])

    async def test_shutdown_close_discard_reach_both_sockets(self):
        for method in ("shutdown", "close", "discard"):
            primary, secondary = _primary(), _secondary()
            dual = DualLiveSession(primary, secondary, secondary_language="ru")
            await getattr(dual, method)()
            self.assertTrue(getattr(primary, f"{method}_called"))
            self.assertTrue(getattr(secondary, f"{method}_called"))

    async def test_replace_primary_swaps_only_the_primary(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        fresh = _primary(name="fresh-primary")
        old = dual.replace_primary(fresh)
        self.assertIs(old, primary)
        self.assertIs(dual.primary, fresh)
        self.assertIs(dual.secondary, secondary)


class DualLiveSessionDrainTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_merged_envelope_carries_the_dual_stats(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(
            primary, secondary,
            secondary_language="ru", primary_language="multi",
        )
        envelope = await dual.drain_transcript()
        self.assertEqual(envelope["text"], "before hole after")
        self.assertEqual(envelope["stats"]["dual_stream"], True)
        self.assertIs(envelope["stats"]["dual_stream"], True, "must be a bool")
        self.assertEqual(envelope["stats"]["dual_secondary_language"], "ru")
        self.assertEqual(envelope["stats"]["dual_filled_from_secondary"], 1)
        self.assertEqual(envelope["stats"]["dual_filled_from_primary"], 0)
        words = envelope["words"]
        self.assertEqual([w["word"] for w in words], ["before", "hole", "after"])
        self.assertTrue(all({"word", "start", "end", "source"} <= w.keys() for w in words))
        for seg in envelope["segments"]:
            self.assertIn("words", seg)

    async def test_one_budget_is_announced_and_forwarded(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        seen = []
        await dual.drain_transcript(on_budget=lambda b, more: seen.append((b, more)))
        self.assertEqual(seen, [(2.0, False)])

    async def test_a_dead_secondary_degrades_to_single_stream(self):
        # A hard failure (the socket dropped, an exception) is NOT the
        # same shape as merely running late (see the "blows the budget"
        # test below) — there is no partial result worth trusting here,
        # so this keeps the "drop to single-stream" behaviour.
        primary = _primary()
        secondary = _secondary(drain_error=RuntimeError("socket dropped"))
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        with self.assertLogs("backend.deepgram_dual", level="WARNING"):
            envelope = await dual.drain_transcript()
        self.assertEqual(envelope["text"], "before after")
        self.assertIs(envelope["stats"]["dual_stream"], False)
        self.assertTrue(dual.secondary_failed)

    async def test_a_secondary_that_blows_the_budget_merges_its_partial_result(self):
        # (c) primary done + covered, secondary still draining: the
        # facade must not wait past the primary's announced budget, but
        # discarding the secondary entirely throws away real committed
        # words its recv loop already has — merge in the SNAPSHOT
        # (``partial_result()``) instead of dropping to single-stream.
        primary = _primary()
        secondary = _secondary(
            drain_delay=10.0,
            # What the secondary's recv loop had actually committed by
            # the time the primary's budget ran out — shorter than its
            # (never-returned) full ``drain_result`` of "before hole
            # after", proving the facade used the snapshot.
            partial_result_data={
                "text": "before",
                "segments": [_segment([_w("before", 0.0, 1.0)])],
                "streamedSec": 1.0,
                "coveredEndSec": 1.0,
            },
        )
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        with self.assertLogs("backend.deepgram_dual", level="WARNING") as logs:
            envelope = await dual.drain_transcript(
                on_budget=lambda b, more: None
            )
        self.assertTrue(
            any("secondary late, merged partial" in m for m in logs.output),
            logs.output,
        )
        # The partial secondary only re-confirms "before" (already in the
        # primary); "after" comes from the primary alone. Nothing is
        # dropped, and this genuinely is a (partial) merge.
        self.assertEqual(envelope["text"], "before after")
        self.assertIs(envelope["stats"]["dual_stream"], True)
        self.assertFalse(dual.secondary_failed)

    async def test_a_late_secondary_is_awaited_before_it_is_snapshotted(self):
        # B-011: the timeout path cancelled the secondary's drain and
        # went straight on to ``partial_result()`` and, one line later
        # in the caller, ``shutdown()``. The abandoned coroutine is
        # still appending its interim-splice fallback segments to the
        # very list being snapshotted, and still holds the socket
        # ``shutdown()`` is about to send ``CloseStream`` on. Cancelling
        # is a request; only awaiting is the answer.
        primary = _primary()
        secondary = _secondary(drain_delay=10.0)
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        with self.assertLogs("backend.deepgram_dual", level="WARNING"):
            await dual.drain_transcript(on_budget=lambda b, more: None)
        self.assertIs(
            secondary.drain_running_at_snapshot,
            False,
            "the secondary's drain was still running when it was snapshotted",
        )

    async def test_uncovered_speech_is_measured_on_the_merged_words(self):
        primary = _primary(holes=[(2.0, 2.5)])
        secondary = _secondary(holes=[])
        dual = DualLiveSession(primary, secondary, secondary_language="ru")
        envelope = await dual.drain_transcript()
        # The secondary's "hole" word fills exactly the primary's
        # reported hole span, so nothing should remain uncovered.
        self.assertAlmostEqual(envelope["uncoveredSpeechSec"], 0.0, places=3)

    async def test_finalize_drains_then_shuts_down_both_sockets(self):
        # The single-session back-compat convenience
        # (DeepgramLiveSession.finalize) — a caller that only knows that
        # API (the A/B tool) must get it here too, not an
        # AttributeError, or the facade is not really "one interface
        # either way".
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(
            primary, secondary,
            secondary_language="ru", primary_language="multi",
        )
        envelope = await dual.finalize()
        self.assertEqual(envelope["text"], "before hole after")
        self.assertTrue(primary.shutdown_called)
        self.assertTrue(secondary.shutdown_called)

    async def test_the_stop_line_reports_both_word_counts(self):
        primary, secondary = _primary(), _secondary()
        dual = DualLiveSession(
            primary, secondary,
            secondary_language="ru", primary_language="multi",
        )
        with self.assertLogs("backend.deepgram_dual", level="INFO") as logs:
            await dual.drain_transcript()
        line = next(m for m in logs.output if "dual-stream merge" in m)
        self.assertIn("multi=2 words", line)
        self.assertIn("ru=3 words", line)
        self.assertIn("merged=3", line)
        self.assertIn("filled_from_ru=1", line)
        self.assertIn("filled_from_multi=0", line)
        self.assertIn("dups_removed=0", line)


# ---------------------------------------------------------------------
# B-001 / B-002: a final without words, and the cost of the merge
# ---------------------------------------------------------------------


def _ev(word: str, start: float, end: float, conf: float, lang: Optional[str] = None) -> dict:
    out = {"word": word, "start": start, "end": end, "confidence": conf}
    if lang:
        out["language"] = lang
    return out


class ContestedStretchTests(unittest.TestCase):
    """One owner per stretch the readings hear in different languages.

    Every number below is a real Deepgram reading (2026-11-20 replay via
    ``backend.tools.deepgram_live_ab --words``): the screen-mode take
    where ``multi`` heard Russian as Lithuanian, and the 2026-09-03
    trilingual recording where it heard Russian as German and English as
    English.
    """

    # multi, take 2026-11-20 16:11:56, 10.83-13.55 s — tagged ``lt``.
    LT_MULTI = [
        _ev("Ir", 10.83, 11.23, 0.908, "lt"), _ev("galgenas", 11.23, 11.87, 0.711, "lt"),
        _ev("žamanas", 11.87, 12.27, 0.888, "lt"), _ev("tačiau", 12.27, 12.59, 0.853, "lt"),
        _ev("kompiuterių", 12.59, 13.23, 0.837, "lt"), _ev("net", 13.23, 13.55, 0.893, "lt"),
        _ev("окно", 14.04, 14.52, 0.800, "ru"),
    ]
    LT_RU = [
        _ev("Когда", 10.75, 11.63, 0.330), _ev("я", 11.63, 11.71, 0.995),
        _ev("нажимаю", 11.71, 12.03, 0.917), _ev("на", 12.03, 12.27, 0.990),
        _ev("значок", 12.27, 12.59, 0.999), _ev("компьютера,", 12.59, 13.23, 0.886),
        _ev("у", 13.23, 13.31, 0.974), _ev("меня", 13.31, 13.47, 1.0),
        _ev("окно", 13.64, 14.44, 0.319),
    ]

    def test_a_hallucinated_language_goes_to_the_confident_reading_whole(self):
        merged = merge_readings([_segment(self.LT_MULTI)], [_segment(self.LT_RU)])
        self.assertTrue(merged.text.startswith("Когда я нажимаю на значок компьютера, у меня окно"))
        for foreign in ("Ir", "galgenas", "žamanas", "tačiau", "kompiuterių", "net"):
            self.assertNotIn(foreign, merged.text.split())
        self.assertEqual((merged.contested_to_secondary, merged.contested_to_primary), (1, 0))

    def test_real_foreign_speech_stays_with_the_multilingual_reading_whole(self):
        # Trilingual 14.58-17.30: genuine English; ``ru`` was less sure.
        multi = [_ev("Agents", 14.58, 15.46, 0.995, "en"), _ev("workflow.", 15.78, 17.30, 0.957, "en")]
        ru = [_ev("Agents,", 14.66, 15.78, 0.649), _ev("workflow.", 15.78, 17.06, 0.914),
              _ev("Да,", 17.14, 17.46, 0.967)]
        merged = merge_readings([_segment(multi)], [_segment(ru)])
        self.assertEqual(merged.text, "Agents workflow. Да,")
        self.assertEqual((merged.contested_to_secondary, merged.contested_to_primary), (0, 1))

    def test_german_hallucination_on_russian_speech_goes_to_ru(self):
        multi = [_ev("Von", 32.95, 33.3, 0.55, "de"), _ev("der", 33.3, 33.6, 0.62, "de"),
                 _ev("Französkomme", 33.6, 34.4, 0.70, "de"), _ev("gehören,", 34.4, 35.43, 0.69, "de")]
        ru = [_ev("На", 32.95, 33.2, 0.96), _ev("французском", 33.2, 34.0, 0.95),
              _ev("я", 34.0, 34.2, 0.97), _ev("обычно", 34.2, 34.8, 0.94), _ev("не", 34.8, 35.0, 0.93),
              _ev("говорю,", 35.0, 35.4, 0.95)]
        merged = merge_readings([_segment(multi)], [_segment(ru)])
        self.assertEqual(merged.text, "На французском я обычно не говорю,")

    def test_a_stretch_only_the_multilingual_reading_heard_is_kept(self):
        # The September French clause ``ru`` skipped entirely.
        multi = [_ev("de", 30.0, 30.3, 0.6, "fr"), _ev("la", 30.3, 30.5, 0.6, "fr"),
                 _ev("France.", 30.5, 31.0, 0.6, "fr")]
        merged = merge_readings([_segment(multi)], [_segment([_ev("Да", 1.0, 1.3, 0.99)])])
        self.assertIn("de la France.", merged.text)
        self.assertEqual((merged.contested_to_secondary, merged.contested_to_primary), (0, 0))

    def test_without_confidence_the_word_rules_decide_as_before(self):
        multi = [_w("Hello", 1.0, 1.4) | {"language": "en"}]
        ru = [_w("Хелло", 1.0, 1.4)]
        merged = merge_readings([_segment(multi)], [_segment(ru)])
        self.assertEqual(merged.text, "Hello")
        self.assertEqual((merged.contested_to_secondary, merged.contested_to_primary), (0, 0))

    def test_words_in_the_secondarys_own_language_are_never_contested(self):
        multi = [_ev("привет", 1.0, 1.4, 0.2, "ru")]
        ru = [_ev("привет", 1.0, 1.4, 0.99)]
        merged = merge_readings([_segment(multi)], [_segment(ru)])
        self.assertEqual((merged.contested_to_secondary, merged.contested_to_primary), (0, 0))

    def test_a_single_partner_fragment_does_not_take_a_stretch(self):
        """BE-01: ``ru`` skipped the French clause but emitted one word
        inside it. One confident word is no reading of six seconds."""
        multi = [_ev(f"mot{i}", 30.0 + i * 0.75, 30.7 + i * 0.75, 0.6, "fr") for i in range(8)]
        ru = [_ev("да", 33.0, 33.3, 0.97)]
        merged = merge_readings([_segment(multi)], [_segment(ru)])
        self.assertEqual(merged.text, " ".join(f"mot{i}" for i in range(8)))
        self.assertEqual((merged.contested_to_secondary, merged.contested_to_primary), (0, 1))

    def test_partner_ground_includes_words_whose_midpoint_lies_outside(self):
        """Measured 2026-11-20 on the 2026-09-03 trilingual take: ``ru``'s
        "слушай." runs 1.52-4.48 s, past the ``uk``-tagged stretch, yet it
        is ground the partner read — the stretch is fully covered and the
        more confident reading takes it."""
        multi = [_ev("Так,", 1.20, 1.84, 0.716, "uk"), _ev("слушай", 1.84, 2.24, 0.801, "uk")]
        ru = [_ev("Так,", 1.12, 1.52, 0.9), _ev("слушай.", 1.52, 4.48, 0.859)]
        merged = merge_readings([_segment(multi)], [_segment(ru)])
        self.assertEqual((merged.contested_to_secondary, merged.contested_to_primary), (1, 0))
        self.assertEqual(merged.text, "Так, слушай.")

    def test_a_tie_goes_to_the_secondary(self):
        multi = [_ev("Ir", 1.0, 1.4, 0.8, "lt"), _ev("net", 1.4, 1.8, 0.8, "lt")]
        ru = [_ev("Когда", 1.0, 1.4, 0.8), _ev("я", 1.4, 1.8, 0.8)]
        merged = merge_readings([_segment(multi)], [_segment(ru)])
        self.assertEqual(merged.text, "Когда я")

    def test_an_english_partner_leaves_russian_speech_to_the_multilingual_reading(self):
        """BE-02, measured 2026-11-20 with ``--dual en`` on the trilingual
        take: over ``multi``'s Russian 5.80-12.37 s the English reading
        heard two words, and over its German hallucination 32.95-36.83 s a
        handful — neither is a reading of that speech."""
        multi = [
            _ev("если", 5.80, 6.12, 0.994, "ru"), _ev("тебе", 6.12, 6.52, 1.0, "ru"),
            _ev("нужно,", 6.52, 6.76, 0.973, "ru"), _ev("я", 6.76, 7.00, 1.0, "ru"),
            _ev("вот", 7.00, 7.16, 0.984, "ru"), _ev("сейчас", 7.16, 7.48, 1.0, "ru"),
            _ev("записываю", 7.48, 8.12, 0.912, "ru"), _ev("прямо", 8.12, 8.36, 0.854, "ru"),
            _ev("сейчас", 8.36, 8.68, 0.999, "ru"), _ev("голосовое", 8.68, 9.32, 0.98, "ru"),
            _ev("сообщение.", 9.32, 9.64, 0.792, "ru"), _ev("На", 10.05, 10.29, 0.993, "ru"),
            _ev("останется.", 10.29, 10.85, 0.76, "ru"),
            _ev("Hello.", 10.85, 11.89, 0.399, "ru"), _ev("Hello,", 11.89, 12.29, 0.828, "ru"),
        ]
        en = [_ev("Hello.", 10.93, 11.49, 0.583), _ev("Hello,", 11.81, 12.37, 0.963)]
        merged = merge_readings(
            [_segment(multi)], [_segment(en)], secondary_language="en",
        )
        self.assertTrue(merged.text.startswith("если тебе нужно, я вот сейчас записываю"))
        self.assertIn("На останется. Hello. Hello,", merged.text)
        self.assertEqual((merged.contested_to_secondary, merged.contested_to_primary), (0, 1))
        self.assertTrue(all(w["source"] in ("multi", "en") for w in merged.words))

    def test_flatten_keeps_the_evidence(self):
        words = flatten_words([_segment([_ev("Hi", 0.0, 0.5, 0.9, "en")])], "multi")
        self.assertEqual(words[0]["confidence"], 0.9)
        self.assertEqual(words[0]["language"], "en")


class WordlessFinalMergeTests(unittest.TestCase):
    """A final Deepgram sent without a word list must still be read.

    ``merge_readings`` builds its text from words, so a wordless final
    used to disappear from the merged transcript entirely — total,
    silent loss of a clause on the path Auto takes by default (B-001).
    The rule now is the one the single-stream path always used: such a
    segment is ONE record over its span, carrying its text.
    """

    def test_a_wordless_primary_final_survives_the_merge(self):
        primary = [{"start": 0.0, "end": 3.0, "text": "это весь мой текст"}]
        secondary = [_segment([_w("это", 0.4, 0.7)])]
        self.assertEqual(
            merge_readings(primary, secondary).text, "это весь мой текст"
        )

    def test_a_wordless_primary_final_survives_with_no_secondary(self):
        """The ``if not secondary`` branch promises the primary reading
        UNTOUCHED, and this is the case where it used to be emptied."""
        primary = [{"start": 0.0, "end": 3.0, "text": "это весь мой текст"}]
        self.assertEqual(merge_readings(primary, []).text, "это весь мой текст")

    def test_the_other_reading_wins_the_ground_when_it_has_the_words(self):
        """A blob loses to real words over most of its own span: those
        words are the same audio, positioned, and printing both would
        say the clause twice."""
        primary = [{"start": 0.0, "end": 1.0, "text": "раз два три"}]
        secondary = [
            _segment([_w("раз", 0.0, 0.3), _w("два", 0.35, 0.65), _w("три", 0.7, 1.0)])
        ]
        self.assertEqual(merge_readings(primary, secondary).text, "раз два три")

    def test_a_blob_and_the_words_under_it_are_never_both_printed(self):
        """The symmetric half: when the blob survives, the other
        reading's words inside it do not also appear."""
        primary = [{"start": 0.0, "end": 4.0, "text": "целая длинная фраза"}]
        secondary = [_segment([_w("фраза", 3.5, 3.9)])]
        merged = merge_readings(primary, secondary)
        self.assertEqual(merged.text, "целая длинная фраза")

    def test_two_wordless_finals_of_the_same_ground_are_not_doubled(self):
        primary = [{"start": 0.0, "end": 2.0, "text": "one two three"}]
        secondary = [{"start": 0.0, "end": 2.0, "text": "one two free"}]
        merged = merge_readings(primary, secondary)
        self.assertEqual(len(merged.words), 1)

    def test_a_wordless_final_still_counts_as_covered_ground(self):
        primary = [{"start": 0.0, "end": 3.0, "text": "это весь мой текст"}]
        merged = merge_readings(primary, [])
        self.assertEqual(merged.covered_spans(), [(0.0, 3.0)])
        self.assertEqual(merged.covered_end_sec(), 3.0)


class MergeCostTests(unittest.TestCase):
    """B-002: the merge runs synchronously between Stop and the text.

    Pairing used to rescan the whole secondary reading from index 0 for
    every primary word — O(P x S) — which cost a measured 2.8 s on a
    7-minute dictation and 30.8 s on a 20-minute one, inside the event
    loop and outside the budget the stop had already announced to the
    renderer.

    Asserted on CPU time, not wall time: what the defect did was OCCUPY
    the event loop, and CPU time is the only measure of that which a
    loaded CI machine cannot distort into a false red.
    """

    @staticmethod
    def _reading(count: int, jitter: float) -> list[dict]:
        words = [
            _w(f"w{i}", round(i * 0.35 + jitter, 3), round(i * 0.35 + jitter + 0.3, 3))
            for i in range(count)
        ]
        return [_segment(words[i:i + 10]) for i in range(0, count, 10)]

    @staticmethod
    def _cpu_ms(primary: list[dict], secondary: list[dict]) -> float:
        started = time.process_time()
        merge_readings(primary, secondary)
        return (time.process_time() - started) * 1000.0

    def test_two_long_readings_merge_in_well_under_the_assembly_allowance(self):
        # 3000 words per reading is a 20-minute dictation — the shape
        # that measured 30.8 s before the sweep replaced the rescan.
        cost_ms = min(
            self._cpu_ms(self._reading(3000, 0.0), self._reading(3000, 0.02))
            for _ in range(3)
        )
        self.assertLess(
            cost_ms, 100.0,
            f"merge_readings spent {cost_ms:.0f} ms of CPU on 3000x3000 words",
        )

    def test_the_cost_grows_with_the_words_and_not_with_their_square(self):
        """The property, not the number: quadratic growth would be ~16x
        for 4x the words, linear is ~4x. Anything under 8x is linear
        with room for measurement noise."""
        small = min(
            self._cpu_ms(self._reading(750, 0.0), self._reading(750, 0.02))
            for _ in range(3)
        )
        large = min(
            self._cpu_ms(self._reading(3000, 0.0), self._reading(3000, 0.02))
            for _ in range(3)
        )
        self.assertLess(
            large, max(small, 0.5) * 8.0,
            f"750x750 cost {small:.1f} ms, 3000x3000 cost {large:.1f} ms",
        )


    @staticmethod
    def _contested_cpu_ms(stretches: int) -> tuple[float, int]:
        primary, secondary = [], []
        for i in range(stretches):
            t = i * 2.0
            primary.append(_ev(f"f{i}", t, t + 0.3, 0.6, "fr"))
            primary.append(_ev(f"r{i}", t + 1.4, t + 1.7, 0.9, "ru"))
            secondary.append(_ev(f"a{i}", t, t + 0.3, 0.9))
            secondary.append(_ev(f"b{i}", t + 1.4, t + 1.7, 0.9))
        started = time.process_time()
        merged = merge_readings([_segment(primary)], [_segment(secondary)])
        return (time.process_time() - started) * 1000.0, merged.contested_to_secondary

    def test_contested_stretches_do_not_rescan_the_partner_per_stretch(self):
        """BE-12: every contested stretch used to rescan the whole partner
        reading for its rivals — O(stretches x words) on the stop path.
        Same property as above: 4x the stretches must cost well under 16x."""
        small, small_count = min(self._contested_cpu_ms(750) for _ in range(3))
        large, large_count = min(self._contested_cpu_ms(3000) for _ in range(3))
        self.assertEqual((small_count, large_count), (750, 3000))
        self.assertLess(
            large, max(small, 0.5) * 8.0,
            f"750 stretches cost {small:.1f} ms, 3000 cost {large:.1f} ms",
        )


class DualDefaultsSsotTests(unittest.TestCase):
    """One place says "dual is on, and its partner is ru" (B-027).

    The pair was written out in ``config.DEFAULT_CONFIG`` and again in
    ``deepgram_dual`` — whose own comment claimed the secondary language
    "is read from ONE place" while being the second of two literals —
    and a third time in the renderer. The renderer copy is the dangerous
    one: a wrong "absent" default there is PERSISTED by the next
    autosave, so a mismatch silently turns the feature off on disk.
    """

    def test_the_module_reads_the_catalog_defaults(self):
        import backend.deepgram_dual as dual
        from backend.model_catalog import (
            DUAL_SECONDARY_LANGUAGE_DEFAULT,
            DUAL_STREAM_DEFAULT,
        )

        self.assertIs(dual.DUAL_STREAM_DEFAULT, DUAL_STREAM_DEFAULT)
        self.assertIs(
            dual.DUAL_SECONDARY_LANGUAGE_DEFAULT, DUAL_SECONDARY_LANGUAGE_DEFAULT
        )

    def test_the_config_default_is_the_same_pair(self):
        import importlib
        import os
        import sys
        import tempfile

        from backend.model_catalog import (
            DUAL_SECONDARY_LANGUAGE_DEFAULT,
            DUAL_STREAM_DEFAULT,
        )

        with tempfile.TemporaryDirectory() as td:
            old = os.environ.get("TRANSCRIPTOR_DATA_DIR")
            os.environ["TRANSCRIPTOR_DATA_DIR"] = td
            sys.modules.pop("backend.config", None)
            try:
                cfg_mod = importlib.import_module("backend.config")
                dg = cfg_mod.DEFAULT_CONFIG["preferences"]["deepgram"]
                self.assertEqual(dg["dual_stream"], DUAL_STREAM_DEFAULT)
                self.assertEqual(
                    dg["dual_secondary_language"], DUAL_SECONDARY_LANGUAGE_DEFAULT
                )
            finally:
                sys.modules.pop("backend.config", None)
                if old is None:
                    os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
                else:
                    os.environ["TRANSCRIPTOR_DATA_DIR"] = old

    def test_an_absent_preference_falls_back_to_the_shipped_default(self):
        from backend.model_catalog import (
            DUAL_SECONDARY_LANGUAGE_DEFAULT,
            DUAL_STREAM_DEFAULT,
        )

        self.assertEqual(
            dual_stream_enabled({}, "auto"), DUAL_STREAM_DEFAULT
        )
        self.assertEqual(
            dual_secondary_language({}), DUAL_SECONDARY_LANGUAGE_DEFAULT
        )

if __name__ == "__main__":
    unittest.main()
