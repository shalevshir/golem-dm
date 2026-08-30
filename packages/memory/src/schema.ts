// The schema's single source. `drizzle-kit generate` diffs this file against
// the snapshots in `drizzle/meta` to produce the migration SQL — the SQL is
// output, never hand-edited (packages/memory/CLAUDE.md: "Schema changes only
// via generated migrations").
import { integer, jsonb, pgTable, primaryKey, text, timestamp, vector } from "drizzle-orm/pg-core";
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import type { CampaignState } from "@ai-dm/schemas";

export const gameEvents = pgTable(
  "game_events",
  {
    campaignId: text("campaign_id").notNull(),
    sequence: integer("sequence").notNull(),
    // `text`, not `uuid`: `z.string().uuid()` is case-insensitive while
    // Postgres's uuid type normalizes to lowercase, so an uppercase eventId
    // would come back changed from one store and unchanged from the other.
    eventId: text("event_id").notNull(),
    // `text`, not `timestamptz`: `z.string().datetime()` accepts arbitrary
    // sub-second precision, which a round trip through timestamptz and a JS
    // Date truncates to milliseconds. Ordering is by `sequence`, never by
    // time, so the column has no query duty to justify that.
    timestamp: text("timestamp").notNull(),
    // `text`, not a PG enum: the zod enum is the authority (invariant 4), and
    // an enum here would mean a migration per new event type.
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // Operational only — when the row actually landed, as opposed to the
    // event's own claimed timestamp.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The conflict semantics. Because it is one constraint, a duplicate within
  // a single multi-row INSERT violates it too.
  (table) => [primaryKey({ columns: [table.campaignId, table.sequence] })],
);

export const campaignSnapshots = pgTable("campaign_snapshots", {
  campaignId: text("campaign_id").primaryKey(),
  sequence: integer("sequence").notNull(),
  state: jsonb("state").$type<CampaignState>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The episodic index. A cache over the log in exactly the sense
 * `campaign_snapshots` is: every row's `summary_english` also sits in the
 * event that produced it, so this table is rebuildable and never authority.
 *
 * The primary key is the event log's own `(campaign_id, sequence)`, which is
 * what makes `write` idempotent and a reindex a no-op.
 */
export const episodicMemories = pgTable(
  "episodic_memories",
  {
    campaignId: text("campaign_id").notNull(),
    sequence: integer("sequence").notNull(),
    // `text`, not a PG enum, for the reason `game_events.type` gives: the zod
    // enum is the authority (invariant 4) and an enum here is a migration per
    // new kind.
    kind: text("kind").notNull(),
    refId: text("ref_id").notNull(),
    summaryEnglish: text("summary_english").notNull(),
    day: integer("day").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.sequence] })],
);
