import { describe, expect, it } from "vitest";
import type { ModelRouting } from "./routing.js";
import { DEFAULT_MODEL_ROUTING, resolveModelSpec } from "./routing.js";

describe("DEFAULT_MODEL_ROUTING", () => {
  // The defaults are the PROJECT_PLAN.md section 3 pricing table. If that table
  // moves, this test is the thing that should fail.
  it("routes narrative to Claude Sonnet 5 for streaming Hebrew prose", () => {
    expect(DEFAULT_MODEL_ROUTING.narrative.provider).toBe("anthropic");
    expect(DEFAULT_MODEL_ROUTING.narrative.modelId).toBe("claude-sonnet-5");
  });

  it("routes intent to the cheapest tier at zero temperature", () => {
    expect(DEFAULT_MODEL_ROUTING.intent.provider).toBe("google");
    expect(DEFAULT_MODEL_ROUTING.intent.modelId).toBe("gemini-3-flash");
    expect(DEFAULT_MODEL_ROUTING.intent.temperature).toBe(0);
  });

  it("asks the intent classifier for the least reasoning", () => {
    expect(DEFAULT_MODEL_ROUTING.intent.reasoningEffort).toBe("low");
  });

  it("routes tactical to the mid tier pending the step 7 benchmark", () => {
    expect(DEFAULT_MODEL_ROUTING.tactical.provider).toBe("google");
    expect(DEFAULT_MODEL_ROUTING.tactical.modelId).toBe("gemini-3-flash");
  });

  it("keeps tactical near-deterministic without making every turn identical", () => {
    expect(DEFAULT_MODEL_ROUTING.tactical.temperature).toBe(0.2);
    expect(DEFAULT_MODEL_ROUTING.tactical.reasoningEffort).toBe("medium");
  });

  it("gives narrative room for varied prose", () => {
    expect(DEFAULT_MODEL_ROUTING.narrative.temperature).toBe(0.8);
  });

  it("covers every agent role", () => {
    expect(Object.keys(DEFAULT_MODEL_ROUTING).sort()).toStrictEqual([
      "intent",
      "narrative",
      "tactical",
    ]);
  });
});

describe("resolveModelSpec", () => {
  it("returns the spec configured for the requested role", () => {
    expect(resolveModelSpec(DEFAULT_MODEL_ROUTING, "narrative")).toStrictEqual(
      DEFAULT_MODEL_ROUTING.narrative,
    );
  });

  it("honours a caller override without touching the other roles", () => {
    const routing: ModelRouting = {
      ...DEFAULT_MODEL_ROUTING,
      tactical: { provider: "openai", modelId: "gpt-5.4-mini", reasoningEffort: "medium" },
    };

    expect(resolveModelSpec(routing, "tactical").modelId).toBe("gpt-5.4-mini");
    expect(resolveModelSpec(routing, "tactical").provider).toBe("openai");
    expect(resolveModelSpec(routing, "intent")).toStrictEqual(DEFAULT_MODEL_ROUTING.intent);
  });

  it("never mutates the routing it is given", () => {
    const routing: ModelRouting = { ...DEFAULT_MODEL_ROUTING };
    resolveModelSpec(routing, "tactical");
    expect(routing).toStrictEqual(DEFAULT_MODEL_ROUTING);
  });
});
