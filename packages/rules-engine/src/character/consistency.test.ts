import { describe, expect, it } from "vitest";
import { assertSheetConsistent } from "./consistency.js";
import { deriveCharacter } from "./derive.js";
import { FIGHTER, GEAR, sheet } from "./test-fixtures.js";

describe("assertSheetConsistent", () => {
  it("accepts a sheet whose stored values match the derivation", () => {
    const good = sheet();
    expect(() => {
      assertSheetConsistent(good, deriveCharacter(good, GEAR), FIGHTER);
    }).not.toThrow();
  });

  it("rejects a wrong proficiency bonus, naming both values", () => {
    const bad = sheet({ proficiencyBonus: 6 });
    expect(() => {
      assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER);
    }).toThrow(/proficiencyBonus.*6.*2/s);
  });

  it("rejects a wrong armor class", () => {
    const bad = sheet({ combat: { ...sheet().combat, armorClass: 99 } });
    expect(() => {
      assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER);
    }).toThrow(/armorClass/);
  });

  it("rejects a wrong initiative modifier", () => {
    const bad = sheet({ combat: { ...sheet().combat, initiativeModifier: 7 } });
    expect(() => {
      assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER);
    }).toThrow(/initiativeModifier/);
  });

  it("rejects saving throw proficiencies that disagree with the class", () => {
    const bad = sheet({ savingThrowProficiencies: ["dex", "cha"] });
    expect(() => {
      assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER);
    }).toThrow(/savingThrowProficiencies/);
  });

  // `combat.currentHp` has no upper bound in the schema (unlike `maxHp`, it
  // cannot cross-check a sibling field there), and `combatantFromStatBlock`
  // sets `status: "alive"` unconditionally — so nothing else in the pipeline
  // would ever catch a sheet claiming more current HP than it has maximum.
  it("rejects a sheet whose currentHp exceeds its maxHp", () => {
    const bad = sheet({ combat: { ...sheet().combat, currentHp: 999 } });
    expect(() => {
      assertSheetConsistent(bad, deriveCharacter(bad, GEAR), FIGHTER);
    }).toThrow(/currentHp/);
  });
});
