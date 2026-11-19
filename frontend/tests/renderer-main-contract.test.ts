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
 * `window.__transcriptorFinishedRecords` is a two-process contract: the
 * renderer trims the list when it writes, and `desktop/main.js` trims
 * again when it reads. Both trimmed to a depth written out as a literal
 * on each side, with nothing connecting them — a renderer that kept
 * fewer than the main process expects silently shortens the paste
 * history, and the main process cannot import the renderer's constants.
 * So the two are pinned here.
 */
const mainTsx = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const desktopMain = readFileSync(resolve(process.cwd(), "../desktop/main.js"), "utf8");

describe("__transcriptorFinishedRecords depth", () => {
  const declared = /FINISHED_RECORDS_KEPT\s*=\s*(\d+)/.exec(mainTsx)?.[1];

  it("is a named constant on the renderer side", () => {
    expect(declared, "FINISHED_RECORDS_KEPT not found in main.tsx").toBeTruthy();
    expect(mainTsx).toContain("next.slice(-FINISHED_RECORDS_KEPT)");
  });

  it("matches the depth desktop/main.js trims to when it reads the list", () => {
    // The main process names its own copy now
    // (RENDERER_FINISHED_RECORDS_LIMIT), and interpolates it into the
    // injected script — so read the constant, not the call site.
    const block = desktopMain.slice(desktopMain.indexOf("__transcriptorFinishedRecords"));
    const usesNamedLimit = /\.slice\(-\$\{RENDERER_FINISHED_RECORDS_LIMIT\}\)/.test(block);
    const desktopDepth = usesNamedLimit
      ? /RENDERER_FINISHED_RECORDS_LIMIT\s*=\s*(\d+)/.exec(desktopMain)?.[1]
      : /\.slice\(-(\d+)\)/.exec(block)?.[1];
    expect(desktopDepth, "no finished-records trim depth found in desktop/main.js").toBeTruthy();
    expect(Number(desktopDepth)).toBe(Number(declared));
  });
});

/**
 * The document.title bridge. Three messages, two processes, and until
 * now four independent string literals on the renderer side alone.
 */
describe("the title bridge prefixes match desktop/main.js", () => {
  const desktopMain = readFileSync(resolve(process.cwd(), "../desktop/main.js"), "utf8");

  it("declares each prefix once in the renderer", () => {
    const block = /TITLE_BRIDGE_PREFIX = \{([\s\S]*?)\} as const;/.exec(mainTsx)?.[1];
    expect(block, "TITLE_BRIDGE_PREFIX not found").toBeTruthy();
    const prefixes = Array.from(String(block).matchAll(/"(__app_[a-z_]+__)"/g)).map((m) => m[1]);
    expect(prefixes.sort()).toEqual([
      "__app_record_toggle__",
      "__app_reveal_recording__",
      "__app_shortcuts__",
    ]);
    for (const prefix of prefixes) {
      // Once in the declaration, nowhere else: the three call sites go
      // through postTitleBridgeMessage.
      expect(mainTsx.split(`"${prefix}"`).length - 1, prefix).toBe(1);
    }
  });

  it("is the same set the main process listens for", () => {
    for (const prefix of ["__app_shortcuts__", "__app_record_toggle__", "__app_reveal_recording__"]) {
      expect(desktopMain, prefix).toContain(prefix);
    }
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
 * instead of a manual one-time verification.
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

  it("the seven no-transcript epilogues share one bookkeeping helper, not a copy each", () => {
    const helperCalls = stopLiveBody.match(/releaseStopEpilogueBookkeeping\(\);/g) || [];
    // Six early returns extracted; the seventh (finalization-failed
    // catch) shares the success path's own `finally` instead — see the
    // helper's doc comment for why that one is deliberately left alone.
    expect(helperCalls.length).toBe(6);
    expect(stopLiveBody).toContain("const releaseStopEpilogueBookkeeping = (): void =>");
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

/**
 * The in-window Record button is one control on two surfaces.
 *
 * In the desktop shell it posts `__app_record_toggle__` and the main process
 * owns the microphone prompt, the capsule and the busy guard. In a plain
 * browser tab there is no main process, the sentinel has no consumer, and the
 * button used to do nothing at all — silently, because a title that changes
 * and changes back throws no error.
 *
 * The marker that tells the two apart is `__transcriptorEngine`, exposed
 * unconditionally by desktop/preload.js. Both halves are pinned here because
 * each one alone is a silent failure: a renderer that stops checking records
 * through main's path in a browser (nothing happens), and a preload that stops
 * exposing the marker makes the desktop shell take the browser path — a
 * recording with no permission prompt, no capsule, and no busy guard.
 */
describe("the in-window Record button", () => {
  // The id appears twice: once in setRecordButton, which paints it, and once
  // in the click handler. Only the handler is under test here.
  const start = mainTsx.indexOf('document.getElementById("recordToggleBtn")?.addEventListener');
  const handler = start === -1 ? "" : mainTsx.slice(start, mainTsx.indexOf("});", start) + 3);

  it("has a click handler this test can read", () => {
    expect(handler, 'recordToggleBtn handler not found in main.tsx').toBeTruthy();
  });

  it("asks the main process when there is one", () => {
    // The exact condition, not a mention of the name: a mutated
    // `if (false && window.__transcriptorEngine…)` still contains the string
    // and would slip past a `toContain`, which is how the first version of
    // this guard failed its own mutation test.
    expect(handler).toMatch(/if \(window\.__transcriptorEngine\) \{/);
    expect(handler).toContain("TITLE_BRIDGE_PREFIX.recordToggle");
    // …the sentinel is posted inside that branch AND followed by a return, so
    // the browser path below it is reachable rather than dead code.
    const guard = handler.indexOf("window.__transcriptorEngine");
    const sentinel = handler.indexOf("TITLE_BRIDGE_PREFIX.recordToggle");
    const here = handler.indexOf("toggleRecordingHere()");
    expect(guard).toBeLessThan(sentinel);
    expect(sentinel).toBeLessThan(here);
    expect(handler.slice(sentinel, here)).toContain("return;");
  });

  it("records here when there is none, instead of posting into the void", () => {
    expect(handler).toContain("toggleRecordingHere()");
    // The bridge check must come BEFORE the sentinel, or the browser path is
    // unreachable and the button is dead again.
    expect(handler.indexOf("window.__transcriptorEngine")).toBeLessThan(
      handler.indexOf("TITLE_BRIDGE_PREFIX.recordToggle"),
    );
  });

  it("is backed by a marker the preload really exposes", () => {
    const preload = readFileSync(resolve(process.cwd(), "../desktop/preload.js"), "utf8");
    expect(preload).toContain('contextBridge.exposeInMainWorld("__transcriptorEngine"');
  });

  it("and the hotkey event runs the same toggle, so one path cannot drift", () => {
    expect(mainTsx).toContain('window.addEventListener("transcriptor-hotkey-toggle", toggleRecordingHere)');
  });
});
