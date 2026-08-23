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
6. **Licensing:** only SRD 5.2.1 (CC-BY-4.0) game content in `data/srd/`. No non-SRD monsters/settings. Attribution is mandatory and its exact wording lives in `NOTICE.md` — reproduce it verbatim and add no other attribution to Wizards.

## Commands

```bash
corepack enable         # REQUIRED first — pnpm is not on PATH
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
- Decisions live in `docs/decisions/` as ADRs. 0001 (2024/SRD 5.2.1), 0002 (solo), 0003 (spatial), 0004 (campaign vs. session identity) are all ACCEPTED — check status before assuming anything is still open.
- Full roadmap and architecture rationale: `PROJECT_PLAN.md`.
- **Before writing or changing any 5e rule, read `RULES_REFERENCE.md`.** It maps every implemented rule to its SRD 5.2.1 source and its code location, and lists the places where 2024 differs from 2014. Verify against it rather than from memory — several 2024 rules (contests removed, unified exhaustion, surprise) differ from what recall suggests. For anything it doesn't cover, query the SRD NotebookLM notebook `3a0d4f39-93c2-48ee-b1d1-258c7f7583ab` via the NotebookLM MCP (`notebook_query`) — full SRD with citations. Dev-time only; never a runtime dependency (PROJECT_PLAN.md §4.1).

## Gotchas

- ESLint `strictTypeChecked`: `[...str]` is banned (`no-misused-spread`) — use `Array.from(str, fn)`.
- Casting `x as keyof typeof obj` makes a real `=== undefined` guard dead code — type lookups as `Record<string, T | undefined>` instead.
- No `argsIgnorePattern` is configured, so `_`-prefixed unused params still error. Stubs won't lint until implemented.
- `-2 * level` yields `-0` at level 0 and fails `toBe(0)` (Object.is) — write `0 - 2 * level`.
- New packages need `vitest run --passWithNoTests` until they have a test file.
- `@vitest/coverage-v8` must match the vitest major (3.x); `pnpm add` grabs 4.x and fails the peer check.
