# Fix journal · backend archive lane (Ultra-Audit 2026-11-20)

Lane: `backend/main.py` outside the live-WS block (4560–6030), archive/CLI/config/support modules, their tests.
Branch: `worktree-agent-a9a0782893a7416fd`, cut from main `fb2cef4`.
Suite command (AGENTS.md): `/tmp/vt-tests-archive/bin/python -m unittest discover -s backend/tests` (from the worktree root).
Proof method: SKILL §7.1 — the fixed file is put aside, `git show HEAD:<path>` restores the pre-fix version, the check is run (before), the fixed file is restored byte-for-byte (`diff -q`), the check is run again (after).

## Commits

### C1 · BM-03 (P0) · retention and delete-all touch only recordings the app wrote
- Files: `backend/main.py` (`_APP_RECORDING_HEADER_RE`, `_is_app_recording_text`, `_prune_recording_audio`, `_prune_recording_screens`, `_delete_all_recordings_sync`), `backend/tests/test_audio_retention.py` (new `UserFilesAreNeverOursTests`; fixture `_recording` now writes the app's header via `_render_recording_content`), `backend/tests/test_recording_names.py`, `backend/tests/test_screen_sessions.py` (fixture transcripts gained the `Saved at:` line every app transcript has).
- Check: `python -m unittest backend.tests.test_audio_retention.UserFilesAreNeverOursTests`
- Before (main.py at HEAD):
  ```
  FAIL: test_a_users_pair_does_not_take_a_slot_in_the_count (...)
  AssertionError: 'only-take.webm' not found in {'talk.mp4'}
  FAIL: test_delete_all_leaves_a_users_own_pair_alone (...)
  AssertionError: False is not true : delete-all removed the user's own .txt
  FAIL: test_retention_never_collects_a_users_own_media (...)
  AssertionError: False is not true : the user's own video was deleted by retention
  Ran 3 tests in 0.624s
  FAILED (failures=3)
  ```
- After: `Ran 3 tests ... OK`; full suite `Ran 885 tests ... OK (skipped=2)`.

### C2 · BL-01 (P1), BL-17 (P2, cause removed) · the recovery spool has one owner of its deletion
- Files: `backend/main.py` (`_safe_delete_live_recovery` defers while the handler owns the session, `_mark_live_recovery_discarded`, `LIVE_RECOVERY_STATUS_DISCARDED`, `_live_recovery_discard_pending`, `_unregister_live_session` returns the pending request, new `_end_live_session_ownership` = the handler's `finally` (finalize first, then release, then carry out the deferred delete), `_finalize_live_recovery` writes `status: "discarded"` when a request is pending, `_list_live_recoveries`/`_promote_live_recovery` skip/404 a discarded take, `_recovery_spool_bytes` docstring), `backend/tests/test_live_recovery_liveness.py` (new `SpoolHasOneOwnerTests`).
- Note for the merge: the `ws_transcribe` `finally` (3 lines) now calls `_end_live_session_ownership`; nothing else in the handler changed.
- Check: `python -m unittest backend.tests.test_live_recovery_liveness.SpoolHasOneOwnerTests`
- Before (main.py at HEAD):
  ```
  ERROR: test_a_save_during_the_session_leaves_the_spool_readable (...)
  AssertionError: 0 not greater than 0
  AttributeError: module 'backend.main' has no attribute '_end_live_session_ownership'
  ERROR: test_the_deferred_discard_runs_after_finalize_and_leaves_nothing (...)
  AttributeError: module 'backend.main' has no attribute '_end_live_session_ownership'
  ERROR: test_without_a_request_finalize_keeps_the_recovery (...)
  AttributeError: module 'backend.main' has no attribute '_end_live_session_ownership'
  Ran 4 tests in 1.775s
  FAILED (errors=3)
  ```
  (the behavioural failure is the first: the save emptied the spool the finalize recovery reads.)
- After: `Ran 4 tests ... OK`; full suite `Ran 889 tests ... OK (skipped=2)`.
- BL-17: the "spool not readable at finalize" WARNING was the symptom of this race; with the race gone the line stays at WARNING because it now reports a genuinely abnormal state.

### C3 · H-01 = BM-04 = S-01 (P1, backend side) · a crashed screen take is promoted into Screen Sessions with its screenshots
- Files: `backend/main.py` (`_open_live_recovery` stores a validated `screen_session_id` in the sidecar; `ws_transcribe` passes `qp.get("screen_session_id")` — one kwarg line; new `_adopt_screen_session_for_recording` — the one adoption call for save and promote; new `_recovery_audio_started_at_ms` (spool mtime − spool duration = first sample, available after a crash); `_promote_live_recovery` adopts before retention and returns `screens`; route `promote_live_recovery` defaults the collection to "" so the sidecar decides; `_cleanup_live_recovery_files` passes `keep_ids=_screen_sessions_referenced_by_recoveries()`), `backend/screen_sessions.py` (`sweep_orphan_sessions(keep_ids=…)`, module docstring), `backend/tests/test_screen_sessions.py` (new `CrashedScreenTakeRecoveryTests`).
- Check: `python -m unittest backend.tests.test_screen_sessions.CrashedScreenTakeRecoveryTests`
- Before (main.py + screen_sessions.py at HEAD):
  ```
  ERROR: test_an_invalid_screen_session_id_is_never_stored (...)
  TypeError: _open_live_recovery() got an unexpected keyword argument 'screen_session_id'
  ERROR: test_the_sidecar_names_the_screen_session (...)
  TypeError: _open_live_recovery() got an unexpected keyword argument 'screen_session_id'
  FAIL: test_promotion_files_the_take_under_screen_sessions_with_its_screenshots (...)
  AssertionError: Lists differ: [] != ['shot-01.png', 'shot-02.png']
  FAIL: test_the_orphan_sweep_keeps_a_session_a_pending_recovery_names (...)
  AssertionError: False is not true : staged screenshots of a recoverable take were swept
  Ran 4 tests in 3.131s
  FAILED (failures=2, errors=2)
  ```
  and `test_the_promote_route_without_a_collection_lets_the_sidecar_decide` at HEAD:
  ```
  AssertionError: Posix[52 chars]…/recordings/Live Capsule') != Posix[52 chars]…/recordings/Screen Sessions')
  FAILED (failures=1)
  ```
- After: `Ran 5 tests ... OK`; full suite `Ran 894 tests ... OK (skipped=2)`.
- Cross-domain (renderer): the WS query must carry `screen_session_id` (main.tsx `wsQuery`, ~11474) and the promote call must stop sending `recording_collection: live` (main.tsx ~5126 `recoverBackendAudioSessions`); until the renderer sends the id, the backend path is in place but inert for new takes.

### C4 · BM-05 (P1), BM-06 (P2) · screen adoption is all or nothing and uses the SSOT atomic writer
- Files: `backend/screen_sessions.py` (`adopt_session` assembles `<stem>.screens.tmp-<hex>` beside the destination — rename on one volume, `copytree` across volumes with the staged source removed only after the swap — writes the manifest with `storage.atomic_write_json`, then rename-swaps over the old folder; any failure puts the staging back, removes the work copy, keeps the old screenshots and raises `ScreenAdoptionError`; `_rehome_manifest` drops a non-list `events`; `_write_manifest` (second atomic writer, pid-named tmp invisible to the sweep) deleted; `SCREENS_WORK_DIR_RE`/`is_screens_work_dir`), `backend/main.py` (`_adopt_screen_session_for_recording` returns `(manifest, error)`; save and promote answer `screens_error`; `_sweep_orphan_tmp_files` removes a crashed adoption's work folder), `backend/tests/test_screen_sessions.py` (5 new `AdoptionTests`, new `AdoptionFailureIsReportedTests`).
- Check: `python -m unittest backend.tests.test_screen_sessions`
- Before (both files at HEAD):
  ```
  ERROR: test_the_save_says_screens_error_when_adoption_fails (...)
  AttributeError: <module 'backend.screen_sessions' ...> does not have the attribute 'atomic_write_json'
  ERROR: test_a_cross_volume_copy_failing_part_way_leaves_no_partial_folder (...)
  AttributeError: module 'backend.screen_sessions' has no attribute 'ScreenAdoptionError'
  ERROR: test_a_failed_manifest_write_keeps_the_old_screenshots_and_the_staging (...)
  AttributeError: <module 'backend.screen_sessions' ...> does not have the attribute 'atomic_write_json'
  ERROR: test_malformed_events_do_not_fail_the_adoption (...)
  TypeError: 'int' object is not iterable
  FAIL: test_the_boot_sweep_collects_a_crashed_adoptions_work_folder (...)
  AssertionError: True is not false
  Ran 25 tests in 1.064s
  FAILED (failures=1, errors=4)
  ```
- After: `Ran 25 tests ... OK`; full suite `Ran 901 tests ... OK (skipped=2)`.
- Cross-domain (renderer): `save-with-audio` / promote now answer `screens_error` (string, empty on success). The renderer should show it and must not fall back to staging paths when it is set (main.tsx ~12682 `parseScreenManifest(persisted.screensManifest) || stagedScreenManifest`).

### C5 · BM-02 = S-07 (P1/P2), H-02 = BM-18 (P1) · the CLI token files new recordings only; revoke reports a surviving token file
- Files: `backend/cli_access.py` (`CLI_SAVE_FROM_PATH_FIELDS`, `cli_save_request_refusal`; `disable()` raises when the token file — the switch — survives, after attempting every file; `enable()` rollback logs a failed revoke and re-raises the enable error), `backend/main.py` (`API_CALLER_RENDERER/CLI` on `request.state.api_caller` set by `_require_api_auth`; `save_recording_from_path` answers 403 to a CLI request carrying `name`/`require_existing`/`archive_dir`/`recording_collection`/any other field, before the source is resolved; `disable_cli_access` answers 500 naming the surviving file), tests: `test_cli_access.py` (new `CliSaveScopeTests` through the real app with `TestClient`, `test_disable_reports_a_token_file_it_could_not_remove`; `_FakeRequest` gained `state`), `test_recording_names.py` (the three direct handler calls pass a renderer request), `test_live.py` (its fake request gained `state`).
- Check: `python -m unittest backend.tests.test_cli_access`
- Before (main.py + cli_access.py at HEAD):
  ```
  FAIL: test_disable_reports_a_token_file_it_could_not_remove (...)
  AssertionError: HTTPException not raised
  FAIL: test_the_cli_token_may_not_overwrite_or_redirect_a_save (...) (extra={'name': 'Existing.txt', 'require_existing': True})
  AssertionError: 404 != 403 : {"detail":"source file is no longer available"}
  FAIL: test_the_cli_token_may_not_overwrite_or_redirect_a_save (...) (extra={'archive_dir': '/Users/someone/Music'})
  AssertionError: 404 != 403 : {"detail":"source file is no longer available"}
  FAIL: test_the_cli_token_may_not_overwrite_or_redirect_a_save (...) (extra={'recording_collection': 'live'})
  AssertionError: 404 != 403 : {"detail":"source file is no longer available"}
  Ran 35 tests in 1.482s
  FAILED (failures=4)
  ```
- After: `Ran 35 tests ... OK`; full suite `Ran 905 tests ... OK (skipped=2)`.

### C6 · BL-02 (P1, backend-archive part), BL-15 (P2) · no dictated title in the access log or the archive's log lines; job polls muted
- Files: `backend/main.py` (`_log_safe_recording_name` = `<timestamp>#<sha1[:8]><known suffix>`, `_log_safe_access_path` + `_ACCESS_LOG_FIXED_RECORDING_ROUTES`: the access filter rewrites a recording route's name segment and drops its query (`archive_dir`); `_ACCESS_LOG_POLLED_PATH_RE` mutes 2xx `GET /api/jobs/<id>`; retention / screens-retention / list-skip / delete-all lines use the safe name and `strerror` instead of the path-bearing exception text), `backend/screen_sessions.py` (`_reason(exc)`; adoption lines name the session id, not the destination path), tests: `test_access_log_filter.py` (5 new), `test_audio_retention.py` (`RetentionLogTests`).
- Check: `python -m unittest backend.tests.test_access_log_filter backend.tests.test_audio_retention.RetentionLogTests`
- Before (main.py at HEAD):
  ```
  ERROR: test_a_dotted_title_does_not_leak_as_a_suffix (...)
  ImportError: cannot import name '_log_safe_recording_name' from 'backend.main' (...)
  FAIL: test_a_recordings_title_never_reaches_the_access_log (...)
  AssertionError: 'маме' unexpectedly found in '/api/recordings/2026-11-08_12-20-30-572172__Позвонить%20маме%20про%20анализы.txt/audio?archive_dir=%2FUsers%2Fme%2FSecret'
  FAIL: test_a_successful_job_poll_is_dropped (...)
  AssertionError: True is not false
  FAIL: test_the_removed_line_does_not_carry_the_title (...)
  AssertionError: 'audio retention: removed 2026-11-08_10-00-00-000000#' not found in 'INFO:backend.main:audio retention: removed 2026-11-08_10-00-00-000000__call mum about the tests.webm (beyond newest 1)'
  Ran 16 tests in 0.049s
  FAILED (failures=3, errors=1)
  ```
- After: `Ran 16 tests ... OK`; full suite `Ran 911 tests ... OK (skipped=2)`.
- Cross-domain (BL-02 remainder): engine lines `remote_deepgram_live.py` `_handle_result` (`text=%r`), coverage-hole snippets (`_HOLE_REPORT_TEXT_CHARS`), `deepgram_recovery.py` "decoded word(s) had no room … %s"; desktop `appendMainLog` should create main.log with mode 0600.

### C7 · S-08, BM-17, BM-20 (P2) + BM-01 documented honestly · CLI wrapper, PATH card, token outside argv
- Files: `backend/cli_access.py` (`_wrapper_text`, `_refresh_wrapper` called from `load()` — a wrapper whose interpreter/script no longer match the running app is rewritten at boot; Windows PATH card = PowerShell `SetEnvironmentVariable('Path', <User Path> + ';<dir>', 'User')` built with `PureWindowsPath` (the old `setx PATH "%PATH%;…"` merged system entries into the user PATH, truncated at 1024 chars, and on a POSIX-built path even showed `;.`); module docstring states plainly that the renderer token is served by unauthenticated `GET /`, so the CLI boundary binds a holder of only the CLI token (BM-01 stays open, see Cross-domain)), `backend/cli.py` (`CLI_TOKEN_ENV = "TRANSCRIPTOR_CLI_TOKEN"`, read by `load_connection` when `--token` is absent; `--token` help warns it is visible in the process list), `.env.example` (`TRANSCRIPTOR_CLI_TOKEN`), tests: `test_cli_access.py` (2 new), `test_cli_client.py` (1 new, `import os`).
- Check: `python -m unittest backend.tests.test_cli_access backend.tests.test_cli_client`
- Before (cli_access.py + cli.py at HEAD):
  ```
  FAIL: test_a_stale_wrapper_is_rewritten_for_the_running_app_at_boot (...)
  AssertionError: '/Applications/New.app/python3' not found in '#!/bin/sh\n# Transcriptor command-line client. ...\nexec /usr/bin/python3 -E -B /app/backend/cli.py --connection .../cli/connection.json "$@"\n'
  FAIL: test_the_windows_path_card_writes_only_the_user_path (...)
  AssertionError: 'setx' unexpectedly found in 'setx PATH "%PATH%;."'
  ERROR: test_the_token_can_come_from_the_environment_not_argv (...)
  backend.cli.CliError: command-line access is off (no .../nothing.json).
  ```
- After: `Ran 73 tests ... OK`; full suite `Ran 914 tests ... OK (skipped=2)`.
- Note: one full-suite run under machine load failed two timing tests in `test_deepgram_finalize_budget` (not touched here); they pass alone and on the next full run.
- BM-20 scope: `--token` is kept (removing a documented flag is a behaviour change); the env var is the non-argv path.

### C8 · BM-07 = S-05, BM-08, BM-10, BM-11 = S-06, H-11, BM-09 = H-05 = S-17 (backend part) (P2) · a recording's audio and screenshots are one thing to retention and delete-all
- Files: `backend/main.py` (`_prune_recording_audio` ranks RECORDINGS — one `(mtime, stem)` per stem, mtime = its audio's, else its transcript's, never the `.screens` folder's own — and collects audio and screenshots of the same stems; `_recording_media_mtime`; `_beyond_retention_policy` takes stems; `_prune_recording_screens` folded in; `_prune_orphan_screens` collects an app-made `.screens` whose transcript is gone after the recovery window; `_delete_all_recordings_sync` moves audio AND screenshots aside before the transcript and puts both back on failure, then removes app-made orphan `.screens`; `_read_recording_payload` asks for the screens folder once; stale comments at `RECORDING_COLLECTION_SCREEN` and in the retention table removed), `backend/screen_sessions.py` (`recording_screens_dir` — the one "does this recording have screenshots" answer used by list, serve and payload; `screenshots_in`; `is_app_screens_dir` (manifest names a session id); docstring no longer restates "newest five"), `backend/tests/test_screen_sessions.py` (new `OneRecordingOneRuleTests`).
- Check: `python -m unittest backend.tests.test_screen_sessions.OneRecordingOneRuleTests`
- Before (both files at HEAD):
  ```
  FAIL: test_a_symlinked_screens_folder_is_neither_listed_nor_served (...)
  AssertionError: PosixPath('.../recordings/Screen Sessions/take.screens/shot-01.png') is not None
  FAIL: test_a_touched_screens_folder_does_not_outrank_its_recording (...)
  AssertionError: Lists differ: ['take-0.screens', 'take-2.screens', 'take-3.scr[37 chars]ens'] != ['take-1.screens', 'take-2.screens', 'take-3.scr[37 chars]ens']
  FAIL: test_delete_all_puts_everything_back_when_the_screenshots_are_locked (...)
  AssertionError: {'deleted': 1, 'failed': 0} != {'deleted': 0, 'failed': 1}
  FAIL: test_delete_all_removes_screenshots_whose_transcript_is_gone (...)
  AssertionError: True is not false
  FAIL: test_screenshots_whose_transcript_is_gone_are_collected_after_the_grace (...)
  AssertionError: True is not false
  Ran 5 tests in 1.555s
  FAILED (failures=5)
  ```
- After: `Ran 5 tests ... OK`; full suite `Ran 919 tests ... OK (skipped=2)`.
- H-11 (perf, hypothesis) has no failing check: the payload now asks once instead of three times; behaviour identical (existing payload tests green).
- Cross-domain (S-17 remainder): `frontend/src/main.tsx` ~380 comment "the backend keeps the audio of the newest five" restates an env-tunable default.

### C9 · BL-04, BL-11, BM-21, BM-22, BM-23, BM-24 (part), BM-28 (P2) · support-module fixes
- Files: `backend/async_tasks.py` (logger `__name__` → `backend.async_tasks`, visible through main.py's one handler), `backend/main.py` (`_hub_offline_error_types` + `urllib.error.URLError`, `ssl.SSLError`; `_is_hub_offline_error` excludes `HTTPError` (the host answered); `_recovery_stem_glob` = `YYYYmmdd_HHMMSS_<id>` used by `_live_recovery_paths` and `_delete_live_recovery`), `backend/config.py` (`_clear_empty_keyfile` decides on stripped content like `_read_existing_keyfile`; an invalid keyfile's log no longer says "regenerating" — it is kept, by the pinned rule; `_adopt_legacy_encryption_key` replaces the keyfile with `atomic_write_bytes(mode=0o600)` instead of unlink-then-create), `backend/models_manager.py` (`huggingface_hub` import inside the worker's `try`; the no-op `time.sleep(0.5)` in `finally` removed), `backend/http_retry.py` (a superseded transient response is closed on success and on giving up, not only when another transient replaces it), tests: `test_untested_units.py` (`AsyncTasksLoggerTests`), `test_live_teardown.py` (asserts on `backend.async_tasks`), `test_warmup_offline.py` (2 new), `test_config.py` (`test_a_whitespace_only_keyfile_is_an_empty_one`, `LegacyKeyAdoptionTests`), `test_models_manager.py` (1 new, `import sys`), `test_http_retry_logging.py` (`SupersededResponseIsReleasedTests`), `test_live_recovery_liveness.py` (`SessionIdMatchingTests`), `test_recording_names.py` + `test_error_honesty.py` (spool fixtures now use the real `YYYYmmdd_HHMMSS_` stem instead of an invented `2026-09-04_19-37-12_`, which only the loose glob matched).
- Checks and before-outputs (each with only the named file restored from HEAD):
  - main.py + async_tasks.py: 
    ```
    ERROR: test_an_expired_certificate_on_the_model_cdn_is_unreachable_not_500 (...)
    FAIL: test_async_tasks_logs_into_the_backend_namespace (...)
    AssertionError: False is not true : transcriptor.async_tasks
    FAIL: test_a_failure_inside_the_task_is_logged_not_dropped (...)
    AssertionError: no logs of level WARNING or higher triggered on backend.async_tasks
    Ran 19 tests ... FAILED (failures=2, errors=1)
    ```
  - models_manager.py: `ERROR: test_a_missing_hub_package_ends_in_error_not_a_stuck_download … ModuleNotFoundError: import of huggingface_hub halted; None in sys.modules` (the worker thread dies; state stays "downloading").
  - http_retry.py: `FAIL: test_closed_when_a_later_attempt_succeeds … Expected 'mock' to have been called once. Called 0 times.` and the same for `test_closed_when_the_call_gives_up_on_a_transport_error`.
  - config.py:
    ```
    FAIL: test_a_failed_write_keeps_the_current_keyfile (...)
    AssertionError: b'-rqfL5…' != b'AkTb…' : the key in use no longer exists on disk
    FAIL: test_a_whitespace_only_keyfile_is_an_empty_one (...)
    AssertionError: unexpectedly None : a whitespace keyfile left encryption off
    ```
  - main.py (BM-28):
    ```
    FAIL: test_discarding_b_never_touches_a_b (...)
    AssertionError: False is not true : session a_b was deleted by a discard of b
    FAIL: test_the_paths_of_b_are_bs (...)
    AssertionError: '20261120_101012_a_b.pcm16' != '20261120_101011_b.pcm16'
    ```
- After: every named check OK; full suite `Ran 929 tests ... OK (skipped=2)`.
- BM-24 naming part (`retries` means attempts): the callers are engine modules (`remote_deepgram.py`, `remote_openrouter.py`); renaming the parameter needs them changed in the same commit → Cross-domain.
- BM-21, non-empty invalid keyfile: kept as is — `test_a_keyfile_with_content_is_never_replaced` pins "a keyfile with content is never replaced" (B-020 decision); only the misleading "regenerating" message was fixed.

### C10 · BM-12, BM-13 (ffmpeg part), BM-14, BM-19, BM-25, BL-14, BL-18 (sweep part) (P2) · save off the loop, one conversion, snapshots and results age out, one dir per inode, one probe
- Files: `backend/main.py` (`_save_recording_audio_source` runs promote + transcript write and the post-save filing — superseded-audio cleanup, adoption, registry, retention — via `asyncio.to_thread`; the remote path's ffmpeg fallback decides on `isinstance(e, FfmpegMissingError)` instead of a substring; `_job_snapshot_is_kept` / `keep_source` on both from-path routes (default true; false → the job deletes its snapshot and answers `audio_source_path: ""`); `_periodic_housekeeping` = retention + `_cleanup_expired_files` on the hourly timer, which now also starts when only the results limit is set; `_dir_identity` (st_dev, st_ino) dedupes `_recordings_scan_dirs`, `_recordings_storage_dirs_for_roots`, `_get_known_archive_dirs`; `network_status` returns at the first host that answers), `backend/audio.py` (`FfmpegMissingError(AudioError)` raised by every "ffmpeg is not installed" site; one `ensure_wav_16k(path_in, path_out, channels: Optional[int] = 1)` with one argv builder `_wav16k_cmd` that always maps the first audio track — `ensure_wav_16k_preserve_channels` removed, its one caller passes `channels=None`), `backend/cli.py` (`create_job` sends `keep_source` = `--save`), tests: new `backend/tests/test_archive_housekeeping.py`, `test_audio.py` (`OneConversionTests`, `FfmpegMissingIsATypeTests`; the two source-inspection tests now check the one builder/function).
- Check: `python -m unittest backend.tests.test_archive_housekeeping backend.tests.test_audio.OneConversionTests backend.tests.test_audio.FfmpegMissingIsATypeTests`
- Before (main.py, cli.py, audio.py at HEAD):
  ```
  ERROR: test_the_cli_asks_to_keep_it_only_with_save (...)
  KeyError: 'keep_source'
  ERROR: test_a_tick_removes_results_past_the_window (...)
  AttributeError: module 'backend.main' has no attribute '_periodic_housekeeping'
  ERROR: test_both_paths_map_the_first_audio_track (...)
  TypeError: int() argument must be a string, a bytes-like object or a real number, not 'NoneType'
  ERROR: test_missing_ffmpeg_raises_its_own_type (...)
  ImportError: cannot import name 'FfmpegMissingError' from 'backend.audio' (...)
  FAIL: test_one_dir_spelled_two_ways_is_one_dir (...)
  AssertionError: 2 != 1 : [PosixPath('.../Archive'), PosixPath('.../ARCHIVE')]
  FAIL: test_a_job_nobody_will_save_deletes_its_snapshot (...)
  AssertionError: False is not true
  FAIL: test_the_probe_stops_at_the_first_host_that_answers (...)
  AssertionError: 3 != 1 : ['https://openrouter.ai', 'https://www.google.com/generate_204', 'https://www.cloudflare.com/cdn-cgi/trace']
  FAIL: test_the_retention_scan_of_a_save_runs_on_a_worker_thread (...)
  AssertionError: Lists differ: [True] != [False]
  Ran 9 tests in 2.017s
  FAILED (failures=4, errors=4)
  ```
- After: `Ran 9 tests ... OK`; full suite `Ran 939 tests ... OK (skipped=2)`. `test_sweeper_thread_not_started_when_every_policy_is_disabled` now also turns the results limit off (the timer owns it too), and `test_sweeper_thread_still_starts_for_the_results_limit_alone` pins the new case.
- BM-25 behaviour note: `latency_ms` is now the first answering host's latency, not the best of three.
- BM-13 remainder (`upscale_text` falls back on `"HTTP 404"`/`"not found"` in `OpenRouterError` prose; `http_retry` hints by substring) → Cross-domain: `OpenRouterError` needs a `status_code` (engine module).

### C11 · BM-15, BM-16, BM-26 (P2) · one clamp, one save normalisation, upload ceiling before the body
- Files: `backend/main.py` (`_bounded_text` / `_nonneg_finite` replace `_upload_queue_str|_number` and `_live_draft_str|_number`, every caller names its cap, `UPLOAD_QUEUE_MAX_TEXT_CHARS`; `_SaveFields` + `_normalize_save_fields` used by `save_recording` and `_save_recording_audio_source`; `MAX_REQUEST_BODY_BYTES` and a declared-`Content-Length` check in the HTTP middleware answering 413 before the multipart parser spools the body), `backend/tests/test_archive_housekeeping.py` (`OneNormalisationTests`, `UploadCeilingBeforeTheBodyTests`).
- Check: `python -m unittest backend.tests.test_archive_housekeeping.OneNormalisationTests backend.tests.test_archive_housekeeping.UploadCeilingBeforeTheBodyTests`
- Before (main.py at HEAD):
  ```
  ERROR: test_both_save_routes_normalise_through_one_function (...)
  AttributeError: module 'backend.main' has no attribute '_normalize_save_fields'
  ERROR: test_both_ui_states_clamp_with_the_same_helpers (...)
  AttributeError: module 'backend.main' has no attribute '_bounded_text'
  FAIL: test_an_oversized_declared_body_is_413_before_auth_or_parsing (...)
  AssertionError: 422 != 413 : {"detail":[{"type":"missing","loc":["body","file"],"msg":"Field required","input":null}]}
  ```
- After: OK; full suite `Ran 942 tests ... OK (skipped=2)` (one earlier run at load average 346 failed two timing tests in `test_deepgram_warm`, untouched here; they pass alone and on the rerun).
- BM-26 scope: a chunked body without `Content-Length` is still bounded only by the per-route copy check.
