// The one place the AI SDK's embedding surface is touched, mirroring
// `vercel.ts`'s role for the chat surface. Kept in its own file rather than
// added to `vercel.ts` because it shares no request shaping with it — no
// `LayeredPrompt`, no tool schema, no streaming.
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { adapterFailure, adapterSuccess } from "./errors.js";
import type { AdapterResult } from "./errors.js";
import type { EmbeddingOutput, EmbeddingPort, EmbeddingSpec } from "./embedding-port.js";

export interface VercelEmbeddingOptions {
  /** Falls back to the provider SDK's own env lookup when absent. */
  apiKey?: string;
}

export function createVercelEmbeddingPort(options: VercelEmbeddingOptions = {}): EmbeddingPort {
  const openai = createOpenAI(options.apiKey === undefined ? {} : { apiKey: options.apiKey });

  return {
    async embed(
      spec: EmbeddingSpec,
      texts: readonly string[],
    ): Promise<AdapterResult<EmbeddingOutput>> {
      // `embedMany` with no values is a provider round trip that cannot
      // succeed usefully; refuse it here so callers get one failure shape.
      if (texts.length === 0) {
        return adapterFailure("provider_error", "No texts to embed");
      }
      // Only openai is wired for embeddings today. A different provider is a
      // deliberate change here, not a silent fallthrough to the wrong model.
      if (spec.provider !== "openai") {
        return adapterFailure(
          "provider_error",
          `No embedding adapter for provider ${spec.provider}`,
        );
      }

      try {
        const result = await embedMany({
          model: openai.textEmbeddingModel(spec.modelId, { dimensions: spec.dimensions }),
          values: [...texts],
        });

        // The width the column expects is not negotiable — a provider that
        // honours `dimensions` differently must fail here, not at INSERT.
        const wrong = result.embeddings.find((vector) => vector.length !== spec.dimensions);
        if (wrong !== undefined) {
          return adapterFailure(
            "provider_error",
            `Expected ${String(spec.dimensions)}-dimension vectors, got ${String(wrong.length)}`,
          );
        }

        return adapterSuccess({
          vectors: result.embeddings.map((vector) => [...vector]),
          usage: {
            promptTokens: result.usage.tokens,
            completionTokens: 0,
            totalTokens: result.usage.tokens,
          },
        });
      } catch (cause) {
        return adapterFailure(
          "provider_error",
          cause instanceof Error ? cause.message : "Embedding call failed",
          { cause },
        );
      }
    },
  };
}
