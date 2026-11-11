/**
 * Settings → Voice mask: three slots (§5.1), one switch each, and one Forget
 * per voice.
 *
 * The store is the backend's (`backend/voice_profiles.py`): three slots, one
 * enabled at a time. This module is the renderer's whole opinion about that —
 * which rows exist, what each row says, what the line under the heading says,
 * and whether the pane's knob can be pressed — so `main.tsx` writes out a view
 * instead of deciding one.
 *
 * What is deliberately absent, because it was built and then taken back out:
 *
 * - Names. Whoever launched this app is not knowable from inside it, and the
 *   store's field is only a label on a file, so nobody is asked to type one.
 * - A take dropdown and a "make a profile" press. A voice is learned by the
 *   switch that needs it: press an empty slot's switch and the microphone
 *   records six seconds of whoever is at this machine, reading the printed
 *   line. Choosing a recording from a list is a decision the feature never
 *   needed, and the newest take is the last voice a mask should learn — it is
 *   whoever spoke last, not whoever is running the app.
 *
 * One rule comes straight out of the spec and is cheap to lose in a renderer,
 * which is why it lives here: an enabled slot that holds no profile is not
 * "on" (§5.1). A half-written file, or a delete racing a switch, must paint
 * as *off*, never as a switch reading on over an empty row.
 */

export const SLOT_COUNT = 3;

export interface VoiceProfileSlot {
  slot: number;
  /** The store's write stamp. Its presence is what makes a slot a profile. */
  createdAt: string;
}

export interface VoiceProfilesStatus {
  /** Always `SLOT_COUNT` entries; `null` where the slot is empty. */
  slots: (VoiceProfileSlot | null)[];
  /** The kept slot, or `null` when nothing is being kept. */
  enabledSlot: number | null;
  /** Whether the ONNX file the enrolment would load is beside the app. */
  modelAvailable: boolean;
  modelName: string;
}

export interface VoiceSlotRow {
  slot: number;
  /** "Voice 1" — the only handle a slot gets. */
  label: string;
  /** "2026-11-13" when the slot holds a voice, "" when it does not. */
  learnedOn: string;
  empty: boolean;
  /** This is the slot being kept — the mask is on *because of* this row. */
  enabled: boolean;
}

export interface VoiceMaskView {
  rows: VoiceSlotRow[];
  /** Is the mask on: some slot is kept and holds a voice. */
  checked: boolean;
  /** Can the pane's knob be pressed at all. */
  disabled: boolean;
  /** The line under the heading, and the knob's tooltip. */
  summary: string;
}

/**
 * What the view knows beyond the store's answer.
 *
 * An unreachable backend paints as `VOICE_PROFILES_EMPTY`, and every line
 * this module derives from that state names a specific reason — "nothing
 * learned yet", "the weights are not beside the app". Both would be claims
 * about a store nobody managed to read. `unknown` is how the caller says "the
 * last read failed", so the line can say only what is true.
 */
export interface VoiceMaskViewOptions {
  unknown?: boolean;
}

export const VOICE_PROFILES_EMPTY: VoiceProfilesStatus = {
  slots: [null, null, null],
  enabledSlot: null,
  modelAvailable: false,
  modelName: "",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function slotLabel(slot: number): string {
  return `Voice ${slot}`;
}

function normalizeSlot(raw: unknown, slot: number): VoiceProfileSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const createdAt = text((raw as Record<string, unknown>).created_at);
  // The store stamps every write. An object without a stamp is not a
  // profile, and a switch over no profile is a lie.
  if (!createdAt) return null;
  return { slot, createdAt };
}

/** The payload as this section may trust it. */
export function normalizeVoiceProfiles(payload: unknown): VoiceProfilesStatus {
  if (!payload || typeof payload !== "object") return VOICE_PROFILES_EMPTY;
  const source = payload as Record<string, unknown>;
  const raw = Array.isArray(source.slots) ? source.slots : [];
  const slots: (VoiceProfileSlot | null)[] = [];
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    slots.push(normalizeSlot(raw[index], index + 1));
  }

  const enabledRaw = source.enabled_slot;
  const enabledNumber =
    typeof enabledRaw === "number" && Number.isInteger(enabledRaw) ? enabledRaw : null;
  const enabledSlot =
    enabledNumber !== null &&
    enabledNumber >= 1 &&
    enabledNumber <= SLOT_COUNT &&
    slots[enabledNumber - 1] !== null
      ? enabledNumber
      : null;

  return {
    slots,
    enabledSlot,
    modelAvailable: source.model_available === true,
    modelName: text(source.model_name),
  };
}

/** The slot a freshly learned voice goes into: the first empty one, or none. */
export function nextFreeSlot(status: VoiceProfilesStatus): number | null {
  const index = status.slots.findIndex((slot) => slot === null);
  return index === -1 ? null : index + 1;
}

/** The slot a press of the pane's knob acts on: the kept one, else the first filled. */
export function voiceMaskTarget(status: VoiceProfilesStatus): number | null {
  if (status.enabledSlot !== null) return status.enabledSlot;
  const firstFilled = status.slots.findIndex((slot) => slot !== null);
  return firstFilled === -1 ? null : firstFilled + 1;
}

/** The three rows, the line under the heading, and the knob. */
export function voiceMaskView(
  status: VoiceProfilesStatus,
  options: VoiceMaskViewOptions = {},
): VoiceMaskView {
  const rows: VoiceSlotRow[] = status.slots.map((slot, index) => ({
    slot: index + 1,
    label: slotLabel(index + 1),
    learnedOn: slot ? slot.createdAt.slice(0, 10) : "",
    empty: slot === null,
    enabled: status.enabledSlot === index + 1,
  }));
  const learned = rows.filter((row) => !row.empty);
  const kept = rows.find((row) => row.enabled) ?? null;

  if (options.unknown) {
    // Not "no voice" and not "no weights": nobody read the store. Off and
    // unpressed, with the card carrying the actual error.
    return {
      rows,
      checked: false,
      disabled: true,
      summary: "Could not read the voice profiles.",
    };
  }

  if (!status.modelAvailable) {
    const name = status.modelName || "the ONNX file";
    // §2.2: the weights are one file beside the app. Saying so beats offering
    // a press that can only answer "not installed".
    return {
      rows,
      checked: false,
      disabled: true,
      summary: `The mask's weights (${name}) are not beside the app, so no voice can be compared.`,
    };
  }

  if (kept) {
    return {
      rows,
      checked: true,
      disabled: false,
      summary:
        `On: only ${kept.label} is heard. Everyone else arrives as silence, ` +
        "and the take on this machine keeps every word.",
    };
  }

  if (learned.length > 0) {
    const names = learned.map((row) => row.label).join(", ");
    return {
      rows,
      checked: false,
      disabled: false,
      summary:
        `Off. ${names} learned — switch one on to keep only that voice.`,
    };
  }

  return {
    rows,
    checked: false,
    disabled: false,
    // The old sentence said the press would use "your latest recording",
    // which is exactly what it did — and what made the card impossible to
    // understand: it asked for nothing and took somebody's last meeting.
    summary:
      "Off. Nothing learned yet — press a switch and the microphone records " +
      "your voice for six seconds.",
  };
}
