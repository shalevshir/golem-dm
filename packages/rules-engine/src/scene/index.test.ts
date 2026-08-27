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
import type { SceneState, SceneTransition } from "./index.js";
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
