// Every 5e number a character has, computed once. The engine consumes a
// projection of this (`characterStatBlock`); a character-sheet page consumes
// it whole. It lives in schemas rather than rules-engine so `apps/web` can
// hold the TYPE without importing the MATH — invariant 1 keeps the
// calculation in the engine, invariant 5 keeps the engine out of the client.
import { z } from "zod";
import { AbilityKey, CharacterClass, GrammaticalGender, Skill } from "./character.js";
import { CreatureSize, DiceNotation } from "./primitives.js";
import { CreatureAttack } from "./srd.js";

const ByAbility = z.record(AbilityKey, z.number().int());

/**
 * One carried item, resolved for display. `CharacterSheet.inventory` holds
 * bare `itemId`s and nothing else; this pairs each with the Hebrew name off
 * its SRD row, so a character-sheet page can list what someone carries
 * without loading gear data itself (invariant 5) or translating an English
 * id at the UI boundary (invariant 2).
 *
 * `nameHebrew` is absent for ordinary gear — rope, rations, a holy symbol —
 * which `equipmentOf` already tolerates precisely because it has neither a
 * weapon nor an armor row, and so has no authored Hebrew name to resolve. A
 * renderer must fall back to the Latin `itemId` in that case, and wrap it the
 * way it wraps every other Latin fragment in an RTL page.
 */
export const DerivedInventoryItem = z.object({
  itemId: z.string(),
  nameHebrew: z.string().min(1).optional(),
  quantity: z.number().int().min(1),
  equipped: z.boolean(),
});

export const DerivedCharacter = z.object({
  characterId: z.string(),
  nameHebrew: z.string().min(1),
  grammaticalGender: GrammaticalGender,
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

  /** English display name of equipped body armor. Absent when unarmored — never the shield, which `attacks`/`armorClass` fold in but do not name. */
  armorNameEnglish: z.string().optional(),

  /**
   * Never empty: an Unarmed Strike is always derived, so a character with no
   * equipped weapon still satisfies `CreatureStatBlock.actions.min(1)`.
   */
  attacks: z.array(CreatureAttack).min(1),
  attacksPerAction: z.number().int().min(1),

  /**
   * Everything carried, equipped or not — the one part of `CharacterSheet`
   * that used to stop at the server. It is display data, not math: nothing in
   * the engine reads it back, `armorClass`/`attacks` above are already
   * derived from the equipped subset, and a client rendering this list is
   * still computing nothing (invariant 1).
   */
  inventory: z.array(DerivedInventoryItem).default([]),

  /** Absent when the class has no spellcasting ability. */
  spellSaveDc: z.number().int().optional(),
});

export type DerivedInventoryItem = z.infer<typeof DerivedInventoryItem>;
export type DerivedCharacter = z.infer<typeof DerivedCharacter>;
