import { describe, expect, it } from "vitest";

import {
  AUTO_KEYTERMS_EMPTY,
  appendKeyterm,
  autoKeytermsSummary,
  parseAutoKeytermsState,
} from "../src/auto-keyterms";

const payload = {
  enabled: true,
  terms: [
    { term: "Deepgram", recordings: 12, included: true },
    { term: "MacBook", recordings: 4, included: false },
  ],
  blocked: ["Tak"],
  manualCount: 16,
  autoCount: 1,
  tokensUsed: 86,
  tokenBudget: 500,
  computedAt: "2026-11-23T10:00:00",
  recordings: 2500,
};

describe("parseAutoKeytermsState", () => {
  it("reads the backend payload", () => {
    const state = parseAutoKeytermsState(payload);
    expect(state.terms.map((t) => t.term)).toEqual(["Deepgram", "MacBook"]);
    expect(state.terms[1].included).toBe(false);
    expect(state.blocked).toEqual(["Tak"]);
    expect(state.tokensUsed).toBe(86);
  });

  it("renders a failed or foreign payload as nothing learned, never a half list", () => {
    expect(parseAutoKeytermsState(null)).toEqual(AUTO_KEYTERMS_EMPTY);
    expect(parseAutoKeytermsState("oops")).toEqual(AUTO_KEYTERMS_EMPTY);
    const state = parseAutoKeytermsState({
      terms: [{ term: "" }, { term: 5 }, null, { term: " Opus ", recordings: -3, included: "yes" }],
      blocked: [1, " Tak "],
      tokensUsed: "NaN",
    });
    expect(state.terms).toEqual([{ term: "Opus", recordings: 0, included: false }]);
    expect(state.blocked).toEqual(["Tak"]);
    expect(state.tokensUsed).toBe(0);
    expect(state.enabled).toBe(AUTO_KEYTERMS_EMPTY.enabled);
  });
});

describe("autoKeytermsSummary", () => {
  it("states the budget the request spends and where the terms came from", () => {
    const line = autoKeytermsSummary(parseAutoKeytermsState(payload));
    expect(line).toContain("86 of 500 tokens used");
    expect(line).toContain("16 yours + 1 automatic");
    expect(line).toContain("2500 recordings");
  });

  it("says when automatic terms are off", () => {
    const line = autoKeytermsSummary(parseAutoKeytermsState({ ...payload, enabled: false }));
    expect(line).toContain("automatic terms are off");
  });

  it("says when nothing has been learned yet", () => {
    expect(autoKeytermsSummary(AUTO_KEYTERMS_EMPTY)).toContain("Nothing learned yet");
  });
});

describe("appendKeyterm", () => {
  it("appends to a comma-separated list", () => {
    expect(appendKeyterm("Sonnet, Opus", "Deepgram")).toBe("Sonnet, Opus, Deepgram");
  });

  it("keeps a newline-separated list newline-separated", () => {
    expect(appendKeyterm("Sonnet\nOpus\n", "Deepgram")).toBe("Sonnet\nOpus\nDeepgram");
  });

  it("starts an empty list", () => {
    expect(appendKeyterm("  ", "Deepgram")).toBe("Deepgram");
  });

  it("leaves the list alone when the term is already there in any casing", () => {
    expect(appendKeyterm("Sonnet, deepgram", "Deepgram")).toBe("Sonnet, deepgram");
  });
});
