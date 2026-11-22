"use strict";

// `[perm-check]` is logged on first sight and on change, not on every
// Chromium permission check (~1,250 identical lines in three days).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createPermissionChangeLog } = require("./session-permissions");

test("a repeated decision is logged once; a changed one is logged again", () => {
  const changed = createPermissionChangeLog();
  const key = "media types=audio origins=http://127.0.0.1:8765/";
  assert.equal(changed(key, "true granted"), true, "first sight is logged");
  assert.equal(changed(key, "true granted"), false);
  assert.equal(changed(key, "true granted"), false);
  assert.equal(changed("speaker-selection origins=http://127.0.0.1:8765/", "false capability-not-in-allow-list"), true,
    "another permission is its own key");
  assert.equal(changed(key, "false non-backend-origin"), true, "a changed decision is logged");
  assert.equal(changed(key, "true granted"), true, "and so is the change back");
});

test("the key space is bounded and forgetting costs only a repeated line", () => {
  const changed = createPermissionChangeLog({ maxKeys: 2 });
  assert.equal(changed("a", "x"), true);
  assert.equal(changed("b", "x"), true);
  assert.equal(changed("c", "x"), true, "evicts the oldest key");
  assert.equal(changed("b", "x"), false, "newer keys are still remembered");
  assert.equal(changed("a", "x"), true, "the evicted key is logged again");
});
