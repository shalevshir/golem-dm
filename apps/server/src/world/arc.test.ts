// The authored Emberfall arc, played by the scene engine, both branches, to
// their terminal states.
//
// It lives in `apps/server` because this is the only package that may read
// `data/world/` — `@ai-dm/rules-engine` forbids I/O, so its own tests use
// TypeScript fixtures. This is the half those fixtures cannot cover: whether
// the world a human edits actually plays.
//
// §4.7 step 2 shipped this arithmetic asserted only in a plan comment,
// because nothing evaluated a predicate yet. These are the same numbers,
// now executable.
import { describe, expect, it } from "vitest";
import {
  availableEdges,
  completeCurrentNode,
  relationBetween,
  startScene,
  traverseEdge,
} from "@ai-dm/rules-engine";
import type {
  EdgeOption,
  SceneOptions,
  SceneState,
  SceneTransition,
} from "@ai-dm/rules-engine";
import { loadWorld } from "./index.js";

function stateOf(transition: SceneTransition): SceneState {
  if (!transition.valid) {
    expect.unreachable(
      `expected a valid transition, got: ${transition.rejections.map((r) => r.message).join("; ")}`,
    );
  }
  return transition.state;
}

function edgesOf(options: SceneOptions): readonly EdgeOption[] {
  if (!options.valid) {
    expect.unreachable(
      `expected options, got: ${options.rejections.map((r) => r.message).join("; ")}`,
    );
  }
  return options.edges;
}

describe("the Emberfall arc", () => {
  it("opens at arrival, day 1, with the factions cold", () => {
    const world = loadWorld();
    const state = stateOf(startScene(world));
    expect(state.currentNodeId).toBe("arrival");
    expect(state.day).toBe(1);
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("cold");
  });

  it("offers both branches from arrival, both open", () => {
    const world = loadWorld();
    const options = edgesOf(availableEdges(world, stateOf(startScene(world))));
    expect(options.map((each) => each.edge.to).sort()).toEqual([
      "guild-offer",
      "warden-warning",
    ]);
    expect(options.every((each) => each.open)).toBe(true);
  });

  // Guild branch: guild-offer shifts the pair -1 from cold to hostile, and
  // nothing on this branch advances the calendar before reckoning.
  it("plays the guild branch to day 3 and neutral", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    expect(state.day).toBe(1);
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("hostile");

    state = stateOf(traverseEdge(world, state, "reckoning"));
    expect(state.currentNodeId).toBe("reckoning");
    state = stateOf(completeCurrentNode(world, state));
    // reckoning: +2 bands from hostile, +2 days from 1.
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("neutral");
    expect(state.day).toBe(3);
    expect(edgesOf(availableEdges(world, state))).toEqual([]);
  });

  // Warden branch: warden-warning advances a day and shifts nothing.
  it("plays the warden branch to day 4 and cordial", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "warden-warning"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    expect(state.day).toBe(2);
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("cold");

    state = stateOf(traverseEdge(world, state, "reckoning"));
    state = stateOf(completeCurrentNode(world, state));
    // reckoning: +2 bands from cold, +2 days from 2.
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("cordial");
    expect(state.day).toBe(4);
  });

  // Two branches that end in the same place would make every assertion above
  // a tautology. This is what says the graph is a graph.
  it("ends the two branches in different world states", () => {
    const world = loadWorld();
    const play = (second: string): SceneState => {
      let state = stateOf(traverseEdge(world, stateOf(startScene(world)), second));
      state = stateOf(traverseEdge(world, state, "the-weir"));
      state = stateOf(traverseEdge(world, state, "reckoning"));
      return stateOf(completeCurrentNode(world, state));
    };
    const guild = play("guild-offer");
    const warden = play("warden-warning");
    expect(guild.day).not.toBe(warden.day);
    expect(
      relationBetween(guild, "ashen-guild", "river-wardens"),
    ).not.toBe(relationBetween(warden, "ashen-guild", "river-wardens"));
  });

  // reckoning's gate asks for at least `hostile`, and `hostile` is the LOWEST
  // band reachable before it, so it passes on both branches. That is not a
  // bug — it is the gate being satisfiable, which the arc intends — but it
  // does mean this file cannot prove the gate works. `blockedWorld()` in
  // packages/rules-engine/src/scene/test-fixtures.ts is what does.
  it("reaches reckoning on both branches, so the gate is never the blocker", () => {
    const world = loadWorld();
    for (const second of ["guild-offer", "warden-warning"]) {
      let state = stateOf(traverseEdge(world, stateOf(startScene(world)), second));
      state = stateOf(traverseEdge(world, state, "the-weir"));
      const options = edgesOf(availableEdges(world, state));
      expect(options).toHaveLength(1);
      expect(options[0]?.open).toBe(true);
    }
  });
});
