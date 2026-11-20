"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  POWER_EVENTS,
  POWER_ACTIONS,
  powerEventAction,
  subscribePowerEvents,
  _resetPowerEventSubscriptions,
} = require("./power-events");

function fakeMonitor() {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event) {
      for (const fn of handlers.get(event) || []) fn();
    },
    countFor(event) {
      return (handlers.get(event) || []).length;
    },
    events() {
      return [...handlers.keys()];
    },
  };
}

test("the three power events the app depends on are all subscribed", () => {
  // BUG-81's resume re-claim and 1.6.0's warm-microphone release both
  // shipped dead because nothing subscribed them.
  assert.deepEqual([...POWER_EVENTS].sort(), ["lock-screen", "resume", "shutdown", "suspend"]);
});

test("resume reclaims shortcuts; suspend and lock-screen release the warm capture", () => {
  assert.equal(powerEventAction("resume"), POWER_ACTIONS.RECLAIM_SHORTCUTS);
  assert.equal(powerEventAction("suspend"), POWER_ACTIONS.RELEASE_WARM_CAPTURE);
  assert.equal(powerEventAction("lock-screen"), POWER_ACTIONS.RELEASE_WARM_CAPTURE);
  assert.equal(powerEventAction("on-ac"), "", "an event we do not handle has no action");
  assert.equal(powerEventAction(undefined), "");
});

test("each event runs exactly its own handler, with the event name", () => {
  const monitor = fakeMonitor();
  const reclaims = [];
  const releases = [];
  subscribePowerEvents(monitor, {
    reclaimShortcuts: (e) => reclaims.push(e),
    releaseWarmCapture: (e) => releases.push(e),
  });

  monitor.emit("resume");
  monitor.emit("suspend");
  monitor.emit("lock-screen");

  assert.deepEqual(reclaims, ["resume"]);
  assert.deepEqual(releases, ["suspend", "lock-screen"]);
  _resetPowerEventSubscriptions(monitor);
});

test("subscribing twice against one monitor does not double-register", () => {
  // The old code sat inside a function called once per aborted hotkey
  // capture: N aborts meant N shortcut re-registrations per wake.
  const monitor = fakeMonitor();
  const noop = () => { };
  const first = subscribePowerEvents(monitor, { reclaimShortcuts: noop, releaseWarmCapture: noop });
  const second = subscribePowerEvents(monitor, { reclaimShortcuts: noop, releaseWarmCapture: noop });

  assert.equal(first.alreadySubscribed, false);
  assert.deepEqual(first.registered, [...POWER_EVENTS]);
  assert.equal(second.alreadySubscribed, true);
  assert.deepEqual(second.registered, []);
  for (const event of POWER_EVENTS) assert.equal(monitor.countFor(event), 1);
  _resetPowerEventSubscriptions(monitor);
});

test("a throwing handler is logged, not propagated out of the OS callback", () => {
  const monitor = fakeMonitor();
  const lines = [];
  subscribePowerEvents(monitor, {
    reclaimShortcuts: () => { throw new Error("no accelerator available"); },
    releaseWarmCapture: () => { },
    log: (line) => lines.push(line),
  });

  assert.doesNotThrow(() => monitor.emit("resume"));
  assert.ok(
    lines.some((l) => l.includes("resume handler failed") && l.includes("no accelerator available")),
    `failure must be logged, got ${JSON.stringify(lines)}`,
  );
  _resetPowerEventSubscriptions(monitor);
});

test("a monitor without .on(), or missing handlers, is refused loudly", () => {
  assert.throws(() => subscribePowerEvents(null, {}), TypeError);
  assert.throws(() => subscribePowerEvents({}, {}), TypeError);
  assert.throws(
    () => subscribePowerEvents(fakeMonitor(), { reclaimShortcuts: () => { } }),
    TypeError,
  );
});


test("shutdown ends the session through its own handler, and only that one", () => {
  assert.equal(powerEventAction("shutdown"), POWER_ACTIONS.END_SESSION);
  const monitor = fakeMonitor();
  const calls = [];
  subscribePowerEvents(monitor, {
    reclaimShortcuts: () => calls.push("reclaim"),
    releaseWarmCapture: () => calls.push("release"),
    endSession: (event) => calls.push(`end:${event}`),
  });
  monitor.emit("shutdown");
  assert.deepEqual(calls, ["end:shutdown"]);
});
