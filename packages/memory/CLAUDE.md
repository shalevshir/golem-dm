# @ai-dm/memory

## Purpose & boundary

Persistence layer, on **one Postgres instance** (image `pgvector/pgvector:pg17`) — do not introduce Pinecone/Redis without an ADR. **Built and live:** the append-only event log (`game_events`, `campaign_snapshots`), behind two implementations (in-memory, Postgres) that both answer to one conformance suite. **Planned, not built:** durable world state (entities, factions, quest DAG) and episodic memory (pgvector embeddings of scene summaries) — see the Stack bullets below for what's blocking each. The one-Postgres-instance design is so that, once built, memories and world state stay transactionally consistent with the event log.

**Boundary:** the only package that talks to the database. World-state writes happen ONLY by applying validated `GameEvent`s (state is a projection). No LLM calls except embedding generation for episodic writes. Depends only on `@ai-dm/schemas`.

## Stack

- drizzle-orm + `postgres` driver; migrations via drizzle-kit (checked into `drizzle/`).
- Tables (snake_case): `game_events` (append-only, composite PK `(campaign_id, sequence)`), `campaign_snapshots`. Planned, not yet built: `entities`, `faction_relations`, `quest_nodes` (deferred past step 10 — a campaign concept exists now, but the world content and scene engine that would populate them are still ahead, `PROJECT_PLAN.md` §4.7 sequence steps 2–3) and `episodic_memories (embedding vector)` (spec #2).
- Episodic memory design constraint, once built (spec #2, not yet designed): embed scene **summaries**, not raw turns; retrieval by cosine top-k, filtered by campaign. No embedding calls happen today — there is no episodic write path.

## Rules

- `game_events` is append-only: no UPDATE or DELETE, ever. Corrections are new events.
- Every projection must be rebuildable by replaying events from the last snapshot — write a replay test for each new projection.
- Schema changes only via generated migrations; never edit applied migrations.
- Both stores answer to one conformance suite (`src/event-store/contract.ts`). A behaviour only one of them has is a bug in the contract, not a feature — add it to the suite or remove it.

## Testing

Vitest against a throwaway Postgres (docker compose in `apps/server/`). Two distinct suites today: the shared `EventStore` conformance suite (`src/event-store/contract.ts`), run against both the in-memory and Postgres implementations; and the append→replay→identical-projection round-trip (`src/event-store/replay.test.ts`), Postgres-only and skipped without `DATABASE_URL` — this file proves the fold identity for a bracket-free log, and that a bracket's own two event types round-trip through Postgres unchanged, but not that a bracket folds correctly: that needs the encounter catalogue, which lives in `apps/server` and which this package may never import (invariant 5), so the cross-bracket projection round-trip (`loadCampaign` across two encounters) lives in `apps/server/src/core/replay.test.ts` instead. Once episodic memory is built (spec #2): vector search returns a seeded fixture in top-k.

## Commands

```bash
docker compose -f ../../apps/server/docker-compose.yml up -d
pnpm --filter @ai-dm/memory db:generate | db:migrate | test | typecheck
```
