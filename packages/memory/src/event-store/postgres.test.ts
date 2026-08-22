import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { GameEvent } from "@ai-dm/schemas";
import { createPostgresEventStore } from "./postgres.js";
import { describeEventStoreContract } from "./contract.js";
import { EventStoreUnavailableError, SequenceConflictError } from "./port.js";
import { gameEvents } from "../schema.js";

const url = process.env.DATABASE_URL;

function eventFor(sessionId: string, sequence: number): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId,
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type: "player_input",
    payload: {},
  };
}

// Skipped without a database so `pnpm test` stays green on a machine with no
// Postgres. Task 9 adds the Postgres service and DATABASE_URL to
// .github/workflows/ci.yml; until that lands these skip in CI too, so a green
// CI run says nothing about the Postgres store.
describe.skipIf(url === undefined)("postgres EventStore", () => {
  // Non-null narrowing rather than `!`: ESLint bans the assertion, and
  // skipIf does not narrow the type for the compiler.
  const connectionString = url ?? "";
  const sql = postgres(connectionString);
  const db = drizzle(sql);
  const store = createPostgresEventStore(db);

  afterAll(async () => {
    await sql.end();
  });

  // One store instance across every case: the contract suite mints a unique
  // session id per case, which is what keeps them isolated on a shared table
  // and lets them run in parallel without truncation.
  describeEventStoreContract("contract", () => store);

  it("reports the conflicting sequence, not a guess", async () => {
    const sessionId = `pg-detail-${String(Date.now())}`;
    await store.append(sessionId, [eventFor(sessionId, 0), eventFor(sessionId, 1)]);

    // The batch's head is 5, but the one that actually conflicts is 0 — a
    // store that reported the head would put a wrong number in a public
    // field that reaches the client.
    await expect(
      store.append(sessionId, [eventFor(sessionId, 5), eventFor(sessionId, 0)]),
    ).rejects.toMatchObject({
      name: "SequenceConflictError",
      sequence: 0,
    });
  });

  it("surfaces SQLSTATE 23505 on the error the driver rethrows", async () => {
    // Pins the driver contract `append`'s classification depends on. A
    // drizzle upgrade that wraps driver errors (later majors raise
    // DrizzleQueryError) would make `errorCode()` return undefined and
    // silently downgrade every lost race from SequenceConflictError to
    // EventStoreUnavailableError. Deterministic — no pre-check is involved
    // and no concurrency is required, because the insert goes straight at
    // the primary key.
    const sessionId = `pg-sqlstate-${String(Date.now())}`;
    const row = {
      sessionId,
      sequence: 0,
      eventId: "00000000-0000-4000-8000-000000000000",
      timestamp: "2026-08-19T10:00:00.000Z",
      type: "player_input",
      payload: {},
    };
    await db.insert(gameEvents).values(row);
    await expect(db.insert(gameEvents).values(row)).rejects.toMatchObject({ code: "23505" });
  });
});

function driverError(code: string): Error {
  // Shaped like postgres-js's PostgresError: a real Error that carries the
  // SQLSTATE on `.code`, which is what `errorCode()` reads.
  return Object.assign(new Error(`driver failure ${code}`), { code });
}

/**
 * A `db` that fails the way a lost insert race does. The unit under test is
 * `append`'s error classification, not SQL, so the stub is the subject rather
 * than a stand-in for one — which is also why these cases sit outside the
 * skipIf block and run with no database at all.
 *
 * A concurrency test would be the wrong tool here: on a runner where the
 * winner commits before the loser's pre-check reads, the race resolves down
 * the pre-check path and the test passes without ever entering the branch —
 * a coverage gap dressed as a green.
 */
function stubDb(options: {
  transactionError: Error;
  taken?: readonly number[];
  rereadFails?: boolean;
}): PostgresJsDatabase {
  const stub = {
    transaction: () => Promise.reject(options.transactionError),
    select: () => ({
      from: () => ({
        where: () =>
          options.rereadFails === true
            ? Promise.reject(new Error("CONNECTION_CLOSED"))
            : Promise.resolve((options.taken ?? []).map((sequence) => ({ sequence }))),
      }),
    }),
  };
  return stub as unknown as PostgresJsDatabase;
}

describe("postgres EventStore — lost-race classification", () => {
  const sessionId = "stub-session";
  // Head is 5, collision is at 0: a store that reported the head would
  // satisfy every other assertion here and still be wrong.
  const batch = [eventFor(sessionId, 5), eventFor(sessionId, 0)];

  it("re-derives the sequence that actually conflicted, not the batch head", async () => {
    const store = createPostgresEventStore(
      stubDb({ transactionError: driverError("23505"), taken: [0] }),
    );
    const error: unknown = await store.append(sessionId, batch).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SequenceConflictError);
    expect(error).toMatchObject({ sequence: 0 });
  });

  it("falls back to EventStoreUnavailableError when the re-read explains nothing", async () => {
    // 23505 was raised, but by the time the log is re-read nothing is taken
    // — the winner rolled back. There is no conflict to report, so the
    // honest answer is "unavailable" rather than a fabricated sequence.
    const store = createPostgresEventStore(
      stubDb({ transactionError: driverError("23505"), taken: [] }),
    );
    await expect(store.append(sessionId, batch)).rejects.toBeInstanceOf(EventStoreUnavailableError);
  });

  it("wraps a driver failure that is not a unique violation", async () => {
    // 57014 is statement_timeout: a real SQLSTATE, but not a conflict.
    const store = createPostgresEventStore(stubDb({ transactionError: driverError("57014") }));
    await expect(store.append(sessionId, batch)).rejects.toBeInstanceOf(EventStoreUnavailableError);
  });

  it("stays inside the three-class surface when the re-read itself fails", async () => {
    // The re-read is a second round trip on the outer pool, taken under
    // exactly the conditions that just cost this writer the race. Its
    // rejection must not escape `append` raw — Task 7 branches on three
    // classes and anything else reaches a catch-all that restores no player
    // affordances.
    const store = createPostgresEventStore(
      stubDb({ transactionError: driverError("23505"), taken: [0], rereadFails: true }),
    );
    await expect(store.append(sessionId, batch)).rejects.toBeInstanceOf(EventStoreUnavailableError);
  });
});
