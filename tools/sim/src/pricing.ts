// USD per million tokens. Data, dated, with its source named — a price that
// silently goes stale turns a cost comparison into a fiction.
//
// Every figure here is copied from PROJECT_PLAN.md section 2, which records them
// as verified as of August 2026. Adding a model without adding its price is
// safe: `costUsd` returns null and the report prints "unpriced" rather than
// inventing a number.
export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /**
   * What a cache HIT costs, per million prompt tokens served from cache.
   * Absent for a model whose provider reports no cache accounting — cache
   * tokens are then ignored rather than charged at the full input rate.
   */
  cacheReadPerMillionUsd?: number;
  /** What it costs to WRITE the cache entry, per million prompt tokens. */
  cacheWritePerMillionUsd?: number;
}

/** When the figures below were last checked against provider pricing pages. */
export const PRICING_TABLE_DATE = "2026-08-17";

export const MODEL_PRICING: Readonly<Record<string, ModelPricing | undefined>> = {
  "gemini-3-flash": { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5 },
  "gpt-5.4-nano": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.25 },
  "gpt-5.4-mini": { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5 },
  // Cache rates are Anthropic's standard multipliers on the input rate: a
  // read bills at one tenth (0.1 x $2), a five-minute write at one and a
  // quarter (1.25 x $2). Written out rather than computed so this table stays
  // one place to check against a pricing page.
  "claude-sonnet-5": {
    inputPerMillionUsd: 2,
    outputPerMillionUsd: 10,
    cacheReadPerMillionUsd: 0.2,
    cacheWritePerMillionUsd: 2.5,
  },
};

const PER_MILLION = 1_000_000;

export interface CostInput {
  /**
   * Prompt tokens billed at the full input rate. On Anthropic this is
   * `input_tokens`, which EXCLUDES the two cache counts below rather than
   * including them, so all three add up rather than overlapping.
   */
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from cache. See `TokenUsage.cachedPromptTokens`. */
  cachedPromptTokens?: number;
  /** Prompt tokens spent writing a cache entry. */
  cacheWritePromptTokens?: number;
}

/** Null when the model has no entry: an unpriced arm must not read as free. */
export function costUsd(modelId: string, usage: CostInput): number | null {
  const pricing = MODEL_PRICING[modelId];
  if (pricing === undefined) return null;

  // Cache tokens are dropped, not charged at the input rate, when the model
  // has no cache rates: a model whose provider folds cached tokens into its
  // prompt count would otherwise be billed for them twice.
  const cacheRead =
    pricing.cacheReadPerMillionUsd === undefined
      ? 0
      : ((usage.cachedPromptTokens ?? 0) / PER_MILLION) * pricing.cacheReadPerMillionUsd;
  const cacheWrite =
    pricing.cacheWritePerMillionUsd === undefined
      ? 0
      : ((usage.cacheWritePromptTokens ?? 0) / PER_MILLION) * pricing.cacheWritePerMillionUsd;

  return (
    (usage.promptTokens / PER_MILLION) * pricing.inputPerMillionUsd +
    (usage.completionTokens / PER_MILLION) * pricing.outputPerMillionUsd +
    cacheRead +
    cacheWrite
  );
}
