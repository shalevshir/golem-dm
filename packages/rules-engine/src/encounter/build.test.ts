import { describe, expect, it } from "vitest";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { buildEncounter } from "./build.js";
import type { EncounterDefinition } from "./build.js";
import { deriveCharacter } from "../character/derive.js";
import { GEAR, sheet } from "../character/test-fixtures.js";

const goblin: MonsterStatBlock = {
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
  ],
};

const definition: EncounterDefinition = {
  encounterId: "test-duel",
  descriptionEnglish: "Two goblins, open floor.",
  width: 5,
  height: 5,
  spawns: [
    { combatantId: "hero", monsterId: "goblin_warrior", faction: "party", position: [0, 0] },
    { combatantId: "villain", monsterId: "goblin_warrior", faction: "hostile", position: [4, 4] },
  ],
  turnOrder: ["hero", "villain"],
  maxRounds: 10,
};

const statBlocks = new Map([["goblin_warrior", goblin]]);

describe("buildEncounter", () => {
  it("places every spawn and keys stat blocks by combatantId", () => {
    const built = buildEncounter({ definition, statBlocks });
    expect(built.world.combatants.map((each) => each.combatantId)).toEqual(["hero", "villain"]);
    expect(built.world.combatants[0]?.position).toEqual([0, 0]);
    expect(built.world.combatants[1]?.position).toEqual([4, 4]);
    expect(built.world.combatants[0]?.faction).toBe("party");
    expect(built.world.combatants[1]?.faction).toBe("hostile");
    // At least one field pulled from the stat block rather than the spawn —
    // pins the mapping against a bug that copied only combatantId/position.
    expect(built.world.combatants[0]?.maxHp).toBe(10);
    expect(built.world.combatants[0]?.armorClass).toBe(15);
    expect(built.world.combatants[0]?.size).toBe("small");
    expect([...built.statBlocks.keys()]).toEqual(["hero", "villain"]);
    expect(built.turnOrder).toEqual(["hero", "villain"]);
  });

  it("defaults every unlisted tile to normal and applies overrides", () => {
    const built = buildEncounter({
      definition: { ...definition, terrain: [{ tile: [2, 2], terrain: "difficult" }] },
      statBlocks,
    });
    expect(built.world.grid.tiles[2]?.[2]).toBe("difficult");
    expect(built.world.grid.tiles[0]?.[1]).toBe("normal");
  });

  it("rejects a terrain override placed off the grid", () => {
    // x=9 is out of range on this 5-wide grid; y=2 is in range, so this
    // exercises the x bound specifically rather than falling through the
    // "row is undefined" branch that an out-of-range y would also hit.
    const badTerrain: EncounterDefinition = {
      ...definition,
      terrain: [{ tile: [9, 2], terrain: "difficult" }],
    };
    expect(() => buildEncounter({ definition: badTerrain, statBlocks })).toThrow(/off the grid/);
  });

  it("derives actionRangesFeet from the same stat blocks the validator will see", () => {
    const built = buildEncounter({ definition, statBlocks });
    expect(built.world.actionRangesFeet?.["scimitar"]).toBe(5);
  });

  it("rejects a spawn whose stat block was not supplied", () => {
    expect(() =>
      buildEncounter({ definition, statBlocks: new Map<string, MonsterStatBlock>() }),
    ).toThrow(/No stat block supplied for monsterId goblin_warrior/);
  });

  it("rejects a spawn placed off the grid", () => {
    const offGrid: EncounterDefinition = {
      ...definition,
      spawns: [
        {
          combatantId: "hero",
          monsterId: "goblin_warrior",
          faction: "party",
          position: [9, 9],
        },
      ],
      turnOrder: ["hero"],
    };
    expect(() => buildEncounter({ definition: offGrid, statBlocks })).toThrow(/off the grid/);
  });

  it("rejects two spawns sharing a tile", () => {
    const stacked: EncounterDefinition = {
      ...definition,
      spawns: [
        {
          combatantId: "hero",
          monsterId: "goblin_warrior",
          faction: "party",
          position: [1, 1],
        },
        {
          combatantId: "villain",
          monsterId: "goblin_warrior",
          faction: "hostile",
          position: [1, 1],
        },
      ],
    };
    expect(() => buildEncounter({ definition: stacked, statBlocks })).toThrow(/collides/);
  });

  it("rejects a combatant missing from turnOrder", () => {
    const partial: EncounterDefinition = { ...definition, turnOrder: ["hero"] };
    expect(() => buildEncounter({ definition: partial, statBlocks })).toThrow(/turnOrder/);
  });
});

const DERIVED_HERO = deriveCharacter(sheet(), GEAR);

describe("character spawns", () => {
  it("builds a combatant from a derived character", () => {
    const built = buildEncounter({
      definition: {
        encounterId: "one-hero",
        descriptionEnglish: "A hero alone.",
        width: 5,
        height: 5,
        spawns: [{ combatantId: "hero", characterId: "hero", faction: "party", position: [1, 1] }],
        turnOrder: ["hero"],
        maxRounds: 5,
      },
      statBlocks: new Map(),
      characters: new Map([["hero", DERIVED_HERO]]),
    });

    const hero = built.world.combatants[0];
    expect(hero?.armorClass).toBe(16);
    expect(hero?.maxHp).toBe(28);
    // The field the schema has always documented as "Present when this
    // combatant is driven by a CharacterSheet", and which nothing populated.
    expect(hero?.characterId).toBe("hero");
  });

  it("puts the character's weapon ranges into the world", () => {
    const built = buildEncounter({
      definition: {
        encounterId: "one-hero",
        descriptionEnglish: "A hero alone.",
        width: 5,
        height: 5,
        spawns: [{ combatantId: "hero", characterId: "hero", faction: "party", position: [1, 1] }],
        turnOrder: ["hero"],
        maxRounds: 5,
      },
      statBlocks: new Map(),
      characters: new Map([["hero", DERIVED_HERO]]),
    });
    expect(built.world.actionRangesFeet?.longsword).toBe(5);
  });

  it("carries a below-full-health character's currentHp, not the sheet's maxHp", () => {
    // R46: DERIVED_HERO has currentHp === maxHp (28 === 28), so the
    // pass-through would look correct even if it were wrong or deleted.
    // Damage the sheet first so the two numbers diverge. The `...sheet().combat`
    // spread is required -- `sheet()`'s override merge is shallow, so a bare
    // `{ combat: { currentHp: 10 } }` would drop every other combat field.
    const wounded = deriveCharacter(sheet({ combat: { ...sheet().combat, currentHp: 10 } }), GEAR);
    const built = buildEncounter({
      definition: {
        encounterId: "one-hero",
        descriptionEnglish: "A wounded hero alone.",
        width: 5,
        height: 5,
        spawns: [{ combatantId: "hero", characterId: "hero", faction: "party", position: [1, 1] }],
        turnOrder: ["hero"],
        maxRounds: 5,
      },
      statBlocks: new Map(),
      characters: new Map([["hero", wounded]]),
    });

    const hero = built.world.combatants[0];
    expect(hero?.currentHp).toBe(10);
    expect(hero?.maxHp).toBe(28);
  });

  it("throws when a character spawn has no supplied character", () => {
    expect(() =>
      buildEncounter({
        definition: {
          encounterId: "one-hero",
          descriptionEnglish: "A hero alone.",
          width: 5,
          height: 5,
          spawns: [
            { combatantId: "hero", characterId: "missing", faction: "party", position: [1, 1] },
          ],
          turnOrder: ["hero"],
          maxRounds: 5,
        },
        statBlocks: new Map(),
        characters: new Map(),
      }),
    ).toThrow(/missing/);
  });

  it("leaves characterId unset on a monster combatant", () => {
    // R8-refined: reuse the module-scope goblin/definition/statBlocks fixtures
    // instead of adding a separate monster-only fixture pair.
    const built = buildEncounter({ definition, statBlocks });
    expect(built.world.combatants[0]?.characterId).toBeUndefined();
  });
});
