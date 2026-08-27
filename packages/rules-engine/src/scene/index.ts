// The scene engine (`PROJECT_PLAN.md` §4.7 step 3): evaluates the predicates
// and applies the effects step 2 authored as data.
//
// Pure, like everything else in this package. It takes the world injected —
// the way `buildEncounter` takes `statBlocks` — and never reads a file, a
// clock or a random source. The calendar advances only through a declared
// `advance_calendar` effect, because a wall-clock read is what makes a replay
// diverge (§4.6).
//
// Its relationship to combat is the one §4.7 describes: `validateExecuteTurn`
// adjudicates an LLM's proposed turn, and this adjudicates an LLM's proposed
// world move one level up. Same shape, same refusal-as-data contract.
import { FACTION_BANDS } from "@ai-dm/schemas";
import type { FactionBand, WorldPredicate } from "@ai-dm/schemas";
import { pairKey } from "./authored-world.js";

export * from "./authored-world.js";

/**
 * What the engine tracks across a campaign. Every function returns a new one;
 * none mutates its input, which the `readonly` markers make a compile error
 * rather than a convention.
 *
 * An interface rather than a zod schema for `AuthoredWorld`'s reason — it
 * holds a `Set` and a `Map`. Choosing a serialized form now would mean
 * deciding it before anything serializes it; §4.7's step 4 is what folds
 * these fields into `WorldState` and is where that choice belongs.
 */
export interface SceneState {
  readonly currentNodeId: string;
  readonly completedNodeIds: ReadonlySet<string>;
  /** Keyed by `pairKey`. */
  readonly relations: ReadonlyMap<string, FactionBand>;
  /** A bare counter. Advanced only by a declared `advance_calendar` effect. */
  readonly day: number;
}

/**
 * Faction standing shifted along `FACTION_BANDS`, clamped to its ends.
 *
 * The band list's order IS the -3..+3 scale (`content.ts`), so this is index
 * arithmetic and there is one table rather than two that can disagree.
 * Clamping rather than wrapping or throwing: `delta` is schema-bounded to
 * -6..+6, which is wider than the seven-band scale on purpose, so an author
 * can declare "as hostile as this gets" without knowing the starting band.
 */
export function shiftBand(band: FactionBand, delta: number): FactionBand {
  const shifted = FACTION_BANDS.indexOf(band) + delta;
  const clamped = Math.min(Math.max(shifted, 0), FACTION_BANDS.length - 1);
  // `noUncheckedIndexedAccess` types this as possibly undefined; the clamp
  // above is what makes it not, and `?? band` is the honest way to say so
  // without a non-null assertion, which eslint bans.
  return FACTION_BANDS[clamped] ?? band;
}

/**
 * Standing between two factions, asked in either order.
 *
 * `undefined` for a pair the state does not hold. A world from `loadWorld`
 * cannot produce that — it refuses a missing pair and a self-pair — but a
 * hand-assembled state can, and step 4 assembles one from a projection.
 */
export function relationBetween(
  state: SceneState,
  a: string,
  b: string,
): FactionBand | undefined {
  return state.relations.get(pairKey(a, b));
}

/**
 * Is this gate open, given what the campaign has done so far?
 *
 * Written as a `return` from each branch with no `default`, so adding a
 * `WorldPredicate` kind fails to compile here rather than silently
 * evaluating true — the same exhaustiveness discipline `reduce.ts` and the
 * loader's `predicateRefs` rely on. Do not add a `default`.
 */
export function evaluatePredicate(predicate: WorldPredicate, state: SceneState): boolean {
  switch (predicate.kind) {
    case "node_completed":
      return state.completedNodeIds.has(predicate.nodeId);
    case "faction_band_at_least": {
      const band = relationBetween(state, predicate.factionA, predicate.factionB);
      // An unknown standing does not establish that standing is at least
      // anything. False, not a throw: the caller is a router deciding what to
      // offer, and an unknown pair makes a gate closed rather than broken.
      if (band === undefined) return false;
      return FACTION_BANDS.indexOf(band) >= FACTION_BANDS.indexOf(predicate.band);
    }
  }
}
