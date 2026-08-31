import { describe, expect, it } from "vitest";
import { adapterFailure, adapterSuccess } from "../providers/errors.js";
import type { AdapterErrorCode, AdapterResult } from "../providers/errors.js";
import type { StructuredOutput } from "../providers/port.js";
import type { TokenUsage } from "../providers/usage.js";
import type { ModelRouting } from "../providers/routing.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { createAgentRuntime } from "../providers/runtime.js";
import type { AgentRuntime } from "../providers/runtime.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import { createGmAgent } from "./index.js";
import { GM_TOOL_NAME } from "./prompt-text.js";
import type { GmPromptInput } from "./prompt.js";

const usage: TokenUsage = { promptTokens: 50, completionTokens: 10, totalTokens: 60 };

/** One NPC present, so the roster the GM reads is never empty in a test. */
const NPCS = [
  {
    nameEnglish: "Sela the Innkeeper",
    nameHebrew: "סלה הפונדקאית",
    descriptionEnglish: "Keeps the only inn in town.",
  },
];

function baseInput(): GmPromptInput {
  return {
    text: "אני רוצה לדבר עם סלה",
    sceneEnglish: "A dusty tavern common room.",
    npcs: NPCS,
    category: "social",
    detours: [],
  };
}

function fakeRuntime(move: unknown): AgentRuntime {
  const port = createFakePort({ structured: [adapterSuccess({ value: move, usage })] });
  return createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });
}

function failingRuntime(
  code: AdapterErrorCode,
  message: string,
  diagnostics: { usage?: TokenUsage } = {},
): AgentRuntime {
  const port = createFakePort({ structured: [adapterFailure(code, message, diagnostics)] });
  return createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });
}

function agentWith(...structured: AdapterResult<StructuredOutput<unknown>>[]) {
  const port = createFakePort({ structured });
  const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });
  return { port, agent: createGmAgent({ runtime }) };
}

describe("createGmAgent — a successful proposal", () => {
  it("returns the validated move on success", async () => {
    const agent = createGmAgent({ runtime: fakeRuntime({ kind: "none" }) });

    const result = await agent.propose(baseInput());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.move).toEqual({ kind: "none" });
  });

  it("stamps the provider and model so the pipeline need not know routing", async () => {
    const agent = createGmAgent({ runtime: fakeRuntime({ kind: "none" }) });

    const result = await agent.propose(baseInput());

    if (!result.ok) throw new Error("expected a proposal");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-5.4-nano");
  });

  it("carries one usage entry", async () => {
    const { agent } = agentWith(adapterSuccess({ value: { kind: "none" }, usage }));

    const result = await agent.propose(baseInput());

    expect(result.usage).toStrictEqual([usage]);
  });

  it("makes exactly one model call", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: { kind: "none" }, usage }));

    await agent.propose(baseInput());

    expect(port.calls).toHaveLength(1);
  });

  it("asks the gm model, with the propose_move tool", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: { kind: "none" }, usage }));

    await agent.propose(baseInput());

    expect(port.calls[0]?.spec.modelId).toBe(DEFAULT_MODEL_ROUTING.gm.modelId);
    expect(port.calls[0]?.request.toolName).toBe(GM_TOOL_NAME);
  });

  it("hands the caller's abort signal to the model call", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: { kind: "none" }, usage }));
    const { signal } = new AbortController();

    await agent.propose({ ...baseInput(), abortSignal: signal });

    expect(port.calls[0]?.request.abortSignal).toBe(signal);
  });

  it("returns a world move with its effects and reason intact", async () => {
    const move = {
      kind: "world",
      effects: [{ kind: "shift_npc_affinity", npcId: "sela", delta: 1 }],
      reasonEnglish: "The player shared a secret with Sela.",
    };
    const { agent } = agentWith(adapterSuccess({ value: move, usage }));

    const result = await agent.propose(baseInput());

    if (!result.ok) throw new Error("expected a proposal");
    expect(result.move).toStrictEqual(move);
  });

  it("does not stamp a routing of its own — only the model the runtime called", async () => {
    const routing: ModelRouting = {
      ...DEFAULT_MODEL_ROUTING,
      gm: { provider: "openai", modelId: "gpt-5.4-nano-gm" },
    };
    const port = createFakePort({ structured: [adapterSuccess({ value: { kind: "none" }, usage })] });
    const agent = createGmAgent({ runtime: createAgentRuntime({ routing, port }) });

    const result = await agent.propose(baseInput());

    if (!result.ok) throw new Error("expected a proposal");
    expect(port.calls[0]?.spec.modelId).toBe("gpt-5.4-nano-gm");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-5.4-nano-gm");
  });
});

describe("createGmAgent — an adapter failure", () => {
  it("surfaces an adapter error rather than throwing, so the pipeline can degrade", async () => {
    const agent = createGmAgent({ runtime: failingRuntime("provider_error", "boom") });

    const result = await agent.propose(baseInput());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provider_error");
  });

  it("does not invent usage for a failure the provider did not price", async () => {
    const agent = createGmAgent({
      runtime: failingRuntime("provider_error", "boom"),
    });

    const result = await agent.propose(baseInput());

    expect(result.usage).toEqual([]);
  });

  it("carries whatever usage the provider billed for the failed attempt", async () => {
    const billedUsage: TokenUsage = { promptTokens: 30, completionTokens: 5, totalTokens: 35 };
    const agent = createGmAgent({
      runtime: failingRuntime("schema_validation_failed", "Tool call did not match", {
        usage: billedUsage,
      }),
    });

    const result = await agent.propose(baseInput());

    if (result.ok) throw new Error("expected a failure");
    expect(result.usage).toStrictEqual([billedUsage]);
  });

  it("makes no retry of its own", async () => {
    const { port, agent } = agentWith(adapterFailure("no_tool_call", "The model answered in prose."));

    await agent.propose(baseInput());

    expect(port.calls).toHaveLength(1);
  });
});
