import { describe, it, expect } from "vitest";

import { parseLanguageHintDefaults, resolveLanguageHints } from "../src/language-hints";

const backend = { options: ["ru", "en", "es", "fr", "de"], defaults: ["ru", "en"] };

describe("language hints — what a stored preference means", () => {
  it("absent means the backend default, never 'none'", () => {
    expect(resolveLanguageHints(undefined, backend)).toEqual(["ru", "en"]);
    expect(resolveLanguageHints("ru,en", backend)).toEqual(["ru", "en"]);
  });

  it("an explicit empty list stays empty", () => {
    expect(resolveLanguageHints([], backend)).toEqual([]);
  });

  it("keeps only offered codes, in the offer's order", () => {
    expect(resolveLanguageHints(["FR", "xx", "ru", "ru"], backend)).toEqual(["ru", "fr"]);
  });
});

describe("language hints — the bootstrap payload", () => {
  it("parses the backend's options and defaults", () => {
    expect(parseLanguageHintDefaults(["ru", "en", "fr"], ["ru", "en"])).toEqual({
      options: ["ru", "en", "fr"],
      defaults: ["ru", "en"],
    });
  });

  it("is null when the backend did not publish an offer", () => {
    expect(parseLanguageHintDefaults(undefined, ["ru"])).toBeNull();
    expect(parseLanguageHintDefaults(["ru"], undefined)).toBeNull();
  });

  it("drops a default the backend does not offer", () => {
    expect(parseLanguageHintDefaults(["ru"], ["ru", "en"])?.defaults).toEqual(["ru"]);
  });
});
