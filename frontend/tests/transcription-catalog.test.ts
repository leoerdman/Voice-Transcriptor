import { describe, expect, it } from "vitest";
import {
  buildTranscriptionCatalog,
  defaultModelForGroup,
  groupFromWire,
  isLocalGroup,
  transcriptionModelLabel,
  wireProviderForGroup,
} from "../src/transcription-catalog";

const input = {
  whisperModels: ["tiny", "base", "small", "medium", "large-v3"],
  gigaamModels: ["gigaam-v3-e2e-rnnt", "gigaam-v3-rnnt"],
  engines: { whisper: true, gigaam: true },
  deepgramModels: ["nova-3", "nova-2"],
  openrouterModels: ["google/gemini-2.5-flash"],
};

describe("buildTranscriptionCatalog", () => {
  it("exposes labeled whisper models as their own group", () => {
    const groups = buildTranscriptionCatalog(input);
    const whisper = groups.find((g) => g.id === "local-whisper")!;
    expect(whisper.label).toBe("Local Whisper");
    expect(whisper.models.map((m) => m.label)).toEqual([
      "Whisper Tiny",
      "Whisper Base",
      "Whisper Small",
      "Whisper Medium",
      "Whisper Large-v3",
    ]);
  });

  it("exposes gigaam as its own group, listing exactly what it is given", () => {
    const groups = buildTranscriptionCatalog(input);
    const gigaam = groups.find((g) => g.id === "gigaam")!;
    expect(gigaam.models.map((m) => m.id)).toEqual(input.gigaamModels);
    expect(gigaam.models[0].label).toBe("GigaAM v3 E2E RNNT");
  });

  it("marks local models unavailable when their engine is missing", () => {
    const groups = buildTranscriptionCatalog({ ...input, engines: { whisper: true, gigaam: false } });
    const gigaam = groups.find((g) => g.id === "gigaam")!;
    expect(gigaam.models.every((m) => !m.available)).toBe(true);
    const whisper = groups.find((g) => g.id === "local-whisper")!;
    expect(whisper.models.every((m) => m.available)).toBe(true);
  });
});

describe("wire mapping", () => {
  it("maps gigaam group to wire provider local", () => {
    expect(wireProviderForGroup("gigaam")).toBe("local");
    expect(wireProviderForGroup("local-whisper")).toBe("local");
    expect(wireProviderForGroup("deepgram")).toBe("deepgram");
    expect(wireProviderForGroup("openrouter")).toBe("openrouter");
  });

  it("recovers the UI group from a persisted wire selection", () => {
    expect(groupFromWire("local", "small")).toBe("local-whisper");
    expect(groupFromWire("local", "gigaam-v3-rnnt")).toBe("gigaam");
    expect(groupFromWire("deepgram", "nova-3")).toBe("deepgram");
    expect(groupFromWire("openrouter", "x")).toBe("openrouter");
    expect(groupFromWire("", "")).toBe("local-whisper");
  });

  it("classifies local groups for the live assist path", () => {
    expect(isLocalGroup("gigaam")).toBe(true);
    expect(isLocalGroup("local-whisper")).toBe(true);
    expect(isLocalGroup("deepgram")).toBe(false);
  });
});

describe("transcriptionModelLabel", () => {
  it("labels known ids and falls back to the raw id", () => {
    expect(transcriptionModelLabel("local-whisper", "small")).toBe("Whisper Small");
    expect(transcriptionModelLabel("gigaam", "gigaam-v3-e2e-rnnt")).toBe("GigaAM v3 E2E RNNT");
    // A model the catalog no longer offers keeps no label of its own; the
    // raw id is the documented fallback.
    expect(transcriptionModelLabel("gigaam", "gigaam-v3-rnnt")).toBe("gigaam-v3-rnnt");
    expect(transcriptionModelLabel("deepgram", "nova-3")).toBe("nova-3");
  });
});

describe("defaultModelForGroup — one answer for 'what is selected here'", () => {
  // Production, 2026-08-25: the user switched the group to GigaAM, the
  // selector showed a GigaAM model, and five consecutive sessions ran
  // `model=small`. The selector fell back to the group's first model and
  // the reader of the selection fell back to the global default — two
  // fallbacks for one question, disagreeing by engine.
  const groups = buildTranscriptionCatalog({
    whisperModels: ["small", "medium", "large-v3"],
    gigaamModels: ["gigaam-v3-e2e-rnnt", "gigaam-v3-rnnt"],
    engines: { whisper: true, gigaam: true },
    deepgramModels: ["nova-3"],
    openrouterModels: ["google/gemini-2.5-flash"],
  });

  it("answers within the group, not with the global default", () => {
    expect(defaultModelForGroup(groups, "gigaam")).toBe("gigaam-v3-e2e-rnnt");
    expect(defaultModelForGroup(groups, "local-whisper")).toBe("small");
  });

  it("matches what the selector displays — the group's first entry", () => {
    for (const group of groups) {
      expect(defaultModelForGroup(groups, group.id)).toBe(group.models[0].id);
    }
  });

  it("prefers a model whose engine is actually installed", () => {
    const noGigaam = buildTranscriptionCatalog({
      whisperModels: ["small"],
      gigaamModels: ["gigaam-v3-e2e-rnnt", "gigaam-v3-rnnt"],
      engines: { whisper: true, gigaam: false },
      deepgramModels: [],
      openrouterModels: [],
    });
    const picked = defaultModelForGroup(noGigaam, "gigaam");
    // Nothing in the group is available, so the first entry stands —
    // the UI shows it disabled rather than the reader inventing another
    // engine behind the user's back.
    expect(picked).toBe("gigaam-v3-e2e-rnnt");
  });

});
