import { describe, it, expect } from "vitest";

import {
  MIC_MISSING_VALUE,
  SYSTEM_DEFAULT_MIC,
  micPickerModel,
  micPreferenceFromPick,
  micPreferenceFromStored,
  micPreferenceToStored,
  resolveMicPreference,
  type AudioInputDevice,
  type MicPreference,
} from "../src/mic-preference";

const BUILT_IN = "MacBook Pro Microphone (Built-in)";
const HEADSET = "Leo Liberty 5 BT (Bluetooth)";
const IPHONE = "Leo's iPhone Microphone";

/** The list on port 8321: built-in mic is the system default. */
const macAlone: AudioInputDevice[] = [
  { deviceId: "default", label: `Default - ${BUILT_IN}`, groupId: "g-default" },
  { deviceId: "id-builtin", label: BUILT_IN, groupId: "g-builtin" },
];

/** A Bluetooth headset connected: macOS moves the system default to it. */
const macWithHeadset: AudioInputDevice[] = [
  { deviceId: "default", label: `Default - ${HEADSET}`, groupId: "g-default" },
  { deviceId: "id-headset", label: HEADSET, groupId: "g-headset" },
  { deviceId: "id-builtin", label: BUILT_IN, groupId: "g-builtin" },
];

const pickedBuiltIn: MicPreference = { deviceId: "id-builtin", label: BUILT_IN, groupId: "g-builtin" };

describe("resolveMicPreference", () => {
  it("records from the system default when nothing was picked", () => {
    expect(resolveMicPreference(SYSTEM_DEFAULT_MIC, macWithHeadset))
      .toEqual({ kind: "system-default", deviceId: "", label: "" });
  });

  it("keeps the picked built-in mic when a Bluetooth headset connects", () => {
    expect(resolveMicPreference(pickedBuiltIn, macWithHeadset))
      .toEqual({ kind: "picked", deviceId: "id-builtin", label: BUILT_IN });
  });

  it("finds the picked device under a new id after a relaunch on another port", () => {
    const onPort8322: AudioInputDevice[] = [
      { deviceId: "default", label: `Default - ${HEADSET}`, groupId: "x-default" },
      { deviceId: "x-headset", label: HEADSET, groupId: "x-headset" },
      { deviceId: "x-builtin", label: BUILT_IN, groupId: "x-builtin" },
    ];
    expect(resolveMicPreference(pickedBuiltIn, onPort8322))
      .toEqual({ kind: "picked-relinked", deviceId: "x-builtin", label: BUILT_IN });
  });

  it("matches the label regardless of case and the alias prefix", () => {
    const pref = { deviceId: "old", label: `Default - ${BUILT_IN}`, groupId: "" };
    const devices = [{ deviceId: "new", label: BUILT_IN.toUpperCase(), groupId: "" }];
    expect(resolveMicPreference(pref, devices).deviceId).toBe("new");
  });

  it("prefers the same group among devices with the same name", () => {
    const twins: AudioInputDevice[] = [
      { deviceId: "a", label: "USB Audio Device", groupId: "g-a" },
      { deviceId: "b", label: "USB Audio Device", groupId: "g-b" },
    ];
    const pref = { deviceId: "gone", label: "USB Audio Device", groupId: "g-b" };
    expect(resolveMicPreference(pref, twins).deviceId).toBe("b");
  });

  it("falls back to the group when the device was renamed", () => {
    const pref = { deviceId: "old-iphone", label: IPHONE, groupId: "g-iphone" };
    const devices = [...macAlone, { deviceId: "new-iphone", label: "iPhone Microphone", groupId: "g-iphone" }];
    expect(resolveMicPreference(pref, devices))
      .toEqual({ kind: "picked-relinked", deviceId: "new-iphone", label: "iPhone Microphone" });
  });

  it("never matches the alias entry, even though it carries the device's name", () => {
    const pref = { deviceId: "gone", label: HEADSET, groupId: "" };
    const headsetIsDefaultButAbsent: AudioInputDevice[] = [
      { deviceId: "default", label: `Default - ${HEADSET}`, groupId: "g-default" },
      { deviceId: "id-builtin", label: BUILT_IN, groupId: "g-builtin" },
    ];
    expect(resolveMicPreference(pref, headsetIsDefaultButAbsent).kind).toBe("picked-missing");
  });

  it("uses the system default for a take while the picked device is absent", () => {
    const pickedIphone = { deviceId: "id-iphone", label: IPHONE, groupId: "g-iphone" };
    expect(resolveMicPreference(pickedIphone, macAlone))
      .toEqual({ kind: "picked-missing", deviceId: "", label: "" });
  });

  it("asks for the stored id when the list carries no names (no permission yet)", () => {
    const unnamed: AudioInputDevice[] = [{ deviceId: "", label: "", groupId: "" }];
    expect(resolveMicPreference(pickedBuiltIn, unnamed))
      .toEqual({ kind: "picked-missing", deviceId: "id-builtin", label: "" });
  });

  it("returns to the picked device as soon as it is back", () => {
    const pickedHeadset = { deviceId: "id-headset", label: HEADSET, groupId: "g-headset" };
    expect(resolveMicPreference(pickedHeadset, macAlone).kind).toBe("picked-missing");
    expect(resolveMicPreference(pickedHeadset, macWithHeadset))
      .toEqual({ kind: "picked", deviceId: "id-headset", label: HEADSET });
  });
});

describe("stored preference", () => {
  it("round-trips through the config fields", () => {
    expect(micPreferenceFromStored(micPreferenceToStored(pickedBuiltIn))).toEqual(pickedBuiltIn);
  });

  it("reads absent, malformed and empty fields as the system default", () => {
    expect(micPreferenceFromStored({})).toEqual(SYSTEM_DEFAULT_MIC);
    expect(micPreferenceFromStored({ mic_id: 42, mic_label: null })).toEqual(SYSTEM_DEFAULT_MIC);
    expect(micPreferenceFromStored({ mic_id: "  " })).toEqual(SYSTEM_DEFAULT_MIC);
  });

  it("reads the old \"Default - <name>\" alias pick as the system default", () => {
    expect(micPreferenceFromStored({ mic_id: "default", mic_label: "" })).toEqual(SYSTEM_DEFAULT_MIC);
  });

  it("keeps a legacy id-only pick, resolved by id", () => {
    const legacy = micPreferenceFromStored({ mic_id: "id-builtin" });
    expect(legacy).toEqual({ deviceId: "id-builtin", label: "", groupId: "" });
    expect(resolveMicPreference(legacy, macWithHeadset).kind).toBe("picked");
  });

  it("survives an app restart: the same stored fields resolve to the same device", () => {
    const stored = micPreferenceToStored(pickedBuiltIn);
    const afterRestart = micPreferenceFromStored(JSON.parse(JSON.stringify(stored)));
    expect(resolveMicPreference(afterRestart, macWithHeadset).deviceId).toBe("id-builtin");
  });
});

describe("micPreferenceFromPick — only an explicit pick changes the choice", () => {
  it("records the device's id, name and group", () => {
    expect(micPreferenceFromPick("id-builtin", macWithHeadset, SYSTEM_DEFAULT_MIC)).toEqual(pickedBuiltIn);
  });

  it("records \"System default\" for the first row and for the alias", () => {
    expect(micPreferenceFromPick("", macWithHeadset, pickedBuiltIn)).toEqual(SYSTEM_DEFAULT_MIC);
    expect(micPreferenceFromPick("default", macWithHeadset, pickedBuiltIn)).toEqual(SYSTEM_DEFAULT_MIC);
  });

  it("changes nothing for the not-connected placeholder", () => {
    expect(micPreferenceFromPick(MIC_MISSING_VALUE, macAlone, pickedBuiltIn)).toBeNull();
  });
});

describe("micPickerModel", () => {
  it("names the system default and leaves Chromium's alias entry out", () => {
    const model = micPickerModel(SYSTEM_DEFAULT_MIC, macWithHeadset);
    expect(model.options).toEqual([
      { value: "", text: `System default (${HEADSET})` },
      { value: "id-headset", text: HEADSET },
      { value: "id-builtin", text: BUILT_IN },
    ]);
    expect(model.selected).toBe("");
  });

  it("keeps the picked device selected when a headset connects", () => {
    expect(micPickerModel(pickedBuiltIn, macWithHeadset).selected).toBe("id-builtin");
  });

  it("selects the picked device under its new id", () => {
    const relinked = macWithHeadset.map((d) => (d.deviceId === "id-builtin" ? { ...d, deviceId: "x-builtin" } : d));
    expect(micPickerModel(pickedBuiltIn, relinked).selected).toBe("x-builtin");
  });

  it("shows an absent pick as not connected instead of \"Default\"", () => {
    const pickedHeadset = { deviceId: "id-headset", label: HEADSET, groupId: "g-headset" };
    const model = micPickerModel(pickedHeadset, macAlone);
    expect(model.selected).toBe(MIC_MISSING_VALUE);
    expect(model.options[model.options.length - 1]).toEqual({ value: MIC_MISSING_VALUE, text: `${HEADSET} — not connected` });
  });

  it("numbers devices that have no name", () => {
    const model = micPickerModel(SYSTEM_DEFAULT_MIC, [{ deviceId: "a", label: "", groupId: "" }]);
    expect(model.options.map((o) => o.text)).toEqual(["System default", "Microphone 1"]);
  });
});
