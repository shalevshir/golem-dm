// Every 5e number a character has, computed once. The engine consumes a
// projection of this (`characterStatBlock`); a character-sheet page consumes
// it whole. It lives in schemas rather than rules-engine so `apps/web` can
// hold the TYPE without importing the MATH — invariant 1 keeps the
// calculation in the engine, invariant 5 keeps the engine out of the client.
import { z } from "zod";
import { AbilityKey, CharacterClass, Skill } from "./character.js";
import { CreatureSize, DiceNotation } from "./primitives.js";
import { CreatureAttack } from "./srd.js";

const ByAbility = z.record(AbilityKey, z.number().int());

export const DerivedCharacter = z.object({
  characterId: z.string(),
  nameHebrew: z.string().min(1),
  grammaticalGender: z.enum(["masculine", "feminine"]),
  class: CharacterClass,
  level: z.number().int().min(1).max(20),
  size: CreatureSize,

  abilityModifiers: ByAbility,
  proficiencyBonus: z.number().int().min(2).max(6),
  armorClass: z.number().int().min(1),
  initiative: z.number().int(),
  /** After any armor Strength penalty. */
  speedFeet: z.number().int().min(0).multipleOf(5),
  passivePerception: z.number().int(),

  maxHp: z.number().int().min(1),
  currentHp: z.number().int().min(0),
  tempHp: z.number().int().min(0),
  hitDice: DiceNotation,

  savingThrows: ByAbility,
  skills: z.record(Skill, z.number().int()),

  /**
   * Never empty: an Unarmed Strike is always derived, so a character with no
   * equipped weapon still satisfies `CreatureStatBlock.actions.min(1)`.
   */
  attacks: z.array(CreatureAttack).min(1),
  attacksPerAction: z.number().int().min(1),

  /** Absent when the class has no spellcasting ability. */
  spellSaveDc: z.number().int().optional(),
});

export type DerivedCharacter = z.infer<typeof DerivedCharacter>;
