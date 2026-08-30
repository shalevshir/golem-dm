// Attack resolution, damage application, conditions, death saves.
// Validates proposals from @ai-dm/schemas — the single gate for legality.
import { d20 } from "../dice/index.js";
import type { Rng } from "../dice/index.js";
import type { RollMode } from "../checks/index.js";
import type { AttackOutcome } from "@ai-dm/schemas";

export * from "./exhaustion.js";
export * from "./action-economy.js";
export * from "./validate-turn.js";
export * from "./statblock.js";
export * from "./affordances.js";

export type CoverLevel = "none" | "half" | "three_quarters" | "full";

export interface AttackInput {
  attackBonus: number;
  targetArmorClass: number;
  cover?: CoverLevel;
  mode?: RollMode;
}

export type { AttackOutcome };

export interface AttackResult {
  naturalRoll: number;
  rolls: number[];
  total: number;
  effectiveArmorClass: number;
  outcome: AttackOutcome;
  hit: boolean;
}

export interface HitPoints {
  currentHp: number;
  maxHp: number;
  tempHp: number;
}

export type LifeStatus = "alive" | "unconscious" | "dead";

export interface DamageResult {
  hitPoints: HitPoints;
  absorbedByTempHp: number;
  appliedToHp: number;
  status: LifeStatus;
  /** Leftover damage met or exceeded max HP — death without death saves. */
  instantDeath: boolean;
}

export interface DamageOptions {
  /**
   * SRD 5.2.1 (Instant Death): a monster dies the instant it drops to 0 Hit
   * Points, whereas a character falls Unconscious and rolls death saves. Pass
   * true for monsters. A `Combatant` without a `characterId` is a monster —
   * the sole production caller, `encounter/` `resolve.ts`, reads this off
   * `characterId`'s presence rather than pinning it.
   */
  diesAtZeroHp?: boolean;
}

export interface DeathSaveState {
  successes: number;
  failures: number;
}

export interface DeathSaveResult {
  state: DeathSaveState;
  naturalRoll: number;
  outcome: "pending" | "stable" | "dead" | "revived";
}

const FULL_COVER_MESSAGE = "Target is behind full cover and cannot be targeted directly";

/**
 * Cover bonus applied to AC and to Dexterity saving throws alike (ADR-0003).
 * Full cover is not a bonus — the target simply cannot be targeted.
 */
export function coverArmorClassBonus(cover: CoverLevel): number {
  switch (cover) {
    case "none":
      return 0;
    case "half":
      return 2;
    case "three_quarters":
      return 5;
    case "full":
      throw new Error(FULL_COVER_MESSAGE);
  }
}

export function resolveAttack(input: AttackInput, rng: Rng): AttackResult {
  const cover = input.cover ?? "none";
  if (cover === "full") throw new Error(FULL_COVER_MESSAGE);

  const effectiveArmorClass = input.targetArmorClass + coverArmorClassBonus(cover);
  const { result, rolls } = d20(rng, input.mode ?? "normal");
  const total = result + input.attackBonus;

  let outcome: AttackOutcome;
  if (result === 20) outcome = "critical_hit";
  else if (result === 1) outcome = "critical_miss";
  else outcome = total >= effectiveArmorClass ? "hit" : "miss";

  const hit = outcome === "hit" || outcome === "critical_hit";
  return { naturalRoll: result, rolls, total, effectiveArmorClass, outcome, hit };
}

export function applyDamage(
  hitPoints: HitPoints,
  amount: number,
  options: DamageOptions = {},
): DamageResult {
  if (amount < 0) throw new Error(`Damage must not be negative: ${String(amount)}`);

  const absorbedByTempHp = Math.min(hitPoints.tempHp, amount);
  const appliedToHp = amount - absorbedByTempHp;
  const currentHp = Math.max(0, hitPoints.currentHp - appliedToHp);
  const excess = appliedToHp - hitPoints.currentHp;
  const instantDeath = currentHp === 0 && excess >= hitPoints.maxHp;

  let status: LifeStatus = "alive";
  if (instantDeath) status = "dead";
  else if (currentHp === 0) status = options.diesAtZeroHp === true ? "dead" : "unconscious";

  return {
    hitPoints: { currentHp, maxHp: hitPoints.maxHp, tempHp: hitPoints.tempHp - absorbedByTempHp },
    absorbedByTempHp,
    appliedToHp,
    status,
    instantDeath,
  };
}

/** Healing restores hit points only — temporary hit points are never healed. */
export function applyHealing(hitPoints: HitPoints, amount: number): HitPoints {
  if (amount < 0) throw new Error(`Healing must not be negative: ${String(amount)}`);
  return {
    ...hitPoints,
    currentHp: Math.min(hitPoints.maxHp, hitPoints.currentHp + amount),
  };
}

export function rollDeathSave(state: DeathSaveState, rng: Rng): DeathSaveResult {
  const { result } = d20(rng);

  // A natural 20 restores 1 HP outright and clears the tally.
  if (result === 20) {
    return { state: { successes: 0, failures: 0 }, naturalRoll: result, outcome: "revived" };
  }

  let { successes, failures } = state;
  if (result === 1) failures += 2;
  else if (result >= 10) successes += 1;
  else failures += 1;

  let outcome: DeathSaveResult["outcome"] = "pending";
  if (failures >= 3) outcome = "dead";
  else if (successes >= 3) outcome = "stable";

  return { state: { successes, failures }, naturalRoll: result, outcome };
}
