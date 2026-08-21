// Turns one resolved turn into narratable material. Pure: no I/O, no
// provider, no clock. Everything a narrator needs to write a sentence is
// computed here exactly once.
import type { AttackRecord, TurnEffect } from "@ai-dm/rules-engine";
import type { Combatant, Condition, CreatureStatBlock } from "@ai-dm/schemas";
import type {
  FightPulse,
  HealthBand,
  NarratedCreature,
  NarrationBeat,
  NarrationInput,
  Severity,
} from "./port.js";

export interface NarrationBriefInput {
  actorId: string;
  effect: TurnEffect;
  combatants: readonly Combatant[];
  statBlocks: ReadonlyMap<string, CreatureStatBlock>;
  /** Hebrew condition labels by id, from the server's `loadConditions()`. */
  conditionNamesHebrew: ReadonlyMap<Condition, string>;
  sceneEnglish: string;
  recentNarrations: readonly string[];
}

const SEVERE_FRACTION = 0.5;
const SOLID_FRACTION = 0.25;
const BLOODIED_FRACTION = 0.5;
const CRITICAL_FRACTION = 0.25;

/**
 * Status first, damage second. A creature the engine put down is `felling`
 * however little damage did it, and a creature still standing is never
 * `felling` however much did — which is what makes this band incapable of
 * contradicting the engine.
 */
export function severityFor(
  damage: number,
  targetMaxHp: number,
  statusAfter: AttackRecord["targetStatusAfter"],
): Severity {
  if (statusAfter !== "alive") return "felling";
  if (damage >= targetMaxHp * SEVERE_FRACTION) return "severe";
  if (damage >= targetMaxHp * SOLID_FRACTION) return "solid";
  return "graze";
}

export function healthBandFor(currentHp: number, maxHp: number): HealthBand {
  if (currentHp <= maxHp * CRITICAL_FRACTION) return "critical";
  if (currentHp <= maxHp * BLOODIED_FRACTION) return "bloodied";
  return "healthy";
}

/**
 * `"fled"` cannot reach an attack beat — `applyDamage` never derives it — but
 * the type must still be total. Mapping it to `"alive"` is the least-wrong
 * choice of the three: a creature that fled is emphatically not down, and
 * narrating it as down would be the one actively false reading.
 */
function narrowStatus(status: AttackRecord["targetStatusAfter"]): "alive" | "unconscious" | "dead" {
  if (status === "dead") return "dead";
  if (status === "unconscious") return "unconscious";
  return "alive";
}

function creatureFor(input: NarrationBriefInput, combatantId: string): NarratedCreature {
  const statBlock = input.statBlocks.get(combatantId);
  const combatant = input.combatants.find((each) => each.combatantId === combatantId);
  const conditions = combatant?.conditions ?? [];

  return {
    // Falling back to the id mirrors what the English renderer did with a
    // missing name: an id on screen beats a blank.
    nameHebrew: statBlock?.nameHebrew ?? combatantId,
    // Masculine is Hebrew's unmarked form, so it is the least-wrong default
    // for a creature with no stat block — which only a malformed world has.
    gender: statBlock?.grammaticalGender ?? "masculine",
    conditionsHebrew: conditions.map(
      (active) => input.conditionNamesHebrew.get(active.condition) ?? active.condition,
    ),
  };
}

function maxHpOf(input: NarrationBriefInput, combatantId: string): number {
  // 1 rather than 0: this is a divisor for the severity band, and a stray 0
  // would band every graze as `severe`.
  return input.combatants.find((each) => each.combatantId === combatantId)?.maxHp ?? 1;
}

function actionNameHebrewFor(input: NarrationBriefInput, attack: AttackRecord): string {
  const actions = input.statBlocks.get(attack.attackerId)?.actions ?? [];
  return actions.find((each) => each.actionId === attack.actionId)?.nameHebrew ?? attack.actionId;
}

function attackBeat(input: NarrationBriefInput, attack: AttackRecord): NarrationBeat {
  const landed = attack.outcome === "hit" || attack.outcome === "critical_hit";
  return {
    kind: "attack",
    target: creatureFor(input, attack.targetId),
    actionNameHebrew: actionNameHebrewFor(input, attack),
    outcome: attack.outcome,
    ...(landed
      ? { severity: severityFor(attack.damage, maxHpOf(input, attack.targetId), attack.targetStatusAfter) }
      : {}),
    statusAfter: narrowStatus(attack.targetStatusAfter),
  };
}

function pulseFor(input: NarrationBriefInput): FightPulse {
  const hostilesStanding = input.combatants.filter(
    (each) => each.faction === "hostile" && each.status === "alive",
  ).length;

  // ADR-0002 makes this a solo game, so there is one party member. If a
  // future party has several, the grimmest band is the honest summary.
  const party = input.combatants.filter((each) => each.faction === "party");
  const bands = party.map((each) => healthBandFor(each.currentHp, each.maxHp));
  const heroBand: HealthBand = bands.includes("critical")
    ? "critical"
    : bands.includes("bloodied")
      ? "bloodied"
      : "healthy";

  return { hostilesStanding, heroBand };
}

export function buildNarrationBrief(input: NarrationBriefInput): NarrationInput {
  const beats: NarrationBeat[] = [];

  if (input.effect.movedFeet > 0) beats.push({ kind: "move", feet: input.effect.movedFeet });
  for (const attack of input.effect.attacks) beats.push(attackBeat(input, attack));

  // Dodge, Dash, Hide: legal and mechanically inert, but not nothing. The
  // English renderer had no branch for this and narrated a Dodge as "holds
  // position", which was simply wrong.
  if (input.effect.nonAttackAction) beats.push({ kind: "other-action" });

  // Reachable when the engine accepts an actionId the actor's stat block does
  // not own (see `TurnEffect.unresolvedActionIds`).
  if (input.effect.unresolvedActionIds.length > 0) beats.push({ kind: "unresolved" });

  // Never zero beats: a silent turn reads to a player as a dropped connection.
  if (beats.length === 0) beats.push({ kind: "hold" });

  const actor = input.combatants.find((each) => each.combatantId === input.actorId);

  return {
    actor: creatureFor(input, input.actorId),
    actorSide: actor?.faction === "party" ? "party" : "hostile",
    beats,
    pulse: pulseFor(input),
    sceneEnglish: input.sceneEnglish,
    recentNarrations: input.recentNarrations,
  };
}
