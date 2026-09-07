// The Hebrew scene narrator: brief in, Hebrew tokens out. A sibling of
// `hebrew.ts` for out-of-combat beats, sharing its role ("narrative" — a
// separate scene role is YAGNI until a benchmark asks for one), its error
// handling (an in-band `error` chunk ends the stream silently; the
// pipeline's ladder supplies the fallback), and its `NarrativeFinish`
// instrumentation shape.
import type { AdapterError } from "../providers/errors.js";
import type { LayeredPrompt } from "../providers/prompt.js";
import type { AgentRuntime } from "../providers/runtime.js";
import type { NarrativeFinish } from "./hebrew.js";
import { HEBREW_GLOSSARY } from "./prompt-text.js";
import type { SceneBeat, SceneNarrationInput, SceneNarrativePort } from "./scene-port.js";
import {
  SCENE_MEMORY_HEADING,
  SCENE_PROMPT_VERSION,
  SCENE_SYSTEM_PROMPT,
} from "./scene-prompt-text.js";

/**
 * The beat as English system material for the dynamic tier. Hebrew fields
 * (a location or NPC name) are embedded verbatim, exactly as combat's
 * `renderBeat` embeds `NarratedCreature.nameHebrew` into an English line —
 * invariant 2 permits Hebrew as a VALUE here, never as an instruction.
 */
function renderBeat(beat: SceneBeat): string {
  switch (beat.kind) {
    // "opens at", never "reached": this is where the story starts, and the
    // player has not travelled to get here. The prompt's own SCENE section
    // carries the node's card, so this line only has to establish that the
    // paragraph is an opening rather than an arrival.
    case "opening":
      return `- opening: the story begins with the player already at ${beat.locationNameHebrew}`;
    case "arrived":
      return `- arrived: the player reached ${beat.locationNameHebrew}`;
    // The hostiles ride in the beat (the DYNAMIC tier) rather than in
    // `semiStatic`'s NPCS PRESENT: they are true for exactly this turn, not
    // for as long as the campaign stands at the node, so the cached tier
    // would keep them in the prompt for every later turn of the fight and
    // its aftermath.
    case "ambushed":
      return [
        `- ambushed: the player reached ${beat.locationNameHebrew} and is attacked there the moment they arrive`,
        "HOSTILES (attacking right now; name them exactly as written)",
        ...beat.hostileNamesHebrew.map((name) => `- ${name}`),
      ].join("\n");
    case "concluded":
      return `- concluded: the player concluded matters at ${beat.locationNameHebrew} without leaving it`;
    case "refused":
      return ["- refused. REFUSAL REASON (ground truth, translate, do not invent an alternative):"]
        .concat(beat.messages.map((message) => `  - ${message}`))
        .join("\n");
    case "check": {
      const skill = beat.skill === undefined ? "" : ` (skill: ${beat.skill})`;
      return `- check: ability ${beat.ability}${skill}, outcome: ${beat.success ? "success" : "failure"}`;
    }
    case "reply":
      return `- reply: the player's message was categorized as ${beat.category}`;
  }
}

function renderNpcs(npcs: SceneNarrationInput["npcsPresent"]): string {
  return [
    "NPCS PRESENT (name them exactly as written; the English after each name is what they are like, to translate into the scene, never to copy)",
    ...npcs.map((npc) => `- ${npc.nameHebrew}: ${npc.descriptionEnglish}`),
  ].join("\n");
}

export function buildScenePrompt(input: SceneNarrationInput): LayeredPrompt {
  const semiStatic = [
    `SCENE\n${input.sceneEnglish}`,
    `PLAYER\nName: ${input.playerNameHebrew}\nGender: ${input.playerGender}`,
  ];

  // Omitted rather than sent empty: an empty "NPCS PRESENT" section is a line
  // of uncached tokens naming nobody. Mirrors `prompt.ts`'s treatment of
  // `recentNarrations`.
  if (input.npcsPresent.length > 0) {
    semiStatic.push(renderNpcs(input.npcsPresent));
  }

  // Stable for as long as the campaign stands at this node — semiStatic, not
  // dynamic, so it rides the cached prefix instead of busting it every turn.
  if (input.memoryEnglish.length > 0) {
    semiStatic.push(
      [SCENE_MEMORY_HEADING, ...input.memoryEnglish.map((each) => `- ${each}`)].join("\n"),
    );
  }

  const dynamic = [renderBeat(input.beat)];
  if (input.recentNarrations.length > 0) {
    dynamic.push(
      ["RECENT NARRATION (do not reuse its verbs, imagery or sentence shapes)"]
        .concat(input.recentNarrations.map((each) => `- ${each}`))
        .join("\n"),
    );
  }

  return {
    static: [SCENE_SYSTEM_PROMPT, HEBREW_GLOSSARY],
    semiStatic,
    dynamic,
  };
}

export interface HebrewSceneNarrativeOptions {
  runtime: AgentRuntime;
  /** Called exactly once per stream — see `HebrewNarrativeOptions.onFinish`. */
  onFinish?: (finish: NarrativeFinish) => void;
}

async function* streamSceneNarration(
  options: HebrewSceneNarrativeOptions,
  input: SceneNarrationInput,
): AsyncIterable<string> {
  const startedAt = Date.now();
  let usage: NarrativeFinish["usage"];
  let error: AdapterError | undefined;

  try {
    for await (const chunk of options.runtime.stream("narrative", {
      prompt: buildScenePrompt(input),
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
    options.onFinish?.({
      ...(usage === undefined ? {} : { usage }),
      ...(error === undefined ? {} : { error }),
      latencyMs: Date.now() - startedAt,
      promptVersion: SCENE_PROMPT_VERSION,
    });
  }
}

export function createHebrewSceneNarrative(
  options: HebrewSceneNarrativeOptions,
): SceneNarrativePort {
  return {
    stream(input: SceneNarrationInput): AsyncIterable<string> {
      return streamSceneNarration(options, input);
    },
  };
}
