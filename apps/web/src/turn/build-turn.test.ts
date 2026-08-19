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
    // `ExecuteTurn.tacticalRationaleEnglish` is required (C-1) and English by
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
    expect(turn.movement).toBeUndefined();
    expect(turn.mainAction).toEqual({ actionType: "dodge" });
    expect(turn.tacticalRationaleEnglish).toBe("Player selected: dodge.");
  });

  it("omits targetIds for an action that needs none", () => {
    const turn = buildTurn({ actorId: "hero", destinationTile: [1, 1], action: dodge });
    expect(turn.mainAction.targetIds).toBeUndefined();
    expect(turn.tacticalRationaleEnglish).toBe("Player selected: move to (1,1); dodge.");
  });

  it("describes a move-only selection", () => {
    expect(describeSelection({ actorId: "hero", destinationTile: [0, 3], action: dodge })).toBe(
      "Player selected: move to (0,3); dodge.",
    );
  });
});
