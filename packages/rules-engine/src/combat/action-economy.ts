// Action-economy state machine: what a creature has left to spend this turn.
// Every transition is total — it either returns the next economy or a stable
// reason code. Nothing here throws; `validateExecuteTurn` forwards the codes.
import type { ActionEconomy, Combatant, Condition } from "@ai-dm/schemas";
import { exhaustionSpeedPenaltyFeet } from "./exhaustion.js";

export type EconomyRejectionReason =
  | "action_already_used"
  | "bonus_action_already_used"
  | "reaction_already_used"
  | "movement_exceeds_speed"
  | "extra_attacks_exceed_budget";

export type EconomyResult =
  { ok: true; economy: ActionEconomy } | { ok: false; reason: EconomyRejectionReason };

/** 2024: each of these conditions includes the Incapacitated condition. */
const INCAPACITATING_CONDITIONS: readonly Condition[] = [
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
];

/** Conditions that drop speed to 0 outright, whatever the creature's speed is. */
const IMMOBILISING_CONDITIONS: readonly Condition[] = [
  "grappled",
  "restrained",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
];

function hasAnyCondition(actor: Combatant, conditions: readonly Condition[]): boolean {
  return actor.conditions.some((active) => conditions.includes(active.condition));
}

/** The economy a creature opens its turn with. Reactions refresh here. */
export function startTurn(): ActionEconomy {
  return {
    actionUsed: false,
    bonusActionUsed: false,
    reactionUsed: false,
    movementUsedFeet: 0,
    attacksMade: 0,
  };
}

export function spendAction(economy: ActionEconomy): EconomyResult {
  if (economy.actionUsed) return { ok: false, reason: "action_already_used" };
  return { ok: true, economy: { ...economy, actionUsed: true } };
}

export function spendBonusAction(economy: ActionEconomy): EconomyResult {
  if (economy.bonusActionUsed) return { ok: false, reason: "bonus_action_already_used" };
  return { ok: true, economy: { ...economy, bonusActionUsed: true } };
}

export function spendReaction(economy: ActionEconomy): EconomyResult {
  if (economy.reactionUsed) return { ok: false, reason: "reaction_already_used" };
  return { ok: true, economy: { ...economy, reactionUsed: true } };
}

export function spendMovement(
  economy: ActionEconomy,
  feet: number,
  budgetFeet: number,
): EconomyResult {
  const movementUsedFeet = economy.movementUsedFeet + feet;
  if (movementUsedFeet > budgetFeet) return { ok: false, reason: "movement_exceeds_speed" };
  return { ok: true, economy: { ...economy, movementUsedFeet } };
}

/** One swing of the Attack action — the action itself grants the first. */
export function spendAttack(economy: ActionEconomy, attacksPerAction: number): EconomyResult {
  if (economy.attacksMade >= attacksPerAction) {
    return { ok: false, reason: "extra_attacks_exceed_budget" };
  }
  return { ok: true, economy: { ...economy, attacksMade: economy.attacksMade + 1 } };
}

/** Incapacitated creatures take no action, bonus action, or reaction. */
export function isIncapacitated(actor: Combatant): boolean {
  return hasAnyCondition(actor, INCAPACITATING_CONDITIONS);
}

/** Held fast by a condition — distinct from simply having no budget left. */
export function isImmobilised(actor: Combatant): boolean {
  return hasAnyCondition(actor, IMMOBILISING_CONDITIONS);
}

export function isProne(actor: Combatant): boolean {
  return hasAnyCondition(actor, ["prone"]);
}

/** The creature's Speed after modifiers. Prone does not change Speed — see below. */
export function effectiveSpeedFeet(actor: Combatant): number {
  if (isImmobilised(actor)) return 0;
  return Math.max(0, actor.speedFeet + exhaustionSpeedPenaltyFeet(actor.exhaustionLevel));
}

/**
 * Feet of movement the creature may spend this turn. Dash grants extra movement
 * equal to its Speed, so the budget doubles.
 *
 * Prone does not appear here: crawling raises the *cost* of each square rather
 * than shrinking the budget, and `findPath` charges it. Halving the budget
 * instead would over-charge Difficult Terrain, which costs 2 extra feet per
 * foot to crawl rather than twice the ordinary difficult rate.
 */
export function movementBudgetFeet(actor: Combatant, options?: { dashed?: boolean }): number {
  const speed = effectiveSpeedFeet(actor);
  return options?.dashed === true ? speed * 2 : speed;
}
