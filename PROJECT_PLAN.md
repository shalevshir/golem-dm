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
| 3 | **Schemas:** character, actions (`ExecuteTurn`), events, world in zod; JSON-schema export | Fixtures parse; tool schema generated | 1 | ✅ done |
| 4 | **Rules engine:** dice → checks → combat resolution → action economy → grid/A*/LoS | Golden tests pass, ≥90% coverage | 1–2 | ✅ done |
| 5 | **SRD data:** ~10 monsters, conditions, 4 classes as validated JSON | Loads + validates | 2 | ✅ done |
| 6 | **Provider adapter:** Vercel AI SDK wrapper, `ModelRouting` config | Mocked-provider tests pass | 3 | ✅ done |
| 7 | **Tactical agent + sim:** validate→retry→fallback loop; benchmark Flash vs nano/mini | Legality ≥95% after retry on fixture scenarios; model chosen from data | 3–4 | 🟡 7a done, 7b pending |
| 8 | **Server + web:** Fastify+WS, event log, replay-on-reconnect, clickable canvas grid | Full combat playable E2E vs scripted enemy | 4–5 | 🟡 designed, not built (§4.2) |
| 9 | **Narrative agent:** Sonnet 5 streaming, Hebrew glossary, gendered narration, cache-stable prefix | First token <1.5s p50; Hebrew reviewed by native speaker | 5–6 | ⬜ not started |
| 10 | **Memory:** pgvector episodic store, scene summarization, quest DAG | Replay test + top-k retrieval test pass | 6 | ⬜ not started |
| 11 | **Closed beta:** 5–10 Hebrew-speaking playtesters; per-turn token/latency/cost dashboards | Measured cost table replaces §3 estimates; go/no-go review | 7–8 | ⬜ not started |

### Status as of 2026-08-17

Toolchain bootstrapped and verified: `pnpm typecheck`, `pnpm lint`, `pnpm test`
all green (489 tests). Rules-engine coverage 99.31% stmts / 97.25% branch / 100%
funcs, above the ≥90% bar.

**Built:** `dice` (notation parser, 2024 crit doubling, replay determinism),
`checks` (modifiers, proficiency/expertise, saves, passive scores, contests),
`combat` (attack vs AC with cover, temp-HP ordering, massive-damage death,
death saves, 2024 unified exhaustion, action-economy state machine,
`ExecuteTurn` validation), `spatial` (Chebyshev distance, A* with difficult
terrain, Bresenham LoS behind a swappable interface, cover).

Steps 3 and 4 closed with `Combatant` (`packages/schemas/src/world.ts`) and
`validateExecuteTurn` (`packages/rules-engine/src/combat/validate-turn.ts`) —
the agent-retry gate named in `packages/rules-engine/CLAUDE.md`. It returns a
discriminated result: either a `TurnPlan` (resolved paths, movement cost,
resulting action economy and spell slots) or a list of rejections, each with a
stable `TurnRejectionReason` code for the tactical agent's single retry and the
`action_rejected` event.

Step 5 landed 11 monster stat blocks, all 15 conditions and the 4 POC classes in
`data/srd/`, transcribed from the SRD 5.2.1 PDF rather than from recall. A test
in `@ai-dm/schemas` loads and validates every file, and
`combatantFromStatBlock` / `actionRangesFeetFrom` in the rules engine turn a
stat block into a `Combatant` and into the validator's range lookup.

The pass paid for itself immediately: it caught that **Stunned does not set
Speed 0** in 2024, which the action-economy state machine had wrong (see
`RULES_REFERENCE.md` §7).

Step 6 put `@ai-dm/agents` behind one `LanguageModelPort` — structured tool
calls, plain completion, token streaming — with `vercel.ts` the only file that
imports the SDK. `ModelRouting` is now `role → ModelSpec` (model id plus
temperature, token cap and reasoning effort), defaulting to the §3 table.
Failures come back as discriminated results with four stable codes rather than
thrown SDK exceptions, which is what step 7's retry loop branches on; a
schema-violating tool call carries the zod issues to quote back at the model.
`LayeredPrompt` makes the cache-stable prefix ordering a type instead of a
convention. 62 tests, no network: behaviour runs against a scripted fake, SDK
wiring against `MockLanguageModelV1`.

Step 7a built the tactical agent on that adapter. `proposeTurn` projects the
`CombatWorld` into a compact JSON snapshot — positions, HP, conditions, action
economy, and a *precomputed* `distanceFeet` to every other combatant, which
removes the coordinate arithmetic that produces most out-of-reach proposals —
puts it in the `dynamic` prompt tier only, and asks the tactical model for an
`ExecuteTurn`. The rules engine validates it. On rejection the agent retries
exactly once, carrying the stable `TurnRejectionReason` codes back to the model;
a second failure yields the deterministic fallback (attack the nearest legal
target, else Dodge, without moving). Every rejection becomes an
`ActionRejectedPayload` — new in `@ai-dm/schemas`, stamped with the provider and
model id so step 7b can group a log of rejections by the model that produced it.

The loop is straight-line rather than a counted one, so "never a third model
call" is visible in the source rather than enforced by a bound; a test asserts
`port.calls` never exceeds two on any failure path, and another asserts the
cached prompt tiers are byte-identical across the retry.

Two things step 7a deliberately does not do: it never moves the fallback (a
pathfinding fallback would re-implement the judgement the model owes us, in the
one path that must be trivially correct), and on `aborted` it abandons the turn
rather than falling back, because the abort signal is the caller's.
`deterministicFallback` is exported so the server can choose otherwise at no
cost.

Two things there are **deliberately unmeasured**: the tactical row still points
at Gemini 3 Flash by default, and `REASONING_BUDGET_TOKENS` (0 / 4096 / 16384)
is a plausible scale rather than an observed one. Step 7b's benchmark is what
should set both.

Two follow-ups landed after 7a's review, both of which exist for 7b's sake:

- **`promptVersion`** on every `action_rejected` payload, sourced from
  `TACTICAL_PROMPT_VERSION` (`packages/agents/src/tactical/prompt-text.ts`).
  Without it, a prompt edited between two benchmark runs pools the two runs
  silently. A guard test pins a hash of every prompt string that reaches a
  model, so the version cannot go stale unnoticed — editing a prompt fails
  `prompt-text.test.ts` until the version is bumped and the hash re-pinned.
- **`createTimingPort`** (`packages/agents/src/providers/timing.ts`), an
  optional decorator recording `durationMs` per call and `firstChunkMs` for
  streams. Timing at the port rather than inside an agent is what makes step
  9's "first token < 1.5s" measurable at all, and lets `apps/server` reuse the
  same numbers without depending on `tools/sim`.

**One known gap 7b must handle before publishing any cost figure:** token usage
is under-reported on retry paths. `TurnProposalResult.usage` accumulates only on
adapter calls that produced output, but a `schema_validation_failed` or
`no_tool_call` attempt was still billed — and `AdapterError`
(`packages/agents/src/providers/errors.ts`) carries no `usage` field, so that
spend is invisible. The bias is downward and lands on exactly the paths a model
comparison most wants to price. Either add `usage?` to `AdapterError` (a step-6
contract change) or state the bias explicitly alongside the results.

**Known gaps** are tracked in [`RULES_REFERENCE.md`](RULES_REFERENCE.md) §8,
which is the canonical record of what the engine does and does not implement.
The ones that most affect the validator: player weapon and spell ranges still
have no data, monster traits and reactions are not captured, cover is
all-or-nothing per square, and Tiny creatures cannot share a square.

### 4.1 SRD reference notebook (registered 2026-08-19)

The full SRD 5.2.1 — the 13 chapter markdowns plus the official
`SRD_CC_v5.2.1.pdf` — is loaded in NotebookLM notebook
**`3a0d4f39-93c2-48ee-b1d1-258c7f7583ab`**, queryable through the NotebookLM
MCP (`notebook_query`); answers carry citations into the SRD text. Verified
2026-08-19 by re-auditing `RULES_REFERENCE.md` §1–§7 against it: ~40 claims
checked, all seven §7 recall traps confirmed, two rows corrected (Temporary
HP replacement is RAW a *choice*, and RAW lets a creature pass a narrow
opening one size smaller as Difficult Terrain — our hard block is a house
rule).

**Where it plugs in — and where it must not:**

- **Not the rules engine, not runtime.** Invariant 1 stands: legality and
  math are code + `data/srd/` JSON. No engine, agent, or server path may call
  NotebookLM at runtime — it is a dev-machine MCP on a personal Google
  account, with the latency and availability to match. If a runtime
  "rules-lawyer" retrieval path is ever wanted, it goes through
  `packages/memory` pgvector over locally ingested SRD markdown (step 10
  infrastructure), never NotebookLM.
- **Rule verification (ongoing).** The `RULES_REFERENCE.md` discipline gains
  a faster loop: query the notebook first; the PDF text stays the authority
  for exact wording.
- **SRD data transcription (step 8 pre-work).** The §8 data gaps close by
  transcription with notebook-cited checks, same methodology that caught the
  Stunned/Speed-0 bug in step 5.
- **Prompt-context curation (step 9).** The static (cache-stable) prompt tier
  gets a curated English rules digest — conditions, action economy, cover —
  compiled at dev time and verified against the notebook before pinning.
  Never live retrieval.
- **Sim adjudication (step 7b+).** When a rejection-log dispute arises
  (validator vs. model), the notebook is the offline referee for what RAW
  says.

**Tasks:**

- [ ] **7b:** before publishing the benchmark, adjudicate any disputed
      `action_rejected` codes against the notebook — a validator bug pooled
      into a model's rejection rate corrupts the comparison.
- [ ] **Step 8 pre-work:** transcribe player weapon data (damage, properties,
      ranges) and armor/base AC into `data/srd/`, notebook-checked — closes
      the caller-supplied default on `CombatWorld.actionRangesFeet` for
      players and the base-AC row in `RULES_REFERENCE.md` §2.
- [ ] **Step 9:** build the rules digest for the narrative/tactical static
      prompt tier; verify each line against the notebook, then pin it under
      the same hash-guard as `TACTICAL_PROMPT_VERSION`.
- [ ] **Backlog:** monster traits/reactions transcription (Pack Tactics,
      Parry, Undead Fortitude) once the engine grows hooks for them (§8).

## 5. Open Risks

Tactical-model quality on spatial reasoning (mitigated by sim benchmarking + fallback); Hebrew narrative register (native-speaker review in step 9); sequential-call latency stacking (streaming + intent bypass); licensing discipline as content grows (SRD-only rule in `data/srd/README.md`); solo→party scope creep (deferred by ADR-0002).

### 4.2 Step 8 decomposition (designed 2026-08-19)

Step 8 turned out to span four independent pieces, so it is split into two
specs, each with its own plan → implementation cycle.

**Spec #1 — the server slice.**
[`docs/superpowers/specs/2026-08-19-server-slice-design.md`](docs/superpowers/specs/2026-08-19-server-slice-design.md),
plan at
[`docs/superpowers/plans/2026-08-19-server-slice.md`](docs/superpowers/plans/2026-08-19-server-slice.md)
(15 tasks). Promotes `applyTurn`, `buildEncounter` and `seeded` out of
`tools/sim` into `@ai-dm/rules-engine` — the sim is a package nothing may
depend on, and its `resolve.ts` header always called itself "the sim's
stand-in for the server's turn pipeline (step 8)". Adds the wire protocol to
`@ai-dm/schemas` (so `apps/web` can read it under invariant 5), a
`NarrativePort` plus deterministic stand-in to `@ai-dm/agents`, and builds
`apps/server` as an event-sourced core (`handleCommand` async generator, pure
`reduce`, `EventStore` port) behind a thin Fastify/WS transport. Verified by a
scripted WS client playing a full combat with a mocked provider.

**Spec #2 — the web client**, against the protocol spec #1 freezes. Not yet
written.

Deferred out of step 8 deliberately: Postgres persistence (the `EventStore`
port ships with an in-memory implementation; `@ai-dm/memory` is still empty
stubs and gets its own spec) and the intent agent (it classifies free text
into five buckets, but nothing downstream can turn language into an
`ExecuteTurn`, so it has no consumer until that exists — `free_text` is
reserved in the protocol envelope and answered with a stable error code).

Two facts the design turned up that are worth not rediscovering: the rules
engine's "no I/O" boundary means `buildEncounter` must take **injected**,
already-parsed stat blocks, and the SRD file loader has no shared home at all
— `@ai-dm/schemas` is bundled for the browser by `apps/web`, so `node:fs`
cannot go there either. The sim and the server each keep a copy.
