"use strict";

// DM-28 (Ultra-Audit 2026-11-20): every IPC channel the preload exposes
// answers only the main window's webContents; the capsule's verbs answer
// only the capsule.
//
// The behaviour lives in ./ipc-sender-guard and is driven here with a fake
// ipcMain. What only main.js's text can show is which registrar each
// channel goes through — so the last test reads the channel lists, not
// the handler bodies.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createSenderGuardedIpc } = require("./ipc-sender-guard");
const { RENDERER_REQUEST_CHANNELS } = require("./renderer-requests");
const { API_TOKEN_CHANNEL } = require("./backend-auth");
const { mainSource } = require("./main-source");

const preloadSource = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle(channel, fn) {
      assert.ok(!handlers.has(channel), `${channel} handled twice`);
      handlers.set(channel, fn);
    },
    on(channel, fn) {
      assert.ok(!listeners.has(channel), `${channel} listened twice`);
      listeners.set(channel, fn);
    },
    invoke(channel, event, ...args) {
      return handlers.get(channel)(event, ...args);
    },
    send(channel, event, ...args) {
      listeners.get(channel)(event, ...args);
    },
  };
}

function setup() {
  const ipcMain = fakeIpcMain();
  const mainWebContents = { id: 1 };
  const refused = [];
  const ipc = createSenderGuardedIpc(ipcMain, {
    isAllowedSender: (event) => event?.sender === mainWebContents,
    onRefused: (channel) => {
      refused.push(channel);
      return { ok: false, error: "sender" };
    },
  });
  return { ipcMain, ipc, refused, own: { sender: mainWebContents }, foreign: { sender: { id: 2 } } };
}

test("an invoke channel runs its handler for the allowed sender, with the arguments", async () => {
  const { ipcMain, ipc, refused, own } = setup();
  const seen = [];
  ipc.handle("engine:install", async (event, a, b) => {
    seen.push([event, a, b]);
    return { ok: true };
  });
  assert.deepEqual(await ipcMain.invoke("engine:install", own, "x", 2), { ok: true });
  assert.deepEqual(seen, [[own, "x", 2]]);
  assert.deepEqual(refused, []);
});

test("an invoke channel refuses any other sender without running the handler", async () => {
  const { ipcMain, ipc, refused, foreign } = setup();
  let ran = 0;
  ipc.handle("permissions:repair", () => { ran += 1; return { ok: true }; });
  assert.deepEqual(await ipcMain.invoke("permissions:repair", foreign), { ok: false, error: "sender" });
  // A missing event (or one without a sender) is not the main window either.
  assert.deepEqual(await ipcMain.invoke("permissions:repair", undefined), { ok: false, error: "sender" });
  assert.equal(ran, 0);
  assert.deepEqual(refused, ["permissions:repair", "permissions:repair"]);
});

test("a send-only channel runs its listener for the allowed sender and drops any other", () => {
  const { ipcMain, ipc, refused, own, foreign } = setup();
  const got = [];
  ipc.on("recording-final", (_event, payload) => got.push(payload));
  ipcMain.send("recording-final", foreign, { text: "forged" });
  ipcMain.send("recording-final", own, { text: "real" });
  assert.deepEqual(got, [{ text: "real" }]);
  assert.deepEqual(refused, ["recording-final"]);
});

test("the predicate is asked on every message, not once at registration", () => {
  // The main window is recreated (and the capsule torn down) while the
  // channels stay registered: the allowed sender is whatever exists now.
  const ipcMain = fakeIpcMain();
  let current = { id: 1 };
  const ipc = createSenderGuardedIpc(ipcMain, {
    isAllowedSender: (event) => event?.sender === current,
    onRefused: () => { },
  });
  const got = [];
  ipc.on("capsule:stop", (event) => got.push(event.sender.id));
  const old = current;
  ipcMain.send("capsule:stop", { sender: old });
  current = { id: 3 };
  ipcMain.send("capsule:stop", { sender: old });
  ipcMain.send("capsule:stop", { sender: current });
  assert.deepEqual(got, [1, 3]);
});

test("a registrar without a predicate or a refusal is a programming error, not an open channel", () => {
  assert.throws(() => createSenderGuardedIpc(fakeIpcMain(), { onRefused: () => { } }), TypeError);
  assert.throws(() => createSenderGuardedIpc(fakeIpcMain(), { isAllowedSender: () => true }), TypeError);
});

// ── Wiring (textual): which registrar each channel goes through ──────────

function registrations(registrar) {
  // Anchored at the start of a line, so a channel named in a comment
  // does not count as registered.
  const re = new RegExp(`^\\s*${registrar}\\.(handle|on)\\((?:"([^"]+)"|RENDERER_REQUEST_CHANNELS\\.(\\w+))`, "gm");
  return [...mainSource.matchAll(re)].map((m) => ({
    kind: m[1],
    channel: m[2] || RENDERER_REQUEST_CHANNELS[m[3]],
  }));
}

test("every channel the preload uses is registered through the main window's guarded registrar", () => {
  const preload = [...preloadSource.matchAll(/ipcRenderer\.(invoke|send|sendSync)\("([^"]+)"/g)]
    .map((m) => ({ kind: m[1], channel: m[2] }))
    // The API token channel answers every sender — with "" for anyone
    // but the main window's own page; ./backend-auth decides that and
    // backend-auth.test.js tests it.
    .filter((c) => c.channel !== API_TOKEN_CHANNEL);
  const expected = preload
    .map((c) => `${c.kind === "invoke" ? "handle" : "on"} ${c.channel}`)
    .sort();
  const registered = registrations("mainWindowIpc").map((r) => `${r.kind} ${r.channel}`).sort();
  assert.ok(expected.length >= 9, `preload channels not found (${expected.length})`);
  assert.deepEqual(registered, expected);
  assert.match(mainSource, /const mainWindowIpc = createSenderGuardedIpc\(ipcMain, \{\s*isAllowedSender: isFromMainWindow,/);
});

test("the capsule's verbs are registered through the capsule's guarded registrar", () => {
  const capsulePreload = fs.readFileSync(path.join(__dirname, "capsule-preload.js"), "utf8");
  const sent = [...capsulePreload.matchAll(/ipcRenderer\.send\("([^"]+)"\)/g)].map((m) => `on ${m[1]}`).sort();
  const registered = registrations("capsuleIpc").map((r) => `${r.kind} ${r.channel}`).sort();
  assert.equal(sent.length, 3);
  assert.deepEqual(registered, sent);
});

test("nothing in main.js registers on ipcMain directly but the API token channel", () => {
  const direct = [...mainSource.matchAll(/\bipcMain\.(?:handle|handleOnce|on|once|addListener)\(\s*([^,]+),/g)]
    .map((m) => m[1].trim());
  assert.deepEqual(direct, ["API_TOKEN_CHANNEL"]);
});
