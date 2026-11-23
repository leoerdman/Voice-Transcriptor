# Frontend gaps audit — frontend/src/main.tsx ranges 2360-3000, 3975-5100 (+5100-5190), 5690-6130
Revision: HEAD acbf737 (main, clean). Read-only; line numbers are of this HEAD.

## Coverage
| Range | Content | Status |
|---|---|---|
| 2360-2560 | base64/cssEscape/ws-protocols/session id, viewer audio ready, MIME map, Content-Disposition | read line by line |
| 2560-2950 | fetchSavedAudioFromBackend, renderLatestSavedAudio, player controls, download, error handler | read |
| 2952-3000 | provider label/order/normalize, small-audio constants | read |
| 3975-4005 | downsample | read |
| 4007-4480 | PCM sink (OPFS/Memory), probe duration | read |
| 4482-4635 | canonical audio choice, stopMediaRecorderAndFlush | read |
| 4637-5100 | remote/local jobs, polling, sync, warmup, recoveries (+to 5190) | read |
| 5690-6126 | mic pill, live draft persistence, recover, collectUiPreferences | read |
Dependencies read: backend/main.py 1690-1712, 2600-2720, 6585-6625, 7013-7041; backend/remote_deepgram.py 45-70; main.tsx 965-1030, 1175-1235, 3009-3060, 11395-11450, 11736-11765, 13725-13750, 13886.
Not read (out of area): 3000-3975, 5100-5690 beyond 5190, 6130+.

## Findings

### FG-01 · P1 · confirmed
main.tsx:4040 `PcmSink.lastWriteError`, :4027 comment ("isDiskBacked lets the UI report which mode is active"), OpfsPcmSink.flushPending :4268-4275.
Gist: a disk-write failure during capture is never shown to the user; both interface members have zero readers outside the sink classes (`rg lastWriteError|isDiskBacked` outside 4040-4450 -> none).
Reproduce: fill the disk / revoke OPFS quota mid-recording (path: startLive :11407 createPcmSink -> worklet append :4213 -> flushPending write() rejects).
Consequence: only console.warn "disk may be full"; from that point `append` stops flushing (:4229) and chunks pile up in RAM unbounded (no cap, unlike MemoryPcmSink); user keeps dictating with no notice that the canonical audio is degraded.
Current: `this.lastWriteError = ...; console.warn(...)` and nothing reads it.
Fixed: after each append/flush failure call an injected `onWriteError` (or poll `pcmSink.lastWriteError` in the existing timer tick) -> `showRecordSessionNotice("Disk write failed; recording continues from memory", "warning", UI_TOKENS.notice.longMs)` once; cap pendingChunks to the same `fallbackWindowSec` window.
Why a bug: the interface and comment promise UI reporting; the member exists precisely to be read.

### FG-02 · P2 · hypothesis
main.tsx:4309-4315 and :4321-4352 OpfsPcmSink.finalize.
Gist: `writable.close()` failure is swallowed at console.debug and the lastWriteError "salvage" assumes spool prefix + RAM tail = complete WAV. With Chromium createWritable() the written bytes live in a swap file committed only by close(); after a failed write the stream is errored and close() rejects, so getFile() returns the pre-session (empty) file: prefix lost, header describes only the tail.
Reproduce: force write failure mid-session then stop. Unverified in a real Chromium (hence hypothesis).
Consequence: silently truncated/empty PCM; downstream falls back to WebM via coverage scoring (:4540) without any log above debug.
Current: `catch (e) { console.debug("OpfsPcmSink: close failed", e); }`.
Fixed: on close() failure set lastWriteError and warn at warn level; treat the spool as unusable (return a 0-length File so selectCanonical picks the container) instead of splicing a prefix that may not exist; correct the comment at :4322-4329.
Why bug: comment claims completeness the platform may not give; failure of the final commit is not "debug".

### FG-03 · P1 · confirmed
main.tsx:5827-5829 drainLiveDraftOperations catch.
Gist: PUT/DELETE of the crash-safety draft failing is dropped (console.debug), no retry, no notice.
Reproduce: stopLive -> clearLiveDraft (:12028/:13608) while backend answers 5xx/connection reset (backend restart, 429 limiter noted at backend/main.py:549 for this very endpoint) -> DELETE lost -> next boot recoverLiveDraftIfAny (:13745) reads the stale draft and saves a second "(Recovered)" recording of text already delivered. Same for PUT: the autosave silently stops protecting.
Consequence: duplicate recording of finished dictation; or no recovery after crash.
Current: `catch (e) { console.debug(`live draft ${op.kind} skipped`, e); }`
Fixed: for `clear` ops requeue (bounded retries with backoff) and keep a "pending clear" in the queue head; for `put` failures log at warn once per streak and surface a one-time notice "Draft autosave unavailable".
Why bug: the draft is the only crash safety net and errors in it are made invisible.

### FG-04 · P2 · confirmed
main.tsx:5762-5786, :5894-5905, :5922; backend/main.py:2650-2664 `_normalize_live_draft`.
Gist: schema versioning is ineffective. Backend rebuilds the draft from a fixed key list and drops `schema_version`; the reader therefore always sees version "missing -> 1", the `> LIVE_DRAFT_SCHEMA_VERSION` gate (BUG-73) can never fire for the backend path, and the reader then stamps the CURRENT version onto whatever it read. The comment at :5763 "The backend stores this blob opaquely" is false.
Reproduce: PUT a draft with schema_version 99; GET returns it without the field.
Consequence: a downgraded app misreads a newer draft instead of discarding it; "branch the reader on it" has nothing to branch on.
Fixed: add `schema_version` (int) to `_normalize_live_draft` (single owner: backend constant echoed in bootstrap) and let the reader branch; delete the false comment.
Why bug: the two sides disagree on the contract; the mechanism exists only on one.

### FG-05 · P2 · confirmed (path needs a failed first recovery)
main.tsx:5959-5981, :5998-6000; backend/main.py:2658.
Gist: `provider_present` decides "legacy => local" vs "none", but the backend always emits `provider` (possibly ""), so every backend-sourced draft has provider_present=true. A legacy localStorage draft without provider is recovered as "local" the first time, but migrated to backend at :5981 with `provider: ""`; if that first recovery throws (draft intentionally kept, :6026), the next boot recovers it as provider "none".
Fixed: carry the resolved provider in the migrated payload (`{...draft, provider: draft.provider_present ? draft.provider : "local"}`) and drop `provider_present` from the persisted interface (it is a reader-derived field in a persisted type).

### FG-06 · P2 · hypothesis
main.tsx:5805-5806 vs backend/main.py:2603, :2656-2657 `LIVE_DRAFT_MAX_TEXT_CHARS = 200_000`, `[:max_len]`.
Gist: backend keeps the FIRST 200k chars and drops the tail, renderer does not know the limit. About 4 h of continuous speech; then the newest text is what is lost, silently, while the response is ok.
Fixed: renderer truncates to the tail (or the backend keeps the tail) and the limit comes through bootstrap.

### FG-07 · P2 · confirmed
main.tsx:11449 + :5795-5812 + :5846-5855.
Gist: every 1.2 s the whole growing source_text AND transcript_text are PUT and atomically rewritten on disk (backend/main.py:233 counts it as top endpoint, "15.5 %" of requests, :214) even when nothing but `updated_at` changed (idle pauses, silence). Coalescing only merges queued ops, not unchanged payloads.
Fixed: skip the put when (source_text, transcript_text, timer-less fields) equal the last successfully persisted ones; keep a slow heartbeat if `updated_at` matters.

### FG-08 · P2 · hypothesis
main.tsx:13735-13747 initRecordingsBootstrap, :5885-5888, :6024.
Gist: recovery is a late step of boot (after loadRecordings and recoverBackendAudioSessions awaited). A recording started earlier calls persistLiveDraft(true) (:11444) and overwrites the single backend draft slot before recoverLiveDraftIfAny reads it -> crash draft lost. Also `clearLiveDraft(sessionId)` with a draft whose session_id is "" sends an unconditional DELETE (:5824) that wipes a live session's draft.
Fixed: read the stale draft once at first renderer boot before any session can start (or gate startLive on `recordingsBootstrapReady`), and never send an empty owner for recovered drafts.

### FG-09 · P2 · hypothesis
main.tsx:13740 vs :13745.
Gist: both backend spool recovery (audio) and renderer draft recovery (text) run for the same crashed session with no cross-key (draft.session_id vs recovery session_id), so one crash can yield two recordings and two notices. Unverified that ids coincide.

### FG-10 · P2 · confirmed
main.tsx:2993-2996 `REMOTE_SMALL_AUDIO_BYTES = 1 MiB`, UI_TOKENS.finalize.smallAudioUiMs 13_000 (:1230) vs backend/remote_deepgram.py:51-70 `_DEEPGRAM_SMALL_AUDIO_BYTES`, timeout (10,12)x1.
Gist: renderer copy of a backend size threshold and a UI timeout that is a hand-tuned "just above" the backend's read timeout; no shared constant or bootstrap value (unlike LIVE_SAMPLE_RATE_HZ/audio mime, which are exported). If backend changes either number the UI cuts a request that would succeed (or waits longer than needed).
Fixed: export both from bootstrap; derive UI timeout = backend connect+read + margin.

### FG-11 · P2 · confirmed
main.tsx:4650-4667 appendRemoteModelFormFields/remoteModelJsonFields; backend/main.py:2215-2220, 6615-6618, 6697.
Gist: one value sent under three names (`model`, `remote_model`, `openrouter_model`), also for Deepgram, because the backend still accepts "legacy alias kept for older clients". Rule restated in 2 renderer helpers + 3 backend sites.
Fixed: send `model` only; remove the alias in backend and renderer together (client and server ship in one bundle, no older client exists).

### FG-12 · P2 · confirmed
main.tsx:4675, :4719, :4942 `opts.provider || "openrouter"`.
Gist: silent substitution of a billing provider when `provider` is "" (None) — `Provider` includes "" (2985-2990) and these functions take `Provider`, not `RemoteProvider`. In remoteJobSync the reachability/model guards are skipped for "" (:4935, :4651) yet the request is sent as openrouter without a model.
Fixed: type the parameter `RemoteProvider` and throw on anything else.

### FG-13 · P2 · confirmed
main.tsx:4760-4808 waitForBackendJob, :4810-4845 waitForQueuedRemoteJob/Local.
Gist: (a) poll ladder 900 ms / 3 s after 30_000 ms are bare literals while UI_TOKENS.polling exists; (b) no overall deadline — a job stuck "running" polls forever; (c) a transient poll failure (fetch TypeError, 5xx) throws out of the wait while the backend job keeps running and is not cancelled (only `abort` cancels, :4821) -> orphan paid Deepgram/OpenRouter job, and a retry duplicates it; (d) backend `cancelled` is mapped to AbortError, i.e. "user cancelled", though the backend may cancel on shutdown. No event endpoint exists (grep backend: no SSE), so polling itself is acceptable.
Fixed: tolerate N consecutive poll failures before giving up; cancel the job on non-abort exit; move the ladder to UI_TOKENS.polling.

### FG-14 · P2 · confirmed
main.tsx:2744-2773 vs comment :2727-2742 and :2942-2949.
Gist: when the backend fetch fails (retention pruning is "the ordinary path", :2757) the player falls back to `latestSavedAudioState.file`, which is the OPFS-lazy blob that the comment at :2728 itself says dangles after sink.destroy() (silent error code=4 on Windows). The media `error` handler only console.warns; controls stay enabled and the user hears nothing.
Fixed: fallback only while the sink is alive (`!savedName`-window), otherwise show AUDIO_LOAD_FAILED_TEXT; in the error listener call setPlayerEnabled(false, ...) and showRecordSessionNotice.

### FG-15 · P2 · confirmed
main.tsx:2770-2772 vs :2683-2688.
Gist: fallback source key `"<key>\nfallback-file"` never equals `desiredBackendKey`, so every later refresh (the comment at :2660-2667 says loadRecordings(true) triggers it) re-runs fetch, revokes and re-attaches src and restarts playback — the exact symptom the guard was written to stop.
Fixed: let the guard accept the fallback key when the backend fetch failed recently (or store a retry timestamp).

### FG-16 · P2 · confirmed
main.tsx:2952-2960 providerLabel, :2968 PROVIDER_DISPLAY_ORDER, :2985 normalizeProviderSelection, :2997 isRemoteProvider, :4970 isProviderKeyConfigured, :4981 providerKeyErrorMessage (+ `Provider` type).
Gist: the provider set is restated six times; adding/removing one touches all and TS does not enforce exhaustiveness (string comparisons, `ReadonlyArray<string>`). The comment at :2962 calls the order list "the third copy" yet six remain.
Fixed: one `const PROVIDERS = {local:{label,remote:false,...}, ...} as const` and derive.

### FG-17 · P2 · confirmed
Magic numbers beside UI_TOKENS: `9000` ×4 (:4421, :5147, :5156, :5164; also :7220, :11758 outside) = UI_TOKENS.notice.longMs (:1018); 30_000 revoke delay :2930; 2500 probe timeout :4473; MEDIA_RECORDER_STOP_FALLBACK_MS :4609 (header :4593 explains why it is not in UI_TOKENS.polling though the sibling remoteChunkSettleTimeoutMs lives there); message texts "exceeds 2 hours" (:4419, :11755) duplicate `fallbackWindowSec = 60*120` (:1181).
Fixed: UI_TOKENS entries, template the hours from the constant.

### FG-18 · P2 · hypothesis
main.tsx:4403-4425 vs :4533-4541.
Gist: MemoryPcmSink drops old chunks but `totalSamples` keeps counting, and selectCanonicalCapturedAudio derives duration from `pcmSampleCount` (not from the file) -> after truncation the PCM duration is overstated, coverage >=0.95 takes the fast path for a file that holds only 2 h. Only >2 h on a machine without OPFS.

### FG-19 · P2 · confirmed (dead / ineffective)
- :4151 `pendingBytes` written at :4227, :4258, :4274, :4380, never read.
- :5169-5173 resolveFastLocalLanguage: both branches return a normalised string; localJobSync repeats `|| "auto"` (:5031) — rule restated.
- :2385-2392 cssEscape and :2401-2406 createClientSessionId keep manual fallbacks for `CSS.escape`/`crypto.randomUUID` that always exist in the shipped Chromium; the JSDoc at :2369-2379 argues exactly why such unreachable fallbacks are harmful, then adds a new one. (createClientSessionId fallback also feeds an OPFS filename and a backend session id.)
- :4624 `recorder.requestData()` immediately before `stop()` — stop() already emits the final dataavailable.
- :5086 warmLocalModel and :4954 remote sync read `ok` loosely; :4954 `ok` unused.

### FG-20 · P2 · confirmed
main.tsx:4455-4480 probeAudioFileDuration.
Gist: the 2500 ms timer is never cleared and the `<audio>` element is never detached (`src=""`/load) after timeout/finish; revoking the URL while metadata is still loading leaves an element with a dead src until GC; reached on every stop with PCM coverage <0.95.

## Known, not fixed
None of FG-01..20 matches an ID in docs/archive/audit-2026-09-04/frontend-findings.md (summary list read); F-002/F-011-style swallowed catches there are in other ranges.

## Clean places (checked, no defect found)
- downsample :3977-4005: carry preserves a continuous grid; floor/round consistent.
- buildWavHeader :4053: correct; uint32 overflow only >4 GiB (~36 h) unreachable.
- OpfsPcmSink name registration before create :4194 vs cleanup scan :4124 — race-free (a visible file of a live session is always registered).
- OpfsPcmSink closing/flush barrier :4301 ordering correct; destroy idempotent.
- createLinkedAbortSignal :3016-3060 and waitForBackendJob abort wiring: listeners removed on all paths.
- fetchSavedAudioFromBackend: honest MIME, empty-body check, disposition parse rejects path separators.
- parseContentDispositionFilename; waitForRecordingViewerAudioReady (rejects on error, clears listeners).
- recoverBackendAudioSessions: per-item failure isolation and summary.
- queue coalescing in enqueueLiveDraftOperation preserves put->clear order.
- Backend `_clear_live_draft_state` owner check matches the renderer's session token.
