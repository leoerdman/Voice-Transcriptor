import { describe, it, expect } from "vitest";

import {
  SOLO_INVITE_KEY,
  SOLO_INVITE_TEXT,
  readSoloInviteDismissed,
  rememberSoloInviteDismissed,
  soloInviteShows,
} from "../src/solo-invite";

/** The two things a storage must do here, and nothing else. */
function store(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe("soloInviteShows", () => {
  it("shows only when there is nothing learned and nobody answered yet", () => {
    expect(soloInviteShows({ invite: true, dismissed: false })).toBe(true);
    expect(soloInviteShows({ invite: true, dismissed: true })).toBe(false);
    // A learned voice means the button itself exists: a call next to a
    // control that is already there is chrome.
    expect(soloInviteShows({ invite: false, dismissed: false })).toBe(false);
    expect(soloInviteShows({ invite: false, dismissed: true })).toBe(false);
  });
});

describe("the one-time flag", () => {
  it("is off until a press writes it", () => {
    const s = store();
    expect(readSoloInviteDismissed(s)).toBe(false);
    rememberSoloInviteDismissed(s);
    expect(s.data[SOLO_INVITE_KEY]).toBe("1");
    expect(readSoloInviteDismissed(s)).toBe(true);
  });

  it("reads only its own value, not any stored string", () => {
    // A key that exists with another value is not an answer: a half-written
    // or foreign value must not silence the call for good.
    expect(readSoloInviteDismissed(store({ [SOLO_INVITE_KEY]: "true" }))).toBe(false);
    expect(readSoloInviteDismissed(store({ [SOLO_INVITE_KEY]: "" }))).toBe(false);
  });

  it("treats a missing or refusing storage as an unanswered call", () => {
    expect(readSoloInviteDismissed(null)).toBe(false);
    const refusing = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(readSoloInviteDismissed(refusing)).toBe(false);
    // The press itself must still work when the flag cannot be written.
    expect(() => rememberSoloInviteDismissed(refusing)).not.toThrow();
    expect(() => rememberSoloInviteDismissed(null)).not.toThrow();
  });
});

describe("the call's sentence", () => {
  it("says what it does and what it costs, in the app's voice", () => {
    expect(SOLO_INVITE_TEXT).toContain("Solo");
    // Twenty, not six: the press records the passage the card puts in front of\n    // him, and a sentence still promising six would be the wrong number in the\n    // one place he reads before deciding.\n    expect(SOLO_INVITE_TEXT).toContain("twenty seconds");
    // The word the naming round removed, and the promise the feature cannot
    // make: the take keeps everything, only the send is narrowed.
    expect(SOLO_INVITE_TEXT).not.toMatch(/owner/i);
    expect(SOLO_INVITE_TEXT).not.toMatch(/delete|erase/i);
  });
});
