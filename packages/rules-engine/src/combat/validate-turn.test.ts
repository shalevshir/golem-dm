import { describe, expect, it } from "vitest";
import type { Combatant, ExecuteTurn } from "@ai-dm/schemas";
import { validateExecuteTurn } from "./validate-turn.js";
import type { CombatWorld, TurnRejectionReason, TurnValidation } from "./validate-turn.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const OPEN_FIELD = parseGrid(`
  ..........
  ..........
  ..........
`);

function turn(overrides: Partial<ExecuteTurn> & Pick<ExecuteTurn, "mainAction">): ExecuteTurn {
  return {
    actorId: "hero",
    tacticalRationaleEnglish: "Test proposal.",
    ...overrides,
  };
}

function world(overrides: Partial<CombatWorld> & Pick<CombatWorld, "combatants">): CombatWorld {
  return { grid: OPEN_FIELD, ...overrides };
}

function reasons(result: TurnValidation): TurnRejectionReason[] {
  return result.valid ? [] : result.rejections.map((rejection) => rejection.reason);
}

const hero = combatant({ combatantId: "hero", faction: "party", position: [0, 0] });
const goblin = combatant({ combatantId: "gob", position: [1, 0] });

describe("validateExecuteTurn — accepted turns", () => {
  it("accepts an attack on an adjacent target", () => {
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] } }),
      hero,
      world({ combatants: [hero, goblin] }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts a move-then-attack and reports the movement cost", () => {
    const target = combatant({ combatantId: "gob", position: [3, 0] });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [2, 0], pathType: "direct" }],
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] },
      }),
      hero,
      world({ combatants: [hero, target] }),
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.plan.totalMovementFeet).toBe(10);
    expect(result.valid && result.plan.segments[0]?.path).toStrictEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  it("measures reach from the tile the actor moves to, not the tile it started on", () => {
    const target = combatant({ combatantId: "gob", position: [3, 0] });
    const standingStill = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] } }),
      hero,
      world({ combatants: [hero, target] }),
    );
    expect(reasons(standingStill)).toContain("target_out_of_reach");

    const afterClosing = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [2, 0], pathType: "direct" }],
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] },
      }),
      hero,
      world({ combatants: [hero, target] }),
    );
    expect(afterClosing.valid).toBe(true);
  });

  it("reports the economy the actor is left with", () => {
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [0, 1], pathType: "direct" }],
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] },
        bonusAction: { abilityId: "second_wind" },
      }),
      hero,
      world({ combatants: [hero, goblin] }),
    );
    expect(result.valid && result.plan.economyAfter).toStrictEqual({
      actionUsed: true,
      bonusActionUsed: true,
      reactionUsed: false,
      movementUsedFeet: 5,
      attacksMade: 1,
    });
  });

  it("accepts a cantrip, which consumes no spell slot", () => {
    const caster = combatant({ combatantId: "hero", faction: "party", spellSlots: {} });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "cast_spell", actionId: "fire_bolt", targetIds: ["gob"] } }),
      caster,
      world({ combatants: [caster, goblin], actionRangesFeet: { fire_bolt: 120 } }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts a spell paid for with an available slot", () => {
    const caster = combatant({
      combatantId: "hero",
      faction: "party",
      spellSlots: { "1": { max: 2, current: 1 } },
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: {
          actionType: "cast_spell",
          actionId: "magic_missile",
          slotLevel: 1,
          targetIds: ["gob"],
        },
      }),
      caster,
      world({ combatants: [caster, goblin], actionRangesFeet: { magic_missile: 120 } }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts a target behind partial cover — only full cover is untargetable", () => {
    const grid = parseGrid(`
      .....
      ..q..
      .....
    `);
    const archer = combatant({ combatantId: "hero", faction: "party", position: [0, 1] });
    const target = combatant({ combatantId: "gob", position: [4, 1] });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "shortbow", targetIds: ["gob"] } }),
      archer,
      { grid, combatants: [archer, target], actionRangesFeet: { shortbow: 80 } },
    );
    expect(result.valid).toBe(true);
  });

  it("accepts an untargeted action such as Dodge", () => {
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "dodge" } }),
      hero,
      world({ combatants: [hero, goblin] }),
    );
    expect(result.valid).toBe(true);
  });
});

describe("validateExecuteTurn — movement", () => {
  it("rejects movement beyond the actor's speed", () => {
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [9, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      world({ combatants: [hero] }),
    );
    expect(result.valid).toBe(false);
    expect(reasons(result)).toContain("movement_exceeds_speed");
  });

  it("counts difficult terrain at double cost against the budget", () => {
    const grid = parseGrid(`~~~~~~~~~~`);
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [4, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      { grid, combatants: [hero] },
    );
    expect(reasons(result)).toContain("movement_exceeds_speed");
  });

  it("counts movement already spent earlier in the turn", () => {
    const winded = combatant({
      combatantId: "hero",
      faction: "party",
      actionEconomy: {
        actionUsed: false,
        bonusActionUsed: false,
        reactionUsed: false,
        movementUsedFeet: 25,
        attacksMade: 0,
      },
    });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [2, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      winded,
      world({ combatants: [winded] }),
    );
    expect(reasons(result)).toContain("movement_exceeds_speed");
  });

  it("doubles the movement budget when the actor Dashes", () => {
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [9, 0], pathType: "direct" }],
        mainAction: { actionType: "dash" },
      }),
      hero,
      world({ combatants: [hero] }),
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.plan.movementBudgetFeet).toBe(60);
  });

  it("rejects a path that no route can reach through blocking terrain", () => {
    const grid = parseGrid(`
      ...
      ###
      ...
    `);
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [0, 2], pathType: "retreat_to_cover" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      { grid, combatants: [hero] },
    );
    expect(reasons(result)).toStrictEqual(["movement_path_blocked"]);
  });

  it("rejects a destination that is itself impassable", () => {
    const grid = parseGrid(`.#.`);
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [1, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      { grid, combatants: [hero] },
    );
    expect(reasons(result)).toStrictEqual(["movement_path_blocked"]);
  });

  it("rejects a destination outside the grid", () => {
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [40, 40], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      world({ combatants: [hero] }),
    );
    expect(reasons(result)).toStrictEqual(["destination_off_grid"]);
  });

  it("rejects ending movement on a tile another combatant occupies", () => {
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [1, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      world({ combatants: [hero, goblin] }),
    );
    expect(reasons(result)).toContain("destination_occupied");
  });

  it("still treats an unconscious combatant's space as occupied", () => {
    const downed = combatant({ combatantId: "gob", position: [1, 0], status: "unconscious" });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [1, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      world({ combatants: [hero, downed] }),
    );
    expect(reasons(result)).toContain("destination_occupied");
  });

  it.each(["dead", "fled"] as const)("lets the actor move onto a %s combatant's tile", (status) => {
    const gone = combatant({ combatantId: "gob", position: [1, 0], status });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [1, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      world({ combatants: [hero, gone] }),
    );
    expect(result.valid).toBe(true);
  });

  it("sums the cost of every ordered segment of a move–attack–move turn", () => {
    const result = validateExecuteTurn(
      turn({
        movement: [
          { destinationTile: [2, 0], pathType: "direct" },
          { destinationTile: [2, 2], pathType: "retreat_to_cover" },
        ],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      world({ combatants: [hero] }),
    );
    expect(result.valid && result.plan.totalMovementFeet).toBe(20);
  });

  it("rejects movement while grappled", () => {
    const grappled = combatant({
      combatantId: "hero",
      faction: "party",
      conditions: [{ condition: "grappled", durationRounds: null }],
    });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [1, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      grappled,
      world({ combatants: [grappled] }),
    );
    expect(reasons(result)).toStrictEqual(["actor_cannot_move"]);
  });

  it("halves the distance a prone actor covers — crawling costs an extra foot per foot", () => {
    const prone = combatant({
      combatantId: "hero",
      faction: "party",
      conditions: [{ condition: "prone", durationRounds: null }],
    });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [6, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      prone,
      world({ combatants: [prone] }),
    );
    expect(reasons(result)).toStrictEqual(["movement_exceeds_speed"]);
  });

  it("lets a prone actor cover half its speed", () => {
    const prone = combatant({
      combatantId: "hero",
      faction: "party",
      conditions: [{ condition: "prone", durationRounds: null }],
    });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [3, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      prone,
      world({ combatants: [prone] }),
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.plan.movementBudgetFeet).toBe(15);
  });

  it("reduces the budget by 5 ft per level of exhaustion", () => {
    const tired = combatant({ combatantId: "hero", faction: "party", exhaustionLevel: 2 });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [5, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      tired,
      world({ combatants: [tired] }),
    );
    expect(reasons(result)).toContain("movement_exceeds_speed");
  });
});

describe("validateExecuteTurn — action economy", () => {
  it("rejects a second action in the same turn", () => {
    const spent = combatant({
      combatantId: "hero",
      faction: "party",
      actionEconomy: {
        actionUsed: true,
        bonusActionUsed: false,
        reactionUsed: false,
        movementUsedFeet: 0,
        attacksMade: 0,
      },
    });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] } }),
      spent,
      world({ combatants: [spent, goblin] }),
    );
    expect(reasons(result)).toStrictEqual(["action_already_used"]);
  });

  it("rejects a second bonus action in the same turn", () => {
    const spent = combatant({
      combatantId: "hero",
      faction: "party",
      actionEconomy: {
        actionUsed: false,
        bonusActionUsed: true,
        reactionUsed: false,
        movementUsedFeet: 0,
        attacksMade: 0,
      },
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "dodge" },
        bonusAction: { abilityId: "second_wind" },
      }),
      spent,
      world({ combatants: [spent] }),
    );
    expect(reasons(result)).toStrictEqual(["bonus_action_already_used"]);
  });

  it("rejects more attacks than the actor's Attack action grants", () => {
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] },
        extraAttacks: [{ actionId: "longsword", targetId: "gob" }],
      }),
      hero,
      world({ combatants: [hero, goblin] }),
    );
    expect(reasons(result)).toStrictEqual(["extra_attacks_exceed_budget"]);
  });

  it("accepts a second attack from a combatant with Extra Attack", () => {
    const fighter = combatant({
      combatantId: "hero",
      faction: "party",
      attacksPerAction: 2,
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] },
        extraAttacks: [{ actionId: "longsword", targetId: "gob" }],
      }),
      fighter,
      world({ combatants: [fighter, goblin] }),
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.plan.economyAfter.attacksMade).toBe(2);
  });

  it("rejects the Attack action itself once the attack budget is already spent", () => {
    const spent = combatant({
      combatantId: "hero",
      faction: "party",
      actionEconomy: {
        actionUsed: false,
        bonusActionUsed: false,
        reactionUsed: false,
        movementUsedFeet: 0,
        attacksMade: 1,
      },
    });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] } }),
      spent,
      world({ combatants: [spent, goblin] }),
    );
    expect(reasons(result)).toStrictEqual(["extra_attacks_exceed_budget"]);
  });

  it("reports an exhausted attack budget once, not once per proposed swing", () => {
    const spent = combatant({
      combatantId: "hero",
      faction: "party",
      actionEconomy: {
        actionUsed: false,
        bonusActionUsed: false,
        reactionUsed: false,
        movementUsedFeet: 0,
        attacksMade: 1,
      },
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] },
        extraAttacks: [{ actionId: "longsword", targetId: "gob" }],
      }),
      spent,
      world({ combatants: [spent, goblin] }),
    );
    expect(reasons(result)).toStrictEqual(["extra_attacks_exceed_budget"]);
  });

  it("counts one attack per target the Attack action names", () => {
    const left = combatant({ combatantId: "left", position: [0, 0] });
    const right = combatant({ combatantId: "right", position: [2, 0] });
    const middle = combatant({ combatantId: "hero", faction: "party", position: [1, 0] });
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["left", "right"] },
      }),
      middle,
      world({ combatants: [middle, left, right] }),
    );
    expect(reasons(result)).toStrictEqual(["extra_attacks_exceed_budget"]);
  });

  it("accepts two named targets when the actor has Extra Attack", () => {
    const left = combatant({ combatantId: "left", position: [0, 0] });
    const right = combatant({ combatantId: "right", position: [2, 0] });
    const middle = combatant({
      combatantId: "hero",
      faction: "party",
      position: [1, 0],
      attacksPerAction: 2,
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["left", "right"] },
      }),
      middle,
      world({ combatants: [middle, left, right] }),
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.plan.economyAfter.attacksMade).toBe(2);
  });

  it("does not count targets of a spell against the attack budget", () => {
    const caster = combatant({
      combatantId: "hero",
      faction: "party",
      position: [1, 0],
      spellSlots: { "1": { max: 2, current: 2 } },
    });
    const left = combatant({ combatantId: "left", position: [0, 0] });
    const right = combatant({ combatantId: "right", position: [2, 0] });
    const result = validateExecuteTurn(
      turn({
        mainAction: {
          actionType: "cast_spell",
          actionId: "magic_missile",
          slotLevel: 1,
          targetIds: ["left", "right"],
        },
      }),
      caster,
      world({ combatants: [caster, left, right], actionRangesFeet: { magic_missile: 120 } }),
    );
    expect(result.valid).toBe(true);
    expect(result.valid && result.plan.economyAfter.attacksMade).toBe(0);
  });

  it("rejects extra attacks appended to something other than the Attack action", () => {
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "dodge" },
        extraAttacks: [{ actionId: "longsword", targetId: "gob" }],
      }),
      hero,
      world({ combatants: [hero, goblin] }),
    );
    expect(reasons(result)).toContain("extra_attacks_without_attack_action");
  });

  it("validates the target of each extra attack", () => {
    const fighter = combatant({ combatantId: "hero", faction: "party", attacksPerAction: 2 });
    const far = combatant({ combatantId: "far", position: [8, 0] });
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] },
        extraAttacks: [{ actionId: "longsword", targetId: "far" }],
      }),
      fighter,
      world({ combatants: [fighter, goblin, far] }),
    );
    expect(reasons(result)).toContain("target_out_of_reach");
  });
});

describe("validateExecuteTurn — targeting", () => {
  it("rejects an attack on a target behind full cover", () => {
    const grid = parseGrid(`
      .....
      ..#..
      .....
    `);
    const archer = combatant({ combatantId: "hero", faction: "party", position: [0, 1] });
    const target = combatant({ combatantId: "gob", position: [4, 1] });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "shortbow", targetIds: ["gob"] } }),
      archer,
      { grid, combatants: [archer, target], actionRangesFeet: { shortbow: 80 } },
    );
    expect(reasons(result)).toStrictEqual(["target_behind_full_cover"]);
  });

  it("rejects a melee attack on a target beyond the actor's reach", () => {
    const target = combatant({ combatantId: "gob", position: [3, 0] });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] } }),
      hero,
      world({ combatants: [hero, target] }),
    );
    expect(reasons(result)).toStrictEqual(["target_out_of_reach"]);
  });

  it("accepts a reach weapon against a target 10 ft away", () => {
    const halberdier = combatant({ combatantId: "hero", faction: "party", reachFeet: 10 });
    const target = combatant({ combatantId: "gob", position: [2, 0] });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "halberd", targetIds: ["gob"] } }),
      halberdier,
      world({ combatants: [halberdier, target] }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a ranged attack beyond the action's range", () => {
    const target = combatant({ combatantId: "gob", position: [8, 0] });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "dart", targetIds: ["gob"] } }),
      hero,
      world({ combatants: [hero, target], actionRangesFeet: { dart: 20 } }),
    );
    expect(reasons(result)).toStrictEqual(["target_out_of_reach"]);
  });

  it("names the offending target so the agent can retry against another", () => {
    const target = combatant({ combatantId: "gob", position: [8, 0] });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] } }),
      hero,
      world({ combatants: [hero, target] }),
    );
    expect(result.valid).toBe(false);
    expect(result.valid || result.rejections[0]?.subjectId).toBe("gob");
  });

  it("falls back to the actor's reach for an action that carries no actionId", () => {
    const target = combatant({ combatantId: "gob", position: [3, 0] });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "shove", targetIds: ["gob"] } }),
      hero,
      world({ combatants: [hero, target] }),
    );
    expect(reasons(result)).toStrictEqual(["target_out_of_reach"]);
  });

  it("accepts an actionId-less shove against an adjacent target", () => {
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "shove", targetIds: ["gob"] } }),
      hero,
      world({ combatants: [hero, goblin] }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a target that is not in the encounter", () => {
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["ghost"] } }),
      hero,
      world({ combatants: [hero, goblin] }),
    );
    expect(reasons(result)).toStrictEqual(["target_not_found"]);
  });
});

describe("validateExecuteTurn — spellcasting", () => {
  it("rejects casting at a level whose slots are spent", () => {
    const caster = combatant({
      combatantId: "hero",
      faction: "party",
      spellSlots: { "1": { max: 2, current: 0 } },
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: {
          actionType: "cast_spell",
          actionId: "magic_missile",
          slotLevel: 1,
          targetIds: ["gob"],
        },
      }),
      caster,
      world({ combatants: [caster, goblin], actionRangesFeet: { magic_missile: 120 } }),
    );
    expect(reasons(result)).toStrictEqual(["spell_slot_unavailable"]);
  });

  it("rejects casting at a level the actor has no slots for at all", () => {
    const caster = combatant({
      combatantId: "hero",
      faction: "party",
      spellSlots: { "1": { max: 2, current: 2 } },
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: {
          actionType: "cast_spell",
          actionId: "fireball",
          slotLevel: 3,
          targetIds: ["gob"],
        },
      }),
      caster,
      world({ combatants: [caster, goblin], actionRangesFeet: { fireball: 150 } }),
    );
    expect(reasons(result)).toStrictEqual(["spell_slot_unavailable"]);
  });

  it("names the slot level when the spell carries no actionId", () => {
    const caster = combatant({ combatantId: "hero", faction: "party", spellSlots: {} });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "cast_spell", slotLevel: 2, targetIds: ["gob"] } }),
      caster,
      world({ combatants: [caster, goblin] }),
    );
    expect(result.valid).toBe(false);
    expect(result.valid || result.rejections[0]?.subjectId).toBe("2");
  });

  it("spends the slot in the reported plan", () => {
    const caster = combatant({
      combatantId: "hero",
      faction: "party",
      spellSlots: { "1": { max: 2, current: 2 } },
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: {
          actionType: "cast_spell",
          actionId: "magic_missile",
          slotLevel: 1,
          targetIds: ["gob"],
        },
      }),
      caster,
      world({ combatants: [caster, goblin], actionRangesFeet: { magic_missile: 120 } }),
    );
    expect(result.valid && result.plan.spellSlotsAfter["1"]?.current).toBe(1);
  });
});

describe("validateExecuteTurn — actor legality", () => {
  it.each(["incapacitated", "paralyzed", "stunned", "unconscious", "petrified"] as const)(
    "rejects acting while %s",
    (condition) => {
      const afflicted = combatant({
        combatantId: "hero",
        faction: "party",
        conditions: [{ condition, durationRounds: null }],
      });
      const result = validateExecuteTurn(
        turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] } }),
        afflicted,
        world({ combatants: [afflicted, goblin] }),
      );
      expect(reasons(result)).toContain("actor_incapacitated");
    },
  );

  it("rejects a bonus action while incapacitated", () => {
    const afflicted = combatant({
      combatantId: "hero",
      faction: "party",
      conditions: [{ condition: "incapacitated", durationRounds: 1 }],
    });
    const result = validateExecuteTurn(
      turn({
        mainAction: { actionType: "dodge" },
        bonusAction: { abilityId: "second_wind" },
      }),
      afflicted,
      world({ combatants: [afflicted] }),
    );
    expect(reasons(result)).toContain("actor_incapacitated");
  });

  it("still allows a prone actor to act", () => {
    const prone = combatant({
      combatantId: "hero",
      faction: "party",
      conditions: [{ condition: "prone", durationRounds: null }],
    });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] } }),
      prone,
      world({ combatants: [prone, goblin] }),
    );
    expect(result.valid).toBe(true);
  });

  it.each(["dead", "fled"] as const)("rejects a turn from a %s combatant", (status) => {
    const gone: Combatant = combatant({ combatantId: "hero", faction: "party", status });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "dodge" } }),
      gone,
      world({ combatants: [gone] }),
    );
    expect(reasons(result)).toStrictEqual(["actor_cannot_act"]);
  });

  it("rejects a turn addressed to a different combatant", () => {
    const result = validateExecuteTurn(
      turn({ actorId: "someone-else", mainAction: { actionType: "dodge" } }),
      hero,
      world({ combatants: [hero] }),
    );
    expect(reasons(result)).toStrictEqual(["actor_mismatch"]);
  });

  it("kills the turn outright at exhaustion level 6", () => {
    const spent = combatant({ combatantId: "hero", faction: "party", exhaustionLevel: 6 });
    const result = validateExecuteTurn(
      turn({ mainAction: { actionType: "dodge" } }),
      spent,
      world({ combatants: [spent] }),
    );
    expect(reasons(result)).toStrictEqual(["actor_cannot_act"]);
  });
});

describe("validateExecuteTurn — rejection reporting", () => {
  it("collects every independent reason so the agent can retry once with all of them", () => {
    const target = combatant({ combatantId: "gob", position: [9, 2] });
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [9, 0], pathType: "direct" }],
        mainAction: { actionType: "attack", actionId: "longsword", targetIds: ["gob"] },
      }),
      hero,
      world({ combatants: [hero, target] }),
    );
    expect(reasons(result)).toStrictEqual(["movement_exceeds_speed", "target_out_of_reach"]);
  });

  it("carries an English message alongside every machine-readable reason", () => {
    const result = validateExecuteTurn(
      turn({
        movement: [{ destinationTile: [9, 0], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      }),
      hero,
      world({ combatants: [hero] }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.rejections[0]?.message).toMatch(/45 ft/);
    expect(result.rejections[0]?.message).toMatch(/30 ft/);
  });
});
