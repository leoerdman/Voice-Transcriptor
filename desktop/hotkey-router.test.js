"use strict";

// desktop/hotkey-router.js — who holds record / paste-last / screen mode:
// the dictation helper's native tap or globalShortcut, never both, and
// back to globalShortcut whenever the tap cannot be trusted.

const test = require("node:test");
const assert = require("node:assert/strict");

const { macHotkeyChord, canonicalAcceleratorForPlatform } = require("./accelerator");
const { createHotkeyRouter, pressedAtFromEvent } = require("./hotkey-router");

const NOW = 1_000_000;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A helper whose answers the test gives, request by request. */
function fakeHelper({ available = true } = {}) {
  const helper = {
    available,
    requests: [],
    isAvailable: () => helper.available,
    request(cmd, fields) {
      return new Promise((resolve) => helper.requests.push({ cmd, fields, resolve }));
    },
    last() { return helper.requests[helper.requests.length - 1]; },
  };
  return helper;
}

/** globalShortcut as the router sees it. */
function fakeGlobal({ refuse = [] } = {}) {
  const held = new Map();
  return {
    held,
    register(accelerator, handler) {
      const canonical = canonicalAcceleratorForPlatform(accelerator, "darwin");
      if (refuse.includes(canonical)) return { ok: false, accelerator: canonical, error: "already in use" };
      assert.ok(!held.has(canonical), `${canonical} registered twice`);
      held.set(canonical, handler);
      return { ok: true, accelerator: canonical, error: "" };
    },
    unregister(accelerator) {
      held.delete(accelerator);
    },
  };
}

function setup({ helper = fakeHelper(), global = fakeGlobal(), platform = "darwin" } = {}) {
  const log = [];
  const statuses = [];
  const presses = [];
  const router = createHotkeyRouter({
    helper,
    registerGlobal: (a, h) => global.register(a, h),
    unregisterGlobal: (a) => global.unregister(a),
    chordFor: macHotkeyChord,
    canonicalize: (a) => canonicalAcceleratorForPlatform(a, "darwin"),
    platform,
    log: (line) => log.push(line),
    now: () => NOW,
    onStatusChange: (s) => statuses.push(s),
  });
  const bindings = [
    { action: "record", accelerator: "Alt+Left", handler: (at) => presses.push(["record", at]) },
    { action: "paste", accelerator: "Alt+Shift+V", handler: (at) => presses.push(["paste", at]) },
    { action: "screen", accelerator: "Alt+Right", handler: (at) => presses.push(["screen", at]) },
  ];
  return { router, helper, global, log, statuses, presses, bindings };
}

async function engaged(opts) {
  const ctx = setup(opts);
  ctx.router.apply(ctx.bindings);
  ctx.helper.last().resolve({ t: "hotkeys", active: true, secureInput: false });
  await flush();
  return ctx;
}

test("apply starts on globalShortcut and hands the native table to the helper", () => {
  const { router, helper, global, bindings } = setup();
  const status = router.apply(bindings);
  assert.deepEqual([...global.held.keys()].sort(), ["Option+Left", "Option+Right", "Option+Shift+V"]);
  assert.equal(status.record.via, "global");
  assert.equal(status.record.active, "Option+Left");
  assert.equal(helper.requests.length, 1);
  assert.equal(helper.last().cmd, "hotkeys");
  assert.deepEqual(helper.last().fields.chords, [
    { chord: "record", keyCode: 0x7b, mods: ["alt"] },
    { chord: "paste", keyCode: 0x09, mods: ["alt", "shift"] },
    { chord: "screen", keyCode: 0x7c, mods: ["alt"] },
  ]);
});

test("a confirmed tap takes the chords off globalShortcut (no double fire)", async () => {
  const { router, global, statuses, log } = await engaged();
  assert.equal(global.held.size, 0);
  const status = router.status();
  for (const action of ["record", "paste", "screen"]) {
    assert.equal(status[action].via, "native");
    assert.ok(status[action].active);
    assert.equal(status[action].error, "");
  }
  assert.equal(statuses.at(-1).record.via, "native");
  assert.equal(log.filter((l) => l.includes("native tap active")).length, 1);
});

test("a native press reaches the same handler with the key-down's stamp", async () => {
  const { router, presses } = await engaged();
  router.onHelperEvent({ t: "hotkey", chord: "record", pressedAt: NOW - 12, ageMs: 12 });
  router.onHelperEvent({ t: "hotkey", chord: "screen", pressedAt: NOW - 3 });
  router.onHelperEvent({ t: "hotkey", chord: "paste" });
  router.onHelperEvent({ t: "hotkey", chord: "unknown", pressedAt: NOW });
  assert.deepEqual(presses, [["record", NOW - 12], ["screen", NOW - 3], ["paste", NOW]]);
});

test("a globalShortcut press is stamped now", () => {
  const { router, global, presses, bindings } = setup({ helper: fakeHelper({ available: false }) });
  router.apply(bindings);
  global.held.get("Option+Left")();
  assert.deepEqual(presses, [["record", NOW]]);
});

test("the press stamp is used only when plausible", () => {
  assert.equal(pressedAtFromEvent({ pressedAt: NOW - 40 }, NOW), NOW - 40);
  assert.equal(pressedAtFromEvent({ pressedAt: NOW + 300 }, NOW), NOW);
  assert.equal(pressedAtFromEvent({ pressedAt: NOW + 5000 }, NOW), NOW);
  assert.equal(pressedAtFromEvent({ pressedAt: NOW - 60_000 }, NOW), NOW);
  assert.equal(pressedAtFromEvent({ pressedAt: "x" }, NOW), NOW);
  assert.equal(pressedAtFromEvent({}, NOW), NOW);
});

for (const [name, answer, reason] of [
  ["no Accessibility", { t: "hotkeys", active: false, reason: "not-trusted" }, "not-trusted"],
  ["the tap would not arm", { t: "hotkeys", active: false, reason: "tap-create-failed" }, "tap-create-failed"],
  ["the request never reached the helper", null, "helper-unavailable"],
]) {
  test(`${name}: everything stays on globalShortcut, one log line`, async () => {
    const { router, helper, global, log, bindings } = setup();
    router.apply(bindings);
    helper.last().resolve(answer);
    await flush();
    assert.equal(global.held.size, 3);
    assert.equal(router.status().record.via, "global");
    assert.deepEqual(log.filter((l) => l.startsWith("[hotkeys]")), [
      `[hotkeys] native tap unavailable (${reason}); hotkeys on globalShortcut`,
    ]);
    // The same refusal on the next apply is not logged again.
    router.apply(bindings);
    helper.last().resolve(answer);
    await flush();
    assert.equal(log.filter((l) => l.startsWith("[hotkeys]")).length, 1);
  });
}

test("no answer in time: globalShortcut, and the helper is told to disarm", async () => {
  const { router, helper, global, bindings } = setup();
  router.apply(bindings);
  helper.last().resolve({ t: "lost", reason: "timeout" });
  await flush();
  assert.equal(global.held.size, 3);
  assert.deepEqual(helper.last().fields, { chords: [] });
});

test("the helper dies: back on globalShortcut; its return brings the tap back", async () => {
  const { router, helper, global, log } = await engaged();
  router.onHelperExit();
  assert.equal(global.held.size, 3);
  assert.equal(router.status().record.via, "global");
  assert.ok(log.some((l) => l.includes("(helper-exited)")));
  router.onHelperReady();
  assert.deepEqual(helper.last().fields.chords.map((c) => c.chord), ["record", "paste", "screen"]);
  helper.last().resolve({ t: "hotkeys", active: true });
  await flush();
  assert.equal(global.held.size, 0);
  assert.equal(router.status().paste.via, "native");
});

test("an answer to a replaced table is ignored", async () => {
  const { router, helper, global, bindings } = setup();
  router.apply(bindings);
  const first = helper.last();
  router.onHelperExit();
  first.resolve({ t: "hotkeys", active: true });
  await flush();
  assert.equal(global.held.size, 3, "the dead helper's late answer does not unbind globalShortcut");
});

test("macOS switches the tap off for good: back on globalShortcut", async () => {
  const { router, global, log } = await engaged();
  router.onHelperEvent({ t: "tap-disabled", reason: "timeout", reenabled: true });
  assert.equal(global.held.size, 0, "a tap that came back keeps the keys");
  router.onHelperEvent({ t: "tap-disabled", reason: "user-input", reenabled: false });
  assert.equal(global.held.size, 3);
  assert.ok(log.some((l) => l.includes("tap-disabled-user-input")));
});

test("Secure Input: globalShortcut while it lasts, the tap again after", async () => {
  const { router, global, statuses } = await engaged();
  router.onHelperEvent({ t: "secure-input", on: true });
  assert.equal(global.held.size, 3);
  assert.equal(statuses.at(-1).record.via, "global");
  router.onHelperEvent({ t: "secure-input", on: true });
  assert.equal(global.held.size, 3);
  router.onHelperEvent({ t: "secure-input", on: false });
  assert.equal(global.held.size, 0);
  assert.equal(statuses.at(-1).record.via, "native");
});

test("Secure Input already on when the tap arms: globalShortcut until it ends", async () => {
  const { router, helper, global, bindings } = setup();
  router.apply(bindings);
  helper.last().resolve({ t: "hotkeys", active: true, secureInput: true });
  await flush();
  assert.equal(global.held.size, 3);
  router.onHelperEvent({ t: "secure-input", on: false });
  assert.equal(global.held.size, 0);
});

test("a trusted tap takes a new table directly; a refusal puts globalShortcut back", async () => {
  const { router, helper, global } = await engaged();
  const changed = [
    { action: "record", accelerator: "Alt+Up", handler: () => { } },
    { action: "paste", accelerator: "Alt+Shift+V", handler: () => { } },
  ];
  const status = router.apply(changed);
  assert.equal(global.held.size, 0, "no globalShortcut overlap while the trusted tap re-arms");
  assert.equal(status.record.active, "Option+Up");
  assert.deepEqual(helper.last().fields.chords[0], { chord: "record", keyCode: 0x7e, mods: ["alt"] });
  helper.last().resolve({ t: "hotkeys", active: false, reason: "not-trusted" });
  await flush();
  assert.deepEqual([...global.held.keys()].sort(), ["Option+Shift+V", "Option+Up"]);
});

test("a chord without a native key code stays on globalShortcut beside the tap", async () => {
  const { router, helper, global } = setup();
  router.apply([
    { action: "record", accelerator: "Alt+Left", handler: () => { } },
    { action: "paste", accelerator: "Alt+MediaNextTrack", handler: () => { } },
  ]);
  assert.deepEqual(helper.last().fields.chords.map((c) => c.chord), ["record"]);
  helper.last().resolve({ t: "hotkeys", active: true });
  await flush();
  assert.deepEqual([...global.held.keys()], ["Option+MediaNextTrack"]);
  assert.equal(router.status().paste.via, "global");
  assert.equal(router.status().record.via, "native");
});

test("clear lets every key go and disarms the tap (Settings capture)", async () => {
  const { router, helper, global, presses, bindings } = await engaged();
  router.clear();
  assert.equal(global.held.size, 0);
  assert.deepEqual(helper.last().fields, { chords: [] });
  router.onHelperEvent({ t: "hotkey", chord: "record", pressedAt: NOW });
  assert.deepEqual(presses, [], "nothing is bound during a capture");
  // The capture ends: the trusted tap gets the table back, no overlap.
  router.apply(bindings);
  assert.equal(global.held.size, 0);
  assert.equal(helper.last().fields.chords.length, 3);
});

test("a globalShortcut that another app holds is reported, and the tap can still take it", async () => {
  const { router, helper, global, bindings } = setup({ global: fakeGlobal({ refuse: ["Option+Left"] }) });
  const status = router.apply(bindings);
  assert.equal(status.record.active, "");
  assert.equal(status.record.error, "already in use");
  helper.last().resolve({ t: "hotkeys", active: true });
  await flush();
  assert.equal(router.status().record.active, "Option+Left");
  assert.equal(router.status().record.via, "native");
  assert.equal(global.held.size, 0);
});

test("not macOS: globalShortcut only, the helper is never asked", () => {
  const helper = fakeHelper();
  const { router, global, bindings } = setup({ helper, platform: "win32" });
  router.apply(bindings);
  assert.equal(global.held.size, 3);
  assert.equal(helper.requests.length, 0);
});

test("no helper yet at startup: globalShortcut, engaged when it says ready", async () => {
  const helper = fakeHelper({ available: false });
  const { router, global, bindings } = setup({ helper });
  router.apply(bindings);
  assert.equal(helper.requests.length, 0);
  helper.available = true;
  router.onHelperReady();
  helper.last().resolve({ t: "hotkeys", active: true });
  await flush();
  assert.equal(global.held.size, 0);
});

test("main.js routes record, paste-last and screen through the router and the helper's events into it", () => {
  const { mainSource } = require("./main-source");
  assert.match(mainSource, /onEvent: \(event\) => hotkeyRouter\.onHelperEvent\(event\)/);
  assert.match(mainSource, /onReady: \(\) => hotkeyRouter\.onHelperReady\(\)/);
  assert.match(mainSource, /onExit: \(\) => hotkeyRouter\.onHelperExit\(\)/);
  assert.match(mainSource, /const routes = hotkeyRouter\.apply\(bindings\)/);
  assert.match(mainSource, /toggleRecordingFromShortcut\("voice", \{ pressedAt \}\)/);
  assert.match(mainSource, /toggleRecordingFromShortcut\("screen", \{ pressedAt \}\)/);
  // Nothing else registers those three with globalShortcut.
  const registrations = mainSource.split("\n").filter((line) => /globalShortcut\.register\(/.test(line) && !line.trim().startsWith("//"));
  assert.equal(registrations.length, 3, "safeRegisterShortcut, the screenshot key, devtools");
});
