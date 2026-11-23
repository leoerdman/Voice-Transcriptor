"""``GET /api/recordings``: rendered off the loop, warmed at boot.

The History list of a large archive is ~10k items. The route used to
return the payload dict, which FastAPI encodes on the event loop on every
request; and the list's first build after a launch was started only by
the window's first request, racing the auto-keyterm boot recompute.
"""

import asyncio
import json
import unittest
from pathlib import Path
from unittest import mock

from backend.tests.test_recording_names import _IsolatedMainCase


class RecordingsListRouteTests(_IsolatedMainCase):
    def _save(self, name: str, text: str) -> None:
        root = self.main._resolve_recordings_dir()
        (Path(root) / name).write_text(text, encoding="utf-8")

    def _get(self):
        return asyncio.run(self.main.list_recordings(None))

    def test_the_route_returns_the_rendered_payload(self):
        self._save("20261122-101010.txt", "Provider: deepgram\nLanguage: ru\n\nПривет мир")
        root = self.main._resolve_recordings_dir()
        expected = self.main._build_recordings_list_payload(root)

        response = self._get()

        self.assertEqual(response.media_type, "application/json")
        self.assertEqual(json.loads(response.body), expected)

    def test_a_cache_hit_neither_rebuilds_nor_re_encodes(self):
        self._save("20261122-101010.txt", "hello")
        first = self._get().body
        with mock.patch.object(
            self.main, "_build_recordings_list_payload", side_effect=AssertionError("rebuilt")
        ), mock.patch.object(
            self.main, "JSONResponse", side_effect=AssertionError("re-encoded")
        ):
            second = self._get().body
        self.assertEqual(first, second)

    def test_a_new_recording_is_listed_after_the_cache_is_dropped(self):
        self._save("20261122-101010.txt", "hello")
        self._get()
        self._save("20261122-111111.txt", "again")
        self.main._invalidate_recordings_cache()
        names = [i["name"] for i in json.loads(self._get().body)["items"]]
        self.assertIn("20261122-111111.txt", names)

    def test_the_boot_warm_up_builds_the_list_before_the_window_asks(self):
        self._save("20261122-101010.txt", "hello")
        asyncio.run(self.main._warm_recordings_list_at_boot())
        with mock.patch.object(
            self.main, "_build_recordings_list_payload", side_effect=AssertionError("rebuilt")
        ):
            items = json.loads(self._get().body)["items"]
        self.assertEqual([i["name"] for i in items], ["20261122-101010.txt"])

    def test_a_failed_boot_warm_up_is_logged_and_the_route_still_builds(self):
        self._save("20261122-101010.txt", "hello")
        with mock.patch.object(
            self.main, "_build_recordings_list_payload", side_effect=OSError("disk")
        ), self.assertLogs("backend.main", level="ERROR"):
            asyncio.run(self.main._warm_recordings_list_at_boot())
        items = json.loads(self._get().body)["items"]
        self.assertEqual(len(items), 1)


if __name__ == "__main__":
    unittest.main()
