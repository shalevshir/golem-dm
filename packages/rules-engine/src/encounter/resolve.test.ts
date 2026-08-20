import { describe, expect, it } from "vitest";
import type { ExecuteTurn, MonsterStatBlock } from "@ai-dm/schemas";
import { validateExecuteTurn } from "../combat/index.js";
import type { Rng } from "../dice/index.js";
import { buildEncounter } from "./build.js";
import type { EncounterDefinition } from "./build.js";
import { applyTurn } from "./resolve.js";

function scripted(values: readonly number[]): Rng {
  let i = 0;
  return () => {
    const v = values[i++];
    if (v === undefined) throw new Error("scripted RNG exhausted");
    return v;
  };
}

/** rng value that makes rollDie(20) produce exactly `target`. */
function d20Exactly(target: number): number {
  return (target - 1) / 20 + 0.0001;
}

// Reproduces the geometry of tools/sim/src/scenarios/melee-brawl.ts's
// MELEE_BRAWL fixture: two goblin warriors meet two guards at close quarters
// on an empty 12x12 field. Stat blocks copied from data/srd/monsters/.
const GOBLIN_WARRIOR: MonsterStatBlock = {
  monsterId: "goblin_warrior",
  nameEnglish: "Goblin Warrior",
  nameHebrew: "גובלין לוחם",
  size: "small",
  creatureType: "Fey (Goblinoid)",
  alignment: "Chaotic Neutral",
  armorClass: 15,
  hitPoints: { average: 10, diceNotation: "3d6" },
  speedFeet: 30,
  abilities: { str: 8, dex: 15, con: 10, int: 10, wis: 8, cha: 8 },
  challengeRating: "1/4",
  proficiencyBonus: 2,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "scimitar",
      nameEnglish: "Scimitar",
      nameHebrew: "חרב מעוקלת",
      attackBonus: 4,
      reachFeet: 5,
      damage: { diceNotation: "1d6+2", averageDamage: 5, damageType: "slashing" },
      extraDamage: [],
    },
    {
      actionId: "shortbow",
      nameEnglish: "Shortbow",
      nameHebrew: "קשת קצרה",
      attackBonus: 4,
      rangeFeet: 80,
      longRangeFeet: 320,
      damage: { diceNotation: "1d6+2", averageDamage: 5, damageType: "piercing" },
      extraDamage: [],
    },
  ],
};

const GUARD: MonsterStatBlock = {
  monsterId: "guard",
  nameEnglish: "Guard",
  nameHebrew: "שומר",
  size: "medium",
  creatureType: "Humanoid",
  alignment: "Neutral",
  armorClass: 16,
  hitPoints: { average: 11, diceNotation: "2d8+2" },
  speedFeet: 30,
  abilities: { str: 13, dex: 12, con: 12, int: 10, wis: 11, cha: 10 },
  challengeRating: "1/8",
  proficiencyBonus: 2,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "spear",
      nameEnglish: "Spear",
      nameHebrew: "חנית",
      attackBonus: 3,
      reachFeet: 5,
      rangeFeet: 20,
      longRangeFeet: 60,
      damage: { diceNotation: "1d6+1", averageDamage: 4, damageType: "piercing" },
      extraDamage: [],
    },
  ],
};

const DEFINITION: EncounterDefinition = {
  encounterId: "melee-brawl",
  descriptionEnglish:
    "Two goblin warriors meet two guards at close quarters on an empty 12x12 field. " +
    "Baseline legality with no spatial reasoning required.",
  width: 12,
  height: 12,
  spawns: [
    { combatantId: "goblin_1", monsterId: "goblin_warrior", faction: "hostile", position: [4, 5] },
    { combatantId: "goblin_2", monsterId: "goblin_warrior", faction: "hostile", position: [4, 7] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [5, 5] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [5, 7] },
  ],
  turnOrder: ["goblin_1", "guard_1", "goblin_2", "guard_2"],
  maxRounds: 15,
};

const STAT_BLOCKS = new Map<string, MonsterStatBlock>([
  ["goblin_warrior", GOBLIN_WARRIOR],
  ["guard", GUARD],
]);

const built = buildEncounter({ definition: DEFINITION, statBlocks: STAT_BLOCKS });

function attack(actorId: string, targetId: string, actionId: string): ExecuteTurn {
  return {
    actorId,
    mainAction: { actionType: "attack", actionId, targetIds: [targetId] },
    tacticalRationaleEnglish: "Test fixture.",
  };
}

function resolve(turn: ExecuteTurn, rolls: readonly number[]) {
  const actor = built.world.combatants.find((each) => each.combatantId === turn.actorId);
  if (actor === undefined) throw new Error("no actor");
  const validation = validateExecuteTurn(turn, actor, built.world);
  if (!validation.valid) {
    throw new Error(
      `fixture turn is illegal: ${validation.rejections.map((r) => r.reason).join()}`,
    );
  }
  return applyTurn({
    world: built.world,
    actorId: turn.actorId,
    turn,
    plan: validation.plan,
    context: { statBlocks: built.statBlocks },
    rng: scripted(rolls),
  });
}

describe("applyTurn", () => {
  it("applies damage on a hit and leaves the input world untouched", () => {
    // Guard AC 16; scimitar +4 needs a 12. Roll 18, then 1d6 -> 4 (+2 = 6).
    const { world, effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [
      d20Exactly(18),
      0.5,
    ]);

    expect(effect.attacks).toHaveLength(1);
    expect(effect.attacks[0]?.outcome).toBe("hit");
    expect(effect.damageDealt).toBe(6);
    expect(effect.attacks[0]?.attackRoll).toEqual({
      naturalRoll: 18,
      rolls: [18],
      total: 22,
      targetArmorClass: 16,
    });
    expect(effect.attacks[0]?.damageRolls).toEqual([
      { kind: "dice", notation: "1d6+2", rolls: [4], modifier: 2, total: 6 },
    ]);

    const after = world.combatants.find((each) => each.combatantId === "guard_1");
    const before = built.world.combatants.find((each) => each.combatantId === "guard_1");
    expect(after?.currentHp).toBe((before?.currentHp ?? 0) - 6);
    expect(before?.currentHp).toBe(before?.maxHp);
  });

  it("deals no damage on a miss", () => {
    const { effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [d20Exactly(3)]);

    expect(effect.attacks[0]?.outcome).toBe("miss");
    expect(effect.damageDealt).toBe(0);
    expect(effect.attacks[0]?.attackRoll).toEqual({
      naturalRoll: 3,
      rolls: [3],
      total: 7,
      targetArmorClass: 16,
    });
    expect(effect.attacks[0]?.damageRolls).toEqual([]);
  });

  it("doubles only the damage dice on a critical hit", () => {
    // Natural 20, then two d6 at 0.5 -> 4 each, plus the +2 modifier once.
    const { effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [
      d20Exactly(20),
      0.5,
      0.5,
    ]);

    expect(effect.attacks[0]?.outcome).toBe("critical_hit");
    expect(effect.damageDealt).toBe(10);
    expect(effect.attacks[0]?.attackRoll).toEqual({
      naturalRoll: 20,
      rolls: [20],
      total: 24,
      targetArmorClass: 16,
    });
    // The dice double (two rolls), the notation and modifier do not.
    expect(effect.attacks[0]?.damageRolls).toEqual([
      { kind: "dice", notation: "1d6+2", rolls: [4, 4], modifier: 2, total: 10 },
    ]);
  });

  it("kills a monster outright at 0 HP rather than downing it", () => {
    const wounded = {
      ...built.world,
      combatants: built.world.combatants.map((each) =>
        each.combatantId === "guard_1" ? { ...each, currentHp: 3 } : each,
      ),
    };
    const turn = attack("goblin_1", "guard_1", "scimitar");
    const actor = wounded.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const validation = validateExecuteTurn(turn, actor, wounded);
    if (!validation.valid) throw new Error("fixture turn is illegal");

    const { world, effect } = applyTurn({
      world: wounded,
      actorId: "goblin_1",
      turn,
      plan: validation.plan,
      context: { statBlocks: built.statBlocks },
      rng: scripted([d20Exactly(18), 0.5]),
    });

    expect(effect.killed).toEqual(["guard_1"]);
    expect(world.combatants.find((each) => each.combatantId === "guard_1")?.status).toBe("dead");
  });

  it("kills a PC outright at 0 HP too -- death saves are not implemented (R45/C-31)", () => {
    // Same fixture as "kills a monster outright at 0 HP", but the target now
    // carries a populated characterId. Before the pin, resolve.ts read
    // `diesAtZeroHp: target.characterId === undefined`, which is false here --
    // this would have failed with status "unconscious". The pin makes it
    // "dead" regardless of characterId.
    const wounded = {
      ...built.world,
      combatants: built.world.combatants.map((each) =>
        each.combatantId === "guard_1" ? { ...each, currentHp: 3, characterId: "guard_1" } : each,
      ),
    };
    const turn = attack("goblin_1", "guard_1", "scimitar");
    const actor = wounded.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const validation = validateExecuteTurn(turn, actor, wounded);
    if (!validation.valid) throw new Error("fixture turn is illegal");

    const { world, effect } = applyTurn({
      world: wounded,
      actorId: "goblin_1",
      turn,
      plan: validation.plan,
      context: { statBlocks: built.statBlocks },
      rng: scripted([d20Exactly(18), 0.5]),
    });

    expect(effect.killed).toEqual(["guard_1"]);
    const target = world.combatants.find((each) => each.combatantId === "guard_1");
    expect(target?.status).toBe("dead");
  });

  it("records flat damage as kind: flat, with no dice rolled", () => {
    const flatDamageBlock: MonsterStatBlock = {
      ...GOBLIN_WARRIOR,
      monsterId: "cultist_test_fixture",
      actions: [
        {
          actionId: "dagger",
          nameEnglish: "Dagger",
          nameHebrew: "פגיון",
          attackBonus: 4,
          reachFeet: 5,
          damage: { averageDamage: 1, damageType: "piercing" }, // no diceNotation
          extraDamage: [],
        },
      ],
    };
    // ResolveContext.statBlocks is keyed by combatantId (see its doc comment
    // and every other test in this file, e.g. `built.statBlocks`) -- override
    // goblin_1's entry rather than adding an unreferenced monsterId key.
    const statBlocks = new Map([...built.statBlocks, ["goblin_1", flatDamageBlock]]);
    const actor = built.world.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const turn = attack("goblin_1", "guard_1", "dagger");
    const validation = validateExecuteTurn(turn, actor, built.world);
    if (!validation.valid) {
      throw new Error(
        `fixture turn is illegal: ${validation.rejections.map((r) => r.reason).join()}`,
      );
    }
    const { effect } = applyTurn({
      world: built.world,
      actorId: "goblin_1",
      turn,
      plan: validation.plan,
      context: { statBlocks },
      rng: scripted([d20Exactly(18)]),
    });

    expect(effect.attacks[0]?.outcome).toBe("hit");
    expect(effect.attacks[0]?.damageRolls).toEqual([{ kind: "flat", total: 1 }]);
    expect(effect.damageDealt).toBe(1);
  });

  it("gives each extra-damage rider its own entry in damageRolls", () => {
    const riderBlock: MonsterStatBlock = {
      ...GOBLIN_WARRIOR,
      monsterId: "rider_test_fixture",
      actions: [
        {
          actionId: "scimitar",
          nameEnglish: "Scimitar",
          nameHebrew: "חרב מעוקלת",
          attackBonus: 4,
          reachFeet: 5,
          damage: { diceNotation: "1d6+2", averageDamage: 5, damageType: "slashing" },
          extraDamage: [{ diceNotation: "1d4", averageDamage: 2, damageType: "poison" }],
        },
      ],
    };
    const statBlocks = new Map([...built.statBlocks, ["goblin_1", riderBlock]]);
    const actor = built.world.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const turn = attack("goblin_1", "guard_1", "scimitar");
    const validation = validateExecuteTurn(turn, actor, built.world);
    if (!validation.valid) {
      throw new Error(
        `fixture turn is illegal: ${validation.rejections.map((r) => r.reason).join()}`,
      );
    }
    // Attack roll: 18. Main damage 1d6+2 at 0.5 -> floor(0.5*6)+1=4, +2=6.
    // Extra 1d4 at 0.5 -> floor(0.5*4)+1=3 (a d4 and a d6 give DIFFERENT
    // faces for the same 0.5 rng value -- rollDie's formula is
    // floor(rng()*sides)+1, so this is not the same 4 the d6 above rolled).
    const { effect } = applyTurn({
      world: built.world,
      actorId: "goblin_1",
      turn,
      plan: validation.plan,
      context: { statBlocks },
      rng: scripted([d20Exactly(18), 0.5, 0.5]),
    });

    expect(effect.attacks[0]?.damageRolls).toEqual([
      { kind: "dice", notation: "1d6+2", rolls: [4], modifier: 2, total: 6 },
      { kind: "dice", notation: "1d4", rolls: [3], modifier: 0, total: 3 },
    ]);
    expect(effect.damageDealt).toBe(9);
  });

  it("flags a non-attack action as mechanically inert", () => {
    const dodge: ExecuteTurn = {
      actorId: "goblin_1",
      mainAction: { actionType: "dodge" },
      tacticalRationaleEnglish: "Test fixture.",
    };
    const { effect } = resolve(dodge, []);

    expect(effect.nonAttackAction).toBe(true);
    expect(effect.attacks).toHaveLength(0);
  });

  it("records an action the actor does not own instead of throwing", () => {
    // The validator resolves ranges from a world-wide map and never checks that
    // an actionId belongs to the actor, so this turn is legal but unresolvable.
    const foreign = attack("goblin_1", "guard_1", "greatclub");
    const actor = built.world.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const validation = validateExecuteTurn(foreign, actor, built.world);
    if (!validation.valid) throw new Error("expected the engine to accept a foreign actionId");

    const { effect } = applyTurn({
      world: built.world,
      actorId: "goblin_1",
      turn: foreign,
      plan: validation.plan,
      context: { statBlocks: built.statBlocks },
      rng: scripted([]),
    });

    expect(effect.unresolvedActionIds).toEqual(["greatclub"]);
    expect(effect.attacks).toHaveLength(0);
  });

  it("moves the actor to the last segment's destination", () => {
    const move: ExecuteTurn = {
      actorId: "goblin_2",
      movement: [{ destinationTile: [4, 8], pathType: "direct" }],
      mainAction: { actionType: "dodge" },
      tacticalRationaleEnglish: "Test fixture.",
    };
    const { world, effect } = resolve(move, []);

    expect(world.combatants.find((each) => each.combatantId === "goblin_2")?.position).toEqual([
      4, 8,
    ]);
    expect(effect.movedFeet).toBe(5);
  });
});
