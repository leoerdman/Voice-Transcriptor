"use strict";

// Executable specification for desktop/shortcut-defaults.json — the SSOT
// data source readShortcutsFromConfig() (desktop/main.js) reads at startup
// and frontend/vite.config.ts injects into the renderer as
// __SHORTCUT_DEFAULTS__.
//
// The rationale below used to live in the manifest as an "_comment" key.
// The manifest is stringified whole into the production renderer bundle,
// so 845 characters of prose shipped to every user. It belongs with the
// assertions it justifies:
//
// BUGS_AUDIT 2026-09-03 §6.10: the old default/default pair (F9/F10)
// collides with Win32 menu-mnemonic activation (F10) and with the debugger
// run/step keys in Visual Studio, VS Code and JetBrains IDEs
// (F5/F8/F9/F10/F11), plus Excel's F9 recalculate-now. Registering a global
// hotkey does not stop the OS or a focused app from also acting on the same
// key, so those presses either did nothing (globalShortcut.register still
// returned true) or fired both actions at once. Control+Alt+Shift+<letter>
// avoids all of that: it is not a single- or double-modifier combo any of
// those surfaces claim (e.g. Ctrl+Alt+V is Office's 'Paste Special', but
// adding Shift makes it a different accelerator), and it still registers as
// a 3-modifier chord on every Windows/Linux desktop environment tested.
// darwin keeps its existing Alt+Left/Alt+Shift+V defaults unchanged.
//
// Run: node --test desktop/  (or npm test in desktop/).
const { test } = require("node:test");
const assert = require("node:assert/strict");

const manifest = require("./shortcut-defaults.json");

test("darwin defaults are unchanged (Alt+Left / Alt+Shift+V) plus the screen-mode pair", () => {
  assert.deepEqual(manifest.platformDefaults.darwin, {
    record: "Alt+Left",
    paste: "Alt+Shift+V",
    // Screen mode (macOS-only): Alt+Right toggles a screen-mode take; the
    // key under Escape (` ~) saves a screenshot — bound only while screen
    // mode runs, so outside it the key types as usual (user, 2026-11-20).
    screen: "Alt+Right",
    screenShot: "`",
  });
});

test("the darwin defaults are four distinct accelerators", () => {
  const values = Object.values(manifest.platformDefaults.darwin);
  assert.equal(new Set(values).size, values.length);
});

test("screen mode has no default off macOS (it is not supported there)", () => {
  assert.equal(manifest.platformDefaults.default.screen, undefined);
  assert.equal(manifest.platformDefaults.default.screenShot, undefined);
});

test("no win32/linux default is a bare function key, in either slot", () => {
  // The old assertions were `record !== "F9"` and `paste !== "F10"`, which a
  // default of `record: "F10"` would have walked straight past — and F10 is
  // the very key (Win32 menu-mnemonic activation) the change was made to get
  // away from. A slot-specific check does not express the rule.
  const { record, paste } = manifest.platformDefaults.default;
  const legacy = new Set([
    manifest.legacy.winLinuxFunctionPair.record,
    manifest.legacy.winLinuxFunctionPair.paste,
    manifest.legacy.macFunctionPair.record,
    manifest.legacy.macFunctionPair.paste,
    manifest.legacy.unpressablePaste,
  ]);
  for (const acc of [record, paste]) {
    assert.ok(!/^F\d{1,2}$/.test(acc), `a bare function key is not usable as a global default: "${acc}"`);
    assert.ok(!legacy.has(acc), `"${acc}" is a retired default`);
  }
});

test("default (win32/linux) accelerators are distinct three-modifier chords", () => {
  const { record, paste } = manifest.platformDefaults.default;
  assert.notEqual(record, paste);
  for (const acc of [record, paste]) {
    const parts = acc.split("+");
    // Three modifiers plus a key. The old assertion was named "3+ modifier
    // chords" and then checked `parts.length >= 3` — two modifiers and a
    // key, one fewer than the collision analysis in shortcut-defaults.json
    // relies on. Ctrl+Alt+V IS Office's Paste Special; the third modifier is
    // exactly what makes the default a different accelerator.
    assert.ok(parts.length >= 4, `expected three modifiers and a key, got "${acc}"`);
    assert.ok(
      !/^F\d{1,2}$/.test(parts[parts.length - 1]),
      `the key itself must not be a function key: "${acc}"`,
    );
  }
});

test("legacy.winLinuxFunctionPair records the exact stale default migrateShortcuts must catch", () => {
  assert.deepEqual(manifest.legacy.winLinuxFunctionPair, { record: "F9", paste: "F10" });
});

test("legacy.macFunctionPair is untouched by this change", () => {
  assert.deepEqual(manifest.legacy.macFunctionPair, { record: "F9", paste: "F10" });
});

test("no default accelerator collides with the darwin defaults (cross-platform config sync safety)", () => {
  const darwin = manifest.platformDefaults.darwin;
  const other = manifest.platformDefaults.default;
  assert.notEqual(darwin.record, other.record);
  assert.notEqual(darwin.paste, other.paste);
});

test("the documented Windows/Linux hotkeys are the ones the app registers", () => {
  // README.md and README.en.md printed F9 / F10 for eleven days after this
  // manifest stopped using them: a user read the documentation, pressed F9,
  // and nothing happened. The READMEs are the only place a Windows user
  // learns the chord before first launch.
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(__dirname, "..");
  // How the READMEs spell an accelerator: each segment in backticks, joined
  // by "+", with Electron's "Control" written the way a keyboard prints it.
  const documented = (acc) =>
    acc.split("+").map((part) => `\`${part === "Control" ? "Ctrl" : part}\``).join("+");

  const { record, paste } = manifest.platformDefaults.default;
  const retired = [
    manifest.legacy.winLinuxFunctionPair.record,
    manifest.legacy.winLinuxFunctionPair.paste,
  ];

  for (const name of ["README.md", "README.en.md"]) {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    for (const acc of [record, paste]) {
      assert.ok(
        source.includes(documented(acc)),
        `${name} does not document the current Windows/Linux default ${acc} (expected ${documented(acc)})`,
      );
    }
    for (const stale of retired) {
      assert.ok(
        !source.includes(`\`${stale}\``),
        `${name} still documents the retired default \`${stale}\``,
      );
    }
  }
});

test("the manifest carries data only — it is stringified into the renderer bundle", () => {
  // frontend/vite.config.ts does `__SHORTCUT_DEFAULTS__: JSON.stringify(...)`,
  // so every byte of this file ships to every user. Prose belongs in this
  // file, next to the assertions it explains.
  const walk = (node, at) => {
    if (node === null || typeof node !== "object") {
      assert.equal(typeof node, "string", `${at}: only accelerator strings belong here`);
      assert.ok(node.length <= 40, `${at}: ${node.length} characters is prose, not an accelerator`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      assert.ok(!key.startsWith("_"), `${at}.${key}: no comment keys — they ship to users`);
      walk(value, `${at}.${key}`);
    }
  };
  walk(manifest, "manifest");
});
