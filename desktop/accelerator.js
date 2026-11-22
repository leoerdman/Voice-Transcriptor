"use strict";

// Canonical Electron accelerator vocabulary per platform — the renderer
// stores bindings using user-intent tokens ("Command", "CommandOrControl")
// so a single saved binding reads correctly in cross-platform JSON.
// Electron's globalShortcut API, however, only recognises those tokens on
// darwin; elsewhere "Command" must become "Super" and
// "CommandOrControl" must become "Control" before registration.
//
// This module is the single SSOT boundary every accelerator passes
// through: safeRegisterShortcut calls canonicalAcceleratorForPlatform,
// and the status payload published to the renderer records the canonical
// form so the Settings UI shows exactly what was actually bound.
//
// Pure CommonJS, zero dependencies — unit-tested by accelerator.test.js
// (node --test), which runs against the exact code Electron loads.
const TOKEN_MAPS = Object.freeze({
  darwin: Object.freeze({
    cmd: "Command",
    commandorcontrol: "Command",
    meta: "Command",
    // A binding stored as "Super+…" (e.g. synced from a Linux profile)
    // must register as Command on macOS — Electron has no Super key
    // there, and passing it through verbatim silently no-ops the bind.
    super: "Command",
  }),
  default: Object.freeze({
    cmd: "Super",
    commandorcontrol: "Control",
    meta: "Super",
    super: "Super",
  }),
});

function canonicalAcceleratorForPlatform(acc, platform = process.platform) {
  if (!acc || typeof acc !== "string") return acc;
  const map = TOKEN_MAPS[platform] || TOKEN_MAPS.default;
  const rawTokens = acc.split("+");
  // An EMPTY segment means the string is not an Electron accelerator:
  // the plus key is spelled "Plus" ("Control+Plus"), so "Control++" is
  // malformed. Dropping the empties with `.filter(Boolean)` turned that
  // into the single token "Control" — a bare modifier, which
  // safeRegisterShortcut then tried to bind as if the user had asked for
  // it. This module is declared the one boundary every accelerator passes
  // through, so it must hand malformed input BACK unchanged and let the
  // registration fail with the string the user actually stored, rather
  // than repair it into something else.
  if (rawTokens.some((t) => t.trim() === "")) return acc;
  const tokens = rawTokens.map((t) => t.trim());
  const out = new Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const lower = raw.toLowerCase();
    if (lower === "command" || lower === "cmd") out[i] = map.cmd;
    else if (lower === "commandorcontrol" || lower === "cmdorctrl") out[i] = map.commandorcontrol;
    else if (lower === "meta") out[i] = map.meta;
    else if (lower === "super") out[i] = map.super;
    else if (lower === "control" || lower === "ctrl") out[i] = "Control";
    else if (lower === "alt" || lower === "option") out[i] = platform === "darwin" ? "Option" : "Alt";
    else if (lower === "shift") out[i] = "Shift";
    else out[i] = raw;
  }
  return out.join("+");
}

// macOS virtual key codes (Carbon's kVK_*, layout-independent key
// positions — the same codes Electron's globalShortcut registers) for the
// key names an Electron accelerator can carry. The one table: the native
// hotkey tap (desktop/native/dictation-helper/HotkeyTap.swift) receives
// its chords already translated through it. A key missing here (media
// keys, shifted punctuation, "Plus") simply stays on globalShortcut.
//
// Positions, not letters, on purpose — unlike the paste's ⌘V, which
// follows the layout (native/dictation-helper/KeyLayout.swift) because
// the target app reads it by letter. A hotkey binding is a key position:
// Settings records letters and digits from KeyboardEvent.code, the
// physical key (frontend/src/shortcut-capture.ts: "KeyV" → "V" on any
// layout), and globalShortcut registers a Carbon hot key on the fixed
// kVK_ANSI_* position Chromium's table gives each accelerator key name,
// whatever the layout. This table is that same mapping, so the tap fires
// on exactly the key globalShortcut would, and handing a hotkey between
// the two (Secure Input, a helper restart) never moves it to another key
// on Dvorak or with Russian selected.
const MAC_KEY_CODES = Object.freeze({
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07,
  c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10,
  t: 0x11, o: 0x1f, u: 0x20, i: 0x22, p: 0x23, l: 0x25, j: 0x26, k: 0x28,
  n: 0x2d, m: 0x2e,
  1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15, 6: 0x16, 5: 0x17, 9: 0x19, 7: 0x1a,
  8: 0x1c, 0: 0x1d,
  "=": 0x18, "-": 0x1b, "]": 0x1e, "[": 0x21, "'": 0x27, ";": 0x29,
  "\\": 0x2a, ",": 0x2b, "/": 0x2c, ".": 0x2f, "`": 0x32,
  return: 0x24, enter: 0x24, tab: 0x30, space: 0x31, backspace: 0x33,
  escape: 0x35, esc: 0x35, delete: 0x75, home: 0x73, end: 0x77,
  pageup: 0x74, pagedown: 0x79, left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62,
  f8: 0x64, f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f, f13: 0x69, f14: 0x6b,
  f15: 0x71, f16: 0x6a, f17: 0x40, f18: 0x4f, f19: 0x50, f20: 0x5a,
  num0: 0x52, num1: 0x53, num2: 0x54, num3: 0x55, num4: 0x56, num5: 0x57,
  num6: 0x58, num7: 0x59, num8: 0x5b, num9: 0x5c, numdec: 0x41,
  numadd: 0x45, numsub: 0x4e, nummult: 0x43, numdiv: 0x4b,
});

const MAC_MODIFIERS = Object.freeze({ Command: "cmd", Option: "alt", Control: "ctrl", Shift: "shift" });
const MAC_MODIFIER_ORDER = Object.freeze(["cmd", "alt", "ctrl", "shift"]);

/**
 * The chord the native hotkey tap matches for an accelerator:
 * `{keyCode, mods}` with `mods` drawn from cmd/alt/ctrl/shift, or null
 * when the accelerator is malformed, names no key or two keys, or names a
 * key the table does not know — such a binding stays on globalShortcut.
 * Read through canonicalAcceleratorForPlatform, so every spelling the
 * shell accepts ("CommandOrControl", "Option", "Super") means here what
 * it means to globalShortcut on macOS.
 */
function macHotkeyChord(acc) {
  const canonical = canonicalAcceleratorForPlatform(acc, "darwin");
  if (!canonical || typeof canonical !== "string") return null;
  const tokens = canonical.split("+").map((t) => t.trim());
  if (tokens.some((t) => t === "")) return null;
  const mods = new Set();
  let keyCode = null;
  for (const token of tokens) {
    if (Object.prototype.hasOwnProperty.call(MAC_MODIFIERS, token)) {
      mods.add(MAC_MODIFIERS[token]);
      continue;
    }
    if (keyCode !== null) return null;
    const lower = token.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(MAC_KEY_CODES, lower)) return null;
    keyCode = MAC_KEY_CODES[lower];
  }
  if (keyCode === null) return null;
  return { keyCode, mods: MAC_MODIFIER_ORDER.filter((m) => mods.has(m)) };
}

module.exports = { MAC_KEY_CODES, canonicalAcceleratorForPlatform, macHotkeyChord };
