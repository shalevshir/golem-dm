// The no-database implementation, so `pnpm test` and `pnpm dev` work without
// docker — the same bargain `event-store/in-memory.ts` strikes.
//
// Cosine is written out by hand rather than imported: `ai` exports a
// `cosineSimilarity`, but this package may not depend on `@ai-dm/agents` or
// the SDK beneath it (invariant 5). It is five lines.
import type { EpisodicMemory } from "@ai-dm/schemas";
import type { EpisodicHit, EpisodicStore } from "./port.js";

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  // A zero vector has no direction, so it is similar to nothing.
  return denominator === 0 ? 0 : dot / denominator;
}

interface Row {
  memory: EpisodicMemory;
  embedding: readonly number[];
}

export function createInMemoryEpisodicStore(): EpisodicStore {
  // Keyed exactly like the Postgres primary key, which is what makes `write`
  // idempotent without a separate existence check.
  const rows = new Map<string, Row>();

  return {
    write(record: EpisodicMemory, embedding: readonly number[]): Promise<void> {
      rows.set(JSON.stringify([record.campaignId, record.sequence]), {
        // Stored by value: the caller may mutate what it passed.
        memory: { ...record },
        embedding: [...embedding],
      });
      return Promise.resolve();
    },

    search(
      campaignId: string,
      queryEmbedding: readonly number[],
      limit: number,
    ): Promise<EpisodicHit[]> {
      if (limit <= 0) return Promise.resolve([]);

      const hits = [...rows.values()]
        .filter((row) => row.memory.campaignId === campaignId)
        .map((row) => ({ memory: { ...row.memory }, score: cosine(queryEmbedding, row.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return Promise.resolve(hits);
    },
  };
}
