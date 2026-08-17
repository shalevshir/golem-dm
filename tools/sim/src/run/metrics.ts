// Folds over `TurnRecord`. Pure arithmetic, no I/O, so the smoke test can pin
// every number these produce.
import type { TurnRecord } from "./records.js";

/** Nearest-rank, so the result is always an observed value and never interpolated. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

export interface LegalitySummary {
  total: number;
  firstTry: number;
  afterRetry: number;
  fallback: number;
  /** Aborted or no legal turn at all. */
  failed: number;
  firstTryRate: number;
  /**
   * Legal without needing the fallback. This is the number step 7's exit
   * criterion — "legality >= 95% after retry" — is stated against.
   */
  legalAfterRetryRate: number;
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

export function summariseLegality(records: readonly TurnRecord[]): LegalitySummary {
  const count = (outcome: TurnRecord["outcome"]): number =>
    records.filter((record) => record.outcome === outcome).length;

  const total = records.length;
  const firstTry = count("model");
  const afterRetry = count("retry");
  const fallback = count("fallback");

  return {
    total,
    firstTry,
    afterRetry,
    fallback,
    failed: count("aborted") + count("no_legal_turn"),
    firstTryRate: rate(firstTry, total),
    legalAfterRetryRate: rate(firstTry + afterRetry, total),
  };
}

export interface LatencySummary {
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
}

export function summariseLatency(records: readonly TurnRecord[]): LatencySummary {
  const durations = records.map((record) => record.durationMs);
  const sum = durations.reduce((accumulator, value) => accumulator + value, 0);

  return {
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    meanMs: durations.length === 0 ? 0 : sum / durations.length,
  };
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  tokensPerTurn: number;
  /** False when any attempt was billed and reported nothing. */
  usageComplete: boolean;
  attemptsMissingUsage: number;
}

export function summariseUsage(records: readonly TurnRecord[]): UsageSummary {
  const promptTokens = records.reduce((sum, record) => sum + record.promptTokens, 0);
  const completionTokens = records.reduce((sum, record) => sum + record.completionTokens, 0);
  const attemptsMissingUsage = records.reduce(
    (sum, record) => sum + record.attemptsMissingUsage,
    0,
  );

  return {
    promptTokens,
    completionTokens,
    tokensPerTurn: records.length === 0 ? 0 : (promptTokens + completionTokens) / records.length,
    usageComplete: attemptsMissingUsage === 0,
    attemptsMissingUsage,
  };
}
