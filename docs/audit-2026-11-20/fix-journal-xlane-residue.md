# Fix journal — cross-domain lane `residue` (Ultra-Audit 2026-11-20)

Branch `worktree-agent-ac1b88dd03eb0f9b9`, cut from `main` at 54b8770. Items left open by the
`ui-desktop-p2` and `p1-backend` lanes: FQ-06 (b, c), FL-08, S-15, the dead
`window.__transcriptorMicHealth` global, and a statement on FL-07's local-waiter half.

## Commit 1 · FQ-06 (b, c) — the upload stage flips on the real "job created" event

- **Before.** `processUploadItem` guessed the "Uploading… → Processing…" moment with a timer
  (`_stageCrossoverDelay = clamp(size/10 000, 800, 8 000)` ms, `_stageTimer`). The remote path also flipped on its
  first job poll (`onProcessingProgress`), so two sources set one field; local jobs had only the guess — a
  multi-GB local upload read "Processing…" eight seconds in.
- **After.** `frontend/src/job-poll.ts` `createThenWaitForJob(create, wait, onJobCreated)`: the creation POST
  resolves only after the body is fully sent and the job exists; `onJobCreated` fires then, never when creation
  fails. All four queued transports (`localJobQueued`, `localJobQueuedFromPath`, `remoteJobQueued`,
  `remoteJobQueuedFromPath`) go through it. `frontend/src/upload-item.ts` `enterUploadProcessingStage(item)`
  owns the transition (only `transcribing` + `uploading` moves; returns whether it changed, so the queue
  re-renders once — FQ-07 kept). `_stageCrossoverDelay`, `_stageTimer`, `clearTimeout(_stageTimer)` and the
  remote `onProcessingProgress` plumbing are deleted; the item's `stage` type is `UploadItemStage`.
- Files: `frontend/src/{job-poll.ts,upload-item.ts,main.tsx}`,
  `frontend/tests/{job-poll.test.ts,upload-item.test.ts,renderer-main-contract.test.ts}`.
- Check — new behaviour tests run against HEAD 54b8770's modules: `Tests 5 failed | 26 passed`
  (`createThenWaitForJob is not a function`, `enterUploadProcessingStage is not a function`). With the change:
  pass. The FQ-06/FQ-07 wiring pin in `renderer-main-contract.test.ts` now asserts the timer and the poll hook
  are gone and the four transports use `createThenWaitForJob`.
- Suites: backend `Ran 1028 tests OK`; desktop `tests 477 · pass 477 · fail 0`; `node --check` OK; frontend
  typecheck, lint clean; vitest `Test Files 51 passed · Tests 649 passed`; build OK.

## Commit 2 · FL-08 — one `decodeSavedRecording` for Re-transcribe and the stop path

- **Before.** Two "decode the saved recording again" chains in `main.tsx`: stopLive's
  `recoverFromEmptyTranscriptInner` (on-disk Deepgram via a raw `fetch` + `authHeaders()`, upload fallback,
  network-probe gate, abort signal, settings from the stop snapshot, every failure swallowed) and the Re-transcribe
  handler (always GET the audio first, upload to Deepgram, local Whisper; no probe gate of its own — `remoteJobSync`
  threw the offline message —, diarize read from the DOM mid-chain, saved `model` re-read from the toolbar at save
  time, its own tried-providers / first-error bookkeeping). A stopLive comment claimed they were the same chain.
- **After.** `frontend/src/saved-recording-decode.ts` `runSavedRecordingDecode(plan, deps, signal)` is the chain
  (Deepgram on-disk when persisted → upload when that failed / heard nothing / not persisted → local Whisper; the
  audio is read at most once; Deepgram unreachable = a skipped attempt carrying the reason; never throws; an
  aborted signal ends it before the next step) and `savedDecodeFailureView(result)` is Re-transcribe's
  "empty" vs "error (+Tried, +First)" rule. `main.tsx` `decodeSavedRecording({name, archiveDir, language, diarize,
  localModel, fetchAudio, deepgramReachabilityHint, signal, traceTag, onStep})` binds it to the transports (the
  on-disk call now goes through `apiPost`, which gained a `signal` option). Both callers use it; each keeps only
  its own policy — the stop path its hard budget (`recoverFromEmptyTranscript` race + abort) and status lines,
  Re-transcribe its status/error copy. The false comment now says they share the chain.
  `[trace recover] …` lines are kept (same step names/fields, emitted from the attempt log); Re-transcribe now
  writes the same `[trace retranscribe] …` lines where it had one `console.warn` on a Deepgram failure.
- **Pinned first.** The old chains were inline closures over stopLive/handler state (no seam to call them from a
  test), so their observable outcomes were pinned as scenario tables read off the HEAD code — 10 for the stop path
  (on-disk wins with no fetch; on-disk fail → upload → local; on-disk empty → upload; unpersisted → upload;
  offline → local without a Deepgram call; no key → local with no failure status; all fail → "" without
  throwing; no audio → no local step; one fetch; abort ends the chain) and 7 for Re-transcribe (Deepgram wins;
  "Deepgram failed — trying local" after a failure; offline reported as Deepgram's failure with the probe message
  as First, as `remoteJobSync`'s throw did; both fail → local error + `Tried:` + Deepgram's error as `First:`;
  Deepgram failed + local empty → "returned empty result (tried: …)"; local only → no First, no "switch to local"
  advice; unreadable audio → the read error). `frontend/tests/saved-recording-decode.test.ts`; against HEAD
  54b8770 it cannot load (`saved-recording-decode` does not exist).
- **User-visible changes to Re-transcribe, and why each is the correct one:**
  1. Deepgram decodes the archived file in place (`transcribe-on-disk`) instead of GET + re-upload — same
     provider/model/language/diarize, no loopback copy of the file. On a Deepgram failure the upload route is then
     tried once before local (the stop path's existing order), so a Deepgram outage costs one more failed request
     before the local fallback.
  2. An unreadable audio copy no longer fails Re-transcribe before Deepgram is asked: the on-disk route does not
     need the renderer's copy. The read error is still the message when nothing produced text.
  3. Offline: no Deepgram request is made (the probe is consulted up front, as on the stop path); status and error
     copy are unchanged ("Deepgram failed — trying local…", `First: Deepgram is unavailable because the internet
     probe is offline.`).
  4. Language, diarize and both models are read once, at the click; the History entry records the model that
     actually decoded, not whatever the toolbar shows when the save runs.
  5. An exception past the decode (marks / save / upscale all handle their own) shows as plain
     "Re-transcribe failed: …" without a providers list — it is not a provider failure.
  **Not adopted from the finding:** Re-transcribe does not get the stop path's hard timeout. That budget
  (`UI_TOKENS.finalize.{short,default}EmptyRecoveryMs`) is a stop-latency policy for a user waiting on a paste; a
  manual re-decode of an hour-long upload legitimately runs for minutes and a budget would discard real work.
  There is no cancel control on Re-transcribe to wire an abort to; `decodeSavedRecording` takes a `signal` if one
  is added. Screen marks ("two clocks"): both paths already go through `annotateTranscript`; the stop path passes
  live word timings, Re-transcribe the manifest's duration (a re-decode has no timings) — same rule, different
  evidence; left as is.
- **Stop-path changes:** none in outcome. The audio is read once instead of up to twice (upload, then local).
- Files: `frontend/src/{saved-recording-decode.ts,main.tsx}`, `frontend/tests/saved-recording-decode.test.ts`.
- Suites: backend `Ran 1028 tests OK`; desktop `tests 477 · pass 477 · fail 0`; `node --check` OK; typecheck,
  lint clean; vitest `Test Files 52 passed · Tests 666 passed`; build OK.

## Commit 3 · S-15 — the History player streams `<audio src>` on a single-recording capability

- **Before.** `openRecording` called `fetchSavedAudioFromBackend` (GET with `X-API-Token`, `await blob()`) and
  played a Blob URL: an uploaded video's audio — hundreds of MB — in renderer memory before the first sample, on
  every open. A media element cannot send the header, and the API token must never travel in a URL (BM-01).
- **Design (as briefed, one narrow capability).** `backend/media_tokens.py` `MediaTokens`:
  `v1.<expires_at>.<b64url HMAC-SHA256(secret, "v1\n<exp>\n<resolved audio path>")>`, secret = 32 random bytes
  per process (never stored — every token dies with the backend), TTL `MEDIA_TOKEN_TTL_SEC` = 600 s, expiry inside
  the signed message, constant-time compare, a token claiming more lifetime than the process grants is refused.
  The scope is the RESOLVED file, so a token opens one recording and nothing else. The threat model (what a URL
  leaks to that a header does not, what is out of scope) is the module docstring.
  Routes (`backend/main.py`): `POST /api/recordings/{name}/audio/stream-url` (API token, renderer only — not on
  `cli_access._CLI_ROUTES`, so the CLI token gets 403) returns `{url, expires_at}`;
  `GET /api/recordings/{name}/audio/stream?media_token=…` accepts ONLY a token minted for that file (not the API
  token, in a header or the query), answers 401 for anything else — including a missing file or a refused folder,
  so a tokenless caller learns nothing about the archive —, applies the same per-client rate limit, serves through
  `FileResponse` (Range → 206) with `Cache-Control: no-store` and an inline disposition. The existing header-auth
  audio route is unchanged (re-transcribe, download, the Live player) and shares the resolver
  `_recording_audio_file_or_404`. The access log already strips the query of every recording route
  (`_log_safe_access_path`), so the token never reaches `main.log` — pinned by a test.
  Renderer: `frontend/src/media-url.ts` (`parseMintedMediaUrl`: same-origin recording URL + expiry or throw;
  `mediaErrorRecovery`: an error at/after the expiry (5 s slack) re-mints, any other is a real failure — no loop).
  `openRecording` mints and sets `player.src`; an `error` listener on `#recordingAudio` re-mints after an expiry
  (a seek after a long pause) and resumes at the same position and play state. `recordingViewerAudioObjectUrl` /
  `revokeRecordingViewerAudioUrl` are replaced by `recordingViewerStream` / `clearRecordingViewerStream`.
  Considered and rejected: an HttpOnly path-scoped cookie (keeps the token out of the URL entirely, but cookie
  `Path` matching against percent-encoded recording names is fragile and it makes the capability ambient).
- Check — before: `backend.tests.test_media_tokens` route tests against HEAD's `main.py`: `FAILED (failures=4,
  errors=4)` (routes absent); `media-url.test.ts` cannot load on HEAD (module absent). After: 18 + 4 new tests
  pass; `renderer-main-contract.test.ts` pins that `openRecording` mints and never builds a Blob.
- Files: `backend/{media_tokens.py,main.py}`, `backend/tests/test_media_tokens.py`,
  `frontend/src/{media-url.ts,main.tsx}`, `frontend/tests/{media-url.test.ts,renderer-main-contract.test.ts}`.
- Suites: backend `Ran 1046 tests OK`; desktop `tests 477 · pass 477 · fail 0`; `node --check` OK; typecheck,
  lint clean; vitest `Test Files 53 passed · Tests 671 passed`; build OK.
- Not verified live: Chromium's media element against the 401-after-expiry path (re-mint and resume) was not
  exercised in the packaged app; Range/206 is verified with Starlette's TestClient.

## Commit 4 · dead global `window.__transcriptorMicHealth`

- **Check.** `grep -rIl 'transcriptorMic\|MicHealth'` over the whole tree (excluding `node_modules`, `.git`,
  `dist`): the global appears only where `frontend/src/main.tsx` declares and assigns it. Nothing in `desktop/`
  (no `executeJavaScript` string, no preload, no test), nothing in the frontend tests, nothing in `backend/`, no
  doc that names it as a devtools aid. `micHealth` itself is read through the module (`micHealth.get()`), which
  stays.
- **After.** The `declare global { interface Window { __transcriptorMicHealth … } }` block and the assignment are
  deleted. No behaviour to pin: nothing read it.
- Files: `frontend/src/main.tsx`.
- Suites: backend `Ran 1046 tests OK`; desktop `tests 477 · pass 477 · fail 0`; `node --check` OK; typecheck,
  lint clean; vitest `Test Files 53 passed · Tests 671 passed`; build OK.

## FL-07, local-waiter half — stated, not changed

The local-assist stop path still waits for the final envelope through `waitForLiveFinalEnvelope` with
`UI_TOKENS.finalize.envelopeWaitMs` (4 s). Routing it through `waitForLiveEnvelopeWithAnnouncedBudget` would make
its budget `announcedEnvelope.confirmMs` (1.5 s), because the backend announces `finalizing` only for Deepgram —
a 4 s → 1.5 s change of the local stop budget. That is a product decision; this lane did not change it. The
numbers already live in `UI_TOKENS.finalize` (ui-desktop-p2 commit 4).

## Not done (ID → reason)
- **FL-07, local-waiter half** → product decision (above).
- **S-15, Live pane player** → the Live pane's "current recording" player still fetches the saved file into a
  Blob (`renderLatestSavedAudio`). S-15 is about History; the Live player's source logic also falls back to the
  in-memory file when the backend fetch fails (`player-source.ts`), and moving it to a stream would turn that
  synchronous fallback into an asynchronous media-error path — its own change. `mintRecordingStreamUrl` is
  ready for it.
- **FL-08, timeout for Re-transcribe** → not adopted (reason in commit 2).

## Cross-domain, for the lead
1. **Merge note, stopLive** — commit 2 replaces the body of `recoverFromEmptyTranscriptInner` and deletes the
   `deepgramRestOnDisk` closure above it, and edits the FL-08 comment in the no-envelope branch. None of it is in
   the collection decision or the `onScreenVoiceTake` handler, but it is inside `stopLive`.
2. **New backend routes** — `POST /api/recordings/{name}/audio/stream-url` (API token) and
   `GET /api/recordings/{name}/audio/stream` (media token only). Neither is on the CLI route list; neither needs
   a desktop change. `apiPost` in the renderer gained an optional `signal`.
3. **CHANGELOG** (not written here): History audio starts playing at once for large recordings (streamed, not
   downloaded first); Re-transcribe decodes the saved file in place and keeps the settings it was started with;
   the Upload queue's "Uploading… → Processing…" flips when the file has actually reached the backend.
