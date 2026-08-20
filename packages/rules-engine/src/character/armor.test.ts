import { describe, expect, it } from "vitest";
import type { ArmorCategory, ArmorDefinition } from "@ai-dm/schemas";
import { armorClassFor, speedFeetFor } from "./armor.js";

const ALL: ArmorCategory[] = ["light", "medium", "heavy", "shield"];

function armor(
  armorId: string,
  category: ArmorCategory,
  extra: Partial<ArmorDefinition>,
): ArmorDefinition {
  return {
    armorId,
    nameEnglish: armorId,
    nameHebrew: "בדיקה",
    category,
    stealthDisadvantage: false,
    ...extra,
  };
}

const LEATHER = armor("leather", "light", { baseAc: 11 });
const HALF_PLATE = armor("half_plate", "medium", { baseAc: 15 });
const PLATE = armor("plate", "heavy", { baseAc: 18, strengthRequirement: 15 });
const CHAIN_MAIL = armor("chain_mail", "heavy", { baseAc: 16, strengthRequirement: 13 });
const SHIELD = armor("shield", "shield", { acBonus: 2 });

describe("armorClassFor", () => {
  it("uses 10 + Dex when unarmored", () => {
    expect(armorClassFor({}, 3, ALL)).toBe(13);
  });

  it("adds the full Dex modifier in light armor", () => {
    expect(armorClassFor({ body: LEATHER }, 4, ALL)).toBe(15);
  });

  // Light armor genuinely applies a NEGATIVE Dex modifier: 11 - 1 = 10.
  it("applies a negative Dex modifier in light armor", () => {
    expect(armorClassFor({ body: LEATHER }, -1, ALL)).toBe(10);
  });

  it("caps the Dex modifier at +2 in medium armor", () => {
    expect(armorClassFor({ body: HALF_PLATE }, 4, ALL)).toBe(17);
  });

  it("does not raise a Dex modifier already below the medium cap", () => {
    expect(armorClassFor({ body: HALF_PLATE }, 1, ALL)).toBe(16);
  });

  it("ignores Dex entirely in heavy armor", () => {
    expect(armorClassFor({ body: PLATE }, 4, ALL)).toBe(18);
  });

  // Heavy armor is "no Dexterity modifier", NOT "capped at 0" — a negative
  // modifier must not reduce it either.
  it("does not penalise a negative Dex modifier in heavy armor", () => {
    expect(armorClassFor({ body: PLATE }, -1, ALL)).toBe(18);
  });

  it("adds the shield bonus with shield training", () => {
    expect(armorClassFor({ body: LEATHER, shield: SHIELD }, 2, ALL)).toBe(15);
  });

  // "You gain the Armor Class benefit of a Shield only if you have training
  // with it." Untrained is no bonus, not a penalty.
  it("withholds the shield bonus without shield training", () => {
    expect(armorClassFor({ body: LEATHER, shield: SHIELD }, 2, ["light"])).toBe(13);
  });
});

describe("speedFeetFor", () => {
  it("leaves speed alone when the armor has no Strength requirement", () => {
    expect(speedFeetFor({ body: LEATHER }, 8, 30)).toBe(30);
  });

  it("costs 10 feet when Strength is below the requirement", () => {
    expect(speedFeetFor({ body: CHAIN_MAIL }, 12, 30)).toBe(20);
  });

  it("leaves speed alone when Strength exactly meets the requirement", () => {
    expect(speedFeetFor({ body: CHAIN_MAIL }, 13, 30)).toBe(30);
  });

  it("never drops speed below zero", () => {
    expect(speedFeetFor({ body: PLATE }, 8, 5)).toBe(0);
  });
});
