// The fourth tier. Unlike the narrative tiers it does not stream, and unlike
// the intent tier it does not use structured output — a paragraph of English
// is the whole product, so `runtime.text` is the right call shape.
//
// It never falls back on its own. `null` goes back to `apps/server`, which
// owns the degradation ladder for every tier (see packages/agents/CLAUDE.md).
import type { AgentRuntime } from "../providers/runtime.js";
import type { LayeredPrompt } from "../providers/prompt.js";
import {
  SUMMARY_FACTS_HEADING,
  SUMMARY_NARRATION_HEADING,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_TASK_HEADING,
} from "./prompt-text.js";
import type { SceneSummaryInput, SceneSummaryPort } from "./port.js";

export function buildSummaryPrompt(input: SceneSummaryInput): LayeredPrompt {
  const dynamic = [SUMMARY_TASK_HEADING, input.contextEnglish];

  if (input.factsEnglish.length > 0) {
    dynamic.push([SUMMARY_FACTS_HEADING, ...input.factsEnglish.map((fact) => `- ${fact}`)].join("\n"));
  }
  if (input.recentNarrations.length > 0) {
    dynamic.push(
      [SUMMARY_NARRATION_HEADING, ...input.recentNarrations.map((each) => `- ${each}`)].join("\n"),
    );
  }

  // Everything is dynamic: an episode summary shares no prefix with the next
  // episode's, so there is nothing cacheable to hoist into `static` beyond
  // the system prompt itself.
  return { static: [SUMMARY_SYSTEM_PROMPT], dynamic };
}

export interface SceneSummarizerOptions {
  runtime: AgentRuntime;
}

export function createSceneSummarizer(options: SceneSummarizerOptions): SceneSummaryPort {
  return {
    async summarize(input: SceneSummaryInput): Promise<string | null> {
      const result = await options.runtime.text("summary", {
        prompt: buildSummaryPrompt(input),
      });

      if (!result.ok) return null;
      const text = result.value.text.trim();
      return text === "" ? null : text;
    },
  };
}

export * from "./port.js";
export * from "./deterministic.js";
export * from "./prompt-text.js";
