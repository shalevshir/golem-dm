// Cross-cutting primitives with no dependency on the rest of the package.
// Split out of `srd.ts` so `gear.ts` (equipment) can depend on `DamageType`
// and `DiceNotation` without `srd.ts` ever needing to import back from
// `gear.ts` (for `ArmorCategory` / `WeaponProperty`) — that would close an
// ESM import cycle. zod dereferences these bindings eagerly at module init
// (`z.object({ damageType: DamageType })` reads `DamageType` immediately,
// not lazily), so such a cycle throws `ReferenceError` on import, not just
// on parse.
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

export type DamageType = z.infer<typeof DamageType>;
