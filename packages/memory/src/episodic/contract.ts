// The shared contract both episodic stores answer to, mirroring
// `event-store/contract.ts`. A behaviour only one implementation has is a
// bug in this file, not a feature of that implementation.
//
// Every vector here is hand-built and unit-length so the expected cosine
// ordering is arithmetic a reader can check, not a property of an embedding
// model.
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import type { EpisodicMemory } from "@ai-dm/schemas";
import type { EpisodicStore } from "./port.js";

/** A unit vector pointing along one axis — trivially orthogonal to the others. */
export function axisVector(axis: number): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  vector[axis] = 1;
  return vector;
}

function memory(overrides: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    campaignId: "c1",
    sequence: 1,
    kind: "quest_node",
    refId: "weir",
    summaryEnglish: "Tobin let the party pass.",
    day: 1,
    ...overrides,
  };
}

export function runEpisodicStoreContract(
  name: string,
  makeStore: () => Promise<EpisodicStore> | EpisodicStore,
): void {
  describe(`EpisodicStore contract: ${name}`, () => {
    it("returns nothing for a campaign with no memories", async () => {
      const store = await makeStore();
      expect(await store.search("c1", axisVector(0), 3)).toEqual([]);
    });

    it("returns a written memory whose text survives the round trip", async () => {
      const store = await makeStore();
      await store.write(memory(), axisVector(0));

      const hits = await store.search("c1", axisVector(0), 3);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.memory).toEqual(memory());
    });

    it("orders hits by similarity, nearest first", async () => {
      const store = await makeStore();
      await store.write(memory({ sequence: 1, refId: "near" }), axisVector(0));
      await store.write(memory({ sequence: 2, refId: "far" }), axisVector(1));

      const hits = await store.search("c1", axisVector(0), 3);
      expect(hits.map((hit) => hit.memory.refId)).toEqual(["near", "far"]);
    });

    it("honours the limit", async () => {
      const store = await makeStore();
      await store.write(memory({ sequence: 1 }), axisVector(0));
      await store.write(memory({ sequence: 2 }), axisVector(1));
      await store.write(memory({ sequence: 3 }), axisVector(2));

      expect(await store.search("c1", axisVector(0), 2)).toHaveLength(2);
    });

    it("never leaks another campaign's memories", async () => {
      const store = await makeStore();
      await store.write(memory({ campaignId: "c1", refId: "mine" }), axisVector(0));
      await store.write(memory({ campaignId: "c2", refId: "theirs" }), axisVector(0));

      const hits = await store.search("c1", axisVector(0), 5);
      expect(hits.map((hit) => hit.memory.refId)).toEqual(["mine"]);
    });

    it("is idempotent on (campaignId, sequence) so a reindex is a no-op", async () => {
      const store = await makeStore();
      await store.write(memory({ sequence: 7 }), axisVector(0));
      await store.write(memory({ sequence: 7 }), axisVector(0));

      expect(await store.search("c1", axisVector(0), 5)).toHaveLength(1);
    });

    it("scores an exact match at 1 and an orthogonal one at 0", async () => {
      const store = await makeStore();
      await store.write(memory({ sequence: 1, refId: "same" }), axisVector(0));
      await store.write(memory({ sequence: 2, refId: "orthogonal" }), axisVector(1));

      const hits = await store.search("c1", axisVector(0), 5);
      expect(hits[0]?.score).toBeCloseTo(1, 5);
      expect(hits[1]?.score).toBeCloseTo(0, 5);
    });

    it("returns a limit of zero as an empty list rather than everything", async () => {
      const store = await makeStore();
      await store.write(memory(), axisVector(0));
      expect(await store.search("c1", axisVector(0), 0)).toEqual([]);
    });
  });
}
