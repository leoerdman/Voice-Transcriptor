"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBackendServing, loadWhenServing, BACKEND_SERVING_STATES } = require("./backend-serving");
const { mainSource } = require("./main-source");

const tick = () => new Promise((r) => setImmediate(r));

test("starts as starting; waiters are released by the first healthy answer", async () => {
  const s = createBackendServing();
  assert.equal(s.state(), BACKEND_SERVING_STATES.starting);
  let done = false;
  s.whenServing().then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  s.markServing();
  await tick();
  assert.equal(done, true);
});

test("serving answers at once; down waits for the restart", async () => {
  const s = createBackendServing();
  s.markServing();
  await s.whenServing();
  s.markDown();
  let done = false;
  s.whenServing().then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  s.markServing();
  await tick();
  assert.equal(done, true);
});

test("failed rejects waiters and later callers until the backend serves again", async () => {
  const s = createBackendServing();
  s.markDown();
  const waiting = s.whenServing();
  s.markFailed("gave up after 8 restarts");
  await assert.rejects(waiting, /gave up after 8 restarts/);
  await assert.rejects(s.whenServing(), /gave up/);
  s.markServing();
  await s.whenServing();
});

test("main.js moves the state on the facts it observes", () => {
  assert.match(mainSource, /backend = null;\s*backendServing\.markDown\(\);/);
  assert.match(mainSource, /broadcastBackendBootError\(\);\s*backendServing\.markFailed\(/);
  const healthy = mainSource.match(/await waitForBackendHealth\([^)]*\);\s*backendServing\.markServing\(\);/g) || [];
  assert.equal(healthy.length, 4, "cold start, restart, the failure page's recovery and a restore's confirmation all mark serving");
});

function refused() {
  return Object.assign(new Error("ERR_CONNECTION_REFUSED (-102)"), { code: "ERR_CONNECTION_REFUSED" });
}

test("loadWhenServing: a load that hits a backend dying unseen is checked and run again", async () => {
  const s = createBackendServing();
  s.markServing(); // the exit has not been observed yet
  const calls = [];
  await loadWhenServing({
    serving: s,
    load: async () => {
      calls.push("load");
      if (calls.filter((c) => c === "load").length === 1) throw refused();
    },
    confirmServing: async () => { calls.push("confirm"); },
  });
  assert.deepEqual(calls, ["load", "confirm", "load"]);
});

test("loadWhenServing: a backend that does not answer ends the attempt", async () => {
  const s = createBackendServing();
  s.markServing();
  let loads = 0;
  await assert.rejects(loadWhenServing({
    serving: s,
    load: async () => { loads += 1; throw refused(); },
    confirmServing: async () => { throw new Error("Backend did not start in time"); },
  }), /did not start in time/);
  assert.equal(loads, 1);
});

test("loadWhenServing: ERR_ABORTED (a newer navigation) is not retried; loads are bounded", async () => {
  const s = createBackendServing();
  s.markServing();
  let loads = 0;
  await assert.rejects(loadWhenServing({
    serving: s,
    load: async () => { loads += 1; throw Object.assign(new Error("aborted"), { code: "ERR_ABORTED" }); },
    confirmServing: async () => { },
  }), /aborted/);
  assert.equal(loads, 1);
  loads = 0;
  await assert.rejects(loadWhenServing({
    serving: s,
    load: async () => { loads += 1; throw refused(); },
    confirmServing: async () => { },
    maxLoads: 3,
  }), /REFUSED/);
  assert.equal(loads, 3);
});
