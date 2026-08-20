// Turns equipped weapons into the resolved `CreatureAttack` shape the engine
// already understands. A monster's attack bonus is printed in its stat block;
// a character's is computed here, from ability, proficiency and the weapon.
import type {
  AbilityKey,
  CreatureAttack,
  DamageRoll,
  WeaponDefinition,
  WeaponProficiencies,
} from "@ai-dm/schemas";
import { parseNotation } from "../dice/index.js";

export interface AttackDerivationInput {
  /** Equipped weapons only — carried ones are not actions. */
  weapons: readonly WeaponDefinition[];
  abilityModifiers: Readonly<Record<AbilityKey, number>>;
  proficiencyBonus: number;
  proficiencies: WeaponProficiencies;
  /** Decides the Versatile die. See the house rule note below. */
  shieldEquipped: boolean;
}

const DEFAULT_REACH_FEET = 5;
const REACH_PROPERTY_FEET = 10;
const UNARMED_BASE_DAMAGE = 1;

/**
 * "Anyone can wield a weapon, but you must have proficiency with it to add
 * your Proficiency Bonus to an attack roll you make with it."
 *
 * `martialWithProperties` exists for the Rogue, whose grant is "Martial
 * weapons that have the Finesse or Light property".
 */
export function isProficientWith(
  weapon: WeaponDefinition,
  proficiencies: WeaponProficiencies,
): boolean {
  if (proficiencies.categories.includes(weapon.category)) return true;
  if (weapon.category !== "martial") return false;
  const byProperty = proficiencies.martialWithProperties ?? [];
  return byProperty.some((property) => weapon.properties.includes(property));
}

/**
 * Which ability swings this weapon. Ranged weapons use Dexterity, melee use
 * Strength, and a Finesse weapon lets the wielder choose — "use your choice of
 * your Strength or Dexterity modifier for the attack and damage rolls. You
 * must use the same modifier for both rolls" — so the higher is taken and used
 * for both.
 *
 * A Thrown melee weapon stays on its melee ability; `kind` already encodes
 * that, since the SRD has a thrown weapon use the modifier it would use in
 * melee.
 */
function attackAbilityFor(
  weapon: WeaponDefinition,
  modifiers: Readonly<Record<AbilityKey, number>>,
): AbilityKey {
  if (weapon.kind === "ranged") return "dex";
  if (!weapon.properties.includes("finesse")) return "str";
  return modifiers.dex > modifiers.str ? "dex" : "str";
}

/**
 * HOUSE RULE. RAW: "A Versatile weapon can be used with one or two hands ...
 * The weapon deals that damage when used with two hands to make a melee
 * attack." Nothing in this engine models hands, so a shield stands in for the
 * off hand. Recorded in RULES_REFERENCE.md section 9.
 *
 * Known gap: a weapon that is both Versatile and Thrown
 * (spear, trident — the only two such rows in the SRD) uses its two-handed
 * die in BOTH modes, so a thrown spear deals 1d8 where RAW gives 1d6.
 * `CreatureAttack` carries exactly one `damage` value and thrown mode is not
 * separately modelled, so this is a deliberate, documented approximation.
 *
 * Known gap: the shield proxy also misses a dual-wielder —
 * a shieldless character holding e.g. a longsword AND a shortsword still
 * gets the longsword's two-handed die, though the off hand is occupied by
 * the second weapon, not free. Same root cause: only the shield slot is
 * checked, not whether the off hand is actually free.
 */
function damageDiceFor(weapon: WeaponDefinition, shieldEquipped: boolean) {
  if (weapon.versatileDamage !== undefined && !shieldEquipped) return weapon.versatileDamage;
  return weapon.damage;
}

/** Average of `count`d`sides`, floored — the convention the SRD prints stat blocks with. */
function averageOfDice(count: number, sides: number): number {
  return Math.floor((count * (sides + 1)) / 2);
}

/** Rebuilds `XdY[+-]Z` from parsed components. A zero modifier adds no suffix. */
function notationFor(count: number, sides: number, modifier: number): string {
  const base = `${String(count)}d${String(sides)}`;
  if (modifier === 0) return base;
  return modifier > 0 ? `${base}+${String(modifier)}` : `${base}${String(modifier)}`;
}

function damageRollFor(
  weapon: WeaponDefinition,
  shieldEquipped: boolean,
  modifier: number,
): DamageRoll {
  const dice = damageDiceFor(weapon, shieldEquipped);

  if (dice.diceNotation === undefined) {
    // Flat damage, e.g. the blowgun's "1 Piercing". `DamageRoll` already
    // documents `diceNotation` as "Absent for flat damage", so this needs no
    // special shape — just no dice.
    return {
      averageDamage: Math.max(0, (dice.fixedDamage ?? 0) + modifier),
      damageType: dice.damageType,
    };
  }

  // A weapon's own notation can carry a baked-in modifier of its own (no SRD
  // row does, but `DiceNotation` permits it). Parse it and COMPOSE the two
  // modifiers into one, rather than appending the ability modifier as a
  // second suffix — `"1d6+2+3"` is not valid `DiceNotation` and `parseNotation`
  // throws on it, which combat resolution would hit downstream.
  const { count, sides, modifier: baseModifier } = parseNotation(dice.diceNotation);
  const totalModifier = baseModifier + modifier;

  return {
    diceNotation: notationFor(count, sides, totalModifier),
    averageDamage: Math.max(0, averageOfDice(count, sides) + totalModifier),
    damageType: dice.damageType,
  };
}

function reachAndRangeFor(weapon: WeaponDefinition) {
  const range = {
    ...(weapon.rangeFeet === undefined ? {} : { rangeFeet: weapon.rangeFeet }),
    ...(weapon.longRangeFeet === undefined ? {} : { longRangeFeet: weapon.longRangeFeet }),
  };
  if (weapon.kind === "ranged") return range;
  return {
    reachFeet: weapon.properties.includes("reach") ? REACH_PROPERTY_FEET : DEFAULT_REACH_FEET,
    ...range,
  };
}

/**
 * "Instead of using a weapon to make a melee attack, you can use a punch,
 * kick, headbutt, or similar forceful blow." Always available, and always
 * proficient: the Damage option's bonus is "your Strength modifier plus your
 * Proficiency Bonus" with no proficiency condition attached.
 *
 * Deriving it unconditionally is also what keeps `CreatureStatBlock.actions`
 * non-empty for a character carrying no weapon at all.
 */
function unarmedStrike(strengthModifier: number, proficiencyBonus: number): CreatureAttack {
  return {
    actionId: "unarmed_strike",
    nameEnglish: "Unarmed Strike",
    nameHebrew: "מכת יד",
    attackBonus: strengthModifier + proficiencyBonus,
    reachFeet: DEFAULT_REACH_FEET,
    damage: {
      averageDamage: Math.max(0, UNARMED_BASE_DAMAGE + strengthModifier),
      damageType: "bludgeoning",
    },
    extraDamage: [],
  };
}

/**
 * First occurrence wins, order otherwise preserved. Two equipped daggers are
 * one attack OPTION ("attack with a dagger"), not two different ones —
 * two-weapon fighting is a separate bonus-action mechanic and an explicit
 * non-goal of this slice.
 */
function dedupeByWeaponId(weapons: readonly WeaponDefinition[]): WeaponDefinition[] {
  const seen = new Set<string>();
  return weapons.filter((weapon) => {
    if (seen.has(weapon.weaponId)) return false;
    seen.add(weapon.weaponId);
    return true;
  });
}

export function attacksFor(input: AttackDerivationInput): CreatureAttack[] {
  const attacks = dedupeByWeaponId(input.weapons).map((weapon): CreatureAttack => {
    const ability = attackAbilityFor(weapon, input.abilityModifiers);
    const modifier = input.abilityModifiers[ability];
    const proficient = isProficientWith(weapon, input.proficiencies);

    return {
      actionId: weapon.weaponId,
      nameEnglish: weapon.nameEnglish,
      nameHebrew: weapon.nameHebrew,
      attackBonus: modifier + (proficient ? input.proficiencyBonus : 0),
      ...reachAndRangeFor(weapon),
      damage: damageRollFor(weapon, input.shieldEquipped, modifier),
      extraDamage: [],
    };
  });

  attacks.push(unarmedStrike(input.abilityModifiers.str, input.proficiencyBonus));
  return attacks;
}
