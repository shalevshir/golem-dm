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
| Models (Aug 2026) | Intent: Gemini 3 Flash ($0.25/$1.50) or GPT-5.4 nano ($0.20/$1.25) · Tactical: **GPT-5.4 nano @ high effort ($0.20/$1.25)** · Narrative: **Claude Sonnet 5 ($2/$10)** | Verified pricing; Sonnet 5 replaces Sonnet 4.6 (newer, 33% cheaper). Tactical is the step 7b benchmark's pick (§4), not a guess — Gemini lost it outright at 86–91% legality |
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
| 7 | **Tactical agent + sim:** validate→retry→fallback loop; benchmark Flash vs nano/mini | Legality ≥95% after retry on fixture scenarios; model chosen from data | 3–4 | ✅ done |
| 8 | **Server + web:** Fastify+WS, event log, replay-on-reconnect, clickable canvas grid | Full combat playable E2E vs scripted enemy | 4–5 | ✅ done |
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

Two things were, at the time of 7a, **deliberately unmeasured**: the tactical
row still pointed at Gemini 3 Flash by default, and `REASONING_BUDGET_TOKENS`
(0 / 4096 / 16384) was a plausible scale rather than an observed one. 7b's
benchmark settled the first and *not* the second — see "Step 7b result" below.
The budget table's only consumer is google, which lost the tactical role, so it
remains unmeasured and now bears only on `intent`.

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

**One known gap 7b had to handle before publishing any cost figure:** token usage
is under-reported on retry paths. `TurnProposalResult.usage` accumulates only on
adapter calls that produced output, but a `schema_validation_failed` or
`no_tool_call` attempt was still billed — and `AdapterError`
(`packages/agents/src/providers/errors.ts`) carries no `usage` field, so that
spend is invisible. The bias is downward and lands on exactly the paths a model
comparison most wants to price. Either add `usage?` to `AdapterError` (a step-6
contract change) or state the bias explicitly alongside the results. *Resolved
by declaration:* `usage` was threaded onto the failure paths that carry it and
the report now computes `costIsUnderreported`, which came back **false** for the
7b run below — no attempt was billed without reporting usage, so its cost column
is a real figure rather than a lower bound.

### Step 7b result (2026-08-19) — tactical model chosen from data

Run `live-2026-08-19T07-28-03.487Z` in `tools/sim/runs/`: 12 arms (4 candidates
x low/medium/high effort) x 4 scenarios x 5 seeds, 1800 probe turns and 1880
encounter turns, all live. `costIsUnderreported: false`, zero attempts missing
usage, and only 8 `schema_validation_failed` across all 3680 calls.

**Chosen: `gpt-5.4-nano` at `high` effort** — 98.7% legality after retry (tied
best of any arm) at **$0.0011/turn, $0.034 per 30-turn session**. It is the
cheapest arm that cleared the ≥95% bar, which is what principle 2 asks for.
`DEFAULT_MODEL_ROUTING.tactical` now says so.

Seven arms cleared the bar: `gpt-5.4-mini@medium` (98.7%), `gpt-5.4-nano@high`
(98.7%), `gpt-5.4-mini@high` (98.0%), `claude-sonnet-5@high` (96.7%),
`claude-sonnet-5@low` (96.7%), `gpt-5.4-nano@medium` (96.0%),
`claude-sonnet-5@medium` (95.3%).

Three findings worth more than the ranking:

- **The plan's own tactical default was wrong.** All three
  `gemini-3.1-flash-lite` arms *missed* the bar — 86.0% / 87.3% / 90.7% — so
  the §2 table's "Tactical: Gemini 3 Flash" is disqualified by measurement.
  Google's tail was also catastrophic (`@high` p95 **273,695ms**, ~4.5 min).
  This says nothing about the `intent` role, which still routes to google:
  classifying a closed-set label is not proposing a legal turn, and no
  benchmark of it exists yet.
- **Reasoning effort is load-bearing for OpenAI and inert for Anthropic.**
  nano climbed 93.3 → 96.0 → 98.7% and mini 92.0 → 98.7 → 98.0% across
  low/medium/high, while sonnet sat flat at 95.3–96.7%. That matches the
  adapter: anthropic's effort travels as `output_config.effort`, so
  `REASONING_BUDGET_TOKENS` never touches it. Note that table is therefore
  *still unmeasured* — google is its only consumer and google lost.
- **Every rejection was spatial.** `target_out_of_reach` (295),
  `destination_occupied` (271), `movement_exceeds_speed` (69),
  `movement_path_blocked` (15), with zero unresolved action ids. §5's
  "tactical-model quality on spatial reasoning" is the live risk, exactly as
  written; the engine's monster-trait gaps never bit.

**The one cost of this choice:** nano@high's p95 is 27.8s against §3's 10s turn
timeout, so a few percent of turns will hit that timeout and take the
deterministic fallback. Part of that tail is the AI SDK's own
retry-with-backoff on transient provider errors rather than model thinking
time. `claude-sonnet-5` was the only family whose p95 (7.2–7.9s) fits inside
the timeout, at 3.4x the cost — the fallback choice if the tail proves
unacceptable once step 8's server enforces the timeout for real.

Encounter-mode win rates (50–75% across all arms, 20 encounters each) did not
separate the arms meaningfully and were not used to choose. Read them with the
harness's declared gaps in view: Dodge is inert, so a model that Dodges wisely
is penalised.

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

**Spec #2 — the web client**, against the protocol spec #1 freezes.
[`docs/superpowers/specs/2026-08-19-web-client-design.md`](docs/superpowers/specs/2026-08-19-web-client-design.md)
(written 2026-08-19, plan not yet started). Reading the frozen protocol
against `apps/web/CLAUDE.md`'s zero-logic boundary turned up six gaps, and
closing them needs *additive* protocol changes rather than a client-only
build: there is no affordance frame, so a clickable grid cannot show legal
moves; `Combatant` carries no display name; `reduce` cannot move to
`@ai-dm/schemas` as spec #1's fallback assumed, because it imports
`startTurn` from the engine; nothing acks a command; `ExecuteTurn` requires
an English rationale a Hebrew-typing player cannot author; and no terminal
frame marks the end of combat. The design adds a `turn_affordances` frame
yielded by `handleCommand`, a `GET /encounters/:id` catalogue for static
facts, and moves `reduce` into `@ai-dm/schemas` (swapping `startTurn` for the
byte-equivalent `ActionEconomy.parse({})`) so client and server share one
fold. Affordances are derived by running the real validator over enumerated
candidates, never by reimplementing legality client-side.

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

### 4.3 Step 8 server slice — execution notes (2026-08-19)

Spec #1 (§4.2) is built and its exit criterion is asserted:
`apps/server/src/e2e.test.ts` plays a full `goblin-ambush` combat over a real
WebSocket, against a mocked tactical provider and the deterministic
narrative stand-in, and separately proves a mid-fight reconnect over a
second real socket reproduces the server's own projection exactly, not just
its combatant count. `apps/server` carries 101 tests; the full repo —
`packages/schemas` (60), `packages/rules-engine` (319, having absorbed the
seven cases moved out of `tools/sim`'s old `resolve.test.ts`),
`packages/agents` (176), `apps/server` (101) and `tools/sim` (129) — is
green under `pnpm typecheck && pnpm lint && pnpm test`.

The protocol that shipped: a client sends `join` (optionally with
`resumeFrom`), `structured_action`, or `free_text` over `/ws`; the server
answers with `session_state` snapshots, `event` frames (the same
`GameEvent`s the store persists), streamed `narrative_token` frames, and
`rejected`/`error` frames on an illegal or malformed turn. `POST /sessions`
creates a session against one of the catalogue's encounters (`goblin-ambush`
is the only one so far) and returns a `sessionId`; everything after that
happens over the socket. A client is never handed state directly — it is
always a fold of the event log (`apps/server/src/core/reduce.ts`), which is
what makes a reconnecting client and the server's own in-memory projection
provably the same function of the same events, rather than two
implementations that happen to agree.

Three things the E2E run surfaced that are worth recording rather than
rediscovering:

- **The hero dies rather than falling unconscious, and that is what lets the
  fight end at all.** `combatantFromStatBlock`
  (`packages/rules-engine/src/combat/statblock.ts`) never sets
  `characterId`, so `resolve.ts`'s
  `diesAtZeroHp: target.characterId === undefined` is true for every
  combatant in `goblin-ambush` — the hero included, since no
  player-character data exists yet and it borrows the `guard` stat block. An
  unconscious hero, with no death-save loop implemented, would leave the
  pipeline with nothing to conclude on; a dead one lets `runEnemyTurns`'
  living-faction check fire and the fight actually stop. This guarantee
  disappears the moment real `CharacterSheet`-backed heroes arrive, and
  whatever step adds them also has to decide what ends a fight the party can
  survive.
- **`EncounterDefinition.maxRounds` is inert.** It is set (20, for
  `goblin-ambush`) and threaded through `buildEncounter`, but nothing under
  `apps/server/src` or `packages/rules-engine/src` reads it — there is no
  round cap anywhere in the pipeline. Termination rests entirely on the
  combat math above; a caller that needs a bound (the E2E test included) has
  to impose its own.
- **Per-turn metrics are missing two of the spec's five fields, honestly
  rather than silently.** `TurnPorts.metrics` (`apps/server/src/core/
  pipeline.ts`) records tokens in/out, retries and latency per tactical
  call, but not cached tokens or cost: `TokenUsage`
  (`packages/agents/src/providers/usage.ts`) has no cache-read field to
  report, and the cost table lives in `tools/sim`, which nothing under
  `apps/server` may depend on (dependency direction, root `CLAUDE.md` §5). A
  cost figure computed from `TokenUsage` alone would also be *wrong*, not
  merely incomplete — cache reads bill differently and nothing at this layer
  reports them.
- **Model routing is not yet config-overridable, though the spec calls for
  it to be.** The spec's §Config says routing "stays config
  (`DEFAULT_MODEL_ROUTING` as the default, overridable), never code," but
  `apps/server/src/config.ts`'s `ServerConfig` carries no routing field and
  `main.ts` wires `DEFAULT_MODEL_ROUTING` in directly — changing the
  tactical model today means editing
  `packages/agents/src/providers/routing.ts` and rebuilding. The final
  pre-merge fix wave (2026-08-19) ruled against inventing an override
  mechanism unreviewed; recorded here so the gap is tracked, not lost.

Deferred, as §4.2 already said: Postgres persistence, the intent agent, and
the web client (spec #2).

### 4.4 Step 8 web client — execution notes (2026-08-20)

Spec #2 (§4.2) is built: 13 tasks, and the suite went **791 → 889** passing
(`@ai-dm/schemas` 60→85, `@ai-dm/rules-engine` 319→332, `@ai-dm/agents` 176,
`apps/server` 107→100, `apps/web` 0→67, `tools/sim` 129). `apps/server`
*drops* by 7 on purpose, not by regression: `reduce`'s 15 test cases moved
with it into `@ai-dm/schemas` (§4.2's package move), and 8 were added back
for the server's own coverage of the import. `pnpm typecheck` is clean and
`npx eslint apps/server apps/web packages tools` exits 0.

The exit criterion was met and verified live in a browser, not only by the
suite: the RTL Hebrew client creates a session, fetches the catalogue,
joins over WS, renders server-computed affordances, commits a structured
action, survives a hard refresh mid-fight with state intact, and plays
`goblin-ambush` through to the C-31 defeat — detected from the projection,
since no terminal frame is ever emitted (C-37), and rendered as a normal
ending rather than an error.

Design points worth keeping:

- **`reduce` now lives in `@ai-dm/schemas`**, so client and server run
  **one** fold rather than two that must agree. `startTurn()` is redefined
  as `ActionEconomy.parse({})`, which removes the engine dependency that
  previously blocked the move.
- **Affordances are derived by enumerating candidates and running the
  real `validateExecuteTurn`**, never a parallel legality implementation. A
  reviewer confirmed this by replacing the server's tile list with a
  locally computed radius and watching the guard test go red.
- **`affordancesFor` must take a `MonsterStatBlock` as a parameter**:
  `CombatWorld` carries `actionRangesFeet` keyed by `actionId` but no list
  of the actions an actor has, and `AvailableAction` lives in
  `@ai-dm/agents`, which the engine may not import.
- **`conclusionOf`'s predicate is byte-for-byte the server's own stop
  condition**, so client and server agree by construction about when the
  fight is over.

Costs and gotchas the next engineer should know:

- Affordance computation runs ~143 A* probes per player turn on a 12×12
  grid. Irrelevant beside a real model call — but **not** beside a mocked
  one. It leaked into a wall-clock timing test's measured window and was
  misdiagnosed as CPU-contention flakiness across three tasks before anyone
  disabled the yield and measured. Lesson: "passes when run alone" is
  evidence about contention, not causation.
- `@testing-library/react` gates its auto-cleanup behind
  `typeof afterEach === 'function'`, so under `globals: false` it never
  registers and DOM leaks between tests. `apps/web/src/test-setup.ts`
  registers `afterEach(cleanup)` explicitly.
- `<StrictMode>` double-invokes effects on **initial mount only**. A shared
  cancellation ref across effect runs is therefore unsafe — the second run
  resets it before the first run's pending async work reads it, opening two
  websockets. Use a monotonic run token.
- The narrative pane currently renders **English**, because the narrative
  agent is spec #1's deterministic stand-in; the Hebrew agent arrives in
  step 9. Today the only Hebrew a player sees is UI chrome.
- There is still no Hebrew name data anywhere in the repo (the SRD is
  English per ADR 0001), so combatant and action names render as English
  inside the RTL UI — which is why every such fragment is wrapped in
  `<bdi>`.

The process finding, stated plainly, is the most transferable thing the
slice produced: **seven separate tasks shipped a test whose name promised a
property its assertion could not detect.** Examples: `toBeUndefined()`
cannot distinguish an omitted key from an explicitly-`undefined` one; a
"reconnect" test that never reconnected; a fold-parity test over an empty
combatant list; a `<bdi>` test covering one of three isolated fragments; a
`<StrictMode>` test that exercised the post-click path where `<StrictMode>`
does not double-invoke. Every one passed against the exact defect it was
written to catch, and none was caught by the suite going red — all came out
of review. The rule that follows: **when a test exists to protect a
specific line, delete that line and watch the test fail.** The sabotage
check, not the green run, is the evidence.
