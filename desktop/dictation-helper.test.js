"use strict";

// The persistent native helper (desktop/native/dictation-helper/) and the
// shell's client for it (desktop/dictation-helper.js):
//
//   * the client: spawn, `ready`, request/answer by id, a late or lost
//     answer, restart after an unexpected exit — against a fake child;
//   * the native paste request and how its answer is read (success /
//     hand over to AppleScript / lost, never pasted twice);
//   * the Swift ClipboardLedger suite and a type-check of the whole helper
//     (macOS + Command Line Tools only, like screen-input.test.js);
//   * the protocol main.js speaks is the one main.swift documents.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  LOST,
  NATIVE_PASTE,
  RESTART_DELAYS_MS,
  createDictationHelper,
  interpretNativePaste,
  nativePasteRequest,
} = require("./dictation-helper");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => { };
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => { };
  child.written = [];
  child.stdin = new EventEmitter();
  child.stdin.write = (line) => { child.written.push(JSON.parse(line)); return true; };
  child.stdin.end = () => { child.ended = true; };
  child.kill = (sig) => { child.killed = sig; };
  child.say = (obj) => child.stdout.emit("data", `${JSON.stringify(obj)}\n`);
  return child;
}

function world({ platform = "darwin", exists = true } = {}) {
  const children = [];
  const timers = [];
  const logs = [];
  const events = [];
  const helper = createDictationHelper({
    spawn: () => { const c = fakeChild(); children.push(c); return c; },
    helperPath: () => "/bundle/runtime/bin/dictation-helper",
    exists: () => exists,
    platform,
    log: (l) => logs.push(l),
    onEvent: (e) => events.push(e),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
  });
  const fire = (ms) => {
    for (const t of timers.filter((x) => !x.cleared && x.ms === ms)) { t.cleared = true; t.fn(); }
  };
  return { helper, children, timers, logs, events, fire };
}

test("not macOS, or no binary: never started, every request is 'no helper'", async () => {
  for (const w of [world({ platform: "linux" }), world({ exists: false })]) {
    assert.equal(w.helper.start(), false);
    assert.equal(w.children.length, 0);
    assert.equal(await w.helper.request("front-app"), null);
  }
});

test("requests wait for ready, carry an id, and resolve to the answer with that id", async () => {
  const w = world();
  assert.equal(w.helper.start(), true);
  assert.equal(await w.helper.request("front-app"), null, "not ready yet: no helper");
  const child = w.children[0];
  child.say({ t: "ready", pid: 7, accessibility: true, postEvents: true });
  assert.equal(w.helper.isAvailable(), true);
  assert.deepEqual(w.helper.permissions(), { accessibility: true, postEvents: true });
  const a = w.helper.request("front-app");
  const b = w.helper.request("clipboard-prepare");
  const [ra, rb] = child.written;
  assert.equal(ra.cmd, "front-app");
  assert.notEqual(ra.id, rb.id);
  // Answers may come in any order; an id-less line is an event.
  child.say({ t: "clipboard-prepare", id: rb.id, changeCount: 4 });
  child.say({ t: "hotkey", chord: "toggle", phase: "down", ageMs: 3 });
  child.say({ t: "front-app", id: ra.id, pid: 42, name: "TextEdit" });
  assert.equal((await a).pid, 42);
  assert.equal((await b).changeCount, 4);
  assert.deepEqual(w.events, [{ t: "hotkey", chord: "toggle", phase: "down", ageMs: 3 }]);
});

test("an answer that never comes is LOST, not 'no helper' — the request reached it", async () => {
  const w = world();
  w.helper.start();
  w.children[0].say({ t: "ready", pid: 7 });
  const p = w.helper.request("paste", { text: "x" }, { timeoutMs: 900 });
  w.fire(900);
  assert.deepEqual(await p, { t: LOST, reason: "timeout" });
});

test("a helper that dies loses its pending requests and is restarted with a backoff", async () => {
  const w = world();
  w.helper.start();
  const first = w.children[0];
  first.say({ t: "ready", pid: 7 });
  const p = w.helper.request("paste", { text: "x" });
  first.emit("exit", 1, null);
  assert.deepEqual(await p, { t: LOST, reason: "exit" });
  assert.equal(w.helper.isAvailable(), false);
  w.fire(RESTART_DELAYS_MS[0]);
  assert.equal(w.children.length, 2, "restarted");
  // A second death before ready waits longer.
  w.children[1].emit("exit", 1, null);
  w.fire(RESTART_DELAYS_MS[0]);
  assert.equal(w.children.length, 2);
  w.fire(RESTART_DELAYS_MS[1]);
  assert.equal(w.children.length, 3);
});

test("stop sends quit, closes stdin and never restarts", async () => {
  const w = world();
  w.helper.start();
  const child = w.children[0];
  child.say({ t: "ready", pid: 7 });
  w.helper.stop();
  assert.equal(child.written.at(-1).cmd, "quit");
  assert.equal(child.ended, true);
  child.emit("exit", 0, null);
  assert.equal(w.timers.filter((t) => !t.cleared && RESTART_DELAYS_MS.includes(t.ms)).length, 0);
});

test("a fresh helper that never says ready is killed (and then restarted)", () => {
  const w = world();
  w.helper.start();
  w.fire(3000);
  assert.equal(w.children[0].killed, "SIGKILL");
});

test("the paste request waits for the keys only for the paste-last hotkey's plan", () => {
  const plain = nativePasteRequest({ text: "hi", pid: 12, verify: true });
  assert.deepEqual(plain.fields, {
    text: "hi", pid: 12, verify: true, releaseDeadlineMs: 0,
    pollMs: NATIVE_PASTE.pollMs, settleMs: NATIVE_PASTE.settleMs, gapMs: NATIVE_PASTE.gapMs,
  });
  assert.equal(plain.timeoutMs, NATIVE_PASTE.answerSlackMs);
  const held = nativePasteRequest({ text: "hi", modifierPlan: { needed: true, canPoll: true, deadlineMs: 500 } });
  assert.equal(held.fields.releaseDeadlineMs, 500);
  assert.equal(held.timeoutMs, 500 + NATIVE_PASTE.answerSlackMs);
  assert.equal(nativePasteRequest({ text: "hi", pid: -3 }).fields.pid, 0);
  // Hex's timings: 15 ms between the four events, 100 ms settle.
  assert.equal(NATIVE_PASTE.gapMs, 15);
  assert.equal(NATIVE_PASTE.settleMs, 100);
});

test("a paste answer: sent is success, not posted hands over, no answer is lost", () => {
  const ok = interpretNativePaste({ t: "paste", ok: true, sent: true, verification: "verified", changeCount: 9 });
  assert.equal(ok.kind, "success");
  assert.equal(ok.verified, true);
  assert.equal(ok.policyOutcome, "verified");
  assert.equal(ok.changeCount, 9);
  assert.equal(interpretNativePaste({ t: "paste", ok: true, sent: true, verification: "unreadable" }).policyOutcome, "unreadable");
  assert.equal(interpretNativePaste({ t: "paste", ok: true, sent: true, verification: "unverified" }).policyOutcome, "inconclusive");
  assert.equal(interpretNativePaste({ t: "paste", ok: true, sent: true, verification: "skipped" }).policyOutcome, null);
  for (const reason of ["not-trusted", "front-mismatch", "clipboard-write-failed", "post-failed"]) {
    const out = interpretNativePaste({ t: "paste", ok: false, sent: false, reason, reverted: true });
    assert.equal(out.kind, "fallback");
    assert.equal(out.reason, `native-${reason}`);
  }
  assert.equal(interpretNativePaste(null).kind, "fallback");
  assert.equal(interpretNativePaste({ t: LOST, reason: "timeout" }).kind, "lost");
  // A slow or dead helper is not an AppleScript "silent" failure: it must
  // not walk the paste capability towards broken.
  const { classifyPasteFailure } = require("./paste-capability");
  for (const reason of ["timeout", "exit"]) {
    assert.equal(classifyPasteFailure(interpretNativePaste({ t: LOST, reason }).reason), "other");
  }
});

// ── The protocol main.js speaks is the one main.swift documents ───────
const helperDir = path.join(__dirname, "native", "dictation-helper");
const helperMain = fs.readFileSync(path.join(helperDir, "main.swift"), "utf8");

test("every command main.js sends is documented and handled by main.swift", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const sent = [...new Set([...main.matchAll(/dictationHelper\.request\("([a-z-]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(sent.includes("paste") && sent.includes("clipboard-restore"));
  const header = helperMain.slice(0, helperMain.indexOf("import "));
  for (const cmd of sent) {
    assert.ok(header.includes(`{"cmd":"${cmd}"`), `${cmd} documented in main.swift`);
    assert.ok(helperMain.includes(`case "${cmd}":`), `${cmd} handled in main.swift`);
  }
});

// ── Swift ─────────────────────────────────────────────────────────────
const swiftc = process.platform === "darwin"
  ? spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" })
  : { status: 1 };
const skip = swiftc.status !== 0 ? "swiftc is not available (macOS + Command Line Tools only)" : false;
const shared = path.join(__dirname, "native", "shared", "LineProtocol.swift");
const ledgerSource = path.join(helperDir, "ClipboardLedger.swift");

const LEDGER_CASES = [
  "a prepared snapshot is used while the clipboard has not changed",
  "a prepared snapshot older than the clipboard is read again",
  "a restore after our write puts the original back, once",
  "a user copy after our write is never overwritten",
  "a second paste carries the first original over",
  "the first paste's restore is superseded by the second's write",
  "a failed paste keeps the transcript",
  "a restore with nothing saved does nothing",
];

test("ClipboardLedger: the user's clipboard comes back only while the change count is our write's", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipboard-ledger-test-"));
  const bin = path.join(dir, "clipboard-ledger-tests");
  const build = spawnSync(
    "xcrun",
    ["swiftc", "-o", bin, ledgerSource, path.join(__dirname, "native", "tests", "clipboard-ledger", "main.swift")],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(bin, [], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n").map((line) => line.replace(/^ok /, "")), LEDGER_CASES);
});

test("the dictation helper compiles from the sources build-native.sh names", { skip }, () => {
  const buildNative = fs.readFileSync(path.join(__dirname, "scripts", "build-native.sh"), "utf8");
  const block = buildNative.slice(buildNative.lastIndexOf("xcrun swiftc"), buildNative.indexOf('-o "$OUT_DIR/dictation-helper"'));
  const sources = [...block.matchAll(/"\$DESKTOP_DIR\/(native\/[\w/-]+\.swift)"/g)].map((m) => path.join(__dirname, m[1]));
  if (block.includes('"$SHARED"')) sources.unshift(shared);
  const onDisk = fs.readdirSync(helperDir).filter((f) => f.endsWith(".swift")).map((f) => path.join(helperDir, f));
  for (const f of onDisk) assert.ok(sources.includes(f), `${path.basename(f)} is built`);
  const check = spawnSync("xcrun", ["swiftc", "-typecheck", ...sources], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("PasteboardIO: a clipboard round trip on a private pasteboard gives back every item and type", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pasteboard-roundtrip-test-"));
  const bin = path.join(dir, "pasteboard-roundtrip-tests");
  const build = spawnSync(
    "xcrun",
    [
      "swiftc", "-o", bin, shared, ledgerSource, path.join(helperDir, "Paste.swift"),
      path.join(__dirname, "native", "tests", "pasteboard-roundtrip", "main.swift"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(bin, [], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split("\n").map((line) => line.replace(/^ok /, "")), [
    "every item and every type comes back, not only the text",
    "an empty clipboard comes back empty",
  ]);
});
