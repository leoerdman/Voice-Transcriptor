"use strict";

// DM-10 / FU-10 / K-1: the main window's requests arrive on preload
// sends, and what each may do is decided by ./renderer-requests from the
// payload alone. These are the rules the document.title handler applied
// inline in main.js, now checked as behaviour.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { parseShortcutMessage, resolveRevealTarget, SHORTCUT_ACTIONS } = require("./renderer-requests");

test("a shortcut message keeps the four slots, trimmed and bounded, and nothing else", () => {
  const out = parseShortcutMessage({
    action: " update ",
    record: "  Alt+Left ",
    paste: "Alt+Up",
    screen: "Alt+Right",
    screenShot: "x".repeat(200),
    nonce: "ignored",
    extra: { evil: true },
  });
  assert.deepEqual(Object.keys(out.message).sort(), ["action", "paste", "record", "screen", "screenShot"]);
  assert.equal(out.message.action, "update");
  assert.equal(out.message.record, "Alt+Left");
  assert.equal(out.message.screenShot.length, 96);
});

test("a shortcut message with an unknown verb or no object is refused", () => {
  assert.ok(parseShortcutMessage({ action: "register-anything" }).error);
  assert.ok(parseShortcutMessage(null).error);
  assert.ok(parseShortcutMessage("__app_shortcuts__{}").error);
  for (const action of SHORTCUT_ACTIONS) assert.ok(parseShortcutMessage({ action }).message, action);
});

const home = path.resolve("/Users/foo");
const recordingsRoot = path.join(home, "Library", "Transcriptor", "recordings");
const roots = { home, recordingsRoot, allowedRoots: [recordingsRoot, path.join(home, "Notes")] };

test("reveal shows the transcript under an allowed recordings root", () => {
  assert.deepEqual(
    resolveRevealTarget({ name: "a.txt", archiveDir: path.join(recordingsRoot, "2026") }, roots),
    { ok: true, target: path.join(recordingsRoot, "2026", "a.txt") },
  );
  // No archive dir: the data directory's recordings/.
  assert.deepEqual(resolveRevealTarget({ name: "b.TXT" }, roots), { ok: true, target: path.join(recordingsRoot, "b.TXT") });
  assert.equal(resolveRevealTarget({ name: "c.txt", archiveDir: path.join(home, "Notes") }, roots).ok, true);
});

test("reveal refuses traversal, separators, non-transcripts and escapes from home or the roots", () => {
  assert.equal(resolveRevealTarget({ name: "..txt" }, roots).reason, "bad-name");
  assert.equal(resolveRevealTarget({ name: "../x.txt" }, roots).reason, "bad-name");
  assert.equal(resolveRevealTarget({ name: "a\\b.txt" }, roots).reason, "bad-name");
  assert.equal(resolveRevealTarget({ name: "" }, roots).reason, "bad-name");
  assert.equal(resolveRevealTarget({ name: "a.wav" }, roots).reason, "not-a-transcript");
  // The classic prefix bypass: /Users/foobar starts with /Users/foo.
  assert.equal(resolveRevealTarget({ name: "a.txt", archiveDir: "/Users/foobar/recordings" }, roots).reason, "outside-home");
  assert.equal(resolveRevealTarget({ name: "a.txt", archiveDir: "/etc" }, roots).reason, "outside-home");
  assert.equal(
    resolveRevealTarget({ name: "a.txt", archiveDir: path.join(home, "Documents") }, roots).reason,
    "outside-recording-roots",
  );
  // A relative archive dir is not trusted: it falls back to recordings/.
  assert.deepEqual(resolveRevealTarget({ name: "a.txt", archiveDir: "../../etc" }, roots), {
    ok: true,
    target: path.join(recordingsRoot, "a.txt"),
  });
});
