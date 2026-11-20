"use strict";

// The accelerators the main process has bound RIGHT NOW, and how a Settings
// update changes them (Ultra-Audit 2026-11-20 S-11, DM-23).
//
// S-11: the runtime accelerators had two sources. A Settings update passed
// the new keys in once as an "override"; every later re-registration —
// resume from sleep, a capture aborted in Settings — re-read config.json
// instead. The renderer saves that file through a debounced request, so a
// change still in flight (or a failed save while the backend restarts)
// reverted silently on the next re-registration while Settings went on
// showing the new keys. The runtime set is now held in memory: disk seeds
// it once at boot, Settings updates replace it, and every re-registration
// binds exactly it.
//
// DM-23(a): an update that cleared an optional slot (screen, screenShot —
// "" = unbound) was refilled from disk (``override.screen ||
// fromDisk.screen``), so the user could not unbind it live. A slot the
// update carries is taken as given, the empty string included; only a
// slot the message does not carry at all keeps its current value.
//
// Record and paste are required: an update without both is rejected, and
// the caller must then put the previous bindings back (DM-23(b)) rather
// than leave every hotkey unregistered until the capture failsafe fires.
//
// Pure — desktop/shortcut-runtime.test.js.

const REQUIRED_SLOTS = Object.freeze(["record", "paste"]);
const OPTIONAL_SLOTS = Object.freeze(["screen", "screenShot"]);

function normalizeShortcutSet(set) {
  const src = set && typeof set === "object" ? set : {};
  const out = {};
  for (const slot of [...REQUIRED_SLOTS, ...OPTIONAL_SLOTS]) out[slot] = String(src[slot] || "").trim();
  return out;
}

/**
 * @param {object} current  the accelerators bound now
 * @param {object} message  the Settings bridge "update" payload
 * @returns {{ok: true, shortcuts: object} | {ok: false, reason: string}}
 */
function applyShortcutUpdate(current, message) {
  const msg = message && typeof message === "object" ? message : {};
  const base = normalizeShortcutSet(current);
  const next = { ...base };
  for (const slot of REQUIRED_SLOTS) {
    const value = String(msg[slot] || "").trim();
    if (!value) return { ok: false, reason: `missing ${slot}` };
    next[slot] = value;
  }
  for (const slot of OPTIONAL_SLOTS) {
    if (Object.prototype.hasOwnProperty.call(msg, slot)) next[slot] = String(msg[slot] ?? "").trim();
  }
  return { ok: true, shortcuts: next };
}

/**
 * The Settings status of the screenshot slot (DM-24, S-09).
 *
 * The key is bound only while a screen take runs, so its status used to
 * be hard-coded ``{active: "", error: ""}`` — a key another app owns was
 * never reported, and the one key the user presses mid-take could be dead
 * with no sign anywhere. The status now carries the fact: outside a take,
 * what a registration probe answered; during a take, what binding it did.
 *
 * @param {{desired: string, supported: boolean, error?: string, bound?: string}} input
 *   ``error`` — the probe's or the bind's refusal ("" = the key is ours to
 *   take); ``bound`` — the accelerator held right now (only during a take).
 */
function screenShotSlotStatus({ desired = "", supported = true, error = "", bound = "" } = {}) {
  if (!supported) return { desired: String(desired || ""), active: "", error: "unsupported" };
  return { desired: String(desired || ""), active: String(bound || ""), error: desired ? String(error || "") : "" };
}

module.exports = {
  REQUIRED_SLOTS,
  OPTIONAL_SLOTS,
  normalizeShortcutSet,
  applyShortcutUpdate,
  screenShotSlotStatus,
};
