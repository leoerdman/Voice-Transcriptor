import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Auto-stop-on-silence is one product decision expressed in three layers,
 * and it used to be written out in each of them: the `index.html` input
 * attributes, `getAutoStopSilenceConfig`, `loadCfg`, and
 * `desktop/main.js`. Four copies of three numbers and two ranges, with
 * no cross-reference, no type, no test, and no backend validation —
 * `config.py` has no `ui` branch at all, so nothing arbitrates.
 *
 * `UI_TOKENS.autoStopSilence` is now the source. The renderer reads it
 * directly; these tests pin the two layers that cannot import it — the
 * markup, which is written at boot by `applyAutoStopSilenceBounds`, and
 * the main process, which keeps a frozen fallback for the case where the
 * renderer has not yet handed it a status snapshot.
 */
const REPO = resolve(process.cwd(), "..");
const mainTsx = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const desktopMain = readFileSync(resolve(REPO, "desktop/main.js"), "utf8");

/** The token block, read out of the source rather than imported: `main.tsx` cannot be loaded outside a DOM app. */
function autoStopTokens(): Record<string, number | boolean> {
  const block = /autoStopSilence:\s*\{([^}]*)\}/.exec(mainTsx);
  expect(block, "UI_TOKENS.autoStopSilence not found in main.tsx").toBeTruthy();
  const out: Record<string, number | boolean> = {};
  for (const m of String(block?.[1]).matchAll(/(\w+):\s*(-?[\d_]+|true|false)/g)) {
    out[m[1]] = m[2] === "true" ? true : m[2] === "false" ? false : Number(m[2].replace(/_/g, ""));
  }
  return out;
}

describe("UI_TOKENS.autoStopSilence", () => {
  const tokens = autoStopTokens();

  it("declares the whole decision in one place", () => {
    expect(tokens).toEqual({
      defaultEnabled: false,
      defaultSeconds: 2,
      minSeconds: 1,
      maxSeconds: 120,
      defaultThresholdDb: -42,
      minThresholdDb: -80,
      maxThresholdDb: -10,
    });
  });

  it("states bounds that contain their own defaults", () => {
    expect(Number(tokens.defaultSeconds)).toBeGreaterThanOrEqual(Number(tokens.minSeconds));
    expect(Number(tokens.defaultSeconds)).toBeLessThanOrEqual(Number(tokens.maxSeconds));
    expect(Number(tokens.defaultThresholdDb)).toBeGreaterThanOrEqual(Number(tokens.minThresholdDb));
    expect(Number(tokens.defaultThresholdDb)).toBeLessThanOrEqual(Number(tokens.maxThresholdDb));
  });
});

describe("the markup keeps no copy of the numbers", () => {
  for (const id of ["autoStopSilenceSeconds", "autoStopSilenceDb"]) {
    it(`#${id} carries no min/max/value attribute`, () => {
      const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0]
        // The attributes may sit on either side of the id across the
        // element's two source lines.
        ?? new RegExp(`<input id="${id}"[\\s\\S]{0,200}?/>`).exec(html)?.[0];
      expect(tag, `#${id} is missing from index.html`).toBeTruthy();
      expect(String(tag)).not.toMatch(/\bmin=/);
      expect(String(tag)).not.toMatch(/\bmax=/);
      expect(String(tag)).not.toMatch(/\bvalue=/);
    });
  }
});

describe("the main process keeps no copy of the numbers (FU-13c)", () => {
  /**
   * `desktop/main.js` used to keep `DEFAULT_RECORDING_AUTO_STOP_CONFIG`, a
   * second copy of these defaults held in step only by a cross-check here.
   * It now applies what the renderer publishes or nothing
   * (desktop/auto-stop-config.js, behaviour-tested there), so there is no
   * copy to agree with.
   */
  it("desktop/main.js declares no auto-stop default of its own", () => {
    expect(desktopMain).not.toContain("DEFAULT_RECORDING_AUTO_STOP_CONFIG");
    expect(desktopMain).toContain("parseAutoStopConfig(");
  });
});
