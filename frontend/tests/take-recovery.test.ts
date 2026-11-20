import { describe, expect, it } from "vitest";

import { LIVE_DRAFT_SCHEMA_VERSION, type PersistedLiveDraft } from "../src/live-draft";
import { annotateTranscript, parseScreenManifest, screenMarksFromManifest } from "../src/screen-annotations";
import {
  draftSpokenText,
  parsePromotedTake,
  planTakeRecovery,
  recoveredTakeTranscript,
  type PromotedTake,
} from "../src/take-recovery";

const SID = "c0ffee00-0000-4000-8000-000000000001";
const START = 1_795_165_500_000;
const SHOT = "/rec/Screen Sessions/Recovered.screens/shot-01.png";

/** What the promote endpoint answers for a screen take the app died in:
 *  the backend wrote ``endedAt`` from the spool (the take never stopped). */
const screenPromoteAnswer = {
  ok: true,
  name: "Recovered 2026-11-20.txt",
  archive_dir: "/rec/Screen Sessions",
  screens: {
    version: 1,
    id: "screen-20261120-100000-000",
    dir: "/rec/Screen Sessions/Recovered.screens",
    startedAt: START,
    audioStartedAt: START,
    endedAt: START + 20_000,
    events: [
      { type: "stroke", at: START + 5_000, shot: 1, xPct: 74, yPct: 53 },
      { type: "shot", at: START + 15_000, shot: 1, files: [SHOT] },
    ],
  },
  screens_error: "",
  title: "Recovered 2026-11-20 10:00:00",
  source_text: "[Recovered live audio capture]",
  transcript_text: "",
  provider: "local",
  model: "nova-3",
  language: "auto",
};

function draft(over: Partial<PersistedLiveDraft> = {}): PersistedLiveDraft {
  return {
    schema_version: LIVE_DRAFT_SCHEMA_VERSION,
    session_id: SID,
    title: "Recording 20.11.2026",
    source_text: "вот тут кнопка съехала и вот здесь тоже",
    transcript_text: "",
    provider: "deepgram",
    model: "nova-3",
    language: "ru",
    recording_collection: "screen",
    ...over,
  };
}

const screenTake = parsePromotedTake(SID, screenPromoteAnswer) as PromotedTake;

describe("parsePromotedTake", () => {
  it("reads the entry, its archived manifest and the fields the promotion wrote", () => {
    expect(screenTake.name).toBe("Recovered 2026-11-20.txt");
    expect(screenTake.archiveDir).toBe("/rec/Screen Sessions");
    expect(screenTake.screens?.endedAt).toBe(START + 20_000);
    expect(screenTake.sourceText).toBe("[Recovered live audio capture]");
    expect(screenTake.model).toBe("nova-3");
  });

  it("an answer that names no entry is no take", () => {
    expect(parsePromotedTake(SID, { ok: true })).toBeNull();
    expect(parsePromotedTake("", screenPromoteAnswer)).toBeNull();
    expect(parsePromotedTake(SID, null)).toBeNull();
  });
});

describe("recoveredTakeTranscript", () => {
  it("places the marks by the one composer, in the take's own time frame", () => {
    const spoken = "вот тут кнопка съехала и вот здесь тоже";
    const marks = screenMarksFromManifest(screenTake.screens!);
    expect(recoveredTakeTranscript(spoken, screenTake.screens)).toBe(
      annotateTranscript(spoken, marks, { durationMs: 20_000 }),
    );
    // 5 s of 20 s → a quarter in; 15 s → three quarters in. Not all at the end.
    const out = recoveredTakeTranscript(spoken, screenTake.screens);
    expect(out.indexOf("[✏️")).toBeLessThan(out.indexOf("съехала"));
    expect(out.indexOf("[📸")).toBeLessThan(out.indexOf("тоже"));
  });

  it("a voice take's transcript is its words", () => {
    expect(recoveredTakeTranscript("  hello  ", null)).toBe("hello");
  });
});

describe("planTakeRecovery — after a crash mid-take", () => {
  it("screen take: the draft's live text and the marks go into the promoted entry, beside its audio and screenshots", () => {
    const plan = planTakeRecovery(draft(), [screenTake]);
    expect(plan.draftAlone).toBe(false);
    expect(plan.draftInWrites).toBe(true);
    expect(plan.writes).toHaveLength(1);
    const [w] = plan.writes;
    expect(w.name).toBe(screenTake.name);
    expect(w.archiveDir).toBe(screenTake.archiveDir);
    expect(w.transcriptText).toContain("кнопка");
    expect(w.transcriptText).toContain("[✏️ 00:05 линия справа (74%, 53%) → скрин 1]");
    expect(w.transcriptText).toContain(`[📸 00:15 скрин 1: ${SHOT}]`);
    expect(w.sourceText).toBe("вот тут кнопка съехала и вот здесь тоже");
    // The draft knows what the take was recorded with; the promotion does not.
    expect(w.provider).toBe("deepgram");
    expect(w.language).toBe("ru");
    expect(w.title.endsWith("(Recovered)")).toBe(true);
    expect(plan.shown).toBe(w);
  });

  it("voice take: the draft's text goes into the promoted entry instead of a second, text-only one", () => {
    const voiceTake = parsePromotedTake(SID, { ...screenPromoteAnswer, screens: null }) as PromotedTake;
    const plan = planTakeRecovery(draft({ recording_collection: "live" }), [voiceTake]);
    expect(plan.draftAlone).toBe(false);
    expect(plan.writes.map((w) => w.transcriptText)).toEqual(["вот тут кнопка съехала и вот здесь тоже"]);
  });

  it("a screen take drawn without speaking keeps its marks alone", () => {
    const plan = planTakeRecovery(draft({ source_text: "" }), [screenTake]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].transcriptText.split("\n")).toHaveLength(2);
    expect(plan.writes[0].title).toBe(screenTake.title);
    expect(plan.writes[0].sourceText).toBe(screenTake.sourceText);
  });

  it("a promoted screen take with no draft (the autosave never reached the backend) still gets its marks", () => {
    const plan = planTakeRecovery(null, [screenTake]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].fromDraft).toBe(false);
    expect(plan.writes[0].transcriptText).toContain(SHOT);
    expect(plan.writes[0].provider).toBe("local");
    expect(plan.shown).toBe(plan.writes[0]);
  });

  it("a draft whose take has no promoted entry is saved on its own, as before", () => {
    const other = { ...screenTake, sessionId: "another-session" };
    const plan = planTakeRecovery(draft(), [other]);
    expect(plan.draftAlone).toBe(true);
    expect(plan.draftInWrites).toBe(false);
    // The other take still gets its marks, but the panel shows the draft.
    expect(plan.writes.map((w) => w.fromDraft)).toEqual([false]);
    expect(plan.shown).toBeNull();
  });

  it("an empty draft and a voice take with nothing to add write nothing", () => {
    const voiceTake = { ...screenTake, screens: null };
    const plan = planTakeRecovery(draft({ source_text: "" }), [voiceTake]);
    expect(plan).toEqual({ writes: [], draftAlone: false, draftInWrites: false, shown: null });
  });

  it("the draft's words are its transcript when it has one, else its live text", () => {
    expect(draftSpokenText(draft({ transcript_text: "final" }))).toBe("final");
    expect(draftSpokenText(draft())).toBe("вот тут кнопка съехала и вот здесь тоже");
    expect(draftSpokenText(null)).toBe("");
  });

  it("parses the archived manifest the same way the transcript composer does", () => {
    expect(screenTake.screens).toEqual(parseScreenManifest(screenPromoteAnswer.screens));
  });
});
