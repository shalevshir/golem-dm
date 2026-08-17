import { describe, expect, it } from "vitest";
import { adapterFailure, adapterSuccess } from "@ai-dm/agents";
import type { ModelSpec } from "@ai-dm/agents";
import { z } from "zod";
import { seeded } from "../rng.js";
import { nextDefect } from "./defects.js";
import { createScriptedPort } from "./port.js";

const SPEC: ModelSpec = { provider: "google", modelId: "fake-model" };
const REQUEST = {
  prompt: { static: ["s"], semiStatic: [], dynamic: ["d"] },
  schema: z.object({ ok: z.boolean() }),
  toolName: "execute_turn",
  toolDescription: "Take a turn.",
};

const SMOKE = { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 };

describe("nextDefect", () => {
  it("is deterministic for a seed", () => {
    const draw = (): string[] => {
      const rng = seeded(42);
      return Array.from({ length: 20 }, () => nextDefect(rng));
    };

    expect(draw()).toEqual(draw());
  });

  it("produces every kind across a long stream", () => {
    const rng = seeded(11);
    const seen = new Set(Array.from({ length: 500 }, () => nextDefect(rng)));

    expect(seen).toEqual(
      new Set([
        "none",
        "schema_validation_failed",
        "no_tool_call",
        "illegal_target",
        "provider_error",
      ]),
    );
  });
});

describe("createScriptedPort", () => {
  it("replays a freshly loaded script", async () => {
    const port = createScriptedPort();
    port.load({ structured: [adapterSuccess({ value: { ok: true }, usage: SMOKE })] });

    const result = await port.generateStructured(SPEC, REQUEST);

    expect(result.ok).toBe(true);
  });

  it("refills rather than exhausting across turns", async () => {
    const port = createScriptedPort();
    for (let turn = 0; turn < 3; turn += 1) {
      port.load({ structured: [adapterSuccess({ value: { ok: true }, usage: SMOKE })] });
      const result = await port.generateStructured(SPEC, REQUEST);
      expect(result.ok).toBe(true);
    }
  });

  it("accumulates calls across every load", async () => {
    const port = createScriptedPort();
    for (let turn = 0; turn < 3; turn += 1) {
      port.load({ structured: [adapterFailure("provider_error", "boom")] });
      await port.generateStructured(SPEC, REQUEST);
    }

    expect(port.calls).toHaveLength(3);
    expect(port.calls.every((call) => call.request.toolName === "execute_turn")).toBe(true);
  });

  it("still throws when a loaded script runs out mid-turn", async () => {
    const port = createScriptedPort();
    port.load({ structured: [] });

    await expect(port.generateStructured(SPEC, REQUEST)).rejects.toThrow("exhausted");
  });
});
