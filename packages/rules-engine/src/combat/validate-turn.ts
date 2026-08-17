// `ExecuteTurn` validation — the single gate between an LLM proposal and state.
//
// The tactical agent proposes a turn; this decides whether the rules permit it.
// Rejections are returned, never thrown: each carries a stable machine-readable
// `reason` the agent retries against once, and which the server logs as an
// `action_rejected` event. All legality checks run, so a retry sees every
// problem at once rather than one per round-trip.
import type {
  ActionEconomy,
  Combatant,
  CreatureSize,
  EntityStatus,
  ExecuteTurn,
  GridMap,
  SpellSlots,
  Tile,
} from "@ai-dm/schemas";
import type { LineOfSightAlgorithm, OccupancyLookup, TilePassability } from "../spatial/index.js";
import {
  coverBetween,
  findPath,
  footprintDistanceFeet,
  nearestSquares,
  occupiedTiles,
} from "../spatial/index.js";
import {
  isImmobilised,
  isIncapacitated,
  isProne,
  movementBudgetFeet,
  spendAction,
  spendAttack,
  spendBonusAction,
  spendMovement,
} from "./action-economy.js";
import type { EconomyRejectionReason } from "./action-economy.js";
import { isDeadFromExhaustion } from "./exhaustion.js";

/** Everything the validator may consult. Assembled by the caller; never mutated. */
export interface CombatWorld {
  grid: GridMap;
  combatants: readonly Combatant[];
  /** Swappable per ADR-0003; defaults to the Bresenham house rule. */
  lineOfSight?: LineOfSightAlgorithm;
  /**
   * Reach or range in feet, keyed by `actionId`. Populated from the SRD data
   * pass (roadmap step 5); an absent entry falls back to the actor's melee
   * reach, which is the right default for weapon and unarmed attacks.
   */
  actionRangesFeet?: Readonly<Record<string, number | undefined>>;
}

export type TurnRejectionReason =
  | EconomyRejectionReason
  | "actor_mismatch"
  | "actor_cannot_act"
  | "actor_cannot_move"
  | "actor_incapacitated"
  | "movement_path_blocked"
  | "destination_off_grid"
  | "destination_occupied"
  | "extra_attacks_without_attack_action"
  | "target_not_found"
  | "target_out_of_reach"
  | "target_behind_full_cover"
  | "spell_slot_unavailable";

export interface TurnRejection {
  reason: TurnRejectionReason;
  /** English detail for the retry prompt and the `action_rejected` event. */
  message: string;
  /** The target, action, or actor the rejection concerns, when there is one. */
  subjectId?: string;
}

export interface MovementSegmentPlan {
  destinationTile: Tile;
  /** Includes both the tile the segment starts on and its destination. */
  path: Tile[];
  costFeet: number;
}

/** What the turn resolves to. The caller turns this into events. */
export interface TurnPlan {
  segments: MovementSegmentPlan[];
  totalMovementFeet: number;
  movementBudgetFeet: number;
  economyAfter: ActionEconomy;
  spellSlotsAfter: SpellSlots;
}

export type TurnValidation =
  { valid: true; plan: TurnPlan } | { valid: false; rejections: TurnRejection[] };

/** A corpse is scenery and a fled creature has left the map; neither blocks a tile. */
const OCCUPYING_STATUSES: readonly EntityStatus[] = ["alive", "unconscious"];

function feet(value: number): string {
  return `${String(value)} ft`;
}

function isOnGrid(grid: GridMap, tile: Tile): boolean {
  return tile[0] >= 0 && tile[1] >= 0 && tile[0] < grid.width && tile[1] < grid.height;
}

function sameTile(a: Tile, b: Tile): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** The creature's space — one square for Medium and smaller, 2x2 for Large, etc. */
function spaceOf(combatant: Combatant): Tile[] {
  return occupiedTiles({ anchor: combatant.position, size: combatant.size });
}

/** Where the mover's space would sit if it were anchored at `anchor`. */
function spaceAnchoredAt(mover: Combatant, anchor: Tile): Tile[] {
  return occupiedTiles({ anchor, size: mover.size });
}

function occupantOf(world: CombatWorld, tile: Tile, exceptId: string): Combatant | undefined {
  return world.combatants.find(
    (other) =>
      other.combatantId !== exceptId &&
      OCCUPYING_STATUSES.includes(other.status) &&
      spaceOf(other).some((part) => sameTile(part, tile)),
  );
}

const SIZE_RANK: Record<CreatureSize, number> = {
  tiny: 0,
  small: 1,
  medium: 2,
  large: 3,
  huge: 4,
  gargantuan: 5,
};

/**
 * SRD "Moving around Other Creatures": you may pass through the space of an
 * ally, a creature with the Incapacitated condition, a Tiny creature, or one
 * two sizes larger or smaller than you. Any other creature's space is Difficult
 * Terrain, unless the creature is Tiny or an ally.
 */
function passabilityThrough(mover: Combatant, occupant: Combatant): TilePassability {
  const ally = mover.faction === occupant.faction;
  const tiny = occupant.size === "tiny";
  const sizesApart = Math.abs(SIZE_RANK[mover.size] - SIZE_RANK[occupant.size]);

  if (!ally && !tiny && sizesApart < 2 && !isIncapacitated(occupant)) return "blocked";
  return ally || tiny ? "clear" : "hindered";
}

/** Reach for a melee action, range for anything the caller has range data for. */
function rangeFeetFor(actor: Combatant, world: CombatWorld, actionId: string | undefined): number {
  const configured = actionId === undefined ? undefined : world.actionRangesFeet?.[actionId];
  return configured ?? actor.reachFeet;
}

export function validateExecuteTurn(
  turn: ExecuteTurn,
  actor: Combatant,
  world: CombatWorld,
): TurnValidation {
  if (turn.actorId !== actor.combatantId) {
    return {
      valid: false,
      rejections: [
        {
          reason: "actor_mismatch",
          message: `Turn is addressed to ${turn.actorId} but was validated against ${actor.combatantId}`,
          subjectId: turn.actorId,
        },
      ],
    };
  }

  if (actor.status !== "alive" || isDeadFromExhaustion(actor.exhaustionLevel)) {
    return {
      valid: false,
      rejections: [
        {
          reason: "actor_cannot_act",
          message: `${actor.combatantId} cannot take a turn (status ${actor.status}, exhaustion ${String(actor.exhaustionLevel)})`,
          subjectId: actor.combatantId,
        },
      ],
    };
  }

  const rejections: TurnRejection[] = [];
  let economy = actor.actionEconomy;
  let spellSlotsAfter = actor.spellSlots;

  // --- Movement -----------------------------------------------------------
  const movement = turn.movement ?? [];
  const budgetFeet = movementBudgetFeet(actor, {
    dashed: turn.mainAction.actionType === "dash",
  });
  const segments: MovementSegmentPlan[] = [];
  let totalMovementFeet = 0;
  let position = actor.position;
  // A prone creature's only movement option is to crawl, unless it stands up —
  // which `ExecuteTurn` has no way to propose yet.
  const occupancy: OccupancyLookup = (tile) => {
    const occupant = occupantOf(world, tile, actor.combatantId);
    return occupant === undefined ? "clear" : passabilityThrough(actor, occupant);
  };
  const movementOptions = { crawling: isProne(actor), occupancy, size: actor.size };

  if (movement.length > 0 && isImmobilised(actor)) {
    rejections.push({
      reason: "actor_cannot_move",
      message: `${actor.combatantId} is held fast by a condition and has no movement`,
      subjectId: actor.combatantId,
    });
  } else {
    // Segments are ordered; the first illegal one invalidates the rest, since
    // every later segment departs from a tile the actor never reached.
    for (const segment of movement) {
      const destination = segment.destinationTile;

      // The creature's whole space has to fit, not just its anchor square.
      const wouldOccupy = spaceAnchoredAt(actor, destination);

      if (!wouldOccupy.every((tile) => isOnGrid(world.grid, tile))) {
        rejections.push({
          reason: "destination_off_grid",
          message: `A ${actor.size} creature anchored at ${String(destination)} does not fit inside the ${String(world.grid.width)}x${String(world.grid.height)} map`,
        });
        break;
      }

      const occupant = wouldOccupy
        .map((tile) => occupantOf(world, tile, actor.combatantId))
        .find((found) => found !== undefined);
      if (occupant !== undefined) {
        rejections.push({
          reason: "destination_occupied",
          message: `${occupant.combatantId} already occupies part of the space at ${String(destination)}`,
          subjectId: occupant.combatantId,
        });
        break;
      }

      const route = findPath(world.grid, position, destination, movementOptions);
      if (route === null) {
        rejections.push({
          reason: "movement_path_blocked",
          message: `No route from ${String(position)} to ${String(destination)}`,
        });
        break;
      }

      segments.push({
        destinationTile: destination,
        path: route.path,
        costFeet: route.costFeet,
      });
      totalMovementFeet += route.costFeet;
      position = destination;
    }

    const moved = spendMovement(economy, totalMovementFeet, budgetFeet);
    if (moved.ok) {
      economy = moved.economy;
    } else {
      const remaining = budgetFeet - economy.movementUsedFeet;
      rejections.push({
        reason: moved.reason,
        message: `Movement of ${feet(totalMovementFeet)} exceeds the ${feet(remaining)} still available this turn (speed budget ${feet(budgetFeet)})`,
        subjectId: actor.combatantId,
      });
    }
  }

  // --- Actions ------------------------------------------------------------
  if (isIncapacitated(actor)) {
    rejections.push({
      reason: "actor_incapacitated",
      message: `${actor.combatantId} is incapacitated and can take no action, bonus action, or reaction`,
      subjectId: actor.combatantId,
    });
    return { valid: false, rejections };
  }

  const action = spendAction(economy);
  if (action.ok) {
    economy = action.economy;
  } else {
    rejections.push({
      reason: action.reason,
      message: `${actor.combatantId} has already taken an action this turn`,
      subjectId: actor.combatantId,
    });
  }

  if (turn.bonusAction !== undefined) {
    const bonus = spendBonusAction(economy);
    if (bonus.ok) {
      economy = bonus.economy;
    } else {
      rejections.push({
        reason: bonus.reason,
        message: `${actor.combatantId} has already taken a bonus action this turn`,
        subjectId: turn.bonusAction.abilityId,
      });
    }
  }

  // --- Spell slots --------------------------------------------------------
  // No slot level means a cantrip, which costs nothing.
  const { slotLevel } = turn.mainAction;
  if (turn.mainAction.actionType === "cast_spell" && slotLevel !== undefined) {
    const level = String(slotLevel);
    const slot = spellSlotsAfter[level];
    if (slot === undefined || slot.current < 1) {
      rejections.push({
        reason: "spell_slot_unavailable",
        message: `No level ${level} spell slot remaining`,
        subjectId: turn.mainAction.actionId ?? level,
      });
    } else {
      spellSlotsAfter = { ...spellSlotsAfter, [level]: { ...slot, current: slot.current - 1 } };
    }
  }

  // --- Targeting ----------------------------------------------------------
  // Targets are measured from where the actor ends up, not where it started.
  const checkTarget = (targetId: string, actionId: string | undefined): void => {
    const target = world.combatants.find((other) => other.combatantId === targetId);
    if (target === undefined) {
      rejections.push({
        reason: "target_not_found",
        message: `No combatant ${targetId} in this encounter`,
        subjectId: targetId,
      });
      return;
    }

    // Range is counted between the nearest squares of the two spaces, so a
    // Huge creature is reachable from anywhere along its edge.
    const actorSpace = { anchor: position, size: actor.size };
    const targetSpace = { anchor: target.position, size: target.size };

    const reachFeet = rangeFeetFor(actor, world, actionId);
    const distanceFeet = footprintDistanceFeet(actorSpace, targetSpace);
    if (distanceFeet > reachFeet) {
      rejections.push({
        reason: "target_out_of_reach",
        message: `${targetId} is ${feet(distanceFeet)} away, beyond the ${feet(reachFeet)} reach of this action`,
        subjectId: targetId,
      });
      return;
    }

    const [from, to] = nearestSquares(actorSpace, targetSpace);
    if (coverBetween(world.grid, from, to, world.lineOfSight) === "full") {
      rejections.push({
        reason: "target_behind_full_cover",
        message: `${targetId} is behind full cover and cannot be targeted`,
        subjectId: targetId,
      });
    }
  };

  for (const targetId of turn.mainAction.targetIds ?? []) {
    checkTarget(targetId, turn.mainAction.actionId);
  }

  // --- Attack budget ------------------------------------------------------
  const extraAttacks = turn.extraAttacks ?? [];
  const isAttack = turn.mainAction.actionType === "attack";

  if (extraAttacks.length > 0 && !isAttack) {
    rejections.push({
      reason: "extra_attacks_without_attack_action",
      message: `Extra attacks require the Attack action, not ${turn.mainAction.actionType}`,
      subjectId: actor.combatantId,
    });
  } else {
    // Each target the Attack action names is a separate attack roll, and each
    // extra attack costs another. Only the Attack action spends this budget —
    // a spell may name many targets and still costs one action.
    const namedTargets = turn.mainAction.targetIds ?? [];
    const mainAttacks = isAttack ? Math.max(1, namedTargets.length) : 0;
    const proposedAttacks = isAttack ? mainAttacks + extraAttacks.length : 0;
    const overBudget = (): void => {
      rejections.push({
        reason: "extra_attacks_exceed_budget",
        message: `The Attack action grants ${String(actor.attacksPerAction)} attack(s); this turn proposes ${String(proposedAttacks)}`,
        subjectId: actor.combatantId,
      });
    };

    let budgetLeft = true;
    for (let swings = 0; swings < mainAttacks && budgetLeft; swings += 1) {
      const swing = spendAttack(economy, actor.attacksPerAction);
      if (swing.ok) economy = swing.economy;
      else {
        overBudget();
        budgetLeft = false;
      }
    }

    for (const extra of extraAttacks) {
      if (!budgetLeft) break;
      const swing = spendAttack(economy, actor.attacksPerAction);
      if (!swing.ok) {
        overBudget();
        break;
      }
      economy = swing.economy;
      checkTarget(extra.targetId, extra.actionId);
    }
  }

  if (rejections.length > 0) return { valid: false, rejections };

  return {
    valid: true,
    plan: {
      segments,
      totalMovementFeet,
      movementBudgetFeet: budgetFeet,
      economyAfter: economy,
      spellSlotsAfter,
    },
  };
}
