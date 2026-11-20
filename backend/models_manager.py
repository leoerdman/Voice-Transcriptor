"""Local model download management (Settings → Models).

SSOT for "is this local ASR model present on this machine":

* faster-whisper variants live in the Hugging Face cache; presence is
  detected via ``huggingface_hub`` (already a transitive dependency of
  faster-whisper, so no new package);
* GigaAM weights are managed inside its own package cache — from the
  app's perspective the whole ENGINE is the unit, so a GigaAM entry is
  "downloaded" exactly when the engine imports.

Downloads run on a daemon thread with per-file progress; state is kept
in-process (a restart forgets transient progress but presence detection
above is authoritative anyway).
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional

from backend.model_catalog import GIGAAM_MODEL_PREFIX, WHISPER_LOCAL_MODELS

logger = logging.getLogger(__name__)

# Upstream homes for the catalog's whisper ids.
#
# DERIVED, not listed. This was a hand-written table beside the catalog's
# own list, so the two could disagree about which models exist — and did:
# after the catalog was cut to three sizes, ``tiny`` and ``base`` still
# had repos here, which left them downloadable through the API while the
# UI could not offer them. Every Systran repo follows one naming rule, so
# the rule is the mapping and the catalog stays the only list.
#
# A future model that breaks the convention goes in ``_REPO_OVERRIDES``;
# a model missing from the catalog cannot be reached at all.
_REPO_OVERRIDES: Dict[str, str] = {}


def _whisper_repo(model_id: str) -> str:
    return _REPO_OVERRIDES.get(model_id, f"Systran/faster-whisper-{model_id}")


WHISPER_REPOS: Dict[str, str] = {
    model_id: _whisper_repo(model_id) for model_id in WHISPER_LOCAL_MODELS
}

# Approximate on-disk sizes for the UI (bytes). Hints only — never used
# for decisions. Keyed by catalog id; ``test_models_manager`` asserts the
# catalog is covered, so a new model cannot ship without one.
SIZE_HINTS: Dict[str, int] = {
    "small": 484_000_000,
    "medium": 1_500_000_000,
    "large-v3": 3_100_000_000,
    "gigaam-v3-e2e-rnnt": 950_000_000,
}

_lock = threading.Lock()
_state: Dict[str, Dict[str, Any]] = {}


def _get_state(model_id: str) -> Dict[str, Any]:
    with _lock:
        return dict(_state.get(model_id) or {"status": "idle", "progress": 0.0})


def _set_state(model_id: str, **fields: Any) -> None:
    with _lock:
        entry = dict(_state.get(model_id) or {"status": "idle", "progress": 0.0})
        entry.update(fields)
        _state[model_id] = entry


def whisper_downloaded(model_id: str) -> bool:
    """Authoritative check: does the HF cache hold this repo's payload?

    ``try_to_load_from_cache`` resolves the actual blob for model.bin —
    the one large file every faster-whisper repo ships. A partial
    download therefore reports as not-downloaded, which is the safe
    direction (the selector would offer a re-download instead of
    failing at record time).
    """
    repo = WHISPER_REPOS.get(model_id)
    if not repo:
        return False
    try:
        from huggingface_hub import try_to_load_from_cache
    except ImportError as e:
        # Told apart from "not in the cache", and told LOUDLY. Two unused
        # exception imports used to sit in this try block; if a future
        # huggingface_hub moved any imported symbol, the ImportError was
        # swallowed into "not downloaded" for EVERY whisper model at once
        # and the UI offered to re-download gigabytes already on disk,
        # leaving only a logger.debug behind.
        logger.warning(
            "whisper presence check unavailable (huggingface_hub import "
            "failed: %s); reporting models as not downloaded", e,
        )
        return False
    try:
        result = try_to_load_from_cache(repo_id=repo, filename="model.bin")
        return isinstance(result, str)
    except Exception as e:  # cache dir unreadable etc. — treat as absent
        logger.debug("whisper presence check failed for %s: %s", model_id, e)
        return False


def list_local_models() -> list[dict[str, Any]]:
    from backend.model_catalog import (
        LOCAL_TRANSCRIPTION_MODELS,
        gigaam_available,
    )

    engine_ok_gigaam = gigaam_available()
    rows: list[dict[str, Any]] = []
    for model_id in LOCAL_TRANSCRIPTION_MODELS:
        if model_id.startswith(GIGAAM_MODEL_PREFIX):
            engine = "gigaam"
            downloaded = engine_ok_gigaam
            note = "" if engine_ok_gigaam else "engine not installed"
        else:
            engine = "whisper"
            downloaded = whisper_downloaded(model_id)
            note = ""
        st = _get_state(model_id)
        rows.append({
            "id": model_id,
            "engine": engine,
            "size_hint_bytes": SIZE_HINTS.get(model_id),
            "downloaded": bool(downloaded and st.get("status") != "downloading"),
            "note": note,
            **st,
        })
    return rows


class ModelDeleteError(RuntimeError):
    """Deletion refused for a reason the user can act on."""


def delete_model(model_id: str) -> Dict[str, Any]:
    """Remove a downloaded Whisper model from the Hugging Face cache.

    Deleting weights is the inverse of ``start_download`` and belongs in
    the same module, keyed off the same ``WHISPER_REPOS`` mapping — the
    SSOT for where a catalog id actually lives on disk.

    Refused, with a reason the UI can show verbatim, when:

    * the id is unknown (``KeyError``);
    * the id is a GigaAM model — those are not weights this manager owns
      but a whole Python engine installed by the desktop layer into
      ``userData/engine-site``. Removing it is an engine-lifecycle
      operation, not a cache eviction, and pretending otherwise would
      leave the engine installed while the UI claims it is gone;
    * a download for that id is in flight — deleting the cache under a
      running ``hf_hub_download`` produces a half-written repo that
      ``whisper_downloaded`` would then report as absent while the worker
      keeps writing into it.

    Also evicts the model from the in-process transcription cache. Without
    that, a model deleted from disk keeps serving transcriptions from RAM
    until the backend restarts, while the UI shows it as not downloaded —
    two answers to "is this model available", which is exactly the drift
    this codebase treats as a bug.
    """
    from backend.model_catalog import LOCAL_TRANSCRIPTION_MODELS

    if model_id not in LOCAL_TRANSCRIPTION_MODELS:
        raise KeyError(model_id)
    if model_id.startswith(GIGAAM_MODEL_PREFIX):
        raise ModelDeleteError(
            "GigaAM is an engine, not a downloadable model. Remove it from "
            "Settings → Local models → engine controls."
        )
    if _get_state(model_id).get("status") == "downloading":
        raise ModelDeleteError(
            f"{model_id} is still downloading. Wait for it to finish, then delete."
        )
    repo = WHISPER_REPOS.get(model_id)
    if not repo:
        raise KeyError(model_id)

    freed_bytes = 0
    try:
        from huggingface_hub import scan_cache_dir

        cache = scan_cache_dir()
        revisions = [
            revision.commit_hash
            for cached_repo in cache.repos
            if cached_repo.repo_id == repo
            for revision in cached_repo.revisions
        ]
        if not revisions:
            # Nothing on disk. Report success rather than an error: the
            # user's intent ("this model should not be stored") already
            # holds, and a failure here would be unactionable.
            _set_state(model_id, status="idle", progress=0.0, error=None)
            _evict_from_transcription_cache(model_id)
            return {"deleted": False, "freed_bytes": 0}
        strategy = cache.delete_revisions(*revisions)
        freed_bytes = int(getattr(strategy, "expected_freed_size", 0) or 0)
        strategy.execute()
    except ImportError as e:  # huggingface_hub missing — nothing to scan
        raise ModelDeleteError(f"model cache is unavailable: {e}") from e
    except OSError as e:
        raise ModelDeleteError(f"could not remove {model_id} from disk: {e}") from e

    _set_state(model_id, status="idle", progress=0.0, error=None)
    _evict_from_transcription_cache(model_id)
    logger.info("models: %s deleted (freed ~%d bytes)", model_id, freed_bytes)
    return {"deleted": True, "freed_bytes": freed_bytes}


def _evict_from_transcription_cache(model_id: str) -> None:
    """Drop a deleted model from the resident transcription cache.

    Imports ``backend.transcribe`` lazily and only touches it when the
    module is ALREADY loaded: importing it here would drag faster-whisper
    into a process that may never transcribe locally, undoing the lazy
    import that keeps an API-only session at ~60 MB.
    """
    import sys

    module = sys.modules.get("backend.transcribe")
    if module is None:
        return
    try:
        module.release_model(model_id)
    except Exception:
        logger.exception("models: could not evict %s from the model cache", model_id)


def _repo_file_sizes(repo: str, files: list[str]) -> dict[str, int]:
    """Best-effort byte sizes for *files* in *repo* (BUG-44).

    faster-whisper repos are dominated by one ``model.bin`` (~95 % of the
    bytes); a per-FILE progress counter therefore sits at ~0 % for nearly
    the whole multi-gigabyte transfer and jumps to 100 % at the end,
    which reads as a hang. Weighting by bytes needs the sizes up front:
    one ``HfApi.repo_info(files_metadata=True)`` call provides them.
    Any failure degrades to an empty mapping — the caller falls back to
    the old count-based scheme rather than blocking the download.
    """
    try:
        from huggingface_hub import HfApi

        info = HfApi().repo_info(repo_id=repo, files_metadata=True)
        sizes: dict[str, int] = {}
        for sibling in getattr(info, "siblings", None) or []:
            name = getattr(sibling, "rfilename", None)
            size = getattr(sibling, "size", None)
            if name and isinstance(size, int) and size > 0:
                sizes[name] = size
        return {name: sizes[name] for name in files if name in sizes}
    except Exception as e:  # metadata endpoint down / rate-limited — non-fatal
        logger.debug("models: file-size metadata unavailable for %s: %s", repo, e)
        return {}


def _download_worker(model_id: str) -> None:
    repo = WHISPER_REPOS[model_id]
    try:
        # Inside the try (BM-23): an ImportError outside it killed the
        # thread with the state still "downloading" — the model then
        # neither downloadable nor deletable until a restart.
        from huggingface_hub import hf_hub_download, list_repo_files

        files = [
            f for f in list_repo_files(repo)
            if not f.startswith(".")
        ]
        sizes = _repo_file_sizes(repo, files)
        total_bytes = sum(sizes.values())
        done_bytes = 0
        for i, name in enumerate(files):
            _set_state(
                model_id,
                status="downloading",
                # Byte-weighted when sizes are known; otherwise the
                # legacy per-file fraction. Both stay monotonic.
                progress=(done_bytes / total_bytes * 100.0) if total_bytes
                else (i / max(1, len(files)) * 100.0),
            )
            hf_hub_download(repo_id=repo, filename=name)
            done_bytes += sizes.get(name, 0)
        _set_state(model_id, status="done", progress=100.0)
        logger.info("models: %s downloaded (%d files)", model_id, len(files))
    except Exception as e:
        logger.warning("models: download failed for %s: %s", model_id, e)
        _set_state(model_id, status="error", error=f"{type(e).__name__}: {e}")


def start_download(model_id: str) -> Dict[str, Any]:
    """Kick off a background download; returns the immediate state."""
    from backend.model_catalog import (
        LOCAL_TRANSCRIPTION_MODELS,
        gigaam_available,
    )
    from backend.transcribe_gigaam import gigaam_import_error

    if model_id not in LOCAL_TRANSCRIPTION_MODELS:
        raise KeyError(model_id)

    if model_id.startswith(GIGAAM_MODEL_PREFIX):
        if gigaam_available():
            return {"status": "done", "progress": 100.0}
        reason = gigaam_import_error() or "package not installed"
        raise RuntimeError(
            f"GigaAM engine is not installed in this runtime ({reason}); "
            "install requirements-gigaam.txt and relaunch"
        )

    if whisper_downloaded(model_id):
        _set_state(model_id, status="done", progress=100.0, error=None)
        return _get_state(model_id)

    current = _get_state(model_id)
    if current.get("status") == "downloading":
        return current

    # Check-and-set must be atomic (BUG-63): two concurrent start_download
    # calls (double-click, health poll racing a user action) could both
    # observe "idle" here and each spawn a download worker for the same
    # model — duplicated bandwidth and two writers fighting over the
    # progress state. The claim happens under the same lock the workers
    # use, so a claimed download is visible before we release.
    with _lock:
        current = _state.get(model_id) or {"status": "idle", "progress": 0.0}
        if current.get("status") == "downloading":
            return dict(current)
        entry = dict(current)
        entry.update({"status": "downloading", "progress": 0.0, "error": None})
        _state[model_id] = entry
    thread = threading.Thread(
        target=_download_worker,
        args=(model_id,),
        name=f"model-dl-{model_id}",
        daemon=True,
    )
    try:
        thread.start()
    except Exception as e:
        # The state was claimed above so two callers cannot both start a
        # download. If the worker never runs, nothing will ever release
        # that claim — and ``delete_model`` refuses a model whose status
        # is "downloading", so it becomes neither downloadable nor
        # deletable until the process restarts.
        logger.error("model download thread failed to start for %s: %s", model_id, e)
        with _lock:
            entry = dict(_state.get(model_id) or {})
            entry.update({
                "status": "error",
                "progress": 0.0,
                "error": f"{type(e).__name__}: {e}",
            })
            _state[model_id] = entry
        raise
    return _get_state(model_id)
