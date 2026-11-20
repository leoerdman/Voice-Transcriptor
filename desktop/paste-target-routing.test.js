"use strict";

// DM-17 (Ultra-Audit 2026-11-20): a paste into an app whose process is
// named "Electron" must keep the safe foreign front pid it was routed to,
// not be emptied into a target the very next check refuses as no-target.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { topLevelFunctionSource } = require("./main-source");

test("the paste ladder never empties a routed target before the no-target check", () => {
  const ladder = topLevelFunctionSource("pasteFromClipboard");
  assert.ok(ladder, "pasteFromClipboard not found");
  const noTargetCheck = ladder.indexOf("if (!hasCapturedPasteTarget(effectiveTarget))");
  assert.ok(noTargetCheck > 0);
  const beforeCheck = ladder.slice(0, noTargetCheck);
  assert.doesNotMatch(beforeCheck, /effectiveTarget = emptyCapturedPasteTarget\(\)/);
  assert.doesNotMatch(ladder, /generic-electron-use-frontmost-global/);
  // The routing that remains: a generic Electron target takes the safe
  // foreign front app's concrete pid.
  assert.match(beforeCheck, /targetLooksGenericElectron && shouldUsePasteTarget\(frontBefore\)/);
  assert.match(beforeCheck, /effectiveTarget = capturePasteTargetFromFrontInfo\(frontBefore\)/);
});
