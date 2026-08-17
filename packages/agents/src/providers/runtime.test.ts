import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adapterSuccess } from "./errors.js";
import type { ModelRouting } from "./routing.js";
import { DEFAULT_MODEL_ROUTING } from "./routing.js";
import { createAgentRuntime } from "./runtime.js";
import { createFakePort } from "./testing/fake-port.js";

const usage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };
const prompt = { static: ["RULES"], dynamic: ["TURN STATE"] };

const turnRequest = {
  prompt,
  schema: z.object({ actorId: z.string() }),
  toolName: "execute_turn",
  toolDescription: "Propose a turn.",
};

function portWithOneStructuredResult() {
  return createFakePort({ structured: [adapterSuccess({ value: { actorId: "gob-2" }, usage })] });
}

describe("createAgentRuntime", () => {
  it("calls the model configured for the tactical role", async () => {
    const port = portWithOneStructuredResult();
    const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });

    await runtime.structured("tactical", turnRequest);

    expect(port.calls[0]?.spec.provider).toBe("google");
    expect(port.calls[0]?.spec.modelId).toBe("gemini-3-flash");
  });

  it("calls the narrative model for narration, not the tactical one", async () => {
    const port = createFakePort({ text: [adapterSuccess({ text: "הגובלין נופל.", usage })] });
    const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });

    await runtime.text("narrative", { prompt });

    expect(port.calls[0]?.spec.provider).toBe("anthropic");
    expect(port.calls[0]?.spec.modelId).toBe("claude-sonnet-5");
  });

  it("carries the role's call parameters through, not just its model id", async () => {
    const port = portWithOneStructuredResult();
    const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });

    await runtime.structured("intent", turnRequest);

    expect(port.calls[0]?.spec.temperature).toBe(0);
    expect(port.calls[0]?.spec.reasoningEffort).toBe("low");
  });

  it("honours a custom routing over the default", async () => {
    const routing: ModelRouting = {
      ...DEFAULT_MODEL_ROUTING,
      tactical: { provider: "openai", modelId: "gpt-5.4-mini", reasoningEffort: "medium" },
    };
    const port = portWithOneStructuredResult();
    const runtime = createAgentRuntime({ routing, port });

    await runtime.structured("tactical", turnRequest);

    expect(port.calls[0]?.spec.provider).toBe("openai");
    expect(port.calls[0]?.spec.modelId).toBe("gpt-5.4-mini");
  });

  it("passes the caller's request through untouched", async () => {
    const port = portWithOneStructuredResult();
    const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });

    await runtime.structured("tactical", turnRequest);

    expect(port.calls[0]?.request.prompt).toStrictEqual(prompt);
    expect(port.calls[0]?.request.toolName).toBe("execute_turn");
  });

  it("returns the port's result unchanged", async () => {
    const port = portWithOneStructuredResult();
    const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });

    const result = await runtime.structured("tactical", turnRequest);

    if (!result.ok) throw new Error("expected success");
    expect(result.value.value.actorId).toBe("gob-2");
  });

  it("reports the same spec through specFor that it calls the port with", async () => {
    // A caller that has to name the model — `action_rejected` payloads carry
    // the provider and model id — must read it from the runtime making the
    // call, or the log can name a model nobody called.
    const routing: ModelRouting = {
      ...DEFAULT_MODEL_ROUTING,
      tactical: { provider: "openai", modelId: "gpt-5.4-mini", reasoningEffort: "medium" },
    };
    const port = portWithOneStructuredResult();
    const runtime = createAgentRuntime({ routing, port });

    await runtime.structured("tactical", turnRequest);

    expect(runtime.specFor("tactical")).toStrictEqual(port.calls[0]?.spec);
    expect(runtime.specFor("narrative").modelId).toBe("claude-sonnet-5");
  });

  it("streams from the role's configured model", async () => {
    const port = createFakePort({
      stream: [[{ type: "text-delta", text: "הגובלין" }, { type: "finish", text: "הגובלין", usage }]],
    });
    const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });

    const seen = [];
    for await (const chunk of runtime.stream("narrative", { prompt })) {
      seen.push(chunk);
    }

    expect(port.calls[0]?.spec.modelId).toBe("claude-sonnet-5");
    expect(seen).toHaveLength(2);
  });
});
