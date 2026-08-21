// The Hebrew narrative agent: brief in, Hebrew tokens out.
//
// It does exactly one thing beyond assembling the prompt — it declines to
// throw. A provider error ends the stream after whatever text arrived, and
// the pipeline decides what to do about the shortfall. That split is
// deliberate: the pipeline owns the turn deadline, so it is the only place
// that can see BOTH ways a narration can come up short, and one rule applied
// there beats two rules applied in two places.
import type { AdapterError } from "../providers/errors.js";
import type { TokenUsage } from "../providers/port.js";
import type { AgentRuntime } from "../providers/runtime.js";
import type { NarrationInput, NarrativePort } from "./port.js";
import { buildNarrativePrompt } from "./prompt.js";
import { NARRATIVE_PROMPT_VERSION } from "./prompt-text.js";

/** Instrumentation, deliberately off the token stream. */
export interface NarrativeFinish {
  usage?: TokenUsage;
  /** Present when the provider failed in-band. The stream still ended cleanly. */
  error?: AdapterError;
  latencyMs: number;
  promptVersion: string;
}

export interface HebrewNarrativeOptions {
  runtime: AgentRuntime;
  /**
   * Called exactly once per stream, including when the consumer abandons it
   * early. `apps/server/CLAUDE.md` requires per-turn per-agent instrumentation,
   * and without this a swallowed provider error would be invisible.
   */
  onFinish?: (finish: NarrativeFinish) => void;
  /** Injected so a test can assert latency without a real clock. */
  now?: () => number;
}

async function* streamNarration(
  options: HebrewNarrativeOptions,
  input: NarrationInput,
): AsyncIterable<string> {
  const now = options.now ?? ((): number => Date.now());
  const startedAt = now();
  let usage: TokenUsage | undefined;
  let error: AdapterError | undefined;

  try {
    for await (const chunk of options.runtime.stream("narrative", {
      prompt: buildNarrativePrompt(input),
    })) {
      if (chunk.type === "text-delta") {
        yield chunk.text;
        continue;
      }
      if (chunk.type === "finish") {
        usage = chunk.usage;
        return;
      }
      error = chunk.error;
      return;
    }
  } finally {
    // `finally` rather than the happy path: a consumer that breaks out of its
    // for-await propagates `.return()` in here, and the turn still deserves a
    // metrics record. The pipeline's deadline cap does exactly that.
    options.onFinish?.({
      ...(usage === undefined ? {} : { usage }),
      ...(error === undefined ? {} : { error }),
      latencyMs: now() - startedAt,
      promptVersion: NARRATIVE_PROMPT_VERSION,
    });
  }
}

export function createHebrewNarrative(options: HebrewNarrativeOptions): NarrativePort {
  return {
    stream(input: NarrationInput): AsyncIterable<string> {
      return streamNarration(options, input);
    },
  };
}
