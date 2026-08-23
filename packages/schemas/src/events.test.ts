import { describe, expect, it } from "vitest";
import {
  CampaignStartedPayload,
  EncounterResolvedPayload,
  EncounterStartedPayload,
  NarrativeEmittedPayload,
} from "./events.js";

describe("NarrativeEmittedPayload", () => {
  const valid = {
    actorId: "hero",
    streamId: "s-1",
    text: "אלדד מתקדם.",
    source: "model",
    promptVersion: "2026-08-21.1",
  };

  it("accepts a well-formed payload", () => {
    expect(NarrativeEmittedPayload.parse(valid).source).toBe("model");
  });

  it("rejects a source outside the three the pipeline can produce", () => {
    expect(() => NarrativeEmittedPayload.parse({ ...valid, source: "guess" })).toThrow();
  });

  it("rejects empty narration text", () => {
    expect(() => NarrativeEmittedPayload.parse({ ...valid, text: "" })).toThrow();
  });
});

describe("the campaign lifecycle payloads", () => {
  it("accepts a well-formed campaign_started payload", () => {
    expect(CampaignStartedPayload.parse({ rootSeed: 42 }).rootSeed).toBe(42);
  });

  it("rejects a non-integer root seed", () => {
    expect(() => CampaignStartedPayload.parse({ rootSeed: 1.5 })).toThrow();
  });

  it("accepts a well-formed encounter_started payload", () => {
    expect(EncounterStartedPayload.parse({ encounterId: "goblin-ambush" }).encounterId).toBe(
      "goblin-ambush",
    );
  });

  it("rejects an encounter_started payload with no encounter named", () => {
    expect(() => EncounterStartedPayload.parse({})).toThrow();
  });

  it("accepts a well-formed encounter_resolved payload", () => {
    const parsed = EncounterResolvedPayload.parse({
      encounterId: "goblin-ambush",
      outcome: "victory",
      survivorIds: ["hero"],
    });
    expect(parsed.survivorIds).toStrictEqual(["hero"]);
  });

  // The open-string decision, asserted rather than left to the comment: an
  // outcome this codebase has never produced must parse, because the log
  // outlives every enum we would have written here.
  it("accepts an outcome no code produces yet", () => {
    const parsed = EncounterResolvedPayload.parse({
      encounterId: "goblin-ambush",
      outcome: "negotiated",
      survivorIds: [],
    });
    expect(parsed.outcome).toBe("negotiated");
  });

  it("rejects survivor ids that are not strings", () => {
    expect(() =>
      EncounterResolvedPayload.parse({
        encounterId: "goblin-ambush",
        outcome: "victory",
        survivorIds: [1],
      }),
    ).toThrow();
  });
});
