import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// D-015: the same shared module main.tsx imports (see the describe block
// below) — executed here too, so this suite proves vitest can actually
// RUN the shared rule, not merely that main.tsx's source text mentions it.
import { migrateShortcutPair } from "../../desktop/shortcut-migration.js";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const liveDefaultsFixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../contracts/live-defaults.json"), "utf-8"),
) as { languages: string[]; keyterm_token_budget: number };
const shortcutDefaultsManifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "../desktop/shortcut-defaults.json"), "utf-8"),
);

/**
 * The renderer's `window.__transcriptor*` mirrors are a two-process
 * contract: a global is worth writing only while the main process reads
 * it. Pinned here because neither side can import the other.
 */
const mainTsx = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const desktopMain = readFileSync(resolve(process.cwd(), "../desktop/main.js"), "utf8");

describe("renderer globals the main process reads", () => {
  // The finished-records list and the …At / …RecordingId scalars had one
  // reader — the main process's post-stop poll — and lost it when that
  // poll was deleted (Ultra-Audit 2026-11-20 DM-15). A global nobody
  // reads is a second, unchecked copy of the IPC hand-off; neither side
  // may bring one back.
  const dead = [
    "__transcriptorFinishedRecords",
    "__transcriptorLastFinishedAt",
    "__transcriptorLastFinishedRecordingId",
    "__transcriptorLastUiFinalAt",
    "__transcriptorLastUiFinalRecordingId",
  ];
  it.each(dead)("%s is neither written by the renderer nor read by main", (name) => {
    expect(mainTsx).not.toContain(name);
    expect(desktopMain).not.toContain(name);
  });

  it("every global the renderer still mirrors has a reader in main", () => {
    for (const name of ["__transcriptorLastFinishedText", "__transcriptorLastUiFinalText", "__transcriptorLastUiFinalKind"]) {
      expect(desktopMain, `${name} has no reader`).toContain(name);
    }
  });
});

/**
 * DM-10 / FU-10 / K-1: the main window talks to main over preload sends
 * (desktop/renderer-requests.js), not by writing sentinels into
 * ``document.title``. The channel must not come back on either side.
 */
describe("no document.title channel between the renderer and main", () => {
  const desktopMain = readFileSync(resolve(process.cwd(), "../desktop/main.js"), "utf8");

  it("the renderer never writes a sentinel title and main never listens for one", () => {
    expect(mainTsx).not.toMatch(/__app_[a-z_]+__/);
    expect(mainTsx).not.toMatch(/document\.title\s*=/);
    expect(desktopMain).not.toContain("page-title-updated");
  });

  it("the renderer uses the preload sends and the pushed shortcut status", () => {
    expect(mainTsx).toContain("window.transcriptor?.shortcuts?.(");
    expect(mainTsx).toContain("window.transcriptor?.recordToggle?.()");
    expect(mainTsx).toContain("window.transcriptor?.revealRecording");
    expect(mainTsx).toContain("window.transcriptor?.onShortcutStatus?.(");
    expect(mainTsx).not.toContain("__transcriptorShortcutStatus");
  });
});

/**
 * B-027 / R-016: the backend is the sole owner of the live-path
 * defaults (dual-stream, secondary language, the language option list,
 * the keyterm token budget). This block guards the two ways a renderer
 * copy could creep back in: a hardcoded fallback constant, and a
 * pre-hydration `<select>` that quietly drifts from what the backend
 * will later replace it with (``applyLiveLanguageOptions`` keeps the
 * current selection across the swap, so a stale pre-hydration option
 * missing from the backend's list would be silently dropped instead of
 * merely relabelled).
 */
describe("live-path defaults have no renderer-owned copy", () => {
  it("readDeepgramDualStream/readDeepgramDualSecondaryLanguage fall back to backendLiveDefaults, not a literal", () => {
    const dualStreamFn = /function readDeepgramDualStream\(\)[^{]*\{([\s\S]*?)\n\}/.exec(mainTsx)?.[1];
    const secondaryFn = /function readDeepgramDualSecondaryLanguage\(\)[^{]*\{([\s\S]*?)\n\}/.exec(mainTsx)?.[1];
    expect(dualStreamFn, "readDeepgramDualStream not found").toBeTruthy();
    expect(secondaryFn, "readDeepgramDualSecondaryLanguage not found").toBeTruthy();
    expect(String(dualStreamFn)).toContain("backendLiveDefaults");
    expect(String(secondaryFn)).toContain("backendLiveDefaults");
    // Neither function may fall back to a boolean/string literal default —
    // only to the checkbox/select state or backendLiveDefaults.
    expect(String(dualStreamFn)).not.toMatch(/:\s*(true|false)\s*;/);
  });

  it("declares no DUAL_STREAM_DEFAULT / DUAL_SECONDARY_LANGUAGE_DEFAULT constant of its own", () => {
    expect(mainTsx).not.toMatch(/\bconst\s+DUAL_STREAM_DEFAULT\b/);
    expect(mainTsx).not.toMatch(/\bconst\s+DUAL_SECONDARY_LANGUAGE_DEFAULT\b/);
  });

  it("#language's pre-hydration options match the backend's live-language list (index.html placeholder, replaced by applyLiveLanguageOptions)", () => {
    const block = /<select id="language">([\s\S]*?)<\/select>/.exec(html)?.[1];
    expect(block, "#language select not found in index.html").toBeTruthy();
    const values = Array.from(String(block).matchAll(/<option value="([^"]+)"/g)).map((m) => m[1]);
    expect(values).toEqual(liveDefaultsFixture.languages);
  });

  it("states the keyterm budget from the backend, not a hardcoded number, next to the field", () => {
    expect(mainTsx).toContain("applyKeytermBudgetNote");
    expect(mainTsx).not.toMatch(/Up to \d+ tokens in total/);
  });
});

/**
 * S-06: ``UI_TOKENS.finalize.segmentEpsilonSec`` (0.08) and
 * ``backend/live.py``'s ``LiveConfig.emit_epsilon_sec`` (0.05) look like
 * the same tolerance and were flagged as a suspected third duplicate
 * (R-016/S-05/S-04's sibling). They are not: one dedups two SENT
 * segments in the renderer's own preview merge regardless of provider,
 * the other governs what a single Whisper-only live session EMITS
 * across two overlapping inference passes, before anything reaches this
 * renderer. Unifying them would make a Whisper-timestamp property
 * decide how the renderer dedups a Deepgram segment pair. This is a
 * documented decision NOT to unify, guarded here so neither comment can
 * be deleted without the other going stale.
 */
describe("segmentEpsilonSec vs. live.py's emit_epsilon_sec (S-06, deliberately not unified)", () => {
  const backendLive = readFileSync(resolve(process.cwd(), "../backend/live.py"), "utf8");

  it("both constants carry a comment explaining why they are not the same value", () => {
    const rendererBlock = /segmentEpsilonSec:\s*0\.08/.exec(mainTsx);
    expect(rendererBlock, "segmentEpsilonSec: 0.08 not found in main.tsx").toBeTruthy();
    const before = mainTsx.slice(0, rendererBlock!.index).slice(-1200);
    expect(before).toMatch(/S-06/);
    expect(before).toMatch(/emit_epsilon_sec/);

    const backendBlock = /emit_epsilon_sec:\s*float\s*=\s*0\.05/.exec(backendLive);
    expect(backendBlock, "emit_epsilon_sec: float = 0.05 not found in backend/live.py").toBeTruthy();
    const backendBefore = backendLive.slice(0, backendBlock!.index).slice(-1500);
    expect(backendBefore).toMatch(/segmentEpsilonSec/);
  });
});

/**
 * F/7 / U-022 — ``stopLive`` had seven near-identical "stop without a
 * transcript" epilogues. Only their common, order-independent tail (drop
 * the live draft, clear the busy flag, release the stop transition) was
 * safe to extract without live-recording verification this environment
 * cannot perform (see backend-fix-journal.md "Швы" for the scoping
 * decision); the surrounding save/patch/status logic keeps its per-site
 * variation. What must never drift regardless is the invariant the
 * 2026-09-04 session pinned by hand with a one-off ``git diff``: exactly
 * ONE place in ``stopLive`` delivers an actual transcript
 * (``kind: "transcript"``) to the user. A second delivery site would
 * mean two different code paths can both decide "the stop is done, here
 * is the text" — which is exactly the three-source-of-truth bug the
 * B-038/889c91a work fixed. This test makes that a standing check
 * instead of a manual one-time verification. These are explicit source
 * pins, not behavior tests: stopLive is nested in the side-effectful
 * renderer entry point and depends on its DOM and preload bridge. The
 * extracted epilogue and metadata-save behavior is exercised in
 * stop-epilogue.test.ts; the one-delivery invariant is not. Replacing the
 * pins requires extracting the stop coordinator behind injectable effects,
 * then asserting one transcript publication and one release per stop via
 * those effects. That production refactor is outside this test-only lane.
 */
describe("stopLive has exactly one transcript delivery site (F/7 / U-022)", () => {
  const stopLiveStart = mainTsx.indexOf("async function stopLive(");
  const nextTopLevelFn = mainTsx.indexOf("\nasync function initRecordingsBootstrap(", stopLiveStart);
  const stopLiveBody = stopLiveStart !== -1 && nextTopLevelFn > stopLiveStart
    ? mainTsx.slice(stopLiveStart, nextTopLevelFn)
    : "";

  it("the boundary markers used to isolate stopLive's body are still present", () => {
    expect(stopLiveStart, "async function stopLive( not found in main.tsx").not.toBe(-1);
    expect(nextTopLevelFn, "end-of-stopLive marker not found").toBeGreaterThan(stopLiveStart);
  });

  it("calls publishRecordingFinalSignal with kind: \"transcript\" exactly once", () => {
    const matches = stopLiveBody.match(/kind:\s*"transcript"/g) || [];
    expect(matches.length).toBe(1);
  });

  it("the one delivery site is reached only through transcriptSource === \"envelope\" (or its recovery fallback), never a second parser", () => {
    // Both assignments feed the SAME downstream delivery — the fast
    // envelope path and its recovery re-run through the same variable,
    // not a second one.
    const assignments = stopLiveBody.match(/transcriptSource\s*=\s*"envelope"/g) || [];
    expect(assignments.length).toBeGreaterThanOrEqual(1);
    // The delivery call must read transcriptRaw the envelope produced —
    // not reassemble text from segments/words itself.
    const deliveryIndex = stopLiveBody.indexOf('kind: "transcript"');
    const around = stopLiveBody.slice(Math.max(0, deliveryIndex - 400), deliveryIndex);
    expect(around).toMatch(/domText:\s*transcriptRaw/);
  });

  it("FL-01: the drained-silence branch asks decideDrainedSilence, so mic health cannot veto a spoken session", () => {
    expect(stopLiveBody).toContain("decideDrainedSilence({");
    expect(stopLiveBody).toMatch(/carriedSpeech:\s*summarizeCaptureLevel\(captureLevel\)\.carriedSpeech/);
    // The pre-fix gate: any bad mic-health state ended the stop as empty.
    expect(stopLiveBody).not.toMatch(/\(!!provider && micHealthBad\)/);
  });

  it("the five no-transcript exits end through one epilogue, not a copy each (D-13)", () => {
    // Each early return states its plan; runStopEpilogue (./stop-epilogue,
    // behaviour-tested in stop-epilogue.test.ts) does the ending.
    // Five, not six: the "no provider selected" exit went with the "None"
    // option (FU-15, user decision 2026-11-20).
    const exits = stopLiveBody.match(/await endWithoutTranscript\(\{/g) || [];
    expect(exits.length).toBe(5);
    expect(stopLiveBody).toContain("runStopEpilogue(plan, {");
    // The bookkeeping is handed to the epilogue, never called inline by an exit.
    expect(stopLiveBody).toContain("release: releaseStopEpilogueBookkeeping,");
    expect(stopLiveBody.match(/releaseStopEpilogueBookkeeping\(\);/g) || []).toHaveLength(0);
  });

  it("FL-02 wiring: the metadata save is the module's saver, and the success path hands it the spoken transcript", () => {
    // What the saver writes — the title rule, the classified outcome — is
    // behaviour-tested in stop-epilogue.test.ts. What only the source can
    // show is that stopLive uses it and what it hands it.
    expect(stopLiveBody).toMatch(/const saveSessionMetadata = createSessionMetadataSaver\(\{/);
    const finalSave = /const finalSave = await saveSessionMetadata\(\{([\s\S]*?)\}\);/.exec(stopLiveBody)?.[1];
    expect(finalSave, "the success-path save not found").toBeTruthy();
    expect(String(finalSave)).toMatch(/spokenTranscript:\s*plainTranscriptRaw,/);
    expect(String(finalSave)).toMatch(/transcriptText:\s*transcriptRaw,/);
  });

  it("the audio save runs beside the transcript wait: the FINAL delivery never waits for it (OPTIMIZATION.md §3.1)", () => {
    expect(stopLiveBody).toContain("startAudioPersistence({");
    // No inline two-attempt upload left on the stop path.
    expect(stopLiveBody).not.toMatch(/await saveRecordingText\(\{[^}]*audioFile/);
    expect(stopLiveBody).not.toMatch(/await audioPersistence\.settled/);
    // Only the steps that consume the saved recording wait for the save:
    // the metadata write's target, the recovery decode of the saved file,
    // and a screen take's marks (archived screenshot paths).
    const allowed = [
      "if (stagedScreenManifest) {",
      "const fetchRecoveryAudioFile = async",
      "const recoverFromEmptyTranscriptInner = async",
      "target: async () => {",
    ];
    const waits = [...stopLiveBody.matchAll(/await audioSaveApplied;/g)];
    expect(waits.length).toBe(allowed.length);
    for (const wait of waits) {
      const before = stopLiveBody.slice(Math.max(0, (wait.index ?? 0) - 400), wait.index);
      expect(allowed.some((ctx) => before.includes(ctx)), `unexpected wait for the audio save: …${before.slice(-160)}`).toBe(true);
    }
    // The spool outlives a failed save until the stop is completely over.
    expect(mainTsx).toContain("audioPersistence.releaseSpoolWhenDone();");
  });

  it("FL-04: every exit ends the mic-health session through the one session-ending step", () => {
    const endBlock = /const endStopSession = \(\): void => \{([\s\S]*?)\n {2}\};/.exec(stopLiveBody)?.[1];
    expect(endBlock, "endStopSession not found in stopLive").toBeTruthy();
    expect(String(endBlock)).toContain('micHealth.observe({ kind: "session-stop" });');
    const bookkeeping = /const releaseStopEpilogueBookkeeping = \(\): void => \{([\s\S]*?)\n {2}\};/.exec(stopLiveBody)?.[1];
    expect(String(bookkeeping)).toContain("endStopSession();");
    // The observation exists once: in endStopSession, not per exit.
    expect(stopLiveBody.match(/kind: "session-stop"/g) || []).toHaveLength(1);
  });
});

/**
 * D-053 (desktop-fix-journal.md, commit 18 "Not done"): ``preload.js``'s
 * ``onSystemSuspend`` returns an unsubscribe function; the renderer used
 * to discard it at a top-level call site, so a second run of that
 * top-level code in one page lifetime (a Vite dev-server HMR update,
 * which re-executes top-level code WITHOUT the page reload that would
 * otherwise tear down the preload world's listeners) stacked a second
 * listener instead of replacing the first. Fixed by moving the
 * subscribe into a named function that retires its own prior
 * subscription before installing a new one — safe by construction on
 * any re-run, not merely on the first one.
 */
describe("system-suspend subscription retires its own prior listener (D-053)", () => {
  it("subscribeToSystemSuspend unsubscribes before resubscribing, using a module-level handle", () => {
    expect(mainTsx).toMatch(/let systemSuspendUnsubscribe:\s*\(\(\)\s*=>\s*void\)\s*\|\s*null\s*=\s*null;/);
    const fnBlock = /function subscribeToSystemSuspend\(\): void \{([\s\S]*?)\n\}/.exec(mainTsx)?.[1];
    expect(fnBlock, "subscribeToSystemSuspend not found").toBeTruthy();
    const body = String(fnBlock);
    // Unsubscribe must run BEFORE the new subscription is installed.
    const unsubIndex = body.indexOf("systemSuspendUnsubscribe?.();");
    const resubIndex = body.indexOf("systemSuspendUnsubscribe = window.transcriptor");
    expect(unsubIndex).toBeGreaterThanOrEqual(0);
    expect(resubIndex).toBeGreaterThan(unsubIndex);
  });

  it("is actually called at module load, not merely declared", () => {
    expect(mainTsx).toMatch(/\nsubscribeToSystemSuspend\(\);/);
  });
});

/**
 * D-009 (desktop-fix-journal.md, commit 18 "Not done"): the renderer
 * badge for a broken/missing macOS Accessibility grant. desktop/main.js
 * already exposed `paste-capability:get-status`; this pins the
 * renderer's consumption of it — a hidden-by-default note, populated on
 * boot and on window focus (matching main's own re-probe cadence), and
 * never invented as a second markup surface.
 */
describe("paste-capability note is wired to the bridge (D-009)", () => {
  it("#pasteCapabilityNote exists in the markup and starts hidden", () => {
    const tag = /<div[^>]*id="pasteCapabilityNote"[^>]*>/.exec(html)?.[0];
    expect(tag, "#pasteCapabilityNote is missing from index.html").toBeTruthy();
    expect(String(tag)).toMatch(/\bhidden\b/);
  });

  it("refreshPasteCapabilityNote reads __transcriptorPasteCapability.getStatus and toggles hidden off fix, not state", () => {
    const fnBlock = /async function refreshPasteCapabilityNote\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(mainTsx)?.[1];
    expect(fnBlock, "refreshPasteCapabilityNote not found").toBeTruthy();
    const body = String(fnBlock);
    expect(body).toContain("window.__transcriptorPasteCapability?.getStatus()");
    expect(body).toMatch(/el\.hidden\s*=\s*!fix/);
  });

  it("is queried at boot and on every window focus", () => {
    expect(mainTsx).toMatch(/\nvoid refreshPasteCapabilityNote\(\);/);
    expect(mainTsx).toMatch(
      /window\.addEventListener\("focus", \(\) => \{ void refreshPasteCapabilityNote\(\); \}\);/,
    );
  });
});

/**
 * The stop tail's input latency (./capture-latency) includes what Core Audio
 * says of the capture device, read by the native helper. The channel is typed
 * in preload, main and here; desktop/ipc-contract.test.js holds the first two.
 */
describe("the capture's input latency reads Core Audio through the input-latency bridge", () => {
  it("asks the bridge once the capture stream is live and hands the list to captureInputLatency", () => {
    expect(mainTsx).toContain("window.__transcriptorInputLatency");
    expect(mainTsx).toMatch(/bridge\.getDevices\(\)/);
    expect(mainTsx).toMatch(/\n\s+void refreshNativeInputDevices\(\);/);
    expect(mainTsx).toMatch(/nativeDevices: nativeInputDevices,/);
  });

  it("puts Core Audio's figure in the stop trace next to what the track reported", () => {
    expect(mainTsx).toContain("native=${pressLatency.nativeMs.toFixed(0)}ms");
  });
});

/**
 * D-015 (desktop-fix-journal.md, commit 14 "Not done, the renderer
 * half"): the renderer used to re-derive migrations 1 and 2
 * (unpressablePaste, macFunctionPair) by hand and never implemented
 * migration 3 (winLinuxFunctionPair, BUGS_AUDIT §6.10) — so on a
 * Windows/Linux config still carrying the retired F9/F10 pair, main.js
 * registered the migrated accelerator while Settings kept showing F9
 * and the next autosave wrote F9/F10 back to disk, forever. Fixed by
 * importing desktop/shortcut-migration.js's migrateShortcutPair instead
 * of re-deriving the rule — it is pure CommonJS with zero Node
 * dependencies, so it bundles into the renderer exactly like
 * shortcut-defaults.json's data already does.
 */
describe("the renderer runs the SAME shortcut migration rule as desktop/main.js (D-015)", () => {
  it("main.tsx imports migrateShortcutPair from the shared module, not a re-derived copy", () => {
    expect(mainTsx).toMatch(
      /import \{ migrateShortcutPair \} from "\.\.\/\.\.\/desktop\/shortcut-migration\.js";/,
    );
    expect(mainTsx).toContain("migrateShortcutPair(stored, {");
    // The two hand-written `if` blocks this replaced are gone — a
    // returning copy of either would mean the rule has two homes again.
    expect(mainTsx).not.toMatch(/LEGACY_SHORTCUTS\.unpressablePaste/);
    expect(mainTsx).not.toMatch(/LEGACY_SHORTCUTS\.macFunctionPair/);
  });

  it("migrateShortcutPair, imported the same way main.tsx imports it, migrates all three retired pairs", () => {
    // Migration 3 (winLinuxFunctionPair) — the one the renderer never
    // implemented by hand. Proven here on Windows/Linux platform.
    const win = migrateShortcutPair(
      { record: "F9", paste: "F10" },
      {
        manifest: shortcutDefaultsManifest,
        defaults: shortcutDefaultsManifest.platformDefaults.default,
        platform: "other",
      },
    );
    expect(win.record).toBe(shortcutDefaultsManifest.platformDefaults.default.record);
    expect(win.paste).toBe(shortcutDefaultsManifest.platformDefaults.default.paste);
    expect(win.applied.map((s: { id: string }) => s.id)).toContain("winLinuxFunctionPair");

    // Migration 2 (macFunctionPair) — still exercised through the same
    // shared call the renderer now makes.
    const mac = migrateShortcutPair(
      { record: "F9", paste: "F10" },
      {
        manifest: shortcutDefaultsManifest,
        defaults: shortcutDefaultsManifest.platformDefaults.darwin,
        platform: "darwin",
      },
    );
    expect(mac.record).toBe(shortcutDefaultsManifest.platformDefaults.darwin.record);
    expect(mac.applied.map((s: { id: string }) => s.id)).toContain("macFunctionPair");

    // A user's own choice is left alone.
    const custom = migrateShortcutPair(
      { record: "F11", paste: "Control+Alt+Shift+V" },
      {
        manifest: shortcutDefaultsManifest,
        defaults: shortcutDefaultsManifest.platformDefaults.default,
        platform: "other",
      },
    );
    expect(custom.applied).toEqual([]);
    expect(custom.record).toBe("F11");
  });
});

/**
 * 2026-09-05 (user request): the Live view carried a paragraph under the
 * MIC/LANG/REC row (``#languageAutoHint`` with its ``#languageAutoDualHint``
 * span) explaining the Auto/dual-stream trade-off. Settings › API Keys
 * already explains the same trade-off next to the controls it governs
 * (``deepgramDualStreamNote``, written from ``dualStreamTradeOffText``) —
 * a second copy under the recording controls was clutter, not a second
 * fact. Removed entirely from the Live view; Settings keeps its one note
 * and the Auto-dependent show/hide of the dual-stream row.
 */
describe("Live topbar carries no Auto/dual-stream hint (2026-09-05)", () => {
  const recordViewMatch = /<section class="view" data-view="record">[\s\S]*?<div class="split">/.exec(html);

  it("the Live (record) view's markup is still found in one piece — the boundary this test relies on", () => {
    expect(recordViewMatch, "record view section not found in index.html").toBeTruthy();
  });

  it("the Live topbar has no #languageAutoHint / #languageAutoDualHint element", () => {
    const recordViewHtml = String(recordViewMatch?.[0] || "");
    expect(recordViewHtml).not.toMatch(/id="languageAutoHint"/);
    expect(recordViewHtml).not.toMatch(/id="languageAutoDualHint"/);
    expect(recordViewHtml).not.toMatch(/topbar-hint/);
  });

  it("Settings keeps its own dual-stream note, wired to the shared trade-off text", () => {
    expect(html).toMatch(/id="deepgramDualStreamNote"/);
    expect(mainTsx).toContain('dualNote.textContent = dualStreamTradeOffText()');
  });

  it("syncAutoLanguageUi still toggles the dual-stream row's visibility from #language, with no hint element left to touch", () => {
    const fnBlock = /function syncAutoLanguageUi\(\): void \{([\s\S]*?)\n\}/.exec(mainTsx)?.[1];
    expect(fnBlock, "syncAutoLanguageUi not found").toBeTruthy();
    const body = String(fnBlock);
    expect(body).toContain('document.getElementById("deepgramDualStreamRow")');
    expect(body).not.toContain("languageAutoHint");
    expect(body).not.toContain("languageAutoDualHint");
  });
});

/**
 * B-041 (2026-09-05): the LIVE PREVIEW pane doubled a whole transcript
 * after a stop while the TRANSCRIBE pane (envelope.text, delivered
 * verbatim — see the F/7 describe block above) showed it once. Root
 * cause: the envelope's segments were appended onto a buffer that
 * already held the same speech from the incremental
 * segments/interim stream, and their timings didn't line up closely
 * enough for the segment-level dedup to see the overlap. Fixed with ONE
 * rule, pure-function-tested in transcript-merge.test.ts
 * (composeLivePreviewText): once a session's envelope has resolved, the
 * preview shows it verbatim, never unioned with the incremental
 * reading. This pins the WIRING — that scheduleLiveOutputRender actually
 * calls that rule instead of always taking the pre-envelope floor path.
 */
describe("the live preview defers to a resolved envelope, verbatim (B-041)", () => {
  const fnBlock = /function scheduleLiveOutputRender\(\): void \{([\s\S]*?)\nfunction syncLiveOutputFromState/.exec(mainTsx)?.[1];

  it("the boundary markers used to isolate scheduleLiveOutputRender's body are still present", () => {
    expect(fnBlock, "scheduleLiveOutputRender (or its end marker) not found in main.tsx").toBeTruthy();
  });

  it("reads the ACTIVE session's slot and treats an errored/absent envelope as not-yet-resolved (envelopeMissing), not a bare null check", () => {
    const body = String(fnBlock);
    expect(body).toContain("liveFinalSlots.get(activeUiSessionToken)");
    expect(body).toMatch(/envelopeMissing\(sessionEnvelope\)/);
  });

  it("a resolved envelope goes through composeLivePreviewText, bypassing the pre-envelope richerTranscript floor", () => {
    const body = String(fnBlock);
    const composeCall = body.indexOf("composeLivePreviewText(candidate, resolvedEnvelopeText)");
    const floorCall = body.indexOf("richerTranscript(livePreviewFloorText, candidate)");
    expect(composeCall, "composeLivePreviewText call not found").toBeGreaterThanOrEqual(0);
    expect(floorCall, "richerTranscript floor call not found").toBeGreaterThan(composeCall);
    // Both branches must be reachable from ONE ternary keyed on whether
    // the envelope resolved — not two independent unconditional writes
    // to the displayed text.
    const ternaryCondition = body.slice(0, composeCall).slice(-80);
    expect(ternaryCondition).toMatch(/resolvedEnvelopeText\s*!==\s*null\s*\n?\s*\?\s*$/);
  });
});

describe("live half: one rule per fact, no dead state (FL-05/06/09/14/15/16/17/18)", () => {
  const liveCoverageSrc = readFileSync(resolve(process.cwd(), "src/live-coverage.ts"), "utf8");
  const screenAnnotationsSrc = readFileSync(resolve(process.cwd(), "src/screen-annotations.ts"), "utf8");

  it("FL-14: the dead projections, aliases and the never-reassigned promise are gone", () => {
    for (const dead of [
      "liveTranscriptSegments",
      "let liveWsMode",
      "clearRecordingFinalSignal",
      "publishRecordingFinalSignal",
      "remoteApiPromise",
      "signalText",
    ]) {
      expect(mainTsx, dead).not.toContain(dead);
    }
  });

  it("FL-15: live-coverage compares against the exported source constant, not a literal", () => {
    expect(liveCoverageSrc).toContain("envelope.source !== LOCAL_ASSIST_SOURCE");
    expect(liveCoverageSrc).not.toContain('"local-assist"');
  });

  it("FL-18: screen-annotations counts words with text-match's countWords", () => {
    expect(screenAnnotationsSrc).toContain('import { countWords } from "./text-match";');
    expect(screenAnnotationsSrc).not.toMatch(/function countWords\(/);
  });

  // The screen-marks composer adds a header and a summary on every call,
  // so it must only ever be handed spoken words. The one input that could
  // carry an annotated final is a crash draft's transcript (the panel's
  // text): the panel is cleared before a take's first autosave, and the
  // draft is written for the last time when the stop begins — before any
  // final, with or without marks, reaches the panel.
  it("a crash draft never holds an annotated final: the panel is cleared before the first autosave, the last one precedes the final", () => {
    expect(mainTsx).toContain('transcript_text: ($("finalOutput").textContent || "").trim()');
    expect(mainTsx.match(/persistLiveDraft\((true|false)\)/g)).toEqual([
      "persistLiveDraft(true)",
      "persistLiveDraft(true)",
      "persistLiveDraft(false)",
    ]);
    const startLive = mainTsx.slice(mainTsx.indexOf("async function startLive("));
    expect(startLive.indexOf("resetOutputs();")).toBeGreaterThan(0);
    expect(startLive.indexOf("resetOutputs();")).toBeLessThan(startLive.indexOf("persistLiveDraft(true)"));
    const lastAutosave = mainTsx.indexOf("persistLiveDraft(false)");
    const firstScreenAnnotate = mainTsx.indexOf("annotateTranscript(text, screenAnnotation");
    expect(lastAutosave).toBeGreaterThan(0);
    expect(firstScreenAnnotate).toBeGreaterThan(lastAutosave);
    // Every composer call in the renderer starts from words, never from
    // the panel's text.
    for (const call of mainTsx.match(/annotateTranscript\([^,]+,/g) || []) {
      expect(call, call).not.toContain("finalOutput");
    }
  });

  it("FL-06: the pre-open buffer cap is a duration at the live sample rate, not 64 000 samples", () => {
    expect(mainTsx).not.toContain("WS_PENDING_MAX_SAMPLES");
    expect(mainTsx).toContain("LIVE_SAMPLE_RATE_HZ * WS_PENDING_MAX_SEC");
    expect(mainTsx).toContain("wsPendingFrames.enqueue(pcm, ds.length)");
    expect(mainTsx).toContain("const WS_PENDING_MAX_SEC = 10;");
  });

  it("FL-17: no PCM16 encode without a socket to send it to", () => {
    const fn = mainTsxSlice("function pushCapturedFrame(", "\nasync function flushWorkletPort(");
    expect(fn, "pushCapturedFrame not found").toBeTruthy();
    const guard = fn.indexOf("if (!ws) return;");
    const encode = fn.indexOf("new ArrayBuffer(ds.length * 2)");
    expect(guard).toBeGreaterThan(0);
    expect(encode).toBeGreaterThan(guard);
  });

  it("FL-05: the final envelope is the parsed message minus its type, and the WS diarize comes from the snapshot", () => {
    const handler = /case "final": \{([\s\S]*?)\n {6}\}/.exec(mainTsx)?.[1] || "";
    expect(handler).toContain("const { type: _type, ...fields } = msg;");
    expect(handler).toContain("...fields,");
    expect(mainTsx).toContain('diarize: activeLiveSessionSnapshot.diarize ? "true" : "false",');
  });

  it("FL-09: the mic-fallback notice is a session notice, not text the next preview event overwrites", () => {
    const fn = mainTsxSlice("function showMicFallbackNotice(): void {", "\n}\n");
    expect(fn).toContain("showRecordSessionNotice(");
    expect(fn).not.toContain("setLiveDraftState(");
  });

  it("FL-16: comments name functions that exist", () => {
    expect(mainTsx).not.toContain("holdWarmCapture");
    expect(mainTsx).not.toContain("through the same ``transcribe-on-disk`` chain the manual");
  });
});

describe("boot, update check and History bootstrap (FQ-13/FQ-14/FQ-15/FQ-22)", () => {
  it("FU-03/FU-04: Delete all reports once, through apiDelete, and never writes the viewer body", () => {
    const handler = mainTsxSlice('$("deleteAllConfirmBtn").addEventListener("click", async () => {', "\n});\n");
    expect(handler).toContain('await apiDelete<{ deleted?: unknown; failed?: unknown }>("/api/recordings")');
    expect(handler).not.toContain("showRecordSessionNotice(");
    expect(handler).not.toContain('$("recordingContent").textContent');
    expect(handler).toContain("historyFailureSurfaces(!!selectedRecordingName).placeholder");
  });

  it("FG-08: the previous run's draft is read once, first, and before a session's first autosave", () => {
    const boot = mainTsxSlice("async function initRecordingsBootstrap(): Promise<void> {", "\n}\n");
    expect(boot.indexOf("void readStaleLiveDraftOnce();")).toBeGreaterThan(0);
    expect(boot.indexOf("void readStaleLiveDraftOnce();")).toBeLessThan(boot.indexOf("await loadRecordings(false);"));
    const start = mainTsxSlice("async function prepareLiveSession(", "\n}\n");
    const read = start.indexOf("readStaleLiveDraftOnce()");
    expect(read).toBeGreaterThan(0);
    expect(start.indexOf("persistLiveDraft(true);")).toBeGreaterThan(read);
    const recover = mainTsxSlice("async function recoverLiveDraftIfAny(", "\n}\n");
    expect(recover).toContain("await readStaleLiveDraftOnce();");
    expect(recover).not.toContain("readBackendLiveDraft(");
    // One clear, gated by FG-08, and only once the draft's text is saved.
    expect(recover.match(/mayClearRecoveredDraft\(sessionId, liveDraftSlotWrittenThisRun\)/g) || []).toHaveLength(1);
    expect(recover).toContain("if (draft && draftSaved) {");
  });

  it("the microphone is asked for at the press; the session — archive folder, socket, storage, draft — runs beside it (OPTIMIZATION.md §3.4, P2-4)", () => {
    // The order itself is behaviour-tested in live-start.test.ts; this pins
    // that startLive runs through it with the capture and session split there.
    const start = mainTsxSlice("async function startLive(", "\n}\n");
    expect(start).toContain("await runLiveStart<LiveCapture, LiveStartSession>({");
    expect(start).toContain("beginCapture: () => beginLiveCapture(startAttemptSeq),");
    expect(start).toContain("prepareSession: () => prepareLiveSession(startAttemptSeq),");
    expect(start).not.toContain("await archiveReady");
    // The session branch holds every wait the microphone no longer stands behind.
    const session = mainTsxSlice("async function prepareLiveSession(", "\n}\n");
    expect(session).toContain("sessionArchiveDir = await archiveReady;");
    expect(session).toContain("new WebSocket(");
    expect(session).toContain("pcmSink = new DeferredPcmSink(");
    expect(session).toContain("readStaleLiveDraftOnce()");
    expect(session).not.toMatch(/await createPcmSink\(/);
    expect(session).not.toMatch(/await Promise\.race\(\[readStaleLiveDraftOnce\(\)/);
    expect(session).not.toContain("acquireMicStream(");
    // The capture branch opens the device and prepares the graph, and waits on none of them.
    const capture = mainTsxSlice("function beginLiveCapture(", "\n}\n") + mainTsxSlice("function beginColdLiveCapture(", "\n}\n");
    expect(capture).toContain("acquireMicStream(deviceId, fallbackToDefault)");
    expect(capture).toContain("prepareGraph: prepareCaptureGraph,");
    expect(capture).not.toMatch(/\bawait archiveReady|new WebSocket\(|DeferredPcmSink|readStaleLiveDraftOnce/);
    // Whether it may run ahead of a fresh device list is the one rule's
    // (./live-start planColdCapture), asked of the list's currency.
    expect(capture).toContain("listCurrent: knownAudioInputsCurrent(),");
    expect(capture).toContain("mode: plan.mode,");
    expect(mainTsxSlice("async function loadMics(", "\n}\n")).toMatch(
      /const changesBefore = audioInputChanges;\s*const devs = await navigator\.mediaDevices\.enumerateDevices\(\);\s*knownAudioInputsAfterChanges = changesBefore;/,
    );
    expect(mainTsx).toMatch(/"devicechange", \(\) => \{\s*releaseWarmCaptureOnLifecycle\("devicechange"\);\s*noteAudioInputsChanged\(\);/);
    // The phases stay visible in the start line, each on its branch (./start-trace).
    for (const [phase, branch] of [
      ["archiveReady", "session"], ["wsRequested", "session"], ["sessionReady", "session"],
      ["staleDraftRead", "side"], ["pcmSink", "side"],
      ["captureConnected", "capture"], ["warmWorkletStart", "capture"],
    ]) {
      expect(mainTsx).toContain(`markStartPhase("${phase}", "${branch}")`);
    }
    expect(mainTsxSlice("function pushCapturedFrame(", "\nfunction ")).toContain("summarizeStartTrace(startMarks, totalMs)");
  });

  it("Bluetooth → built-in mic: one setting, off by default, decided by chooseCaptureDevice on both start paths", () => {
    expect(html).toMatch(/id="bluetoothBuiltinMicToggle" \/>/);
    expect(mainTsxSlice("function collectUiPreferences(", "\n}\n")).toContain("bluetooth_builtin_mic: readBluetoothBuiltinMicEnabled(),");
    expect(mainTsx).toContain('($("bluetoothBuiltinMicToggle") as HTMLInputElement).checked = ui.bluetooth_builtin_mic === true;');
    // A take the built-in mic barely heard says so, once per launch.
    expect(mainTsxSlice("async function stopLive(", "\nasync function ")).toContain("warnBuiltInMicBarelyHeard(captureLevel, recordedMs)");
    const begin = mainTsxSlice("function beginLiveCapture(", "\n}\n");
    const cold = mainTsxSlice("function beginColdLiveCapture(", "\n}\n");
    const connect = mainTsxSlice("async function connectLiveCapture(", "\nasync function ");
    // One chooser, asked on both lists: the warm path reuses the hold only
    // for the device the choice names; the cold path opens that device and
    // chooses again on the freshly enumerated list (./live-start reopens
    // when the answers differ).
    expect(mainTsxSlice("function chooseLiveMic(", "\n}\n").match(/chooseCaptureDevice\(\{/g) || []).toHaveLength(1);
    expect(mainTsx.match(/chooseCaptureDevice\(\{/g) || []).toHaveLength(1);
    expect(begin).toContain("const mic = chooseLiveMic();");
    expect(cold).toContain("initialChoice: mic,");
    expect(cold).toMatch(/refreshChoice: async \(\) => \{\s*await loadMics\(false\);\s*return chooseLiveMic\(\);/);
    // The held graph is only checked at the press and taken at the connect,
    // so a start that fails before it leaves the hold — its one owner — intact.
    expect(begin).toContain("if (warmCaptureReusable(mic.deviceId)) {");
    expect(begin).not.toContain("takeWarmCapture(");
    expect(connect).toContain('const warm = capture.kind === "warm" ? takeWarmCapture(capture.mic.deviceId) : null;');
    expect(mainTsxSlice("function abandonLiveCapture(", "\n}\n")).not.toMatch(/releaseWarmCapture|\.close\(|getTracks/);
    expect(connect).toContain("choice=${micChoice.reason}");
    // A hot-plugged headset refreshes the list the next choice uses.
    expect(mainTsx).toMatch(/"devicechange", \(\) => \{\s*releaseWarmCaptureOnLifecycle\("devicechange"\);[\s\S]{0,200}void loadMics\(false\);/);
  });

  it("the picked microphone is a stored intent (./mic-preference) that only a pick in the Mic list changes", () => {
    // Settings persist the stored pick, never what the list happens to show.
    const collect = mainTsxSlice("function collectUiPreferences(", "\n}\n");
    expect(collect).toContain("...micPreferenceToStored(micPreference),");
    expect(collect).not.toContain("micSelect");
    expect(mainTsx).toContain("micPreference = micPreferenceFromStored(ui);");
    // Exactly two writers: the config load above and the user's pick.
    expect(mainTsx.match(/\bmicPreference = /g) || []).toHaveLength(2);
    expect(mainTsx).toContain("const next = micPreferenceFromPick(sel.value, knownAudioInputs, micPreference);");
    // Both start paths resolve the pick on the list they choose against:
    // the one chooser resolves it afresh every time it is asked.
    const chooser = mainTsxSlice("function chooseLiveMic(", "\n}\n");
    expect(chooser.indexOf("const micResolution = resolveRequestedMic();")).toBeGreaterThan(0);
    expect(chooser.indexOf("requestedDeviceId: micResolution.deviceId,")).toBeGreaterThan(chooser.indexOf("const micResolution = resolveRequestedMic();"));
    expect(mainTsx.match(/resolveRequestedMic\(\)/g) || []).toHaveLength(2); // its definition and the one chooser
    expect(mainTsxSlice("async function startLive(", "\nasync function stopLive(")).not.toContain("micSelect");
    expect(mainTsxSlice("async function connectLiveCapture(", "\nasync function ")).toContain("pick=${micResolution.kind}");
    // The list is rendered from the pick, not from its previous value.
    expect(mainTsxSlice("async function loadMics(", "\n}\n")).toContain("renderMicPicker();");
  });

  it("a crashed take's draft is joined with the entry its audio was promoted into (./take-recovery)", () => {
    const boot = mainTsxSlice("async function initRecordingsBootstrap(): Promise<void> {", "\n}\n");
    const promote = boot.indexOf("promoted = await recoverBackendAudioSessions();");
    expect(promote).toBeGreaterThan(0);
    expect(boot.indexOf("await recoverLiveDraftIfAny(promoted);")).toBeGreaterThan(promote);
    const recover = mainTsxSlice("async function recoverLiveDraftIfAny(", "\n}\n");
    expect(recover).toContain("const plan = planTakeRecovery(draft, promoted);");
    expect(recover).toContain("requireExisting: true,");
  });

  it("FQ-13 / FU-17 (M1): the update check stamps and renders by updateCheckOutcome, per trigger", () => {
    // The decision is behaviour-tested in update-check.test.ts; this pins
    // that the one caller asks it instead of restating the rule inline.
    const fn = mainTsxSlice("async function runUpdateCheck(trigger: UpdateCheckTrigger): Promise<void> {", "\n}\n");
    const decide = fn.indexOf("const outcome = updateCheckOutcome(result, trigger);");
    expect(decide).toBeGreaterThan(0);
    expect(fn.indexOf("if (outcome.stamp) {")).toBeGreaterThan(decide);
    expect(fn.indexOf("if (!outcome.render) {")).toBeGreaterThan(decide);
    expect(fn).not.toContain('result.status !== "unknown"');
    expect(mainTsx).toContain('void runUpdateCheck("user");');
    expect(mainTsx).toContain('void runUpdateCheck("boot");');
    expect(mainTsx).not.toMatch(/\}, 4000\);/);
  });

  it("FQ-14: the classifier lives in ./boot-error and every raw error gets its disclosure", () => {
    expect(mainTsx).toContain('import { classifyBootError, type BootFailure } from "./boot-error";');
    expect(mainTsx).not.toMatch(/function classifyBootError\(/);
    expect(mainTsx).not.toContain("raw !== detail");
  });

  it("FQ-15: bootstrap failures reach the status line, and the boot race clears only its own promise", () => {
    const init = mainTsxSlice("async function initRecordingsBootstrap(): Promise<void> {", "\n}\n");
    expect(init).toContain('setStatus(`${said.charAt(0).toUpperCase()}${said.slice(1)}. Restart the app to try again.`, "warning");');
    expect(mainTsx).toMatch(/if \(recordingsBootstrapPromise === bootRecordingsBootstrap\) \{\s*recordingsBootstrapPromise = null;/);
  });

  it("FQ-22: no overlay state written right before the page reloads", () => {
    const retry = mainTsxSlice('_bootRetry.addEventListener("click", () => {', "window.location.reload();");
    expect(retry).toBeTruthy();
    expect(retry).not.toContain("_bootOverlayHidden");
  });
});

describe("live socket close handler (FL-03)", () => {
  const handler = /ws\.onclose = \(ev\) => \{([\s\S]*?)\n {4}\};/.exec(mainTsx)?.[1] || "";

  it("records the error envelope through liveCloseOwesErrorEnvelope, without bailing out on a missing slot", () => {
    expect(handler, "ws.onclose handler not found").toBeTruthy();
    expect(handler).toContain("liveCloseOwesErrorEnvelope({");
    expect(handler).toContain("resolveLiveFinal(sessionUiToken, {");
    expect(handler).not.toMatch(/if \(!slot\) return;/);
  });
});

describe("S-15: the History player streams instead of fetching the whole file", () => {
  it("openRecording plays a minted stream URL and never builds a Blob of the audio", () => {
    const open = mainTsxSlice("async function openRecording(", "\n}\n");
    expect(open).toContain("mintRecordingStreamUrl(name, audioArchiveDir)");
    expect(open).toContain("player.src = minted.url;");
    expect(open).not.toContain("fetchSavedAudioFromBackend(");
    expect(open).not.toContain("createObjectURL(");
  });
});

/** Slice one top-level function of main.tsx, from its header to the next marker. */
function mainTsxSlice(header: string, next: string): string {
  const start = mainTsx.indexOf(header);
  const end = mainTsx.indexOf(next, start + header.length);
  return start !== -1 && end > start ? mainTsx.slice(start, end) : "";
}

/**
 * FQ-01 / FQ-05 / FQ-18: the upload queue's "transcript finished, History
 * save failed" state. The decisions are behaviour-tested in
 * upload-item.test.ts; this pins that the queue actually uses them.
 */
describe("upload queue wiring for a failed History save (FQ-01/FQ-05/FQ-18)", () => {
  it("both the queue row and the result pane render the error state through uploadErrorView", () => {
    const row = mainTsxSlice("function renderUploadQueue(): void {", "\nfunction renderUploadResultPane(");
    const pane = mainTsxSlice("function renderUploadResultPane(): void {", "\nsetupUploadView();");
    expect(row).toContain("uploadErrorView(item)");
    expect(pane).toContain("uploadErrorView(item)");
  });

  it("Retry asks uploadRetryPlan and a save-only retry goes through the one save helper", () => {
    const retry = mainTsxSlice("async function retryUploadItem(", "\n}\n");
    expect(retry).toContain('uploadRetryPlan(item) === "save"');
    expect(retry).toContain("await saveUploadItemToHistory(item,");
    // The processor and the retry share the save; nothing else saves uploads.
    const processor = mainTsxSlice("async function processUploadItem(", "\nasync function saveUploadItemToHistory(");
    expect(processor).toContain("await saveUploadItemToHistory(item, text,");
    expect(processor).not.toContain("saveRecordingText(");
  });

  it("'Clear done' filters by isUploadClearable", () => {
    expect(mainTsx).toMatch(/if \(isUploadClearable\(uploadQueue\[i\]\)\) \{\s*uploadQueue\.splice\(i, 1\);/);
  });

  it("FQ-02: a failed queue snapshot write re-arms the dirty flag and goes through the retry policy", () => {
    const flush = mainTsxSlice("async function flushUploadQueueSnapshotNow(", "\nfunction saveUploadQueueSnapshot(");
    const catchBlock = /\.catch\(\(e\) => \{([\s\S]*?)\n {4}\}\);/.exec(flush)?.[1];
    expect(catchBlock, "the PUT's catch block was not found").toBeTruthy();
    expect(String(catchBlock)).toContain("uploadQueueSavePending = true;");
    expect(flush).toContain("nextQueueSaveRetry(uploadQueueSaveFailures)");
    expect(flush).toContain("setStatus(UPLOAD_QUEUE_SAVE_FAILED_STATUS, \"warning\")");
  });

  it("FQ-03: the unload flush listens to pagehide only", () => {
    expect(mainTsx).toContain('window.addEventListener("pagehide", flushUploadQueueSnapshotBestEffort');
    expect(mainTsx).not.toContain('window.addEventListener("beforeunload", flushUploadQueueSnapshotBestEffort');
  });

  it("FQ-06/FQ-07: no invented progress; the stage flips once, when the transport reports the job created", () => {
    expect(mainTsx).not.toContain("uploadProgress");
    // The size-guessed timer and the poll-tick hook are gone; the one source
    // is the transport's onJobCreated (behaviour: job-poll / upload-item tests).
    expect(mainTsx).not.toContain("_stageTimer");
    expect(mainTsx).not.toContain("onProcessingProgress");
    expect(mainTsx).toContain("if (enterUploadProcessingStage(item)) renderUploadQueue();");
    expect(mainTsx.match(/createThenWaitForJob\(/g) || []).toHaveLength(4);
  });

  it("FQ-08: the pump starts the oldest queued item", () => {
    const pump = mainTsxSlice("function runUploadProcessor(): void {", "\nasync function processUploadItem(");
    expect(pump).toContain("pickNextQueuedUpload(uploadQueue)");
    expect(pump).not.toContain('uploadQueue.find((it) => it.status === "queued")');
  });

  it("FQ-09: nothing is enqueued while the server queue is unknown", () => {
    const fn = mainTsxSlice("function afterUploadQueueSnapshotLoaded(", "\nfunction flushUploadQueueSnapshotBestEffort(");
    expect(fn).toMatch(/\.then\(\(\) => \{\s*if \(uploadQueueSnapshotLoaded\) \{\s*action\(\);/);
  });

  it("FQ-10/FQ-11: one provider normaliser and one source validator", () => {
    const norm = mainTsxSlice("function normalizeUploadProvider(", "\n}\n");
    expect(norm).toContain("normalizeProviderSelection(value, UI_TOKENS.upload.defaultProvider)");
    expect(mainTsx).not.toMatch(/function uploadExtensionFromName\(/);
    expect(mainTsx.match(/uploadSourceValidationError\(\{/g) || []).toHaveLength(1);
  });

  it("FQ-16/FQ-19: rows are keyboard buttons, the title counts done only, one filter rule, one pane render", () => {
    const row = mainTsxSlice("function renderUploadQueue(): void {", "\nfunction renderUploadResultPane(");
    expect(row).toContain('li.setAttribute("role", "button");');
    expect(row).toContain("li.tabIndex = 0;");
    expect(row).toContain("uploadQueueTitle(uploadQueue.map((it) => it.status))");
    expect(row).toContain("uploadQueue.filter(isUploadVisibleUnderCurrentFilter)");
    expect(row.match(/renderUploadPersistenceNote\(\);/g) || []).toHaveLength(1);
    expect(mainTsx).not.toContain("isUploadPastItem");
  });

  it("FQ-20: the window-level drop blocker cancels file drags only", () => {
    expect(mainTsx).toContain('.includes("Files")) return;');
  });

  it("FQ-21: upload timings are one clock (epoch ms)", () => {
    const upload = mainTsx.slice(mainTsx.indexOf("async function processUploadItem("), mainTsx.indexOf("function renderUploadPersistenceNote("));
    expect(upload).not.toMatch(/(startedAt|endedAt) = performance\.now\(\)/);
  });

  it("FQ-22: no dead File.path fallback, no abort of a settled item, Retry for cancelled items", () => {
    expect(mainTsx).not.toContain("{ path?: string }).path");
    const retry = mainTsxSlice("async function retryUploadItem(", "\n}\n");
    expect(retry).not.toContain("abortController?.abort()");
    expect(retry).toContain("uploadItemRetryable(item.status)");
  });

  it("the save stage cannot be 'stopped': cancel ignores it and the Stop button is disabled", () => {
    expect(mainTsx).toContain('if (item.cancelRequested || item.stage === "saving") return;');
    expect(mainTsx).toContain('stopBtn.disabled = item.cancelRequested === true || item.stage === "saving";');
  });
});

/**
 * Screen mode's "record clicks" setting (2026-11-21): one stored value
 * (preferences.ui.screen_clicks, off unless explicitly true — user, 2026-11-21), read by a
 * screen take when it starts and handed to main with the take
 * (desktop/renderer-toggle.js reads `screenClicks`).
 */
describe("screen mode's record-clicks setting", () => {
  it("is a Settings toggle beside the screen-mode hotkeys, hidden with them", () => {
    expect(html).toMatch(/id="screenClicksField" hidden>[\s\S]*?id="screenClicksToggle" \/>/);
    expect(mainTsx).toContain('["shortcutScreenField", "shortcutScreenShotField", "screenClicksField"]');
  });

  it("is saved with the preferences and loads off unless explicitly on", () => {
    expect(mainTsxSlice("function collectUiPreferences(", "\n}\n")).toContain("screen_clicks: readScreenClicksEnabled(),");
    expect(mainTsx).toContain('($("screenClicksToggle") as HTMLInputElement).checked = ui.screen_clicks === true;');
  });

  it("a screen take reads it once at start and reports it with the take", () => {
    expect(mainTsxSlice("async function startLive(", "\n}\n")).toContain('liveScreenClicks = take.mode === "screen" && readScreenClicksEnabled();');
    expect(mainTsx).toMatch(/window\.__transcriptorLiveTake = \(\) => \(\{[\s\S]*?screenClicks: liveScreenClicks,/);
  });
});

/**
 * A new recording is named by when it BEGAN (backend/recording_names.py):
 * every save that files one says so (./recording-save refuses one that
 * does not), and a screen take's marks are placed by the same moment.
 */
describe("every new recording is saved with the moment it began", () => {
  it("a live take: its first sample (or its press), for its audio save and its metadata save", () => {
    expect(mainTsx).toContain("const takeStartedAt = takeStartedAtMs(startAt, startRequestedAt);");
    expect(mainTsx.match(/recordedAtMs: takeStartedAt,/g)).toHaveLength(2);
    expect(mainTsx).not.toContain("screenAudioStartedAt");
  });

  it("an upload: when it started; a recovered draft: its own start", () => {
    expect(mainTsxSlice("async function saveUploadItemToHistory(", "\n}\n")).toContain("recordedAtMs: item.startedAt,");
    expect(mainTsx).toContain("recordedAtMs: Number(draft.started_at) || 0,");
  });
});

/**
 * A preset says what it writes in (backend ``output_language``): both
 * preset dialogs offer the catalog's languages and send the choice, so a
 * translating preset's output is kept by the expected-language filter.
 */
describe("upscale presets carry their output language", () => {
  it("both dialogs have the select and send what it says", () => {
    expect(html).toContain('<select id="upscalePresetOutputLanguage"></select>');
    expect(html).toContain('<select id="upscalePromptOutputLanguage"></select>');
    expect(mainTsx).toContain("{ name, instruction, output_language: outputLanguage }");
    expect(mainTsx).toContain("{ instruction, output_language: outputLanguage }");
  });

  it("the choices are the catalog's own list, after the text's own language", () => {
    expect(mainTsx).toContain("upscaleOutputLanguageOptions = Array.isArray(r.output_language_options)");
    expect(mainTsxSlice("function renderUpscaleOutputLanguageSelect(", "\n}\n")).toContain('const choices = ["", ...upscaleOutputLanguageOptions];');
  });
});

describe("the capsule waveform's display gain", () => {
  it("magnifies the input level 5 times the first 4, for the capsule only (user, 2026-11-21)", () => {
    expect(mainTsx).toContain("vuAmplify: 20,");
    // The only reader of the magnified level is main's capsule probe; the raw
    // RMS (speech detection, auto-stop) is published separately, unscaled.
    expect(mainTsx).toContain("window.__transcriptorRmsLevel = Math.max(0, Number.isFinite(rms) ? rms : 0);");
    expect(mainTsx.match(/__transcriptorVuLevel = [^;]*vuAmplify/g)?.length).toBe(2);
  });
});

describe("the microphone's wake state (./mic-wake)", () => {
  it("the renderer publishes it and the main process's capsule probe is its one reader", () => {
    expect(mainTsx).toContain("window.__transcriptorMicWaking = true;");
    expect(mainTsx).toContain("window.__transcriptorMicWaking = false;");
    expect(desktopMain).toContain("window.__transcriptorMicWaking");
    expect(desktopMain).toContain("micWakeTransition(");
  });

  it("is fed by every captured frame, from the frame's own peak", () => {
    expect(mainTsx).toContain("const wake = micWake.observe(peak, frameMs);");
    // The tracker is reset at the press, with the first-frame bookkeeping.
    expect(mainTsx).toContain("micWake = createMicWakeTracker();");
  });

  it("sounds the ready tone only on the wake, never at the press", () => {
    expect(mainTsx.match(/playRecordingCue\("ready"\)/g)).toHaveLength(1);
    expect(mainTsxSlice("if (wake.justWoke) {", "const frameIsSpeech")).toContain('playRecordingCue("ready")');
  });
});

/**
 * P2-4 (2026-11-24): the warm hold's length is the user's, the graph it
 * keeps opens no output device, and every reason it must be let go is
 * wired to the one release path. The policy itself is behaviour-tested in
 * capture-warm.test.ts and the worklet in pcm-worklet.test.ts; these pins
 * say main.tsx uses exactly those.
 */
describe("the warm hold: its length, its output, and its releases", () => {
  it("takes its length from the setting, and no other place restates it", () => {
    expect(mainTsx).not.toContain("UI_TOKENS.capture.warmHoldMs");
    expect(mainTsx).not.toMatch(/warmHoldMs:\s*\d/);
    expect(mainTsxSlice("function planWarmCaptureHold(", "\nfunction commitWarmCaptureHold(")).toContain("warmHoldMs: warmHoldMs(),");
    expect(mainTsxSlice("function commitWarmCaptureHold(", "\nfunction ")).toContain("warmHoldMs(),");
    // One reader, one resolver: the control names an option id and the
    // table in ./capture-warm says what it means.
    expect(mainTsxSlice("function readMicHoldSetting(", "\n}\n")).toContain('getElementById("micHoldSelect")');
    expect(mainTsxSlice("function warmHoldMs(", "\n}\n")).toContain("warmHoldMsForOption(readMicHoldSetting())");
    // The control offers exactly the table's ids, and says what it costs.
    const select = html.slice(html.indexOf('<select id="micHoldSelect">'), html.indexOf("</select>", html.indexOf('<select id="micHoldSelect">')));
    expect(select).toContain('<option value="30s">');
    expect(select).toContain('<option value="5m">');
    expect(select).toContain('<option value="15m">');
    expect(html).toContain("the macOS microphone indicator stays on");
  });

  it("stores the setting and restores the control from it", () => {
    expect(mainTsxSlice("function collectUiPreferences(", "\n}\n")).toContain("mic_hold: readMicHoldSetting(),");
    expect(mainTsx).toContain('($("micHoldSelect") as HTMLSelectElement).value = warmHoldOptionFor(ui.mic_hold);');
    expect(mainTsxSlice('($("micHoldSelect") as HTMLSelectElement).addEventListener("change", () => {', "\n});"))
      .toContain('releaseWarmCapture("mic-hold-changed")');
  });

  it("keeps the input and opens no output device, on both the branch and the fallback", () => {
    const make = mainTsxSlice("function createSilentCaptureContext(", "\n}\n");
    expect(make).toContain('sinkId: { type: "none" }');
    expect(mainTsxSlice("async function prepareCaptureGraph(", "\n}\n")).toContain("createSilentCaptureContext()");
    expect(mainTsxSlice("async function connectLiveCapture(", "\nasync function ")).toContain("ac = createSilentCaptureContext();");
  });

  it("is released by the ttl, a locked screen, sleep, a device change, a new pick, a new length and an exit", () => {
    const lifecycle = mainTsxSlice("function releaseWarmCaptureOnLifecycle(", "\n}\n");
    expect(lifecycle).toContain("releaseWarmCapture(reason)");
    expect(mainTsx).toContain('releaseWarmCaptureOnLifecycle("ttl")');
    expect(mainTsx).toContain('releaseWarmCaptureOnLifecycle("pagehide")');
    expect(mainTsx).toContain('releaseWarmCaptureOnLifecycle("devicechange")');
    // The shell forwards the powerMonitor event name; a locked screen is
    // its own reason in the log, not folded into "suspend".
    expect(mainTsx).toContain('kind === "lock-screen" ? "lock-screen" : "system-suspend"');
    expect(mainTsxSlice("function subscribeToSystemSuspend(", "\n}\n")).toContain("releaseWarmCaptureOnLifecycle(why)");
    expect(mainTsxSlice('($("micSelect") as HTMLSelectElement).addEventListener("change", () => {', "\n});"))
      .toContain('releaseWarmCapture("mic-changed")');
  });

  it("is NOT released by the window becoming hidden", () => {
    // Dictation by hotkey runs with the main window hidden or closed; a
    // release on that transition died in exactly the case it exists for.
    expect(mainTsx).not.toContain('releaseWarmCaptureOnLifecycle("window-hidden")');
    const hidden = mainTsxSlice('document.addEventListener("visibilitychange", () => {', "\n});");
    expect(hidden).not.toContain("releaseWarmCapture");
  });

  it("refuses a held device that stopped delivering, and says why in the log", () => {
    const handler = mainTsxSlice("function handleWorkletMessage(", "\nfunction ");
    expect(handler).toContain('data.type === "signal"');
    expect(handler).toContain("held.silent = data.silent === true;");
    expect(mainTsxSlice("function warmReuseDecision(", "\n}\n")).toContain("audioSilent: held.silent,");
    expect(mainTsxSlice("function commitWarmCaptureHold(", "\nfunction ")).toContain("silent: false,");
    // The release trace reaches main.log: INFO + a mirrored prefix.
    expect(mainTsx).toContain("console.info(`[trace warmCapture] released reason=${reason} heldMs=${heldMs}`);");
    expect(mainTsxSlice("function releaseWarmCapture(", "\n}\n")).toContain("console.info(");
  });
});
