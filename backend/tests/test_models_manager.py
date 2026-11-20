"""Settings→Models backend: presence detection, downloads, gating."""

from __future__ import annotations

import sys
import time
import unittest
from unittest import mock

from backend import models_manager
from backend.model_catalog import (
    DEFAULT_LIVE_PREVIEW_LOCAL_MODEL,
    GIGAAM_MODELS,
    LOCAL_LIVE_PREVIEW_MODELS,
    WHISPER_LOCAL_MODELS,
)


class CatalogCoverageTests(unittest.TestCase):
    """The manager's universe of models must equal the catalog's.

    They were two hand-written lists. After the catalog was cut to three
    Whisper sizes, `tiny` and `base` still had repos in the manager — so
    a model the UI could not offer was still downloadable through the
    API, and nothing said the two disagreed.
    """

    def test_every_catalog_whisper_model_has_a_repo(self):
        for model_id in WHISPER_LOCAL_MODELS:
            self.assertIn(model_id, models_manager.WHISPER_REPOS)

    def test_no_repo_exists_outside_the_catalog(self):
        self.assertEqual(
            set(models_manager.WHISPER_REPOS),
            set(WHISPER_LOCAL_MODELS),
            "a repo for a model the catalog does not offer is reachable by API only",
        )

    def test_every_catalog_model_has_a_size_hint(self):
        for model_id in (*WHISPER_LOCAL_MODELS, *GIGAAM_MODELS):
            self.assertIn(
                model_id,
                models_manager.SIZE_HINTS,
                f"{model_id} would render with no size in Settings",
            )

    def test_no_size_hint_survives_a_model_the_catalog_dropped(self):
        self.assertEqual(
            set(models_manager.SIZE_HINTS),
            {*WHISPER_LOCAL_MODELS, *GIGAAM_MODELS},
        )

    def test_whisper_models_are_ordered_cheapest_first(self):
        """The order is load-bearing, not cosmetic.

        ``LOCAL_LIVE_PREVIEW_MODELS`` is the first entry — the cap on what
        may decode continuously beside a remote provider. A reorder would
        silently promote a heavier model into that role, so the order is
        held against the size hints rather than trusted.
        """
        sizes = [models_manager.SIZE_HINTS[m] for m in WHISPER_LOCAL_MODELS]
        self.assertEqual(sizes, sorted(sizes), "catalog order must be cheapest first")

    def test_the_live_preview_cap_is_the_cheapest_model_shipped(self):
        self.assertEqual(LOCAL_LIVE_PREVIEW_MODELS, (WHISPER_LOCAL_MODELS[0],))
        self.assertEqual(DEFAULT_LIVE_PREVIEW_LOCAL_MODEL, WHISPER_LOCAL_MODELS[0])

    def test_a_retired_model_cannot_be_downloaded(self):
        with self.assertRaises(KeyError):
            models_manager.start_download("tiny")


class ModelsManagerTests(unittest.TestCase):
    def tearDown(self):
        with models_manager._lock:
            models_manager._state.clear()

    def test_whisper_presence_via_hf_cache(self):
        with mock.patch(
            "huggingface_hub.try_to_load_from_cache", return_value="/cache/model.bin"
        ):
            self.assertTrue(models_manager.whisper_downloaded("small"))
        with mock.patch(
            "huggingface_hub.try_to_load_from_cache",
            side_effect=Exception("no cache dir"),
        ):
            self.assertFalse(models_manager.whisper_downloaded("small"))

    def test_list_rows_shape_and_gigaam_engine_note(self):
        with (
            mock.patch("huggingface_hub.try_to_load_from_cache", return_value=None),
            mock.patch("backend.model_catalog.gigaam_available", return_value=False),
        ):
            rows = models_manager.list_local_models()
        by_id = {r["id"]: r for r in rows}
        self.assertIn("small", by_id)
        self.assertFalse(by_id["small"]["downloaded"])
        # Read the id from the catalog: hardcoding one pinned this test
        # to a variant the catalog later stopped offering.
        gigaam_id = GIGAAM_MODELS[0]
        self.assertEqual(by_id[gigaam_id]["engine"], "gigaam")
        self.assertIn("engine not installed", by_id[gigaam_id]["note"])

    def test_start_download_unknown_id_raises(self):
        with self.assertRaises(KeyError):
            models_manager.start_download("nonexistent-model")

    def test_start_download_gigaam_without_engine_is_409_style(self):
        with mock.patch("backend.model_catalog.gigaam_available", return_value=False):
            with self.assertRaises(RuntimeError):
                models_manager.start_download(GIGAAM_MODELS[0])

    def test_start_download_runs_worker_to_done(self):
        # One model id for the whole test, taken from the catalog: the
        # three hardcoded copies of "tiny" disagreed with each other the
        # moment the catalog stopped offering it.
        model_id = WHISPER_LOCAL_MODELS[0]
        files = ["model.bin", "config.json"]
        dl_calls: list[str] = []

        def fake_list_repo_files(repo):
            assert repo == models_manager.WHISPER_REPOS[model_id]
            return files

        def fake_hf_download(repo_id, filename):
            dl_calls.append(filename)
            return f"/cache/{filename}"

        with (
            mock.patch("huggingface_hub.try_to_load_from_cache", return_value=None),
            mock.patch("huggingface_hub.list_repo_files", side_effect=fake_list_repo_files),
            mock.patch("huggingface_hub.hf_hub_download", side_effect=fake_hf_download),
        ):
            state = models_manager.start_download(model_id)
            # Mocked downloads can outrun the return; both are valid.
            self.assertIn(state["status"], ("downloading", "done"))
            deadline = time.time() + 5
            while time.time() < deadline:
                if models_manager._get_state(model_id)["status"] == "done":
                    break
                time.sleep(0.02)
            final = models_manager._get_state(model_id)
        self.assertEqual(final["status"], "done")
        self.assertEqual(final["progress"], 100.0)
        self.assertEqual(sorted(dl_calls), sorted(files))

    def test_a_missing_hub_package_ends_in_error_not_a_stuck_download(self):
        # BM-23: the import sat outside the worker's try; an ImportError
        # killed the thread with the state still "downloading" — the model
        # neither downloadable nor deletable until a restart.
        model_id = WHISPER_LOCAL_MODELS[0]
        models_manager._set_state(model_id, status="downloading", progress=0.0)
        with mock.patch.dict(sys.modules, {"huggingface_hub": None}):
            models_manager._download_worker(model_id)
        final = models_manager._get_state(model_id)
        self.assertEqual(final["status"], "error")
        self.assertIn("huggingface_hub", final["error"])

    def test_already_downloaded_short_circuits_without_thread(self):
        with mock.patch(
            "backend.models_manager.whisper_downloaded", return_value=True
        ) as probe:
            state = models_manager.start_download("medium")
            self.assertEqual(state["status"], "done")
            probe.assert_called_once_with("medium")


if __name__ == "__main__":
    unittest.main()
