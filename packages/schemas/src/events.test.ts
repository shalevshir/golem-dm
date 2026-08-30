import { describe, expect, it } from "vitest";
import {
  CampaignStartedPayload,
  CheckRolledPayload,
  EncounterResolvedPayload,
  EncounterStartedPayload,
  IntentClassifiedPayload,
  NarrativeEmittedPayload,
  QuestNodeCompletedPayload,
  QuestNodeEnteredPayload,
  WorldDeltaAppliedPayload,
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

  it("accepts the full genesis quartet alongside rootSeed", () => {
    const parsed = CampaignStartedPayload.parse({
      rootSeed: 1,
      worldId: "riverbend",
      startingNodeId: "find-the-trail",
      startingDay: 1,
      characterId: "hero",
    });
    expect(parsed).toMatchObject({ worldId: "riverbend", characterId: "hero" });
  });

  it("rejects a partial quartet — worldId with no characterId — with the all-or-none message", () => {
    const result = CampaignStartedPayload.safeParse({
      rootSeed: 1,
      worldId: "riverbend",
      startingNodeId: "find-the-trail",
      startingDay: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("scene genesis fields are all-or-none");
    }
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

describe("the scene event payloads (§4.7 step 4)", () => {
  it("accepts a well-formed quest_node_entered payload", () => {
    expect(QuestNodeEnteredPayload.parse({ nodeId: "cross-the-bridge" }).nodeId).toBe(
      "cross-the-bridge",
    );
  });

  it("rejects a quest_node_entered payload with no nodeId", () => {
    expect(() => QuestNodeEnteredPayload.parse({})).toThrow();
  });

  it("accepts a well-formed quest_node_completed payload", () => {
    expect(QuestNodeCompletedPayload.parse({ nodeId: "find-the-trail" }).nodeId).toBe(
      "find-the-trail",
    );
  });

  it("rejects a quest_node_completed payload with no nodeId", () => {
    expect(() => QuestNodeCompletedPayload.parse({})).toThrow();
  });

  it("accepts a world_delta_applied payload with relations and day", () => {
    const parsed = WorldDeltaAppliedPayload.parse({
      relations: [{ factionA: "millers", factionB: "raiders", band: "hostile" }],
      day: 2,
    });
    expect(parsed.relations).toEqual([
      { factionA: "millers", factionB: "raiders", band: "hostile" },
    ]);
    expect(parsed.day).toBe(2);
  });

  it("accepts an empty world_delta_applied payload, defaulting relations and npcAffinities to []", () => {
    expect(WorldDeltaAppliedPayload.parse({})).toEqual({ relations: [], npcAffinities: [] });
  });

  it("accepts a world_delta_applied payload with npcAffinities", () => {
    const parsed = WorldDeltaAppliedPayload.parse({
      npcAffinities: [
        { npcId: "sela-the-innkeeper", band: "cordial", facts: ["helped broker the reckoning"] },
      ],
    });
    expect(parsed.npcAffinities).toEqual([
      { npcId: "sela-the-innkeeper", band: "cordial", facts: ["helped broker the reckoning"] },
    ]);
  });

  it("rejects a world_delta_applied payload with a non-integer day", () => {
    expect(() => WorldDeltaAppliedPayload.parse({ day: 1.5 })).toThrow();
  });

  it("rejects a world_delta_applied relation entry with an unrecognised band", () => {
    expect(() =>
      WorldDeltaAppliedPayload.parse({
        relations: [{ factionA: "millers", factionB: "raiders", band: "furious" }],
      }),
    ).toThrow();
  });

  const validCheckRolled = {
    actorId: "hero",
    ability: "dex",
    skill: "stealth",
    difficulty: "medium",
    dc: 13,
    naturalRoll: 15,
    rolls: [15],
    modifier: 3,
    total: 18,
    success: true,
    seed: 42,
  };

  it("accepts a well-formed check_rolled payload", () => {
    expect(CheckRolledPayload.parse(validCheckRolled).success).toBe(true);
  });

  it("rejects a check_rolled payload with an out-of-range naturalRoll", () => {
    expect(() =>
      CheckRolledPayload.parse({ ...validCheckRolled, naturalRoll: 21 }),
    ).toThrow();
  });

  it("rejects a check_rolled payload with an unrecognised ability", () => {
    expect(() => CheckRolledPayload.parse({ ...validCheckRolled, ability: "luck" })).toThrow();
  });

  const validIntentClassified = {
    clientMessageId: "c1",
    actorId: "hero",
    classification: { category: "exploration", targetNodeId: null },
    provider: "anthropic",
    modelId: "claude-x",
    promptVersion: "2026-08-28.1",
  };

  it("accepts a well-formed intent_classified payload", () => {
    expect(IntentClassifiedPayload.parse(validIntentClassified).classification).toEqual({
      category: "exploration",
      targetNodeId: null,
    });
  });

  it("rejects an intent_classified payload with a malformed classification", () => {
    expect(() =>
      IntentClassifiedPayload.parse({
        ...validIntentClassified,
        classification: { category: "guess" },
      }),
    ).toThrow();
  });
});

describe("EncounterStartedPayload", () => {
  it("accepts a legacy payload carrying only encounterId", () => {
    const parsed = EncounterStartedPayload.parse({ encounterId: "goblin-ambush" });
    expect(parsed.grid).toBeUndefined();
    expect(parsed.combatants).toBeUndefined();
    expect(parsed.turnOrder).toBeUndefined();
  });

  it("refuses a half-declared board", () => {
    expect(() =>
      EncounterStartedPayload.parse({
        encounterId: "goblin-ambush",
        grid: { width: 1, height: 1, tiles: [["normal"]] },
      }),
    ).toThrow();
  });
});

describe("summaryEnglish on the closing payloads", () => {
  it("accepts an encounter_resolved payload carrying a summary", () => {
    const parsed = EncounterResolvedPayload.parse({
      encounterId: "e1",
      outcome: "victory",
      survivorIds: ["pc1"],
      summaryEnglish: "The party won.",
    });
    expect(parsed.summaryEnglish).toBe("The party won.");
  });

  it("still accepts an encounter_resolved payload written before summaries existed", () => {
    const parsed = EncounterResolvedPayload.parse({
      encounterId: "e1",
      outcome: "victory",
      survivorIds: ["pc1"],
    });
    expect(parsed.summaryEnglish).toBeUndefined();
  });

  it("accepts a quest_node_completed payload with and without a summary", () => {
    expect(QuestNodeCompletedPayload.parse({ nodeId: "n1" }).summaryEnglish).toBeUndefined();
    expect(
      QuestNodeCompletedPayload.parse({ nodeId: "n1", summaryEnglish: "Tobin talked." })
        .summaryEnglish,
    ).toBe("Tobin talked.");
  });

  it("rejects an empty summary rather than storing a blank memory", () => {
    expect(
      QuestNodeCompletedPayload.safeParse({ nodeId: "n1", summaryEnglish: "" }).success,
    ).toBe(false);
  });
});
