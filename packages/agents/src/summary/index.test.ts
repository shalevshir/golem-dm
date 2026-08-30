import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../providers/runtime.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import type { FakePortScript } from "../providers/testing/fake-port.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { adapterFailure, adapterSuccess } from "../providers/errors.js";
import type { AdapterResult } from "../providers/errors.js";
import type { TextOutput } from "../providers/port.js";
import { createSceneSummarizer } from "./index.js";
import type { SceneSummaryInput } from "./port.js";

const input: SceneSummaryInput = {
  kind: "quest_node",
  contextEnglish: "The weir at dusk.",
  factsEnglish: ["Node completed: quiet-word."],
  recentNarrations: ["טובין הנהן ופתח את השער."],
};

// `createFakePort` takes a `FakePortScript`, whose `text` field is
// `readonly AdapterResult<TextOutput>[]` — the summarizer only ever calls
// `generateText` (via `AgentRuntime.text`), so only that field is scripted.
function summarizerWith(...text: readonly AdapterResult<TextOutput>[]) {
  const script: FakePortScript = { text };
  const port = createFakePort(script);
  const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });
  return { port, agent: createSceneSummarizer({ runtime }) };
}

describe("createSceneSummarizer", () => {
  it("returns the model's text", async () => {
    const { agent } = summarizerWith(
      adapterSuccess({
        text: "Tobin opened the weir gate once the player invoked the Guild.",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    );

    expect(await agent.summarize(input)).toBe(
      "Tobin opened the weir gate once the player invoked the Guild.",
    );
  });

  it("calls the summary role's model, not the narrative one", async () => {
    const { port, agent } = summarizerWith(
      adapterSuccess({
        text: "x",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    );
    await agent.summarize(input);

    expect(port.calls[0]?.spec.modelId).toBe(DEFAULT_MODEL_ROUTING.summary.modelId);
  });

  it("returns null on a provider failure rather than throwing", async () => {
    const { agent } = summarizerWith(adapterFailure("provider_error", "down"));
    expect(await agent.summarize(input)).toBeNull();
  });

  it("returns null for an empty completion", async () => {
    const { agent } = summarizerWith(
      adapterSuccess({
        text: "   ",
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      }),
    );
    expect(await agent.summarize(input)).toBeNull();
  });
});
