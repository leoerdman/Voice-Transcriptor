const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, systemPreferences, dialog, clipboard, shell, screen } = require("electron");
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const shortcutDefaultsManifest = require("./shortcut-defaults.json");
// SSOT for cross-platform accelerator canonicalisation — required by
// main.js and unit-tested directly (desktop/accelerator.test.js).
const { canonicalAcceleratorForPlatform } = require("./accelerator");
// One declaration of "this stored hotkey pair is retired" — see
// desktop/shortcut-migration.js.
const { migrateShortcutPair } = require("./shortcut-migration");
// wmctrl -x joins X11's two WM_CLASS strings with a dot and gives no way to
// tell where the join is — see desktop/linux-wm-class.js.
const { parseLinuxWmClass } = require("./linux-wm-class");
// SSOT for the name of the directory this app keeps its data in, and
// for what to do about one left behind under the previous spelling —
// see desktop/user-data-dir.js.
const {
  USER_DATA_MIGRATION,
  userDataDirName,
  decideUserDataMigration,
  userDataDirCandidates,
} = require("./user-data-dir");
const { formatConsoleMirrorLine, createConsoleMirrorLimiter } = require("./renderer-console");
// SSOT for every main-window transition: what to do on activate, close,
// minimise, quit, second-instance and capsule-shown, and where the window
// goes when it is shown. Pure decisions — see desktop/window-lifecycle.js.
const {
  WINDOW_LIFECYCLE_EVENTS,
  WINDOW_LIFECYCLE_ACTIONS,
  decideWindowAction,
  decideMainWindowBounds,
  normalizeStoredWindowState,
} = require("./window-lifecycle");
// SSOT for "did this paste attempt actually succeed, and is it verified
// enough to trust restoring the clipboard afterward" (BUGS_AUDIT
// 2026-09-03 §6.1/§6.4/§6.6) — unit-tested by desktop/paste-result.test.js.
const { MAC_VERIFICATION, evaluatePasteOutcome } = require("./paste-result");
// SSOT for the AppleScript the macOS paste runs, in both its verifying
// and non-verifying shape, and for escaping anything interpolated into
// an AppleScript — unit-tested by desktop/paste-script.test.js.
const { robustPasteScript, menuPasteFallbackScript, escapeAppleScriptString } = require("./paste-script");

// SSOT for the paste wire protocol — the markers the paste scripts
// print and every parser reads.
const { AX_TRACE_PREFIX, PASTE_SENT_PREFIX } = require("./paste-protocol");
// SSOT for "is it worth verifying a paste into THIS app" — the per-target
// memory that stops paying for accessibility reads an app can never
// answer (BUGS_AUDIT 2026-09-03 §6.6) — unit-tested by
// desktop/paste-verification-policy.test.js.
const {
  PASTE_VERIFICATION_OUTCOME,
  pasteVerificationKey,
  createPasteVerificationPolicy,
  summarizeAxReadTrace,
} = require("./paste-verification-policy");

// What the script's verification suffix teaches the policy. Only
// ":unreadable" — a read that returned nothing at all — is evidence that
// this app cannot be verified; ":unverified" (reads landed, growth did
// not match) is inconclusive and changes nothing.
const MAC_VERIFICATION_TO_POLICY_OUTCOME = Object.freeze({
  [MAC_VERIFICATION.VERIFIED]: PASTE_VERIFICATION_OUTCOME.VERIFIED,
  [MAC_VERIFICATION.UNREADABLE]: PASTE_VERIFICATION_OUTCOME.UNREADABLE,
  [MAC_VERIFICATION.UNVERIFIED]: PASTE_VERIFICATION_OUTCOME.INCONCLUSIVE,
  [MAC_VERIFICATION.NONE]: PASTE_VERIFICATION_OUTCOME.ERROR,
});
// SSOT for "can this machine paste at all right now" (the stale
// post-update Accessibility grant that AXIsProcessTrusted still reports
// as trusted), for the retry/timeout budget the paste ladder spends, and
// for the modifier-release wait the paste-last hotkey needs — unit-tested
// by desktop/paste-capability.test.js.
const {
  PASTE_CAPABILITY,
  PASTE_PERMISSION_ROUTE,
  classifyPastePermissionFailure,
  pasteActivationTimeoutMs,
  pasteAutoSendTimeoutMs,
  pasteAutoSendSettleMs,
  PASTE_PROBE_COMMAND,
  PASTE_POST_STOP_DEADLINE_MS,
  initialPasteCapability,
  applyProbeResult,
  applyPasteOutcome,
  shouldAttemptPaste,
  shouldProbe,
  mustProbeBeforePaste,
  pasteCapabilityMessage,
  TCC_SERVICE,
  PERMISSION_REPAIR,
  PERMISSION_REPAIR_SERVICES,
  detectBundleReplacement,
  preferSpecificFailureReason,
  planPermissionRepair,
  permissionRepairCommand,
  permissionRepairMessage,
  parseBundleIdentity,
  pasteBudgetFor,
  pasteAttemptDelayMs,
  pasteMethodTimeoutMs,
  planModifierRelease,
  modifierReleaseCommand,
  parseModifierReleaseResult,
  heldModifiersFromFlags,
} = require("./paste-capability");
// SSOT for the renderer → main transcript hand-off: the shape of a
// "recording-final" IPC payload and the per-recordingId mailbox the
// post-stop task waits on (BUGS_AUDIT 2026-09-03 §6.7/§6.8/§6.9) —
// unit-tested by desktop/recording-final-slot.test.js.
const { createRecordingFinalSlot } = require("./recording-final-slot");

// SSOT for "which system power events the app reacts to, and what each
// one means" — subscribed exactly once from app.whenReady below.
const { subscribePowerEvents } = require("./power-events");

// SSOT for "what state is the recording capsule in": one kind, from
// which the capsule's mode and tone are both derived.
const {
  RECORDING_STATUS_KIND,
  recordingStatusIsLive,
  recordingStatusPresentation,
} = require("./recording-status");

// SSOT for the interpreter version: `.python-version` at the repo root, the
// same file prepare-runtime.sh builds the bundled runtime from and CI installs.
const { readPythonVersion } = require("./python-version");

// SSOT for how a child process's text output is produced and decoded —
// the PowerShell UTF-8 prelude and the `cscript //U` UTF-16LE receipt.
const { childStreamEncoding, stripBom, withUtf8OutputPrelude } = require("./child-io");

const MIRROR_RENDERER_TRACE_LOGS =
  process.env.TRANSCRIPTOR_RENDERER_TRACE_LOGS === "1" ||
  process.env.NODE_ENV === "development";

const BACKEND_RUNTIME_IMPORTS = Object.freeze([
  "fastapi",
  "uvicorn",
  "multipart",
  "cryptography",
  "faster_whisper",
  "soundfile",
  "numpy",
  "requests",
  "websockets",
]);
const BACKEND_RUNTIME_IMPORT_CHECK = `import ${BACKEND_RUNTIME_IMPORTS.join(", ")}`;
const PYTHON_ENV_SCRUB_KEYS = Object.freeze([
  "PYTHONPATH",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "PYTHONUSERBASE",
]);
const RUN_COMMAND_OUTPUT_MAX_CHARS = 1024 * 1024;

// canonicalAcceleratorForPlatform lives in ./accelerator (SSOT — the
// unit-tested module required at the top of this file).

function shortcutDefaultsForPlatform(platform = process.platform) {
  const platformDefaults = shortcutDefaultsManifest?.platformDefaults || {};
  const defaults = platformDefaults[platform] || platformDefaults.default || {};
  return {
    record: String(defaults.record || "").trim(),
    paste: String(defaults.paste || "").trim(),
  };
}

// Register process-level crash handlers IMMEDIATELY — the previous
// registration happened inside app.whenReady().then(...), meaning any
// module-load-time crash (in requestSingleInstanceLock or other
// top-level fs/path calls) terminated the process with no log trace
// because appendMainLog requires app.getPath('userData') which isn't
// ready yet. Fall back to console.error for the pre-ready window.
let fatalMainExitScheduled = false;
function exitAfterFatalMainProcessError(reason) {
  if (fatalMainExitScheduled) return;
  fatalMainExitScheduled = true;
  try { isQuitting = true; } catch { }
  try {
    if (typeof killBackendHard === "function") {
      killBackendHard(reason || "fatal main-process exception");
    }
  } catch { }
  const exitNow = () => {
    try { app.exit(1); } catch { process.exit(1); }
  };
  try { setImmediate(exitNow); } catch { exitNow(); }
  try {
    const timer = setTimeout(() => process.exit(1), 1500);
    timer.unref?.();
  } catch { }
}
process.on("uncaughtException", (err) => {
  try {
    if (typeof appendMainLog === "function") {
      appendMainLog(`[uncaughtException] ${err?.stack || err?.message || String(err)}`);
    }
  } catch { /* appendMainLog may not be defined yet during early boot */ }
  try { console.error("[uncaughtException]", err); } catch { }
  exitAfterFatalMainProcessError("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  try {
    if (typeof appendMainLog === "function") {
      appendMainLog(`[unhandledRejection] ${String(reason)}`);
    }
  } catch { }
  try { console.error("[unhandledRejection]", reason); } catch { }
});

// Windows: detect OneDrive-managed %APPDATA% and re-home userData to
// %LOCALAPPDATA%\Transcriptor (which is NEVER synced by OneDrive,
// regardless of Known-Folder-Move policy). When a corporate Group
// Policy enables KFM Roaming → OneDrive, our config.json writes get
// sync-conflicted across devices and ``writeFile(tmp) + rename``
// fails with EPERM while OneDrive holds the file handle during
// upload — symptom: users periodically lose their API keys +
// presets + archive-dir preferences. Also: encrypted API keys wind
// up syncing to OneDrive cloud (privacy leak).
//
// Must run BEFORE any `app.getPath('userData')` call (line 227
// `mainLogFilePath`), BEFORE `requestSingleInstanceLock` (line 154),
// and BEFORE we spawn the backend (TRANSCRIPTOR_DATA_DIR env flows
// through to backend/config.py `_default_data_dir`).
function _relocateUserDataOffOneDrive() {
  if (process.platform !== "win32") return;
  const roaming = process.env.APPDATA;
  const local = process.env.LOCALAPPDATA;
  if (!roaming || !local) return;
  // Resolve OneDrive root candidates. `OneDriveCommercial` is
  // corporate M365; `OneDriveConsumer` / `OneDrive` are personal.
  const oneDriveRoots = [
    process.env.OneDriveCommercial,
    process.env.OneDriveConsumer,
    process.env.OneDrive,
  ].filter((p) => p && typeof p === "string").map((p) => path.resolve(p));
  if (oneDriveRoots.length === 0) return;
  const roamingResolved = path.resolve(roaming);
  const insideOneDrive = oneDriveRoots.some((od) => {
    const rel = path.relative(od, roamingResolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!insideOneDrive) return;
  // Target: non-synced Local AppData.
  const newDir = path.join(local, "Transcriptor");
  const oldDir = path.join(roaming, "Transcriptor");
  try { fs.mkdirSync(newDir, { recursive: true }); } catch { /* EEXIST or broken FS — fall through; setPath will still try */ }
  // One-time migration: if the user had a prior OneDrive'd install,
  // copy their data from the old location to the new location once.
  // Marker file prevents re-copying on every launch, which would
  // silently overwrite their new-location edits with old data.
  const marker = path.join(newDir, ".migrated-from-onedrive");
  try {
    if (!fs.existsSync(marker) && fs.existsSync(oldDir)) {
      // `cpSync` landed in Node 16.7; the pinned Electron (see
      // devDependencies) is far past that, and package.json engines
      // requires Node >=22.12 for the dev path.
      // Copy only the user-facing subset — skip bundled-runtime caches,
      // .venv, anything else that is safe to regenerate.
      let allCopied = true;
      const copyChild = (name) => {
        const src = path.join(oldDir, name);
        const dst = path.join(newDir, name);
        try {
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.cpSync(src, dst, { recursive: true, errorOnExist: false });
          }
        } catch (e) {
          // 1.1.25 fix: previously silently swallowed per-child errors
          // AND wrote the migration marker unconditionally. If a single
          // child copy failed (disk full, AV blocking, antivirus quarantine
          // mid-rename), the marker pinned the migration as "done" forever
          // and the user's recordings stayed stranded in the OneDrive path
          // — silent data loss. Now we track success and write the marker
          // only when EVERY child landed.
          allCopied = false;
        }
      };
      for (const child of [
        "config.json",
        ".encryption_key",
        "api_token.txt",
        "known_archive_dirs.json",
        "upscale_presets",
        "recordings",
      ]) copyChild(child);
      if (allCopied) {
        try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* non-fatal */ }
      }
      // If !allCopied, intentionally do NOT write the marker — next boot
      // will retry the failed child(ren). The user only sees a "did all
      // copies succeed" delta on retry, never silent loss.
    }
  } catch { /* migration best-effort */ }
  // Override BOTH Electron's userData AND the backend's DATA_DIR so
  // they stay in lockstep. The child-spawn code at line ~5085 reads
  // `TRANSCRIPTOR_DATA_DIR` from process.env — setting it here means
  // backend/config.py `_default_data_dir` picks up the override even
  // though it never sees Electron's `app.setPath` call.
  try { app.setPath("userData", newDir); } catch { /* path must be absolute on Win; already is */ }
  process.env.TRANSCRIPTOR_DATA_DIR = newDir;
  // Cache note: main.log path switches to the new dir automatically
  // on the next appendMainLog call (mainLogFilePath at line 227 is
  // computed lazily from app.getPath). Old log in OneDrive'd path
  // stays as an artefact — harmless.
}
// ── The data directory's name ───────────────────────────────────────
//
// Electron names ``userData`` after the package's ``name`` field, which
// npm requires to be lower case. ``backend/data_dir.py`` spells the same
// directory ``Transcriptor``, and so does the OneDrive re-home above.
// This makes the shell use the backend's spelling, so there is one
// answer wherever the path is resolved or shown.
//
// Must run BEFORE anything reads ``app.getPath('userData')`` — the
// OneDrive re-home below, ``appendMainLog`` (which caches the log path
// on first use) and the single-instance lock all do.
function _useOneSpellingForUserDataDir() {
  const preferredName = userDataDirName(process.platform);
  const legacyName = app.getName();
  if (!preferredName || legacyName === preferredName) return;

  const { legacyDir, preferredDir } = userDataDirCandidates(
    app.getPath("appData"), legacyName, preferredName,
  );
  // Adopt the new spelling FIRST: everything below logs, and the logger
  // pins its path to whatever userData says the moment it is called.
  try { app.setName(preferredName); } catch { /* pre-ready only; ignore */ }

  const statDir = (dir) => {
    try {
      const st = fs.statSync(dir);
      return st.isDirectory() ? st : null;
    } catch { return null; }
  };
  const legacyStat = statDir(legacyDir);
  const preferredStat = statDir(preferredDir);
  const decision = decideUserDataMigration({
    legacyName,
    preferredName,
    legacyExists: Boolean(legacyStat),
    preferredExists: Boolean(preferredStat),
    // Device + inode, not a string compare: on a case-insensitive
    // volume — the normal case on macOS and Windows — the two names
    // ARE one directory, and "renaming" it would be a mistake.
    sameDirectory: Boolean(
      legacyStat && preferredStat
      && legacyStat.dev === preferredStat.dev
      && legacyStat.ino === preferredStat.ino,
    ),
  });

  if (decision.action === USER_DATA_MIGRATION.ADOPT) {
    try {
      fs.renameSync(legacyDir, preferredDir);
      appendMainLog(`[user-data-dir] adopted ${legacyDir} as ${preferredDir}`);
      return;
    } catch (e) {
      // The rename is the only branch that can lose the user's data by
      // half-succeeding, and it cannot: renameSync either moves the
      // directory or leaves it exactly where it was. Point userData
      // back at what actually holds the data and say so.
      try { app.setPath("userData", legacyDir); } catch { /* keep going */ }
      appendMainLog(
        `[user-data-dir] could not adopt ${legacyDir}: ${e?.message || e}` +
        " — still using the old directory",
      );
      return;
    }
  }
  if (decision.action === USER_DATA_MIGRATION.KEEP_BOTH) {
    // Both names hold a real, distinct directory. One of them has the
    // user's config, provider keys and archive; merging is guesswork
    // and the wrong guess loses data nothing can reconstruct.
    appendMainLog(
      `[user-data-dir] two data directories exist (${legacyDir} and ${preferredDir});` +
      ` using ${preferredDir} and leaving both untouched`,
    );
    return;
  }
  appendMainLog(`[user-data-dir] name=${preferredName} decision=${decision.action}/${decision.reason}`);
}
_useOneSpellingForUserDataDir();
_relocateUserDataOffOneDrive();

let backend = null;
let win = null;
let recordingStatusWindow = null;
let recordingStatusWindowLoadPromise = null;
let recordingStatusWindowReady = false;
// Grace period between the capsule going idle and its renderer process
// being torn down. Root cause it fixes: the capsule window was created
// on the first recording and then lived until app quit — a second,
// permanently resident renderer process (~64 MB plus its own V8 isolate)
// that, being created with backgroundThrottling disabled, kept its
// compositor ticking while hidden and burned ~13% of a CPU core at idle,
// dragging the shared GPU process along with it. The window now exists
// only while there is something to show. The delay keeps a rapid
// stop→start cycle from paying a window re-create.
const RECORDING_STATUS_CAPSULE_TEARDOWN_MS = 8000;
let recordingStatusTeardownTimer = null;
let mainWindowInitialLoadPromise = null;
let recordingStateMonitor = null;
let tray = null;
let backendBootError = "";
// Cache the last shortcut-registration status so we can replay it to
// any renderer window created AFTER the registration happened.
// `registerGlobalShortcuts` runs during app startup before createWindow,
// so the very first window misses the live injection and would render
// with no awareness that its F9 hotkey is unclaimed. Cached here,
// replayed from `did-finish-load`.
let lastShortcutStatus = null;
// Cached macOS Accessibility-trust state, main-process only: it is what
// makes the `[accessibility] trusted=` log line report CHANGES rather than
// repeat the current value on every probe.
//
// It used to be pushed into the renderer as
// `window.__transcriptorAccessibilityStatus` on every change and replayed
// on every window load, for a badge that was never built — nothing in
// frontend/ has ever read the global, and a 30-second interval was kept
// running for the life of the process to feed it. The state that DOES
// drive behaviour is `pasteCapability`, and every probe of it
// (`probePasteCapability`: boot, window focus, pre-paste, and after a
// failed paste) refreshes this value on the way through. Surfaced to the
// user via the invoke-only `paste-capability:get-status` handler below
// (D-009) — the renderer pulls a snapshot instead of main pushing a
// global.
let lastAccessibilityTrusted = null;
// Ring buffer of the last ~4 KB of backend stderr. When the fallback
// HTML fires "Backend did not start in time" / "exited with code N
// after 8 restart attempts", we include the tail of stderr so the user
// and support can SEE what actually failed — ImportError, missing
// module, module-level crash, port collision, etc. Without this the
// error page is actionable only by a developer with log-file access.
let backendStderrTail = "";
const BACKEND_STDERR_TAIL_MAX = 4096;
let isQuitting = false;
let shortcutToggleInFlight = false;
let recordingStopInFlight = false;
let pasteShortcutInFlight = false;
let lastTranscriptText = "";
let mainLogFilePath = "";
let traceCounter = 0;
// When the user last asked for the window, cleared when focus lands. The
// distance to the focus event is the latency the user actually perceives.
let mainWindowShowRequestedAt = 0;
// Saved geometry, and whether the user has earned it. Until the user
// moves or resizes the window themselves it stays null and the window
// opens filling the work area — see desktop/window-lifecycle.js.
let mainWindowStoredState = { userSized: false, bounds: null };
// The geometry the app itself last wrote, so our own `setBounds` is not
// mistaken for the user resizing the window.
let mainWindowLastAppliedBounds = null;
const MAIN_WINDOW_STATE_FILE = "window-state.json";
// SSOT for the window's floor. The layout below 1140×700 collapses the
// transcript column into the settings rail; the numbers are the
// BrowserWindow's minWidth/minHeight AND the clamp the saved-bounds
// decision applies before restoring a remembered size.
const MAIN_WINDOW_MIN_WIDTH = 1140;
const MAIN_WINDOW_MIN_HEIGHT = 700;
const DEFAULT_RECORDING_AUTO_STOP_CONFIG = Object.freeze({ enabled: false, seconds: 2, thresholdDb: -42 });
const RECORDING_STATUS_TERMINAL_DWELL_MS = 900;

// ── Recording-monitor bounds ──────────────────────────────────────────
//
// The four numbers the 1 Hz recording-state monitor and the capsule spend.
// They were bare literals inside the monitor body, which is where a product
// parameter goes to stop being one: nothing named them, nothing could state
// them, and one of them was retyped into the message the user reads.

/** How long a click on the capsule suppresses the app-activate that
 *  would otherwise raise the main window behind it. */
const RECORDING_STATUS_CAPSULE_ACTIVATE_SUPPRESS_MS = 700;

/** How often the monitor re-reads the renderer's auto-stop settings. The
 *  user can change them mid-recording from Settings. */
const RECORDING_AUTOSTOP_CONFIG_REFRESH_MS = 1200;

/** Silence before this much of a recording has elapsed is the microphone
 *  warming up, not the user having stopped talking. */
const RECORDING_AUTOSTOP_WARMUP_MS = 1500;

/** No audio frame for this long, after frames HAVE been seen, means the
 *  capture pipeline died; the recording is force-stopped rather than left
 *  running with no way out but quitting. */
const RECORDING_DEAD_PIPELINE_MS = 8000;

/** How many finished recordings the renderer snapshot carries back. It is
 *  a hand-off buffer, not a history: the post-stop task looks for ONE id
 *  in it, and the renderer owns the real list. */
const RENDERER_FINISHED_RECORDS_LIMIT = 30;
let recordingSilenceStartedAt = 0;
let recordingAutoStopConfig = DEFAULT_RECORDING_AUTO_STOP_CONFIG;
let recordingAutoStopConfigRefreshAt = 0;
// Generation counter for recordingAutoStopConfig async refreshes. Each
// scheduled refresh captures this value; when the Promise resolves it
// checks that the generation still matches before writing — so a
// resolve from a PREVIOUS session (after the recording status state was reset and a
// new recording started) cannot clobber the new session's config.
let recordingAutoStopConfigGen = 0;
let recordingStartedAt = 0;
let recordingSeenAudioFrames = false;
let postStopQueue = [];
let postStopWorkerRunning = false;
let pendingTranscriptionCount = 0;
// Mailbox for the renderer's "recording-final" IPC hand-off. Filled by
// the ipcMain listener registered in app.whenReady, drained by
// processPostStopTask. It is a slot rather than an event listener
// because the renderer can publish the paste-ready text BEFORE the
// post-stop task starts waiting for it (fast recording, queued task) —
// an event fired into no listener would be lost, and the recording
// would fall back to the 32 s poll for a transcript that already exists.
const recordingFinalSlot = createRecordingFinalSlot();
let backendRestartTimer = null;
// Render-process-gone recovery timer. Schedules a loadURL to recreate
// the renderer 500 ms after a crash. Tracked at module scope so
// before-quit can clear it — if the user quits during the recovery
// window the loadURL would otherwise fire against a teardown-in-progress
// webContents and produce shutdown-log noise.
let renderRecoveryTimer = null;
let backendRestartAttempts = 0;

/**
 * How long a restarted backend is given to answer /api/health before the
 * restart is treated as not having recovered. Shorter than the cold-start
 * budget in createWindow: by this point the runtime is warm and the only
 * thing being started is uvicorn.
 */
const BACKEND_RESTART_HEALTH_TIMEOUT_MS = 30000;

/**
 * Bounds for the backend-down recovery poll shown in the error window.
 * 40 attempts x 3 s is two minutes: long enough for a slow cold start or
 * a user fixing a port conflict, short enough that a backend which is
 * never coming back stops counting at the user forever.
 */
const BACKEND_RECOVERY_MAX_ATTEMPTS = 40;
const BACKEND_RECOVERY_PROBE_TIMEOUT_MS = 3000;
const BACKEND_RECOVERY_POLL_INTERVAL_MS = 3000;

/**
 * The backend answered a health check, so whatever incident the restart
 * counter was tracking is over. ONE place, because the counter's cap is
 * meant to bound a single failing incident, not the whole session.
 */
function noteBackendHealthy(source) {
  if (backendRestartAttempts === 0) return;
  appendMainLog(`[${source}] healthy after ${backendRestartAttempts} attempt(s); resetting counter`);
  backendRestartAttempts = 0;
}
// Set at app.whenReady, cleared on before-quit so shutdown doesn't
// produce unhandledRejection noise from executeJavaScript against a
// destroyed webContents.
let shortcutBridgeHandler = null;
let shortcutCaptureAbortHandler = null;
let shortcutCaptureFailsafeTimer = null;
let pendingShortcutBridgeMessages = [];
// Single-flight promise for ``startBackend``. Concurrent callers
// (window creation, restart timer, tray re-open) all await the same
// in-flight start instead of racing to spawn duplicate Python
// subprocesses that leak PIDs when ``backend`` is overwritten.
let backendStartInFlight = null;
// Guards the "Open Microphone Settings" escalation dialog so a denied
// user is told once per process, not on every recording attempt. The TCC
// status itself is never cached — ``ensureMacMicrophoneAccess`` always
// reads it live, so granting access mid-session takes effect immediately.
let micPermissionDialogShown = false;
let macPastePermissionPromptAt = 0;
let macPastePermissionPromptInFlight = false;
const MAC_PASTE_PERMISSION_PROMPT_THROTTLE_MS = 60000;
let loadedFrontendBuildSignature = "";
let pasteTarget = emptyCapturedPasteTarget();
const HOST = "127.0.0.1";
// Backend port default. pickBackendPort iterates up if occupied, so
// collisions with other local services on 8321 are non-fatal — the
// actual port the backend bound is stored in mutable ``PORT`` below.
// All four previous hardcoded 8321 literals now reference this constant
// so a future port change is a one-line edit.
const DEFAULT_BACKEND_PORT = 8321;
let PORT = DEFAULT_BACKEND_PORT;
let BASE_URL = `http://${HOST}:${PORT}`;
let BACKEND_BOOT_NONCE = "";
const LAST_TRANSCRIPT_FILE = "last_transcript.json";
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  // app.quit() is async and allows module-level code to keep running
  // (startBackend, BrowserWindow creation, globalShortcut registration),
  // so the duplicate instance briefly races the primary for port 8321
  // and the F9/F10 hotkeys before finally exiting. app.exit(0) is
  // synchronous — nothing after this line runs.
  app.exit(0);
}

app.on("second-instance", () => {
  applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.secondInstance);
});

// Rotate main.log when it exceeds this size. Prior code appended
// forever — a heavy trace-log session (hotkey fires ~200 events per
// recording start/stop cycle) grew the file to 35+ MB over a few
// days, making the log unusable for support triage and unnecessarily
// consuming userData disk.
const MAIN_LOG_MAX_BYTES = 5 * 1024 * 1024;
// No cached size: `mainLogSizeCached` was written in two places and read
// in none, which made it look as if the rotation check avoided a stat it
// never avoided. mainLogCheckCounter is the real throttle.
let mainLogCheckCounter = 0;

function mainLogArchivePath(kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${mainLogFilePath}.${kind}-${stamp}`;
  let candidate = base;
  for (let i = 1; fs.existsSync(candidate); i += 1) {
    candidate = `${base}-${i}`;
  }
  return candidate;
}

function recoverOrphanRotatingLogs() {
  // Rotation is rename→rename; a crash between the two steps leaves
  // ``main.log.<kind>-<stamp>.rotating`` orphans that nothing else ever
  // promotes — silently stranded support logs. Sweep them at boot.
  if (!mainLogFilePath) return;
  try {
    const dir = path.dirname(mainLogFilePath);
    const prefix = path.basename(mainLogFilePath) + ".";
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".rotating")) continue;
      const orphan = path.join(dir, name);
      const promoted = orphan.slice(0, -".rotating".length);
      try {
        if (fs.existsSync(promoted)) {
          fs.renameSync(orphan, `${promoted}-recovered-${Date.now()}`);
        } else {
          fs.renameSync(orphan, promoted);
        }
        appendMainLog(`[log-rotation] recovered orphan ${name}`);
      } catch { /* keep orphan in place; retried next boot */ }
    }
  } catch { /* directory unreadable — non-fatal */ }
}

// Archive retention (BUG-34): rotation deliberately never deletes, so
// without a boot-time cap the archives grow without bound (up to 5 MB
// per rotation, forever). Keep the newest MAIN_LOG_ARCHIVE_KEEP_COUNT
// archives and at most MAIN_LOG_ARCHIVE_KEEP_BYTES in total; the sweep
// runs once per boot, never during rotation.
const MAIN_LOG_ARCHIVE_KEEP_COUNT = 10;
const MAIN_LOG_ARCHIVE_KEEP_BYTES = 50 * 1024 * 1024;
// Age cap. The count/byte caps alone let a quiet week and a busy week
// keep the same amount of history, so a heavy-logging stretch could
// still pin 50 MB of archives that are months old and useless for
// triage. Support only ever looks at the last few days.
const MAIN_LOG_ARCHIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function pruneMainLogArchives() {
  if (!mainLogFilePath) return;
  try {
    const dir = path.dirname(mainLogFilePath);
    const prefix = path.basename(mainLogFilePath) + ".";
    const archives = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      archives.push({ full, mtimeMs: st.mtimeMs, size: st.size });
    }
    archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const now = Date.now();
    let keptBytes = 0;
    for (let i = 0; i < archives.length; i += 1) {
      const a = archives[i];
      // The newest archive always survives (it holds the freshest
      // crash evidence); count, byte and age caps apply to the older
      // tail. A clock that jumped backwards yields a negative age,
      // which must not read as "expired".
      const ageMs = now - a.mtimeMs;
      const overCaps = i + 1 > MAIN_LOG_ARCHIVE_KEEP_COUNT
        || keptBytes + a.size > MAIN_LOG_ARCHIVE_KEEP_BYTES
        || ageMs > MAIN_LOG_ARCHIVE_MAX_AGE_MS;
      if (i > 0 && overCaps) {
        try {
          fs.rmSync(a.full, { force: true });
          appendMainLog(`[log-rotation] pruned old archive ${path.basename(a.full)}`);
        } catch { /* keep in place; retried next boot */ }
        continue;
      }
      keptBytes += a.size;
    }
  } catch { /* directory unreadable — non-fatal */ }
}

function rotateMainLogIfNeeded() {
  if (!mainLogFilePath) return;
  try {
    const st = fs.statSync(mainLogFilePath);
    if (st.size < MAIN_LOG_MAX_BYTES) return;
    const legacyPending = mainLogFilePath + ".rotating";
    if (fs.existsSync(legacyPending)) {
      try { fs.renameSync(legacyPending, mainLogArchivePath("recovered")); } catch { /* keep orphan in place */ }
    }
    const pending = mainLogArchivePath("rotating");
    const archived = mainLogArchivePath("archive");
    // Never delete support logs during rotation. Move current log to a
    // unique pending name, then promote that pending file to a unique
    // timestamped archive. If any step fails, preserve the best available
    // file instead of unlinking it.
    try {
      fs.renameSync(mainLogFilePath, pending);
    } catch {
      // Current log is locked — skip rotation this cycle. Next
      // amortised-counter tick will retry. main.log keeps growing
      // past 5 MB until the lock is released.
      return;
    }
    try {
      fs.renameSync(pending, archived);
    } catch {
      // Promotion failed. Restore the log to its original name so
      // appendFile keeps working. If THAT also fails, preserve the
      // pending file as a recovered archive.
      try { fs.renameSync(pending, mainLogFilePath); } catch {
        try { fs.renameSync(pending, mainLogArchivePath("recovered")); } catch { /* keep pending in place */ }
      }
    }
  } catch { /* stat failed — nothing to rotate */ }
}

function appendMainLog(message) {
  try {
    if (!mainLogFilePath) {
      mainLogFilePath = path.join(app.getPath("userData"), "main.log");
    }
    const line = `[${new Date().toISOString()}] ${message}\n`;
    // Amortised rotation check — stat every 256 appends (& 0xff).
    // Must come BEFORE the append so we rotate the CURRENT main.log
    // and the just-generated line lands in the fresh file rather
    // than getting buffered into the about-to-be-renamed inode.
    if ((++mainLogCheckCounter & 0xff) === 0) {
      rotateMainLogIfNeeded();
    }
    // appendFileSync (not appendFile): the async form buffers the
    // write and can race with a synchronous renameSync inside
    // rotateMainLogIfNeeded — on POSIX the pending write lands in
    // the NOW-RENAMED inode (the .rotating / .1 file), then the
    // next rotation cycle unlinks it, losing data. Synchronous
    // appends cost ~0.5-1ms per line on local SSD; trace logging
    // peaks at ~20 lines/second which is still well under 2% of
    // main-process time. Acceptable cost for log durability.
    fs.appendFileSync(mainLogFilePath, line, "utf8");
  } catch (e) {
    // Last-resort: the logger itself failed. Fall back to stderr so
    // we never silently lose signal.
    // eslint-disable-next-line no-console
    console.error("appendMainLog failed", e);
  }
}

function logPasteTrace(step, details = {}) {
  try {
    appendMainLog(`[paste-trace] ${JSON.stringify({ step, ...details })}`);
  } catch (e) {
    // JSON.stringify cycles or unrepresentable values — fall back to
    // a single-line dump. Do NOT recurse via appendMainLog with
    // objects that just threw.
    try {
      appendMainLog(`[paste-trace-error] step=${step} error=${e?.message || e}`);
    } catch (inner) {
      // eslint-disable-next-line no-console
      console.error("logPasteTrace catastrophic failure", inner);
    }
  }
}

/**
 * Best-effort execution helper with observability.
 *
 * Use for "might legitimately fail during teardown" calls — executing JS
 * in the renderer after it's been destroyed, resizing a hidden window,
 * or clipboard ops on platforms where the caller might not have focus.
 * Failures are logged to main.log (``safe-exec`` tag) and ``null`` is
 * returned so the caller can continue.
 *
 * Do NOT call inside ``appendMainLog`` / ``logPasteTrace``.
 */
async function safeExec(context, fn) {
  try {
    return await fn();
  } catch (error) {
    appendMainLog(`[safe-exec] ${context}: ${error?.message || error}`);
    return null;
  }
}

function safeExecSync(context, fn) {
  try {
    return fn();
  } catch (error) {
    appendMainLog(`[safe-exec-sync] ${context}: ${error?.message || error}`);
    return null;
  }
}

function compactLogText(value, max = 180) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function normalizeTranscriptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isNoSpeechFinalStatusText(value) {
  const txt = normalizeTranscriptText(value);
  if (!txt) return false;
  const lower = txt.toLowerCase();
  return (
    lower.includes("no speech detected") ||
    lower.includes("no speech captured") ||
    lower.includes("silence detected") ||
    lower === "[silence]" ||
    lower === "[ silence ]"
  );
}

function textDigest(input) {
  const str = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function isMeaningfulTranscriptText(value) {
  const txt = normalizeTranscriptText(value);
  if (!txt) return false;
  const lower = txt.toLowerCase();
  const compact = lower.replace(/\s+/g, "");
  if (isNoSpeechFinalStatusText(txt)) return false;
  if (lower === "error" || lower === "[websocket error]" || compact === "[silence]") return false;
  if (lower.startsWith("http ") || lower.startsWith("network error")) return false;
  return true;
}

function createTrace(scope, seed = {}) {
  const id = `${scope}-${Date.now()}-${(++traceCounter % 100000).toString().padStart(5, "0")}`;
  const ctx = { id, scope, startedAt: Date.now(), step: 0 };
  appendMainLog(`[trace-start] ${JSON.stringify({ id, scope, ...seed })}`);
  return ctx;
}

function traceStep(ctx, stage, details = {}) {
  if (!ctx) return;
  ctx.step += 1;
  appendMainLog(
    `[trace] ${JSON.stringify({
      id: ctx.id,
      scope: ctx.scope,
      step: ctx.step,
      ms: Date.now() - ctx.startedAt,
      stage,
      ...details,
    })}`
  );
}

function traceEnd(ctx, status = "done", details = {}) {
  if (!ctx) return;
  appendMainLog(
    `[trace-end] ${JSON.stringify({
      id: ctx.id,
      scope: ctx.scope,
      status,
      totalMs: Date.now() - ctx.startedAt,
      steps: ctx.step,
      ...details,
    })}`
  );
}

// ── Main-window lifecycle ─────────────────────────────────────────────
//
// One entry point. Every show / quit / do-nothing decision comes from
// desktop/window-lifecycle.js and is executed here; nothing else in this
// file is allowed to show, hide, focus or reorder the main window.
//
// What used to live here — a reveal single-flight promise, an 80 ms
// reveal-request timer, a "reveal protection" dwell, an "expected hide"
// dwell, an app-level un-hide dance, a four-flag activate heuristic
// and a Dock-presence state machine — is gone. Between them they wrote
// the `[main-window] event=show/hide … lastReveal=ensure-window-visible
// revealProtection=…` flap the user reported: eight transitions inside
// 200 ms at boot.

function normalizeLifecycleReason(reason = "") {
  return String(reason || "unknown").trim() || "unknown";
}

function mainWindowSnapshot() {
  if (!win || win.isDestroyed()) return "window=missing";
  try {
    return `visible=${win.isVisible()} focused=${win.isFocused()} minimized=${win.isMinimized()}`;
  } catch {
    return "window=unreadable";
  }
}

/**
 * Rule 1: while the process runs, the Dock shows the running indicator.
 *
 * `regular` is the policy a bundled app with no `LSUIElement` already
 * starts in. Setting it once, explicitly, is this file's standing
 * assertion that nothing here ever moves to `accessory` — and there is
 * deliberately no dock-hiding call anywhere in the app to match it.
 */
function applyMacDockPolicy() {
  if (process.platform !== "darwin") return;
  try {
    app.setActivationPolicy("regular");
    appendMainLog("[main-window] dock=regular");
  } catch (e) {
    appendMainLog(`[main-window] dock policy failed: ${e?.message || e}`);
  }
}

function mainWindowStatePath() {
  const dataDir = process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData");
  return path.join(dataDir, MAIN_WINDOW_STATE_FILE);
}

function loadMainWindowState() {
  try {
    mainWindowStoredState = normalizeStoredWindowState(
      JSON.parse(fs.readFileSync(mainWindowStatePath(), "utf8")),
    );
  } catch {
    // No file, a truncated write, or a hand-edit. All of them mean the
    // same thing: open maximised.
    mainWindowStoredState = { userSized: false, bounds: null };
  }
  return mainWindowStoredState;
}

function saveMainWindowState(reason) {
  const file = mainWindowStatePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(mainWindowStoredState), "utf8");
  } catch (e) {
    appendMainLog(`[main-window] bounds save failed reason=${reason}: ${e?.message || e}`);
  }
}

function sameWindowRect(a, b) {
  return !!a && !!b
    && a.x === b.x && a.y === b.y
    && a.width === b.width && a.height === b.height;
}

/**
 * The user dragged or resized the window, so from now on the app opens
 * where they left it instead of filling the work area.
 *
 * The app's own `setBounds` also raises `resized`/`moved` on some
 * platforms, so the guard is the geometry itself rather than a timer:
 * bounds identical to the ones we just applied are ours, not theirs.
 */
function noteMainWindowUserGeometry(kind) {
  if (!win || win.isDestroyed()) return;
  let bounds;
  try {
    bounds = win.getBounds();
  } catch {
    return;
  }
  if (sameWindowRect(bounds, mainWindowLastAppliedBounds)) return;
  // Filling the work area IS the default, so a window dragged or zoomed
  // back to it gives up its remembered geometry instead of pinning the
  // default as if it were a choice. It also absorbs the case where the
  // OS rounds our own `setBounds` by a pixel.
  let workArea = null;
  try {
    workArea = screen.getDisplayMatching(bounds).workArea;
  } catch { }
  if (workArea && sameWindowRect(bounds, workArea)) {
    if (!mainWindowStoredState.userSized) return;
    mainWindowStoredState = { userSized: false, bounds: null };
    saveMainWindowState(kind);
    appendMainLog(`[main-window] bounds back to default reason=${kind}`);
    return;
  }
  mainWindowStoredState = {
    userSized: true,
    bounds: {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    },
  };
  saveMainWindowState(kind);
  appendMainLog(
    `[main-window] bounds remembered reason=${kind} ` +
    `${mainWindowStoredState.bounds.width}x${mainWindowStoredState.bounds.height}`,
  );
}

/**
 * Rule 2: shown means maximised — the display's work area, which is what
 * the native zoom button does — unless the user has taken the window's
 * geometry into their own hands.
 *
 * Never `setFullScreen(true)`: a macOS full-screen space would put the
 * window on its own desktop, away from the recording capsule and from
 * the app the user is dictating into. A window the user themselves put
 * into full screen is left exactly as it is.
 */
function applyMainWindowBounds(reason) {
  if (!win || win.isDestroyed()) return;
  const label = normalizeLifecycleReason(reason);
  try {
    if (win.isFullScreen()) return;
  } catch { }
  let workArea;
  try {
    workArea = screen.getDisplayMatching(win.getBounds()).workArea;
  } catch {
    try {
      workArea = screen.getPrimaryDisplay().workArea;
    } catch (e) {
      appendMainLog(`[main-window] work area unavailable reason=${label}: ${e?.message || e}`);
      return;
    }
  }
  let decided;
  try {
    decided = decideMainWindowBounds({
      workArea,
      savedBounds: mainWindowStoredState.userSized ? mainWindowStoredState.bounds : null,
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT,
    });
  } catch (e) {
    appendMainLog(`[main-window] bounds decision failed reason=${label}: ${e?.message || e}`);
    return;
  }
  try {
    if (sameWindowRect(win.getBounds(), decided.bounds)) {
      mainWindowLastAppliedBounds = { ...decided.bounds };
      return;
    }
    mainWindowLastAppliedBounds = { ...decided.bounds };
    win.setBounds(decided.bounds);
  } catch (e) {
    appendMainLog(`[main-window] setBounds failed reason=${label}: ${e?.message || e}`);
  }
}

/**
 * The one place that makes the main window visible. Synchronous, so the
 * whole transition happens inside a single turn of the event loop and
 * cannot interleave with another.
 */
function presentMainWindow(reason) {
  if (!win || win.isDestroyed()) return;
  const label = normalizeLifecycleReason(reason);
  try {
    if (win.isMinimized()) win.restore();
    applyMainWindowBounds(label);
    if (!win.isVisible()) win.show();
    // macOS raises the app itself for a Dock click, but a tray click or
    // a second launch arrives while some other app is frontmost, and
    // `BrowserWindow.focus()` alone cannot come forward from there.
    if (process.platform === "darwin") {
      try { app.focus({ steal: true }); } catch { }
    }
    win.focus();
  } catch (e) {
    appendMainLog(`[main-window] present failed reason=${label}: ${e?.message || e}`);
  }
}

async function showMainWindow(reason) {
  const label = normalizeLifecycleReason(reason);
  if (!win || win.isDestroyed()) {
    await createWindow({ showWindow: true, revealReason: label });
    return;
  }
  if (backend === null) {
    await startBackend();
  }
  // The window exists but its first load may still be in flight (the app
  // shows nothing until the backend answers /api/health). Showing a blank
  // frame and then repainting it is the flash this waits out — it is a
  // one-shot on the initial load, not a retry loop.
  await waitForMainWindowInitialLoad(label);
  presentMainWindow(label);
}

/**
 * Report a lifecycle event and carry out whatever the table says.
 * Exactly one `[main-window]` line per transition, carrying the reason.
 *
 * @param {string} event one of WINDOW_LIFECYCLE_EVENTS
 * @param {{capsuleInteraction?: boolean}} [context]
 */
function applyWindowLifecycleEvent(event, context = {}) {
  const decision = decideWindowAction(event, {
    quitting: isQuitting,
    capsuleInteraction: context.capsuleInteraction === true,
  });
  appendMainLog(
    `[main-window] event=${event} action=${decision.action} ` +
    `reason=${decision.reason} ${mainWindowSnapshot()}`,
  );
  if (decision.action === WINDOW_LIFECYCLE_ACTIONS.show) {
    mainWindowShowRequestedAt = Date.now();
    return showMainWindow(decision.reason).catch((e) => {
      appendMainLog(`[main-window] show failed reason=${decision.reason}: ${e?.message || e}`);
    });
  }
  if (decision.action === WINDOW_LIFECYCLE_ACTIONS.quit) {
    quitApp(decision.reason);
  }
  return Promise.resolve();
}

/**
 * The one call site that asks Electron to start a normal shutdown.
 * `before-quit` (registered once, below) does the actual teardown —
 * this only starts it, so there is exactly one place in the app that
 * decides "we are quitting now": the lifecycle table's `quit` action
 * above, and the paste-capability self-heal relaunch below, both go
 * through here instead of each calling `app.quit()` on its own.
 */
function quitApp(reason = "") {
  appendMainLog(`[main-window] quit requested reason=${normalizeLifecycleReason(reason)}`);
  app.quit();
}

function getRepoRoot() {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, "..");
}

function getFrontendBuildRoot() {
  const repoRoot = getRepoRoot();
  const devDistDir = path.join(repoRoot, "frontend", "dist");
  const packagedFrontendDir = path.join(repoRoot, "frontend");
  if (fs.existsSync(path.join(devDistDir, "index.html"))) return devDistDir;
  if (fs.existsSync(path.join(packagedFrontendDir, "index.html"))) return packagedFrontendDir;
  return devDistDir;
}

// Signature cache: stat the frontend entry file at most once per TTL
// window. Since Vite emits hashed asset filenames, index.html is the
// SSOT for the build — any asset change implies index.html references
// a different hash and therefore a different on-disk content. Stat'ing
// 10+ asset files on every window show was a main-thread stall.
const FRONTEND_SIGNATURE_TTL_MS = 1500;
let cachedFrontendSignature = "";
let cachedFrontendSignatureAt = 0;

async function getFrontendBuildSignature() {
  const now = Date.now();
  if (cachedFrontendSignature && now - cachedFrontendSignatureAt < FRONTEND_SIGNATURE_TTL_MS) {
    return cachedFrontendSignature;
  }
  try {
    const indexPath = path.join(getFrontendBuildRoot(), "index.html");
    const stat = await fs.promises.stat(indexPath);
    cachedFrontendSignature = `index:${stat.size}:${stat.mtimeMs}`;
    cachedFrontendSignatureAt = now;
    return cachedFrontendSignature;
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      appendMainLog(`[frontend-signature-error] ${error?.message || error}`);
    }
    cachedFrontendSignature = "";
    cachedFrontendSignatureAt = now;
    return "";
  }
}

function invalidateFrontendSignatureCache() {
  cachedFrontendSignature = "";
  cachedFrontendSignatureAt = 0;
}

async function refreshWindowForFrontendBuild(force = false) {
  if (!win || win.isDestroyed() || !win.webContents) return false;
  if (force) {
    invalidateFrontendSignatureCache();
  }
  const nextSignature = await getFrontendBuildSignature();
  if (!nextSignature) return false;

  // First-launch case: the renderer hasn't reported its loaded
  // signature yet (``did-finish-load`` hasn't fired). Doing clearCache
  // + reload here would be a spurious white flash on every app startup.
  if (!loadedFrontendBuildSignature) return false;

  if (!force && loadedFrontendBuildSignature === nextSignature) return false;

  appendMainLog(
    `[frontend-refresh] force=${force} from=${loadedFrontendBuildSignature || "none"} to=${nextSignature}`
  );
  await safeExec("refreshWindowForFrontendBuild:clearCache", () =>
    win.webContents.session.clearCache()
  );
  await safeExec("refreshWindowForFrontendBuild:clearStorageData", () =>
    win.webContents.session.clearStorageData({
      origin: BASE_URL,
      storages: ["serviceworkers", "cachestorage"],
    })
  );
  loadedFrontendBuildSignature = nextSignature;
  if (!win.webContents.isLoading()) {
    trackMainWindowInitialLoad(win, "frontend-refresh");
    await safeExec("refreshWindowForFrontendBuild:reload", () =>
      win.webContents.reloadIgnoringCache()
    );
    return true;
  }
  return false;
}

function normalizeProviderChoice(value) {
  const v = String(value || "").trim();
  // UI group ids (transcription-catalog SSOT) map onto wire providers:
  // both local groups transcribe through provider "local".
  if (v === "local-whisper" || v === "gigaam") return "local";
  if (v === "local" || v === "openrouter" || v === "deepgram" || v === "") return v;
  return "local";
}

function normalizeLocalModelChoice(value) {
  const v = String(value || "").trim();
  return v || "small";
}

/**
 * Race win.webContents.executeJavaScript(code) against a timeout.
 *
 * Every hotkey-lifecycle renderer probe (`getRendererProviderChoice`,
 * `getRendererLocalModelChoice`, auto-stop config reads, etc.) previously awaited the
 * executeJavaScript Promise unconditionally. If the renderer was
 * stuck (long synchronous work, layout lock, extension interaction),
 * the main process would hang in the recording startup path forever —
 * `shortcutToggleInFlight` stayed true and the user could not re-fire
 * the hotkey until process restart. This wrapper guarantees a
 * bounded wait per probe.
 *
 * Returns ``fallback`` if:
 *   - win is destroyed / webContents is gone
 *   - executeJavaScript rejects
 *   - the timeout (default 2000ms) elapses before the Promise settles
 */
async function execRendererJsWithTimeout(code, fallback, timeoutMs = 2000) {
  if (!win || win.isDestroyed() || !win.webContents) return fallback;
  let timer = null;
  try {
    const result = await Promise.race([
      win.webContents.executeJavaScript(code, true),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`renderer probe timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return result;
  } catch (e) {
    try { appendMainLog(`[renderer-probe] fallback: ${e?.message || e}`); } catch { }
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getRendererProviderChoice() {
  const v = await execRendererJsWithTimeout(
    `(() => {
      const el = document.getElementById('providerSelect');
      return String(el ? el.value : 'local').trim();
    })();`,
    "local",
  );
  return normalizeProviderChoice(v);
}

async function getRendererLocalModelChoice() {
  const v = await execRendererJsWithTimeout(
    `(() => String((document.getElementById('remoteModelSelect')?.value || 'small')).trim())();`,
    "small",
  );
  return normalizeLocalModelChoice(v);
}

async function getRendererAutoStopSilenceConfig() {
  const fallback = DEFAULT_RECORDING_AUTO_STOP_CONFIG;
  const out = await execRendererJsWithTimeout(
    `
    (() => {
      const snapshot = typeof window.__transcriptorLiveStatusSnapshot === 'function'
        ? window.__transcriptorLiveStatusSnapshot()
        : null;
      return snapshot && typeof snapshot.autoStopSilence === 'object'
        ? snapshot.autoStopSilence
        : null;
    })();
    `,
    null,
  );
  if (!out) return fallback;
  return {
    enabled: !!out.enabled,
    seconds: Number.isFinite(Number(out.seconds)) ? Number(out.seconds) : fallback.seconds,
    thresholdDb: Number.isFinite(Number(out.thresholdDb)) ? Number(out.thresholdDb) : fallback.thresholdDb,
  };
}

function hasActivePostStopWork() {
  return pendingTranscriptionCount > 0 || postStopWorkerRunning || postStopQueue.length > 0;
}

// Capsule geometry SSOT. The pill's width is the sum of its parts —
// padLeft + statusControlSize + gap + waveWidth + gap + timerWidth +
// padRight — and the page reports that back as the window size, so the
// two must stay consistent: 4 + 22 + 8 + 30 + 8 + 29 + 9 = 110.
//
// 110 is the previous 138 narrowed by 1.25×. Most of those 28 px come
// out of the gaps and the right padding rather than the waveform: the
// status control and the timer are sized by their content, and squeezing
// the waveform column hard enough to absorb the whole reduction left too
// few bars to read. The waveform keeps a 30 px column.
const RECORDING_STATUS_CAPSULE = Object.freeze({
  width: 110,
  height: 30,
  geometryPadding: 0,
  minWidth: 110,
  minHeight: 30,
  maxWidth: 116,
  maxHeight: 30,
  bottomMargin: 16,
  pillHeight: 30,
  pillPadLeft: 4,
  pillPadRight: 9,
  pillGap: 8,
  statusControlSize: 22,
  timerWidth: 29,
  timerFontSize: 9,
  waveWidth: 30,
  // Bar heights scale with ``waveHeight - 2``, so this is the vertical
  // scale of the waveform. 15 of the 30 px pill reads as taller than the
  // old squeezed 10 without the bars dominating the capsule.
  waveHeight: 15,
  // floor(30 / 2.4) = 12 bars in the narrowed column.
  waveBarWidth: 1.0,
  waveBarGap: 1.4,
  waveFrameMs: 16,
  waveLevelTickMs: 220,
  waveIdleTickMs: 360,
  waveActiveStaleMs: 900,
});
const RECORDING_STATUS_CAPSULE_SESSION_PARTITION = "recording-status-capsule";
const RECORDING_STATUS_LEVEL_POLL_MS = 180;
const RECORDING_STATUS_LEVEL_MIN_DELTA = 0.012;
const RECORDING_STATUS_LEVEL_MAX_STALE_MS = 600;

const recordingStatusCapsuleState = {
  status: "",
  // The producer's own answer to "what state is this?", when it has one.
  // Empty means "classify the text" (the renderer's statuses arrive that
  // way) — see ./recording-status.
  kind: "",
  startedAt: 0,
  elapsedMs: 0,
  timerRunning: false,
  level: 0,
};

let recordingStatusCapsuleGeometry = null;
// Every intent to change what the capsule shows takes the next number.
// An update that has to wait for its window — a cold create is 110-380 ms
// — checks the counter again before it paints, so a slow publish can
// never repaint a state the app has already left, nor re-show a window a
// later hide has put away. Bumped by both writers: update and hide.
let recordingStatusCapsuleUpdateSeq = 0;
// Cost of the last capsule window create, so the log can separate "the
// capsule was slow to appear" from "the press was slow to arrive".
let recordingStatusCapsuleLastCreateMs = 0;
let recordingStatusSuppressActivateUntil = 0;
let recordingStatusCapsuleLevelUpdateInFlight = false;
let recordingStatusCapsuleLastLevelSent = -1;
let recordingStatusCapsuleLastLevelSentAt = 0;

function clampRecordingStatusCapsuleDimension(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.ceil(n)));
}

function getRecordingStatusCapsuleFallbackWindowSize() {
  return {
    width: RECORDING_STATUS_CAPSULE.width,
    height: RECORDING_STATUS_CAPSULE.height,
  };
}

function noteRecordingStatusCapsuleInteraction() {
  recordingStatusSuppressActivateUntil = Date.now() + RECORDING_STATUS_CAPSULE_ACTIVATE_SUPPRESS_MS;
}

function shouldSuppressActivateForRecordingStatusCapsule() {
  if (Date.now() > recordingStatusSuppressActivateUntil) return false;
  return true;
}

function getRecordingStatusCapsuleWindowSize() {
  const geometry = recordingStatusCapsuleGeometry;
  if (!geometry) {
    return getRecordingStatusCapsuleFallbackWindowSize();
  }
  const pad = Math.max(0, Number(RECORDING_STATUS_CAPSULE.geometryPadding) || 0);
  return {
    width: clampRecordingStatusCapsuleDimension(
      geometry.width + pad,
      RECORDING_STATUS_CAPSULE.minWidth,
      RECORDING_STATUS_CAPSULE.maxWidth,
    ),
    height: clampRecordingStatusCapsuleDimension(
      geometry.height + pad,
      RECORDING_STATUS_CAPSULE.minHeight,
      RECORDING_STATUS_CAPSULE.maxHeight,
    ),
  };
}

function applyRecordingStatusCapsuleWindowSize() {
  if (!recordingStatusWindow || recordingStatusWindow.isDestroyed()) return;
  const size = getRecordingStatusCapsuleWindowSize();
  try {
    recordingStatusWindow.setSize(size.width, size.height, false);
    recordingStatusWindow.setBounds(recordingStatusCapsuleBounds(), false);
  } catch { }
}

function applyRecordingStatusCapsuleGeometryPayload(rawPayload) {
  let payload = null;
  try {
    payload = JSON.parse(decodeURIComponent(String(rawPayload || "")));
  } catch {
    return;
  }
  const width = Number(payload?.width);
  const height = Number(payload?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const next = {
    width: clampRecordingStatusCapsuleDimension(width, 1, RECORDING_STATUS_CAPSULE.maxWidth),
    height: clampRecordingStatusCapsuleDimension(height, 1, RECORDING_STATUS_CAPSULE.maxHeight),
  };
  const prev = recordingStatusCapsuleGeometry;
  if (
    prev &&
    prev.width === next.width &&
    prev.height === next.height
  ) {
    return;
  }
  recordingStatusCapsuleGeometry = next;
  applyRecordingStatusCapsuleWindowSize();
}

// The two substring ladders that used to live here — one for the mode,
// one for the tone — are gone. A status now carries its kind, and both
// views come from ./recording-status. See that module for the drift the
// copies had accumulated.

function recordingStatusCapsuleHtml() {
  const t = RECORDING_STATUS_CAPSULE;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
  <style>
    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      color: #f4f4f4;
      -webkit-user-select: none;
    }
    body {
      display: flex;
      align-items: flex-end;
      justify-content: center;
    }
    #stack {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin: 0 auto;
      width: min-content;
    }
    #pill {
      width: ${t.width}px;
      height: ${t.pillHeight}px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding: 0 ${t.pillPadRight}px 0 ${t.pillPadLeft}px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.16);
      /* Fully opaque: nothing behind the capsule shows through. The
         backdrop blur that used to sit here had nothing left to blur
         once the surface stopped being translucent, and it cost a GPU
         pass on every frame of an always-on-top window. */
      background: #121212;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.10);
      overflow: hidden;
      isolation: isolate;
    }
    #core {
      width: 100%;
      display: grid;
      grid-template-columns: ${t.statusControlSize}px minmax(0, 1fr) ${t.timerWidth}px;
      align-items: center;
      justify-content: center;
      gap: ${t.pillGap}px;
    }
    #wave {
      display: block;
      width: 100%;
      max-width: ${t.waveWidth}px;
      height: ${t.waveHeight}px;
      opacity: .95;
      justify-self: center;
    }
    #timer {
      font-size: ${t.timerFontSize}px;
      font-weight: 800;
      color: rgba(255,255,255,.96);
      font-family: Menlo, ui-monospace, monospace;
      min-width: ${t.timerWidth}px;
      text-align: right;
      line-height: 1;
      justify-self: end;
      font-variant-numeric: tabular-nums;
    }
    #stateIcon {
      width: ${t.statusControlSize}px;
      height: ${t.statusControlSize}px;
      border-radius: 50%;
      position: relative;
      display: inline-block;
      justify-self: center;
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.055);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
      cursor: default;
    }
    #stateIcon::before {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 9px;
      height: 9px;
      transform: translate(-50%,-50%);
      border-radius: 50%;
      background: rgba(180,180,180,.92);
    }
    #stateIcon::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 20px;
      height: 20px;
      transform: translate(-50%,-50%);
      border-radius: 50%;
      border: 1px solid rgba(180,180,180,.2);
      opacity: 0;
    }
    #stateIcon.rec::before {
      width: 8px;
      height: 8px;
      background: rgba(255,92,92,.96);
      border-radius: 2.5px;
      animation: coreBreathe 1.35s ease-in-out infinite;
    }
    #stateIcon.rec::after {
      opacity: 1;
      border-color: rgba(255,92,92,.44);
      animation: recHalo 1.35s ease-out infinite;
    }
    #stateIcon.transcribing::before {
      background: rgba(114,174,255,.98);
      box-shadow: 0 0 8px rgba(114,174,255,.55);
    }
    #stateIcon.transcribing::after {
      opacity: 1;
      border-color: rgba(114,174,255,.75);
      border-radius: 38% 62% 44% 56% / 54% 42% 58% 46%;
      box-shadow: 0 0 10px rgba(114,174,255,.36), inset 0 0 6px rgba(114,174,255,.28);
      animation: transBlob 1.05s ease-in-out infinite;
    }
    #stateIcon.upscaling::before {
      background: rgba(173,112,255,.98);
      box-shadow: 0 0 8px rgba(173,112,255,.5);
    }
    #stateIcon.upscaling::after {
      opacity: 1;
      border-color: rgba(173,112,255,.72);
      border-radius: 38% 62% 44% 56% / 54% 42% 58% 46%;
      box-shadow: 0 0 10px rgba(173,112,255,.34), inset 0 0 6px rgba(173,112,255,.26);
      animation: transBlob 1.05s ease-in-out infinite;
    }
    #stateIcon.autostop::before {
      background: rgba(255,196,74,.98);
      box-shadow: 0 0 8px rgba(255,196,74,.46);
    }
    #stateIcon.autostop::after {
      opacity: 1;
      border-color: rgba(255,196,74,.66);
      animation: okHalo .8s ease-out infinite;
    }
    #stateIcon.ok::before {
      background: rgba(112,210,136,.96);
      box-shadow: 0 0 8px rgba(112,210,136,.4);
      animation: okBreathe .65s ease-out 1;
    }
    #stateIcon.ok::after {
      opacity: 1;
      border-color: rgba(112,210,136,.35);
      animation: okHalo .7s ease-out 1;
    }
    #stateIcon.fail::before {
      background: rgba(184,184,184,.95);
    }
    @keyframes coreBreathe {
      0%,100% { transform: translate(-50%,-50%) scale(1); }
      50% { transform: translate(-50%,-50%) scale(1.1); }
    }
    @keyframes recHalo {
      0% { transform: translate(-50%,-50%) scale(1); opacity: .9; }
      70% { transform: translate(-50%,-50%) scale(1.28); opacity: .16; }
      100% { transform: translate(-50%,-50%) scale(1.36); opacity: 0; }
    }
    @keyframes transBlob {
      0% { transform: translate(-50%,-50%) rotate(0deg) scale(1); border-radius: 38% 62% 44% 56% / 54% 42% 58% 46%; }
      33% { transform: translate(-50%,-50%) rotate(40deg) scale(1.07); border-radius: 62% 38% 58% 42% / 40% 62% 38% 60%; }
      66% { transform: translate(-50%,-50%) rotate(84deg) scale(1.02); border-radius: 46% 54% 40% 60% / 62% 36% 64% 38%; }
      100% { transform: translate(-50%,-50%) rotate(125deg) scale(1); border-radius: 38% 62% 44% 56% / 54% 42% 58% 46%; }
    }
    @keyframes okBreathe {
      0% { transform: translate(-50%,-50%) scale(.86); }
      100% { transform: translate(-50%,-50%) scale(1); }
    }
    @keyframes okHalo {
      0% { transform: translate(-50%,-50%) scale(.92); opacity: .7; }
      100% { transform: translate(-50%,-50%) scale(1.2); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      #stateIcon::before,
      #stateIcon::after {
        animation: none !important;
        transition: none !important;
      }
    }
  </style>
</head>
<body>
  <div id="stack">
    <div id="pill">
      <div id="core">
        <span id="stateIcon" aria-hidden="true"></span>
        <canvas id="wave" width="${t.waveWidth}" height="${t.waveHeight}"></canvas>
        <span id="timer">00:00</span>
      </div>
    </div>
  </div>
  <script>
    const stackEl = document.getElementById("stack");
    const stateIcon = document.getElementById("stateIcon");
    const timeEl = document.getElementById("timer");
    const cv = document.getElementById("wave");
    const ctx = cv.getContext("2d");
    const waveW = ${t.waveWidth};
    const waveH = ${t.waveHeight};
    const bw = ${t.waveBarWidth};
    const gap = ${t.waveBarGap};
    const maxBars = Math.floor(waveW / (bw + gap));
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    cv.width = Math.round(waveW * dpr);
    cv.height = Math.round(waveH * dpr);
    cv.style.width = waveW + "px";
    cv.style.height = waveH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bars = [];
    let state = {
      status: "",
      mode: "idle",
      startedAt: 0,
      elapsedMs: 0,
      timerRunning: false,
      level: 0
    };
    let geometryEmitScheduled = false;
    let lastLevelAt = 0;
    let lastWavePushAt = 0;
    let lastRenderFrameAt = 0;
    let animationFrameHandle = 0;
    let lastTimerText = "";
    let activeWave = true;
    let waveMode = "recording";
    let stateIconModeClass = "";
    let pointerEmitLocked = false;
    function fmt(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const mm = String(Math.floor(total / 60)).padStart(2, "0");
      const ss = String(total % 60).padStart(2, "0");
      return mm + ":" + ss;
    }
    function emitGeometry() {
      const stackRect = stackEl.getBoundingClientRect();
      let left = stackRect.left;
      let top = stackRect.top;
      let right = stackRect.right;
      let bottom = stackRect.bottom;
      const payload = {
        width: Math.max(1, Math.ceil(right - left)),
        height: Math.max(1, Math.ceil(bottom - top))
      };
      document.title = "__recording_capsule_geometry__" + encodeURIComponent(JSON.stringify(payload));
    }
    function scheduleGeometryEmit() {
      if (geometryEmitScheduled) return;
      geometryEmitScheduled = true;
      requestAnimationFrame(() => {
        geometryEmitScheduled = false;
        setTimeout(emitGeometry, 0);
      });
    }
    function applyStatusMode(mode) {
      const next = String(mode || "idle");
      const nextWaveMode = next === "upscaling"
        ? "upscaling"
        : next === "transcribing"
          ? "transcribing"
          : next === "autostop"
            ? "autostop"
            : next === "recording"
              ? "recording"
              : "idle";
      if (nextWaveMode !== waveMode) {
        waveMode = nextWaveMode;
        activeWave = waveMode === "recording" || waveMode === "autostop";
        lastWavePushAt = 0;
      }
      const nextClass = next === "recording"
        ? "rec"
        : next === "upscaling"
          ? "upscaling"
          : next === "transcribing"
            ? "transcribing"
            : next === "autostop"
              ? "autostop"
              : next === "ok"
                ? "ok"
                : next === "fail"
                  ? "fail"
                  : "transcribing";
      if (nextClass === stateIconModeClass) return;
      stateIconModeClass = nextClass;
      stateIcon.className = "";
      stateIcon.classList.add(nextClass);
    }
    function renderWave(now = Date.now()) {
      ctx.clearRect(0, 0, waveW, waveH);
      const tickMs = (waveMode === "recording" || waveMode === "autostop")
        ? ${t.waveLevelTickMs}
        : ${t.waveIdleTickMs};
      const step = bw + gap;
      const progress = lastWavePushAt > 0
        ? Math.max(0, Math.min(1, (now - lastWavePushAt) / tickMs))
        : 0;
      const smoothOffset = progress * step;
      for (let i = 0; i < bars.length; i += 1) {
        const v = bars[bars.length - 1 - i];
        const x = waveW - (i + 1) * step - smoothOffset;
        if (x < 0) break;
        const h = Math.min(waveH - 2, v * (waveH - 2));
        if (h <= 0) continue;
        const y = (waveH - h) / 2;
        if (waveMode === "recording") ctx.fillStyle = "rgba(255,77,77,.88)";
        else if (waveMode === "autostop") ctx.fillStyle = "rgba(255,196,74,.92)";
        else if (waveMode === "transcribing") ctx.fillStyle = "rgba(114,174,255,.92)";
        else if (waveMode === "upscaling") ctx.fillStyle = "rgba(173,112,255,.92)";
        else ctx.fillStyle = "rgba(170,170,170,.62)";
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(x, y, bw, h, Math.min(bw / 2, h / 2));
          ctx.fill();
        } else {
          ctx.fillRect(x, y, bw, h);
        }
      }
    }
    function pushLevel(value) {
      const raw = Math.max(0, Math.min(1, Number(value) || 0));
      const level = Math.max(0, Math.min(1, Math.pow(raw, .72) * 1.45));
      if (level > 0.015) lastLevelAt = Date.now();
      bars.push(level);
      while (bars.length > maxBars) bars.shift();
    }
    function timerElapsedMs(now) {
      const startedAt = Number(state.startedAt || 0);
      const frozen = Number(state.elapsedMs || 0);
      if (state.timerRunning && startedAt > 0) {
        return Math.max(0, now - startedAt);
      }
      return Math.max(0, Number.isFinite(frozen) ? frozen : 0);
    }
    function tickWave(now) {
      if (!pageIsActive()) {
        if (bars.length) {
          bars.length = 0;
          renderWave(now);
        }
        return;
      }
      const level = Math.max(0, Math.min(1, Number(state.level || 0)));
      if (waveMode === "recording" || waveMode === "autostop") {
        if (now - lastWavePushAt >= ${t.waveLevelTickMs}) {
          lastWavePushAt = now;
          pushLevel(level);
        }
      } else if (now - lastWavePushAt >= ${t.waveIdleTickMs}) {
        lastWavePushAt = now;
        const idle = activeWave
          ? (0.08 + Math.random() * 0.12)
          : ((waveMode === "transcribing" || waveMode === "upscaling") ? 0.055 : (0.03 + Math.random() * 0.03));
        pushLevel(idle);
      }
      if (now - lastLevelAt > ${t.waveActiveStaleMs} && activeWave) {
        activeWave = false;
      }
      renderWave(now);
    }
    function render(now = Date.now()) {
      const nextTimerText = pageIsActive() ? fmt(timerElapsedMs(now)) : "00:00";
      if (nextTimerText !== lastTimerText) {
        lastTimerText = nextTimerText;
        timeEl.textContent = nextTimerText;
      }
      applyStatusMode(state.mode);
    }
    function pageIsActive() {
      return !document.hidden && !!String(state.status || "").trim();
    }
    function stopAnimationLoop() {
      if (animationFrameHandle) {
        cancelAnimationFrame(animationFrameHandle);
        animationFrameHandle = 0;
      }
      lastRenderFrameAt = 0;
    }
    function requestAnimationLoop() {
      if (animationFrameHandle) return;
      animationFrameHandle = requestAnimationFrame(animationLoop);
    }
    function clearInactiveWave(now = Date.now()) {
      if (!bars.length) return;
      bars.length = 0;
      renderWave(now);
    }
    window.__setCapsuleState = (next) => {
      state = { ...state, ...(next || {}) };
      render();
      if (pageIsActive()) {
        requestAnimationLoop();
      } else {
        stopAnimationLoop();
        clearInactiveWave();
      }
      return true;
    };
    window.addEventListener("resize", scheduleGeometryEmit);
    document.addEventListener("pointerdown", () => {
      if (pointerEmitLocked) return;
      pointerEmitLocked = true;
      setTimeout(() => { pointerEmitLocked = false; }, 80);
      document.title = "__recording_capsule_pointer__" + Date.now();
    }, true);
    document.getElementById("core").addEventListener("click", (event) => {
      // "autostop" too: the capsule is amber and counting down, but the
      // recording IS still running, so a click on it must still stop it.
      // Leaving it out would make the one state where the user is most
      // likely to reach for the capsule the one where clicking does
      // nothing.
      if (waveMode === "recording" || waveMode === "autostop") {
        event.stopPropagation();
        document.title = "__recording_capsule_stop__";
      }
    });
    function animationLoop(frameNow) {
      animationFrameHandle = 0;
      if (!pageIsActive()) {
        stopAnimationLoop();
        clearInactiveWave();
        return;
      }
      const now = Date.now();
      if (!lastRenderFrameAt || frameNow - lastRenderFrameAt >= ${t.waveFrameMs}) {
        lastRenderFrameAt = frameNow;
        render(now);
        tickWave(now);
      }
      requestAnimationLoop();
    }
    render();
    if (pageIsActive()) requestAnimationLoop();
    scheduleGeometryEmit();
  </script>
</body>
</html>`;
}

function recordingStatusCapsuleBounds() {
  const size = getRecordingStatusCapsuleWindowSize();
  const fallback = { x: 0, y: 0, width: 1440, height: 900 };
  let workArea = fallback;
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
    workArea = display?.workArea || fallback;
  } catch {
    workArea = fallback;
  }
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - RECORDING_STATUS_CAPSULE.bottomMargin),
    width: size.width,
    height: size.height,
  };
}

async function ensureRecordingStatusCapsuleWindow() {
  if (!app.isReady()) return null;
  // A pending teardown means the capsule is idle but still alive.
  // Reclaim it rather than letting the timer destroy a window we are
  // about to show again.
  cancelRecordingStatusCapsuleTeardown();
  if (recordingStatusWindow && !recordingStatusWindow.isDestroyed()) {
    // The window OBJECT exists the moment `new BrowserWindow` returns —
    // its document does not. A caller handed the object mid-load used to
    // fall out at the `recordingStatusWindowReady` check below, which was
    // harmless while some other caller was still going to paint. It
    // stopped being harmless once every update takes a sequence number:
    // the early return had already claimed the newest number, so the
    // caller that WAS waiting for the load then saw itself superseded and
    // skipped its paint too. Both left, nothing painted, and the capsule
    // stayed invisible for a whole recording — 2026-08-25 08:59:19, the
    // window created in 198 ms and first shown 6 s later by the stop.
    if (recordingStatusWindowLoadPromise) {
      await recordingStatusWindowLoadPromise;
    }
    return recordingStatusWindow && !recordingStatusWindow.isDestroyed() ? recordingStatusWindow : null;
  }
  if (recordingStatusWindowLoadPromise) {
    await recordingStatusWindowLoadPromise;
    return recordingStatusWindow && !recordingStatusWindow.isDestroyed() ? recordingStatusWindow : null;
  }

  recordingStatusWindowReady = false;
  const createStartedAt = Date.now();
  recordingStatusWindow = new BrowserWindow({
    ...recordingStatusCapsuleBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    hasShadow: false,
    title: "Transcriptor Recording",
    backgroundColor: "#00000000",
    webPreferences: {
      partition: RECORDING_STATUS_CAPSULE_SESSION_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      backgroundThrottling: false,
    },
  });

  recordingStatusWindow.setMenuBarVisibility(false);
  try { recordingStatusWindow.setAlwaysOnTop(true, "floating"); } catch { }
  try { recordingStatusWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { }
  recordingStatusWindow.on("closed", () => {
    recordingStatusWindow = null;
    recordingStatusWindowReady = false;
    recordingStatusWindowLoadPromise = null;
    cancelRecordingStatusCapsuleTeardown();
  });
  recordingStatusWindow.webContents.on("page-title-updated", (event, title) => {
    const raw = String(title || "");
    if (!raw.startsWith("__recording_capsule_")) return;
    event.preventDefault();
    noteRecordingStatusCapsuleInteraction();
    if (raw.startsWith("__recording_capsule_pointer__")) {
      return;
    }
    if (raw === "__recording_capsule_stop__") {
      recordingStopInFlight = true;
      // The capsule stops the recording. It does NOT touch the main
      // window — it used to hide it here, which is how pressing stop
      // could make the app vanish.
      guardedStopFromRecordingStatus("capsule-click");
      return;
    }
    if (raw.startsWith("__recording_capsule_geometry__")) {
      applyRecordingStatusCapsuleGeometryPayload(raw.replace("__recording_capsule_geometry__", ""));
      return;
    }
  });

  const html = recordingStatusCapsuleHtml();
  recordingStatusWindowLoadPromise = recordingStatusWindow
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .then(() => {
      recordingStatusWindowReady = true;
      recordingStatusCapsuleLastCreateMs = Date.now() - createStartedAt;
    })
    .catch((e) => {
      appendMainLog(`[recording-capsule] load failed: ${e?.message || e}`);
      if (recordingStatusWindow && !recordingStatusWindow.isDestroyed()) {
        recordingStatusWindow.destroy();
      }
    })
    .finally(() => {
      recordingStatusWindowLoadPromise = null;
    });
  await recordingStatusWindowLoadPromise;
  return recordingStatusWindow && !recordingStatusWindow.isDestroyed() ? recordingStatusWindow : null;
}

async function updateRecordingStatusCapsule(patch = {}) {
  Object.assign(recordingStatusCapsuleState, patch);
  const seq = ++recordingStatusCapsuleUpdateSeq;
  const requestedAt = Date.now();
  const status = String(recordingStatusCapsuleState.status || "").trim();
  if (!status) {
    hideRecordingStatusCapsule();
    return;
  }
  const presentation = recordingStatusPresentation(status, recordingStatusCapsuleState.kind);
  const mode = presentation.mode;
  const now = Date.now();
  const startedAt = Number(recordingStatusCapsuleState.startedAt || 0);
  const previousTimerRunning = !!recordingStatusCapsuleState.timerRunning;
  const timerCanRun = recordingStatusIsLive(presentation.kind) && startedAt > 0;
  if (timerCanRun) {
    recordingStatusCapsuleState.timerRunning = true;
    recordingStatusCapsuleState.elapsedMs = Math.max(0, now - startedAt);
  } else {
    if (previousTimerRunning && startedAt > 0) {
      recordingStatusCapsuleState.elapsedMs = Math.max(0, now - startedAt);
    }
    recordingStatusCapsuleState.timerRunning = false;
  }
  const capsuleWindow = await ensureRecordingStatusCapsuleWindow();
  if (!capsuleWindow || capsuleWindow.isDestroyed()) return;
  // Superseded while this call waited for the window. Safe only because
  // every caller now waits for the load: a caller that gives up early
  // while holding the newest sequence number silences the one that would
  // have painted.
  if (seq !== recordingStatusCapsuleUpdateSeq) return;
  try {
    capsuleWindow.setBounds(recordingStatusCapsuleBounds(), false);
  } catch { }
  if (!recordingStatusWindowReady) {
    // The load failed; ensure() already logged it. Nothing to paint on.
    appendMainLog(`[recording-capsule] update dropped: window never loaded (status="${status}")`);
    return;
  }
  const payload = {
    status,
    mode,
    tone: presentation.tone,
    startedAt: recordingStatusCapsuleState.startedAt,
    elapsedMs: Math.max(0, Number(recordingStatusCapsuleState.elapsedMs || 0)),
    timerRunning: !!recordingStatusCapsuleState.timerRunning,
    level: Math.max(0, Math.min(1, Number(recordingStatusCapsuleState.level || 0))),
  };
  try {
    await capsuleWindow.webContents.executeJavaScript(
      `window.__setCapsuleState(${JSON.stringify(payload)})`,
      true,
    );
    if (!capsuleWindow.isVisible()) {
      // `showInactive` on a `focusable: false` window: the capsule
      // appears without taking focus, without activating the app and
      // without reordering the main window. The lifecycle table is asked
      // anyway, so "the capsule appeared" is a transition on the record
      // and its answer — do nothing to the main window — is stated in
      // one place rather than assumed here.
      capsuleWindow.showInactive();
      applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.capsuleShown);
      appendMainLog(
        `[recording-capsule] visible status="${status}" ms=${Date.now() - requestedAt} ` +
        `create=${recordingStatusCapsuleLastCreateMs}ms`,
      );
      recordingStatusCapsuleLastCreateMs = 0;
    }
  } catch (e) {
    appendMainLog(`[recording-capsule] update failed: ${e?.message || e}`);
  }
}

function cancelRecordingStatusCapsuleTeardown() {
  if (recordingStatusTeardownTimer) {
    clearTimeout(recordingStatusTeardownTimer);
    recordingStatusTeardownTimer = null;
  }
}

function destroyRecordingStatusCapsuleWindow(reason) {
  cancelRecordingStatusCapsuleTeardown();
  const target = recordingStatusWindow;
  if (!target || target.isDestroyed()) return;
  // `closable: false` blocks `close()`, so `destroy()` is the only way
  // out for this window — it is also what the load-failure path already
  // uses. The "closed" handler nulls the module state.
  try {
    target.destroy();
    appendMainLog(`[recording-capsule] window destroyed (${reason})`);
  } catch (e) {
    appendMainLog(`[recording-capsule] destroy failed: ${e?.message || e}`);
  }
}

function scheduleRecordingStatusCapsuleTeardown() {
  cancelRecordingStatusCapsuleTeardown();
  if (!recordingStatusWindow || recordingStatusWindow.isDestroyed()) return;
  recordingStatusTeardownTimer = setTimeout(() => {
    recordingStatusTeardownTimer = null;
    // Re-check under the timer: an update that arrived after the hide
    // cancels the teardown via ensureRecordingStatusCapsuleWindow, but
    // a status set through some other path must not lose its window.
    if (String(recordingStatusCapsuleState.status || "").trim()) return;
    destroyRecordingStatusCapsuleWindow("idle");
  }, RECORDING_STATUS_CAPSULE_TEARDOWN_MS);
  // Never hold the event loop open for a teardown that quit would do
  // anyway.
  try { recordingStatusTeardownTimer.unref?.(); } catch { }
}

function hideRecordingStatusCapsule() {
  recordingStatusCapsuleUpdateSeq++;
  recordingStatusCapsuleState.status = "";
  recordingStatusCapsuleState.level = 0;
  recordingStatusCapsuleState.startedAt = 0;
  recordingStatusCapsuleState.elapsedMs = 0;
  recordingStatusCapsuleState.timerRunning = false;
  recordingStatusCapsuleGeometry = null;
  recordingStatusCapsuleLastLevelSent = -1;
  recordingStatusCapsuleLastLevelSentAt = 0;
  if (recordingStatusWindow && !recordingStatusWindow.isDestroyed()) {
    if (recordingStatusWindowReady) {
      recordingStatusWindow.webContents.executeJavaScript(
        `(() => {
          window.__setCapsuleState(${JSON.stringify({ status: "", mode: "idle", startedAt: 0, elapsedMs: 0, timerRunning: false, level: 0 })});
          return true;
        })();`,
        true,
      ).catch(() => { });
    }
    try { recordingStatusWindow.hide(); } catch { }
    scheduleRecordingStatusCapsuleTeardown();
  }
}

function stopRecordingStateMonitor() {
  if (recordingStateMonitor) {
    clearInterval(recordingStateMonitor);
    recordingStateMonitor = null;
  }
}

function startRecordingStateMonitor() {
  stopRecordingStateMonitor();
  recordingStateMonitor = setInterval(() => {
    if (!win || win.isDestroyed() || !win.webContents) return;
    win.webContents
      .executeJavaScript(
        `(() => {
          const vu = Number(window.__transcriptorVuLevel || 0);
          const rms = Number(window.__transcriptorRmsLevel || 0);
          const lastFrameAt = Number(window.__transcriptorLastFrameAt || 0);
          const isRec = !!window.__transcriptorIsRecording;
          return {
            vu: Number.isFinite(vu) ? vu : 0,
            rms: Number.isFinite(rms) ? rms : 0,
            lastFrameAt: Number.isFinite(lastFrameAt) ? lastFrameAt : 0,
            isRec
          };
        })();`,
        true
      )
      .then((state) => {
        const safeLevel = Math.max(0, Math.min(1, Number(state?.vu) || 0));
        const safeRms = Math.max(0, Number(state?.rms) || 0);
        const safeLastFrameAt = Math.max(0, Number(state?.lastFrameAt) || 0);
        const isRec = !!state?.isRec;
        const now = Date.now();
        recordingStatusCapsuleState.level = safeLevel;
        if (recordingStatusWindow && !recordingStatusWindow.isDestroyed() && recordingStatusWindow.isVisible()) {
          const shouldPublishLevel =
            recordingStatusCapsuleLastLevelSent < 0 ||
            Math.abs(safeLevel - recordingStatusCapsuleLastLevelSent) >= RECORDING_STATUS_LEVEL_MIN_DELTA ||
            (now - recordingStatusCapsuleLastLevelSentAt) >= RECORDING_STATUS_LEVEL_MAX_STALE_MS;
          if (!recordingStatusCapsuleLevelUpdateInFlight) {
            if (shouldPublishLevel) {
              recordingStatusCapsuleLevelUpdateInFlight = true;
              recordingStatusCapsuleLastLevelSent = safeLevel;
              recordingStatusCapsuleLastLevelSentAt = now;
              updateRecordingStatusCapsule({ level: safeLevel })
                .catch((e) => {
                  appendMainLog(`[recording-capsule] level update failed: ${e?.message || e}`);
                })
                .finally(() => {
                  recordingStatusCapsuleLevelUpdateInFlight = false;
                });
            }
          }
        }
        const cfg = recordingAutoStopConfig || DEFAULT_RECORDING_AUTO_STOP_CONFIG;
        if (safeLastFrameAt > 0) recordingSeenAudioFrames = true;
        if (now - recordingAutoStopConfigRefreshAt > RECORDING_AUTOSTOP_CONFIG_REFRESH_MS) {
          recordingAutoStopConfigRefreshAt = now;
          const gen = ++recordingAutoStopConfigGen;
          getRendererAutoStopSilenceConfig().then((nextCfg) => {
            // Drop the result if a new recording session bumped the
            // generation while we were awaiting — the old config would
            // otherwise overwrite freshly set values from the new
            // session's recording status state.
            if (gen === recordingAutoStopConfigGen) {
              recordingAutoStopConfig = nextCfg;
            }
          }).catch(() => { });
        }
        const silenceDetectionActive = isRec && cfg.enabled && !recordingStopInFlight;
        const pastWarmup = !recordingStartedAt || (now - recordingStartedAt) >= RECORDING_AUTOSTOP_WARMUP_MS;
        if (!silenceDetectionActive || !pastWarmup) {
          recordingSilenceStartedAt = 0;
        } else {
          const thresholdRms = Math.pow(10, Number(cfg.thresholdDb) / 20);
          // Only use dB-based silence detection — no staleAudioFrames shortcut.
          // staleAudioFrames was causing false stops during active speech when
          // the audio pipeline had minor hiccups.
          const consideredSilent = safeRms <= thresholdRms;
          if (consideredSilent) {
            if (!recordingSilenceStartedAt) {
              recordingSilenceStartedAt = now;
              // Announce the countdown. The capsule has always had a
              // dedicated "autostop" look — amber icon, amber wave, timer
              // still running — and nothing ever reached it, because the
              // only way in was a status text containing "auto stop" and
              // no producer wrote one. So a recording was killed by a
              // pause in the user's thought with no warning and no way to
              // cancel it except by noticing it had happened. Now the
              // capsule turns amber and says how long is left, and the
              // countdown is cancelled by speaking again.
              void publishRecordingStatus(
                `Auto stop in ${Math.ceil(Number(cfg.seconds))}s`,
                RECORDING_STATUS_KIND.AUTOSTOP,
              ).catch(() => { });
            }
            const silentElapsed = now - recordingSilenceStartedAt;
            if (silentElapsed >= Number(cfg.seconds) * 1000) {
              recordingSilenceStartedAt = 0;
              recordingStopInFlight = true;
              stopRecordingStateMonitor();
              appendMainLog(`[recording-autostop] trigger level=${safeLevel.toFixed(4)} rms=${safeRms.toFixed(6)} lastFrameAge=${safeLastFrameAt ? (now - safeLastFrameAt) : -1} cfgSec=${Number(cfg.seconds)} cfgDb=${Number(cfg.thresholdDb)}`);
              guardedStopFromRecordingStatus("autostop");
            }
          } else {
            // The user spoke again: cancel the countdown and say so.
            if (recordingSilenceStartedAt) {
              void publishRecordingStatus("Recording", RECORDING_STATUS_KIND.RECORDING).catch(() => { });
            }
            recordingSilenceStartedAt = 0;
          }
        }
        // Fail-safe: if the audio pipeline is truly dead (no frames for
        // 8 s) force a stop so the session can't hang forever. This is
        // NOT silence detection and must NOT be gated on the auto-stop
        // setting — it previously lived inside the ``cfg.enabled``
        // branch, so for every user with auto-stop OFF (the default) a
        // dead mic/worklet left the capsule recording indefinitely with
        // no way out but quitting the app.
        const staleAudioFrames =
          isRec &&
          !recordingStopInFlight &&
          recordingSeenAudioFrames &&
          safeLastFrameAt > 0 &&
          (now - safeLastFrameAt) > RECORDING_DEAD_PIPELINE_MS;
        if (staleAudioFrames) {
          recordingStopInFlight = true;
          stopRecordingStateMonitor();
          appendMainLog(`[recording-autostop-stale] audio pipeline dead for ${Math.round(RECORDING_DEAD_PIPELINE_MS / 1000)}s, forcing stop`);
          guardedStopFromRecordingStatus("autostop-stale");
        }
      })
      .catch(() => { });
  }, RECORDING_STATUS_LEVEL_POLL_MS);
  try { recordingStateMonitor.unref?.(); } catch { }
}

async function beginRecordingStatusSession() {
  recordingSilenceStartedAt = 0;
  recordingAutoStopConfigRefreshAt = 0;
  recordingStartedAt = Date.now();
  recordingStatusCapsuleState.startedAt = recordingStartedAt;
  recordingStatusCapsuleState.elapsedMs = 0;
  recordingStatusCapsuleState.timerRunning = true;
  recordingStatusCapsuleState.level = 0;
  recordingStatusCapsuleLastLevelSent = -1;
  recordingStatusCapsuleLastLevelSentAt = 0;
  recordingSeenAudioFrames = false;
  recordingAutoStopConfig = DEFAULT_RECORDING_AUTO_STOP_CONFIG;
  startRecordingStateMonitor();
  await setRecordingStatus("Recording", RECORDING_STATUS_KIND.RECORDING);
  // Guarded by the same generation counter the monitor's own refresh
  // uses: this await crosses a renderer round-trip, and a session that
  // was reset while it was in flight must not have the PREVIOUS take's
  // auto-stop config installed on top of its defaults.
  const gen = ++recordingAutoStopConfigGen;
  const cfg = await getRendererAutoStopSilenceConfig();
  if (gen === recordingAutoStopConfigGen) recordingAutoStopConfig = cfg;
}

async function publishRecordingStatus(status, kind = "") {
  const text = String(status || "").trim();
  if (!text) return;
  await setRecordingStatus(text, kind);
}

function resetRecordingStatusState() {
  recordingStopInFlight = false;
  recordingSilenceStartedAt = 0;
  recordingAutoStopConfigRefreshAt = 0;
  recordingAutoStopConfigGen++;
  recordingStartedAt = 0;
  recordingSeenAudioFrames = false;
  hideRecordingStatusCapsule();
  void setRendererMainStatus("Idle").catch((e) => {
    appendMainLog(`[recording-status] renderer idle publish failed: ${e?.message || e}`);
  });
  stopRecordingStateMonitor();
  if (!postStopWorkerRunning && postStopQueue.length === 0 && pendingTranscriptionCount !== 0) {
    appendMainLog(`[recording-status] reset-stale-pending=${pendingTranscriptionCount}`);
    pendingTranscriptionCount = 0;
  }
}

async function setRendererMainStatus(text) {
  const status = String(text || "").trim();
  if (!status) return;
  await execRendererJsWithTimeout(
    `(() => {
      const fn = window.__transcriptorSetMainStatus;
      if (typeof fn !== 'function') return false;
      return !!fn(${JSON.stringify(status)});
    })();`,
    false,
    500,
  );
}

/**
 * Publish a status to the capsule and to the main window.
 *
 * `kind` is the producer's own answer to "what state is this?" — pass it
 * whenever the caller knows, which is everywhere in this file. It is
 * what stops a terminal error ("Mic Not Started") from being drawn as
 * work in progress because its wording happened to miss two substring
 * ladders. Omitting it falls back to classifying the text, which is what
 * renderer-authored statuses need.
 */
async function setRecordingStatus(text, kind = "") {
  const status = String(text || "").trim();
  if (!status) return;
  await updateRecordingStatusCapsule({ status, kind: String(kind || "") });
  await setRendererMainStatus(status);
}

async function isRendererRecording() {
  if (!win || win.isDestroyed() || !win.webContents) return false;
  const recording = await safeExec("isRendererRecording", () =>
    win.webContents.executeJavaScript(
      `(() => { return !!(window.__transcriptorIsRecording); })();`,
      true
    )
  );
  return !!recording;
}

async function ensureBackgroundWindow() {
  if (win && !win.isDestroyed() && win.webContents) return;
  // Losing the window now means the app is on its way out (rule 4:
  // closing it quits) or the renderer died. Neither is a moment to build
  // a new one during teardown.
  if (isQuitting) return;
  await createWindow({ showWindow: false });
}

async function waitForRendererUiReady(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!win || win.isDestroyed() || !win.webContents) return false;
    try {
      const remainingMs = Math.max(100, timeoutMs - (Date.now() - started));
      const ready = await execRendererJsWithTimeout(
        `(() => typeof window.__transcriptorLiveStatusSnapshot === 'function')();`,
        false,
        Math.min(500, remainingMs)
      );
      if (ready) return true;
    } catch { }
    await sleep(120);
  }
  return false;
}

/**
 * Is the microphone already ours to open?
 *
 * ``getMediaAccessStatus`` is synchronous, so the common case — access
 * granted long ago — costs nothing and lets the press be dispatched
 * without a round trip. Anything else routes through
 * ``requestMacMicrophonePermissionOnce``, which may prompt.
 */
function macMicrophoneAccessGranted() {
  if (process.platform !== "darwin") return true;
  try {
    return String(systemPreferences.getMediaAccessStatus("microphone") || "") === "granted";
  } catch {
    return false;
  }
}

/**
 * Ask the renderer everything the press needs to know, and act on it, in
 * one ``executeJavaScript`` round trip.
 *
 * ``allowStart`` is the main process's veto: when the renderer is idle
 * and the main process already knows a start cannot proceed (post-stop
 * work still holding the single capsule, microphone permission not
 * granted), nothing is dispatched and the caller decides what to tell
 * the user. A stop is never vetoed.
 *
 * Returns null when the renderer did not answer inside the budget — the
 * 2 s ceiling that keeps a wedged renderer from turning the hotkey into
 * a permanent no-op.
 */
/**
 * A stop of a recording the renderer threw away produces nothing: no
 * transcript, no history entry, no paste — and, the part that was
 * actually breaking recordings, no post-stop work for the next press to
 * queue behind.
 *
 * The user's report: two fast presses, and the second "start" was
 * refused with ``start blocked by single-capsule post-stop work`` while
 * a 3-second fragment went to the clipboard. The block is correct — one
 * capsule at a time — but there was no work worth blocking for.
 */
async function dispatchRendererTogglePress(allowStart) {
  return execRendererJsWithTimeout(
    `
    (() => {
      const uiReady = typeof window.__transcriptorLiveStatusSnapshot === 'function';
      const isRec = !!(window.__transcriptorIsRecording);
      const recordingId = Number(window.__transcriptorCurrentRecordingId || 0);
      const auto = !!(document.getElementById('autoTranscribeToggle') && document.getElementById('autoTranscribeToggle').checked);
      const liveSnapshot = uiReady ? window.__transcriptorLiveStatusSnapshot() : null;
      const autoSendEnter = !!liveSnapshot?.autoSendEnter;
      const timerText = String(liveSnapshot?.timerText || '00:00').trim();
      // The renderer owns the recording clock and the floor under it.
      // Asking it — rather than timing the press here — is what keeps
      // the two processes from disagreeing about whether this stop
      // produced anything.
      const tooShort = isRec && typeof window.__transcriptorRecordingTooShort === 'function'
        ? !!window.__transcriptorRecordingTooShort()
        : false;
      const state = { ok: true, uiReady, wasRecording: isRec, recording: isRec, dispatched: false, discarded: tooShort, auto, autoSendEnter, timerText, recordingId };
      if (!uiReady) return state;
      if (!isRec && !${allowStart ? "true" : "false"}) return state;
      window.dispatchEvent(new Event('transcriptor-hotkey-toggle'));
      state.dispatched = true;
      state.recording = !isRec;
      return state;
    })();
    `,
    null,
    2000,
  );
}

async function toggleRecordingFromShortcut() {
  if (shortcutToggleInFlight) return;
  const trace = createTrace("toggle_hotkey", {});
  shortcutToggleInFlight = true;
  let keepCapturedTarget = false;
  const frontAtHotkeyPromise = getFrontmostAppInfoWithTimeout(1200);
  try {
    const activePostStopAtPress = hasActivePostStopWork();
    await ensureBackgroundWindow();
    if (!win || win.isDestroyed() || !win.webContents) {
      traceStep(trace, "app_not_ready", {});
      await setRecordingStatus("App Not Ready", RECORDING_STATUS_KIND.WARN);
      resetRecordingStatusState();
      traceEnd(trace, "failed", { reason: "window-not-ready" });
      return;
    }

    // One round trip decides the press. The sequential shape asked the
    // renderer three questions — is the UI ready, are you recording, now
    // toggle — and the microphone could not open until all three answers
    // had come back. The toggle handler reads both facts anyway, so
    // ``dispatchRendererTogglePress`` asks them together and a press
    // reaches ``startLive`` in one hop.
    const postStopActive = activePostStopAtPress || hasActivePostStopWork();
    let result = await dispatchRendererTogglePress(!postStopActive && macMicrophoneAccessGranted());
    if (result && result.uiReady === false) {
      // Cold renderer: fall back to the wait loop and ask once more when
      // it has finished booting.
      const ready = await waitForRendererUiReady();
      traceStep(trace, "renderer_ready_wait", { ready: !!ready });
      if (ready) {
        result = await dispatchRendererTogglePress(!postStopActive && macMicrophoneAccessGranted());
      }
    }
    if (result === null) {
      // Renderer didn't respond inside the budget — log, release the
      // inflight guard via the outer finally, and let the user retry.
      appendMainLog("[shortcut] toggle aborted: renderer probe timed out (2s)");
      resetRecordingStatusState();
      traceEnd(trace, "failed", { reason: "renderer-probe-timeout" });
      return;
    }
    if (!result?.ok || !result.uiReady) {
      traceStep(trace, "renderer_not_ready", { result: result || null });
      await setRecordingStatus("App Loading", RECORDING_STATUS_KIND.WARN);
      resetRecordingStatusState();
      traceEnd(trace, "failed", { reason: "renderer-not-ready" });
      return;
    }
    traceStep(trace, "renderer_toggle", {
      dispatched: !!result.dispatched,
      wasRecording: !!result.wasRecording,
    });

    if (result.discarded) {
      // The renderer threw this recording away — it was shorter than the
      // floor, i.e. a double-tap on the hotkey. There is no transcript
      // coming, so queueing post-stop work would only block the next
      // press behind a capsule that has nothing to do.
      appendMainLog(`[shortcut] discarded a too-short recording rec=${Number(result.recordingId || 0)}`);
      traceStep(trace, "recording_discarded", {
        recordingId: Number(result.recordingId || 0),
        timerText: result.timerText || "",
      });
      stopRecordingStateMonitor();
      resetRecordingStatusState();
      traceEnd(trace, "discarded", { reason: "below-minimum-duration" });
      return;
    }

    // Published, not awaited. Creating the capsule window costs 110-380 ms
    // (it is destroyed 8 s after going idle, so most presses pay a fresh
    // create) and the microphone has no reason to wait behind it — the
    // renderer already has the press. A later status supersedes this one
    // through the capsule's update sequence, so a slow create can never
    // repaint a state the app has left.
    const transitionStatus = result.wasRecording || postStopActive ? "Transcribing" : "Starting";
    void publishRecordingStatus(transitionStatus).catch((e) => {
      appendMainLog(`[recording-status] transition publish failed: ${e?.message || e}`);
    });
    traceStep(trace, "recording_status_published", {
      status: transitionStatus,
      recording: !!result.wasRecording,
      postStopActive: !!postStopActive,
    });

    if (!result.dispatched) {
      // The renderer was idle and the main process withheld the start.
      // Two possible reasons, answered in the order the sequential code
      // checked them.
      if (postStopActive) {
        appendMainLog(
          `[shortcut] start blocked by single-capsule post-stop work ` +
          `pending=${pendingTranscriptionCount} queue=${postStopQueue.length} worker=${postStopWorkerRunning ? 1 : 0}`,
        );
        traceStep(trace, "single_capsule_busy", {
          pending: pendingTranscriptionCount,
          queue: postStopQueue.length,
          worker: !!postStopWorkerRunning,
        });
        traceEnd(trace, "blocked", { reason: "single-capsule-post-stop-active" });
        return;
      }
      const micGranted = await requestMacMicrophonePermissionOnce();
      if (!micGranted) {
        traceStep(trace, "mic_permission_denied", {});
        await setRecordingStatus("Grant Access", RECORDING_STATUS_KIND.WARN);
        resetRecordingStatusState();
        traceEnd(trace, "failed", { reason: "mic-permission-denied" });
        return;
      }
      result = await dispatchRendererTogglePress(true);
      if (!result?.dispatched) {
        traceStep(trace, "renderer_toggle_failed", { result: result || null });
        await setRecordingStatus("App Loading", RECORDING_STATUS_KIND.WARN);
        resetRecordingStatusState();
        traceEnd(trace, "failed", { reason: "renderer-toggle-failed" });
        return;
      }
    }

    if (result.recording) {
      const confirmedStart = await waitForRendererRecordingStart();
      if (!confirmedStart.confirmed) {
        appendMainLog(
          `[shortcut] recording start not confirmed within ` +
          `${RENDERER_RECORDING_START_CONFIRM_TIMEOUT_MS}ms ` +
          `recording=${confirmedStart.recording ? 1 : 0} rec=${Number(confirmedStart.recordingId || 0)}`,
        );
        traceStep(trace, "recording_start_not_confirmed", {
          recording: !!confirmedStart.recording,
          recordingId: Number(confirmedStart.recordingId || 0),
          timeoutMs: RENDERER_RECORDING_START_CONFIRM_TIMEOUT_MS,
        });
        await setRecordingStatus("Mic Not Started", RECORDING_STATUS_KIND.FAIL);
        await sleep(RECORDING_STATUS_TERMINAL_DWELL_MS);
        resetRecordingStatusState();
        traceEnd(trace, "failed", { reason: "recording-start-not-confirmed" });
        return;
      }
      // The frontmost-app lookup was fired at the press, so it reports
      // the app the user was in when they hit the key no matter when it
      // is read. It is awaited here rather than before the dispatch: it
      // is an ``osascript`` spawn (60-250 ms measured) and auto-paste
      // needs its answer at stop, not at start.
      const front = await frontAtHotkeyPromise;
      traceStep(trace, "front_before", {
        name: front.name || "",
        pid: front.pid || 0,
        windowTitle: compactLogText(front.windowTitle || "", 80),
        timedOut: !!front.timedOut,
        source: "hotkey-press",
      });
      setCapturedPasteTarget(capturePasteTargetFromFrontInfo(front));
      keepCapturedTarget = true;
      traceStep(trace, "target_captured", {
        target: pasteTargetSummary(pasteTarget),
      });
      traceStep(trace, "recording_started", {
        auto: !!result.auto,
        timerText: result.timerText || "",
        recordingId: Number(confirmedStart.recordingId || 0),
      });
      await beginRecordingStatusSession();
      traceEnd(trace, "recording-started", {});
      return;
    }

    if (result.auto) {
      traceStep(trace, "recording_stopped", { autoTranscribe: true, timerText: result.timerText || "" });
      enqueuePostStopTask({
        autoTranscribe: true,
        autoSendEnter: !!result.autoSendEnter,
        stopRequestedAt: Date.now(),
        recordingId: Number(result.recordingId || 0),
        target: pasteTarget,
      });
      stopRecordingStateMonitor();
    } else {
      traceStep(trace, "recording_stopped", { autoTranscribe: false, timerText: result.timerText || "" });
      // Kill recording monitor immediately — recording is done.
      stopRecordingStateMonitor();
      await setRecordingStatus("Saved To App", RECORDING_STATUS_KIND.OK);
      resetRecordingStatusState();
    }
    traceEnd(trace, "done", {});
  } finally {
    shortcutToggleInFlight = false;
    if (!keepCapturedTarget) {
      clearCapturedPasteTarget();
    }
  }
}

/**
 * Fire-and-forget wrapper for ``stopRecordingFromMainProcess`` with a
 * hard deadline. If the stop call hangs (e.g., renderer is
 * unresponsive), the recording state machine would be stuck with
 * ``recordingStopInFlight = true`` forever, permanently blocking new
 * recordings. This wrapper clears the flag on EVERY exit path —
 * resolve, reject, OR timeout — and resets recording status state if the stop
 * never completed.
 */
function guardedStopFromRecordingStatus(reason) {
  const deadlineMs = 12000;
  let settled = false;
  const finish = (why, err) => {
    if (settled) return;
    settled = true;
    recordingStopInFlight = false;
    if (err) {
      appendMainLog(`[recording-${reason}-error] ${compactLogText(err?.message || err)}`);
    } else if (why === "timeout") {
      appendMainLog(`[recording-${reason}-timeout] stopRecordingFromMainProcess exceeded ${deadlineMs}ms deadline`);
    }
    if (why !== "resolve") {
      resetRecordingStatusState();
    }
  };
  const timer = setTimeout(() => finish("timeout"), deadlineMs);
  stopRecordingFromMainProcess().then(
    () => {
      clearTimeout(timer);
      finish("resolve");
    },
    (err) => {
      clearTimeout(timer);
      finish("reject", err);
    }
  );
}

async function stopRecordingFromMainProcess() {
  await ensureBackgroundWindow();
  if (!win || win.isDestroyed() || !win.webContents) return;
  // Stopping a recording is not a window operation. This used to hide
  // the main window so the paste target stayed frontmost; the paste
  // ladder captures and re-activates its target itself
  // (activateCapturedPasteTarget), so the hide bought nothing and cost
  // the user their window.

  try {
    const snapshot = await queryRendererRecordingState().catch(() => ({ recording: false, recordingId: 0 }));
    const expectedRecordingId = Number(snapshot?.recordingId || 0);
    const result = snapshot?.recording
      ? await execRendererJsWithTimeout(
        `
        (() => {
          const expectedRecordingId = ${JSON.stringify(expectedRecordingId)};
          const isRec = !!(window.__transcriptorIsRecording);
          const recordingId = Number(window.__transcriptorCurrentRecordingId || 0);
          const auto = !!(document.getElementById('autoTranscribeToggle') && document.getElementById('autoTranscribeToggle').checked);
          const liveSnapshot = typeof window.__transcriptorLiveStatusSnapshot === 'function'
            ? window.__transcriptorLiveStatusSnapshot()
            : null;
          const timerText = String(liveSnapshot?.timerText || '00:00').trim();
          const autoSendEnter = !!liveSnapshot?.autoSendEnter;
          if (!isRec) return { ok: false, recording: false, timerText, recordingId, auto, autoSendEnter };
          if (expectedRecordingId > 0 && recordingId !== expectedRecordingId) {
            return { ok: false, recording: true, stale: true, timerText, recordingId, expectedRecordingId, auto, autoSendEnter };
          }
          // Use a dedicated stop event so main-process stops have one renderer entrypoint.
          window.dispatchEvent(new CustomEvent('transcriptor-hotkey-stop', { detail: { recordingId } }));
          return { ok: true, recording: false, timerText, recordingId, auto, autoSendEnter };
        })();
        `,
        null,
        2000,
      )
      : {
        ok: false,
        recording: false,
        timerText: "",
        recordingId: expectedRecordingId,
        auto: false,
        autoSendEnter: false,
      };

    if (!result) {
      appendMainLog("[recording-stop] renderer stop request timed out");
      await setRecordingStatus("App Loading", RECORDING_STATUS_KIND.WARN);
      resetRecordingStatusState();
    } else if (result?.stale) {
      appendMainLog(
        `[recording-stop] stale stop ignored current=${Number(result.recordingId || 0)} expected=${Number(result.expectedRecordingId || 0)}`
      );
      // The recording continues, so the monitor must too. Both callers
      // that can reach a stale stop — the silence auto-stop and the
      // capsule click — call stopRecordingStateMonitor() before coming
      // in, and beginRecordingStatusSession (the only other place that
      // starts it) does not run on this path. Without the restart the
      // capsule level freezes, the silence auto-stop silently stops
      // working, and the dead-audio fail-safe that exists to stop a dead
      // mic leaving the capsule recording forever is gone — all for the
      // rest of the take. Restoring the status here without restoring
      // the monitor was half the recovery.
      startRecordingStateMonitor();
      await setRecordingStatus("Recording", RECORDING_STATUS_KIND.RECORDING);
    } else if (result?.ok) {
      if (result.auto) {
        enqueuePostStopTask({
          autoTranscribe: true,
          autoSendEnter: !!result.autoSendEnter,
          stopRequestedAt: Date.now(),
          recordingId: Number(result.recordingId || 0),
          target: pasteTarget,
        });
        stopRecordingStateMonitor();
      } else {
        await setRecordingStatus("Saved To App", RECORDING_STATUS_KIND.OK);
        resetRecordingStatusState();
      }
    } else {
      await setRecordingStatus("Saved To App", RECORDING_STATUS_KIND.OK);
      resetRecordingStatusState();
    }
  } finally {
    clearCapturedPasteTarget();
  }
}

// Maximum time we wait on the renderer for a state snapshot. If the
// renderer is stuck (infinite loop, ongoing synchronous work, blocked
// on a pending IPC), ``executeJavaScript`` never resolves — and the
// recording stop path sits forever waiting for getLatestTranscriptText.
// 2 s is long enough for a healthy renderer under load but short
// enough that a stuck renderer still lets the user stop cleanly.
const RENDERER_STATE_QUERY_TIMEOUT_MS = 2000;
const RENDERER_RECORDING_START_CONFIRM_TIMEOUT_MS = 8000;
const RENDERER_RECORDING_START_CONFIRM_POLL_MS = 80;

async function queryRendererState() {
  if (!win || win.isDestroyed() || !win.webContents) return null;
  // Attach a no-op ``.catch`` to the executeJavaScript promise up-front so
  // a late rejection (renderer crashes AFTER our Promise.race timeout
  // already gave up waiting) doesn't surface as an unhandledRejection in
  // the main process. We still return null via the timeoutPromise path —
  // the queryPromise's eventual settlement is intentionally discarded.
  const queryPromise = win.webContents.executeJavaScript(
    `
    (() => {
      const finishedAt = Number(window.__transcriptorLastFinishedAt || 0);
      const finishedRecordingId = Number(window.__transcriptorLastFinishedRecordingId || 0);
      const finishedText = String(window.__transcriptorLastFinishedText || '').trim();
      const uiFinalAt = Number(window.__transcriptorLastUiFinalAt || 0);
      const uiFinalRecordingId = Number(window.__transcriptorLastUiFinalRecordingId || 0);
      const uiFinalText = String(window.__transcriptorLastUiFinalText || '').trim();
      const uiFinalKind = String(window.__transcriptorLastUiFinalKind || '').trim();
      const finishedRecords = Array.isArray(window.__transcriptorFinishedRecords)
        ? window.__transcriptorFinishedRecords
          .map((x) => ({
            recordingId: Number((x && x.recordingId) || 0),
            finishedAt: Number((x && x.finishedAt) || 0),
            text: String((x && x.text) || '').trim(),
          }))
          .filter((x) => x.recordingId > 0 && x.finishedAt > 0 && x.text.length > 0)
          .slice(-${RENDERER_FINISHED_RECORDS_LIMIT})
        : [];
      const isRec = !!(window.__transcriptorIsRecording);
      const liveSnapshot = typeof window.__transcriptorLiveStatusSnapshot === 'function'
        ? window.__transcriptorLiveStatusSnapshot()
        : null;
      const status = String(liveSnapshot?.status || '').trim();
      const statusKind = String(liveSnapshot?.statusKind || '').trim();
      const finalText = (document.getElementById('finalOutput')?.textContent || '').trim();
      const liveText = (document.getElementById('liveOutput')?.textContent || '').trim();
      const busy = !!liveSnapshot?.busy;
      const progressVisible = document.getElementById('progressRow') ? !document.getElementById('progressRow').hidden : false;
      return {
        finishedAt,
        finishedRecordingId,
        finishedText,
        uiFinalAt,
        uiFinalRecordingId,
        uiFinalText,
        uiFinalKind,
        finishedRecords,
        isRec,
        status,
        statusKind,
        finalText,
        liveText,
        busy,
        progressVisible,
      };
    })();
    `,
    true
  ).catch(() => null);
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      appendMainLog(
        `[renderer-state-query-timeout] ms=${RENDERER_STATE_QUERY_TIMEOUT_MS}`,
      );
      resolve(null);
    }, RENDERER_STATE_QUERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([queryPromise, timeoutPromise]);
  } catch {
    return null;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function queryRendererRecordingState() {
  const state = await execRendererJsWithTimeout(
    `(() => ({ recording: !!window.__transcriptorIsRecording, recordingId: Number(window.__transcriptorCurrentRecordingId || 0) }))();`,
    { recording: false, recordingId: 0 },
    1000,
  );
  return state && typeof state === "object"
    ? state
    : { recording: false, recordingId: 0 };
}

async function waitForRendererRecordingStart(
  timeoutMs = RENDERER_RECORDING_START_CONFIRM_TIMEOUT_MS,
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let lastState = { recording: false, recordingId: 0 };
  while (Date.now() < deadline) {
    lastState = await queryRendererRecordingState().catch(() => ({ recording: false, recordingId: 0 }));
    if (lastState?.recording && Number(lastState.recordingId || 0) > 0) {
      return {
        confirmed: true,
        recording: true,
        recordingId: Number(lastState.recordingId || 0),
      };
    }
    await sleep(RENDERER_RECORDING_START_CONFIRM_POLL_MS);
  }
  return {
    confirmed: false,
    recording: !!lastState?.recording,
    recordingId: Number(lastState?.recordingId || 0),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyCapturedPasteTarget() {
  return {
    appName: "",
    pid: 0,
    windowTitle: "",
    windowId: "",
    hwnd: "",
    className: "",
    instanceName: "",
    // macOS only: the target's CFBundleIdentifier. It is what
    // pasteVerificationKey keys the per-app verification memory on, so a
    // renamed app does not inherit another app's verdict and two apps
    // called "Notes" do not share one.
    bundleId: "",
  };
}

function normalizeCapturedPasteTarget(target) {
  const src = target && typeof target === "object" ? target : {};
  return {
    appName: String(src.appName ?? src.name ?? src.targetName ?? "").trim(),
    pid: Number.parseInt(String(src.pid ?? src.targetPid ?? 0), 10) || 0,
    windowTitle: String(src.windowTitle || "").trim(),
    windowId: normalizeLinuxWindowId(src.windowId || ""),
    hwnd: normalizeWindowsHwnd(src.hwnd || ""),
    className: String(src.className || "").trim(),
    instanceName: String(src.instanceName || "").trim(),
    bundleId: String(src.bundleId || "").trim(),
  };
}

function cloneCapturedPasteTarget(target) {
  return normalizeCapturedPasteTarget(target);
}

function hasCapturedPasteTarget(target) {
  const normalized = normalizeCapturedPasteTarget(target);
  return (
    normalized.pid > 0 ||
    !!normalized.appName ||
    !!normalized.windowId ||
    !!normalized.hwnd
  );
}

function setCapturedPasteTarget(target) {
  pasteTarget = cloneCapturedPasteTarget(target);
}

function clearCapturedPasteTarget() {
  pasteTarget = emptyCapturedPasteTarget();
}

function capturePasteTargetFromFrontInfo(front) {
  if (!shouldUsePasteTarget(front)) return emptyCapturedPasteTarget();
  return normalizeCapturedPasteTarget({
    appName: front?.name,
    pid: front?.pid,
    windowTitle: front?.windowTitle,
    windowId: front?.windowId,
    hwnd: front?.hwnd,
    className: front?.className,
    instanceName: front?.instanceName,
    bundleId: front?.bundleId,
  });
}

function pasteTargetSummary(target) {
  const normalized = normalizeCapturedPasteTarget(target);
  return `app="${normalized.appName}" pid=${normalized.pid} windowTitle="${compactLogText(normalized.windowTitle, 80)}" windowId="${normalized.windowId}" hwnd="${normalized.hwnd}" class="${normalized.className}" instance="${normalized.instanceName}" bundleId="${normalized.bundleId}"`;
}

function getLastTranscriptPath() {
  try {
    return path.join(app.getPath("userData"), LAST_TRANSCRIPT_FILE);
  } catch {
    return "";
  }
}

/**
 * Sweep stale `last_transcript.json.tmp-*` files from userData on boot.
 * saveLastTranscriptToDisk writes via tmp+rename for atomicity; if
 * Electron crashes between write and rename, the tmp file lingers.
 * Over many crashes these accumulate. Called once at app.whenReady.
 *
 * Files modified within the last 60 s are preserved: the single-instance
 * lock prevents two Electron Transcriptor processes from running
 * concurrently, but a second-instance launch that loses the lock may
 * still have fired whenReady before app.quit() took effect. An mtime
 * floor ensures we never delete an in-flight tmp from the primary.
 */
function cleanupStaleTranscriptTmpFiles() {
  const p = getLastTranscriptPath();
  if (!p) return;
  const dir = path.dirname(p);
  const prefix = `${LAST_TRANSCRIPT_FILE}.tmp-`;
  const cutoff = Date.now() - 60_000;
  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > cutoff) continue;
        fs.unlinkSync(full);
      } catch { }
    }
  } catch { }
}

// Cache for the last-transcript file. Paste-last is triggered by a
// global hotkey and can fire rapidly; without a cache every press
// performed a synchronous stat + readFile + JSON.parse on the main
// process, blocking the Electron event loop. We key on the file's
// mtime so any external change (another process, manual edit,
// saveLastTranscriptToDisk) invalidates the cache automatically.
let _lastTranscriptCacheText = "";
let _lastTranscriptCacheMtimeMs = -1;

function loadLastTranscriptFromDisk() {
  const p = getLastTranscriptPath();
  if (!p) return "";
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    // File does not exist or stat failed — invalidate cache and return "".
    _lastTranscriptCacheText = "";
    _lastTranscriptCacheMtimeMs = -1;
    return "";
  }
  const mtimeMs = stat.mtimeMs;
  if (mtimeMs === _lastTranscriptCacheMtimeMs && _lastTranscriptCacheText) {
    return _lastTranscriptCacheText;
  }
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    const text = String(parsed?.text || "").trim();
    _lastTranscriptCacheText = text;
    _lastTranscriptCacheMtimeMs = mtimeMs;
    return text;
  } catch {
    _lastTranscriptCacheText = "";
    _lastTranscriptCacheMtimeMs = -1;
    return "";
  }
}

function saveLastTranscriptToDisk(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return;
  const p = getLastTranscriptPath();
  if (!p) return;
  const payload = JSON.stringify({ text: cleaned, updated_at: new Date().toISOString() }, null, 2);
  // Atomic write: temp file in the SAME directory (same filesystem,
  // avoiding EXDEV on cross-volume rename), then fs.renameSync which is
  // atomic on POSIX and Windows. A crash mid-write leaves the tmp file
  // behind as garbage but the real file stays consistent.
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, p);
    _lastTranscriptCacheText = cleaned;
    try {
      _lastTranscriptCacheMtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      _lastTranscriptCacheMtimeMs = -1;
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { }
    appendMainLog(`[save-last-transcript-error] ${compactLogText(e?.message || e)}`);
  }
}

// escapeAppleScriptString now lives in ./paste-script, next to the
// scripts it protects, so the escaping and the largest consumer of it
// cannot drift apart. It is required at the top of this file.

/**
 * Process-wide memory of which apps are worth verifying a paste into.
 * The decisions are pure (./paste-verification-policy); the one log line
 * per app that is switched off is the only side effect, and it belongs
 * here.
 */
const pasteVerificationPolicy = createPasteVerificationPolicy({
  onDisable: ({ key, limit }) => {
    appendMainLog(
      `[paste-verification] disabled for app="${key}" after ${limit} consecutive unverified pastes ` +
      "(accessibility reads skipped for this app for the lifetime of this process)"
    );
  },
});

function isBadActivationTarget(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return true;
  // Exact matches only for our own process family. Previous substring
  // check on "transcriptor" would exclude third-party apps whose name
  // or window title contains the word (e.g. "Audio Transcriptor Pro",
  // a browser tab titled "Transcriptor tutorial", another voice tool).
  // Electron helpers have deterministic suffixes that substring match
  // is correct for.
  if (n === "electron" || n === "transcriptor" || n === "transcriptor helper") return true;
  if (n.includes("helper (renderer)") ||
      n.includes("helper (gpu)") ||
      n.includes("helper (plugin)") ||
      n.includes("electron helper")) return true;
  return false;
}

function shouldUsePasteTarget(front) {
  const pid = Number(front?.pid || 0);
  const name = String(front?.name || "").trim().toLowerCase();
  if (pid > 0 && pid === process.pid) return false;
  // Exact match for our own app; substring would block legitimate
  // third-party apps with "transcriptor" in their window title.
  if (name === "transcriptor" || name === "transcriptor helper") return false;
  if (!name && pid <= 0) return false;
  return true;
}

/**
 * Does this failure name a macOS permission the user has to grant?
 *
 * The classification itself lives in ./paste-capability, so the trigger
 * below and the dialog's route are one decision. They used to be two
 * ladders over the same string: when the capability preflight began
 * refusing before the ladder could produce ERR:no-accessibility, the
 * status line learned its new verdict and this trigger did not, and the
 * app's only Accessibility prompt stopped firing.
 */
function needsMacPastePermissionPrompt(reason) {
  return classifyPastePermissionFailure(reason) !== PASTE_PERMISSION_ROUTE.NONE;
}

/**
 * The accelerator the "paste last transcript" hotkey is registered on,
 * as the user would press it. Read from the same published shortcut
 * status the renderer shows, so a status that names the hotkey can never
 * name one that is not actually registered.
 */
function pasteLastAccelerator() {
  return lastShortcutStatus?.paste?.active || lastShortcutStatus?.paste?.desired || "";
}

// The system paste chord — what the user presses to recover a transcript
// from the clipboard by hand. Named here because it is the ONLY recovery
// advice that is still true after the app's own paste-last hotkey has just
// failed.
function systemPasteAccelerator() {
  return process.platform === "darwin" ? "Cmd+V" : "Ctrl+V";
}

/**
 * Status text for a failed paste.
 *
 * `pasteAccel` is the key the status tells the user to press. It defaults to
 * the app's paste-last hotkey, which is right on the post-stop path — the
 * user has not tried it yet. It is NOT right on the paste-last path itself:
 * there the hotkey is the thing that just failed, and a status reading
 * "In Clipboard — press Alt+Shift+V" after Alt+Shift+V did nothing is advice
 * that loops. That caller passes the system chord instead.
 */
function recordingStatusForPasteFailure(reason, pasteAccel = pasteLastAccelerator()) {
  const r = String(reason || "").toLowerCase();
  // The capability preflight refused to even try (./paste-capability):
  // the grant is missing, or it survived the re-signed install and no
  // longer works. Both are fixed by a specific sequence of clicks, and a
  // status that just said "In Clipboard" would leave the user to guess
  // it. The transcript is on the clipboard either way.
  if (r.includes("paste-capability-")) {
    const capabilityStatus = pasteCapabilityStatusText();
    if (capabilityStatus) {
      return pasteAccel ? `${capabilityStatus} Then press ${pasteAccel} to paste.` : capabilityStatus;
    }
  }
  // Every other failure leaves the transcript on the clipboard too (see
  // keepTranscriptOnClipboardAfterFailure), so every one of them names
  // the hotkey that pastes it — the recovery is one keypress, and the
  // user cannot use it if nothing says which key.
  const hint = pasteAccel ? ` — press ${pasteAccel}` : "";
  return `${recordingStatusBadgeForPasteFailure(r)}${hint}`;
}

function recordingStatusBadgeForPasteFailure(r) {
  // The transcript is ALWAYS written to the system clipboard before
  // the paste attempt (see ``clipboard.writeText(transcript)`` in
  // processPostStopTask), so every failure mode below still leaves
  // the text available via Cmd+V. We prefer a status that tells the
  // user their text is safe rather than one that just says
  // "failed" — "In Clipboard" is the clearest signal that recovery
  // is one keypress away. The explicit permission flows
  // (no-accessibility, automation) still open System Settings via
  // the separate callback path, so the user can grant access AND
  // knows the text survived.
  if (r.includes("no-accessibility")) return "In Clipboard · Accessibility";
  if (r.includes("no-target") || r.includes("no-focus") || r.includes("not-editable") || r.includes("ax-failed")) return "In Clipboard · No Focus";
  if (r.includes("clipboard")) return "Clipboard Error";
  if (classifyPastePermissionFailure(r) === PASTE_PERMISSION_ROUTE.AUTOMATION) return "In Clipboard · Automation";
  return "In Clipboard";
}

function recordingStatusForAutoSendFailure(reason) {
  const r = String(reason || "").toLowerCase();
  if (classifyPastePermissionFailure(r) === PASTE_PERMISSION_ROUTE.AUTOMATION) return "Send Failed · Automation";
  if (r.includes("no-target") || r.includes("no-focus") || r.includes("not-editable") || r.includes("ax-failed")) {
    return "Send Failed · No Focus";
  }
  return "Send Failed";
}

function openPrivacyAccessibilitySettings() {
  runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
    timeoutMs: 5000
  }).catch(() => { });
}

function openPrivacyAutomationSettings() {
  runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"], {
    timeoutMs: 5000
  }).catch(() => { });
}

function isLinuxWaylandSession() {
  return process.platform === "linux" && !!process.env.WAYLAND_DISPLAY;
}

function hasLinuxX11Session() {
  return process.platform === "linux" && !!process.env.DISPLAY;
}

function normalizeWindowsHwnd(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-f]+$/i.test(hex)) return "";
  return `0x${hex.replace(/^0+/, "") || "0"}`;
}

function normalizeLinuxWindowId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const parsed = raw.startsWith("0x")
    ? Number.parseInt(raw.slice(2), 16)
    : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  return `0x${parsed.toString(16)}`;
}

function linuxWindowIdToDecimal(value) {
  const normalized = normalizeLinuxWindowId(value);
  if (!normalized) return "";
  const parsed = Number.parseInt(normalized.slice(2), 16);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  return String(parsed);
}

function normalizeLinuxMatchValue(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreLinuxTargetCandidate(candidate, target) {
  const c = normalizeLinuxMatchValue(candidate);
  const t = normalizeLinuxMatchValue(target);
  if (!c || !t) return 0;
  if (c === t) return 40;
  if (c.startsWith(`${t}.`) || c.endsWith(`.${t}`)) return 32;
  if (c.includes(t)) return 24;
  if (t.includes(c) && c.length >= 4) return 12;
  return 0;
}

async function getLinuxProcessName(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  const res = await runCommand("ps", ["-p", String(Math.trunc(n)), "-o", "comm="], {
    timeoutMs: 1500
  });
  if (!res.ok) return "";
  return String(res.stdout || "").trim();
}

async function listLinuxWindows() {
  if (!hasLinuxX11Session()) return [];
  const res = await runCommand("wmctrl", ["-lpGx"], { timeoutMs: 2000 });
  if (!res.ok) return [];
  const windows = [];
  const lines = String(res.stdout || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const wmClassInfo = parseLinuxWmClass(m[9]);
    windows.push({
      windowId: normalizeLinuxWindowId(m[1]),
      desktop: Number.parseInt(m[2], 10) || 0,
      pid: Number.parseInt(m[3], 10) || 0,
      host: String(m[8] || "").trim(),
      wmClass: wmClassInfo.wmClass,
      instanceName: wmClassInfo.instanceName,
      className: wmClassInfo.className,
      title: String(m[10] || "").trim(),
    });
  }
  return windows;
}

function pickLinuxTargetName(windowInfo, processName = "") {
  const className = String(windowInfo?.className || "").trim();
  if (className) return className;
  const instanceName = String(windowInfo?.instanceName || "").trim();
  if (instanceName) return instanceName;
  const proc = String(processName || "").trim();
  if (proc) return proc;
  return String(windowInfo?.title || "").trim();
}

function scoreLinuxWindowMatch(windowInfo, targetName) {
  const weightedFields = [
    { value: windowInfo?.className, weight: 400 },
    { value: windowInfo?.instanceName, weight: 340 },
    { value: windowInfo?.wmClass, weight: 280 },
    { value: windowInfo?.title, weight: 180 },
  ];
  let best = 0;
  for (const field of weightedFields) {
    const score = scoreLinuxTargetCandidate(field.value, targetName);
    if (score > 0) {
      best = Math.max(best, field.weight + score);
    }
  }
  return best;
}

async function findLinuxWindowByPid(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  const windows = await listLinuxWindows();
  const matches = windows.filter((w) => Number(w.pid || 0) === Math.trunc(n));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => {
    const aScore = (a.title ? 10 : 0) + (a.className ? 5 : 0);
    const bScore = (b.title ? 10 : 0) + (b.className ? 5 : 0);
    return bScore - aScore;
  })[0] || null;
}

async function findLinuxWindowByName(name) {
  const targetName = String(name || "").trim();
  if (!targetName) return null;
  const windows = await listLinuxWindows();
  let bestWindow = null;
  let bestScore = 0;
  for (const winInfo of windows) {
    const score = scoreLinuxWindowMatch(winInfo, targetName);
    if (score > bestScore) {
      bestScore = score;
      bestWindow = winInfo;
    }
  }
  return bestWindow;
}

async function activateLinuxWindowById(windowId) {
  const normalizedId = normalizeLinuxWindowId(windowId);
  if (!normalizedId || !hasLinuxX11Session()) return false;
  const wmctrlRes = await runCommand("wmctrl", ["-ia", normalizedId], {
    timeoutMs: activationTimeoutMs(),
  });
  if (wmctrlRes.ok) {
    await sleep(X11_ACTIVATION_SETTLE_MS);
    return true;
  }
  const decimalId = linuxWindowIdToDecimal(normalizedId);
  if (!decimalId) return false;
  const xdotoolRes = await runCommand("xdotool", ["windowactivate", "--sync", decimalId], {
    timeoutMs: activationTimeoutMs(),
  });
  if (!xdotoolRes.ok) return false;
  await sleep(X11_ACTIVATION_SETTLE_MS);
  return true;
}

async function getLinuxFrontmostAppInfo() {
  if (!hasLinuxX11Session()) return { name: "", pid: 0 };
  const activeRes = await runCommand("xdotool", ["getactivewindow"], { timeoutMs: 1500 });
  if (!activeRes.ok) return { name: "", pid: 0 };
  const activeWindowId = normalizeLinuxWindowId(activeRes.stdout || "");
  if (!activeWindowId) return { name: "", pid: 0 };
  const windows = await listLinuxWindows();
  const winInfo = windows.find((w) => w.windowId === activeWindowId) || null;
  const activeWindowDec = linuxWindowIdToDecimal(activeWindowId);
  let pid = Number(winInfo?.pid || 0);
  if (pid <= 0 && activeWindowDec) {
    const pidRes = await runCommand("xdotool", ["getwindowpid", activeWindowDec], { timeoutMs: 1500 });
    if (pidRes.ok) {
      pid = Number.parseInt(String(pidRes.stdout || "").trim(), 10) || 0;
    }
  }
  let title = String(winInfo?.title || "").trim();
  if (!title && activeWindowDec) {
    const titleRes = await runCommand("xdotool", ["getwindowname", activeWindowDec], { timeoutMs: 1500 });
    if (titleRes.ok) {
      title = String(titleRes.stdout || "").trim();
    }
  }
  const processName = pid > 0 ? await getLinuxProcessName(pid) : "";
  const name = pickLinuxTargetName({ ...winInfo, title }, processName);
  return {
    name,
    pid,
    windowId: activeWindowId,
    windowTitle: title,
    className: String(winInfo?.className || "").trim(),
    instanceName: String(winInfo?.instanceName || "").trim(),
  };
}

/**
 * macOS fast path for "which app is in front" — name and pid only.
 *
 * ``getFrontmostAppInfo`` asks System Events for
 * ``first process whose frontmost is true``, which makes AppleScript
 * enumerate every running process and evaluate a property on each. On a
 * normally-loaded desktop that measures 790–840 ms *per call*, and the
 * post-stop pipeline makes several of them — it was the single largest
 * contributor to the delay between finishing a recording and seeing the
 * text appear in the target app.
 *
 * ``lsappinfo`` reads the same information straight from LaunchServices:
 * 110 ms for the two calls, no Apple Event round trip and no
 * Accessibility permission. It ships with macOS, so there is no new
 * dependency.
 *
 * It cannot report the front *window's* title, so this is only for
 * callers that need the app identity. Anything that targets a specific
 * window still goes through ``getFrontmostAppInfo``.
 *
 * @returns {Promise<{name: string, pid: number, windowTitle: string}|null>}
 *   null when unavailable, so callers fall back to the AppleScript path.
 */
async function getFrontmostAppIdentityFast() {
  if (process.platform !== "darwin") return null;
  try {
    const front = await runCommand("/usr/bin/lsappinfo", ["front"], { timeoutMs: 1500 });
    const asn = String(front?.stdout || "").trim();
    if (!front?.ok || !asn.startsWith("ASN:")) return null;
    const info = await runCommand(
      "/usr/bin/lsappinfo",
      ["info", "-only", "pid,name", asn],
      { timeoutMs: 1500 },
    );
    if (!info?.ok) return null;
    // Output shape: `"Claude" ASN:0x0-0x34fc4f9: (in front)` followed by
    // an indented `pid = 52135 …` line.
    const raw = String(info.stdout || "");
    const nameMatch = raw.match(/"([^"]*)"/);
    const pidMatch = raw.match(/\bpid\s*=\s*(\d+)/);
    const name = nameMatch ? String(nameMatch[1]).trim() : "";
    const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) || 0 : 0;
    if (!name && !pid) return null;
    return { name, pid, windowTitle: "" };
  } catch {
    return null;
  }
}

// ── Windows persistent front-window helper (BUGS_AUDIT §6.3) ──────────
//
// getFrontmostAppInfo()'s Windows branch used to spawn a fresh
// ``powershell -Command`` with an inline ``Add-Type @"...C#..."@`` on
// EVERY call. Add-Type compiles that P/Invoke class via csc.exe under
// the hood — 700-2000 ms cold, worse under Defender real-time scanning —
// against the 1200 ms budget most callers apply
// (getFrontmostAppInfoWithTimeout), so it frequently timed out and
// produced an empty paste target ("no-target") even though a perfectly
// good foreground window existed the whole time.
//
// Fix: compile the helper class ONCE, in a PowerShell child process kept
// alive for the app's lifetime (started lazily, on first need), and ask
// it questions over its stdin/stdout instead of spawning + compiling per
// call. All three Windows front-window lookups named in the audit —
// hotkey-press capture (toggleRecordingFromShortcut, via
// getFrontmostAppInfoWithTimeout), resolvePasteDestination, and
// tryPasteToFocusedField — already funnel through this one function
// (getFrontmostAppInfo), so fixing it here fixes every call site with a
// single change, the same way macOS's fast path centralises on
// lsappinfo in getFrontmostAppIdentityFast.
//
// Protocol: the helper reads one line, "FRONT", per request and writes
// back one line, "RESULT:<json>". Requests are answered strictly FIFO,
// which is safe for concurrent callers because each request's push onto
// the pending queue and its stdin write happen synchronously together
// (no ``await`` between them), so two overlapping calls can never
// interleave their queue position and their wire order.
let winFrontHelper = null; // { child, buf, pending: [{resolve}] } | null
let winFrontHelperStarting = null; // Promise<helper|null> while (re)starting

const WIN_FRONT_HELPER_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -ne "FRONT") { continue }
  try {
    $hwnd = [TWindow]::GetForegroundWindow()
    # NOT $pid — that is a READ-ONLY automatic variable holding the
    # id of this PowerShell process itself (see the identical note
    # this script replaced, previously inline in getFrontmostAppInfo).
    $procId = 0
    [TWindow]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $titleSb = New-Object System.Text.StringBuilder 4096
    [TWindow]::GetWindowText($hwnd, $titleSb, $titleSb.Capacity) | Out-Null
    $classSb = New-Object System.Text.StringBuilder 512
    [TWindow]::GetClassName($hwnd, $classSb, $classSb.Capacity) | Out-Null
    $result = @{
      name = if ($proc) { $proc.Name } else { "" }
      pid = if ($proc) { $procId } else { 0 }
      hwnd = if ($hwnd -ne [IntPtr]::Zero) { ('0x{0:X}' -f ([Int64]$hwnd)) } else { "" }
      windowTitle = $titleSb.ToString()
      className = $classSb.ToString()
    }
    Write-Output ("RESULT:" + ($result | ConvertTo-Json -Compress))
  } catch {
    Write-Output "RESULT:{}"
  }
}
`;

/** Kill the persistent helper (if any) and fail out any in-flight requests. Restarted lazily on next use. */
function stopWinFrontHelper() {
  const helper = winFrontHelper;
  winFrontHelper = null;
  winFrontHelperStarting = null;
  if (!helper) return;
  try { helper.child.kill("SIGKILL"); } catch { }
  for (const pending of helper.pending.splice(0)) {
    try { pending.resolve(null); } catch { }
  }
}

function ensureWinFrontHelper() {
  if (winFrontHelper) return Promise.resolve(winFrontHelper);
  if (winFrontHelperStarting) return winFrontHelperStarting;
  winFrontHelperStarting = new Promise((resolve) => {
    let child;
    try {
      // "-Command -" makes PowerShell read the script body from stdin
      // instead of taking it as a one-shot -Command argument, which is
      // what keeps the process (and its already-compiled TWindow class)
      // alive across requests instead of exiting after one answer.
      child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch {
      winFrontHelperStarting = null;
      resolve(null);
      return;
    }
    // Same live-children registry runCommand() uses (BUG-61) — a quit
    // while this helper is running must SIGKILL it too, not orphan it.
    trackedChildren.add(child);
    const helper = { child, buf: "", pending: [] };
    try { child.stdout.setEncoding("utf8"); } catch { }
    try { child.stderr.setEncoding("utf8"); } catch { }
    child.stdout.on("data", (d) => {
      helper.buf += String(d || "");
      let idx;
      while ((idx = helper.buf.indexOf("\n")) >= 0) {
        const line = helper.buf.slice(0, idx).trim();
        helper.buf = helper.buf.slice(idx + 1);
        if (line.startsWith("RESULT:")) {
          const pending = helper.pending.shift();
          if (pending) pending.resolve(line.slice("RESULT:".length));
        }
      }
    });
    const onDead = () => {
      trackedChildren.delete(child);
      for (const pending of helper.pending.splice(0)) {
        try { pending.resolve(null); } catch { }
      }
      if (winFrontHelper === helper) winFrontHelper = null;
    };
    child.once("error", onDead);
    child.once("close", onDead);
    try {
      child.stdin.write(WIN_FRONT_HELPER_SCRIPT + "\n");
    } catch { }
    winFrontHelper = helper;
    winFrontHelperStarting = null;
    resolve(helper);
  });
  return winFrontHelperStarting;
}

/**
 * Ask the persistent helper who is in the foreground. Returns the raw
 * JSON string from its "RESULT:" line, or null on timeout/failure — in
 * which case the helper is torn down and restarted on the next call, so
 * a late answer can never be matched to a future, unrelated request.
 */
async function getWindowsFrontmostInfoRaw(timeoutMs = 4000) {
  const helper = await ensureWinFrontHelper();
  if (!helper) return null;
  return new Promise((resolve) => {
    let settled = false;
    const settleOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      stopWinFrontHelper();
      settleOnce(null);
    }, Math.max(200, Number(timeoutMs) || 4000));
    helper.pending.push({
      resolve: (raw) => {
        clearTimeout(timer);
        settleOnce(raw);
      },
    });
    try {
      helper.child.stdin.write("FRONT\n");
    } catch {
      clearTimeout(timer);
      settleOnce(null);
    }
  });
}

async function getFrontmostAppInfo() {
  if (process.platform === "win32") {
    const raw = await getWindowsFrontmostInfoRaw();
    if (raw == null) return { name: "", pid: 0 };
    try {
      const parsed = JSON.parse(raw.trim() || "{}");
      return {
        name: String(parsed?.name || "").trim(),
        pid: Number.parseInt(String(parsed?.pid || "0").trim(), 10) || 0,
        hwnd: normalizeWindowsHwnd(parsed?.hwnd || ""),
        windowTitle: String(parsed?.windowTitle || "").trim(),
        className: String(parsed?.className || "").trim(),
      };
    } catch {
      return { name: "", pid: 0 };
    }
  }
  if (process.platform === "linux") {
    return getLinuxFrontmostAppInfo();
  }
  // `bundle identifier` is read in the SAME Apple Event as the name and the
  // pid: it is one more property of a process this script already has, so it
  // costs nothing on the capture path and gives pasteVerificationKey a key
  // that survives a rename and separates two apps with the same name. It is
  // wrapped in its own `try` because a faceless/background process may not
  // have one, and a missing bundle id must not lose the name and the pid.
  const script = `
    tell application "System Events"
      set p to first process whose frontmost is true
      set n to name of p
      set u to unix id of p
      set d to ASCII character 30
      set w to ""
      try
        set w to name of front window of p
      end try
      set b to ""
      try
        set b to bundle identifier of p
      end try
      return (n as text) & d & (u as text) & d & (w as text) & d & (b as text)
    end tell
  `;
  const res = await runCommand("osascript", ["-e", script], { timeoutMs: 5000 });
  if (!res.ok) return { name: "", pid: 0 };
  const raw = String(res.stdout || "").trim();
  const [name, pidText, windowTitle, bundleId] = raw.split(String.fromCharCode(30));
  return {
    name: String(name || "").trim(),
    pid: Number.parseInt(String(pidText || "0").trim(), 10) || 0,
    windowTitle: String(windowTitle || "").trim(),
    bundleId: String(bundleId || "").trim(),
  };
}

async function getFrontmostAppInfoWithTimeout(timeoutMs = 1200) {
  let timer = null;
  const fallback = { name: "", pid: 0, windowTitle: "", timedOut: true };
  try {
    return await Promise.race([
      getFrontmostAppInfo(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(100, Number(timeoutMs) || 1200));
      }),
    ]);
  } catch {
    return { name: "", pid: 0, windowTitle: "" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// How long an activation is given to take effect before the caller acts
// on it. Distinct per mechanism because they differ by an order of
// magnitude: a Win32 SetForegroundWindow is asynchronous and the shell
// needs a moment to repaint, while an X11 activation is acknowledged by
// the call itself.
const WIN_ACTIVATION_SETTLE_MS = 350;
// Auto-send re-raises the target before firing its chord; this is the
// pause between that activation and the keystroke.
const AUTO_SEND_ACTIVATION_SETTLE_MS = 110;
const X11_ACTIVATION_SETTLE_MS = 180;

/** Wall-clock bound for one target-activation child, from PASTE_BUDGET. */
function activationTimeoutMs() {
  return pasteActivationTimeoutMs(process.platform);
}

/** Wall-clock bound for the one auto-send child, from PASTE_BUDGET. */
function autoSendTimeoutMs() {
  return pasteAutoSendTimeoutMs(process.platform);
}

async function activateAppByName(name) {
  const appName = String(name || "").trim();
  if (!appName || isBadActivationTarget(appName)) return false;
  if (process.platform === "win32") {
    // PowerShell single-quoted strings do NOT interpolate: ``$var``,
    // ``$(expr)``, and backticks are all literal. Using single quotes
    // plus the canonical single-quote doubling escape ('') is the only
    // injection-safe way to embed untrusted data — here, an app name
    // that could (in principle) come from a process named something
    // like ``evil$(Invoke-Mimikatz)``. The previous double-quoted form
    // only escaped ``"`` and left ``$(...)`` subexpression evaluation
    // wide open.
    const escapedName = appName.replace(/'/g, "''");
    const pwsh = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Window {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
"@
      $proc = Get-Process -Name '${escapedName}' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($proc -and $proc.MainWindowHandle) {
        # Same rule as activateWindowsWindowByHwnd (BUGS_AUDIT 6.2):
        # Win32 refuses SetForegroundWindow from a process that does not
        # own the foreground lock, which a spawned PowerShell child never
        # does. Piping the result to Out-Null and printing "1" reported
        # "the process has a main window", not "it came forward".
        $activated = [Window]::SetForegroundWindow($proc.MainWindowHandle)
        if ($activated) { Write-Output "1" } else { Write-Output "0" }
      } else { Write-Output "0" }
    `;
    const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], {
      timeoutMs: activationTimeoutMs(),
    });
    // A zero exit code says PowerShell ran, not that a window came
    // forward. The script prints "1"/"0" precisely so the caller can
    // tell those apart, and the two sibling activators on this same
    // ladder — activateAppByPid and activateWindowsWindowByHwnd — both
    // read it. This one did not, so the last rung always reported
    // success, `activateCapturedPasteTarget` never returned false, the
    // "we could not restore the target" branch in processPostStopTask
    // was unreachable, and SendKeys went to whatever was frontmost —
    // usually Transcriptor itself.
    if (!res.ok) return false;
    if (String(res.stdout || "").trim() !== "1") return false;
    await sleep(WIN_ACTIVATION_SETTLE_MS);
    return true;
  }
  if (process.platform === "linux") {
    const winInfo = await findLinuxWindowByName(appName);
    if (!winInfo) return false;
    return activateLinuxWindowById(winInfo.windowId);
  }
  const escaped = escapeAppleScriptString(appName);
  const res = await runCommand("osascript", ["-e", `tell application "${escaped}" to activate`], {
    timeoutMs: activationTimeoutMs(),
  });
  if (!res.ok) return false;
  await sleep(WIN_ACTIVATION_SETTLE_MS);
  return true;
}

async function activateAppByPid(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (process.platform === "win32") {
    const pwsh = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Window {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
"@
      $proc = Get-Process -Id ${Math.trunc(n)} -ErrorAction SilentlyContinue
      if ($proc -and $proc.MainWindowHandle) {
        # Same rule as activateWindowsWindowByHwnd (BUGS_AUDIT 6.2):
        # Win32 refuses SetForegroundWindow from a process that does not
        # own the foreground lock, which a spawned PowerShell child never
        # does. Piping the result to Out-Null and printing "1" reported
        # "the process has a main window", not "it came forward".
        $activated = [Window]::SetForegroundWindow($proc.MainWindowHandle)
        if ($activated) { Write-Output "1" } else { Write-Output "0" }
      } else { Write-Output "0" }
    `;
    const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], {
      timeoutMs: activationTimeoutMs(),
    });
    if (!res.ok) return false;
    return String(res.stdout || "").trim() === "1";
  }
  if (process.platform === "linux") {
    const winInfo = await findLinuxWindowByPid(n);
    if (!winInfo) return false;
    return activateLinuxWindowById(winInfo.windowId);
  }
  const script = `
    tell application "System Events"
      if exists (first process whose unix id is ${Math.trunc(n)}) then
        set frontmost of first process whose unix id is ${Math.trunc(n)} to true
        return "1"
      end if
      return "0"
    end tell
  `;
  const res = await runCommand("osascript", ["-e", script], { timeoutMs: activationTimeoutMs() });
  if (!res.ok) return false;
  return String(res.stdout || "").trim() === "1";
}

async function activateWindowsWindowByHwnd(hwnd) {
  const normalized = normalizeWindowsHwnd(hwnd);
  if (!normalized) return false;
  const hex = normalized.slice(2);
  const pwsh = `
    Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class Window {
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
      }
"@
    $hwnd = [IntPtr]::new([Int64]::Parse('${hex}', [System.Globalization.NumberStyles]::AllowHexSpecifier))
    if ([Window]::IsWindow($hwnd)) {
      [Window]::ShowWindowAsync($hwnd, 5) | Out-Null
      # BUGS_AUDIT §6.2: this used to be "| Out-Null" — the actual
      # SetForegroundWindow result was discarded and "1" was written
      # unconditionally whenever the hwnd merely still existed. Win32
      # refuses SetForegroundWindow calls from a process that does not
      # own the current foreground lock (which a spawned PowerShell
      # child never does), so that "1" was reporting "the window is
      # still a window", not "activation worked". Capture and report
      # the real return value so callers can tell the two apart.
      $activated = [Window]::SetForegroundWindow($hwnd)
      if ($activated) { Write-Output "1" } else { Write-Output "0" }
    } else {
      Write-Output "0"
    }
  `;
  const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], {
    timeoutMs: activationTimeoutMs(),
  });
  if (!res.ok) return false;
  await sleep(X11_ACTIVATION_SETTLE_MS);
  return String(res.stdout || "").trim() === "1";
}

async function activateMacCapturedWindow(target) {
  const normalized = normalizeCapturedPasteTarget(target);
  const escapedApp = escapeAppleScriptString(normalized.appName);
  const escapedTitle = escapeAppleScriptString(normalized.windowTitle);
  const pid = Number(normalized.pid || 0);
  const script = `
    set targetApp to "${escapedApp}"
    set targetPid to ${pid > 0 ? Math.trunc(pid) : 0}
    set targetWindowTitle to "${escapedTitle}"
    tell application "System Events"
      set p to missing value
      if targetPid > 0 then
        try
          if exists (first process whose unix id is targetPid) then
            set p to first process whose unix id is targetPid
          end if
        end try
      end if
      if p is missing value and targetApp is not "" then
        try
          if exists process targetApp then
            set p to process targetApp
          end if
        end try
      end if
      if p is missing value then return "0"
      set frontmost of p to true
      delay 0.08
      if targetWindowTitle is not "" then
        try
          if exists (first window of p whose name is targetWindowTitle) then
            set w to first window of p whose name is targetWindowTitle
            try
              perform action "AXRaise" of w
            end try
            try
              set value of attribute "AXMain" of w to true
            end try
            delay 0.08
          end if
        end try
      end if
      return "1"
    end tell
  `;
  const res = await runCommand("osascript", ["-e", script], { timeoutMs: activationTimeoutMs() });
  if (!res.ok) return false;
  return String(res.stdout || "").trim() === "1";
}

async function activateCapturedPasteTarget(target) {
  const normalized = normalizeCapturedPasteTarget(target);
  if (!hasCapturedPasteTarget(normalized)) return false;
  if (process.platform === "win32") {
    if (normalized.hwnd) {
      const byHwnd = await activateWindowsWindowByHwnd(normalized.hwnd);
      if (byHwnd) return true;
    }
    if (normalized.pid > 0) {
      const byPid = await activateAppByPid(normalized.pid);
      if (byPid) return true;
    }
    if (normalized.appName) {
      return activateAppByName(normalized.appName);
    }
    return false;
  }
  if (process.platform === "linux") {
    if (normalized.windowId) {
      const byWindow = await activateLinuxWindowById(normalized.windowId);
      if (byWindow) return true;
    }
    if (normalized.pid > 0) {
      const byPid = await activateAppByPid(normalized.pid);
      if (byPid) return true;
    }
    if (normalized.appName) {
      return activateAppByName(normalized.appName);
    }
    return false;
  }
  return activateMacCapturedWindow(normalized);
}

function setCachedAccessibilityTrusted(trusted) {
  const next = !!trusted;
  if (lastAccessibilityTrusted === next) return;
  lastAccessibilityTrusted = next;
  appendMainLog(`[accessibility] trusted=${next}`);
}

function refreshMacAccessibilityTrustState({ prompt = false } = {}) {
  if (process.platform !== "darwin") return;
  let trusted = false;
  try {
    trusted = !!systemPreferences.isTrustedAccessibilityClient(!!prompt);
  } catch { }
  setCachedAccessibilityTrusted(trusted);
  return trusted;
}

// ── Paste capability probe ─────────────────────────────────────────────
//
// ``isTrustedAccessibilityClient`` answers a question about a TCC row,
// not about whether events we synthesise actually land. After the app is
// re-signed and replaced — which is exactly what installing a new build
// does — that row can outlive the code identity it was granted to: the
// bit stays true and every synthesised event is dropped in silence. The
// only way to tell from inside Electron is to DO something that needs
// the same grant and see whether it works, which is what the probe below
// is: one bounded osascript round trip through System Events, the same
// road the paste itself travels. Decisions live in
// ./paste-capability (pure, tested); the side effects live here.
let pasteCapability = initialPasteCapability();
let pasteCapabilityProbeInFlight = null;

/**
 * The user-facing half of the capability, as a status line: short enough
 * for the capsule, specific enough to act on. `setRecordingStatus` is
 * the channel the renderer already renders — inventing a second one
 * would mean touching the renderer for a message the existing one can
 * carry.
 */
// ── The identity macOS grants permissions to ───────────────────────────
//
// TCC keys every grant by bundle id plus the code signing requirement
// the app satisfied when the grant was made, so the self-heal below has
// to name the bundle id — and the running bundle's Info.plist is the
// only authority on what that is (electron-builder writes it from
// `build.appId` in desktop/package.json, which desktop/packaging.test.js
// holds every other copy in the repo to). Unpackaged runs read the
// manifest directly: there is no bundle, and no TCC row to reset either.
//
// The same read answers the second question this file needs: is the
// bundle on disk still the bundle this process was launched from? See
// detectBundleReplacement in ./paste-capability for why that decides
// whether a reset can help at all.
const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);
/** The verdict is re-derived at most this often; a swap can happen any time. */
const MAC_BUNDLE_FACTS_TTL_MS = 5000;
let macBundleFactsCache = null;

function macBundleFacts() {
  const now = Date.now();
  if (macBundleFactsCache && now - macBundleFactsCache.at < MAC_BUNDLE_FACTS_TTL_MS) {
    return macBundleFactsCache;
  }
  const runningVersion = (() => {
    try { return String(app.getVersion() || ""); } catch { return ""; }
  })();
  const facts = {
    at: now,
    bundleId: "",
    runningVersion,
    bundleVersion: "",
    bundleMtimeMs: 0,
    replaced: false,
    evidence: "",
  };
  if (process.platform !== "darwin" || !app.isPackaged) {
    try {
      facts.bundleId = String(require("./package.json")?.build?.appId || "");
    } catch { }
    macBundleFactsCache = facts;
    return facts;
  }
  try {
    // process.resourcesPath = <bundle>/Contents/Resources
    const contents = path.dirname(process.resourcesPath || "");
    const plistPath = path.join(contents, "Info.plist");
    const identity = parseBundleIdentity(fs.readFileSync(plistPath, "utf8"));
    facts.bundleId = identity.bundleId;
    facts.bundleVersion = identity.version;
    let mtimeMs = 0;
    for (const candidate of [plistPath, app.getPath("exe")]) {
      try { mtimeMs = Math.max(mtimeMs, fs.statSync(candidate).mtimeMs || 0); } catch { }
    }
    facts.bundleMtimeMs = mtimeMs;
  } catch (e) {
    appendMainLog(`[paste-capability] bundle-facts unreadable: ${compactLogText(String(e?.message || e), 120)}`);
  }
  if (!facts.bundleId) {
    try { facts.bundleId = String(require("./package.json")?.build?.appId || ""); } catch { }
  }
  const replacement = detectBundleReplacement({
    runningVersion: facts.runningVersion,
    bundleVersion: facts.bundleVersion,
    bundleMtimeMs: facts.bundleMtimeMs,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
  });
  facts.replaced = replacement.replaced;
  facts.evidence = replacement.evidence;
  macBundleFactsCache = facts;
  return facts;
}

/** The message context every describer of the capability shares. */
function pasteCapabilityMessageContext() {
  if (process.platform !== "darwin") return {};
  try {
    return { bundleReplaced: macBundleFacts().replaced };
  } catch {
    return {};
  }
}

function pasteCapabilityStatusText() {
  const message = pasteCapabilityMessage(pasteCapability, pasteCapabilityMessageContext());
  if (!message.fix) return "";
  return `In Clipboard · ${message.title}. ${message.fix}`;
}

function logPasteCapability(context) {
  const line =
    `state=${pasteCapability.state} cause=${context} ` +
    `reason="${compactLogText(pasteCapability.reason, 160)}"`;
  if (pasteCapability.state === PASTE_CAPABILITY.ACTIVE ||
    pasteCapability.state === PASTE_CAPABILITY.UNKNOWN) {
    appendMainLog(`[paste-capability] ${line}`);
    return;
  }
  appendMainLog(
    `[paste-capability] WARN: ${line} ` +
    `fix="${pasteCapabilityMessage(pasteCapability, pasteCapabilityMessageContext()).fix}"`
  );
}

/**
 * Run the real probe and fold it into the state. Concurrent callers
 * share one in-flight probe — boot, focus and the pre-paste check can
 * all fire within the same second.
 */
async function probePasteCapability(cause = "manual") {
  if (pasteCapabilityProbeInFlight) return pasteCapabilityProbeInFlight;
  pasteCapabilityProbeInFlight = (async () => {
    if (process.platform !== "darwin") {
      // No trust bit, no probe — Unknown, and Unknown still pastes. The
      // Windows and Linux ladders are unchanged by this module.
      pasteCapability = applyProbeResult(pasteCapability, {
        platform: process.platform,
        trusted: null,
        probeOk: false,
      });
      return pasteCapability;
    }
    const trusted = refreshMacAccessibilityTrustState() === true;
    if (!trusted) {
      // No spawn: the verdict is already decided, and an Apple Event we
      // do not need is exactly the kind of thing that summons a TCC
      // prompt at startup. "Startup must not summon macOS permission
      // prompts" — see the whenReady comment. On a machine that HAS the
      // grant, the probe below sends the same Apple Event the paste
      // itself sends, so it can raise no prompt the first paste would
      // not have raised anyway.
      pasteCapability = applyProbeResult(pasteCapability, {
        platform: "darwin",
        trusted: false,
        probeOk: false,
      });
      logPasteCapability(`${cause} trusted=0 probeOk=skipped`);
      return pasteCapability;
    }
    const startedAt = Date.now();
    let probeOk = false;
    let probeReason = "";
    try {
      const res = await runCommand(PASTE_PROBE_COMMAND.cmd, PASTE_PROBE_COMMAND.args.slice(), {
        timeoutMs: PASTE_PROBE_COMMAND.timeoutMs,
      });
      probeOk = !!res.ok && String(res.stdout || "").trim().length > 0;
      if (!probeOk) {
        probeReason = compactLogText(String(res.stderr || res.stdout || "probe-empty").trim(), 160);
      }
    } catch (e) {
      probeReason = compactLogText(String(e?.message || e), 160);
    }
    pasteCapability = applyProbeResult(pasteCapability, {
      platform: "darwin",
      trusted,
      probeOk,
      probeReason,
    });
    logPasteCapability(`${cause} trusted=${trusted ? 1 : 0} probeOk=${probeOk ? 1 : 0} ms=${Date.now() - startedAt}`);
    return pasteCapability;
  })();
  try {
    return await pasteCapabilityProbeInFlight;
  } finally {
    pasteCapabilityProbeInFlight = null;
  }
}

// ── Self-heal ──────────────────────────────────────────────────────────
//
// A probe that says "broken" used to end at a log line and a status
// string telling the user to re-add a permission that was already there.
// The two things that actually repair it are a TCC reset (for a grant
// whose code signing requirement no longer matches this build) and a
// relaunch (for a process whose bundle was replaced under it) — see the
// section head in ./paste-capability, which owns every decision below.
// This half owns the side effects: one `tccutil` child, one re-probe,
// one dialog per boot.
const permissionRepairState = {
  /** Services this boot has already reset. At most one attempt each. */
  resets: new Set(),
  /** Has this boot already said it? Once per boot, never once per paste. */
  reported: false,
  inFlight: null,
};

/**
 * The one place a `tccutil` process is spawned. The command — including
 * the bundle id it targets and the refusal to run against anything that
 * is not one — is built by ./paste-capability.
 */
async function runPermissionReset(service, bundleId) {
  const command = permissionRepairCommand(service, bundleId);
  const res = await runCommand(command.cmd, command.args.slice(), { timeoutMs: command.timeoutMs });
  return {
    ok: !!res.ok,
    detail: compactLogText(String(res.stderr || res.stdout || "").trim(), 120),
  };
}

/** Reset ONE service, then re-probe, then say so in one line. */
async function resetPermissionAndReprobe(service, bundleId, cause) {
  permissionRepairState.resets.add(service);
  let reset = "failed";
  let detail = "";
  try {
    const res = await runPermissionReset(service, bundleId);
    reset = res.ok ? "ok" : "failed";
    detail = res.detail;
  } catch (e) {
    detail = compactLogText(String(e?.message || e), 120);
  }
  const capability = await probePasteCapability(`${cause}-after-reset`);
  appendMainLog(
    `[paste-capability] self-heal service=${service} reset=${reset} re-probe=${capability.state}` +
    (detail ? ` detail="${detail}"` : "")
  );
  return { service, reset, capability };
}

/**
 * Tell the user — once per boot, with the pane and the exact clicks the
 * failure in front of us needs. Scheduled, never awaited by a paste: the
 * transcript is already on the clipboard and must not wait for a click.
 */
function reportPastePermissionFailure(plan, reason = "") {
  permissionRepairState.reported = true;
  // The generic prompt path shares this throttle, so it cannot pile a
  // second dialog on top of this one.
  macPastePermissionPromptAt = Date.now();
  const message = permissionRepairMessage(plan);
  appendMainLog(
    `[paste-capability] self-heal report action=${plan.action} ` +
    `service=${plan.service || "-"} why=${plan.why}`
  );
  const relaunch = plan.action === PERMISSION_REPAIR.RELAUNCH;
  const cleanReason = compactLogText(String(reason || "").trim(), 300);
  dialog
    .showMessageBox({
      type: "warning",
      buttons: relaunch ? ["Restart Transcriptor", "Later"] : ["Open Privacy Settings", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Grant macOS Permissions",
      message: message.title,
      detail: cleanReason ? `${message.fix}\n\nmacOS response:\n${cleanReason}` : message.fix,
    })
    .then((res) => {
      if (res.response !== 0) return;
      if (relaunch) {
        // Relaunching the SAME bundle path is the whole remedy: the copy
        // on disk is valid, only this process's identity is not. `quit`
        // rather than `exit` so the backend child is still killed by the
        // before-quit handler.
        appendMainLog("[paste-capability] self-heal relaunch requested by user");
        app.relaunch();
        quitApp("self-heal-relaunch");
        return;
      }
      if (plan.service === TCC_SERVICE.AUTOMATION) {
        openPrivacyAutomationSettings();
        return;
      }
      openPrivacyAccessibilitySettings();
    })
    .catch((e) => {
      appendMainLog(`[paste-capability] self-heal report failed: ${compactLogText(String(e?.message || e), 120)}`);
    });
}

/**
 * Decide and run the repair for the failure we are looking at.
 *
 * Awaits only what is bounded and automatic (one `tccutil`, one probe);
 * the dialog is scheduled. `handled` means the caller must NOT raise its
 * own permission dialog — either this repaired the state, or it has
 * already said everything there is to say this boot.
 */
async function maybeRepairPastePermissions({ cause = "auto", reason = "" } = {}) {
  if (process.platform !== "darwin") return { capability: pasteCapability, handled: false };
  if (permissionRepairState.inFlight) return permissionRepairState.inFlight;
  permissionRepairState.inFlight = (async () => {
    const facts = macBundleFacts();
    const specific = preferSpecificFailureReason(reason, pasteCapability.reason);
    const plan = planPermissionRepair({
      platform: "darwin",
      state: pasteCapability,
      reason: specific,
      trusted: refreshMacAccessibilityTrustState() === true,
      bundleReplaced: facts.replaced,
      resetServices: [...permissionRepairState.resets],
      reported: permissionRepairState.reported,
    });
    if (plan.action === PERMISSION_REPAIR.NONE) {
      if (plan.why !== "not-a-permission-failure") {
        appendMainLog(
          `[paste-capability] self-heal skipped why=${plan.why} service=${plan.service || "-"}`
        );
      }
      return { capability: pasteCapability, handled: plan.why === "already-reported", plan };
    }
    if (plan.action === PERMISSION_REPAIR.RESET && facts.bundleId) {
      const outcome = await resetPermissionAndReprobe(plan.service, facts.bundleId, cause);
      if (shouldAttemptPaste(outcome.capability)) {
        return { capability: outcome.capability, handled: true, plan };
      }
      reportPastePermissionFailure({ ...plan, action: PERMISSION_REPAIR.REPORT, why: "reset-did-not-help" }, specific);
      return { capability: pasteCapability, handled: true, plan };
    }
    if (plan.action === PERMISSION_REPAIR.RESET) {
      appendMainLog("[paste-capability] self-heal skipped why=no-bundle-id");
      return { capability: pasteCapability, handled: false, plan };
    }
    if (facts.replaced) {
      appendMainLog(`[paste-capability] bundle replaced under the running process (${facts.evidence})`);
    }
    reportPastePermissionFailure(plan, specific);
    return { capability: pasteCapability, handled: true, plan };
  })();
  try {
    return await permissionRepairState.inFlight;
  } finally {
    permissionRepairState.inFlight = null;
  }
}

/**
 * Probe, and repair what the probe found. Every background caller goes
 * through here; only the reset's own re-probe calls the bare probe, so a
 * repair can never recurse into itself.
 */
async function probeAndRepairPasteCapability(cause = "manual") {
  const capability = await probePasteCapability(cause);
  if (process.platform !== "darwin") return capability;
  if (shouldAttemptPaste(capability)) return capability;
  const repaired = await maybeRepairPastePermissions({ cause, reason: capability.reason });
  return repaired.capability || pasteCapability;
}

/** Probe only if the cached verdict is stale (see shouldProbe). */
async function ensurePasteCapabilityFresh(cause = "focus") {
  if (process.platform !== "darwin") return pasteCapability;
  if (!shouldProbe(pasteCapability, Date.now())) return pasteCapability;
  return probeAndRepairPasteCapability(cause);
}

/**
 * The "Repair permissions" action (Settings → the paste-capability
 * note). The user asked for it explicitly, so it repairs BOTH services
 * rather than the one a failure named, and it is not bound by the
 * once-per-boot rule the automatic path is.
 */
async function repairPastePermissionsOnRequest() {
  if (process.platform !== "darwin") {
    return { ok: false, status: "unsupported", state: pasteCapability.state, title: "", fix: "" };
  }
  const facts = macBundleFacts();
  if (!facts.bundleId) {
    appendMainLog("[paste-capability] repair requested but no bundle id is readable");
    return { ok: false, status: "no-bundle-id", state: pasteCapability.state, title: "", fix: "" };
  }
  const services = [];
  for (const service of PERMISSION_REPAIR_SERVICES) {
    const outcome = await resetPermissionAndReprobe(service, facts.bundleId, "repair-request");
    services.push({ service, reset: outcome.reset });
  }
  const capability = await probePasteCapability("repair-request-final");
  const context = pasteCapabilityMessageContext();
  const message = pasteCapabilityMessage(capability, context);
  return {
    ok: shouldAttemptPaste(capability),
    status: "repaired",
    services,
    state: capability.state,
    bundleReplaced: !!context.bundleReplaced,
    ...message,
  };
}

/**
 * The pre-paste check, which is the only one on a latency-critical path:
 * the user has stopped talking and is waiting for text to appear.
 *
 * So it BLOCKS only where blocking changes the outcome — nothing has
 * ever been probed, or the cached verdict is the thing that would refuse
 * this paste (never act on a stale refusal: two transient timeouts must
 * not switch pasting off for a whole recheck window). A cached verdict
 * that allows the paste is used as-is and refreshed in the background,
 * so a paste an hour after the last probe costs nothing extra.
 */
async function ensurePasteCapabilityForPaste() {
  if (process.platform !== "darwin") return pasteCapability;
  // The blocking case is also the one where a repair can still rescue
  // THIS paste: the cached verdict refuses it, so the alternative is a
  // ladder of Apple Events that all fail. The repair is bounded (one
  // tccutil, one probe) and happens at most once per boot per service.
  if (mustProbeBeforePaste(pasteCapability)) return probeAndRepairPasteCapability("pre-paste");
  if (shouldProbe(pasteCapability, Date.now())) {
    probeAndRepairPasteCapability("pre-paste-stale").catch(() => { });
  }
  return pasteCapability;
}

/**
 * Fold a real paste result into the capability. A paste that worked is
 * stronger evidence than any probe; a paste that failed the way a dead
 * grant fails is what turns the state to broken between probes.
 */
function notePasteOutcome({ ok, reason } = {}) {
  // Windows and Linux have no trust bit and no probe, so there is
  // nothing for an outcome to correct: their state stays Unknown, which
  // pastes. Folding failures in there could only ever take a working
  // platform and start refusing its pastes on a heuristic built for a
  // macOS-specific TCC bug.
  if (process.platform !== "darwin") return;
  const before = pasteCapability.state;
  pasteCapability = applyPasteOutcome(pasteCapability, {
    ok: !!ok,
    reason: String(reason || ""),
    platform: process.platform,
  });
  if (pasteCapability.state !== before) {
    logPasteCapability(`paste-outcome from=${before}`);
  }
}

async function promptMacPastePermissions(reason = "") {
  if (process.platform !== "darwin") return;
  // Repair before asking a human to. This is the funnel every paste
  // failure arrives in, so it is the one place that can guarantee the
  // user is asked ONCE, about the permission that actually failed, and
  // only after the app has tried what it can do on its own behalf.
  const repair = await maybeRepairPastePermissions({ cause: "paste-failure", reason }).catch((e) => {
    appendMainLog(`[paste-capability] self-heal failed: ${compactLogText(String(e?.message || e), 120)}`);
    return { handled: false };
  });
  if (repair.handled) return;
  const now = Date.now();
  if (now - macPastePermissionPromptAt < MAC_PASTE_PERMISSION_PROMPT_THROTTLE_MS) {
    appendMainLog(`[permissions] paste prompt throttled reason="${compactLogText(reason, 120)}"`);
    return;
  }
  macPastePermissionPromptAt = now;
  const cleanReason = String(reason || "").trim();
  const normalizedReason = cleanReason.toLowerCase();
  const classified = classifyPastePermissionFailure(normalizedReason);
  const accessibilityFailure = classified === PASTE_PERMISSION_ROUTE.ACCESSIBILITY;
  // `{ prompt: true }` is what raises the system TCC dialog, and this is
  // the only place in the app that passes it. Before the capability
  // preflight existed, an Accessibility failure always arrived here as
  // ERR:no-accessibility; the preflight's own verdicts now reach the
  // same branch, so a first run on a machine that has never granted the
  // permission is asked for it instead of being told to go and find it.
  const accessibilityTrusted = refreshMacAccessibilityTrustState({ prompt: accessibilityFailure });
  const route = accessibilityFailure || !accessibilityTrusted
    ? PASTE_PERMISSION_ROUTE.ACCESSIBILITY
    : classified === PASTE_PERMISSION_ROUTE.AUTOMATION
      ? PASTE_PERMISSION_ROUTE.AUTOMATION
      : "permissions";
  const message = route === PASTE_PERMISSION_ROUTE.ACCESSIBILITY
    ? "Enable Accessibility for Transcriptor"
    : route === PASTE_PERMISSION_ROUTE.AUTOMATION
      ? "Enable Automation for Transcriptor"
      : "Enable permissions for auto-paste";
  const instruction = route === PASTE_PERMISSION_ROUTE.ACCESSIBILITY
    ? "To auto-paste transcript into other apps, allow Transcriptor in Privacy & Security -> Accessibility."
    : route === PASTE_PERMISSION_ROUTE.AUTOMATION
      ? "To auto-paste via System Events, allow Transcriptor to control System Events in Privacy & Security -> Automation."
      : "To auto-paste transcript into any app, allow Transcriptor in Accessibility and Automation (System Events).";
  const detail = cleanReason ? `${instruction}\n\nmacOS response:\n${cleanReason}` : instruction;
  const res = await dialog.showMessageBox({
    type: "info",
    buttons: ["Open Privacy Settings", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Grant macOS Permissions",
    message,
    detail
  });
  if (res.response === 0) {
    if (route === PASTE_PERMISSION_ROUTE.AUTOMATION) {
      openPrivacyAutomationSettings();
    } else {
      openPrivacyAccessibilitySettings();
    }
  }
}

function scheduleMacPastePermissionsPrompt(reason = "") {
  if (process.platform !== "darwin") return;
  if (macPastePermissionPromptInFlight) {
    appendMainLog(`[permissions] paste prompt already in flight reason="${compactLogText(reason, 120)}"`);
    return;
  }
  macPastePermissionPromptInFlight = true;
  promptMacPastePermissions(reason)
    .catch((e) => {
      appendMainLog(`[permissions] paste prompt failed: ${e?.message || e}`);
    })
    .finally(() => {
      macPastePermissionPromptInFlight = false;
    });
}

/**
 * Resolve the macOS microphone TCC state, triggering the one-time system
 * prompt while the state is still undetermined.
 *
 * This is the single place that talks to TCC. It is safe to call from any
 * entry point and as often as needed: ``askForMediaAccess`` only shows UI
 * while the status is "not-determined" and resolves immediately after.
 *
 * Why this matters: on macOS a renderer ``getUserMedia`` call does **not**
 * reject when microphone access was never granted — it resolves with a
 * live ``MediaStreamTrack`` that emits digital silence. Without an
 * explicit ask, a recording therefore produces no waveform, no error and
 * a zero-signal WAV. Any code path that can start a capture must go
 * through here first.
 *
 * @returns {Promise<"granted"|"denied"|"restricted"|"not-determined"|"unknown">}
 */
async function ensureMacMicrophoneAccess() {
  if (process.platform !== "darwin") return "granted";
  let status = "unknown";
  try {
    status = String(systemPreferences.getMediaAccessStatus("microphone") || "unknown");
  } catch {
    return "unknown";
  }
  if (status === "granted") return status;
  // "denied"/"restricted" are terminal until the user changes them in
  // System Settings; asking again would be a silent no-op.
  if (status !== "not-determined" && status !== "unknown") return status;
  try {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    return granted ? "granted" : "denied";
  } catch {
    return status;
  }
}

async function requestMacMicrophonePermissionOnce() {
  if (process.platform !== "darwin") return true;
  const status = await ensureMacMicrophoneAccess();
  if (status === "granted") return true;
  // Escalate to an actionable dialog once per process so a denied user
  // is told why nothing records, without a modal on every attempt.
  if (micPermissionDialogShown) return false;
  micPermissionDialogShown = true;
  const res = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Open Microphone Settings", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Microphone Access Required",
    message: "Transcriptor needs microphone permission to record audio.",
    detail: "Enable Transcriptor in System Settings -> Privacy & Security -> Microphone.",
  });
  if (res.response === 0) {
    runCommand("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"], {
      timeoutMs: 5000
    }).catch(() => { });
  }
  return false;
}

/**
 * Snapshot every clipboard format that Electron exposes so we can restore
 * the ORIGINAL clipboard after a paste — even when it held an image, RTF,
 * or a browser bookmark rather than plain text.
 *
 * If the original clipboard was completely empty the snapshot records
 * { formats: [] } and restoreClipboard will call clipboard.clear() instead
 * of leaving the transcript pinned on the clipboard permanently.
 */
function snapshotClipboard() {
  try {
    const formats = clipboard.availableFormats();
    const snap = { formats: formats || [] };
    if (!formats || formats.length === 0) return snap;
    snap.text = clipboard.readText();
    if (formats.some(f => /html/i.test(f))) { try { snap.html = clipboard.readHTML(); } catch { } }
    if (formats.some(f => /rtf/i.test(f))) { try { snap.rtf = clipboard.readRTF(); } catch { } }
    if (formats.some(f => /image|png|bitmap|tiff/i.test(f))) {
      try {
        const img = clipboard.readImage();
        if (img && !img.isEmpty()) { snap.image = img; snap.hasImage = true; }
      } catch { }
    }
    // macOS bookmark (URL + display title) — clipboard.readBookmark is macOS-only.
    if (formats.some(f => /url|bookmark/i.test(f))) {
      try { snap.bookmark = clipboard.readBookmark(); } catch { }
    }
    return snap;
  } catch {
    return { formats: [] };
  }
}

// Reference-counted snapshot of the user's REAL clipboard, captured
// at the FIRST paste of any chained-paste sequence. Without this,
// rapid F9-stop → F9-stop within the 1500 ms restore window has
// paste-2's `snapshotClipboard` capture paste-1's transcript as the
// "original" — paste-2's eventual restore then writes paste-1's
// transcript back onto the clipboard, permanently pinning it
// (the user's real clipboard is gone forever).
//
// acquireClipboardSnapshot:
//   - First paste: snapshots the clipboard (user's real content)
//     and stores it module-wide.
//   - Subsequent pastes during the restore window: return the SAME
//     snapshot. Increment depth.
//
// releaseClipboardSnapshot:
//   - Decrement depth. When the LAST outstanding paste finishes
//     (depth=0), clear the cached snapshot so the next paste-cycle
//     starts fresh.
//
// Both atomic under V8's single-threaded event loop — no extra lock
// needed, the increment/decrement pair runs synchronously between
// awaits.
let _clipboardSnapshotDepth = 0;
let _clipboardSnapshotCache = null;
function acquireClipboardSnapshot() {
  _clipboardSnapshotDepth += 1;
  if (_clipboardSnapshotCache === null) {
    _clipboardSnapshotCache = snapshotClipboard();
  }
  return _clipboardSnapshotCache;
}
function releaseClipboardSnapshot() {
  _clipboardSnapshotDepth = Math.max(0, _clipboardSnapshotDepth - 1);
  if (_clipboardSnapshotDepth === 0) {
    _clipboardSnapshotCache = null;
  }
}

/**
 * Smart clipboard restore.
 *
 * Waits for the paste to settle, then restores the user's original
 * clipboard — but ABORTS the restore if the clipboard contents
 * changed before we got there, which means the user intentionally
 * copied something new (Cmd+C on a different selection) during the
 * window. Without this guard the prior fixed-1200 ms setTimeout
 * could clobber the user's new copy, or could steal a second paste
 * (Cmd+V → gets transcript again) if the target app handled the
 * synthesised paste faster than 1200 ms.
 *
 * Algorithm:
 *   1. Wait INITIAL_DELAY_MS (400) so the target process reads the
 *      clipboard via the synthesised Cmd+V / Ctrl+V.
 *   2. Poll ``clipboard.readText()`` every POLL_INTERVAL_MS (200)
 *      up to MAX_WAIT_MS (1500) total.
 *      - If text still equals what WE wrote → keep waiting.
 *      - If text differs → user copied something else; ABORT restore
 *        (don't clobber).
 *   3. At MAX_WAIT_MS → restore snapshot.
 *
 * Note on rich clipboards: ``readText`` returns "" for image-only
 * clipboards, so Cmd+C on an image during the window → "" !==
 * writtenText → correctly aborts restore (user's image survives).
 *
 * ``verified`` (BUGS_AUDIT 2026-09-03 §6.1/§6.4/§6.6) is the single gate
 * that decides whether restoring is even attempted: every paste method
 * used to call this unconditionally on any ok:true result, but "ok:true"
 * only ever meant "the OS-level paste command was sent", never "the
 * target actually received the text". A silently-failed Windows paste
 * (§6.1) or a macOS target that reads the pasteboard slower than the
 * fixed 1.5 s window (§6.4) both then had their clipboard overwritten
 * back to the OLD content — destroying the only remaining copy of the
 * transcript. When ``verified`` is not literally ``true`` the transcript
 * is left on the clipboard on purpose: the user can still paste it by
 * hand, whereas a silent restore gives them nothing.
 */
/**
 * The failure half of the clipboard contract (BUGS_AUDIT §6.5, debt
 * registry item 3, and the Wispr Flow rule the registry records: the
 * clipboard is never restored on failure).
 *
 * Restoring here used to be the worst of both worlds — the paste did not
 * happen AND the text the user had just dictated was gone, while the
 * status told them it was "In Clipboard". Leaving the transcript there
 * is what makes that status true and what makes the paste-last hotkey
 * work as the recovery it is advertised as.
 */
function keepTranscriptOnClipboardAfterFailure(logCtx) {
  appendMainLog(
    `[${logCtx}] paste failed; transcript left on the clipboard, previous clipboard NOT restored`
  );
  releaseClipboardSnapshot();
}

function scheduleSmartClipboardRestore(snap, writtenText, logCtx = "paste:clipboardRestore", verified = false) {
  if (verified !== true) {
    appendMainLog(`[${logCtx}] paste not verified; leaving transcript on the clipboard instead of restoring`);
    releaseClipboardSnapshot();
    return;
  }
  const INITIAL_DELAY_MS = 400;
  const POLL_INTERVAL_MS = 200;
  const MAX_WAIT_MS = 1500;
  const expected = String(writtenText == null ? "" : writtenText);
  const startedAt = Date.now();

  const tryPollOrRestore = () => {
    const elapsed = Date.now() - startedAt;
    let current = "";
    try { current = String(clipboard.readText() || ""); } catch { current = ""; }
    if (current !== expected) {
      // User copied something new during the window. Abort the restore
      // so we don't clobber their new clipboard content. The original
      // snapshot is forever sacrificed here — acceptable trade-off,
      // otherwise we silently overwrite user intent.
      appendMainLog(`[${logCtx}] user copied new content during paste window; skipping restore`);
      releaseClipboardSnapshot();
      return;
    }
    if (elapsed >= MAX_WAIT_MS) {
      // Paste is settled, clipboard still has our text, no new user
      // copy arrived — safe to restore the original snapshot.
      safeExecSync(logCtx, () => restoreClipboard(snap));
      releaseClipboardSnapshot();
      return;
    }
    setTimeout(tryPollOrRestore, POLL_INTERVAL_MS);
  };
  setTimeout(tryPollOrRestore, INITIAL_DELAY_MS);
}

/** Restore a clipboard snapshot produced by snapshotClipboard(). */
function restoreClipboard(snap) {
  try {
    if (!snap || !snap.formats || snap.formats.length === 0) {
      // Original clipboard was genuinely empty — clear so we don't
      // leave the transcript pinned.
      clipboard.clear();
      return;
    }
    const writeObj = {};
    if (snap.text) writeObj.text = snap.text;
    if (snap.html) writeObj.html = snap.html;
    if (snap.rtf) writeObj.rtf = snap.rtf;
    if (snap.hasImage && snap.image) writeObj.image = snap.image;
    if (snap.bookmark && (snap.bookmark.title || snap.bookmark.url)) writeObj.bookmark = snap.bookmark;
    if (Object.keys(writeObj).length > 0) {
      clipboard.write(writeObj);
      return;
    }
    // Original clipboard held formats we can't read back (file URLs,
    // CF_HDROP, custom MIME types). Calling clipboard.clear() here
    // would destroy the user's file/URL reference — worse than
    // leaving our transcript pinned. Log and leave the clipboard as is.
    appendMainLog(
      `[clipboard-restore] unrecognised formats=${snap.formats.join(",")}; keeping transcript`
    );
  } catch {
    // Swallow any unexpected write/clear errors — we cannot recover.
  }
}

/**
 * Resolve where the transcript should be pasted.
 *
 * Policy: it goes into the field that has focus *right now*. In the
 * normal flow — recording stopped with the global hotkey while the caret
 * sits in the target app — focus never left, so restoring and activating
 * a "start target" is a no-op that still pays for several Apple Event
 * round trips. main.log for a 12 s dictation showed the target app
 * already frontmost at paste time, and the restore plus re-activation
 * still burned 4.7 s of the 9.6 s between Stop and the text appearing.
 *
 * The captured start target survives as a fallback for the single case
 * where "current focus" is meaningless: the user stopped from
 * Transcriptor's own window, so the front app is us and pasting into it
 * would drop the transcript into our own UI.
 *
 * @returns {Promise<{target: object, alreadyFront: boolean}>}
 *   ``alreadyFront`` tells the paste routine it can skip activation.
 */
async function resolvePasteDestination(capturedTarget) {
  const startTarget = normalizeCapturedPasteTarget(capturedTarget);
  let frontNow = null;
  try {
    frontNow = (await getFrontmostAppIdentityFast()) || (await getFrontmostAppInfo());
  } catch { }
  const frontIsForeignApp =
    !!frontNow &&
    Number(frontNow.pid) > 0 &&
    !isBadActivationTarget(frontNow.name);
  if (frontIsForeignApp) {
    return { target: capturePasteTargetFromFrontInfo(frontNow), alreadyFront: true };
  }
  return { target: startTarget, alreadyFront: false };
}

/**
 * The paste entry point. It is a thin shell on purpose: the ladder below
 * is long, has a dozen return points, and every one of them is evidence
 * about whether this machine can paste at all. Folding that evidence in
 * ONE place is what keeps the capability state honest — a paste that
 * worked is stronger liveness proof than any probe, and the failure
 * shape that means "the grant is dead" is what turns the state broken
 * between probes (./paste-capability).
 */
async function tryPasteToFocusedField(text, target = emptyCapturedPasteTarget(), options = {}) {
  const result = await runPasteLadder(text, target, options);
  notePasteOutcome({ ok: result.ok, reason: result.reason });
  return result;
}

/**
 * The paste-last hotkey fires while its own chord is still physically
 * held, and a synthesised Cmd+V inherits the real modifier flags — the
 * target then receives Cmd+Alt+Shift+V and does something else entirely.
 * The record hotkey has no such problem: it pastes a second or more
 * after the key came up.
 *
 * Handy holds its injected chord for CHORD_HOLD_MS = 100 ms so the
 * target reliably sees a complete event; local-speak waits up to 0.5 s
 * for the user's own control keys to come up before injecting. We do
 * both: never inject sooner than 150 ms after the hotkey, wait for the
 * flags to actually clear, and give up at 500 ms and paste anyway
 * (a stuck flag must not swallow the transcript).
 *
 * Explicit key-UP events for the user's own physical modifiers would be
 * the belt to this braces, and they are NOT available here: System
 * Events can press a chord but has no "key up" command, so synthesising
 * one needs CGEventPost — a native addon. Waiting for the real release
 * is what an Electron main process can do, and it is what this does.
 */
async function awaitModifierRelease(options = {}) {
  const plan = planModifierRelease({
    platform: process.platform,
    accelerator: options.accelerator || "",
    trigger: options.trigger || "",
  });
  if (!plan.needed) return null;
  if (!plan.canPoll) {
    // Windows/Linux: no NSEvent.modifierFlags to poll, so the plan is
    // the fixed floor alone. Waiting it out is the whole wait — there is
    // nothing to spawn and nothing to parse.
    await sleep(plan.holdMs);
    appendMainLog(`[paste-modifiers] fixed hold ${plan.holdMs}ms (no modifier-flag poll on ${process.platform})`);
    return { ok: true, cleared: false, flags: 0, waitedMs: plan.holdMs };
  }
  const command = modifierReleaseCommand(plan);
  const startedAt = Date.now();
  const res = await runCommand(command.cmd, command.args, { timeoutMs: command.timeoutMs });
  const parsed = parseModifierReleaseResult(res.stdout);
  const held = heldModifiersFromFlags(parsed.flags);
  appendMainLog(
    `[paste-modifiers] cleared=${parsed.cleared ? 1 : 0} held="${held.join("+") || "none"}" ` +
    `waitedMs=${parsed.waitedMs} spawnMs=${Date.now() - startedAt} parsed=${parsed.ok ? 1 : 0}`
  );
  if (!parsed.ok) {
    // The wait itself failed (JXA unavailable, killed). Fall back to the
    // fixed floor so the chord still has time to come up.
    await sleep(plan.holdMs);
  }
  return parsed;
}

async function runPasteLadder(text, target = emptyCapturedPasteTarget(), options = {}) {
  // Every wall-clock bound this function spends comes from ONE table
  // (./paste-capability PASTE_BUDGET), so "how long can a paste take" has
  // a single answer, and a test can check that answer against the
  // deadline the user is already waiting inside.
  const pasteBudget = pasteBudgetFor(process.platform);
  const skipActivation = !!options.alreadyFront;
  const originalTarget = normalizeCapturedPasteTarget(target);
  let effectiveTarget = cloneCapturedPasteTarget(originalTarget);
  const trace = createTrace("paste", {
    target: pasteTargetSummary(originalTarget),
    textLen: String(text || "").length,
    textDigest: textDigest(text),
    textPreview: compactLogText(text, 120),
  });
  if (!text || !text.trim()) {
    traceStep(trace, "input_rejected", { reason: "empty-text" });
    logPasteTrace("start_skip", { reason: "empty-text" });
    traceEnd(trace, "failed", { reason: "empty-text" });
    return { ok: false, reason: "empty-text", method: "none", verified: false };
  }
  // Can we paste at all? ``isTrustedAccessibilityClient`` answers a
  // question about a TCC row, not about whether the events we synthesise
  // land — and after the app is re-signed and replaced, which is exactly
  // what installing a new build does, that row can outlive the code
  // identity it was granted to. The probe DOES something that needs the
  // same grant and looks at whether it worked. When the answer is no,
  // running the ladder anyway would spend seconds of Apple Events to end
  // up reporting a paste that never happened; the transcript is already
  // on the clipboard (the caller wrote it there), so the honest outcome
  // is to say so, with the click sequence that repairs it.
  const capability = await ensurePasteCapabilityForPaste();
  traceStep(trace, "paste_capability", {
    state: capability.state,
    reason: compactLogText(capability.reason, 120),
  });
  if (!shouldAttemptPaste(capability)) {
    const reason = `paste-capability-${capability.state}`;
    logPasteTrace("start_skip", { reason, capabilityReason: compactLogText(capability.reason, 120) });
    traceEnd(trace, "failed", { reason, method: "capability-preflight" });
    return { ok: false, reason, method: "capability-preflight", verified: false };
  }
  const modifiers = await awaitModifierRelease(options);
  if (modifiers) {
    traceStep(trace, "modifier_release", {
      cleared: !!modifiers.cleared,
      held: heldModifiersFromFlags(modifiers.flags),
      waitedMs: modifiers.waitedMs,
    });
  }
  let frontBefore = { name: "", pid: 0 };
  try {
    // Identity is all this path needs: the name feeds the paste-strategy
    // hint and the pid feeds activation. The window title is only
    // required by the generic-Electron branch below, which tops it up on
    // demand rather than making every paste pay for it.
    frontBefore = (await getFrontmostAppIdentityFast()) || (await getFrontmostAppInfo());
  } catch { }
  traceStep(trace, "front_before", {
    frontBeforeName: frontBefore.name || "",
    frontBeforePid: frontBefore.pid || 0,
    frontBeforeWindowTitle: compactLogText(frontBefore.windowTitle || "", 80),
  });
  const targetLooksGenericElectron = /^electron$/i.test(effectiveTarget.appName);
  if (targetLooksGenericElectron && shouldUsePasteTarget(frontBefore)) {
    // This branch routes by the front window, so it needs the title the
    // fast identity lookup cannot provide. Pay for the slow query only
    // here, where it changes the outcome.
    if (!frontBefore.windowTitle) {
      try {
        const detailed = await getFrontmostAppInfo();
        if (detailed && detailed.pid === frontBefore.pid) frontBefore = detailed;
      } catch { }
    }
    effectiveTarget = capturePasteTargetFromFrontInfo(frontBefore);
    traceStep(trace, "target_normalized_from_front", {
      from: pasteTargetSummary(originalTarget),
      to: pasteTargetSummary(effectiveTarget),
      reason: "generic-electron-target",
    });
  } else if (targetLooksGenericElectron) {
    // Avoid routing by generic app name when we don't have a safe concrete pid.
    effectiveTarget.appName = "";
    traceStep(trace, "target_name_cleared", {
      from: pasteTargetSummary(originalTarget),
      reason: "generic-electron-without-safe-front",
    });
  }
  const targetHint = `${effectiveTarget.appName} ${effectiveTarget.windowTitle} ${String(frontBefore.name || "")}`.toLowerCase();
  const genericElectronTarget = /^electron$/i.test(effectiveTarget.appName);
  if (genericElectronTarget) {
    // For Electron-based third-party apps, process-level targeting can hit the shell process
    // instead of the real focused webview/editor. Force global frontmost route.
    traceStep(trace, "target_route_override", {
      from: pasteTargetSummary(effectiveTarget),
      reason: "generic-electron-use-frontmost-global",
    });
    effectiveTarget = emptyCapturedPasteTarget();
  }
  traceStep(trace, "paste_strategy", { targetHint: compactLogText(targetHint, 80) });
  logPasteTrace("start", {
    target: pasteTargetSummary(effectiveTarget),
    frontBeforeName: frontBefore.name || "",
    frontBeforePid: frontBefore.pid || 0,
    textLen: String(text).length,
  });
  if (!hasCapturedPasteTarget(effectiveTarget)) {
    traceStep(trace, "target_missing_before_clipboard_write", {});
    logPasteTrace("failed", { reason: "no-target" });
    traceEnd(trace, "failed", { reason: "no-target", method: "target-preflight" });
    return { ok: false, reason: "no-target", method: "target-preflight", verified: false };
  }
  // Acquire the depth-counted shared snapshot. First paste captures
  // the user's REAL clipboard; subsequent pastes during the
  // 1500 ms restore window reuse the same snapshot so a chained
  // paste can never accidentally capture our own transcript as
  // the "original" content. Every code path below MUST eventually
  // call releaseClipboardSnapshot() so the cache clears when the
  // last outstanding paste resolves.
  const savedClipboard = acquireClipboardSnapshot();
  try {
    clipboard.writeText(String(text));
  } catch {
    traceStep(trace, "clipboard_write_failed", {});
    logPasteTrace("clipboard_write_failed", {});
    traceEnd(trace, "failed", { reason: "clipboard-write-failed" });
    // Restore original clipboard.
    safeExecSync("paste:clipboardRestore", () => restoreClipboard(savedClipboard));
    releaseClipboardSnapshot();
    return { ok: false, reason: "clipboard-write-failed", method: "clipboard", verified: false };
  }
  traceStep(trace, "clipboard_write_ok", {});
  logPasteTrace("clipboard_write_ok", {});
  if (skipActivation) {
    // The destination already owns focus — the caret is sitting in it.
    // Activating it would cost an Apple Event round trip to change
    // nothing, and on macOS the bounce can pull our own window forward
    // mid-sequence and fight the paste it is supposed to help.
    traceStep(trace, "target_activation_skipped", {
      target: pasteTargetSummary(effectiveTarget),
      reason: "already-frontmost",
    });
  } else if (hasCapturedPasteTarget(effectiveTarget)) {
    try {
      const restored = await activateCapturedPasteTarget(effectiveTarget);
      traceStep(trace, restored ? "target_activated" : "target_activation_failed", {
        target: pasteTargetSummary(effectiveTarget),
      });
      await sleep(pasteBudget.preflightSettleMs);
    } catch { }
  }
  const rawPid = Number.parseInt(String(effectiveTarget.pid || 0), 10) || 0;
  // Defense-in-depth: reject any value that is not a safe non-negative integer
  // before interpolating it into the AppleScript source string.
  const pid = (Number.isFinite(rawPid) && rawPid >= 0 && rawPid < 2 ** 31) ? Math.trunc(rawPid) : 0;
  // Passed to the paste script as a plain integer, never as interpolated
  // text: it is what the verification reads compare the focused element
  // growth against.
  // Code POINTS, not UTF-16 code units: AppleScript's `count of <text>`
  // counts characters, so a single emoji is 1 there and 2 to
  // String.length. A transcript containing one would make the verified
  // comparison miss by exactly that difference, and the paste report
  // ":unverified" for a reason that has nothing to do with the paste.
  const pastedTextLen = [...String(text || "")].length;
  let lastReason = "paste-no-attempt";

  // ── Enterprise Paste Logic ──
  // Clipboard is already populated synchronously via Electron before we get here.
  
  if (process.platform === "win32") {
    // Windows paste strategy:
    //
    // Method 1 (fast): Write a temporary .vbs script that calls
    // WScript.Shell.SendKeys "^v" (Ctrl+V). This is instantaneous
    // compared to the old PowerShell path which compiled C# inline
    // on every attempt (~2-3 seconds per try, often timing out).
    //
    // Method 2 (fallback): PowerShell with SendKeys as a last resort
    // if VBS is blocked by group policy.
    //
    // Both methods require the clipboard to be populated BEFORE the
    // keypress fires, which we do via Electron's clipboard.writeText
    // synchronously.
    for (let attempt = 0; attempt < pasteBudget.maxAttempts; attempt++) {
      try { clipboard.writeText(String(text)); } catch { }
      await sleep(pasteAttemptDelayMs(process.platform, attempt));
      if (hasCapturedPasteTarget(effectiveTarget)) {
        await activateCapturedPasteTarget(effectiveTarget).catch(() => false);
        await sleep(pasteBudget.activationSettleMs);
      }

      logPasteTrace("direct_attempt", { attempt: attempt + 1, method: "win_paste" });
      traceStep(trace, "method_begin", { method: "win_paste", attempt: attempt + 1 });

      const cmdStarted = Date.now();

      // Fast path: VBS SendKeys — no compilation, no .NET assembly
      // loading, executes in <100 ms on all Windows versions.
      // Use a per-invocation UUID rather than Date.now() — two paste
      // operations in the same millisecond (chained autosend, dual
      // hotkey press) collided on the same temp filename, and the
      // first's `unlinkSync` could delete the second's script
      // mid-execution. crypto.randomUUID is in Node 14.17+, well below
      // both the pinned Electron's Node and the >=22.12 engines floor.
      const vbsPath = path.join(
        app.getPath("temp"),
        `transcriptor_paste_${require("crypto").randomUUID()}.vbs`,
      );
      try {
        const vbsLines = [
          'Set WshShell = CreateObject("WScript.Shell")',
        ];
        // Activate the target UNCONDITIONALLY (BUGS_AUDIT §6.2) — this
        // used to be gated on ``!effectiveTarget.hwnd``, but Windows
        // front-window capture (getFrontmostAppInfo) always returns an
        // hwnd, so that condition was always false and this AppActivate
        // never ran. It matters because it is the one activation call in
        // the whole ladder that is actually reliable: WSH's AppActivate
        // does its own AttachThreadInput dance internally and is exempt
        // from the same-thread-input restriction that makes a plain
        // SetForegroundWindow from an unrelated PowerShell child fail
        // (see activateWindowsWindowByHwnd below). Its result is checked
        // — a target that failed to activate must not have SendKeys
        // fired at it, since that would type into whatever else happens
        // to be foreground (often Transcriptor itself).
        if (effectiveTarget.pid > 0) {
          vbsLines.push(`If Not WshShell.AppActivate(${Math.trunc(effectiveTarget.pid)}) Then`);
          vbsLines.push('  WScript.Echo "ERR:activate"');
          vbsLines.push('  WScript.Quit 2');
          vbsLines.push('End If');
          vbsLines.push('WScript.Sleep 80');
        } else if (effectiveTarget.appName) {
          // VBS string literals are terminated by CR/LF — a target name
          // that contains a newline would break out of the quoted string
          // and inject arbitrary VBS into the script. Doubling the ``"``
          // is the standard VBS escape; stripping CR/LF + NUL + all other
          // control characters prevents any line-break-based escape.
          // effectiveTarget.appName comes from the Windows process table, so
          // the attack surface is small (a process would have to register
          // with a pathological name), but the one-line fix is free.
          const sanitizedName = effectiveTarget.appName
            .replace(/[\x00-\x1f\x7f]/g, "")
            .replace(/"/g, '""');
          vbsLines.push(`If Not WshShell.AppActivate("${sanitizedName}") Then`);
          vbsLines.push('  WScript.Echo "ERR:activate"');
          vbsLines.push('  WScript.Quit 2');
          vbsLines.push('End If');
          vbsLines.push('WScript.Sleep 80');
        }
        vbsLines.push('WScript.Sleep 30');
        vbsLines.push('WshShell.SendKeys "^v"');
        // The receipt, printed the instant the keystroke is out and
        // BEFORE anything else the script does. cscript's launch can
        // spend 1-3 s in Defender's real-time scan, so the per-attempt
        // wall-clock bound can kill this process between SendKeys and
        // the final Echo — indistinguishable, without a receipt, from a
        // kill before the keystroke, which made the ladder retry and
        // paste the transcript a second time. Same protocol the macOS
        // script uses, from the same constant.
        vbsLines.push(`WScript.Echo "${PASTE_SENT_PREFIX}vbs-paste"`);
        vbsLines.push('WScript.Echo "OK:vbs-paste"');

        // Write as UTF-16 LE with BOM. Windows cscript/wscript decode
        // .vbs files using the system's ANSI code page (CP-1251 / CP-932
        // / Windows-1252) unless the file starts with a UTF-16 LE BOM.
        // A Russian user targeting a window titled "Телеграм" would
        // otherwise see UTF-8 bytes interpreted as CP-1251 gibberish,
        // AppActivate fails silently, and SendKeys hits whichever
        // process is foreground — usually Transcriptor itself.
        const vbsSource = vbsLines.join("\r\n");
        const vbsBuf = Buffer.concat([
          Buffer.from([0xFF, 0xFE]),           // UTF-16 LE BOM
          Buffer.from(vbsSource, "utf16le"),
        ]);
        fs.writeFileSync(vbsPath, vbsBuf);
        // 3500 ms (BUGS_AUDIT §6.4/§6.5, was 5000, before that 2500):
        // the comment this budget has always cited is that on Windows
        // 11 with Defender real-time scanning, cscript launch can spend
        // 1–3 s in AV scan before the script body executes. 3500 ms is
        // the smallest budget that still covers that documented 1-3 s
        // worst case with headroom for the script's own body (two
        // AppActivate calls + two short Sleeps, well under 500 ms). The
        // previous 5000 ms budget let every failing attempt burn a full
        // 5 s before the PowerShell fallback (below) even started,
        // which is what let the retry ladder reach ~30 s end to end.
        const check = await runCommand("cscript", ["//Nologo", "//B", "//U", vbsPath], {
          timeoutMs: pasteMethodTimeoutMs(process.platform, 0),
        });

        // Clean up temp file
        try { fs.unlinkSync(vbsPath); } catch { }

        const vbsOutcome = evaluatePasteOutcome({ method: "vbs_paste", ok: check.ok, stdout: check.stdout, stderr: check.stderr });
        if (vbsOutcome.success) {
          traceEnd(trace, "success", { method: "vbs_paste", attempt: attempt + 1, reason: vbsOutcome.reason, verified: vbsOutcome.verified });
          scheduleSmartClipboardRestore(savedClipboard, text, "paste:clipboardRestore:vbs", vbsOutcome.verified);
          return { ok: true, reason: vbsOutcome.reason || "OK:vbs-paste", method: "vbs_paste", verified: vbsOutcome.verified };
        }
        lastReason = (check.stderr || vbsOutcome.reason || "vbs-failed").trim();
      } catch (e) {
        try { fs.unlinkSync(vbsPath); } catch { }
        lastReason = `vbs-error: ${e?.message || e}`;
      }

      // Fallback: lightweight PowerShell (no C# compilation).
      // Activate the captured target PID FIRST via SetForegroundWindow
      // — otherwise SendKeys fires at whatever has focus when the
      // hotkey was pressed (often Transcriptor itself), and the
      // text lands in the wrong window.
      //
      // Runs right after EVERY VBS failure now (BUGS_AUDIT §6.4), not
      // only when attempt === 2. Gating it to the last attempt meant a
      // VBS failure on attempt 0 paid for two more full VBS timeouts
      // before this — the actually-different fallback method — ever
      // ran, which is most of how the retry ladder reached ~30 s.
      {
        const pidNum = Number.parseInt(String(effectiveTarget.pid || 0), 10) || 0;
        const safePid = (Number.isFinite(pidNum) && pidNum > 0 && pidNum < 2 ** 31) ? Math.trunc(pidNum) : 0;
        const safeHwnd = normalizeWindowsHwnd(effectiveTarget.hwnd || "");
        const hwndHex = safeHwnd ? safeHwnd.slice(2) : "";
        // Inside a JS template literal (backtick-delimited), `"` is not
        // a special character and MUST NOT be escaped. The over-escaped
        // `\\"user32.dll\\"` version produced literal `\"user32.dll\"`
        // in the PowerShell source, which was then invalid C# inside
        // Add-Type (CS1056: unexpected character '\'). See the sibling
        // PowerShell blocks in getFrontmostAppInfo / getFrontmostAppName
        // for the correct unescaped form.
        const activateBlock = safeHwnd ? (
          `Add-Type @"\n` +
          `using System;\n` +
          `using System.Runtime.InteropServices;\n` +
          `public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd); }\n` +
          `"@;\n` +
          `try { $h = [IntPtr]::new([Int64]::Parse('${hwndHex}', [System.Globalization.NumberStyles]::AllowHexSpecifier)); [W]::ShowWindowAsync($h, 5) | Out-Null; [W]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 120 } catch {};`
        ) : safePid > 0 ? (
          `Add-Type @"\n` +
          `using System;\n` +
          `using System.Runtime.InteropServices;\n` +
          `public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }\n` +
          `"@;\n` +
          `try { $p = Get-Process -Id ${safePid} -ErrorAction Stop; [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 120 } catch {};`
        ) : "";
        const pwshSimple = `${activateBlock}Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^{v}"); Write-Output "OK:pwsh-paste"`;
        const fallback = await runCommand("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", pwshSimple], {
          timeoutMs: pasteMethodTimeoutMs(process.platform, 1),
        });
        const pwshOutcome = evaluatePasteOutcome({ method: "pwsh_paste_fallback", ok: fallback.ok, stdout: fallback.stdout });
        if (pwshOutcome.success) {
          traceEnd(trace, "success", { method: "pwsh_paste_fallback", attempt: attempt + 1, verified: pwshOutcome.verified });
          scheduleSmartClipboardRestore(savedClipboard, text, "paste:clipboardRestore:pwsh_fallback", pwshOutcome.verified);
          return { ok: true, reason: pwshOutcome.reason || "OK:pwsh-paste", method: "pwsh_paste_fallback", verified: pwshOutcome.verified };
        }
        lastReason = (fallback.stderr || pwshOutcome.reason || "pwsh-fallback-failed").trim();
      }
    }
  } else if (process.platform === "linux") {
    // ─ Linux paste cascade ─────────────────────────────────────────
    //
    // Linux has no single canonical paste API — the active display
    // server dictates which tool can send synthesised keystrokes:
    //
    //   * X11: xdotool (well-established, installed by setup.sh).
    //   * Wayland (GNOME/KDE/Sway/wlroots): wtype — stateless Wayland
    //     virtual-keyboard injector. Works on most compositors that
    //     expose the virtual-keyboard-v1 protocol.
    //   * Wayland fallback when wtype is blocked: ydotool — userland
    //     uinput driver; requires the user to be in the ``input``
    //     group but bypasses the compositor protocol entirely.
    //
    // The cascade: wtype → xdotool → ydotool. Each tool's exit code
    // tells us truthfully whether the keystroke landed; we don't
    // second-guess via focus polling (Linux has no stable per-window
    // "activate and paste" API like AppleScript's ``tell process``).
    //
      // Window activation: for captured X11 targets we restore the
      // exact window id first; on Wayland there is no standard cross-
      // compositor restore API, so we rely on the compositor's current
      // focus and then send the paste keystroke.
    // $WAYLAND_DISPLAY is set on any Wayland session (pure Wayland or
    // XWayland hybrid). GNOME and KDE on Wayland set BOTH WAYLAND_DISPLAY
    // and DISPLAY — the old check (&&!DISPLAY) incorrectly treated them
    // as X11-only and never tried wtype. Correct check: Wayland whenever
    // WAYLAND_DISPLAY is present, X11-only when only DISPLAY is set.
    const isWayland = !!process.env.WAYLAND_DISPLAY;
    const hasX11 = !!process.env.DISPLAY;

    for (let attempt = 0; attempt < pasteBudget.maxAttempts; attempt++) {
      try { clipboard.writeText(String(text)); } catch { }
      await sleep(pasteAttemptDelayMs(process.platform, attempt));

      logPasteTrace("direct_attempt", { attempt: attempt + 1, method: "linux_paste" });
      traceStep(trace, "method_begin", { method: "linux_paste", attempt: attempt + 1, wayland: isWayland });

      if (hasCapturedPasteTarget(effectiveTarget)) {
        await activateCapturedPasteTarget(effectiveTarget).catch(() => false);
        await sleep(pasteBudget.activationSettleMs);
      }

      // Build ordered cascade for the detected session type.
      // Wayland (pure or hybrid): wtype → ydotool → xdotool (for XWayland apps).
      // X11 only: xdotool → ydotool (fallback).
      // No timeoutMs here: the loop below fills it from PASTE_BUDGET.
      // The entries used to carry a literal 2000 that was immediately
      // overwritten — a second source of truth for a number this file
      // had already promised came from one table.
      const attempts = [];
      if (isWayland) {
        attempts.push({
          method: "wtype",
          cmd: "wtype",
          args: ["-M", "ctrl", "v", "-m", "ctrl"],
        });
        attempts.push({
          method: "ydotool",
          cmd: "ydotool",
          args: ["key", "29:1", "47:1", "47:0", "29:0"],
        });
        // On XWayland hybrid sessions the target may be an X11 app —
        // xdotool works for those even inside a Wayland compositor.
        if (hasX11) {
          attempts.push({
            method: "xdotool",
            cmd: "xdotool",
            args: ["key", "--clearmodifiers", "ctrl+v"],
          });
        }
      } else {
        // Pure X11 session.
        attempts.push({
          method: "xdotool",
          cmd: "xdotool",
          args: ["key", "--clearmodifiers", "ctrl+v"],
        });
        attempts.push({
          method: "ydotool",
          cmd: "ydotool",
          args: ["key", "29:1", "47:1", "47:0", "29:0"],
        });
      }

      // The per-tool bound comes from the same table as everything else;
      // the literals the cascade was built with would have been a second
      // place to change it.
      attempts.forEach((a, index) => {
        a.timeoutMs = pasteMethodTimeoutMs(process.platform, index);
      });
      let methodOk = false;
      let lastPasteErr = "";
      for (const a of attempts) {
        const cmdStarted = Date.now();
        const res = await runCommand(a.cmd, a.args, { timeoutMs: a.timeoutMs });
        traceStep(trace, "method_result", {
          method: a.method,
          attempt: attempt + 1,
          ms: Date.now() - cmdStarted,
          ok: !!res.ok,
          code: res.code,
          stderr: compactLogText(res.stderr),
        });
        const linuxOutcome = evaluatePasteOutcome({ method: a.method, ok: res.ok, stdout: res.stdout });
        if (linuxOutcome.success) {
          methodOk = true;
          traceEnd(trace, "success", { method: a.method, attempt: attempt + 1, reason: `${a.method}_ok`, verified: linuxOutcome.verified });
          scheduleSmartClipboardRestore(savedClipboard, text, `paste:clipboardRestore:${a.method}`, linuxOutcome.verified);
          return { ok: true, reason: `OK:${a.method}`, method: a.method, verified: linuxOutcome.verified };
        }
        lastPasteErr = (res.stderr || res.stdout || `${a.method}-failed`).trim();
      }
      if (!methodOk) {
        lastReason = lastPasteErr || "linux-paste-failed";
      }
    }
  } else {
    // macOS AppleScript 'key code 9'
    //
    // ONE decision, taken once for the whole ladder: does this paste
    // carry the accessibility verification reads? The policy remembers
    // per app; ./paste-script emits a script with no read in it at all
    // when the answer is no (BUGS_AUDIT §6.6 / hotfix A3).
    const verificationKey = pasteVerificationKey({
      bundleId: effectiveTarget.bundleId || frontBefore.bundleId || "",
      appName: effectiveTarget.appName || frontBefore.name || "",
    });
    const verifyPaste = pasteVerificationPolicy.shouldAttemptVerification(verificationKey);
    traceStep(trace, "paste_verification_policy", {
      ...pasteVerificationPolicy.stateFor(verificationKey),
      verify: verifyPaste,
    });
    const pasteScript = robustPasteScript({
      appName: effectiveTarget.appName,
      windowTitle: effectiveTarget.windowTitle,
      pid,
      pastedTextLen,
      verify: verifyPaste,
    });
    for (let attempt = 0; attempt < pasteBudget.maxAttempts; attempt++) {
    // Refresh clipboard just in case OS flushed it
    try { clipboard.writeText(String(text)); } catch { }
    await sleep(pasteAttemptDelayMs(process.platform, attempt));

    logPasteTrace("direct_attempt", { attempt: attempt + 1, method: "robust_paste" });
    traceStep(trace, "method_begin", { method: "robust_paste", attempt: attempt + 1 });

    const cmdStarted = Date.now();
    // The script marks the edges of each AX read with ``log``, which
    // osascript flushes to stderr as it happens. Timing their arrival is
    // the only way to measure what the reads cost without spending a
    // ``do shell script`` inside the script to read a clock.
    const axTraceEvents = [];
    const onStreamLine = verifyPaste
      ? (streamName, line, ms) => {
        if (streamName === "stderr" && line.startsWith(AX_TRACE_PREFIX)) axTraceEvents.push({ line, ms });
      }
      : null;
    // 3200 ms is the budget for the paste itself. When the verification
    // reads are attempted they add at most 2 x 0.5 s: one
    // axFocusedValueLength call is up to three Apple Events bounded at
    // 0.25 s each, and the "after" call is skipped outright when the
    // "before" one failed. Without verification the budget is exactly
    // what it was before verification existed, because the script then
    // contains no read to wait for.
    const check = await runCommand("osascript", ["-e", pasteScript], {
      timeoutMs: pasteMethodTimeoutMs(process.platform, 0, verifyPaste),
      onStreamLine,
    });
    const axReads = summarizeAxReadTrace(axTraceEvents);

    traceStep(trace, "method_result", {
      method: "robust_paste",
      attempt: attempt + 1,
      ms: Date.now() - cmdStarted,
      verify: verifyPaste,
      axReadMs: axReads.totalMs,
      axReads: axReads.reads,
      axReadUnfinished: axReads.unfinished,
      ok: !!check.ok,
      code: check.code,
      stdout: compactLogText(check.stdout),
      stderr: compactLogText(check.stderr),
    });
    logPasteTrace("robust_paste_result", {
      attempt: attempt + 1,
      ok: !!check.ok,
      code: check.code,
      verify: verifyPaste,
      axReadMs: axReads.totalMs,
      stdout: compactLogText(check.stdout),
      stderr: compactLogText(check.stderr),
    });

    // Evaluated even when the child did NOT exit cleanly: the script
    // logs a "SENT:" receipt the instant the paste is out, so a
    // wall-clock kill that landed AFTER the keystroke is a paste that
    // happened. Retrying it would put the transcript into the target a
    // second time — the exact reason the receipt exists.
    const macOutcome = evaluatePasteOutcome({
      method: "robust_paste",
      ok: check.ok,
      stdout: check.stdout,
      stderr: check.stderr,
    });
    const out = macOutcome.reason;
    // Only a COMPLETED verification attempt teaches the policy anything.
    // A paste that ran without the reads reports "unverified" too, and a
    // paste cut short mid-read verified nothing it could report —
    // feeding either back would switch the app off on evidence the
    // policy manufactured itself.
    if (verifyPaste) {
      // Only "the reads returned nothing at all" (:unreadable) says this
      // app cannot be verified. ":unverified" — reads landed, growth did
      // not match — is inconclusive and must not switch anything off.
      pasteVerificationPolicy.recordOutcome(
        verificationKey,
        check.ok && macOutcome.success
          ? MAC_VERIFICATION_TO_POLICY_OUTCOME[macOutcome.verification] || PASTE_VERIFICATION_OUTCOME.ERROR
          : PASTE_VERIFICATION_OUTCOME.ERROR,
      );
    }
    if (macOutcome.success) {
      logPasteTrace("success", { method: "robust_paste", attempt: attempt + 1, reason: out, verified: macOutcome.verified, sent: !!macOutcome.sent });
      traceEnd(trace, "success", { method: "robust_paste", attempt: attempt + 1, reason: out, verified: macOutcome.verified, sent: !!macOutcome.sent });
      // Restore previous clipboard only when the paste was verified —
      // see scheduleSmartClipboardRestore's doc comment (§6.4/§6.6).
      scheduleSmartClipboardRestore(savedClipboard, text, "paste:clipboardRestore:robust_paste", macOutcome.verified);
      return { ok: true, reason: out, method: "robust_paste", verified: macOutcome.verified };
    }
    if (check.ok) {
      // There is no `ERR:secure-field` branch here. Nothing emits that
      // marker — neither paste script produces it, and detecting a secure
      // text field needs an AXSubrole read of the focused element, which is
      // the expensive call this ladder is built to avoid. The branch, the
      // "In Clipboard · Secure Field" status behind it and the classifier
      // entry were three pieces of code describing a capability the product
      // does not have. Recorded in the debt ledger.
      if (out === "ERR:no-accessibility") {
        lastReason = "ERR:no-accessibility";
        traceEnd(trace, "failed", { reason: lastReason, method: "robust_paste", attempt: attempt + 1 });
        logPasteTrace("failed", { reason: lastReason, method: "robust_paste", attempt: attempt + 1 });
        keepTranscriptOnClipboardAfterFailure("paste:clipboardKeep:robust_paste");
        return { ok: false, reason: lastReason, method: "robust_paste", verified: false };
      } else {
        lastReason = out || "paste-return-unknown";
      }
    } else {
      lastReason = (check.stderr || check.stdout || "osascript-failed").trim();
    }
  }
  } // end macOS block

  // Secondary fallback: trigger Edit -> Paste menu item in target process.
  // macOS-only — uses AppleScript ``System Events`` which doesn't exist
  // on Win/Linux. Without this guard, the post-Win/Linux fallthrough
  // ran the osascript spawn anyway, hit ENOENT (no osascript binary),
  // overwrote ``lastReason`` with the bogus spawn-error string, and
  // surfaced a useless "spawn osascript ENOENT" status to the user
  // instead of the real Win/Linux paste-failure cause. Skip directly
  // to the consolidated failure path which restores the clipboard +
  // releases the snapshot symmetrically with the success branches.
  if (process.platform !== "darwin") {
    keepTranscriptOnClipboardAfterFailure("paste:clipboardKeep:exhausted");
    traceEnd(trace, "failed", { reason: lastReason || "paste-no-attempt", method: "exhausted" });
    logPasteTrace("failed", { reason: compactLogText(lastReason || "paste-no-attempt") });
    return {
      ok: false,
      reason: lastReason || "paste-no-attempt",
      method: "exhausted",
      verified: false,
    };
  }
  // The secondary fallback's AppleScript lives in ./paste-script with the
  // primary one, so both speak the same ERR: vocabulary, both escape their
  // interpolations with the same helpers, and applescript.test.js compiles
  // both.
  const menuPasteScript = menuPasteFallbackScript({
    appName: effectiveTarget.appName,
    pid,
  });
  const menuRes = await runCommand("osascript", ["-e", menuPasteScript], {
    timeoutMs: pasteBudget.tailFallbackTimeoutMs,
  });
  traceStep(trace, "menu_paste_result", {
    ok: !!menuRes.ok,
    code: menuRes.code,
    stdout: compactLogText(menuRes.stdout),
    stderr: compactLogText(menuRes.stderr),
  });
  if (menuRes.ok) {
    const out = String(menuRes.stdout || "").trim();
    const menuOutcome = evaluatePasteOutcome({ method: "menu-paste", ok: menuRes.ok, stdout: menuRes.stdout });
    if (menuOutcome.success) {
      // This fallback script has no AX-verification suffix (unlike
      // robust_paste's menu-paste-primary/robust-paste branches), so
      // verified is always false here — the restore gate correctly
      // leaves the transcript on the clipboard rather than restoring.
      scheduleSmartClipboardRestore(savedClipboard, text, "paste:clipboardRestore:menu", menuOutcome.verified);
      traceEnd(trace, "success", { method: "menu-paste", reason: out, verified: menuOutcome.verified });
      return { ok: true, reason: out, method: "menu-paste", verified: menuOutcome.verified };
    }
    if (out === "ERR:no-accessibility") {
      lastReason = out;
      traceEnd(trace, "failed", { reason: lastReason, method: "menu-paste" });
      logPasteTrace("failed", { reason: lastReason, method: "menu-paste" });
      keepTranscriptOnClipboardAfterFailure("paste:clipboardKeep:menu_paste");
      return { ok: false, reason: lastReason, method: "menu-paste", verified: false };
    }
    lastReason = out || lastReason;
  } else {
    lastReason = String(menuRes.stderr || menuRes.stdout || lastReason || "menu-paste-failed").trim();
  }

  // Exhausted all robust attempts
  let frontAfter = { name: "", pid: 0 };
  try {
    // Diagnostics only — name and pid, so the identity fast path serves.
    frontAfter = (await getFrontmostAppIdentityFast()) || (await getFrontmostAppInfo());
  } catch { }
  traceStep(trace, "front_after", {
    frontAfterName: frontAfter.name || "",
    frontAfterPid: frontAfter.pid || 0,
  });
  logPasteTrace("failed", {
    reason: compactLogText(lastReason),
    frontAfterName: frontAfter.name || "",
    frontAfterPid: frontAfter.pid || 0,
  });
  traceEnd(trace, "failed", {
    reason: compactLogText(lastReason),
    finalMethod: "failed",
  });
  keepTranscriptOnClipboardAfterFailure("paste:clipboardKeep:failed");
  return { ok: false, reason: lastReason, method: "failed", verified: false };
}

async function sendCommandEnterToFocusedApp(target = emptyCapturedPasteTarget()) {
  const normalized = normalizeCapturedPasteTarget(target);
  if (hasCapturedPasteTarget(normalized)) {
    await activateCapturedPasteTarget(normalized);
    await sleep(AUTO_SEND_ACTIVATION_SETTLE_MS);
  }
  
  if (process.platform === "win32") {
      const pwsh = `
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait("^{ENTER}")
      `;
      const res = await runCommand("powershell", ["-NoProfile", "-Command", pwsh], {
        timeoutMs: autoSendTimeoutMs(),
      });
      if (res.ok) {
        return { ok: true, reason: "powershell-ctrl-enter-sent" };
      }
      return { ok: false, reason: String(res.stderr || res.stdout || "powershell-ctrl-enter-failed") };
  }

  if (process.platform === "linux") {
    const attempts = [];
    if (isLinuxWaylandSession()) {
      attempts.push({
        method: "wtype-ctrl-enter",
        cmd: "wtype",
        args: ["-M", "ctrl", "-P", "Return", "-p", "Return", "-m", "ctrl"],
        timeoutMs: autoSendTimeoutMs(),
      });
      attempts.push({
        method: "ydotool-ctrl-enter",
        cmd: "ydotool",
        args: ["key", "29:1", "28:1", "28:0", "29:0"],
        timeoutMs: autoSendTimeoutMs(),
      });
      if (hasLinuxX11Session()) {
        attempts.push({
          method: "xdotool-ctrl-enter",
          cmd: "xdotool",
          args: ["key", "--clearmodifiers", "ctrl+Return"],
          timeoutMs: autoSendTimeoutMs(),
        });
      }
    } else {
      attempts.push({
        method: "xdotool-ctrl-enter",
        cmd: "xdotool",
        args: ["key", "--clearmodifiers", "ctrl+Return"],
        timeoutMs: autoSendTimeoutMs(),
      });
      attempts.push({
        method: "ydotool-ctrl-enter",
        cmd: "ydotool",
        args: ["key", "29:1", "28:1", "28:0", "29:0"],
        timeoutMs: autoSendTimeoutMs(),
      });
    }

    let lastReason = "linux-ctrl-enter-no-attempt";
    for (const attempt of attempts) {
      const res = await runCommand(attempt.cmd, attempt.args, { timeoutMs: attempt.timeoutMs });
      if (res.ok) {
        return { ok: true, reason: attempt.method };
      }
      lastReason = String(res.stderr || res.stdout || `${attempt.method}-failed`).trim();
    }
    return { ok: false, reason: lastReason };
  }

  // Cmd+Enter is the "send" chord in every target this feature exists
  // for — Telegram, Slack, Messages, Discord, most web composers — and
  // is what this function is named after. It used to be reached only as
  // a fallback behind Cmd+CONTROL+Return, which is not "send" in any of
  // them: `keystroke` reports success as soon as the event is posted, so
  // the first attempt practically always "succeeded", the fallback was
  // unreachable, and the capsule said "Sent" for a message that was
  // still sitting unsent in the composer.
  //
  // There is exactly one attempt, because there is no second thing to
  // try: neither `keystroke` nor `key code` gives any feedback about
  // whether the target acted on the event, so a second chord would be a
  // guess reported as a result. `key code 36` rather than
  // `keystroke return` for the same reason the paste uses `key code 9` —
  // it does not depend on the active keyboard layout.
  const sendChord = `
    tell application "System Events"
      key code 36 using command down
    end tell
  `;
  const res = await runCommand("osascript", ["-e", sendChord], { timeoutMs: autoSendTimeoutMs() });
  if (res.ok) return { ok: true, reason: "cmd-enter-keycode-sent" };
  return { ok: false, reason: String(res.stderr || res.stdout || "cmd-enter-failed").trim() };
}

// Tracks recordingIds that have already been enqueued or processed
// in this app session. enqueuePostStopTask dedupes against this set
// so a single recording can never produce two paste events.
//
// User report (1 May 2026, Telegram screenshot showed duplicated text):
//   "Сергей, привет... Просто расскажу,"           ← interim-final paste
//   "Сергей, привет... Просто расскажу кратко..."  ← later final paste
// The two halves both started with the exact same opening sentence —
// classic two-paste-of-same-recording symptom. Two entry points feed
// enqueuePostStopTask:
//   * toggleRecordingFromShortcut() — fired by Alt+Left hotkey
//   * stopRecordingFromMainProcess()    — fired by main-process auto-stop,
//                                     wrapped in guardedStopFromRecordingStatus
// They use SEPARATE in-flight flags (shortcutToggleInFlight vs
// recordingStopInFlight). A press-and-click sequence within ~50 ms can
// invoke both before either flag has been observed, producing TWO
// enqueuePostStopTask calls for the SAME recordingId — two
// transcript polls, two clipboard writes, two AppleScript Cmd+V's.
// Dedup at the enqueue gate is the simplest enterprise-correct fix:
// recordingId is monotonic (++liveRecordingSeq in startLive), unique
// per recording, and already on the task. We track up to 4096
// recordingIds (~weeks of normal usage) and roll the oldest out.
const _enqueuedRecordingIds = new Set();
const _ENQUEUED_RECORDING_IDS_CAP = 4096;
function enqueuePostStopTask(options = {}) {
  const task = {
    autoTranscribe: !!options.autoTranscribe,
    autoSendEnter: !!options.autoSendEnter,
    stopRequestedAt: Number(options.stopRequestedAt || Date.now()),
    recordingId: Number(options.recordingId || 0),
    target: normalizeCapturedPasteTarget(options.target),
  };
  if (!task.autoTranscribe) return false;
  // Dedup by recordingId. recordingId === 0 is the legacy fallback
  // (renderer didn't supply one, very old build); skip dedup for
  // those so the legacy path still works at least once. Modern
  // renderers always send a positive monotonic id.
  if (task.recordingId > 0) {
    if (_enqueuedRecordingIds.has(task.recordingId)) {
      appendMainLog(
        `[post-stop-queue] dedup-skipped rec=${task.recordingId} ` +
        `(already enqueued; preventing double-paste)`
      );
      return false;
    }
    _enqueuedRecordingIds.add(task.recordingId);
    // Roll the oldest entry out when the cap is reached.
    if (_enqueuedRecordingIds.size > _ENQUEUED_RECORDING_IDS_CAP) {
      const iter = _enqueuedRecordingIds.values();
      const oldest = iter.next().value;
      if (oldest !== undefined) _enqueuedRecordingIds.delete(oldest);
    }
  }
  postStopQueue.push(task);
  pendingTranscriptionCount += 1;
  appendMainLog(`[post-stop-queue] enqueue pending=${pendingTranscriptionCount} rec=${task.recordingId} ${pasteTargetSummary(task.target)}`);
  void setRecordingStatus("Transcribing", RECORDING_STATUS_KIND.TRANSCRIBING).catch((e) => {
    appendMainLog(`[post-stop-queue] status-publish failed: ${compactLogText(e?.message || e)}`);
  });
  void runPostStopQueue();
  return true;
}

async function runPostStopQueue() {
  if (postStopWorkerRunning) return;
  postStopWorkerRunning = true;
  try {
    while (postStopQueue.length > 0) {
      const task = postStopQueue.shift();
      if (!task) continue;
      // One accounting block per task: the decrement is guaranteed
      // to happen exactly once even if any step below throws, so the
      // counter can never drift above the real number of pending
      // tasks. The outer try/finally (at the function bottom) drains
      // any remaining queue entries on catastrophic failure.
      let taskResult = null;
      try {
        try {
          taskResult = await processPostStopTask(task);
        } catch (e) {
          appendMainLog(`[post-stop-queue] task-error rec=${task.recordingId} err="${compactLogText(e?.message || e)}"`);
          await setRecordingStatus("Saved To App", RECORDING_STATUS_KIND.OK).catch(() => { });
          taskResult = { dwellMs: RECORDING_STATUS_TERMINAL_DWELL_MS };
        }
      } finally {
        pendingTranscriptionCount = Math.max(0, pendingTranscriptionCount - 1);
      }
      if (pendingTranscriptionCount > 0) {
        await setRecordingStatus("Transcribing", RECORDING_STATUS_KIND.TRANSCRIBING).catch(() => { });
      } else {
        const dwellMs = Math.max(0, Number(taskResult?.dwellMs || 0));
        if (dwellMs > 0) await sleep(dwellMs);
        resetRecordingStatusState();
      }
    }
  } finally {
    // Catastrophic exit — drop any tasks the loop could not reach so
    // the counter can never outlive the queue and produce a phantom
    // "N queued" indicator the user cannot clear.
    if (postStopQueue.length > 0) {
      const dropped = postStopQueue.length;
      postStopQueue = [];
      pendingTranscriptionCount = Math.max(0, pendingTranscriptionCount - dropped);
      appendMainLog(`[post-stop-queue] drained dropped=${dropped}`);
    }
    postStopWorkerRunning = false;
  }
}

// Second-line dedup: tracks recordingIds that have ACTUALLY been pasted.
//
// The two gates are not one guard written twice. `_enqueuedRecordingIds`
// is an idempotency key at queue ADMISSION — it stops the duplicate work
// (a transcript poll, a clipboard write) before it is done. This one sits
// at the IRREVERSIBLE boundary: injecting keystrokes into another
// application cannot be taken back, and the only cost of a guard there is
// a Set lookup. `postStopQueue.push` happens at exactly one site today, so
// this gate should never fire; that is the point of putting it in front of
// the one action a future third entry point could not undo.
//
// It does NOT cover the legacy `recordingId === 0` path, and an earlier
// version of this comment claimed it did: an id of 0 is exempt from BOTH
// gates by the same rule, because a renderer old enough not to send an id
// cannot be deduplicated at all.
const _pastedRecordingIds = new Set();
const _PASTED_RECORDING_IDS_CAP = 4096;
function _markRecordingPasted(recordingId) {
  if (!recordingId || recordingId <= 0) return;
  _pastedRecordingIds.add(recordingId);
  if (_pastedRecordingIds.size > _PASTED_RECORDING_IDS_CAP) {
    const oldest = _pastedRecordingIds.values().next().value;
    if (oldest !== undefined) _pastedRecordingIds.delete(oldest);
  }
}

async function processPostStopTask(task) {
  const trace = createTrace("post_stop", { autoTranscribe: !!task.autoTranscribe, queuePending: pendingTranscriptionCount });
  // SECOND-LINE DEDUP — the guard in front of the irreversible action. If
  // the same recordingId reaches this function through any path that
  // bypassed the admission gate, refuse to paste a recording that already
  // produced one. (Not the `recordingId === 0` path: an id of 0 is exempt
  // from both gates, because there is nothing to key on.)
  if (task.recordingId > 0 && _pastedRecordingIds.has(task.recordingId)) {
    appendMainLog(
      `[post-stop-paste] dedup-skipped rec=${task.recordingId} ` +
      `(already pasted; second-line guard fired)`,
    );
    traceEnd(trace, "skipped", { reason: "already-pasted" });
    return { dwellMs: 0 };
  }
  await setRecordingStatus("Transcribing", RECORDING_STATUS_KIND.TRANSCRIBING).catch((e) => {
    appendMainLog(`[post-stop] transcribing-status failed: ${compactLogText(e?.message || e)}`);
  });
  // Bound post-stop wait to the renderer's live-recovery SLA. Fast paths
  // exit immediately on paste-ready; this ceiling only protects the
  // rare "stream dropped, REST/local recovery is still running" case.
  // Mirrors the renderer's slow-path SLA: Deepgram final envelope
  // (up to ~4s) + REST/local recovery hard cap (20s) + bounded live
  // paste-upscale wait (3s) + disk/IPC headroom. Fast paths exit on
  // the first paste-ready signal, so increasing this ceiling does not
  // add latency to healthy recordings; it only prevents legitimate
  // slow recovery from degrading into "Saved To App" with no paste.
  const POST_STOP_TRANSCRIPT_TIMEOUT_MS = PASTE_POST_STOP_DEADLINE_MS;
  // BUGS_AUDIT §6.7. The renderer's IPC hand-off is the primary path;
  // the executeJavaScript poll is what happens when it never speaks.
  // A renderer that has the bridge sends its first signal within
  // milliseconds of publishing any output, so this window is generous
  // for the case it covers and short enough that an OLDER renderer —
  // one built before the bridge existed, which will never call it —
  // loses at most this much before the poll takes over.
  const POST_STOP_IPC_GRACE_MS = 2000;
  // Poll cadence once the fallback is in charge. 30 ms cost up to ~1000
  // synchronous evaluations in the renderer at exactly the moment it
  // finalizes Deepgram, runs the paste upscale and serializes audio
  // (§6.7). At 250 ms the fallback costs ~120 over the whole deadline,
  // and it only runs at all when nothing better is available.
  const POST_STOP_POLL_INTERVAL_MS = 250;
  const deadline = Date.now() + POST_STOP_TRANSCRIPT_TIMEOUT_MS;
  let transcript = "";
  let pollCount = 0;
  const stopRequestedAt = Number(task.stopRequestedAt || Date.now());
  let recordingStatusPhase = "transcribing";
  let terminalWithoutPasteStatus = "";
  // BUGS_AUDIT §6.9: the best text seen for THIS recording that was not
  // paste-ready — a pre-upscale provisional, or a status-only signal
  // carrying transcript text. Never pasted (§6.8), but it is what the
  // deadline-expiry recovery hands to the user instead of nothing.
  let bestKnownText = "";
  // Sequence of the last hand-off signal already accounted for, so the
  // same signal cannot be handled twice by the loop below.
  let handledSignalSeq = 0;
  let heardIpcSignal = false;

  // One reading of a hand-off signal, used wherever a signal is picked
  // up, so the primary path cannot drift from the late-arrival case.
  // Returns "final" | "terminal" | "provisional".
  const consumeIpcSignal = (signal) => {
    handledSignalSeq = signal.seq;
    heardIpcSignal = true;
    const text = normalizeTranscriptText(signal.text);
    const elapsedMs = Date.now() - stopRequestedAt;
    if (signal.final) {
      // §6.8: finality is stated, never inferred. This is the only
      // thing on the IPC path that may be pasted.
      transcript = text;
      traceStep(trace, "ipc_final", {
        elapsedMs,
        recordingId: signal.recordingId,
        source: signal.source,
        textLen: text.length,
      });
      if (isMeaningfulTranscriptText(text)) return "final";
      // The renderer called this final, but it is a no-speech/error
      // string rather than something to paste — same outcome the poll
      // reaches through uiFinalTerminalWithoutPaste.
      transcript = "";
      terminalWithoutPasteStatus = isNoSpeechFinalStatusText(text)
        ? "Recording completed, no speech detected."
        : text;
      return "terminal";
    }
    const meaningful = isMeaningfulTranscriptText(text);
    traceStep(trace, "ipc_provisional", {
      elapsedMs,
      recordingId: signal.recordingId,
      source: signal.source,
      textLen: text.length,
      meaningful,
    });
    if (meaningful) {
      // Best-known text only (§6.8/§6.9) — keep waiting for the final.
      bestKnownText = text;
      return "provisional";
    }
    // A status-only publish with nothing to paste (no speech, error):
    // the recording is over and there will be no final. Reporting it
    // now is what the poll's terminal branches do today.
    terminalWithoutPasteStatus = isNoSpeechFinalStatusText(text)
      ? "Recording completed, no speech detected."
      : text;
    return "terminal";
  };

  // How the transcript arrives, in one loop with two sources and a
  // strict order of preference (BUGS_AUDIT §6.7):
  //
  //   1. The renderer's IPC hand-off. Primary. Once ANYTHING has come
  //      over the bridge we know the renderer speaks the protocol, so we
  //      stay on it until the deadline: it WILL publish the paste-ready
  //      text, and if it dies before doing so, the provisional already
  //      in hand is the best-known text §6.9 recovers with. Zero
  //      evaluations are injected into the renderer on this path.
  //   2. The executeJavaScript poll. Fallback, entered only after the
  //      bridge has stayed silent for the whole grace window — an older
  //      renderer, built before the bridge existed, which will never
  //      call it. recordingId <= 0 is the same case one step further
  //      back (a renderer too old even to supply an id): there is no id
  //      to match a signal against, so it starts polling immediately.
  //
  // A late first signal still wins: the loop re-reads the slot on every
  // pass, so a renderer that speaks up after the poll started takes the
  // poll back out of charge.
  const ipcGraceUntil = Date.now() + POST_STOP_IPC_GRACE_MS;
  let pollFallbackStarted = false;
  // Sleep that ends the moment the renderer publishes something newer
  // than what has already been handled. Used for every wait below, so a
  // signal is never sitting in the slot while this task sleeps on a
  // timer. With a legacy recordingId there is nothing to match, and the
  // slot degrades to exactly that plain timer.
  const restUntilSignalOr = (ms) =>
    recordingFinalSlot.waitForSignal(task.recordingId, {
      sinceSeq: handledSignalSeq,
      timeoutMs: Math.max(1, ms),
    });

  while (Date.now() < deadline) {
    // 1. The primary path: anything the renderer has handed over.
    const known = recordingFinalSlot.peek(task.recordingId);
    if (known?.last && known.last.seq > handledSignalSeq) {
      // "provisional" is not an answer — keep waiting for the final.
      if (consumeIpcSignal(known.last) !== "provisional") break;
      continue;
    }

    // 2. The fallback poll takes over only when the bridge has stayed
    //    silent for the whole grace window. Once the renderer HAS used
    //    it, the poll never starts: the renderer will publish the
    //    paste-ready text, and until it does there is nothing the poll
    //    could learn that §6.8 would let us paste anyway.
    const pollInCharge =
      !heardIpcSignal && (task.recordingId <= 0 || Date.now() >= ipcGraceUntil);
    if (!pollInCharge) {
      const waitUntil = heardIpcSignal ? deadline : Math.min(ipcGraceUntil, deadline);
      await restUntilSignalOr(waitUntil - Date.now());
      continue;
    }
    if (!pollFallbackStarted) {
      pollFallbackStarted = true;
      traceStep(trace, "poll_fallback", {
        elapsedMs: Date.now() - stopRequestedAt,
        recordingId: task.recordingId || 0,
        reason: task.recordingId > 0 ? "no-ipc-signal-within-grace" : "legacy-recording-id",
      });
    }

    // Everything below is the pre-§6.7 poll, minus the two wall-clock
    // guesses §6.8 removed: status-only text is best-known text, never
    // a final.
    pollCount += 1;
    if (!win || win.isDestroyed() || !win.webContents) {
      traceStep(trace, "poll_window_lost", { pollCount });
      await restUntilSignalOr(70);
      continue;
    }
    const state = await queryRendererState();
    if (!state) {
      traceStep(trace, "poll_js_error", { pollCount });
      await restUntilSignalOr(70);
      continue;
    }
    const statusLower = String(state.status || "").trim().toLowerCase();
    if (!state.isRec) {
      if (statusLower === "upscaling" && recordingStatusPhase !== "upscaling") {
        await setRecordingStatus("Upscaling", RECORDING_STATUS_KIND.UPSCALING);
        recordingStatusPhase = "upscaling";
      } else if ((statusLower === "processing" || statusLower === "transcribing") && recordingStatusPhase !== "transcribing") {
        await setRecordingStatus("Transcribing", RECORDING_STATUS_KIND.TRANSCRIBING);
        recordingStatusPhase = "transcribing";
      }
    }
    const finishedRecords = Array.isArray(state.finishedRecords) ? state.finishedRecords : [];
    const byRecording = task.recordingId > 0
      ? finishedRecords.find((x) => Number(x?.recordingId || 0) === task.recordingId)
      : null;
    const byTime = task.recordingId <= 0
      ? [...finishedRecords]
        .filter((x) => Number(x?.finishedAt || 0) > stopRequestedAt)
        .sort((a, b) => Number(b?.finishedAt || 0) - Number(a?.finishedAt || 0))[0]
      : null;
    const uiFinalKind = String(state.uiFinalKind || "").trim().toLowerCase();
    const uiFinalText = normalizeTranscriptText(state.uiFinalText || "");
    const uiFinalBelongsToTask =
      task.recordingId > 0
        ? Number(state.uiFinalRecordingId || 0) === task.recordingId
        : Number(state.uiFinalAt || 0) > stopRequestedAt;
    const uiFinalStatusHasTranscript =
      uiFinalKind === "status" &&
      uiFinalBelongsToTask &&
      isMeaningfulTranscriptText(uiFinalText);
    const uiFinalTerminalWithoutPaste =
      uiFinalBelongsToTask &&
      (uiFinalKind === "status" || uiFinalKind === "error") &&
      !!uiFinalText &&
      !uiFinalStatusHasTranscript;
    const uiFinalReadyByRecording =
      uiFinalKind === "transcript" &&
      isMeaningfulTranscriptText(uiFinalText) &&
      task.recordingId > 0 &&
      Number(state.uiFinalRecordingId || 0) === task.recordingId;
    const uiFinalReadyByTime =
      uiFinalKind === "transcript" &&
      isMeaningfulTranscriptText(uiFinalText) &&
      task.recordingId <= 0 &&
      Number(state.uiFinalAt || 0) > stopRequestedAt;
    const readyByRecording = !!byRecording || (task.recordingId > 0 && Number(state.finishedRecordingId || 0) === task.recordingId);
    const readyByTime = !!byTime || (task.recordingId <= 0 && state.finishedAt > stopRequestedAt);
    if (readyByRecording || readyByTime || uiFinalReadyByRecording || uiFinalReadyByTime) {
      transcript = normalizeTranscriptText(
        byRecording?.text || byTime?.text || state.finishedText || uiFinalText || ""
      );
      if (!isMeaningfulTranscriptText(transcript)) {
        const terminalReason = isNoSpeechFinalStatusText(transcript)
          ? "no-speech-ready-signal"
          : !transcript && (byRecording || byTime || Number(state.finishedRecordingId || 0) === task.recordingId)
            ? "empty-finished-record"
            : uiFinalTerminalWithoutPaste
              ? "ui-final-status"
              : "";
        if (terminalReason) {
          terminalWithoutPasteStatus = isNoSpeechFinalStatusText(transcript) || terminalReason === "empty-finished-record"
            ? "Recording completed, no speech detected."
            : uiFinalText;
          traceStep(trace, "signal_ready_terminal_without_paste", {
            pollCount,
            expectedRecordingId: task.recordingId || 0,
            finishedRecordingId: Number(byRecording?.recordingId || state.finishedRecordingId || state.uiFinalRecordingId || 0),
            reason: terminalReason,
            textLen: transcript.length,
            preview: compactLogText(transcript || uiFinalText, 80),
          });
          break;
        }
        traceStep(trace, "signal_ready_ignored_non_transcript", {
          pollCount,
          textLen: transcript.length,
          preview: compactLogText(transcript, 80),
        });
        transcript = "";
        await restUntilSignalOr(POST_STOP_POLL_INTERVAL_MS);
        continue;
      }
      traceStep(trace, "signal_ready", {
        pollCount,
        finishedAt: Number(byRecording?.finishedAt || byTime?.finishedAt || state.finishedAt || 0),
        finishedRecordingId: Number(byRecording?.recordingId || state.finishedRecordingId || state.uiFinalRecordingId || 0),
        expectedRecordingId: task.recordingId || 0,
        delay: Number(byRecording?.finishedAt || byTime?.finishedAt || state.finishedAt || state.uiFinalAt || 0) - stopRequestedAt,
        source: byRecording ? "finished_record" : byTime ? "finished_record_by_time" : state.finishedText ? "finished_text" : "ui_final",
        textLen: transcript.length,
      });
      break;
    }
    if (uiFinalStatusHasTranscript) {
      // BUGS_AUDIT §6.8. This is the status-only publish: the renderer
      // has text, but the paste-ready version (post-upscale) does not
      // exist yet. It used to become the pasted transcript after 3500 ms
      // of waiting, which made one recording produce two possible
      // results depending on how long the upscale took. A wall clock
      // cannot know whether text is final — only the renderer can, and
      // it says so on the signal it publishes next. Until then this is
      // best-known text: never pasted, but what §6.9 recovers with if
      // the deadline expires.
      bestKnownText = uiFinalText;
    }
    if (uiFinalTerminalWithoutPaste) {
      terminalWithoutPasteStatus = isNoSpeechFinalStatusText(uiFinalText)
        ? "Recording completed, no speech detected."
        : uiFinalText;
      traceStep(trace, "terminal_without_paste", {
        pollCount,
        expectedRecordingId: task.recordingId || 0,
        uiFinalRecordingId: Number(state.uiFinalRecordingId || 0),
        uiFinalKind,
        status: compactLogText(state.status || "", 80),
        statusKind: compactLogText(state.statusKind || "", 40),
        reason: isNoSpeechFinalStatusText(uiFinalText) ? "no-speech" : "ui-final-status",
      });
      break;
    }
    const doneLike = !state.busy && !state.progressVisible && !state.isRec &&
      (
        state.status === "Done" ||
        state.status === "Error" ||
        state.status === "Idle" ||
        state.statusKind === "done" ||
        state.statusKind === "error" ||
        state.statusKind === "idle"
      );
    if (doneLike && state.status === "Done" && uiFinalStatusHasTranscript) {
      // Status "Done" with transcript text but no paste-ready signal
      // yet. §6.8's second wall-clock guess lived here — 600 ms and the
      // pre-upscale text was pasted. Keep waiting instead: the renderer
      // publishes the paste-ready text within its own upscale SLA, and
      // if it never does, the deadline hands bestKnownText to §6.9.
      traceStep(trace, "done_waiting_for_paste_ready", {
        pollCount,
        expectedRecordingId: task.recordingId || 0,
        uiFinalRecordingId: Number(state.uiFinalRecordingId || 0),
        textLen: uiFinalText.length,
      });
      await restUntilSignalOr(POST_STOP_POLL_INTERVAL_MS);
      continue;
    }
    if (doneLike) {
      terminalWithoutPasteStatus = isNoSpeechFinalStatusText(uiFinalText)
        ? "Recording completed, no speech detected."
        : "";
      traceStep(trace, "terminal_done_without_transcript", {
        pollCount,
        expectedRecordingId: task.recordingId || 0,
        uiFinalRecordingId: Number(state.uiFinalRecordingId || 0),
        uiFinalKind,
        status: compactLogText(state.status || "", 80),
        statusKind: compactLogText(state.statusKind || "", 40),
        reason: terminalWithoutPasteStatus ? "no-speech" : "done-no-transcript",
      });
      break;
    }
    await restUntilSignalOr(POST_STOP_POLL_INTERVAL_MS);
  }

  let recordingStatusText = "Saved To App";
  // The kind travels with the text all the way to setRecordingStatus, so
  // the capsule never has to guess a terminal state from its wording.
  let recordingStatusKind = RECORDING_STATUS_KIND.OK;
  if (transcript) {
    traceStep(trace, "transcript_ready", {
      len: transcript.length,
      digest: textDigest(transcript),
      preview: compactLogText(transcript, 140),
    });
    lastTranscriptText = transcript;
    saveLastTranscriptToDisk(transcript);
    try {
      clipboard.writeText(transcript);
    } catch { }

    // Paste destination is current-focus-first — see
    // ``resolvePasteDestination``. The start target is only consulted
    // when the front app is Transcriptor itself.
    const destination = await resolvePasteDestination(task.target);
    let effectiveTarget = destination.target;
    if (destination.alreadyFront) {
      traceStep(trace, "target_current_focus", {
        target: pasteTargetSummary(effectiveTarget),
      });
    } else if (!hasCapturedPasteTarget(effectiveTarget)) {
      try {
        effectiveTarget = capturePasteTargetFromFrontInfo(await getFrontmostAppInfo());
        traceStep(trace, "target_fallback_current_front", {
          target: pasteTargetSummary(effectiveTarget),
        });
      } catch { }
    } else {
      try {
        const restored = await activateCapturedPasteTarget(effectiveTarget);
        traceStep(trace, restored ? "target_restored" : "target_restore_failed", {
          target: pasteTargetSummary(effectiveTarget),
        });
        if (!restored) {
          effectiveTarget = emptyCapturedPasteTarget();
        }
      } catch {
        effectiveTarget = emptyCapturedPasteTarget();
      }
    }

    const pasted = await tryPasteToFocusedField(transcript, effectiveTarget, {
      alreadyFront: destination.alreadyFront,
    });
    traceStep(trace, "paste_result", {
      ok: !!pasted.ok,
      method: pasted.method || "unknown",
      verified: !!pasted.verified,
      reason: compactLogText(pasted.reason || ""),
    });
    appendMainLog(
      `[paste-auto] ${pasteTargetSummary(effectiveTarget)} ok=${pasted.ok} method=${pasted.method || "unknown"} verified=${pasted.verified ? "1" : "0"} reason="${pasted.reason || ""}" len=${transcript.length}`
    );
    if (pasted.ok) {
      // Mark this recordingId as pasted BEFORE returning so any
      // second-arrival task for the same id (defensive against races
      // that bypass the enqueue dedup) is rejected by the second-line
      // guard at the top of processPostStopTask.
      //
      // There is exactly ONE paste site in this function, reached by
      // both hand-off paths — the IPC final and the poll fallback only
      // differ in how ``transcript`` was filled. So paste-last and the
      // double-paste guard cannot end up covering one path and not the
      // other: adding a path can only mean filling in ``transcript``.
      _markRecordingPasted(task.recordingId);
      // Show success immediately once the paste actually happened.
      await setRecordingStatus("Pasted", RECORDING_STATUS_KIND.OK);
    }
    let autoSendResult = null;
    if (pasted.ok && task.autoSendEnter) {
      // Settle before Enter, from the budget table with every other
      // wall-clock number the paste path spends. It was raised 220 -> 380
      // when the paste script stopped holding its own 160 ms delay after
      // clicking Paste: the time between the paste landing and Enter firing
      // is what this protects, and it is unchanged.
      await sleep(pasteAutoSendSettleMs(process.platform));
      const sent = await sendCommandEnterToFocusedApp(effectiveTarget);
      autoSendResult = sent;
      traceStep(trace, "cmd_enter_result", {
        ok: !!sent.ok,
        reason: compactLogText(sent.reason || ""),
      });
      appendMainLog(
        `[cmd-enter] ${pasteTargetSummary(effectiveTarget)} ok=${sent.ok ? "1" : "0"} reason="${sent.reason || ""}"`
      );
      if (sent.ok) {
        await setRecordingStatus("Sent", RECORDING_STATUS_KIND.OK);
      } else {
        await setRecordingStatus(recordingStatusForAutoSendFailure(sent.reason), RECORDING_STATUS_KIND.FAIL);
      }
      if (!sent.ok && needsMacPastePermissionPrompt(sent.reason)) {
        scheduleMacPastePermissionsPrompt(sent.reason);
      }
    }
    if (!pasted.ok && needsMacPastePermissionPrompt(pasted.reason)) {
      scheduleMacPastePermissionsPrompt(pasted.reason);
    }
    if (pasted.ok && task.autoSendEnter) {
      recordingStatusText = autoSendResult?.ok
        ? "Sent"
        : recordingStatusForAutoSendFailure(autoSendResult?.reason);
      recordingStatusKind = autoSendResult?.ok ? RECORDING_STATUS_KIND.OK : RECORDING_STATUS_KIND.FAIL;
    } else {
      recordingStatusText = pasted.ok ? "Paste Sent" : recordingStatusForPasteFailure(pasted.reason);
      // A failed paste always leaves the transcript on the clipboard, so
      // it is a warning the user can act on, not an error.
      recordingStatusKind = pasted.ok ? RECORDING_STATUS_KIND.OK : RECORDING_STATUS_KIND.WARN;
    }
  } else {
    if (terminalWithoutPasteStatus) {
      recordingStatusText = terminalWithoutPasteStatus;
      recordingStatusKind = RECORDING_STATUS_KIND.OK;
    } else {
      // BUGS_AUDIT §6.9: the poll deadline expired with no ready signal
      // at all — previously this branch did nothing (no clipboard write,
      // no last_transcript.json, no status naming a way out), so a slow
      // recovery that finished moments later was invisible: the user's
      // only feedback was "Saved To App" with nothing actually pasted or
      // copied, and no way to tell that pressing the paste-last hotkey
      // would help. Recover whatever text the renderer or disk already
      // has through the same lookup the paste-last hotkey itself uses
      // (getLatestTranscriptText), so a transcript that exists is never
      // silently dropped just because this poll gave up on it.
      //
      // bestKnownText is the stronger half of that recovery: the
      // pre-upscale text this recording actually produced, which §6.8
      // forbids PASTING but which is exactly what the user wants on the
      // clipboard when the paste-ready version never arrived.
      traceStep(trace, "transcript_missing", {
        reason: "no-final-or-live-text-before-deadline",
        bestKnownLen: bestKnownText.length,
      });
      ({ text: recordingStatusText, kind: recordingStatusKind } =
        await handlePostStopTranscriptTimeout(trace, bestKnownText));
    }
  }

  const isRecNow = await isRendererRecording();
  if (!isRecNow) {
    await setRecordingStatus(recordingStatusText, recordingStatusKind);
  }
  traceEnd(trace, "done", { transcriptFound: !!transcript, pollCount });
  return {
    dwellMs: isRecNow ? 0 : RECORDING_STATUS_TERMINAL_DWELL_MS,
  };
}

/**
 * BUGS_AUDIT §6.9 recovery path: called only when processPostStopTask's
 * deadline expired without any ready signal — no finished record, no
 * ui-final transcript, nothing terminal to report.
 *
 * ``bestKnownText`` is what THIS recording produced but never declared
 * paste-ready: a ``final:false`` IPC provisional, or the status-only
 * text the poll saw. §6.8 forbids pasting it — the renderer never said
 * it was final — but it is the most specific thing that exists for this
 * recording, so it is preferred over the general lookup below, which
 * can only offer whatever transcript happens to be newest (and on a
 * failed recording, that is a PREVIOUS recording's text from disk).
 *
 * Otherwise it reuses getLatestTranscriptText (the same lookup
 * pasteLatestTranscriptFromShortcut uses for the paste-last hotkey —
 * finishedText, then a ui-final transcript, then the in-memory/disk
 * fallback) so recovery here can never drift out of sync with what that
 * hotkey would find.
 *
 * If something is found: write it to the clipboard (getLatestTranscriptText
 * already persists it to last_transcript.json) and return a status that
 * names the paste-last accelerator, so the user has a concrete next
 * action instead of a dead-end "Saved To App".
 *
 * If nothing is found: there is nothing to recover — the recording
 * genuinely produced no text before the deadline — so the status says
 * that plainly instead of pointing at a hotkey that would also find
 * nothing.
 */
async function handlePostStopTranscriptTimeout(trace, bestKnownText = "") {
  const best = normalizeTranscriptText(bestKnownText);
  const fromBestKnown = isMeaningfulTranscriptText(best);
  const recovered = fromBestKnown ? best : await getLatestTranscriptText();
  const pasteAccel = lastShortcutStatus?.paste?.active || lastShortcutStatus?.paste?.desired || "";
  if (isMeaningfulTranscriptText(recovered)) {
    // getLatestTranscriptText already persists what it returns; the
    // best-known path has to do it here so the paste-last hotkey (and
    // the next launch) find the same text this status points at.
    if (fromBestKnown) {
      lastTranscriptText = recovered;
      saveLastTranscriptToDisk(recovered);
    }
    try { clipboard.writeText(recovered); } catch { }
    traceStep(trace, "transcript_recovered_after_timeout", {
      len: recovered.length,
      digest: textDigest(recovered),
      source: fromBestKnown ? "best_known_text" : "latest_transcript_lookup",
    });
    // WARN, not "still working": this IS the final answer, and it says
    // the transcript survived. It used to fall through both substring
    // ladders into "transcribing"/neutral, so the recovery status looked
    // like unfinished processing and the user went on waiting.
    return {
      text: pasteAccel
        ? `Timed out, but transcript is on your clipboard — press ${pasteAccel} to paste it.`
        : "Timed out, but transcript is on your clipboard.",
      kind: RECORDING_STATUS_KIND.WARN,
    };
  }
  traceStep(trace, "transcript_unrecoverable_after_timeout", {});
  return { text: "Timed out with no transcript to recover.", kind: RECORDING_STATUS_KIND.FAIL };
}

async function getLatestTranscriptText() {
  const s = await queryRendererState();
  const finished = normalizeTranscriptText(s?.finishedText || "");
  if (isMeaningfulTranscriptText(finished)) {
    lastTranscriptText = finished;
    saveLastTranscriptToDisk(finished);
    return finished;
  }
  const uiFinalKind = String(s?.uiFinalKind || "").trim().toLowerCase();
  const uiFinalText = normalizeTranscriptText(s?.uiFinalText || "");
  if (uiFinalKind === "transcript" && isMeaningfulTranscriptText(uiFinalText)) {
    lastTranscriptText = uiFinalText;
    saveLastTranscriptToDisk(uiFinalText);
    return uiFinalText;
  }
  if (lastTranscriptText) return lastTranscriptText;
  const disk = loadLastTranscriptFromDisk();
  if (disk) {
    lastTranscriptText = disk;
    return disk;
  }
  return "";
}

async function pasteLatestTranscriptFromShortcut() {
  if (pasteShortcutInFlight) return;
  const trace = createTrace("paste_last", {});
  pasteShortcutInFlight = true;
  try {
    clearCapturedPasteTarget();
    await publishRecordingStatus("Pasting");
    const front = await getFrontmostAppInfoWithTimeout(1200);
    traceStep(trace, "front_before", {
      name: front.name || "",
      pid: front.pid || 0,
      windowTitle: compactLogText(front.windowTitle || "", 80),
      timedOut: !!front.timedOut,
    });
    const shortcutPasteTarget = capturePasteTargetFromFrontInfo(front);
    setCapturedPasteTarget(shortcutPasteTarget);

    const text = await getLatestTranscriptText();
    if (!text) {
      traceStep(trace, "no_text_available", {});
      await setRecordingStatus("No Text", RECORDING_STATUS_KIND.FAIL);
      await sleep(RECORDING_STATUS_TERMINAL_DWELL_MS);
      resetRecordingStatusState();
      clearCapturedPasteTarget();
      return;
    }
    traceStep(trace, "text_ready", {
      len: text.length,
      digest: textDigest(text),
      preview: compactLogText(text, 140),
    });
    try {
      clipboard.writeText(text);
    } catch { }

    // The target was just read from the frontmost app, so it already
    // owns focus — re-activating it would only cost a round trip.
    const pasted = await tryPasteToFocusedField(text, shortcutPasteTarget, {
      alreadyFront: Number(front?.pid) > 0 && !isBadActivationTarget(front?.name),
      // This paste is happening WHILE the hotkey chord is held — see
      // awaitModifierRelease.
      trigger: "hotkey",
      accelerator: lastShortcutStatus?.paste?.active || lastShortcutStatus?.paste?.desired || "",
    });
    traceStep(trace, "paste_result", {
      ok: !!pasted.ok,
      method: pasted.method || "unknown",
      verified: !!pasted.verified,
      reason: compactLogText(pasted.reason || ""),
    });
    appendMainLog(
      `[paste-last] ${pasteTargetSummary(shortcutPasteTarget)} ok=${pasted.ok} method=${pasted.method || "unknown"} verified=${pasted.verified ? "1" : "0"} reason="${pasted.reason || ""}" len=${text.length}`
    );
    await setRecordingStatus(
      // The paste-last hotkey is what the user just pressed, so the advice
      // is the system chord, not the key that failed.
      pasted.ok ? "Paste Sent" : recordingStatusForPasteFailure(pasted.reason, systemPasteAccelerator()),
      pasted.ok ? RECORDING_STATUS_KIND.OK : RECORDING_STATUS_KIND.WARN,
    );
    if (!pasted.ok) {
      if (needsMacPastePermissionPrompt(pasted.reason)) {
        scheduleMacPastePermissionsPrompt(pasted.reason);
      }
      appendMainLog(`[paste-last] failed: ${pasted.reason || "unknown"}`);
    }
    await sleep(RECORDING_STATUS_TERMINAL_DWELL_MS);
    clearCapturedPasteTarget();
    resetRecordingStatusState();
  } finally {
    clearCapturedPasteTarget();
    pasteShortcutInFlight = false;
    traceEnd(trace, "done", {});
  }
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fileExists(p) {
  // Accept BOTH POSIX absolute paths ("/…") AND Windows drive paths
  // ("C:\…"). The original "/"-prefix gate was a defence against bare
  // PATH names slipping through into fs.existsSync — preserve that
  // intent via path.isAbsolute which handles both conventions.
  // Without this, every bundled-runtime discovery on Windows returned
  // false because paths start with a drive letter, and 1.1.0's
  // "zero user setup" promise was silently inverted into a guaranteed
  // "Python not found" boot failure.
  if (!p) return false;
  if (!path.isAbsolute(p)) return false;
  try { return fs.existsSync(p); } catch { return false; }
}

// Live children spawned by runCommand (BUG-61): pip installs can run
// for 30 minutes; a quit must SIGKILL them, not orphan them. Populated
// on spawn, drained on close, flushed by killAllTrackedChildren().
const trackedChildren = new Set();

function killAllTrackedChildren() {
  for (const child of trackedChildren) {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  }
  trackedChildren.clear();
}

function runCommand(cmd, args, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  // Optional live view of the child's output: (streamName, line,
  // msSinceSpawn) per COMPLETE line, as it arrives. The buffered
  // stdout/stderr in the resolved value cannot say WHEN anything
  // happened, and for a child that reports progress before its result —
  // the paste script logging the edges of its accessibility reads — when
  // is the whole measurement. A partial trailing line is never
  // delivered: every progress marker ends in a newline.
  const onStreamLine = typeof options.onStreamLine === "function" ? options.onStreamLine : null;
  // How this child's text output is produced and how it must be read are
  // ONE decision, derived from the command line in ./child-io: PowerShell
  // is made to emit UTF-8 (its default is the system OEM code page, which
  // turns Cyrillic/CJK window titles into mojibake), and a `cscript //U`
  // invocation declares UTF-16LE output, which is read back as UTF-16LE.
  // Reading //U output as UTF-8 is what made every successful Windows
  // paste look like a failure and pasted the transcript twice.
  const effectiveArgs = withUtf8OutputPrelude(cmd, args);
  const streamEncoding = childStreamEncoding(cmd, effectiveArgs);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const appendBoundedOutput = (current, chunk, streamName) => {
      const next = current + String(chunk || "");
      if (next.length <= RUN_COMMAND_OUTPUT_MAX_CHARS) return next;
      if (streamName === "stdout") stdoutTruncated = true;
      if (streamName === "stderr") stderrTruncated = true;
      return next.slice(-RUN_COMMAND_OUTPUT_MAX_CHARS);
    };
    const finalStdout = () => (
      stdoutTruncated
        ? `[stdout truncated to last ${RUN_COMMAND_OUTPUT_MAX_CHARS} chars]\n${stdout}`
        : stdout
    );
    const finalStderr = () => (
      stderrTruncated
        ? `[stderr truncated to last ${RUN_COMMAND_OUTPUT_MAX_CHARS} chars]\n${stderr}`
        : stderr
    );
    // Three independent code paths (timeout, child error, child close)
    // can all reach ``resolve``; the first wins, the rest are no-ops.
    // Without this guard, an error fired BETWEEN the timeout's
    // SIGKILL and the kernel reaping the process triggered TWO
    // resolves on the same Promise — the second is a Promise no-op
    // but the work allocated by the second (e.g. extra stderr
    // concatenation) is wasted and the trace path fires twice.
    let settled = false;
    const settleOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const spawnedAt = Date.now();
    const lineBuffers = { stdout: "", stderr: "" };
    const emitLines = (streamName, chunk) => {
      if (!onStreamLine) return;
      const at = Date.now() - spawnedAt;
      lineBuffers[streamName] += chunk;
      let newlineAt = lineBuffers[streamName].indexOf("\n");
      while (newlineAt >= 0) {
        const line = lineBuffers[streamName].slice(0, newlineAt).replace(/\r$/, "").trim();
        lineBuffers[streamName] = lineBuffers[streamName].slice(newlineAt + 1);
        if (line) {
          // A misbehaving observer must never take down the child it is
          // only watching.
          try { onStreamLine(streamName, line, at); } catch { }
        }
        newlineAt = lineBuffers[streamName].indexOf("\n");
      }
    };
    const child = spawn(cmd, effectiveArgs, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    // Live-children registry (BUG-61): a quit during a long runCommand
    // (the multi-GB engine pip install) previously left the child
    // running orphaned for its whole timeout. Tracked here and killed
    // by killAllTrackedChildren on the quit paths.
    trackedChildren.add(child);
    const untrackChild = () => trackedChildren.delete(child);
    child.once("close", untrackChild);
    child.once("error", untrackChild);
    // Decode by the encoding the command line declares (see ./child-io).
    // Explicit so a platform quirk cannot silently switch it, and so a
    // //U cscript call is read as the UTF-16LE it actually writes.
    try { child.stdout.setEncoding(streamEncoding); } catch { }
    try { child.stderr.setEncoding(streamEncoding); } catch { }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { }
      settleOnce({ ok: false, code: -1, stdout: finalStdout(), stderr: `${finalStderr()}\nTimed out` });
    }, timeoutMs);

    // A UTF-16LE stream (cscript //U) opens with a BOM, which survives
    // decoding as U+FEFF and would otherwise sit in front of the first
    // protocol marker. It can only appear in the first chunk.
    const firstChunkSeen = { stdout: false, stderr: false };
    const decodeChunk = (streamName, d) => {
      const raw = d.toString();
      if (firstChunkSeen[streamName]) return raw;
      firstChunkSeen[streamName] = true;
      return stripBom(raw);
    };

    child.stdout.on("data", (d) => {
      const chunk = decodeChunk("stdout", d);
      stdout = appendBoundedOutput(stdout, chunk, "stdout");
      emitLines("stdout", chunk);
    });

    child.stderr.on("data", (d) => {
      const chunk = decodeChunk("stderr", d);
      stderr = appendBoundedOutput(stderr, chunk, "stderr");
      emitLines("stderr", chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      settleOnce({ ok: false, code: -1, stdout: finalStdout(), stderr: `${finalStderr()}\n${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      settleOnce({ ok: code === 0, code: code ?? -1, stdout: finalStdout(), stderr: finalStderr() });
    });
  });
}

function isBundledPythonRuntime(python) {
  const bundled = getBundledPythonPath();
  return !!bundled && path.resolve(python) === path.resolve(bundled);
}

function getEngineSiteDir() {
  // OUTSIDE the signed .app: torch must never live inside the bundle
  // (writes break the code signature; updates would wipe it). The
  // backend imports the engine through PYTHONPATH instead.
  return path.join(app.getPath("userData"), "engine-site");
}

// Written into a staging tree only AFTER pip + reconciliation succeed
// and the tree is complete (BUG-76). A site without it is treated as
// not-installed: the installer re-runs instead of trusting a half-built
// tree whose `gigaam` may import but miss lazy transitive deps.
const ENGINE_INSTALL_MARKER = ".install-complete";

function buildPythonEnv(python, overrides = {}) {
  const env = { ...process.env };
  if (isBundledPythonRuntime(python)) {
    for (const key of PYTHON_ENV_SCRUB_KEYS) {
      delete env[key];
    }
    env.PYTHONNOUSERSITE = "1";
  }
  // Engine site-packages (GigaAM/torch) — prepended when present so
  // both the availability probe and the backend itself see it.
  try {
    const engineSite = getEngineSiteDir();
    if (fs.existsSync(path.join(engineSite, "gigaam"))) {
      const existing = env.PYTHONPATH || "";
      if (!existing.split(path.delimiter).includes(engineSite)) {
        env.PYTHONPATH = existing ? `${engineSite}${path.delimiter}${existing}` : engineSite;
      }
    }
  } catch { /* userData unavailable this early — skip */ }
  return {
    ...env,
    ...overrides,
  };
}

function canBindPort(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    const done = (ok) => {
      try {
        srv.close();
      } catch { }
      resolve(ok);
    };
    srv.once("error", () => done(false));
    srv.once("listening", () => done(true));
    try {
      srv.listen(port, host);
    } catch {
      done(false);
    }
  });
}

async function pickBackendPort(host, preferred = DEFAULT_BACKEND_PORT) {
  const start = Number(preferred || DEFAULT_BACKEND_PORT);
  for (let p = start; p < start + 24; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(host, p)) return p;
  }
  // Last resort: ask the OS for an ephemeral port. A zero result (never
  // observed in practice, but the API allows it on bind failure) used to
  // fall back to ``start`` — a port we just proved is occupied — which
  // guaranteed an EADDRINUSE crash loop. Now: retry the ephemeral ask,
  // then extend the linear scan before ever reusing a known-busy port.
  const ephemeralOnce = () => new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? Number(addr.port || 0) : 0;
      try {
        srv.close();
      } catch { }
      resolve(port);
    });
    srv.once("error", () => resolve(0));
  });
  return (async () => {
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const port = await ephemeralOnce();
      if (port > 0) return port;
    }
    for (let p = start + 24; p < start + 1048; p += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await canBindPort(host, p)) return p;
    }
    return 0;
  })();
}

// ── App-scoped venv (persists across app updates) ──
function getAppVenvDir() {
  return path.join(app.getPath("userData"), ".venv");
}

/**
 * One-shot cleanup of the legacy 1.0.x app-venv.
 *
 * 1.0.x created a Python venv at ``userData/.venv`` (~300–500 MB
 * after `pip install -r requirements.txt`). 1.1.0 ships a fully
 * self-contained bundled Python under ``resourcesPath/runtime/``
 * and never touches the legacy venv — it just sits on the user's
 * disk forever, wasting space, showing up in backup/sync tooling
 * for no reason.
 *
 * Only deletes if:
 *   1. We successfully booted with the bundled runtime this session
 *      (caller guarantees this via call site in resolvePython).
 *   2. The path really is ``userData/.venv`` — not some other `.venv`
 *      the user symlinked in via TRANSCRIPTOR_DATA_DIR shenanigans.
 *   3. We haven't already cleaned it in a prior session
 *      (idempotency marker).
 *
 * Non-fatal on every failure — wasting 500 MB is better than
 * deleting the wrong directory.
 */
function _cleanupOrphanedLegacyVenv() {
  try {
    const userData = path.resolve(app.getPath("userData"));
    const marker = path.join(userData, ".legacy-venv-cleaned");
    if (fs.existsSync(marker)) return;
    const venvDir = getAppVenvDir();
    const target = path.resolve(venvDir);
    // Safety: path must be EXACTLY `<userData>/.venv` — no subpath,
    // no symlink chain. Prevents a misconfigured userData from
    // causing us to delete something unexpected.
    if (path.dirname(target) !== userData || path.basename(target) !== ".venv") {
      appendMainLog(`[legacy-venv-cleanup] refusing to delete unexpected path: ${target}`);
      return;
    }
    if (!fs.existsSync(target)) {
      // No legacy venv to clean. Still write the marker so we skip
      // the directory-exists probe on every subsequent launch.
      try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* non-fatal */ }
      return;
    }
    // Additional safety: confirm it LOOKS like a Python venv before
    // deleting (has pyvenv.cfg or bin/python* / Scripts/python.exe).
    // A user's arbitrary .venv folder without these markers gets
    // skipped — better cautious than sorry.
    const looksLikeVenv = (
      fs.existsSync(path.join(target, "pyvenv.cfg"))
      || fs.existsSync(path.join(target, "bin", "python"))
      || fs.existsSync(path.join(target, "bin", "python3"))
      || fs.existsSync(path.join(target, "Scripts", "python.exe"))
    );
    if (!looksLikeVenv) {
      appendMainLog(`[legacy-venv-cleanup] ${target} does not look like a Python venv; skipping`);
      return;
    }
    fs.rmSync(target, { recursive: true, force: true });
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* non-fatal */ }
    appendMainLog(`[legacy-venv-cleanup] removed legacy venv at ${target}`);
  } catch (e) {
    appendMainLog(`[legacy-venv-cleanup] non-fatal: ${e?.message || e}`);
  }
}

async function findSystemPython(repoRoot) {
  // Find any working Python 3 on the system (for venv creation)
  const sysCandidates = process.platform === "win32" ? [
    (process.env.PYTHON || "").trim(),
    "python"
  ].filter(Boolean) : [
    (process.env.PYTHON || "").trim(),
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const py of sysCandidates) {
    // path.isAbsolute matches both POSIX "/…" and Windows "C:\…".
    // Previous startsWith("/") let non-existent Windows paths slip
    // through to spawn() with ENOENT.
    if (path.isAbsolute(py) && !fileExists(py)) continue;
    const check = await runCommand(py, ["-c", "import sys; print(sys.version_info.major)"], {
      cwd: repoRoot, timeoutMs: 8000
    });
    if (check.ok && (check.stdout || "").trim() === "3") return py;
  }
  return null;
}

async function ensureAppVenv(repoRoot) {
  const venvDir = getAppVenvDir();
  const venvPy = process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python3");

  // If venv already exists and works, return it
  if (fileExists(venvPy)) {
    const check = await runCommand(venvPy, ["-c", "import sys; print(sys.executable)"], {
      cwd: repoRoot, timeoutMs: 8000
    });
    if (check.ok) return venvPy;
    // Venv is broken — delete and recreate
    appendMainLog(`[venv] existing venv broken, recreating`);
    try { fs.rmSync(venvDir, { recursive: true, force: true }); } catch { }
  }

  // Find a system Python to create the venv with
  const sysPy = await findSystemPython(repoRoot);
  if (!sysPy) return null;

  appendMainLog(`[venv] creating app venv at "${venvDir}" using "${sysPy}"`);
  const create = await runCommand(sysPy, ["-m", "venv", venvDir], {
    cwd: repoRoot, timeoutMs: 60000
  });

  if (!create.ok) {
    appendMainLog(`[venv] creation failed: ${(create.stderr || "").trim()}`);
    return null;
  }

  if (fileExists(venvPy)) return venvPy;
  return null;
}

/**
 * Absolute path to the bundled Python interpreter that ships with the
 * installer, or null if not present (dev checkout or prior releases).
 *
 * When the app is packaged by electron-builder with the bundled runtime,
 * extraResources places the Python install at
 * `process.resourcesPath/runtime/python/`. Windows layout:
 *   runtime/python/python.exe
 * Unix layout:
 *   runtime/python/bin/python3
 *
 * The bundled runtime contains Python 3.12 + all requirements.txt deps
 * pre-installed into site-packages + a static ffmpeg binary. Using it
 * means zero user setup — no winget install, no pip, no internet.
 */
function getBundledPythonPath() {
  // Only a packaged app ships the bundled runtime. In dev mode
  // process.resourcesPath points at Electron's OWN Resources dir
  // (node_modules/electron/.../Resources); a stray runtime/ folder
  // there would be picked up by accident.
  if (!app.isPackaged) return null;
  const resDir = process.resourcesPath || "";
  if (!resDir) return null;
  const candidate = process.platform === "win32"
    ? path.join(resDir, "runtime", "python", "python.exe")
    : path.join(resDir, "runtime", "python", "bin", "python3");
  return fileExists(candidate) ? candidate : null;
}

/**
 * Absolute path to the bundled ffmpeg binary, or null if not bundled.
 * Appended to PATH when the backend is spawned so audio conversion
 * works offline without a system ffmpeg install.
 */
function getBundledFfmpegDir() {
  if (!app.isPackaged) return null;
  const resDir = process.resourcesPath || "";
  if (!resDir) return null;
  const dir = path.join(resDir, "runtime", "ffmpeg", "bin");
  const ffmpeg = process.platform === "win32"
    ? path.join(dir, "ffmpeg.exe")
    : path.join(dir, "ffmpeg");
  return fileExists(ffmpeg) ? dir : null;
}

async function resolvePython(repoRoot) {
  // 0) Bundled runtime (ships with release installer). Preferred over
  // everything else because it is known-good + fully self-contained —
  // the user doesn't need a system Python, a venv, pip, or network
  // access to first-launch the app.
  const bundled = getBundledPythonPath();
  if (bundled) {
    const check = await runCommand(bundled, ["-c", "import sys; print(sys.executable)"], {
      cwd: repoRoot, timeoutMs: 8000, env: buildPythonEnv(bundled)
    });
    if (check.ok) {
      appendMainLog(`[resolvePython] using bundled runtime: ${bundled}`);
      _cleanupOrphanedLegacyVenv();
      return bundled;
    }
    appendMainLog(`[resolvePython] bundled runtime failed probe: ${(check.stderr || "").trim()}`);
  }

  // 1) Try app venv (used by legacy source installers and older
  // Windows installs prior to 1.1.0).
  const appVenvPy = process.platform === "win32"
    ? path.join(getAppVenvDir(), "Scripts", "python.exe")
    : path.join(getAppVenvDir(), "bin", "python3");
  if (fileExists(appVenvPy)) {
    const check = await runCommand(appVenvPy, ["-c", "import sys; print(sys.executable)"], {
      // BUG-50: same scrubbed env as the bundled-runtime probe. A stray
      // PYTHONHOME/PYTHONPATH from the user's shell must not be able to
      // fail a healthy venv's `import sys` and push interpreter choice
      // down to the system fallback.
      cwd: repoRoot, timeoutMs: 8000, env: buildPythonEnv(appVenvPy)
    });
    if (check.ok) return (check.stdout || "").trim() || appVenvPy;
  }

  // 2) Try dev venv (for development)
  const devVenvPy = process.platform === "win32"
    ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
    : path.join(repoRoot, ".venv", "bin", "python3");
  if (fileExists(devVenvPy)) {
    const check = await runCommand(devVenvPy, ["-c", "import sys; print(sys.executable)"], {
      cwd: repoRoot, timeoutMs: 8000, env: buildPythonEnv(devVenvPy)
    });
    if (check.ok) return (check.stdout || "").trim() || devVenvPy;
  }

  // 3) Create app venv from system Python (legacy fallback for
  // installs without a bundled runtime).
  setBackendBootStatus("Setting up Python environment…");
  const created = await ensureAppVenv(repoRoot);
  if (created) return created;

  // 4) Fallback to any system Python (will need --user pip later)
  return await findSystemPython(repoRoot);
}

let backendBootStatus = "";
function setBackendBootStatus(msg) {
  backendBootStatus = msg || "";
  appendMainLog(`[backend-boot-status] ${msg}`);
  // Broadcast to renderer if window exists
  if (win && !win.isDestroyed() && win.webContents) {
    win.webContents.executeJavaScript(
      `window.__setBackendBootStatus && window.__setBackendBootStatus(${JSON.stringify(msg)});`,
      true
    ).catch(() => { });
  }
}

function broadcastBackendBootError() {
  if (!backendBootError || !win || win.isDestroyed() || !win.webContents) return;
  win.webContents.executeJavaScript(
    `window.__setBackendBootError && window.__setBackendBootError(${JSON.stringify(backendBootError)});`,
    true
  ).catch((e) => {
    appendMainLog(`[backend-boot-error-broadcast] failed: ${e?.message || e}`);
  });
}

/**
 * Optional engine: GigaAM (Sber Russian ASR).
 *
 * Lifecycle is USER-INITIATED (Settings → Local models → "Install
 * engine"), never boot-initiated: a multi-gigabyte pip run behind the
 * backend spawn wedged first-use for minutes and could not be cancelled.
 * ENABLE_GIGAAM next to requirements.txt remains the build-level feature
 * switch — it now gates AVAILABILITY of the Install affordance, not an
 * automatic download. The pure decision logic lives in ./engine-deps
 * (SSOT, unit-tested); this file owns orchestration only.
 */
const engineDeps = require("./engine-deps");

// Interpreter sys.path query: authoritative site-packages location for
// ANY runtime (bundled, app-venv, dev venv, system) without path guessing.
const SITE_PACKAGES_QUERY = [
  "import json, sysconfig",
  "print(json.dumps(sysconfig.get_paths()['purelib']))",
].join("; ");
const _sitePackagesCache = new Map(); // python path -> purelib dir | null

async function resolveSitePackagesDir(python, repoRoot) {
  if (_sitePackagesCache.has(python)) return _sitePackagesCache.get(python);
  const check = await runCommand(python, ["-c", SITE_PACKAGES_QUERY], {
    cwd: repoRoot, timeoutMs: 15000, env: buildPythonEnv(python),
  });
  const dir = check.ok ? (check.stdout || "").trim() : "";
  const value = dir && fs.existsSync(dir) ? dir : null;
  _sitePackagesCache.set(python, value);
  return value;
}

function readDistInfoInventory(dir) {
  try {
    return engineDeps.distInfoInventory(() => fs.readdirSync(dir));
  } catch {
    return {};
  }
}

/**
 * The engine interpreter's `major.minor`, for evaluating PEP 508
 * environment markers. Empty when it cannot be determined, which
 * `evaluateEnvironmentMarker` treats as "cannot decide" rather than
 * inventing an answer.
 */
async function resolvePythonVersion(python, repoRoot) {
  try {
    const res = await runCommand(
      python,
      ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
      { cwd: repoRoot, timeoutMs: 8000, env: buildPythonEnv(python) },
    );
    const out = String(res.stdout || "").trim();
    return res.ok && /^\d+\.\d+$/.test(out) ? out : "";
  } catch {
    return "";
  }
}

/**
 * Remove ONE distribution from an engine-site directory: the files pip
 * recorded for it, then the directories they leave empty, then the
 * dist-info. Returns how many paths were actually removed, so a prune
 * that found nothing can be logged as the warning it is instead of the
 * success the old code always claimed.
 */
function pruneEngineSiteDistribution(siteDir, name, version) {
  const candidates = [];
  let recordText = "";
  let distInfoDirName = "";
  for (const spelling of new Set([name, String(name).replace(/-/g, "_")])) {
    const dir = `${spelling}-${version}.dist-info`;
    const recordPath = path.join(siteDir, dir, "RECORD");
    try {
      if (fs.existsSync(recordPath)) {
        recordText = fs.readFileSync(recordPath, "utf8");
        distInfoDirName = dir;
        break;
      }
    } catch { /* fall through to the conventional layout */ }
  }
  if (recordText) {
    const { paths, unsafe } = engineDeps.planDistributionRemoval(recordText, distInfoDirName);
    if (unsafe.length > 0) {
      appendMainLog(`[engine-policy] refused ${unsafe.length} out-of-tree path(s) in ${distInfoDirName}/RECORD`);
    }
    candidates.push(...paths);
  } else {
    appendMainLog(`[engine-policy] ${name} has no readable RECORD; falling back to the conventional layout`);
    candidates.push(...engineDeps.guessDistributionPaths(name, version));
  }

  let removed = 0;
  const touchedDirs = new Set();
  for (const rel of candidates) {
    const victim = path.join(siteDir, rel);
    // Belt to the planner's braces: never step outside the site dir.
    const relFromSite = path.relative(siteDir, victim);
    if (relFromSite.startsWith("..") || path.isAbsolute(relFromSite)) continue;
    try {
      if (!fs.existsSync(victim)) continue;
      fs.rmSync(victim, { recursive: true, force: true });
      removed += 1;
      const parent = path.dirname(victim);
      if (parent !== siteDir) touchedDirs.add(parent);
    } catch (e) {
      appendMainLog(`[engine-policy] could not remove ${rel}: ${e?.message || e}`);
    }
  }
  // Directories the files left behind, deepest first.
  for (const dir of [...touchedDirs].sort((a, b) => b.length - a.length)) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* a non-empty directory is not ours to remove */ }
  }
  return removed;
}

/**
 * Overlap policy enforcement (BUG-46): prune every engine-site copy of a
 * package the release-pinned bundle also ships, UNLESS the bundle copy
 * fails a requirement some engine distribution declares — then report a
 * CONFLICT instead of silently winning or losing the import-resolution
 * race. `mode` distinguishes hard failure (fresh install) from boot-time
 * reconciliation of a pre-existing dirty engine-site (log-only).
 */
async function reconcileEngineSiteWithBundle(siteDir, python, repoRoot, mode) {
  const bundleSite = await resolveSitePackagesDir(python, repoRoot);
  if (!bundleSite || !fs.existsSync(siteDir)) return { ok: true, conflicts: [] };
  const staged = readDistInfoInventory(siteDir);
  const bundle = readDistInfoInventory(bundleSite);
  // Markers are evaluated against the interpreter that will actually run
  // the engine, not against this Electron process.
  const markerEnv = engineDeps.defaultMarkerEnvironment({
    python_version: await resolvePythonVersion(python, repoRoot),
  });
  const needs = engineDeps.collectRequirementIndex(siteDir, fs, markerEnv);
  const { prune, conflicts } = engineDeps.planEngineSitePrune({ staged, bundle, needs });
  for (const name of prune) {
    const removed = pruneEngineSiteDistribution(siteDir, name, staged[name]);
    appendMainLog(removed > 0
      ? `[engine-policy] pruned duplicate ${name} (${staged[name]}) — removed ${removed} path(s); bundle ${bundle[name]} satisfies all declared needs`
      : `[engine-policy] WARN: ${name} (${staged[name]}) was planned for prune but nothing was removed from ${siteDir} — it may still shadow the bundle`);
  }
  if (conflicts.length > 0) {
    const report = conflicts.map((c) => `${c.name}: need ${c.required}, bundle has ${c.have}`).join("; ");
    appendMainLog(`[engine-policy] OVERLAP CONFLICTS (${mode}): ${report}`);
    return { ok: mode === "reconcile", conflicts };
  }
  return { ok: true, conflicts: [] };
}


// BUG-39: pip's failure mode on an offline / captive-portal machine is
// minutes of TCP retries per package URL. A bounded connect probe to the
// two hosts the engine install actually needs (PyPI for wheels,
// github.com for the pinned GigaAM checkout) decides in ~seconds whether
// the attempt can even start — without it every offline launch paid the
// full pip retry cycle BEFORE uvicorn spawned, wedging first-run behind
// "Installing GigaAM engine…" with no cancel.
function probeTcpReachable(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (ok) => {
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * HTTPS reachability probe (BUG-80): a captive portal ACCEPTS TCP but
 * intercepts HTTP and breaks TLS (its own cert), so a TCP-only gate
 * waved the install straight into a minute of pip SSL failures. A
 * certificate-validated HTTPS request is the smallest probe a portal
 * cannot fake.
 */
function probeHttpsReachable(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const { net } = require("electron");
      const request = net.request({ method: "HEAD", url });
      const timer = setTimeout(() => {
        try { request.abort(); } catch { }
        resolve(false);
      }, timeoutMs);
      request.on("response", (response) => {
        clearTimeout(timer);
        // Any real TLS-validated HTTP response — even 403 from a
        // blocked path — proves the pipe is not portal-intercepted.
        resolve(response.statusCode >= 200);
      });
      request.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      request.end();
    } catch {
      resolve(false);
    }
  });
}

async function isEngineInstallNetworkAvailable() {
  // Sequential by design: an offline machine fails the first probe fast
  // and never touches the second; an online machine pays one extra RTT.
  for (const { host, port } of engineDeps.ENGINE_NETWORK_HOSTS) {
    if (!(await probeTcpReachable(host, port))) return false;
  }
  // TCP says a pipe exists; TLS says it is the real internet and not a
  // captive portal that would fail pip mid-download (BUG-80).
  return probeHttpsReachable("https://pypi.org/simple/", 4000);
}

// ── Engine install lifecycle (user-initiated, single-flight) ─────────
//
// State is the SSOT for every surface: IPC "engine:get-status" returns
// this snapshot verbatim, and every phase transition is logged. The
// renderer never learns about pip internals — only phases and a reason.
//
// There is no push channel. An "engine:status" broadcast used to be sent
// to every BrowserWindow — including the sandboxed status capsule — on
// four transitions, but preload never exposed it and the renderer polls
// on purpose ("pull beats push here: no subscription lifecycle to leak
// across window reloads", frontend/src/main.tsx syncEngineInstallState).
// A channel with a sender and no receiver is not a contract; it is work
// and a name that suggests a surface which does not exist.
const engineInstall = {
  phase: engineDeps.ENGINE_INSTALL_PHASES.IDLE,
  reason: "",
  error: "",
  startedAtMs: 0,
  inFlight: null,
};

function setEnginePhase(phase, fields = {}) {
  engineInstall.phase = phase;
  engineInstall.reason = String(fields.reason ?? "");
  engineInstall.error = String(fields.error ?? "");
  if (phase === engineDeps.ENGINE_INSTALL_PHASES.INSTALLING) {
    engineInstall.startedAtMs = Date.now();
  }
}

function engineInstallSnapshot() {
  return {
    phase: engineInstall.phase,
    reason: engineInstall.reason,
    error: engineInstall.error,
    startedAtMs: engineInstall.startedAtMs,
  };
}

async function probeGigaamImportable(python, repoRoot) {
  // 60 s (BUG-79): the first `import gigaam` in a runtime pays the full
  // torch + CUDA-libs load; on cold caches with AV scanning (Windows)
  // that legitimately exceeds 20 s, and a false negative here made the
  // "already installed" gate fail — offering a pointless multi-GB
  // reinstall of a working engine.
  const probe = await runCommand(python, ["-c", "import gigaam"], {
    cwd: repoRoot, timeoutMs: 60000, env: buildPythonEnv(python),
  });
  return probe.ok;
}

/**
 * Install the GigaAM engine stack on explicit user request.
 *
 * Gates run in cheapest-first order (marker → already-installed →
 * network → disk). The pip run targets a staging dir which is then
 * policy-pruned against the bundle (BUG-46 invariant) and swapped in
 * atomically (BUG-36); on success the backend is hard-restarted so the
 * CURRENT session picks the engine up via PYTHONPATH without an app
 * relaunch — the existing crash-restart machinery owns the respawn.
 */
async function installGigaamEngine(python, repoRoot) {
  if (engineInstall.inFlight) {
    return { ok: false, status: "already-running", ...engineInstallSnapshot() };
  }
  const marker = path.join(repoRoot, "ENABLE_GIGAAM");
  if (!fs.existsSync(marker)) {
    return { ok: false, status: "disabled", reason: "engine feature not enabled in this build" };
  }
  const req = path.join(repoRoot, "requirements-gigaam.txt");
  if (!fs.existsSync(req)) {
    return { ok: false, status: "disabled", reason: "requirements-gigaam.txt missing" };
  }

  setEnginePhase(engineDeps.ENGINE_INSTALL_PHASES.PROBING);

  if (await probeGigaamImportable(python, repoRoot)
    && fs.existsSync(path.join(getEngineSiteDir(), ENGINE_INSTALL_MARKER))) {
    setEnginePhase(engineDeps.ENGINE_INSTALL_PHASES.DONE, { reason: "already installed" });
      return { ok: true, status: "already-installed", ...engineInstallSnapshot() };
  }

  engineInstall.inFlight = (async () => {
    setEnginePhase(engineDeps.ENGINE_INSTALL_PHASES.INSTALLING);
      appendMainLog("[engine-install] started (user request)");

    try {
      // Network gate first: ~2.5 s worst case offline, versus minutes of
      // pip retries for a result we can predict (see BUG-39).
      if (!(await isEngineInstallNetworkAvailable())) {
        throw Object.assign(new Error("offline"), { userReason: "no network access" });
      }
      // Disk gate (BUG-33): constants are the SSOT values from engine-deps.
      try {
        const st = fs.statfsSync(path.dirname(getEngineSiteDir()));
        const freeBytes = BigInt(st.bavail) * BigInt(st.bsize);
        if (freeBytes < BigInt(engineDeps.ENGINE_MIN_FREE_BYTES)) {
          const gb = Math.floor(Number(freeBytes / (1024 * 1024 * 1024)));
          // ONE formatting of the requirement. The message the user sees
          // used to carry a hardcoded "8 GB" while the log line derived
          // its number from the constant, so changing the constant would
          // have changed the log and left the user reading the old figure.
          const neededGb = engineDeps.ENGINE_MIN_FREE_BYTES / (1024 ** 3);
          throw Object.assign(
            new Error(`only ${gb} GB free, need ${neededGb} GB`),
            { userReason: `insufficient disk space (${gb} GB free, ${neededGb} GB needed)` },
          );
        }
      } catch (e) {
        if (e.userReason) throw e;
        appendMainLog(`[engine-install] free-space check failed (${e?.message || e}); proceeding`);
      }

      // Staging + swap (BUG-36): --target upgrades never remove replaced
      // files; a fresh staging dir swapped in with two renames is the
      // canonical pip pattern.
      const engineSite = getEngineSiteDir();
      const staging = `${engineSite}.staging`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      let res;
      try {
        res = await runCommand(python, ["-m", "pip", "install", "--target", staging, "-r", req], {
          cwd: repoRoot, timeoutMs: 1800000, env: buildPythonEnv(python),
        });
      } catch (e) {
        res = { ok: false, stderr: e?.message || String(e), stdout: "" };
      }
      if (!res || !res.ok) {
        // BUG-32 class: real diagnostics come from stderr, not a phantom field.
        throw new Error(`pip failed: ${(res?.stderr || res?.stdout || "").slice(0, 400)}`);
      }

      // BUG-46 invariant: engine-site may only ADD names. Overlap with
      // the release-pinned bundle is pruned when provably safe and ABORTS
      // the install when not.
      const reconcile = await reconcileEngineSiteWithBundle(staging, python, repoRoot, "install");
      if (!reconcile.ok) {
        throw new Error(
          "dependency overlap cannot be resolved safely: "
          + reconcile.conflicts.map((c) => `${c.name} needs ${c.required}, bundle ships ${c.have}`).join("; "),
        );
      }

      // Completion marker (BUG-76): written INTO staging so a tree is
      // only ever considered "installed" once it is fully assembled and
      // reconciled. A half-installed site (crash mid-pip) whose `gigaam`
      // happens to import would otherwise pass the probe and defer its
      // breakage to model-load time with no installer re-trigger.
      fs.writeFileSync(path.join(staging, ENGINE_INSTALL_MARKER), new Date().toISOString());

      const retired = `${engineSite}.old-${Date.now()}`;
      if (fs.existsSync(engineSite)) fs.renameSync(engineSite, retired);
      fs.renameSync(staging, engineSite);
      // Retired-tree cleanup is best-effort (BUG-60): on Windows AV and
      // indexers routinely hold handles on a just-renamed ~7 GB tree, and
      // an rmSync failure here must NOT report the install as FAILED —
      // the new engine is already live. Orphans are swept at next boot.
      try {
        fs.rmSync(retired, { recursive: true, force: true });
      } catch (cleanupErr) {
        appendMainLog(`[engine-install] retired-tree cleanup deferred to next boot: ${cleanupErr?.message || cleanupErr}`);
      }

      setEnginePhase(engineDeps.ENGINE_INSTALL_PHASES.DONE);
      appendMainLog("[engine-install] ok (engine-site swapped)");

      // Activate NOW: killing the backend makes the exit handler respawn
      // it with the refreshed PYTHONPATH — no app relaunch needed.
      if (backend && !isQuitting) {
        appendMainLog("[engine-install] restarting backend to activate engine");
        killBackendHard("gigaam-engine-installed");
      }
    } catch (e) {
      setEnginePhase(engineDeps.ENGINE_INSTALL_PHASES.FAILED, {
        reason: e.userReason || "",
        error: e?.message || String(e),
      });
      appendMainLog(`[engine-install] FAILED: ${e.userReason ? `${e.userReason} — ` : ""}${e?.message || e}`);
      try { fs.rmSync(`${getEngineSiteDir()}.staging`, { recursive: true, force: true }); } catch { /* best effort */ }
    } finally {
      engineInstall.inFlight = null;
        }
  })();

  return engineInstall.inFlight.then(() => ({ ok: engineInstall.phase === engineDeps.ENGINE_INSTALL_PHASES.DONE, ...engineInstallSnapshot() }));
}

/**
 * Boot-time reconciliation ONLY: heal a pre-existing dirty engine-site
 * (installed before the BUG-46 policy existed) by pruning provably-safe
 * overlaps. Never installs, never aborts boot; conflicts are logged for
 * release engineering instead of silently shadowing pinned versions.
 */
async function reconcileEngineSiteAtBoot(python, repoRoot) {
  const marker = path.join(repoRoot, "ENABLE_GIGAAM");
  if (!fs.existsSync(marker)) return;
  const engineSite = getEngineSiteDir();
  if (!fs.existsSync(path.join(engineSite, "gigaam"))) return;
  await reconcileEngineSiteWithBundle(engineSite, python, repoRoot, "reconcile");
}

/**
 * Boot-time engine-site hygiene (BUG-60/BUG-76). At boot no install is
 * in flight, so every leftover is attributable to a previous run:
 *
 *  - a complete staging tree (marker present) is PROMOTED when the live
 *    site is missing/incomplete — the app died between the two renames
 *    of the atomic swap, and the ~6 GB download is still good;
 *  - `engine-site.old-*` trees (retired by a swap, cleanup deferred) are
 *    removed — each one is ~6-7 GB and the BUG-33 disk gate would
 *    otherwise block the next install once they accumulate;
 *  - an incomplete staging tree (no marker) is removed — pip died
 *    mid-install and it can never be trusted.
 */
function sweepEngineSiteLeftoversAtBoot() {
  const engineSite = getEngineSiteDir();
  const parent = path.dirname(engineSite);
  const base = path.basename(engineSite);
  let entries;
  try {
    entries = fs.readdirSync(parent);
  } catch { /* userData not readable — nothing to sweep */ return; }

  const siteIncomplete = !fs.existsSync(path.join(engineSite, "gigaam"));
  for (const name of entries) {
    const full = path.join(parent, name);
    if (name.startsWith(`${base}.old-`)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        appendMainLog(`[engine-install] swept retired tree ${name}`);
      } catch { /* retried next boot */ }
      continue;
    }
    if (name === `${base}.staging`) {
      const stagingComplete = fs.existsSync(path.join(full, ENGINE_INSTALL_MARKER))
        && fs.existsSync(path.join(full, "gigaam"));
      try {
        if (siteIncomplete && stagingComplete) {
          fs.renameSync(full, engineSite);
          appendMainLog("[engine-install] promoted completed staging tree (crash between renames)");
        } else {
          fs.rmSync(full, { recursive: true, force: true });
          if (!stagingComplete) {
            appendMainLog("[engine-install] removed incomplete staging tree");
          }
        }
      } catch { /* retried next boot */ }
    }
  }
}

async function ensureBackendRuntime(python, repoRoot) {
  const importCheck = await runCommand(
    python,
    ["-c", BACKEND_RUNTIME_IMPORT_CHECK],
    { cwd: repoRoot, timeoutMs: 12000, env: buildPythonEnv(python) }
  );

  if (importCheck.ok) {
    // Engine installs are USER-initiated (Settings → Local models), never
    // boot-initiated: a boot-time pip run wedged first-use for minutes and
    // could not be declined. Boot only reconciles an existing engine-site
    // against the pinned bundle (BUG-46 heal, log-only).
    await reconcileEngineSiteAtBoot(python, repoRoot);
    return { ok: true };
  }

  // If the selected Python IS the bundled runtime, deps are pre-installed
  // into its site-packages at release build time. An import failure here
  // means the bundle is corrupted (AV quarantined a .pyd / .so, user
  // deleted a file, disk error). `pip install --user` would write to a
  // dir OUTSIDE the app bundle (~/Library/Python/<x.y>/ or
  // %APPDATA%\Python\Python<xy>\), persist across uninstalls, and shadow
  // the pinned versions on every future launch — a worse state than
  // the failure itself. Surface the error with the stderr so the user
  // can report it.
  const bundled = getBundledPythonPath();
  if (bundled && path.resolve(python) === path.resolve(bundled)) {
    // Attribution (BUG-82): buildPythonEnv prepends engine-site to
    // PYTHONPATH, so a broken engine site can fail imports that the
    // pinned bundle would pass — the old message blamed the bundle and
    // sent users hunting for antivirus ghosts with no way out. Re-run
    // the IDENTICAL check in a clean environment: pass → the engine
    // site is the culprit (point at its reinstall path); fail → the
    // bundle really is damaged (keep the AV diagnosis).
    const cleanEnv = { ...process.env };
    for (const key of PYTHON_ENV_SCRUB_KEYS) delete cleanEnv[key];
    delete cleanEnv.PYTHONPATH;
    const attribution = await runCommand(
      python,
      ["-c", BACKEND_RUNTIME_IMPORT_CHECK],
      { cwd: repoRoot, timeoutMs: 12000, env: cleanEnv }
    );
    if (attribution.ok) {
      appendMainLog("[backend-runtime] import check passes WITHOUT engine-site — engine-site is shadowing the bundle");
      return {
        ok: false,
        details: [
          "The optional engine install (userData/engine-site) is breaking the bundled runtime's imports.",
          "Fix: Settings → Local models → reinstall the engine, or delete the engine-site folder.",
          `python: ${python}`,
          (importCheck.stderr || importCheck.stdout || "").trim(),
        ].filter(Boolean).join("\n"),
      };
    }
    return {
      ok: false,
      details: [
        "Bundled Python runtime is missing one or more pre-installed dependencies.",
        "This usually means an antivirus quarantined a file inside the app bundle.",
        `python: ${python}`,
        (importCheck.stderr || importCheck.stdout || "").trim(),
      ].filter(Boolean).join("\n"),
    };
  }

  const requirementsPath = path.join(repoRoot, "requirements.txt");
  if (!fs.existsSync(requirementsPath)) {
    return { ok: false, details: "requirements.txt not found in app resources" };
  }

  setBackendBootStatus("Installing dependencies (first launch)…");

  // If Python is inside the app venv, install directly (no --user needed).
  // Compare normalized absolute paths with a separator-boundary check
  // so we can't (a) match a sibling directory by raw prefix
  // ("/…/.venvold" matching "/…/.venv"), or (b) miss due to mixed
  // separators after Python normalizes its own `sys.executable`.
  // On case-insensitive filesystems (macOS APFS default, Windows NTFS)
  // also compare case-insensitively so a user dir recorded in
  // different case by the OS doesn't produce a false negative that
  // scatters pip packages outside the app sandbox.
  const venvDirNormalized = path.resolve(getAppVenvDir());
  const pythonResolved = path.resolve(python);
  const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";
  const pathEq = (a, b) => caseInsensitiveFs
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
  const pathStartsWith = (a, prefix) => caseInsensitiveFs
    ? a.toLowerCase().startsWith(prefix.toLowerCase())
    : a.startsWith(prefix);
  const isAppVenv =
    pathEq(pythonResolved, venvDirNormalized) ||
    pathStartsWith(pythonResolved, venvDirNormalized + path.sep);
  // The SAME constraints the shipped runtime was built with
  // (desktop/scripts/prepare-runtime.sh applies this file too).
  // requirements.txt keeps ranges for five direct dependencies on purpose and
  // the exact versions live in the lock; without it this repair install can
  // put a numpy or an onnxruntime into the user's environment that the pinned
  // faster-whisper / ctranslate2 pair was never tested against — a runtime
  // regression on the user's machine, produced by a repair. The lock ships in
  // extraResources, so it sits next to requirements.txt in a packaged app
  // exactly as it does in a checkout.
  const lockPath = path.join(repoRoot, "requirements.runtime-lock.txt");
  const constraintArgs = fs.existsSync(lockPath) ? ["-c", lockPath] : [];
  if (constraintArgs.length === 0) {
    appendMainLog(`[backend-runtime] WARN: ${lockPath} is missing — installing without the release constraints`);
  }
  const pipArgs = ["-m", "pip", "install"];
  if (!isAppVenv) pipArgs.push("--user");
  pipArgs.push(...constraintArgs, "-r", requirementsPath);

  // Same scrubbed interpreter env as every other runCommand(python, ...)
  // call in this file. Without it a stray PYTHONPATH / PYTHONHOME /
  // VIRTUAL_ENV inherited from the launching shell steers pip at a
  // different site-packages than the import check that follows, so a
  // "successful" install can be followed by a failing recheck.
  const install = await runCommand(python, pipArgs, {
    cwd: repoRoot, timeoutMs: 300000, env: buildPythonEnv(python)
  });

  // The optional engine is NOT installed here: installs are user-initiated
  // from Settings (installGigaamEngine). Boot never blocks on pip.

  if (!install.ok && !isAppVenv) {
    // Retry with --break-system-packages for macOS 14+ managed Python
    appendMainLog("[backend-runtime] retrying pip with --break-system-packages");
    const retry = await runCommand(
      python,
      // Same constraints as the first attempt: a retry must not install a
      // different set of versions than the one that just failed for an
      // unrelated reason.
      ["-m", "pip", "install", "--user", "--break-system-packages", ...constraintArgs, "-r", requirementsPath],
      { cwd: repoRoot, timeoutMs: 300000, env: buildPythonEnv(python) }
    );
    if (!retry.ok) {
      return {
        ok: false,
        details: [
          "Python dependencies are missing and auto-install failed.",
          `python: ${python}`,
          (retry.stderr || retry.stdout || "").trim()
        ].join("\n")
      };
    }
  } else if (!install.ok) {
    return {
      ok: false,
      details: [
        "Python dependencies are missing and auto-install failed.",
        `python: ${python}`,
        (install.stderr || install.stdout || "").trim()
      ].join("\n")
    };
  }

  setBackendBootStatus("Verifying dependencies…");

  const recheck = await runCommand(
    python,
    ["-c", BACKEND_RUNTIME_IMPORT_CHECK],
    { cwd: repoRoot, timeoutMs: 12000, env: buildPythonEnv(python) }
  );

  if (!recheck.ok) {
    return {
      ok: false,
      details: [
        "Python dependencies were installed but still cannot be imported.",
        `python: ${python}`,
        (recheck.stderr || recheck.stdout || "").trim()
      ].join("\n")
    };
  }

  return { ok: true };
}

async function startBackend() {
  // ORDER MATTERS: check inflight FIRST. Otherwise a concurrent
  // caller arriving during the spawn-then-instant-crash window can
  // see `backend` momentarily set, take the early-return, and
  // proceed to loadURL against a backend that's about to die.
  // Returning the inflight promise keeps every concurrent caller
  // synchronised on the same outcome.
  if (backendStartInFlight) return backendStartInFlight;
  if (backend) return;

  // Absorb any queued crash-restart BEFORE we set inflight, so a
  // concurrent caller that arrives while the timer is firing can't
  // race us into double-spawn. The timer clear must happen on the
  // SAME synchronous branch as the inflight check above.
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }

  backendStartInFlight = (async () => {
  const repoRoot = getRepoRoot();
  setBackendBootStatus("Locating Python…");
  const python = await resolvePython(repoRoot);

  if (!python) {
    backendBootError = "Python 3 interpreter was not found. Please install Python 3 from python.org.";
    setBackendBootStatus("");
    broadcastBackendBootError();
    throw new Error(backendBootError);
  }

  const runtime = await ensureBackendRuntime(python, repoRoot);
  if (!runtime.ok) {
    backendBootError = runtime.details || "Backend runtime is unavailable.";
    setBackendBootStatus("");
    broadcastBackendBootError();
    throw new Error(backendBootError);
  }

  setBackendBootStatus("Starting backend…");

  // Validate TRANSCRIPTOR_PORT: must be a user-space TCP port
  // (1024-65535). A bogus value (0, negative, non-integer, >65535)
  // silently fell through pickBackendPort's iteration and produced an
  // OS-assigned random port — deviation from the user's configured
  // port with no log trace.
  let preferredPort = Number(process.env.TRANSCRIPTOR_PORT);
  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
    if (process.env.TRANSCRIPTOR_PORT) {
      appendMainLog(`[backend-start] invalid TRANSCRIPTOR_PORT=${process.env.TRANSCRIPTOR_PORT}; using default ${DEFAULT_BACKEND_PORT}`);
    }
    preferredPort = DEFAULT_BACKEND_PORT;
  }
  PORT = await pickBackendPort(HOST, preferredPort);
  BASE_URL = `http://${HOST}:${PORT}`;
  BACKEND_BOOT_NONCE = crypto.randomBytes(32).toString("hex");
  appendMainLog(`[backend-start] python="${python}" host=${HOST} port=${PORT} repo="${repoRoot}"`);

  // --app-dir tells uvicorn where to find the "backend.main" module
  // WITHOUT polluting PYTHONPATH globally. The previous PYTHONPATH=
  // repoRoot approach made the bundled standalone Python willing to
  // import any top-level name from resources/ (including `runtime`
  // and `frontend`) which invites silent import shadowing on any
  // refactor.
  const args = [
    "-B",
    "-m", "uvicorn",
    "backend.main:app",
    "--app-dir", repoRoot,
    "--host", HOST,
    "--port", String(PORT),
    "--log-level", "info"
  ];

  // stdin is a ``pipe`` (not ``ignore``) so the backend's parent-death
  // watchdog can detect EOF when this Electron process dies. Without
  // this, a SIGKILL / crash of Electron leaves the Python backend
  // running as an orphan: still bound to the TCP port, still holding
  // whisper models in RAM, visible only via ``ps``. With the pipe open,
  // the kernel closes our write-end when we exit (for ANY reason,
  // including SIGKILL), the backend's watchdog thread sees EOF on its
  // stdin, and calls ``os._exit(0)`` — guaranteed cleanup.
  //
  // We explicitly NEVER write to backend.stdin; the pipe's sole purpose
  // is liveness signalling via close-on-exit.
  // Prepend the bundled ffmpeg directory to PATH so backend/audio.py
  // finds `ffmpeg` for format conversion even on a user system that
  // has no ffmpeg installed. On dev / non-release runs the bundled
  // path doesn't exist and we fall through to the existing PATH.
  const ffmpegDir = getBundledFfmpegDir();
  const envPath = ffmpegDir
    ? `${ffmpegDir}${path.delimiter}${process.env.PATH || ""}`
    : (process.env.PATH || "");
  const pythonCacheDir = path.join(app.getPath("userData"), "python-cache");
  try {
    fs.mkdirSync(pythonCacheDir, { recursive: true });
  } catch (e) {
    appendMainLog(`[backend-start] python cache dir unavailable: ${e?.message || e}`);
  }
  // Child env. `--app-dir repoRoot` (above, in args) already inserts
  // repoRoot into sys.path for uvicorn's module resolution, so
  // exporting PYTHONPATH=repoRoot would double-inject the same dir
  // AND expose every sibling top-level dir (runtime/, frontend/) as
  // importable. buildPythonEnv scrubs Python-specific parent env when
  // using the bundled runtime so packaged launches stay hermetic.
  const childEnv = buildPythonEnv(python, {
    PATH: envPath,
    PYTHONUNBUFFERED: "1",
    // CRITICAL on macOS: prevent Python from writing .pyc bytecode
    // cache files into the signed .app bundle at runtime. Python
    // eagerly caches compiled bytecode next to .py source files on
    // every import; those writes invalidate the bundle's Resources
    // envelope (codesign --verify --deep reports them as "file
    // added") and amfi on every subsequent backend spawn re-checks
    // the envelope — eventually breaking launch after enough
    // imports accumulated. Setting this env var makes Python run
    // entirely from source; PYTHONPYCACHEPREFIX is an additional
    // hard guard for any Python subprocess/import path that ignores
    // -B or PYTHONDONTWRITEBYTECODE. Any bytecode cache that still
    // gets written lands in userData/python-cache, never in the
    // signed Resources envelope.
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: pythonCacheDir,
    TRANSCRIPTOR_DATA_DIR: process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData"),
    TRANSCRIPTOR_BOOT_NONCE: BACKEND_BOOT_NONCE,
    TRANSCRIPTOR_PARENT_WATCHDOG: "1",
  });
  backend = spawn(python, args, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  // Ignore any stdin errors — the pipe is only used for EOF-on-parent-
  // exit detection. If the write end gets EPIPE for some reason (backend
  // crashed, fd was closed), Node would otherwise emit an unhandled
  // 'error' event and crash the main process.
  if (backend.stdin) {
    backend.stdin.on("error", () => { /* intentional no-op */ });
  }

  backend.stdout.on("data", (d) => {
    const msg = d.toString();
    appendMainLog(`[backend-stdout] ${compactLogText(msg, 1400)}`);
  });
  backend.stderr.on("data", (d) => {
    const msg = d.toString();
    appendMainLog(`[backend-stderr] ${compactLogText(msg, 1400)}`);
    // Keep the last ~4 KB of stderr so the fallback error page can
    // show the actual failure reason instead of a generic "did not
    // start in time" message.
    backendStderrTail = (backendStderrTail + msg).slice(-BACKEND_STDERR_TAIL_MAX);
  });

  backend.on("exit", (code, signal) => {
    appendMainLog(`[backend-exit] code=${code} signal=${signal || ""}`);
    backend = null;
    // Restart on either:
    //   (a) non-zero exit (Python crash, sys.exit(1), broken venv, ...)
    //   (b) signal exit (segfault, oom-kill, manual SIGKILL outside our
    //       quit path) — code is null in that case so the old check
    //       ``Number(code || 0) !== 0`` was 0 !== 0 → false → silently
    //       skipped restart. A backend killed by SIGSEGV would not
    //       come back without a manual app relaunch.
    const abnormalExit = Number(code || 0) !== 0 || (signal != null && signal !== "");
    if (!isQuitting && abnormalExit) {
      if (backendRestartTimer) {
        clearTimeout(backendRestartTimer);
        backendRestartTimer = null;
      }
      const attempt = backendRestartAttempts + 1;
      backendRestartAttempts = attempt;
      // Hard cap: after 8 attempts, stop scheduling. A deterministically
      // broken backend (corrupt config, missing dep, port conflict we
      // can't escape) would otherwise restart every 5s forever, growing
      // the log file unboundedly and masking the real failure. The user
      // sees a permanent backend error in the renderer instead.
      if (attempt > 8) {
        backendBootError = `Backend exited with code ${code} after ${attempt - 1} restart attempts — giving up.`;
        setBackendBootStatus("");
        appendMainLog(`[backend-restart-giving-up] ${backendBootError}`);
        broadcastBackendBootError();
        return;
      }
      const delay = Math.min(800 * attempt, 5000);
      appendMainLog(`[backend-restart-scheduled] attempt=${attempt} delayMs=${delay}`);
      backendRestartTimer = setTimeout(() => {
        // 1.1.25 fix: previously nulled ``backendRestartTimer`` BEFORE
        // calling startBackend(). A concurrent caller (window-create,
        // tray click) entering startBackend between the null and the
        // inflight assignment passed the ``if (backendRestartTimer)
        // clearTimeout(...)`` guard on a now-null timer, then proceeded
        // independently — both spawned ``python -m uvicorn`` and the
        // loser hit "Address already in use", triggering yet another
        // restart cycle and leaking PIDs.
        //
        // New ordering: keep backendRestartTimer set until startBackend
        // takes the inflight lock; null it from .finally so a concurrent
        // clearTimeout above is a no-op only AFTER the inflight promise
        // is in place.
        startBackend()
          .then(async () => {
            appendMainLog("[backend-restart] attempted");
            // Confirm the restart produced a HEALTHY backend, and clear
            // the counter when it did. Without this the cap above is a
            // per-session budget rather than a per-incident one: the
            // only other resets are a clean exit (which, per the comment
            // on it, never fires outside shutdown) and createWindow's
            // health wait, which does not re-run on this path. Eight
            // unrelated, fully recovered crashes in one session and the
            // ninth gave up permanently — and installGigaamEngine spends
            // one of them deliberately, by design, on every engine
            // install.
            try {
              await waitForBackendHealth(`${BASE_URL}/api/health`, BACKEND_RESTART_HEALTH_TIMEOUT_MS);
              noteBackendHealthy("backend-restart");
            } catch (e) {
              appendMainLog(`[backend-restart] not healthy after restart: ${e?.message || e}`);
            }
          })
          .catch((e) => appendMainLog(`[backend-restart-error] ${e?.message || e}`))
          .finally(() => { backendRestartTimer = null; });
      }, delay);
    } else if (Number(code || 0) === 0) {
      backendRestartAttempts = 0;
    }
  });

  backend.on("error", (err) => {
    backendBootError = err.message;
    appendMainLog(`[backend-error] ${err.message}`);
    // A spawn error (missing python binary, EACCES, EMFILE) leaves the
    // ChildProcess object dead but still truthy, so startBackend's
    // "already running" guard would silently refuse every restart until
    // the app relaunches (BUG-62). Drop the dead handle so the normal
    // retry/backoff path can bring the backend back.
    backend = null;
  });
  })();

  try {
    await backendStartInFlight;
  } finally {
    backendStartInFlight = null;
  }
}

function waitForBackendHealth(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleOk = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const settleErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const scheduleRetry = () => {
      if (settled) return;
      setTimeout(tick, 250);
    };
    const tick = () => {
      if (settled) return;
      if (Date.now() - started > timeoutMs) {
        settleErr(new Error("Backend did not start in time"));
        return;
      }
      const req = http.get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16 * 1024) {
            try { req.destroy(new Error("health response too large")); } catch { }
          }
        });
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
            const payload = JSON.parse(body || "{}");
            if (payload?.boot_nonce !== BACKEND_BOOT_NONCE) {
              throw new Error("backend boot nonce mismatch");
            }
            settleOk();
          } catch {
            scheduleRetry();
          }
        });
      });
      // Per-request timeout so a hanging connection (backend mid-boot,
      // accept queue full, kernel pause) doesn't sit on a half-open
      // socket for the full outer ``timeoutMs``. Without this, a 60 s
      // outer timeout with 250 ms retry interval can pile up ~240
      // dangling sockets against the loopback backend before the outer
      // reject fires. ``req.destroy()`` cancels the in-flight TCP
      // connection cleanly so the next tick reuses fresh sockets.
      req.setTimeout(2000, () => {
        try { req.destroy(); } catch { }
      });
      req.on("error", scheduleRetry);
    };
    tick();
  });
}

function trackMainWindowInitialLoad(browserWindow, reason = "initial-load") {
  if (!browserWindow || browserWindow.isDestroyed()) {
    mainWindowInitialLoadPromise = null;
    return null;
  }
  const label = String(reason || "initial-load").trim() || "initial-load";
  let timeoutHandle = null;
  let resolvePromise = null;
  const startedAt = Date.now();
  let settled = false;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const settle = (eventName = "settled") => {
    if (settled) return;
    settled = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    try { browserWindow.webContents.off("did-finish-load", onDidFinishLoad); } catch { }
    try { browserWindow.webContents.off("did-fail-load", onDidFailLoad); } catch { }
    try { browserWindow.off("closed", onClosed); } catch { }
    if (mainWindowInitialLoadPromise === promise) {
      mainWindowInitialLoadPromise = null;
    }
    appendMainLog(`[main-window-load] reason=${label} event=${eventName} ms=${Date.now() - startedAt}`);
    resolvePromise?.();
  };
  const onDidFinishLoad = () => settle("did-finish-load");
  const onDidFailLoad = () => settle("did-fail-load");
  const onClosed = () => settle("closed");
  browserWindow.webContents.once("did-finish-load", onDidFinishLoad);
  browserWindow.webContents.once("did-fail-load", onDidFailLoad);
  browserWindow.once("closed", onClosed);
  timeoutHandle = setTimeout(() => settle("timeout"), 15000);
  timeoutHandle.unref?.();
  mainWindowInitialLoadPromise = promise;
  return promise;
}

async function waitForMainWindowInitialLoad(reason = "") {
  const pending = mainWindowInitialLoadPromise;
  if (!pending) return;
  const label = normalizeLifecycleReason(reason);
  const startedAt = Date.now();
  try {
    await pending;
  } catch (e) {
    appendMainLog(`[main-window] pending-load failed reason=${label}: ${e?.message || e}`);
  }
  const waitedMs = Date.now() - startedAt;
  if (waitedMs > 50) {
    appendMainLog(`[main-window] waited-for-load reason=${label} ms=${waitedMs}`);
  }
}

async function createWindow(options = {}) {
  const showWindow = options.showWindow !== false;
  const revealReason = normalizeLifecycleReason(options.revealReason || "create-window-loaded");

  // Idempotency guard: if we already own a live BrowserWindow, reuse
  // it instead of spawning a second one. Creating a second window
  // would leak the first's webContents listeners (render-process-gone,
  // did-fail-load, did-finish-load) because nothing ever destroys the
  // orphaned BrowserWindow. Every caller today already checks
  // ``win && !win.isDestroyed()`` — this is a defense-in-depth guard
  // so a future caller cannot silently trip the leak.
  if (win && !win.isDestroyed()) {
    if (showWindow) {
      await waitForMainWindowInitialLoad("create-window-existing");
      presentMainWindow("create-window-existing");
    }
    return;
  }

  // Window icon for Windows taskbar + Linux panel. On macOS the dock
  // icon comes from the .app bundle's Info.plist (set by electron-builder
  // via mac.icon), so no runtime assignment is needed there. On Windows
  // the BrowserWindow takes an .ico (multi-resolution); the .png is
  // used on Linux.
  const appIconPath = process.platform === "win32"
    ? path.join(__dirname, "icon.ico")
    : path.join(__dirname, "icon.png");
  // Rule 2: the window opens filling the work area unless the user has
  // resized or moved it themselves; `decideMainWindowBounds` is the SSOT
  // for that, and it runs here so the very first frame is already the
  // right size — no create-then-resize flash.
  loadMainWindowState();
  let initialBounds;
  try {
    initialBounds = decideMainWindowBounds({
      workArea: screen.getPrimaryDisplay().workArea,
      savedBounds: mainWindowStoredState.userSized ? mainWindowStoredState.bounds : null,
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT,
    }).bounds;
  } catch (e) {
    appendMainLog(`[main-window] initial bounds unavailable: ${e?.message || e}`);
    initialBounds = { x: undefined, y: undefined, width: 1420, height: 780 };
  }
  mainWindowLastAppliedBounds = Number.isFinite(initialBounds.x) ? { ...initialBounds } : null;
  win = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    backgroundColor: "#1a1a1a",
    title: "Transcriptor",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    icon: process.platform !== "darwin" ? appIconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Sandbox: renderer has no Node.js access even in worst case
      // (a preload script exploit would not break out of sandbox).
      sandbox: true,
      // ROOT CAUSE for Windows-only "transcription is slow / doesn't
      // appear when the app window is not focused":
      //
      // Chromium aggressively throttles background renderers to save
      // CPU on Windows. When this BrowserWindow loses focus (user
      // alt-tabs to a browser to paste into a Meet chat / Slack /
      // editor — the EXACT workflow this app is built for):
      //   * setInterval / setTimeout clamp to 1 Hz
      //   * AudioContext + AudioWorklet get demoted CPU priority,
      //     so the PCM-capture worklet skips frames and the mic
      //     stream goes patchy
      //   * WebSocket frames sit on the Chromium event loop
      //     without being processed for hundreds of ms
      //   * MediaRecorder ondataavailable callbacks stall
      //
      // Result on Windows: "I started recording, switched to my
      // browser to paste, came back — no transcription appeared
      // and the bar at the bottom shows 'no speech detected'".
      // On macOS Chromium throttles less aggressively so the same
      // workflow worked fine. This single flag disables the
      // throttle for our renderer so background recording behaves
      // identically across platforms.
      backgroundThrottling: false,
    }
  });
  trackMainWindowInitialLoad(win, "create-window");

  // Refuse navigation to any origin other than the backend. A
  // transcript containing an <a href="https://evil..."> that's clicked
  // must NOT navigate the renderer to an attacker-controlled origin —
  // hand it off to the OS default browser via shell.openExternal.
  //
  // Use proper URL origin parsing rather than string prefix-match.
  // Prefix-match is vulnerable to suffix injection: BASE_URL =
  // "http://127.0.0.1:8321" prefix-matches "http://127.0.0.1:8321evil.com"
  // because the dot/slash boundary is not enforced. URL.parse strips
  // ambiguity — same protocol + host + port = same origin. We also
  // match the backend's host:port exactly instead of any-port loopback.
  const _isBackendOrigin = (rawUrl) => {
    if (typeof rawUrl !== "string") return false;
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return false; }
    let backend;
    try { backend = new URL(BASE_URL); } catch { return false; }
    return parsed.protocol === backend.protocol
        && parsed.hostname === backend.hostname
        && parsed.port === backend.port;
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (_isBackendOrigin(url)) return { action: "allow" };
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      try { shell.openExternal(url); } catch { }
    }
    return { action: "deny" };
  });
  // Renderer → main IPC over the document-title channel. The renderer
  // (sandbox: true, contextIsolation: true) cannot use ipcRenderer;
  // the canonical workaround used elsewhere in this file
  // is to set ``document.title = "__app_<verb>__<payload>"`` and have
  // the main process intercept the page-title-updated event. We
  // restrict accepted verbs to a closed list and decode the payload
  // back to a known recordings dir + filename, so a malicious
  // transcript cannot smuggle arbitrary paths into shell.showItemInFolder.
  win.webContents.on("page-title-updated", (event, title) => {
    const raw = String(title || "");
    if (!raw.startsWith("__app_")) return;
    event.preventDefault();
    if (raw.startsWith("__app_shortcuts__")) {
      let payload;
      try {
        payload = JSON.parse(decodeURIComponent(raw.slice("__app_shortcuts__".length)));
      } catch (e) {
        appendMainLog(`[shortcuts-bridge] bad payload: ${e?.message || e}`);
        return;
      }
      const action = String(payload?.action || "").trim();
      if (!["capture-start", "capture-cancel", "update"].includes(action)) {
        appendMainLog(`[shortcuts-bridge] rejected action=${compactLogText(action, 40)}`);
        return;
      }
      const message = {
        action,
        record: String(payload?.record || "").trim().slice(0, 96),
        paste: String(payload?.paste || "").trim().slice(0, 96),
      };
      if (shortcutBridgeHandler) {
        shortcutBridgeHandler(message);
      } else {
        pendingShortcutBridgeMessages.push(message);
        pendingShortcutBridgeMessages = pendingShortcutBridgeMessages.slice(-8);
      }
      return;
    }
    if (raw.startsWith("__app_record_toggle__")) {
      // The in-window Record/Stop button. Routed to the very same
      // function the global hotkey calls so there is one recording
      // toggle, not two: same microphone-permission prompt, same
      // frontmost-window capture for auto-paste, same capsule, same
      // single-capsule busy guard, same trace. The renderer deliberately
      // does NOT dispatch its own toggle event for this.
      appendMainLog("[record-toggle] requested from the in-window button");
      toggleRecordingFromShortcut().catch((e) => {
        appendMainLog(`[record-toggle] failed: ${e?.message || e}`);
      });
      return;
    }
    if (raw.startsWith("__app_reveal_recording__")) {
      let payload;
      try {
        payload = JSON.parse(decodeURIComponent(raw.slice("__app_reveal_recording__".length)));
      } catch (e) {
        appendMainLog(`[reveal-recording] bad payload: ${e?.message || e}`);
        return;
      }
      // 1.1.25: path-traversal defense. Previous form stripped only
      // path separators, leaving ``..`` intact. Combined with
      // shell.showItemInFolder, a renderer compromise could enumerate
      // the user's home parent (e.g. /Users) by repeatedly revealing
      // dotted names. Reject any name containing ``..`` OR a path
      // separator outright — recording filenames produced by the
      // backend never need either character.
      const rawName = String(payload?.name || "");
      if (!rawName || rawName.includes("..") || /[\\/]/.test(rawName)) return;
      const safeName = rawName;
      if (!safeName.toLowerCase().endsWith(".txt")) {
        appendMainLog(`[reveal-recording] rejected non-transcript name: ${safeName}`);
        return;
      }
      const archiveDirRaw = String(payload?.archiveDir || "").trim();
      // Resolve the transcript path under the SAME archive dir we wrote to.
      // archiveDir comes back from saveRecordingText which already
      // sanitises it via _resolve_recordings_target_dir on the backend
      // side, but defence-in-depth: only accept absolute paths under
      // the userData root or under TRANSCRIPTOR_DATA_DIR / recordings.
      const pathContains = (root, candidate) => {
        const rel = path.relative(root, candidate);
        return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
      };
      const dataDir = process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData");
      const recordingsRoot = path.resolve(dataDir, "recordings");
      const allowedRecordingRoots = [recordingsRoot];
      try {
        const cfgPath = path.join(dataDir, "config.json");
        if (fs.existsSync(cfgPath)) {
          const rawCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          const configuredRoot = String(rawCfg?.preferences?.recordings_dir || "").trim();
          if (configuredRoot) {
            allowedRecordingRoots.push(
              path.isAbsolute(configuredRoot)
                ? path.resolve(configuredRoot)
                : path.resolve(dataDir, configuredRoot)
            );
          }
        }
      } catch (e) {
        appendMainLog(`[reveal-recording] config allowlist read failed: ${e?.message || e}`);
      }
      const archiveDir = archiveDirRaw && path.isAbsolute(archiveDirRaw)
        ? path.resolve(archiveDirRaw)
        : recordingsRoot;
      // Walk up to make sure the resolved path is still under the
      // user's home — block any symlink-shenanigans that would point
      // at /etc/shadow or similar.
      //
      // Plain ``startsWith(home)`` has the classic prefix-bypass bug:
      // when home = "/Users/foo", any sibling like "/Users/foobar/x"
      // also matches because "/Users/foobar" starts with "/Users/foo".
      // A compromised renderer could pass an archive_dir like
      // "<home>~unrelated/whatever" and reveal arbitrary files via
      // shell.showItemInFolder. Anchor the check on a path-separator
      // boundary (or exact equality) so only descendants of home pass.
      const home = path.resolve(app.getPath("home"));
      const isInsideHome =
        archiveDir === home || archiveDir.startsWith(home + path.sep);
      if (!isInsideHome) {
        appendMainLog(`[reveal-recording] archive_dir outside home: ${archiveDir}`);
        return;
      }
      // Reveal means "show the transcript file". Never substitute the
      // adjacent audio/video recording: the History and Upload panes
      // already have dedicated playback, and selecting the media file
      // made the user think the transcription had been saved under the
      // wrong name.
      const target = path.resolve(archiveDir, safeName);
      const isAllowedRecordingPath = allowedRecordingRoots.some((root) =>
        pathContains(root, archiveDir) && pathContains(root, target)
      );
      if (!isAllowedRecordingPath) {
        appendMainLog(`[reveal-recording] archive_dir outside recording roots: ${archiveDir}`);
        return;
      }
      try {
        shell.showItemInFolder(target);
      } catch (e) {
        appendMainLog(`[reveal-recording] shell.showItemInFolder failed: ${e?.message || e}`);
      }
      return;
    }
  });

  win.webContents.on("will-navigate", (e, url) => {
    if (_isBackendOrigin(url)) return;
    e.preventDefault();
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      try { shell.openExternal(url); } catch { }
    }
  });

  const audioPermissions = new Set(["microphone", "audioCapture"]);
  const clipboardWritePermissions = new Set([
    "clipboard-write",
    "clipboard-sanitized-write",
  ]);
  const permissionLogUrl = (url) => {
    const raw = String(url || "");
    if (!raw) return "";
    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      const mime = raw.slice(5, comma >= 0 ? comma : Math.min(raw.length, 80)).split(";")[0] || "inline";
      return `data:${mime};bytes=${Buffer.byteLength(raw, "utf8")}`;
    }
    return compactLogText(raw, 240);
  };
  // Origin gate: only the backend's own origin is allowed to request
  // media permissions and clipboard-write. Clipboard-read stays
  // denied; copy buttons only need writeText. Without this check, a
  // navigation race or a
  // shared-session future (Electron shares the default session across
  // BrowserWindow instances) could let any other origin
  // inherit our microphone / clipboard grants. Tightened to ``_isBackendOrigin``
  // so the renderer must be on http://127.0.0.1:<our-port> to be
  // allowed.
  const mediaRequestTypes = (details = {}) => {
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes.map(String) : [];
    if (mediaTypes.length > 0) return mediaTypes;
    const mediaType = String(details?.mediaType || "").trim();
    return mediaType ? [mediaType] : [];
  };
  const mediaRequestIsAudioOnly = (details = {}) => {
    const types = mediaRequestTypes(details);
    return types.length > 0 && types.every((type) => type === "audio");
  };
  const permissionDecision = (permission, details = {}, mode = "request") => {
    const perm = String(permission || "");
    const mediaTypes = mediaRequestTypes(details);
    const audioOnlyMedia = perm === "media" && mediaRequestIsAudioOnly(details);
    const genericBackendMediaCheck = mode === "check" && perm === "media" && mediaTypes.length === 0;
    const allowedCapability =
      audioPermissions.has(perm) ||
      audioOnlyMedia ||
      genericBackendMediaCheck ||
      clipboardWritePermissions.has(perm);
    const known =
      allowedCapability ||
      perm === "media" ||
      perm === "videoCapture";
    // Why, not just what.
    //
    // A recording start produces six permission decisions in ~40 ms,
    // and some of them are denials BY DESIGN: Chromium probes video
    // alongside audio, and `selectAudioOutput` asks for a capability
    // this app does not use. Both were logged as a bare
    // `perm=media allow=false`, which reads as "the microphone was
    // refused" — and, worse, is indistinguishable from an actual
    // microphone refusal. The one line a support reader needs to spot
    // was camouflaged by 70 identical lines that meant nothing was
    // wrong.
    let reason;
    if (allowedCapability) {
      reason = "granted";
    } else if (perm === "media" && mediaTypes.includes("video")) {
      reason = "video-capture-not-used-by-this-app";
    } else if (!known) {
      reason = "capability-not-in-allow-list";
    } else {
      reason = "capability-not-granted";
    }
    return { perm, known, allowedCapability, reason, mediaTypes };
  };
  const permissionOriginCandidates = (wc, details = {}, requestingOrigin = "") => {
    const values = [
      details?.securityOrigin,
      details?.requestingOrigin,
      details?.requestingUrl,
      requestingOrigin,
      details?.embeddingOrigin,
      details?.frameOrigin,
      wc?.getURL?.(),
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    return Array.from(new Set(values));
  };
  const permissionFromBackendOrigin = (wc, details = {}, requestingOrigin = "") => {
    const origins = permissionOriginCandidates(wc, details, requestingOrigin);
    return origins.length > 0 && origins.every((origin) => _isBackendOrigin(origin));
  };
  const permissionOriginsLog = (wc, details = {}, requestingOrigin = "") =>
    permissionOriginCandidates(wc, details, requestingOrigin)
      .map(permissionLogUrl)
      .filter(Boolean)
      .join(" | ");
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb, details = {}) => {
    const { perm, known, allowedCapability } = permissionDecision(permission, details, "request");
    const fromBackend = permissionFromBackendOrigin(wc, details);
    const allow = allowedCapability && fromBackend;
    const logUrl = permissionOriginsLog(wc, details);
    if (known && !fromBackend) {
      appendMainLog(`[perm-request] DENY non-backend origin: perm=${perm} origins=${logUrl}`);
    } else {
      appendMainLog(`[perm-request] perm=${perm} allow=${allow} origins=${logUrl}`);
    }
    cb(allow);
  });
  win.webContents.session.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
    const { perm, known, allowedCapability, reason, mediaTypes } =
      permissionDecision(permission, details, "check");
    const fromBackend = permissionFromBackendOrigin(wc, details, requestingOrigin);
    const allow = allowedCapability && fromBackend;
    const logUrl = permissionOriginsLog(wc, details, requestingOrigin);
    const kinds = mediaTypes.length ? ` types=${mediaTypes.join("+")}` : "";
    if (known && !fromBackend) {
      appendMainLog(`[perm-check] DENY non-backend origin: perm=${perm}${kinds} origins=${logUrl}`);
    } else {
      appendMainLog(
        `[perm-check] perm=${perm}${kinds} allow=${allow} reason=${allow ? reason : (fromBackend ? reason : "non-backend-origin")} origins=${logUrl}`,
      );
    }
    return allow;
  });
  // Mirror renderer-side trace logs to main.log only when explicitly
  // enabled. The renderer emits high-volume ``[trace ...]`` lines on
  // live stop/recovery paths; mirroring them synchronously in release
  // builds creates avoidable I/O during the exact latency-sensitive
  // path users are timing. Keep crash/backend/permission logs always
  // on, and enable renderer trace capture with
  // TRANSCRIPTOR_RENDERER_TRACE_LOGS=1 when diagnosing a packaged app.
  //
  // Args: (event, level, message, line, sourceId)
  //   level: 0=verbose, 1=info, 2=warning, 3=error
  // Renderer console → support log. Policy and both Electron call
  // signatures live in ./renderer-console.js (pure, unit-tested); this
  // handler only forwards. See that module for why nothing the renderer
  // logged had ever reached main.log.
  // One limiter per window: a reload gets a fresh budget, and two windows
  // cannot spend each other's.
  const consoleMirrorLimiter = createConsoleMirrorLimiter();
  win.webContents.on("console-message", (a, b) => {
    const line = formatConsoleMirrorLine(a, b, MIRROR_RENDERER_TRACE_LOGS);
    // appendMainLog is synchronous, and the renderer is loudest exactly
    // when the user is waiting for a transcript.
    for (const out of consoleMirrorLimiter(line, Date.now())) appendMainLog(out);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    const reason = String(details?.reason || "unknown");
    const exitCode = details?.exitCode ?? "";
    appendMainLog(`[render-process-gone] reason=${reason} exitCode=${exitCode}`);
    if (shortcutCaptureAbortHandler) {
      shortcutCaptureAbortHandler(`render-process-gone:${reason}`);
    }
    // ``clean-exit`` happens on normal window close and does NOT
    // require recovery. Every other reason (crashed, killed,
    // oom, etc.) leaves the Electron main process holding stale
    // references — the recording state machine, any in-flight
    // ``recordingStopInFlight`` flag, the ``pendingTranscriptionCount``
    // counter, and the ``shortcutToggleInFlight`` guard — that
    // would otherwise block every future hotkey press.
    if (reason === "clean-exit") return;
    // Reset the state machine so the NEXT hotkey press starts
    // cleanly instead of short-circuiting on a stale flag.
    recordingStopInFlight = false;
    shortcutToggleInFlight = false;
    pasteShortcutInFlight = false;
    if (pendingTranscriptionCount > 0) {
      appendMainLog(`[render-process-gone] dropping pendingTranscriptionCount=${pendingTranscriptionCount}`);
      pendingTranscriptionCount = 0;
    }
    // Drain any queued post-stop tasks — their renderer state is
    // dead, polling them would just spin processPostStopTask for
    // 15 s per task hitting executeJavaScript failures, then time
    // out. Faster + cleaner to drop them now.
    if (postStopQueue.length > 0) {
      const dropped = postStopQueue.length;
      postStopQueue = [];
      appendMainLog(`[render-process-gone] dropped postStopQueue=${dropped}`);
    }
    // Clear dedup Sets — the post-crash renderer's ``liveRecordingSeq``
    // resets to 0 on reload, so the new recordings will reuse ids 1, 2,
    // 3, ... that the pre-crash session already added to these Sets.
    // Without this clear, the next recording's recordingId=1 silently
    // collides with the dead-session entry and the dedup gate falsely
    // skips the post-stop paste task — user records, stops, and sees
    // NO paste happen until ids climb past the highest pre-crash id.
    if (_enqueuedRecordingIds.size > 0 || _pastedRecordingIds.size > 0) {
      appendMainLog(
        `[render-process-gone] clearing dedup sets ` +
        `enqueued=${_enqueuedRecordingIds.size} pasted=${_pastedRecordingIds.size}`,
      );
      _enqueuedRecordingIds.clear();
      _pastedRecordingIds.clear();
    }
    // Tear down recording status state: it may be waiting on a transcript
    // that will never arrive.
    try {
      resetRecordingStatusState();
    } catch (e) {
      appendMainLog(`[render-process-gone] resetRecordingStatusState failed: ${e?.message || e}`);
    }
    // The renderer is dead; ``reload()`` on a crashed webContents
    // throws. Schedule a fresh load so the user sees a working UI
    // on the next Spotlight/Dock click. Track the handle so the
    // app-quit path can clear it — if the user quits within the
    // 500 ms window after a crash, the timer would otherwise fire
    // against a webContents that's already going through teardown
    // and produce an unhandled rejection in the shutdown log.
    if (renderRecoveryTimer) clearTimeout(renderRecoveryTimer);
    renderRecoveryTimer = setTimeout(() => {
      renderRecoveryTimer = null;
      if (isQuitting) return;
      if (!win || win.isDestroyed() || !win.webContents) return;
      const baseUrl = `${BASE_URL}/`;
      win.loadURL(baseUrl).catch((e) => {
        appendMainLog(`[render-process-gone] reload failed: ${e?.message || e}`);
      });
    }, 500);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    appendMainLog(`[did-fail-load] code=${code} desc=${desc} url=${url}`);
    // -3 = ERR_ABORTED (internal, usually benign — new nav cancelled old).
    // Everything else is a real load failure that leaves the renderer
    // blank, so surface a native diagnostic dialog with the log path.
    // Users on Windows most commonly see this when the backend hasn't
    // finished bootstrapping but the window was shown via a second
    // instance / tray click before loadURL completed.
    if (Number(code) === -3) return;
    if (String(url || "").startsWith("data:")) return;
    if (shortcutCaptureAbortHandler) {
      shortcutCaptureAbortHandler(`did-fail-load:${code}`);
    }
    const logPath = path.join(app.getPath("userData"), "main.log");
    const msg =
      "Transcriptor could not load the app window.\n\n" +
      `Error: ${desc} (${code})\n\n` +
      `Log file: ${logPath}\n\n` +
      "This is usually a one-time startup hiccup. Try closing and " +
      "reopening Transcriptor. If it keeps happening, send the log " +
      "file to support.";
    try {
      dialog.showMessageBox({
        type: "error",
        title: "Transcriptor — startup error",
        message: "The app window failed to load",
        detail: msg,
        buttons: ["Copy log path", "OK"],
        defaultId: 1,
        cancelId: 1,
      }).then((res) => {
        if (res.response === 0) {
          try { clipboard.writeText(logPath); } catch { }
        }
      }).catch(() => { });
    } catch { }
  });
  win.webContents.on("did-finish-load", async () => {
    loadedFrontendBuildSignature = (await getFrontendBuildSignature()) || "";
    appendMainLog(`[did-finish-load] frontendSignature=${loadedFrontendBuildSignature || "none"}`);
    if (shortcutCaptureAbortHandler) {
      shortcutCaptureAbortHandler("did-finish-load");
    }
    // Clear paste-dedup Sets on every renderer (re)load — but ONLY
    // when no in-flight recording or queued post-stop work exists.
    //
    // ``liveRecordingSeq`` (the renderer-side monotonic counter that
    // produces ``recordingId`` values) resets to 0 in every new
    // renderer instance — initial window load AND after a user-
    // initiated ``location.reload()`` (recoverFromBackendBoot,
    // DevTools refresh, F5). Without a clear at that boundary, ids
    // 1, 2, 3 from the new renderer collide with stale Set entries
    // from the previous renderer — ``handleRecordingPostStop`` then
    // falsely flags the next recording as a duplicate and silently
    // drops the paste task.
    //
    // BUT: a careless unconditional clear is itself a regression
    // surface. ``did-finish-load`` also fires when DevTools refreshes
    // mid-recording (Cmd-R / F5 while a recording is active). At that
    // moment ``pendingTranscriptionCount > 0`` (the in-flight stop is
    // queued) and ``postStopQueue`` is non-empty — clearing the Sets
    // there drops the active recording's id, then the post-stop
    // signal arrives and bypasses dedup, allowing the SAME content
    // to be pasted twice (once by the queued task, once by the
    // post-reload retry). That is the exact paste-duplication
    // regression the 1b05c52 / 1.1.10 hardening fixed.
    //
    // Idle-gate: clear only when both signals say "no work in
    // flight". On a normal cold load both are zero / empty — clear
    // runs as before. On a mid-recording reload the clear is
    // skipped, the in-flight id stays in the Set, and the queued
    // task's eventual paste is correctly deduped.
    const idle = pendingTranscriptionCount === 0 && postStopQueue.length === 0;
    if (!idle) {
      appendMainLog(
        `[did-finish-load] dedup clear SKIPPED ` +
        `(pending=${pendingTranscriptionCount} queue=${postStopQueue.length}) — ` +
        `mid-recording reload protected from paste-dup regression`,
      );
    } else if (_enqueuedRecordingIds.size > 0 || _pastedRecordingIds.size > 0) {
      appendMainLog(
        `[did-finish-load] clearing dedup sets ` +
        `enqueued=${_enqueuedRecordingIds.size} pasted=${_pastedRecordingIds.size}`,
      );
      _enqueuedRecordingIds.clear();
      _pastedRecordingIds.clear();
    }
    // Replay the cached shortcut status. If the initial
    // registerGlobalShortcuts() call happened before this window
    // existed (the usual case — shortcuts register during app.whenReady
    // before createWindow), the renderer would otherwise render with
    // its "hotkey" Settings panel showing the configured accelerator
    // as healthy when in fact registration silently failed.
    if (lastShortcutStatus && win && !win.isDestroyed() && win.webContents) {
      try {
        await win.webContents.executeJavaScript(
          `window.__transcriptorShortcutStatus = ${JSON.stringify(lastShortcutStatus)};`,
          true,
        );
      } catch (e) {
        appendMainLog(`[did-finish-load] shortcut replay failed: ${e?.message || e}`);
      }
    }
    // Replay backendBootError if set — a window that was closed-
    // and-reopened after a failed boot attempt would otherwise
    // render its boot overlay in a "no error" state, hiding the
    // diagnostic the user needs.
    if (backendBootError && win && !win.isDestroyed() && win.webContents) {
      try {
        await win.webContents.executeJavaScript(
          `window.__setBackendBootError && window.__setBackendBootError(${JSON.stringify(backendBootError)});`,
          true,
        );
      } catch (e) {
        appendMainLog(`[did-finish-load] backendBootError replay failed: ${e?.message || e}`);
      }
    }
    // Replay the boot STATUS too (BUG-74): a reload mid-install (or mid
    // dependency setup) lost the progress line and rendered a bare
    // overlay with no indication of what is happening.
    if (backendBootStatus && win && !win.isDestroyed() && win.webContents) {
      try {
        await win.webContents.executeJavaScript(
          `window.__setBackendBootStatus && window.__setBackendBootStatus(${JSON.stringify(backendBootStatus)});`,
          true,
        );
      } catch (e) {
        appendMainLog(`[did-finish-load] backendBootStatus replay failed: ${e?.message || e}`);
      }
    }
  });

  win.on("close", () => {
    // Rule 4, every platform: the red button and Cmd+W mean "not
    // running". macOS used to preventDefault and hide instead, which is
    // how the user ended up with an app that was closed and running at
    // the same time. `before-quit` stops the backend child, the capsule
    // and the tray.
    if (shortcutCaptureAbortHandler) {
      shortcutCaptureAbortHandler("window-close");
    }
    applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.mainWindowClose);
  });
  win.on("minimize", () => {
    // Rule 3: the OS did it and the app keeps running. Recorded so the
    // log distinguishes "the user minimised" from "something hid it".
    applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.mainWindowMinimize);
  });
  win.on("hide", () => {
    // Nothing in this process hides the main window any more, so a hide
    // is the user's own Cmd+H / Hide Others. Kept as the canary: if this
    // line ever appears without one of those, something grew a new
    // visibility crutch.
    appendMainLog(`[main-window] event=hide reason=os-initiated ${mainWindowSnapshot()}`);
  });
  win.on("focus", () => {
    // How long the user waited between asking for the app and having it.
    // "The window does not come forward immediately" was a report with
    // nothing in the log to confirm or refute it.
    const waitedMs = mainWindowShowRequestedAt > 0 ? Date.now() - mainWindowShowRequestedAt : -1;
    mainWindowShowRequestedAt = 0;
    appendMainLog(`[main-window] event=focus waited_ms=${waitedMs} ${mainWindowSnapshot()}`);
  });
  win.on("resized", () => noteMainWindowUserGeometry("resized"));
  win.on("moved", () => noteMainWindowUserGeometry("moved"));

  win.on("closed", () => {
    // Drop webContents listeners explicitly before releasing the ref
    // so nothing can re-bind them through a stale closure. Electron
    // GCs the BrowserWindow's native resources on its own, but
    // JavaScript closures that captured ``win.webContents`` would
    // still hold references to the old listener set.
    try {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.removeAllListeners("render-process-gone");
        win.webContents.removeAllListeners("did-fail-load");
        win.webContents.removeAllListeners("did-finish-load");
      }
    } catch (e) {
      appendMainLog(`[win-closed-listener-cleanup] ${e?.message || e}`);
    }
    win = null;
  });

  // ``url`` is captured AFTER startBackend so it reflects whatever
  // port pickBackendPort actually bound. Previously captured at this
  // point (before the conditional startBackend call), the URL would
  // freeze at the OLD ``BASE_URL`` and a port shift inside
  // pickBackendPort (preferred 8321 occupied → fallback 8322) made
  // win.loadURL hit ERR_CONNECTION_REFUSED on the stale port. The
  // healthcheck below already used template re-evaluation against
  // fresh BASE_URL, so the inconsistency was easy to miss until a
  // backend-restart-after-crash path triggered the port shift.
  try {
    if (!backend) {
      await startBackend();
    }
    const url = `${BASE_URL}/`;
    // Per-user-decision (pass 28): NO BOOT LOADER. The window stays
    // hidden during the cold-start window; once /api/health responds
    // OK we load the real URL and reveal the window. This avoids
    // the "Starting Transcriptor…" pulse screen the user finds
    // distracting, while ALSO avoiding the alternative regression
    // (blank window for 5–60 s) — by staying hidden we show
    // nothing at all until the app is genuinely ready.
    //
    // 60 s ceiling: cold-start on a fresh install with bundled
    // runtime is typically <5 s; the budget just bounds the wait
    // before the catch branch surfaces a real error to the user.
    await waitForBackendHealth(`${BASE_URL}/api/health`, 60_000);
    // Backend is up — clear the "Starting backend…" pill. Nothing ever
    // cleared it before, so the amber chip lingered next to the green
    // "Online" pill for the whole session (user-reported).
    setBackendBootStatus("");
    // Backend is healthy — treat this as a successful recovery signal
    // and clear the restart-attempt counter. Without this reset the
    // counter only decayed on a clean `exit code 0`, which never fires
    // outside shutdown, so the exponential backoff compounded across
    // sessions making the log delay misleading.
    noteBackendHealthy("backend-recovery");
    // CLEAR `backendBootError` once /api/health responds OK. Pass-24c
    // added a `did-finish-load` replay of this string so a closed-
    // and-reopened window can re-deliver the diagnostic — but if the
    // user successfully RECOVERED from the error (transient port
    // collision, fixed permissions, etc.), the stale message would
    // re-render on every subsequent window load, looking like the
    // app failed when it actually succeeded. Clearing on health-OK
    // closes that regression window.
    if (backendBootError) {
      appendMainLog(`[backend-recovery] clearing prior backendBootError (was: ${backendBootError.slice(0, 80)}...)`);
      backendBootError = "";
    }
    await refreshWindowForFrontendBuild(true);
    await win.loadURL(url);
    // Reveal NOW that the real frontend is loaded and the backend is
    // healthy. Skipping the loader page (pass 28) means this is the
    // very first time the user sees a window — no transition flash,
    // no "starting up" UI, just the ready app.
    if (showWindow) {
      presentMainWindow(revealReason);
    }
  } catch (err) {
    const stderrTail = (backendStderrTail || "").trim();
    const details = [
      err.message,
      backendBootError,
      stderrTail ? `— Backend stderr (last ${stderrTail.length} chars) —\n${stderrTail}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // Platform-specific recovery instructions. Keep these tied to the
    // current root entrypoints instead of deleted legacy install scripts.
    const logPath = path.join(app.getPath("userData"), "main.log");
    let recoveryHtml;
    if (app.isPackaged) {
      recoveryHtml = (
        `<p style="color:#bbb;margin-bottom:6px">Troubleshooting:</p>` +
        `<ol style="color:#ddd;margin:8px 0 14px 18px;padding:0;line-height:1.8">` +
        `<li>Close Transcriptor fully and reopen it once.</li>` +
        `<li>Reinstall the current release if the bundled runtime was quarantined or removed.</li>` +
        `<li>If the problem persists, send the log file shown below.</li>` +
        `</ol>` +
        `<p style="color:#888;font-size:12px">Log file: <code style="background:#222;padding:2px 6px;border-radius:4px;user-select:all">${escapeHtml(logPath)}</code></p>`
      );
    } else if (process.platform === "win32") {
      // The version comes from .python-version, not from a literal typed
      // here: a source checkout that is one minor version behind would
      // otherwise be told to install the interpreter the build no longer
      // uses. If the file cannot be read we name no version at all rather
      // than guess one.
      const py = readPythonVersion(getRepoRoot());
      const pythonStep = py
        ? `<li>Make sure Python ${escapeHtml(py.xy)} is installed: <code style="background:#333;padding:2px 6px;border-radius:4px">winget install Python.Python.${escapeHtml(py.xy)}</code></li>`
        : `<li>Make sure the Python version named in <code style="background:#333;padding:2px 6px;border-radius:4px">.python-version</code> is installed.</li>`;
      recoveryHtml = (
        `<p style="color:#bbb;margin-bottom:6px">Troubleshooting:</p>` +
        `<ol style="color:#ddd;margin:8px 0 14px 18px;padding:0;line-height:1.8">` +
        `<li>Close Transcriptor fully and reopen it.</li>` +
        pythonStep +
        `<li>If the problem persists, rebuild from the source checkout.</li>` +
        `</ol>` +
        `<p style="color:#888;font-size:12px">Log file: <code style="background:#222;padding:2px 6px;border-radius:4px;user-select:all">${escapeHtml(logPath)}</code></p>`
      );
    } else if (process.platform === "linux") {
      recoveryHtml = (
        `<p style="color:#bbb;margin-bottom:6px">Troubleshooting:</p>` +
        `<ol style="color:#ddd;margin:8px 0 14px 18px;padding:0;line-height:1.8">` +
        `<li>Install missing system deps: <code style="background:#333;padding:2px 6px;border-radius:4px">sudo apt install python3 python3-venv python3-pip ffmpeg xdotool zenity</code></li>` +
        `<li>Close and relaunch the AppImage.</li>` +
        `</ol>` +
        `<p style="color:#888;font-size:12px">Log file: <code style="background:#222;padding:2px 6px;border-radius:4px;user-select:all">${escapeHtml(logPath)}</code></p>`
      );
    } else {
      recoveryHtml = (
        `<h3 style="margin:0 0 10px 0;color:#e0e0e0">If it doesn't recover automatically</h3>` +
        `<p style="color:#bbb;margin-bottom:6px">Find the <b>Voice Transcriptor</b> folder you downloaded:</p>` +
        `<p style="color:#ddd;margin:8px 0">Quit and reopen Transcriptor. For a source checkout, run the current root installer:</p>` +
        `<pre style="background:#111;padding:10px 14px;border-radius:8px;border:1px solid #444;color:#7defa0;font-size:12px;user-select:all;cursor:text">cd ~/Downloads/Voice\\ Transcriptor && ./INSTALL.command</pre>` +
        `<p style="color:#888;font-size:12px;margin-top:14px">Log file: <code style="background:#222;padding:2px 6px;border-radius:4px;user-select:all">${escapeHtml(logPath)}</code></p>`
      );
    }
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
      <html>
        <head><meta charset="utf-8"></head>
        <body style="background:#1a1a1a;color:#cfcfcf;font-family:-apple-system,Segoe UI,Arial;padding:28px;line-height:1.6">
          <h2 style="margin:0 0 16px 0">Transcriptor — Backend startup failed</h2>
          <pre style="white-space:pre-wrap;background:#111;padding:14px;border-radius:8px;border:1px solid #333;margin-bottom:20px">${escapeHtml(details)}</pre>
          <div id="status" style="padding:10px 14px;background:#1a2a1a;border:1px solid #2a4a2a;border-radius:8px;margin-bottom:16px;color:#7defa0;font-size:13px">⏳ Checking if backend is starting...</div>
          ${recoveryHtml}
        </body>
      </html>
    `)}`
    );
    if (showWindow && win && !win.isDestroyed()) {
      presentMainWindow("create-window-error");
    }
    let recoveryAttempt = 0;
    const updateRecoveryStatus = async (text, healthy = false) => {
      if (!win || win.isDestroyed()) return;
      const js = `
        (() => {
          const s = document.getElementById('status');
          if (!s) return;
          s.textContent = ${JSON.stringify(text)};
          if (${healthy ? "true" : "false"}) {
            s.style.background = '#1a3a1a';
            s.style.borderColor = '#2a6a2a';
          }
        })();
      `;
      try { await win.webContents.executeJavaScript(js, true); } catch { /* page may have navigated */ }
    };
    const pollRecovery = async () => {
      // Bounded, and it stops when the app is going away. The loop used
      // to run `while (win && !win.isDestroyed())` with no ceiling and no
      // isQuitting check: on a backend that is not coming back it polled
      // every 3 s for the life of the process, printing an
      // ever-increasing attempt number at the user.
      while (win && !win.isDestroyed() && !isQuitting && recoveryAttempt < BACKEND_RECOVERY_MAX_ATTEMPTS) {
        recoveryAttempt += 1;
        await updateRecoveryStatus(`⏳ Waiting for backend... (attempt ${recoveryAttempt}/${BACKEND_RECOVERY_MAX_ATTEMPTS})`);
        try {
          await waitForBackendHealth(`${BASE_URL}/api/health`, BACKEND_RECOVERY_PROBE_TIMEOUT_MS);
          await updateRecoveryStatus("✅ Backend is up! Loading app...", true);
          if (win && !win.isDestroyed()) {
            await win.loadURL(`${BASE_URL}/`);
          }
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, BACKEND_RECOVERY_POLL_INTERVAL_MS));
        }
      }
      if (win && !win.isDestroyed() && !isQuitting) {
        appendMainLog(`[backend-recovery] gave up after ${recoveryAttempt} attempts`);
        await updateRecoveryStatus(
          `The backend did not come back after ${recoveryAttempt} attempts. Reopen Transcriptor, or send the log file above.`,
          true,
        );
      }
    };
    void pollRecovery();
  }
}

app.on("window-all-closed", () => {
  // Every platform, macOS included. "Closed" means "not running".
  applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.allWindowsClosed);
});

// Focus regain is the moment the user comes back from System Settings,
// so it is when a repaired grant should be noticed — and when a grant
// that died while we were in the background should be. The check is
// cache-first: it spawns nothing unless the cached verdict is stale.
app.on("browser-window-focus", () => {
  ensurePasteCapabilityFresh("focus").catch(() => { });
});

app.on("activate", () => {
  // Rule 2. No `hasVisibleWindows` heuristic and no four-flag inspection:
  // an activate is the user asking for the window, and the answer is
  // always the same one.
  applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.appActivate, {
    capsuleInteraction: shouldSuppressActivateForRecordingStatusCapsule(),
  });
});

/**
 * Robust backend termination — used from every exit path so the
 * Python subprocess is never orphaned.
 *
 * Previously only ``before-quit`` called ``backend.kill()``. If the
 * app crashed (``uncaughtException``), received a POSIX signal, or
 * went through any exit path that doesn't fire ``before-quit``, the
 * backend would keep running and hold on to its listening port.
 *
 * This helper sends SIGTERM first (graceful shutdown), then escalates
 * to SIGKILL after 1500 ms if the process is still alive. It also
 * tries to reap a stale PID via ``process.kill`` even after our local
 * ``backend`` reference has been cleared.
 */
let backendTerminationInProgress = false;
function killBackendHard(reason, opts = {}) {
  // ``force`` lets a second lifecycle caller (before-quit after a
  // signal) proceed even though an earlier call is still mid-sequence;
  // without it the before-quit retry was a silent no-op and the
  // SIGKILL escalation depended entirely on the first call's timer
  // surviving teardown.
  if (backendTerminationInProgress && !opts.force) return;
  backendTerminationInProgress = true;
  const proc = backend;
  backend = null;
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  if (!proc) {
    backendTerminationInProgress = false;
    return;
  }
  appendMainLog(`[backend-kill] reason=${reason} pid=${proc.pid}`);
  let pidForFallback = proc.pid;

  // On Windows, Node's ``proc.kill("SIGTERM")`` maps to TerminateProcess
  // on the IMMEDIATE child only — uvicorn workers, ffmpeg subprocesses,
  // and any Python-spawned helpers survive as orphans holding port 8321
  // and whisper models in RAM. The kernel's ``taskkill /T /F`` tree-
  // kill primitive walks the PID tree and is the correct fix. We still
  // rely on the parent-death stdin watchdog (backend/main.py) as a
  // belt-and-braces backup for crash-exit paths where we don't get to
  // run this function.
  if (process.platform === "win32") {
    const tryProcKill = () => {
      // Final fallback — the original TerminateProcess path. Better
      // than nothing when taskkill fails / times out / the PID is
      // garbage. ``proc`` may be a stale reference at this point, so
      // swallow its own failure — we already logged one above.
      try {
        if (proc && typeof proc.kill === "function") {
          proc.kill("SIGKILL");
          appendMainLog(`[backend-kill] fallback proc.kill(SIGKILL) executed`);
        } else if (pidForFallback) {
          process.kill(pidForFallback, "SIGKILL");
          appendMainLog(`[backend-kill] fallback process.kill(${pidForFallback}, SIGKILL) executed`);
        }
      } catch { }
    };
    // Guard: the subprocess can have spawned but crashed before we got
    // here, making `proc.pid` either `undefined` or a stale value that
    // taskkill will reject with "ERROR: Invalid argument". Without the
    // guard `String(undefined) === "undefined"` becomes a literal
    // taskkill arg, the call fails nonzero, and we used to `return`
    // with no fallback kill.
    if (!pidForFallback || typeof pidForFallback !== "number") {
      appendMainLog(`[backend-kill] no valid pid to tree-kill; trying direct proc.kill fallback`);
      tryProcKill();
      pidForFallback = null;
      backendTerminationInProgress = false;
      return;
    }
    let taskkillOk = false;
    try {
      const r = spawnSync("taskkill", ["/pid", String(pidForFallback), "/t", "/f"], {
        windowsHide: true,
        timeout: 5000,
      });
      if (r.status === 0) {
        taskkillOk = true;
        appendMainLog(`[backend-kill] taskkill tree-killed pid=${pidForFallback}`);
      } else {
        appendMainLog(
          `[backend-kill] taskkill exit=${r.status} signal=${r.signal || ""} ` +
          `stderr=${(r.stderr || "").toString().trim().slice(0, 200)}`
        );
      }
    } catch (e) {
      appendMainLog(`[backend-kill] taskkill threw: ${e?.message || e}`);
    }
    // If taskkill didn't report success (non-zero exit, SIGTERM'd by
    // our 5 s timeout, or threw), run the direct-kill fallback.
    // Without this a wedged taskkill (corp AV, elevated shell
    // blocking) leaves the backend tree orphaned and the next app
    // launch fails with "port 8321 already in use" for 120 s.
    if (!taskkillOk) tryProcKill();
    pidForFallback = null;
    backendTerminationInProgress = false;
    return;
  }

  const escalateSync = () => {
    if (!pidForFallback) return;
    try {
      process.kill(pidForFallback, "SIGKILL");
      appendMainLog(`[backend-kill] escalated to SIGKILL pid=${pidForFallback} (${reason})`);
    } catch (e) {
      appendMainLog(`[backend-kill] SIGKILL failed: ${e?.message || e}`);
    }
    pidForFallback = null;
    backendTerminationInProgress = false;
  };
  try {
    proc.kill("SIGTERM");
  } catch (e) {
    appendMainLog(`[backend-kill] SIGTERM failed: ${e?.message || e}`);
  }
  if (opts.synchronous) {
    // ``process.on("exit")`` context: NO pending timer will ever run —
    // the only reliable escalation is a synchronous SIGKILL right here.
    // The backend's own stdin watchdog remains the deeper backstop.
    escalateSync();
    return;
  }
  // Hard-kill timeout — if the process ignores SIGTERM (e.g., blocked
  // in a native call), SIGKILL it so we don't orphan it. Signal paths
  // shorten the window so escalation lands BEFORE their bounded
  // ``app.exit`` fallback tears the loop down.
  setTimeout(() => {
    if (!pidForFallback) return;
    try {
      process.kill(pidForFallback, 0);
      // Still alive — escalate to SIGKILL.
      escalateSync();
    } catch {
      // ESRCH — process is already gone, nothing to do.
      pidForFallback = null;
      backendTerminationInProgress = false;
    }
  }, opts.escalateAfterMs || 1500);
}

app.on("before-quit", () => {
  isQuitting = true;
  // Long-running runCommand children (the multi-GB engine pip install)
  // must die with the app, not orphan for their full timeout (BUG-61).
  killAllTrackedChildren();
  // Clear the auto-restart timer FIRST, before any other cleanup.
  // killBackendHard at the bottom of this handler also clears it, but
  // by then we've already spent ~tens of milliseconds tearing down
  // shortcuts, timers, recording monitors, and the tray. If the timer fires
  // during that window it spawns a NEW backend that the now-cleared
  // ``backend`` reference can't kill — a guaranteed orphan. Yanking
  // the timer first closes that race window.
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  // Same reasoning for the render-process-gone recovery timer:
  // if the user quits during the 500 ms window after a renderer
  // crash, the scheduled loadURL must NOT fire against a webContents
  // that's already going through teardown.
  if (renderRecoveryTimer) {
    clearTimeout(renderRecoveryTimer);
    renderRecoveryTimer = null;
  }
  // Same reasoning: a capsule teardown scheduled seconds before quit
  // must not fire against a window Electron is already tearing down.
  cancelRecordingStatusCapsuleTeardown();
  globalShortcut.unregisterAll();
  shortcutBridgeHandler = null;
  shortcutCaptureAbortHandler = null;
  if (shortcutCaptureFailsafeTimer) {
    clearTimeout(shortcutCaptureFailsafeTimer);
    shortcutCaptureFailsafeTimer = null;
  }
  pendingShortcutBridgeMessages = [];
  stopRecordingStateMonitor();
  if (recordingStatusWindow && !recordingStatusWindow.isDestroyed()) {
    try {
      recordingStatusWindow.destroy();
    } catch (e) {
      appendMainLog(`[before-quit] recording capsule destroy failed: ${e?.message || e}`);
    }
  }
  recordingStatusWindow = null;
  recordingStatusWindowReady = false;
  recordingStatusWindowLoadPromise = null;
  if (tray) {
    try {
      tray.destroy();
    } catch (e) {
      appendMainLog(`[before-quit] tray destroy failed: ${e?.message || e}`);
    }
    tray = null;
  }
  killBackendHard("before-quit", { force: true });
});

// Hook the raw node process exit events too — covers crashes and
// external signals that bypass Electron's ``before-quit`` handler.
process.on("exit", () => {
  isQuitting = true;
  killBackendHard("process-exit", { force: true, synchronous: true });
});
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    appendMainLog(`[signal] ${sig}`);
    isQuitting = true;
    killBackendHard(`signal-${sig}`, { escalateAfterMs: 250 });
    try {
      app.quit();
    } catch {
      try { app.exit(SIGNAL_EXIT_CODES[sig] || 0); } catch { process.exit(SIGNAL_EXIT_CODES[sig] || 0); }
    }
    const exitTimer = setTimeout(() => {
      try { app.exit(SIGNAL_EXIT_CODES[sig] || 0); } catch { process.exit(SIGNAL_EXIT_CODES[sig] || 0); }
    }, 1500);
    if (typeof exitTimer.unref === "function") exitTimer.unref();
  });
}

app.whenReady().then(async () => {
  // Process-level uncaughtException / unhandledRejection handlers are
  // already registered at module top-level so pre-whenReady crashes are
  // captured. No duplicate registration needed here.
  cleanupStaleTranscriptTmpFiles();
  recoverOrphanRotatingLogs();
  pruneMainLogArchives();
  sweepEngineSiteLeftoversAtBoot();

  // Engine lifecycle IPC (Settings → Local models). Handlers are
  // registered once, before any window exists, so the very first render
  // can already query status. invoke-only: the renderer never receives
  // raw ipcRenderer and cannot initiate arbitrary channels.
  const { ipcMain } = require("electron");
  ipcMain.handle("engine:get-status", () => engineInstallSnapshot());
  ipcMain.handle("engine:install", async () => {
    // Every return carries the phase snapshot the renderer branches on.
    // Two of these three paths used to return an object WITHOUT `phase`
    // — so an install that failed because there was no usable Python, or
    // because the handler threw, showed the user nothing at all, and
    // left engineInstallState as a shape syncEngineInstallState and
    // renderLocalModels could not read.
    const repoRoot = getRepoRoot();
    try {
      const python = await resolvePython(repoRoot);
      if (!python) {
        setEnginePhase(engineDeps.ENGINE_INSTALL_PHASES.FAILED, { reason: "no usable Python runtime" });
        return { ok: false, status: "no-python", ...engineInstallSnapshot() };
      }
      return await installGigaamEngine(python, repoRoot);
    } catch (e) {
      const reason = e?.message || String(e);
      appendMainLog(`[engine-install] handler error: ${reason}`);
      setEnginePhase(engineDeps.ENGINE_INSTALL_PHASES.FAILED, { reason });
      return { ok: false, status: "error", error: reason, ...engineInstallSnapshot() };
    }
  });

  // Accessibility/paste-capability status (D-009). Invoke-only, same
  // shape as the engine bridge above: the renderer pulls a snapshot
  // rather than main pushing one.
  //
  // `pasteCapability` used to be surfaced only reactively, inside a
  // recording-status string AFTER a paste had already failed
  // (pasteCapabilityStatusText, used by recordingStatusForPasteFailure)
  // — so a stale or missing grant was invisible until the user tried to
  // dictate something and the paste silently went nowhere. An earlier
  // attempt at a proactive surface pushed
  // `window.__transcriptorAccessibilityStatus` via `executeJavaScript`
  // on a 30-second interval; nothing in frontend/ ever read the global,
  // so it was deleted (see the comment on `lastAccessibilityTrusted`
  // above) rather than built on. This handler is the renderer-owned
  // surface that was missing, using the SAME invoke pattern as
  // `engine:get-status` instead of another injected global.
  //
  // `ensurePasteCapabilityFresh` probes only when the cached verdict is
  // stale (see paste-capability.js `shouldProbe`), so a renderer that
  // asks right after `probePasteCapability("boot")` already ran gets the
  // cached answer for free; the very first ask of a session pays for one
  // probe so the badge is never a beat behind the first recording.
  ipcMain.handle("paste-capability:get-status", async () => {
    const cap = await ensurePasteCapabilityFresh("renderer-query");
    const context = pasteCapabilityMessageContext();
    return {
      state: cap.state,
      // The renderer's "Repair permissions" button is offered only where
      // there is a TCC row to repair. A bundle replaced under the running
      // process is not one: the fix is the relaunch the note names.
      repairable: process.platform === "darwin" && !context.bundleReplaced,
      ...pasteCapabilityMessage(cap, context),
    };
  });

  // "Repair permissions" (Settings, next to the note above). The stale
  // grant this app's capability probe detects is repairable without
  // System Settings at all — `tccutil reset <service> <bundle id>` drops
  // the row whose code signing requirement no longer matches this build,
  // and macOS asks again on the next Apple Event. Main owns the command
  // (desktop/paste-capability.js builds it, including the refusal to run
  // it against anything that is not this app's own bundle id); the
  // renderer owns nothing but the click.
  ipcMain.handle("permissions:repair", async () => {
    try {
      return await repairPastePermissionsOnRequest();
    } catch (e) {
      const error = compactLogText(String(e?.message || e), 160);
      appendMainLog(`[paste-capability] repair handler error: ${error}`);
      return { ok: false, status: "error", error, state: pasteCapability.state, title: "", fix: "" };
    }
  });

  // Transcript hand-off from the renderer (BUGS_AUDIT §6.7). Registered
  // here, before any window exists, so a renderer that publishes its
  // final text the instant it loads still reaches a live listener.
  //
  // Send-only and one-way: the renderer says "recording N's text is X,
  // and here is whether it is the paste-ready one". Everything about
  // what that means — whether it may be pasted, when the fallback poll
  // starts, what happens on deadline expiry — stays in the main process.
  //
  // Two gates, both of them about not trusting renderer-controlled
  // input: the sender must be the main window's own webContents (the
  // recording-status capsule window has no preload and no business on
  // this channel), and the payload must match the contract exactly —
  // validateRecordingFinalPayload inside slot.set() ignores anything
  // else rather than coercing it.
  ipcMain.on("recording-final", (event, payload) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    const signal = recordingFinalSlot.set(payload);
    if (!signal) {
      appendMainLog(
        `[recording-final] ignored-invalid-payload keys=${compactLogText(
          payload && typeof payload === "object" ? Object.keys(payload).join(",") : typeof payload,
          80,
        )}`,
      );
      return;
    }
    appendMainLog(
      `[recording-final] rec=${signal.recordingId} final=${signal.final ? "1" : "0"} ` +
      `len=${signal.text.length} source="${signal.source}" seq=${signal.seq}`,
    );
  });

  lastTranscriptText = loadLastTranscriptFromDisk();
  // The one and only Dock statement of the whole process.
  applyMacDockPolicy();
  // macOS-only: read Accessibility permission once at boot. Users who
  // recorded successfully, then revoked the permission via System
  // Settings, would otherwise see the hotkey become a silent no-op —
  // `globalShortcut.register` returns true even when revocation has made
  // the handler non-functional, and there is no event to listen for.
  //
  // A 30-second interval used to re-read it for the lifetime of the
  // process. It answered no question: the state that decides whether a
  // paste is attempted is `pasteCapability`, and `probePasteCapability`
  // re-reads the trust bit itself on every path that consults it —
  // window focus, pre-paste, and after a paste fails the way a dead
  // grant fails. The poll's only other effect was feeding a renderer
  // global nothing has ever read.
  if (process.platform === "darwin") {
    try {
      refreshMacAccessibilityTrustState();
    } catch { }
    // One real probe at boot, so a grant that survived the re-signed
    // install but no longer works is known BEFORE the first recording
    // ends with a paste that silently goes nowhere. It is skipped
    // entirely when Accessibility is not granted (see
    // probePasteCapability), so a fresh install spawns nothing.
    probeAndRepairPasteCapability("boot").catch(() => { });
  }
  if (process.platform === "darwin") {
    // Resolve microphone TCC up front. Recording can be started from the
    // global hotkey, the tray or the in-app button, and only the hotkey
    // path used to ask — so starting from the UI on a fresh install (or
    // after any rebuild, which gives the bundle a new code identity and
    // resets TCC) handed the renderer a live-but-silent audio track with
    // no prompt and no error: no waveform, no words, no explanation.
    // Priming here makes the system prompt appear once, for every entry
    // point. Fire-and-forget so a stalled prompt cannot block startup.
    void ensureMacMicrophoneAccess()
      .then((status) => {
        appendMainLog(`[permissions] microphone access status=${status}`);
      })
      .catch((e) => {
        appendMainLog(`[permissions] microphone probe failed: ${e?.message || e}`);
      });
  }
  // Create a 5-bar sound wave tray icon matching the app icon (icon.png).
  // 32×32 @2x retina, template image auto-adapts to light/dark menu bar.
  const trayCanvas = (() => {
    const s = 32;
    const buf = Buffer.alloc(s * s * 4, 0);
    const barW = 3;
    const gap = 2;
    const totalW = 5 * barW + 4 * gap;
    const startX = Math.round((s - totalW) / 2);
    const heights = [14, 19, 24, 18, 12];

    const setPixel = (x, y, alpha) => {
      if (x < 0 || x >= s || y < 0 || y >= s) return;
      const i = (y * s + x) * 4;
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = alpha;
    };

    for (let b = 0; b < 5; b++) {
      const bx = startX + b * (barW + gap);
      const h = heights[b];
      const top = Math.round((s - h) / 2);
      const bot = top + h;
      for (let y = top; y < bot; y++) {
        for (let x = bx; x < bx + barW; x++) {
          // Round the top and bottom corners
          const isTopEdge = y === top;
          const isBotEdge = y === bot - 1;
          const isLeftEdge = x === bx;
          const isRightEdge = x === bx + barW - 1;
          if ((isTopEdge || isBotEdge) && (isLeftEdge || isRightEdge)) {
            setPixel(x, y, 140); // soften corners
          } else {
            setPixel(x, y, 255);
          }
        }
      }
    }
    return nativeImage.createFromBuffer(buf, { width: s, height: s, scaleFactor: 2.0 });
  })();
  trayCanvas.setTemplateImage(true);
  tray = new Tray(trayCanvas);
  const trayMenu = Menu.buildFromTemplate([
    {
      label: "Open Transcriptor",
      click: () => {
        applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.trayOpen);
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit()
    }
  ]);
  tray.on("click", () => {
    applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.trayOpen);
  });
  tray.on("right-click", () => {
    tray?.popUpContextMenu(trayMenu);
  });
  // Linux GTK status icons don't emit ``right-click`` on most desktop
  // environments — only macOS and Windows do. Without setContextMenu,
  // Linux users have no way to reach Quit / Open from the tray icon.
  // Calling setContextMenu installs a native context menu hook that
  // works on every platform; macOS and Windows still benefit from the
  // explicit right-click handler above for double-coverage.
  try {
    tray.setContextMenu(trayMenu);
  } catch (e) {
    appendMainLog(`[tray] setContextMenu failed: ${e?.message || e}`);
  }
  if (!app.isPackaged) {
    const devKey = process.platform === "darwin" ? "Command+Shift+D" : "Control+Shift+D";
    const ok = globalShortcut.register(devKey, () => {
      if (!win?.webContents) return;
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools();
    });
    if (!ok) {
      appendMainLog("[app] failed to register devtools shortcut");
    }
  }

  // ── Global Shortcuts (config-driven with live reload) ─────────────────────
  let registeredRecordHotkey = "";
  let registeredPasteHotkey = "";
  let shortcutsSuspendedForCapture = false;

  function readShortcutsFromConfig() {
    const defaults = shortcutDefaultsForPlatform();
    try {
      const dataDir = process.env.TRANSCRIPTOR_DATA_DIR || app.getPath("userData");
      const cfgPath = path.join(dataDir, "config.json");
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const ui = raw?.preferences?.ui || {};
        const stored = {
          record: String(ui.shortcut_record || defaults.record).trim() || defaults.record,
          paste: String(ui.shortcut_paste || defaults.paste).trim() || defaults.paste,
        };
        // Retired accelerator pairs are rewritten to the platform default by
        // ONE rule, declared in desktop/shortcut-migration.js and driven by
        // shortcut-defaults.json. The main process registers FIRST at
        // startup, before the renderer has read anything, so this first
        // `globalShortcut.register` must already use the migrated
        // accelerator — otherwise the retired key is a black hole until the
        // renderer catches up, and on the platforms where the OS itself
        // claims that key (F9 = Mission Control on macOS, F10 = Win32 menu
        // mnemonics) for as long as it stays bound.
        const migrated = migrateShortcutPair(stored, {
          manifest: shortcutDefaultsManifest,
          defaults,
          platform: process.platform,
        });
        for (const step of migrated.applied) {
          appendMainLog(`[shortcuts] migrated stale ${step.from} → ${step.to} (${step.id}) on ${process.platform}`);
        }
        return { record: migrated.record, paste: migrated.paste };
      }
    } catch (e) {
      appendMainLog(`[shortcuts] config read error: ${e?.message || e}`);
    }
    return defaults;
  }

  // Attempt to register an accelerator and return a normalized result.
  // ``globalShortcut.register`` can return ``false`` (accelerator in
  // use by another app) OR throw (malformed accelerator string from
  // an edited config). Both paths become a non-fatal ``ok=false`` so
  // the caller can log + surface the failure without crashing the
  // Electron main process.
  function safeRegisterShortcut(accelerator, handler) {
    const canonical = canonicalAcceleratorForPlatform(accelerator, process.platform);
    try {
      const ok = globalShortcut.register(canonical, handler);
      return { ok: !!ok, accelerator: canonical, error: ok ? "" : "already in use" };
    } catch (e) {
      return { ok: false, accelerator: canonical, error: String(e?.message || e) };
    }
  }

  function unregisterRegisteredShortcuts(reason = "") {
    const previousRecord = registeredRecordHotkey;
    const previousPaste = registeredPasteHotkey;
    if (registeredRecordHotkey) {
      try { globalShortcut.unregister(registeredRecordHotkey); } catch { }
    }
    if (registeredPasteHotkey) {
      try { globalShortcut.unregister(registeredPasteHotkey); } catch { }
    }
    registeredRecordHotkey = "";
    registeredPasteHotkey = "";
    if (reason && (previousRecord || previousPaste)) {
      appendMainLog(
        `[shortcuts] unregistered (${reason}): record=${previousRecord || "-"} paste=${previousPaste || "-"}`,
      );
    }
  }

  function clearShortcutCaptureFailsafe() {
    if (shortcutCaptureFailsafeTimer) {
      clearTimeout(shortcutCaptureFailsafeTimer);
      shortcutCaptureFailsafeTimer = null;
    }
  }

  function armShortcutCaptureFailsafe() {
    clearShortcutCaptureFailsafe();
    shortcutCaptureFailsafeTimer = setTimeout(() => {
      shortcutCaptureFailsafeTimer = null;
      restoreShortcutsAfterCaptureAbort("capture-timeout");
    }, 120000);
    try { shortcutCaptureFailsafeTimer.unref?.(); } catch { }
  }

  function restoreShortcutsAfterCaptureAbort(reason) {
    clearShortcutCaptureFailsafe();
    if (!shortcutsSuspendedForCapture) return;
    shortcutsSuspendedForCapture = false;
    appendMainLog(`[shortcuts] settings capture aborted by ${reason}; restoring registered shortcuts`);
    registerGlobalShortcuts();
  }

  /**
   * Fire-and-forget main → renderer notification. A destroyed or
   * not-yet-created window is the normal case during shutdown, not an
   * error worth failing a power event over.
   */
  function notifyRendererSystemSuspend(reason) {
    try {
      if (!win || win.isDestroyed() || !win.webContents) return;
      win.webContents.send("system-suspend", { reason: String(reason || "") });
    } catch (e) {
      appendMainLog(`[power] system-suspend notify failed: ${compactLogText(e?.message || e)}`);
    }
  }

  function registerGlobalShortcuts(override = null) {
    if (shortcutsSuspendedForCapture && !override) {
      appendMainLog("[shortcuts] register skipped while Settings capture is active");
      return;
    }
    // SSOT for the accelerators we actually bind:
    //   - At startup → readShortcutsFromConfig() (disk-backed, pre-renderer).
    //   - After a Settings-UI capture → the shortcuts bridge delivers an
    //     "update" message carrying the accelerators the user just
    //     typed. Passed in here as `override` so the registration uses
    //     those IN-MEMORY values, NOT the disk config.
    //
    // Why the override exists (root cause of "не ставятся новые при
    // нажатии клавиш"): the renderer queues a debounced (600 ms) save
    // to /api/config which the backend writes to disk asynchronously.
    // Re-reading disk on an update would therefore often return the OLD
    // shortcut and re-register the very accelerator the user just
    // changed away from — the displayed shortcut updates in the UI
    // while the actual global hotkey stays on the previous binding.
    // Routing the bridge payload through `override` removes the
    // disk-write dependency
    // entirely — registration uses exactly what the user pressed.
    //
    // Defensive fallback: if `override` is partial (only `record` or
    // only `paste`) we fill the missing half from disk so we never
    // unregister an accelerator without re-registering its replacement.
    let shortcuts;
    if (override && (override.record || override.paste)) {
      const fromDisk = (override.record && override.paste) ? null : readShortcutsFromConfig();
      shortcuts = {
        record: String(override.record || (fromDisk && fromDisk.record) || "").trim(),
        paste: String(override.paste || (fromDisk && fromDisk.paste) || "").trim(),
      };
    } else {
      shortcuts = readShortcutsFromConfig();
    }
    // Unregister old shortcuts (keep devtools). Clear stored values
    // up-front — only set them back after a
    // successful registration, so a failed accelerator is never
    // tracked as "active" (which would cause the next reload to
    // unregister something that was never registered).
    unregisterRegisteredShortcuts();

    const recordResult = safeRegisterShortcut(shortcuts.record, () => {
      toggleRecordingFromShortcut().catch((e) => {
        appendMainLog(`[shortcut] toggle failed: ${e?.message || e}`);
        resetRecordingStatusState();
      });
    });
    if (recordResult.ok) {
      registeredRecordHotkey = shortcuts.record;
    } else {
      // WARN: a failed registration is silent otherwise — the app
      // looks like it started fine and the hotkey simply never fires.
      // The status object built below (and replayed via did-finish-load,
      // see the comment at its declaration) is what actually surfaces
      // this to the renderer/Settings UI.
      appendMainLog(
        `[shortcuts] WARN: failed to register recording shortcut: ${shortcuts.record} (${recordResult.error})`,
      );
    }

    const pasteResult = safeRegisterShortcut(shortcuts.paste, () => {
      pasteLatestTranscriptFromShortcut().catch((e) => {
        appendMainLog(`[shortcut] paste-last failed: ${e?.message || e}`);
        resetRecordingStatusState();
      });
    });
    if (pasteResult.ok) {
      registeredPasteHotkey = shortcuts.paste;
    } else {
      appendMainLog(
        `[shortcuts] WARN: failed to register paste-last shortcut: ${shortcuts.paste} (${pasteResult.error})`,
      );
    }

    // Surface registration status to the renderer so the Settings
    // panel can show a red indicator next to any shortcut that the
    // main process could not claim. Failures are common: stale
    // accelerators from another running copy, malformed user input,
    // OS-level reservations (e.g. Alt+Space on some locales).
    //
    // IMPORTANT: `registerGlobalShortcuts` is invoked DURING app startup
    // (see the bottom of this file, before createWindow). At that
    // moment `win` is null and the injection below no-ops, so the
    // renderer never learns that its hotkey is unclaimed — the most
    // common real-world failure mode (corp user, F9 owned by another
    // app) becomes silent. We cache the latest status in a module var
    // and replay it from `did-finish-load` so every window creation
    // sees the current state, including the very first window ever
    // created.
    // On macOS, check whether the OS is intercepting F1–F12 as media
    // keys (default on Apple keyboards: "Use F1, F2, etc. keys as
    // standard function keys" OFF → F9 = Mission Control, F10 =
    // Notification Center, F11 = Show Desktop). In that mode
    // `globalShortcut.register("F9")` returns true but the user's
    // actual F9 press fires the OS function, never reaches us — the
    // single most common "hotkey does not work" report from Mac users.
    // We surface the state to the renderer so Settings can badge the
    // F9 / F10 rows with a "macOS is intercepting this key — hold Fn,
    // or switch the OS setting, or pick a different hotkey" hint.
    // No forced dialog on launch — that would annoy users who
    // deliberately picked a non-F-key accelerator.
    let macFnState = null;  // null = unknown / non-darwin / probe failed
    if (process.platform === "darwin") {
      try {
        const raw = systemPreferences.getUserDefault("com.apple.keyboard.fnState", "boolean");
        macFnState = (raw === true);
      } catch {
        macFnState = null;
      }
    }
    const status = {
      record: {
        desired: recordResult.accelerator || shortcuts.record,
        active: recordResult.ok ? recordResult.accelerator : "",
        error: recordResult.ok ? "" : recordResult.error,
      },
      paste: {
        desired: pasteResult.accelerator || shortcuts.paste,
        active: pasteResult.ok ? pasteResult.accelerator : "",
        error: pasteResult.ok ? "" : pasteResult.error,
      },
      // Renderer uses this to decide whether to show the "macOS is
      // intercepting F9/F10" hint. Only relevant on darwin and only
      // when the configured accelerator is an F-key.
      macFnState,
      platform: process.platform,
    };
    lastShortcutStatus = status;
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents
        .executeJavaScript(
          `window.__transcriptorShortcutStatus = ${JSON.stringify(status)};`,
          true,
        )
        .catch(() => { });
    }

    appendMainLog(
      `[shortcuts] registered: record=${registeredRecordHotkey || "FAILED"} ` +
      `paste=${registeredPasteHotkey || "FAILED"}`,
    );
  }

  function handleShortcutBridgeMessage(message) {
    const action = String(message?.action || "").trim();
    if (action === "capture-start") {
      if (!shortcutsSuspendedForCapture) {
        shortcutsSuspendedForCapture = true;
        unregisterRegisteredShortcuts("settings-capture");
      }
      armShortcutCaptureFailsafe();
      return;
    }
    if (action === "capture-cancel") {
      restoreShortcutsAfterCaptureAbort("capture-cancel");
      return;
    }
    if (action === "update") {
      const record = String(message?.record || "").trim();
      const paste = String(message?.paste || "").trim();
      if (!record || !paste) {
        appendMainLog(`[shortcuts] bridge update rejected: record=${record || "-"} paste=${paste || "-"}`);
        return;
      }
      shortcutsSuspendedForCapture = false;
      clearShortcutCaptureFailsafe();
      appendMainLog(`[shortcuts] bridge live reload: record=${record} paste=${paste}`);
      registerGlobalShortcuts({ record, paste });
    }
  }

  registerGlobalShortcuts();

  // System power transitions, subscribed ONCE at app scope. These two
  // handlers used to be nested inside restoreShortcutsAfterCaptureAbort,
  // which only runs when the user aborts a hotkey capture in Settings —
  // so in a normal session nothing was subscribed and both shipped fixes
  // (BUG-81 resume re-claim, and the 1.6.0 warm-microphone release on
  // sleep) never ran. The event → action mapping is now data in
  // ./power-events, which is also what makes it testable.
  subscribePowerEvents(require("electron").powerMonitor, {
    reclaimShortcuts: () => registerGlobalShortcuts(),
    releaseWarmCapture: (reason) => notifyRendererSystemSuspend(reason),
    log: appendMainLog,
  });

  shortcutBridgeHandler = handleShortcutBridgeMessage;
  shortcutCaptureAbortHandler = restoreShortcutsAfterCaptureAbort;
  if (pendingShortcutBridgeMessages.length > 0) {
    const queuedMessages = pendingShortcutBridgeMessages.splice(0);
    for (const message of queuedMessages) {
      handleShortcutBridgeMessage(message);
    }
  }

  // No poll for shortcut changes: ``handleShortcutBridgeMessage`` above
  // already receives every capture-start / capture-cancel / update the
  // Settings UI emits, and the "update" payload carries the very
  // accelerators the poll used to fetch. Publishing the same fact on
  // two channels meant a 2 s ``executeJavaScript`` round-trip into the
  // renderer for the entire life of the app — cross-process work, V8
  // compile and result serialisation, forever, to learn something the
  // event had already delivered. The event bridge is also strictly
  // better: it fires the instant the user finishes a capture instead of
  // up to 2 s later, and it is the only channel that can express the
  // capture lifecycle at all.

  // Startup must not summon macOS permission prompts. Permission prompts
  // are tied to user actions: recording asks for microphone when the
  // user records, and paste asks for Accessibility/Automation when paste
  // actually needs them.
  refreshMacAccessibilityTrustState();
  await startBackend();
  await applyWindowLifecycleEvent(WINDOW_LIFECYCLE_EVENTS.startup);
}).catch((err) => {
  // The whenReady chain has many awaits — startBackend, permission
  // probes, accessibility checks, and any one of
  // them rejecting becomes an unhandled promise rejection that the
  // top-level ``unhandledRejection`` handler logs but cannot recover
  // from. The app then sits in an inconsistent state (no shortcuts,
  // no tray, no backend) with the user staring at a hidden window.
  // Catching here gives us one place to surface the failure both to
  // the log AND to the renderer / boot overlay so the user can
  // either retry or quit instead of force-killing.
  const msg = err && err.message ? err.message : String(err);
  try { appendMainLog(`[whenReady-fatal] ${msg}`); } catch { }
  backendBootError = `App startup failed: ${msg}`;
  setBackendBootStatus("");
  // Surface to whichever surface is alive: an existing window's
  // boot-overlay first (renderer is up but backend died), tray
  // notification second, dialog last (final fallback when the
  // window never made it).
  if (win && !win.isDestroyed() && win.webContents) {
    try {
      win.webContents.executeJavaScript(
        `window.__setBackendBootError && window.__setBackendBootError(${JSON.stringify(backendBootError)});`,
        true,
      ).catch(() => { });
    } catch { }
  } else {
    try {
      dialog.showErrorBox("Transcriptor — startup failed", msg);
    } catch { }
  }
});
