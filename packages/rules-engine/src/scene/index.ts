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
import type { FactionBand, QuestEdge, QuestNode, WorldEffect, WorldPredicate } from "@ai-dm/schemas";
import { pairKey } from "./authored-world.js";
import type { AuthoredWorld } from "./authored-world.js";

export * from "./authored-world.js";
export * from "./snapshot.js";

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
 *
 * `delta` is typed `number`, not the schema's integer, so a fractional value
 * is truncated toward zero before indexing. Authored content cannot produce
 * one — `WorldEffect.delta` is `z.number().int()` — but a hand-built caller
 * could, and `FACTION_BANDS[3.5]` is `undefined`, which would otherwise fall
 * through `?? band` as a silent no-op rather than a shift.
 */
export function shiftBand(band: FactionBand, delta: number): FactionBand {
  const shifted = FACTION_BANDS.indexOf(band) + Math.trunc(delta);
  const clamped = Math.min(Math.max(shifted, 0), FACTION_BANDS.length - 1);
  // `noUncheckedIndexedAccess` types this as possibly undefined; the clamp
  // above is what makes it not, and `?? band` is the honest way to say so
  // without a non-null assertion, which eslint bans.
  return FACTION_BANDS[clamped] ?? band;
}

/**
 * Standing between two factions, asked in either order.
 *
 * The authored relation is the baseline and the state is the overlay: a
 * `SceneState` folded out of the event log may carry only the pairs that have
 * actually changed, since the rest are already in `world.json`. Reading the
 * state alone would make an unrecorded pair look like it has no standing at
 * all — which silently closes every gate over it and cancels every shift.
 *
 * This is the ONE place that rule is written. Every reader of a band goes
 * through here, so a second copy of `state ?? world` anywhere is a bug.
 *
 * `undefined` only when neither the state nor the authored world declares the
 * pair. A world from `loadWorld` cannot produce that — it refuses a missing
 * pair and a self-pair — so reaching it means a hand-built world.
 */
export function relationBetween(
  world: AuthoredWorld,
  state: SceneState,
  a: string,
  b: string,
): FactionBand | undefined {
  const key = pairKey(a, b);
  return state.relations.get(key) ?? world.relations.get(key);
}

/**
 * Is this gate open, given what the campaign has done so far?
 *
 * Written as a `return` from each branch with no `default`, so adding a
 * `WorldPredicate` kind fails to compile here rather than silently
 * evaluating true — the same exhaustiveness discipline `reduce.ts` and the
 * loader's `predicateRefs` rely on. Do not add a `default`.
 */
export function evaluatePredicate(
  world: AuthoredWorld,
  state: SceneState,
  predicate: WorldPredicate,
): boolean {
  switch (predicate.kind) {
    case "node_completed":
      return state.completedNodeIds.has(predicate.nodeId);
    case "faction_band_at_least": {
      const band = relationBetween(world, state, predicate.factionA, predicate.factionB);
      // An unknown standing does not establish that standing is at least
      // anything. False, not a throw: the caller is a router deciding what to
      // offer, and an unknown pair makes a gate closed rather than broken.
      // With the authored baseline behind it this now means a pair NEITHER
      // the state nor the world declares, which authored content cannot be.
      if (band === undefined) return false;
      return FACTION_BANDS.indexOf(band) >= FACTION_BANDS.indexOf(predicate.band);
    }
  }
}

export type SceneRejectionReason = "no_such_node" | "no_such_edge" | "precondition_unmet";

export interface SceneRejection {
  reason: SceneRejectionReason;
  /** English detail: a refused turn's narration, or a corrupt-log throw. */
  message: string;
  /** The node this rejection concerns, when there is one. */
  subjectId?: string;
}

/**
 * What a move resolves to. Nothing throws for a refusal, for the reason
 * `validateExecuteTurn` does not: the caller is a retry loop around a model,
 * and a refusal it has to read and explain is data rather than an exception.
 *
 * A rejection list carries EVERY failed precondition, not the first — the
 * same argument `WorldContentError` makes about defects.
 */
export type SceneTransition =
  | { valid: true; state: SceneState }
  | { valid: false; rejections: readonly SceneRejection[] };

export interface EdgeOption {
  edge: QuestEdge;
  /** True exactly when `traverseEdge` to this edge's target would succeed. */
  open: boolean;
  /** Empty when `open`. Why not, otherwise. */
  rejections: readonly SceneRejection[];
}

/**
 * What asking for the current node's choices resolves to.
 *
 * A union rather than a bare array so that "this node has no way out" and
 * "this node does not exist" are distinguishable. A terminal node answers
 * `{ valid: true, edges: [] }`; a state pointing at content that has since
 * been renamed answers `{ valid: false }` with the same `no_such_node`
 * rejection `traverseEdge` and `completeCurrentNode` give — otherwise a
 * router reading `[]` narrates an ending for a campaign that is actually
 * broken.
 */
export type SceneOptions =
  | { valid: true; edges: readonly EdgeOption[] }
  | { valid: false; rejections: readonly SceneRejection[] };

/**
 * The refusal every entry point gives for a `currentNodeId` that resolves to
 * no node. Written once so `availableEdges`, `traverseEdge` and
 * `completeCurrentNode` cannot answer the same corrupt state differently.
 */
function missingCurrentNode(state: SceneState): SceneRejection {
  return {
    reason: "no_such_node",
    message: `no quest node "${state.currentNodeId}"`,
    subjectId: state.currentNodeId,
  };
}

/** Why entering `nodeId` from `state` would be refused. Empty means it would not. */
function entryRejections(
  world: AuthoredWorld,
  state: SceneState,
  nodeId: string,
): SceneRejection[] {
  const node = world.questNodes.get(nodeId);
  if (node === undefined) {
    return [
      { reason: "no_such_node", message: `no quest node "${nodeId}"`, subjectId: nodeId },
    ];
  }
  return node.preconditions
    .filter((precondition) => !evaluatePredicate(world, state, precondition))
    .map((precondition) => ({
      reason: "precondition_unmet" as const,
      message: `entering "${nodeId}" requires ${describePredicate(precondition)}`,
      subjectId: nodeId,
    }));
}

/** English, for a rejection message. Same no-`default` exhaustiveness contract. */
function describePredicate(predicate: WorldPredicate): string {
  switch (predicate.kind) {
    case "node_completed":
      return `"${predicate.nodeId}" to be completed`;
    case "faction_band_at_least":
      return `${predicate.factionA} and ${predicate.factionB} to be at least ${predicate.band}`;
  }
}

/**
 * One declared world change, applied. Same exhaustiveness contract as
 * `evaluatePredicate`.
 *
 * Deliberately NOT exported. An effect is reachable only through a node
 * completing, which is what keeps invariant 1 intact one level above combat:
 * nothing can shift a faction band by asking. It is fully exercised through
 * `traverseEdge` and `completeCurrentNode`, which is a stronger test than
 * calling it directly would be.
 *
 * It takes `world` because a shift starts from the band `relationBetween`
 * reports, which is the authored relation overlaid by the state rather than
 * the state alone.
 */
function applyEffect(
  world: AuthoredWorld,
  effect: WorldEffect,
  state: SceneState,
): SceneState {
  switch (effect.kind) {
    case "shift_faction_relation": {
      const current = relationBetween(world, state, effect.factionA, effect.factionB);
      // Still a no-op when neither the state nor the authored world declares
      // the pair, rather than an invention: `loadWorld` refuses an effect
      // naming an unknown faction, so reaching this means a hand-built world,
      // and inventing `neutral` here would put a relation in the map that no
      // author declared.
      if (current === undefined) return state;
      const key = pairKey(effect.factionA, effect.factionB);
      const relations = new Map(state.relations);
      relations.set(key, shiftBand(current, effect.delta));
      return { ...state, relations };
    }
    case "advance_calendar":
      return { ...state, day: state.day + effect.days };
  }
}

/**
 * The state a node completing produces: itself marked done and its effects
 * applied — but only the first time, so a cycle cannot pump a faction shift
 * twice.
 */
function completed(world: AuthoredWorld, node: QuestNode, state: SceneState): SceneState {
  if (state.completedNodeIds.has(node.nodeId)) return state;
  const completedNodeIds = new Set(state.completedNodeIds);
  completedNodeIds.add(node.nodeId);
  return node.effects.reduce<SceneState>(
    (each, effect) => applyEffect(world, effect, each),
    { ...state, completedNodeIds },
  );
}

/**
 * The campaign's opening state, or why the authored world has no enterable
 * entry point.
 *
 * Total rather than throwing on a missing start node, so `loadWorld` can call
 * it as a check rather than as a thing to catch.
 */
export function startScene(world: AuthoredWorld): SceneTransition {
  const state: SceneState = {
    currentNodeId: world.startingNodeId,
    completedNodeIds: new Set<string>(),
    relations: world.relations,
    day: world.startingDay,
  };
  const rejections = entryRejections(world, state, world.startingNodeId);
  if (rejections.length > 0) return { valid: false, rejections };
  return { valid: true, state };
}

/**
 * Every edge out of the current node, each with whether it can be taken.
 *
 * Returns the closed ones too: step 4's router has to be able to say why a
 * choice is unavailable, and a caller wanting only the open ones filters in
 * one line. It shares `entryRejections` with `traverseEdge`, so what this
 * calls open and what that accepts cannot drift apart.
 *
 * An unknown `currentNodeId` is refused with the same `no_such_node`
 * rejection its siblings give, so a router cannot mistake missing content for
 * a scene that has simply run out of choices.
 */
export function availableEdges(world: AuthoredWorld, state: SceneState): SceneOptions {
  const current = world.questNodes.get(state.currentNodeId);
  if (current === undefined) {
    return { valid: false, rejections: [missingCurrentNode(state)] };
  }
  const after = completed(world, current, state);
  return {
    valid: true,
    edges: current.edges.map((edge) => {
      const rejections = entryRejections(world, after, edge.to);
      return { edge, open: rejections.length === 0, rejections };
    }),
  };
}

/**
 * Leave the current node by an edge: complete it, then enter the target.
 *
 * Preconditions are evaluated against the POST-completion state because
 * `content.ts` says predicates gate the node and "traversing an edge is
 * entering its target" — the shipped arc's second node requires the first to
 * be completed and is reached by leaving it, so any other order makes every
 * authored arc illegal at its first move.
 *
 * Nothing is committed when the target refuses: the returned rejections
 * describe a move that did not happen.
 */
export function traverseEdge(
  world: AuthoredWorld,
  state: SceneState,
  to: string,
): SceneTransition {
  const current = world.questNodes.get(state.currentNodeId);
  if (current === undefined) {
    return { valid: false, rejections: [missingCurrentNode(state)] };
  }
  if (!current.edges.some((edge) => edge.to === to)) {
    return {
      valid: false,
      rejections: [
        {
          reason: "no_such_edge",
          message: `"${state.currentNodeId}" has no edge to "${to}"`,
          subjectId: to,
        },
      ],
    };
  }
  const after = completed(world, current, state);
  const rejections = entryRejections(world, after, to);
  if (rejections.length > 0) return { valid: false, rejections };
  return { valid: true, state: { ...after, currentNodeId: to } };
}

/**
 * Finish the current node without leaving it. What applies a terminal node's
 * effects — the shipped arc's `reckoning` has effects and no edges, so without
 * this they are declared by an author and applied by nothing.
 *
 * The node's own preconditions are re-checked first. Entry is already gated by
 * `startScene` and `traverseEdge`, but they are not the only producers of a
 * `SceneState` once step 4 folds one out of the event log — and completing a
 * node applies its declared effects, so it may not be the one door into them
 * that skips the gate.
 *
 * Idempotent, through the same first-completion guard as traversal.
 */
export function completeCurrentNode(
  world: AuthoredWorld,
  state: SceneState,
): SceneTransition {
  const current = world.questNodes.get(state.currentNodeId);
  if (current === undefined) {
    return { valid: false, rejections: [missingCurrentNode(state)] };
  }
  // Already completed: a no-op, and the precondition check below must NOT run.
  // A node whose own effects invalidate its own gate — a `cordial` gate over a
  // pair its effect shifts down — would otherwise refuse its own second call,
  // which is the idempotency this function promises. The gate belongs to the
  // transition into a node, not to the state of already being past it.
  if (state.completedNodeIds.has(current.nodeId)) return { valid: true, state };
  const rejections = entryRejections(world, state, state.currentNodeId);
  if (rejections.length > 0) return { valid: false, rejections };
  return { valid: true, state: completed(world, current, state) };
}
