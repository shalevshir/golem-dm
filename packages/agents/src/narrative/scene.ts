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
import { SCENE_PROMPT_VERSION, SCENE_SYSTEM_PROMPT } from "./scene-prompt-text.js";

/**
 * The beat as English system material for the dynamic tier. Hebrew fields
 * (a location or NPC name) are embedded verbatim, exactly as combat's
 * `renderBeat` embeds `NarratedCreature.nameHebrew` into an English line —
 * invariant 2 permits Hebrew as a VALUE here, never as an instruction.
 */
function renderBeat(beat: SceneBeat): string {
  switch (beat.kind) {
    case "arrived":
      return `- arrived: the player reached ${beat.locationNameHebrew}`;
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

function renderNpcs(npcNamesHebrew: readonly string[]): string {
  return ["NPCS PRESENT", ...npcNamesHebrew.map((name) => `- ${name}`)].join("\n");
}

export function buildScenePrompt(input: SceneNarrationInput): LayeredPrompt {
  const semiStatic = [`SCENE\n${input.sceneEnglish}`, `PLAYER\nName: ${input.playerNameHebrew}\nGender: ${input.playerGender}`];

  // Omitted rather than sent empty: an empty "NPCS PRESENT" section is a line
  // of uncached tokens naming nobody. Mirrors `prompt.ts`'s treatment of
  // `recentNarrations`.
  if (input.npcNamesHebrew.length > 0) {
    semiStatic.push(renderNpcs(input.npcNamesHebrew));
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

export function createHebrewSceneNarrative(options: HebrewSceneNarrativeOptions): SceneNarrativePort {
  return {
    stream(input: SceneNarrationInput): AsyncIterable<string> {
      return streamSceneNarration(options, input);
    },
  };
}
