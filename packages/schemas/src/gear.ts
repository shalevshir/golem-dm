// Equipment a player character can carry. Monsters need none of this: their
// stat blocks carry final attack bonuses, because "A monster is proficient
// with any weapon in its stat block" (SRD 5.2.1). Characters derive theirs.
import { z } from "zod";
import { DamageType, DiceNotation } from "./primitives.js";

export const WeaponProperty = z.enum([
  "ammunition",
  "finesse",
  "heavy",
  "light",
  "loading",
  "reach",
  "thrown",
  "two_handed",
  "versatile",
]);

/**
 * Weapon damage before the wielder's ability modifier. The blowgun deals a
 * flat "1 Piercing", so dice are optional — but a row carrying both a die and
 * a flat value is a transcription error, not a valid weapon.
 */
export const WeaponDamage = z
  .object({
    diceNotation: DiceNotation.optional(),
    fixedDamage: z.number().int().min(0).optional(),
    damageType: DamageType,
  })
  .refine(
    (damage) => (damage.diceNotation === undefined) !== (damage.fixedDamage === undefined),
    "a weapon carries exactly one of diceNotation or fixedDamage",
  );

export const WeaponDefinition = z.object({
  weaponId: z.string().regex(/^[a-z0-9_]+$/),
  nameEnglish: z.string(),
  nameHebrew: z.string().min(1),
  category: z.enum(["simple", "martial"]),
  /**
   * How the weapon is wielded by default, which fixes the ability used for
   * its attack. A Thrown melee weapon stays `melee`: the SRD has a thrown
   * weapon use the same modifier it would use for a melee attack.
   */
  kind: z.enum(["melee", "ranged"]),
  damage: WeaponDamage,
  /** Present exactly when `properties` includes `versatile`. */
  versatileDamage: WeaponDamage.optional(),
  properties: z.array(WeaponProperty).default([]),
  rangeFeet: z.number().int().multipleOf(5).optional(),
  longRangeFeet: z.number().int().multipleOf(5).optional(),
});

export type WeaponProperty = z.infer<typeof WeaponProperty>;
export type WeaponDamage = z.infer<typeof WeaponDamage>;
export type WeaponDefinition = z.infer<typeof WeaponDefinition>;
