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
  availableDetours,
  availableEdges,
  completeCurrentNode,
  relationBetween,
  startScene,
  traverseEdge,
  validateMove,
} from "@ai-dm/rules-engine";
import type { EdgeOption, SceneOptions, SceneState, SceneTransition } from "@ai-dm/rules-engine";
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
    expect(relationBetween(world, state, "ashen-guild", "river-wardens")).toBe("cold");
  });

  it("offers both branches from arrival, both open", () => {
    const world = loadWorld();
    const options = edgesOf(availableEdges(world, stateOf(startScene(world))));
    expect(options.map((each) => each.edge.to).sort()).toEqual(["guild-offer", "warden-warning"]);
    expect(options.every((each) => each.open)).toBe(true);
  });

  // Guild branch: guild-offer shifts the pair -1 from cold to hostile.
  // `the-weir`'s one edge leads to `saboteurs` (§4.7 step 5), not directly to
  // `reckoning` — the arc runs arrival/guild-offer/the-weir/saboteurs/reckoning,
  // and `saboteurs` itself advances the calendar a day (the exit criterion's
  // combat-effects clause) on the way through to reckoning.
  it("plays the guild branch to day 4 and neutral", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    expect(state.day).toBe(1);
    expect(relationBetween(world, state, "ashen-guild", "river-wardens")).toBe("hostile");

    state = stateOf(traverseEdge(world, state, "saboteurs"));
    state = stateOf(traverseEdge(world, state, "reckoning"));
    expect(state.currentNodeId).toBe("reckoning");
    // saboteurs: +1 day from 1, applied by leaving it for reckoning.
    expect(state.day).toBe(2);
    state = stateOf(completeCurrentNode(world, state));
    // reckoning: +2 bands from hostile, +2 days from 2.
    expect(relationBetween(world, state, "ashen-guild", "river-wardens")).toBe("neutral");
    expect(state.day).toBe(4);
    expect(edgesOf(availableEdges(world, state))).toEqual([]);
  });

  // Warden branch: warden-warning advances a day and shifts nothing.
  it("plays the warden branch to day 5 and cordial", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "warden-warning"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    expect(state.day).toBe(2);
    expect(relationBetween(world, state, "ashen-guild", "river-wardens")).toBe("cold");

    state = stateOf(traverseEdge(world, state, "saboteurs"));
    state = stateOf(traverseEdge(world, state, "reckoning"));
    // saboteurs: +1 day from 2.
    expect(state.day).toBe(3);
    state = stateOf(completeCurrentNode(world, state));
    // reckoning: +2 bands from cold, +2 days from 3.
    expect(relationBetween(world, state, "ashen-guild", "river-wardens")).toBe("cordial");
    expect(state.day).toBe(5);
  });

  // Two branches that end in the same place would make every assertion above
  // a tautology. This is what says the graph is a graph.
  it("ends the two branches in different world states", () => {
    const world = loadWorld();
    const play = (second: string): SceneState => {
      let state = stateOf(traverseEdge(world, stateOf(startScene(world)), second));
      state = stateOf(traverseEdge(world, state, "the-weir"));
      state = stateOf(traverseEdge(world, state, "saboteurs"));
      state = stateOf(traverseEdge(world, state, "reckoning"));
      return stateOf(completeCurrentNode(world, state));
    };
    const guild = play("guild-offer");
    const warden = play("warden-warning");
    expect(guild.day).not.toBe(warden.day);
    expect(relationBetween(world, guild, "ashen-guild", "river-wardens")).not.toBe(
      relationBetween(world, warden, "ashen-guild", "river-wardens"),
    );
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
      state = stateOf(traverseEdge(world, state, "saboteurs"));
      // Two ways on from `saboteurs`: straight to the inn, or the second act
      // that finds out who paid the ambushers. Both open on both branches —
      // the short road is what keeps `reckoning`'s gate provably unblocked
      // regardless of anything the long one does.
      const options = edgesOf(availableEdges(world, state));
      expect(options.map((each) => each.edge.to).sort()).toEqual([
        "reckoning",
        "the-outsiders-mark",
      ]);
      expect(options.every((each) => each.open)).toBe(true);
    }
  });

  // The long road: `saboteurs`' second edge opens an act that finds out who
  // paid the ambushers and ends by walking the evidence back into the same
  // `reckoning` the short road reaches in one step. Every `advance_calendar`
  // and every `shift_faction_relation` on that road is asserted here, because
  // a chain this long is exactly where an authoring slip stops being visible
  // by reading the file.
  const LONG_ROAD = [
    "the-weir",
    "saboteurs",
    "the-outsiders-mark",
    "the-factors-room",
    "up-to-the-kilns",
    "the-slag-pit",
    "hessas-ledger",
    "down-to-the-ford",
    "the-drowned-ford",
    "the-fish-ladder",
    "the-buyers-barge",
    "reckoning",
  ] as const;

  it("plays the long road from saboteurs to the barge and back into reckoning", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
    for (const nodeId of LONG_ROAD) state = stateOf(traverseEdge(world, state, nodeId));

    expect(state.currentNodeId).toBe("reckoning");
    // Eight nodes on this road advance the calendar a day each, applied as
    // each is left: saboteurs, the-outsiders-mark, up-to-the-kilns,
    // the-slag-pit, down-to-the-ford, the-drowned-ford, the-fish-ladder,
    // the-buyers-barge. From day 1, that is day 9 on arrival at the inn.
    expect(state.day).toBe(9);

    state = stateOf(completeCurrentNode(world, state));
    // reckoning: +2 days on top, and +2 bands on the pair it has always moved.
    expect(state.day).toBe(11);
    expect(relationBetween(world, state, "ashen-guild", "river-wardens")).toBe("neutral");
    // The buyer is the pair this act exists to move. Guild: cordial, less one
    // for the factor's room, one for the night crew, one for the barge.
    // Wardens: neutral, less one for the ford and one for the barge.
    expect(relationBetween(world, state, "ashen-guild", "quiet-buyer")).toBe("hostile");
    expect(relationBetween(world, state, "river-wardens", "quiet-buyer")).toBe("hostile");
  });

  // The long road is longer in days AND lands the world somewhere the short
  // road cannot — otherwise the whole act is decoration.
  it("ends the long road in a different world state than the short one", () => {
    const world = loadWorld();
    const short = (): SceneState => {
      let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
      state = stateOf(traverseEdge(world, state, "the-weir"));
      state = stateOf(traverseEdge(world, state, "saboteurs"));
      state = stateOf(traverseEdge(world, state, "reckoning"));
      return stateOf(completeCurrentNode(world, state));
    };
    const long = (): SceneState => {
      let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
      for (const nodeId of LONG_ROAD) state = stateOf(traverseEdge(world, state, nodeId));
      return stateOf(completeCurrentNode(world, state));
    };
    const a = short();
    const b = long();
    expect(a.day).not.toBe(b.day);
    // Untouched by the short road, moved three bands by the long one.
    expect(relationBetween(world, a, "ashen-guild", "quiet-buyer")).toBe("cordial");
    expect(relationBetween(world, b, "ashen-guild", "quiet-buyer")).toBe("hostile");
  });

  // Both new gates sit at exactly the band the authored road delivers, the
  // same zero-margin shape `reckoning`'s gate has. That is the property worth
  // pinning: one more band of slippage from anywhere — an improvised GM shift,
  // an added effect — closes them, and the door guard is what has to catch it.
  it("opens both new gates at exactly their floor, with no margin to spare", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
    for (const nodeId of ["the-weir", "saboteurs", "the-outsiders-mark", "the-factors-room"]) {
      state = stateOf(traverseEdge(world, state, nodeId));
    }
    state = stateOf(traverseEdge(world, state, "up-to-the-kilns"));
    state = stateOf(traverseEdge(world, state, "the-slag-pit"));
    // hessas-ledger demands `cold`, and leaving the slag pit is what puts the
    // pair at exactly `cold`.
    expect(relationBetween(world, state, "ashen-guild", "quiet-buyer")).toBe("neutral");
    const toLedger = edgesOf(availableEdges(world, state)).find(
      (each) => each.edge.to === "hessas-ledger",
    );
    expect(toLedger?.open).toBe(true);
    state = stateOf(traverseEdge(world, state, "hessas-ledger"));
    expect(relationBetween(world, state, "ashen-guild", "quiet-buyer")).toBe("cold");

    state = stateOf(traverseEdge(world, state, "down-to-the-ford"));
    state = stateOf(traverseEdge(world, state, "the-drowned-ford"));
    const toLadder = edgesOf(availableEdges(world, state)).find(
      (each) => each.edge.to === "the-fish-ladder",
    );
    expect(toLadder?.open).toBe(true);
    state = stateOf(traverseEdge(world, state, "the-fish-ladder"));
    expect(relationBetween(world, state, "river-wardens", "quiet-buyer")).toBe("cold");
  });

  // A player who skips the night crew and the ford still reaches the barge:
  // both gates are floors the *unshifted* baseline already clears, so the
  // short way through the act cannot soft-lock on them.
  it("reaches the fish ladder without fighting at the ford", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
    for (const nodeId of ["the-weir", "saboteurs", "the-outsiders-mark", "up-to-the-kilns"]) {
      state = stateOf(traverseEdge(world, state, nodeId));
    }
    state = stateOf(traverseEdge(world, state, "down-to-the-ford"));
    state = stateOf(traverseEdge(world, state, "the-fish-ladder"));
    expect(relationBetween(world, state, "river-wardens", "quiet-buyer")).toBe("neutral");
    state = stateOf(traverseEdge(world, state, "the-buyers-barge"));
    expect(state.currentNodeId).toBe("the-buyers-barge");
  });

  it("has exactly four detours, none of them targeted by an authored edge", () => {
    const world = loadWorld();
    const detours = Array.from(world.questNodes.values()).filter((node) => node.detour);
    expect(detours.map((node) => node.nodeId).sort()).toEqual([
      "after-the-reckoning",
      "ilvas-count",
      "the-ash-shrine",
      "tobins-errand",
    ]);
    const targeted = new Set(
      Array.from(world.questNodes.values()).flatMap((node) => node.edges.map((edge) => edge.to)),
    );
    for (const detour of detours) expect(targeted.has(detour.nodeId)).toBe(false);
  });

  // The half of the problem this step exists for: before it, a concluded arc
  // had nowhere left to go.
  it("offers a detour once the arc has concluded", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    state = stateOf(traverseEdge(world, state, "saboteurs"));
    state = stateOf(traverseEdge(world, state, "reckoning"));
    state = stateOf(completeCurrentNode(world, state));
    expect(availableEdges(world, state)).toEqual({ valid: true, edges: [] });
    const open = availableDetours(world, state).filter((each) => each.open);
    expect(open.map((each) => each.node.nodeId)).toContain("after-the-reckoning");
  });

  // Regression: `tobins-errand` originally had no precondition, so it was
  // enterable straight from `arrival` — before the player had taken either
  // branch, and before `the-weir` (whose own precondition only checks
  // `arrival`) was reachable any other way. That let a detour visit stand in
  // for the branch choice, and its one edge back required `the-weir`
  // completed, which a turn-one entrant could never satisfy — a permanent
  // soft-lock. Gating `tobins-errand` on `the-weir` itself closes both holes.
  it("keeps tobins-errand closed until the-weir is completed", () => {
    const world = loadWorld();
    const startState = stateOf(startScene(world));
    expect(
      availableDetours(world, startState).find((each) => each.node.nodeId === "tobins-errand")
        ?.open,
    ).toBe(false);

    let state = stateOf(traverseEdge(world, startState, "guild-offer"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    state = stateOf(completeCurrentNode(world, state));
    const open = availableDetours(world, state).filter((each) => each.open);
    expect(open.map((each) => each.node.nodeId)).toContain("tobins-errand");
  });

  it("keeps every detour's own effects inside the improvised vocabulary's spirit", () => {
    const world = loadWorld();
    for (const node of Array.from(world.questNodes.values()).filter((each) => each.detour)) {
      expect(node.encounterId).toBeUndefined();
    }
  });

  // The spec's own motivating example for the door guard: `guild-offer`
  // shifts ashen-guild/river-wardens from `cold` to exactly `hostile`, which
  // is precisely what `reckoning`'s gate demands — zero margin. Nothing else
  // in this file calls `validateMove`, so nothing else protects the real
  // content this guard exists for.
  it("the door guard protects reckoning's real zero-margin gate", () => {
    const world = loadWorld();
    // `guild-offer`'s own effect does not apply until it is COMPLETED — i.e.
    // on leaving it for `the-weir` (see "plays the guild branch to day 4 and
    // neutral" above) — so the band is only actually `hostile`, the exact
    // floor `reckoning` requires, once this second traversal has happened.
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    const result = validateMove(world, state, {
      kind: "world",
      effects: [
        {
          kind: "shift_faction_relation",
          factionA: "ashen-guild",
          factionB: "river-wardens",
          delta: -1,
        },
      ],
      reasonEnglish: "the player sided loudly with the kilns",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.rejections[0]?.reason).toBe("would_close_door");
  });
});
