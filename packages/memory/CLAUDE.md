# @ai-dm/memory

## Purpose & boundary

Persistence layer: durable world state (entities, factions, quest DAG) and episodic memory (pgvector embeddings of scene summaries) in **one Postgres instance** (image `pgvector/pgvector:pg17`). One DB keeps memories and world state transactionally consistent — do not introduce Pinecone/Redis without an ADR.

**Boundary:** the only package that talks to the database. World-state writes happen ONLY by applying validated `GameEvent`s (state is a projection). No LLM calls except embedding generation for episodic writes. Depends only on `@ai-dm/schemas`.

## Stack

- drizzle-orm + `postgres` driver; migrations via drizzle-kit (checked into `drizzle/`).
- Tables (snake_case): `game_events` (append-only, unique `(session_id, sequence)`), `session_snapshots`, `entities`, `faction_relations`, `quest_nodes`, `episodic_memories (embedding vector)`.
- Embed scene **summaries**, not raw turns. Retrieval: cosine top-k, filtered by session/campaign.

## Rules

- `game_events` is append-only: no UPDATE or DELETE, ever. Corrections are new events.
- Every projection must be rebuildable by replaying events from the last snapshot — write a replay test for each new projection.
- Schema changes only via generated migrations; never edit applied migrations.

## Testing

Vitest against a throwaway Postgres (docker compose in `apps/server/`). Required: append→replay→identical-projection round-trip; vector search returns seeded fixture in top-k.

## Commands

```bash
docker compose -f ../../apps/server/docker-compose.yml up -d
pnpm --filter @ai-dm/memory db:generate | db:migrate | test | typecheck
```
