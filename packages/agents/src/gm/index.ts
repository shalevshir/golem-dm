// The GM tier: proposes at most one small `NarrativeMove` for the improvised
// space an authored quest graph does not cover. Direct structural sibling of
// `intent/index.ts` — see that file's header for why there is no bespoke
// retry loop here either: `runtime.structured` already schema-validates and
// the adapter already retries transient provider errors, so one call per
// `propose`, always. A separate deterministic system (`validateMove` in
// `@ai-dm/rules-engine`) decides whether the proposal is legal (invariant 1);
// this agent never mutates state.
import type { NarrativeMove } from "@ai-dm/schemas";
import { NarrativeMove as NarrativeMoveSchema } from "@ai-dm/schemas";
import type { AdapterError } from "../providers/errors.js";
import type { TokenUsage } from "../providers/port.js";
import type { AgentRuntime } from "../providers/runtime.js";
import { buildGmPrompt } from "./prompt.js";
import type { GmPromptInput } from "./prompt.js";
import { GM_TOOL_DESCRIPTION, GM_TOOL_NAME } from "./prompt-text.js";

export * from "./prompt.js";
export * from "./prompt-text.js";

export interface GmAgentOptions {
  runtime: AgentRuntime;
}

export interface ProposeInput extends GmPromptInput {
  /** The server's turn/request budget. */
  abortSignal?: AbortSignal;
}

/**
 * `provider`/`modelId` come from `runtime.specFor("gm")`, stamped by the
 * agent so the pipeline can log the model that actually proposed a move
 * without knowing routing — the same reason `IntentResult` stamps them.
 */
export type GmResult =
  | {
      ok: true;
      move: NarrativeMove;
      provider: string;
      modelId: string;
      usage: readonly TokenUsage[];
    }
  | { ok: false; error: AdapterError; usage: readonly TokenUsage[] };

export interface GmAgent {
  propose(input: ProposeInput): Promise<GmResult>;
}

export function createGmAgent({ runtime }: GmAgentOptions): GmAgent {
  // Asked of the runtime rather than resolved from a routing of our own — see
  // the same reasoning on `createIntentAgent`.
  const spec = runtime.specFor("gm");

  return {
    async propose(input: ProposeInput): Promise<GmResult> {
      const result = await runtime.structured("gm", {
        prompt: buildGmPrompt(input),
        schema: NarrativeMoveSchema,
        toolName: GM_TOOL_NAME,
        toolDescription: GM_TOOL_DESCRIPTION,
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
        move: result.value.value,
        provider: spec.provider,
        modelId: spec.modelId,
        usage: [result.value.usage],
      };
    },
  };
}
