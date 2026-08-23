import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The generated migration is what CI actually applies, so it — not the DSL —
// is what these assertions read. A regenerated migration that quietly drops
// the composite primary key would take the conflict semantics with it.
const drizzleDir = join(import.meta.dirname, "..", "drizzle");

function migrationSql(): string {
  const files = readdirSync(drizzleDir).filter((name) => name.endsWith(".sql"));
  return files.map((name) => readFileSync(join(drizzleDir, name), "utf8")).join("\n");
}

describe("generated migration", () => {
  it("creates both tables", () => {
    const sql = migrationSql();
    expect(sql).toContain(`CREATE TABLE "game_events"`);
    expect(sql).toContain(`CREATE TABLE "campaign_snapshots"`);
  });

  it("gives game_events a composite primary key on (campaign_id, sequence)", () => {
    // This is the conflict semantics: it is what makes a duplicate sequence
    // — including one inside a single multi-row INSERT — a 23505.
    expect(migrationSql()).toContain(`PRIMARY KEY("campaign_id","sequence")`);
  });

  it("stores event_id and timestamp as text", () => {
    const sql = migrationSql();
    // Both deliberately not their "natural" PG types: uuid normalizes case
    // and timestamptz truncates sub-millisecond precision, either of which
    // would diverge from the in-memory store.
    expect(sql).toMatch(/"event_id" text NOT NULL/);
    expect(sql).toMatch(/"timestamp" text NOT NULL/);
  });

  it("stores payload and state as jsonb", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/"payload" jsonb NOT NULL/);
    expect(sql).toMatch(/"state" jsonb NOT NULL/);
  });
});
