// Shared across derive.test.ts, consistency.test.ts and the encounter build
// tests. Not a test file itself, so it ships no `it` blocks.
import type {
  ArmorDefinition,
  CharacterSheet,
  ClassDefinition,
  SkillDefinition,
  WeaponDefinition,
} from "@ai-dm/schemas";
import type { SrdGear } from "./derive.js";

export const FIGHTER: ClassDefinition = {
  class: "fighter",
  nameEnglish: "Fighter",
  hitDie: 10,
  primaryAbilities: ["str", "dex"],
  savingThrowProficiencies: ["str", "con"],
  extraAttackLevel: 5,
  weaponProficiencies: { categories: ["simple", "martial"] },
  armorTraining: ["light", "medium", "heavy", "shield"],
};

export const WIZARD: ClassDefinition = {
  class: "wizard",
  nameEnglish: "Wizard",
  hitDie: 6,
  primaryAbilities: ["int"],
  savingThrowProficiencies: ["int", "wis"],
  spellcastingAbility: "int",
  weaponProficiencies: { categories: ["simple"] },
  armorTraining: [],
};

export const CHAIN_MAIL: ArmorDefinition = {
  armorId: "chain_mail",
  nameEnglish: "Chain Mail",
  nameHebrew: "שריון שרשראות",
  category: "heavy",
  baseAc: 16,
  strengthRequirement: 13,
  stealthDisadvantage: true,
};

export const SHIELD: ArmorDefinition = {
  armorId: "shield",
  nameEnglish: "Shield",
  nameHebrew: "מגן",
  category: "shield",
  acBonus: 2,
  stealthDisadvantage: false,
};

export const LONGSWORD: WeaponDefinition = {
  weaponId: "longsword",
  nameEnglish: "Longsword",
  nameHebrew: "חרב ארוכה",
  category: "martial",
  kind: "melee",
  damage: { diceNotation: "1d8", damageType: "slashing" },
  versatileDamage: { diceNotation: "1d10", damageType: "slashing" },
  properties: ["versatile"],
};

export const SKILLS: SkillDefinition[] = [
  { skill: "acrobatics", nameEnglish: "Acrobatics", ability: "dex" },
  { skill: "animal_handling", nameEnglish: "Animal Handling", ability: "wis" },
  { skill: "arcana", nameEnglish: "Arcana", ability: "int" },
  { skill: "athletics", nameEnglish: "Athletics", ability: "str" },
  { skill: "deception", nameEnglish: "Deception", ability: "cha" },
  { skill: "history", nameEnglish: "History", ability: "int" },
  { skill: "insight", nameEnglish: "Insight", ability: "wis" },
  { skill: "intimidation", nameEnglish: "Intimidation", ability: "cha" },
  { skill: "investigation", nameEnglish: "Investigation", ability: "int" },
  { skill: "medicine", nameEnglish: "Medicine", ability: "wis" },
  { skill: "nature", nameEnglish: "Nature", ability: "int" },
  { skill: "perception", nameEnglish: "Perception", ability: "wis" },
  { skill: "performance", nameEnglish: "Performance", ability: "cha" },
  { skill: "persuasion", nameEnglish: "Persuasion", ability: "cha" },
  { skill: "religion", nameEnglish: "Religion", ability: "int" },
  { skill: "sleight_of_hand", nameEnglish: "Sleight of Hand", ability: "dex" },
  { skill: "stealth", nameEnglish: "Stealth", ability: "dex" },
  { skill: "survival", nameEnglish: "Survival", ability: "wis" },
];

export const GEAR: SrdGear = {
  weapons: new Map([["longsword", LONGSWORD]]),
  armor: new Map([
    ["chain_mail", CHAIN_MAIL],
    ["shield", SHIELD],
  ]),
  classes: new Map([
    ["fighter", FIGHTER],
    ["wizard", WIZARD],
  ]),
  skills: new Map(SKILLS.map((each) => [each.skill, each])),
};

export function sheet(overrides: Partial<CharacterSheet> = {}): CharacterSheet {
  return {
    characterId: "hero",
    nameHebrew: "אלדד",
    grammaticalGender: "masculine",
    size: "medium",
    class: "fighter",
    level: 3,
    proficiencyBonus: 2,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 10 },
    savingThrowProficiencies: ["str", "con"],
    skillProficiencies: ["athletics", "perception"],
    combat: {
      maxHp: 28,
      currentHp: 28,
      tempHp: 0,
      armorClass: 16,
      speedFeet: 30,
      initiativeModifier: 1,
      deathSaves: { successes: 0, failures: 0 },
      spellSlots: {},
    },
    conditions: [],
    inventory: [
      { itemId: "chain_mail", quantity: 1, equipped: true },
      { itemId: "longsword", quantity: 1, equipped: true },
    ],
    ...overrides,
  };
}
