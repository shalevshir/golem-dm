import { ExecuteTurn } from "@ai-dm/schemas";
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from "ai";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ModelSpec } from "./routing.js";
import { callSettingsFor, createVercelPort, providerOptionsFor } from "./vercel.js";

const flash: ModelSpec = { provider: "google", modelId: "gemini-3-flash" };

const turnRequest = {
  prompt: { static: ["RULES"], semiStatic: ["SHEET"], dynamic: ["TURN STATE"] },
  schema: ExecuteTurn,
  toolName: "execute_turn",
  toolDescription: "Propose this creature's turn.",
};

const legalTurn = {
  actorId: "gob-2",
  mainAction: { actionType: "dodge" },
  tacticalRationaleEnglish: "Outnumbered; stall until the shaman closes.",
};

let captured: LanguageModelV1CallOptions | undefined;

beforeEach(() => {
  captured = undefined;
});

// MockLanguageModelV1 declares `supportsStructuredOutputs` as `boolean |
// undefined` where the interface has it optional, which `exactOptionalProperty
// Types` rejects. The mock is a faithful LanguageModelV1 at runtime; this cast
// is the seam between the SDK's looser types and this repo's stricter ones.
function asLanguageModel(mock: MockLanguageModelV1): LanguageModelV1 {
  return mock as LanguageModelV1;
}

function generatingModel(
  body: () => ReturnType<LanguageModelV1["doGenerate"]>,
): LanguageModelV1 {
  return asLanguageModel(
    new MockLanguageModelV1({
      defaultObjectGenerationMode: "tool",
      doGenerate: (options) => {
        captured = options;
        return body();
      },
    }),
  );
}

function returningToolCall(args: unknown): LanguageModelV1 {
  return generatingModel(() =>
    Promise.resolve({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "tool-calls",
      usage: { promptTokens: 120, completionTokens: 30 },
      toolCalls: [
        {
          toolCallType: "function" as const,
          toolCallId: "call-1",
          toolName: "execute_turn",
          args: JSON.stringify(args),
        },
      ],
    }),
  );
}

function streamingModel(chunks: LanguageModelV1StreamPart[]): LanguageModelV1 {
  return asLanguageModel(
    new MockLanguageModelV1({
      doStream: (options) => {
        captured = options;
        return Promise.resolve({
          rawCall: { rawPrompt: null, rawSettings: {} },
          stream: simulateReadableStream({ chunks }),
        });
      },
    }),
  );
}

function portFor(model: LanguageModelV1) {
  return createVercelPort({ resolveModel: () => model });
}

describe("generateStructured", () => {
  it("returns the parsed proposal for a well-formed tool call", async () => {
    const result = await portFor(returningToolCall(legalTurn)).generateStructured(
      flash,
      turnRequest,
    );

    if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
    expect(result.value.value.actorId).toBe("gob-2");
    expect(result.value.value.mainAction.actionType).toBe("dodge");
  });

  it("reports token usage so the server can meter cost per turn", async () => {
    const result = await portFor(returningToolCall(legalTurn)).generateStructured(
      flash,
      turnRequest,
    );

    if (!result.ok) throw new Error("expected success");
    expect(result.value.usage).toStrictEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
    });
  });

  // The brief's requirement: a malformed tool call is a typed error value, not
  // a thrown string the caller has to pattern-match on.
  it("surfaces a schema-violating tool call as a typed error", async () => {
    const port = portFor(returningToolCall({ ...legalTurn, actorId: 7 }));

    const result = await port.generateStructured(flash, turnRequest);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("schema_validation_failed");
    expect(typeof result.error.message).toBe("string");
  });

  it("carries the zod issues the step 7 retry quotes back to the model", async () => {
    const port = portFor(returningToolCall({ ...legalTurn, actorId: 7 }));

    const result = await port.generateStructured(flash, turnRequest);

    if (result.ok) throw new Error("expected failure");
    expect(result.error.issues?.some((issue) => issue.path.includes("actorId"))).toBe(true);
  });

  it("distinguishes prose from a malformed proposal", async () => {
    const port = portFor(
      generatingModel(() =>
        Promise.resolve({
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop",
          usage: { promptTokens: 120, completionTokens: 5 },
          text: "I think the goblin should probably retreat.",
        }),
      ),
    );

    const result = await port.generateStructured(flash, turnRequest);

    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("no_tool_call");
  });

  it("surfaces a provider failure as provider_error", async () => {
    const port = portFor(
      generatingModel(() =>
        Promise.reject(
          new APICallError({
            message: "overloaded",
            url: "https://example.invalid",
            requestBodyValues: {},
            statusCode: 529,
            isRetryable: false,
          }),
        ),
      ),
    );

    const result = await port.generateStructured(flash, turnRequest);

    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("provider_error");
    expect(result.error.cause).toBeDefined();
  });

  it("reports an exhausted turn budget as aborted", async () => {
    const port = portFor(returningToolCall(legalTurn));

    const result = await port.generateStructured(flash, {
      ...turnRequest,
      abortSignal: AbortSignal.abort(),
    });

    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("aborted");
  });

  it("sends the layered prompt in cache-stable order", async () => {
    await portFor(returningToolCall(legalTurn)).generateStructured(flash, turnRequest);

    const roles = captured?.prompt.map((message) => message.role);
    expect(roles?.slice(0, 2)).toStrictEqual(["system", "system"]);
    expect(roles?.at(-1)).toBe("user");
  });

  it("names the tool from the request", async () => {
    await portFor(returningToolCall(legalTurn)).generateStructured(flash, turnRequest);

    // v4 carries the tool definition only on `mode`, which it already marks
    // deprecated ahead of the v2 provider interface. It is the sole way to
    // observe what tool schema reached the model until we move to v5.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mode = captured?.mode;
    expect(JSON.stringify(mode)).toContain("execute_turn");
  });
});

describe("streamText", () => {
  it("yields text deltas in order, then a finish chunk", async () => {
    const port = portFor(
      streamingModel([
        { type: "text-delta", textDelta: "הגובלין" },
        { type: "text-delta", textDelta: " נסוג" },
        { type: "text-delta", textDelta: " לאחור." },
        {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 90, completionTokens: 12 },
        },
      ]),
    );

    const seen = [];
    for await (const chunk of port.streamText(flash, { prompt: turnRequest.prompt })) {
      seen.push(chunk);
    }

    expect(seen.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text))
      .toStrictEqual(["הגובלין", " נסוג", " לאחור."]);
    expect(seen.at(-1)?.type).toBe("finish");
  });

  it("accumulates the full text on the finish chunk", async () => {
    const port = portFor(
      streamingModel([
        { type: "text-delta", textDelta: "one" },
        { type: "text-delta", textDelta: "two" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 2 },
        },
      ]),
    );

    const seen = [];
    for await (const chunk of port.streamText(flash, { prompt: turnRequest.prompt })) {
      seen.push(chunk);
    }

    const finish = seen.at(-1);
    expect(finish?.type === "finish" ? finish.text : undefined).toBe("onetwo");
  });

  it("ends a failed stream with an error chunk rather than throwing", async () => {
    const port = portFor(
      streamingModel([
        { type: "text-delta", textDelta: "start" },
        { type: "error", error: new Error("connection reset") },
      ]),
    );

    const seen = [];
    for await (const chunk of port.streamText(flash, { prompt: turnRequest.prompt })) {
      seen.push(chunk);
    }

    const last = seen.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" ? last.error.code : undefined).toBe("provider_error");
  });
});

describe("callSettingsFor", () => {
  it("maps maxOutputTokens onto the SDK maxTokens setting", () => {
    expect(callSettingsFor({ ...flash, maxOutputTokens: 512 }).maxTokens).toBe(512);
  });

  it("passes temperature through", () => {
    expect(callSettingsFor({ ...flash, temperature: 0.2 }).temperature).toBe(0.2);
  });

  it("omits settings the spec does not set", () => {
    expect(callSettingsFor(flash)).toStrictEqual({});
  });
});

describe("providerOptionsFor", () => {
  it("encodes reasoning effort as an OpenAI reasoning effort", () => {
    const options = providerOptionsFor({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      reasoningEffort: "high",
    });

    expect(options).toStrictEqual({ openai: { reasoningEffort: "high" } });
  });

  it("encodes reasoning effort as an Anthropic thinking budget", () => {
    const options = providerOptionsFor({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      reasoningEffort: "high",
    });

    expect(options.anthropic?.thinking).toStrictEqual({
      type: "enabled",
      budgetTokens: 16384,
    });
  });

  it("disables Anthropic thinking at the lowest effort", () => {
    const options = providerOptionsFor({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      reasoningEffort: "low",
    });

    expect(options.anthropic?.thinking).toStrictEqual({ type: "disabled" });
  });

  it("encodes reasoning effort as a Gemini thinking budget", () => {
    const options = providerOptionsFor({ ...flash, reasoningEffort: "medium" });

    expect(options.google?.thinkingConfig).toStrictEqual({ thinkingBudget: 4096 });
  });

  it("sends nothing when the spec asks for no particular effort", () => {
    expect(providerOptionsFor(flash)).toStrictEqual({});
  });

  it("lets an explicit providerOptions override the derived one", () => {
    const options = providerOptionsFor({
      ...flash,
      reasoningEffort: "high",
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 1 } } },
    });

    expect(options.google?.thinkingConfig).toStrictEqual({ thinkingBudget: 1 });
  });
});
