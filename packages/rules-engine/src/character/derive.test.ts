import { describe, expect, it } from "vitest";
import type { CharacterSheet } from "@ai-dm/schemas";
import { DerivedCharacter } from "@ai-dm/schemas";
import { deriveCharacter } from "./derive.js";
import { GEAR, sheet } from "./test-fixtures.js";

describe("deriveCharacter", () => {
  it("derives the proficiency bonus from level, not from the sheet", () => {
    expect(deriveCharacter(sheet({ level: 3 }), GEAR).proficiencyBonus).toBe(2);
    expect(deriveCharacter(sheet({ level: 5 }), GEAR).proficiencyBonus).toBe(3);
  });

  it("derives ability modifiers for all six abilities", () => {
    const derived = deriveCharacter(sheet(), GEAR);
    expect(derived.abilityModifiers).toEqual({ str: 3, dex: 1, con: 2, int: 0, wis: 1, cha: 0 });
  });

  it("derives armor class from the equipped armor", () => {
    expect(deriveCharacter(sheet(), GEAR).armorClass).toBe(16);
  });

  it("applies the armor Strength penalty to speed", () => {
    const weak = sheet({ abilities: { str: 12, dex: 12, con: 14, int: 10, wis: 12, cha: 10 } });
    expect(deriveCharacter(weak, GEAR).speedFeet).toBe(20);
  });

  it("takes initiative from Dexterity", () => {
    expect(deriveCharacter(sheet(), GEAR).initiative).toBe(1);
  });

  it("adds proficiency to proficient saving throws only", () => {
    const derived = deriveCharacter(sheet(), GEAR);
    expect(derived.savingThrows.str).toBe(5); // +3 and proficient
    expect(derived.savingThrows.con).toBe(4); // +2 and proficient
    expect(derived.savingThrows.dex).toBe(1); // +1, not proficient
  });

  it("derives a bonus for every one of the 18 skills", () => {
    const derived = deriveCharacter(sheet(), GEAR);
    expect(Object.keys(derived.skills)).toHaveLength(18);
    expect(derived.skills.athletics).toBe(5); // +3 Str, proficient
    expect(derived.skills.stealth).toBe(1); // +1 Dex, not proficient
  });

  it("derives passive perception as 10 plus the perception bonus", () => {
    // +1 Wis, proficient in perception, +2 proficiency = 3; 10 + 3.
    expect(deriveCharacter(sheet(), GEAR).passivePerception).toBe(13);
  });

  it("grants Extra Attack only at the class's level", () => {
    expect(deriveCharacter(sheet({ level: 4 }), GEAR).attacksPerAction).toBe(1);
    expect(deriveCharacter(sheet({ level: 5 }), GEAR).attacksPerAction).toBe(2);
  });

  it("gives a non-caster no spell save DC", () => {
    expect(deriveCharacter(sheet(), GEAR).spellSaveDc).toBeUndefined();
  });

  it("derives a spell save DC for a caster", () => {
    const wizard = sheet({
      class: "wizard",
      level: 3,
      abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 12, cha: 10 },
      savingThrowProficiencies: ["int", "wis"],
      inventory: [],
    });
    // 8 + 2 proficiency + 3 Int
    expect(deriveCharacter(wizard, GEAR).spellSaveDc).toBe(13);
  });

  it("carries hit points and hit dice through unchanged", () => {
    const derived = deriveCharacter(sheet(), GEAR);
    expect(derived.maxHp).toBe(28);
    expect(derived.hitDice).toBe("3d10");
  });

  it("gives an unarmed wizard exactly one action", () => {
    const wizard = sheet({ class: "wizard", inventory: [] });
    expect(deriveCharacter(wizard, GEAR).attacks).toHaveLength(1);
  });

  it("rejects a sheet equipping two suits of armor", () => {
    const twoArmors = sheet({
      inventory: [
        { itemId: "chain_mail", quantity: 1, equipped: true },
        { itemId: "shield", quantity: 1, equipped: true },
        { itemId: "chain_mail", quantity: 1, equipped: true },
      ],
    });
    expect(() => deriveCharacter(twoArmors, GEAR)).toThrow(/one suit of armor/i);
  });

  it("rejects an unknown class", () => {
    const unknown = sheet({ class: "bard" } as unknown as Partial<CharacterSheet>);
    expect(() => deriveCharacter(unknown, GEAR)).toThrow(/bard/);
  });

  it("produces a value that parses as a DerivedCharacter", () => {
    expect(() => DerivedCharacter.parse(deriveCharacter(sheet(), GEAR))).not.toThrow();
  });
});
