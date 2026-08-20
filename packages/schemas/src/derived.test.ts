import { describe, expect, it } from "vitest";
import { DerivedCharacter } from "./index.js";

const minimal = {
  characterId: "hero",
  nameHebrew: "אלדד",
  grammaticalGender: "masculine",
  class: "fighter",
  level: 3,
  size: "medium",
  abilityModifiers: { str: 3, dex: 1, con: 2, int: 0, wis: 1, cha: 0 },
  proficiencyBonus: 2,
  armorClass: 16,
  initiative: 1,
  speedFeet: 30,
  passivePerception: 11,
  maxHp: 28,
  currentHp: 28,
  tempHp: 0,
  hitDice: "3d10",
  savingThrows: { str: 5, dex: 1, con: 4, int: 0, wis: 1, cha: 0 },
  skills: {},
  attacks: [
    {
      actionId: "longsword",
      nameEnglish: "Longsword",
      nameHebrew: "חרב ארוכה",
      attackBonus: 5,
      reachFeet: 5,
      damage: { diceNotation: "1d10+3", averageDamage: 8, damageType: "slashing" },
    },
  ],
  attacksPerAction: 1,
};

describe("DerivedCharacter", () => {
  it("parses a complete derivation", () => {
    const parsed = DerivedCharacter.parse(minimal);
    expect(parsed.armorClass).toBe(16);
    expect(parsed.attacks[0]?.attackBonus).toBe(5);
  });

  it("leaves spellSaveDc absent for a non-caster", () => {
    expect(DerivedCharacter.parse(minimal).spellSaveDc).toBeUndefined();
  });

  it("carries spellSaveDc when given one", () => {
    expect(DerivedCharacter.parse({ ...minimal, spellSaveDc: 13 }).spellSaveDc).toBe(13);
  });

  it("requires at least one attack", () => {
    expect(() => DerivedCharacter.parse({ ...minimal, attacks: [] })).toThrow();
  });
});
