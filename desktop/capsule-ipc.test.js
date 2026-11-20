"use strict";

// DM-10, capsule half (Ultra-Audit 2026-11-20): the capsule's verbs travel
// over a preload with fixed send-only channels, not over document.title —
// where setting the same title twice fires nothing, so a second stop click
// after a stale stop was lost.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { mainSource, topLevelFunctionSource } = require("./main-source");

const capsulePreload = fs.readFileSync(path.join(__dirname, "capsule-preload.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const VERBS = ["capsule:stop", "capsule:shot", "capsule:pointer"];

test("the capsule page sets no magic titles; main intercepts none", () => {
  const html = topLevelFunctionSource("recordingStatusCapsuleHtml");
  assert.ok(html, "recordingStatusCapsuleHtml not found");
  assert.doesNotMatch(html, /document\.title\s*=/);
  assert.match(html, /window\.__capsule\.stop\(\)/);
  assert.match(html, /window\.__capsule\.shot\(\)/);
  assert.match(html, /window\.__capsule\.pointer\(\)/);
  assert.doesNotMatch(mainSource, /__recording_capsule_(stop|shot|pointer)__/);
});

test("the capsule preload sends exactly the three verbs and exposes no raw ipcRenderer", () => {
  const sent = [...capsulePreload.matchAll(/ipcRenderer\.send\("([^"]+)"\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(sent, [...VERBS].sort());
  assert.doesNotMatch(capsulePreload, /exposeInMainWorld\([^)]*ipcRenderer\s*\)/);
  assert.doesNotMatch(capsulePreload, /ipcRenderer\.on\(|ipcRenderer\.invoke\(/);
});

test("main listens on each verb, only from the capsule window, and the window loads the preload", () => {
  const ipc = topLevelFunctionSource("installRecordingStatusCapsuleIpc");
  for (const verb of VERBS) {
    assert.match(ipc, new RegExp(`ipcMain\\.on\\("${verb}", \\(event\\) => \\{\\s*if \\(!fromCapsule\\(event\\)\\) return;`));
  }
  assert.match(topLevelFunctionSource("ensureRecordingStatusCapsuleWindow"), /preload: path\.join\(__dirname, "capsule-preload\.js"\)/);
  assert.ok(pkg.build.files.includes("capsule-preload.js"), "the preload must be packaged");
});
