// Which model answers for which agent role. This is CONFIG: a role maps to a
// model id and its call parameters, never to a branch in code. Swapping the
// tactical model after the step 7 benchmark must be a data edit, not a patch.
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import type { EmbeddingSpec } from "./embedding-port.js";

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
 * Defaults from PROJECT_PLAN.md section 3 (Aug 2026 pricing), except tactical,
 * which is now a measurement rather than a guess.
 *
 * Intent is a closed-set label, so temperature 0 and the least reasoning the
 * provider will do. Tactical stays near-deterministic but not frozen, or every
 * goblin takes the identical turn each round. Narrative is the one role paying
 * for a bigger model, because Hebrew prose quality is the product.
 *
 * **Tactical was set by the step 7b live benchmark**, run
 * `live-2026-08-19T07-28-03.487Z` in `tools/sim/runs/` (12 arms x 4 scenarios
 * x 5 seeds, 1800 probe turns). `gpt-5.4-nano` at `high` effort measured 98.7%
 * legality after retry — tied for the best of any arm — at $0.0011/turn, the
 * cheapest arm to clear the >= 95% bar, which is what principle 2 (cheapest
 * capable model per role) asks for.
 *
 * Two things that measurement settled, both of which had been guesses:
 *
 * - **Google is out.** All three `gemini-3.1-flash-lite` arms missed the bar
 *   (86.0% / 87.3% / 90.7%), so the plan's original `gemini-3-flash` tactical
 *   default is disqualified. `intent` still points at google and is NOT
 *   covered by this benchmark — intent is a closed-set label task, nothing
 *   like proposing a legal turn, so this result does not transfer to it.
 * - **Effort is load-bearing here.** nano measured 93.3% / 96.0% / 98.7%
 *   across low / medium / high, so `high` is bought deliberately: it is the
 *   difference between missing and clearing the exit criterion.
 *
 * The one known cost of this choice: nano@high's p95 was 27.8s against the
 * 10s turn timeout in PROJECT_PLAN.md section 3, so a few percent of turns
 * will hit that timeout and take the deterministic fallback. The tail is
 * partly the AI SDK's own retry-with-backoff on transient provider errors
 * rather than model thinking time. `claude-sonnet-5` was the only family
 * whose p95 (7.2-7.9s) fits inside the timeout, at 3.4x the cost, and is the
 * fallback choice if that tail proves unacceptable in the step 8 server.
 */
export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  intent: {
    provider: "google",
    modelId: "gemini-3-flash",
    temperature: 0,
    reasoningEffort: "low",
  },
  tactical: {
    provider: "openai",
    modelId: "gpt-5.4-nano",
    temperature: 0.2,
    reasoningEffort: "high",
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

/**
 * Embedding model selection, deliberately its own constant rather than a
 * fourth `AgentRole`. A `ModelSpec` carries `temperature`,
 * `maxOutputTokens` and `reasoningEffort`, all meaningless for an embedding
 * call, and `resolveModelSpec` would start returning specs `EmbeddingPort`
 * cannot accept.
 *
 * `openai` because it is already a wired `ProviderId` — no adapter-layer
 * provider work is needed.
 */
export const DEFAULT_EMBEDDING_SPEC: EmbeddingSpec = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  dimensions: EMBEDDING_DIMENSIONS,
};
