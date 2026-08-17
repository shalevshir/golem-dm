// The scripted baseline. It drives the party in every run, and both sides in the
// control arm that "win rate vs baseline" is measured against.
//
// It is deliberately one notch smarter than `deterministicFallback` from
// `@ai-dm/agents`: it moves. A baseline that stands still would make any model
// that walks look good, which is not a finding.
//
// It is not clever. It picks the nearest living enemy, prefers an action that
// already reaches, steps to the closest square from which it can attack, and —
// when nothing this turn brings it into range at all — advances as far toward
// the nearest enemy as its movement budget allows rather than standing still.
// Every candidate goes through `validateExecuteTurn`; this file never decides a
// turn is legal, and it never reimplements the rules engine's pathfinding,
// distance metric, or corner-cutting rules.
import type { AvailableAction } from "@ai-dm/agents";
import type { CombatWorld, MovementOptions, OccupancyLookup, TurnPlan } from "@ai-dm/rules-engine";
import {
  findPath,
  footprintDistanceFeet,
  isImmobilised,
  isProne,
  movementBudgetFeet,
  occupiedTiles,
  validateExecuteTurn,
} from "@ai-dm/rules-engine";
import type { Combatant, ExecuteTurn, Faction, Tile } from "@ai-dm/schemas";

export interface ScriptedPolicyInput {
  world: CombatWorld;
  actorId: string;
  availableActions: readonly AvailableAction[];
}

export interface DecidedTurn {
  turn: ExecuteTurn;
  plan: TurnPlan;
}

const ATTACK_RATIONALE = "Baseline: attacking the nearest reachable enemy.";
const ADVANCE_RATIONALE = "Baseline: closing on the nearest enemy, then attacking.";
const PARTIAL_ADVANCE_RATIONALE =
  "Baseline: nothing in range this turn, so closing as much distance as movement allows.";
const DODGE_RATIONALE = "Baseline: nothing reachable, so taking the Dodge action.";

/** Policy, not rules — 5e lets you attack an ally, so the engine has no opinion. */
function opposes(actor: Faction, other: Faction): boolean {
  if (actor === "party") return other === "hostile";
  if (actor === "hostile") return other === "party";
  return false;
}

function actorIn(world: CombatWorld, actorId: string): Combatant {
  const found = world.combatants.find((each) => each.combatantId === actorId);
  if (found === undefined) throw new Error(`No combatant ${actorId} in this encounter`);
  return found;
}

/** Nearest first; ties broken on id so the same board always yields the same turn. */
function enemiesByDistance(actor: Combatant, world: CombatWorld): Combatant[] {
  const actorSpace = { anchor: actor.position, size: actor.size };
  return world.combatants
    .filter((each) => each.status === "alive" && opposes(actor.faction, each.faction))
    .map((each) => ({
      combatant: each,
      distanceFeet: footprintDistanceFeet(actorSpace, { anchor: each.position, size: each.size }),
    }))
    .sort((left, right) =>
      left.distanceFeet !== right.distanceFeet
        ? left.distanceFeet - right.distanceFeet
        : left.combatant.combatantId.localeCompare(right.combatant.combatantId),
    )
    .map((each) => each.combatant);
}

function attackTurn(
  actorId: string,
  targetId: string,
  actionId: string,
  movement?: Tile,
): ExecuteTurn {
  return {
    actorId,
    ...(movement === undefined
      ? {}
      : { movement: [{ destinationTile: movement, pathType: "direct" as const }] }),
    mainAction: { actionType: "attack", actionId, targetIds: [targetId] },
    tacticalRationaleEnglish: movement === undefined ? ATTACK_RATIONALE : ADVANCE_RATIONALE,
  };
}

/**
 * Squares to try stepping to, nearest to the target first. A ring around the
 * target's anchor at a few radii, deduplicated and ordered deterministically —
 * enough for a baseline, and bounded so a big map cannot make this quadratic.
 */
function approachTiles(target: Combatant, world: CombatWorld): Tile[] {
  const [tx, ty] = target.position;
  const tiles: Tile[] = [];
  for (let radius = 1; radius <= 3; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tile: Tile = [tx + dx, ty + dy];
        if (tile[0] < 0 || tile[1] < 0) continue;
        if (tile[0] >= world.grid.width || tile[1] >= world.grid.height) continue;
        tiles.push(tile);
      }
    }
  }
  return tiles;
}

function tileKey(tile: Tile): string {
  return `${String(tile[0])},${String(tile[1])}`;
}

/**
 * Conservative occupancy for the baseline's own route-finding: any square held
 * by a living or unconscious creature (ally or foe) is off-limits. This is
 * simpler than the rules engine's real "moving around other creatures" rule
 * (which lets you cross an ally's or a Tiny creature's space) — deliberately
 * so, since this is only used to pick a *candidate* destination. Every
 * candidate still passes through `validateExecuteTurn`, which applies the real
 * rule and can only find a route at least as good as this one.
 */
function conservativeOccupancy(world: CombatWorld, actorId: string): OccupancyLookup {
  const blocked = new Set<string>();
  for (const other of world.combatants) {
    if (other.combatantId === actorId) continue;
    if (other.status !== "alive" && other.status !== "unconscious") continue;
    for (const tile of occupiedTiles({ anchor: other.position, size: other.size })) {
      blocked.add(tileKey(tile));
    }
  }
  return (tile) => (blocked.has(tileKey(tile)) ? "blocked" : "clear");
}

function movementOptionsFor(actor: Combatant, world: CombatWorld): MovementOptions {
  return {
    crawling: isProne(actor),
    occupancy: conservativeOccupancy(world, actor.combatantId),
    size: actor.size,
  };
}

/**
 * The furthest tile along `path` (which starts at the actor's own position)
 * that a fresh `findPath` call still prices at or under `budgetFeet`. Shortest
 * paths have the prefix-optimality property — the prefix of a shortest route is
 * itself a shortest route to the intermediate tile — so re-querying `findPath`
 * against tiles drawn from the already-computed path gives a monotonic cost
 * sequence, and a binary search over its length (never over the grid) finds the
 * answer in O(log path length) calls.
 */
function furthestWithinBudget(
  world: CombatWorld,
  start: Tile,
  path: readonly Tile[],
  budgetFeet: number,
  options: MovementOptions,
): Tile | null {
  let low = 1;
  let high = path.length - 1;
  let best: Tile | null = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = path[mid];
    if (candidate === undefined) break;

    const route = findPath(world.grid, start, candidate, options);
    const costFeet = route?.costFeet ?? Number.POSITIVE_INFINITY;
    if (costFeet <= budgetFeet) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

/**
 * Nothing attacks from here or from any square within charging distance. Rather
 * than stand still, advance as far toward the nearest enemy as this turn's
 * movement budget allows — closing the distance is strictly better than a
 * baseline that dodges in place, and lets a long corridor or a wide-open field
 * resolve over several turns instead of stalling forever.
 */
function partialAdvanceTurn(
  actorId: string,
  actor: Combatant,
  enemies: readonly Combatant[],
  world: CombatWorld,
): ExecuteTurn | null {
  if (isImmobilised(actor)) return null;
  const budgetFeet = movementBudgetFeet(actor);
  if (budgetFeet <= 0) return null;

  const options = movementOptionsFor(actor, world);

  for (const enemy of enemies) {
    for (const tile of approachTiles(enemy, world)) {
      const route = findPath(world.grid, actor.position, tile, options);
      if (route === null) continue;

      const destination = furthestWithinBudget(
        world,
        actor.position,
        route.path,
        budgetFeet,
        options,
      );
      if (destination === null) continue;

      return {
        actorId,
        movement: [{ destinationTile: destination, pathType: "direct" }],
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: PARTIAL_ADVANCE_RATIONALE,
      };
    }
  }

  return null;
}

export function scriptedTurn(input: ScriptedPolicyInput): DecidedTurn | null {
  const actor = actorIn(input.world, input.actorId);
  const enemies = enemiesByDistance(actor, input.world);
  const actionIds = input.availableActions.map((action) => action.actionId);

  // 1. Attack from where we stand. Longest-reaching action first, so a bow is
  //    tried before a scimitar at distance and the first legal hit wins.
  const byReach = [...actionIds].sort(
    (left, right) =>
      (input.world.actionRangesFeet?.[right] ?? actor.reachFeet) -
      (input.world.actionRangesFeet?.[left] ?? actor.reachFeet),
  );

  for (const enemy of enemies) {
    for (const actionId of byReach) {
      const turn = attackTurn(input.actorId, enemy.combatantId, actionId);
      const validation = validateExecuteTurn(turn, actor, input.world);
      if (validation.valid) return { turn, plan: validation.plan };
    }
  }

  // 2. Step into contact, then attack. First legal combination wins; candidates
  //    are ordered nearest-target-first, so this is a charge, not a wander.
  for (const enemy of enemies) {
    for (const tile of approachTiles(enemy, input.world)) {
      for (const actionId of byReach) {
        const turn = attackTurn(input.actorId, enemy.combatantId, actionId, tile);
        const validation = validateExecuteTurn(turn, actor, input.world);
        if (validation.valid) return { turn, plan: validation.plan };
      }
    }
  }

  // 3. Nothing this turn brings it into range. Close as much distance as the
  //    movement budget allows, so the encounter keeps advancing instead of
  //    dodging in place until `maxRounds` with no winner.
  const advance = partialAdvanceTurn(input.actorId, actor, enemies, input.world);
  if (advance !== null) {
    const validation = validateExecuteTurn(advance, actor, input.world);
    if (validation.valid) return { turn: advance, plan: validation.plan };
  }

  // 4. Nothing worked. Dodge is inert in this harness (see resolve.ts) but it is
  //    a legal turn, which keeps the encounter advancing.
  const dodge: ExecuteTurn = {
    actorId: input.actorId,
    mainAction: { actionType: "dodge" },
    tacticalRationaleEnglish: DODGE_RATIONALE,
  };
  const validation = validateExecuteTurn(dodge, actor, input.world);
  return validation.valid ? { turn: dodge, plan: validation.plan } : null;
}
