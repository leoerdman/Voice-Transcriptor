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
