"use strict";

/**
 * One declaration of "this stored hotkey pair is retired; use the platform
 * default instead".
 *
 * ── Why this module exists ────────────────────────────────────────────
 *
 * The rule used to be three hand-written `if` blocks inside
 * `readShortcutsFromConfig` in main.js, and a partial copy of the same rule
 * inside the renderer's `loadCfg`. The copies drifted: BUGS_AUDIT §6.10
 * retired the Windows/Linux `F9`/`F10` pair, main.js grew a third `if` for
 * it, and the renderer never did — so on Windows the main process registered
 * `Control+Alt+Shift+R`, Settings displayed `F9`, and the renderer's autosave
 * wrote `F9`/`F10` back to disk on every session. The two sides could never
 * converge, because each re-derived the answer from its own copy of the rule.
 *
 * The rule is now DATA, derived from `shortcut-defaults.json` — the same file
 * both processes already read for the defaults themselves. Adding a retired
 * pair to `legacy` produces a migration automatically, and
 * `shortcut-migration.test.js` fails if one is added that nothing migrates.
 *
 * Pure module: no Electron, no filesystem, no platform sniffing beyond the
 * `platform` string it is handed, so `node --test` drives it directly.
 */

/**
 * The retired shapes, in the order they are applied.
 *
 * Each entry is `{ id, platforms, match, replace }`:
 *   - `platforms`  "darwin" | "other" | "all" — which platforms it applies to.
 *   - `match(pair)` true when the stored pair is the retired one.
 *   - `replace(pair, defaults)` the pair to use instead.
 *
 * `pairMigrations` is built from the manifest so the accelerators live in
 * exactly one place.
 */
function buildMigrations(manifest) {
  const legacy = (manifest && manifest.legacy) || {};
  const migrations = [];

  // Migration 1 — a Mac config still carrying the cross-platform F9/F10
  // default from pass 15. F9 is Mission Control on macOS, so registering it
  // means the OS hijacks every press and the user reports "the shortcut does
  // nothing".
  if (legacy.macFunctionPair) {
    migrations.push({
      id: "macFunctionPair",
      platforms: "darwin",
      match: (pair) =>
        pair.record === String(legacy.macFunctionPair.record || "") &&
        pair.paste === String(legacy.macFunctionPair.paste || ""),
      replace: (_pair, defaults) => ({ record: defaults.record, paste: defaults.paste }),
      describe: () => `${legacy.macFunctionPair.record}/${legacy.macFunctionPair.paste}`,
    });
  }

  // Migration 2 — `Alt+Shift+7` was unpressable on US/UK layouts (Shift+7 is
  // `&`). It rewrites the PASTE slot only, on every platform.
  if (legacy.unpressablePaste) {
    migrations.push({
      id: "unpressablePaste",
      platforms: "all",
      match: (pair) => pair.paste === String(legacy.unpressablePaste),
      replace: (pair, defaults) => ({ record: pair.record, paste: defaults.paste }),
      describe: () => String(legacy.unpressablePaste),
    });
  }

  // Migration 3 (BUGS_AUDIT §6.10) — a Windows/Linux config still carrying
  // F9/F10. F10 is the Win32 menu-mnemonic-activation key, and F9/F10 are
  // debugger run/step keys in Visual Studio, VS Code and JetBrains IDEs: the
  // OS or the focused app can act on the press even though
  // `globalShortcut.register("F9")` returns true, so the hotkey looks
  // registered and does something else.
  if (legacy.winLinuxFunctionPair) {
    migrations.push({
      id: "winLinuxFunctionPair",
      platforms: "other",
      match: (pair) =>
        pair.record === String(legacy.winLinuxFunctionPair.record || "") &&
        pair.paste === String(legacy.winLinuxFunctionPair.paste || ""),
      replace: (_pair, defaults) => ({ record: defaults.record, paste: defaults.paste }),
      describe: () => `${legacy.winLinuxFunctionPair.record}/${legacy.winLinuxFunctionPair.paste}`,
    });
  }

  // Migration 4 — the screenshot key under Escape (` ~) replaced Option+↓
  // as the default (user, 2026-11-20: "the key under Escape, left of 1,
  // working only in screen mode"). Settings saves every slot, so a config
  // written while Option+↓ was the default carries it as if chosen; only
  // that exact stored value follows the new default.
  if (legacy.retiredScreenShot) {
    migrations.push({
      id: "retiredScreenShot",
      platforms: "darwin",
      match: (pair) => pair.screenShot === String(legacy.retiredScreenShot),
      replace: (pair, defaults) => ({ ...pair, screenShot: defaults.screenShot }),
      describe: () => String(legacy.retiredScreenShot),
      result: (next) => next.screenShot,
    });
  }

  return migrations;
}

function appliesTo(migration, platform) {
  if (migration.platforms === "all") return true;
  if (migration.platforms === "darwin") return platform === "darwin";
  return platform !== "darwin";
}

/**
 * Apply every retired-accelerator rule to a stored `{record, paste,
 * screenShot}` (screenShot optional).
 *
 * Returns `{ record, paste, screenShot, applied }` where `applied` names the
 * migrations that fired, in order — the caller logs them; nothing else
 * reads it.
 *
 * The input is never mutated, and an unrecognised pair is returned unchanged:
 * a user's own accelerator is not a thing this module has an opinion about.
 */
function migrateShortcutPair(stored, { manifest, defaults, platform }) {
  const pair = {
    record: String((stored && stored.record) || "").trim(),
    paste: String((stored && stored.paste) || "").trim(),
    screenShot: String((stored && stored.screenShot) || "").trim(),
  };
  const applied = [];
  for (const migration of buildMigrations(manifest)) {
    if (!appliesTo(migration, platform)) continue;
    if (!migration.match(pair)) continue;
    const next = migration.replace(pair, defaults);
    applied.push({
      id: migration.id,
      from: migration.describe(),
      to: migration.result ? migration.result(next) : `${next.record}/${next.paste}`,
    });
    pair.record = next.record;
    pair.paste = next.paste;
    pair.screenShot = next.screenShot === undefined ? pair.screenShot : next.screenShot;
  }
  return { record: pair.record, paste: pair.paste, screenShot: pair.screenShot, applied };
}

/**
 * Every `legacy` key the manifest declares that this module knows how to
 * migrate. The test compares it against the manifest's own keys, so a retired
 * accelerator added to the data without a rule here fails the suite instead
 * of silently staying in users' configs.
 */
function migratedLegacyKeys(manifest) {
  return buildMigrations(manifest).map((migration) => migration.id);
}

module.exports = { migrateShortcutPair, migratedLegacyKeys };
