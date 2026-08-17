import { describe, expect, it } from "vitest";
import { deterministicFallback } from "./fallback.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const grid = parseGrid(`
  ......
  ......
  ......
`);

const goblin = combatant({ combatantId: "gob-1", faction: "hostile", position: [0, 0] });

function world(...combatants: ReturnType<typeof combatant>[]) {
  return { grid, combatants };
}

describe("deterministicFallback", () => {
  it("attacks an adjacent enemy", () => {
    const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });

    const fallback = deterministicFallback(goblin, world(goblin, hero));

    expect(fallback?.turn.mainAction.actionType).toBe("attack");
    expect(fallback?.turn.mainAction.targetIds).toStrictEqual(["pc-1"]);
  });

  it("returns the validated plan, so the caller never re-validates", () => {
    const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });

    const fallback = deterministicFallback(goblin, world(goblin, hero));

    expect(fallback?.plan.economyAfter.actionUsed).toBe(true);
  });

  it("attacks the nearest enemy when several are in reach", () => {
    const near = combatant({ combatantId: "pc-near", faction: "party", position: [1, 0] });
    const far = combatant({ combatantId: "pc-far", faction: "party", position: [4, 0] });
    const reacher = combatant({ ...goblin, reachFeet: 30 });

    const fallback = deterministicFallback(reacher, world(reacher, near, far));

    expect(fallback?.turn.mainAction.targetIds).toStrictEqual(["pc-near"]);
  });

  it("breaks a distance tie by id, so the same board always yields the same turn", () => {
    const bravo = combatant({ combatantId: "pc-bravo", faction: "party", position: [1, 0] });
    const alpha = combatant({ combatantId: "pc-alpha", faction: "party", position: [0, 1] });

    // bravo is listed first; alpha must still win on the id tiebreak.
    const fallback = deterministicFallback(goblin, world(goblin, bravo, alpha));

    expect(fallback?.turn.mainAction.targetIds).toStrictEqual(["pc-alpha"]);
  });

  it("dodges when no enemy is in reach", () => {
    const far = combatant({ combatantId: "pc-1", faction: "party", position: [5, 2] });

    const fallback = deterministicFallback(goblin, world(goblin, far));

    expect(fallback?.turn.mainAction.actionType).toBe("dodge");
  });

  it("dodges when there is no enemy at all", () => {
    const ally = combatant({ combatantId: "gob-2", faction: "hostile", position: [1, 0] });

    const fallback = deterministicFallback(goblin, world(goblin, ally));

    expect(fallback?.turn.mainAction.actionType).toBe("dodge");
  });

  it("ignores a downed enemy in favour of one still standing", () => {
    const downed = combatant({
      combatantId: "pc-down",
      faction: "party",
      position: [1, 0],
      status: "unconscious",
    });
    const upright = combatant({ combatantId: "pc-up", faction: "party", position: [0, 1] });

    const fallback = deterministicFallback(goblin, world(goblin, downed, upright));

    expect(fallback?.turn.mainAction.targetIds).toStrictEqual(["pc-up"]);
  });

  it("uses a ranged action when the caller supplies one", () => {
    const far = combatant({ combatantId: "pc-1", faction: "party", position: [5, 0] });
    const bowWorld = {
      ...world(goblin, far),
      actionRangesFeet: { shortbow: 80 },
    };

    const fallback = deterministicFallback(goblin, bowWorld, {
      availableActions: [{ actionId: "shortbow", name: "Shortbow" }],
    });

    expect(fallback?.turn.mainAction.actionType).toBe("attack");
    expect(fallback?.turn.mainAction.actionId).toBe("shortbow");
  });

  it("gives up when even dodging is illegal", () => {
    // Incapacitated: no action, no bonus action, no reaction.
    const stunned = combatant({
      combatantId: "gob-1",
      conditions: [{ condition: "stunned", durationRounds: 1 }],
    });
    const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });

    expect(deterministicFallback(stunned, world(stunned, hero))).toBeNull();
  });

  it("gives up when the actor has already spent its action", () => {
    const spent = combatant({
      combatantId: "gob-1",
      actionEconomy: {
        actionUsed: true,
        bonusActionUsed: false,
        reactionUsed: false,
        movementUsedFeet: 0,
        attacksMade: 0,
      },
    });
    const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });

    expect(deterministicFallback(spent, world(spent, hero))).toBeNull();
  });
});
