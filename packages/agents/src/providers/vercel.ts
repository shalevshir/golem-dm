// The Vercel AI SDK implementation of `LanguageModelPort`. The ONLY file in
// this package that imports the SDK — everything else depends on the port, so
// swapping SDKs or adding a provider touches one file.
//
// `resolveModel` is the test seam: injecting `MockLanguageModelV1` exercises
// this whole file with no network and no API keys.
import { createAnthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { CoreMessage, LanguageModelV1, Schema } from "ai";
import {
  APICallError,
  NoObjectGeneratedError,
  TypeValidationError,
  generateObject,
  generateText,
  jsonSchema,
  streamText as sdkStreamText,
} from "ai";
import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AdapterError, AdapterResult } from "./errors.js";
import { adapterFailure, adapterSuccess } from "./errors.js";
import type {
  LanguageModelPort,
  StreamChunk,
  StructuredOutput,
  StructuredRequest,
  TextOutput,
  TextRequest,
  TokenUsage,
} from "./port.js";
import type { ProviderOptionsMap, PromptMessage } from "./prompt.js";
import { assemblePrompt } from "./prompt.js";
import type { JsonValue, ModelSpec, ReasoningEffort } from "./routing.js";

/**
 * Thinking budget per effort level. Providers that bill reasoning by tokens
 * need a number, not a word.
 *
 * These are a plausible scale, NOT a measured one — step 7's sim benchmark is
 * what should set them. Exported so tuning is a one-line change.
 */
export const REASONING_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  low: 0,
  medium: 4096,
  high: 16384,
};

export interface SdkCallSettings {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Translate the spec's neutral names into AI SDK v4 call settings.
 *
 * Anthropic drops `temperature` here entirely: `claude-sonnet-5` returns a
 * 400 ("`temperature` is deprecated for this model") for any explicit value,
 * confirmed live against both thinking-enabled and thinking-disabled
 * requests — this is not a thinking-mode interaction, the parameter itself
 * is gone for this provider. A caller-supplied `ModelSpec.temperature` is
 * silently dropped rather than risking a hard failure on every anthropic
 * call; there is currently no anthropic model in this repo's config that
 * still accepts it.
 *
 * Dropping it here is necessary but NOT sufficient: `ai@4.3.19` substitutes
 * its own `temperature: 0` for every request that omits one (see
 * `anthropicBodyFor`, which takes it back off the wire). Both layers are
 * needed — this one keeps the SDK's own view of the call honest, that one
 * keeps the forced default out of the request.
 */
export function callSettingsFor(spec: ModelSpec): SdkCallSettings {
  const temperature = spec.provider === "anthropic" ? undefined : spec.temperature;

  return {
    ...(temperature === undefined ? {} : { temperature }),
    // v4 calls this maxTokens; v5 renamed it maxOutputTokens. Ours is the
    // unambiguous name and this is where it gets translated.
    ...(spec.maxOutputTokens === undefined ? {} : { maxTokens: spec.maxOutputTokens }),
  };
}

/**
 * Encode a neutral reasoning effort the way each provider expects it.
 *
 * Anthropic is absent on purpose. Its effort travels as `output_config.effort`
 * (see `anthropicBodyFor`), which `@ai-sdk/anthropic@1.2.12` has no
 * `providerOptions` key for — its schema accepts only `thinking`, the older
 * manual-budget control that `claude-sonnet-5` rejects outright.
 *
 * OpenAI gets `strictSchemas: false` on every call, effort or not. The SDK
 * defaults it to `true`, which makes OpenAI validate the tool schema against
 * its strict structured-output subset and reject `ExecuteTurn` with a 400
 * before the model is ever reached — on two counts, confirmed live:
 * `Invalid schema for function 'execute_turn': [{'type': 'integer'},
 * {'type': 'integer'}] is not of type 'object', 'boolean'` (the `Tile` tuple,
 * which strict mode has no representation for) and `'required' is required to
 * be supplied and to be an array including every key in properties` (strict
 * mode forbids optional properties, and most of `ExecuteTurn` is optional).
 *
 * Turning it off costs nothing this repo relies on. Strict mode is a
 * provider-side schema check, not the forced tool call — `tool_choice` still
 * forces `execute_turn` — and invariant 1 puts validation on our side of the
 * line anyway: `generateStructured` parses every tool call with the same zod
 * schema and reports a violation as `schema_validation_failed` with the zod
 * issues the tactical agent's retry quotes back to the model.
 */
export function providerOptionsFor(spec: ModelSpec): ProviderOptionsMap {
  const options: ProviderOptionsMap = {};
  const effort = spec.reasoningEffort;

  switch (spec.provider) {
    case "openai":
      options.openai = {
        strictSchemas: false,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      };
      break;
    case "anthropic":
      // Deliberately nothing: `anthropicBodyFor` writes the effort straight
      // onto the request body. Emitting `thinking` here is what made every
      // anthropic call fail — see that function for the two 400s.
      break;
    case "google":
      if (effort !== undefined) {
        options.google = { thinkingConfig: { thinkingBudget: REASONING_BUDGET_TOKENS[effort] } };
      }
      break;
  }

  // Explicit provider options win — that is what the escape hatch is for.
  for (const [provider, overrides] of Object.entries(spec.providerOptions ?? {})) {
    options[provider] = { ...options[provider], ...overrides };
  }

  return options;
}

/**
 * Rewrite an outgoing Anthropic Messages request into the shape
 * `claude-sonnet-5` actually accepts. Pure, and exported, because it encodes
 * two live-confirmed 400s that no unit test could otherwise pin.
 *
 * - **`temperature` comes off.** Anthropic answers any explicit value with
 *   400 "`temperature` is deprecated for this model", and `ai@4.3.19` inserts
 *   `temperature: 0` into every request that omits one (`// TODO v5 remove
 *   default 0 for temperature`, `prepareCallSettings`). `callSettingsFor` not
 *   sending one is therefore not enough; the default has to be removed here,
 *   on the wire.
 * - **`output_config.effort` goes on.** `claude-sonnet-5` is an
 *   adaptive-thinking model: it rejects the manual
 *   `thinking: {type:"enabled", budget_tokens}` that `@ai-sdk/anthropic@1.2.12`
 *   is built around, and takes reasoning depth as an effort level instead.
 *   The neutral `ReasoningEffort` names are Anthropic's own effort names, so
 *   they pass through unmapped.
 *
 * Forced tool choice survives both. `generateObject({ mode: "tool" })` always
 * sends `tool_choice: {type:"tool"}`, which is incompatible with *manual*
 * extended thinking ("Thinking may not be enabled when tool_choice forces tool
 * use") but explicitly supported with adaptive thinking — so dropping the
 * `thinking` option is what makes the forced call legal, and the tactical
 * agent's guarantee that every attempt forces the tool is untouched.
 */
export function anthropicBodyFor(
  spec: ModelSpec,
  body: Record<string, JsonValue>,
): Record<string, JsonValue> {
  // Destructuring the key away would leave an unused binding, which this
  // repo's ESLint config rejects even when it is `_`-prefixed.
  const rest: Record<string, JsonValue> = { ...body };
  delete rest.temperature;

  return {
    ...rest,
    ...(spec.reasoningEffort === undefined
      ? {}
      : { output_config: { effort: spec.reasoningEffort } }),
  };
}

/** Bind `anthropicBodyFor` to the one call the SDK is about to make. */
function anthropicFetch(spec: ModelSpec): typeof globalThis.fetch {
  return async (input, init) => {
    if (init === undefined || typeof init.body !== "string") {
      return globalThis.fetch(input, init);
    }
    const body = anthropicBodyFor(spec, JSON.parse(init.body) as Record<string, JsonValue>);
    return globalThis.fetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/**
 * Gemini's function-declaration schema has no representation for JSON
 * Schema's tuple form (`items` as an array of per-position schemas). Live
 * against `gemini-3.1-flash-lite`, it answers with a 400: "Proto field is
 * not repeating, cannot start list." `@ai-sdk/google@1.2.22` does not paper
 * over this — `convertJSONSchemaToOpenAPISchema` maps an array `items`
 * straight through — and `zod-to-json-schema` emits exactly that shape for
 * `Tile = z.tuple([z.number().int(), z.number().int()])`, used by
 * `ExecuteTurn.movement[].destinationTile` and `.mainAction.targetTile`.
 *
 * Collapsing to the first element's schema is safe here: every tuple this
 * repo's schemas define is homogeneous (`Tile` is two integers), so nothing
 * Gemini needs is lost — `minItems`/`maxItems` still constrain it to
 * exactly two, and the field's own name already carries the [x, y] order.
 */
export function collapseTupleItemsForGoogle(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(collapseTupleItemsForGoogle);
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([key, value]) => [
      key,
      key === "items" && Array.isArray(value)
        ? collapseTupleItemsForGoogle(value[0])
        : collapseTupleItemsForGoogle(value),
    ]),
  );
}

/**
 * The google-only detour around the tuple incompatibility above. Anthropic
 * and OpenAI accept tuple-style `items` fine, so this only ever runs for
 * `spec.provider === "google"` (see `generateStructured`) rather than
 * changing what `packages/schemas` hands every provider. It does not weaken
 * validation either: `validate` still parses with the same zod schema the
 * caller passed in, so a response is held to the exact same contract as
 * anthropic/openai — only the JSON Schema google is shown on the wire, to
 * describe the tool, is reshaped.
 */
function googleCompatibleSchema<T>(schema: ZodType<T>): Schema<T> {
  // `$refStrategy: "none"` fully inlines the schema instead of deduplicating
  // repeated subschemas behind a `$ref`. Default `zodToJsonSchema` turns the
  // second occurrence of a repeated schema — `Tile`, used by both
  // `destinationTile` and `targetTile` — into a JSON Pointer. Gemini's
  // function-declaration schema is not general JSON Schema; it has no `$ref`
  // support at all, confirmed live: with the tuple fix alone, every call
  // still failed as `provider_error`.
  const collapsed = collapseTupleItemsForGoogle(
    zodToJsonSchema(schema, { $refStrategy: "none" }),
  ) as Parameters<typeof jsonSchema>[0];
  return jsonSchema<T>(collapsed, {
    validate: (value) => {
      const result = schema.safeParse(value);
      return result.success
        ? { success: true, value: result.data }
        : { success: false, error: result.error };
    },
  });
}

export function resolveLanguageModel(spec: ModelSpec): LanguageModelV1 {
  switch (spec.provider) {
    case "anthropic":
      // A per-spec client, because the request rewrite depends on the spec's
      // effort. `createAnthropic` reads ANTHROPIC_API_KEY through a header
      // thunk, so building one here still touches no credential until a call
      // is actually made.
      return createAnthropic({ fetch: anthropicFetch(spec) })(spec.modelId);
    case "google":
      return google(spec.modelId);
    case "openai":
      // The default `openai(modelId)` factory targets Chat Completions, which
      // rejects function tools combined with `reasoning_effort` (confirmed
      // live: 400 "Function tools with reasoning_effort are not supported for
      // gpt-5.4-nano in /v1/chat/completions. To use function tools, use
      // /v1/responses..."). Every call this repo makes is a tool call
      // (`generateStructured`) with a reasoning effort set, so the Responses
      // API is used unconditionally rather than branching on a call shape
      // this function cannot see.
      return openai.responses(spec.modelId);
  }
}

function toCoreMessages(messages: readonly PromptMessage[]): CoreMessage[] {
  return messages.map((message) => {
    const providerOptions =
      message.providerOptions === undefined ? {} : { providerOptions: message.providerOptions };
    return message.role === "system"
      ? { role: "system", content: message.content, ...providerOptions }
      : { role: "user", content: message.content, ...providerOptions };
  });
}

function toUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}): TokenUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}

/**
 * Read through a function call deliberately. An inline `signal?.aborted ===
 * true` lets TypeScript narrow the guard at the top of a call to `false` for
 * the rest of the body — but a signal can fire *during* the await, which is
 * the whole point of the 10s turn budget.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/** Everything that is not a schema problem. Streaming shares this. */
function classifyProviderError(error: unknown, abortSignal?: AbortSignal): AdapterError {
  if (isAborted(abortSignal)) {
    return adapterFailure("aborted", "The call was aborted before it completed.", {
      cause: error,
    }).error;
  }
  if (APICallError.isInstance(error)) {
    return adapterFailure("provider_error", `Provider call failed: ${error.message}`, {
      cause: error,
    }).error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return adapterFailure("provider_error", `Provider call failed: ${message}`, { cause: error })
    .error;
}

/**
 * A tool call that does not match the schema and no tool call at all are
 * different problems with different fixes, so they get different codes even
 * though the SDK raises both as `NoObjectGeneratedError`.
 */
function typeValidationCauseOf(error: unknown): TypeValidationError | undefined {
  if (TypeValidationError.isInstance(error)) return error;
  if (NoObjectGeneratedError.isInstance(error) && TypeValidationError.isInstance(error.cause)) {
    return error.cause;
  }
  return undefined;
}

/**
 * Usage the SDK attached to a failure. `NoObjectGeneratedError` carries it for
 * both the no-tool-call and the schema-violation paths; `APICallError` does not,
 * which is correct — nothing was billed for output there.
 */
function usageFromError(error: unknown): TokenUsage | undefined {
  return NoObjectGeneratedError.isInstance(error) && error.usage !== undefined
    ? toUsage(error.usage)
    : undefined;
}

function schemaFailure<T>(
  schema: ZodType<T>,
  value: unknown,
  cause: unknown,
  usage: TokenUsage | undefined,
): AdapterResult<never> {
  const parsed = schema.safeParse(value);
  return adapterFailure(
    "schema_validation_failed",
    "The model's tool call did not match the tool schema.",
    {
      ...(parsed.success ? {} : { issues: parsed.error.issues }),
      cause,
      ...(usage === undefined ? {} : { usage }),
    },
  );
}

export interface VercelPortOptions {
  /** Override to inject a mock model. Defaults to the real provider clients. */
  resolveModel?: (spec: ModelSpec) => LanguageModelV1;
}

export function createVercelPort(options: VercelPortOptions = {}): LanguageModelPort {
  const resolveModel = options.resolveModel ?? resolveLanguageModel;

  return {
    async generateStructured<T>(
      spec: ModelSpec,
      request: StructuredRequest<T>,
    ): Promise<AdapterResult<StructuredOutput<T>>> {
      if (isAborted(request.abortSignal)) {
        return adapterFailure("aborted", "The turn budget was spent before the call started.");
      }

      try {
        const result = await generateObject({
          model: resolveModel(spec),
          mode: "tool",
          schema:
            spec.provider === "google" ? googleCompatibleSchema(request.schema) : request.schema,
          schemaName: request.toolName,
          schemaDescription: request.toolDescription,
          messages: toCoreMessages(assemblePrompt(request.prompt, spec.provider)),
          providerOptions: providerOptionsFor(spec),
          ...callSettingsFor(spec),
          ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
        });

        // No re-validation here: generateObject already parsed with this exact
        // zod schema, so a second safeParse can never fail. What we do own is
        // the failure path — turning the SDK's exception into zod issues the
        // step 7 retry can quote back (see schemaFailure).
        return adapterSuccess({ value: result.object, usage: toUsage(result.usage) });
      } catch (error) {
        if (isAborted(request.abortSignal)) {
          return adapterFailure("aborted", "The turn budget was spent mid-call.", { cause: error });
        }

        const validation = typeValidationCauseOf(error);
        if (validation !== undefined) {
          return schemaFailure(request.schema, validation.value, error, usageFromError(error));
        }

        if (NoObjectGeneratedError.isInstance(error)) {
          const usage = usageFromError(error);
          return adapterFailure("no_tool_call", "The model answered without calling the tool.", {
            cause: error,
            ...(usage === undefined ? {} : { usage }),
          });
        }

        return { ok: false, error: classifyProviderError(error, request.abortSignal) };
      }
    },

    async generateText(spec: ModelSpec, request: TextRequest): Promise<AdapterResult<TextOutput>> {
      if (isAborted(request.abortSignal)) {
        return adapterFailure("aborted", "The turn budget was spent before the call started.");
      }

      try {
        const result = await generateText({
          model: resolveModel(spec),
          messages: toCoreMessages(assemblePrompt(request.prompt, spec.provider)),
          providerOptions: providerOptionsFor(spec),
          ...callSettingsFor(spec),
          ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
        });

        return adapterSuccess({ text: result.text, usage: toUsage(result.usage) });
      } catch (error) {
        return { ok: false, error: classifyProviderError(error, request.abortSignal) };
      }
    },

    streamText(spec: ModelSpec, request: TextRequest): AsyncIterable<StreamChunk> {
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<StreamChunk> {
          if (isAborted(request.abortSignal)) {
            yield {
              type: "error",
              error: adapterFailure("aborted", "The turn budget was spent before the stream began.")
                .error,
            };
            return;
          }

          let text = "";
          try {
            const result = sdkStreamText({
              model: resolveModel(spec),
              messages: toCoreMessages(assemblePrompt(request.prompt, spec.provider)),
              providerOptions: providerOptionsFor(spec),
              ...callSettingsFor(spec),
              ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
            });

            for await (const part of result.fullStream) {
              if (part.type === "text-delta") {
                text += part.textDelta;
                yield { type: "text-delta", text: part.textDelta };
              } else if (part.type === "error") {
                // Stop here. After an error the stream is over, and a caller
                // reading the last chunk should find the failure, not a finish.
                yield {
                  type: "error",
                  error: classifyProviderError(part.error, request.abortSignal),
                };
                return;
              } else if (part.type === "finish") {
                yield { type: "finish", text, usage: toUsage(part.usage) };
              }
            }
          } catch (error) {
            yield { type: "error", error: classifyProviderError(error, request.abortSignal) };
          }
        },
      };
    },
  };
}
