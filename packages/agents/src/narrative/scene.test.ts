import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../providers/runtime.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import type { StreamChunk } from "../providers/port.js";
import type { NarrativeFinish } from "./hebrew.js";
import { buildScenePrompt, createHebrewSceneNarrative } from "./scene.js";
import { SCENE_PROMPT_VERSION, SCENE_SYSTEM_PROMPT } from "./scene-prompt-text.js";
import { HEBREW_GLOSSARY } from "./prompt-text.js";
import type { SceneNarrationInput } from "./scene-port.js";

const INPUT: SceneNarrationInput = {
  beat: { kind: "arrived", sceneEnglish: "A quiet market square.", locationNameHebrew: "הכיכר" },
  sceneEnglish: "A quiet market square.",
  playerNameHebrew: "אלדד",
  playerGender: "masculine",
  npcNamesHebrew: ["רעות"],
  recentNarrations: [],
};

const USAGE = { promptTokens: 700, completionTokens: 30, totalTokens: 730 };

function narrativeFor(chunks: StreamChunk[]) {
  const port = createFakePort({ stream: [chunks] });
  const finishes: NarrativeFinish[] = [];
  const narrative = createHebrewSceneNarrative({
    runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    onFinish: (finish) => finishes.push(finish),
  });
  return { port, narrative, finishes };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("buildScenePrompt", () => {
  it("puts the version-stamped system text and glossary in the static tier", () => {
    const prompt = buildScenePrompt(INPUT);
    expect(prompt.static).toEqual([SCENE_SYSTEM_PROMPT, HEBREW_GLOSSARY]);
  });

  it("puts the scene card and NPC names in the semiStatic tier", () => {
    const prompt = buildScenePrompt(INPUT);
    expect(prompt.semiStatic?.some((segment) => segment.includes(INPUT.sceneEnglish))).toBe(true);
    expect(prompt.semiStatic?.some((segment) => segment.includes("רעות"))).toBe(true);
  });

  it("omits the NPC section when no NPCs are present", () => {
    const prompt = buildScenePrompt({ ...INPUT, npcNamesHebrew: [] });
    expect(prompt.semiStatic?.some((segment) => segment.includes("NPCS PRESENT"))).toBe(false);
  });

  it("puts the beat and recent narrations in the dynamic tier", () => {
    const withHistory = { ...INPUT, recentNarrations: ["אלדד הגיע לשוק."] };
    const prompt = buildScenePrompt(withHistory);
    expect(prompt.dynamic?.some((segment) => segment.includes("הכיכר"))).toBe(true);
    expect(prompt.dynamic?.some((segment) => segment.includes("אלדד הגיע לשוק."))).toBe(true);
  });

  // The heaviest requirement in this task: the English rejection messages
  // are the model's ONLY ground truth for explaining a refusal in-world —
  // the deterministic fallback deliberately never sees them (asymmetry by
  // design, see `scene-deterministic.ts`). If a future edit dropped
  // `beat.messages` from `renderBeat`, nothing else would catch it.
  it("puts every refusal message in the dynamic tier, as the model's ground truth for why", () => {
    const refused = {
      ...INPUT,
      beat: {
        kind: "refused" as const,
        messages: ["The door to the vault is locked from within.", "No key is present in the party's gear."],
      },
    };
    const prompt = buildScenePrompt(refused);
    expect(prompt.dynamic?.some((segment) => segment.includes("The door to the vault is locked from within."))).toBe(
      true,
    );
    expect(
      prompt.dynamic?.some((segment) => segment.includes("No key is present in the party's gear.")),
    ).toBe(true);
  });

  it("puts the check's ability, skill, and outcome in the dynamic tier", () => {
    const check = {
      ...INPUT,
      beat: { kind: "check" as const, ability: "dex" as const, skill: "stealth" as const, success: false },
    };
    const prompt = buildScenePrompt(check);
    expect(prompt.dynamic?.some((segment) => segment.includes("dex"))).toBe(true);
    expect(prompt.dynamic?.some((segment) => segment.includes("stealth"))).toBe(true);
    expect(prompt.dynamic?.some((segment) => segment.includes("failure"))).toBe(true);
  });

  it("puts the reply category in the dynamic tier", () => {
    const reply = { ...INPUT, beat: { kind: "reply" as const, category: "combat" as const } };
    const prompt = buildScenePrompt(reply);
    expect(prompt.dynamic?.some((segment) => segment.includes("combat"))).toBe(true);
  });
});

describe("createHebrewSceneNarrative", () => {
  it("yields the provider's text deltas verbatim", async () => {
    const { narrative } = narrativeFor([
      { type: "text-delta", text: "אלדד " },
      { type: "text-delta", text: "מגיע אל הכיכר." },
      { type: "finish", text: "אלדד מגיע אל הכיכר.", usage: USAGE },
    ]);
    expect(await collect(narrative.stream(INPUT))).toEqual(["אלדד ", "מגיע אל הכיכר."]);
  });

  it("calls the narrative role with exactly buildScenePrompt's prompt", async () => {
    const { port, narrative } = narrativeFor([{ type: "finish", text: "", usage: USAGE }]);
    await collect(narrative.stream(INPUT));
    expect(port.calls[0]?.kind).toBe("stream");
    expect(port.calls[0]?.spec.modelId).toBe(DEFAULT_MODEL_ROUTING.narrative.modelId);
    expect(port.calls[0]?.request.prompt).toEqual(buildScenePrompt(INPUT));
  });

  it("reports usage and the scene prompt version on a clean finish", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד מגיע אל הכיכר." },
      { type: "finish", text: "אלדד מגיע אל הכיכר.", usage: USAGE },
    ]);
    await collect(narrative.stream(INPUT));
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.usage).toEqual(USAGE);
    expect(finishes[0]?.error).toBeUndefined();
    expect(finishes[0]?.promptVersion).toBe(SCENE_PROMPT_VERSION);
  });

  it("ends the stream after an in-band error rather than throwing", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד מתק" },
      { type: "error", error: { code: "provider_error", message: "socket closed" } },
    ]);
    expect(await collect(narrative.stream(INPUT))).toEqual(["אלדד מתק"]);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.error?.code).toBe("provider_error");
  });

  it("reports a finish even when the consumer abandons the stream early", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד " },
      { type: "text-delta", text: "מגיע אל הכיכר." },
      { type: "finish", text: "אלדד מגיע אל הכיכר.", usage: USAGE },
    ]);
    for await (const chunk of narrative.stream(INPUT)) {
      expect(chunk).toBe("אלדד ");
      break;
    }
    expect(finishes).toHaveLength(1);
  });
});
