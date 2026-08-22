import { and, asc, eq, gt, inArray, lt, sql as raw } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// One import, not two: `@ai-dm/schemas` exports `GameEvent` as both the zod
// schema (used here as `GameEvent.parse`) and the inferred type, and a single
// named import brings both.
import { GameEvent, SessionState } from "@ai-dm/schemas";
import { EventStoreUnavailableError, SequenceConflictError, SessionMismatchError } from "./port.js";
import type { EventSnapshot, EventStore } from "./port.js";
import { gameEvents, sessionSnapshots } from "../schema.js";
import { findAppendConflict } from "./validate.js";

/** Postgres' unique_violation. `game_events` has exactly one unique
 * constraint — its primary key — so on that table this can only ever mean a
 * sequence collision. Keying on the SQLSTATE avoids both a constraint-name
 * literal that must track drizzle's naming and the localized `detail` string,
 * which is emitted in the server's `lc_messages` and suppressed outright when
 * the role lacks column privileges. */
const UNIQUE_VIOLATION = "23505";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function toGameEvent(row: typeof gameEvents.$inferSelect): GameEvent {
  // Parsed, not cast: a row written under an older shape must fail loudly
  // here rather than flow into `fold` as an untyped object. `createdAt` is
  // deliberately not passed — it is operational, not part of the event.
  return GameEvent.parse({
    eventId: row.eventId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    timestamp: row.timestamp,
    type: row.type,
    payload: row.payload,
  });
}

function toRow(event: GameEvent): typeof gameEvents.$inferInsert {
  return {
    sessionId: event.sessionId,
    sequence: event.sequence,
    eventId: event.eventId,
    timestamp: event.timestamp,
    type: event.type,
    payload: event.payload,
  };
}

export function createPostgresEventStore(db: PostgresJsDatabase): EventStore {
  async function takenSequences(
    executor: PostgresJsDatabase,
    sessionId: string,
    sequences: readonly number[],
  ): Promise<Set<number>> {
    const rows = await executor
      .select({ sequence: gameEvents.sequence })
      .from(gameEvents)
      .where(
        and(eq(gameEvents.sessionId, sessionId), inArray(gameEvents.sequence, [...sequences])),
      );
    return new Set(rows.map((row) => row.sequence));
  }

  /**
   * Turns a lost insert race into the same error the pre-check would have
   * produced, by reading the log again now that the winner has committed.
   * Runs outside the failed transaction, which is aborted.
   */
  async function deriveConflict(
    sessionId: string,
    events: readonly GameEvent[],
    cause: unknown,
  ): Promise<Error> {
    const taken = await takenSequences(
      db,
      sessionId,
      events.map((each) => each.sequence),
    );
    return (
      findAppendConflict(sessionId, events, taken) ??
      new EventStoreUnavailableError("append", cause)
    );
  }

  return {
    async append(sessionId, events) {
      // Nothing to do, and nothing to open a transaction for.
      if (events.length === 0) return;
      const sequences = events.map((each) => each.sequence);

      try {
        await db.transaction(async (tx) => {
          // Every query in here must use `tx`, never the outer `db`: the
          // latter takes a different pooled connection and would deadlock
          // against this transaction's own uncommitted insert.
          const taken = await takenSequences(tx, sessionId, sequences);
          const conflict = findAppendConflict(sessionId, events, taken);
          // Thrown, not returned — the throw is what rolls the transaction
          // back, which is what makes "a rejection leaves the store exactly
          // as it was" true.
          if (conflict !== null) throw conflict;
          await tx.insert(gameEvents).values(events.map(toRow));
        });
      } catch (error) {
        if (error instanceof SequenceConflictError || error instanceof SessionMismatchError) {
          throw error;
        }
        if (errorCode(error) === UNIQUE_VIOLATION) {
          throw await deriveConflict(sessionId, events, error);
        }
        throw new EventStoreUnavailableError("append", error);
      }
    },

    async readSince(sessionId, afterSequence) {
      try {
        const rows = await db
          .select()
          .from(gameEvents)
          .where(and(eq(gameEvents.sessionId, sessionId), gt(gameEvents.sequence, afterSequence)))
          .orderBy(asc(gameEvents.sequence));
        return rows.map(toGameEvent);
      } catch (error) {
        // Covers a ZodError from `toGameEvent` as well as any driver
        // failure: both leave the caller unable to read the log, and
        // `pipeline.ts` needs one class to branch on.
        throw new EventStoreUnavailableError("readSince", error);
      }
    },

    async latestSnapshot(sessionId): Promise<EventSnapshot | null> {
      try {
        const rows = await db
          .select()
          .from(sessionSnapshots)
          .where(eq(sessionSnapshots.sessionId, sessionId))
          .limit(1);
        const row = rows[0];
        if (row === undefined) return null;
        return { sequence: row.sequence, state: SessionState.parse(row.state) };
      } catch (error) {
        throw new EventStoreUnavailableError("latestSnapshot", error);
      }
    },

    async putSnapshot(sessionId, sequence, state) {
      try {
        await db
          .insert(sessionSnapshots)
          .values({ sessionId, sequence, state })
          .onConflictDoUpdate({
            target: sessionSnapshots.sessionId,
            set: { sequence, state, updatedAt: raw`now()` },
            // Makes a stale *or equal* sequence a silent no-op rather than an
            // error, matching the in-memory store's `snapshot.sequence <
            // sequence` guard exactly. A false predicate skips the row; it
            // does not raise.
            setWhere: lt(sessionSnapshots.sequence, sequence),
          });
      } catch (error) {
        throw new EventStoreUnavailableError("putSnapshot", error);
      }
    },
  };
}

export interface PostgresEventStoreHandle {
  store: EventStore;
  /** A trivial query, so a bad URL fails at boot rather than on the first
   * player's first turn. */
  probe(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens the connection and builds a store on it. This exists so `drizzle-orm`
 * and `postgres` stay out of `apps/server`'s dependency list —
 * `packages/memory/CLAUDE.md` scopes this package as the only one that talks
 * to the database, and a server importing the driver directly would make that
 * false.
 */
export function connectPostgresEventStore(url: string): PostgresEventStoreHandle {
  const sql = postgres(url);
  const db = drizzle(sql);
  return {
    store: createPostgresEventStore(db),
    async probe() {
      await sql`select 1`;
    },
    async close() {
      await sql.end();
    },
  };
}
