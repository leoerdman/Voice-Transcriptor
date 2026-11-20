"""The expected-languages script rule (``backend.transcript_scripts``) and
the boundaries every delivered transcript leaves the backend through.

The words below are the ones Deepgram's ``multi`` stream actually wrote
for this user's Russian speech on 2026-11-20 (``که دارم بویت``, ``در``).
"""

import asyncio
import json
import unittest
from pathlib import Path
from unittest import mock

from backend.deepgram_language import DEFAULT_LANGUAGE_HINTS, LANGUAGE_HINT_OPTIONS
from backend.tests.test_live import IsolatedBackendMainImportMixin
from backend.transcript_scripts import (
    LANGUAGE_SCRIPTS,
    SCRIPT_CYRILLIC,
    SCRIPT_DEVANAGARI,
    SCRIPT_HAN,
    SCRIPT_HIRAGANA,
    SCRIPT_KATAKANA,
    SCRIPT_LATIN,
    allowed_scripts,
    is_foreign_word,
    letter_script,
    strip_foreign_script,
    strip_foreign_script_payload,
    transcript_scripts,
)

RU_EN = allowed_scripts(("ru", "en"))
SCREEN_MARKS = (
    "### Скрин 7 · Google Chrome — Студия\n"
    "[✏️3 синий, вверху по центру] вот здесь [/3] и [🖱 клик, вверху по центру]"
)


class ScriptTableTests(unittest.TestCase):
    def test_every_language_the_setting_can_hold_has_scripts_and_no_other(self):
        self.assertEqual(set(LANGUAGE_SCRIPTS), set(LANGUAGE_HINT_OPTIONS))
        known = {SCRIPT_LATIN, SCRIPT_CYRILLIC, SCRIPT_DEVANAGARI, SCRIPT_HAN, SCRIPT_HIRAGANA, SCRIPT_KATAKANA}
        for code, scripts in LANGUAGE_SCRIPTS.items():
            self.assertTrue(scripts, code)
            self.assertLessEqual(set(scripts), known, code)

    def test_the_table_maps_languages_to_their_alphabets(self):
        self.assertEqual(LANGUAGE_SCRIPTS["ru"], {SCRIPT_CYRILLIC})
        for code in ("en", "es", "fr", "de", "pt", "it", "nl"):
            self.assertEqual(LANGUAGE_SCRIPTS[code], {SCRIPT_LATIN}, code)
        self.assertEqual(LANGUAGE_SCRIPTS["ja"], {SCRIPT_HAN, SCRIPT_HIRAGANA, SCRIPT_KATAKANA})
        self.assertEqual(LANGUAGE_SCRIPTS["hi"], {SCRIPT_DEVANAGARI})

    def test_letters_are_identified_by_script(self):
        cases = {
            "a": SCRIPT_LATIN, "é": SCRIPT_LATIN, "ß": SCRIPT_LATIN, "ª": SCRIPT_LATIN, "Ａ": SCRIPT_LATIN,
            "я": SCRIPT_CYRILLIC, "ї": SCRIPT_CYRILLIC, "ё": SCRIPT_CYRILLIC,
            "中": SCRIPT_HAN, "々": SCRIPT_HAN, "あ": SCRIPT_HIRAGANA, "カ": SCRIPT_KATAKANA,
            "ー": SCRIPT_KATAKANA, "ｶ": SCRIPT_KATAKANA, "क": SCRIPT_DEVANAGARI, "ा": SCRIPT_DEVANAGARI,
            "د": "ARABIC", "ک": "ARABIC", "ש": "HEBREW", "α": "GREEK", "ქ": "GEORGIAN",
            "ա": "ARMENIAN", "ก": "THAI", "한": "HANGUL",
        }
        for ch, script in cases.items():
            self.assertEqual(letter_script(ch), script, ch)

    def test_what_every_language_shares_has_no_script(self):
        for ch in "0123456789٣ .,!?…—-«»()[]#/·‍‌️́✏🖱😀ʼ":
            self.assertIsNone(letter_script(ch), repr(ch))


class PolicyTests(unittest.TestCase):
    def test_no_languages_is_unrestricted(self):
        self.assertIsNone(allowed_scripts(()))
        self.assertIsNone(allowed_scripts(("", " ")))

    def test_a_language_the_table_cannot_answer_for_lifts_the_restriction(self):
        self.assertIsNone(allowed_scripts(("ru", "ka")))

    def test_region_suffixes_are_ignored(self):
        self.assertEqual(allowed_scripts(("en-US", "RU")), {SCRIPT_LATIN, SCRIPT_CYRILLIC})

    def test_the_setting_is_the_source(self):
        # Absent preference: the shipped default, ru + en.
        self.assertEqual(DEFAULT_LANGUAGE_HINTS, ("ru", "en"))
        self.assertEqual(transcript_scripts({}), {SCRIPT_CYRILLIC, SCRIPT_LATIN})
        hints = lambda codes: {"preferences": {"deepgram": {"language_hints": codes}}}
        self.assertEqual(transcript_scripts(hints(["ru", "hi"])), {SCRIPT_CYRILLIC, SCRIPT_DEVANAGARI})
        # The user declared no languages: nothing is removed, whatever the request.
        self.assertIsNone(transcript_scripts(hints([])))
        self.assertIsNone(transcript_scripts(hints([]), "ru"))

    def test_the_requested_language_is_always_allowed(self):
        cfg = {"preferences": {"deepgram": {"language_hints": ["ru"]}}}
        self.assertEqual(transcript_scripts(cfg, "auto"), {SCRIPT_CYRILLIC})
        self.assertEqual(transcript_scripts(cfg, None), {SCRIPT_CYRILLIC})
        self.assertEqual(transcript_scripts(cfg, "en"), {SCRIPT_CYRILLIC, SCRIPT_LATIN})
        # A language the table cannot read is never deleted.
        self.assertIsNone(transcript_scripts(cfg, "fa"))


class RuleTests(unittest.TestCase):
    def test_ru_en_drops_the_observed_persian(self):
        self.assertEqual(strip_foreign_script("در", RU_EN), "")
        self.assertEqual(strip_foreign_script("که دارم بویت", RU_EN), "")
        self.assertEqual(
            strip_foreign_script("که دارم بویت только при наведении на эту область.", RU_EN),
            "только при наведении на эту область.",
        )

    def test_ru_en_drops_every_other_foreign_alphabet(self):
        text = "Привет שלום 中文 नमस्ते Ελλάδα ქართული Հայերեն สวัสดี 안녕 мир"
        self.assertEqual(strip_foreign_script(text, RU_EN), "Привет мир")

    def test_ru_en_keeps_latin_cyrillic_digits_emoji_and_marks(self):
        text = "Claude Code 4.5 — это ударе́ние, 100% 😀 ok?"
        self.assertEqual(strip_foreign_script(text, RU_EN), text)
        self.assertEqual(strip_foreign_script(SCREEN_MARKS, RU_EN), SCREEN_MARKS)

    def test_unrestricted_keeps_everything(self):
        text = "که دارم بویت Привет 中文"
        self.assertEqual(strip_foreign_script(text, None), text)
        self.assertEqual(strip_foreign_script(text, allowed_scripts(())), text)

    def test_another_language_set_keeps_its_alphabet(self):
        ru_hi = allowed_scripts(("ru", "hi"))
        self.assertEqual(strip_foreign_script("नमस्ते Привет در", ru_hi), "नमस्ते Привет")
        ja = allowed_scripts(("ja",))
        self.assertEqual(strip_foreign_script("東京へ行きます。カタカナ Hello", ja), "東京へ行きます。カタカナ")

    def test_a_mixed_script_word_is_kept_whole(self):
        self.assertFalse(is_foreign_word("Claudeدر", RU_EN))
        self.assertFalse(is_foreign_word("α-версия", RU_EN))
        self.assertTrue(is_foreign_word("«در»,", RU_EN))
        self.assertFalse(is_foreign_word("—", RU_EN))
        self.assertEqual(strip_foreign_script("α-версия Claudeدر", RU_EN), "α-версия Claudeدر")


class WhitespaceTests(unittest.TestCase):
    def test_no_double_spaces_and_no_space_before_punctuation(self):
        self.assertEqual(strip_foreign_script("Привет در мир", RU_EN), "Привет мир")
        self.assertEqual(strip_foreign_script("мы пошли در.", RU_EN), "мы пошли.")
        self.assertEqual(strip_foreign_script("Привет در, мир", RU_EN), "Привет, мир")
        self.assertEqual(strip_foreign_script("Привет, در, мир", RU_EN), "Привет, мир")
        self.assertEqual(strip_foreign_script("Да, در.", RU_EN), "Да.")
        self.assertEqual(strip_foreign_script("Конец. در, и дальше", RU_EN), "Конец. и дальше")
        self.assertEqual(strip_foreign_script("«Привет در»", RU_EN), "«Привет»")
        self.assertEqual(strip_foreign_script("در, начало", RU_EN), "начало")

    def test_a_removed_line_leaves_no_empty_line(self):
        self.assertEqual(strip_foreign_script("Один\nکه دارم\nДва", RU_EN), "Один\nДва")
        self.assertEqual(strip_foreign_script("Один\n\nکه دارم\n\nДва", RU_EN), "Один\n\nДва")
        self.assertEqual(strip_foreign_script("که دارم\n\nДва", RU_EN), "Два")
        self.assertEqual(strip_foreign_script("Один\n\nکه دارم", RU_EN), "Один")
        self.assertEqual(strip_foreign_script("Один\nدر\n", RU_EN), "Один\n")

    def test_untouched_lines_are_returned_byte_for_byte(self):
        text = "  отступ  и  двойные пробелы\n\n\nтри пустые\nدر конец"
        self.assertEqual(
            strip_foreign_script(text, RU_EN),
            "  отступ  и  двойные пробелы\n\n\nтри пустые\nконец",
        )


class PayloadTests(unittest.TestCase):
    def test_text_segments_and_words_are_filtered_and_emptied_segments_go(self):
        payload = {
            "type": "final",
            "text": "که دارم Должны быть",
            "segments": [
                {"start": 0.0, "end": 1.0, "text": "که دارم", "words": [{"word": "که"}, {"word": "دارم"}]},
                {"start": 1.0, "end": 2.0, "text": "Должны در быть",
                 "words": [{"word": "Должны"}, {"word": "در"}, {"word": "быть"}]},
            ],
            "stats": {"dual": 1},
        }
        out = strip_foreign_script_payload(payload, RU_EN)
        self.assertEqual(out["text"], "Должны быть")
        self.assertEqual(len(out["segments"]), 1)
        self.assertEqual(out["segments"][0]["text"], "Должны быть")
        self.assertEqual([w["word"] for w in out["segments"][0]["words"]], ["Должны", "быть"])
        self.assertEqual(out["stats"], {"dual": 1})
        # The caller's payload is not mutated.
        self.assertEqual(payload["text"], "که دارم Должны быть")
        self.assertEqual(len(payload["segments"]), 2)

    def test_an_interim_keeps_its_place_with_its_text_filtered(self):
        out = strip_foreign_script_payload({"type": "interim", "segment": {"start": 0, "end": 1, "text": "در"}}, RU_EN)
        self.assertEqual(out["segment"]["text"], "")

    def test_unrestricted_returns_the_payload_itself(self):
        payload = {"text": "در"}
        self.assertIs(strip_foreign_script_payload(payload, None), payload)

    def test_non_transcript_frames_pass_through(self):
        frame = {"type": "finalizing", "budgetMs": 3000, "expectsMore": False}
        self.assertEqual(strip_foreign_script_payload(frame, RU_EN), frame)


class _CapturingSocket:
    def __init__(self):
        self.sent: list[dict] = []

    async def send_text(self, text):
        self.sent.append(json.loads(text))


class LiveBoundaryTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    """Every live frame — segments, interim, final — leaves through
    ``_ws_send_json``; the socket's rule is applied there."""

    async def test_every_live_frame_kind_is_filtered_on_a_bound_socket(self):
        ws = _CapturingSocket()
        self.main._bind_live_transcript_scripts(ws, {}, None)
        await self.main._ws_send_json(
            ws, {"type": "segments", "segments": [{"start": 0, "end": 1, "text": "که دارم Привет"}], "is_final": True}
        )
        await self.main._ws_send_json(ws, {"type": "interim", "segment": {"start": 1, "end": 2, "text": "در мир"}})
        await self.main._ws_send_json(
            ws, self.main.live_final_envelope(source="deepgram-live", text="که دارم Привет мир",
                                              segments=[{"start": 0, "end": 1, "text": "که دارم"}]),
        )
        self.assertEqual(ws.sent[0]["segments"][0]["text"], "Привет")
        self.assertEqual(ws.sent[1]["segment"]["text"], "мир")
        self.assertEqual(ws.sent[2]["text"], "Привет мир")
        self.assertEqual(ws.sent[2]["segments"], [])

    async def test_a_socket_bound_with_no_expected_languages_is_unrestricted(self):
        ws = _CapturingSocket()
        self.main._bind_live_transcript_scripts(ws, {"preferences": {"deepgram": {"language_hints": []}}}, None)
        await self.main._ws_send_json(ws, {"type": "interim", "segment": {"text": "در мир"}})
        self.assertEqual(ws.sent[0]["segment"]["text"], "در мир")

    def test_the_live_socket_binds_the_rule_before_the_first_frame(self):
        from fastapi.testclient import TestClient

        async def fake_local_session(*, websocket, model, language, recovery):
            await self.main._ws_send_json(
                websocket, {"type": "segments", "segments": [{"start": 0, "end": 1, "text": "که دارم Привет"}]}
            )

        with mock.patch.object(self.main, "_run_local_live_session", side_effect=fake_local_session):
            client = TestClient(self.main.app)
            with client.websocket_connect(
                "/ws/transcribe?provider=local&language=auto&session_id=boundary-test",
                headers={"x-api-token": self.main.API_TOKEN, "host": "127.0.0.1:8321"},
            ) as ws:
                frame = ws.receive_json()
        self.assertEqual(frame["segments"][0]["text"], "Привет")


class DeliveredResultBoundaryTests(IsolatedBackendMainImportMixin, unittest.TestCase):
    """Uploaded-file transcription (local and remote) and the AI rewrite."""

    def test_the_local_engines_result_is_filtered(self):
        decoded = {"text": "که دارم Привет", "segments": [{"text": "که دارم"}, {"text": "Привет"}]}
        with mock.patch.object(self.main, "_decode_local_once", return_value=decoded):
            result = self.main._run_local_transcribe_once(
                run_id="r", upload_path=Path("x.wav"), model="small", language=None,
                split_stereo=False, word_timestamps=False,
            )
        self.assertEqual(result["text"], "Привет")
        self.assertEqual(result["segments"], [{"text": "Привет"}])

    def test_the_remote_providers_result_is_filtered_and_raw_is_kept(self):
        decoded = {"provider": "deepgram", "text": "در Привет", "raw": {"words": ["در"]}}
        with mock.patch.object(self.main, "_decode_remote_once", return_value=decoded) as decode:
            result = self.main._run_remote_transcribe_once(
                provider_norm="deepgram", upload_path=Path("x.wav"), orig_name="x.wav",
                language="auto", diarize=False, num_speakers="", cfg={"preferences": {}},
            )
        self.assertEqual(result["text"], "Привет")
        self.assertEqual(result["raw"], {"words": ["در"]})
        self.assertEqual(decode.call_args.kwargs["cfg"], {"preferences": {}})

    def test_the_upscale_rewrite_is_filtered(self):
        self.main.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-test-upscale-key-12345678"}},
            "preferences": {},
        })
        with mock.patch.object(self.main, "openrouter_upscale_text", return_value={"text": "Привет در мир."}):
            response = asyncio.run(self.main.upscale_text({"text": "raw"}, _auth=None))
        self.assertEqual(response["text"], "Привет мир.")


class UpscalePresetOutputLanguageTests(IsolatedBackendMainImportMixin, unittest.TestCase):
    """A preset says what it writes in (``output_language``); the rewrite is
    held to the expected languages PLUS that one, so a translation is kept
    and a stray alphabet still goes."""

    def setUp(self):
        super().setUp()
        self.main.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-test-upscale-key-12345678"}},
            "preferences": {"deepgram": {"language_hints": ["ru", "en"]}},
        })

    def _rewrite(self, model_text: str, **request) -> str:
        with mock.patch.object(self.main, "openrouter_upscale_text", return_value={"text": model_text}):
            return asyncio.run(self.main.upscale_text({"text": "raw", **request}, _auth=None))["text"]

    def test_a_preset_that_translates_to_japanese_keeps_its_translation(self):
        created = self.main.create_upscale_preset(
            {"name": "To Japanese", "instruction": "Translate the transcript into Japanese.", "output_language": "ja"},
            _auth=None,
        )["item"]
        self.assertEqual(created["output_language"], "ja")
        out = self._rewrite("こんにちは、世界。 Claude در OK", preset_id=created["id"])
        self.assertEqual(out, "こんにちは、世界。 Claude OK")

    def test_an_ordinary_preset_still_drops_persian_and_japanese(self):
        self.assertEqual(self._rewrite("Привет در мир こんにちは."), "Привет мир.")

    def test_every_built_in_writes_in_the_texts_own_language(self):
        listed = self.main.list_upscale_presets(_auth=None)
        self.assertEqual(listed["output_language_options"], list(self.main.LANGUAGE_HINT_OPTIONS))
        builtins = [x for x in listed["items"] if x["builtin"]]
        self.assertTrue(builtins)
        self.assertTrue(all(x["output_language"] == "" for x in builtins))

    def test_an_output_language_the_app_cannot_name_is_refused(self):
        with self.assertRaises(self.main.HTTPException) as raised:
            self.main.create_upscale_preset(
                {"name": "To Klingon", "instruction": "Translate.", "output_language": "tlh"}, _auth=None,
            )
        self.assertEqual(raised.exception.status_code, 400)

    def test_editing_the_instruction_keeps_the_output_language_unless_it_is_changed(self):
        pid = self.main.create_upscale_preset(
            {"name": "To Japanese", "instruction": "Translate.", "output_language": "ja"}, _auth=None,
        )["item"]["id"]
        kept = self.main.update_upscale_preset(pid, {"instruction": "Translate politely."}, _auth=None)["item"]
        self.assertEqual(kept["output_language"], "ja")
        back = self.main.update_upscale_preset(pid, {"instruction": "Clean up.", "output_language": ""}, _auth=None)["item"]
        self.assertEqual(back["output_language"], "")
        self.assertEqual(self._rewrite("こんにちは Привет", preset_id=pid), "Привет")


if __name__ == "__main__":
    unittest.main()
