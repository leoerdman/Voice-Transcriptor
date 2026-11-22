/**
 * The microphone the user picked — kept as their intent, not as today's
 * handle for it.
 *
 * The Mic list used to store a bare ``deviceId`` and treat the picker's
 * current value as the truth, which lost the choice in three ordinary
 * situations:
 *
 *  - Chromium salts every ``deviceId`` (and ``groupId``) with the page's
 *    origin. The renderer is served from ``http://127.0.0.1:<port>``, and
 *    the port is 8321 only while it is free — a relaunch on 8322 sees
 *    every microphone under a new id, so the stored one matches nothing.
 *  - A device that is briefly absent (a headset reconnecting, a USB hub
 *    waking, an iPhone dropping out of Continuity range) has no entry in
 *    the list, so the picker fell back to "Default".
 *  - Settings autosave persisted whatever the picker said. Once it showed
 *    "Default", the next save of ANY setting wrote ``mic_id: ""`` — the
 *    choice was gone for good, and every later take followed the system
 *    default, which macOS moves to a Bluetooth headset the moment one
 *    connects.
 *
 * So the preference is a record of what was picked — id, label and group
 * at the moment of picking — which only an explicit pick replaces. Each
 * take resolves it against the current device list: the same id, else the
 * same device under a new id (by its label, then its group), else — while
 * it is absent — the system default for that take only, with the stored
 * choice untouched, so the device is used again as soon as it is back.
 */

/** One ``audioinput`` entry of ``enumerateDevices()``. */
export interface AudioInputDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

/** What the user picked. ``deviceId: ""`` with no label is the system default. */
export interface MicPreference {
  /** The device's id when it was picked (origin-salted, may go stale). */
  deviceId: string;
  /** The device's name when it was picked — the key that survives a new id. */
  label: string;
  /** The device's group when it was picked (also origin-salted). */
  groupId: string;
}

export const SYSTEM_DEFAULT_MIC: MicPreference = Object.freeze({ deviceId: "", label: "", groupId: "" });

/**
 * The Mic list's value for "the picked device, not connected". Chromium's
 * device ids are hex digests, so this never collides with one.
 */
export const MIC_MISSING_VALUE = "picked-missing";

/** Chromium's aliases for "whatever the system picks" — not devices. */
const DEVICE_ALIAS_IDS = new Set(["default", "communications"]);

/** Chromium's prefix on the alias entries: "Default - MacBook Pro Microphone". */
const ALIAS_LABEL_PREFIX = /^\s*(default|communications)\s+-\s+/i;

export function isDeviceAliasId(deviceId: string): boolean {
  return DEVICE_ALIAS_IDS.has(String(deviceId || "").trim());
}

function sameLabel(a: string, b: string): boolean {
  const norm = (s: string) => String(s || "").replace(ALIAS_LABEL_PREFIX, "").trim().toLowerCase();
  const left = norm(a);
  return !!left && left === norm(b);
}

export function isSystemDefaultMic(pref: MicPreference): boolean {
  const id = String(pref.deviceId || "").trim();
  return (!id || isDeviceAliasId(id)) && !String(pref.label || "").trim();
}

/** The stored ``preferences.ui`` fields, as the config holds them. */
export interface StoredMicPreference {
  mic_id?: unknown;
  mic_label?: unknown;
  mic_group_id?: unknown;
}

/**
 * Read the stored preference. A stored alias id ("default" — the list's
 * old "Default - <name>" entry) is the system default by another name.
 */
export function micPreferenceFromStored(stored: StoredMicPreference): MicPreference {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const deviceId = text(stored.mic_id);
  if (isDeviceAliasId(deviceId)) return SYSTEM_DEFAULT_MIC;
  const pref = { deviceId, label: text(stored.mic_label), groupId: text(stored.mic_group_id) };
  return isSystemDefaultMic(pref) ? SYSTEM_DEFAULT_MIC : pref;
}

export function micPreferenceToStored(pref: MicPreference): Required<{ [K in keyof StoredMicPreference]: string }> {
  return { mic_id: pref.deviceId, mic_label: pref.label, mic_group_id: pref.groupId };
}

/**
 * How the preference maps onto the devices present right now.
 *
 *   system-default  — nothing picked; the system's choice.
 *   picked          — the picked device, under the id it was picked with.
 *   picked-relinked — the picked device under a new id (found by label or
 *                     group): a relaunch on another port, a re-paired
 *                     headset.
 *   picked-missing  — the picked device is not connected. This take uses
 *                     ``deviceId`` instead (see ``resolveMicPreference``);
 *                     the preference itself stays as it is.
 *
 * ``kind`` is a support-log contract: the start trace prints it.
 */
export type MicResolutionKind = "system-default" | "picked" | "picked-relinked" | "picked-missing";

export interface MicResolution {
  kind: MicResolutionKind;
  /** What ``getUserMedia`` is asked for ("" = the system default). */
  deviceId: string;
  /** The resolved device's label ("" when it is not in the list). */
  label: string;
}

/** Real devices only — the alias entries name the system default, not a device. */
function realDevices(devices: readonly AudioInputDevice[]): AudioInputDevice[] {
  return devices.filter((d) => d.deviceId && !isDeviceAliasId(d.deviceId));
}

/**
 * Can the list be judged by name at all? Before microphone permission is
 * granted Chromium returns entries with empty ids and labels; an absent
 * device cannot be told from an unnamed one then.
 */
function listIsNamed(devices: readonly AudioInputDevice[]): boolean {
  return realDevices(devices).some((d) => d.label.trim());
}

export function resolveMicPreference(
  pref: MicPreference,
  devices: readonly AudioInputDevice[],
): MicResolution {
  if (isSystemDefaultMic(pref)) return { kind: "system-default", deviceId: "", label: "" };
  const candidates = realDevices(devices);
  const exact = pref.deviceId ? candidates.find((d) => d.deviceId === pref.deviceId) : undefined;
  if (exact) return { kind: "picked", deviceId: exact.deviceId, label: exact.label };

  const byLabel = candidates.filter((d) => sameLabel(pref.label, d.label));
  const relinked = byLabel.find((d) => pref.groupId && d.groupId === pref.groupId)
    || byLabel[0]
    || (() => {
      if (!pref.groupId) return undefined;
      const byGroup = candidates.filter((d) => d.groupId === pref.groupId);
      return byGroup.length === 1 ? byGroup[0] : undefined;
    })();
  if (relinked) return { kind: "picked-relinked", deviceId: relinked.deviceId, label: relinked.label };

  // Absent. With a named list that is a fact: record from the system
  // default this time. With an unnamed one it cannot be known, so ask for
  // the stored id — the capture path falls back to the default if it
  // fails, and nothing is lost if the device is there after all.
  return {
    kind: "picked-missing",
    deviceId: listIsNamed(devices) ? "" : pref.deviceId,
    label: "",
  };
}

/**
 * The preference an explicit pick in the Mic list records, or ``null``
 * when the pick changes nothing (the "not connected" placeholder for the
 * current choice).
 */
export function micPreferenceFromPick(
  value: string,
  devices: readonly AudioInputDevice[],
  current: MicPreference,
): MicPreference | null {
  const id = String(value || "").trim();
  if (!id || isDeviceAliasId(id)) return SYSTEM_DEFAULT_MIC;
  const device = realDevices(devices).find((d) => d.deviceId === id);
  if (device) return { deviceId: device.deviceId, label: device.label, groupId: device.groupId };
  if (id === MIC_MISSING_VALUE) return null;
  // An id the list no longer has (it changed under an open picker):
  // still the user's pick, and resolved by id like any other.
  return id === current.deviceId ? null : { deviceId: id, label: "", groupId: "" };
}

export interface MicPickerOption {
  value: string;
  text: string;
}

export interface MicPickerModel {
  options: MicPickerOption[];
  selected: string;
}

/**
 * What the Mic list shows: "System default" (naming the device it is
 * right now), every real device, and — while the picked device is not
 * connected — that device, marked so, and selected. The list never shows
 * "Default" for a choice that is merely absent, so it never claims a
 * choice the user did not make.
 *
 * Chromium's own "Default - <name>" entry is left out: it is the same
 * system default as the first row, and picking it looked like picking
 * the named device while actually following whatever macOS chose next.
 */
export function micPickerModel(pref: MicPreference, devices: readonly AudioInputDevice[]): MicPickerModel {
  const alias = devices.find((d) => d.deviceId === "default");
  const defaultName = alias ? alias.label.replace(ALIAS_LABEL_PREFIX, "").trim() : "";
  const options: MicPickerOption[] = [
    { value: "", text: defaultName ? `System default (${defaultName})` : "System default" },
  ];
  realDevices(devices).forEach((d, i) => {
    options.push({ value: d.deviceId, text: d.label || `Microphone ${i + 1}` });
  });
  const resolution = resolveMicPreference(pref, devices);
  if (resolution.kind === "system-default") return { options, selected: "" };
  if (resolution.kind !== "picked-missing") return { options, selected: resolution.deviceId };
  options.push({ value: MIC_MISSING_VALUE, text: `${pref.label || "Selected microphone"} — not connected` });
  return { options, selected: MIC_MISSING_VALUE };
}
