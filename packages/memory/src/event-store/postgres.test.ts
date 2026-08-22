import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPostgresEventStore } from "./postgres.js";
import { describeEventStoreContract } from "./contract.js";

const url = process.env.DATABASE_URL;

// Skipped without a database so `pnpm test` stays green on a machine with no
// docker running. CI sets DATABASE_URL, so these do run on every push — see
// .github/workflows/ci.yml.
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
    const event = (sequence: number) => ({
      eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      sessionId,
      sequence,
      timestamp: "2026-08-19T10:00:00.000Z",
      type: "player_input" as const,
      payload: {},
    });
    await store.append(sessionId, [event(0), event(1)]);

    // The batch's lowest sequence is 1, but the one that actually conflicts
    // is 0 — a store that reported the batch head would put a wrong number
    // in a public field that reaches the client.
    await expect(store.append(sessionId, [event(5), event(0)])).rejects.toMatchObject({
      name: "SequenceConflictError",
      sequence: 0,
    });
  });
});
