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
