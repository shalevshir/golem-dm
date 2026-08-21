import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../providers/runtime.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import type { StreamChunk } from "../providers/port.js";
import { createHebrewNarrative } from "./hebrew.js";
import type { NarrativeFinish } from "./hebrew.js";
import { buildNarrativePrompt } from "./prompt.js";
import { NARRATIVE_PROMPT_VERSION } from "./prompt-text.js";
import type { NarrationInput } from "./port.js";

const INPUT: NarrationInput = {
  actor: { nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] },
  actorSide: "party",
  beats: [{ kind: "hold" }],
  pulse: { hostilesStanding: 1, heroBand: "healthy" },
  sceneEnglish: "A dry hillside track.",
  recentNarrations: [],
};

const USAGE = { promptTokens: 900, completionTokens: 40, totalTokens: 940 };

function narrativeFor(chunks: StreamChunk[], now: () => number = () => 0) {
  const port = createFakePort({ stream: [chunks] });
  const finishes: NarrativeFinish[] = [];
  const narrative = createHebrewNarrative({
    runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    onFinish: (finish) => finishes.push(finish),
    now,
  });
  return { port, narrative, finishes };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("createHebrewNarrative", () => {
  it("yields the provider's text deltas verbatim", async () => {
    const { narrative } = narrativeFor([
      { type: "text-delta", text: "אלדד " },
      { type: "text-delta", text: "עומד במקומו." },
      { type: "finish", text: "אלדד עומד במקומו.", usage: USAGE },
    ]);
    expect(await collect(narrative.stream(INPUT))).toEqual(["אלדד ", "עומד במקומו."]);
  });

  it("calls the narrative role, not another one", async () => {
    const { port, narrative } = narrativeFor([{ type: "finish", text: "", usage: USAGE }]);
    await collect(narrative.stream(INPUT));
    expect(port.calls[0]?.kind).toBe("stream");
    expect(port.calls[0]?.spec.modelId).toBe(DEFAULT_MODEL_ROUTING.narrative.modelId);
    // The role and model can be right while the agent still hands the runtime
    // a stale or partial brief (e.g. a scene card dropped by a later
    // refactor) — that failure mode is invisible unless the actual prompt
    // sent to the port is checked against what `buildNarrativePrompt` would
    // produce for this exact input.
    expect(port.calls[0]?.request.prompt).toEqual(buildNarrativePrompt(INPUT));
  });

  it("reports usage and the prompt version on a clean finish", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד עומד במקומו." },
      { type: "finish", text: "אלדד עומד במקומו.", usage: USAGE },
    ]);
    await collect(narrative.stream(INPUT));
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.usage).toEqual(USAGE);
    expect(finishes[0]?.error).toBeUndefined();
    expect(finishes[0]?.promptVersion).toBe(NARRATIVE_PROMPT_VERSION);
  });

  it("reports latency measured from the injected clock", async () => {
    // Queue-backed, the same idiom `createFakePort` uses for its own scripted
    // results: first call is `startedAt`, second is the finally block's
    // `now() - startedAt`, so 0 then 12 must surface as exactly 12.
    const nowValues = [0, 12];
    const now = (): number => nowValues.shift() ?? 0;
    const { narrative, finishes } = narrativeFor([{ type: "finish", text: "", usage: USAGE }], now);
    await collect(narrative.stream(INPUT));
    expect(finishes[0]?.latencyMs).toBe(12);
  });

  it("ends the stream after an in-band error rather than throwing", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד מתק" },
      { type: "error", error: { code: "provider_error", message: "socket closed" } },
    ]);
    // Must not reject: throwing into an async iterator forces every consumer
    // into a try/catch around its for-await, which is exactly why StreamChunk
    // carries failure in-band.
    expect(await collect(narrative.stream(INPUT))).toEqual(["אלדד מתק"]);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.error?.code).toBe("provider_error");
  });

  it("reports a finish even when the consumer abandons the stream early", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד " },
      { type: "text-delta", text: "עומד במקומו." },
      { type: "finish", text: "אלדד עומד במקומו.", usage: USAGE },
    ]);
    for await (const chunk of narrative.stream(INPUT)) {
      expect(chunk).toBe("אלדד ");
      break;
    }
    expect(finishes).toHaveLength(1);
  });
});
