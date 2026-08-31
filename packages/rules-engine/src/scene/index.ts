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
import type {
  FactionBand,
  ImprovisedEffect,
  NarrativeMove,
  QuestEdge,
  QuestNode,
  WorldEffect,
  WorldPredicate,
} from "@ai-dm/schemas";
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
  /** The node to return to on leaving a detour; `null` on the spine. */
  readonly detourReturnNodeId: string | null;
  readonly completedNodeIds: ReadonlySet<string>;
  /** Keyed by `pairKey`. */
  readonly relations: ReadonlyMap<string, FactionBand>;
  /** Keyed by bare npcId — no pairKey needed, this is not a pairwise relation. */
  readonly npcAffinities: ReadonlyMap<
    string,
    { readonly band: FactionBand; readonly facts: readonly string[] }
  >;
  /** A bare counter. Advanced only by a declared `advance_calendar` effect. */
  readonly day: number;
  /** The hero's current HP. Restored to their maximum only by a declared
   *  `long_rest` effect — this module never learns their maximum itself
   *  (see `applyEffect`'s injected `heroMaxHp`). */
  readonly heroHp: number;
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
 * An NPC's standing and remembered facts, read from the overlay with a
 * hardcoded default for any NPC nobody has interacted with yet. Unlike
 * `relationBetween`, there is no authored baseline to fall back to second —
 * a single sensible default covers every NPC, so declaring one per NPC in
 * `content.ts` would be authoring surface with no consumer (character-
 * profiles spec Decision 5).
 */
export function affinityOf(
  state: SceneState,
  npcId: string,
): { band: FactionBand; facts: readonly string[] } {
  return state.npcAffinities.get(npcId) ?? { band: "neutral", facts: [] };
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

export type SceneRejectionReason =
  | "no_such_node"
  | "no_such_edge"
  | "precondition_unmet"
  | "would_close_door"
  | "not_a_detour";

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
  { valid: true; state: SceneState } | { valid: false; rejections: readonly SceneRejection[] };

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
    return [{ reason: "no_such_node", message: `no quest node "${nodeId}"`, subjectId: nodeId }];
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
 * Deliberately NOT exported. An effect is reachable only two ways: a node
 * completing, or a `validateMove` "world" move the door guard and magnitude
 * ceiling have already adjudicated — never by a caller asking directly. That
 * second path is what keeps invariant 1 intact one level above combat: a
 * model can shift a faction band, but only within the ceiling `validateMove`
 * enforces and never by closing a door `closedDoors` finds open. It is fully
 * exercised through `traverseEdge`, `completeCurrentNode`, and `validateMove`,
 * which is a stronger test than calling it directly would be.
 *
 * It takes `world` because a shift starts from the band `relationBetween`
 * reports, which is the authored relation overlaid by the state rather than
 * the state alone.
 *
 * `heroMaxHp` is injected, the same way `buildEncounter` takes stat blocks
 * injected rather than loaded: this module is pure and knows nothing about a
 * specific character, so `long_rest` — the only case that needs it — is
 * handed the one fact it cannot derive. Absent (a caller with no hero to
 * rest, or one that has not resolved it) makes `long_rest` a no-op rather
 * than inventing a target HP.
 */
function applyEffect(
  world: AuthoredWorld,
  effect: WorldEffect,
  state: SceneState,
  heroMaxHp?: number,
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
    case "shift_npc_affinity": {
      // No "unknown pair" bail-out like the faction case: `affinityOf`'s
      // fallback always resolves, since a single hardcoded default (neutral,
      // no facts) covers every npc rather than an authored baseline to
      // consult (character-profiles spec Decision 4).
      const current = affinityOf(state, effect.npcId);
      const npcAffinities = new Map(state.npcAffinities);
      npcAffinities.set(effect.npcId, { ...current, band: shiftBand(current.band, effect.delta) });
      return { ...state, npcAffinities };
    }
    case "add_npc_fact": {
      const current = affinityOf(state, effect.npcId);
      const npcAffinities = new Map(state.npcAffinities);
      npcAffinities.set(effect.npcId, { ...current, facts: [...current.facts, effect.fact] });
      return { ...state, npcAffinities };
    }
    case "long_rest":
      return heroMaxHp === undefined ? state : { ...state, heroHp: heroMaxHp };
  }
}

/**
 * The state a node completing produces: itself marked done and its effects
 * applied — but only the first time, so a cycle cannot pump a faction shift
 * twice.
 */
function completed(
  world: AuthoredWorld,
  node: QuestNode,
  state: SceneState,
  heroMaxHp?: number,
): SceneState {
  if (state.completedNodeIds.has(node.nodeId)) return state;
  const completedNodeIds = new Set(state.completedNodeIds);
  completedNodeIds.add(node.nodeId);
  return node.effects.reduce<SceneState>(
    (each, effect) => applyEffect(world, effect, each, heroMaxHp),
    { ...state, completedNodeIds },
  );
}

/**
 * The campaign's opening state, or why the authored world has no enterable
 * entry point.
 *
 * Total rather than throwing on a missing start node, so `loadWorld` can call
 * it as a check rather than as a thing to catch.
 *
 * `heroHp: 0` is inert here — this is `loadWorld`'s enterability self-check,
 * never the live genesis path (`sceneFromGenesis` + `apps/server`'s
 * `initialWorldState`), and the self-check never applies an effect.
 */
export function startScene(world: AuthoredWorld): SceneTransition {
  const state: SceneState = {
    currentNodeId: world.startingNodeId,
    detourReturnNodeId: null,
    completedNodeIds: new Set<string>(),
    relations: world.relations,
    npcAffinities: new Map(),
    day: world.startingDay,
    heroHp: 0,
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
  // No `heroMaxHp`: this previews what leaving would look like without
  // applying anything, so a `long_rest` effect never restores HP here.
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
  heroMaxHp?: number,
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
  const after = completed(world, current, state, heroMaxHp);
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
  heroMaxHp?: number,
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
  return { valid: true, state: completed(world, current, state, heroMaxHp) };
}

export interface DetourOption {
  node: QuestNode;
  /** True exactly when `validateMove`'s `enter_detour` to this node would succeed. */
  open: boolean;
  /** Empty when `open`. Why not, otherwise. */
  rejections: readonly SceneRejection[];
}

/**
 * Every detour-marked node in the world, each with whether it can be entered
 * right now. What the GM tier's prompt is built from — the engine enumerates
 * the legal reach and the model picks from it, the same contract
 * `availableEdges` gives the intent router.
 *
 * Detours are world-wide rather than per-node: a detour has no authored
 * inbound edge, so there is no "out of here" relation to filter by. Its own
 * preconditions are the whole gate.
 */
export function availableDetours(world: AuthoredWorld, state: SceneState): readonly DetourOption[] {
  return Array.from(world.questNodes.values())
    .filter((node) => node.detour)
    .map((node) => {
      const rejections = entryRejections(world, state, node.nodeId);
      return { node, open: rejections.length === 0, rejections };
    });
}

/**
 * The improvised ceiling. Authored content keeps `WorldEffect`'s full -6..+6
 * range — an author declaring "as hostile as this gets" is deliberate — but a
 * model swinging a town from `cold` to `allied` because the player was polite
 * is not. Enforced here rather than in `ImprovisedEffect` so that schema stays
 * a pure subset of `WorldEffect` with no divergent bound to keep in sync.
 */
const MAX_IMPROVISED_DELTA = 1;

function magnitudeRejection(effect: ImprovisedEffect): SceneRejection | null {
  if (effect.kind !== "shift_faction_relation" && effect.kind !== "shift_npc_affinity") return null;
  if (Math.abs(effect.delta) <= MAX_IMPROVISED_DELTA) return null;
  return {
    reason: "precondition_unmet",
    message: `an improvised shift may move at most ${String(MAX_IMPROVISED_DELTA)} band, not ${String(effect.delta)}`,
  };
}

/**
 * The door guard, and the whole reason improvisation is safe: **a move may not
 * close a door that is currently open.**
 *
 * For every node not yet completed, a precondition that evaluates `true`
 * before must still evaluate `true` after. Three properties earn this its
 * place over a faction-specific rule:
 *
 *   - It is written over `evaluatePredicate`, so it covers every
 *     `WorldPredicate` kind that exists now and every one added later — the
 *     check-gated traversal the intent-router spec defers included — with no
 *     change here.
 *   - It refuses only CLOSING. A gate already shut staying shut is fine, and
 *     a gate opening is fine. Improvisation may make the world more reachable
 *     and never less.
 *   - It knows nothing about the shipped arc, yet makes that arc's
 *     zero-margin `reckoning` gate structurally unbreakable.
 *
 * ponytail: scans ALL uncompleted nodes, not only reachable ones — a node the
 * player can no longer get to still constrains what may be improvised.
 * Over-strict, and irrelevant at this graph size; add reachability analysis if
 * the world ever grows enough for it to bite.
 */
function closedDoors(
  world: AuthoredWorld,
  before: SceneState,
  after: SceneState,
): SceneRejection[] {
  const rejections: SceneRejection[] = [];
  for (const node of world.questNodes.values()) {
    if (before.completedNodeIds.has(node.nodeId)) continue;
    for (const precondition of node.preconditions) {
      if (!evaluatePredicate(world, before, precondition)) continue;
      if (evaluatePredicate(world, after, precondition)) continue;
      rejections.push({
        reason: "would_close_door",
        message: `this would make "${node.nodeId}" unreachable: it requires ${describePredicate(precondition)}`,
        subjectId: node.nodeId,
      });
    }
  }
  return rejections;
}

/**
 * A proposed `NarrativeMove`, adjudicated. The sibling of `traverseEdge` for
 * a move the authored graph did not enumerate, and the reason invariant 1
 * survives one level above combat: the GM tier proposes, this decides.
 *
 * Refusal is data, never a throw — the caller is a pipeline that degrades to
 * `{ kind: "none" }` and narrates on, not a retry loop.
 *
 * A `world` move is refused as a WHOLE when any effect offends. A partially
 * applied two-effect move is a state neither the author nor the model asked
 * for.
 */
export function validateMove(
  world: AuthoredWorld,
  state: SceneState,
  move: NarrativeMove,
): SceneTransition {
  switch (move.kind) {
    case "none":
      return { valid: true, state };

    case "world": {
      const magnitude = move.effects
        .map((effect) => magnitudeRejection(effect))
        .filter((each): each is SceneRejection => each !== null);
      if (magnitude.length > 0) return { valid: false, rejections: magnitude };

      // `applyEffect` stays unexported and is reached only from here and from
      // `completed()`: a move gets no privileged path into world state that a
      // completing node does not already have.
      const after = move.effects.reduce<SceneState>(
        (each, effect) => applyEffect(world, effect, each),
        state,
      );
      const doors = closedDoors(world, state, after);
      if (doors.length > 0) return { valid: false, rejections: doors };
      return { valid: true, state: after };
    }

    case "enter_detour": {
      // One level, by design. A stack would need its own serialized form and
      // nothing has asked for one.
      if (state.detourReturnNodeId !== null) {
        return {
          valid: false,
          rejections: [
            {
              reason: "precondition_unmet",
              message: "already on a detour; detours do not nest",
              subjectId: move.nodeId,
            },
          ],
        };
      }
      const node = world.questNodes.get(move.nodeId);
      if (node === undefined) {
        return {
          valid: false,
          rejections: [
            { reason: "no_such_node", message: `no quest node "${move.nodeId}"`, subjectId: move.nodeId },
          ],
        };
      }
      if (!node.detour) {
        return {
          valid: false,
          rejections: [
            {
              reason: "not_a_detour",
              message: `"${move.nodeId}" is a spine node and may only be reached by an authored edge`,
              subjectId: move.nodeId,
            },
          ],
        };
      }
      const rejections = entryRejections(world, state, move.nodeId);
      if (rejections.length > 0) return { valid: false, rejections };
      // The node being LEFT is deliberately not completed. A detour is a
      // departure, not a conclusion — the player is expected to come back,
      // and completing the spine node here would fire its effects early and
      // let `completed()`'s short-circuit block the real traversal later.
      return {
        valid: true,
        state: { ...state, currentNodeId: move.nodeId, detourReturnNodeId: state.currentNodeId },
      };
    }
  }
}
