"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { floatingWindowOptions, spanAllWorkspaces } = require("./floating-window");

test("floating windows are NSPanels on macOS and plain windows elsewhere", () => {
  assert.deepEqual(floatingWindowOptions("darwin"), { type: "panel" });
  assert.deepEqual(floatingWindowOptions("win32"), {});
  assert.deepEqual(floatingWindowOptions("linux"), {});
});

test("spanning workspaces never transforms the process out of the Dock", () => {
  const calls = [];
  spanAllWorkspaces({ setVisibleOnAllWorkspaces: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[true, { visibleOnFullScreen: true, skipTransformProcessType: true }]]);
});

test("no desktop source spans workspaces behind the helper's back", () => {
  const offenders = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js") && f !== "floating-window.js")
    .filter((f) => /setVisibleOnAllWorkspaces\(/.test(fs.readFileSync(path.join(__dirname, f), "utf8")));
  assert.deepEqual(offenders, [], "use spanAllWorkspaces() from ./floating-window");
});
