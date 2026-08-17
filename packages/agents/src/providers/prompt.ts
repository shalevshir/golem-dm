// Prompt assembly that makes the cache-stable prefix ordering mechanical.
//
// Cached input costs ~10% of fresh input on Anthropic and OpenAI and ~25% on
// Gemini, but only for an EXACT prefix match. One line of turn state spliced
// into the system block invalidates the cache on every single call, and the
// symptom is a bill, not a failure. Splitting the prompt into tiers makes that
// mistake a type error instead of an invisible regression.
import type { JsonValue, ProviderId } from "./routing.js";

export interface LayeredPrompt {
  /** Never varies within a campaign: system rules, Hebrew glossary. Cached. */
  static: readonly string[];
  /** Varies per scene: character sheet, NPC cards. Cached. */
  semiStatic?: readonly string[];
  /** Varies every call: turn state, player utterance. Never cached. */
  dynamic?: readonly string[];
}

export type ProviderOptionsMap = Record<string, Record<string, JsonValue>>;

/** Provider-neutral message. `vercel.ts` is what turns these into SDK types. */
export interface PromptMessage {
  role: "system" | "user";
  content: string;
  providerOptions?: ProviderOptionsMap;
}

const SEGMENT_SEPARATOR = "\n\n";

/**
 * Anthropic needs an explicit breakpoint marking where the reusable prefix
 * ends. Google and OpenAI match prefixes implicitly, so they get nothing.
 */
const CACHE_BREAKPOINT: ProviderOptionsMap = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

function tierContent(segments: readonly string[] | undefined): string | undefined {
  if (segments === undefined || segments.length === 0) return undefined;
  return segments.join(SEGMENT_SEPARATOR);
}

/**
 * Flatten a layered prompt into ordered messages: every cached tier first as
 * its own system message, then the dynamic tier as the user message.
 */
export function assemblePrompt(prompt: LayeredPrompt, provider: ProviderId): PromptMessage[] {
  const cached = [tierContent(prompt.static), tierContent(prompt.semiStatic)].filter(
    (content): content is string => content !== undefined,
  );

  const messages: PromptMessage[] = cached.map((content) => ({ role: "system", content }));

  // The breakpoint belongs on the LAST cached tier — it marks the end of the
  // prefix, so everything before it is what gets reused.
  const lastCached = messages.at(-1);
  if (lastCached !== undefined && provider === "anthropic") {
    lastCached.providerOptions = CACHE_BREAKPOINT;
  }

  const dynamic = tierContent(prompt.dynamic);
  if (dynamic !== undefined) {
    messages.push({ role: "user", content: dynamic });
  }

  return messages;
}
