import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SLOT_COUNT,
  VOICE_PROFILES_EMPTY,
  nextFreeSlot,
  normalizeVoiceProfiles,
  voiceMaskTarget,
  voiceMaskView,
} from "../src/voice-profiles-section";

/**
 * The backend's payload, as it comes off the wire: a label and a stamp per
 * slot, one enabled flag, and the weights' name. `name` is still in the file
 * format (the store labels its file), and these tests keep sending it to
 * prove the section does not read it.
 */
const WITH_ONE_KEPT = {
  slots: [
    { slot: 1, name: "take-2026-11-13", created_at: "2026-11-13T00:00:00+00:00" },
    null,
    { slot: 3, name: "take-2026-11-12", created_at: "2026-11-12T00:05:00+00:00" },
  ],
  enabled_slot: 1,
  model_available: true,
  model_name: "campplus_zh_en.onnx",
};

const NOTHING_KEPT = {
  slots: [
    { slot: 1, name: "take-a", created_at: "2026-11-13T00:00:00+00:00" },
    { slot: 2, name: "take-b", created_at: "2026-11-13T00:05:00+00:00" },
  ],
  model_available: true,
  model_name: "campplus_zh_en.onnx",
};

const LEARNED_BUT_OFF = {
  slots: [{ slot: 1, created_at: "2026-11-13T00:00:00+00:00" }, null, null],
  model_available: true,
  model_name: "campplus_zh_en.onnx",
};

const NOTHING_LEARNED = {
  slots: [null, null, null, null, null, null, null],
  enabled_slot: null,
  model_available: true,
  model_name: "campplus_zh_en.onnx",
};

describe("normalizeVoiceProfiles", () => {
  it("reads the backend's payload as it stands", () => {
    const status = normalizeVoiceProfiles(WITH_ONE_KEPT);
    expect(status.slots).toHaveLength(SLOT_COUNT);
    expect(SLOT_COUNT).toBe(7);
    expect(status.slots[0]?.createdAt).toBe("2026-11-13T00:00:00+00:00");
    expect(status.slots[1]).toBeNull();
    expect(status.enabledSlot).toBe(1);
    expect(status.modelAvailable).toBe(true);
    expect(status.modelName).toBe("campplus_zh_en.onnx");
  });

  it("treats anything that is not an object as empty", () => {
    for (const payload of [null, undefined, "", 0, [], "on"]) {
      expect(normalizeVoiceProfiles(payload)).toEqual(VOICE_PROFILES_EMPTY);
    }
  });

  it("always draws three slots, whatever the payload carries", () => {
    expect(normalizeVoiceProfiles({ slots: [] }).slots).toHaveLength(SLOT_COUNT);
    expect(normalizeVoiceProfiles({ slots: [null] }).slots).toHaveLength(SLOT_COUNT);
    const extra = normalizeVoiceProfiles({
      slots: [null, null, null, { slot: 4, created_at: "2026-11-13T00:00:00+00:00" }],
    });
    expect(extra.slots).toHaveLength(SLOT_COUNT);
    expect(extra.slots[2]).toBeNull();
  });

  it("refuses a slot the store never wrote", () => {
    // The store stamps every write. An object with no stamp is from
    // somewhere else, and a switch over no profile is a lie.
    const status = normalizeVoiceProfiles({ slots: [{ slot: 1, name: "x" }] });
    expect(status.slots[0]).toBeNull();
  });

  it("shows the name the user gave a voice", () => {
    // A slot's handle is the name typed on its row, not a generated number:
    // three rows that only say "Voice 1" are three rows nobody can tell apart.
    const status = normalizeVoiceProfiles(WITH_ONE_KEPT);
    const rows = voiceMaskView(status).rows;
    expect(rows[0].label).toBe("take-2026-11-13");
    expect(rows[2].label).toBe("take-2026-11-12");
    // An empty slot has no name to show, so it falls back to its number.
    expect(rows[1].label).toBe("Voice 2");
  });

  it("refuses a kept slot that holds no profile", () => {
    // §5.1 presupposes a profile behind the switch. A delete racing a switch
    // must render as off, not as a switch reading on over an empty row.
    const lost = normalizeVoiceProfiles({
      slots: [null, null, null, null, null, null, null],
      enabled_slot: 2,
    });
    expect(lost.enabledSlot).toBeNull();
  });

  it("ignores a kept slot outside the three", () => {
    for (const enabled_slot of [0, 4, -1, 1.5, "1", null]) {
      const status = normalizeVoiceProfiles({
        slots: [{ slot: 1, created_at: "2026-11-13T00:00:00+00:00" }],
        enabled_slot,
      });
      expect(status.enabledSlot).toBeNull();
    }
  });
});

describe("voiceMaskView", () => {
  it("draws a row per track, whatever the store holds", () => {
    // §5.1: three slots. A list that shrinks when a slot is empty is how a UI
    // silently renumbers the slots under the user's finger.
    for (const payload of [WITH_ONE_KEPT, NOTHING_KEPT, NOTHING_LEARNED, {}]) {
      expect(voiceMaskView(normalizeVoiceProfiles(payload)).rows).toHaveLength(SLOT_COUNT);
    }
    const rows = voiceMaskView(normalizeVoiceProfiles(WITH_ONE_KEPT)).rows;
    expect(rows.slice(0, 3).map((row) => row.label)).toEqual([
      "take-2026-11-13",
      "Voice 2",
      "take-2026-11-12",
    ]);
    expect(rows.slice(3).every((row) => row.empty)).toBe(true);
    expect(rows.slice(0, 3).map((row) => row.empty)).toEqual([false, true, false]);
    expect(rows.slice(0, 3).map((row) => row.enabled)).toEqual([true, false, false]);
    expect(rows[0].learnedOn).toBe("2026-11-13");
    expect(rows[1].learnedOn).toBe("");
  });

  it("paints on when a voice is kept", () => {
    const view = voiceMaskView(normalizeVoiceProfiles(WITH_ONE_KEPT));
    expect(view.checked).toBe(true);
    expect(view.disabled).toBe(false);
    expect(view.visible).toBe(true);
    expect(view.invite).toBe(false);
    expect(view.summary).toContain("only take-2026-11-13 is heard");
    expect(view.summary).toContain("silence");
  });

  it("names the voices it has when none is kept", () => {
    const view = voiceMaskView(normalizeVoiceProfiles(NOTHING_KEPT));
    expect(view.checked).toBe(false);
    expect(view.disabled).toBe(false);
    expect(view.summary).toContain("Off.");
    expect(view.summary).toContain("take-a, take-b");
    expect(view.summary).toContain("switch one on");
  });

  it("invites the press, and the recording behind it, when nothing is learned", () => {
    // The switch is the whole interaction: pressing it is what asks for a
    // recording, so it must be pressable rather than disabled with a note
    // pointing somewhere else. The topbar's button is the exception: it only
    // exists once a voice does.
    const view = voiceMaskView(normalizeVoiceProfiles(NOTHING_LEARNED));
    expect(view.checked).toBe(false);
    expect(view.disabled).toBe(false);
    expect(view.visible).toBe(false);
    expect(view.invite).toBe(true);
    expect(view.summary).toContain("Nothing learned yet");
    // What the press does, said where the press is: the microphone records.
    // "latest recording" was the old behaviour and the whole reason the card
    // read as "something is already there".
    expect(view.summary).toContain("microphone records");
    expect(view.summary).toContain("six seconds");
    expect(view.summary).not.toContain("latest recording");
  });

  it("never says owner, and never names a person", () => {
    // The word is what the whole naming round was about; a summary that
    // creeps back to it is the complexity coming back in a string. Slot
    // numbers are allowed — they are the only handle a voice has.
    for (const payload of [WITH_ONE_KEPT, NOTHING_KEPT, LEARNED_BUT_OFF, NOTHING_LEARNED]) {
      expect(voiceMaskView(normalizeVoiceProfiles(payload)).summary).not.toMatch(/owner/i);
    }
  });

  it("does not offer a press that cannot work without the weights", () => {
    // §2.2/§6.2: one file, and the owner decides whether it ships. The card
    // names the file instead of failing on the press.
    const view = voiceMaskView(
      normalizeVoiceProfiles({
        slots: [null, null, null, null, null, null, null],
        model_available: false,
        model_name: "campplus_zh_en.onnx",
      }),
    );
    expect(view.disabled).toBe(true);
    expect(view.checked).toBe(false);
    expect(view.visible).toBe(false);
    // No call either: an invitation that can only fail is worse than none.
    expect(view.invite).toBe(false);
    expect(view.summary).toContain("campplus_zh_en.onnx");
    expect(view.summary).toContain("not beside the app");
  });

  it("says only what is true when nobody read the store", () => {
    const view = voiceMaskView(VOICE_PROFILES_EMPTY, { unknown: true });
    expect(view.disabled).toBe(true);
    expect(view.checked).toBe(false);
    // Neither a button nor a call over a store nobody read.
    expect(view.visible).toBe(false);
    expect(view.invite).toBe(false);
    expect(view.summary).toContain("Could not read");
    // Not a claim about a store nobody managed to read.
    expect(view.summary).not.toContain("Nothing learned");
  });

  it("still draws a learned voice it cannot keep", () => {
    // The weights missing is about comparing, not about what is stored: the
    // row and its Forget are still the truth of the disk.
    const view = voiceMaskView(
      normalizeVoiceProfiles({ ...LEARNED_BUT_OFF, model_available: false }),
    );
    expect(view.disabled).toBe(true);
    expect(view.rows[0].empty).toBe(false);
    expect(view.rows[0].learnedOn).toBe("2026-11-13");
    // The button stays: it is the only place that can say which file is gone.
    expect(view.visible).toBe(true);
  });
});

describe("nextFreeSlot", () => {
  it("takes the first empty slot", () => {
    expect(nextFreeSlot(normalizeVoiceProfiles({ slots: [null, null, null] }))).toBe(1);
    expect(nextFreeSlot(normalizeVoiceProfiles(NOTHING_KEPT))).toBe(3);
  });

  it("has nowhere to put a voice past the last track", () => {
    expect(
      nextFreeSlot(
        normalizeVoiceProfiles({
          slots: Array.from({ length: SLOT_COUNT }, (_, index) => ({
            slot: index + 1,
            created_at: "2026-11-13T00:0" + index + ":00+00:00",
          })),
        }),
      ),
    ).toBeNull();
  });
});

describe("voiceMaskTarget", () => {
  it("acts on the kept slot, else on the first that holds a voice", () => {
    expect(voiceMaskTarget(normalizeVoiceProfiles(WITH_ONE_KEPT))).toBe(1);
    expect(voiceMaskTarget(normalizeVoiceProfiles(NOTHING_KEPT))).toBe(1);
    expect(voiceMaskTarget(normalizeVoiceProfiles(NOTHING_LEARNED))).toBeNull();
  });
});

describe("the card's markup", () => {
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

  it("has the list, the note, the error line and the pane's knob", () => {
    for (const id of [
      "voiceProfilesNote",
      "voiceProfileSlots",
      "voiceProfilesError",
      "soloItem",
      "soloToggleBtn",
      "soloToggleLabel",
      "soloInvite",
      "soloInviteText",
      "soloInviteLearnBtn",
      "soloInviteDismissBtn",
    ]) {
      expect(html, `#${id} is missing from index.html`).toContain(`id="${id}"`);
    }
  });

  it("asks for no take and no profile press", () => {
    // The dropdown of takes and the "Make profile" button were removed on
    // purpose: the switch that needs a voice learns it.
    for (const gone of [
      'id="voiceEnrolTake"',
      'id="voiceEnrolBtn"',
      'id="voiceEnrolNote"',
      'id="voiceEnrolBlock"',
      'id="voiceMaskOnlyToggle"',
      'id="voiceForgetBtn"',
    ]) {
      expect(html, `${gone} came back`).not.toContain(gone);
    }
    expect(html).not.toContain("Make profile");
  });

  it("cannot be pressed before the store has answered", () => {
    // The button is painted from a fetch, so the markup's own state is what
    // the first frame shows. An enabled button there swallows the first press
    // and then reads "on" with nothing behind it.
    const at = html.indexOf('id="soloToggleBtn"');
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(at, html.indexOf(">", at))).toContain("disabled");
  });

  it("starts with neither a button nor a call, before the store answers", () => {
    // The first frame is the markup's: an enabled button would swallow the
    // first press, and a call shown before the read could say "nothing is
    // learned" about a store nobody has looked at yet.
    for (const id of ["soloItem", "soloInvite"]) {
      const at = html.indexOf(`id="${id}"`);
      expect(at, `#${id} is missing`).toBeGreaterThan(-1);
      expect(html.slice(at, html.indexOf(">", at))).toContain("hidden");
    }
  });

  it("sits beside Rec as the same pressable button", () => {
    // Solo answers the same question Rec does — what the next take does — so
    // it is the same control in the same row, not a knob in another pane.
    const solo = html.indexOf('id="soloToggleBtn"');
    const rec = html.indexOf('id="recordToggleBtn"');
    expect(solo).toBeGreaterThan(-1);
    expect(html.slice(solo - 400, solo)).toContain("top-item-solo");
    expect(solo).toBeLessThan(rec);
    // A button carrying its state, not a bare checkbox with a title.
    const open = html.lastIndexOf("<button", solo);
    const tag = html.slice(open, html.indexOf(">", solo));
    expect(tag).toContain('aria-pressed="false"');
    expect(tag).toContain('class="btn record-toggle-btn solo-toggle-btn"');
    // And the pane no longer holds a second, hidden way to switch it.
    expect(html).not.toContain('id="voiceMaskToggle"');
  });
});

describe("the card's presses", () => {
  const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");

  it("is painted at boot, not only when Settings is opened", () => {
    const boot = main.slice(main.lastIndexOf("setupUploadView();"));
    expect(boot).toContain("void refreshVoiceProfiles();");
  });

  it("draws one row per slot, each with its own switch", () => {
    expect(main).toContain("for (const row of view.rows)");
    expect(main).toContain("item.dataset.slot = String(row.slot)");
    expect(main).toContain("void switchSlot(row.slot, input.checked)");
  });

  it("learns into the slot whose switch was pressed, from a capture", () => {
    // The press records the user for six seconds; it does not reach into the
    // archive. See voice-enrol-prompt.test.ts for what the card promises.
    expect(main).toContain("async function learnInto(slot: number, name: string)");
    expect(main).toContain("if (await learnInto(slot, voiceLabel(slot)))");
    expect(main).toContain("`/api/voice/profiles/${slot}/enrol-live${query}`");
    expect(main).toContain("async function captureEnrolment");
  });

  it("takes the voice's name from the row that is being learned", () => {
    // Each empty row owns its name field (`#voiceName-<slot>`) and records the
    // voice on the spot, so a press learns the row it pressed with the name
    // typed in it.
    expect(main).toContain("voiceName-${row.slot}");
    expect(main).toContain("learnFromThisRow(row.slot)");
    expect(main).not.toContain("window.prompt(");
    expect(main).toContain("?name=${encodeURIComponent(name)}");
  });

  it("no longer borrows the newest take from History", () => {
    // The bug: "press Keep" quietly enrolled from whatever was recorded last,
    // so the card asked nothing and took a meeting's worth of other voices.
    expect(main).not.toContain("voiceMaskReferences");
    expect(main).not.toContain("recording_name: take.name");
    expect(main).not.toContain("const LEARN_ATTEMPTS");
  });

  it("says the press is learning while it records", () => {
    // The switch being on is not the same fact as "six seconds are being
    // taken right now": a filled row says which one it is. An empty row has
    // no switch at all — it is the field and the press.
    expect(main).toContain('meta.textContent = learning ? "Learning…" : row.enabled ? "Catching now" : row.learnedOn;');
    expect(main).toContain('if (row.empty) {');
  });

  it("sends the pane's knob to the card instead of recording blind", () => {
    // The knob lives in Live Preview. With nothing learned, pressing it used
    // to open the microphone for six seconds in a pane that has no line to
    // read and no countdown, so the user was asked to talk to a switch that
    // turned itself back off. The knob now starts nothing and shows the card.
    expect(main).toContain("function revealVoiceMaskCard(): void");
    const fn = main.slice(main.indexOf("async function switchMask("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("voiceProfilesStatus.slots.every((slot) => slot === null)");
    expect(body).toContain('switchView("settings")');
    expect(body).toContain("revealVoiceMaskCard();");
    // And the detour precedes the press that could record, or it is
    // decoration. (The `!on` branch's own `switchSlot` comes first and is a
    // different press: it only ever turns the mask off.)
    expect(body.indexOf("slots.every")).toBeLessThan(
      body.indexOf("await switchSlot(target, true)"),
    );
    expect(body.indexOf('switchView("settings")')).toBeLessThan(
      body.indexOf("await switchSlot(target, true)"),
    );
  });

  it("keeps the keyboard where it was when the rows are rebuilt", () => {
    // Found by UAT: the knob's detour focuses the switch that can learn, and
    // the refresh it triggers lands a moment later, rebuilds every row and
    // drops focus to the body. A keyboard user then has to start the card
    // over — on the one press that is supposed to be a single action.
    expect(main).toContain("function voiceFocusKey()");
    expect(main).toContain("function restoreVoiceFocus(");
    const fn = main.slice(main.indexOf("function renderVoiceMask("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body.indexOf("const focusKey = voiceFocusKey();")).toBeLessThan(
      body.indexOf('list.textContent = "";'),
    );
    expect(body.indexOf("restoreVoiceFocus(focusKey);")).toBeGreaterThan(
      body.indexOf("list.appendChild(item);"),
    );
  });

  it("answers a press it cannot honour instead of disabling the row", () => {
    // A disabled switch answers nothing: the user presses Keep, nothing
    // happens, and the reason ("the weights are not beside the app") sits in a
    // note they have no reason to connect to the press. The row takes the
    // press and the card says why — before the microphone opens.
    expect(main).toContain("input.disabled = voiceProfilesBusy;");
    const fn = main.slice(main.indexOf("async function switchSlot("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("if (view.disabled) {");
    expect(body).toContain("setVoiceProfilesError(view.summary);");
    expect(body.indexOf("setVoiceProfilesError(view.summary);")).toBeLessThan(
      body.indexOf("await learnInto("),
    );
  });

  it("offers one way to learn, not two", () => {
    // An empty row is a name field and a press, and that press records the
    // voice on the spot. The latest-recording lookup and its label went with
    // it: two paths to the same slot is how the card started asking the user
    // to understand its plumbing.
    expect(main).not.toContain("`Learn ${row.label} in six seconds`");
    expect(main).toContain("learnFromThisRow(row.slot)");
    expect(main).not.toContain("enrol-latest");
  });

  it("forgets the voice in the row it belongs to", () => {
    expect(main).toContain("async function forgetSlot(slot: number, label: string)");
    expect(main).toContain("() => apiDelete<unknown>(`/api/voice/profiles/${slot}`)");
  });

  it("holds the press on screen while the store is being asked", () => {
    // The defect this pins: enrolment takes seconds on a cold model, and the
    // row was painted from the payload that predates the press — so the knob
    // flicked on and back, which reads as a switch that refused. The press is
    // painted, disabled for the duration, and dropped the moment the store
    // answers, whatever the answer was.
    expect(main).toContain("let voiceSwitchPending: { slot: number; on: boolean } | null");
    expect(main).toContain("const pending = voiceSwitchPending;");
    expect(main).toContain("const on = pending ? pending.on : view.checked;");
    expect(main).toContain('solo.setAttribute("aria-pressed", String(on));');
    expect(main).toContain('solo.classList.toggle("is-on", on);');
    expect(main).toContain("input.checked = pending && pending.slot === row.slot ? pending.on : row.enabled;");
    expect(main).toContain("voiceSwitchPending = { slot, on };");
    expect(main).toContain("voiceSwitchPending = null;");
    // Set before the first paint of the press, cleared after the last one.
    const fn = main.slice(main.indexOf("async function switchSlot("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body.indexOf("voiceSwitchPending = { slot, on };")).toBeLessThan(
      body.indexOf("try {"),
    );
    expect(body.indexOf("voiceSwitchPending = null;")).toBeGreaterThan(
      body.indexOf("} finally {"),
    );
  });
});

describe("the card's styles", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

  /** The declarations of one rule, by selector, without its braces. */
  function rule(selector: string): string {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, `${selector} has no rule`).toBeGreaterThan(-1);
    const open = css.indexOf("{", start);
    return css.slice(open + 1, css.indexOf("}", open));
  }

  it("gives the voice the only shrinkable column", () => {
    // A row was a flex line whose switch carried `settings-toggle` — `width:
    // 100%` inside a flex item — so the switch ate the row, the copy column
    // collapsed and Forget was pushed off the card. Grid with an explicit
    // `minmax(0, 1fr)` first column is the shape that cannot come back.
    const slot = rule(".voice-slot");
    expect(slot).toContain("display: grid");
    expect(slot).toContain("grid-template-columns: minmax(0, 1fr) auto auto");
  });

  it("keeps the row's switch out of the settings-line variant", () => {
    expect(css).toContain(".voice-slot-switch {");
    expect(css).not.toContain("settings-toggle voice-slot-switch");
  });

  it("marks Solo's on state without borrowing the record alarm", () => {
    // On is a setting the next take obeys; Record's red is the one state where
    // something is happening. Same geometry, different colour.
    expect(css).toContain(".solo-toggle-btn.is-on {");
    expect(css).toContain(".solo-toggle-btn.is-on .record-toggle-dot {");
    expect(css).not.toContain(".solo-toggle-btn.is-recording");
  });

  it("hides the call with the attribute the renderer writes", () => {
    // The global `[hidden]` rule loses to `.solo-invite` on source order, so
    // the call needs its own: otherwise "hidden" renders as a permanent line.
    expect(css).toContain(".solo-invite[hidden] {");
  });
});
