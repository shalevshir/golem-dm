// Which model answers for which agent role. This is CONFIG: a role maps to a
// model id and its call parameters, never to a branch in code. Swapping the
// tactical model after the step 7 benchmark must be a data edit, not a patch.

/** JSON as providers accept it. Declared here so routing stays SDK-free. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

export type AgentRole = "intent" | "tactical" | "narrative";
export type ProviderId = "anthropic" | "google" | "openai";

/**
 * Provider-neutral reasoning depth. Each provider spells this differently;
 * translating it is the adapter's job (see `providerOptionsFor` in vercel.ts).
 */
export type ReasoningEffort = "low" | "medium" | "high";

export interface ModelSpec {
  provider: ProviderId;
  modelId: string;
  temperature?: number;
  /** Mapped onto the AI SDK v4 `maxTokens` call setting. */
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Raw per-provider passthrough. Merged last, so it overrides everything. */
  providerOptions?: Partial<Record<ProviderId, Record<string, JsonValue>>>;
}

export type ModelRouting = Record<AgentRole, ModelSpec>;

/**
 * Defaults from PROJECT_PLAN.md section 3 (Aug 2026 pricing).
 *
 * Intent is a closed-set label, so temperature 0 and the least reasoning the
 * provider will do. Tactical stays near-deterministic but not frozen, or every
 * goblin takes the identical turn each round; its model is a starting point,
 * not a verdict — step 7 benchmarks Flash against GPT-5.4 mini and rewrites it
 * from measurements. Narrative is the one role paying for a bigger model,
 * because Hebrew prose quality is the product.
 */
export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  intent: {
    provider: "google",
    modelId: "gemini-3-flash",
    temperature: 0,
    reasoningEffort: "low",
  },
  tactical: {
    provider: "google",
    modelId: "gemini-3-flash",
    temperature: 0.2,
    reasoningEffort: "medium",
  },
  narrative: {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    temperature: 0.8,
  },
};

/** Look up the model configured for a role. Never mutates the routing. */
export function resolveModelSpec(routing: ModelRouting, role: AgentRole): ModelSpec {
  return routing[role];
}
