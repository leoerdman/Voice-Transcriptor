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

## 4. Recording-state monitor (DM-14) and capsule permissions (DM-35)

- Monitor: `startRecordingStateMonitor` no longer hand-writes a
  `probeInFlight` flag; its tick runs the one `executeJavaScript` probe
  through `createSingleFlight().tryRun(...)` — the helper the engine
  install already uses and single-flight.test.js tests under concurrency.
  Side effect, a fix: a probe that throws synchronously (webContents gone
  mid-tick) used to throw out of the interval callback with the flag left
  `true`, wedging the monitor for the rest of the take; tryRun turns it
  into a rejected run that releases the flight.
  `recording-monitor.test.js`: the regex
  `if (probeInFlight) return;\s*probeInFlight = true;` / `.finally(...)`
  is replaced by behaviour tests of the shipped helper in the tick's
  shape (three ticks while a probe is pending start one probe; the next
  tick after it settles starts another; a synchronously-throwing probe
  does not wedge it) and a wiring check (the tick's one
  `executeJavaScript` is inside `probeFlight.tryRun(`; no `probeInFlight`
  flag). Honest scope: the behaviour proven is the helper's; that the
  monitor uses it is the wiring check. The "no comment calls it a 1 Hz
  monitor" absence test is kept (a wording, textual by nature).
- Capsule permissions: new `desktop/session-permissions.js`
  `denyAllSessionPermissions(session)`; `ensureRecordingStatusCapsuleWindow`
  calls it. `capsule-permissions.test.js`: the two regexes over the
  handler text are replaced by a fake session — every request (media,
  clipboard-read, notifications, geolocation, openExternal, unknown) is
  answered `false`, every check is `false`, both handlers are installed —
  plus a line-anchored wiring check.
- Break-it evidence: single-flight without its `if (inFlight) return null`
  → the tick test fails; the monitor's probe taken out of
  `probeFlight.tryRun` → the wiring test fails; `callback(true)` → the
  permissions test fails; the check handler not installed → same; the
  `denyAllSessionPermissions(...)` call commented out in main.js → the
  wiring test fails. Restored → green.
- Suites: desktop 503/503, frontend 649/649, typecheck, lint, build,
  `node --check`: green.

## 5. Timing budgets (DM-20), second test

- The crash-restart policy moves into `desktop/backend-exit.js`
  (`BACKEND_RESTART_MAX_ATTEMPTS/BACKOFF_STEP_MS/BACKOFF_MAX_MS`,
  `backendRestartPlan(attempt)` → `{ giveUp }` or `{ giveUp: false, delayMs }`);
  main.js's backend exit handler asks it instead of computing
  `attempt > MAX` and `Math.min(step * attempt, max)` inline. Same numbers.
- `timing-budgets.test.js` second test: six `doesNotMatch` regexes (pass
  when the code is deleted) replaced by
  - behaviour: attempts 1..10 → 800, 1600, 2400, 3200, 4000, 4800, 5000,
    5000, give up, give up; plus a check that main.js schedules
    `restartPlan.delayMs` and gives up on `restartPlan.giveUp`;
  - positive textual (naming is a fact of the text): each remaining
    budget is declared once with its value and the call site waits for it
    (`setTimeout(tick, BACKEND_HEALTH_RETRY_MS)`,
    `timeoutMs: ENGINE_PIP_INSTALL_TIMEOUT_MS`,
    `const deadlineMs = GUARDED_STOP_DEADLINE_MS`, `pointerLockMs: 80`
    used by the capsule's pointer lock) — deleting or inlining a call
    site now fails, which the old negatives did not.
  The first test (cold-start budget = health + page load) was already
  positive; kept.
- Break-it evidence: cap off by one (`>=`) → the policy test fails; the
  ceiling dropped → fails; main.js scheduling a fixed `1000` instead of
  the plan → fails; the health-poll `setTimeout(tick, …)` line deleted →
  the naming test fails. Restored → green.
- Suites: desktop 504/504, frontend 649/649, typecheck, lint, build,
  `node --check`: green.

## 6. Own-process rules (DM-16)

- New `desktop/own-process.js`: `createOwnProcessRules({ appName, pid })`
  → `{ isOwnAppName, isBadActivationTarget, shouldUsePasteTarget }`, moved
  verbatim from main.js; main.js takes the two it calls from it
  (`appName: () => app.getName(), pid: process.pid`).
- `own-process-rules.test.js` first test: the regexes
  (`isOwnAppName` contains `app.getName()`, the two checks contain
  `isOwnAppName(n)` / `isOwnAppName(name)`) replaced by behaviour: exact
  name and helper only, never a substring ("Audio Transcriptor Pro" is not
  us); a renamed app ("Dictate") changes what is "own" — the proof that no
  product name is retyped; activation refuses own family, bare Electron
  and Electron helpers only; a paste target is neither this pid nor our
  app nor unidentified. Wiring kept textual: main.js builds the rules from
  `app.getName()` / `process.pid`, has no second copy of the functions,
  and no `=== "transcriptor"` literal.
- Break-it evidence: substring match instead of exact → 2 tests fail;
  the app name hard-coded to "transcriptor" → the rename test fails; the
  own-pid check removed → the paste-target test fails; activation no
  longer asking isOwnAppName → 2 tests fail. Restored → 7/7.
- Suites: desktop 508/508, frontend 649/649, typecheck, lint, build,
  `node --check`: green.

## Kept as textual (why)

- `ipc-sender.test.js` / `ipc-contract.test.js` / `recording-final-slot.test.js`
  channel lists: which channel name is registered on which registrar, and
  that preload and main spell it the same, is a fact of two source files
  that cannot be loaded together outside Electron.
- `main-dead-code.test.js` (all three): absence claims — "this dead
  function / payload field / cleanup is not present". A behaviour test
  cannot show that code does not exist. They are deliberately negative;
  the review's "passes if the code is deleted" is the point here (the
  claim is that it was deleted).
- `log-privacy.test.js`: "no `textPreview:` / `preview: compactLogText(`"
  is an absence claim; "the paste and post-stop traces carry `textLen` /
  `textDigest(text)` / `digest: textDigest(transcript)`" would need
  `runPasteLadder` (AppleScript, clipboard, activation) extracted to run
  it with fakes — not worth it for a field name; positive and scoped to
  the function, so it fails if the trace step is deleted.
- `capsule-ipc.test.js` remaining two tests: the capsule page's HTML is a
  string main.js builds (no `document.title =`, calls `window.__capsule.*`);
  the preload sends exactly three fixed verbs and exposes no raw
  ipcRenderer — both texts of files that only run inside Electron.
- `own-process-rules.test.js` tests 2–3 (one accessor of the paste-last
  accelerator, settle constants named for what they settle), `timing-budgets`
  naming checks, `recording-monitor`'s "no 1 Hz wording", and
  `post-stop-handoff`'s `queryRendererState` has no DOM ids (its probe is
  an executeJavaScript *string*): naming / one-reader / wording facts.
- `startup-boot.test.js`: see Not done.
- `frontend/tests/renderer-main-contract.test.ts`: untouched. The review's
  named weak pins ("exactly two `saveRecordingText({`",
  "`isArchiveMutationConflict` count 1") are already gone — the ui lane
  replaced them with `createSessionMetadataSaver` in ./stop-epilogue,
  behaviour-tested in stop-epilogue.test.ts (the title that reaches the
  save, review #1), plus a wiring check of what stopLive hands it. The
  remaining counts ("one `kind: "transcript"` delivery", "five
  `endWithoutTranscript` exits through one epilogue", "`session-stop`
  observed once") are DRY/structure claims about stopLive's text; their
  behaviour (the epilogue, the saver) is already module-tested. Turning
  the rest into behaviour tests means extracting stopLive pieces from
  main.tsx, which a parallel lane (FQ-06, FL-08, S-15) is editing — out of
  scope for this lane by instruction.

## Not done

- `startup-boot.test.js` stays grep-based: "whenReady raises the startup
  event without awaiting startBackend", "createWindow starts the backend
  itself", "exactly one `setBackendBootStatus("")` after a healthy
  `/api/health`", "five `failBackendBoot(CODE` sites", "only failBackendBoot
  writes `backendBootError`". A behaviour test needs the boot sequence
  (whenReady → createWindow → startBackend → health → status/error
  broadcast) extracted into a module with injected window, backend and
  health check — a refactor of the startup path larger than this lane's
  remit and risky without a run of the app. Suggested shape: a
  `createBootStatus({ publish })` owning `progress(msg)` (non-empty only),
  `ready()` (the one empty status) and `fail(code, raw)`, with main.js's
  boot steps calling it.
- `log-privacy` positive checks (see above) and the renderer contract's
  structural counts.
- No app run: every change is covered by the desktop suite only
  (main.js cannot be loaded outside Electron). The extracted functions
  are moved verbatim except where noted (the monitor's synchronous-throw
  fix).
