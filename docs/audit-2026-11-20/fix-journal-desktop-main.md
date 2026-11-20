# Fix journal — desktop/main.js lane (Ultra-Audit 2026-11-20)

Branch: `worktree-agent-a051537e22a866963` (fast-forwarded onto `main` bbce978 to get the audit docs).
Procedure: SKILL §7/§7.1 — each check was run against the pre-fix file (`git show HEAD:<path> > <path>`
inside `prove.sh`), the fix restored byte-for-byte (`diff -q`), and the check run again. Outputs below are the
`node --test` result lines, verbatim.

Baseline before any fix: `npm --prefix desktop test` → `ℹ tests 311 / ℹ pass 311 / ℹ fail 0`.

## Commits

### 6974957 → DM-01
- Files: `desktop/main.js`, `desktop/transcript-signal.js` (new), `desktop/transcript-signal.test.js` (new), `desktop/package.json` (build.files).
- Check: `node --test desktop/transcript-signal.test.js`
- Before (pre-fix main.js):
  ```
  ✔ a final transcript is pasted whatever words it contains
  ✔ the pre-upscale publish is best-known text, whatever words it contains
  ✔ no-speech is read from the phase or an exact placeholder, never from a substring
  ✔ a status or error publish ends the recording and its text is the status
  ✔ a transcript-kind publish the renderer did not mark final is waited past, not dropped
  ✔ the source label splits into kind and phase
  ✖ main.js classifies hand-off signals through ./transcript-signal and sniffs no text
  ℹ pass 6
  ℹ fail 1
  ```
- After:
  ```
  ✔ main.js classifies hand-off signals through ./transcript-signal and sniffs no text
  ℹ pass 7
  ℹ fail 0
  ```

### ea361c5 → DM-02, DM-26
- Files: `desktop/main.js`, `desktop/clipboard-lease.js` (new), `desktop/clipboard-lease.test.js` (new), `desktop/main-source.js` (new test helper), `desktop/package.json`
- Check: `node --test desktop/clipboard-lease.test.js`
- Before (pre-fix main.js):
  ```
  ✔ a chain of pastes shares the first snapshot and frees it after the last lease
  ✔ release is idempotent and settle releases only what was not handed off
  ✔ a throw between acquire and an outcome cannot strand the snapshot
  ✖ main.js: only the paste ladder writes the transcript, after snapshotting, with a finally
  ℹ pass 3
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: processPostStopTask must not write the clipboard before the ladder snapshots it
  ```
- After:
  ```
  ✔ a chain of pastes shares the first snapshot and frees it after the last lease
  ✔ release is idempotent and settle releases only what was not handed off
  ✔ a throw between acquire and an outcome cannot strand the snapshot
  ✔ main.js: only the paste ladder writes the transcript, after snapshotting, with a finally
  ℹ pass 4
  ℹ fail 0
  ```

### 24b611e → DM-03, DM-22
- Files: `desktop/main.js`, `desktop/recording-stop.js` (new), `desktop/recording-stop.test.js` (new), `desktop/package.json`
- Check: `node --test desktop/recording-stop.test.js`
- Before (pre-fix main.js):
  ```
  ✔ no answer to the state probe keeps the recording, its monitor and its paste target
  ✔ a stale stop keeps the recording and its paste target
  ✔ the paths that end the session clear the paste target
  ✖ main.js: the state probe reports silence as null and the stop decides through ./recording-stop
  ℹ pass 3
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: no answer must not be read as idle
  ```
- After:
  ```
  ✔ no answer to the state probe keeps the recording, its monitor and its paste target
  ✔ a stale stop keeps the recording and its paste target
  ✔ the paths that end the session clear the paste target
  ✔ main.js: the state probe reports silence as null and the stop decides through ./recording-stop
  ℹ pass 4
  ℹ fail 0
  ```

### 89b4c5d → DM-04
- Files: `desktop/main.js`, `desktop/windows-paste-fallback.js` (new), `desktop/windows-paste-fallback.test.js` (new), `desktop/package.json`
- Check: `node --test desktop/windows-paste-fallback.test.js`
- Before (pre-fix main.js):
  ```
  ✔ an hwnd target: the keystroke is sent only after a confirmed activation
  ✔ a pid target: the keystroke is sent only after a confirmed activation
  ✔ no window to activate means no script, and nothing hostile is interpolated
  ✖ main.js builds the fallback through ./windows-paste-fallback
  ℹ pass 3
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /buildPwshPasteFallbackScript\(/. Input:
  ```
- After:
  ```
  ✔ an hwnd target: the keystroke is sent only after a confirmed activation
  ✔ a pid target: the keystroke is sent only after a confirmed activation
  ✔ no window to activate means no script, and nothing hostile is interpolated
  ✔ main.js builds the fallback through ./windows-paste-fallback
  ℹ pass 4
  ℹ fail 0
  ```

### e5b2135 → DM-05
- Files: `desktop/main.js`, `desktop/renderer-toggle.js` (new), `desktop/renderer-toggle.test.js` (new), `desktop/package.json`
- Check: `node --test desktop/renderer-toggle.test.js`
- Before (pre-fix main.js):
  ```
  ✔ a press run in time is dispatched
  ✔ a press the renderer reaches after its deadline does nothing
  ✔ the deadline leaves the answer time to travel back inside main's budget
  ✖ main.js dispatches the press through ./renderer-toggle with the same budget
  ℹ pass 3
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /toggleDispatchScript\(\{ allowStart, startDetail, notAfter: toggleNotAfter\(\) \}\)/. Input:
  ```
- After:
  ```
  ✔ a press run in time is dispatched
  ✔ a press the renderer reaches after its deadline does nothing
  ✔ the deadline leaves the answer time to travel back inside main's budget
  ✔ main.js dispatches the press through ./renderer-toggle with the same budget
  ℹ pass 4
  ℹ fail 0
  ```

### 397b696 → DM-06
- Files: `desktop/main.js`, `desktop/engine-install-flight.test.js` (new)
- Check: `node --test desktop/engine-install-flight.test.js`
- Before (pre-fix main.js):
  ```
  ✖ installGigaamEngine claims engineInstall.inFlight before it awaits anything
  ✔ the shape: a concurrent invoke during the probe is refused
  ℹ pass 1
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: the claim happens on the synchronous turn, before any await
  ```
- After:
  ```
  ✔ installGigaamEngine claims engineInstall.inFlight before it awaits anything
  ✔ the shape: a concurrent invoke during the probe is refused
  ℹ pass 2
  ℹ fail 0
  ```

### c8564ac → DM-07, DM-11, S-12, DM-34
- Files: `desktop/main.js`, `desktop/data-dir.js` (new), `desktop/data-dir.test.js` (new), `desktop/package.json`
- Check: `node --test desktop/data-dir.test.js`
- Before (pre-fix main.js):
  ```
  ✔ the override wins, otherwise userData
  ✖ main.js resolves the data directory in exactly one place
  ✖ main.log follows the data directory instead of caching its first path (DM-07)
  ✖ the OneDrive re-home copies everything but what the shell regenerates (DM-34)
  ℹ pass 1
  ℹ fail 3
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: only dataDir() may read userData
    AssertionError [ERR_ASSERTION]: a cached log path outlives the OneDrive re-home
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /oneDriveMigrationEntries\(/. Input:
  ```
- After:
  ```
  ✔ the override wins, otherwise userData
  ✔ main.js resolves the data directory in exactly one place
  ✔ main.log follows the data directory instead of caching its first path (DM-07)
  ✔ the OneDrive re-home copies everything but what the shell regenerates (DM-34)
  ℹ pass 4
  ℹ fail 0
  ```

### 4819f41 → DM-08
- Files: `desktop/main.js`, `desktop/log-privacy.test.js` (new)
- Check: `node --test desktop/log-privacy.test.js`
- Before (pre-fix main.js):
  ```
  ✖ no trace or log line in main.js carries a preview of transcript text
  ✔ the paste and post-stop traces identify the text by length and digest
  ℹ pass 1
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /textPreview\s*:/. Input:
  ```
- After:
  ```
  ✔ no trace or log line in main.js carries a preview of transcript text
  ✔ the paste and post-stop traces identify the text by length and digest
  ℹ pass 2
  ℹ fail 0
  ```

### c1b0a18 → DM-09, DM-27
- Files: `desktop/main.js`, `desktop/backend-exit.js` (new), `desktop/backend-exit.test.js` (new), `desktop/package.json`
- Check: `node --test desktop/backend-exit.test.js`
- Before (pre-fix main.js):
  ```
  ✔ a code-0 exit nobody asked for restarts the backend
  ✔ crashes and signals restart; quitting never does
  ✔ a planned restart (handle released by a kill, app not quitting) restarts with any exit code
  ✔ a late exit of a replaced child leaves the live handle and spawns nothing
  ✖ main.js wires the backend exit through ./backend-exit and closes over its own child
  ℹ pass 4
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /const child = spawn\(/. Input:
  ```
- After:
  ```
  ✔ a code-0 exit nobody asked for restarts the backend
  ✔ crashes and signals restart; quitting never does
  ✔ a planned restart (handle released by a kill, app not quitting) restarts with any exit code
  ✔ a late exit of a replaced child leaves the live handle and spawns nothing
  ✔ main.js wires the backend exit through ./backend-exit and closes over its own child
  ℹ pass 5
  ℹ fail 0
  ```

### a0be23d → DM-15, S-13
- Files: `desktop/main.js`, `desktop/post-stop-handoff.test.js` (new)
- Check: `node --test desktop/post-stop-handoff.test.js`
- Before (pre-fix main.js):
  ```
  ✖ processPostStopTask reads only the IPC hand-off
  ✖ a task with no recording id is refused at admission, not left waiting
  ✖ the renderer snapshot the paste-last lookup reads carries no DOM ids
  ℹ pass 0
  ℹ fail 3
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: no renderer poll
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /if \(!\(task\.recordingId > 0\)\) \{/. Input:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /getElementById/. Input:
  ```
- After:
  ```
  ✔ processPostStopTask reads only the IPC hand-off
  ✔ a task with no recording id is refused at admission, not left waiting
  ✔ the renderer snapshot the paste-last lookup reads carries no DOM ids
  ℹ pass 3
  ℹ fail 0
  ```

### b3b4f7f → DM-32
- Files: `desktop/main.js`, `desktop/renderer-epoch.js` (new), `desktop/renderer-epoch.test.js` (new), `desktop/post-stop-handoff.test.js` (assertion follows the task's mailbox), `desktop/package.json`
- Check: `node --test desktop/renderer-epoch.test.js`
- Before (pre-fix main.js):
  ```
  ✔ a reload with pending work does not swallow the new page's recording 1
  ✔ the same recording on the same page is a duplicate
  ✔ the key set forgets only past its cap
  ✖ main.js keys both guards by epoch, never clears them, and gives each epoch its own mailbox
  ℹ pass 3
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /_enqueuedRecordingIds\.clear\(\)|_pastedRecordingIds\.clear\(\)/. Input:
  ```
- After:
  ```
  ✔ a reload with pending work does not swallow the new page's recording 1
  ✔ the same recording on the same page is a duplicate
  ✔ the key set forgets only past its cap
  ✔ main.js keys both guards by epoch, never clears them, and gives each epoch its own mailbox
  ℹ pass 4
  ℹ fail 0
  ```

### 139b862 → DM-17
- Files: `desktop/main.js`, `desktop/paste-target-routing.test.js` (new)
- Check: `node --test desktop/paste-target-routing.test.js`
- Before (pre-fix main.js):
  ```
  ✖ the paste ladder never empties a routed target before the no-target check
  ℹ pass 0
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /effectiveTarget = emptyCapturedPasteTarget\(\)/. Input:
  ```
- After:
  ```
  ✔ the paste ladder never empties a routed target before the no-target check
  ℹ pass 1
  ℹ fail 0
  ```

### f2b2181 → S-11, DM-23
- Files: `desktop/main.js`, `desktop/shortcut-runtime.js` (new), `desktop/shortcut-runtime.test.js` (new), `desktop/package.json`
- Check: `node --test desktop/shortcut-runtime.test.js`
- Before (pre-fix main.js):
  ```
  ✔ an update replaces every slot it carries, and an empty optional slot unbinds it
  ✔ a slot the update does not carry keeps its current value
  ✔ record and paste are required
  ✖ main.js: registrations bind the in-memory set; disk is read only to seed it
  ✖ main.js: a rejected update restores the bindings instead of waiting for the failsafe
  ℹ pass 3
  ℹ fail 2
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /if \(!activeShortcuts\) activeShortcuts = normalizeShortcutSet\(readShortcutsFromConfig\(\)\)/. Input:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /applyShortcutUpdate\(activeShortcuts, message\)/. Input:
  ```
- After:
  ```
  ✔ an update replaces every slot it carries, and an empty optional slot unbinds it
  ✔ a slot the update does not carry keeps its current value
  ✔ record and paste are required
  ✔ main.js: registrations bind the in-memory set; disk is read only to seed it
  ✔ main.js: a rejected update restores the bindings instead of waiting for the failsafe
  ℹ pass 5
  ℹ fail 0
  ```

### 2e9f9a7 → DM-07, DM-11 (follow-up: TDZ in three callers introduced by c8564ac)
- Files: `desktop/main.js`, `desktop/data-dir.test.js`
- Check: `node --test desktop/data-dir.test.js`
- Before (pre-fix main.js):
  ```
  ✔ the override wins, otherwise userData
  ✔ main.js resolves the data directory in exactly one place
  ✖ no local binding shadows dataDir() (a `const dataDir = dataDir()` throws in its TDZ)
  ✔ main.log follows the data directory instead of caching its first path (DM-07)
  ✔ the OneDrive re-home copies everything but what the shell regenerates (DM-34)
  ℹ pass 4
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /\b(?:const|let|var)\s+dataDir\b/. Input:
  ```
- After:
  ```
  ✔ the override wins, otherwise userData
  ✔ main.js resolves the data directory in exactly one place
  ✔ no local binding shadows dataDir() (a `const dataDir = dataDir()` throws in its TDZ)
  ✔ main.log follows the data directory instead of caching its first path (DM-07)
  ✔ the OneDrive re-home copies everything but what the shell regenerates (DM-34)
  ℹ pass 5
  ℹ fail 0
  ```

### b72d80d → DM-24, S-09
- Files: `desktop/main.js`, `desktop/shortcut-runtime.js`, `desktop/screenshot-hotkey-status.test.js` (new); check reverts both main.js and shortcut-runtime.js
- Check: `node --test desktop/screenshot-hotkey-status.test.js`
- Before (pre-fix main.js):
  ```
  ✖ the slot carries the probe's or the bind's refusal
  ✖ main.js probes the key at registration and reports a failed bind during a take
  ℹ pass 0
  ℹ fail 2
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /globalShortcut\.unregister\(canonical\)/. Input:
  ```
- After:
  ```
  ✔ the slot carries the probe's or the bind's refusal
  ✔ main.js probes the key at registration and reports a failed bind during a take
  ℹ pass 2
  ℹ fail 0
  ```

### d2decfe → DM-13, DM-25 (and DM-12's geometryPadding)
- Files: `desktop/main.js`, `desktop/capsule-geometry.js` (new), `desktop/capsule-geometry.test.js` (new), `desktop/package.json`
- Check: `node --test desktop/capsule-geometry.test.js`
- Before (pre-fix main.js):
  ```
  ✔ screen mode's wider pill gets a window that fits it from the first frame
  ✔ bounds are centred at the bottom of the work area
  ✔ a status or level tick of a visible capsule does not move it
  ✖ main.js: no measured-geometry channel, and updates place only when needed
  ℹ pass 3
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /__recording_capsule_geometry__/. Input:
  ```
- After:
  ```
  ✔ screen mode's wider pill gets a window that fits it from the first frame
  ✔ bounds are centred at the bottom of the work area
  ✔ a status or level tick of a visible capsule does not move it
  ✔ main.js: no measured-geometry channel, and updates place only when needed
  ℹ pass 4
  ℹ fail 0
  ```

### db58136 → DM-12
- Files: `desktop/main.js`, `desktop/main-dead-code.test.js` (new)
- Check: `node --test desktop/main-dead-code.test.js`
- Before (pre-fix main.js):
  ```
  ✖ no dead renderer probes restating the provider catalog
  ✖ the capsule payload carries only what the capsule reads
  ✖ no window-closed cleanup guarded by a condition that is always false there
  ℹ pass 0
  ℹ fail 3
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: getRendererProviderChoice is dead and duplicates the catalog
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /tone: presentation\.tone/. Input:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /if \(win && !win\.isDestroyed\(\) && win\.webContents\) \{\s*win\.webContents\.removeAllListeners/. Input:
  ```
- After:
  ```
  ✔ no dead renderer probes restating the provider catalog
  ✔ the capsule payload carries only what the capsule reads
  ✔ no window-closed cleanup guarded by a condition that is always false there
  ℹ pass 3
  ℹ fail 0
  ```

### dbbdcca → DM-19
- Files: `desktop/main.js`, `desktop/quit-path.test.js` (new)
- Check: `node --test desktop/quit-path.test.js`
- Before (pre-fix main.js):
  ```
  ✖ app.quit() is called only inside quitApp
  ✖ the tray and the signal handlers quit through quitApp
  ℹ pass 0
  ℹ fail 2
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: app.quit() outside quitApp:   app.quit(); |       app.quit(); |       click: () => app.quit()
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /click: \(\) => quitApp\("tray-quit"\)/. Input:
  ```
- After:
  ```
  ✔ app.quit() is called only inside quitApp
  ✔ the tray and the signal handlers quit through quitApp
  ℹ pass 2
  ℹ fail 0
  ```

### eba196a → DM-14 (main-side half), DM-21 ("1 Hz")
- Files: `desktop/main.js`, `desktop/recording-monitor.test.js` (new)
- Check: `node --test desktop/recording-monitor.test.js`
- Before (pre-fix main.js):
  ```
  ✖ the monitor keeps at most one renderer probe in flight
  ✖ no comment calls the ~5.5 Hz monitor a 1 Hz monitor
  ℹ pass 0
  ℹ fail 2
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /if \(probeInFlight\) return;\s*probeInFlight = true;/. Input:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /1 Hz (recording-state )?monitor/. Input:
  ```
- After:
  ```
  ✔ the monitor keeps at most one renderer probe in flight
  ✔ no comment calls the ~5.5 Hz monitor a 1 Hz monitor
  ℹ pass 2
  ℹ fail 0
  ```

### 99ed5a5 → DM-28
- Files: `desktop/main.js`, `desktop/ipc-sender.test.js` (new)
- Check: `node --test desktop/ipc-sender.test.js`
- Before (pre-fix main.js):
  ```
  ✖ every preload channel checks that the sender is the main window
  ℹ pass 0
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: engine:get-status must refuse other senders
  ```
- After:
  ```
  ✔ every preload channel checks that the sender is the main window
  ℹ pass 1
  ℹ fail 0
  ```

### 3d62b58 → DM-35
- Files: `desktop/main.js`, `desktop/capsule-permissions.test.js` (new)
- Check: `node --test desktop/capsule-permissions.test.js`
- Before (pre-fix main.js):
  ```
  ✖ the capsule window's session denies all permissions
  ℹ pass 0
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/. Input:
  ```
- After:
  ```
  ✔ the capsule window's session denies all permissions
  ℹ pass 1
  ℹ fail 0
  ```

### d491015 → DM-20
- Files: `desktop/main.js`, `desktop/timing-budgets.test.js` (new)
- Check: `node --test desktop/timing-budgets.test.js`
- Before (pre-fix main.js):
  ```
  ✖ the first window load waits for the backend cold start plus the page load
  ✖ restart policy, health polling, pip and stop deadlines are named, not literals
  ℹ pass 0
  ℹ fail 2
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: MAIN_WINDOW_INITIAL_LOAD_TIMEOUT_MS is not declared
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /attempt > 8\b/. Input:
  ```
- After:
  ```
  ✔ the first window load waits for the backend cold start plus the page load
  ✔ restart policy, health polling, pip and stop deadlines are named, not literals
  ℹ pass 2
  ℹ fail 0
  ```

### 7e7a54c → DM-29
- Files: `desktop/main.js`, `desktop/startup-boot.test.js` (new)
- Check: `node --test desktop/startup-boot.test.js`
- Before (pre-fix main.js):
  ```
  ✖ whenReady raises the startup event without awaiting the backend first
  ✔ createWindow starts the backend itself and owns the failure page
  ℹ pass 1
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /await startBackend\(\);/. Input:
  ```
- After:
  ```
  ✔ whenReady raises the startup event without awaiting the backend first
  ✔ createWindow starts the backend itself and owns the failure page
  ℹ pass 2
  ℹ fail 0
  ```

### 4502f2f → DM-16
- Files: `desktop/main.js`, `desktop/own-process-rules.test.js` (new)
- Check: `node --test desktop/own-process-rules.test.js`
- Before (pre-fix main.js):
  ```
  ✖ both target checks use one own-app rule derived from the app name
  ✖ the paste-last accelerator has one accessor
  ✖ activation settle constants are named for what they settle
  ℹ pass 0
  ℹ fail 3
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /app\.getName\(\)/. Input:
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /\bWIN_ACTIVATION_SETTLE_MS\b|\bX11_ACTIVATION_SETTLE_MS\b/. Input:
  ```
- After:
  ```
  ✔ both target checks use one own-app rule derived from the app name
  ✔ the paste-last accelerator has one accessor
  ✔ activation settle constants are named for what they settle
  ℹ pass 3
  ℹ fail 0
  ```

### cb31c13 → DM-31 (main side of S-02 / DX-03)
- Files: `desktop/main.js`, `desktop/screen-session-start.js` (new), `desktop/screen-session-start.test.js` (new), `desktop/package.json`
- Check: `node --test desktop/screen-session-start.test.js`
- Before (pre-fix main.js):
  ```
  ✔ a take that ended while its session was starting leaves an orphan to end
  ✔ the live take keeps its session; a silent renderer is not evidence of a stop
  ✔ a failed start is reported
  ✖ main.js reconciles the session after start and surfaces a failed start
  ℹ pass 3
  ℹ fail 1
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /decideAfterScreenStart\(\{/. Input:
  ```
- After:
  ```
  ✔ a take that ended while its session was starting leaves an orphan to end
  ✔ the live take keeps its session; a silent renderer is not evidence of a stop
  ✔ a failed start is reported
  ✔ main.js reconciles the session after start and surfaces a failed start
  ℹ pass 4
  ℹ fail 0
  ```

### 37bb6e5 → DM-10 (capsule half)
- Files: `desktop/main.js`, `desktop/capsule-preload.js` (new), `desktop/capsule-ipc.test.js` (new), `desktop/package.json`; check reverts main.js + package.json
- Check: `node --test desktop/capsule-ipc.test.js`
- Before (pre-fix main.js):
  ```
  ✖ the capsule page sets no magic titles; main intercepts none
  ✔ the capsule preload sends exactly the three verbs and exposes no raw ipcRenderer
  ✖ main listens on each verb, only from the capsule window, and the window loads the preload
  ℹ pass 1
  ℹ fail 2
  ✖ failing tests:
    AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /document\.title\s*=/. Input:
    AssertionError [ERR_ASSERTION]: The input did not match the regular expression /ipcMain\.on\("capsule:stop", \(event\) => \{\s*if \(!fromCapsule\(event\)\) return;/. Input:
  ```
- After:
  ```
  ✔ the capsule page sets no magic titles; main intercepts none
  ✔ the capsule preload sends exactly the three verbs and exposes no raw ipcRenderer
  ✔ main listens on each verb, only from the capsule window, and the window loads the preload
  ℹ pass 3
  ℹ fail 0
  ```

### 3cb32fc → H-03 (main.js part: the comment's claim)
- Files: `desktop/main.js` (doc of `RECORDING_STATUS_CAPSULE_ACTIVATE_SUPPRESS_MS`).
- Check: `grep -c "would otherwise raise the main window behind it"` / `grep -c "cannot stop macOS itself"` on HEAD~ vs HEAD.
- Before: `1` / `0`. After: `0` / `1`.

## Final state

- `npm --prefix desktop test` → `ℹ tests 390 / ℹ pass 390 / ℹ fail 0 / ℹ skipped 0` (baseline 311; +79 new checks in 27 new test files).
- `node --check desktop/main.js && node --check desktop/preload.js` → OK (also `desktop/capsule-preload.js`).
- Extra gate used before every commit after 2e9f9a7: ESLint (the frontend's binary, no config) with `no-undef`,
  `no-use-before-define` (same-scope TDZ), `no-unused-vars`, `no-shadow` over main.js, preload.js and every new module
  → 0 errors (7 pre-existing warnings: `net`/`backend` shadowing, unused eslint-disable directives).
- Nothing here was exercised in a live Electron (the worktree has no Electron binary: `ELECTRON_SKIP_BINARY_DOWNLOAD=1`),
  on Windows or on X11. Checks are pure-function tests of every extracted decision plus static wiring checks of main.js,
  the same technique `ipc-contract.test.js` uses. A live smoke of the capsule (stop/shot click — 37bb6e5) and of a
  cold start (7e7a54c, d491015) is the first thing to do on a real build.

## Decisions taken without asking (§7)

- **Р-DM-1.** The audit docs live only on `main` (bbce978); this branch was fast-forwarded onto it so the journal can
  sit next to them. No other branch touched.
- **Р-DM-2.** Wiring of main.js cannot be executed outside Electron, so each fix extracts its decision into a pure
  module (`desktop/<name>.js`, added to `build.files`) tested directly, plus a source-level check that main.js calls
  it — that check is the one that fails on the pre-fix main.js. Helper: `desktop/main-source.js` (test-only, not shipped).
- **Р-DM-3.** DM-01 reads kind/phase from the existing `source` label (`"<kind>:<phase>"`), because the payload
  validator (`recording-final-slot.js`) belongs to another lane; promoting them to explicit fields is listed below.
- **Р-DM-4.** DM-15/S-13: the poll was deleted (not gated). A renderer that never publishes now reaches the existing
  §6.9 deadline recovery instead of the poll's "Saved To App"; this is the only observable change and only for a
  renderer that breaks the protocol. Tasks without a positive recordingId are refused at admission.
- **Р-DM-5.** DM-28: `ipc-contract.test.js:195` (not this lane's file) pins the inline sender check of
  `screen-mode:finish`, so that handler and `recording-final` keep the inline spelling; the other four use one
  predicate. Listed below.
- **Р-DM-6.** DM-13 side effect: geometry titles used to arm the 700 ms activate suppression on every capsule show;
  with the geometry channel gone only real capsule pointer/stop/shot events arm it.
- **Р-DM-7.** 2e9f9a7 fixes a regression introduced by this lane's own c8564ac (`const dataDir = dataDir()` in three
  callers — TDZ throw on window-state, screen staging, reveal). Found by the ESLint gate; `data-dir.test.js` now forbids it.

## Not done (ID → reason)

- **DM-10, main-window half** (`__app_shortcuts__`, `__app_record_toggle__`, `__app_reveal_recording__` over
  document.title) → the renderer sets those titles (frontend/src/main.tsx `postTitleBridgeMessage`,
  `TITLE_BRIDGE_PREFIX` ≈ :931); switching needs the renderer to call preload sends. Main + preload side is a
  15-line change once the renderer moves (spec below). The capsule half is done (37bb6e5).
- **DM-14, push half** → the renderer must publish `{isRec, vu, rms, lastFrameAt, recordingId}` (≤10 Hz) over a
  preload send; until then main keeps the poll, now with a single probe in flight (eba196a).
- **DM-18** (four copies of SetForegroundWindow C#, per-call `Add-Type`) → the fix is new verbs (`ACTIVATE <hwnd>`,
  `SENDKEYS`) on the persistent PowerShell helper's FIFO protocol; it cannot be verified without Windows, and a broken
  activation verb types transcripts into the wrong window. The false "no C# compilation" comment went with DM-04.
- **DM-30 / S-14** (quit/close during a take or post-stop work) → hypothesis; any fix (confirm dialog, minimise
  instead) changes rule 4 of `window-lifecycle.js` ("close = quit", tested) — a product decision for the user.
- **DM-33** (English-only main-process copy) → needs a shared locale catalog and the UI language in main (renderer
  `ui-copy.ts` owns the strings and the language); cross-domain and a product decision on which strings move.
- **S-10** (shortcut status pushed into a window global, polled every 2 s) → needs the renderer to subscribe to a
  preload event and drop `_shortcutConflictPoll` (main.tsx ≈ :6355); a sender with no receiver is not added.
- **H-03** (voice-mode capsule click still lets macOS raise the main window) → needs the screen-mode tap-in-process
  approach for the voice capsule (native helper) or a CHANGELOG/lifecycle-doc correction — both outside this lane and
  needing macOS. main.js's own overclaiming comment is corrected (3cb32fc).
- **H-04, main.js part** → nothing to fix: no "non-activating panel", "exclusion rectangle", "prune list" or
  "non-focusable panel" wording exists in main.js (grep, verified); the stale wording is in PROJECT_STRUCTURE.md,
  screen-mode-controller.js, main.swift, window-lifecycle.js.
- **DM-21, docs part** → `docs/VERIFIED_AUDIT.md` cites `desktop/main.js:NNNN`; historical audit, not this lane's file.

## Cross-domain, for the lead

1. **frontend/src/main.tsx `recordingOutputIsInvalidTranscript`** (≈ :10720): `lower.startsWith("http ")` (and
   `lower === "error"`) refuses a dictation such as "HTTP server returns 500" as paste-ready — the renderer half of
   DM-01. Delete the text sniffing; mark non-transcripts with `kind`/`phase` at the publish site.
2. **Explicit kind/phase on the hand-off**: `recording-final-slot.js validateRecordingFinalPayload` + `preload.js
   recordingFinal` + the renderer's `publishRecordingOutput` should carry `kind` ("transcript"|"status"|"error") and
   `phase` as validated fields; then `transcript-signal.js parseSignalSource` reads them instead of the `source` label.
3. **Renderer globals main no longer reads** (DM-15): `__transcriptorFinishedRecords`,
   `__transcriptorLastFinishedAt/RecordingId`, `__transcriptorLastUiFinalAt/RecordingId`, and the snapshot fields
   `status`/`statusKind`/`busy` + DOM ids `finalOutput`/`liveOutput`/`progressRow` for post-stop. Main still reads
   `__transcriptorLastFinishedText`, `__transcriptorLastUiFinalText`, `__transcriptorLastUiFinalKind` (paste-last).
4. **DM-10 main-window half**: renderer → `window.transcriptor.shortcuts(message)` (`ipcRenderer.send("shortcuts:message", {action, record, paste, screen, screenShot})`),
   `recordToggle()` (`"record:toggle"`), `revealRecording({name, archiveDir})` (`"recording:reveal"`); main then
   `ipcMain.on` each with the main-window sender check and deletes its `page-title-updated` handler (main.js ≈ :8100).
5. **DM-14 + S-10 push channels**: renderer publishes recording state and subscribes to `shortcut-status`
   (main sends on change, like `system-suspend`); drop `window.__transcriptorShortcutStatus` and the 2 s poll.
6. **S-09 renderer special case**: main now fills `status.screenShot.{active,error}`; main.tsx ≈ :6325
   (`id === "screenShot" ? !entry.error : !!entry.active`) can use the same rule as the other slots.
7. **ipc-contract.test.js:195** pins the inline sender check of `screen-mode:finish`; relax it to accept
   `isFromMainWindow(event)` so all six preload channels share one predicate (DM-28).
8. **DX-03 / S-02 controller half**: `screen-mode-controller.js` should tombstone a finished id so a late
   `start(id)` no-ops; main now ends an orphaned session after start (cb31c13), the controller guard closes the race.
9. **H-03**: CHANGELOG.md:75 / window-lifecycle.js:39,136 overclaim ("the capsule never moves the main window");
   state the voice-mode limit or extend the tap-in-process approach to the voice capsule.
10. **recording-status.js `presentation.tone`**: no longer sent to the capsule (the capsule never read it).
11. **user-data-dir.test.js:134** decides "nothing reads userData before the spelling fix" by the first TEXTUAL
    occurrence; it forced `dataDir()` to be declared after the boot calls (hoisting makes position irrelevant).
12. **DM-16/DM-20**: the activation settle values (`APP_/WINDOW_ACTIVATION_SETTLE_MS`, `AUTO_SEND_ACTIVATION_SETTLE_MS`)
    belong in `paste-capability.js PASTE_BUDGET` with the other paste-path wall-clock numbers.
