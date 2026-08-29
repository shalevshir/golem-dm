// Ability checks, saving throws, DC resolution.
import { d20 } from "../dice/index.js";
import type { Rng } from "../dice/index.js";
import type { CheckDifficulty } from "@ai-dm/schemas";

/**
 * SRD 5.2.1 "Typical Difficulty Classes" table, verified against the SRD
 * NotebookLM notebook (see RULES_REFERENCE.md §1 for the row). The intent
 * router proposes a `CheckDifficulty` label only — this is the engine's sole
 * authority translating that label to a DC number.
 */
export const DC_BY_DIFFICULTY: Record<CheckDifficulty, number> = {
  very_easy: 5,
  easy: 10,
  medium: 15,
  hard: 20,
  very_hard: 25,
  nearly_impossible: 30,
};

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

export interface ImposedSaveDcInput {
  abilityScore: number;
  proficiencyBonus?: number;
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

/**
 * The DC of a saving throw one creature forces on another — Grapple and Shove
 * from an Unarmed Strike, and monster abilities built the same way.
 * SRD 5.2.1: 8 + the relevant ability modifier + Proficiency Bonus.
 *
 * The 2024 rules removed 2014's opposed "contest" checks entirely, replacing
 * them with this fixed DC. There is deliberately no `contest()` helper.
 */
export function imposedSaveDc(input: ImposedSaveDcInput): number {
  return 8 + abilityModifier(input.abilityScore) + (input.proficiencyBonus ?? 0);
}
