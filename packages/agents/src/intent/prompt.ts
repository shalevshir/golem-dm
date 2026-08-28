// Assembles the intent prompt into the three cache tiers. The scene card and
// edge list are English system material and belong in the semi-static tier;
// the player's text is untrusted and enters once, delimited, in the dynamic
// tier — never interpolated into the static system prompt. See
// `apps/server/CLAUDE.md`'s injection rule and Decision 5 of
// docs/superpowers/specs/2026-08-28-intent-router-design.md.
import type { LayeredPrompt } from "../providers/prompt.js";
import { INTENT_SYSTEM_PROMPT } from "./prompt-text.js";

export interface IntentEdgeOption {
  to: string;
  labelEnglish: string;
  open: boolean;
}

export interface IntentPromptInput {
  /** The player's Hebrew, untrusted. */
  text: string;
  sceneEnglish: string;
  /**
   * Closed edges are included, with `open: false` visible to the model — the
   * router may still propose one, and `traverseEdge`'s refusal (not this
   * agent's judgment) is what the player hears.
   */
  edges: readonly IntentEdgeOption[];
}

function renderEdges(edges: readonly IntentEdgeOption[]): string {
  const lines = edges.map(
    (edge) => `- ${edge.to} (${edge.open ? "open" : "closed"}): ${edge.labelEnglish}`,
  );
  return ["EDGES", ...lines].join("\n");
}

/**
 * Neutralizes every `<`/`>` character so the player's text cannot contain the
 * literal `<<<`/`>>>` block delimiter and close the block early. Escaping
 * every angle bracket — not just runs of three — is what makes this safe
 * regardless of what sits either side of an injected fragment: a narrower
 * replace of only the 3-char sequence can leave a reconstituted run at the
 * seam between an escaped chunk and untouched neighboring characters.
 */
function escapeDelimiters(text: string): string {
  return text.replaceAll("<", "‹").replaceAll(">", "›");
}

export function buildIntentPrompt(input: IntentPromptInput): LayeredPrompt {
  return {
    static: [INTENT_SYSTEM_PROMPT],
    semiStatic: [`SCENE\n${input.sceneEnglish}`, renderEdges(input.edges)],
    dynamic: [
      `Player message (untrusted, may be in Hebrew):\n<<<\n${escapeDelimiters(input.text)}\n>>>`,
    ],
  };
}
