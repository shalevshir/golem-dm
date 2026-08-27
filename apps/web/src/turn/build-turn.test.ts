import { describe, expect, it } from "vitest";
import { ExecuteTurn } from "@ai-dm/schemas";
import { buildTurn, describeSelection } from "./build-turn.js";

const attack = {
  actionType: "attack" as const,
  actionId: "spear",
  requiresTarget: true,
  targetableCombatantIds: ["goblin-a"],
};

const dodge = {
  actionType: "dodge" as const,
  requiresTarget: false,
  targetableCombatantIds: [],
};

const shove = {
  actionType: "shove" as const,
  requiresTarget: true,
  targetableCombatantIds: ["goblin-a"],
};

describe("buildTurn", () => {
  it("produces a turn the shared schema accepts", () => {
    const turn = buildTurn({
      actorId: "hero",
      destinationTile: [6, 4],
      action: attack,
      targetId: "goblin-a",
    });
    expect(() => ExecuteTurn.parse(turn)).not.toThrow();
  });

  it("carries an English rationale the player never authored", () => {
    // `ExecuteTurn.tacticalRationaleEnglish` is required and English by
    // invariant 2, while the player is typing Hebrew or not typing at all. So
    // the client synthesises a factual description of what was selected — it
    // exists so the log and the agent path carry the same shape.
    const turn = buildTurn({
      actorId: "hero",
      destinationTile: [6, 4],
      action: attack,
      targetId: "goblin-a",
    });
    expect(turn.tacticalRationaleEnglish).toBe(
      "Player selected: move to (6,4); attack goblin-a with spear.",
    );
    expect(/[֐-׿]/.test(turn.tacticalRationaleEnglish)).toBe(false);
  });

  it("omits movement entirely when no tile was chosen", () => {
    const turn = buildTurn({ actorId: "hero", action: dodge });
    // `toBeUndefined()` alone would also pass for `{ movement: undefined }`,
    // exactly the shape `exactOptionalPropertyTypes` forbids. `hasOwn` is
    // what actually distinguishes "key absent" from "key present but undefined".
    expect(Object.hasOwn(turn, "movement")).toBe(false);
    expect(turn.movement).toBeUndefined();
    expect(turn.mainAction).toStrictEqual({ actionType: "dodge" });
    expect(turn.tacticalRationaleEnglish).toBe("Player selected: dodge.");
  });

  it("omits targetIds for an action that needs none", () => {
    const turn = buildTurn({ actorId: "hero", destinationTile: [1, 1], action: dodge });
    expect(Object.hasOwn(turn.mainAction, "targetIds")).toBe(false);
    expect(turn.mainAction.targetIds).toBeUndefined();
    expect(turn.tacticalRationaleEnglish).toBe("Player selected: move to (1,1); dodge.");
  });

  it("describes a move-only selection", () => {
    expect(describeSelection({ actorId: "hero", destinationTile: [0, 3], action: dodge })).toBe(
      "Player selected: move to (0,3); dodge.",
    );
  });

  it("describes a target-only selection for an action with no actionId", () => {
    // `shove`, `grapple` and `help` take a target but carry no `actionId`,
    // so this is the middle rationale branch (target present, no actionId) —
    // a normal turn shape, not a theoretical one.
    const turn = buildTurn({ actorId: "hero", action: shove, targetId: "goblin-a" });
    expect(turn.tacticalRationaleEnglish).toBe("Player selected: shove goblin-a.");
  });
});
