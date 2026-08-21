// Applies a turn this package has already validated. Both the sim's encounter
// loop and the server's turn pipeline drive it, which is why it lives here
// rather than in either of them: it is combat math, and invariant 1 says only
// this package owns that.
//
// It decides no legality: `validateExecuteTurn` has already run, and this file
// never second-guesses it. What it owns is sequencing — move, swing, damage,
// die — plus the arithmetic inputs the engine cannot supply, because
// `resolveAttack` needs an attack bonus and `Combatant` has no such field.
//
// Deliberately NOT modelled, all of them RULES_REFERENCE.md section 8 gaps:
// opportunity attacks, monster traits and reactions (Pack Tactics, Nimble
// Escape, Undead Fortitude, Parry), and conditional damage riders. Most
// consequentially, Dodge has no mechanical effect, because the engine models
// no dodging state — `TurnEffect.nonAttackAction` exists so no report reads a
// win rate without that in view.
import { roll } from "../dice/index.js";
import type { Rng } from "../dice/index.js";
import { applyDamage, coverAgainst, resolveAttack } from "../combat/index.js";
import type { AttackOutcome, CombatWorld, TurnPlan } from "../combat/index.js";
import type {
  AttackRollTrace,
  Combatant,
  CreatureAttack,
  CreatureStatBlock,
  DamageRoll,
  DamageRollTrace,
  EntityStatus,
  ExecuteTurn,
} from "@ai-dm/schemas";

export interface ResolveContext {
  /** By `combatantId`. Supplies attack bonuses and damage dice. */
  statBlocks: ReadonlyMap<string, CreatureStatBlock>;
}

export interface AttackRecord {
  attackerId: string;
  targetId: string;
  actionId: string;
  outcome: AttackOutcome;
  damage: number;
  targetStatusAfter: EntityStatus;
  attackRoll: AttackRollTrace;
  damageRolls: DamageRollTrace[];
}

export interface TurnEffect {
  attacks: readonly AttackRecord[];
  damageDealt: number;
  killed: readonly string[];
  movedFeet: number;
  /** Dodge, Dash, Hide and friends. Legal, but mechanically inert. */
  nonAttackAction: boolean;
  /**
   * Action ids the engine accepted but the actor's stat block does not contain.
   * `validateExecuteTurn` resolves ranges from a world-wide map and never checks
   * ownership, so this is reachable — and worth counting rather than crashing on.
   */
  unresolvedActionIds: readonly string[];
}

export interface ApplyTurnInput {
  world: CombatWorld;
  actorId: string;
  turn: ExecuteTurn;
  /** From `validateExecuteTurn`. Movement and economy are taken from here. */
  plan: TurnPlan;
  context: ResolveContext;
  rng: Rng;
}

export interface ApplyTurnResult {
  world: CombatWorld;
  effect: TurnEffect;
}

interface Swing {
  targetId: string;
  actionId: string | undefined;
}

function combatantOf(world: CombatWorld, combatantId: string): Combatant {
  const found = world.combatants.find((each) => each.combatantId === combatantId);
  if (found === undefined) throw new Error(`No combatant ${combatantId} in this encounter`);
  return found;
}

function replace(world: CombatWorld, updated: Combatant): CombatWorld {
  return {
    ...world,
    combatants: world.combatants.map((each) =>
      each.combatantId === updated.combatantId ? updated : each,
    ),
  };
}

/**
 * The attack a swing refers to. An absent `actionId` means the actor's first
 * listed attack — matching the validator, which falls back to the actor's melee
 * reach for the same case.
 */
function attackFor(
  statBlock: CreatureStatBlock,
  actionId: string | undefined,
): CreatureAttack | undefined {
  if (actionId === undefined) return statBlock.actions[0];
  return statBlock.actions.find((action) => action.actionId === actionId);
}

/** Dice when the roll has them, the printed average when it is flat damage.
 *  Returns the full trace, not just the total, so the combat log can show
 *  the roll itself, not only its result. */
function damageFrom(damage: DamageRoll, critical: boolean, rng: Rng): DamageRollTrace {
  if (damage.diceNotation === undefined) return { kind: "flat", total: damage.averageDamage };
  const r = roll(damage.diceNotation, rng, { critical });
  return {
    kind: "dice",
    notation: r.notation,
    rolls: r.rolls,
    modifier: r.modifier,
    total: r.total,
  };
}

/** The swings this turn proposes, in the order the engine budgeted them. */
function swingsOf(turn: ExecuteTurn): Swing[] {
  if (turn.mainAction.actionType !== "attack") return [];

  const main = (turn.mainAction.targetIds ?? []).map((targetId): Swing => ({
    targetId,
    actionId: turn.mainAction.actionId,
  }));
  const extra = (turn.extraAttacks ?? []).map((each): Swing => ({
    targetId: each.targetId,
    actionId: each.actionId,
  }));
  return [...main, ...extra];
}

export function applyTurn(input: ApplyTurnInput): ApplyTurnResult {
  const { turn, plan, context, rng } = input;

  const statBlock = context.statBlocks.get(input.actorId);
  if (statBlock === undefined) throw new Error(`No stat block for ${input.actorId}`);

  // --- Movement and economy ------------------------------------------------
  const finalSegment = plan.segments[plan.segments.length - 1];
  const startingActor = combatantOf(input.world, input.actorId);
  let world = replace(input.world, {
    ...startingActor,
    ...(finalSegment === undefined ? {} : { position: finalSegment.destinationTile }),
    actionEconomy: plan.economyAfter,
    spellSlots: plan.spellSlotsAfter,
  });

  // --- Attacks -------------------------------------------------------------
  const attacks: AttackRecord[] = [];
  const killed: string[] = [];
  const unresolvedActionIds: string[] = [];
  let damageDealt = 0;

  for (const swing of swingsOf(turn)) {
    const attack = attackFor(statBlock, swing.actionId);
    if (attack === undefined) {
      unresolvedActionIds.push(swing.actionId ?? "<none>");
      continue;
    }

    // Read fresh each swing: an earlier swing may have moved a target's HP, and
    // cover depends on who is still standing between the two.
    const attacker = combatantOf(world, input.actorId);
    const target = combatantOf(world, swing.targetId);
    if (target.status !== "alive" && target.status !== "unconscious") continue;

    const cover = coverAgainst(attacker, target, world);
    // The validator already rejects full cover, so this cannot be "full" here.
    const result = resolveAttack(
      { attackBonus: attack.attackBonus, targetArmorClass: target.armorClass, cover },
      rng,
    );

    let damage = 0;
    const damageRolls: DamageRollTrace[] = [];
    let statusAfter: EntityStatus = target.status;

    if (result.hit) {
      const critical = result.outcome === "critical_hit";
      const mainTrace = damageFrom(attack.damage, critical, rng);
      damageRolls.push(mainTrace);
      damage = mainTrace.total;
      for (const extra of attack.extraDamage) {
        const extraTrace = damageFrom(extra, critical, rng);
        damageRolls.push(extraTrace);
        damage += extraTrace.total;
      }

      // Correction C-31: every combatant dies at 0 HP, PCs included — not just
      // monsters. Death saving throws are not implemented
      // (RULES_REFERENCE.md §8's gap), so letting a PC fall Unconscious
      // instead would strand it with nothing that ever resolves that state.
      // `diesAtZeroHp` is therefore pinned `true` unconditionally, not read
      // off `target.characterId`, until death saves exist. `rollDeathSave`
      // exists in `../combat/`; this file does not drive it.
      const applied = applyDamage(
        { currentHp: target.currentHp, maxHp: target.maxHp, tempHp: target.tempHp },
        damage,
        { diesAtZeroHp: true },
      );
      statusAfter = applied.status;
      if (applied.status === "dead") killed.push(target.combatantId);

      world = replace(world, {
        ...target,
        currentHp: applied.hitPoints.currentHp,
        tempHp: applied.hitPoints.tempHp,
        status: applied.status,
      });
      damageDealt += damage;
    }

    attacks.push({
      attackerId: input.actorId,
      targetId: swing.targetId,
      actionId: attack.actionId,
      outcome: result.outcome,
      damage,
      targetStatusAfter: statusAfter,
      attackRoll: {
        naturalRoll: result.naturalRoll,
        rolls: result.rolls,
        total: result.total,
        targetArmorClass: result.effectiveArmorClass,
      },
      damageRolls,
    });
  }

  return {
    world,
    effect: {
      attacks,
      damageDealt,
      killed,
      movedFeet: plan.totalMovementFeet,
      nonAttackAction: turn.mainAction.actionType !== "attack",
      unresolvedActionIds,
    },
  };
}
