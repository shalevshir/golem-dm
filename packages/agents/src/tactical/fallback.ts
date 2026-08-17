// What the enemy does when the model has failed twice. Deliberately dumb: it
// does not move. A fallback that pathfinds would be re-implementing the
// tactical judgement the model was supposed to supply, in the one code path
// that has to be trivially correct.
import type { CombatWorld, TurnPlan } from "@ai-dm/rules-engine";
import { footprintDistanceFeet, validateExecuteTurn } from "@ai-dm/rules-engine";
import type { Combatant, ExecuteTurn, Faction } from "@ai-dm/schemas";
import type { AvailableAction } from "./snapshot.js";

export interface FallbackOptions {
  availableActions?: readonly AvailableAction[];
}

/** The turn and the plan it validated to, so the caller never validates twice. */
export interface FallbackTurn {
  turn: ExecuteTurn;
  plan: TurnPlan;
}

const ATTACK_RATIONALE = "Fallback: attacking the nearest legal target.";
const DODGE_RATIONALE = "Fallback: nothing is in reach, so taking the Dodge action.";

/**
 * Who this actor will attack. Policy, not rules — 5e permits attacking an ally,
 * so the engine has no opinion here, and policy is what an agent is for.
 */
function opposes(actor: Faction, other: Faction): boolean {
  if (actor === "party") return other === "hostile";
  if (actor === "hostile") return other === "party";
  return false;
}

function attackTurn(actorId: string, targetId: string, actionId: string | undefined): ExecuteTurn {
  return {
    actorId,
    mainAction: {
      actionType: "attack",
      ...(actionId === undefined ? {} : { actionId }),
      targetIds: [targetId],
    },
    tacticalRationaleEnglish: ATTACK_RATIONALE,
  };
}

function dodgeTurn(actorId: string): ExecuteTurn {
  return {
    actorId,
    mainAction: { actionType: "dodge" },
    tacticalRationaleEnglish: DODGE_RATIONALE,
  };
}

export function deterministicFallback(
  actor: Combatant,
  world: CombatWorld,
  options: FallbackOptions = {},
): FallbackTurn | null {
  const actorSpace = { anchor: actor.position, size: actor.size };

  // Downed enemies are excluded outright, not merely deprioritised: with only a
  // downed enemy on the board this Dodges rather than finish it off.
  const targets = world.combatants
    .filter((each) => each.status === "alive" && opposes(actor.faction, each.faction))
    .map((each) => ({
      combatantId: each.combatantId,
      distanceFeet: footprintDistanceFeet(actorSpace, { anchor: each.position, size: each.size }),
    }))
    .sort((left, right) => {
      // The id tiebreak is what makes this replayable: the same board must
      // always produce the same fallback, whatever order the array arrived in.
      if (left.distanceFeet !== right.distanceFeet) return left.distanceFeet - right.distanceFeet;
      return left.combatantId.localeCompare(right.combatantId);
    });

  // With no action list, an attack with no actionId resolves to the actor's
  // melee reach in the validator — the right default when the caller has no
  // stat block data to hand.
  const actionIds: readonly (string | undefined)[] =
    options.availableActions === undefined || options.availableActions.length === 0
      ? [undefined]
      : options.availableActions.map((action) => action.actionId);

  for (const target of targets) {
    for (const actionId of actionIds) {
      const turn = attackTurn(actor.combatantId, target.combatantId, actionId);
      const validation = validateExecuteTurn(turn, actor, world);
      if (validation.valid) return { turn, plan: validation.plan };
    }
  }

  const dodge = dodgeTurn(actor.combatantId);
  const validation = validateExecuteTurn(dodge, actor, world);
  return validation.valid ? { turn: dodge, plan: validation.plan } : null;
}
