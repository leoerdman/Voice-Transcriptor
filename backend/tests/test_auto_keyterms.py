"""The self-filling keyterm vocabulary (``backend.auto_keyterms``).

Every keyterm biases Deepgram toward itself, so a wrong one is not
harmless: a common word, a mis-scripted Russian word or a file name in
the list makes recognition WORSE. The extraction tests pin what is and
is not a candidate; the store tests pin that the work stays cheap (one
new file read per save, nothing on the request path) and survives a
restart.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Optional

from backend.auto_keyterms import (
    BUILTIN_TERMS,
    AutoKeytermStore,
    CorpusEntry,
)
from backend.english_frequent_words import is_frequent_english


def _ranked(texts, **kwargs):
    """The store's own ranking over one recording per text.

    What this used to do — read each text into its statistics, then rank
    them together — is ``AutoKeytermStore.recompute``'s composition. A
    copy of it here could drift from the store while both kept passing,
    so the tests build the archive the store reads (``_Corpus``) and let
    the store rank it; only the fake archive is local.
    """
    corpus = _Corpus()
    for index, text in enumerate(texts):
        corpus.put(f"r{index}", text, float(index))
    store = AutoKeytermStore(
        corpus=corpus.entries,
        cache_path=None,
        builtin_terms=kwargs.pop("builtin", ()),
        **kwargs,
    )
    store.recompute()
    return list(store.snapshot().terms)


def _terms(texts, **kwargs) -> list[str]:
    return [t.term for t in _ranked(texts, **kwargs)]


class CandidateTests(unittest.TestCase):
    def test_a_name_recurring_across_recordings_is_found(self):
        texts = [
            "Сегодня я открыл Deepgram и проверил ключ.",
            "Потом снова зашёл в Deepgram посмотреть баланс.",
            "Вечером Deepgram опять ответил ошибкой.",
        ]
        self.assertIn("Deepgram", _terms(texts))

    def test_repeats_inside_one_recording_do_not_count(self):
        texts = ["Тут Deepgram, и Deepgram, и ещё раз Deepgram, и Deepgram."] + [
            "Обычный текст без имён." for _ in range(5)
        ]
        self.assertNotIn("Deepgram", _terms(texts))

    def test_a_capitalised_first_word_is_not_a_name(self):
        texts = ["Сделай это. Потом проверь.", "Сделай так. Потом иди.", "Сделай быстро."]
        terms = _terms(texts)
        self.assertNotIn("Сделай", terms)
        self.assertNotIn("Потом", terms)

    def test_a_word_capitalised_by_noise_but_mostly_lower_is_not_a_name(self):
        texts = [
            "мы прям пошли, а потом Прям вернулись",
            "это прям хорошо и прям быстро",
            "он Прям сказал, что прям сейчас",
            "прям вот так прям",
        ]
        self.assertNotIn("Прям", _terms(texts))

    def test_code_shaped_tokens_are_found(self):
        texts = [f"Запиши в SSOT, открой MacBook и запусти nova-3, вариант {i}." for i in range(3)]
        terms = _terms(texts)
        for expected in ("SSOT", "MacBook", "nova-3"):
            self.assertIn(expected, terms)

    def test_russian_ordinals_file_names_and_paths_are_not_vocabulary(self):
        texts = [
            "Это 2-ой вариант, файл shot-01-preview.jpg лежит в /Users/leo/Library тут."
            for _ in range(4)
        ]
        terms = _terms(texts)
        self.assertNotIn("2-ой", terms)
        self.assertNotIn("shot-01-preview.jpg", terms)
        self.assertNotIn("Users", terms)
        self.assertNotIn("Library", terms)

    def test_latin_inside_russian_speech_is_found(self):
        texts = [
            "надо сделать worktree и потом",
            "создай новый worktree для задачи",
            "удали старый worktree пожалуйста",
        ]
        self.assertIn("worktree", _terms(texts))

    def test_ordinary_english_sentences_add_no_common_words(self):
        texts = [
            "We should check the build before we ship it.",
            "Please check the build and ship it today.",
            "The build is green so we can ship it now.",
        ]
        self.assertEqual(_terms(texts), [])

    def test_russian_returned_in_latin_script_is_rejected(self):
        # Multi mislabels Russian as another language ("Tak" for "так");
        # a keyterm would make that error stick.
        texts = [f"так вот, Tak и так далее, вариант {i}" for i in range(3)] + [
            f"так получилось, так бывает {i}" for i in range(40)
        ]
        self.assertNotIn("Tak", _terms(texts))

    def test_stop_words_are_not_offered(self):
        texts = ["ну Okay давай", "ладно Okay сделаем", "хорошо Okay пошли"]
        self.assertNotIn("Okay", _terms(texts))

    def test_a_two_word_name_is_one_term_and_its_tail_is_not_offered_alone(self):
        texts = [
            "запускаем Ultra Gen на сервере",
            "в Ultra Gen есть сцены",
            "Ultra Gen собрал ролик",
        ]
        terms = _terms(texts)
        self.assertIn("Ultra Gen", terms)
        self.assertNotIn("Gen", terms)

    def test_spelling_variants_are_one_term(self):
        texts = [
            "открой UltraGen сейчас",
            "в UltraGen новая сцена",
            "запусти Ultra Gen ещё раз",
            "проверь Ultra Gen",
            "Ultra Gen готов, а UltraGen ждёт",
        ]
        found = _ranked(texts)
        variants = [t for t in found if t.term.replace(" ", "").lower() == "ultragen"]
        self.assertEqual(len(variants), 1, found)
        self.assertEqual(variants[0].recordings, 5)

    def test_russian_inflections_of_a_name_are_one_term(self):
        texts = [
            "я открыл Транскриптор вчера",
            "у Транскриптора новая версия",
            "мы довольны Транскриптором очень",
            "снова Транскриптор упал",
        ]
        terms = _terms(texts)
        self.assertEqual(
            [t for t in terms if t.lower().startswith("транскриптор")],
            ["Транскриптор"],
        )

    def test_everyday_english_inside_russian_speech_is_not_offered_but_jargon_is(self):
        texts = [
            f"открой main и поправь code в source, потом model и pop-up, а worktree удали {i}"
            for i in range(4)
        ]
        self.assertEqual(_terms(texts), ["worktree"])

    def test_a_capitalised_everyday_word_alone_is_not_a_name_inside_a_two_word_name_it_is(self):
        texts = [f"сделай Liquid Glass на кнопке, и Glass ещё раз, и Motion тоже {i}" for i in range(3)]
        terms = _terms(texts)
        self.assertIn("Liquid Glass", terms)
        self.assertNotIn("Glass", terms)
        self.assertNotIn("Motion", terms)

    def test_shape_wins_over_frequency(self):
        texts = [f"поправь MainActor, потом API и CODE-2 тут {i}" for i in range(3)]
        terms = _terms(texts)
        for expected in ("MainActor", "API", "CODE-2"):
            self.assertIn(expected, terms)

    def test_pieces_split_off_a_compound_name_are_not_offered(self):
        texts = [
            f"запусти Deep DeepSeek на полосе, пусть DeepSeek Seek доделает, а Deep Seek проверит {i}"
            for i in range(3)
        ]
        terms = _terms(texts)
        self.assertIn("DeepSeek", terms)
        for piece in ("Deep", "Seek", "DeepSeek Seek", "Deep DeepSeek"):
            self.assertNotIn(piece, terms)

    def test_a_stutter_is_not_a_two_word_name(self):
        texts = [f"скажи Claude Claude, что всё готово {i}" for i in range(3)]
        terms = _terms(texts)
        self.assertIn("Claude", terms)
        self.assertNotIn("Claude Claude", terms)

    def test_a_surname_that_starts_like_the_first_name_is_still_a_name(self):
        texts = [f"позвони Иван Иванов сегодня {i}" for i in range(3)]
        self.assertIn("Иван Иванов", _terms(texts))

    def test_the_built_in_name_comes_first_with_the_recordings_it_is_heard_in(self):
        texts = [
            "у Транскриптора новая версия",
            "открыл Транскриптор вчера",
            "сегодня Deepgram снова",
            "вечером Deepgram опять",
            "утром Deepgram работает",
        ]
        found = _ranked(texts, builtin=BUILTIN_TERMS)
        self.assertEqual([t.term for t in found], [*BUILTIN_TERMS, "Deepgram"])
        heard = {t.term: t.recordings for t in found}
        self.assertEqual(heard["Транскриптор"], 2)
        self.assertEqual(heard["Transcriptor"], 0)
        self.assertEqual(BUILTIN_TERMS, ("Transcriptor", "Транскриптор"))

    def test_a_mined_form_of_the_built_in_name_is_not_listed_twice(self):
        texts = [f"снова Транскриптора нет, Транскриптором доволен {i}" for i in range(4)]
        found = [t.term for t in _ranked(texts, builtin=BUILTIN_TERMS)]
        self.assertEqual([t for t in found if t.lower().startswith("транскриптор")], ["Транскриптор"])

    def test_the_list_is_bounded_and_ranked_by_recordings(self):
        texts = []
        for i in range(10):
            names = ", ".join(f"Name{j}x" for j in range(i + 1))
            texts.append(f"тут {names} есть")
        found = _ranked(texts, max_terms=3)
        self.assertEqual(len(found), 3)
        self.assertEqual(found[0].term, "Name0x")
        self.assertGreaterEqual(found[0].recordings, found[-1].recordings)


class FrequentEnglishTests(unittest.TestCase):
    def test_everyday_words_and_their_inflections(self):
        for word in ("code", "Model", "models", "coding", "fixed", "studies", "pop-up", "follow-up"):
            self.assertTrue(is_frequent_english(word), word)

    def test_jargon_and_names_are_not_everyday(self):
        for word in ("worktree", "handoff", "Telegram", "Opus", "Ultra", "M-Code", "pop-upz"):
            self.assertFalse(is_frequent_english(word), word)


class _Corpus:
    def __init__(self) -> None:
        self.files: dict[str, tuple[str, float, Optional[str]]] = {}
        self.reads: list[str] = []

    def put(self, key: str, text: Optional[str], mtime: float) -> None:
        self.files[key] = (key, mtime, text)

    def entries(self):
        out = []
        for key, (_k, mtime, text) in self.files.items():
            def read(key=key, text=text):
                self.reads.append(key)
                return text

            out.append(CorpusEntry(key=key, identity=(mtime, len(text or "")), mtime=mtime, read=read))
        return out


NAMED = "сегодня Deepgram снова работает"


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self._tmp.name) / "auto_keyterms.json"
        self.corpus = _Corpus()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _store(self, **kwargs) -> AutoKeytermStore:
        # The mining is what these pin; the built-in name has its own test.
        kwargs.setdefault("builtin_terms", ())
        return AutoKeytermStore(corpus=self.corpus.entries, cache_path=self.cache, **kwargs)

    def test_the_built_in_name_is_there_before_the_first_recompute_and_after(self):
        store = AutoKeytermStore(corpus=self.corpus.entries, cache_path=self.cache)
        self.assertEqual(store.terms(), BUILTIN_TERMS)
        for i in range(3):
            self.corpus.put(f"r{i}", NAMED, float(i))
        store.recompute()
        self.assertEqual(store.terms(), (*BUILTIN_TERMS, "Deepgram"))

    def test_a_recompute_reads_only_new_or_changed_transcripts(self):
        for i in range(3):
            self.corpus.put(f"r{i}", NAMED, float(i))
        store = self._store()
        store.recompute()
        self.assertEqual(sorted(self.corpus.reads), ["r0", "r1", "r2"])
        self.assertEqual(store.terms(), ("Deepgram",))
        self.corpus.reads.clear()
        self.corpus.put("r3", NAMED + " и ещё", 3.0)
        store.recompute()
        self.assertEqual(self.corpus.reads, ["r3"])

    def test_only_the_newest_transcripts_count(self):
        for i in range(3):
            self.corpus.put(f"old{i}", NAMED, float(i))
        for i in range(3):
            self.corpus.put(f"new{i}", "обычные слова без имён", 100.0 + i)
        store = self._store(max_recordings=3)
        store.recompute()
        self.assertEqual(store.terms(), ())
        self.assertEqual(store.snapshot().recordings, 3)

    def test_a_transcript_the_caller_excludes_is_not_counted(self):
        for i in range(2):
            self.corpus.put(f"r{i}", NAMED, float(i))
        self.corpus.put("upload", None, 5.0)
        store = self._store()
        store.recompute()
        self.assertEqual(store.terms(), ())
        self.assertEqual(store.snapshot().recordings, 2)

    def test_the_ranking_survives_a_restart(self):
        for i in range(3):
            self.corpus.put(f"r{i}", NAMED, float(i))
        self._store().recompute()
        stored = json.loads(self.cache.read_text(encoding="utf-8"))
        self.assertEqual([row["term"] for row in stored["terms"]], ["Deepgram"])
        fresh = self._store()
        self.assertEqual(fresh.terms(), ())
        fresh.load_cached()
        self.assertEqual(fresh.terms(), ("Deepgram",))
        self.assertEqual(fresh.snapshot().recordings, 3)

    def test_a_corrupt_cache_is_ignored(self):
        self.cache.write_text("{not json", encoding="utf-8")
        store = self._store()
        with self.assertLogs("backend.auto_keyterms", level="WARNING"):
            store.load_cached()
        self.assertEqual(store.terms(), ())

    def test_one_line_is_logged_per_recompute_without_the_list(self):
        for i in range(3):
            self.corpus.put(f"r{i}", NAMED, float(i))
        with self.assertLogs("backend.auto_keyterms", level="INFO") as logs:
            self._store().recompute()
        self.assertEqual(len(logs.output), 1)
        self.assertIn("1 term(s)", logs.output[0])
        self.assertIn("token(s)", logs.output[0])
        self.assertNotIn("Deepgram", logs.output[0])

    def test_the_recompute_line_reaches_main_log(self):
        # backend.main hangs the stderr → main.log handler on "backend";
        # a logger outside that tree is never written anywhere.
        for i in range(3):
            self.corpus.put(f"r{i}", NAMED, float(i))
        with self.assertLogs("backend", level="INFO") as logs:
            self._store().recompute()
        self.assertTrue(any("auto-keyterms:" in line for line in logs.output), logs.output)


class SchedulingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.corpus = _Corpus()
        for i in range(3):
            self.corpus.put(f"r{i}", NAMED, float(i))
        self.refreshes = 0
        self.enabled = True

    async def _on_refresh(self) -> None:
        self.refreshes += 1

    def _store(self) -> AutoKeytermStore:
        return AutoKeytermStore(
            corpus=self.corpus.entries,
            cache_path=None,
            builtin_terms=(),
            is_enabled=lambda: self.enabled,
            recompute_debounce_sec=0.05,
            refresh_debounce_sec=0.01,
        )

    async def _settle(self, store: AutoKeytermStore, seconds: float = 0.2) -> None:
        await asyncio.sleep(seconds)
        if store._task is not None:
            await store._task

    async def test_nothing_is_scheduled_before_start(self):
        store = self._store()
        store.schedule_recompute()
        store.schedule_refresh()
        await asyncio.sleep(0.1)
        self.assertEqual(self.corpus.reads, [])

    async def test_a_burst_of_saves_is_one_recompute_then_a_refresh(self):
        store = self._store()
        store.start(self._on_refresh, boot_delay_sec=10.0)
        for _ in range(5):
            store.schedule_recompute()
        await self._settle(store)
        self.assertEqual(sorted(self.corpus.reads), ["r0", "r1", "r2"])
        self.assertEqual(self.refreshes, 1)
        self.assertEqual(store.terms(), ("Deepgram",))
        await store.stop()

    async def test_switched_off_it_does_not_read_the_archive_but_still_refreshes(self):
        self.enabled = False
        store = self._store()
        store.start(self._on_refresh, boot_delay_sec=0.0)
        await self._settle(store)
        self.assertEqual(self.corpus.reads, [])
        self.assertEqual(self.refreshes, 1)
        await store.stop()

    async def test_a_settings_refresh_does_not_wait_for_a_pending_recompute(self):
        store = self._store()
        store.start(self._on_refresh, boot_delay_sec=10.0)
        store.schedule_refresh()
        await self._settle(store, 0.03)
        self.assertEqual(self.refreshes, 1)
        self.assertEqual(self.corpus.reads, [], "a refresh alone reads nothing")
        await store.stop()

    async def test_the_boot_recompute_waits_for_start_up_work(self):
        # The History list's first build reads the same archive; the boot
        # recompute racing it for the GIL is what pushed the list past the
        # renderer's bootstrap timeout.
        gate = asyncio.get_running_loop().create_future()
        store = self._store()
        store.start(self._on_refresh, boot_delay_sec=0.0, boot_after=gate)
        await asyncio.sleep(0.1)
        self.assertEqual(self.corpus.reads, [], "nothing read while start-up work runs")
        gate.set_result(None)
        await self._settle(store, 0.05)
        self.assertEqual(sorted(self.corpus.reads), ["r0", "r1", "r2"])
        self.assertEqual(self.refreshes, 1)
        await store.stop()

    async def test_failed_start_up_work_still_arms_the_boot_recompute(self):
        gate = asyncio.get_running_loop().create_future()
        store = self._store()
        store.start(self._on_refresh, boot_delay_sec=0.0, boot_after=gate)
        with self.assertLogs("backend.auto_keyterms", level="WARNING"):
            gate.set_exception(OSError("disk"))
            await self._settle(store, 0.05)
        self.assertEqual(sorted(self.corpus.reads), ["r0", "r1", "r2"])
        await store.stop()

    async def test_a_save_during_start_up_is_not_held_by_the_gate(self):
        gate = asyncio.get_running_loop().create_future()
        store = self._store()
        store.start(self._on_refresh, boot_delay_sec=0.0, boot_after=gate)
        store.schedule_recompute()
        await self._settle(store)
        self.assertEqual(sorted(self.corpus.reads), ["r0", "r1", "r2"])
        gate.set_result(None)
        await store.stop()

    async def test_stop_during_start_up_leaves_the_start_up_work_alone(self):
        gate = asyncio.get_running_loop().create_future()
        store = self._store()
        store.start(self._on_refresh, boot_delay_sec=0.0, boot_after=gate)
        await asyncio.sleep(0.01)
        await store.stop()
        self.assertFalse(gate.cancelled(), "stopping the store cancelled the caller's work")
        gate.set_result(None)
        await asyncio.sleep(0.05)
        self.assertEqual(self.corpus.reads, [])
        self.assertEqual(self.refreshes, 0)

    async def test_stop_cancels_what_is_pending(self):
        store = self._store()
        store.start(self._on_refresh, boot_delay_sec=0.05)
        await store.stop()
        await asyncio.sleep(0.1)
        self.assertEqual(self.corpus.reads, [])
        self.assertEqual(self.refreshes, 0)


if __name__ == "__main__":
    unittest.main()
