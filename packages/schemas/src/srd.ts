// Shapes for the SRD 5.2.1 game data in `data/srd/`. Content licensed
// CC-BY-4.0; see NOTICE.md for the required attribution.
import { z } from "zod";
import { Abilities, AbilityKey, CharacterClass, Condition, Skill } from "./character.js";
import { DamageType, DiceNotation } from "./primitives.js";
import { CreatureSize } from "./world.js";

export const DamageRoll = z.object({
  /** Absent for flat damage, such as the cultist's "plus 1 Necrotic damage". */
  diceNotation: DiceNotation.optional(),
  /** The stat block's printed average, used when not rolling. */
  averageDamage: z.number().int().min(0),
  damageType: DamageType,
});

/**
 * One attack from a stat block's Actions. An attack that is "Melee or Ranged"
 * in the SRD carries both `reachFeet` and a range pair.
 */
export const MonsterAttack = z.object({
  /** snake_case key; also the `actionId` the tactical agent proposes. */
  actionId: z.string().regex(/^[a-z0-9_]+$/),
  nameEnglish: z.string(),
  attackBonus: z.number().int(),
  /** Melee reach. Absent for an attack that is ranged only. */
  reachFeet: z.number().int().multipleOf(5).optional(),
  /** Normal range; beyond it, out to `longRangeFeet`, the attack has Disadvantage. */
  rangeFeet: z.number().int().multipleOf(5).optional(),
  longRangeFeet: z.number().int().multipleOf(5).optional(),
  damage: DamageRoll,
  /**
   * Damage the attack always adds, such as the cultist's Necrotic rider.
   * Conditional riders — the goblin's extra damage on an Advantaged roll — are
   * not modelled; see RULES_REFERENCE.md.
   */
  extraDamage: z.array(DamageRoll).default([]),
});

export const MonsterStatBlock = z.object({
  monsterId: z.string().regex(/^[a-z0-9_]+$/),
  nameEnglish: z.string(),
  size: CreatureSize,
  /** SRD creature type line, e.g. "Fey (Goblinoid)". */
  creatureType: z.string(),
  alignment: z.string(),
  armorClass: z.number().int().min(1),
  hitPoints: z.object({ average: z.number().int().min(1), diceNotation: DiceNotation }),
  speedFeet: z.number().int().min(0).multipleOf(5),
  abilities: Abilities,
  /** Fractional below 1, so a string: "1/8", "1/4", "1/2", "2". */
  challengeRating: z.string(),
  proficiencyBonus: z.number().int().min(2).max(9),
  /** Attacks a single Attack action grants — 2 when the stat block has Multiattack. */
  attacksPerAction: z.number().int().min(1).default(1),
  actions: z.array(MonsterAttack).min(1),
});

/** A condition's mechanical effects, as named in its SRD glossary entry. */
export const ConditionDefinition = z.object({
  condition: Condition,
  nameEnglish: z.string(),
  effects: z.array(z.object({ nameEnglish: z.string(), ruleEnglish: z.string() })).min(1),
});

export const ClassDefinition = z.object({
  class: CharacterClass,
  nameEnglish: z.string(),
  /** Hit Point Die: 6, 8, 10, or 12. */
  hitDie: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]),
  primaryAbilities: z.array(AbilityKey).min(1),
  savingThrowProficiencies: z.array(AbilityKey).length(2),
  spellcastingAbility: AbilityKey.optional(),
  /** Level at which the class gains Extra Attack, if it ever does. */
  extraAttackLevel: z.number().int().min(1).max(20).optional(),
});

/** Which ability governs a skill check. Data, because the SRD says so. */
export const SkillDefinition = z.object({
  skill: Skill,
  nameEnglish: z.string(),
  ability: AbilityKey,
});

export type DamageRoll = z.infer<typeof DamageRoll>;
export type MonsterAttack = z.infer<typeof MonsterAttack>;
export type MonsterStatBlock = z.infer<typeof MonsterStatBlock>;
export type ConditionDefinition = z.infer<typeof ConditionDefinition>;
export type ClassDefinition = z.infer<typeof ClassDefinition>;
export type SkillDefinition = z.infer<typeof SkillDefinition>;
