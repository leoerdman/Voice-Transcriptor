"use strict";

// DM-28 (Ultra-Audit 2026-11-20): every IPC channel the preload exposes
// answers only the main window's webContents. Two handlers checked the
// sender; four did not.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource } = require("./main-source");

function handlerHead(channel) {
  const at = mainSource.search(new RegExp(`ipcMain\\.(?:handle|on)\\("${channel}"`));
  assert.ok(at >= 0, `${channel} is not handled`);
  return mainSource.slice(at, at + 260);
}

test("every preload channel checks that the sender is the main window", () => {
  const SENDER_CHECK = /isFromMainWindow\(event\)|event\.sender !== win\.webContents/;
  for (const channel of [
    "engine:get-status",
    "engine:install",
    "paste-capability:get-status",
    "permissions:repair",
    "screen-mode:finish",
    "recording-final",
  ]) {
    assert.match(handlerHead(channel), SENDER_CHECK, `${channel} must refuse other senders`);
  }
});
