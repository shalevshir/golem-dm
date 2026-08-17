// Assembles the tactical prompt into the three cache tiers. The whole point of
// the tiering is that a retry may only ever add to `dynamic` — anything added
// to a cached tier destroys the prefix match for every later call.
import type { ExecuteTurn } from "@ai-dm/schemas";
import type { LayeredPrompt } from "../providers/prompt.js";
import { RETRY_PREAMBLE, TACTICAL_SYSTEM_PROMPT } from "./prompt-text.js";
import type { CapabilityCard, CombatSnapshot } from "./snapshot.js";

/** Why the previous attempt failed. Rendered into the dynamic tier on a retry. */
export interface RetryFeedback {
  /** Stable codes — a `TurnRejectionReason` or an `AdapterErrorCode`. */
  codes: readonly string[];
  messages: readonly string[];
  /** The rejected proposal, when the model produced one at all. */
  proposedTurn?: ExecuteTurn;
}

export interface TacticalPromptInput {
  snapshot: CombatSnapshot;
  card: CapabilityCard;
  feedback?: RetryFeedback;
}

function renderFeedback(feedback: RetryFeedback): string {
  const lines = [
    RETRY_PREAMBLE,
    `Rejection codes: ${feedback.codes.join(", ")}`,
    ...feedback.messages.map((message) => `- ${message}`),
  ];

  if (feedback.proposedTurn !== undefined) {
    lines.push(`The proposal you sent was: ${JSON.stringify(feedback.proposedTurn)}`);
  }

  return lines.join("\n");
}

export function buildTacticalPrompt(input: TacticalPromptInput): LayeredPrompt {
  const dynamic = [`COMBAT STATE\n${JSON.stringify(input.snapshot)}`];
  if (input.feedback !== undefined) dynamic.push(renderFeedback(input.feedback));

  return {
    static: [TACTICAL_SYSTEM_PROMPT],
    semiStatic: [`YOUR CAPABILITIES\n${JSON.stringify(input.card)}`],
    dynamic,
  };
}
