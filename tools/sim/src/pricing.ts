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
}

/** When the figures below were last checked against provider pricing pages. */
export const PRICING_TABLE_DATE = "2026-08-17";

export const MODEL_PRICING: Readonly<Record<string, ModelPricing | undefined>> = {
  "gemini-3-flash": { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5 },
  "gpt-5.4-nano": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.25 },
  "gpt-5.4-mini": { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5 },
  "claude-sonnet-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
};

const PER_MILLION = 1_000_000;

export interface CostInput {
  promptTokens: number;
  completionTokens: number;
}

/** Null when the model has no entry: an unpriced arm must not read as free. */
export function costUsd(modelId: string, usage: CostInput): number | null {
  const pricing = MODEL_PRICING[modelId];
  if (pricing === undefined) return null;

  return (
    (usage.promptTokens / PER_MILLION) * pricing.inputPerMillionUsd +
    (usage.completionTokens / PER_MILLION) * pricing.outputPerMillionUsd
  );
}
