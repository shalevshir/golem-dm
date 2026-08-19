import { ExecuteTurn } from "@ai-dm/schemas";
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from "ai";
import { APICallError, NoObjectGeneratedError, simulateReadableStream } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ModelSpec } from "./routing.js";
import {
  anthropicBodyFor,
  callSettingsFor,
  createVercelPort,
  providerOptionsFor,
  resolveLanguageModel,
} from "./vercel.js";

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

function generatingModel(body: () => ReturnType<LanguageModelV1["doGenerate"]>): LanguageModelV1 {
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

  // Pins that usage survives the nested-error unwrap: the SDK raises a schema
  // violation as a `NoObjectGeneratedError` wrapping a `TypeValidationError`,
  // and `usageFromError` reads the outer error, not the inner one.
  it("reports the tokens a schema-violating attempt was billed", async () => {
    const port = portFor(returningToolCall({ ...legalTurn, actorId: 7 }));

    const result = await port.generateStructured(flash, turnRequest);

    if (result.ok) throw new Error("expected failure");
    expect(result.error.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
    });
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

  // Live-confirmed 2026-08-18: Gemini's function-declaration schema rejects
  // `items` as an array of per-position schemas ("Proto field is not
  // repeating, cannot start list") — @ai-sdk/google@1.2.22 passes tuple-style
  // JSON Schema through unchanged, and zod-to-json-schema emits exactly that
  // shape for `Tile = z.tuple([...])`, used by `ExecuteTurn`'s
  // `destinationTile` and `targetTile`. Anthropic and OpenAI both accept it
  // fine; this is a google-only incompatibility.
  it("sends google a schema with no tuple-style `items` array — Gemini rejects those with a 400", async () => {
    await portFor(returningToolCall(legalTurn)).generateStructured(flash, turnRequest);

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mode = captured?.mode;
    expect(JSON.stringify(mode)).not.toMatch(/"items":\[/);
  });

  // Live-confirmed 2026-08-18, discovered after the fix above: with the
  // tuple bug fixed, live calls to gemini-3.1-flash-lite still failed.
  // `zodToJsonSchema` deduplicates repeated schemas with a `$ref` by
  // default, and `Tile` is used twice in `ExecuteTurn` (`destinationTile`
  // and `targetTile`), so the second occurrence became a JSON Pointer
  // rather than an inline schema. Gemini's function-declaration schema has
  // no `$ref` support (it is not general JSON Schema, only a restricted
  // OpenAPI-like subset), so this needs the same google-only detour as the
  // tuple fix.
  it("sends google a fully inlined schema — Gemini's function schema has no $ref support", async () => {
    await portFor(returningToolCall(legalTurn)).generateStructured(flash, turnRequest);

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const mode = captured?.mode;
    expect(JSON.stringify(mode)).not.toMatch(/"\$ref"/);
  });
});

describe("usage on failed structured calls", () => {
  it("reports the tokens a no-tool-call attempt was billed", async () => {
    const port = portFor(
      asLanguageModel(
        new MockLanguageModelV1({
          doGenerate: () => {
            throw new NoObjectGeneratedError({
              message: "No object generated.",
              text: "I think the goblin should charge.",
              response: { id: "r1", timestamp: new Date(0), modelId: "test" },
              usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
              finishReason: "stop",
            });
          },
        }),
      ),
    );

    const result = await port.generateStructured(flash, turnRequest);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("no_tool_call");
    expect(result.error.usage).toEqual({
      promptTokens: 900,
      completionTokens: 40,
      totalTokens: 940,
    });
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

    expect(
      seen.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text),
    ).toStrictEqual(["הגובלין", " נסוג", " לאחור."]);
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

  it("drops temperature for anthropic — claude-sonnet-5 returns a 400 for any explicit value", () => {
    const claude: ModelSpec = { provider: "anthropic", modelId: "claude-sonnet-5" };
    expect(callSettingsFor({ ...claude, temperature: 0.2 })).toStrictEqual({});
  });

  it("still maps maxOutputTokens for anthropic — only temperature is dropped", () => {
    const claude: ModelSpec = { provider: "anthropic", modelId: "claude-sonnet-5" };
    expect(callSettingsFor({ ...claude, temperature: 0.2, maxOutputTokens: 512 })).toStrictEqual({
      maxTokens: 512,
    });
  });
});

describe("resolveLanguageModel", () => {
  it("resolves openai through the Responses API, not Chat Completions", () => {
    // Chat Completions rejects function tools combined with reasoning_effort
    // (confirmed live: 400 on gpt-5.4-nano), and every call this repo makes
    // is exactly that combination. The two implementations are otherwise
    // indistinguishable from the outside, so this pins the constructor.
    const model = resolveLanguageModel({ provider: "openai", modelId: "gpt-5.4-nano" });
    expect(model.constructor.name).toBe("OpenAIResponsesLanguageModel");
  });

  // The anthropic case builds its own client so the request rewrite can close
  // over the spec. Resolving one must still read no credential: the whole
  // no-key-exported sim path depends on the failure arriving as a provider
  // error at call time, not as a throw at construction.
  it("resolves anthropic without touching the API key", () => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const model = resolveLanguageModel({ provider: "anthropic", modelId: "claude-sonnet-5" });
      expect(model.modelId).toBe("claude-sonnet-5");
    } finally {
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
    }
  });
});

describe("anthropicBodyFor", () => {
  const claude: ModelSpec = { provider: "anthropic", modelId: "claude-sonnet-5" };

  // `ai@4.3.19` substitutes temperature 0 for every request that omits one,
  // and claude-sonnet-5 answers any explicit value with a 400. callSettingsFor
  // cannot prevent that — only removing it from the body can.
  it("removes the temperature the SDK forces onto every request", () => {
    const body = anthropicBodyFor(claude, { model: "claude-sonnet-5", temperature: 0 });

    expect(body).not.toHaveProperty("temperature");
  });

  it("leaves the rest of the request alone", () => {
    const body = anthropicBodyFor(claude, {
      model: "claude-sonnet-5",
      temperature: 0,
      max_tokens: 512,
      tool_choice: { type: "tool", name: "execute_turn" },
    });

    expect(body).toStrictEqual({
      model: "claude-sonnet-5",
      max_tokens: 512,
      tool_choice: { type: "tool", name: "execute_turn" },
    });
  });

  // Adaptive-thinking models take reasoning depth as an effort level, and the
  // neutral names happen to be Anthropic's own, so they pass through unmapped.
  it.each(["low", "medium", "high"] as const)("carries %s effort as output_config", (effort) => {
    const body = anthropicBodyFor({ ...claude, reasoningEffort: effort }, { model: "x" });

    expect(body.output_config).toStrictEqual({ effort });
  });

  it("omits output_config when the spec asks for no particular effort", () => {
    expect(anthropicBodyFor(claude, { model: "x" })).not.toHaveProperty("output_config");
  });
});

describe("providerOptionsFor", () => {
  it("encodes reasoning effort as an OpenAI reasoning effort", () => {
    const options = providerOptionsFor({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      reasoningEffort: "high",
    });

    expect(options.openai?.reasoningEffort).toBe("high");
  });

  // The SDK defaults strictSchemas to true, and OpenAI's strict subset cannot
  // express either the Tile tuple or ExecuteTurn's optional properties — it
  // 400s on the tool definition before the model runs. Confirmed live on both
  // gpt-5.4-nano and gpt-5.4-mini, which fail 10/10 turns with it on.
  it.each([undefined, "low", "high"] as const)(
    "turns OpenAI strict schemas off at %s effort",
    (effort) => {
      const options = providerOptionsFor({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      });

      expect(options.openai?.strictSchemas).toBe(false);
    },
  );

  // Emitting `thinking` here is exactly what broke every anthropic call:
  // `{type:"enabled"}` collides with generateObject's forced tool choice
  // ("Thinking may not be enabled when tool_choice forces tool use"), and
  // claude-sonnet-5 rejects manual thinking outright. Effort now rides on the
  // request body instead — see the anthropicBodyFor block.
  it.each(["low", "medium", "high"] as const)(
    "sends no Anthropic thinking option at %s effort",
    (effort) => {
      const options = providerOptionsFor({
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        reasoningEffort: effort,
      });

      expect(options).toStrictEqual({});
    },
  );

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
