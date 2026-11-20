import { describe, expect, it } from "vitest";
import {
  LIVE_DRAFT_SCHEMA_VERSION,
  LiveDraftOperationQueue,
  parsePersistedLiveDraftPayload,
  recoveredDraftProvider,
  type LiveDraftQueueDeps,
  type PersistedLiveDraft,
} from "../src/live-draft";

function draft(text: string, extra: Partial<PersistedLiveDraft> = {}): PersistedLiveDraft {
  return { schema_version: LIVE_DRAFT_SCHEMA_VERSION, session_id: "s1", source_text: text, ...extra };
}

function harness(overrides: Partial<LiveDraftQueueDeps> = {}) {
  const calls: string[] = [];
  const events: string[] = [];
  const deps: LiveDraftQueueDeps = {
    put: async (p) => { calls.push(`put:${p.source_text}`); },
    clear: async (t) => { calls.push(`clear:${t}`); },
    sleep: async (ms) => { calls.push(`sleep:${ms}`); },
    clearRetryDelaysMs: [10, 20],
    onPutUnavailable: () => { events.push("put-unavailable"); },
    onClearAbandoned: () => { events.push("clear-abandoned"); },
    ...overrides,
  };
  return { queue: new LiveDraftOperationQueue(deps), calls, events };
}

describe("LiveDraftOperationQueue — clear (FG-03)", () => {
  it("retries a failed clear instead of dropping it", async () => {
    let failures = 2;
    const { queue, calls, events } = harness({
      clear: async (t) => {
        calls.push(`clear:${t}`);
        if (failures-- > 0) throw new Error("HTTP 503");
      },
    });
    await queue.enqueue({ kind: "clear", sessionToken: "s1" });
    expect(calls).toEqual(["clear:s1", "sleep:10", "clear:s1", "sleep:20", "clear:s1"]);
    expect(events).toEqual([]);
  });

  it("reports a clear that failed every retry, once, and moves on", async () => {
    const { queue, calls, events } = harness({
      clear: async (t) => { calls.push(`clear:${t}`); throw new Error("reset"); },
    });
    await queue.enqueue({ kind: "clear", sessionToken: "s1" });
    expect(calls.filter((c) => c.startsWith("clear")).length).toBe(3);
    expect(events).toEqual(["clear-abandoned"]);
    expect(queue.pending).toBe(0);
  });

  it("keeps put → clear order while a clear is being retried", async () => {
    let failures = 1;
    const { queue, calls } = harness({
      clear: async (t) => {
        calls.push(`clear:${t}`);
        if (failures-- > 0) throw new Error("HTTP 429");
      },
    });
    void queue.enqueue({ kind: "clear", sessionToken: "s1" });
    await queue.enqueue({ kind: "put", payload: draft("next session") });
    expect(calls).toEqual(["clear:s1", "sleep:10", "clear:s1", "put:next session"]);
  });
});

describe("LiveDraftOperationQueue — put (FG-03, FG-07)", () => {
  it("reports the first put failure of a streak, not every tick", async () => {
    let fail = true;
    const { queue, events } = harness({
      put: async () => { if (fail) throw new Error("Failed to fetch"); },
    });
    await queue.enqueue({ kind: "put", payload: draft("a") });
    await queue.enqueue({ kind: "put", payload: draft("ab") });
    expect(events).toEqual(["put-unavailable"]);
    fail = false;
    await queue.enqueue({ kind: "put", payload: draft("abc") });
    fail = true;
    await queue.enqueue({ kind: "put", payload: draft("abcd") });
    expect(events).toEqual(["put-unavailable", "put-unavailable"]);
  });

  it("does not resend a draft whose content did not change (only the clock moved)", async () => {
    const { queue, calls } = harness();
    await queue.enqueue({ kind: "put", payload: draft("hello", { timer: "00:01", updated_at: 1 }) });
    await queue.enqueue({ kind: "put", payload: draft("hello", { timer: "00:02", updated_at: 2 }) });
    await queue.enqueue({ kind: "put", payload: draft("hello world", { timer: "00:03", updated_at: 3 }) });
    expect(calls).toEqual(["put:hello", "put:hello world"]);
  });

  it("resends the same content after a clear emptied the backend slot", async () => {
    const { queue, calls } = harness();
    await queue.enqueue({ kind: "put", payload: draft("hello") });
    await queue.enqueue({ kind: "clear", sessionToken: "s1" });
    await queue.enqueue({ kind: "put", payload: draft("hello") });
    expect(calls).toEqual(["put:hello", "clear:s1", "put:hello"]);
  });

  it("resends content whose previous put failed", async () => {
    let fail = true;
    const { queue, calls } = harness({
      put: async (p) => { calls.push(`put:${p.source_text}`); if (fail) throw new Error("x"); },
    });
    await queue.enqueue({ kind: "put", payload: draft("hello") });
    fail = false;
    await queue.enqueue({ kind: "put", payload: draft("hello") });
    expect(calls).toEqual(["put:hello", "put:hello"]);
  });
});

describe("parsePersistedLiveDraftPayload (FG-05)", () => {
  it("resolves a pre-provider (legacy) draft to local, and keeps that through a migration", () => {
    const legacy = parsePersistedLiveDraftPayload({ session_id: "s", source_text: "t" })!;
    expect(recoveredDraftProvider(legacy)).toBe("local");
    // The backend echoes every key it knows, so the migrated draft comes
    // back WITH a provider key; it must still say local.
    const roundTripped = parsePersistedLiveDraftPayload({ ...legacy })!;
    expect(recoveredDraftProvider(roundTripped)).toBe("local");
  });

  it("keeps an explicit provider and maps an explicit empty one to none", () => {
    expect(recoveredDraftProvider(parsePersistedLiveDraftPayload({ provider: "deepgram" })!)).toBe("deepgram");
    expect(recoveredDraftProvider(parsePersistedLiveDraftPayload({ provider: "" })!)).toBe("none");
  });

  it("refuses a draft from a newer schema", () => {
    const warnings: string[] = [];
    expect(parsePersistedLiveDraftPayload({ schema_version: 99 }, (m) => warnings.push(m))).toBeNull();
    expect(warnings.length).toBe(1);
  });
});
