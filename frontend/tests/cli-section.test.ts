import { describe, expect, it } from "vitest";

import {
  CLI_ACCESS_OFF,
  cliDefaultsSummary,
  cliSectionView,
  normalizeCliStatus,
} from "../src/cli-section";

const ON_PAYLOAD = {
  enabled: true,
  base_url: "http://127.0.0.1:8321",
  command_path: "/Users/a/Library/Application Support/Transcriptor/cli/transcriptor",
  cli_dir: "/Users/a/Library/Application Support/Transcriptor/cli",
  cards: [
    { id: "agent", title: "For an agent", text: "Transcriptor is installed…", note: "Paste it." },
    { id: "transcribe", title: "Transcribe a file", text: "'…/transcriptor' transcribe x.mp4", note: "" },
  ],
  defaults: {
    engine: "deepgram",
    model: "nova-3",
    language: "ru",
    diarize: true,
    engines: ["local", "openrouter", "deepgram"],
    local_models: ["small", "medium"],
  },
};

describe("normalizeCliStatus", () => {
  it("reads the backend's payload as it stands", () => {
    const status = normalizeCliStatus(ON_PAYLOAD);
    expect(status.enabled).toBe(true);
    expect(status.baseUrl).toBe("http://127.0.0.1:8321");
    expect(status.cards).toHaveLength(2);
    expect(status.defaults.localModels).toEqual(["small", "medium"]);
  });

  it("treats anything that is not an object as off", () => {
    for (const payload of [null, undefined, "", 0, [], "on"]) {
      expect(normalizeCliStatus(payload)).toEqual(CLI_ACCESS_OFF);
    }
  });

  it("refuses an on-state with no command path", () => {
    // The one combination that would render as a working install the
    // user cannot use: a switch reading on above an empty command.
    const status = normalizeCliStatus({ ...ON_PAYLOAD, command_path: "" });
    expect(status.enabled).toBe(false);
    expect(status.cards).toEqual([]);
  });

  it("drops a card with no command in it", () => {
    const status = normalizeCliStatus({
      ...ON_PAYLOAD,
      cards: [{ id: "a", title: "Empty", text: "   ", note: "n" }, ON_PAYLOAD.cards[1]],
    });
    expect(status.cards.map((card) => card.id)).toEqual(["transcribe"]);
  });

  it("survives a payload whose fields are the wrong shape", () => {
    const status = normalizeCliStatus({
      enabled: true,
      command_path: "/bin/transcriptor",
      cards: "nope",
      defaults: { engines: [1, "local", null], diarize: "yes" },
    });
    expect(status.enabled).toBe(true);
    expect(status.cards).toEqual([]);
    expect(status.defaults.engines).toEqual(["local"]);
    // "yes" is not true: only the boolean the backend sends turns it on.
    expect(status.defaults.diarize).toBe(false);
  });

  it("carries no card while off, whatever the payload holds", () => {
    const status = normalizeCliStatus({ ...ON_PAYLOAD, enabled: false });
    expect(status.cards).toEqual([]);
  });
});

describe("cliDefaultsSummary", () => {
  it("names the engine, the model, the language and diarization", () => {
    expect(
      cliDefaultsSummary({
        engine: "deepgram",
        model: "nova-3",
        language: "ru",
        diarize: true,
        engines: [],
        localModels: [],
      }),
    ).toBe("deepgram/nova-3 · ru · speakers");
  });

  it("falls back to something readable when the app said nothing", () => {
    expect(cliDefaultsSummary(CLI_ACCESS_OFF.defaults)).toBe("local · auto");
  });
});

describe("cliSectionView", () => {
  it("explains what the switch is for while it is off", () => {
    const view = cliSectionView(CLI_ACCESS_OFF);
    expect(view.enabled).toBe(false);
    expect(view.showCards).toBe(false);
    expect(view.summary).toMatch(/agents/);
  });

  it("says where the app is and how a bare command would transcribe", () => {
    const view = cliSectionView(normalizeCliStatus(ON_PAYLOAD));
    expect(view.enabled).toBe(true);
    expect(view.showCards).toBe(true);
    expect(view.summary).toContain("http://127.0.0.1:8321");
    expect(view.summary).toContain("deepgram/nova-3 · ru · speakers");
  });

  it("leaves the address out rather than printing an empty one", () => {
    const view = cliSectionView(normalizeCliStatus({ ...ON_PAYLOAD, base_url: "" }));
    expect(view.summary).not.toContain("at ");
    expect(view.summary.startsWith("On.")).toBe(true);
  });
});
