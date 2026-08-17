// The Vercel AI SDK implementation of `LanguageModelPort`. The ONLY file in
// this package that imports the SDK — everything else depends on the port, so
// swapping SDKs or adding a provider touches one file.
//
// `resolveModel` is the test seam: injecting `MockLanguageModelV1` exercises
// this whole file with no network and no API keys.
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { CoreMessage, LanguageModelV1 } from "ai";
import {
  APICallError,
  NoObjectGeneratedError,
  TypeValidationError,
  generateObject,
  generateText,
  streamText as sdkStreamText,
} from "ai";
import type { ZodType } from "zod";
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
import type { ModelSpec, ReasoningEffort } from "./routing.js";

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

/** Translate the spec's neutral names into AI SDK v4 call settings. */
export function callSettingsFor(spec: ModelSpec): SdkCallSettings {
  return {
    ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
    // v4 calls this maxTokens; v5 renamed it maxOutputTokens. Ours is the
    // unambiguous name and this is where it gets translated.
    ...(spec.maxOutputTokens === undefined ? {} : { maxTokens: spec.maxOutputTokens }),
  };
}

/** Encode a neutral reasoning effort the way each provider expects it. */
export function providerOptionsFor(spec: ModelSpec): ProviderOptionsMap {
  const options: ProviderOptionsMap = {};
  const effort = spec.reasoningEffort;

  if (effort !== undefined) {
    switch (spec.provider) {
      case "openai":
        options.openai = { reasoningEffort: effort };
        break;
      case "anthropic":
        options.anthropic = {
          thinking:
            effort === "low"
              ? { type: "disabled" }
              : { type: "enabled", budgetTokens: REASONING_BUDGET_TOKENS[effort] },
        };
        break;
      case "google":
        options.google = { thinkingConfig: { thinkingBudget: REASONING_BUDGET_TOKENS[effort] } };
        break;
    }
  }

  // Explicit provider options win — that is what the escape hatch is for.
  for (const [provider, overrides] of Object.entries(spec.providerOptions ?? {})) {
    options[provider] = { ...options[provider], ...overrides };
  }

  return options;
}

export function resolveLanguageModel(spec: ModelSpec): LanguageModelV1 {
  switch (spec.provider) {
    case "anthropic":
      return anthropic(spec.modelId);
    case "google":
      return google(spec.modelId);
    case "openai":
      return openai(spec.modelId);
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

function toUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): TokenUsage {
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

function schemaFailure<T>(schema: ZodType<T>, value: unknown, cause: unknown): AdapterResult<never> {
  const parsed = schema.safeParse(value);
  return adapterFailure(
    "schema_validation_failed",
    "The model's tool call did not match the tool schema.",
    {
      ...(parsed.success ? {} : { issues: parsed.error.issues }),
      cause,
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
          schema: request.schema,
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
          return schemaFailure(request.schema, validation.value, error);
        }

        if (NoObjectGeneratedError.isInstance(error)) {
          return adapterFailure(
            "no_tool_call",
            "The model answered without calling the tool.",
            { cause: error },
          );
        }

        return { ok: false, error: classifyProviderError(error, request.abortSignal) };
      }
    },

    async generateText(
      spec: ModelSpec,
      request: TextRequest,
    ): Promise<AdapterResult<TextOutput>> {
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
                yield { type: "error", error: classifyProviderError(part.error, request.abortSignal) };
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
