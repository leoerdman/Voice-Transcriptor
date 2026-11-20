import { describe, expect, it } from "vitest";
import {
  parseRecordingSaveResponse,
  planRecordingSave,
  recordingSaveFormEntries,
  type RecordingSaveInput,
} from "../src/recording-save";

function input(extra: Partial<RecordingSaveInput> = {}): RecordingSaveInput {
  return {
    hasAudioFile: false,
    audioSourcePath: "",
    consumeAudioSourcePath: false,
    existingName: "",
    archiveDir: "",
    recordingCollection: "",
    requireExisting: false,
    title: "T",
    sourceText: "src",
    transcriptText: "",
    provider: "local",
    model: "small",
    language: "auto",
    ...extra,
  };
}

describe("planRecordingSave (FU-21)", () => {
  it("refuses a screen session on a save without the audio file instead of dropping it", () => {
    expect(() => planRecordingSave(input({ screenSessionId: "scr-1" }))).toThrow(/screen/);
    expect(() => planRecordingSave(input({ audioSourcePath: "/a.wav", screenSessionId: "scr-1" }))).toThrow(/screen/);
  });

  it("attaches the screen session to the multipart save", () => {
    const plan = planRecordingSave(input({ hasAudioFile: true, screenSessionId: "scr-1", screenAudioStartedAt: 1700 }));
    expect(plan.route).toBe("save-with-audio");
    expect(plan.fields.screen_session_id).toBe("scr-1");
    expect(plan.fields.screen_audio_started_at).toBe("1700");
  });

  it("sends the same common fields on every route", () => {
    const common = ["title", "source_text", "transcript_text", "provider", "model", "language"];
    for (const extra of [{}, { audioSourcePath: "/a.wav" }, { hasAudioFile: true }]) {
      const plan = planRecordingSave(input(extra));
      for (const key of common) expect(plan.fields).toHaveProperty(key);
    }
    expect(planRecordingSave(input({ audioSourcePath: "/a.wav", consumeAudioSourcePath: true })).fields)
      .toMatchObject({ source_path: "/a.wav", consume_source_path: true });
  });

  it("keeps the multipart form free of empty optional fields, as before", () => {
    const entries = recordingSaveFormEntries(planRecordingSave(input({ hasAudioFile: true })).fields);
    const keys = entries.map(([k]) => k);
    expect(keys).not.toContain("name");
    expect(keys).not.toContain("require_existing");
    expect(keys).toContain("transcript_text");
    const withAll = recordingSaveFormEntries(
      planRecordingSave(input({ hasAudioFile: true, existingName: "n", requireExisting: true, liveSessionId: "l" })).fields,
    );
    expect(withAll).toContainEqual(["require_existing", "true"]);
    expect(withAll).toContainEqual(["live_session_id", "l"]);
  });
});

describe("parseRecordingSaveResponse (FU-21)", () => {
  it("parses every route's answer the same way", () => {
    expect(parseRecordingSaveResponse({ name: "a.txt", archive_dir: "/x", pruned_audio_count: 2.7, screens: { n: 1 } }, { name: "", archiveDir: "" }))
      .toEqual({ name: "a.txt", archiveDir: "/x", prunedAudioCount: 2, screensManifest: { n: 1 } });
    expect(parseRecordingSaveResponse({ ok: true }, { name: "old", archiveDir: "/d" }))
      .toEqual({ name: "old", archiveDir: "/d", prunedAudioCount: 0 });
  });
});
