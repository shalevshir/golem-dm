import { describe, expect, it } from "vitest";
import {
  affinityOf,
  availableEdges,
  completeCurrentNode,
  evaluatePredicate,
  pairKey,
  relationBetween,
  shiftBand,
  startScene,
  traverseEdge,
} from "./index.js";
import type {
  AuthoredWorld,
  EdgeOption,
  SceneOptions,
  SceneRejection,
  SceneState,
  SceneTransition,
} from "./index.js";
import { blockedWorld, linearWorld } from "./test-fixtures.js";
import type { FactionBand } from "@ai-dm/schemas";

function stateWith(relations: readonly (readonly [string, string, FactionBand])[]): SceneState {
  return {
    currentNodeId: "start",
    completedNodeIds: new Set<string>(),
    relations: new Map(relations.map(([a, b, band]) => [pairKey(a, b), band])),
    npcAffinities: new Map(),
    day: 1,
  };
}

describe("pairKey", () => {
  // Moved here from apps/server. The engine is pure and may never import the
  // server (invariant 5), and an engine that cannot import this would
  // hand-write `a < b ? a|b : b|a` a second time — the invariant-4 duplicate
  // step 2's whole-branch review predicted for this step.
  it("is order-independent", () => {
    expect(pairKey("alpha", "beta")).toBe(pairKey("beta", "alpha"));
  });

  it("distinguishes different pairs", () => {
    expect(pairKey("alpha", "beta")).not.toBe(pairKey("alpha", "gamma"));
  });
});

describe("shiftBand", () => {
  it("moves along FACTION_BANDS by the delta", () => {
    expect(shiftBand("cold", 1)).toBe("neutral");
    expect(shiftBand("cold", -1)).toBe("hostile");
    expect(shiftBand("neutral", 0)).toBe("neutral");
  });

  // The schema permits -6..+6 precisely so clamping is reachable rather than
  // theoretical. Both ends, because a clamp written with one bound is a clamp
  // that is wrong in one direction.
  it("clamps at allied and never wraps", () => {
    expect(shiftBand("cordial", 6)).toBe("allied");
    expect(shiftBand("allied", 1)).toBe("allied");
  });

  it("clamps at war and never wraps", () => {
    expect(shiftBand("hostile", -6)).toBe("war");
    expect(shiftBand("war", -1)).toBe("war");
  });

  it("spans the whole scale in one shift", () => {
    expect(shiftBand("war", 6)).toBe("allied");
    expect(shiftBand("allied", -6)).toBe("war");
  });

  // Unreachable through authored content — `WorldEffect.delta` is
  // `z.number().int()` — but the export is typed `delta: number`, and
  // `FACTION_BANDS[3.5]` is `undefined`. Truncating toward zero before
  // indexing is what keeps that a rounded shift rather than a silent no-op.
  it("truncates a fractional delta toward zero rather than silently no-opping", () => {
    expect(shiftBand("cold", 1.9)).toBe("neutral");
    expect(shiftBand("cold", -1.9)).toBe("hostile");
  });
});

describe("relationBetween", () => {
  // `linearWorld()` declares only alpha/beta, so neither pair below is in the
  // authored baseline and these cases read the state alone. The baseline's own
  // behaviour is covered in the `evaluatePredicate` block.
  const world = linearWorld();

  it("finds a relation asked in either order", () => {
    const state = stateWith([["ashen-guild", "river-wardens", "cold"]]);
    expect(relationBetween(world, state, "ashen-guild", "river-wardens")).toBe("cold");
    expect(relationBetween(world, state, "river-wardens", "ashen-guild")).toBe("cold");
  });

  // Unreachable through `loadWorld`, which refuses a missing pair and a
  // self-pair. Reachable through a hand-built world, which is what step 4
  // assembles alongside a projected state.
  it("returns undefined for a pair neither the state nor the world holds", () => {
    const state = stateWith([["ashen-guild", "river-wardens", "cold"]]);
    expect(relationBetween(world, state, "ashen-guild", "nobody")).toBeUndefined();
  });
});

describe("affinityOf", () => {
  it("defaults to neutral with no facts for an npc the state has not touched", () => {
    const state = stateWith([]);
    expect(affinityOf(state, "sela-the-innkeeper")).toEqual({ band: "neutral", facts: [] });
  });

  it("reads the overlay for a touched npc", () => {
    const state: SceneState = {
      ...stateWith([]),
      npcAffinities: new Map([["sela-the-innkeeper", { band: "cordial", facts: ["a fact"] }]]),
    };
    expect(affinityOf(state, "sela-the-innkeeper")).toEqual({
      band: "cordial",
      facts: ["a fact"],
    });
  });
});

/**
 * The state from a transition, or a loud failure naming the rejections.
 *
 * `expect.unreachable` is called OUTSIDE any try/catch for the reason
 * `apps/server/src/config.test.ts:36-61` records — but here the reason to
 * factor it out is different and simpler: unwrapping a union inline in twenty
 * assertions is twenty chances to write `transition.state` behind a check that
 * does not narrow.
 */
function stateOf(transition: SceneTransition): SceneState {
  if (!transition.valid) {
    expect.unreachable(
      `expected a valid transition, got: ${transition.rejections.map((r) => r.reason).join(", ")}`,
    );
  }
  return transition.state;
}

describe("startScene", () => {
  it("opens at the manifest's node, day and relations, with nothing completed", () => {
    const world = linearWorld();
    const state = stateOf(startScene(world));
    expect(state.currentNodeId).toBe("start");
    expect(state.day).toBe(1);
    expect(state.completedNodeIds.size).toBe(0);
    expect(relationBetween(world, state, "alpha", "beta")).toBe("neutral");
  });
});

describe("traverseEdge", () => {
  it("completes the node it leaves and enters the one it names", () => {
    const world = linearWorld();
    const state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    expect(state.currentNodeId).toBe("middle");
    expect(state.completedNodeIds.has("start")).toBe(true);
    // `middle`'s own effects have NOT run — it was entered, not completed.
    expect(state.day).toBe(1);
  });

  // The order that makes the shipped arc playable: `middle` requires
  // `node_completed: start`, and it is reached by leaving `start`. Evaluating
  // preconditions before the current node completes would make the first move
  // of every authored arc illegal.
  it("evaluates the target's preconditions after the current node completes", () => {
    const world = linearWorld();
    const opening = stateOf(startScene(world));
    expect(evaluatePredicate(world, opening, { kind: "node_completed", nodeId: "start" })).toBe(
      false,
    );
    expect(traverseEdge(world, opening, "middle").valid).toBe(true);
  });

  it("applies the leaving node's effects, both kinds", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(state.currentNodeId).toBe("end");
    expect(state.day).toBe(3); // 1 + middle's advance_calendar of 2
    expect(relationBetween(world, state, "alpha", "beta")).toBe("cold"); // neutral - 1
  });

  it("does not mutate the state it was given", () => {
    const world = linearWorld();
    const before = stateOf(startScene(world));
    traverseEdge(world, before, "middle");
    expect(before.currentNodeId).toBe("start");
    expect(before.completedNodeIds.size).toBe(0);
  });
});

describe("completeCurrentNode", () => {
  // `reckoning` in the shipped arc is terminal AND carries effects. Without
  // this function those effects are declared by an author and applied by
  // nothing.
  it("applies a terminal node's effects", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(state.day).toBe(3);
    state = stateOf(completeCurrentNode(world, state));
    expect(state.completedNodeIds.has("end")).toBe(true);
    expect(state.day).toBe(4); // end's advance_calendar of 1
  });

  // A node re-entered by a cycle must not pump its faction shift a second
  // time. The graph has no cycle today; the guard is what makes adding one
  // safe rather than silently wrong.
  it("is idempotent — effects apply on first completion only", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    const once = stateOf(completeCurrentNode(world, state));
    const twice = stateOf(completeCurrentNode(world, once));
    expect(twice.day).toBe(once.day);
    expect(twice.completedNodeIds.size).toBe(once.completedNodeIds.size);
  });

  // `applyEffect`'s `shift_faction_relation` case no-ops when the pair it
  // names is absent from the state's relations, rather than inventing one.
  // `loadWorld` refuses an effect naming an unknown faction, so this needs a
  // hand-built world to reach at all — `applyEffect` is unexported by design,
  // so a node completion is the only door in.
  it("no-ops a faction shift naming a pair the state does not hold", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node whose effect targets an unknown faction pair.",
            locationId: "here",
            preconditions: [],
            effects: [
              { kind: "shift_faction_relation", factionA: "gamma", factionB: "delta", delta: 1 },
            ],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const after = stateOf(completeCurrentNode(world, before));
    expect(after.relations).toEqual(before.relations);
    expect(relationBetween(world, after, "gamma", "delta")).toBeUndefined();
  });

  // A `SceneState` folded out of the event log may carry only the pairs that
  // have actually changed — the rest are already in `world.json`. Reading the
  // state alone made a shift over an unchanged pair silently do nothing, so
  // the authored relation is the baseline the shift starts from.
  it("shifts from the authored band when the state omits the pair", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node that shifts a pair the state has not recorded.",
            locationId: "here",
            preconditions: [],
            effects: [
              { kind: "shift_faction_relation", factionA: "alpha", factionB: "beta", delta: -1 },
            ],
            edges: [],
          },
        ],
      ]),
    };
    // linearWorld() declares alpha/beta at `neutral`; this projection has
    // recorded no change to it yet, so the pair is absent from the state.
    const partial: SceneState = {
      currentNodeId: "solo",
      completedNodeIds: new Set<string>(),
      relations: new Map(),
      npcAffinities: new Map(),
      day: 1,
    };
    expect(partial.relations.get(pairKey("alpha", "beta"))).toBeUndefined();
    const after = stateOf(completeCurrentNode(world, partial));
    expect(relationBetween(world, after, "alpha", "beta")).toBe("cold");
  });

  // The precondition check must not defeat the idempotency above. A node whose
  // own effect shifts the pair its own gate reads would, on a second call,
  // re-evaluate that gate against the band its first call produced — and
  // refuse a completion that has already happened.
  it("stays idempotent for a node whose effects invalidate its own gate", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "self-undoing",
      relations: new Map([[pairKey("alpha", "beta"), "cordial"]]),
      questNodes: new Map([
        [
          "self-undoing",
          {
            nodeId: "self-undoing",
            titleEnglish: "Self-undoing",
            sceneEnglish: "A node that shifts the pair its own gate reads.",
            locationId: "here",
            preconditions: [
              {
                kind: "faction_band_at_least",
                factionA: "alpha",
                factionB: "beta",
                band: "cordial",
              },
            ],
            effects: [
              { kind: "shift_faction_relation", factionA: "alpha", factionB: "beta", delta: -4 },
            ],
            edges: [],
          },
        ],
      ]),
    };
    const once = stateOf(completeCurrentNode(world, stateOf(startScene(world))));
    expect(relationBetween(world, once, "alpha", "beta")).toBe("war");
    const twice = stateOf(completeCurrentNode(world, once));
    expect(relationBetween(world, twice, "alpha", "beta")).toBe("war");
    expect(twice.completedNodeIds.size).toBe(once.completedNodeIds.size);
  });

  // Entry is gated by `startScene` and `traverseEdge`, but they stop being the
  // only producers of a `SceneState` once step 4 folds one out of the log —
  // and completing a node is what applies its effects.
  it("refuses to complete a node whose own preconditions are unmet", () => {
    const world = linearWorld();
    const stranded: SceneState = {
      currentNodeId: "middle",
      completedNodeIds: new Set<string>(),
      relations: world.relations,
      npcAffinities: new Map(),
      day: 1,
    };
    const transition = completeCurrentNode(world, stranded);
    expect(transition.valid).toBe(false);
    if (transition.valid) return;
    expect(transition.rejections).toHaveLength(1);
    expect(transition.rejections[0]?.reason).toBe("precondition_unmet");
    // middle carries a -1 shift and a +2 day advance; neither may have run.
    expect(relationBetween(world, stranded, "alpha", "beta")).toBe("neutral");
    expect(stranded.day).toBe(1);
  });

  it("shifts an npc's affinity on node completion", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node whose effect shifts an npc's affinity.",
            locationId: "here",
            preconditions: [],
            effects: [{ kind: "shift_npc_affinity", npcId: "sela-the-innkeeper", delta: 1 }],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const after = stateOf(completeCurrentNode(world, before));
    expect(affinityOf(after, "sela-the-innkeeper")).toEqual({ band: "cordial", facts: [] });
  });

  it("records a fact on node completion, without touching the band", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node whose effect records a fact.",
            locationId: "here",
            preconditions: [],
            effects: [
              {
                kind: "add_npc_fact",
                npcId: "sela-the-innkeeper",
                fact: "helped at the reckoning",
              },
            ],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const after = stateOf(completeCurrentNode(world, before));
    expect(affinityOf(after, "sela-the-innkeeper")).toEqual({
      band: "neutral",
      facts: ["helped at the reckoning"],
    });
  });

  it("appends a second fact rather than replacing the first", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node with two fact-recording effects.",
            locationId: "here",
            preconditions: [],
            effects: [
              { kind: "add_npc_fact", npcId: "sela-the-innkeeper", fact: "first fact" },
              { kind: "add_npc_fact", npcId: "sela-the-innkeeper", fact: "second fact" },
            ],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const after = stateOf(completeCurrentNode(world, before));
    expect(affinityOf(after, "sela-the-innkeeper").facts).toEqual(["first fact", "second fact"]);
  });

  it("is idempotent for npc effects too — a re-completed node does not double-shift", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node whose effect shifts an npc's affinity.",
            locationId: "here",
            preconditions: [],
            effects: [{ kind: "shift_npc_affinity", npcId: "sela-the-innkeeper", delta: 1 }],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const once = stateOf(completeCurrentNode(world, before));
    const twice = stateOf(completeCurrentNode(world, once));
    expect(affinityOf(twice, "sela-the-innkeeper")).toEqual(affinityOf(once, "sela-the-innkeeper"));
  });
});

/**
 * The edges from a `SceneOptions`, or a loud failure naming the rejections —
 * the `stateOf` of the third entry point.
 */
function edgesOf(options: SceneOptions): readonly EdgeOption[] {
  if (!options.valid) {
    expect.unreachable(
      `expected options, got: ${options.rejections.map((r) => r.reason).join(", ")}`,
    );
  }
  return options.edges;
}

describe("availableEdges", () => {
  it("reports an open edge as open with no rejections", () => {
    const world = linearWorld();
    const options = edgesOf(availableEdges(world, stateOf(startScene(world))));
    expect(options).toHaveLength(1);
    expect(options[0]?.edge.to).toBe("middle");
    expect(options[0]?.open).toBe(true);
    expect(options[0]?.rejections).toEqual([]);
  });

  it("reports every edge, not only the open ones", () => {
    const world = blockedWorld();
    const options = edgesOf(availableEdges(world, stateOf(startScene(world))));
    expect(options.map((each) => each.edge.to)).toEqual(["open", "shut"]);
  });

  it("returns nothing for a terminal node", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(edgesOf(availableEdges(world, state))).toEqual([]);
  });
});

/**
 * The rejections from a transition, or a loud failure if it succeeded.
 *
 * The mirror of `stateOf`, and the reason both exist: a union unwrapped
 * inline is a union that can be read behind a check that does not narrow.
 */
function rejectionsOf(transition: SceneTransition): readonly SceneRejection[] {
  if (transition.valid) {
    expect.unreachable(`expected a refusal, got node "${transition.state.currentNodeId}"`);
  }
  return transition.rejections;
}

describe("evaluatePredicate", () => {
  // `linearWorld()` authors alpha/beta at `neutral` (index 3); the state below
  // records them at `hostile` (index 1), out of `war, hostile, cold, neutral,
  // cordial, friendly, allied`. The two deliberately DISAGREE, so every case
  // here also says which of them a gate reads.
  const world = linearWorld();
  const state: SceneState = {
    currentNodeId: "start",
    completedNodeIds: new Set<string>(),
    relations: new Map([[pairKey("alpha", "beta"), "hostile"]]),
    npcAffinities: new Map(),
    day: 1,
  };

  // The state is an overlay on the authored baseline, not the other way
  // round. An inverted lookup would read `neutral` here and open a gate the
  // campaign has actually closed — and would pass every other case in this
  // block, since `neutral` outranks both bands they ask for.
  it("reads the state's band, not the authored one, for a pair the state records", () => {
    expect(relationBetween(world, state, "alpha", "beta")).toBe("hostile");
    expect(
      evaluatePredicate(world, state, {
        kind: "faction_band_at_least",
        factionA: "alpha",
        factionB: "beta",
        band: "cold",
      }),
    ).toBe(false);
  });

  // The other half: a pair the state has not recorded falls back to the band
  // the author declared, rather than reading as "no standing at all". A
  // projection that stores only what changed would otherwise close every gate
  // over every untouched pair.
  it("falls back to the authored band for a pair the state omits", () => {
    const partial: SceneState = { ...state, relations: new Map() };
    expect(relationBetween(world, partial, "alpha", "beta")).toBe("neutral");
    expect(
      evaluatePredicate(world, partial, {
        kind: "faction_band_at_least",
        factionA: "alpha",
        factionB: "beta",
        band: "cold",
      }),
    ).toBe(true);
  });

  // Neither the state nor the authored world declares gamma/delta, which is
  // the only way the `band === undefined` guard is reachable now that the
  // authored relation backs every lookup.
  it("treats a pair neither the state nor the world holds as gate-closed", () => {
    expect(
      evaluatePredicate(world, state, {
        kind: "faction_band_at_least",
        factionA: "gamma",
        factionB: "delta",
        band: "cordial",
      }),
    ).toBe(false);
  });

  // The `>=` boundary, and the case the shipped arc actually depends on:
  // `reckoning`'s gate asks for at least `hostile` and the arc leaves the
  // pair at exactly `hostile` before it. Nothing else in this suite puts a
  // faction gate in its open state, so `>` masquerading as `>=` passes every
  // other test and strands that node.
  it("opens a gate when the pair sits at exactly the required band", () => {
    expect(
      evaluatePredicate(world, state, {
        kind: "faction_band_at_least",
        factionA: "alpha",
        factionB: "beta",
        band: "hostile",
      }),
    ).toBe(true);
  });

  it("opens a gate when the pair sits above the required band", () => {
    expect(
      evaluatePredicate(world, state, {
        kind: "faction_band_at_least",
        factionA: "alpha",
        factionB: "beta",
        band: "war",
      }),
    ).toBe(true);
  });
});

describe("refusing a traversal", () => {
  it("refuses an edge the current node does not have", () => {
    const world = linearWorld();
    const rejections = rejectionsOf(traverseEdge(world, stateOf(startScene(world)), "end"));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("no_such_edge");
    expect(rejections[0]?.subjectId).toBe("end");
  });

  it("refuses an edge to a node that does not exist", () => {
    const world = blockedWorld();
    const rejections = rejectionsOf(traverseEdge(world, stateOf(startScene(world)), "nowhere"));
    // `start` has no edge to "nowhere", so this is the edge check, not the
    // node check — the two reasons are distinguishable and this pins which
    // one fires first.
    expect(rejections[0]?.reason).toBe("no_such_edge");
  });

  // The test this whole step exists for. `shut` demands `cordial` and the
  // pair is at `hostile` with nothing to shift it. An evaluator hard-coded to
  // return true for `faction_band_at_least` passes every other test in this
  // repo and fails exactly this one.
  it("refuses a traversal whose faction gate is not met", () => {
    const world = blockedWorld();
    const rejections = rejectionsOf(traverseEdge(world, stateOf(startScene(world)), "shut"));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("precondition_unmet");
    expect(rejections[0]?.subjectId).toBe("shut");
    expect(rejections[0]?.message).toContain("cordial");
  });

  it("leaves the state untouched when the target refuses", () => {
    const world = blockedWorld();
    const before = stateOf(startScene(world));
    traverseEdge(world, before, "shut");
    expect(before.currentNodeId).toBe("start");
    expect(before.completedNodeIds.has("start")).toBe(false);
  });

  // The sibling branch is open from the same state, so the closure above is
  // the gate refusing and not the fixture being broken.
  it("still allows the open branch from the same state", () => {
    const world = blockedWorld();
    expect(traverseEdge(world, stateOf(startScene(world)), "open").valid).toBe(true);
  });

  // Two unmet preconditions on one node is a shape no authored content has,
  // so this replaces the fixture's node rather than adding a fixture world
  // that exists only to hold it. Both kinds, so a bug that reported only one
  // branch of `entryRejections`' filter would show up here.
  it("names every unmet precondition, not the first", () => {
    const gated: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "gate",
      questNodes: new Map([
        [
          "gate",
          {
            nodeId: "gate",
            titleEnglish: "Gate",
            sceneEnglish: "Two gates, both shut.",
            locationId: "here",
            preconditions: [
              { kind: "node_completed", nodeId: "never" },
              {
                kind: "faction_band_at_least",
                factionA: "alpha",
                factionB: "beta",
                band: "allied",
              },
            ],
            effects: [],
            edges: [],
          },
        ],
      ]),
    };
    const rejections = rejectionsOf(startScene(gated));
    expect(rejections).toHaveLength(2);
    expect(rejections.every((each) => each.reason === "precondition_unmet")).toBe(true);
    // Pins `describePredicate`'s `node_completed` arm, the sibling of the
    // `faction_band_at_least` arm already covered by the "cordial" assertion
    // above — otherwise that arm's text is asserted nowhere.
    expect(rejections[0]?.message).toBe('entering "gate" requires "never" to be completed');
  });
});

describe("availableEdges under a closed gate", () => {
  it("marks the closed edge closed and the open one open", () => {
    const world = blockedWorld();
    const options = edgesOf(availableEdges(world, stateOf(startScene(world))));
    const byTarget = new Map(options.map((each) => [each.edge.to, each]));
    expect(byTarget.get("open")?.open).toBe(true);
    expect(byTarget.get("shut")?.open).toBe(false);
    expect(byTarget.get("shut")?.rejections[0]?.reason).toBe("precondition_unmet");
  });

  // The two must agree by construction — they share `entryRejections` — and
  // this is what would catch someone "optimising" one of them apart from the
  // other.
  it("agrees with traverseEdge on every edge", () => {
    const world = blockedWorld();
    const state = stateOf(startScene(world));
    for (const option of edgesOf(availableEdges(world, state))) {
      expect(traverseEdge(world, state, option.edge.to).valid).toBe(option.open);
    }
  });
});

describe("startScene on a world it cannot open", () => {
  // Exactly the hazard step 2 left open: a start node gated on its own
  // completion loads clean and yields no enterable entry point. Task 5 makes
  // `loadWorld` refuse it; this is the evaluator half.
  it("refuses a start node that requires its own completion", () => {
    const world = linearWorld();
    const selfGated: AuthoredWorld = {
      ...world,
      questNodes: new Map([
        [
          "start",
          {
            nodeId: "start",
            titleEnglish: "Start",
            sceneEnglish: "A node that requires itself.",
            locationId: "here",
            preconditions: [{ kind: "node_completed", nodeId: "start" }],
            effects: [],
            edges: [],
          },
        ],
      ]),
    };
    const rejections = rejectionsOf(startScene(selfGated));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("precondition_unmet");
  });

  it("refuses a starting node id that resolves to nothing", () => {
    const world = linearWorld();
    const rejections = rejectionsOf(startScene({ ...world, startingNodeId: "no-such-node" }));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("no_such_node");
  });
});

// `startScene` and a valid `traverseEdge`/`completeCurrentNode` chain can
// never produce a state whose `currentNodeId` is not in the world — but a
// hand-built state can, the same way `relationBetween`'s "unknown pair" case
// can, and step 4 assembles a `SceneState` from a projection. Coverage
// flagged these as the two `no_such_node` guards nothing else in this suite
// reaches.
describe("acting from a state whose current node does not exist", () => {
  function ghostState(): SceneState {
    return {
      currentNodeId: "ghost",
      completedNodeIds: new Set<string>(),
      relations: new Map(),
      npcAffinities: new Map(),
      day: 1,
    };
  }

  it("refuses traverseEdge", () => {
    const rejections = rejectionsOf(traverseEdge(linearWorld(), ghostState(), "middle"));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("no_such_node");
    expect(rejections[0]?.subjectId).toBe("ghost");
  });

  it("refuses completeCurrentNode", () => {
    const rejections = rejectionsOf(completeCurrentNode(linearWorld(), ghostState()));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("no_such_node");
    expect(rejections[0]?.subjectId).toBe("ghost");
  });

  // All three siblings answer alike. `availableEdges` used to return `[]`
  // here, which a router cannot tell apart from a terminal node that has
  // simply run out of edges — so a campaign pointing at renamed content read
  // as one that had ended.
  it("refuses availableEdges", () => {
    const options = availableEdges(linearWorld(), ghostState());
    expect(options.valid).toBe(false);
    if (options.valid) return;
    expect(options.rejections).toHaveLength(1);
    expect(options.rejections[0]?.reason).toBe("no_such_node");
    expect(options.rejections[0]?.subjectId).toBe("ghost");
  });

  // A terminal node is the case that must NOT look like the one above.
  it("distinguishes a terminal node from a missing one", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(edgesOf(availableEdges(world, state))).toEqual([]);
  });
});
