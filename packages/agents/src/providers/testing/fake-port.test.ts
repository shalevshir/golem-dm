import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adapterFailure, adapterSuccess } from "../errors.js";
import type { ModelSpec } from "../routing.js";
import { createFakePort } from "./fake-port.js";

const spec: ModelSpec = { provider: "google", modelId: "gemini-3-flash" };
const prompt = { static: ["RULES"], dynamic: ["TURN STATE"] };
const usage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };

const structuredRequest = {
  prompt,
  schema: z.object({ actorId: z.string() }),
  toolName: "execute_turn",
  toolDescription: "Propose a turn.",
};

describe("createFakePort", () => {
  it("records the model spec it was asked to call", async () => {
    const port = createFakePort({
      structured: [adapterSuccess({ value: { actorId: "gob-2" }, usage })],
    });

    await port.generateStructured(spec, structuredRequest);

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.spec).toStrictEqual(spec);
    expect(port.calls[0]?.kind).toBe("structured");
  });

  it("records the request so callers can assert on the prompt they built", async () => {
    const port = createFakePort({
      structured: [adapterSuccess({ value: { actorId: "gob-2" }, usage })],
    });

    await port.generateStructured(spec, structuredRequest);

    expect(port.calls[0]?.request.prompt).toStrictEqual(prompt);
  });

  it("replays scripted structured results in order", async () => {
    const port = createFakePort({
      structured: [
        adapterFailure("no_tool_call", "Answered in prose."),
        adapterSuccess({ value: { actorId: "gob-2" }, usage }),
      ],
    });

    const first = await port.generateStructured(spec, structuredRequest);
    const second = await port.generateStructured(spec, structuredRequest);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
  });

  it("replays scripted text results", async () => {
    const port = createFakePort({ text: [adapterSuccess({ text: "הגובלין נופל.", usage })] });

    const result = await port.generateText(spec, { prompt });

    if (!result.ok) throw new Error("expected success");
    expect(result.value.text).toBe("הגובלין נופל.");
  });

  it("replays scripted stream chunks in order", async () => {
    const port = createFakePort({
      stream: [
        [
          { type: "text-delta", text: "one" },
          { type: "text-delta", text: "two" },
          { type: "finish", text: "onetwo", usage },
        ],
      ],
    });

    const seen = [];
    for await (const chunk of port.streamText(spec, { prompt })) {
      seen.push(chunk);
    }

    expect(seen.map((chunk) => chunk.type)).toStrictEqual([
      "text-delta",
      "text-delta",
      "finish",
    ]);
  });

  // A double that silently returns undefined turns a test failure into a
  // confusing one somewhere else. Exhaustion should be loud.
  it("fails loudly when the script runs out", async () => {
    const port = createFakePort({ structured: [] });

    await expect(port.generateStructured(spec, structuredRequest)).rejects.toThrow(
      /exhausted/i,
    );
  });
});
