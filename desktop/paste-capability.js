"use strict";

// Can this machine actually paste right now — and if it cannot, what is
// the concrete thing the user has to do about it?
//
// BUGS_AUDIT 2026-09-03 §6.5/§6.6 fixed "we said we pasted when we only
// sent a keystroke". This module fixes the layer under it: "the OS says
// we are allowed to send that keystroke when we are not".
//
// The failure mode this exists for (observed by Whispering,
// epicenter-so/epicenter `keyboard/mod.rs`): after an app is re-signed
// and replaced in /Applications — exactly what a fresh 1.5.0 build is —
// the TCC row for Accessibility can survive while pointing at the old
// code identity. `AXIsProcessTrusted()` (Electron's
// `systemPreferences.isTrustedAccessibilityClient`) keeps answering
// **true**, the app keeps synthesising events, and the window server
// silently drops every one of them. Whispering's answer is to keep a
// real event tap alive as a liveness probe and to publish a capability
// state that gates the paste, so the app says "left on clipboard"
// instead of pretending it typed. Electron cannot open a CGEventTap
// without a native addon, so our liveness probe is the cheapest real
// action that travels the same road as the paste itself: an osascript
// `System Events` read of the frontmost process name. It needs the same
// Apple Events + Accessibility grants the paste needs, it cost 188-203 ms
// measured over three runs on macOS 27, and it fails when the grant is
// stale.
//
//   trusted flag | real probe | capability
//   -------------+------------+------------
//   true         | ok         | active
//   true         | fails      | broken     <- the stale-grant case
//   true         | times out  | unchanged  <- one strike; two in a row = broken
//   false        | (any)      | untrusted
//   unavailable  | (any)      | unknown    <- non-darwin; paste anyway
//
// Everything here is pure: state in, state out. desktop/main.js owns the
// side effects (spawning the probe, logging, turning a refusal into the
// status the user reads) and this module owns the decisions, so the
// decisions can be tested without a window server. See
// desktop/paste-capability.test.js.
//
// It is one of THREE modules on the paste path, and they do not overlap:
// this one decides IF we may paste at all and how long the ladder may
// spend, desktop/paste-verification-policy.js decides whether a paste is
// worth VERIFYING, and desktop/paste-result.js decides what one
// attempt's output MEANS.

/** The four capability states. Platform-agnostic. */
const PASTE_CAPABILITY = Object.freeze({
  /** Never probed, or the platform has no probe (Windows/Linux). */
  UNKNOWN: "unknown",
  /** The OS says we do not hold Accessibility. Asking again will not help. */
  UNTRUSTED: "untrusted",
  /** Trusted AND a real action just worked. */
  ACTIVE: "active",
  /** Trusted on paper, dead in practice — the stale post-update grant. */
  BROKEN: "broken",
});

/** Which Privacy & Security pane a paste permission failure points at. */
const PASTE_PERMISSION_ROUTE = Object.freeze({
  NONE: "",
  ACCESSIBILITY: "accessibility",
  AUTOMATION: "automation",
});

/** An `active` verdict is believed this long before it is re-checked. */
const PASTE_PROBE_ACTIVE_TTL_MS = 60000;
/** Any non-`active` verdict is re-checked this often, so a user who
 *  fixes the grant in System Settings is noticed within seconds. */
const PASTE_PROBE_RECHECK_MS = 10000;
/** Wall-clock bound for the probe child process itself. */
const PASTE_PROBE_TIMEOUT_MS = 1000;

/**
 * The probe command. It is deliberately the same road the paste takes
 * (osascript → Apple Event → System Events → process list), because a
 * probe that uses a different mechanism (e.g. `lsappinfo`) would answer
 * "fine" while the mechanism we actually paste with is dead.
 */
const PASTE_PROBE_COMMAND = Object.freeze({
  cmd: "osascript",
  args: Object.freeze([
    "-e",
    'tell application "System Events" to get name of first process whose frontmost is true',
  ]),
  timeoutMs: PASTE_PROBE_TIMEOUT_MS,
});

function nowOr(now) {
  return Number.isFinite(now) ? Number(now) : Date.now();
}

/** Fresh state for a process that has not probed anything yet. */
function initialPasteCapability(now = 0) {
  const at = nowOr(now);
  return {
    state: PASTE_CAPABILITY.UNKNOWN,
    reason: "never-probed",
    since: at,
    probedAt: 0,
    changedAt: at,
    /** Consecutive "the command ran but nothing happened" paste failures. */
    silentFailures: 0,
  };
}

function transition(prev, state, reason, now) {
  const at = nowOr(now);
  const changed = prev.state !== state;
  return {
    state,
    reason,
    since: changed ? at : prev.since,
    probedAt: prev.probedAt,
    changedAt: changed ? at : prev.changedAt,
    silentFailures: state === PASTE_CAPABILITY.ACTIVE ? 0 : prev.silentFailures,
  };
}

/**
 * Fold a probe result into the state.
 *
 * @param {object} prev      previous state (from initialPasteCapability)
 * @param {object} result
 * @param {string} result.platform     process.platform of the probing host
 * @param {boolean|null} result.trusted  the AXIsProcessTrusted bit, or null
 *                                       when the platform has no such bit
 * @param {boolean} result.probeOk     did the real action succeed
 * @param {string} [result.probeReason] stderr/stdout of the probe, for logs
 * @param {number} [result.now]
 */
function applyProbeResult(prev, result = {}) {
  const base = prev || initialPasteCapability();
  const at = nowOr(result.now);
  const trusted = result.trusted;
  const probeReason = String(result.probeReason || "").trim();
  let next;
  if (trusted === null || trusted === undefined) {
    // R5: Windows/Linux have no trust bit and no probe. Unknown is not a
    // failure — it is "nothing has disproved paste yet", and
    // shouldAttemptPaste() lets it through.
    next = transition(base, PASTE_CAPABILITY.UNKNOWN, "probe-unavailable", at);
  } else if (trusted === false) {
    next = transition(base, PASTE_CAPABILITY.UNTRUSTED, "not-trusted", at);
  } else if (result.probeOk) {
    next = transition(base, PASTE_CAPABILITY.ACTIVE, "probe-ok", at);
  } else if (
    classifyPasteFailure(probeReason) === "silent" &&
    base.silentFailures + 1 < SILENT_FAILURES_BEFORE_BROKEN
  ) {
    // A probe that timed out (or whose osascript never answered) is the
    // same evidence as a paste that timed out, and it is judged by the
    // same rule: one is a loaded machine, two in a row on a trusted
    // system is the stale grant. Condemning the grant on one 1 s timeout
    // is what raised the "Auto-paste could not reach macOS" dialog a
    // minute after two pastes had landed — the probe fired as the
    // window came forward and System Events was slow to answer
    // (main.log 2026-11-20T15:02:40Z). The verdict stands, the strike is
    // counted, and shouldProbe() re-checks it at the recheck cadence.
    next = { ...base, silentFailures: base.silentFailures + 1 };
  } else {
    // The whole point of this module: trusted on paper, dead in practice.
    next = transition(
      base,
      PASTE_CAPABILITY.BROKEN,
      probeReason ? `stale-grant:${probeReason}` : "stale-grant",
      at,
    );
    if (classifyPasteFailure(probeReason) === "silent") next.silentFailures = base.silentFailures + 1;
  }
  next.probedAt = at;
  return next;
}

/**
 * What kind of paste failure is this reason string?
 *
 *  - "permission": the OS told us we are not allowed. Terminal until the
 *    user changes a setting.
 *  - "silent": the command was dispatched and nothing came back — an
 *    Apple Event timeout, a killed osascript, a spawn failure. One of
 *    these is a loaded machine; two in a row on a "trusted" system is
 *    the stale-grant signature.
 *  - "target": there was nothing to paste into (no process, no focus, a
 *    secure field). Says nothing about our capability.
 *  - "other": anything else. Says nothing about our capability.
 */
function classifyPasteFailure(reason) {
  const r = String(reason || "").toLowerCase();
  if (!r) return "other";
  if (
    r.includes("no-accessibility") ||
    r.includes("not authorized") ||
    r.includes("not permitted") ||
    r.includes("not allowed assistive") ||
    r.includes("-1743")
  ) {
    return "permission";
  }
  if (
    r.includes("no-target") ||
    r.includes("no-process") ||
    r.includes("no-focus") ||
    r.includes("not-editable") ||
    r.includes("empty-text")
  ) {
    return "target";
  }
  if (
    r.includes("timed out") ||
    r.includes("timeout") ||
    r.includes("-1712") ||
    r.includes("osascript-failed") ||
    r.includes("spawn")
  ) {
    return "silent";
  }
  return "other";
}

/**
 * Which macOS permission a paste failure is asking the user to grant —
 * ONE classifier, for the trigger and the dialog alike.
 *
 * These two decisions used to be separate substring ladders over the
 * same string, and they drifted: when the capability preflight started
 * refusing BEFORE the ladder could ever produce `ERR:no-accessibility`,
 * its `paste-capability-untrusted` verdict was taught to the status line
 * and not to the prompt trigger — so the app's only Accessibility prompt
 * stopped firing entirely and a first run on a new Mac never asked for
 * the permission it cannot work without.
 *
 * @returns {""|"accessibility"|"automation"}
 */
function classifyPastePermissionFailure(reason) {
  const r = String(reason || "").toLowerCase();
  if (!r) return PASTE_PERMISSION_ROUTE.NONE;
  // The script got far enough to answer, and the answer was "no grant".
  if (r.includes("no-accessibility")) return PASTE_PERMISSION_ROUTE.ACCESSIBILITY;
  // The preflight refused before the script could run. `untrusted` is no
  // grant at all; `broken` is a grant that survived a re-signed install
  // and no longer works — both are repaired in Privacy & Security ->
  // Accessibility, and both need the TCC prompt raised.
  if (
    r.includes(`paste-capability-${PASTE_CAPABILITY.UNTRUSTED}`) ||
    r.includes(`paste-capability-${PASTE_CAPABILITY.BROKEN}`)
  ) {
    return PASTE_PERMISSION_ROUTE.ACCESSIBILITY;
  }
  if (
    r.includes("not authorized") ||
    r.includes("not permitted") ||
    r.includes("system events got an error") ||
    r.includes("-1743") ||
    // Our own vocabulary for "macOS refused the Apple Event", so a state
    // this module produced (applyPasteOutcome's `paste-denied-automation`)
    // routes through the same classifier as the macOS text that caused it
    // and cannot be sent to the wrong Privacy pane on the way back out.
    r.includes("automation")
  ) {
    return PASTE_PERMISSION_ROUTE.AUTOMATION;
  }
  return PASTE_PERMISSION_ROUTE.NONE;
}

/** Two silent failures in a row on a trusted system = stale grant. */
const SILENT_FAILURES_BEFORE_BROKEN = 2;

/**
 * Fold a real paste outcome into the state. A paste that worked is the
 * strongest liveness evidence there is — stronger than the probe — so it
 * promotes any state to `active`.
 *
 * @param {object} prev
 * @param {object} outcome
 * @param {boolean} outcome.ok      did the paste ladder report success
 * @param {string} [outcome.reason]
 * @param {string} [outcome.platform]
 * @param {number} [outcome.now]
 */
function applyPasteOutcome(prev, outcome = {}) {
  const base = prev || initialPasteCapability();
  const at = nowOr(outcome.now);
  if (outcome.ok) return transition(base, PASTE_CAPABILITY.ACTIVE, "paste-succeeded", at);
  const kind = classifyPasteFailure(outcome.reason);
  if (kind === "permission") {
    // WHICH permission was refused decides which state this is, because
    // the two states mean different things to the user. `untrusted` is
    // "nothing was ever granted — go and grant it". An Automation
    // refusal (-1743) is the opposite: System Settings shows the row as
    // ON and macOS still refuses, which is `broken` — the stale grant
    // this module exists for. Collapsing both into `untrusted` is what
    // told a user whose Automation row was already on to go and switch
    // on a permission that was on (main.log 2026-09-05T11:00:00Z).
    if (classifyPastePermissionFailure(outcome.reason) === PASTE_PERMISSION_ROUTE.AUTOMATION) {
      return transition(base, PASTE_CAPABILITY.BROKEN, "paste-denied-automation", at);
    }
    return transition(base, PASTE_CAPABILITY.UNTRUSTED, "paste-denied", at);
  }
  if (kind === "silent") {
    const silentFailures = base.silentFailures + 1;
    if (silentFailures >= SILENT_FAILURES_BEFORE_BROKEN && base.state !== PASTE_CAPABILITY.UNTRUSTED) {
      const next = transition(base, PASTE_CAPABILITY.BROKEN, "paste-silent", at);
      next.silentFailures = silentFailures;
      return next;
    }
    return { ...base, silentFailures };
  }
  // "target" / "other": nothing was learned about the capability.
  return { ...base };
}

/**
 * The gate. `untrusted` and `broken` mean the paste cannot land, so the
 * caller must leave the transcript on the clipboard and say so instead
 * of running a ladder of Apple Events that will all fail (Whispering's
 * rule: never report a paste we did not perform). `unknown` pastes — a
 * platform with no probe is Active-until-proven-otherwise.
 */
function shouldAttemptPaste(state) {
  const s = typeof state === "string" ? state : state?.state;
  return s !== PASTE_CAPABILITY.UNTRUSTED && s !== PASTE_CAPABILITY.BROKEN;
}

/**
 * Is the cached verdict old enough to be worth re-probing? This is the
 * background question — boot, focus regain, and the refresh a paste
 * kicks off behind itself.
 */
function shouldProbe(cap, now = 0) {
  const at = nowOr(now);
  const state = cap?.state || PASTE_CAPABILITY.UNKNOWN;
  if (!cap || !cap.probedAt) return true;
  // An `active` verdict with an unanswered probe behind it is not yet
  // believed for the full minute: the strike is confirmed or cleared at
  // the recheck cadence.
  const believed = state === PASTE_CAPABILITY.ACTIVE && !(cap.silentFailures > 0);
  const ttl = believed ? PASTE_PROBE_ACTIVE_TTL_MS : PASTE_PROBE_RECHECK_MS;
  return at - cap.probedAt >= ttl;
}

/**
 * Must a paste WAIT for a fresh probe before it decides anything?
 *
 * Only in the two cases where the answer changes what happens: nothing
 * has ever been probed, or the cached verdict is the thing that would
 * refuse this paste. Never act on a stale refusal — two transient
 * timeouts must not switch pasting off for a whole recheck window, and
 * the probe is one bounded round trip (~200 ms measured on macOS 27)
 * against a ladder that would otherwise spend seconds failing.
 *
 * A verdict that ALLOWS the paste is never waited on, however old it is:
 * the user has just stopped talking and is waiting for text.
 */
function mustProbeBeforePaste(cap) {
  if (!cap || !cap.probedAt) return true;
  return !shouldAttemptPaste(cap);
}

// ── Repairing a grant macOS believes it has already given ──────────────
//
// The state machine above can SEE a dead grant. This section decides
// what to do about one, because "tell the user to switch on a permission
// that is already switched on" is not a remedy.
//
// Two different diseases produce the identical symptom — the app is
// listed and ON in Privacy & Security, and macOS refuses anyway:
//
//  1. STALE csreq. TCC stores a grant against a bundle id AND the code
//     signing requirement the app satisfied when the grant was made. A
//     rebuild under a different certificate (or an ad-hoc signature)
//     leaves the row visible and matching nothing. The remedy is to drop
//     the row so macOS asks again: `tccutil reset <service> <bundle id>`,
//     which needs no admin for the user's own TCC store.
//
//  2. The RUNNING COPY is no longer the copy on disk. Installing a new
//     build over /Applications/Transcriptor.app while the old one runs
//     replaces the bundle under a live process; from that moment macOS
//     stops validating that process's identity and every Apple Event it
//     sends comes back errAEEventNotPermitted (-1743). This is what
//     main.log recorded on 2026-09-05: the bundle was re-signed at
//     10:56Z, the process that had been running since 2026-09-04T22:47Z
//     probed OK at 10:58:53Z, then failed every Apple Event from
//     10:59:59Z on — and the very next launch of the very same bundle
//     probed `active` again at 11:00:51Z.
//
// Telling those apart matters, because a reset is the WRONG move for the
// second one: the grant on file is valid for the copy on disk, the
// running process cannot be rescued by any TCC change, and resetting
// would throw away a working grant to no purpose. Only a relaunch fixes
// it. Which is why `detectBundleReplacement` is consulted first.
//
// Everything here stays pure — which service, whether to reset, whether
// this boot has already tried, what to say — and desktop/main.js runs
// the one shell command behind `permissionRepairCommand`.

/**
 * The macOS TCC services the paste path depends on, under the names
 * `tccutil` knows them by. `AppleEvents` is the service System Settings
 * presents as "Automation"; there is no `tccutil` service called
 * "Automation" and asking for one is a silent no-op.
 */
const TCC_SERVICE = Object.freeze({
  AUTOMATION: "AppleEvents",
  ACCESSIBILITY: "Accessibility",
});

/** Both services, in the order the "Repair permissions" action tries them. */
const PERMISSION_REPAIR_SERVICES = Object.freeze([
  TCC_SERVICE.ACCESSIBILITY,
  TCC_SERVICE.AUTOMATION,
]);

/** What to DO about a permission failure. One verb per outcome. */
const PERMISSION_REPAIR = Object.freeze({
  /** Nothing this module can repair — or nothing left to try this boot. */
  NONE: "none",
  /** Drop the grant so macOS asks again: `tccutil reset <service> <id>`. */
  RESET: "reset",
  /** The running copy is not the copy on disk; only a restart fixes it. */
  RELAUNCH: "relaunch",
  /** Say it, once, with the pane and the exact clicks. */
  REPORT: "report",
});

/** `tccutil` is a local database write; a second is already suspicious. */
const TCC_RESET_TIMEOUT_MS = 5000;

/**
 * Slack between "the bundle was written" and "the process started"
 * before a rewrite counts as having happened UNDER the running process.
 * An install writes the bundle and launches it seconds later, so the
 * normal case is a negative difference; this only guards the boundary.
 */
const BUNDLE_REPLACEMENT_TOLERANCE_MS = 2000;

/**
 * Was the app bundle replaced while this process was running?
 *
 * Two independent witnesses, either of which is conclusive:
 *   - the version in the bundle's Info.plist is not the version this
 *     process is running (a new build was installed over it), and
 *   - the executable on disk was written after this process started.
 *
 * @returns {{replaced: boolean, evidence: string}}
 */
function detectBundleReplacement({
  runningVersion = "",
  bundleVersion = "",
  bundleMtimeMs = 0,
  processStartedAtMs = 0,
  toleranceMs = BUNDLE_REPLACEMENT_TOLERANCE_MS,
} = {}) {
  const running = String(runningVersion || "").trim();
  const onDisk = String(bundleVersion || "").trim();
  if (running && onDisk && running !== onDisk) {
    return { replaced: true, evidence: `version-mismatch:running=${running},disk=${onDisk}` };
  }
  const mtime = Number(bundleMtimeMs) || 0;
  const started = Number(processStartedAtMs) || 0;
  const tolerance = Math.max(0, Number(toleranceMs) || 0);
  if (mtime > 0 && started > 0 && mtime - started > tolerance) {
    return {
      replaced: true,
      evidence: `rewritten-after-launch:+${Math.round((mtime - started) / 1000)}s`,
    };
  }
  return { replaced: false, evidence: "" };
}

/**
 * Which TCC service a failure text is about — the SAME classifier the
 * dialog and the status line use, mapped onto `tccutil`'s vocabulary.
 * Empty when the text names no permission.
 */
function tccServiceForPasteFailure(reason) {
  const route = classifyPastePermissionFailure(reason);
  if (route === PASTE_PERMISSION_ROUTE.AUTOMATION) return TCC_SERVICE.AUTOMATION;
  if (route === PASTE_PERMISSION_ROUTE.ACCESSIBILITY) return TCC_SERVICE.ACCESSIBILITY;
  return "";
}

/**
 * The most specific failure text available.
 *
 * When the capability preflight refuses a paste, the ladder's reason is
 * `paste-capability-<state>` — which says the preflight refused and
 * nothing about WHY. The capability's own reason carries the macOS error
 * that decided it (`stale-grant:… (-1743)`), and that is the text the
 * service classifier needs. Preferring it here is what keeps an
 * Automation refusal from being repaired as an Accessibility one.
 */
function preferSpecificFailureReason(ladderReason, capabilityReason) {
  const ladder = String(ladderReason || "");
  const capability = String(capabilityReason || "").trim();
  if (capability && /paste-capability-/i.test(ladder)) return capability;
  return ladder;
}

/**
 * The whole self-heal decision.
 *
 * @param {object}  input
 * @param {string}  input.platform        process.platform
 * @param {object|string} input.state     capability state (or its name)
 * @param {string}  input.reason          the most specific failure text
 * @param {boolean|null} input.trusted    AXIsProcessTrusted, or null
 * @param {boolean} input.bundleReplaced  detectBundleReplacement().replaced
 * @param {string[]} input.resetServices  services already reset this boot
 * @param {boolean} input.reported        has this boot already said it
 * @returns {{action: string, service: string, why: string}}
 */
function planPermissionRepair({
  platform = "darwin",
  state = "",
  reason = "",
  trusted = null,
  bundleReplaced = false,
  resetServices = [],
  reported = false,
} = {}) {
  const none = (why, service = "") => ({ action: PERMISSION_REPAIR.NONE, service, why });
  if (platform !== "darwin") return none("not-darwin");
  const capState = typeof state === "string" ? state : state?.state || "";
  const service = tccServiceForPasteFailure(reason);
  if (
    !service &&
    capState !== PASTE_CAPABILITY.BROKEN &&
    capState !== PASTE_CAPABILITY.UNTRUSTED
  ) {
    return none("not-a-permission-failure");
  }
  if (bundleReplaced) {
    // No TCC change can help a process whose bundle was swapped under
    // it, and a reset here would drop a grant that is valid for the copy
    // on disk. Say the one thing that works.
    if (reported) return none("already-reported", service);
    return { action: PERMISSION_REPAIR.RELAUNCH, service, why: "bundle-replaced" };
  }
  if (trusted === false) {
    // Nothing was ever granted. Resetting an absent row changes nothing;
    // the remedy is the system's own permission prompt, which the
    // ordinary prompt path raises. Not this module's job.
    return none("not-trusted");
  }
  if (!service) {
    // Broken, trusted, and the failure named no permission — a probe
    // that timed out, say. That is not evidence of a dead grant, and
    // resetting on it would revoke a working permission because the
    // machine was busy. Report it and let the user decide.
    if (reported) return none("already-reported");
    return { action: PERMISSION_REPAIR.REPORT, service: "", why: "no-named-service" };
  }
  const alreadyReset = new Set((resetServices || []).map((s) => String(s || "")));
  if (!alreadyReset.has(service)) {
    return { action: PERMISSION_REPAIR.RESET, service, why: "granted-but-refused" };
  }
  // Reset once, still refused: this is no longer something the app can
  // fix on the user's behalf.
  if (reported) return none("already-reported", service);
  return { action: PERMISSION_REPAIR.REPORT, service, why: "reset-did-not-help" };
}

/**
 * The one shell command the self-heal runs, built here so no caller can
 * assemble a different one — and so the bundle id it targets is checked
 * before it reaches a process argument list. The id comes from the
 * running bundle (desktop/package.json `build.appId` is its source, see
 * desktop/packaging.test.js); there is no default and no second literal.
 */
function permissionRepairCommand(service, bundleId) {
  const svc = String(service || "").trim();
  if (svc !== TCC_SERVICE.AUTOMATION && svc !== TCC_SERVICE.ACCESSIBILITY) {
    throw new Error(
      `permissionRepairCommand: unknown TCC service "${svc}" — expected ` +
        `${TCC_SERVICE.ACCESSIBILITY} or ${TCC_SERVICE.AUTOMATION}.`,
    );
  }
  const id = String(bundleId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(
      `permissionRepairCommand: refusing to reset TCC for an implausible bundle id "${id}".`,
    );
  }
  return { cmd: "tccutil", args: ["reset", svc, id], timeoutMs: TCC_RESET_TIMEOUT_MS };
}

/**
 * The single writer of remediation prose. Both the dialog and the
 * renderer note read it, so the app cannot name two different fixes for
 * one failure — which is exactly what it used to do: every `broken`
 * state, including an Automation refusal, was described as a stale
 * ACCESSIBILITY row and sent the user to the wrong pane.
 *
 * @returns {{title: string, fix: string}}
 */
function permissionRepairMessage({ action = "", service = "" } = {}) {
  if (action === PERMISSION_REPAIR.RELAUNCH) {
    return {
      title: "Transcriptor was replaced while it was running",
      fix:
        "Quit and reopen Transcriptor. macOS stops trusting a running copy once its " +
        "files have been replaced by a new build, and no permission change repairs it.",
    };
  }
  if (service === TCC_SERVICE.AUTOMATION) {
    return {
      title: "Auto-paste is blocked by a stale Automation permission",
      fix:
        "System Settings → Privacy & Security → Automation: switch Transcriptor → " +
        "System Events off and on again. If it is already on, use Repair permissions " +
        "in Transcriptor's Settings, then quit and reopen Transcriptor.",
    };
  }
  if (service === TCC_SERVICE.ACCESSIBILITY) {
    return {
      title: "Auto-paste is blocked by a stale Accessibility permission",
      fix:
        "System Settings → Privacy & Security → Accessibility: remove and re-add " +
        "Transcriptor. If it is already on, use Repair permissions in Transcriptor's " +
        "Settings, then quit and reopen Transcriptor.",
    };
  }
  return {
    title: "Auto-paste could not reach macOS",
    fix:
      "Use Repair permissions in Transcriptor's Settings, then quit and reopen " +
      "Transcriptor. If it keeps happening, check Privacy & Security → Accessibility " +
      "and → Automation.",
  };
}

/**
 * The user-facing half of a capability verdict. `fix` is the literal
 * sequence of clicks that repairs the state, routed by the SAME
 * classifier the self-heal uses — pass the state OBJECT (or a `reason`)
 * and an Automation refusal is described as one.
 *
 * @param {object|string} state
 * @param {object} [context]
 * @param {string} [context.reason]          overrides state.reason
 * @param {boolean} [context.bundleReplaced] the running copy is stale
 */
function pasteCapabilityMessage(state, context = {}) {
  const s = typeof state === "string" ? state : state?.state;
  if (s !== PASTE_CAPABILITY.BROKEN && s !== PASTE_CAPABILITY.UNTRUSTED) {
    return { title: "", fix: "" };
  }
  if (context.bundleReplaced) {
    return permissionRepairMessage({ action: PERMISSION_REPAIR.RELAUNCH });
  }
  if (s === PASTE_CAPABILITY.UNTRUSTED) {
    // Nothing was ever granted — the only state where "add it and switch
    // it on" is true.
    return {
      title: "Auto-paste needs Accessibility permission",
      fix: "System Settings → Privacy & Security → Accessibility: add Transcriptor and switch it on.",
    };
  }
  const reason = context.reason !== undefined
    ? context.reason
    : (typeof state === "object" ? state?.reason : "");
  const service = tccServiceForPasteFailure(reason) || TCC_SERVICE.ACCESSIBILITY;
  return permissionRepairMessage({ action: PERMISSION_REPAIR.REPORT, service });
}

// ── Who macOS thinks we are ────────────────────────────────────────────
//
// TCC keys every grant by bundle id, so the self-heal has to name one —
// and naming it twice is how an app ends up resetting a row that belongs
// to nothing. The authority at runtime is the Info.plist of the bundle
// actually running (electron-builder writes it from `build.appId` in
// desktop/package.json, which packaging.test.js holds every other copy
// to). Parsing it is pure, so it is tested here rather than discovered
// in production.

/**
 * Read one string value out of an XML Info.plist.
 *
 * Deliberately narrow: `<key>K</key>` followed by `<string>V</string>`.
 * electron-builder writes XML plists, and this is only ever pointed at
 * the app's own Info.plist. A binary plist or an unexpected shape
 * returns "" and the caller falls back rather than guessing.
 */
function infoPlistString(text, key) {
  const source = String(text || "");
  const wanted = String(key || "");
  if (!source || !wanted) return "";
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`).exec(source);
  return m ? m[1].trim() : "";
}

/** `{ bundleId, version }` from an app's Info.plist text. */
function parseBundleIdentity(text) {
  return {
    bundleId: infoPlistString(text, "CFBundleIdentifier"),
    version: infoPlistString(text, "CFBundleShortVersionString"),
  };
}

// ── Retry / timeout budget ─────────────────────────────────────────────
//
// ONE table for every bound the paste ladder is allowed to spend, so
// "how long can a paste take" has a single answer a test can check
// against the deadline the user is already waiting inside. The numbers
// are the ones the ladder in desktop/main.js actually uses; the ladder
// reads them from here rather than carrying literals next to each
// runCommand call.
//
// What this table does NOT own: how long ONE accessibility read inside
// the AppleScript may take. That bound lives with the script that
// carries it (desktop/paste-script.js AX_READ_TIMEOUT_SEC), because it
// is enforced by AppleScript, not by us. What this table owns is the
// parent's wall clock: `verificationAllowanceMs` is the extra time an
// attempt is granted when the script carries those reads at all.
//
// Fields:
//   maxAttempts        — attempts of the whole method ladder. The
//                        contract ceiling is PASTE_MAX_ATTEMPTS (5, the
//                        Wispr Flow number); every platform stays at the
//                        3 it has always used, because nothing measured
//                        says a fourth identical attempt lands where
//                        three did not, and each one is seconds the user
//                        spends watching a spinner.
//   attemptDelaysMs    — settle sleep before attempt N (index = attempt).
//   methodTimeoutsMs   — the bounded child processes ONE attempt may
//                        spawn, in order. macOS runs one osascript;
//                        Windows runs cscript then the PowerShell
//                        fallback; Linux walks its CLI cascade.
//   verificationAllowanceMs — added to a macOS attempt when the script
//                        carries the AX verification reads. Worst case:
//                        the "before" read (focused element + AXValue +
//                        AXNumberOfCharacters, each an Apple Event
//                        bounded at AX_READ_TIMEOUT_SEC = 0.25 s) plus
//                        the "after" read, which resolves the element
//                        once and then polls its value up to
//                        AX_VERIFY_POLLS times, AX_VERIFY_POLL_INTERVAL_SEC
//                        apart, because a key code is delivered
//                        asynchronously and reading immediately measured
//                        the element BEFORE the paste. Measured against a
//                        scratch TextEdit document, one poll sufficed in
//                        8 of 8 trials, so the typical cost is ~50 ms;
//                        the allowance covers the bound, not the typical.
//   activationSettleMs — sleep after re-activating the target INSIDE an
//                        attempt (Windows/Linux do this every attempt).
//   preflightSettleMs  — the same sleep paid ONCE before the ladder
//                        (macOS activates the target before attempt 1).
//   tailFallbackTimeoutMs — the one bounded child that runs after the
//                        ladder is exhausted (macOS menu-paste).
//   preflightMs        — worst case spent before the ladder starts:
//                        waiting for the paste-last hotkey's own
//                        modifiers to come up (see planModifierRelease),
//                        INCLUDING the spawn allowance the wait carries
//                        (modifierReleaseCommand's own timeout), plus the
//                        capability probe.
//   activationTimeoutMs — bound for ONE target-activation child. The
//                        ladder in activateCapturedPasteTarget may spawn
//                        up to activationLadderSteps of them per attempt
//                        (window handle, then pid, then app name).
//   activationLadderSteps — how many of those one attempt may spend.
//   autoSendTimeoutMs  — bound for the one auto-send child (Cmd+Enter /
//                        Ctrl+Enter), which runs after a successful
//                        paste when the user enabled auto-send.
//   appActivationSettleMs / windowActivationSettleMs — how long an
//                        activation is given to take effect before the
//                        caller acts on it (DM-16/DM-20: these lived in
//                        main.js as constants named for one platform and
//                        used by another). Activating an APP (by name or
//                        pid) is asynchronous and the shell needs a
//                        moment to repaint; activating one WINDOW by id
//                        (an X11 window id, a Win32 hwnd) is acknowledged
//                        far sooner. One successful activation per
//                        attempt pays one of them.
//   autoSendActivationSettleMs — the pause between auto-send re-raising
//                        the target and firing its chord.
//
// These last three used to be bare 5000 / 2000 literals scattered across
// main.js while the comment above pasteBudgetWorstCaseMs claimed every
// wall-clock bound came from this table. On Windows, with an
// unreachable target, that made the real worst case far larger than the
// computed one.
const MODIFIER_HOLD_MS = 150;
const MODIFIER_WAIT_DEADLINE_MS = 500;
const MODIFIER_POLL_INTERVAL_MS = 25;
/** osascript + JXA startup measured at ~240 ms; 600 ms is that with room. */
const MODIFIER_SPAWN_ALLOWANCE_MS = 600;

const PASTE_MAX_ATTEMPTS = 5;

// The pause between the paste landing and the auto-send Enter. It is the
// same on every platform because it protects the same thing everywhere: the
// target application applying the pasted text before Enter is delivered.
// Enter into a field that has not received the text yet sends an empty
// message. Declared here rather than as a literal at the call site so it
// sits with every other wall-clock number the paste path spends.
const AUTO_SEND_SETTLE_MS = 380;

// The activation settles, the same on every platform that activates (see
// the field notes above); one declaration each, referenced by every row.
const APP_ACTIVATION_SETTLE_MS = 350;
const WINDOW_ACTIVATION_SETTLE_MS = 180;
const AUTO_SEND_ACTIVATION_SETTLE_MS = 110;
const ACTIVATION_SETTLES = Object.freeze({
  appActivationSettleMs: APP_ACTIVATION_SETTLE_MS,
  windowActivationSettleMs: WINDOW_ACTIVATION_SETTLE_MS,
  autoSendActivationSettleMs: AUTO_SEND_ACTIVATION_SETTLE_MS,
});

const PASTE_BUDGET = Object.freeze({
  darwin: Object.freeze({
    maxAttempts: 3,
    attemptDelaysMs: Object.freeze([45, 85, 125]),
    methodTimeoutsMs: Object.freeze([3200]),
    // 0.75 s "before" + 0.25 s element resolve
    // + AX_VERIFY_POLLS x (interval + 2 bounded reads) = 0.25 + 4 x 0.55
    // -> 3.2 s, rounded up.
    verificationAllowanceMs: 3300,
    activationSettleMs: 0,
    preflightSettleMs: 80,
    tailFallbackTimeoutMs: 4500,
    // The modifier wait's deadline (500) plus the spawn allowance
    // modifierReleaseCommand adds on top of it (600), plus the
    // capability probe that runs before the ladder.
    preflightMs: MODIFIER_WAIT_DEADLINE_MS + MODIFIER_SPAWN_ALLOWANCE_MS + PASTE_PROBE_TIMEOUT_MS,
    // macOS activates the captured window once BEFORE the ladder, not
    // per attempt, so the ladder itself spends none of this.
    activationTimeoutMs: 1500,
    activationLadderSteps: 0,
    autoSendTimeoutMs: 5000,
    autoSendSettleMs: AUTO_SEND_SETTLE_MS,
    ...ACTIVATION_SETTLES,
  }),
  win32: Object.freeze({
    // Two, not three. With the target-activation ladder finally counted
    // (three PowerShell spawns per attempt, each with an Add-Type
    // compile), three attempts put the honest worst case at ~65 s — far
    // past the deadline the user is actually waiting in, and past what
    // the ladder was ever believed to cost. Two attempts still means up
    // to four injections, because every attempt runs the VBS paste and
    // then the PowerShell fallback.
    maxAttempts: 2,
    attemptDelaysMs: Object.freeze([30, 60]),
    // cscript (Defender can spend 1-3 s scanning it) then the
    // PowerShell SendKeys fallback, which now runs after every VBS
    // failure rather than only on the last attempt.
    methodTimeoutsMs: Object.freeze([3500, 3000]),
    verificationAllowanceMs: 0,
    activationSettleMs: 70,
    preflightSettleMs: 0,
    tailFallbackTimeoutMs: 0,
    preflightMs: 0,
    // PowerShell with an Add-Type compile is the slow one here; this is
    // the value the three Windows activators have always used, now named
    // and counted.
    activationTimeoutMs: 2500,
    activationLadderSteps: 3,
    autoSendTimeoutMs: 2000,
    autoSendSettleMs: AUTO_SEND_SETTLE_MS,
    ...ACTIVATION_SETTLES,
  }),
  linux: Object.freeze({
    maxAttempts: 3,
    attemptDelaysMs: Object.freeze([30, 60, 90]),
    // wtype / xdotool / ydotool — at most three of them per attempt,
    // depending on whether the session is Wayland, X11 or both.
    methodTimeoutsMs: Object.freeze([2000, 2000, 2000]),
    verificationAllowanceMs: 0,
    activationSettleMs: 60,
    preflightSettleMs: 0,
    tailFallbackTimeoutMs: 0,
    preflightMs: 0,
    // wmctrl / xdotool / a bare osascript-free activation are all fast;
    // nothing here compiles C# on the way in.
    activationTimeoutMs: 1200,
    activationLadderSteps: 3,
    autoSendTimeoutMs: 2000,
    autoSendSettleMs: AUTO_SEND_SETTLE_MS,
    ...ACTIVATION_SETTLES,
  }),
});

/**
 * The deadline processPostStopTask waits for a paste-ready transcript
 * (BUGS_AUDIT §6.7/§6.9). Lives here because the paste budget is only
 * meaningful relative to it: the ladder has to fit inside the same
 * envelope the user is already waiting in, which is what
 * pasteBudgetWorstCaseMs is checked against.
 */
const PASTE_POST_STOP_DEADLINE_MS = 32000;

function pasteBudgetFor(platform) {
  return PASTE_BUDGET[platform] || PASTE_BUDGET.linux;
}

/** Delay before attempt `attempt` (0-based), clamped to the table. */
function pasteAttemptDelayMs(platform, attempt) {
  const budget = pasteBudgetFor(platform);
  const delays = budget.attemptDelaysMs;
  if (!delays.length) return 0;
  const idx = Math.max(0, Math.min(delays.length - 1, Number(attempt) || 0));
  return delays[idx];
}

/**
 * Wall-clock bound for ONE bounded child inside an attempt.
 * `verify` adds the verification allowance to the first (and, on macOS,
 * only) method — that is the osascript that carries the AX reads.
 */
function pasteMethodTimeoutMs(platform, methodIndex = 0, verify = false) {
  const budget = pasteBudgetFor(platform);
  const timeouts = budget.methodTimeoutsMs;
  const idx = Math.max(0, Math.min(timeouts.length - 1, Number(methodIndex) || 0));
  const base = timeouts[idx];
  return verify && idx === 0 ? base + budget.verificationAllowanceMs : base;
}

/**
 * Worst case wall-clock of the whole paste ladder: every attempt runs
 * every method it may run, every one of them times out, verification is
 * attempted throughout, and the tail fallback times out too.
 */
function pasteBudgetWorstCaseMs(platform) {
  const b = pasteBudgetFor(platform);
  const delays = b.attemptDelaysMs.slice(0, b.maxAttempts).reduce((a, x) => a + x, 0);
  const perAttemptMethods = b.methodTimeoutsMs.reduce((a, x) => a + x, 0) + b.verificationAllowanceMs;
  // The activation ladder is spawned INSIDE each attempt on the
  // platforms that re-activate per attempt, and it is real wall clock
  // the user waits through. Leaving it out is what made the "one table,
  // one answer" claim above false.
  // The rung that succeeds then sleeps its settle before the attempt goes
  // on — the longer of the two kinds, since either may be the one.
  const perAttemptActivation = b.activationLadderSteps * b.activationTimeoutMs
    + (b.activationLadderSteps > 0 ? Math.max(b.appActivationSettleMs, b.windowActivationSettleMs) : 0);
  return (
    b.preflightMs +
    b.preflightSettleMs +
    delays +
    b.maxAttempts * (perAttemptMethods + perAttemptActivation + b.activationSettleMs) +
    b.tailFallbackTimeoutMs
  );
}

/** Bound for ONE target-activation child on this platform. */
function pasteActivationTimeoutMs(platform) {
  return pasteBudgetFor(platform).activationTimeoutMs;
}

/** Bound for the one auto-send (Cmd+Enter / Ctrl+Enter) child. */
function pasteAutoSendTimeoutMs(platform) {
  return pasteBudgetFor(platform).autoSendTimeoutMs;
}

/** Pause between the paste landing and the auto-send Enter. */
function pasteAutoSendSettleMs(platform) {
  return pasteBudgetFor(platform).autoSendSettleMs;
}

// ── Marking the transcript as transient ────────────────────────────────
//
// Clipboard managers hoover up everything that lands on the pasteboard,
// so a dictated transcript ends up in the user's clipboard history
// forever. The convention for opting out is to put the type
// `org.nspasteboard.TransientType` on the same pasteboard item
// (nspasteboard.org).
//
// Electron 42.4.1 (the pinned version) cannot do it without native code,
// and the reason is structural rather than a missing argument:
//   - `clipboard.write(data)` takes a fixed `Data` shape — text, html,
//     image, rtf, bookmark. There is no key for a custom UTI.
//   - `clipboard.writeBuffer(format, buffer)` does take an arbitrary
//     format, but it is a WRITE, not an addition: every Electron
//     clipboard write goes through a ScopedClipboardWriter whose commit
//     replaces the pasteboard contents. Writing the marker after the
//     text removes the text; writing it before, the text removes the
//     marker. There is no API to add a type to the item already there.
// Doing it properly needs NSPasteboard directly, which means a native
// addon. Recorded in the debt ledger; the analysis stays here because it is
// what stops the next reader spending a day rediscovering it.
//
// It used to be recorded as two exported constants —
// PASTE_TRANSIENT_TYPE = "org.nspasteboard.TransientType" and
// PASTE_TRANSIENT_TYPE_SUPPORTED = false — imported by nothing and asserted
// equal to their own literals by a test. A constant no code reads is not a
// record of a decision, it is a symbol pretending to be a capability.

// ── Modifier-release race ─────────────────────────────────────────
//
// The record hotkey pastes 1–2 s after the key is released, so the
// physical modifiers are long up. The paste-last hotkey (Alt+Shift+V on
// macOS) pastes IMMEDIATELY, while Alt and Shift are still physically
// held — and a synthesised Cmd+V inherits the real modifier flags, so
// the target app receives Cmd+Alt+Shift+V and does something else
// entirely (or nothing).
//
// Handy holds its injected chord for CHORD_HOLD_MS = 100 ms so the
// target reliably sees a complete key event, and local-speak waits up to
// CTRL_WAIT_DEADLINE = 0.5 s for the user's own control keys to come up
// before injecting. We take both numbers: wait for the flags to clear,
// give up after 500 ms, and never inject sooner than 150 ms after the
// hotkey (≥ CHORD_HOLD_MS, so the user's own chord has finished being
// delivered to whatever else is listening).

/** NSEventModifierFlags bits we care about (AppKit). */
const NS_EVENT_MODIFIER_FLAGS = Object.freeze({
  shift: 1 << 17,
  control: 1 << 18,
  option: 1 << 19,
  command: 1 << 20,
});
const NS_EVENT_MODIFIER_MASK =
  NS_EVENT_MODIFIER_FLAGS.shift |
  NS_EVENT_MODIFIER_FLAGS.control |
  NS_EVENT_MODIFIER_FLAGS.option |
  NS_EVENT_MODIFIER_FLAGS.command;

/**
 * Does this paste need to wait for the user's own modifiers, and for how
 * long? Only the hotkey-triggered paste does: `trigger: "hotkey"` with a
 * modifier-bearing accelerator.
 */
function planModifierRelease({ platform = "", accelerator = "", trigger = "" } = {}) {
  const none = {
    needed: false,
    canPoll: false,
    holdMs: 0,
    deadlineMs: 0,
    pollIntervalMs: MODIFIER_POLL_INTERVAL_MS,
  };
  if (trigger !== "hotkey") return none;
  const accel = String(accelerator || "");
  if (!accel.includes("+")) return none;
  // Windows and Linux are NOT immune to this. The section above was
  // written when the paste-last default on those platforms was a bare
  // F10, which carries no modifiers — but the same wave that added this
  // wait changed the default to Control+Alt+Shift+V (see
  // shortcut-defaults.json), so `SendKeys "^v"` now fires while
  // Ctrl+Alt+Shift are physically down and the target receives
  // Ctrl+Alt+Shift+V. What they lack is not the problem, it is the
  // INSTRUMENT: there is no NSEvent.modifierFlags to poll, so they get
  // the fixed floor — never inject sooner than MODIFIER_HOLD_MS after
  // the hotkey — while macOS additionally waits for the flags to clear.
  const canPoll = platform === "darwin";
  return {
    needed: true,
    canPoll,
    holdMs: MODIFIER_HOLD_MS,
    deadlineMs: canPoll ? MODIFIER_WAIT_DEADLINE_MS : MODIFIER_HOLD_MS,
    pollIntervalMs: MODIFIER_POLL_INTERVAL_MS,
  };
}

/**
 * JXA source for the wait. One osascript spawn does the whole poll —
 * spawning once per 25 ms poll would cost more than the wait itself.
 * `NSEvent.modifierFlags` is a global read that needs no permission at
 * all, so this works even when the capability probe says `broken`.
 * Prints `MODS:<cleared|held>:<flags>:<waitedMs>`.
 */
function modifierReleaseScript(plan) {
  const holdMs = Math.max(0, Number(plan?.holdMs) || 0);
  const deadlineMs = Math.max(holdMs, Number(plan?.deadlineMs) || 0);
  const pollMs = Math.max(5, Number(plan?.pollIntervalMs) || MODIFIER_POLL_INTERVAL_MS);
  return [
    'ObjC.import("AppKit");',
    'ObjC.import("Foundation");',
    `var MASK = ${NS_EVENT_MODIFIER_MASK};`,
    `var HOLD = ${holdMs};`,
    `var DEADLINE = ${deadlineMs};`,
    `var POLL = ${pollMs};`,
    "var started = Date.now();",
    "var flags = 0;",
    "var cleared = false;",
    "while (true) {",
    "  var waited = Date.now() - started;",
    "  flags = Number($.NSEvent.modifierFlags) & MASK;",
    "  if (flags === 0 && waited >= HOLD) { cleared = true; break; }",
    "  if (waited >= DEADLINE) { break; }",
    "  $.NSThread.sleepForTimeInterval(POLL / 1000);",
    "}",
    '"MODS:" + (cleared ? "cleared" : "held") + ":" + flags + ":" + (Date.now() - started);',
  ].join("\n");
}

/**
 * The whole spawn, so no caller can get the interpreter flag wrong: the
 * script above is JavaScript for Automation, and `osascript` compiles
 * AppleScript unless told otherwise. Measured on macOS 27: 405 ms wall
 * for a 164 ms wait, i.e. ~240 ms of osascript + JXA startup, which is
 * why this runs ONCE per paste-last press and never in a poll loop.
 *
 * The timeout is the plan deadline plus that startup allowance: the
 * script always returns on its own at the deadline, so a wall-clock kill
 * here means something else went wrong, and the caller pastes anyway.
 */
function modifierReleaseCommand(plan) {
  return {
    cmd: "osascript",
    args: ["-l", "JavaScript", "-e", modifierReleaseScript(plan)],
    timeoutMs: Math.max(0, Number(plan?.deadlineMs) || 0) + MODIFIER_SPAWN_ALLOWANCE_MS,
  };
}

/** Parse `MODS:<cleared|held>:<flags>:<waitedMs>` out of osascript stdout. */
function parseModifierReleaseResult(stdout) {
  const line = String(stdout == null ? "" : stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  const m = /^MODS:(cleared|held):(\d+):(\d+)$/.exec(line || "");
  if (!m) return { ok: false, cleared: false, flags: 0, waitedMs: 0 };
  return {
    ok: true,
    cleared: m[1] === "cleared",
    flags: Number(m[2]),
    waitedMs: Number(m[3]),
  };
}

/** Which modifiers are still down, from a raw NSEventModifierFlags value. */
function heldModifiersFromFlags(flags) {
  const f = Number(flags) || 0;
  return Object.keys(NS_EVENT_MODIFIER_FLAGS).filter((k) => (f & NS_EVENT_MODIFIER_FLAGS[k]) !== 0);
}

module.exports = {
  PASTE_PERMISSION_ROUTE,
  pasteActivationTimeoutMs,
  pasteAutoSendTimeoutMs,
  pasteAutoSendSettleMs,
  classifyPastePermissionFailure,
  PASTE_CAPABILITY,
  PASTE_PROBE_ACTIVE_TTL_MS,
  PASTE_PROBE_RECHECK_MS,
  PASTE_PROBE_TIMEOUT_MS,
  PASTE_PROBE_COMMAND,
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
  TCC_RESET_TIMEOUT_MS,
  PERMISSION_REPAIR,
  PERMISSION_REPAIR_SERVICES,
  BUNDLE_REPLACEMENT_TOLERANCE_MS,
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
  NS_EVENT_MODIFIER_FLAGS,
  NS_EVENT_MODIFIER_MASK,
  MODIFIER_HOLD_MS,
  MODIFIER_WAIT_DEADLINE_MS,
  MODIFIER_POLL_INTERVAL_MS,
  planModifierRelease,
  modifierReleaseScript,
  modifierReleaseCommand,
  MODIFIER_SPAWN_ALLOWANCE_MS,
  parseModifierReleaseResult,
  heldModifiersFromFlags,
};
