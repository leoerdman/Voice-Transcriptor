"use strict";

// DM-08 (Ultra-Audit 2026-11-20): main.log keeps 7 days / 50 MB and the
// error dialogs ask users to send it to support. What the user dictated
// must not be in it — length and digest identify a transcript for
// debugging without carrying its words.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { mainSource, topLevelFunctionSource } = require("./main-source");

test("no trace or log line in main.js carries a preview of transcript text", () => {
  assert.doesNotMatch(mainSource, /textPreview\s*:/);
  assert.doesNotMatch(mainSource, /\bpreview\s*:\s*compactLogText\(/);
});

test("the paste and post-stop traces identify the text by length and digest", () => {
  const ladder = topLevelFunctionSource("runPasteLadder");
  assert.match(ladder, /textLen:/);
  assert.match(ladder, /textDigest: textDigest\(text\)/);
  const postStop = topLevelFunctionSource("processPostStopTask");
  assert.match(postStop, /digest: textDigest\(transcript\)/);
});
