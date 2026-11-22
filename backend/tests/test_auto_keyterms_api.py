"""The self-filling vocabulary as the app wires it (``backend.main``):
which transcripts feed it, the Settings endpoints, and that every
Deepgram entry point and the warm pool read the merged list."""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.auto_keyterms import BUILTIN_TERMS

#: The app's own name heads every list (``backend.auto_keyterms``).
BUILTIN = tuple(BUILTIN_TERMS)


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


def _transcript(text: str, *, source_file: str = "") -> str:
    header = "Title: t\nSaved at: 2026-11-23 10:00:00\nLanguage: ru\nProvider: deepgram\nModel: nova-3\n"
    if source_file:
        header += f"Source file: {source_file}\n"
    return f"{header}\nOriginal:\nсырой текст\n\nTranscription:\n{text}\n"


class _MainCase(unittest.TestCase):
    def setUp(self) -> None:
        self._old = {k: os.environ.get(k) for k in ("HOME", "TRANSCRIPTOR_DATA_DIR")}
        self._home = tempfile.TemporaryDirectory()
        os.environ["HOME"] = self._home.name
        self._tmp = tempfile.TemporaryDirectory(dir=self._home.name)
        self.main = _fresh_main_module(self._tmp.name)
        self.root = self.main._resolve_recordings_dir()

    def tearDown(self) -> None:
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        for key, old in self._old.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)
        self._tmp.cleanup()
        self._home.cleanup()

    def _write(self, folder: str, name: str, content: str) -> Path:
        d = self.root / folder if folder else self.root
        d.mkdir(parents=True, exist_ok=True)
        path = d / name
        path.write_text(content, encoding="utf-8")
        return path

    def _client(self):
        from fastapi.testclient import TestClient

        return TestClient(self.main.app, base_url="http://127.0.0.1:8321")

    def _headers(self) -> dict:
        return {"x-api-token": self.main.API_TOKEN}


class CorpusTests(_MainCase):
    def test_dictations_count_and_imported_media_does_not(self):
        for i in range(3):
            self._write("Live Capsule", f"d{i}.txt", _transcript("сегодня Deepgram снова"))
        for i in range(3):
            self._write("Uploaded Media", f"u{i}.txt", _transcript("эфир про Infinity тут"))
            self._write("", f"legacy{i}.txt", _transcript("эфир про Infinity тут", source_file="a.mp4"))
        self.main.AUTO_KEYTERMS.recompute()
        self.assertEqual(self.main.AUTO_KEYTERMS.terms(), BUILTIN + ("Deepgram",))
        self.assertEqual(self.main.AUTO_KEYTERMS.snapshot().recordings, 3)

    def test_the_corrected_transcript_is_read_not_the_raw_live_text(self):
        for i in range(3):
            self._write(
                "Live Capsule",
                f"d{i}.txt",
                "Title: t\nSaved at: x\nLanguage: ru\nProvider: deepgram\nModel: nova-3\n\n"
                "Original:\nоткрыл Дипграм вчера\n\nTranscription:\nоткрыл Deepgram вчера\n",
            )
        self.main.AUTO_KEYTERMS.recompute()
        self.assertEqual(self.main.AUTO_KEYTERMS.terms(), BUILTIN + ("Deepgram",))

    def test_any_change_to_the_archive_schedules_a_recompute(self):
        with mock.patch.object(self.main.AUTO_KEYTERMS, "schedule_recompute") as spy:
            self.main._invalidate_recordings_cache()
        spy.assert_called_once_with()


class EndpointTests(_MainCase):
    def setUp(self) -> None:
        super().setUp()
        for i in range(3):
            self._write("Live Capsule", f"d{i}.txt", _transcript("сегодня Deepgram и MacBook снова"))
        self.main.AUTO_KEYTERMS.recompute()
        self.main.save_config({"preferences": {"deepgram": {"keyterms": "Sonnet"}}})

    def test_the_state_lists_terms_and_the_budget_they_spend(self):
        r = self._client().get("/api/deepgram/auto-keyterms", headers=self._headers())
        self.assertEqual(r.status_code, 200, r.text)
        state = r.json()
        self.assertTrue(state["enabled"])
        self.assertEqual([t["term"] for t in state["terms"]], [*BUILTIN, "Deepgram", "MacBook"])
        self.assertTrue(all(t["included"] for t in state["terms"]))
        self.assertEqual(state["manualCount"], 1)
        self.assertEqual(state["autoCount"], 4)
        self.assertEqual(state["tokenBudget"], 500)
        self.assertEqual(state["tokensUsed"], 10)
        self.assertEqual(state["recordings"], 3)

    def test_the_endpoints_need_the_api_token(self):
        r = self._client().get("/api/deepgram/auto-keyterms")
        self.assertIn(r.status_code, (401, 403))

    def test_a_removed_term_leaves_the_list_and_the_request(self):
        client = self._client()
        r = client.post("/api/deepgram/auto-keyterms", json={"block": "deepgram"}, headers=self._headers())
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([t["term"] for t in r.json()["terms"]], [*BUILTIN, "MacBook"])
        self.assertEqual(r.json()["blocked"], ["deepgram"])
        cfg = self.main.load_config()
        self.assertEqual(
            self.main.configured_keyterms(cfg, self.main.AUTO_KEYTERMS.terms()),
            ("Sonnet", *BUILTIN, "MacBook"),
        )
        r = client.post("/api/deepgram/auto-keyterms", json={"unblock": "Deepgram"}, headers=self._headers())
        self.assertEqual(r.json()["blocked"], [])
        self.assertEqual(len(r.json()["terms"]), 4)

    def test_the_built_in_name_can_be_removed_like_any_automatic_term(self):
        client = self._client()
        r = client.post("/api/deepgram/auto-keyterms", json={"block": BUILTIN[0]}, headers=self._headers())
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(BUILTIN[0], [t["term"] for t in r.json()["terms"]])
        cfg = self.main.load_config()
        self.assertNotIn(BUILTIN[0], self.main.configured_keyterms(cfg, self.main.AUTO_KEYTERMS.terms()))

    def test_a_pinned_term_is_shown_once_in_the_manual_list(self):
        self.main.save_config({"preferences": {"deepgram": {"keyterms": "Sonnet, Deepgram"}}})
        state = self._client().get("/api/deepgram/auto-keyterms", headers=self._headers()).json()
        self.assertEqual([t["term"] for t in state["terms"]], [*BUILTIN, "MacBook"])

    def test_switching_off_keeps_the_list_visible_but_sends_only_the_manual_list(self):
        r = self._client().post(
            "/api/deepgram/auto-keyterms", json={"enabled": False}, headers=self._headers()
        )
        state = r.json()
        self.assertFalse(state["enabled"])
        self.assertEqual(state["autoCount"], 0)
        self.assertEqual(len(state["terms"]), 4)
        cfg = self.main.load_config()
        self.assertEqual(
            self.main.configured_keyterms(cfg, self.main.AUTO_KEYTERMS.terms()), ("Sonnet",)
        )

    def test_malformed_requests_are_refused(self):
        client = self._client()
        for body in ({}, {"enabled": "yes"}, {"block": ""}, {"block": 3}, {"unblock": "x" * 200}):
            r = client.post("/api/deepgram/auto-keyterms", json=body, headers=self._headers())
            self.assertEqual(r.status_code, 400, body)


class WarmPoolWiringTests(_MainCase):
    def test_a_refresh_retargets_the_warm_pool_at_the_merged_list(self):
        for i in range(3):
            self._write("Live Capsule", f"d{i}.txt", _transcript("сегодня Deepgram снова"))
        self.main.AUTO_KEYTERMS.recompute()
        self.main.save_config({
            "providers": {"deepgram": {"key": "dg-test"}},
            "preferences": {"deepgram": {"keyterms": "Sonnet"}},
        })
        calls = []

        async def fake_retarget(api_key, keyterms):
            calls.append((api_key, keyterms))

        with mock.patch.object(self.main.DEEPGRAM_WARM_POOL, "retarget_keyterms", fake_retarget):
            asyncio.run(self.main._retarget_warm_keyterms())
        self.assertEqual(calls, [("dg-test", ("Sonnet", *BUILTIN, "Deepgram"))])


if __name__ == "__main__":
    unittest.main()
