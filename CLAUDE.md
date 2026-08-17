# AI-DM — Hebrew D&D 5e AI Dungeon Master

pnpm/TypeScript monorepo. Deterministic rules engine + tiered LLM cascade + Hebrew narrative output.

## Layout

| Path | Package | Role |
|---|---|---|
| `packages/schemas` | `@ai-dm/schemas` | zod schemas — single source of truth for types AND LLM tool JSON schemas |
| `packages/rules-engine` | `@ai-dm/rules-engine` | Pure 5e rules. No I/O, no LLM, injected RNG |
| `packages/agents` | `@ai-dm/agents` | LLM cascade: intent / tactical / narrative, provider adapter |
| `packages/memory` | `@ai-dm/memory` | Postgres + pgvector: world state, episodic memory |
| `apps/server` | `@ai-dm/server` | Fastify + WS orchestrator, append-only event log |
| `apps/web` | `@ai-dm/web` | React + canvas grid, RTL Hebrew UI |
| `tools/sim` | `@ai-dm/sim` | Headless combat simulator / agent benchmark |

## Architectural invariants (do not violate)

1. **The rules engine is the only authority on game legality and math.** LLMs propose; the engine validates and resolves. Never let an LLM output mutate state directly.
2. **English inside, Hebrew outside.** All prompts, state, tool schemas, logs, code comments: English. Hebrew exists only in narrative-agent output and the web UI. (Hebrew tokens cost ~2x.)
3. **Event log is the source of truth.** State is a projection of the append-only `GameEvent` stream. Every mutation goes through an event. Enables replay, undo, reconnect.
4. **Schemas define everything once.** Types, runtime validation, and LLM tool definitions all derive from `@ai-dm/schemas` zod schemas. Never hand-write a duplicate interface or JSON schema.
5. **Dependency direction:** `schemas ← rules-engine ← agents ← server`. `web` depends only on `schemas`. Nothing depends on `server`.
6. **Licensing:** only SRD 5.2.1 (CC-BY-4.0) game content in `data/srd/`. No non-SRD monsters/settings.

## Commands

```bash
pnpm install            # bootstrap
pnpm dev                # server + web in parallel
pnpm test               # all packages (vitest)
pnpm typecheck | lint | format
pnpm sim                # headless agent benchmark
docker compose -f apps/server/docker-compose.yml up -d   # local Postgres+pgvector
```

## Conventions

- TypeScript strict (see `tsconfig.base.json`); ESLint strictTypeChecked + Prettier (100 cols). CI runs typecheck + lint + test on every push.
- Node 22, ESM only (`"type": "module"`), `.js` extensions in relative imports.
- Tests colocated as `*.test.ts`, run with Vitest. New rules-engine code requires golden tests (see its CLAUDE.md).
- camelCase in TS/JSON; DB columns snake_case.
- Pending decisions live in `docs/decisions/` as ADRs — check ADR status before implementing edition-dependent rules (ADR-0001 edition, ADR-0002 solo/party, ADR-0003 spatial house rules).
- Full roadmap and architecture rationale: `PROJECT_PLAN.md`.
