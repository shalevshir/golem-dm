import { describe, expect, it } from "vitest";
import { pairKey, relationBetween, shiftBand } from "./index.js";
import type { SceneState } from "./index.js";
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
