import { describe, expect, it } from "vitest";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { actionRangesFeetFrom, combatantFromStatBlock, meleeReachFeet } from "./statblock.js";
import { validateExecuteTurn } from "./validate-turn.js";
import { combatant, parseGrid } from "./test-fixtures.js";

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

const [SCIMITAR, SHORTBOW] = GOBLIN_WARRIOR.actions;
if (SCIMITAR === undefined || SHORTBOW === undefined) throw new Error("fixture is malformed");

const OGRE: MonsterStatBlock = {
  ...GOBLIN_WARRIOR,
  monsterId: "ogre",
  nameEnglish: "Ogre",
  nameHebrew: "אוגר",
  size: "large",
  armorClass: 11,
  hitPoints: { average: 68, diceNotation: "8d10+24" },
  speedFeet: 40,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "greatclub",
      nameEnglish: "Greatclub",
      nameHebrew: "אלה גדולה",
      attackBonus: 6,
      reachFeet: 5,
      damage: { diceNotation: "2d8+4", averageDamage: 13, damageType: "bludgeoning" },
      extraDamage: [],
    },
  ],
};

describe("combatantFromStatBlock", () => {
  it("carries the stat block's combat numbers across", () => {
    const spawned = combatantFromStatBlock(GOBLIN_WARRIOR, {
      combatantId: "gob-1",
      faction: "hostile",
      position: [3, 4],
    });
    expect(spawned).toMatchObject({
      combatantId: "gob-1",
      faction: "hostile",
      position: [3, 4],
      size: "small",
      speedFeet: 30,
      armorClass: 15,
      maxHp: 10,
      currentHp: 10,
      status: "alive",
    });
  });

  it("opens with a fresh action economy", () => {
    const spawned = combatantFromStatBlock(GOBLIN_WARRIOR, {
      combatantId: "gob-1",
      faction: "hostile",
      position: [0, 0],
    });
    expect(spawned.actionEconomy).toStrictEqual({
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementUsedFeet: 0,
      attacksMade: 0,
    });
  });

  it("takes the printed average for hit points so spawning stays deterministic", () => {
    const a = combatantFromStatBlock(OGRE, {
      combatantId: "a",
      faction: "hostile",
      position: [0, 0],
    });
    const b = combatantFromStatBlock(OGRE, {
      combatantId: "b",
      faction: "hostile",
      position: [1, 0],
    });
    expect(a.maxHp).toBe(68);
    expect(b.maxHp).toBe(a.maxHp);
  });

  it("accepts a rolled hit point total when the caller wants variety", () => {
    const spawned = combatantFromStatBlock(OGRE, {
      combatantId: "a",
      faction: "hostile",
      position: [0, 0],
      currentHp: 55,
    });
    expect(spawned.currentHp).toBe(55);
    expect(spawned.maxHp).toBe(68);
  });

  it("carries size through, so a Large monster fills its space", () => {
    const spawned = combatantFromStatBlock(OGRE, {
      combatantId: "ogre",
      faction: "hostile",
      position: [0, 0],
    });
    expect(spawned.size).toBe("large");
  });
});

describe("meleeReachFeet", () => {
  it("takes the longest melee reach on the stat block", () => {
    expect(meleeReachFeet(GOBLIN_WARRIOR)).toBe(5);
  });

  it("falls back to 5 ft for a creature with only ranged attacks", () => {
    const archer: MonsterStatBlock = { ...GOBLIN_WARRIOR, actions: [SHORTBOW] };
    expect(meleeReachFeet(archer)).toBe(5);
  });
});

describe("actionRangesFeetFrom", () => {
  it("uses the normal range of a ranged attack", () => {
    expect(actionRangesFeetFrom([GOBLIN_WARRIOR]).shortbow).toBe(80);
  });

  it("uses reach for a melee attack", () => {
    expect(actionRangesFeetFrom([GOBLIN_WARRIOR]).scimitar).toBe(5);
  });

  it("keeps the longer reach when two stat blocks share a weapon", () => {
    const reachGoblin: MonsterStatBlock = {
      ...GOBLIN_WARRIOR,
      monsterId: "goblin_pikeman",
      actions: [{ ...SCIMITAR, reachFeet: 10 }],
    };
    expect(actionRangesFeetFrom([GOBLIN_WARRIOR, reachGoblin]).scimitar).toBe(10);
  });

  it("feeds the validator so a real shortbow shot is legal at 40 ft", () => {
    const grid = parseGrid(`..........`);
    const archer = combatantFromStatBlock(GOBLIN_WARRIOR, {
      combatantId: "gob",
      faction: "hostile",
      position: [0, 0],
    });
    const target = combatant({ combatantId: "pc", faction: "party", position: [8, 0] });
    const result = validateExecuteTurn(
      {
        actorId: "gob",
        mainAction: { actionType: "attack", actionId: "shortbow", targetIds: ["pc"] },
        tacticalRationaleEnglish: "Shoot from range.",
      },
      archer,
      {
        grid,
        combatants: [archer, target],
        actionRangesFeet: actionRangesFeetFrom([GOBLIN_WARRIOR]),
      },
    );
    expect(result.valid).toBe(true);
  });

  it("still rejects a scimitar swing at 40 ft", () => {
    const grid = parseGrid(`..........`);
    const attacker = combatantFromStatBlock(GOBLIN_WARRIOR, {
      combatantId: "gob",
      faction: "hostile",
      position: [0, 0],
    });
    const target = combatant({ combatantId: "pc", faction: "party", position: [8, 0] });
    const result = validateExecuteTurn(
      {
        actorId: "gob",
        mainAction: { actionType: "attack", actionId: "scimitar", targetIds: ["pc"] },
        tacticalRationaleEnglish: "Swing wildly from across the room.",
      },
      attacker,
      {
        grid,
        combatants: [attacker, target],
        actionRangesFeet: actionRangesFeetFrom([GOBLIN_WARRIOR]),
      },
    );
    expect(result.valid).toBe(false);
  });
});
