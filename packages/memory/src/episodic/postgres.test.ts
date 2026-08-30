import { afterAll, describe, it } from "vitest";
import { runEpisodicStoreContract } from "./contract.js";
import { connectPostgresEpisodicStore } from "./postgres.js";

const databaseUrl = process.env["DATABASE_URL"];

// Skipped without a database, exactly as the event store's Postgres suite is.
// The number to hold green is the WITH-Postgres run: zero skipped.
if (databaseUrl === undefined) {
  describe.skip("EpisodicStore contract: postgres (no DATABASE_URL)", () => {
    it("is skipped", () => undefined);
  });
} else {
  const handle = connectPostgresEpisodicStore(databaseUrl);

  afterAll(async () => {
    await handle.close();
  });

  runEpisodicStoreContract("postgres", async () => {
    // Each contract case assumes an empty store; the suite reuses campaign
    // ids, so clear between them rather than relying on unique keys.
    await handle.truncate();
    return handle.store;
  });
}
