import { describe, expect, it } from "vitest";
import type { AbilityKey, WeaponDefinition, WeaponProficiencies } from "@ai-dm/schemas";
import { attacksFor, isProficientWith } from "./attacks.js";

const SIMPLE_AND_MARTIAL: WeaponProficiencies = { categories: ["simple", "martial"] };
const SIMPLE_ONLY: WeaponProficiencies = { categories: ["simple"] };
const ROGUE: WeaponProficiencies = {
  categories: ["simple"],
  martialWithProperties: ["finesse", "light"],
};

const MODS: Record<AbilityKey, number> = { str: 3, dex: 1, con: 2, int: 0, wis: 1, cha: 0 };
const FINESSE_MODS: Record<AbilityKey, number> = { ...MODS, str: 3, dex: 4 };

const LONGSWORD: WeaponDefinition = {
  weaponId: "longsword",
  nameEnglish: "Longsword",
  nameHebrew: "חרב ארוכה",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d8", damageType: "slashing" },
  versatileDamage: { diceNotation: "1d10", damageType: "slashing" },
  properties: ["versatile"],
};

const RAPIER: WeaponDefinition = {
  weaponId: "rapier",
  nameEnglish: "Rapier",
  nameHebrew: "סיף",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d8", damageType: "piercing" },
  properties: ["finesse"],
};

const GREATAXE: WeaponDefinition = {
  weaponId: "greataxe",
  nameEnglish: "Greataxe",
  nameHebrew: "גרזן ענק",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d12", damageType: "slashing" },
  properties: ["heavy", "two_handed"],
};

const SHORTBOW: WeaponDefinition = {
  weaponId: "shortbow",
  nameEnglish: "Shortbow",
  nameHebrew: "קשת קצרה",
  category: "simple",
  kind: "ranged",
  damage: { diceNotation: "1d6", damageType: "piercing" },
  properties: ["ammunition", "two_handed"],
  rangeFeet: 80,
  longRangeFeet: 320,
};

const WHIP: WeaponDefinition = {
  weaponId: "whip",
  nameEnglish: "Whip",
  nameHebrew: "שוט",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d4", damageType: "slashing" },
  properties: ["finesse", "reach"],
};

const BLOWGUN: WeaponDefinition = {
  weaponId: "blowgun",
  nameEnglish: "Blowgun",
  nameHebrew: "רובה נשיפה",
  category: "martial",
  kind: "ranged",
  damage: { fixedDamage: 1, damageType: "piercing" },
  properties: ["ammunition", "loading"],
  rangeFeet: 25,
  longRangeFeet: 100,
};

// Real SRD row, for the dedupe test below: two equipped daggers
// must collapse into one attack option.
const DAGGER: WeaponDefinition = {
  weaponId: "dagger",
  nameEnglish: "Dagger",
  nameHebrew: "פגיון",
  category: "simple",
  kind: "melee",
  damage: { diceNotation: "1d4", damageType: "piercing" },
  properties: ["finesse", "light", "thrown"],
  rangeFeet: 20,
  longRangeFeet: 60,
};

// Real SRD row, copied verbatim (`grep -n spear data/srd/weapons.json`), for
// the characterization test below. Both Versatile and Thrown — one
// of only two such rows in the SRD (with the trident).
const SPEAR: WeaponDefinition = {
  weaponId: "spear",
  nameEnglish: "Spear",
  nameHebrew: "חנית",
  category: "simple",
  kind: "melee",
  damage: { diceNotation: "1d6", damageType: "piercing" },
  versatileDamage: { diceNotation: "1d8", damageType: "piercing" },
  properties: ["thrown", "versatile"],
  rangeFeet: 20,
  longRangeFeet: 60,
};

// SYNTHETIC — deliberately not an SRD row, unlike every fixture above.
// `DiceNotation` permits a baked-in "+N"/"-N" modifier
// (packages/schemas/src/primitives.ts), even though no real row in
// data/srd/weapons.json ever carries one. Exists only to test
// `averageOfDice`'s modifier parse.
const SYNTHETIC_MODIFIER_DAGGER: WeaponDefinition = {
  weaponId: "synthetic_modifier_dagger",
  nameEnglish: "Synthetic Modifier Dagger (test-only)",
  nameHebrew: "פגיון בדיקה",
  category: "simple",
  kind: "melee",
  damage: { diceNotation: "1d6+2", damageType: "piercing" },
  properties: [],
};

const base = {
  abilityModifiers: MODS,
  proficiencyBonus: 2,
  proficiencies: SIMPLE_AND_MARTIAL,
  shieldEquipped: false,
};

// Generic over the element type: an `only()` returning
// `{ actionId: string } | undefined` would make every `.attackBonus` /
// `.damage` / range access below a TS2339 compile error.
const only = <T extends { actionId: string }>(
  weaponId: string,
  attacks: readonly T[],
): T | undefined => attacks.find((each) => each.actionId === weaponId);

describe("isProficientWith", () => {
  it("grants proficiency by category", () => {
    expect(isProficientWith(GREATAXE, SIMPLE_AND_MARTIAL)).toBe(true);
    expect(isProficientWith(SHORTBOW, SIMPLE_ONLY)).toBe(true);
  });

  it("denies a martial weapon to a simple-only class", () => {
    expect(isProficientWith(GREATAXE, SIMPLE_ONLY)).toBe(false);
  });

  // "Simple weapons and Martial weapons that have the Finesse or Light
  // property" — the Rogue's grant, which no category list can express.
  it("grants the Rogue a martial weapon with Finesse", () => {
    expect(isProficientWith(RAPIER, ROGUE)).toBe(true);
  });

  it("denies the Rogue a martial weapon without Finesse or Light", () => {
    expect(isProficientWith(GREATAXE, ROGUE)).toBe(false);
  });
});

describe("attacksFor", () => {
  it("uses Strength for a plain melee weapon", () => {
    const attack = only("longsword", attacksFor({ ...base, weapons: [LONGSWORD] }));
    expect(attack?.attackBonus).toBe(5); // +3 Str, +2 proficiency
  });

  // Versatile: no hands are modelled, so the two-handed die is taken whenever
  // no shield is equipped. HOUSE RULE — see RULES_REFERENCE.md section 9.
  it("takes the versatile die when no shield is equipped", () => {
    const attack = only("longsword", attacksFor({ ...base, weapons: [LONGSWORD] }));
    expect(attack?.damage.diceNotation).toBe("1d10+3");
    expect(attack?.damage.averageDamage).toBe(8); // floor(5.5) + 3
  });

  it("takes the one-handed die when a shield is equipped", () => {
    const attack = only(
      "longsword",
      attacksFor({ ...base, weapons: [LONGSWORD], shieldEquipped: true }),
    );
    expect(attack?.damage.diceNotation).toBe("1d8+3");
    expect(attack?.damage.averageDamage).toBe(7); // floor(4.5) + 3
  });

  // Characterization test: pins the house rule's known
  // deviation from RAW, not RAW itself. The spear is both Versatile and
  // Thrown; `damageDiceFor`'s docstring explains why this engine cannot tell
  // thrown mode from two-handed melee mode, so the two-handed die (1d8)
  // leaks into thrown mode too, where RAW gives 1d6.
  it("takes the versatile die for a thrown weapon too", () => {
    const attack = only("spear", attacksFor({ ...base, weapons: [SPEAR] }));
    expect(attack?.damage.diceNotation).toBe("1d8+3"); // RAW thrown would be 1d6+3
    expect(attack?.damage.averageDamage).toBe(7); // floor(4.5) + 3
  });

  // "use your choice of your Strength or Dexterity modifier ... You must use
  // the same modifier for both rolls."
  it("takes the higher modifier for a finesse weapon, on both rolls", () => {
    const attack = only(
      "rapier",
      attacksFor({ ...base, weapons: [RAPIER], abilityModifiers: FINESSE_MODS }),
    );
    expect(attack?.attackBonus).toBe(6); // +4 Dex, +2 proficiency
    expect(attack?.damage.diceNotation).toBe("1d8+4");
  });

  it("uses Dexterity for a ranged weapon", () => {
    const attack = only("shortbow", attacksFor({ ...base, weapons: [SHORTBOW] }));
    expect(attack?.attackBonus).toBe(3); // +1 Dex, +2 proficiency
    expect(attack?.rangeFeet).toBe(80);
    expect(attack?.longRangeFeet).toBe(320);
    expect(attack?.reachFeet).toBeUndefined();
  });

  it("withholds the proficiency bonus from a weapon the class cannot use", () => {
    const attack = only(
      "greataxe",
      attacksFor({ ...base, weapons: [GREATAXE], proficiencies: SIMPLE_ONLY }),
    );
    expect(attack?.attackBonus).toBe(3); // +3 Str only
  });

  it("gives a reach weapon 10 feet and everything else 5", () => {
    const [whip] = attacksFor({ ...base, weapons: [WHIP] });
    expect(whip?.reachFeet).toBe(10);
    const [sword] = attacksFor({ ...base, weapons: [LONGSWORD] });
    expect(sword?.reachFeet).toBe(5);
  });

  it("keeps flat weapon damage flat", () => {
    const attack = only("blowgun", attacksFor({ ...base, weapons: [BLOWGUN] }));
    expect(attack?.damage.diceNotation).toBeUndefined();
    expect(attack?.damage.averageDamage).toBe(2); // 1 + 1 Dex
  });

  // SYNTHETIC fixture: exercises `parseNotation`'s parse of a baked-in dice
  // modifier through the public surface (a hand-rolled regex here used to
  // return NaN on this input), AND that the weapon's own modifier COMPOSES
  // with the ability modifier into one suffix rather than being appended as
  // a second one.
  it("composes a baked-in dice modifier with the ability modifier, instead of appending a second suffix", () => {
    const attack = only(
      "synthetic_modifier_dagger",
      attacksFor({ ...base, weapons: [SYNTHETIC_MODIFIER_DAGGER] }),
    );
    // parseNotation("1d6+2") -> count 1, sides 6, modifier 2; composed with
    // attacksFor's own +3 Str modifier: averageDamage = floor(7/2) + 2 + 3 = 8,
    // diceNotation = "1d6+5" — ONE suffix, not "1d6+2+3" (which `DiceNotation`
    // rejects and `parseNotation` throws on).
    expect(attack?.damage.averageDamage).toBe(8);
    expect(attack?.damage.diceNotation).toBe("1d6+5");
  });

  // Without this, a Wizard with no equipped weapon derives an empty action
  // list and fails CreatureStatBlock's .min(1).
  it("always derives an unarmed strike, even with no weapons", () => {
    const attacks = attacksFor({ ...base, weapons: [] });
    expect(attacks).toHaveLength(1);
    const unarmed = attacks[0];
    expect(unarmed?.actionId).toBe("unarmed_strike");
    expect(unarmed?.attackBonus).toBe(5); // +3 Str, +2 proficiency — always proficient
    expect(unarmed?.damage.diceNotation).toBeUndefined();
    expect(unarmed?.damage.averageDamage).toBe(4); // 1 + 3 Str
    expect(unarmed?.reachFeet).toBe(5);
  });

  it("appends the unarmed strike alongside real weapons", () => {
    const ids = attacksFor({ ...base, weapons: [LONGSWORD] }).map((each) => each.actionId);
    expect(ids).toEqual(["longsword", "unarmed_strike"]);
  });

  // Two equipped daggers are one attack OPTION ("attack with a
  // dagger"), not two — two-weapon fighting is a separate bonus-action
  // mechanic and an explicit non-goal of this slice.
  it("dedupes two identical equipped weapons into a single attack", () => {
    const ids = attacksFor({ ...base, weapons: [DAGGER, DAGGER] }).map((each) => each.actionId);
    expect(ids).toEqual(["dagger", "unarmed_strike"]);
  });

  it("never lets damage go below zero", () => {
    const feeble: Record<AbilityKey, number> = { ...MODS, str: -5 };
    const attacks = attacksFor({ ...base, weapons: [], abilityModifiers: feeble });
    expect(attacks[0]?.damage.averageDamage).toBe(0);
  });

  it("names every derived attack in Hebrew", () => {
    for (const attack of attacksFor({ ...base, weapons: [LONGSWORD, SHORTBOW] })) {
      expect(attack.nameHebrew.trim(), attack.actionId).not.toBe("");
    }
  });
});
