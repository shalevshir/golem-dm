// Free-text intent router -> combat | check | social | exploration | ooc.
// SKIPPED entirely when the client sends a structured action (tile click,
// attack button) — those carry explicit intent and route directly.
//
// A closed-choice classifier, not a GM tier: it proposes ids and enum words,
// never a number that reaches state (invariant 1). The scene engine and
// `abilityCheck` decide everything else.
//
// No bespoke retry loop. `generateStructured` already schema-validates and
// the adapter already retries transient provider errors, so there is nothing
// machine-checkable left to feed back that the schema did not already
// enforce — one call per `classify`, always. See Decision 5 of
// docs/superpowers/specs/2026-08-28-intent-router-design.md.
import type { IntentClassification } from "@ai-dm/schemas";
import { IntentClassification as IntentClassificationSchema } from "@ai-dm/schemas";
import type { AdapterError } from "../providers/errors.js";
import type { TokenUsage } from "../providers/port.js";
import type { AgentRuntime } from "../providers/runtime.js";
import { buildIntentPrompt } from "./prompt.js";
import type { IntentPromptInput } from "./prompt.js";
import { INTENT_TOOL_DESCRIPTION, INTENT_TOOL_NAME } from "./prompt-text.js";

export * from "./prompt.js";
export * from "./prompt-text.js";

export interface IntentAgentOptions {
  runtime: AgentRuntime;
}

export interface ClassifyInput extends IntentPromptInput {
  /** The server's turn/request budget. */
  abortSignal?: AbortSignal;
}

/**
 * `provider`/`modelId` come from `runtime.specFor("intent")`, stamped by the
 * agent so the pipeline can fill `IntentClassifiedPayload` without knowing
 * routing — the same reason the tactical agent stamps them into
 * `ActionRejectedPayload`.
 */
export type IntentResult =
  | {
      ok: true;
      classification: IntentClassification;
      provider: string;
      modelId: string;
      usage: readonly TokenUsage[];
    }
  | { ok: false; error: AdapterError; usage: readonly TokenUsage[] };

export interface IntentAgent {
  classify(input: ClassifyInput): Promise<IntentResult>;
}

export function createIntentAgent({ runtime }: IntentAgentOptions): IntentAgent {
  // Asked of the runtime rather than resolved from a routing of our own — see
  // the same reasoning on `createTacticalAgent`.
  const spec = runtime.specFor("intent");

  return {
    async classify(input: ClassifyInput): Promise<IntentResult> {
      const result = await runtime.structured("intent", {
        prompt: buildIntentPrompt(input),
        schema: IntentClassificationSchema,
        toolName: INTENT_TOOL_NAME,
        toolDescription: INTENT_TOOL_DESCRIPTION,
        ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      });

      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          usage: result.error.usage === undefined ? [] : [result.error.usage],
        };
      }

      return {
        ok: true,
        classification: result.value.value,
        provider: spec.provider,
        modelId: spec.modelId,
        usage: [result.value.usage],
      };
    },
  };
}
