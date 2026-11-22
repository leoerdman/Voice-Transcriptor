"use strict";

// Executable specification for desktop/accelerator.js — the SSOT
// boundary every Electron global shortcut crosses at registration.
// Run: node --test desktop/  (or npm test in desktop/).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { MAC_KEY_CODES, canonicalAcceleratorForPlatform, macHotkeyChord } = require("./accelerator");

test("darwin: Command/Cmd stay Command", () => {
  assert.equal(canonicalAcceleratorForPlatform("Command+S", "darwin"), "Command+S");
  assert.equal(canonicalAcceleratorForPlatform("Cmd+Shift+F9", "darwin"), "Command+Shift+F9");
});

test("darwin: Meta and Super canonicalise to Command (Electron has no Super on macOS)", () => {
  assert.equal(canonicalAcceleratorForPlatform("Meta+P", "darwin"), "Command+P");
  assert.equal(canonicalAcceleratorForPlatform("Super+X", "darwin"), "Command+X");
});

test("darwin: CommandOrControl/CmdOrCtrl become Command", () => {
  assert.equal(canonicalAcceleratorForPlatform("CommandOrControl+R", "darwin"), "Command+R");
  assert.equal(canonicalAcceleratorForPlatform("CmdOrCtrl+L", "darwin"), "Command+L");
});

test("darwin: Option is the canonical Alt token", () => {
  assert.equal(canonicalAcceleratorForPlatform("Alt+ArrowUp", "darwin"), "Option+ArrowUp");
  assert.equal(canonicalAcceleratorForPlatform("Option+ArrowUp", "darwin"), "Option+ArrowUp");
});

test("linux/win32: Command/Cmd/Meta become Super (the original silent no-op bug)", () => {
  assert.equal(canonicalAcceleratorForPlatform("Command+Shift+S", "linux"), "Super+Shift+S");
  assert.equal(canonicalAcceleratorForPlatform("Cmd+E", "win32"), "Super+E");
  assert.equal(canonicalAcceleratorForPlatform("Meta+W", "linux"), "Super+W");
});

test("linux/win32: stored Super stays Super", () => {
  assert.equal(canonicalAcceleratorForPlatform("Super+K", "linux"), "Super+K");
});

test("linux/win32: CommandOrControl/CmdOrCtrl become Control", () => {
  assert.equal(canonicalAcceleratorForPlatform("CommandOrControl+R", "linux"), "Control+R");
  assert.equal(canonicalAcceleratorForPlatform("CmdOrCtrl+L", "win32"), "Control+L");
});

test("linux/win32: Ctrl/Control/Alt/Shift pass through canonically", () => {
  assert.equal(canonicalAcceleratorForPlatform("Ctrl+C", "linux"), "Control+C");
  assert.equal(canonicalAcceleratorForPlatform("Alt+F4", "win32"), "Alt+F4");
  assert.equal(canonicalAcceleratorForPlatform("Shift+Space", "linux"), "Shift+Space");
});

test("unknown platform falls back to the non-darwin map", () => {
  assert.equal(canonicalAcceleratorForPlatform("Command+Q", "freebsd"), "Super+Q");
  assert.equal(canonicalAcceleratorForPlatform("CommandOrControl+Q", "sunos"), "Control+Q");
});

test("default platform argument follows process.platform", () => {
  assert.equal(
    canonicalAcceleratorForPlatform("Command+J"),
    canonicalAcceleratorForPlatform("Command+J", process.platform),
  );
});

test("whitespace and case are normalised; key order preserved", () => {
  assert.equal(
    canonicalAcceleratorForPlatform(" command + SHIFT + f9 ", "darwin"),
    "Command+Shift+f9",
  );
});

test("empty and non-string input pass through untouched", () => {
  assert.equal(canonicalAcceleratorForPlatform("", "darwin"), "");
  assert.equal(canonicalAcceleratorForPlatform(null, "darwin"), null);
  assert.equal(canonicalAcceleratorForPlatform(undefined, "linux"), undefined);
});

test("normalisation is idempotent", () => {
  const samples = ["CommandOrControl+Shift+F9", "Super+X", "Meta+P", "Ctrl+Alt+Delete"];
  for (const s of samples) {
    for (const platform of ["darwin", "linux"]) {
      const once = canonicalAcceleratorForPlatform(s, platform);
      assert.equal(canonicalAcceleratorForPlatform(once, platform), once);
    }
  }
});

test("a malformed accelerator is handed back, not repaired into a bare modifier", () => {
  // "Control++" is what a naive capture writes for the Plus key (Electron
  // spells it "Control+Plus"). The old `.filter(Boolean)` reduced it to the
  // single token "Control", and safeRegisterShortcut then attempted to bind
  // a bare modifier — a global shortcut the user never asked for, on a key
  // every other chord in the system also uses.
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(canonicalAcceleratorForPlatform("Control++", platform), "Control++");
    assert.equal(canonicalAcceleratorForPlatform("Cmd++", platform), "Cmd++");
    assert.equal(canonicalAcceleratorForPlatform("+", platform), "+");
    assert.equal(canonicalAcceleratorForPlatform("Control+ +V", platform), "Control+ +V");
  }
  // The well-formed spelling of the same key still canonicalises.
  assert.equal(canonicalAcceleratorForPlatform("Cmd+Plus", "darwin"), "Command+Plus");
  assert.equal(canonicalAcceleratorForPlatform("Cmd+Plus", "win32"), "Super+Plus");
});

test("surrounding whitespace inside a well-formed chord is still normalised", () => {
  assert.equal(canonicalAcceleratorForPlatform(" Cmd + Shift + V ", "darwin"), "Command+Shift+V");
});

// ── macHotkeyChord: what the native hotkey tap matches ───────────────
test("macHotkeyChord: the shipped macOS defaults all have a native chord", () => {
  const defaults = require("./shortcut-defaults.json").platformDefaults.darwin;
  assert.deepEqual(macHotkeyChord(defaults.record), { keyCode: 0x7b, mods: ["alt"] });
  assert.deepEqual(macHotkeyChord(defaults.paste), { keyCode: 0x09, mods: ["alt", "shift"] });
  assert.deepEqual(macHotkeyChord(defaults.screen), { keyCode: 0x7c, mods: ["alt"] });
  assert.deepEqual(macHotkeyChord(defaults.screenShot), { keyCode: 0x32, mods: [] });
});

test("macHotkeyChord: every spelling the shell accepts means what it means to globalShortcut", () => {
  const cmdV = { keyCode: 0x09, mods: ["cmd"] };
  for (const acc of ["Command+V", "Cmd+V", "CommandOrControl+V", "CmdOrCtrl+v", "Meta+V", "Super+V"]) {
    assert.deepEqual(macHotkeyChord(acc), cmdV, acc);
  }
  assert.deepEqual(macHotkeyChord("Option+Left"), macHotkeyChord("Alt+Left"));
  assert.deepEqual(macHotkeyChord("Ctrl+Shift+Alt+Cmd+F9"), { keyCode: 0x65, mods: ["cmd", "alt", "ctrl", "shift"] });
  assert.deepEqual(macHotkeyChord(" Alt + Shift + V "), { keyCode: 0x09, mods: ["alt", "shift"] });
});

test("macHotkeyChord: what the tap cannot match stays on globalShortcut (null)", () => {
  for (const acc of ["", "Alt", "Alt+Shift", "Alt+A+B", "Control++", "Cmd+Plus", "MediaNextTrack", "AltGr+A", "Alt+Nope", null, 42]) {
    assert.equal(macHotkeyChord(acc), null, String(acc));
  }
});

test("macHotkeyChord: the key-code table gives one code per key position", () => {
  const SYNONYMS = new Set(["enter,return", "esc,escape"]);
  const byCode = new Map();
  for (const [name, code] of Object.entries(MAC_KEY_CODES)) {
    assert.ok(Number.isInteger(code) && code >= 0 && code <= 0x7f, `${name}: ${code}`);
    byCode.set(code, [...(byCode.get(code) || []), name]);
  }
  for (const names of byCode.values()) {
    if (names.length > 1) assert.ok(SYNONYMS.has(names.sort().join(",")), names.join(","));
  }
});
