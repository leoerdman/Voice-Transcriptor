"use strict";

// DM-24 / S-09 (Ultra-Audit 2026-11-20): a screenshot key another app owns
// must show up in the shortcut status — before the take, from a
// registration probe, and during it, from the bind — instead of the slot
// being hard-coded "no error".

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { screenShotSlotStatus } = require("./shortcut-runtime");
const { mainSource, topLevelFunctionSource } = require("./main-source");

test("the slot carries the probe's or the bind's refusal", () => {
  assert.deepEqual(
    screenShotSlotStatus({ desired: "Alt+Down", supported: true, error: "already in use" }),
    { desired: "Alt+Down", active: "", error: "already in use" },
  );
  assert.deepEqual(
    screenShotSlotStatus({ desired: "Alt+Down", supported: true, bound: "Alt+Down" }),
    { desired: "Alt+Down", active: "Alt+Down", error: "" },
  );
  assert.deepEqual(
    screenShotSlotStatus({ desired: "Alt+Down", supported: false, error: "already in use" }),
    { desired: "Alt+Down", active: "", error: "unsupported" },
  );
  assert.deepEqual(screenShotSlotStatus({ desired: "", error: "stale" }), { desired: "", active: "", error: "" });
});

test("main.js probes the key at registration and reports a failed bind during a take", () => {
  assert.match(topLevelFunctionSource("probeScreenShotHotkey"), /globalShortcut\.unregister\(canonical\)/);
  const bind = topLevelFunctionSource("bindScreenShotHotkey");
  assert.match(bind, /publishScreenShotHotkeyStatus\(\)/);
  assert.match(bind, /notifyScreenModeWarning\("screenshot-hotkey"\)/);
  assert.match(mainSource, /screenShot: screenShotSlotStatus\(\{/);
  assert.doesNotMatch(mainSource, /active: "",\s*error: screenSupported \? "" : "unsupported"/, "no hard-coded slot status");
});
