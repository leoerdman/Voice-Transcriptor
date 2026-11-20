"use strict";

// The main ↔ renderer IPC channels, as a contract both sides are checked
// against.
//
// A channel name is a string typed twice, in two files, that nothing
// resolves: rename it on one side and the other side goes quiet — no
// exception, no log line, just a feature that stops happening. Nothing
// else in the suite can catch that, because exercising the bridge needs
// a live Electron. Reading the two sources and requiring them to agree
// does not.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");

test("recording-final is sent by the renderer and received by main", () => {
  assert.match(preloadSource, /ipcRenderer\.send\("recording-final"/);
  assert.match(mainSource, /ipcMain\.on\("recording-final"/);
});

test("system-suspend is sent by main and subscribed to by the renderer bridge", () => {
  // The renderer holds a microphone capture warm after a recording and
  // cannot see powerMonitor, which lives in main.
  assert.match(mainSource, /webContents\.send\("system-suspend"/);
  assert.match(preloadSource, /ipcRenderer\.on\("system-suspend"/);
  assert.match(preloadSource, /onSystemSuspend:/, "the bridge is what the renderer actually calls");
  // What this guarantees is that the bridge OFFERS a way off, not that the
  // renderer takes it — a renderer reload destroys the preload world and
  // its listeners with it, so the reload was never the leak. The leak that
  // WAS possible is a renderer that subscribes more than once in one page
  // lifetime and never unsubscribes, which is what the returned function is
  // for. frontend/src/main.tsx's subscribeToSystemSuspend (D-053) now
  // retires its own prior subscription before installing a new one, so a
  // second run of that top-level code (a Vite dev-server HMR update, which
  // re-executes top-level code without a page reload) cannot stack a
  // second listener.
  assert.match(
    preloadSource,
    /ipcRenderer\.removeListener\("system-suspend"/,
    "the bridge must hand back a way to unsubscribe",
  );
  assert.match(
    preloadSource,
    /return \(\) => \{/,
    "onSystemSuspend must RETURN the unsubscribe, not just define one",
  );
});

test("paste-capability:get-status is invoked by the renderer bridge and handled by main (D-009)", () => {
  // Accessibility trust was probed and decided in main
  // (desktop/paste-capability.js) but never reached the renderer as
  // anything but a message AFTER a paste had already failed. An earlier
  // attempt pushed a global via executeJavaScript on a 30-second
  // interval that nothing in frontend/ read; this is the invoke-only
  // replacement, same shape as the engine bridge.
  assert.match(preloadSource, /getStatus: \(\) => ipcRenderer\.invoke\("paste-capability:get-status"\)/);
  assert.match(mainSource, /ipcMain\.handle\("paste-capability:get-status"/);
  assert.match(
    preloadSource,
    /exposeInMainWorld\("__transcriptorPasteCapability"/,
    "must be its own named bridge, not folded into an unrelated one",
  );
});

test("permissions:repair is invoked by the renderer bridge and handled by main", () => {
  // The stale-grant repair the app performs on its own behalf, exposed
  // as an explicit action: `tccutil reset <service> <bundle id>` drops a
  // TCC row whose code signing requirement no longer matches this build.
  // The renderer asks for a repair; it never names a service, a bundle
  // id or a command.
  assert.match(preloadSource, /repair: \(\) => ipcRenderer\.invoke\("permissions:repair"\)/);
  assert.match(mainSource, /ipcMain\.handle\("permissions:repair"/);
  // The bridge takes no arguments at all — no service, no bundle id —
  // and the command itself is built by the capability module behind one
  // function in main, so a renderer cannot ask for a reset of anything
  // but this app's own grants.
  assert.match(mainSource, /permissionRepairCommand\(service, bundleId\)/);
  assert.match(mainSource, /runCommand\(command\.cmd, command\.args\.slice\(\)/);
});

/**
 * Brace depth of `index` inside the block that opens at `open` (the "{"),
 * skipping strings, template literals and comments, so a "{" in a log
 * message or a comment does not count. 1 = directly inside that block.
 */
function blockDepthAt(source, open, index) {
  let depth = 0;
  const templateStack = [];
  for (let i = open; i < index; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") { i = source.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (ch === "/" && next === "*") { i = source.indexOf("*/", i + 2) + 1; if (i <= 0) return -1; continue; }
    if (ch === "\"" || ch === "'") {
      for (i += 1; i < index && source[i] !== ch; i += 1) if (source[i] === "\\") i += 1;
      continue;
    }
    if (ch === "`" || (ch === "}" && templateStack.length && templateStack[templateStack.length - 1] === depth)) {
      if (ch === "}") { templateStack.pop(); depth -= 1; }
      // Inside a template literal: run to its end or to the next ${.
      for (i += 1; i < index; i += 1) {
        if (source[i] === "\\") { i += 1; continue; }
        if (source[i] === "`") break;
        if (source[i] === "$" && source[i + 1] === "{") { depth += 1; templateStack.push(depth); i += 1; break; }
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  return depth;
}

test("main subscribes the power events once, directly inside app.whenReady, with the handlers they need (DX-28)", () => {
  const ready = mainSource.indexOf("app.whenReady().then(async () => {");
  assert.ok(ready >= 0, "app.whenReady() callback not found");
  const open = mainSource.indexOf("{", ready);
  const callAt = mainSource.indexOf("subscribePowerEvents(require(\"electron\").powerMonitor, {");
  assert.ok(callAt > open, "the subscription must be inside app.whenReady");
  assert.equal(mainSource.indexOf("subscribePowerEvents(", callAt + 1), -1, "subscribed from exactly one place");
  assert.equal(blockDepthAt(mainSource, open, callAt), 1, "at the top of the whenReady callback, not nested in a handler");

  // Run main's own call against a fake powerMonitor: every event the app
  // depends on is subscribed, and each reaches the handler main wired.
  const end = mainSource.indexOf("});", callAt) + 3;
  const callText = mainSource.slice(callAt, end);
  const listeners = new Map();
  const powerMonitor = { on: (event, fn) => listeners.set(event, fn) };
  const calls = [];
  const run = new Function(
    "subscribePowerEvents", "require", "registerGlobalShortcuts", "notifyRendererSystemSuspend", "appendMainLog",
    callText,
  );
  run(
    require("./power-events").subscribePowerEvents,
    (name) => (name === "electron" ? { powerMonitor } : require(name)),
    () => calls.push("reclaim"),
    (reason) => calls.push(`release:${reason}`),
    () => { },
  );
  const { POWER_EVENTS } = require("./power-events");
  assert.deepEqual([...listeners.keys()].sort(), [...POWER_EVENTS].sort());
  for (const event of ["resume", "suspend", "lock-screen"]) listeners.get(event)();
  assert.deepEqual(calls, ["reclaim", "release:suspend", "release:lock-screen"]);
});

test("the preload exposes fixed channels only — never raw ipcRenderer", () => {
  // A bridge that hands the renderer `ipcRenderer` (or a send that takes
  // the channel as an argument) gives it every channel in the app.
  //
  // The old assertion used /exposeInMainWorld\([^)]*ipcRenderer\)/, which
  // cannot cross a ")" — so the realistic leak,
  // `exposeInMainWorld("bad", { raw: ipcRenderer })`, matched nothing and
  // the test passed. Scan each exposeInMainWorld call's whole argument
  // list by brace/paren matching instead.
  const exposed = exposeCalls(preloadSource);
  assert.ok(exposed.length >= 1, "the preload must expose at least one bridge");
  for (const call of exposed) {
    assert.ok(
      !/(^|[^.\w])ipcRenderer(\s*[,}\])]|\s*$)/.test(call),
      `ipcRenderer itself must never cross the bridge: ${call.slice(0, 120)}`,
    );
  }

  // Every ipcRenderer method that names a channel must name a literal —
  // `once`, `sendSync`, `postMessage` and `sendTo` included, not just the
  // four the first version of this test happened to list.
  const CHANNEL_METHODS = "send|sendSync|sendTo|postMessage|on|once|off|invoke|removeListener|removeAllListeners";
  const calls = preloadSource.match(new RegExp(`ipcRenderer\\.(?:${CHANNEL_METHODS})\\(([^,)]*)`, "g")) || [];
  assert.ok(calls.length >= 3, "no ipcRenderer channel calls found — the scan matched nothing");
  for (const call of calls) {
    const channel = call.slice(call.indexOf("(") + 1).trim();
    assert.match(channel, /^"[a-z][a-z0-9:-]*"$/, `channel must be a literal, got ${channel}`);
  }
});

/** The full argument text of every `contextBridge.exposeInMainWorld(...)` call. */
function exposeCalls(source) {
  const out = [];
  const marker = "exposeInMainWorld(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at < 0) return out;
    const open = at + marker.length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(" || ch === "{" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          out.push(source.slice(open + 1, i));
          from = i;
          break;
        }
      }
      if (i === source.length - 1) from = source.length;
    }
    if (from <= at) return out;
  }
}

test("screen-mode:finish is invoked by the renderer bridge and handled by main", () => {
  // Screen mode's session (screenshots + stroke times) is owned by main;
  // the renderer's stopLive asks for it back on every stop path.
  assert.match(preloadSource, /ipcRenderer\.invoke\("screen-mode:finish"/);
  assert.match(mainSource, /ipcMain\.handle\("screen-mode:finish"/);
});

test("the main window's requests ride preload sends, not document.title (DM-10)", () => {
  const { RENDERER_REQUEST_CHANNELS } = require("./renderer-requests");
  for (const channel of Object.values(RENDERER_REQUEST_CHANNELS)) {
    assert.match(preloadSource, new RegExp(`ipcRenderer\\.send\\("${channel}"`), `preload must send ${channel}`);
  }
  for (const key of Object.keys(RENDERER_REQUEST_CHANNELS)) {
    assert.match(mainSource, new RegExp(`ipcMain\\.on\\(RENDERER_REQUEST_CHANNELS\\.${key},`), `main must receive ${key}`);
  }
  // The title channel is gone from both sides of the main window.
  assert.doesNotMatch(mainSource, /page-title-updated/);
  assert.doesNotMatch(mainSource, /__app_/);
});

test("shortcut-status is pushed by main and subscribed to by the renderer bridge (DM-14 / S-10)", () => {
  assert.match(mainSource, /webContents\.send\("shortcut-status"/);
  assert.match(preloadSource, /ipcRenderer\.on\("shortcut-status"/);
  assert.match(preloadSource, /ipcRenderer\.removeListener\("shortcut-status"/);
  assert.doesNotMatch(mainSource, /__transcriptorShortcutStatus/, "no window global written with executeJavaScript");
});

test("the backend API token is asked for on backend-auth's channel and answered by main (BM-01)", () => {
  const { API_TOKEN_CHANNEL } = require("./backend-auth");
  // The sandboxed preload cannot require ./backend-auth, so it spells the
  // channel; this is what holds the two spellings together.
  assert.ok(
    preloadSource.includes(`ipcRenderer.sendSync("${API_TOKEN_CHANNEL}")`),
    "preload must ask on API_TOKEN_CHANNEL",
  );
  assert.match(preloadSource, /exposeInMainWorld\("__TRANSCRIPTOR_API_TOKEN"/);
  assert.match(mainSource, /ipcMain\.on\(API_TOKEN_CHANNEL,/);
  assert.match(mainSource, /TRANSCRIPTOR_API_TOKEN: BACKEND_API_TOKEN,/);
});

test("screen-mode:voice-take is sent by main and subscribed to by the renderer bridge (S-04)", () => {
  // A screen take whose session could not start is a voice take: main
  // tells the renderer so, or the take is filed under Screen Sessions
  // with no screenshots. Main → main window only: there is no renderer →
  // main traffic on this channel, so no sender for main to check.
  assert.match(mainSource, /win\.webContents\.send\("screen-mode:voice-take"/);
  assert.match(preloadSource, /ipcRenderer\.on\("screen-mode:voice-take"/);
  assert.match(preloadSource, /onScreenVoiceTake:/, "the bridge is what the renderer actually calls");
  assert.match(
    preloadSource,
    /ipcRenderer\.removeListener\("screen-mode:voice-take"/,
    "the bridge must hand back a way to unsubscribe",
  );
});
