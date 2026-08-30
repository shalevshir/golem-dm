// Converters between the wire-shaped `SceneSnapshot` (`@ai-dm/schemas`) and
// the engine's own `SceneState` (`./index.ts`), and `diffScene`, which turns
// one `SceneState` transition into the absolute-value payload an event
// carries (invariant 3: no delta to compute on replay).
//
// Lives beside `pairKey`/`splitPairKey` per the design spec's Decision 2: a
// converter written anywhere else would re-derive the `|` key format, the
// invariant-4 duplicate `authored-world.ts` already warns about.
import type {
  ContentId,
  FactionRelationEntry,
  NpcAffinityEntry,
  SceneSnapshot,
} from "@ai-dm/schemas";
import { pairKey, splitPairKey } from "./authored-world.js";
import type { SceneState } from "./index.js";

/**
 * A folded `SceneSnapshot` as the engine's own shape.
 *
 * `relations` is keyed by `pairKey`, not by the snapshot entry's own field
 * order. A snapshot can hold `{factionA: "raiders", factionB: "millers"}` for
 * a pair a world declares the other way round — Task 3's fold writes a
 * payload's `FactionRelationEntry` verbatim — and keying positionally would
 * turn one overlay pair into two map entries that silently disagree.
 */
export function sceneStateFrom(snapshot: SceneSnapshot): SceneState {
  return {
    currentNodeId: snapshot.currentNodeId,
    completedNodeIds: new Set(snapshot.completedNodeIds),
    relations: new Map(
      snapshot.relations.map((entry) => [pairKey(entry.factionA, entry.factionB), entry.band]),
    ),
    npcAffinities: new Map(snapshot.npcAffinities.map((entry) => [entry.npcId, entry])),
    day: snapshot.day,
  };
}

/**
 * The engine's `SceneState` as a `SceneSnapshot`, canonical: `relations` and
 * `completedNodeIds` sorted, so two folds of the same state serialize
 * identically rather than merely `toEqual`-comparably.
 */
export function snapshotOf(state: SceneState, worldId: ContentId): SceneSnapshot {
  const relations: FactionRelationEntry[] = Array.from(state.relations, ([key, band]) => {
    const [factionA, factionB] = splitPairKey(key);
    return { factionA, factionB, band };
  }).sort((a, b) => a.factionA.localeCompare(b.factionA) || a.factionB.localeCompare(b.factionB));
  const npcAffinities: NpcAffinityEntry[] = Array.from(
    state.npcAffinities,
    ([npcId, { band, facts }]) => ({ npcId, band, facts: [...facts] }),
  ).sort((a, b) => a.npcId.localeCompare(b.npcId));
  return {
    worldId,
    currentNodeId: state.currentNodeId,
    completedNodeIds: Array.from(state.completedNodeIds).sort(),
    relations,
    npcAffinities,
    day: state.day,
  };
}

/**
 * What an event payload needs to carry after a `SceneState` transition:
 * absolute values, per invariant 3, never deltas a reader would have to
 * compute.
 */
export interface SceneDelta {
  relations: FactionRelationEntry[];
  npcAffinities: NpcAffinityEntry[];
  day?: number;
}

/**
 * `before` and `after` compared directly — no effect re-application, no
 * authored world consulted (design spec Decision 4's last paragraph). The
 * engine already computed `after`; the delta is just what differs between its
 * `relations` map and `before`'s.
 */
export function diffScene(before: SceneState, after: SceneState): SceneDelta {
  const relations: FactionRelationEntry[] = [];
  for (const [key, band] of after.relations) {
    if (before.relations.get(key) !== band) {
      const [factionA, factionB] = splitPairKey(key);
      relations.push({ factionA, factionB, band });
    }
  }
  const npcAffinities: NpcAffinityEntry[] = [];
  for (const [npcId, entry] of after.npcAffinities) {
    const beforeEntry = before.npcAffinities.get(npcId);
    const changed =
      beforeEntry === undefined ||
      beforeEntry.band !== entry.band ||
      beforeEntry.facts.length !== entry.facts.length ||
      beforeEntry.facts.some((fact, i) => fact !== entry.facts[i]);
    if (changed) npcAffinities.push({ npcId, band: entry.band, facts: [...entry.facts] });
  }
  const delta: SceneDelta = { relations, npcAffinities };
  if (after.day !== before.day) delta.day = after.day;
  return delta;
}
