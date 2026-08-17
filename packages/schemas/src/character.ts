import { z } from "zod";

/** The 15 core 5e conditions. Extend only via ADR. */
export const Condition = z.enum([
  "blinded", "charmed", "deafened", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned",
  "prone", "restrained", "stunned", "unconscious", "exhaustion",
]);

/** A condition currently affecting a creature. `null` duration = until removed. */
export const ActiveCondition = z.object({
  condition: Condition,
  durationRounds: z.number().int().nullable(),
});

/** Keyed by slot level "1".."9": { max, current } */
export const SpellSlots = z.record(
  z.string(),
  z.object({ max: z.number().int(), current: z.number().int() }),
);

export const AbilityKey = z.enum(["str", "dex", "con", "int", "wis", "cha"]);

/** POC scope — widening this is a reviewed change (see the schemas CLAUDE.md). */
export const CharacterClass = z.enum(["fighter", "wizard", "rogue", "cleric"]);

export const Abilities = z.object({
  str: z.number().int().min(1).max(30),
  dex: z.number().int().min(1).max(30),
  con: z.number().int().min(1).max(30),
  int: z.number().int().min(1).max(30),
  wis: z.number().int().min(1).max(30),
  cha: z.number().int().min(1).max(30),
});

export const CharacterSheet = z.object({
  characterId: z.string(),
  nameHebrew: z.string(),
  /** Required for grammatically correct Hebrew narration. */
  grammaticalGender: z.enum(["masculine", "feminine"]),
  class: CharacterClass,
  level: z.number().int().min(1).max(20),
  proficiencyBonus: z.number().int().min(2).max(6),
  abilities: Abilities,
  savingThrowProficiencies: z.array(AbilityKey),
  skillProficiencies: z.array(z.string()),
  combat: z.object({
    maxHp: z.number().int().min(1),
    currentHp: z.number().int().min(0),
    tempHp: z.number().int().min(0).default(0),
    armorClass: z.number().int(),
    speedFeet: z.number().int().multipleOf(5),
    initiativeModifier: z.number().int(),
    deathSaves: z.object({ successes: z.number().int().max(3), failures: z.number().int().max(3) }),
    spellSlots: SpellSlots,
  }),
  conditions: z.array(ActiveCondition),
  inventory: z.array(z.object({ itemId: z.string(), quantity: z.number().int().min(1) })),
});

export type CharacterSheet = z.infer<typeof CharacterSheet>;
export type ActiveCondition = z.infer<typeof ActiveCondition>;
export type SpellSlots = z.infer<typeof SpellSlots>;
export type Condition = z.infer<typeof Condition>;
export type AbilityKey = z.infer<typeof AbilityKey>;
export type CharacterClass = z.infer<typeof CharacterClass>;
export type Abilities = z.infer<typeof Abilities>;
