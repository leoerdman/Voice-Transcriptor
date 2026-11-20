# Ultra-Audit · backend runtime logs (read-only) — BL-xx

Revision audited: HEAD acbf737 (installed app 1.6.6). Logs are UTC; the machine is UTC+7 (spool file names are local time).
Method: grep/awk/python on concatenated copies in the scratchpad (`bl/all.log`, `bl/nov.log`); no source file touched.

## 1. Log sources read

| file | period (UTC) | lines | how |
|---|---|---|---|
| main.log | 2026-11-19T05:53 → 2026-11-20T10:10 | 7 887 | whole, classified by tag + sampled |
| 9 Nov archives (2026-11-02 … 2026-11-19T05-53) | 2026-10-31T17:21 → 2026-11-19T05:53 | ~230 000 | concatenated -> `nov.log` (239 291 lines, 48.95 MB), classified by tag/signature, percentiles, timelines |
| 16 Aug–Oct archives (2026-08-27 … 2026-10-31) | 2026-08-25T03:37 → 2026-10-31T17:21 | ~420 000 | concatenated with Nov -> `all.log` (659 383 lines): counts per signature/month, first/last seen |
| main.log.1 | 2026-06-10 → 06-17 | 48 145 | `head`/`tail` only (period/size); not analysed |

Log growth: 25 archives = 131.6 MB (+ main.log.1 5.3 MB + main.log 1.6 MB); one 5 MB archive per ~1.5-2 days = ~2.7 MB/day (Nov: 48.95 MB over 18.3 days).
Categories of Nov bytes: desktop paste/post-stop/renderer traces 30.4 %; **Deepgram `is_final text=` lines 20.5 %**; other backend 17.8 %; Deepgram interim 9.8 %; **coverage-holes reports 8.0 %**; **`params` lines 7.4 %**; perm-check 3.7 %. Backend-attributed ~64 % (~31 MB). Deepgram-live logging alone = 22.4 MB per 31.9 h of dictated audio (= 0.7 MB per audio hour).

## 2. Metrics

Sessions (Deepgram WS): Nov 1 591 (31.9 h audio, mean 72 s), all-time 4 425.
- connect_ms (session complete line, Nov, n=1 616): p50 837, p90 1 084, p99 4 044, max 12 228 (2026-11-17T18:25:28). All-time p50 869, p99 3 487. Not on the user path: startLive-to-first-audio p50 256 ms, p90 728, p99 2 640, max 7 399 (renderer trace).
- Deepgram "connected in N ms" lines Nov n=4 261: p50 834, p90 1 076, p99 3 597.
- finalize_ms (Nov n=1 616): p50 707, p90 1 529, p99 4 095, max 81 669 (2026-11-08T06:56:01, see BL-09). Share >=3 s per month: Aug 17.5 %, Sep 4.9 %, Oct 1.2 %, Nov 2.0 % (mean 1705 -> 866 ms): the 3.2 s / 6.2 s clusters of August are gone (fixed in 1.3.x-1.4.x), so the stop path is not a long-standing problem any more.
- post-Finalize waited (n=3 075): p50 674 ms, p90 1 464, p99 3 002, max 6 269. 2 113 of 2 260 budgets announced `expectsMore=1`, i.e. the wait is a real Deepgram flush, not wasted.
- renderer stop->final (`stopLive total`, n=1 577): p50 1 049, p90 2 113, p99 6 962, max 20 708. post_stop scope totalMs (n=1 585): p50 1 348, p90 2 680, p99 10 187, max 32 068. paste totalMs (n=1 546): p50 266, p90 597.
- Backend startup (backend-start -> "Application startup complete"): n=21 (Nov) p50 1.31 s, p90 1.97, max 3.44; all-time n=132 p50 1.34, max 3.83. Fine.
- whisper small load (n=50 Nov, 196 all-time): p50 855 ms, p90 3 516, max 51 562 (2026-11-18T21:57:18, started on lock-screen resume: `[power] resume` 21:57:18.488, wake artefact). Released after 600 s idle every time. 31 of 50 loads fall within 30 min after a `[power]` suspend/resume/lock event.
- Finalize-time REST recovery ran in 43 of 1 591 sessions: p50 2 077 ms, p90 3 873, max 17 350. "recovery: none needed" 1 127, "no audio spool" 399 (BL-01).
- ffmpeg conversions (`backend.audio: ffmpeg ok`, n=158): p50 1.5 s, p90 52 s, p99 98 s, max 142 s (long CLI/upload media; ran in a worker, jobs 233 ok / 4 failed in Nov).
- Jobs (`backend.jobs`, Nov): 239 start, 233 done, 3 failed (audio compression), 1 failed (network). POST /api/remote/jobs/from-path 404 x18 on 2026-11-12T02:54 (single burst).
- Warm pool: 4 247 `connecting` for 1 592 sessions (2.67 sockets/session: 2 dual streams + 2 re-warmed sockets); 1 051 `adopted warm socket` (66 %); 824 pool sockets die at 309 s after connect (= WARM_IDLE_TTL_SEC 300 s) and are logged as `upstream closed code=1011 ... did not receive audio` (BL-05).
- Errors Nov / all-time: `upstream wedged` 20/83; `tail guard` 24/295; `Finalize send wedged` 1/1; `error (fatal=True)` 21/64; `giving up after N attempt` (Deepgram REST) 5/14; `ASGI exception` 4/21; HTTP 500 15 live-draft (Sep 6/9 disk full + 1 on 11-04), 6 warmup 500, 3x 502 transcribe-sync, 5x 502 transcribe-on-disk.
- Noise: access lines Nov 12 183 (2.15 MB, 4.4 %): `GET /api/jobs/{id}` 3 483, `POST /api/recordings/save*` 3 195, `GET .../audio` 1 646, `GET /api/recordings` 1 627, `POST .../discard` 1 583. `/api/health`, `/api/network`, `/api/ui/live-draft` are already muted (main.py `_ACCESS_LOG_POLLED_PATHS`) - not present in the log, so BM-25's probe cadence cannot be measured from logs.
- Secrets: grep for `sk-`, `Bearer`, `Authorization`, `api_key=`, 40-hex tokens and the literal contents of `api_token.txt` over all 659k lines = 0 hits. No key/token leak. Text leak: see BL-02.

## 3. Findings

### BL-01 · backend/main.py `_safe_delete_live_recovery` (called from `save_recording_from_path`/`_save_recording_audio_source` at :8082-8084 and from route `discard_live_recovery` :6102) × `_recovery_spool_bytes` :4447 × `_finalize_live_recovery` :4380 — the renderer's save/discard deletes the audio spool before the backend's finalize-time recovery reads it, so recovery is silently skipped in ~25 % of sessions and the finalize then resurrects an orphan sidecar
- How to notice: 400 of 1 591 Nov sessions (1 114 since 2026-09-05, 0 before) log `live recovery spool not readable at finalize: [Errno 2] No such file or directory: '.../live_recovery/<sid>.pcm16'` immediately followed by `recovery: no audio spool for this session; envelope unchanged`. Typical ordering (2026-11-08T05:20:30): `.751 audio retention: removed ...` / `.758 POST /api/recordings/save-with-audio 200` / `.761 POST /api/live/recoveries/39a8f9e1-.../discard 200` / `.804 finalize EXIT 239 ms` / `.827 ... live recovery spool not readable at finalize`. Worked example with a real hole: `[2026-11-08T06:55:58.932Z] ... 0.86s of recognised speech is not covered by any final segment — the committed transcript has holes` then `[06:55:58.934Z] ... spool not readable ... recovery: no audio spool for this session; envelope unchanged`. 217 of the 400 misses sit within 12 log lines of an "N s of recognised speech is not covered" report. Disk: `live_recovery/` holds 30 `.json` sidecars with status "recoverable" and zero `.pcm16` (e.g. `20261120_170943_fab1bd45-....json`, bytes=2099704).
- Consequence: the backend-owned "paid REST recovery" (docstring of `_recovery_spool_bytes`: "the spool ... is deleted only by `_finalize_live_recovery` ... strictly after the envelope has been sent") is defeated by a race the renderer wins one time in four, exactly in the slow-stop sessions where holes are likeliest (wedged socket, sleep/wake). Speech that Deepgram dropped stays dropped, and the envelope still declares `uncoveredSpeechSec` > 0 only if the live module counted it. `_finalize_live_recovery` additionally rewrites the sidecar after the delete (`atomic_write_json(recovery["meta_path"], meta)` :4429), leaving an orphan "recoverable" meta that nothing names (the comment in `_delete_live_recovery` documents the same debris: "207 orphan sidecars"). 11 of the 30 current orphans are in the miss list by session id; the other 19 are consistent with the same window (spool read first, sidecar written after the discard).
- Severity: P1, confirmed (log shows the full chain; code paths named). Renderer side: frontend/src/main.tsx:12679 `saveRecordingText({ liveSessionId })` then :12697 `discardLiveRecovery(liveSessionId)`, both before the `final` envelope is consumed.
- Current code (main.py):
```python
raw_sid = str(live_session_id or "").strip()
if raw_sid and LIVE_SESSION_ID_RE.fullmatch(raw_sid):
    _safe_delete_live_recovery(raw_sid)          # :8082-8084, runs while the WS handler may still be in finalize
...
def discard_live_recovery(session_id: str, ...):  # :6102
    deleted = _safe_delete_live_recovery(session_id)
```
- Fixed code (sketch):
```python
_LIVE_RECOVERY_OWNED: dict[str, bool] = {}     # session_id -> discard requested while the WS handler still owns the spool
_LIVE_RECOVERY_OWNED_LOCK = threading.Lock()

# in the WS handler right after _open_live_recovery(...):  _LIVE_RECOVERY_OWNED[session_id] = False

def _safe_delete_live_recovery(session_id: str) -> bool:
    with _LIVE_RECOVERY_OWNED_LOCK:
        if session_id in _LIVE_RECOVERY_OWNED:
            _LIVE_RECOVERY_OWNED[session_id] = True      # finalize owns the files until the envelope is sent
            _mark_recovery_meta_discarded(session_id)    # atomic status:"discarded" so a crash does not re-promote
            return True
    try:
        return _delete_live_recovery(session_id)
    except OSError as exc: ...

# WS handler finally (:4211), after the envelope was sent:
_finalize_live_recovery(recovery_ctx)
with _LIVE_RECOVERY_OWNED_LOCK:
    discard = _LIVE_RECOVERY_OWNED.pop(session_id, False)
if discard:
    _delete_live_recovery(session_id)                   # also removes the sidecar _finalize just wrote
```
- Explanation: ownership of the spool is the WS handler's until it has sent the envelope; any other deleter registers intent and the owner executes it. The docstring already states this invariant; the code does not enforce it.
- Why a bug: the function's own docstring promises "deleted only by `_finalize_live_recovery`", the measured miss rate (25 %) is the race window, and the leftover sidecars are the exact debris class the code already tried to fix once. Open point: crash between save and finalize - handled by the `discarded` status so `_list_live_recoveries`/promote skip it (check how `_list_live_recoveries` filters status).

### BL-02 · backend/remote_deepgram_live.py:3761 `_handle_result` ("is_final ... text=%r"), :2699-2710 coverage-hole report (`_HOLE_REPORT_TEXT_CHARS = 120`), main.py:3482 `_prune_recording_audio` ("audio retention: removed %s"), uvicorn access log of `GET /api/recordings/<name>/audio`, deepgram_recovery.py:566 ("decoded word(s) had no room ...: %s") — dictated words are written to main.log
- How to notice: `[2026-10-31T17:26:25.184Z] ... deepgram-live: is_final start=0.00 end=3.62 speech_final=False textLen=4 text='Так.'` (80 chars per line, 44 001 such lines in Nov = 10.0 MB = 20.5 % of the log); `[2026-11-08T06:55:58.933Z] ... coverage holes at finalize (...) hole 3.12-3.76s ... interim [0.00-4.00] '<up to 120 chars of speech>'` (2 951 lines, 3.9 MB); `[2026-10-31T17:26:47.244Z] ... audio retention: removed 2026-10-31_03-41-41-855874__<first words of the dictation>.wav (beyond newest 100)` (1 606 in Nov); access line `GET /api/recordings/2026-11-08_12-20-30-572172__<title from the dictation>.txt/audio?archive_dir=...` (1 646); `recovery: 2 decoded word(s) had no room beside the transcript: [...]`.
- Consequence: main.log keeps a searchable ~3-month transcript of what the user dictated (Aug 25 on), in a plain 0644 file (`-rw-r--r--`) beside config, and it is the artefact users are asked to attach for support. No secret leaked (0 hits), so this is privacy, not credentials.
- Severity: P1, confirmed (SKILL §2 "секреты в логах"; here content, not secrets). Not a defect only if the product states main.log may hold transcripts: README "Storage & privacy" (README.md:195) says nothing about it.
- Current code: `logger.info("deepgram-live: is_final start=%.2f end=%.2f speech_final=%s textLen=%d text=%r", start, end, speech_final, len(text), text[:80])`
- Fixed code: drop `text=%r` (keep `textLen` + a `lang`/stream tag, BL-06); gate the hole-report snippets and the recovery word list behind a `TRANSCRIPTOR_LOG_TRANSCRIPT_TEXT=1` env (default off; document in `.env.example`); log `entry.name` -> `entry.stem[:19]` (timestamp only) in the retention line; add `/api/recordings/` to the access-log redaction in `_MutedPollingAccessFilter` (strip the name segment); create main.log with mode 0600 (`fs.appendFileSync(..., { mode: 0o600 })` in desktop/main.js:`appendMainLog`).
- Explanation: the diagnostic value of these lines is timing/coverage (start/end/textLen), which survive without the text.
- Why a bug: two other places in the same module (`_safe_error_text` cap, "No secret is involved - the key travels in a header" comment at remote_deepgram_live.py:1713) show the log was designed to be shareable; content was never decided on.

### BL-03 · desktop/main.js:9393-9395 `app.whenReady` (`recoverOrphanRotatingLogs`, `pruneMainLogArchives`) × :455 `mainLogFilePath = ""` × :744 `appendMainLog` — boot-time archive pruning is a no-op, 25 archives / 131.6 MB are never pruned
- How to notice: `ls` shows 25 `main.log.archive-*` from 2026-08-27 on (oldest data 2026-08-25), total 131.6 MB, although `MAIN_LOG_ARCHIVE_KEEP_COUNT=10`, `KEEP_BYTES=50 MB`, `MAX_AGE_MS=7 d`. 21 backend starts in Nov and 132 in all logs, and **0** lines `[log-rotation] pruned old archive` / `recovered orphan` in 659 383 log lines.
- Consequence: unbounded growth (the machine hit ENOSPC on 2026-09-06 and 2026-09-09: `[2026-09-09T03:41:03.454Z] ... OSError: [Errno 28] No space left on device` -> 8 x `PUT /api/ui/live-draft 500`; log growth was one contributor among others, cause of the full disk itself not proven). Both sweeps start with `if (!mainLogFilePath) return;` and `mainLogFilePath` is only assigned lazily inside `appendMainLog`; the first statement of `whenReady` runs before any line was logged (`cleanupStaleTranscriptTmpFiles` does not log), so both return immediately. Observed outcome confirmed; root cause is the only reading consistent with code and log (hypothesis on the mechanism, confirmed on the result).
- Policy note: AGENTS.md rule 3 says "Do not delete logs unless the user explicitly asks". The existing code deletes automatically; whichever way it is resolved, the two disagree. If auto-prune stays, record the decision in AGENTS.md; if not, remove `pruneMainLogArchives` and the caps instead of shipping dead retention code.
- Severity: P2 confirmed (resource growth, 131.6 MB and rising ~2.7 MB/day).
- Current code: `let mainLogFilePath = "";` ... `function pruneMainLogArchives() { if (!mainLogFilePath) return; ...`
- Fixed code: resolve the path from one function, `function mainLogPath() { return (mainLogFilePath ||= path.join(app.getPath("userData"), "main.log")); }`, use it in `appendMainLog`, `recoverOrphanRotatingLogs`, `pruneMainLogArchives` and `mainLogArchivePath`; add a test that boots with no prior append and asserts a 12th archive is pruned.
- Why a bug: the function has a test-shaped guard that is false at its only call site; the feature never executed once in 3 months.

### BL-04 · backend/deepgram_warm.py:103 `logger = logging.getLogger("transcriptor.deepgram_warm")` and backend/async_tasks.py:39 `"transcriptor.async_tasks"` × main.py:184-197 `_backend_logger = logging.getLogger("backend")` — all warm-pool INFO logging is invisible
- How to notice: 659 383 lines contain 294 472 `backend.remote_deepgram_live`, 20 353 `backend.main`, ... and **0** lines from `transcriptor.*`. The pool logs at INFO at deepgram_warm.py:380 (open), :427 ("pre-warm connect failed"), :459/:472 (TTL), :536 (drop/adopt refusal). Only `backend.main: deepgram-live: adopted warm socket answered Nms ...` (1 051) survives, which is why a pool socket dying at exactly 309 s shows up only as someone else's `upstream closed code=1011` (BL-05).
- Consequence: no way to tell from the log why a session did not adopt a warm socket (34 % of Nov sessions did not: 1 592 sessions, 1 051 adoptions), why a warm connect failed, or when TTL fired. The handler is on the `backend` logger only; `propagate=False` there, root has no handler, so INFO from `transcriptor.*` is dropped (WARNING would go to Python's lastResort handler without timestamp prefix).
- Severity: P2 confirmed.
- Fixed code: `logging.getLogger(__name__)` in both modules (the other 17 modules already do; `__name__` is `backend.deepgram_warm`).
- Why a bug: it is the only two modules out of 21 using a hand-typed name outside the `backend` namespace; the comment above `_backend_logger` states "the diagnostic ladder ... is visible by construction".

### BL-05 · backend/deepgram_warm.py:481 `_expire_when_idle` -> `_drop_slot` × remote_deepgram_live.py:3480-3510 receive loop — a pool-initiated TTL close is logged as a Deepgram idle-timeout error
- How to notice: 844 Nov lines (2 446 all-time) `deepgram-live: upstream closed code=1011 reason=Deepgram did not receive audio data or a text message within the timeout window. See https://dpgr.am/net0001 finalize_sent=False final_segs=0`. Measured connect-start -> close = 309.2 s (min 308.9, max 318.1, n=820) = `WARM_IDLE_TTL_SEC=300` + connect/probe, not Deepgram's 10 s timeout (KeepAlive every 4 s is working). Follow-ons: `error (fatal=True): Deepgram upstream closed unexpectedly (code=1011 ...)` x4 and 14 renderer WARN `live ws error event (fatal=false): Deepgram upstream closed while sending: received 1011 ...` (2026-11 14, one of them `[2026-11-08T06:55:55.925Z] ... error (fatal=False) ... sent 1000 (OK); no close frame received`).
- Consequence: ~0.2 MB/18 days (844 lines) of expected socket retirements read like an outage; real wedges (`upstream wedged` 20) are harder to count. 412 sockets pairs/18 days are opened and retired unused (26 % of sessions end with a re-warm nobody uses within 5 min) - a billing/concurrency cost by design, see the optimization plan.
- Severity: P2 confirmed for the log signature; the claim "the close is ours" is a hypothesis (the 309 s constancy proves timing, not the close initiator).
- Fixed code: in `_drop_slot`, mark the session `session.retire(reason)` before closing so the receive loop logs `deepgram-live: warm socket retired (idle TTL)` at INFO and never calls `_report_error`; the 1011 reply to our own close is then expected and ignored.

### BL-06 · desktop/main.js:8047-8051 `backend.stdout/stderr.on("data")` + `compactLogText(msg, 1400)` — backend stderr chunks, not records, are logged and cut at 1 400 chars
- How to notice: of 127 706 `[backend-stderr]` lines in Nov, 5 198 contain 2+ merged records (`... backend.remote_deepgram_live: ... backend.main: live recovery spool not readable ... backend.deepgram_recovery: ...`, only the first has a timestamp) and 1 125 end with `...` (cut): 1 095 of the 2 951 `coverage holes at finalize` reports (the multi-line hole list is exactly what is truncated) and every long traceback: `[2026-09-09T03:41:03.454Z] ... ERROR: Exception in ASGI application Traceback ... File "site-packages/starlette/middleware/errors.py", line 186, in __call__ raise...` - the exception that matters (ENOSPC) survived only because it is the first frame; the `Exception in ASGI application` for 2026-09-01T09:40:50 and 2026-11-19T11:44:01 lose the closing `URLError`/`ConnectionError` text (the line is cut at `wrap_socket(...`/`handle_request stream = self._connect(request)`).
- Consequence: records are merged (a burst of 3 records is attributed to one timestamp) and the tail of every traceback - the only line naming the cause - is deleted; the coverage-hole diagnostics are cut in 37 % of cases.
- Severity: P2 confirmed.
- Current code: `appendMainLog(\`[backend-stderr] ${compactLogText(msg, 1400)}\`)`
- Fixed code: split on `\n` per chunk with a carry buffer, log one record per line, for lines > 1 400 keep `head 700 + " ... " + tail 700` (the exception line is at the tail); in the backend make `logger.exception` output single-record by keeping the traceback summary (`ExcType: message`) in the first 200 chars.
- Why a bug: the file comment on `appendMainLog` says "never silently lose signal"; the tail is the signal.

### BL-07 · backend/remote_deepgram_live.py:1717 "deepgram-live: params %s keyterms=%d" — 850-byte parameter line (with 16 personal keyterms) logged at every connection
- How to notice: 4 253 `params` lines in Nov = 3.6 MB = 7.4 % of the log, identical except language (`...language=multi&keyterm=Sonnet&keyterm=Opus&keyterm=Claude&...keyterm=single+source+of+truth&keyterm=SSOT&...` url-encoded). Also reveals the user's personal vocabulary.
- Consequence: ~200 KB/day of identical bytes; with `connecting model=... language=...` already on the next line.
- Severity: P2 confirmed (noise + minor privacy; the comment justifies logging params, not logging them 2.7x per session).
- Fixed code: log `params` once per distinct config hash (`self._cfg` -> `hash`), later connections log `params=<hash8> language=...`; keyterm count only; never the terms.

### BL-08 · backend/remote_deepgram_live.py:3761 / :3859 / :2251 and deepgram_dual.py — dual-stream log lines carry no stream/language tag
- How to notice: two parallel sessions emit indistinguishable lines (`[2026-11-11T19:41:30.525Z] is_final start=448.59 end=452.04 ... text='...кастомную...'` and `.554Z ... start=448.59 end=452.04 ... text='...простомную...'`; `finalize ENTER segments_final=86` and `segments_final=161` one ms apart). 2 951 hole reports and 3 075 post-Finalize lines per ~1 590 sessions: twice per session, which is the dual mode, but the reader cannot attribute any of them.
- Consequence: the logs cannot answer "which stream dropped this clause" - the question the user's own memory note (multi drops RU clauses) hinges on.
- Severity: P2 confirmed. Fix: add `[multi]`/`[ru]` (`self._cfg.language`) to the `DeepgramLiveSession` log prefix via a `LoggerAdapter`; subsumes BW-17 (observability gaps).

### BL-09 · backend/remote_deepgram_live.py `_send_control`/`drain_transcript` finalize path — one dead socket held the stop path for 81.7 s
- How to notice: `[2026-11-08T06:54:35.521Z] [renderer WARN] live ws error event (fatal=true): Deepgram upstream wedged: audio queued 5.2s ago was never accepted`; `[06:54:42.267Z] deepgram-live: Finalize send wedged (>5.0s); closing the socket`; `[06:55:55.924Z] upstream closed code=1006`; `[06:55:58.932Z] finalize EXIT 81669 ms`; `[06:56:01.037Z] ws deepgram session complete: ... connect_ms=713 finalize_ms=81669`. The renderer had already saved at 06:54:38 and the capsule idled out, so the user did not wait, but the backend task, the dual partner and the warm re-open were held for 76 s after the "wedged -> closing" decision, and the spool was gone (BL-01) so nothing was repaired.
- Consequence: the "close" of a wedged socket is not bounded: `closing the socket` at :06:54:42 took until 06:55:55 (73 s, TCP-level 1006). `wait_for(session.close(), 3.0)` is cancelled (BW-03) and the underlying close continues to hold `finalize`.
- Severity: P2, confirmed for the one incident (1/1 600), hypothesis for the mechanism (confirms BW-02/BW-03 shape). Fixed: abort the transport (`ws.transport.abort()`) when the 5 s send-wedge fires instead of a graceful close.

### BL-10 · backend/deepgram_recovery.py `_words_from_rest_result` — REST recovery returns words in the wrong script (confirms BE-11)
- How to notice: `[2026-11-04T20:25:13.508Z] ... recovery: 1 decoded word(s) had no room beside the transcript: ['कौन', 'कौन']` (Hindi), `[2026-11-13T00:02:44.675Z] ... ['మా', 'చివత్లో']` (Telugu), `[2026-11-19T10:03:25.545Z] ... ['చింకురా', 'వద్దాం']` (Telugu): 4 of 20 "no room" lines this period are Devanagari/Telugu/Hebrew output for a Russian/English speaker; a second sample list contains Hebrew `לי`.
- Consequence: when recovery does run (43 sessions Nov) it decodes short spans with `language=multi` and can splice foreign-script hallucinations into the dictation; the "no room" branch rejected these, but `recovery: spans=... words=N` successes are not checked by script.
- Severity: P1 hypothesis (the log proves the decoder emits wrong-script words; whether any were spliced in is not visible). Confirms BE-11. Fix: pass the session's language set to the REST decode and drop words whose script is outside it.

### BL-11 · backend/transcribe_gigaam.py (download) / backend/main.py:1766 `transcribe_warmup` × `_is_hub_offline_error` :1749 — an expired TLS certificate on the GigaAM CDN returns HTTP 500 with a stack trace
- How to notice: `[2026-11-19T11:43:56.567Z] WARNING:root:Download of https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/v3_e2e_rnnt.ckpt failed (attempt 1/3): <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: certificate has expired (_ssl.c:1010)>. Retrying...`; `[11:44:01.787Z] POST /api/transcribe/warmup 500 Internal Server Error`; `[11:44:01.789Z] [renderer WARN] Local model warmup failed for gigaam-v3-e2e-rnnt Error: HTTP 500`; `[11:44:01.805Z] ERROR: Exception in ASGI application`; `[11:44:07.504Z] backend.live: transcribe error (1/3 consecutive): URLError: ... certificate has expired` and `renderer WARN live ws error event (fatal=false)`. Same host failed 2026-09-06T00:52. 10 download attempts in total.
- Consequence: the endpoint's own comment says an unreachable host must not 500; a TLS-expired host is the same class (a state of the environment) but `_HUB_OFFLINE_ERRORS` is only requests/httpx/hf transport errors, so `urllib.error.URLError`/`ssl.SSLCertVerificationError` raise. The warm-up retries on every renderer trigger.
- Severity: P2 confirmed. Fixed: add `urllib.error.URLError` and `ssl.SSLError` to `_hub_offline_error_types()`; mark the host "failed for 10 min" in `transcribe_gigaam` so the same call is not retried per trigger.

### BL-12 · frontend/src/main.tsx:5238 `scheduleLocalWarmup` × network-flip (via `setNetworkState` :5278) × backend/main.py:1766 — local Whisper is loaded (~700 MB, 5-16 s CPU per the code comment) on every wake network blip although the provider is Deepgram
- How to notice: 50 `whisper model loaded: model=small ... load_ms=...` in Nov, 3 665 sessions' `provider=deepgram` vs 4 `provider=local`; 31 of the 50 loads happen within 30 min after a `[power] suspend/resume/lock-screen` event (e.g. `[2026-11-09T19:58:15.532Z] [power] suspend`, `[20:08:19.436Z] whisper model loaded ... load_ms=1278`, `[20:08:30.520Z] POST /api/transcribe/warmup 200` - during a dark wake); every one is freed again after 600 s (`whisper model released after 600s idle`: 191 times all-time).
- Consequence: ~50 loads/18 days for a feature used 4 times; wasted RAM spikes and 1-5 s CPU, plus 84 warmup POSTs. Mechanism (offline flip on wake makes `localEngineInUse` true) is a hypothesis; the correlation is measured.
- Severity: P2 hypothesis. Fixed: debounce `setNetworkState` flips by 10-15 s after resume (renderer already receives power events) or require the offline state to persist >=10 s before `scheduleLocalWarmup()`.

### BL-13 · backend/main.py `_prune_recording_audio` :3416 / `_build_recordings_list_payload` :7461 / `_recordings_scan_cache_key` :3303 — three full-directory walks of an 8 212-entry folder after every dictation
- How to notice: `recordings/Live Capsule` holds 8 112 `.txt` + 100 `.wav` (324 MB); per Nov session the log shows exactly one `audio retention: removed ...` (1 584 x "beyond newest 100"), one `GET /api/recordings` (1 627), one `POST .../save` pair; each save changes the cache key (`file_count`, newest mtime), so `GET /api/recordings` is always a miss. Per dictation: retention `iterdir()` + `is_file()`+`stat()` for 8 212 entries + a second text-file listing (`_iter_recording_text_files`), then the cache-key stat walk, then the payload scan. The log has no timing for these (the access line is emitted on completion), so latency is not measured - hypothesis.
- Consequence: O(N) syscalls (~25-30 k stats per dictation,) on every stop, in threads but competing with the live finalize; also retention removes exactly one wav per save, so at steady state it is O(N) to delete one file.
- Severity: P2 hypothesis (perf). Fixed: retention for the per-save call can derive "beyond newest 100" from `audio_index` already built by the list scan (or keep an in-memory ordered set updated on save) and run the full sweep only at boot/periodic; patch the list cache incrementally on save instead of invalidating.

### BL-14 · backend/main.py `_get_known_archive_dirs` :3613 / `~/Library/Application Support/transcriptor/known_archive_dirs.json` — the same directory registered under two spellings ("Transcriptor" and "transcriptor")
- How to notice: the registry contains both `/Users/leoerdman/Library/Application Support/Transcriptor/recordings/Live Capsule` and `.../transcriptor/recordings/Live Capsule` (and the Uploaded Media pair), a case-insensitive APFS volume; `d.resolve()` does not canonicalise case, so `seen` does not dedupe them. Log lines use "Transcriptor", the folder is "transcriptor".
- Consequence: retention sweeps, list scans and cache keys over these roots run twice per pass (2 x the 8 212-entry walk of BL-13) and `audio retention sweep: removed N` could double count. Not measurable from logs - hypothesis.
- Severity: P2 hypothesis. Fixed: dedupe on `os.path.normcase` + `st_ino`/`os.path.samefile` in `_get_known_archive_dirs`; migrate the registry.

### BL-15 · backend/main.py `_MutedPollingAccessFilter` :238 `_ACCESS_LOG_POLLED_PATHS` — job polling (`GET /api/jobs/{id}`) is not muted
- How to notice: 3 483 lines in Nov = 28 % of all access lines, ~14.6 polls per job (239 jobs): `[2026-11-03T10:42:45.730Z] ... "GET /api/jobs/6a2396b2-... HTTP/1.1" 200 OK`.
- Consequence: ~0.6 MB/18 days; minor. The same filter comment measured 75 % noise before and removed it; jobs were added later.
- Severity: P2 confirmed. Fixed: match `/api/jobs/` as a prefix for 2xx in the filter (keep non-2xx).

### BL-16 · frontend/src/main.tsx:12625-12697 `discardLiveRecovery` after `saveRecordingText({liveSessionId})` — redundant HTTP call per dictation
- How to notice: 1 583 `POST /api/live/recoveries/{id}/discard 200` for 1 591 sessions; `save-with-audio` has already deleted the spool (main.py:8084), so `deleted:false` each time. 1 646 `GET .../audio` after save as well (the audio just uploaded is fetched back for the player).
- Severity: P2 (hypothesis for GET .../audio payload bytes - not logged). Resolved naturally by BL-01's single owner; then drop the renderer `discard` after a successful save-with-audio.

### BL-17 · backend/main.py:4479 `_recovery_spool_bytes` `logger.warning("live recovery spool not readable ...")` — a normal-path condition logged at WARNING with `[Errno 2]` prose (follows BL-01)
- 400 times in Nov. After BL-01 it should not occur; if it still can (no spool because it was < `LIVE_RECOVERY_MIN_BYTES`), downgrade to INFO with the reason. P2, confirmed.

### BL-18 · results/ and uploads/ retention — checked
- `uploads/ad7f51ef-....audio.webm` (4.2 MB) dated 2026-11-18 22:56 and 3 `results/*.remote.json|txt` pairs (2.8 MB) are still on disk at 2026-11-20 17:18 (42 h) with `RESULT_RETENTION_SEC=86400`: the sweep is boot-time only (`_sweep_orphan_tmp_files` main.py:391/:1024), and the CLI copy persists up to the next backend start. Bounded in practice (6 files, ~7 MB) - confirms BM-19's "full copy" claim without a growth problem. P2 hypothesis for the schedule (is there a periodic sweep? the 21 starts in 18 days hide it).
- `ui_state/upload_queue.json` = 1.58 MB: 22 items, one with `text` of 150 KB; 98 `PUT /api/ui/upload-queue` in Nov (~150 MB written). P2: persist item metadata only; the transcript is already in `results/`.

## 4. Places where the logs show no defect (proved)
- Startup: 1.3 s p50 (n=132); no crash loops (12 clean `Shutting down`, 21 starts).
- Secrets: zero hits (BL-02 note). Polling noise for health/network/live-draft is muted as designed.
- Stop-path latency since 1.4.x: finalize p50 707 ms, wait dominated by Deepgram flush with `expectsMore=1` in 93 % - no avoidable wait.
- Tracebacks: only 24 total all-time; no unhandled exception in live WS handler; the 500s are disk-full (Sep), GigaAM TLS (BL-11) and one unexplained `PUT /api/ui/live-draft 500` on 2026-11-04T21:38:02.596Z with no traceback line (unknown cause, cannot be attributed).
- `MallocStackLogging: can't turn off malloc stack logging` (169 lines all-time, 90 in Nov) is emitted by a child `python3(pid)` within ~10 ms of each `jobs: job start`; origin not established from backend code (`subprocess.Popen` is ffmpeg-only, stderr piped). Unknown, harmless, 2 KB.

## 5. Optimization plan (ranked by user-visible impact)
1. BL-01: stop the spool race -> restores recovery in 25 % of sessions (400/1 591 Nov) and removes 30+ orphan sidecars; zero extra cost.
2. BL-02 + BL-07 + BL-08: drop dictated text and the 850-byte params line, tag stream: -10.0 MB (is_final) -3.6 MB (params) -3.9 MB (holes) = -17.5 MB of 48.9 MB (-36 %) -> support history grows from ~2 days to ~3 days per 5 MB archive, and removes the plaintext transcript.
3. BL-03: make the boot sweep run: 131.6 MB -> <=50 MB (or the policy decision vs AGENTS.md rule 3).
4. BL-12: no whisper preload on wake blips: 50 loads/18 d, 31 of them after power events.
5. BL-13/BL-14: single scan/dedupe of the 8 212-entry archive per dictation (~25-30 k stat calls per stop; unmeasured).
6. BL-06: per-record logging + tail-preserving truncation: recovers 1 125 truncated lines (37 % of hole reports) and every traceback tail.
7. BL-05/BL-04: make pool TTL close a first-class event; shrinks 844 misleading error lines (-0.2 MB) and makes adoption failures (34 % non-adopted) diagnosable.
8. BL-15, BL-16: 3 483 job-poll lines + 1 583 redundant discard calls.

Cross-references: confirms BE-11 (BL-10); BL-09 shape confirms BW-02/BW-03; BL-08 subsumes BW-17; BL-18 confirms BM-19; BM-25 could not be measured (muted in access log).
