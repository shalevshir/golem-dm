// The floor under the summarizer: a summary assembled from the engine's own
// English facts, with no model, no key and no network. It is what makes an
// episodic row unconditional — the model supplies the interpretive content
// that makes a memory worth retrieving, and this guarantees there is
// something to retrieve when the model is absent.
//
// It never reads `recentNarrations`. Those are Hebrew, and this output is
// English internal state — the same asymmetry `scene-deterministic.ts`
// documents for `refused` messages, for the same invariant-2 reason.
import type { SceneSummaryInput, SceneSummaryPort } from "./port.js";

export function createDeterministicSceneSummary(): SceneSummaryPort {
  return {
    summarize(input: SceneSummaryInput): Promise<string | null> {
      const parts = [input.contextEnglish, ...input.factsEnglish]
        .map((part) => part.trim())
        .filter((part) => part !== "");

      return Promise.resolve(parts.join(" "));
    },
  };
}
