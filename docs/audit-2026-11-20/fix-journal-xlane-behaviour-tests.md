# Fix journal: cross-lane "behaviour-tests" (review-merged.md §4)

Lane goal: the wiring the audit's fix lanes proved by grepping
`desktop/main.js` / `frontend/src/main.tsx` is extracted into small
functions with injected dependencies, the shipped code calls them, and the
claim is tested on behaviour with fakes. Source-text tests stay only for
facts that are textual (a channel/module is or is not present, which
registrar a channel goes through). Every replacement test was run against
a deliberately broken shipped function (break, run, restore); the
evidence is recorded per step.

Cut from `main` at 8e8f0a6.

## 1. IPC sender guarding (DM-28) — security

- New `desktop/ipc-sender-guard.js`: `createSenderGuardedIpc(ipcMain, { isAllowedSender, onRefused })`
  returns `{ handle, on }`; the registrar runs the sender check before the
  handler, so a handler cannot leave it out. main.js registers all nine
  main-window channels through `mainWindowIpc` and the capsule's three
  verbs through `capsuleIpc` (the inline `if (!isFromMainWindow(event))` /
  `if (!fromCapsule(event))` first lines are gone). The only direct
  `ipcMain.on` left is `API_TOKEN_CHANNEL`, which answers every sender by
  design (`""` for anyone but the main window's page; `apiTokenForRequest`
  in ./backend-auth decides, tested in backend-auth.test.js).
- `desktop/ipc-sender.test.js` rewritten. Grep test removed: "slice 260
  chars after the channel name and regex-match `isFromMainWindow(event)`"
  (passed with the call in a comment or another branch). Replaced by:
  - behaviour (fake ipcMain): an invoke channel runs the handler for the
    allowed sender with its arguments; refuses any other sender (and a
    missing event) without running it and answers with `onRefused`'s value;
    a send-only channel drops a foreign sender; the predicate is asked per
    message (window recreated); a registrar without predicate/refusal throws.
  - wiring (textual, kept on purpose — "which registrar a channel goes
    through" is a fact of the source): the set of channels preload.js
    invokes/sends equals the set main.js registers on `mainWindowIpc`
    (line-anchored, so a comment cannot count); the capsule preload's three
    verbs equal the `capsuleIpc` registrations; main.js has no direct
    `ipcMain.handle/on/once` except `API_TOKEN_CHANNEL`.
- `capsule-ipc.test.js`: its regex over `installRecordingStatusCapsuleIpc`
  (`ipcMain.on("verb", (event) => { if (!fromCapsule(event)) return;`) is
  replaced by the two tests above; the preload-path and packaging checks
  stay. `ipc-contract.test.js` / `recording-final-slot.test.js`: the
  channel-presence regexes now name `mainWindowIpc`.
- Break-it evidence:
  - guard `handle` without the check → "an invoke channel refuses any other
    sender…" fails (1 fail); restored → 8/8.
  - guard `on` without the check → "a send-only channel…" and "the
    predicate is asked on every message…" fail; restored.
  - main.js registers `permissions:repair` on `ipcMain.handle` directly →
    "every channel the preload uses…" and "nothing in main.js registers on
    ipcMain directly…" fail; same with the guarded line left in a `//`
    comment above the direct one → same two fail (the old test would have
    passed this one); restored → 8/8.
- Suites: desktop 490/490, frontend 649/649 (51 files), typecheck, lint,
  build, `node --check` main/preload: green.

## 2. Quit path (DM-19)

- New `desktop/quit-path.js`: `createQuitApp({ app, log, normalizeReason })`
  (main.js: `const quitApp = createQuitApp(...)`, so main.js itself calls
  `app.quit()` nowhere) and `installSignalQuitHandlers({ proc, log,
  markQuitting, killBackend, quitApp, exit, setTimer })`, which replaces
  main.js's `for (const sig of [...]) process.on(sig, ...)` loop. The
  250 ms escalation and 1500 ms forced-exit grace are now named
  (`SIGNAL_BACKEND_ESCALATE_AFTER_MS`, `SIGNAL_QUIT_GRACE_MS`) next to
  `SIGNAL_EXIT_CODES`. Behaviour unchanged.
- `desktop/quit-path.test.js` rewritten. Removed: the vacuous
  `assert.ok(calls.length >= 1)`, the "one `app.quit()` inside
  `topLevelFunctionSource("quitApp")`" count, and the regex for the signal
  handler's `quitApp(`signal-${sig}`)` text. Replaced by behaviour tests
  with fakes: quitApp logs the normalised reason, then calls `app.quit`
  once per call; each of SIGINT/SIGTERM/SIGHUP runs log → markQuitting →
  killBackend(escalate 250 ms) → quitApp(`signal-X`) and arms an unref'd
  forced exit with 128+n; a throwing quitApp exits at once.
  Kept textual (wiring): no non-comment line of main.js calls `app.quit(`
  (an absence claim — the comment-line filter can only make it stricter,
  a line starting with `//` or `*` is not code); main.js builds quitApp
  with createQuitApp and installs the handlers with `proc: process`, with
  no `process.on("SIG…")` of its own; the tray item's
  `click: () => quitApp("tray-quit")` (line-anchored).
- Break-it evidence: signal handler without the quitApp call → 2 tests
  fail; quitApp without `app.quit()` → "quitApp logs the reason, then asks
  Electron to quit" fails; the tray item changed to `app.quit()` in
  main.js → the wiring test fails; forced-exit timer removed → "each
  signal…" fails. Restored → 5/5.
- Suites: desktop 493/493, frontend 649/649, typecheck, lint, build,
  `node --check`: green.

## 3. Post-stop hand-off (DM-15 / S-13)

- New `desktop/post-stop-handoff.js`:
  - `awaitRecordingTranscript({ slot, recordingId, deadlineAt, now, onSignal })`
    — the wait loop that was inline in `processPostStopTask`
    (`consumeIpcSignal` + `restUntilSignalOr` + the `while`), unchanged in
    behaviour. It takes the recording's mailbox and nothing else, so "the
    IPC hand-off is the only source" is a property of its signature.
    main.js keeps what is its own in `onSignal`: the trace step and the
    "Upscaling" capsule status.
  - `decidePostStopAdmission(task, isAlreadyEnqueued)` →
    `POST_STOP_ADMISSION.{AUTO_TRANSCRIBE_OFF, NO_RECORDING_ID, DUPLICATE, ADMIT}`;
    `enqueuePostStopTask` branches on it (its side effects — the log
    lines, closing the session for a task without an id — are unchanged).
- `desktop/post-stop-handoff.test.js` rewritten. Removed: the regexes
  over `processPostStopTask`'s text (`task.slot.peek(...)` present;
  `queryRendererState(`, `POST_STOP_IPC_GRACE_MS|pollFallbackStarted|heardIpcSignal`,
  `state.status === "Done"`, `recordingId <= 0` absent) and over
  `enqueuePostStopTask`'s `if (!(task.recordingId > 0)) {`. Replaced by
  behaviour tests with a real `createRecordingFinalSlot` and a fake clock:
  a final published before the wait is the transcript with no wait; one
  published during the wait ends it, and the provisional before it is
  best-known only (each signal handled once, the upscaling verdict reaches
  `onSignal`); a provisional alone is never the transcript — the deadline
  hands it to the recovery; a terminal publish ends with its status; a
  dictation reading "HTTP 500 …" is still pasted (no text sniffing);
  nothing published → nothing; another recording's final is ignored; the
  admission order. Kept textual: `processPostStopTask` calls
  `awaitRecordingTranscript({ slot: task.slot, recordingId: task.recordingId, …`
  and contains no `queryRendererState(`/`executeJavaScript(` (absence);
  `enqueuePostStopTask` branches on each admission outcome and the
  no-id branch resets the status; `queryRendererState` has no
  `getElementById` / `__transcriptorFinishedRecords` (it is an
  executeJavaScript *string* — what it reads exists only as text).
- Neighbouring textual tests re-pointed, not weakened:
  `transcript-signal.test.js` "Upscaling on the verdict" now reads the
  `onSignal` block in `processPostStopTask`; "classifies through
  ./transcript-signal" now requires `./post-stop-handoff` (the
  classification itself is behaviour-tested above);
  `renderer-epoch.test.js` checks the task's slot reaches
  `awaitRecordingTranscript`.
- Break-it evidence: a provisional treated as the transcript → 2 tests
  fail; the handled-sequence bookkeeping removed → the loop re-handles one
  provisional forever and the file fails (times out); the
  `recordingId > 0` admission check removed → the admission test fails;
  main.js polling `queryRendererState()` beside the hand-off → the wiring
  test fails. Restored → 10/10.
- Suites: desktop 500/500, frontend 649/649, typecheck, lint, build,
  `node --check`: green.
