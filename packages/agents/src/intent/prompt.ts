// Assembles the intent prompt into the three cache tiers. The scene card and
// edge list are English system material and belong in the semi-static tier;
// the player's text is untrusted and enters once, delimited, in the dynamic
// tier — never interpolated into the static system prompt. See
// `apps/server/CLAUDE.md`'s injection rule and Decision 5 of
// docs/superpowers/specs/2026-08-28-intent-router-design.md.
import type { LayeredPrompt } from "../providers/prompt.js";
import { renderPlayerMessage } from "../providers/prompt.js";
import { INTENT_SYSTEM_PROMPT } from "./prompt-text.js";

export interface IntentEdgeOption {
  to: string;
  labelEnglish: string;
  open: boolean;
}

/**
 * An NPC standing in the current node's location, as the router needs to see
 * them. Without this the router cannot connect a person to a way forward:
 * `arrival`'s edges are labelled "Hear out the guild factor" and "Hear out
 * the river warden", its scene card says only "Two people are waiting at the
 * bridge", and the player writes "מארן וס" — a name the narrator has already
 * shown them and that nothing else in this prompt defines. Every such turn
 * classified `social`, which is narrate-only, so naming the NPC the game had
 * just introduced was a dead end.
 */
export interface IntentNpcPresent {
  nameEnglish: string;
  /**
   * The player writes Hebrew, so an English-only roster is a roster the
   * router cannot match against the message it is classifying. This is the
   * same sanctioned direction as the player's own text: Hebrew as data to
   * match, never as instructions.
   */
  nameHebrew: string;
  /** One line, and the load-bearing half: it is what makes a name resolve to a role. */
  descriptionEnglish: string;
}

export interface IntentPromptInput {
  /** The player's Hebrew, untrusted. */
  text: string;
  sceneEnglish: string;
  /** Everyone in the current location — the scene card rarely names them. */
  npcs: readonly IntentNpcPresent[];
  /**
   * Closed edges are included, with `open: false` visible to the model — the
   * router may still propose one, and `traverseEdge`'s refusal (not this
   * agent's judgment) is what the player hears.
   */
  edges: readonly IntentEdgeOption[];
}

function renderNpcs(npcs: readonly IntentNpcPresent[]): string {
  const lines = npcs.map(
    (npc) => `- ${npc.nameEnglish} (${npc.nameHebrew}): ${npc.descriptionEnglish}`,
  );
  return ["NPCS PRESENT", ...lines].join("\n");
}

function renderEdges(edges: readonly IntentEdgeOption[]): string {
  const lines = edges.map(
    (edge) => `- ${edge.to} (${edge.open ? "open" : "closed"}): ${edge.labelEnglish}`,
  );
  return ["EDGES", ...lines].join("\n");
}

export function buildIntentPrompt(input: IntentPromptInput): LayeredPrompt {
  return {
    static: [INTENT_SYSTEM_PROMPT],
    semiStatic: [`SCENE\n${input.sceneEnglish}`, renderNpcs(input.npcs), renderEdges(input.edges)],
    dynamic: [renderPlayerMessage(input.text)],
  };
}
