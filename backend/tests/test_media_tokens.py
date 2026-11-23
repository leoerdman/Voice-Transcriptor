"""S-15: History streams a recording's audio through a short-lived,
single-file capability instead of fetching the whole file into a Blob.

The capability itself (``backend/media_tokens.py``) and the two routes
that use it: the authenticated mint route and the streaming route that
accepts nothing but a token minted for the file it serves.
"""

from __future__ import annotations

import importlib
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from backend.media_tokens import MEDIA_TOKEN_TTL_SEC, MediaTokens

SECRET = b"k" * 32


class MediaTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 1_000_000.0
        self.tokens = MediaTokens(secret=SECRET, ttl_sec=600, clock=lambda: self.now)

    def test_a_minted_token_opens_its_own_file(self) -> None:
        token, expires_at = self.tokens.mint("/a/rec.webm")
        self.assertEqual(expires_at, 1_000_600)
        self.assertTrue(self.tokens.verify(token, "/a/rec.webm"))

    def test_it_opens_no_other_file(self) -> None:
        token, _ = self.tokens.mint("/a/rec.webm")
        self.assertFalse(self.tokens.verify(token, "/a/other.webm"))
        self.assertFalse(self.tokens.verify(token, "/b/rec.webm"))

    def test_it_expires(self) -> None:
        token, _ = self.tokens.mint("/a/rec.webm")
        self.now += 600
        self.assertTrue(self.tokens.verify(token, "/a/rec.webm"))
        self.now += 1
        self.assertFalse(self.tokens.verify(token, "/a/rec.webm"))

    def test_the_expiry_cannot_be_edited(self) -> None:
        token, expires_at = self.tokens.mint("/a/rec.webm")
        _v, _exp, sig = token.split(".")
        self.assertFalse(self.tokens.verify(f"v1.{expires_at + 60}.{sig}", "/a/rec.webm"))

    def test_another_process_secret_rejects_it(self) -> None:
        token, _ = self.tokens.mint("/a/rec.webm")
        other = MediaTokens(secret=b"z" * 32, ttl_sec=600, clock=lambda: self.now)
        self.assertFalse(other.verify(token, "/a/rec.webm"))

    def test_garbage_is_rejected_without_raising(self) -> None:
        for bad in ("", "v1", "v1..", "v2.1000600.x", "v1.abc.x", "v1.1000600.éé", "v1.1000600"):
            with self.subTest(token=bad):
                self.assertFalse(self.tokens.verify(bad, "/a/rec.webm"))

    def test_a_token_claiming_more_lifetime_than_granted_is_rejected(self) -> None:
        # Signed by the same secret but for an expiry this process never grants.
        long_lived = MediaTokens(secret=SECRET, ttl_sec=10 * 600, clock=lambda: self.now)
        token, _ = long_lived.mint("/a/rec.webm")
        self.assertFalse(self.tokens.verify(token, "/a/rec.webm"))

    def test_a_short_secret_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            MediaTokens(secret=b"short")

    def test_the_default_lifetime_is_minutes(self) -> None:
        self.assertGreater(MEDIA_TOKEN_TTL_SEC, 60)
        self.assertLessEqual(MEDIA_TOKEN_TTL_SEC, 30 * 60)


def _fresh_main_module(data_dir: str):
    os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for name in ("backend.main", "backend.config"):
        sys.modules.pop(name, None)
    return importlib.import_module("backend.main")


class StreamRouteTests(unittest.TestCase):
    NAME = "2026-11-20_10-00-00__Interview.txt"
    AUDIO = bytes(range(256)) * 64  # 16 KiB

    def setUp(self) -> None:
        self._old = {k: os.environ.get(k) for k in ("HOME", "TRANSCRIPTOR_DATA_DIR")}
        self._home = tempfile.TemporaryDirectory()
        os.environ["HOME"] = self._home.name
        self._tmp = tempfile.TemporaryDirectory(dir=self._home.name)
        self.main = _fresh_main_module(self._tmp.name)
        from fastapi.testclient import TestClient

        self.client = TestClient(self.main.app, base_url="http://127.0.0.1:8321")
        rec_dir = Path(self.main._resolve_recordings_dir())
        rec_dir.mkdir(parents=True, exist_ok=True)
        (rec_dir / self.NAME).write_text("Title: Interview\n\nhello", encoding="utf-8")
        (rec_dir / self.NAME.replace(".txt", ".webm")).write_bytes(self.AUDIO)
        other = "2026-11-20_11-00-00__Other.txt"
        (rec_dir / other).write_text("Title: Other\n\nx", encoding="utf-8")
        (rec_dir / other.replace(".txt", ".webm")).write_bytes(b"other-audio")
        self.other = other

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

    def _mint(self, name: str | None = None, headers: dict | None = None):
        from urllib.parse import quote

        return self.client.post(
            f"/api/recordings/{quote(name or self.NAME, safe='')}/audio/stream-url",
            json={},
            headers={"x-api-token": self.main.API_TOKEN} if headers is None else headers,
        )

    def test_mint_needs_the_api_token(self) -> None:
        self.assertEqual(self._mint(headers={}).status_code, 401)

    def test_the_cli_token_cannot_mint(self) -> None:
        self.main.CLI_ACCESS.token_matches = lambda provided: provided == "cli-token"  # type: ignore[method-assign]
        self.assertEqual(self._mint(headers={"x-api-token": "cli-token"}).status_code, 403)

    def test_mint_reports_a_recording_without_audio_as_404(self) -> None:
        self.assertEqual(self._mint(name="2026-01-01_00-00-00__Nope.txt").status_code, 404)

    def test_the_minted_url_streams_the_file_with_range_support(self) -> None:
        r = self._mint()
        self.assertEqual(r.status_code, 200, r.text)
        url = r.json()["url"]
        self.assertIn("media_token=", url)
        self.assertGreater(r.json()["expires_at"], 0)
        full = self.client.get(url)
        self.assertEqual(full.status_code, 200)
        self.assertEqual(full.content, self.AUDIO)
        self.assertEqual(full.headers.get("cache-control"), "no-store")
        self.assertTrue(full.headers.get("content-disposition", "").startswith("inline"))
        part = self.client.get(url, headers={"Range": "bytes=100-199"})
        self.assertEqual(part.status_code, 206)
        self.assertEqual(part.content, self.AUDIO[100:200])

    def test_the_authenticated_audio_route_is_never_cached(self) -> None:
        # Every /api response defaults to no-store: the window's HTTP cache
        # had kept a copy of every recording played (746 MB, 2026-11-23).
        r = self.client.get(
            f"/api/recordings/{self.NAME}/audio",
            headers={"x-api-token": self.main.API_TOKEN},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers.get("cache-control"), "no-store")

    def test_the_stream_route_needs_a_token_and_ignores_the_api_token(self) -> None:
        base = f"/api/recordings/{self.NAME}/audio/stream"
        self.assertEqual(self.client.get(base).status_code, 401)
        self.assertEqual(self.client.get(base, headers={"x-api-token": self.main.API_TOKEN}).status_code, 401)
        self.assertEqual(self.client.get(f"{base}?media_token={self.main.API_TOKEN}").status_code, 401)

    def test_a_token_for_one_recording_opens_no_other(self) -> None:
        token = parse_qs(urlparse(self._mint().json()["url"]).query)["media_token"][0]
        r = self.client.get(f"/api/recordings/{self.other}/audio/stream", params={"media_token": token})
        self.assertEqual(r.status_code, 401)

    def test_a_token_opens_no_other_route(self) -> None:
        token = parse_qs(urlparse(self._mint().json()["url"]).query)["media_token"][0]
        for path in (f"/api/recordings/{self.NAME}/audio", f"/api/recordings/{self.NAME}", "/api/config"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, headers={"x-api-token": token}).status_code, 401)
                self.assertEqual(self.client.get(path, params={"media_token": token}).status_code, 401)

    def test_a_missing_file_with_a_token_is_401_not_a_probe(self) -> None:
        url = self._mint().json()["url"]
        rec_dir = Path(self.main._resolve_recordings_dir())
        (rec_dir / self.NAME.replace(".txt", ".webm")).unlink()
        self.assertEqual(self.client.get(url).status_code, 401)

    def test_the_access_log_never_shows_the_token(self) -> None:
        url = self._mint().json()["url"]
        record = logging.LogRecord(
            name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=1,
            msg='%s - "%s %s HTTP/%s" %d', args=("127.0.0.1:1", "GET", url, "1.1", 206), exc_info=None,
        )
        self.main._MutedPollingAccessFilter().filter(record)
        line = record.getMessage()
        self.assertNotIn("media_token", line)
        self.assertNotIn("Interview", line)


if __name__ == "__main__":
    unittest.main()
