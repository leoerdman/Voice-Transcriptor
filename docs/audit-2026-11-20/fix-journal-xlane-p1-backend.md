# Fix journal — cross-domain lane p1-backend (2026-11-20)

Branch `worktree-agent-a20e6e245bf863957`, cut from `main` at 3cc7666.
Source: `docs/NEXT_SESSION_2026-11-20.md` §3.2 and Appendix A; original
findings in `docs/audit-2026-11-20/*.md`.

Every commit was verified with the full set from AGENTS.md: backend suite
(throwaway venv), `npm --prefix desktop test`, `node --check` main/preload,
frontend typecheck, lint, vitest, build.

## C1 — FQ-04: job poll failures classified (renderer)

Files: `frontend/src/job-poll.ts`, `frontend/src/main.tsx`
(`waitForBackendJob`), `frontend/tests/job-poll.test.ts`.

What was already there (FG-13 a/c/d, d9dbf0d): a rejected poll is retried up
to `maxConsecutiveFailures`, and a wait that ends without a terminal job
status and without the caller's abort cancels the job (`waitForJob`'s
`catch` → `deps.cancel()`), so the `finally` cancel the handoff asks for in
`waitForQueued*Job` is already provided one level down — adding it there
would be a second owner of the same decision. Abort still cancels through the
callers' signal listener.

What was missing: every non-2xx poll was a plain `Error` and therefore
retried — a 404 (job gone after a backend restart / results sweep) was polled
three more times and then "cancelled", a 401 likewise. Now `fetchJob` throws
`JobPollHttpError(status)`, and `classifyJobPollFailure` decides:
transport failure / 5xx / 429 → transient (bounded retries, same ladder);
404 → terminal, no cancel (no job left); other 4xx → terminal at once, cancel
(the job may still be running).

Check (test fails on the old behaviour — classification forced to "transient"):

```
before:  × ends the wait on a 404 at once, without retrying or cancelling a job that is gone
         × ends the wait on another 4xx at once and cancels the job it may leave running
         Tests  2 failed | 8 passed (10)
after:   Tests  10 passed (10)
```

Suites: backend 991 OK; desktop 427 pass; vitest 604 pass; typecheck, lint,
build clean.

## C2 — BM-01 (security): the API token leaves the unauthenticated page

Files: `desktop/backend-auth.js` (new, pure) + `desktop/backend-auth.test.js`,
`desktop/main.js` (require, `BACKEND_API_TOKEN`, child env, `_isBackendOrigin`
now calls `isSameOrigin`, `ipcMain.on(API_TOKEN_CHANNEL)`), `desktop/preload.js`,
`desktop/ipc-contract.test.js`, `desktop/package.json` (build.files),
`PROJECT_STRUCTURE.md`, `backend/main.py` (`index`, two comments),
`backend/cli_access.py` (docstring), `backend/tests/test_cli_access.py`,
`frontend/src/main.tsx` (comment on `apiToken`).

Design: the desktop shell mints one token per LAUNCH
(`createLaunchApiToken`, 32 random bytes) and starts the backend with it in
`TRANSCRIPTOR_API_TOKEN` — an input `_load_or_create_api_token` already
honoured, so the backend has no new code path; a process environment is
readable only by its own user (argv would have been world-readable, so not
`additionalArguments`). The preload asks `backend:api-token` synchronously
once per page load and exposes the answer under the SAME global the renderer
always read (`window.__TRANSCRIPTOR_API_TOKEN`) — the renderer has one source
and no code change. Main answers only the main window's webContents showing a
page of the backend's origin (`apiTokenForRequest`), "" to anyone else.
Per launch, not per spawn: the backend is restarted under a living page
(engine install, crash recovery). `BACKEND_BOOT_NONCE` was not used
(`/api/health` publishes it).

Non-Electron path, decided explicitly: the page opened in an ordinary browser
or via the Vite dev server (`npm --prefix frontend run dev`, which has no API
proxy anyway) has no token, so API calls fail with "API token is missing".
That is the point of the fix — full access only through the app's window.
Documented at `index()` and `apiToken()`. Side effect for the user to know:
in the desktop app `<data>/api_token.txt` is no longer the live token (it is
left on disk, untouched); manual `curl` against the running app should use
the CLI (`transcriptor`) or a backend started by hand.

Checks:
```
backend  IndexPageCarriesNoTokenTests — with the old injection line put back:
         FAIL: test_the_page_serves_the_bootstrap_but_not_the_token  (FAILED failures=1)
         after: Ran 38 tests OK
desktop  backend-auth.test.js 4 tests (new module); ipc-contract channel test
         (preload spells API_TOKEN_CHANNEL; main answers it; env carries it)
```
Live check in a real Electron (the repo's own electron binary, a probe app in
the scratchpad: sandboxed + contextIsolated window, same preload code,
loopback page): `senderFrame.url= http://127.0.0.1:61160/ … isMain= true`,
page saw `T:secret123` — the sync IPC from a sandboxed preload works and
`senderFrame.url` is the page URL at preload time. The full app was not
launched.

Suites: backend 992 OK; desktop 432 pass; vitest 604; typecheck, lint, build clean.

## C3 — BL-02 remainder (privacy): main.log is owner-only

Backend half was already on main: `_MutedPollingAccessFilter` reduces the
`<name>` segment of every `/api/recordings/<name>/…` route (audio included)
to `<timestamp>#<digest>` and drops recording-route query strings
(d5d9e6b, `backend/tests/test_access_log_filter.py` covers `…/audio`);
retention logs `_log_safe_recording_name`. No backend change needed.

Desktop half: `desktop/private-log.js` (new, pure with injected fs) +
`desktop/private-log.test.js`; `desktop/main.js` `appendMainLog` appends
through it; `desktop/package.json` build.files; `PROJECT_STRUCTURE.md`.
The file is created with mode 0600 (`appendFileSync` `mode`, which applies
only on creation — so every file a rotation starts is private) and a
pre-existing world-readable main.log from an older version is `chmod`ed
0600 once per process. A filesystem refusing chmod does not lose the line.
Existing rotated archives keep their old mode (not touched: log files are
the user's call per AGENTS.md rule 3; they age out by the existing sweep).

Check (module with `mode` and `chmod` removed = old behaviour):
```
before:  ✖ a log the appender creates is readable by its owner only
         ✖ a log left world-readable by an older version is tightened on first append
         ✖ the file a rotation starts afresh is created private too
         ✖ a filesystem that refuses chmod does not lose the line
after:   ℹ pass 4  ℹ fail 0
```
Suites: backend 992 OK; desktop 436 pass; vitest 604; typecheck, lint, build clean.

## C4 — FG-04, FG-06, FG-11 (backend contracts with the renderer)

Files: `backend/main.py` (`_normalize_live_draft`, new
`_live_draft_schema_version`, new `_bounded_text_tail`,
`_remote_model_from_payload`, `_run_remote_transcribe_once`,
`/api/remote/jobs`, `/api/remote/transcribe-sync`, transcribe-on-disk
docstring), `backend/tests/test_live_draft_state.py`,
`backend/tests/test_remote_chunking.py`, comments in
`frontend/src/live-draft.ts` and `frontend/src/main.tsx`.

- FG-04: the draft keeps `schema_version` (a positive integer; absent or
  malformed → 1, the renderer's own reading of a pre-versioning draft), so
  the renderer's newer-schema gate now works for backend drafts.
- FG-06: `source_text` / `transcript_text` over `LIVE_DRAFT_MAX_TEXT_CHARS`
  keep the TAIL (newest words). Chosen over publishing the limit: one owner
  of the cap, no renderer copy.
- FG-11: `remote_model` / `openrouter_model` removed from the JSON helper,
  both form endpoints and `_run_remote_transcribe_once`; only `model` is
  read (the renderer sends only `model` since bf3cb2f, `backend/cli.py` too).
  `/api/remote/jobs/from-path` and transcribe-on-disk read through
  `_remote_model_from_payload`, so they follow.

Check — new tests against the previous `backend/main.py`:
```
before:  ERROR: test_the_schema_version_survives_the_round_trip
         FAIL:  test_an_over_long_draft_keeps_its_newest_text (source_text, transcript_text)
         FAIL:  test_remote_model_travels_under_model_only
         FAILED (failures=3, errors=1)
after:   Ran 9 tests OK
```
Suites: backend 994 OK; desktop 436; vitest 604; typecheck, lint, build clean.

## C5 — FU-13a, FU-13b / FG-10: backend-owned limits published, renderer copies gone

Files: `backend/remote_deepgram.py` (public `DEEPGRAM_SMALL_AUDIO_BYTES`,
`DEEPGRAM_SMALL_AUDIO_READ_TIMEOUT_SEC`, used by `_deepgram_http_policy`),
`backend/main.py` (`runtime_limits` gains `upscale_custom_preset_limit`,
`deepgram_small_audio_bytes`, `deepgram_small_audio_read_timeout_ms`),
`backend/tests/test_live.py`, `frontend/src/runtime-limits.ts` (parse +
`customPresetLimitReached`, `smallAudioUiTimeoutMs`),
`frontend/tests/runtime-limits.test.ts`, `frontend/src/main.tsx`
(`applyRuntimeLimits`, `loadUpscalePresets`, `inferRemoteJobTimeoutMs`;
`REMOTE_SMALL_AUDIO_BYTES`, `DEEPGRAM_SMALL_AUDIO_UI_TIMEOUT_MS` and
`UI_TOKENS.finalize.smallAudioUiMs` removed, `smallAudioUiMarginMs: 1_000`).

Decisions: the UI deadline is the backend's READ timeout + 1 s margin
(today 12 s + 1 s = the old 13 s — behaviour unchanged). FG-10 suggested
connect+read+margin (= 23 s); that would change behaviour, so the existing
"read + 1 s" convention is kept and now derived instead of copied. No
renderer defaults for the new numbers: until bootstrap/health reports them
the add-preset button stays enabled (the create route still refuses past the
limit with a 400) and small Deepgram requests have no UI deadline of their
own. In the app the bootstrap is in the page, so they are known from the
first render.

Check: backend `test_runtime_limits_publish_what_the_renderer_used_to_copy`
(also pins that the published read timeout IS the one the client uses for a
small body) — against the previous main.py:
`ERROR … KeyError: 'upscale_custom_preset_limit'`; after: OK. Frontend: 3 new
vitest cases (the old renderer had no reading at all — `customCount >= 3`,
literal 1 MiB / 13 s).

Suites: backend 995 OK; desktop 436; vitest 607; typecheck, lint, build clean.

## C6 — BW-13, BE-22, BM-13, BM-24 (backend debts)

Files: `backend/main.py`, `backend/transcribe.py`, `backend/http_retry.py`,
`backend/remote_openrouter.py`, `backend/remote_deepgram.py`; tests
`backend/tests/test_live.py`, `test_upscale_presets.py`,
`test_recording_names.py`, `test_remote_openrouter.py`,
`test_http_retry_logging.py`, `test_error_honesty.py`.

- BW-13: the recovery spool is opened with a 16 KiB buffer
  (`LIVE_RECOVERY_WRITE_BUFFER_BYTES`, ½ s of audio) instead of
  `buffering=0` — no more one `write()` syscall per renderer frame on the
  event loop. The two readers that look at the file while the session holds
  it (`_recovery_spool_bytes`, `_recovery_spool_seconds`) flush first
  (`_flush_recovery_spool`, a failed flush degrades the take like a failed
  write); finalize flushes + fsyncs as before and now marks the take
  `had_error` when that flush fails (buffered data would be lost). Trade-off,
  stated at the constant: a backend PROCESS crash may lose up to ½ s that was
  still in the buffer (the kernel keeps everything flushed). The finding's
  other half (`asyncio.to_thread` for the finalize read) is in
  `deepgram_recovery` (engines lane) — not touched.
  `test_recording_names` read the file by path while the handle was open
  (relied on unbuffered); it now reads through `_recovery_spool_bytes`.
- BE-22: main.py's copy of `_env_int` removed; main imports
  `backend.transcribe._env_int` (as `transcribe_gigaam` already did), which
  got the explanatory docstring. Behaviour identical.
- BM-13: `OpenRouterError(message, status_code=…)` carries the HTTP status
  for HTTP failures (transcribe, audio-unsupported, upscale); the upscale
  model fallback continues on `status_code == 404` only, not on "HTTP 404" /
  "not found" in the prose. Not done: the `http_retry` hint substrings — they
  only decorate the final error message (no control flow), and DNS failures
  are only distinguishable by text in `requests`.
- BM-24: `request_with_retry(retries=…)` → `attempts=…` with the callers
  (`remote_deepgram`, `remote_openrouter`) and tests. The `last_resp` close
  half was already fixed (C9 of the archive lane).

Check — new/changed tests against the previous five backend modules:
```
before:  ERROR test_an_http_failure_carries_its_status
         ERROR test_model_fallback_is_decided_by_the_http_status_not_the_wording
         ERROR test_transcribe_short_audio_uses_interactive_timeout_and_canonical_mime  (kwargs["attempts"])
         FAIL  test_main_uses_the_shared_parser
         FAIL  test_small_frames_are_buffered_not_written_one_by_one   (BW-13, separate run)
after:   all OK
```
Suites: backend 1002 OK (one full run hit a wall-clock flake in
`test_deepgram_finalize_budget` under machine load — passes 3/3 alone and in
the re-run of the full suite); desktop 436; vitest 607; typecheck, lint, build clean.
