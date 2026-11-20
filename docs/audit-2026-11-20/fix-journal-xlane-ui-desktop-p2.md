# Fix journal — cross-domain lane `ui-desktop-p2` (Ultra-Audit 2026-11-20)

Branch `worktree-agent-a522f964456e813d9`, cut from `main` at 3cc7666. Source: `docs/NEXT_SESSION_2026-11-20.md`
§3.2 "P2 — Рендерер / Desktop" and Appendix A. "Before" runs = the new/changed tests run against the HEAD sources
(`git archive HEAD` into the scratchpad, new test files copied over).

## Commit 1 · DM-10/FU-10/K-1, DM-14/S-10/FU-08, S-09, DM-28 (part of DX-28 #2), kind/phase on the hand-off, DM-15, FU-15

One commit: the renderer half of all of these lives in interleaved hunks of `frontend/src/main.tsx`, and every
intermediate state would have needed its own full verification run on a shared, rationed machine.

- **DM-10 / FU-10 / K-1** — `document.title` is no longer IPC. New pure module `desktop/renderer-requests.js`
  (`RENDERER_REQUEST_CHANNELS`, `parseShortcutMessage`, `resolveRevealTarget` — the action allow-list, slot trimming,
  the 1.1.25 traversal rule, the home-boundary rule and the recording-roots rule, moved verbatim out of the
  `page-title-updated` handler). `preload.js` exposes `transcriptor.shortcuts(message)` → `"shortcuts:message"`,
  `recordToggle()` → `"record:toggle"`, `revealRecording({name, archiveDir})` → `"recording:reveal"`. `main.js`
  registers `ipcMain.on` for each next to the other channels with `isFromMainWindow(event)`; the
  `page-title-updated` handler is deleted. Renderer: `TITLE_BRIDGE_PREFIX`, `postTitleBridgeMessage`, the nonce, the
  restore timer, `window.__transcriptorRevealRecording` and `installRevealRecordingBridge` are gone;
  `revealRecordingInFolder()` calls the preload, `hostCanRevealFiles()` asks for the preload's `revealRecording`.
- **DM-14 / S-10 / FU-08 (shortcut half)** — `publishShortcutStatusToRenderer` sends `"shortcut-status"` with
  `webContents.send` (on change + replay on did-finish-load) instead of writing `window.__transcriptorShortcutStatus`;
  preload `onShortcutStatus(cb)` returns an unsubscribe; renderer subscribes once and paints. `_shortcutConflictPoll`,
  the global and the extra refresh in `switchView` are deleted.
- **S-09** — `shortcutBadge` decides every slot by one rule (an error main reported); the `screenShot` special case
  and the now-unused `slotId` parameter are gone. Side effect, intended: an optional slot left empty is no longer
  badged "Not registered: unknown reason".
- **DM-28 / DX-28 #2** — `screen-mode:finish` and `recording-final` use `isFromMainWindow(event)` like the others;
  the indentation-exact regex in `ipc-contract.test.js` is gone, `ipc-sender.test.js` requires the one predicate and
  forbids the inline spelling, and covers the three new channels.
- **Explicit kind/phase** — `validateRecordingFinalPayload` requires `kind` ∈ `RECORDING_SIGNAL_KINDS`
  ("transcript"|"status"|"error") and accepts `phase` "" or a lowercase token; anything else rejects the payload.
  `source` is dropped from the contract. `transcript-signal.js` reads `s.kind`/`s.phase`; `parseSignalSource` is
  deleted. Preload copies `kind`/`phase`; renderer `publishRecordingOutput` sends `kind: kind || "status"`,
  `phase: signal.phase || ""`. main.js logs `kind=… phase=…`.
- **DM-15** — verified by grep over `desktop/`: `__transcriptorFinishedRecords`, `…LastFinishedAt/RecordingId`,
  `…LastUiFinalAt/RecordingId` were already removed by the desktop-main lane (pinned in
  `renderer-main-contract.test.ts`). Left: the `LiveStatusSnapshot` fields `status`, `statusKind`, `busy` (no reader)
  and `recording`, `recordingId` (main reads the globals, never the snapshot) — deleted. The DOM ids
  `finalOutput`/`liveOutput`/`progressRow` are the renderer's own UI, not a main-facing surface: unchanged.
- **FU-15 — user decision 2026-11-20: remove None.** The Live toolbar's "None" option is deleted, with every path
  that existed only for it: `WireProvider` no longer includes `""`; `uiProviderGroup`, `readProviderGroup`,
  `setTranscriptionSelection`, `wireProviderForGroup`, `isLocalGroup`, `defaultModelForGroup` take a real group;
  `LiveWsMode` lost `"none"` and startLive's "Recording audio only. No transcription provider is selected." branch
  (the WS block is dedented, no logic change); stopLive lost its "no provider selected" exit (D-13 count 6 → 5);
  `resolveEffectiveProvider`/`getRemoteModelValue` lost their `""` guards. **Migration:** `normalizeProviderSelection`
  maps a stored `""` (or anything unrecognised) to the fallback, i.e. the default provider; `loadCfg` reads through it
  and the next autosave persists the migrated value. Upload items keep "provider not known yet" as `undefined`
  (`isProviderId` check) rather than `""`. The capsule vocabulary entry for the removed copy is deleted
  (`desktop/recording-status.js`).
- Files: `desktop/{renderer-requests.js,renderer-requests.test.js,main.js,preload.js,recording-final-slot.js,
  recording-final-slot.test.js,transcript-signal.js,transcript-signal.test.js,ipc-contract.test.js,ipc-sender.test.js,
  recording-status.js,package.json}`, `frontend/src/{main.tsx,shortcut-display.ts,providers.ts,transcription-catalog.ts}`,
  `frontend/tests/{shortcut-display,providers,transcription-catalog,renderer-main-contract}.test.ts`,
  `PROJECT_STRUCTURE.md`.
- Before (HEAD sources, new desktop tests), exit 1 — `ℹ pass 31 / ℹ fail 11`:
  ```
  ✖ renderer-requests.test.js                      (module did not exist)
  ✖ the main window's requests ride preload sends, not document.title (DM-10)
  ✖ shortcut-status is pushed by main and subscribed to by the renderer bridge (DM-14 / S-10)
  ✖ every preload channel checks that the sender is the main window
  ✖ validator accepts the contract shape and drops unknown keys
  ✖ validator accepts a provisional payload and an empty text
  ✖ validator requires an explicit kind and a well-formed phase (no label parsing)
  ✖ kind and phase are read from their own fields, not from a label
  ✖ the pre-upscale publish is best-known text, whatever words it contains
  ✖ the pre-upscale publish puts the capsule in Upscaling; nothing else does
  ✖ a transcript-kind publish the renderer did not mark final is waited past, not dropped
  ```
  Before (HEAD `shortcut-display.ts` / `providers.ts`), exit 1 — `Tests 3 failed | 21 passed (24)`:
  ```
  × S-09: decides every slot by one rule — an error main reported — so it needs no slot id
  × FU-15 (user decision 2026-11-20: remove None): a stored "" migrates to the default provider
  ```
  (a third × was an artifact of the harness passing `"record"` as the old slot id.)
- After: desktop `ℹ tests 433 · pass 433 · fail 0`; frontend `Test Files 47 passed · Tests 601 passed`; typecheck,
  lint, build clean; `node --check` main/preload OK.
- Not done in this commit: the DM-14 recording-state push (see "Not done").

## Commit 2 · DX-26, DX-12, DX-25, DX-28 #1, DM-16/DM-20, FU-13c, FQ-14 (a, desktop half), FQ-22(5), H-03 (docs)

- **DX-26** — `paste-protocol.js` builds the complete Windows marker lines once (`VBS_PASTE_OK`, `VBS_PASTE_SENT`,
  `PWSH_PASTE_OK`, `PASTE_ERR_ACTIVATE`); main.js's VBS, `windows-paste-fallback.js` and `paste-result.js` use them.
  No `"OK:vbs-paste"` / `"OK:pwsh-paste"` / `"ERR:activate"` literal left in main.js.
- **DX-12** — `screen-mode-controller.js` owns the stacking (`SCREEN_MODE_LAYERS`: "screen-saver", overlay 0 <
  palette 1 < capsule 2; main.js lifts the capsule with it) and takes the capsule's geometry as
  `deps.capsuleLayout = {bottomMargin, height}` from main's `RECORDING_STATUS_CAPSULE`. The palette fallback is the
  pure `paletteBoundsFor` — no literal `54`.
- **DX-25** — dev helper path is `native/build/mac-arm64`, the only macOS target `build-native.sh` builds; the
  packaging test derives that target from the script and requires main.js to use it.
- **DX-28 #1** — `ipc-contract.test.js` no longer text-matches the power subscription: it checks the call sits at
  brace depth 1 of the `app.whenReady` callback (a comment/string/template-aware counter) and RUNS main's own call
  text against a fake `powerMonitor`, asserting every `POWER_EVENTS` entry is subscribed and reaches the handler
  main wired (resume → reclaim, suspend/lock-screen → release with the event name). (#2 was done in commit 1.)
- **DM-16 / DM-20** — `appActivationSettleMs` (350), `windowActivationSettleMs` (180), `autoSendActivationSettleMs`
  (110) are fields of every `PASTE_BUDGET` row (one declaration each, spread into the rows); main.js reads them via
  `activationSettleMs(kind)`. `pasteBudgetWorstCaseMs` now counts one settle per attempt where the ladder
  re-activates (win32 28 930 ms, linux 30 210 ms, darwin 26 435 ms — all inside `PASTE_POST_STOP_DEADLINE_MS` 32 000,
  asserted).
- **FU-13c** — `DEFAULT_RECORDING_AUTO_STOP_CONFIG` is gone. New pure `desktop/auto-stop-config.js`
  (`parseAutoStopConfig`, `AUTO_STOP_OFF`): main applies the renderer's published setting or nothing. Behaviour
  difference: a renderer answer that is enabled but has unusable numbers now means "off" instead of main's private
  2 s / −42 dB (the renderer clamps every value it publishes, so this does not occur in practice).
  `frontend/tests/auto-stop-silence.test.ts`'s cross-check of the copy becomes "there is no copy".
- **FQ-14 (a), desktop half** — main sends `__setBackendBootError({code, raw})`; codes `BACKEND_BOOT_ERROR_CODES`
  (PYTHON_MISSING, RUNTIME_UNAVAILABLE, BACKEND_EXITED, BACKEND_SPAWN_FAILED, APP_STARTUP_FAILED) set only through
  `failBackendBoot`. Renderer `classifyBootError(raw, code)` decides PYTHON_MISSING by code and no longer matches
  main's own sentence; Python/OS stderr in `raw` is still classified as text. A contract test pins the code names on
  both sides. **(e)** (inline `style.*` on the disclosure) not done — see Not done.
- **FQ-22(5)** — failure paths call `retireBackendBootStatusAfterFailure()` (drops the replayed status) instead of
  `setBackendBootStatus("")`, which the renderer reads as success ("Ready"). Only the health-OK path sends "".
- **H-03 (docs)** — `window-lifecycle.js` rule 5 now says the APP never moves the window and points at the stated
  limit; CHANGELOG [Unreleased] gets a correction entry and the 1.6.4 bullet a pointer to it. The native-helper
  change was not attempted (lead's brief).
- Files: `desktop/{paste-protocol,paste-result,windows-paste-fallback,screen-mode-controller,paste-capability,
  auto-stop-config,window-lifecycle,main}.js`, tests `desktop/{paste-result,screen-mode-controller,packaging,
  ipc-contract,paste-capability,own-process-rules,auto-stop-config,startup-boot}.test.js`, `desktop/package.json`,
  `frontend/src/{boot-error.ts,main.tsx}`, `frontend/tests/{boot-error,auto-stop-silence,renderer-main-contract}.test.ts`,
  `CHANGELOG.md`, `PROJECT_STRUCTURE.md`.
- Before (HEAD 8a9bc6b sources, new tests; unrelated packaging failures caused by the partial archive omitted):
  ```
  ✖ the markers the Windows scripts print are the ones the parser accepts
  ✖ the palette sits above where the capsule is, or would be, from the injected capsule layout
  ✖ the overlay, palette and capsule layers are one ordered fact
  ✖ the helper's place in the bundle is one fact across build-native.sh, package.json, main.js and afterPack
  ✖ the activation settles live in PASTE_BUDGET and are counted in the worst case
  ✖ auto-stop-config.test.js            (module did not exist)
  ✖ only the success path sends an empty boot status; failures carry a code
  ```
  frontend (HEAD `boot-error.ts`): `Tests 3 failed | 4 passed (7)` —
  `× FQ-14 (a): main's own failures are told apart by code…`, `× the codes are the ones desktop/main.js sends`
  (+1 TypeError from the missing export). The DX-28 #1 power test passes on HEAD too: it is a test rewrite (text
  match → depth + behaviour), not a behaviour change.
- After: desktop `ℹ tests 441 · pass 441 · fail 0`; frontend `Test Files 47 passed · Tests 603 passed`; typecheck,
  lint, build clean; `node --check` OK.
