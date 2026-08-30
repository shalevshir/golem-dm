import { describe, expect, it } from "vitest";
import { diffScene, sceneStateFrom, snapshotOf } from "./snapshot.js";
import {
  completeCurrentNode,
  pairKey,
  relationBetween,
  splitPairKey,
  startScene,
  traverseEdge,
} from "./index.js";
import type { SceneState, SceneTransition } from "./index.js";
import { linearWorld } from "./test-fixtures.js";
import type { FactionBand, SceneSnapshot } from "@ai-dm/schemas";

/** Sorts a `SceneSnapshot`'s array fields the same way `snapshotOf` promises to emit them. */
function sorted(snapshot: SceneSnapshot): SceneSnapshot {
  return {
    ...snapshot,
    completedNodeIds: [...snapshot.completedNodeIds].sort(),
    relations: [...snapshot.relations].sort(
      (a, b) => a.factionA.localeCompare(b.factionA) || a.factionB.localeCompare(b.factionB),
    ),
    npcAffinities: [...snapshot.npcAffinities].sort((a, b) => a.npcId.localeCompare(b.npcId)),
  };
}

/** The state from a transition, or a loud failure — same pattern as `index.test.ts`. */
function stateOf(transition: SceneTransition): SceneState {
  if (!transition.valid) {
    expect.unreachable(
      `expected a valid transition, got: ${transition.rejections.map((r) => r.reason).join(", ")}`,
    );
  }
  return transition.state;
}

describe("splitPairKey", () => {
  it("inverts pairKey", () => {
    expect(splitPairKey(pairKey("b", "a"))).toEqual(["a", "b"]);
  });
});

describe("round trip: snapshotOf(sceneStateFrom(s))", () => {
  it("preserves an empty overlay", () => {
    const snapshot: SceneSnapshot = {
      worldId: "fixture",
      currentNodeId: "start",
      completedNodeIds: [],
      relations: [],
      npcAffinities: [],
      day: 1,
      heroHp: 10,
    };
    expect(sorted(snapshotOf(sceneStateFrom(snapshot), snapshot.worldId))).toEqual(
      sorted(snapshot),
    );
  });

  it("preserves a multi-pair overlay", () => {
    // Entries in canonical (alphabetical) factionA/factionB order: the
    // round trip normalizes through `pairKey`/`splitPairKey`, which always
    // emits that order, so a flipped-order entry is covered separately below
    // (`sceneStateFrom`'s "order-independent" test) rather than here.
    const snapshot: SceneSnapshot = {
      worldId: "fixture",
      currentNodeId: "middle",
      completedNodeIds: ["start"],
      relations: [
        { factionA: "alpha", factionB: "beta", band: "cold" },
        { factionA: "delta", factionB: "gamma", band: "friendly" },
      ],
      npcAffinities: [],
      day: 3,
      heroHp: 10,
    };
    expect(sorted(snapshotOf(sceneStateFrom(snapshot), snapshot.worldId))).toEqual(
      sorted(snapshot),
    );
  });

  it("preserves a multi-node completed set", () => {
    const snapshot: SceneSnapshot = {
      worldId: "fixture",
      currentNodeId: "end",
      completedNodeIds: ["middle", "start"],
      relations: [{ factionA: "alpha", factionB: "beta", band: "war" }],
      npcAffinities: [],
      day: 4,
      heroHp: 10,
    };
    expect(sorted(snapshotOf(sceneStateFrom(snapshot), snapshot.worldId))).toEqual(
      sorted(snapshot),
    );
  });

  it("preserves a populated npcAffinities overlay", () => {
    const snapshot: SceneSnapshot = {
      worldId: "fixture",
      currentNodeId: "middle",
      completedNodeIds: ["start"],
      relations: [],
      npcAffinities: [
        { npcId: "old-tobin", band: "friendly", facts: ["remembered fact"] },
        { npcId: "sela-the-innkeeper", band: "cordial", facts: [] },
      ],
      day: 3,
      heroHp: 10,
    };
    expect(sorted(snapshotOf(sceneStateFrom(snapshot), snapshot.worldId))).toEqual(
      sorted(snapshot),
    );
  });

  it("snapshotOf emits relations and completedNodeIds already sorted", () => {
    const state: SceneState = {
      currentNodeId: "end",
      completedNodeIds: new Set(["zeta", "alpha"]),
      relations: new Map([
        [pairKey("zulu", "yankee"), "friendly"],
        [pairKey("alpha", "beta"), "cold"],
      ]),
      npcAffinities: new Map(),
      day: 2,
      heroHp: 10,
    };
    const snapshot = snapshotOf(state, "fixture");
    expect(snapshot.completedNodeIds).toEqual(["alpha", "zeta"]);
    expect(snapshot.relations.map((r) => [r.factionA, r.factionB])).toEqual([
      ["alpha", "beta"],
      ["yankee", "zulu"],
    ]);
  });
});

describe("sceneStateFrom", () => {
  // Task 3's fold writes a relations entry with the payload's own field
  // ordering, so a snapshot can hold `{factionA: "raiders", factionB:
  // "millers"}` for the same pair a world declares as `{factionA: "millers",
  // factionB: "raiders"}`. Keying `relations` by `pairKey` rather than
  // positionally is what keeps that one overlay entry instead of splitting it
  // into two — the failure this test would catch.
  it("keys relations by pairKey, order-independent of the snapshot entry", () => {
    const world = {
      ...linearWorld(),
      relations: new Map<string, FactionBand>([[pairKey("millers", "raiders"), "neutral"]]),
    };
    const snapshot: SceneSnapshot = {
      worldId: "fixture",
      currentNodeId: "start",
      completedNodeIds: [],
      relations: [{ factionA: "raiders", factionB: "millers", band: "hostile" }],
      npcAffinities: [],
      day: 1,
      heroHp: 10,
    };
    const state = sceneStateFrom(snapshot);
    expect(relationBetween(world, state, "millers", "raiders")).toBe("hostile");
    expect(relationBetween(world, state, "raiders", "millers")).toBe("hostile");
  });
});

describe("diffScene", () => {
  const world = linearWorld();

  it("reports no change for identical states, with no day", () => {
    const state = stateOf(startScene(world));
    const delta = diffScene(state, state);
    expect(delta).toEqual({ relations: [], npcAffinities: [] });
    expect(delta.day).toBeUndefined();
  });

  it("reports exactly the shifted pair at its post-clamp band", () => {
    const before = stateOf(startScene(world));
    const afterMiddle = stateOf(traverseEdge(world, before, "middle"));
    // Completing "middle" applies its shift_faction_relation effect.
    const after = stateOf(traverseEdge(world, afterMiddle, "end"));
    const delta = diffScene(before, after);
    // linearWorld's `middle` shifts alpha/beta from neutral by -1 -> cold.
    expect(delta.relations).toEqual([{ factionA: "alpha", factionB: "beta", band: "cold" }]);
  });

  it("sets day when only the calendar advances, with no relation change", () => {
    const afterMiddle = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    const before = stateOf(traverseEdge(world, afterMiddle, "end")); // day 3, alpha/beta=cold
    // "end" has only advance_calendar; completing it shifts no relation.
    const after = stateOf(completeCurrentNode(world, before)); // day 4
    expect(diffScene(before, after)).toEqual({ relations: [], npcAffinities: [], day: 4 });
  });

  it("reports both a relation shift and a day advance together", () => {
    const before = stateOf(startScene(world)); // day 1, no overlay
    const afterMiddle = stateOf(traverseEdge(world, before, "middle"));
    const afterEnd = stateOf(traverseEdge(world, afterMiddle, "end"));
    const after = stateOf(completeCurrentNode(world, afterEnd)); // day 4, alpha/beta=cold
    const delta = diffScene(before, after);
    expect(delta.relations).toEqual([{ factionA: "alpha", factionB: "beta", band: "cold" }]);
    expect(delta.day).toBe(4);
  });

  // `linearWorld()`'s "start" node has no edge to a node named "npc-node" —
  // its only edge is to "middle" — so this test overrides a spread copy of
  // "start" to add one, rather than mutating the shared fixture.
  it("reports a shifted npc affinity alongside an unrelated relation change", () => {
    const originalStart = world.questNodes.get("start");
    if (originalStart === undefined) {
      expect.unreachable('fixture is missing its "start" node');
    }
    const npcWorld = {
      ...world,
      npcs: new Map([
        [
          "sela-the-innkeeper",
          {
            npcId: "sela-the-innkeeper",
            nameEnglish: "Sela",
            nameHebrew: "סלה",
            grammaticalGender: "feminine" as const,
            locationId: "here",
            descriptionEnglish: "A fixture npc.",
          },
        ],
      ]),
      questNodes: new Map([
        ...world.questNodes,
        [
          "start",
          {
            ...originalStart,
            edges: [...originalStart.edges, { to: "npc-node", labelEnglish: "Talk to Sela" }],
          },
        ],
        [
          "npc-node",
          {
            nodeId: "npc-node",
            titleEnglish: "Npc node",
            sceneEnglish: "A fixture node that shifts an npc's affinity.",
            locationId: "here",
            preconditions: [],
            effects: [
              { kind: "shift_npc_affinity" as const, npcId: "sela-the-innkeeper", delta: 1 },
            ],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(npcWorld));
    const traversed = stateOf(traverseEdge(npcWorld, before, "npc-node"));
    const after = stateOf(completeCurrentNode(npcWorld, traversed));
    const delta = diffScene(before, after);
    expect(delta.npcAffinities).toEqual([
      { npcId: "sela-the-innkeeper", band: "cordial", facts: [] },
    ]);
  });

  // The case above's `before` never holds an overlay entry for the npc it
  // diffs, so it only exercises the `beforeEntry === undefined` disjunct.
  // This one gives `before` a real entry and re-applies a no-op shift, so the
  // band/facts comparison itself runs and reports no change.
  it("reports no npc change when a later node re-touches the same npc without altering it", () => {
    const originalStart = world.questNodes.get("start");
    if (originalStart === undefined) {
      expect.unreachable('fixture is missing its "start" node');
    }
    const npcWorld = {
      ...world,
      npcs: new Map([
        [
          "sela-the-innkeeper",
          {
            npcId: "sela-the-innkeeper",
            nameEnglish: "Sela",
            nameHebrew: "סלה",
            grammaticalGender: "feminine" as const,
            locationId: "here",
            descriptionEnglish: "A fixture npc.",
          },
        ],
      ]),
      questNodes: new Map([
        ...world.questNodes,
        [
          "start",
          {
            ...originalStart,
            edges: [...originalStart.edges, { to: "npc-node", labelEnglish: "Talk to Sela" }],
          },
        ],
        [
          "npc-node",
          {
            nodeId: "npc-node",
            titleEnglish: "Npc node",
            sceneEnglish: "A fixture node that shifts an npc's affinity.",
            locationId: "here",
            preconditions: [],
            effects: [
              { kind: "shift_npc_affinity" as const, npcId: "sela-the-innkeeper", delta: 1 },
            ],
            edges: [{ to: "npc-node-2", labelEnglish: "Talk again" }],
          },
        ],
        [
          "npc-node-2",
          {
            nodeId: "npc-node-2",
            titleEnglish: "Npc node 2",
            sceneEnglish: "A fixture node that re-touches the npc with a no-op shift.",
            locationId: "here",
            preconditions: [],
            effects: [
              { kind: "shift_npc_affinity" as const, npcId: "sela-the-innkeeper", delta: 0 },
            ],
            edges: [],
          },
        ],
      ]),
    };
    const opening = stateOf(startScene(npcWorld));
    const touched = stateOf(traverseEdge(npcWorld, opening, "npc-node"));
    const before = stateOf(traverseEdge(npcWorld, touched, "npc-node-2"));
    const after = stateOf(completeCurrentNode(npcWorld, before));
    expect(diffScene(before, after).npcAffinities).toEqual([]);
  });
});
