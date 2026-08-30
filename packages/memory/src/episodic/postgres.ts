// The durable episodic index. Follows `event-store/postgres.ts`'s shape: a
// connect function returning a handle that owns the connection, so the
// caller closes what it opened.
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { EpisodicMemory } from "@ai-dm/schemas";
import { episodicMemories } from "../schema.js";
import { EpisodicStoreUnavailableError } from "./port.js";
import type { EpisodicHit, EpisodicStore } from "./port.js";

export interface PostgresEpisodicStoreHandle {
  store: EpisodicStore;
  close(): Promise<void>;
  /** Test support: empties the table. Never called in production. */
  truncate(): Promise<void>;
}

export function connectPostgresEpisodicStore(databaseUrl: string): PostgresEpisodicStoreHandle {
  const client = postgres(databaseUrl);
  const db = drizzle(client);

  const store: EpisodicStore = {
    async write(record: EpisodicMemory, embedding: readonly number[]): Promise<void> {
      try {
        await db
          .insert(episodicMemories)
          .values({
            campaignId: record.campaignId,
            sequence: record.sequence,
            kind: record.kind,
            refId: record.refId,
            summaryEnglish: record.summaryEnglish,
            day: record.day,
            embedding: [...embedding],
          })
          // Idempotent by primary key: re-indexing a replayed log rewrites
          // the same row rather than erroring or duplicating.
          .onConflictDoUpdate({
            target: [episodicMemories.campaignId, episodicMemories.sequence],
            set: {
              kind: record.kind,
              refId: record.refId,
              summaryEnglish: record.summaryEnglish,
              day: record.day,
              embedding: [...embedding],
            },
          });
      } catch (cause) {
        throw new EpisodicStoreUnavailableError("write", cause);
      }
    },

    async search(
      campaignId: string,
      queryEmbedding: readonly number[],
      limit: number,
    ): Promise<EpisodicHit[]> {
      if (limit <= 0) return [];

      try {
        // `<=>` is pgvector's cosine DISTANCE (0 identical, 2 opposite), so
        // similarity is 1 - distance. Ordering ascending by distance is
        // ordering descending by similarity, which is what the contract asks.
        const distance = sql<number>`${episodicMemories.embedding} <=> ${JSON.stringify([...queryEmbedding])}::vector`;

        const rows = await db
          .select({
            campaignId: episodicMemories.campaignId,
            sequence: episodicMemories.sequence,
            kind: episodicMemories.kind,
            refId: episodicMemories.refId,
            summaryEnglish: episodicMemories.summaryEnglish,
            day: episodicMemories.day,
            distance,
          })
          .from(episodicMemories)
          .where(eq(episodicMemories.campaignId, campaignId))
          .orderBy(distance)
          .limit(limit);

        return rows.map((row) => ({
          // Parsed, not cast: a stored row that no longer matches the schema
          // is a store failure, the same stance `event-store/validate.ts` takes.
          memory: EpisodicMemory.parse({
            campaignId: row.campaignId,
            sequence: row.sequence,
            kind: row.kind,
            refId: row.refId,
            summaryEnglish: row.summaryEnglish,
            day: row.day,
          }),
          // `sql<number>` above already types this as `number`, and
          // postgres.js parses pgvector's float8 distance as a JS number at
          // runtime, so no conversion is needed here.
          score: 1 - row.distance,
        }));
      } catch (cause) {
        throw new EpisodicStoreUnavailableError("search", cause);
      }
    },
  };

  return {
    store,
    async close(): Promise<void> {
      await client.end();
    },
    async truncate(): Promise<void> {
      await db.delete(episodicMemories);
    },
  };
}
