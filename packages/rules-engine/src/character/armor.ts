// Armor Class and the armor Strength penalty. Both are SRD table rules, and
// both feed the engine through `characterStatBlock`.
import type { ArmorCategory, ArmorDefinition } from "@ai-dm/schemas";

/** What the character is actually wearing and wielding. */
export interface EquippedArmor {
  body?: ArmorDefinition;
  shield?: ArmorDefinition;
}

const UNARMORED_BASE_AC = 10;
const MEDIUM_DEX_CAP = 2;
const STRENGTH_PENALTY_FEET = 10;

/**
 * How much Dexterity the worn armor lets through. Taken from the category
 * rather than stored per row: every Light row in the SRD table is
 * `base + Dex`, every Medium row `base + Dex (max 2)`, every Heavy row a bare
 * number, and no row deviates from its category.
 *
 * Heavy contributes 0 flatly rather than capping at 0 — capping would let a
 * -1 modifier through as -1, and heavy armor does not penalise low Dexterity.
 */
function dexterityContribution(category: ArmorCategory | undefined, dexModifier: number): number {
  if (category === undefined || category === "light") return dexModifier;
  if (category === "medium") return Math.min(dexModifier, MEDIUM_DEX_CAP);
  return 0;
}

export function armorClassFor(
  equipped: EquippedArmor,
  dexModifier: number,
  armorTraining: readonly ArmorCategory[],
): number {
  const base = equipped.body?.baseAc ?? UNARMORED_BASE_AC;
  const fromDex = dexterityContribution(equipped.body?.category, dexModifier);

  // "You gain the Armor Class benefit of a Shield only if you have training
  // with it." Untrained is simply no bonus, never a penalty.
  const trained = armorTraining.includes("shield");
  const fromShield = equipped.shield !== undefined && trained ? (equipped.shield.acBonus ?? 0) : 0;

  return base + fromDex + fromShield;
}

/**
 * "If the table shows a Strength score in the Strength column for an armor
 * type, that armor reduces the wearer's speed by 10 feet unless the wearer has
 * a Strength score equal to or higher than the listed score."
 */
export function speedFeetFor(
  equipped: EquippedArmor,
  strengthScore: number,
  baseSpeedFeet: number,
): number {
  const required = equipped.body?.strengthRequirement;
  if (required === undefined || strengthScore >= required) return baseSpeedFeet;
  return Math.max(0, baseSpeedFeet - STRENGTH_PENALTY_FEET);
}
