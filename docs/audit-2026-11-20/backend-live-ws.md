# Audit: backend/main.py 4560-6030 (live WS, Deepgram live orchestration, local assist)

Method: read the whole block and the dependencies it leans on (async_tasks.py, deepgram_warm.pcm_has_voice,
DeepgramLiveSession.send_pcm / close / discard / shutdown / note_undelivered_audio, DualLiveSession.replace_primary,
deepgram_recovery.run_recovery pcm(), frontend finalize/fatal handlers, pcm-worklet.js frame size). No code was run.
Known-and-closed (B-003/B-004/B-009/B-010/B-012 etc. in backend-findings.md) not repeated.

## Coverage
| Sub-area | Lines | Status |
|---|---|---|
| _apply_live_recovery / recovery budget | 4568-4623 | read |
| _ws_send_json / _ws_recv_next | 4626-4699 | read |
| _run_local_live_session | 4702-4847 | read |
| constants (send path, warm probe, drain) | 4850-4955 | read |
| _new_live_session, pool, boot prewarm | 4966-5061 | read |
| _run_deepgram_live_session: connect, preconnect, failure path | 5064-5269 | read |
| dual attach, warm probe, swap, sender, watchdog | 5271-5595 | read |
| _drain_finalize_tail, receiver, forwarder | 5608-5758 | read |
| finalize block / envelope / recovery / teardown / logging | 5762-6030 | read |

## Findings

### BW-01 . main.py:5764 `_run_deepgram_live_session` (forwarder fatal exit + `if fw in done ... not session.last_fatal`) . mid-stream fatal ends the session at once and sends `final` while the mic is still open
- Reproduce: Deepgram dies mid-recording with a fatal (or send_watchdog fires at :5572 -> report_fatal). Forwarder returns at :5751, `asyncio.wait` returns, :5764 excludes `last_fatal`, finally cancels rx (:5773), runs drain+recovery on the spool as it is NOW, sends final (:5937); handler returns, ws_transcribe closes the socket and `_finalize_live_recovery` closes the spool.
- Frontend (main.tsx:11553-11560) only paints a status pill on fatal: "the recording keeps going". Audio spoken afterwards is read by nobody and is in no spool.
- Contrast: connect-failure path (:5228) deliberately keeps reading into the spool until finalize/disconnect "because the envelope is the only transcript there is". Same decision (upstream dead, user still talking) made two ways.
- Severity: P1 hypothesis (needs renderer behaviour after final confirmed; renderer has its own WAV but memory says envelope owner, no second reading).
- Current: `if fw in done and not rx.done() and session.is_closed and not session.last_fatal:` keep consuming; fatal falls through to finalize.
- Fixed: on fatal (any cause) also keep rx alive: `if fw in done and not rx.done() and session.is_closed: _mark_recovery_error(recovery); await rx` and let the finalize path run the recovery with `stream_death_sec` (already recorded at the first fatal). The fatal `error` event has already reached the renderer.
- Why a bug: the docstring of this very function and the connect-failure comment state the rule "keep the spool complete until the user stops"; the fatal branch silently opts out.

### BW-02 . main.py:4647 `_ws_send_json` . `asyncio.wait_for(websocket.send_text(...), 5s)` cancels a send mid-frame: the anti-pattern the same module bans upstream
- main.py:4884-4886 and remote_deepgram_live.py send_pcm docstring: cancelling a websockets send mid-frame leaves the connection undefined. The fix was applied to the upstream socket only; the renderer socket still gets it, and the same socket then carries the next sends (the final envelope at :5937, finalizing tasks).
- Severity: P2 hypothesis. Consequence: after a timeout the next send on that socket may raise/garble; forwarder turns it into "client gone" (:5743) and stop, then a final envelope is attempted anyway.
- Fixed: do not cancel; on stall close the websocket (`await websocket.close()` bounded) like the upstream watchdog, or serialise sends through one writer task per connection.
- Why a bug: rule restated in two places, applied in one (dead/ineffective fix).

### BW-03 . main.py:5582 `send_watchdog` . `wait_for(session.close(), 3.0)` cancels a close that is guarded by `_close_ran`, making the later "idempotent backstop" a no-op
- remote_deepgram_live.py close() sets `_close_ran=True`, `_ws=None` first, then awaits `ws.close()` (close handshake against a wedged peer routinely > 3 s). wait_for cancels it midway: the recv task cancel and the events sentinel (end of close()) never run, and main.py:5953 `await session.close()` returns immediately (comment at :5949 claims it guarantees release).
- shutdown() (:5940) still cancels recv_task after 3 s, which limits the damage; the socket object itself is whatever the cancelled ws.close() left.
- Also `except (asyncio.TimeoutError, Exception)` (:5583) is redundant tuple.
- Severity: P2 confirmed (code path: wedge -> close >3 s). Consequence for the socket beyond recv task: hypothesis.
- Fixed: make `close()` resumable (steps individually guarded, not gated by a single flag) or run the bounded close as a shielded task and let a second close() await the same task: `self._close_task = self._close_task or create_task(self._do_close()); await shield(self._close_task)`.

### BW-04 . main.py:4634,4913,4918,5582,5976,5940,4762,4791 + remote_deepgram_live.py:83 . same "5 s wedge" and other timeouts stated as separate literals
- `_WS_SEND_TIMEOUT_SEC=5.0` (:4634), `_SEND_WEDGE_TIMEOUT_SEC=5.0` (:4912, comment: "same 5 s the old per-send timeout used"), `CONTROL_SEND_WEDGE_SEC=5.0` (remote_deepgram_live.py:83). Three constants for one idea in two modules; `_FINALIZE_DRAIN_CEILING_SEC=0.25` echoes FINALIZE_EMPTY_TAIL_WAIT_SEC=0.25. Inline literals: `timeout=3.0` wedge close (:5582), `wait_timeout=3.0` shutdown (:5940, also the default in remote_deepgram_live.py:2420 and FINALIZE_FLUSH_WAIT_SEC=3.0), `timeout=0.25` forwarder join (:5976), local `0.2` poll (:4762), local tail `30.0` (:4792), probe 2.5 s is also hard-coded in the docstring text (:5478 "2.5 s").
- Severity: P2 confirmed. Consequence: tuning one leaves the other behind; docstrings already lie when changed.
- Fixed: one `live_timeouts` block next to the other live constants (remote_deepgram_live) imported here; derive teardown bounds from it; format docstring numbers from the constant.

### BW-05 . main.py:4858,4893,4904,4955,5138,5601 . frame-count caps and sizing comments contradict the code and the renderer
- `_PRECONNECT_FRAME_BUFFER_MAX=4096` frames with comment "~85 bytes at ~375 frames/s" => 10.9 s, but the comment claims it covers a 1-12 s connect (open 8 s + retry 4 s, remote_deepgram_live.py:75-76). The worklet (pcm-worklet.js MAX_PENDING_SAMPLES=512 @48 kHz) actually posts ~94 frames/s, so the numbers in :4888-4891 are stale; a ScriptProcessor fallback sends far larger frames. The cap is in FRAMES, the real constraint is bytes (the send queue already has a bytes cap; `_SEND_QUEUE_MAX_FRAMES=8192` is inert next to it).
- `deque(maxlen=...)` drops the OLDEST frame silently at overflow (:5156): no log, no `note_undelivered_audio`, so Deepgram's timeline starts later than the spool's with nothing declared.
- `_WARM_REPLAY_MAX_BYTES` = 8 s "probe window plus a worst-case connect" (:4953): worst-case connect is 12 s + 2.5 s probe; the send queue bound (10 s, :4903) is also below that, so audio can overflow during a long swap connect (see BW-09).
- Severity: P2 (overflow silent = hypothesis, needs >10 s connect at tiny frames; stale numbers confirmed).
- Fixed: one byte-based bound derived from `DEEPGRAM_LIVE_OPEN_TIMEOUT_SEC + RETRY + _WARM_PROBE_TIMEOUT_SEC` seconds * LIVE_PCM_BYTES_PER_SEC, used by pre-connect buffer, replay ring and queue; count and log drops; remove the frames cap.

### BW-06 . main.py:5544 `sender` . an unexpected exception ends the sender silently: logged, not escalated, finalize proceeds as if drained
- `except Exception: logger.error(...)` then the task returns normally. `upstream_fatal` is not set, `_mark_recovery_error` not called, `session.report_fatal` not called. Finalize (:5805) sees `snd` done, so the queue (and sentinel) is never consumed; remaining queued audio never reaches Deepgram and is not declared undelivered (`bytes_offered` is incremented only in send_pcm). Later audio fills the queue to 320 kB and logs "upstream is not accepting writes" (wrong cause). The wedge watchdog stays blind if `pending_since` is None.
- send_pcm itself swallows transport errors (remote_deepgram_live.py:1999-2018), so the reachable triggers are bugs in this closure (`_swap_warm_socket`, `_flush_frame`) - but that is exactly what a swallowed error hides.
- Severity: P2 hypothesis. Also `except asyncio.CancelledError: raise` (:5542) is dead since 3.8 (CancelledError is BaseException).
- Fixed: in the handler: `session.report_fatal(f"sender failed: {e}")`, `upstream_fatal=True`, `stop.set()`, `_mark_recovery_error(recovery)`.

### BW-07 . main.py:5493,5551 `warm_probe_watchdog` / `send_watchdog` . polling loops where an event exists
- 0.1 s and 0.5 s `asyncio.sleep` loops over `session.stats.last_recv_at` and `pending_since`. The first can be one `asyncio.wait_for(first_message_event, TIMEOUT)` armed at the first voiced frame (the session already has a recv loop setting `last_recv_at`); the second can sleep exactly until `pending_since + WEDGE` and recheck. Two wakeups per recording-second per session forever; wedge detection latency 0.5 s worse than stated "no later than it used to be".
- Severity: P2 confirmed (design). Fixed: expose an asyncio.Event on the session, set at message receipt; or compute the sleep deadline from the armed timestamp.

### BW-08 . main.py:5142-5166,5649-5659,5698-5712 . frame accounting and the "closed? record only" rule restated three times
- pre-connect reader, `_drain_finalize_tail`, `receiver` each do frames_received/bytes_received += ...; `_record_recovery_chunk`; `_offer_pcm`. In the drain and receiver, `_record_recovery_chunk` is written in both branches of `if session.is_closed:` (:5655/5657, :5706/5708). One helper `_ingest(data)` (count, record, offer unless closed) removes the three copies.
- Related: the drain machinery (`_FINALIZE_DRAIN_CEILING_SEC`, `has_counts`, `_matched`) cannot wait for anything useful with the current renderer: WebSocket is ordered and the renderer sends counts, so `frames_received == framesSent` when `finalize` is processed and the loop never iterates; only an old renderer without counts pays a fixed 250 ms receive. Legacy path kept for a renderer that no longer exists in the same build (frontend main.tsx:12415 always sends counts). Hypothesis (needs "no frames after finalize" from renderer).
- Severity: P2 confirmed (duplication) / hypothesis (dead drain).

### BW-09 . main.py:5375,5440-5463 `_offer_pcm` during `_swap_warm_socket` . dropped bytes are declared to the OLD session
- While `fresh.connect()` runs (up to 12 s) `session` is still `old`; a queue overflow (10 s bound) calls `session.note_undelivered_audio` on the session about to be discarded. After the rebind (:5463) `fresh` never sees them, so its `bytes_offered`/streamedSec/coverage omits that audio.
- Severity: P2 hypothesis (needs overflow during swap; BW-05 numbers make it reachable at connect > 10 s).
- Fixed: keep a handler-level `undelivered_bytes` counter and apply it to whichever session is current at the point of use (or in swap, after rebind: `fresh.note_undelivered_audio(pending_undelivered)`).

### BW-10 . main.py:5238 . connect-failure path: `except Exception: pass` around `await pre_task`
- A receive error in the pre-connect reader (not disconnect) is swallowed with no log, no `_mark_recovery_error` (already marked for connect error, but the spool may be truncated and nothing says so). The rule in async_tasks.py (never `pass`) exists precisely for this (B-008 closed class).
- Severity: P2 confirmed. Fixed: `except Exception as e: logger.warning("preconnect reader failed: %s", e, exc_info=True)`.

### BW-11 . main.py:5925,5260 . paid recovery runs for a client that is gone
- Client disconnect or failed send (`fw` sets stop at :5744, receiver at :5696, pre-connect at :5149) all proceed to `drain_transcript` + `_apply_live_recovery` (REST re-decode of the spool, billed, up to the announced budget) and then send to a dead socket (return value of :5937/:5268 ignored). The spool is retained for the renderer's own recovery on error anyway.
- Severity: P2 hypothesis (cost/duplicate work; depends on whether the spool is re-promoted after disconnect). Fixed: track `client_gone` (disconnect/send False) and skip recovery + envelope, keep spool.

### BW-12 . main.py:5183-5188,5266,5931 `_send_finalizing` . fire-and-forget announcement tasks can overtake or trail the final envelope
- Each announcement is its own task doing a 5 s `_ws_send_json`; the final envelope is sent with a separate await. Nothing orders them or joins `budget_sends` before the final / before return. A slow client lets `finalizing` arrive after `final`, re-arming the renderer's deadline that "is always measured from the start of ITS wait" (comment :5857).
- Severity: P2 hypothesis. Fixed: one outbound writer (queue) per connection, or `await asyncio.gather(*budget_sends)` before sending final.

### BW-13 . deepgram_recovery.py:653,667 via main.py:4611 + main.py:4276,4351 . synchronous disk I/O on the event loop
- `pcm=lambda: _recovery_spool_bytes(recovery)` is called synchronously inside `run_recovery`: a read of up to `MAX_RECOVERY_READ_BYTES` (128 MB) on the loop (the comment at :4606 says "lazily" but not off-thread). `_record_recovery_chunk` does an UNBUFFERED `write()` (open buffering=0, :4276) per renderer frame on the loop, each frame, for every session. Neither is in the closed audit set.
- Severity: P2 confirmed (hot path). Fixed: `audio = await asyncio.to_thread(pcm)`; buffered spool writer flushed by a timer/size (the file is read back only at finalize, where flush is already done).

### BW-14 . main.py:4963,5045-5050 . restated defaults and a test-only alias
- `_live_config = live_config` exists "because this module and its tests refer to it by that name" (alias crutch). Boot pre-warm passes `model=DEFAULT_DEEPGRAM_AUDIO_MODEL, language="auto"` which `live_config` (remote_deepgram_live.py:1418-1419) already defaults to, and "the default the renderer sends" is a third copy (renderer default in frontend). Severity P2 confirmed. Fixed: call `live_config(diarize=False, keyterms=...)`, drop the alias and update tests.

### BW-15 . main.py:5203-5300,5587-5603 . resources not owned by try/finally before the main try
- Between `acquire` success (:5207) and the `try:` at :5762: `await secondary_task` (:5277), `cancel_and_await(pre_task)`, creation of snd/wd/warm_probe, replay loop. A CancelledError here (server shutdown cancels the handler) leaves: the primary session (open, billed, keepalive loop running), `secondary_task`/its socket (only `except DeepgramLiveError` at :5209 releases it), snd/wd/warm_probe tasks. A non-Deepgram exception from `acquire` likewise leaves `pre_task` reading the websocket and `secondary_task` undiscarded.
- Severity: P2 hypothesis (shutdown/cancel only). Fixed: move the `try:` up to right after `acquire` and put `session.close()`, `_discard_secondary_acquire`, and task cancellation in `finally`.

### BW-16 . main.py:5578 vs 5949 . comment/code ordering contradiction in the stop path
- :5788-5799 say the swap request is withdrawn FIRST, but the sentinel is enqueued (:5782) and `warm_swap_requested=False` is set only after `await cancel_and_await(warm_probe)` (:5798-5799); the sender can enter `_swap_warm_socket` in that await. The grace branch masks it. Severity P2 confirmed (ordering), consequence mitigated. Fixed: set the flag False (and a `warm_swap_closed` latch the sender checks) before enqueuing the sentinel.

### BW-17 . main.py:5665-5679,5991-6030 . observability gaps
- Tail loss on finalize drain ("timed out" with unmatched counts) is INFO; send-queue drops warn once with no total; the end-of-session log omits dropped bytes, swap occurrence, replay bytes, probe outcome. Severity P2 confirmed. Fixed: WARNING when `has_counts and not _matched()`, add `dropped_bytes`, `swapped`, `queued_bytes` to the :5990 summary.

### BW-18 . main.py:4702-4847 local path vs Deepgram path . two policies for "stop"
- Local receiver stops at `finalize` with no drain; Deepgram path drains (BW-08 says drain is moot). Local final envelope bypasses `_apply_live_recovery`, so only coverage flags tell the renderer. Severity P2 hypothesis (documentation drift: the Deepgram docstring :5085-5101 describes a protocol the local path does not follow).

## Clean places (examined, no defect found)
- `_ws_recv_next` (4672): all frame kinds map; non-dict JSON falls through to "text", logged at debug.
- Send queue ordering: sentinel in-queue guarantees finalize-after-all-audio (5782); pending_since age logic works for a wedged first frame; `warm_swap_in_progress` suppression of the watchdog is correct for a normal swap.
- `_apply_live_recovery` never raises, logs with exc_info; `not api_key` early return is correct.
- `_flush_frame` replay ring keeps sample alignment (even `excess`) and offset accounting is exact.
- Probe armed from capture-time of voiced frame (not first frame), cleared on answer, only for adopted sockets.
- Forwarder follows single-session swap (identity check) and dual (facade handles swap).
- Envelope construction goes through `envelope_from_result` / `live_final_envelope`; error text through `_safe_error_text` on every outbound error.
- Recovery spool cap/odd-byte/partial-write handling (4308-4377) correct; `_finalize_live_recovery` closes FD on every path.
- `acquire` raises only DeepgramLiveError (deepgram_warm.py:262-335), so the :5209 catch matches.
- `cancel_and_await` use is consistent with the cancellation rule (async_tasks.py).
