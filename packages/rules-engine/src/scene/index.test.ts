import { describe, expect, it } from "vitest";
import {
  availableEdges,
  completeCurrentNode,
  evaluatePredicate,
  pairKey,
  relationBetween,
  shiftBand,
  startScene,
  traverseEdge,
} from "./index.js";
import type { AuthoredWorld, SceneRejection, SceneState, SceneTransition } from "./index.js";
import { blockedWorld, linearWorld } from "./test-fixtures.js";
import type { FactionBand } from "@ai-dm/schemas";

function stateWith(
  relations: readonly (readonly [string, string, FactionBand])[],
): SceneState {
  return {
    currentNodeId: "start",
    completedNodeIds: new Set<string>(),
    relations: new Map(relations.map(([a, b, band]) => [pairKey(a, b), band])),
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
  it("finds a relation asked in either order", () => {
    const state = stateWith([["ashen-guild", "river-wardens", "cold"]]);
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("cold");
    expect(relationBetween(state, "river-wardens", "ashen-guild")).toBe("cold");
  });

  // Unreachable through `loadWorld`, which refuses a missing pair and a
  // self-pair. Reachable through a hand-built SceneState, which is what step
  // 4 will assemble from a projection.
  it("returns undefined for a pair it does not hold", () => {
    const state = stateWith([["ashen-guild", "river-wardens", "cold"]]);
    expect(relationBetween(state, "ashen-guild", "nobody")).toBeUndefined();
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
    expect(relationBetween(state, "alpha", "beta")).toBe("neutral");
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
    expect(evaluatePredicate({ kind: "node_completed", nodeId: "start" }, opening)).toBe(false);
    expect(traverseEdge(world, opening, "middle").valid).toBe(true);
  });

  it("applies the leaving node's effects, both kinds", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(state.currentNodeId).toBe("end");
    expect(state.day).toBe(3); // 1 + middle's advance_calendar of 2
    expect(relationBetween(state, "alpha", "beta")).toBe("cold"); // neutral - 1
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
    expect(relationBetween(after, "gamma", "delta")).toBeUndefined();
  });
});

describe("availableEdges", () => {
  it("reports an open edge as open with no rejections", () => {
    const world = linearWorld();
    const options = availableEdges(world, stateOf(startScene(world)));
    expect(options).toHaveLength(1);
    expect(options[0]?.edge.to).toBe("middle");
    expect(options[0]?.open).toBe(true);
    expect(options[0]?.rejections).toEqual([]);
  });

  it("reports every edge, not only the open ones", () => {
    const world = blockedWorld();
    const options = availableEdges(world, stateOf(startScene(world)));
    expect(options.map((each) => each.edge.to)).toEqual(["open", "shut"]);
  });

  it("returns nothing for a terminal node", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(availableEdges(world, state)).toEqual([]);
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
  // Shared by every case below: alpha/beta sit at `hostile`, which is the
  // band index 1 out of `war, hostile, cold, neutral, cordial, friendly,
  // allied`. Fixed once so the three cases below read as one scale.
  const state: SceneState = {
    currentNodeId: "start",
    completedNodeIds: new Set<string>(),
    relations: new Map([[pairKey("alpha", "beta"), "hostile"]]),
    day: 1,
  };

  // `blockedWorld()`'s `faction_band_at_least` pair is always declared, and
  // the `relationBetween` test for an unknown pair goes through
  // `relationBetween` directly, not `evaluatePredicate`. This is the only
  // path that reaches `evaluatePredicate`'s own `band === undefined` guard.
  it("treats a faction pair the state does not hold as gate-closed, not gate-open", () => {
    expect(
      evaluatePredicate(
        { kind: "faction_band_at_least", factionA: "gamma", factionB: "delta", band: "cordial" },
        state,
      ),
    ).toBe(false);
  });

  // The `>=` boundary, and the case the shipped arc actually depends on:
  // `reckoning`'s gate asks for at least `hostile` and the arc leaves the
  // pair at exactly `hostile` before it. Nothing else in this suite puts a
  // faction gate in its open state, so `>` masquerading as `>=` passes every
  // other test and strands that node.
  it("opens a gate when the pair sits at exactly the required band", () => {
    expect(
      evaluatePredicate(
        { kind: "faction_band_at_least", factionA: "alpha", factionB: "beta", band: "hostile" },
        state,
      ),
    ).toBe(true);
  });

  it("opens a gate when the pair sits above the required band", () => {
    expect(
      evaluatePredicate(
        { kind: "faction_band_at_least", factionA: "alpha", factionB: "beta", band: "war" },
        state,
      ),
    ).toBe(true);
  });
});

describe("refusing a traversal", () => {
  it("refuses an edge the current node does not have", () => {
    const world = linearWorld();
    const rejections = rejectionsOf(
      traverseEdge(world, stateOf(startScene(world)), "end"),
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("no_such_edge");
    expect(rejections[0]?.subjectId).toBe("end");
  });

  it("refuses an edge to a node that does not exist", () => {
    const world = blockedWorld();
    const rejections = rejectionsOf(
      traverseEdge(world, stateOf(startScene(world)), "nowhere"),
    );
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
    const rejections = rejectionsOf(
      traverseEdge(world, stateOf(startScene(world)), "shut"),
    );
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
    const options = availableEdges(world, stateOf(startScene(world)));
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
    for (const option of availableEdges(world, state)) {
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
    const rejections = rejectionsOf(
      startScene({ ...world, startingNodeId: "no-such-node" }),
    );
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

  // The third sibling answers differently on purpose: "no options" rather than
  // a loud `no_such_node`, per its own doc comment. Pinned here so the branch
  // is reached — without this case it was covered by line but not by branch,
  // which is exactly what let it silently disagree with its two siblings.
  it("returns no options from availableEdges, quietly rather than as a rejection", () => {
    expect(availableEdges(linearWorld(), ghostState())).toEqual([]);
  });
});
