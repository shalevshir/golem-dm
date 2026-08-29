import { describe, expect, it } from "vitest";
import { adapterFailure, adapterSuccess } from "../providers/errors.js";
import type { AdapterResult } from "../providers/errors.js";
import type { StructuredOutput } from "../providers/port.js";
import type { ModelRouting } from "../providers/routing.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { createAgentRuntime } from "../providers/runtime.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import { createIntentAgent } from "./index.js";
import { INTENT_TOOL_NAME } from "./prompt-text.js";

const usage = { promptTokens: 50, completionTokens: 10, totalTokens: 60 };

const input = {
  text: "אני מנסה לפרוץ את המנעול",
  sceneEnglish: "A dusty tavern common room.",
  edges: [{ to: "cellar-stairs", labelEnglish: "the cellar stairs", open: true }],
};

const classification = {
  category: "check",
  ability: "dex",
  skill: "sleight_of_hand",
  difficulty: "medium",
} as const;

function agentWith(...structured: AdapterResult<StructuredOutput<unknown>>[]) {
  const port = createFakePort({ structured });
  const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });
  return { port, agent: createIntentAgent({ runtime }) };
}

describe("createIntentAgent — a successful classification", () => {
  it("returns the model's classification", async () => {
    const { agent } = agentWith(adapterSuccess({ value: classification, usage }));

    const result = await agent.classify(input);

    if (!result.ok) throw new Error("expected a classification");
    expect(result.classification).toStrictEqual(classification);
  });

  it("stamps the provider and model id the runtime actually called", async () => {
    const { agent } = agentWith(adapterSuccess({ value: classification, usage }));

    const result = await agent.classify(input);

    if (!result.ok) throw new Error("expected a classification");
    expect(result.provider).toBe(DEFAULT_MODEL_ROUTING.intent.provider);
    expect(result.modelId).toBe(DEFAULT_MODEL_ROUTING.intent.modelId);
  });

  it("carries one usage entry", async () => {
    const { agent } = agentWith(adapterSuccess({ value: classification, usage }));

    const result = await agent.classify(input);

    expect(result.usage).toStrictEqual([usage]);
  });

  it("makes exactly one model call", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: classification, usage }));

    await agent.classify(input);

    expect(port.calls).toHaveLength(1);
  });

  it("asks the intent model, with the classify_intent tool", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: classification, usage }));

    await agent.classify(input);

    expect(port.calls[0]?.spec.modelId).toBe(DEFAULT_MODEL_ROUTING.intent.modelId);
    expect(port.calls[0]?.request.toolName).toBe(INTENT_TOOL_NAME);
  });

  it("hands the caller's abort signal to the model call", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: classification, usage }));
    const { signal } = new AbortController();

    await agent.classify({ ...input, abortSignal: signal });

    expect(port.calls[0]?.request.abortSignal).toBe(signal);
  });

  it("does not stamp a routing of its own — only the model the runtime called", async () => {
    // The result feeds an append-only log; naming a model that was never
    // called would poison the one dataset step 7b's benchmark is built from.
    const routing: ModelRouting = {
      ...DEFAULT_MODEL_ROUTING,
      intent: { provider: "openai", modelId: "gpt-5.4-nano-classify" },
    };
    const port = createFakePort({
      structured: [adapterSuccess({ value: classification, usage })],
    });
    const agent = createIntentAgent({ runtime: createAgentRuntime({ routing, port }) });

    const result = await agent.classify(input);

    if (!result.ok) throw new Error("expected a classification");
    expect(port.calls[0]?.spec.modelId).toBe("gpt-5.4-nano-classify");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-5.4-nano-classify");
  });
});

describe("createIntentAgent — an adapter failure", () => {
  it("returns ok:false carrying the error, with no retry of its own", async () => {
    const { port, agent } = agentWith(
      adapterFailure("no_tool_call", "The model answered in prose."),
    );

    const result = await agent.classify(input);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("no_tool_call");
    expect(port.calls).toHaveLength(1);
  });

  it("carries whatever usage the provider billed for the failed attempt", async () => {
    const { agent } = agentWith(
      adapterFailure("schema_validation_failed", "Tool call did not match", {
        usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
      }),
    );

    const result = await agent.classify(input);

    if (result.ok) throw new Error("expected a failure");
    expect(result.usage).toStrictEqual([{ promptTokens: 30, completionTokens: 5, totalTokens: 35 }]);
  });

  it("reports no usage when the provider billed nothing", async () => {
    const { agent } = agentWith(adapterFailure("provider_error", "429 rate limited"));

    const result = await agent.classify(input);

    if (result.ok) throw new Error("expected a failure");
    expect(result.usage).toStrictEqual([]);
  });
});
