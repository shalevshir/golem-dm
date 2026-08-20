// What the actor may legally do right now, for a UI to render.
//
// The hard rule: this is NOT a second implementation of legality. It enumerates
// candidates and asks `validateExecuteTurn`. A client highlighting a tile the
// server then rejects is the failure this exists to prevent, and it can only
// happen if two pieces of code decide legality — so there is only one, and this
// calls it.
//
// Cost: a 30 ft mover on a 5 ft grid has a 13x13 candidate square, so this is
// low hundreds of validator calls per turn. Irrelevant beside a model call, and
// it cannot diverge from the validator, because it is the validator.
import { FEET_PER_TILE } from "../spatial/index.js";
import { validateExecuteTurn } from "./validate-turn.js";
import type { CombatWorld, TurnRejectionReason, TurnValidation } from "./validate-turn.js";
import { DEFAULT_PATH_TYPE } from "@ai-dm/schemas";
import type { ActionAffordance, CreatureStatBlock, Tile, TurnAffordances } from "@ai-dm/schemas";
import type { ExecuteTurn } from "@ai-dm/schemas";

/**
 * `ExecuteTurn.mainAction` is required, so every probe carries an action even
 * when it is only asking about movement. That means a probe can fail for a
 * reason unrelated to what it asked. These lists name the reasons that DO
 * condemn each aspect; anything else in the rejection list is incidental to
 * the probe and ignored. Copied from `TurnRejectionReason` (`validate-turn.ts`)
 * and `EconomyRejectionReason` (`action-economy.ts`) — if either gains a member,
 * classify it here.
 */
const BLOCKS_THE_WHOLE_TURN: readonly TurnRejectionReason[] = [
  "actor_mismatch",
  "actor_cannot_act",
  "actor_incapacitated",
];

const BLOCKS_MOVEMENT: readonly TurnRejectionReason[] = [
  ...BLOCKS_THE_WHOLE_TURN,
  "actor_cannot_move",
  "movement_exceeds_speed",
  "movement_path_blocked",
  "destination_off_grid",
  "destination_occupied",
];

const BLOCKS_THE_ACTION: readonly TurnRejectionReason[] = [
  ...BLOCKS_THE_WHOLE_TURN,
  "action_already_used",
  "extra_attacks_exceed_budget",
  "extra_attacks_without_attack_action",
  "spell_slot_unavailable",
];

const BLOCKS_THE_TARGET: readonly TurnRejectionReason[] = [
  ...BLOCKS_THE_ACTION,
  "target_not_found",
  "target_out_of_reach",
  "target_behind_full_cover",
];

/**
 * Actions every creature has that need no target and no stat-block entry. The
 * client needs them to exist as affordances or a player has no way to Dodge.
 * Each is still probed through the validator, so an actor who has already acted
 * is offered none of them.
 */
const UNIVERSAL_ACTIONS = ["dodge", "dash", "disengage"] as const;

function permits(verdict: TurnValidation, blockers: readonly TurnRejectionReason[]): boolean {
  if (verdict.valid) return true;
  return !verdict.rejections.some((rejection) => blockers.includes(rejection.reason));
}

export function affordancesFor(
  world: CombatWorld,
  actorId: string,
  statBlock: CreatureStatBlock,
): TurnAffordances {
  const actor = world.combatants.find((each) => each.combatantId === actorId);
  if (actor === undefined) {
    throw new Error(`No combatant ${actorId} in this world`);
  }

  const empty: TurnAffordances = { actorId, reachableTiles: [], actions: [] };
  if (actor.status !== "alive") return empty;

  // `dodge` is the probe's filler action: it needs no target and no id, so it
  // adds the fewest possible reasons of its own to a movement question.
  const probe = (turn: Omit<ExecuteTurn, "actorId" | "tacticalRationaleEnglish">): TurnValidation =>
    validateExecuteTurn(
      { actorId, ...turn, tacticalRationaleEnglish: "Affordance probe." },
      actor,
      world,
    );

  const reachableTiles: Tile[] = [];
  const remainingFeet = actor.speedFeet - actor.actionEconomy.movementUsedFeet;
  const radiusTiles = Math.floor(remainingFeet / FEET_PER_TILE);
  const [originX, originY] = actor.position;

  for (let y = originY - radiusTiles; y <= originY + radiusTiles; y += 1) {
    for (let x = originX - radiusTiles; x <= originX + radiusTiles; x += 1) {
      if (x === originX && y === originY) continue;
      if (x < 0 || x >= world.grid.width || y < 0 || y >= world.grid.height) continue;
      const destinationTile: Tile = [x, y];
      const verdict = probe({
        movement: [{ destinationTile, pathType: DEFAULT_PATH_TYPE }],
        mainAction: { actionType: "dodge" },
      });
      if (permits(verdict, BLOCKS_MOVEMENT)) reachableTiles.push(destinationTile);
    }
  }

  const actions: ActionAffordance[] = [];

  for (const action of statBlock.actions) {
    // `status === "alive"` is a presentation-layer narrowing, not a rules
    // decision: `checkTarget` in validate-turn.ts accepts any combatant
    // present within reach regardless of status, and attacking a downed
    // (unconscious) creature is legal and mechanically meaningful in 5e
    // (e.g. a coup de grace). This filter simply keeps the client from
    // suggesting attacks on corpses.
    //
    // Only the unconscious case is unreachable today -- the dead case is not:
    // the `status === "alive"` check just below excludes a corpse every turn
    // once a kill happens. Unconscious is unreachable no longer because
    // combatants lack a `characterId` — a character spawn populates a real
    // one now (`combatantFromStatBlock`, ../encounter/build.ts's
    // `resolveSpawn`). The reason is correction C-31: `applyTurn`'s
    // `applyDamage` call in `../encounter/resolve.ts` pins `diesAtZeroHp:
    // true` unconditionally (death saves are implemented but not driven by
    // the encounter pipeline — RULES_REFERENCE.md §8's gap), so nobody, PC
    // or monster, ever ends up "unconscious" — everyone who hits 0 HP goes
    // straight to "dead". This filter becomes load-bearing for the
    // unconscious case only once death saves land and the pin is lifted,
    // and should be revisited then so the client still offers attacks
    // against an unconscious PC.
    const targetableCombatantIds = world.combatants
      .filter((each) => each.combatantId !== actorId && each.status === "alive")
      .filter((candidate) =>
        permits(
          probe({
            mainAction: {
              actionType: "attack",
              actionId: action.actionId,
              targetIds: [candidate.combatantId],
            },
          }),
          BLOCKS_THE_TARGET,
        ),
      )
      .map((each) => each.combatantId);

    // Offered even with no target in range: `requiresTarget` is what tells the
    // client the difference between "needs nobody" and "needs somebody and
    // nobody is there", and the UI renders the second as a disabled button
    // rather than a missing one.
    if (
      permits(
        probe({ mainAction: { actionType: "attack", actionId: action.actionId } }),
        BLOCKS_THE_ACTION,
      )
    ) {
      actions.push({
        actionType: "attack",
        actionId: action.actionId,
        requiresTarget: true,
        targetableCombatantIds,
      });
    }
  }

  for (const actionType of UNIVERSAL_ACTIONS) {
    if (permits(probe({ mainAction: { actionType } }), BLOCKS_THE_ACTION)) {
      actions.push({ actionType, requiresTarget: false, targetableCombatantIds: [] });
    }
  }

  return { actorId, reachableTiles, actions };
}
