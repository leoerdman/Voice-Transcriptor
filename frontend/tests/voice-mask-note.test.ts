import { describe, it, expect } from "vitest";

import { formatWithheld, voiceMaskNoteText, type VoiceMaskState } from "../src/voice-mask-note";

const base: VoiceMaskState = { state: "closed", withheldSec: 0, degraded: false, final: false };

describe("voiceMaskNoteText (§5.3/§5.4)", () => {
  it("draws nothing while the gate is refusing nothing", () => {
    // One line less rather than permanent chrome over a recording that
    // went fine. The private half of this rule: "nothing withheld" is a
    // real answer (the gate counted), not an unknown the pane hides.
    expect(voiceMaskNoteText({ ...base, state: "open" })).toBe("");
    expect(voiceMaskNoteText({ ...base, state: "idle" })).toBe("");
  });

  it("says how much is being withheld while it happens", () => {
    const text = voiceMaskNoteText({ ...base, withheldSec: 1.44 });
    expect(text).toContain("1.4 s");
    expect(text).toContain("withholding");
  });

  it("says where the withheld audio still is once the recording stops", () => {
    // The half that makes this a line of state and not an error: the
    // take holds every byte (§1.4), so a user must not read the note as
    // "the app lost my meeting". It says "not sent", never "not
    // transcribed" — a recovery pass re-reads the local take.
    const text = voiceMaskNoteText({ ...base, withheldSec: 4.2, final: true });
    expect(text).toContain("4.2 s");
    expect(text).toContain("still in the recording");
    expect(text).toContain("not sent");
    expect(text).not.toContain("lost");
  });

  it("stops saying it is happening once the recording is over", () => {
    const live = voiceMaskNoteText({ ...base, withheldSec: 2, final: false });
    const done = voiceMaskNoteText({ ...base, withheldSec: 2, final: true });
    expect(live).toContain("withholding");
    expect(done).not.toContain("withholding");
  });

  it("reports a gate that gave up, before anything else", () => {
    // §5.3's "never silent" applies hardest here: a degrade forwarded
    // audio that was never judged. It is not a refusal, and a user who
    // is told nothing would believe the mask was still working.
    const text = voiceMaskNoteText({ ...base, withheldSec: 3.5, degraded: true });
    expect(text).toContain("sent unmasked");
    expect(text).toContain("3.5 s was withheld before that");
  });

  it("reports a degrade even when nothing was withheld before it", () => {
    const text = voiceMaskNoteText({ ...base, withheldSec: 0, degraded: true });
    expect(text).toContain("sent unmasked");
    expect(text).not.toContain("before that");
  });
});

describe("formatWithheld", () => {
  it("keeps one decimal, so the number does not jitter between reports", () => {
    expect(formatWithheld(4.24)).toBe("4.2 s");
    expect(formatWithheld(4.26)).toBe("4.3 s");
  });

  it("names the first tenth of a second instead of printing 0.0", () => {
    expect(formatWithheld(0.04)).toBe("under 0.1 s");
  });

  it("never prints a negative or a NaN as an amount of withheld audio", () => {
    expect(formatWithheld(-3)).toBe("0.0 s");
    expect(formatWithheld(Number.NaN)).toBe("0.0 s");
  });
});
