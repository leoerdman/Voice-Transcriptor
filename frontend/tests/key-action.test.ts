import { describe, expect, it } from "vitest";
import { keyAction, performKeyAction, type KeyFieldState } from "../src/key-action";

function run(state: KeyFieldState, confirmAnswer: boolean) {
  const calls: string[] = [];
  const done = performKeyAction(state, {
    providerName: "Deepgram",
    confirm: (m) => { calls.push(`confirm:${m.split("\n")[0]}`); return confirmAnswer; },
    save: async () => { calls.push("save"); },
    remove: async () => { calls.push("remove"); },
  });
  return { done, calls };
}

describe("keyAction (FU-06)", () => {
  it("is delete over a stored key with nothing typed — masked or focused-empty", () => {
    expect(keyAction({ saved: true, masked: true, value: "••••" })).toBe("delete");
    expect(keyAction({ saved: true, masked: false, value: "" })).toBe("delete");
  });

  it("is save once something is typed, and none when there is nothing to do", () => {
    expect(keyAction({ saved: true, masked: false, value: "dg_new" })).toBe("save");
    expect(keyAction({ saved: false, masked: false, value: "  " })).toBe("none");
  });
});

describe("performKeyAction (FU-06)", () => {
  it("asks before deleting a stored key and keeps it when the user declines", async () => {
    const { done, calls } = run({ saved: true, masked: false, value: "" }, false);
    expect(await done).toBe("none");
    expect(calls).toEqual(["confirm:Delete the saved Deepgram API key?"]);
  });

  it("deletes after the user confirms", async () => {
    const { done, calls } = run({ saved: true, masked: true, value: "••••" }, true);
    expect(await done).toBe("delete");
    expect(calls).toEqual(["confirm:Delete the saved Deepgram API key?", "remove"]);
  });

  it("saves a typed key without asking", async () => {
    const { done, calls } = run({ saved: true, masked: false, value: "dg_new" }, false);
    expect(await done).toBe("save");
    expect(calls).toEqual(["save"]);
  });
});
