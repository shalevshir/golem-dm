// Ability checks, saving throws, DC resolution.
import { d20 } from "../dice/index.js";
import type { Rng } from "../dice/index.js";

export type RollMode = "normal" | "advantage" | "disadvantage";

/** Everything that shifts a d20 test other than the die itself. */
export interface D20Modifiers {
  abilityScore: number;
  proficient?: boolean;
  proficiencyBonus?: number;
  /** Doubles the proficiency bonus (skill expertise). */
  expertise?: boolean;
  /** Situational adjustments — cover, exhaustion, bardic inspiration, etc. */
  situationalBonus?: number;
  mode?: RollMode;
}

export interface D20TestInput extends D20Modifiers {
  dc: number;
}

export interface D20TestResult {
  /** The die that counts, after advantage/disadvantage selection. */
  naturalRoll: number;
  /** Every die rolled — two entries under advantage/disadvantage. */
  rolls: number[];
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
}

export interface ContestResult {
  initiatorTotal: number;
  defenderTotal: number;
  initiatorWins: boolean;
}

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonusForLevel(level: number): number {
  return 2 + Math.floor((level - 1) / 4);
}

function totalModifier(modifiers: D20Modifiers): number {
  const ability = abilityModifier(modifiers.abilityScore);
  const bonus = modifiers.proficiencyBonus ?? 0;
  const multiplier = modifiers.expertise === true ? 2 : 1;
  const proficiency = modifiers.proficient === true ? bonus * multiplier : 0;
  return ability + proficiency + (modifiers.situationalBonus ?? 0);
}

/**
 * Resolves a d20 test against a DC. A natural 20 is NOT an automatic success —
 * per the 2024 rules (ADR-0001) criticals apply to attack rolls only.
 */
function resolveD20Test(input: D20TestInput, rng: Rng): D20TestResult {
  const { result, rolls } = d20(rng, input.mode ?? "normal");
  const modifier = totalModifier(input);
  const total = result + modifier;
  return { naturalRoll: result, rolls, modifier, total, dc: input.dc, success: total >= input.dc };
}

export function abilityCheck(input: D20TestInput, rng: Rng): D20TestResult {
  return resolveD20Test(input, rng);
}

export function savingThrow(input: D20TestInput, rng: Rng): D20TestResult {
  return resolveD20Test(input, rng);
}

/** Passive score: 10 + modifiers, ±5 for advantage/disadvantage. No die is rolled. */
export function passiveScore(modifiers: D20Modifiers): number {
  const mode = modifiers.mode ?? "normal";
  const swing = mode === "advantage" ? 5 : 0;
  const penalty = mode === "disadvantage" ? 5 : 0;
  return 10 + totalModifier(modifiers) + swing - penalty;
}

/** Opposed check. Ties leave the situation unchanged, so the initiator loses. */
export function contest(
  initiator: D20Modifiers,
  defender: D20Modifiers,
  rng: Rng,
): ContestResult {
  const initiatorRoll = d20(rng, initiator.mode ?? "normal");
  const defenderRoll = d20(rng, defender.mode ?? "normal");
  const initiatorTotal = initiatorRoll.result + totalModifier(initiator);
  const defenderTotal = defenderRoll.result + totalModifier(defender);
  return { initiatorTotal, defenderTotal, initiatorWins: initiatorTotal > defenderTotal };
}
