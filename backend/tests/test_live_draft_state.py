import importlib
import os
import sys
import tempfile
import unittest


def _reload_backend_main(data_dir: str):
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    for module_name in ("backend.main", "backend.config", "backend.storage"):
        sys.modules.pop(module_name, None)
    return importlib.import_module("backend.main")


class LiveDraftStateTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_data_dir = os.environ.get("TRANSCRIPTOR_DATA_DIR")
        self.main = _reload_backend_main(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()
        if self._old_data_dir is None:
            os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)
        else:
            os.environ["TRANSCRIPTOR_DATA_DIR"] = self._old_data_dir
        for module_name in ("backend.main", "backend.config", "backend.storage"):
            sys.modules.pop(module_name, None)

    def test_live_draft_roundtrip_and_owner_scoped_clear(self):
        saved = self.main.put_live_draft_state(
            {
                "session_id": "session-1",
                "source_text": "draft text",
                "provider": "deepgram",
                "updated_at": "42",
            },
            _auth=None,
        )

        self.assertTrue(saved["ok"])
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["draft"]["session_id"], "session-1")
        self.assertEqual(saved["draft"]["source_text"], "draft text")
        self.assertEqual(saved["draft"]["updated_at"], 42)
        self.assertTrue(self.main.LIVE_DRAFT_STATE_PATH.exists())

        retained = self.main.delete_live_draft_state("different-session", _auth=None)

        self.assertEqual(retained["draft"]["session_id"], "session-1")

        cleared = self.main.delete_live_draft_state("session-1", _auth=None)

        self.assertIsNone(cleared["draft"])
        self.assertIsNone(self.main.get_live_draft_state(_auth=None)["draft"])

    def test_live_draft_rejects_non_object_payload(self):
        with self.assertRaises(self.main.HTTPException) as raised:
            self.main.put_live_draft_state([], _auth=None)  # type: ignore[arg-type]

        self.assertEqual(raised.exception.status_code, 400)

    def test_the_schema_version_survives_the_round_trip(self):
        # FG-04: the renderer discards a draft from a NEWER schema (a
        # downgraded app) — only possible if the number comes back.
        self.main.put_live_draft_state({"schema_version": 99, "source_text": "x"}, _auth=None)
        self.assertEqual(self.main.get_live_draft_state(_auth=None)["draft"]["schema_version"], 99)
        for raw in (None, "2", True, 0, -3, 1.5, float("nan")):
            with self.subTest(raw=raw):
                saved = self.main.put_live_draft_state({"schema_version": raw}, _auth=None)
                self.assertEqual(saved["draft"]["schema_version"], 1)

    def test_an_over_long_draft_keeps_its_newest_text(self):
        # FG-06: a draft grows at its end; the cap used to drop the end.
        limit = self.main.LIVE_DRAFT_MAX_TEXT_CHARS
        text = "old " + "x" * limit + " newest words"
        saved = self.main.put_live_draft_state(
            {"source_text": text, "transcript_text": text}, _auth=None
        )
        for key in ("source_text", "transcript_text"):
            with self.subTest(key=key):
                self.assertEqual(len(saved["draft"][key]), limit)
                self.assertTrue(saved["draft"][key].endswith(" newest words"))


if __name__ == "__main__":
    unittest.main()
