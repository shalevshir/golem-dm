// Episodic memory's storage boundary.
//
// The store takes VECTORS, never text to embed. That is the whole reason
// this package still depends only on `@ai-dm/schemas`: an embedding adapter
// lives in `@ai-dm/agents`, which this package may not import (invariant 5),
// so the composition root embeds first and writes second. There is no
// embedding port here to reach for, by design.
//
// The table this backs is a rebuildable INDEX, never authority. Every fact
// it holds also sits in the event log as a closing event's `summaryEnglish`,
// so losing it costs retrieval quality until a reindex and costs correctness
// nothing (invariant 3).
import type { EpisodicMemory } from "@ai-dm/schemas";

/** A retrieved memory and its cosine similarity in [-1, 1]; 1 is identical. */
export interface EpisodicHit {
  memory: EpisodicMemory;
  score: number;
}

/**
 * Mirrors `EventStoreUnavailableError`: every way a durable store can fail
 * that is not a caller error. The in-memory store never raises it, which the
 * shared contract permits rather than requires.
 */
export class EpisodicStoreUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(`Episodic store unavailable during ${operation}`, { cause });
    this.name = "EpisodicStoreUnavailableError";
    this.operation = operation;
  }
}

export interface EpisodicStore {
  /**
   * Idempotent on `(campaignId, sequence)` — the same key the event log uses.
   * Re-indexing a log that has already been indexed rewrites the same rows,
   * so a rebuild needs no delete pass and no ordering.
   *
   * `embedding` must have exactly `EMBEDDING_DIMENSIONS` entries.
   */
  write(record: EpisodicMemory, embedding: readonly number[]): Promise<void>;

  /**
   * The `limit` nearest memories in this campaign by cosine similarity,
   * highest score first. Always filtered by `campaignId` — no query crosses
   * campaigns (ADR-0004). A `limit` of zero returns an empty list.
   */
  search(
    campaignId: string,
    queryEmbedding: readonly number[],
    limit: number,
  ): Promise<EpisodicHit[]>;
}
