// The embedding boundary. Deliberately NOT a fourth method on
// `LanguageModelPort`: that port's three methods all take prompt-shaped
// requests (a `LayeredPrompt`, a tool name, a tool description), two of
// `AdapterErrorCode`'s four values cannot occur for an embedding, and
// `StreamChunk` has no embedding-shaped case. Adding a method there would
// break both implementers for no shared behaviour.
//
// `@ai-dm/memory` never sees this type. The store takes vectors; the
// composition root (`apps/server`) embeds and then writes, which is what
// keeps memory's dependency list at `@ai-dm/schemas` alone (invariant 5).
import type { ProviderId } from "./routing.js";
import type { TokenUsage } from "./usage.js";
import type { AdapterResult } from "./errors.js";

export interface EmbeddingSpec {
  provider: ProviderId;
  modelId: string;
  /**
   * Must equal `EMBEDDING_DIMENSIONS`. The pgvector column is fixed-width, so
   * a mismatch is an insert failure rather than a degraded result.
   */
  dimensions: number;
}

export interface EmbeddingOutput {
  /** One vector per input text, in input order. */
  vectors: number[][];
  /**
   * The AI SDK reports `EmbeddingModelUsage` as `{ tokens }` — a single
   * count. It maps onto the shared `TokenUsage` as prompt-only:
   * `completionTokens: 0` is truthful, not a placeholder, because an
   * embedding call bills input alone.
   */
  usage: TokenUsage;
}

export interface EmbeddingPort {
  embed(spec: EmbeddingSpec, texts: readonly string[]): Promise<AdapterResult<EmbeddingOutput>>;
}
