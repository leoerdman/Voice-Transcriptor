"use strict";

// Executable specification for desktop/paste-capability.js — the state
// machine that decides whether auto-paste can work at all, the single
// retry/timeout table the paste ladder spends, and the modifier-release
// plan for the paste-last hotkey. Run: npm --prefix desktop test.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  PASTE_CAPABILITY,
  PASTE_PROBE_ACTIVE_TTL_MS,
  PASTE_PROBE_RECHECK_MS,
  PASTE_PROBE_COMMAND,
  PASTE_PROBE_TIMEOUT_MS,
  PASTE_PERMISSION_ROUTE,
  classifyPastePermissionFailure,
  pasteActivationTimeoutMs,
  pasteAutoSendTimeoutMs,
  pasteAutoSendSettleMs,
  SILENT_FAILURES_BEFORE_BROKEN,
  initialPasteCapability,
  applyProbeResult,
  applyPasteOutcome,
  classifyPasteFailure,
  shouldAttemptPaste,
  shouldProbe,
  mustProbeBeforePaste,
  pasteCapabilityMessage,
  TCC_SERVICE,
  PERMISSION_REPAIR,
  PERMISSION_REPAIR_SERVICES,
  detectBundleReplacement,
  tccServiceForPasteFailure,
  preferSpecificFailureReason,
  planPermissionRepair,
  permissionRepairCommand,
  permissionRepairMessage,
  infoPlistString,
  parseBundleIdentity,
  PASTE_BUDGET,
  PASTE_MAX_ATTEMPTS,
  PASTE_POST_STOP_DEADLINE_MS,
  pasteBudgetFor,
  pasteAttemptDelayMs,
  pasteMethodTimeoutMs,
  pasteBudgetWorstCaseMs,
  pasteKeyAnswerTimeoutMs,
  NS_EVENT_MODIFIER_FLAGS,
  planModifierRelease,
  modifierReleaseScript,
  modifierReleaseCommand,
  MODIFIER_SPAWN_ALLOWANCE_MS,
  parseModifierReleaseResult,
  heldModifiersFromFlags,
} = require("./paste-capability");

// ── states ────────────────────────────────────────────────────────────

test("a fresh process is unknown and has never probed", () => {
  const cap = initialPasteCapability(1000);
  assert.equal(cap.state, PASTE_CAPABILITY.UNKNOWN);
  assert.equal(cap.probedAt, 0);
  assert.equal(shouldProbe(cap, 1000), true);
});

test("trusted + working probe = active", () => {
  const cap = applyProbeResult(initialPasteCapability(0), {
    platform: "darwin", trusted: true, probeOk: true, now: 10,
  });
  assert.equal(cap.state, PASTE_CAPABILITY.ACTIVE);
  assert.equal(cap.probedAt, 10);
  assert.equal(shouldAttemptPaste(cap), true);
});

test("trusted + failing probe = broken — the stale post-update grant", () => {
  // The whole reason this module exists: AXIsProcessTrusted() says yes,
  // the real action says no. Reporting "pasted" here is the lie.
  const cap = applyProbeResult(initialPasteCapability(0), {
    platform: "darwin", trusted: true, probeOk: false, probeReason: "probe-empty", now: 10,
  });
  assert.equal(cap.state, PASTE_CAPABILITY.BROKEN);
  assert.match(cap.reason, /stale-grant/);
  assert.equal(shouldAttemptPaste(cap), false);
});

test("one timed-out probe is a loaded machine, not a dead grant — the probe obeys the paste's rule", () => {
  // main.log 2026-11-20T15:02:40Z: two pastes landed at 14:55 and 15:01,
  // then the focus probe took 1150 ms against its 1000 ms bound and the
  // app raised "Auto-paste could not reach macOS — stale-grant:Timed out".
  const T0 = 1000;
  const active = applyProbeResult(initialPasteCapability(0), {
    platform: "darwin", trusted: true, probeOk: true, now: T0,
  });
  const once = applyProbeResult(active, {
    platform: "darwin", trusted: true, probeOk: false, probeReason: "Timed out", now: T0 + 100,
  });
  assert.equal(once.state, PASTE_CAPABILITY.ACTIVE, "a single timeout must not condemn the grant");
  assert.equal(once.silentFailures, 1);
  assert.equal(shouldAttemptPaste(once), true);
  assert.equal(mustProbeBeforePaste(once), false, "the next paste is not held up by the strike");
  assert.equal(
    planPermissionRepair({ platform: "darwin", state: once, reason: once.reason, trusted: true }).action,
    PERMISSION_REPAIR.NONE,
    "no dialog on one timeout",
  );
  // The strike is settled at the recheck cadence, not after a full minute.
  assert.equal(shouldProbe(once, T0 + 100 + PASTE_PROBE_RECHECK_MS), true);

  // A second silent failure in a row — probe or paste, one counter — is the signature.
  const twice = applyProbeResult(once, {
    platform: "darwin", trusted: true, probeOk: false, probeReason: "AppleEvent timed out (-1712)", now: T0 + 200,
  });
  assert.equal(twice.state, PASTE_CAPABILITY.BROKEN);
  assert.match(twice.reason, /^stale-grant:/);
  const viaPaste = applyPasteOutcome(once, { ok: false, reason: "osascript-failed\nTimed out", now: T0 + 200 });
  assert.equal(viaPaste.state, PASTE_CAPABILITY.BROKEN);

  // A probe that answers in between clears the strike.
  const cleared = applyProbeResult(once, { platform: "darwin", trusted: true, probeOk: true, now: T0 + 150 });
  assert.equal(cleared.silentFailures, 0);
  const afterClear = applyProbeResult(cleared, {
    platform: "darwin", trusted: true, probeOk: false, probeReason: "Timed out", now: T0 + 300,
  });
  assert.equal(afterClear.state, PASTE_CAPABILITY.ACTIVE);

  // A refusal is not a timeout: macOS said no, and that is final at once.
  const refused = applyProbeResult(active, {
    platform: "darwin", trusted: true, probeOk: false,
    probeReason: "Not authorized to send Apple events to System Events. (-1743)", now: T0 + 100,
  });
  assert.equal(refused.state, PASTE_CAPABILITY.BROKEN);
});

test("not trusted = untrusted even when the probe somehow answers", () => {
  const cap = applyProbeResult(initialPasteCapability(0), {
    platform: "darwin", trusted: false, probeOk: true, now: 10,
  });
  assert.equal(cap.state, PASTE_CAPABILITY.UNTRUSTED);
  assert.equal(shouldAttemptPaste(cap), false);
});

test("no trust bit (Windows/Linux) = unknown, and unknown still pastes", () => {
  for (const trusted of [null, undefined]) {
    const cap = applyProbeResult(initialPasteCapability(0), {
      platform: "win32", trusted, probeOk: false, now: 10,
    });
    assert.equal(cap.state, PASTE_CAPABILITY.UNKNOWN);
    assert.equal(cap.reason, "probe-unavailable");
    assert.equal(shouldAttemptPaste(cap), true, "unknown is Active-until-proven-otherwise");
  }
});

test("since/changedAt only move when the state actually changes", () => {
  const a = applyProbeResult(initialPasteCapability(0), { platform: "darwin", trusted: true, probeOk: true, now: 100 });
  const b = applyProbeResult(a, { platform: "darwin", trusted: true, probeOk: true, now: 500 });
  assert.equal(b.since, a.since);
  assert.equal(b.changedAt, a.changedAt);
  assert.equal(b.probedAt, 500, "probedAt always moves — it is what staleness is measured from");
  const c = applyProbeResult(b, { platform: "darwin", trusted: false, probeOk: false, now: 900 });
  assert.equal(c.since, 900);
});

// ── transitions from paste outcomes ───────────────────────────────────

test("a successful paste is the strongest liveness evidence — it promotes any state", () => {
  for (const start of [PASTE_CAPABILITY.UNKNOWN, PASTE_CAPABILITY.UNTRUSTED, PASTE_CAPABILITY.BROKEN]) {
    const prev = { ...initialPasteCapability(0), state: start, silentFailures: 5 };
    const next = applyPasteOutcome(prev, { ok: true, now: 1 });
    assert.equal(next.state, PASTE_CAPABILITY.ACTIVE);
    assert.equal(next.silentFailures, 0);
  }
});

test("a permission-shaped failure lands in the state that matches WHICH permission", () => {
  const active = applyProbeResult(initialPasteCapability(0), { platform: "darwin", trusted: true, probeOk: true, now: 0 });
  // No Accessibility grant at all: nothing to repair, everything to ask for.
  const ax = applyPasteOutcome(active, { ok: false, reason: "ERR:no-accessibility", now: 5 });
  assert.equal(ax.state, PASTE_CAPABILITY.UNTRUSTED);
  // An Automation refusal is the opposite claim: the row IS on and macOS
  // refuses anyway. Calling that "untrusted" is what told a user with the
  // grant switched on to go and switch it on.
  const automation = applyPasteOutcome(active, {
    ok: false,
    reason: "System Events got an error: … not authorized to send Apple events (-1743)",
    now: 5,
  });
  assert.equal(automation.state, PASTE_CAPABILITY.BROKEN);
  assert.equal(
    classifyPastePermissionFailure(automation.reason),
    PASTE_PERMISSION_ROUTE.AUTOMATION,
    "the state's own reason must still route to the pane that can fix it",
  );
});

test("one silent failure is a loaded machine; two in a row is a stale grant", () => {
  const active = applyProbeResult(initialPasteCapability(0), { platform: "darwin", trusted: true, probeOk: true, now: 0 });
  const once = applyPasteOutcome(active, { ok: false, reason: "osascript-failed\nTimed out", now: 5 });
  assert.equal(once.state, PASTE_CAPABILITY.ACTIVE, "a single timeout must not condemn the grant");
  assert.equal(once.silentFailures, 1);
  const twice = applyPasteOutcome(once, { ok: false, reason: "AppleEvent timed out (-1712)", now: 6 });
  assert.equal(twice.state, PASTE_CAPABILITY.BROKEN);
  assert.equal(SILENT_FAILURES_BEFORE_BROKEN, 2);
});

test("target-shaped failures say nothing about the capability", () => {
  const active = applyProbeResult(initialPasteCapability(0), { platform: "darwin", trusted: true, probeOk: true, now: 0 });
  for (const reason of ["no-target", "ERR:no-process", "ERR:no-focus", "not-editable", "empty-text"]) {
    const next = applyPasteOutcome(active, { ok: false, reason, now: 5 });
    assert.equal(next.state, PASTE_CAPABILITY.ACTIVE, reason);
    assert.equal(next.silentFailures, 0, reason);
  }
});

test("classifyPasteFailure buckets every reason the ladder can produce", () => {
  assert.equal(classifyPasteFailure("ERR:no-accessibility"), "permission");
  assert.equal(classifyPasteFailure("not permitted"), "permission");
  assert.equal(classifyPasteFailure("ERR:no-focus"), "target");
  // "secure-field" is deliberately NOT in the vocabulary: no script emits
  // it, and a classifier entry for a marker nothing produces is a third
  // piece of code describing a capability the product does not have.
  assert.equal(classifyPasteFailure("ERR:secure-field"), "other");
  assert.equal(classifyPasteFailure("spawn osascript ENOENT"), "silent");
  assert.equal(classifyPasteFailure(""), "other");
  assert.equal(classifyPasteFailure("paste-return-unknown"), "other");
});

test("a failing paste on an untrusted system never upgrades it to broken", () => {
  const untrusted = applyProbeResult(initialPasteCapability(0), { platform: "darwin", trusted: false, probeOk: false, now: 0 });
  let s = untrusted;
  for (let i = 0; i < 4; i++) s = applyPasteOutcome(s, { ok: false, reason: "Timed out", now: i });
  assert.equal(s.state, PASTE_CAPABILITY.UNTRUSTED, "the fix for untrusted is different from the fix for broken");
});

// ── staleness ─────────────────────────────────────────────────────────

test("an active verdict is believed for a minute; a bad one is re-checked in ten seconds", () => {
  const T0 = 1000;
  const active = applyProbeResult(initialPasteCapability(0), { platform: "darwin", trusted: true, probeOk: true, now: T0 });
  assert.equal(shouldProbe(active, T0 + PASTE_PROBE_ACTIVE_TTL_MS - 1), false);
  assert.equal(shouldProbe(active, T0 + PASTE_PROBE_ACTIVE_TTL_MS), true);
  const broken = applyProbeResult(initialPasteCapability(0), { platform: "darwin", trusted: true, probeOk: false, now: T0 });
  assert.equal(shouldProbe(broken, T0 + PASTE_PROBE_RECHECK_MS - 1), false);
  assert.equal(shouldProbe(broken, T0 + PASTE_PROBE_RECHECK_MS), true);
  assert.ok(PASTE_PROBE_RECHECK_MS < PASTE_PROBE_ACTIVE_TTL_MS);
  // A state that has never been probed is always worth probing, whatever
  // the clock says — this is the "before the first paste after boot" call.
  assert.equal(shouldProbe(initialPasteCapability(T0), T0), true);
});

test("a verdict that would REFUSE a paste is never trusted without re-probing", () => {
  // Two transient timeouts must not switch pasting off for the whole
  // recheck window. Before a paste, a blocking verdict is always
  // re-tested — the probe is one bounded round trip against a ladder
  // that would otherwise spend seconds failing.
  const T0 = 1000;
  const broken = applyProbeResult(initialPasteCapability(0), {
    platform: "darwin", trusted: true, probeOk: false, now: T0,
  });
  assert.equal(shouldProbe(broken, T0 + 100), false, "the periodic check still respects its interval");
  assert.equal(mustProbeBeforePaste(broken), true);
  const untrusted = applyProbeResult(initialPasteCapability(0), {
    platform: "darwin", trusted: false, probeOk: false, now: T0,
  });
  assert.equal(mustProbeBeforePaste(untrusted), true);
  // An active verdict is never waited on, however old — the user has
  // just stopped talking and is waiting for text.
  const active = applyProbeResult(initialPasteCapability(0), {
    platform: "darwin", trusted: true, probeOk: true, now: T0,
  });
  assert.equal(mustProbeBeforePaste(active), false);
  assert.equal(shouldProbe(active, T0 + PASTE_PROBE_ACTIVE_TTL_MS), true, "it is refreshed in the background instead");
  // Nothing probed yet is the one case a first paste does wait for.
  assert.equal(mustProbeBeforePaste(initialPasteCapability(T0)), true);
  assert.equal(mustProbeBeforePaste(null), true);
});

// ── user-facing message ───────────────────────────────────────────────

test("broken tells the user to REMOVE and re-add — toggling a stale row does not fix it", () => {
  const msg = pasteCapabilityMessage(PASTE_CAPABILITY.BROKEN);
  assert.match(msg.fix, /Privacy & Security → Accessibility/);
  assert.match(msg.fix, /remove and re-add/i);
  const untrusted = pasteCapabilityMessage(PASTE_CAPABILITY.UNTRUSTED);
  assert.match(untrusted.fix, /Accessibility/);
  assert.doesNotMatch(untrusted.fix, /remove and re-add/i);
  assert.equal(pasteCapabilityMessage(PASTE_CAPABILITY.ACTIVE).fix, "");
  assert.equal(pasteCapabilityMessage(PASTE_CAPABILITY.UNKNOWN).fix, "");
});

test("the message names the pane the ACTUAL failure lives in", () => {
  // The regression this exists for: every `broken` state was described
  // as a stale Accessibility row, so a -1743 (Automation) refusal sent
  // the user to a pane where nothing was wrong — main.log 2026-09-05.
  const automation = applyProbeResult(initialPasteCapability(0), {
    platform: "darwin",
    trusted: true,
    probeOk: false,
    probeReason: "40:85: execution error: Not authorized to send Apple events to System Events. (-1743)",
    now: 1,
  });
  const msg = pasteCapabilityMessage(automation);
  assert.match(msg.title, /Automation/);
  assert.match(msg.fix, /Privacy & Security → Automation/);
  assert.doesNotMatch(msg.fix, /Privacy & Security → Accessibility/);
  // And a replaced bundle is neither pane's problem.
  const replaced = pasteCapabilityMessage(automation, { bundleReplaced: true });
  assert.match(replaced.fix, /Quit and reopen/i);
});

// ── self-heal: repairing a grant macOS believes it has given ───────────

test("the service comes from the error text, in tccutil's vocabulary", () => {
  assert.equal(
    tccServiceForPasteFailure("127:132: execution error: Not authorized to send Apple events to System Events. (-1743)"),
    TCC_SERVICE.AUTOMATION,
  );
  assert.equal(tccServiceForPasteFailure("ERR:no-accessibility"), TCC_SERVICE.ACCESSIBILITY);
  assert.equal(tccServiceForPasteFailure("no-target"), "");
  // System Settings says "Automation"; tccutil only knows "AppleEvents",
  // and asking it for a service it does not know resets nothing at all.
  assert.equal(TCC_SERVICE.AUTOMATION, "AppleEvents");
});

test("the ladder's own vocabulary never outranks the macOS error underneath it", () => {
  // `paste-capability-broken` says the preflight refused and nothing
  // about why; the capability's reason carries the -1743 that decided it.
  const specific = preferSpecificFailureReason(
    "paste-capability-broken",
    "stale-grant:40:85: execution error: Not authorized to send Apple events to System Events. (-1743)",
  );
  assert.equal(tccServiceForPasteFailure(specific), TCC_SERVICE.AUTOMATION);
  // A reason that is already specific is left alone.
  assert.equal(preferSpecificFailureReason("ERR:no-accessibility", "stale-grant:x"), "ERR:no-accessibility");
});

test("a bundle replaced under the running process is detected, and by either witness", () => {
  const started = 1_000_000;
  assert.equal(
    detectBundleReplacement({
      runningVersion: "1.6.2",
      bundleVersion: "1.6.2",
      bundleMtimeMs: started - 60_000,
      processStartedAtMs: started,
    }).replaced,
    false,
    "the normal case: installed, then launched",
  );
  assert.equal(
    detectBundleReplacement({
      runningVersion: "1.6.2",
      bundleVersion: "1.6.3",
      bundleMtimeMs: 0,
      processStartedAtMs: started,
    }).replaced,
    true,
    "a new version on disk is conclusive on its own",
  );
  const byMtime = detectBundleReplacement({
    runningVersion: "1.6.2",
    bundleVersion: "1.6.2",
    bundleMtimeMs: started + 600_000,
    processStartedAtMs: started,
  });
  assert.equal(byMtime.replaced, true, "a re-signed bundle keeps the version but not the mtime");
  assert.match(byMtime.evidence, /rewritten-after-launch/);
  // A same-second write must not be read as a swap.
  assert.equal(
    detectBundleReplacement({
      bundleMtimeMs: started + 500,
      processStartedAtMs: started,
    }).replaced,
    false,
  );
});

test("a replaced bundle is told to relaunch, never reset — a reset cannot help it", () => {
  const plan = planPermissionRepair({
    state: PASTE_CAPABILITY.BROKEN,
    reason: "stale-grant:… Not authorized to send Apple events to System Events. (-1743)",
    trusted: true,
    bundleReplaced: true,
  });
  assert.equal(plan.action, PERMISSION_REPAIR.RELAUNCH);
  assert.equal(plan.why, "bundle-replaced");
  // Said once per boot, not once per paste.
  const again = planPermissionRepair({
    state: PASTE_CAPABILITY.BROKEN,
    reason: "stale-grant:… (-1743)",
    trusted: true,
    bundleReplaced: true,
    reported: true,
  });
  assert.equal(again.action, PERMISSION_REPAIR.NONE);
});

test("a grant that is on and refuses is reset ONCE per boot, then reported", () => {
  const input = {
    state: PASTE_CAPABILITY.BROKEN,
    reason: "stale-grant:… Not authorized to send Apple events to System Events. (-1743)",
    trusted: true,
  };
  const first = planPermissionRepair(input);
  assert.equal(first.action, PERMISSION_REPAIR.RESET);
  assert.equal(first.service, TCC_SERVICE.AUTOMATION);
  const second = planPermissionRepair({ ...input, resetServices: [TCC_SERVICE.AUTOMATION] });
  assert.equal(second.action, PERMISSION_REPAIR.REPORT, "one reset is a repair; two is a loop");
  assert.equal(second.why, "reset-did-not-help");
  const third = planPermissionRepair({
    ...input,
    resetServices: [TCC_SERVICE.AUTOMATION],
    reported: true,
  });
  assert.equal(third.action, PERMISSION_REPAIR.NONE);
  // The other service is still repairable — resets are per service.
  const ax = planPermissionRepair({
    ...input,
    reason: "ERR:no-accessibility",
    resetServices: [TCC_SERVICE.AUTOMATION],
  });
  assert.equal(ax.action, PERMISSION_REPAIR.RESET);
  assert.equal(ax.service, TCC_SERVICE.ACCESSIBILITY);
});

test("the self-heal keeps its hands off what it cannot know", () => {
  // Never granted: the system prompt is the remedy, not a reset of a row
  // that does not exist.
  assert.equal(
    planPermissionRepair({ state: PASTE_CAPABILITY.UNTRUSTED, reason: "not-trusted", trusted: false }).action,
    PERMISSION_REPAIR.NONE,
  );
  // Trusted, broken, and the failure named no permission (a probe that
  // timed out on a loaded machine): reporting is honest, resetting would
  // revoke a working grant because the Mac was busy.
  const vague = planPermissionRepair({
    state: PASTE_CAPABILITY.BROKEN,
    reason: "stale-grant:Timed out",
    trusted: true,
  });
  assert.equal(vague.action, PERMISSION_REPAIR.REPORT);
  assert.equal(vague.service, "");
  // Nothing to repair at all.
  assert.equal(
    planPermissionRepair({ state: PASTE_CAPABILITY.ACTIVE, reason: "no-target", trusted: true }).action,
    PERMISSION_REPAIR.NONE,
  );
  // Windows and Linux have no TCC to reset.
  assert.equal(
    planPermissionRepair({ platform: "win32", state: PASTE_CAPABILITY.BROKEN, reason: "(-1743)" }).action,
    PERMISSION_REPAIR.NONE,
  );
});

test("the reset command is built here, and refuses anything that is not a bundle id", () => {
  const cmd = permissionRepairCommand(TCC_SERVICE.AUTOMATION, "local.transcriptor.app");
  assert.equal(cmd.cmd, "tccutil");
  assert.deepEqual(cmd.args, ["reset", "AppleEvents", "local.transcriptor.app"]);
  assert.ok(cmd.timeoutMs > 0 && cmd.timeoutMs <= 5000);
  for (const bad of ["", "  ", "local.transcriptor.app; rm -rf /", "-all", "com.example/../x"]) {
    assert.throws(() => permissionRepairCommand(TCC_SERVICE.AUTOMATION, bad), /implausible bundle id/, bad);
  }
  assert.throws(() => permissionRepairCommand("Automation", "local.transcriptor.app"), /unknown TCC service/);
});

test("remediation prose has ONE writer, shared by the dialog and the note", () => {
  const relaunch = permissionRepairMessage({ action: PERMISSION_REPAIR.RELAUNCH });
  assert.match(relaunch.fix, /Quit and reopen/i);
  const automation = permissionRepairMessage({
    action: PERMISSION_REPAIR.REPORT,
    service: TCC_SERVICE.AUTOMATION,
  });
  assert.deepEqual(
    pasteCapabilityMessage(
      { state: PASTE_CAPABILITY.BROKEN, reason: "… (-1743)" },
    ),
    automation,
    "the note and the dialog must not be able to name two different fixes",
  );
  assert.equal(
    PERMISSION_REPAIR_SERVICES.length,
    2,
    "the Settings action repairs both services",
  );
});

test("the bundle id the reset targets is read from the running bundle", () => {
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<plist version=\"1.0\"><dict>",
    "<key>CFBundleIdentifier</key><string>local.transcriptor.app</string>",
    "<key>CFBundleShortVersionString</key><string>1.6.3</string>",
    "</dict></plist>",
  ].join("\n");
  assert.deepEqual(parseBundleIdentity(plist), {
    bundleId: "local.transcriptor.app",
    version: "1.6.3",
  });
  // The manifest is where that value comes from (packaging.test.js holds
  // every other copy to it), so the two must agree.
  assert.equal(
    parseBundleIdentity(plist).bundleId,
    require("./package.json").build.appId,
  );
  assert.deepEqual(parseBundleIdentity("bplist00  "), { bundleId: "", version: "" });
  assert.equal(infoPlistString("", "CFBundleIdentifier"), "");
});

test("the probe is the same mechanism the paste uses, and it is bounded", () => {
  assert.equal(PASTE_PROBE_COMMAND.cmd, "osascript");
  assert.match(PASTE_PROBE_COMMAND.args.join(" "), /System Events/);
  assert.ok(PASTE_PROBE_COMMAND.timeoutMs <= 1000, "a probe on the paste path may not cost more than a second");
});

// ── budget table ─────────────────────────────────────────────────

test("the paste ladder's worst case fits inside the post-stop deadline on every platform", () => {
  for (const platform of Object.keys(PASTE_BUDGET)) {
    const worst = pasteBudgetWorstCaseMs(platform);
    assert.ok(
      worst <= PASTE_POST_STOP_DEADLINE_MS,
      `${platform}: worst case ${worst}ms exceeds the ${PASTE_POST_STOP_DEADLINE_MS}ms post-stop deadline`,
    );
  }
});

test("the table owns EVERY wall-clock bound the ladder spends, activation included", () => {
  // The comment above pasteBudgetWorstCaseMs claimed a single answer to
  // "how long can a paste take". Three things were outside it: the
  // target-activation ladder (three PowerShell spawns per attempt on
  // Windows, at 5000 ms each), the pre-paste capability probe, and the
  // spawn allowance the modifier wait adds on top of its own deadline.
  // On Windows that made the real worst case ~2x the computed one.
  for (const platform of Object.keys(PASTE_BUDGET)) {
    const b = pasteBudgetFor(platform);
    for (const key of ["activationTimeoutMs", "activationLadderSteps", "pasteKeyAnswerMs", "autoSendTimeoutMs"]) {
      assert.equal(typeof b[key], "number", `${platform}.${key}`);
    }
    assert.ok(b.activationTimeoutMs > 0, platform);
    assert.equal(pasteActivationTimeoutMs(platform), b.activationTimeoutMs);
    assert.equal(pasteAutoSendTimeoutMs(platform), b.autoSendTimeoutMs);
    assert.equal(pasteKeyAnswerTimeoutMs(platform), b.pasteKeyAnswerMs);
    // Only macOS reads a keyboard layout for the AppleScript fallback.
    assert.equal(b.pasteKeyAnswerMs > 0, platform === "darwin", `${platform}: paste-key query is macOS only`);
    assert.ok(
      pasteBudgetWorstCaseMs(platform) >=
      b.maxAttempts * b.activationLadderSteps * b.activationTimeoutMs,
      `${platform}: the activation ladder must be counted`,
    );
  }
  // macOS activates once BEFORE the ladder, so its attempts spend none.
  assert.equal(pasteBudgetFor("darwin").activationLadderSteps, 0);
});

test("the darwin preflight covers what is really spent before the ladder", () => {
  // preflightMs claimed to be the modifier wait's deadline, but the wait
  // is spawned with deadline + spawn allowance, and the capability probe
  // runs before the ladder too. The old test compared the plan's
  // deadline against preflightMs (500 <= 500) — the script's bound, not
  // the spawn's.
  const plan = planModifierRelease({ platform: "darwin", accelerator: "Alt+Shift+V", trigger: "hotkey" });
  const spent = modifierReleaseCommand(plan).timeoutMs + PASTE_PROBE_TIMEOUT_MS;
  assert.ok(
    spent <= pasteBudgetFor("darwin").preflightMs,
    `preflight really costs ${spent}ms but the table budgets ${pasteBudgetFor("darwin").preflightMs}ms`,
  );
});

test("macOS honours the paste contract: at most 5 attempts, one delay each", () => {
  for (const platform of Object.keys(PASTE_BUDGET)) {
    const b = pasteBudgetFor(platform);
    assert.ok(b.maxAttempts >= 1 && b.maxAttempts <= PASTE_MAX_ATTEMPTS, platform);
    assert.equal(b.attemptDelaysMs.length, b.maxAttempts, `${platform}: one delay per attempt, no fallthrough`);
    assert.ok(b.methodTimeoutsMs.length >= 1, platform);
    assert.ok(b.methodTimeoutsMs.every((t) => t > 0), platform);
  }
  assert.equal(PASTE_MAX_ATTEMPTS, 5);
});

test("the table does NOT own the accessibility read bound", () => {
  // Three SSOTs, no overlap: paste-capability decides IF and FOR HOW
  // LONG the ladder may run, paste-script owns how long ONE
  // accessibility read inside the AppleScript may take (it is the thing
  // AppleScript enforces), paste-verification-policy decides whether the
  // reads happen at all. A read timeout in this table would be a fourth
  // opinion on a number only one file can enforce.
  for (const platform of Object.keys(PASTE_BUDGET)) {
    assert.ok(!("axReadTimeoutSec" in PASTE_BUDGET[platform]), platform);
  }
  // What it DOES own is the parent wall clock those reads need.
  assert.ok(pasteBudgetFor("darwin").verificationAllowanceMs > 0);
  assert.equal(pasteBudgetFor("win32").verificationAllowanceMs, 0);
});

test("verification only widens the attempt that carries the reads", () => {
  const b = pasteBudgetFor("darwin");
  assert.equal(pasteMethodTimeoutMs("darwin", 0, false), b.methodTimeoutsMs[0]);
  assert.equal(
    pasteMethodTimeoutMs("darwin", 0, true),
    b.methodTimeoutsMs[0] + b.verificationAllowanceMs,
  );
  // Windows/Linux never verify, so asking for it changes nothing.
  assert.equal(pasteMethodTimeoutMs("win32", 0, true), pasteMethodTimeoutMs("win32", 0, false));
  // Method index is clamped, never undefined.
  assert.equal(pasteMethodTimeoutMs("win32", 1), 3000);
  assert.equal(pasteMethodTimeoutMs("win32", 99), 3000);
  // Only the FIRST method of an attempt carries the reads.
  assert.equal(pasteMethodTimeoutMs("linux", 2, true), pasteMethodTimeoutMs("linux", 2, false));
});

test("an unknown platform falls back to a real table rather than undefined", () => {
  assert.deepEqual(pasteBudgetFor("sunos"), PASTE_BUDGET.linux);
});

test("attempt delays are clamped, never undefined past the last attempt", () => {
  assert.equal(pasteAttemptDelayMs("darwin", 0), 45);
  assert.equal(pasteAttemptDelayMs("darwin", 2), 125);
  assert.equal(pasteAttemptDelayMs("darwin", 99), 125);
  assert.equal(pasteAttemptDelayMs("darwin", -1), 45);
});

// ── modifier release ─────────────────────────────────────────────

test("only the hotkey path with a modifier chord waits for modifiers", () => {
  assert.equal(planModifierRelease({ platform: "darwin", accelerator: "Alt+Shift+V", trigger: "hotkey" }).needed, true);
  // Auto-paste after a recording: 1–2 s have passed, the chord is long up.
  assert.equal(planModifierRelease({ platform: "darwin", accelerator: "Alt+Shift+V", trigger: "auto" }).needed, false);
  // A bare key has no modifiers to inherit.
  assert.equal(planModifierRelease({ platform: "darwin", accelerator: "F10", trigger: "hotkey" }).needed, false);
  // Windows and Linux need the wait too: their paste-last default is
  // Control+Alt+Shift+V, so SendKeys "^v" fires while three modifiers are
  // physically down and the target receives Ctrl+Alt+Shift+V. What they
  // lack is the instrument, not the problem — no NSEvent.modifierFlags to
  // poll — so they get the fixed floor and macOS gets the floor plus a
  // poll for the flags to actually clear.
  const win = planModifierRelease({ platform: "win32", accelerator: "Control+Alt+Shift+V", trigger: "hotkey" });
  assert.equal(win.needed, true);
  assert.equal(win.canPoll, false);
  assert.equal(win.deadlineMs, win.holdMs, "with nothing to poll, the floor IS the wait");
  const linux = planModifierRelease({ platform: "linux", accelerator: "Control+Alt+Shift+V", trigger: "hotkey" });
  assert.equal(linux.needed, true);
  assert.equal(linux.canPoll, false);
  // A bare key still has nothing to wait for, on any platform.
  assert.equal(planModifierRelease({ platform: "win32", accelerator: "F10", trigger: "hotkey" }).needed, false);
  assert.equal(planModifierRelease({ platform: "darwin", accelerator: "Alt+Shift+V", trigger: "hotkey" }).canPoll, true);
});

test("the wait borrows Handy's chord hold and local-speak's deadline", () => {
  const plan = planModifierRelease({ platform: "darwin", accelerator: "Alt+Shift+V", trigger: "hotkey" });
  assert.ok(plan.holdMs >= 150, "≥ CHORD_HOLD_MS (100) plus headroom, per R4");
  assert.equal(plan.deadlineMs, 500, "local-speak CTRL_WAIT_DEADLINE");
  assert.ok(plan.holdMs < plan.deadlineMs, "the floor must fit under the ceiling");
  assert.ok(plan.pollIntervalMs > 0);
});



test("the modifier script polls in ONE spawn and carries the plan's numbers", () => {
  const plan = planModifierRelease({ platform: "darwin", accelerator: "Alt+Shift+V", trigger: "hotkey" });
  const src = modifierReleaseScript(plan);
  assert.match(src, /NSEvent\.modifierFlags/);
  assert.match(src, /var HOLD = 150;/);
  assert.match(src, /var DEADLINE = 500;/);
  assert.match(src, /sleepForTimeInterval/, "the poll loop lives inside the script, not in spawn calls");
});

test("the modifier wait is spawned as JavaScript, not AppleScript", () => {
  // The script is JXA; osascript compiles AppleScript unless told
  // otherwise, so the interpreter flag is part of the contract rather
  // than something each caller remembers.
  const plan = planModifierRelease({ platform: "darwin", accelerator: "Alt+Shift+V", trigger: "hotkey" });
  const command = modifierReleaseCommand(plan);
  assert.equal(command.cmd, "osascript");
  assert.deepEqual(command.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.equal(command.args[3], modifierReleaseScript(plan));
  // The script returns on its own at the deadline; the wall-clock bound
  // only has to cover that plus osascript + JXA startup (~240 ms
  // measured on macOS 27).
  assert.equal(command.timeoutMs, plan.deadlineMs + MODIFIER_SPAWN_ALLOWANCE_MS);
  assert.ok(command.timeoutMs > plan.deadlineMs);
});

test("parseModifierReleaseResult reads the marker and rejects anything else", () => {
  assert.deepEqual(parseModifierReleaseResult("MODS:cleared:0:132"), {
    ok: true, cleared: true, flags: 0, waitedMs: 132,
  });
  const held = parseModifierReleaseResult("noise\nMODS:held:655360:500\n");
  assert.equal(held.ok, true);
  assert.equal(held.cleared, false);
  assert.equal(held.flags, 655360);
  assert.deepEqual(parseModifierReleaseResult(""), { ok: false, cleared: false, flags: 0, waitedMs: 0 });
  assert.equal(parseModifierReleaseResult("execution error: …").ok, false);
});

test("held flags decode to the modifier names the log prints", () => {
  const flags = NS_EVENT_MODIFIER_FLAGS.option | NS_EVENT_MODIFIER_FLAGS.shift;
  assert.deepEqual(heldModifiersFromFlags(flags).sort(), ["option", "shift"]);
  assert.deepEqual(heldModifiersFromFlags(0), []);
});

// ── permission classification ─────────────────────────────────────────

test("one classifier decides which macOS permission a failure is asking for", () => {
  // This used to be two independent substring ladders over the same
  // string — one for the status line, one for the prompt trigger. When
  // the capability preflight started refusing BEFORE the ladder could
  // produce ERR:no-accessibility, only the status line was taught its
  // new verdict, and the app's ONLY Accessibility prompt stopped firing:
  // a first run on a machine that had never granted the permission was
  // never asked for it.
  const R = PASTE_PERMISSION_ROUTE;
  assert.equal(classifyPastePermissionFailure("ERR:no-accessibility"), R.ACCESSIBILITY);
  assert.equal(
    classifyPastePermissionFailure(`paste-capability-${PASTE_CAPABILITY.UNTRUSTED}`),
    R.ACCESSIBILITY,
    "the preflight's own refusal must reach the prompt",
  );
  assert.equal(
    classifyPastePermissionFailure(`paste-capability-${PASTE_CAPABILITY.BROKEN}`),
    R.ACCESSIBILITY,
    "a grant that survived a re-signed install is repaired in the same pane",
  );

  assert.equal(classifyPastePermissionFailure("Not authorized to send Apple events"), R.AUTOMATION);
  assert.equal(classifyPastePermissionFailure("System Events got an error: (-1743)"), R.AUTOMATION);

  // States that are NOT a permission problem must not raise a dialog.
  assert.equal(classifyPastePermissionFailure(`paste-capability-${PASTE_CAPABILITY.ACTIVE}`), R.NONE);
  assert.equal(classifyPastePermissionFailure("ERR:no-focus"), R.NONE);
  assert.equal(classifyPastePermissionFailure("timed out"), R.NONE);
  assert.equal(classifyPastePermissionFailure(""), R.NONE);
  assert.equal(classifyPastePermissionFailure(null), R.NONE);
});

test("the budget table is the ladder's real clock, not a model of it", () => {
  // pasteBudgetWorstCaseMs is called from nowhere but this file, so the
  // "worst case fits the post-stop deadline" property above is only as true
  // as the ladder's agreement with the table. That agreement was assumed;
  // this asserts it. Every wall-clock bound spent inside a paste-path
  // function must come FROM the table — a literal there is a second clock
  // the worst case does not know about, which is exactly the shape D-019
  // found (six hardcoded 5000 ms activation timeouts outside the budget).
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

  // Brace-matched body of a top-level function, so the scan cannot silently
  // cover nothing (the guard below fails if a name stops matching).
  const bodyOf = (name) => {
    const head = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
    assert.ok(head, `main.js no longer declares ${name} — this scan must be updated, not deleted`);
    let i = source.indexOf("{", head.index);
    let depth = 0;
    for (let j = i; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}" && --depth === 0) return source.slice(i, j + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  };

  const PASTE_PATH_FUNCTIONS = [
    "runPasteLadder",
    "tryPasteToFocusedField",
    "awaitModifierRelease",
    "activateCapturedPasteTarget",
    "activateMacCapturedWindow",
    "activateAppByPid",
    "activateAppByName",
    "activateWindowsWindowByHwnd",
    "activateLinuxWindowById",
    "sendCommandEnterToFocusedApp",
  ];
  for (const name of PASTE_PATH_FUNCTIONS) {
    const body = bodyOf(name);
    const literals = [...body.matchAll(/timeoutMs:\s*(\d+)/g)].map((m) => m[1]);
    assert.deepEqual(
      literals,
      [],
      `${name} spends ${literals.join(", ")} ms of wall clock that pasteBudgetWorstCaseMs cannot see`,
    );
  }

  // ...and the worst case is not a number this test invented: it is spent
  // by the accessors the ladder actually calls.
  for (const accessor of [
    "pasteMethodTimeoutMs",
    "pasteAttemptDelayMs",
    "pasteActivationTimeoutMs",
    "pasteAutoSendTimeoutMs",
  ]) {
    assert.ok(source.includes(`${accessor}(`), `main.js must spend its clock through ${accessor}`);
  }
});

test("the auto-send settle is in the table too, not a literal at its call site", () => {
  // D-047 moved the auto-send TIMEOUTS into the table and left the settle
  // sleep behind — a wall-clock number on the paste path that the table did
  // not know about, which is the same shape the finding was about.
  for (const platform of Object.keys(PASTE_BUDGET)) {
    assert.equal(typeof pasteBudgetFor(platform).autoSendSettleMs, "number", platform);
    assert.ok(pasteAutoSendSettleMs(platform) > 0, platform);
  }
  // It protects the same thing everywhere, so it is the same everywhere.
  const values = new Set(Object.keys(PASTE_BUDGET).map(pasteAutoSendSettleMs));
  assert.equal(values.size, 1);

  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(source, /await sleep\(pasteAutoSendSettleMs\(process\.platform\)\)/);
});

// DM-16 / DM-20: the activation settles are rows of PASTE_BUDGET, and the
// worst case the table claims pays one per attempt where the ladder
// re-activates the target — and still fits the post-stop deadline.
test("the activation settles live in PASTE_BUDGET and are counted in the worst case", () => {
  const cap = require("./paste-capability");
  for (const platform of ["darwin", "win32", "linux"]) {
    const b = cap.PASTE_BUDGET[platform];
    for (const field of ["appActivationSettleMs", "windowActivationSettleMs", "autoSendActivationSettleMs"]) {
      assert.ok(Number.isFinite(b[field]) && b[field] > 0, `${platform}.${field}`);
    }
    const settle = b.activationLadderSteps > 0 ? Math.max(b.appActivationSettleMs, b.windowActivationSettleMs) : 0;
    const withoutSettle = cap.pasteBudgetWorstCaseMs(platform) - b.maxAttempts * settle;
    // Removing the settles must leave exactly the old sum, i.e. they are counted once per attempt.
    assert.equal(
      withoutSettle,
      b.preflightMs + b.preflightSettleMs + b.pasteKeyAnswerMs
        + b.attemptDelaysMs.slice(0, b.maxAttempts).reduce((a, x) => a + x, 0)
        + b.maxAttempts * (b.methodTimeoutsMs.reduce((a, x) => a + x, 0) + b.verificationAllowanceMs
          + b.activationLadderSteps * b.activationTimeoutMs + b.activationSettleMs)
        + b.tailFallbackTimeoutMs,
      platform,
    );
    assert.ok(cap.pasteBudgetWorstCaseMs(platform) <= cap.PASTE_POST_STOP_DEADLINE_MS, `${platform} fits the deadline`);
  }
});
