// Cross-cutting primitives with no dependency on the rest of the package.
// Split out of `srd.ts` so `gear.ts` (equipment) can depend on `DamageType`
// and `DiceNotation` without `srd.ts` ever needing to import back from
// `gear.ts` (for `ArmorCategory` / `WeaponProperty`) — that would close an
// ESM import cycle. zod dereferences these bindings eagerly at module init
// (`z.object({ damageType: DamageType })` reads `DamageType` immediately,
// not lazily), so such a cycle throws `ReferenceError` on import, not just
// on parse. `CreatureSize` lives here for the same reason: `world.ts`
// imports `character.ts`, so `character.ts` cannot import a size type back
// from `world.ts` without closing that cycle — it belongs in a file that
// depends on neither.
import { z } from "zod";

export const DamageType = z.enum([
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
]);

/** Dice the rules engine can parse, e.g. "1d6+2", "2d8", "8d10+24". */
export const DiceNotation = z
  .string()
  .regex(/^\d+d\d+([+-]\d+)?$/, "expected dice notation such as 1d6+2");

/**
 * SRD 5.2.1 Creature Size and Space. Order matters — the rule for moving
 * through another creature's space is stated in size categories apart.
 */
export const CreatureSize = z.enum(["tiny", "small", "medium", "large", "huge", "gargantuan"]);

export type DamageType = z.infer<typeof DamageType>;
export type CreatureSize = z.infer<typeof CreatureSize>;
