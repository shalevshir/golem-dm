# @ai-dm/memory

## Purpose & boundary

Persistence layer, on **one Postgres instance** (image `pgvector/pgvector:pg17`) — do not introduce Pinecone/Redis without an ADR. **Built and live:** the append-only event log (`game_events`, `session_snapshots`), behind two implementations (in-memory, Postgres) that both answer to one conformance suite. **Planned, not built:** durable world state (entities, factions, quest DAG) and episodic memory (pgvector embeddings of scene summaries) — see the Stack bullets below for what's blocking each. The one-Postgres-instance design is so that, once built, memories and world state stay transactionally consistent with the event log.

**Boundary:** the only package that talks to the database. World-state writes happen ONLY by applying validated `GameEvent`s (state is a projection). No LLM calls except embedding generation for episodic writes. Depends only on `@ai-dm/schemas`.

## Stack

- drizzle-orm + `postgres` driver; migrations via drizzle-kit (checked into `drizzle/`).
- Tables (snake_case): `game_events` (append-only, composite PK `(session_id, sequence)`), `session_snapshots`. Planned, not yet built: `entities`, `faction_relations`, `quest_nodes` (deferred past step 10 — no campaign concept exists yet) and `episodic_memories (embedding vector)` (spec #2).
- Episodic memory design constraint, once built (spec #2, not yet designed): embed scene **summaries**, not raw turns; retrieval by cosine top-k, filtered by session/campaign. No embedding calls happen today — there is no episodic write path.

## Rules

- `game_events` is append-only: no UPDATE or DELETE, ever. Corrections are new events.
- Every projection must be rebuildable by replaying events from the last snapshot — write a replay test for each new projection.
- Schema changes only via generated migrations; never edit applied migrations.
- Both stores answer to one conformance suite (`src/event-store/contract.ts`). A behaviour only one of them has is a bug in the contract, not a feature — add it to the suite or remove it.

## Testing

Vitest against a throwaway Postgres (docker compose in `apps/server/`). Required today: append→replay→identical-projection round-trip, run against both event-store implementations via the shared conformance suite. Once episodic memory is built (spec #2): vector search returns a seeded fixture in top-k.

## Commands

```bash
docker compose -f ../../apps/server/docker-compose.yml up -d
pnpm --filter @ai-dm/memory db:generate | db:migrate | test | typecheck
```
