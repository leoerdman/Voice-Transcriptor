import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  RECORDING_COLLECTIONS,
  VOICE_TAKE,
  liveRecordingCollection,
  liveTakeAfterVoiceTakeNotice,
  liveTakeFromRequest,
  recordingCollectionFromDraft,
  recoveryPromoteBody,
} from "../src/take-collection";

const SID = "screen-20261120-100000-000";

describe("liveTakeFromRequest", () => {
  it("is a screen take only with a screen session id", () => {
    expect(liveTakeFromRequest({ mode: "screen", screenSessionId: SID })).toEqual({ mode: "screen", screenSessionId: SID });
    expect(liveTakeFromRequest({ mode: "screen" })).toEqual(VOICE_TAKE);
    expect(liveTakeFromRequest({ mode: "voice", screenSessionId: SID })).toEqual(VOICE_TAKE);
    expect(liveTakeFromRequest()).toEqual(VOICE_TAKE);
  });
});

describe("liveTakeAfterVoiceTakeNotice (S-04)", () => {
  it("makes the screen take it names a voice take, filed under Live", () => {
    const take = liveTakeAfterVoiceTakeNotice({ mode: "screen", screenSessionId: SID }, SID);
    expect(take).toEqual(VOICE_TAKE);
    expect(liveRecordingCollection(take.mode)).toBe(RECORDING_COLLECTIONS.live);
  });

  it("leaves any other take alone: a newer screen take, a voice take, an empty id", () => {
    const newer = { mode: "screen" as const, screenSessionId: "screen-20261120-100500-000" };
    expect(liveTakeAfterVoiceTakeNotice(newer, SID)).toBe(newer);
    expect(liveTakeAfterVoiceTakeNotice(VOICE_TAKE, SID)).toBe(VOICE_TAKE);
    const live = { mode: "screen" as const, screenSessionId: SID };
    expect(liveTakeAfterVoiceTakeNotice(live, "")).toBe(live);
  });
});

describe("recordingCollectionFromDraft (FL-12)", () => {
  it("recovers a draft into the collection it was written for", () => {
    expect(recordingCollectionFromDraft("screen")).toBe(RECORDING_COLLECTIONS.screen);
    expect(recordingCollectionFromDraft("live")).toBe(RECORDING_COLLECTIONS.live);
  });

  it("files an old or unknown draft under Live, as every draft was until now", () => {
    expect(recordingCollectionFromDraft(undefined)).toBe(RECORDING_COLLECTIONS.live);
    expect(recordingCollectionFromDraft("")).toBe(RECORDING_COLLECTIONS.live);
    expect(recordingCollectionFromDraft("../etc")).toBe(RECORDING_COLLECTIONS.live);
    expect(recordingCollectionFromDraft(42)).toBe(RECORDING_COLLECTIONS.live);
  });
});

describe("recoveryPromoteBody (FL-12 / S-01)", () => {
  it("never names a collection: the recovery sidecar decides", () => {
    expect(recoveryPromoteBody("/rec")).toEqual({ archive_dir: "/rec" });
    expect(recoveryPromoteBody("")).toEqual({});
    expect("recording_collection" in recoveryPromoteBody("/rec")).toBe(false);
  });
});

// Wiring: main.tsx is not importable in a test, so its source is read —
// only for which helper each path calls (the decisions are tested above).
describe("main.tsx files every take through ./take-collection", () => {
  const mainTsx = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");

  it("no draft or promotion path sends the Live literal any more (FL-12)", () => {
    expect(mainTsx).toContain("recording_collection: liveRecordingCollection(liveRecordingMode),\n  };");
    expect(mainTsx).toContain("recordingCollection: recordingCollectionFromDraft(draft.recording_collection)");
    expect(mainTsx).toContain("body: JSON.stringify(recoveryPromoteBody(archiveDir))");
    expect(mainTsx).not.toMatch(/recording_collection: RECORDING_COLLECTIONS\.live/);
    expect(mainTsx).not.toMatch(/recordingCollection: RECORDING_COLLECTIONS\.live/);
  });

  it("the live socket names the take's screen session (S-01)", () => {
    expect(mainTsx).toContain('wsQuery.set("screen_session_id", liveScreenSessionId)');
  });

  it("the voice-take notice is subscribed once per page, retiring a prior listener (S-04)", () => {
    const body = /function subscribeToScreenVoiceTake\(\): void \{([\s\S]*?)\n\}/.exec(mainTsx)?.[1] || "";
    expect(body.indexOf("screenVoiceTakeUnsubscribe?.();")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("screenVoiceTakeUnsubscribe = window.transcriptor?.onScreenVoiceTake")).toBeGreaterThan(
      body.indexOf("screenVoiceTakeUnsubscribe?.();"),
    );
    expect(body).toContain("liveTakeAfterVoiceTakeNotice(");
    expect(mainTsx).toMatch(/\nsubscribeToScreenVoiceTake\(\);/);
  });
});
