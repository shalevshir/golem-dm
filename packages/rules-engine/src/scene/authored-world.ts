// The authored world as the scene engine consumes it, and the key format its
// relations map uses.
//
// This lives here rather than in `apps/server`, where `loadWorld` produced it
// through §4.7's step 2, because the scene engine is pure and may never
// import an app (invariant 5). `loadWorld` stays where it is — it reads
// `node:fs`, which neither this package nor browser-bundled `@ai-dm/schemas`
// may — and imports these two back from here.
//
// Declared as an interface rather than a zod schema because it holds `Map`s:
// it is neither a wire shape nor something that round-trips through JSON as
// written. `SrdGear` is the identical case in this package.
import type {
  FactionBand,
  FactionDefinition,
  LocationDefinition,
  NpcDefinition,
  QuestNode,
} from "@ai-dm/schemas";

/**
 * The authored world, indexed. `Map`s rather than arrays for the reason
 * `loadGear` returns them: every consumer looks content up by id.
 */
export interface AuthoredWorld {
  readonly worldId: string;
  readonly startingDay: number;
  readonly startingNodeId: string;
  readonly factions: ReadonlyMap<string, FactionDefinition>;
  readonly locations: ReadonlyMap<string, LocationDefinition>;
  readonly npcs: ReadonlyMap<string, NpcDefinition>;
  readonly questNodes: ReadonlyMap<string, QuestNode>;
  /** Keyed by `pairKey`, so a relation is an unordered pair. */
  readonly relations: ReadonlyMap<string, FactionBand>;
}

/**
 * Canonical key for an unordered faction pair, so declaring `A,B` and `B,A`
 * names one relation rather than two. `|` is safe as a delimiter because
 * `ContentId` forbids it.
 *
 * There is exactly one implementation of this format, and it is here. A
 * second one written inline anywhere is the invariant-4 duplicate.
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Recovers the two ids `pairKey` folded together. The ONLY other code, besides
 * `pairKey` itself, that reads the `|` separator.
 *
 * Sliced around the separator's index rather than `.split("|")` so the result
 * is two `string`s rather than two `string | undefined`s under
 * `noUncheckedIndexedAccess` — a key `pairKey` produced always has exactly one
 * `|`, since `ContentId` forbids the character in either id.
 */
export function splitPairKey(key: string): [string, string] {
  const separator = key.indexOf("|");
  return [key.slice(0, separator), key.slice(separator + 1)];
}
