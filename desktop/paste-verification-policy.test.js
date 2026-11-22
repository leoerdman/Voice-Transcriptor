"use strict";

// Executable specification for "stop paying for a verification this app
// can never give us" (BUGS_AUDIT §6.6, hotfix A3).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  UNVERIFIED_STREAK_LIMIT,
  REPROBE_AFTER_SKIPS,
  PASTE_VERIFICATION_OUTCOME: OUTCOME,
  pasteVerificationKey,
  createPasteVerificationPolicy,
  summarizeAxReadTrace,
} = require("./paste-verification-policy");

test("the key prefers a bundle id and falls back to the app name", () => {
  assert.equal(pasteVerificationKey({ bundleId: "com.anthropic.claudefordesktop" }), "com.anthropic.claudefordesktop");
  assert.equal(pasteVerificationKey({ bundleId: "  Com.Example.APP ", appName: "Other" }), "com.example.app");
  assert.equal(pasteVerificationKey({ appName: "Claude" }), "claude");
  assert.equal(pasteVerificationKey({ appName: "  " }), "");
  assert.equal(pasteVerificationKey(), "");
});

test("verification is attempted until two consecutive unreadable outcomes", () => {
  const policy = createPasteVerificationPolicy();
  assert.equal(UNVERIFIED_STREAK_LIMIT, 2);
  assert.equal(policy.shouldAttemptVerification("claude"), true);
  policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  assert.equal(policy.shouldAttemptVerification("claude"), true, "one is not a pattern");
  policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  assert.equal(policy.shouldAttemptVerification("claude"), false, "two in a row is");
});

test("switching off is per target, not global", () => {
  const policy = createPasteVerificationPolicy();
  policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  assert.equal(policy.shouldAttemptVerification("claude"), false);
  assert.equal(policy.shouldAttemptVerification("textedit"), true);
});

test("a verified outcome resets the memory", () => {
  const policy = createPasteVerificationPolicy();
  policy.recordOutcome("notes", OUTCOME.UNREADABLE);
  policy.recordOutcome("notes", OUTCOME.VERIFIED);
  policy.recordOutcome("notes", OUTCOME.UNREADABLE);
  assert.equal(policy.shouldAttemptVerification("notes"), true, "the streak restarted");
  assert.equal(policy.stateFor("notes").unverifiedStreak, 1);
});

test("a failed paste neither counts toward the streak nor clears it", () => {
  // The ladder failed before anything could be read. That is a fact
  // about the paste, not about whether this app is verifiable.
  const policy = createPasteVerificationPolicy();
  policy.recordOutcome("mail", OUTCOME.UNREADABLE);
  policy.recordOutcome("mail", OUTCOME.ERROR);
  assert.equal(policy.stateFor("mail").unverifiedStreak, 1);
  assert.equal(policy.shouldAttemptVerification("mail"), true);
  policy.recordOutcome("mail", OUTCOME.UNREADABLE);
  assert.equal(policy.shouldAttemptVerification("mail"), false);
});

test("the switch-off is announced exactly once per target", () => {
  const disabled = [];
  const policy = createPasteVerificationPolicy({ onDisable: (state) => disabled.push(state) });
  for (let i = 0; i < 6; i += 1) policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  assert.equal(disabled.length, 1, "one log line, not one per paste");
  assert.equal(disabled[0].key, "claude");
  assert.equal(disabled[0].limit, 2);
  assert.equal(disabled[0].unverifiedStreak, 2);
});

test("a throwing onDisable can never break a paste", () => {
  const policy = createPasteVerificationPolicy({
    onDisable: () => {
      throw new Error("log volume full");
    },
  });
  policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  assert.equal(policy.shouldAttemptVerification("claude"), false);
});

test("an unattributable outcome disables nothing", () => {
  const policy = createPasteVerificationPolicy();
  assert.equal(policy.recordOutcome("", OUTCOME.UNREADABLE), null);
  policy.recordOutcome("", OUTCOME.UNREADABLE);
  assert.equal(policy.shouldAttemptVerification(""), true);
});

test("the limit is configurable and never below one", () => {
  const one = createPasteVerificationPolicy({ limit: 1 });
  one.recordOutcome("claude", OUTCOME.UNREADABLE);
  assert.equal(one.shouldAttemptVerification("claude"), false);
  const zero = createPasteVerificationPolicy({ limit: 0 });
  assert.equal(zero.stateFor("claude").limit, UNVERIFIED_STREAK_LIMIT);
});

test("an inconclusive outcome is not evidence and never switches anything off", () => {
  // The reads landed; the length simply did not grow by what we
  // predicted (the target rewrote the text, focus moved, the poll bound
  // expired). While the after-read was being taken BEFORE the paste had
  // landed this was the outcome for every paste into every app, and it
  // switched verification off everywhere after two pastes — taking the
  // user's clipboard restore with it, because that gate only opens for a
  // verified paste.
  const policy = createPasteVerificationPolicy();
  for (let i = 0; i < 10; i += 1) policy.recordOutcome("slack", OUTCOME.INCONCLUSIVE);
  assert.equal(policy.shouldAttemptVerification("slack"), true);
  assert.equal(policy.stateFor("slack").unverifiedStreak, 0);

  // It does not clear a streak either: an app that has already gone
  // silent twice stays switched off.
  const other = createPasteVerificationPolicy();
  other.recordOutcome("claude", OUTCOME.UNREADABLE);
  other.recordOutcome("claude", OUTCOME.INCONCLUSIVE);
  assert.equal(other.stateFor("claude").unverifiedStreak, 1);
  other.recordOutcome("claude", OUTCOME.UNREADABLE);
  assert.equal(other.shouldAttemptVerification("claude"), false);
});

test("stateFor reports a target nothing is known about", () => {
  const policy = createPasteVerificationPolicy();
  assert.deepEqual(policy.stateFor("finder"), {
    key: "finder",
    unverifiedStreak: 0,
    disabled: false,
    limit: 2,
    skipped: 0,
  });
});

test("a switched-off app is probed again every REPROBE_AFTER_SKIPS-th paste, and only that app", () => {
  const policy = createPasteVerificationPolicy({ reprobeAfter: 3 });
  policy.recordOutcome("com.anthropic.claudefordesktop", OUTCOME.UNREADABLE);
  policy.recordOutcome("com.anthropic.claudefordesktop", OUTCOME.UNREADABLE);
  const asked = [1, 2, 3, 4, 5, 6].map(() => policy.shouldAttemptVerification("com.anthropic.claudefordesktop"));
  assert.deepEqual(asked, [false, false, true, false, false, true]);
  // Another app is untouched by the first one's verdict.
  assert.equal(policy.shouldAttemptVerification("com.apple.textedit"), true);
  // The probe found it readable now: back on for good.
  policy.recordOutcome("com.anthropic.claudefordesktop", OUTCOME.VERIFIED);
  assert.equal(policy.shouldAttemptVerification("com.anthropic.claudefordesktop"), true);
  assert.equal(policy.stateFor("com.anthropic.claudefordesktop").disabled, false);
});

test("the default re-probe interval is the exported constant", () => {
  const policy = createPasteVerificationPolicy();
  policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  policy.recordOutcome("claude", OUTCOME.UNREADABLE);
  let probes = 0;
  for (let i = 0; i < REPROBE_AFTER_SKIPS * 2; i++) if (policy.shouldAttemptVerification("claude")) probes++;
  assert.equal(probes, 2);
});

// ── AX read timings ───────────────────────────────────────────────────

test("read timings come from the arrival times of the script markers", () => {
  const summary = summarizeAxReadTrace([
    { line: "AXT:before:begin", ms: 120 },
    { line: "AXT:before:end", ms: 371 },
    { line: "AXT:after:begin", ms: 402 },
    { line: "AXT:after:end", ms: 410 },
  ]);
  assert.deepEqual(summary.reads, [
    { label: "before", ms: 251 },
    { label: "after", ms: 8 },
  ]);
  assert.equal(summary.totalMs, 259);
  assert.equal(summary.unfinished, false);
});

test("a read that began and never ended is reported, not silently dropped", () => {
  // osascript killed by the parent wall-clock bound while the read was
  // still running — the one case where the cost is unbounded.
  const summary = summarizeAxReadTrace([
    { line: "AXT:before:begin", ms: 100 },
    { line: "AXT:before:end", ms: 140 },
    { line: "AXT:after:begin", ms: 200 },
  ]);
  assert.deepEqual(summary.reads, [
    { label: "before", ms: 40 },
    { label: "after", ms: -1 },
  ]);
  assert.equal(summary.totalMs, 40, "an unfinished read contributes no time it cannot know");
  assert.equal(summary.unfinished, true);
});

test("unrelated output and stray ends are ignored", () => {
  const summary = summarizeAxReadTrace([
    { line: "OK:menu-paste-primary", ms: 5 },
    { line: "AXT:after:end", ms: 6 },
    { line: "AXT:before:begin", ms: 10 },
    { line: "AXT:before:end", ms: 12 },
    { line: "", ms: 13 },
  ]);
  assert.deepEqual(summary.reads, [{ label: "before", ms: 2 }]);
  assert.equal(summarizeAxReadTrace().reads.length, 0);
  assert.equal(summarizeAxReadTrace(null).totalMs, 0);
});

test("the AX trace keeps chronological order, unfinished reads included", () => {
  // Reads used to be appended as they CLOSED, with the unfinished ones
  // tacked on at the end — so a trace read top-to-bottom said the wrong
  // read was the one still running when osascript was killed, which is the
  // single question the array exists to answer.
  const summary = summarizeAxReadTrace([
    { line: "AXT:before:begin", ms: 10 },
    { line: "AXT:before:end", ms: 30 },
    { line: "AXT:focus:begin", ms: 40 },   // never ends — killed mid-read
    { line: "AXT:after:begin", ms: 45 },
    { line: "AXT:after:end", ms: 60 },
  ]);
  assert.deepEqual(summary.reads.map((r) => r.label), ["before", "focus", "after"]);
  assert.deepEqual(summary.reads.map((r) => r.ms), [20, -1, 15]);
  assert.equal(summary.unfinished, true);
  assert.equal(summary.totalMs, 35);
  // No bookkeeping field leaks into the trace payload.
  for (const read of summary.reads) assert.deepEqual(Object.keys(read).sort(), ["label", "ms"]);
});

test("two markers in one pipe chunk report 0, not a negative or a guess", () => {
  const summary = summarizeAxReadTrace([
    { line: "AXT:before:begin", ms: 12 },
    { line: "AXT:before:end", ms: 12 },
  ]);
  assert.deepEqual(summary.reads, [{ label: "before", ms: 0 }]);
  assert.equal(summary.unfinished, false);
});

test("main.js actually supplies the bundle id the key prefers", () => {
  // pasteVerificationKey has always preferred bundleId, and main.js never
  // passed one — `grep -c bundleId desktop/main.js` was 0. The promise that
  // "a renamed app cannot inherit another app's verdict" was therefore not
  // kept: the key was the display name, so two apps called "Notes" shared
  // one verdict and a rename lost it.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

  // Read in the same Apple Event as the name and the pid — no extra
  // round trip on the capture path — and guarded, because a faceless
  // process may not have one.
  assert.match(source, /set b to bundle identifier of p/);
  assert.match(source, /bundleId: String\(bundleId \|\| ""\)\.trim\(\)/);
  // Carried on the captured target...
  assert.match(source, /bundleId: String\(src\.bundleId \|\| ""\)\.trim\(\)/);
  assert.match(source, /bundleId: front\?\.bundleId/);
  // ...and handed to the key, ahead of the display name.
  assert.match(
    source,
    /pasteVerificationKey\(\{\s*\n\s*bundleId: effectiveTarget\.bundleId \|\| frontBefore\.bundleId \|\| "",/,
  );
});

test("a missing bundle id still keys on the display name", () => {
  // Windows and Linux have no bundle id at all, and a faceless macOS
  // process may not have one either. The key must not become empty.
  assert.equal(pasteVerificationKey({ bundleId: "", appName: "Sublime Text" }), "sublime text");
  assert.equal(pasteVerificationKey({ appName: "Sublime Text" }), "sublime text");
  // ...and two apps with the same name are only separated when the id is there.
  assert.notEqual(
    pasteVerificationKey({ bundleId: "com.a.notes", appName: "Notes" }),
    pasteVerificationKey({ bundleId: "com.b.notes", appName: "Notes" }),
  );
});
