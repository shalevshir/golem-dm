# PROJECT_PLAN.md — AI-DM: Hebrew D&D 5e AI Dungeon Master

Status: POC phase · Supersedes `dm-plan.md` (see `dm-plan-review.md` for the fact-check that produced these revisions).

## 1. System Architecture

```
┌─────────────────────────────────────────────────────┐
│ apps/web — React 19, RTL Hebrew UI, canvas grid     │
│  structured actions (clicks) + free text · streams  │
└──────────────────────┬──────────────────────────────┘
                       │ WebSocket (typed messages, event sequence numbers)
┌──────────────────────▼──────────────────────────────┐
│ apps/server — Fastify orchestrator                  │
│  turn pipeline · append-only event log · metrics    │
├──────────────┬───────────────────┬──────────────────┤
│ rules-engine │ agents            │ memory           │
│ pure 5e math │ intent (nano/     │ Postgres 17 +    │
│ dice·checks· │  flash, skippable)│  pgvector (one   │
│ combat·grid· │ tactical (flash/  │  instance):      │
│ A*·LoS·cover │  mini + validate→ │  world state,    │
│ injected RNG │  retry→fallback)  │  event log,      │
│              │ narrative (sonnet │  episodic memory │
│              │  5, Hebrew,stream)│                  │
└──────────────┴───────────────────┴──────────────────┘
        all derive shapes from packages/schemas (zod)
```

**Core principles** (unchanged from original plan, refined):

1. **Deterministic rule supremacy** — the pure TS rules engine owns all math and legality; LLMs only propose and narrate.
2. **Tiered LLM cascade** — cheapest capable model per role; routing is config, benchmarked in `tools/sim`, not guessed.
3. **English internal, Hebrew at the boundary** — ~2x Hebrew token overhead avoided everywhere except final narration.
4. **Event-sourced state** — append-only `GameEvent` log; state is a projection; replay/undo/reconnect for free.
5. **Adaptive reasoning effort** — low for intent/trivial turns, high for boss-fight tactical calls.

## 2. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5.7+, strict, ESM, Node 22 | One language across all packages |
| Monorepo | pnpm workspaces | Simple; turbo can be added later if builds slow |
| Schemas | zod (+ zod-to-json-schema) | Types + validation + LLM tool schemas from one source |
| Rules engine | Pure TS, zero deps, injected RNG | Testability, replay determinism |
| LLM adapter | Vercel AI SDK (anthropic/google/openai) | Provider-agnostic; streaming + tool calls |
| Models (Aug 2026) | Intent: Gemini 3 Flash ($0.25/$1.50) or GPT-5.4 nano ($0.20/$1.25) · Tactical: Gemini 3 Flash / GPT-5.4 mini ($0.75/$4.50) · Narrative: **Claude Sonnet 5 ($2/$10)** | Verified pricing; Sonnet 5 replaces Sonnet 4.6 (newer, 33% cheaper) |
| Server | Fastify 5 + @fastify/websocket | Lightweight, fast, schema-validated routes |
| DB | Postgres 17 + pgvector (single instance, drizzle-orm) | World state + event log + episodic memory transactionally consistent; no Pinecone/Redis at POC scale |
| Web | React 19 + Vite, Canvas 2D | POC grid ≤30×30 needs no WebGL |
| Testing | Vitest everywhere; golden tests for rules; sim harness for agents | Trust in the engine is the product |

**Game content:** SRD 5.2.1 (CC-BY-4.0) only — 2024 rules recommended (ADR-0001). Attribution required. No non-SRD monsters/settings.

## 3. Latency & Resilience Requirements

**Latency budget (per player turn, p50):** intent skip/classify ≤300ms → rules resolution ≤10ms → first Hebrew narrative token **<1.5s** → full narration ≤4s. Levers: structured UI actions bypass the intent hop; narrative streams token-by-token; cache-stable prompt prefixes (static system+glossary → semi-static sheets → dynamic state) keep cached input at 90% discount (Anthropic/OpenAI) / ~75% (Gemini); combat context is a compact state snapshot, not transcript history.

**Tactical-agent validation loop (mandatory):** engine validates every `ExecuteTurn` → on rejection, one retry with machine-readable reason → then deterministic fallback (attack nearest legal target, else dodge). Every rejection logged as `action_rejected` for offline model comparison. Hard 10s turn timeout → terse rule-outcome narration fallback.

**Event replay:** all mutations are events with recorded RNG seeds; snapshots every 50 events; WS reconnect replays from client's last sequence number. Any projection must rebuild identically from log+snapshot (tested).

**Safety:** player free text is untrusted input — length-capped, sanitized, never interpolated into system prompts. Content-safety pass before beta.

**Cost target (revised, 30-turn session):** Flash-everywhere ~$0.05–$0.10 · hybrid (Flash grid + Sonnet 5 narrative) ~$0.12–$0.30. Replace with measured numbers from server metrics in week 7.

## 4. Roadmap — 11 Steps (≈8 weeks)

| # | Step | Exit criteria | Week | Status |
|---|---|---|---|---|
| 1 | **Decisions:** edition (rec: 2024/SRD 5.2.1), solo vs party (rec: solo), spatial house rules → ADRs | ADRs 0001–0003 accepted | 1 | ✅ done |
| 2 | **Scaffold:** pnpm workspaces, tsconfig, ESLint/Prettier, Vitest, CI | `pnpm typecheck && lint && test` green in CI | 1 | ✅ done |
| 3 | **Schemas:** character, actions (`ExecuteTurn`), events, world in zod; JSON-schema export | Fixtures parse; tool schema generated | 1 | 🟡 partial — no `Combatant` schema |
| 4 | **Rules engine:** dice → checks → combat resolution → action economy → grid/A*/LoS | Golden tests pass, ≥90% coverage | 1–2 | 🟡 partial — no action economy / `ExecuteTurn` validation |
| 5 | **SRD data:** ~10 monsters, conditions, 4 classes as validated JSON | Loads + validates | 2 | ⬜ not started |
| 6 | **Provider adapter:** Vercel AI SDK wrapper, `ModelRouting` config | Mocked-provider tests pass | 3 | ⬜ not started |
| 7 | **Tactical agent + sim:** validate→retry→fallback loop; benchmark Flash vs nano/mini | Legality ≥95% after retry on fixture scenarios; model chosen from data | 3–4 | ⬜ not started |
| 8 | **Server + web:** Fastify+WS, event log, replay-on-reconnect, clickable canvas grid | Full combat playable E2E vs scripted enemy | 4–5 | ⬜ not started |
| 9 | **Narrative agent:** Sonnet 5 streaming, Hebrew glossary, gendered narration, cache-stable prefix | First token <1.5s p50; Hebrew reviewed by native speaker | 5–6 | ⬜ not started |
| 10 | **Memory:** pgvector episodic store, scene summarization, quest DAG | Replay test + top-k retrieval test pass | 6 | ⬜ not started |
| 11 | **Closed beta:** 5–10 Hebrew-speaking playtesters; per-turn token/latency/cost dashboards | Measured cost table replaces §3 estimates; go/no-go review | 7–8 | ⬜ not started |

### Status as of 2026-08-17

Toolchain bootstrapped and verified: `pnpm typecheck`, `pnpm lint`, `pnpm test`
all green (132 tests). Rules-engine coverage 98.2% stmts / 94.15% branch / 100%
funcs, above the ≥90% bar.

**Built:** `dice` (notation parser, 2024 crit doubling, replay determinism),
`checks` (modifiers, proficiency/expertise, saves, passive scores, contests),
`combat` (attack vs AC with cover, temp-HP ordering, massive-damage death,
death saves, 2024 unified exhaustion), `spatial` (Chebyshev distance, A* with
difficult terrain, Bresenham LoS behind a swappable interface, cover).

**Blocked:** `ExecuteTurn` validation and the action-economy state machine —
the agent-retry gate described in `packages/rules-engine/CLAUDE.md`. Both need a
`Combatant` schema (position, speed, reach, remaining action economy, conditions)
that does not exist yet; `packages/schemas/src/world.ts` currently has only
`GridMap`, `EntityStatus`, `TerrainType`, and `FactionRelation`. **This is the
next task**, and it reopens steps 3 and 4 before step 5 can start.

## 5. Open Risks

Tactical-model quality on spatial reasoning (mitigated by sim benchmarking + fallback); Hebrew narrative register (native-speaker review in step 9); sequential-call latency stacking (streaming + intent bypass); licensing discipline as content grows (SRD-only rule in `data/srd/README.md`); solo→party scope creep (deferred by ADR-0002).
