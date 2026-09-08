// Assembles the GM prompt into the three cache tiers, mirroring
// `intent/prompt.ts` exactly: the scene card, NPC roster, classification,
// check outcome and detour list are English system material and belong in
// the semi-static tier; the player's text is untrusted and enters once,
// delimited, in the dynamic tier — never interpolated into the static system
// prompt. See `apps/server/CLAUDE.md`'s injection rule.
import type { LayeredPrompt } from "../providers/prompt.js";
import { renderPlayerMessage } from "../providers/prompt.js";
import type { IntentNpcPresent } from "../intent/prompt.js";
import { GM_SYSTEM_PROMPT } from "./prompt-text.js";

/**
 * An NPC present, as the GM tier needs to see it: `IntentNpcPresent` plus the
 * real, machine-readable id. The GM tier — unlike the intent router — must
 * name an npcId back in a `shift_npc_affinity`/`add_npc_fact` effect, and a
 * display name alone gives the model nothing to copy: it has to guess a slug,
 * which is exactly how a real proposal once named `maren_vess` (underscore)
 * for the real `maren-vess` (hyphenated) and was silently accepted before
 * `validateMove` learned to check.
 */
export interface GmNpcPresent extends IntentNpcPresent {
  npcId: string;
}

/**
 * A detour's shape as the GM tier needs to see it — deliberately its own
 * type rather than an import of `@ai-dm/rules-engine`'s `DetourOption`
 * (invariant 5: `@ai-dm/agents` never imports `@ai-dm/rules-engine`). Kept
 * to exactly the fields the prompt renders.
 */
export interface GmDetourOption {
  nodeId: string;
  titleEnglish: string;
  open: boolean;
}

export interface GmCheckOutcome {
  ability: string;
  skill?: string;
  success: boolean;
}

export interface GmPromptInput {
  /** The player's Hebrew, untrusted. */
  text: string;
  sceneEnglish: string;
  /** Everyone in the current location, in the same shape the router reads, plus their real id. */
  npcs: readonly GmNpcPresent[];
  /** What the intent router made of the player's message — a hint, not an instruction. */
  category: string;
  /** The result of a roll the player just made, when the turn rolled one. */
  checkOutcome?: GmCheckOutcome;
  /**
   * Side threads that exist in this world. Closed ones are included, with
   * `open: false` visible to the model — the same reasoning as
   * `IntentEdgeOption`: a closed detour can still be the right proposal, and
   * `validateMove`'s refusal (not this agent's judgment) is what the player
   * hears.
   */
  detours: readonly GmDetourOption[];
}

function renderNpcs(npcs: readonly GmNpcPresent[]): string {
  const lines = npcs.map(
    (npc) => `- ${npc.npcId} — ${npc.nameEnglish} (${npc.nameHebrew}): ${npc.descriptionEnglish}`,
  );
  return ["NPCS PRESENT", ...lines].join("\n");
}

function renderDetours(detours: readonly GmDetourOption[]): string {
  const lines = detours.map(
    (detour) => `- ${detour.nodeId} (${detour.open ? "open" : "closed"}): ${detour.titleEnglish}`,
  );
  return ["DETOURS", ...lines].join("\n");
}

function renderCheckOutcome(check: GmCheckOutcome | undefined): string | undefined {
  if (check === undefined) return undefined;
  const skillPart = check.skill === undefined ? "" : ` (${check.skill})`;
  return `CHECK\n${check.ability}${skillPart}: ${check.success ? "success" : "failure"}`;
}

export function buildGmPrompt(input: GmPromptInput): LayeredPrompt {
  const checkBlock = renderCheckOutcome(input.checkOutcome);

  return {
    static: [GM_SYSTEM_PROMPT],
    semiStatic: [
      `SCENE\n${input.sceneEnglish}`,
      renderNpcs(input.npcs),
      `CLASSIFICATION\n${input.category}`,
      ...(checkBlock === undefined ? [] : [checkBlock]),
      renderDetours(input.detours),
    ],
    dynamic: [renderPlayerMessage(input.text)],
  };
}
