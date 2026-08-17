// The seam every agent depends on. Three call shapes, and nothing else:
// structured output for the tactical agent's tool call, plain completion for
// the intent router, and token streaming for Hebrew narration.
//
// The port takes a resolved `ModelSpec` and knows nothing about roles — that
// is `runtime.ts`'s job. Keeping them apart means routing is testable without
// a provider, and a provider is testable without any notion of roles.
import type { ZodType } from "zod";
import type { AdapterError, AdapterResult } from "./errors.js";
import type { LayeredPrompt } from "./prompt.js";
import type { ModelSpec } from "./routing.js";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TextRequest {
  prompt: LayeredPrompt;
  /** Enforces the 10s turn budget from PROJECT_PLAN.md section 3. */
  abortSignal?: AbortSignal;
}

export interface StructuredRequest<T> extends TextRequest {
  /** The single source of truth for the shape. Never a hand-written schema. */
  schema: ZodType<T>;
  toolName: string;
  toolDescription: string;
}

export interface TextOutput {
  text: string;
  usage: TokenUsage;
}

export interface StructuredOutput<T> {
  value: T;
  usage: TokenUsage;
}

/**
 * Streams carry failure in-band. A stream can die after its third token, so
 * there is no result to return up front, and throwing into an async iterator
 * forces every consumer into a try/catch around a for-await. One switch
 * handles all three cases instead.
 */
export type StreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "finish"; text: string; usage: TokenUsage }
  | { type: "error"; error: AdapterError };

export interface LanguageModelPort {
  generateStructured<T>(
    spec: ModelSpec,
    request: StructuredRequest<T>,
  ): Promise<AdapterResult<StructuredOutput<T>>>;

  generateText(spec: ModelSpec, request: TextRequest): Promise<AdapterResult<TextOutput>>;

  streamText(spec: ModelSpec, request: TextRequest): AsyncIterable<StreamChunk>;
}
