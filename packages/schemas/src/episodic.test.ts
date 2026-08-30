import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, EpisodicMemory } from "./episodic.js";

describe("EMBEDDING_DIMENSIONS", () => {
  it("is the width text-embedding-3-small returns and the pgvector column declares", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });
});

describe("EpisodicMemory", () => {
  const valid = {
    campaignId: "c1",
    sequence: 12,
    kind: "encounter" as const,
    refId: "goblin-ambush",
    summaryEnglish: "The party drove off the goblins at the weir.",
    day: 3,
  };

  it("accepts a well-formed record", () => {
    expect(EpisodicMemory.parse(valid)).toEqual(valid);
  });

  it("accepts the quest_node kind", () => {
    expect(EpisodicMemory.parse({ ...valid, kind: "quest_node" }).kind).toBe("quest_node");
  });

  it("rejects an unknown kind", () => {
    expect(EpisodicMemory.safeParse({ ...valid, kind: "conversation" }).success).toBe(false);
  });

  it("rejects an empty summary — a memory with no text is not retrievable", () => {
    expect(EpisodicMemory.safeParse({ ...valid, summaryEnglish: "" }).success).toBe(false);
  });

  it("rejects a negative sequence", () => {
    expect(EpisodicMemory.safeParse({ ...valid, sequence: -1 }).success).toBe(false);
  });
});
