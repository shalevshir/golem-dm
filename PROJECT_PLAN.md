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
| 9 | **Narrative agent:** Sonnet 5 streaming, Hebrew glossary, gendered narration, cache-stable prefix | First token p50 1340 ms, pooled n=36 (meets <1.5s; see §4.5 for the per-run spread); Hebrew reviewed by native speaker — pending (`docs/prompts/hebrew-review-2026-08-21.md` committed, not yet reviewed) | 5–6 | 🟡 agent shipped; native-speaker review pending |
| 10 | **Memory:** pgvector episodic store, scene summarization, quest DAG | Replay test + top-k retrieval test pass | 6 | 🟡 spec #1 merged to `main`, CI green; spec #2 folded into §4.7's sequence (step 7) |
| 11 | **Closed beta:** 5–10 Hebrew-speaking playtesters; per-turn token/latency/cost dashboards | Measured cost table replaces §3 estimates; go/no-go review | 7–8 | ⬜ deferred behind the §4.7 narrative foundation |

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
- [x] **Step 8 pre-work:** transcribe player weapon data (damage, properties,
      ranges) and armor/base AC into `data/srd/`, notebook-checked — closes
      the caller-supplied default on `CombatWorld.actionRangesFeet` for
      players and the base-AC row in `RULES_REFERENCE.md` §2. Shipped inside
      step 9 spec #1 (§4.5), not step 8.
- [x] **Step 9:** build the rules digest for the narrative/tactical static
      prompt tier; verify each line against the notebook, then pin it under
      the same hash-guard as `TACTICAL_PROMPT_VERSION`. Shipped wired into
      the **narrative role only**: the tactical prompt is exactly what step
      7b benchmarked to justify `DEFAULT_MODEL_ROUTING.tactical`, and adding
      the digest there would change that prompt (§4.5).
- [ ] **Backlog:** monster traits/reactions transcription (Pack Tactics,
      Parry, Undead Fortitude) once the engine grows hooks for them (§8).

## 5. Open Risks

Tactical-model quality on spatial reasoning (mitigated by sim benchmarking + fallback); Hebrew narrative register (native-speaker review in step 9); sequential-call latency stacking (streaming + intent bypass); licensing discipline as content grows (SRD-only rule in `data/srd/README.md`); solo→party scope creep (deferred by ADR-0002); the in-memory event store's silent data loss on restart when `DATABASE_URL` is absent — a deliberate fallback for dev/tests, not a warning a deploy operator is guaranteed to see before it costs a session (§4.6).

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
always a fold of the event log (`packages/schemas/src/reduce.ts`), which is
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
  survive. **Superseded by step 9 spec #1 (§4.5):** `combatantFromStatBlock`
  now sets `characterId` for a character spawn, the hero is a real
  `CharacterSheet`-derived character rather than a borrowed `guard` stat
  block, and the question above is answered — `resolve.ts` still pins
  `diesAtZeroHp: true` unconditionally rather than reading it off
  `characterId`, so a real hero still dies at 0 HP rather than falling
  Unconscious, now recorded as a known gap rather than an artifact of the
  stand-in (`RULES_REFERENCE.md` §8, "Every combatant dies at 0 HP, PCs
  included").
- **`EncounterDefinition.maxRounds` is inert.** It is set (20, for
  `goblin-ambush`) and threaded through `buildEncounter`, but nothing under
  `apps/server/src` or `packages/rules-engine/src` reads it — there is no
  round cap anywhere in the pipeline. Termination rests entirely on the
  combat math above; a caller that needs a bound (the E2E test included) has
  to impose its own.
- **Per-turn metrics are missing two of the spec's five fields, honestly rather
  than silently.** `TurnPorts.metrics` (`apps/server/src/core/pipeline.ts`)
  records tokens in/out, retries and latency per tactical call, but not cached
  tokens or cost: `TokenUsage` (`packages/agents/src/providers/usage.ts`) has
  no cache-read field to report, and the cost table lives in `tools/sim`, which
  nothing under `apps/server` may depend on (dependency direction, root
  `CLAUDE.md` §5). A cost figure computed from `TokenUsage` alone would also be
  *wrong*, not merely incomplete — cache reads bill differently and nothing at
  this layer reports them.
- **Model routing is not yet config-overridable, though the spec calls for
  it to be.** The spec's §Config says routing "stays config
  (`DEFAULT_MODEL_ROUTING` as the default, overridable), never code," but
  `apps/server/src/config.ts`'s `ServerConfig` carries no routing field and
  `main.ts` wires `DEFAULT_MODEL_ROUTING` in directly — changing the
  tactical model today means editing
  `packages/agents/src/providers/routing.ts` and rebuilding. The final
  pre-merge fix wave (2026-08-19) ruled against inventing an override
  mechanism unreviewed; recorded here so the gap is tracked, not lost.
- **A session's genesis state is now re-derived from a mutable file.**
  `loadSession` (`apps/server/src/core/session.ts`) rebuilds a session's
  initial state by calling `buildEncounterById` again, which — now that the
  hero is a real `CharacterSheet` (step 9 spec #1, §4.5) — reaches
  `loadCharacter` (`apps/server/src/encounters/characters.ts`) and reads
  `data/characters/hero.json`. Before that, `buildEncounterById` touched only
  immutable SRD reference data. Editing the hero's level, gear or HP now
  silently rewrites the starting state of every session already in the log,
  so the stored event deltas fold onto a different world on replay.
  Invariant 3 in root `CLAUDE.md` ("state is a projection of the append-only
  `GameEvent` stream") has thereby acquired an unrecorded qualifier — plus
  whatever the character sheet says at load time. No defect today: one
  sheet, authored by us, and `GenesisPayload` deliberately omits `state`
  itself. Recorded here per the final whole-branch review's fix wave
  (2026-08-20) rather than re-architected.

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
  step 9. Today the only Hebrew a player sees is UI chrome. **Closed by
  step 9 spec #2 (§4.5):** the server streams Hebrew narration from
  `claude-sonnet-5`, degrading to a Hebrew deterministic renderer rather
  than an English one, so the narrative pane is Hebrew end to end.
- Hebrew name data now exists throughout `data/srd/` and `data/characters/`
  (`nameHebrew`, added by step 9 spec #1 — see §4.5), but the web client
  does not consume it yet: combatant and action names still render as
  English (`nameEnglish`) inside the RTL UI — which is why every such
  fragment is wrapped in `<bdi>`. **Closed by step 9 spec #2 (§4.5):**
  `CombatLog.tsx`, `ActionBar.tsx` and `Grid.tsx` now render `nameHebrew`;
  the `<bdi>` wrappers stay load-bearing in both places — around the LTR
  roll-number traces, and around names, because the catalogue-miss fallback
  is still a Latin id.

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

### 4.5 Step 9 decomposition (designed 2026-08-20)

Step 9's narrative agent needs Hebrew names for every creature and action,
and a real player character to narrate about — neither existed: monster and
weapon data was English-only, and `goblin-ambush`'s hero was the `guard`
monster stat block borrowed as a stand-in (§4.3). Building the narrative
agent straight onto that foundation would mean building it twice, so step 9
splits into two specs, each with its own plan → implementation cycle.

**Spec #1 — player characters and SRD gear data.**
[`docs/superpowers/specs/2026-08-20-player-character-design.md`](docs/superpowers/specs/2026-08-20-player-character-design.md),
plan at
[`docs/superpowers/plans/2026-08-20-player-character.md`](docs/superpowers/plans/2026-08-20-player-character.md)
(16 tasks). Transcribes the SRD weapon, armor and skill tables into
`data/srd/`; builds `deriveCharacter` / `characterStatBlock` in
`@ai-dm/rules-engine` so a character's AC, speed, attacks and damage are
computed from equipped gear instead of hand-entered; gives `goblin-ambush`'s
hero a real `CharacterSheet` (server-side only — `loadCharacter` never
leaves `apps/server`) whose `DerivedCharacter` projection crosses HTTP
inside `EncounterCatalogue.characters`; and adds `nameHebrew` to every
creature, action, weapon and armor row plus a required `grammaticalGender` on
every character sheet.

Spec #1 **shipped on 2026-08-21**, merged to `main` as `7f99b38` (30 commits,
suite 931/71 → 1042/76). Correction C-13 is closed.

**Spec #2 — the narrative agent**, designed 2026-08-21:
[`docs/superpowers/specs/2026-08-21-narrative-agent-design.md`](docs/superpowers/specs/2026-08-21-narrative-agent-design.md).
It can now assume
Hebrew names on every creature and action, and a real `grammaticalGender` to
narrate by, rather than having to invent either at prompt time. Three
constraints it inherits from spec #1, none accidental: death saves are
implemented (`rollDeathSave`) but not driven by the encounter pipeline, so
`diesAtZeroHp` is pinned `true` and a hero dies at 0 HP rather than falling
Unconscious (§8 of `RULES_REFERENCE.md`); `DerivedCharacter`'s `z.record`
fields infer `Partial<Record<K, V>>` under zod 3, so a consumer reads
`savingThrows.str` as `number | undefined` even though the derivation always
fills every key; and the web client still renders `nameEnglish` inside
`<bdi>`, which is a deliberate follow-up rather than missing data.

The design keeps `NarrativePort` unchanged and puts a pure narration brief
between the engine and both narrators: the rules engine bands damage into a
severity rather than handing the model a number, the deterministic renderer
is rewritten in Hebrew so a failed provider never prints English, and the
pipeline owns one degradation ladder covering both a provider error and a
spent turn budget. It folds in two of the three inherited constraints: the
web client switches to `nameHebrew`, closing the §4.4 follow-up, and the
`unconscious` beat is rendered but stays unreachable while `diesAtZeroHp`
is pinned. It also closes §4.1's "Step 9" rules-digest task, for the
narrative role only — wiring the digest into the tactical prompt would
change the prompt the step 7b benchmark measured, which is the sole
justification for `DEFAULT_MODEL_ROUTING.tactical`.

Spec #2 **shipped on 2026-08-21**, commits `f7b623b..e033e5d` (34 commits;
suite 1042/76 → 1196/86 — schemas 140, rules-engine 402, web 96, agents 237,
sim 194, server 127), all green under `pnpm test`, `pnpm typecheck` and
`npx eslint packages apps tools`.

**Measured against the exit criterion.** Time to first token, four live
9-sample runs against `claude-sonnet-5` at prompt version `2026-08-21.1`,
re-measured at commit `13eab18` after the benchmark's own `SCENE_ENGLISH` scene
card was corrected (below): per-run p50 1340, 1156, 1634, 1058 ms — three of
four pass, the third run the outlier this time. Pooled across all four (n=36),
**p50 = 1340 ms**, which meets the criterion, and the same caveat still travels
with the number: still only 20 of 36 samples (56%) land under 1500 ms —
unchanged from the previous measurement — and a single 9-sample run can still
land on either side of the line: the third one read 1634 ms and would have
looked like a miss on its own. Pooled p95 = 4466 ms, mean 2074 ms, min 966 /
max **13332 ms** — the tail got *worse*, not better, than the previous
measurement's p95 3397 ms and max 7865 ms, and that still matters for the same
reason: narration shares its one 10s turn budget with the tactical call that
precedes it on a hostile turn, and this run's worst sample alone would have
exceeded that budget. Small samples, real variance, recorded rather than
smoothed. Artifacts: `tools/sim/runs/live-narrative-*/report.md`, eight runs
committed in total — these four (commit `13eab18`) plus the four superseded
runs kept as the record of what was measured and why it needed correcting. Both
sets stamp `promptVersion: 2026-08-21.1` — the shipped prompt never changed,
only the benchmark's own scene-card fixture did — so it is the commit each
report names, not the prompt version, that tells the two sets apart, and they
must not be pooled together.

**Output discipline**, all 36 samples: zero digit violations, zero non-Hebrew
outputs, zero over-length outputs, zero errored streams — as before. The corpus
counter matches literal digit characters only, so a number spelled out in
Hebrew words needs a human to catch it; this document used to state that as a
hypothetical gap, and it no longer should, because it was real. Under the
superseded scene card, the committed corpus read "...ומביט בשני הגובלינים..."
("...looking at the two goblins..."), naming in words the exact count the
card's own roster had handed the model — the `/[0-9]/` counter scored that
sample clean — and the same corpus separately mis-narrated a downed she-wolf as
a "goblin-ess" (`הגובלינית`), primed by that same roster. Correcting
`SCENE_ENGLISH` to atmosphere only (ground, light, sound; no creature count, no
roster) removed the card as a source of either error: a manual reread of all 36
re-measured samples finds neither recurring anywhere — the wolf sample narrates
the wolf throughout, and no sample states a creature count as a numeral. The
counter's blind spot is not fully closed, though. Two samples reach for `היחיד`
("the sole one") to state a creature count in words instead — and one of them
is not merely a stylistic word choice but a narration contradicting the board
state its own prompt supplied: a felling `critical_hit` leaves the FIGHT PULSE
reading `hostilesStanding: one` ("Enemies still standing: one" in the rendered
prompt), yet the model narrates `אלדד נותר לרגע היחיד הזקוף` ("Eldad remains
for a moment the only one standing") — false, since a hostile is still standing
too. That is a real, observed instance of the limitation this spec's own
Limitations section already names as undetectable at runtime — "a fact the
board contradicts" — seen once in 36 samples, not only in the abstract. The
other, `באויב היחיד שעדיין עומד מולה` ("the sole enemy still standing before
her"), is true of the board but still a count in words. Separately, three of
the 36 samples (four occurrences — one sample uses it twice) reach for `אחת`
("one") for emphasis rather than from the scene card — "בתנופה אחת חדה" (in one
sharp lunge), "בבת אחת" (all at once), "במכה אחת" (in one blow) — the same
blanket rule, the same digit-only blind spot, but nothing false about the board
this time. Every instance in both groups was found by rereading the corpus;
none of it registers on the counter.

**Cost, across the four runs, not a single figure:** $0.0017–$0.0024 per
narration, $0.0152–$0.0212 per 9-sample run — up from $0.0015–$0.0018 and
$0.0135–$0.0163 in the previous measurement. `usage.promptTokens` still reads
exactly 939 across all nine calls of a run, unchanged from before, so the rise
is a completion-token effect — longer sampled outputs this round — not a
prompt-side one, while the static prompt tier alone is ~1455 tokens by a
chars÷4 estimate (5820 characters ÷ 4), a heuristic that
understates the Hebrew glossary segment — Hebrew tokens cost roughly twice a
Latin-script character's share (root `CLAUDE.md`, invariant 2) — so the true
static-tier count runs higher than 1455. Anthropic's `input_tokens` also
excludes both `cache_read_input_tokens` and `cache_creation_input_tokens`
(`packages/agents/src/providers/vercel.ts` passes the SDK field through
verbatim), and that cuts both ways rather than settling anything. A rough,
unmeasured estimate — ~1455 static tokens × nine calls, plus each call's
dynamic beats/pulse/history — puts an unshared-prefix run at roughly 14k prompt
tokens, well above the measured 939, which is consistent with the static tier
being recognized as a cacheable block. It is equally consistent with every one
of those nine calls paying to *write* that block rather than *read* it, since a
cache write is excluded from `input_tokens` exactly like a cache read is.
Cached-token share is not measurable at all in this repo to settle which: no
`TokenUsage` field and no adapter surfaces a cache-read or cache-write count.
Recorded as unavailable, never as a number, mirroring the same honest gap §4.3
already recorded for the tactical role.

**Fallback rate**, from a browser play-through of two `goblin-ambush`
sessions to a conclusion (one won, one lost), 14 narrated turns, party and
hostile reported separately as the design requires: party turns 6, 1
fallback (17% — model 5, completed 1); hostile turns 8, 1 fallback (12% —
model 7, deterministic 1); all turns 14, 2 fallbacks (14%). Narration
latency median 5788 ms, max 10002 ms, exactly one turn hitting the 10s
budget. All three narration sources fired in production, unprompted:
`model`, `deterministic` (that hostile turn's own `narrative_stream_finished`
recorded `error=None` and no usage, which rules out an in-band provider
error — `hebrew.ts` would have set `error` — so the shared turn deadline cut
the stream before its first token), and `completed` (latencyMs 10002 — the
deadline cut the stream mid-word and the pipeline appended the `… ` seam
plus the deterministic Hebrew, visible mid-sentence in the UI). One observation
worth recording honestly: the hostile fallback rate came out *lower* than
the party rate, where the design anticipated the opposite; n=14 is far too
small to overturn that reasoning, so it stands as an observation, not a
finding. Rendering held throughout: combatant names, action names and the
roll log all render Hebrew, digit runs sit LTR inside RTL text exactly as
the `<bdi>` wrappers intend, and nothing renders reversed or mirrored.

**Limitations this spec knowingly ships**, from the design's own
accounting:

- Nothing validates the model's Hebrew at runtime; a hallucinated noun or a
  stray digit reaches the player.
- The `unconscious` beat is rendered but unreachable, because
  `diesAtZeroHp` stays pinned.
- A player's own free text is never reflected in the narration.
- The rules digest serves the narrative role only; the tactical prompt is
  untouched until a re-benchmark.
- The recent-narration window is two turns. A repetition at distance three
  is invisible to the narrator.
- The fight pulse assumes a single party combatant (ADR-0002).

The roadmap's step 9 row (§4 above) is now **🟡 agent shipped;
native-speaker review pending**: the agent is built, benchmarked live and
played through a full `goblin-ambush` encounter in Hebrew, and the
first-token criterion is met at the measured p50 above. The row's second
exit criterion is not met: the Hebrew review sheet
(`docs/prompts/hebrew-review-2026-08-21.md`) is generated and committed,
but no native speaker has read it yet, and the spec is explicit that the
sheet is not itself a blocking gate — putting a concrete artifact in front
of a reviewer, rather than holding the step open on a task only they can
perform.

### 4.6 Step 10 decomposition (designed 2026-08-22)

Step 10's row reads "pgvector episodic store, scene summarization, quest
DAG". Only the first of those has a consumer today, and none of them has a
place to live: `@ai-dm/memory` was three files and eight lines, all
`export {}`. So the step splits.

**Spec #1 — event-log persistence.**
[`docs/superpowers/specs/2026-08-22-event-log-persistence-design.md`](docs/superpowers/specs/2026-08-22-event-log-persistence-design.md),
plan at
[`docs/superpowers/plans/2026-08-22-event-log-persistence.md`](docs/superpowers/plans/2026-08-22-event-log-persistence.md).
Moves the `EventStore` contract out of `apps/server` — a Postgres store
cannot import it from there under invariant 5 — holds both implementations
to one conformance suite, and makes `DATABASE_URL` optional so the
in-memory path survives for tests and for `pnpm dev` without docker.

**Spec #2 — episodic memory**, not yet designed. It needs a scene-summary
producer and a prompt tier that reads retrieval back; today the narrator's
history is `recentNarrations`, a two-turn window of raw strings. It also
needs an embedding port, which does not exist in `@ai-dm/agents` and cannot
simply be imported: `@ai-dm/memory` depends only on `@ai-dm/schemas`. §4.7's
sequence step 7 records which of these the narrative foundation resolves and
which are still spec #2's to solve.

**The quest DAG is deferred out of step 10 entirely.** A grep for
"campaign" across the repo returns a line of `packages/memory`'s charter, a
comment on the static prompt tier, and that comment's copy in an older
spec — no code, no schema, no second encounter. `SessionState` is
combat-only. `quest_nodes` would be a table nothing reads, and the shape it
should have is not knowable until there is a campaign concept to serve.

### 4.7 The narrative layer — assessment and decomposition (designed 2026-08-23)

Ten of eleven roadmap steps built the tactical vertical. This section records
an audit of the other one, the decision that follows from it, and the
architecture proposed to close it.

#### What exists, and what only appears to

§1's diagram asserts a three-tier cascade over a world-state layer. Two of
those tiers and none of that layer are built. The narrative agent is real and
good, but what it is, precisely, is a combat commentator: its whole input is
one turn, a pulse, two prior narrations and a static scene card, and it can
change nothing (invariant 1, correctly). "Narrative layer" today means a prose
skin on the tactical layer.

The placeholders that assert intent without design:

- **`free_text` is closed.** It is in `ClientMessage`
  (`packages/schemas/src/protocol.ts:78`), and the pipeline answers every one
  with a `free_text_not_supported` error frame. It is the only door into
  open-ended play.
- **The intent tier is a stub.** `packages/agents/src/intent/index.ts` is
  `export {}` under a comment naming the right categories (`combat | check |
  social | exploration | ooc`). The cascade is two tiers, not three.
- **`intent_classified` is a reserved word** — in the `GameEvent` enum
  (`events.ts:16`), a no-op in `reduce` (`reduce.ts:87`).
- **`SessionState` is combat-only** (`protocol.ts:29`): grid, combatants,
  turn order, current actor, round, plus ids and idempotency. No world, no
  time, no location, no quest.
- **`scene_changed` is a combat signal with a narrative name.** Payload
  schema `{kind: string}`; `reduce` handles exactly one kind,
  `turn_advanced` (`reduce.ts:53`).
- **`CharacterSheet` carries no identity** — no bonds, ideals, flaws, goals
  or backstory. `nameHebrew` and `grammaticalGender` are the only
  non-mechanical fields, and the second exists for Hebrew verb agreement.
- **One encounter exists**, `GOBLIN_AMBUSH`, a TS const in
  `apps/server/src/encounters/index.ts:22`.
- **Session identity is encounter identity** — genesis payload is
  `{encounterId, rootSeed}` (`apps/server/src/core/session.ts:27`).
- `packages/memory/src/world-state.ts` and `episodic.ts` are both `export {}`.

Building the deterministic core first was the right order: it is the part a
capable model cannot paper over, and it is what makes the LLM safe to use at
all. But it has a consequence the roadmap did not record — steps 10 and 11
both stall, and the thing they stall on is not episodic memory or dashboards.
It is the entire non-combat half of the game.

#### Decision: the narrative foundation lands before the closed beta

Taken 2026-08-23. The work below refactors session identity, `SessionState`
and `reduce` — the load-bearing pieces. Doing it after a beta means either
migrating that beta's data or discarding it. Step 11 slips accordingly; step
10's spec #2 is folded into the sequence below rather than being attempted
against a corpus that does not exist.

#### The governing constraint

In combat, `validateExecuteTurn` adjudicates every LLM proposal. Out of
combat, if nothing adjudicates, an LLM mutates state and invariants 1 and 3
are both gone. **The answer is the same shape one level up:** a
`NarrativeMove` schema that a GM tier proposes, and a pure *scene engine* —
sibling to the rules engine — that validates it against world state (does
this NPC exist, is this edge reachable, is this exit open) before anything
becomes an event. Branching is then data, not prose.

#### Storyline and campaign progression

An authored quest DAG is the spine; simulation is texture. The DAG is
deterministic, testable and replayable, and it costs authoring effort; a
purely emergent world is cheap to author, nearly untestable, and puts an LLM
in charge of world state, which is the invariant-1 violation again. So: an
authored graph for the main arc, plus a few coarse dials (faction relations,
regional danger) that modify how a node *presents*, never whether it exists.

`QuestNode` carries preconditions as predicates over world state, a
`sceneEnglish` card, outbound edges, and effects declared as data and applied
by the engine. The intent router picks an edge, the engine checks its
predicate, the narrator describes the traversal.

This content is original, so it lives in `data/world/`, **not `data/srd/`** —
invariant 6 restricts that directory to SRD 5.2.1 CC-BY material and
`NOTICE.md`'s wording is fixed.

New event types: `quest_node_entered`, `quest_node_completed`,
`world_delta_applied`, `encounter_started`, `encounter_resolved`. Extending
the `GameEvent` enum trips `reduce`'s exhaustiveness check (`reduce.ts:85`)
by design.

**The campaign is the log; an encounter is a span within it.** `SessionState`
splits into a persistent `WorldState` and an `EncounterState` present only
during combat.

#### Worldbuilding and global state

Static lore — locations, factions, NPCs, history — is zod-validated content
in `data/world/`, loaded by a loader that throws rather than producing
something half-valid (the `buildEncounter` precedent). Events reference it
**by stable id, never embedded text**, so editing a lore file cannot
retroactively invalidate a replay.

Mutable world state is a projection of the log, in
`packages/memory/src/world-state.ts` — which is what invariant 3 forces and
what `packages/memory/CLAUDE.md:7` already commits to. The Postgres tables
are a materialized cache of that fold, the same relationship
`session_snapshots` has to `game_events`; `SNAPSHOT_EVERY = 50` generalizes
to keep a long campaign's fold affordable.

- **Calendar/time** advances only through explicit events — travel, rest,
  declared node effects. A wall-clock read makes replay diverge, the failure
  mode the `timestamp`-as-`text` decision already guards against (§4.6).
- **Faction relations** are a coarse scalar per pair (−3..+3, named bands),
  changed only by declared effects. A model reads a band name far more
  reliably than a number, and coarse buckets are much easier to assert on.
- **Regional danger** is derived from faction relations and quest progress,
  not stored. Derived state cannot drift.
- **Town events** carry a `scheduledFor` time and fire when the calendar
  crosses it — deterministic under replay because time is event-driven.

#### Character narrative profiles and memory

Narrative fields do not go on `CharacterSheet`: that schema is the rules
engine's input, and the rules engine must not grow a dependency on story
data. A separate `CharacterProfile`, keyed by `characterId`, splits the same
way the world does — authored (background, bonds, ideals, flaws, goals,
starting alignment) in `data/characters/`, earned (secrets learned, goals
advanced or abandoned, alignment drift, reputation) as a projection. The
split is not tidiness: the earned half must replay, the authored half must be
editable without invalidating replays.

**Alignment shifts are declared effects of specific logged choices, with a
reason — not a hidden morality meter.** A meter is untestable and is exactly
the quantity a model will hallucinate movement in. Logged shifts make "why
did my character become this" answerable from the event stream.

NPC affinity is the same pattern: a projection of `(npcId → band + remembered
facts)`. That remembered-facts list is what finally gives **episodic memory a
consumer** — a query a two-turn `recentNarrations` window genuinely cannot
answer, over a corpus (NPC-tagged scene summaries) that spans more than one
fight. Step 10's spec #2 becomes designable at that point and not before.

Cost consequence: the narrative prompt is layered for cache stability
(`static` / `semiStatic` / `dynamic`). Retrieved memories vary per turn, so
they land in the uncached tail — which interacts directly with the missing
`cache_read_input_tokens` field described under step 11 below.

#### Integration with tactical combat

A quest node declares an encounter by id with a narrow, schema'd
parameterization — spawn table, map, starting positions, surprise — and
`buildEncounter` then runs exactly as it does today. The bridge is
deliberately not a general hook: an open one would erode the tactical layer's
tested legality guarantees at the edges.

**An encounter's `rootSeed` derives from the campaign seed and sequence,
never fresh randomness.** Otherwise campaign replay diverges the instant a
fight starts. This generalizes the rule already in force per-turn
(`protocol.ts:31`).

`encounter_resolved` carries the outcome — survivors, HP, resources spent,
notable moments — feeding three consumers: world-state deltas via declared
effects, a scene summary for episodic memory, and quest-node preconditions
for what is now reachable.

Mode is campaign state (`exploration | social | encounter`), not a separate
system: combat is a bracketed span in one log. This is also what makes
`free_text` implementable and gives the intent router its reason to exist.
`abilityCheck` (`packages/rules-engine/src/checks/index.ts:66`) is already
built and tested, so out-of-combat skill checks come nearly free.

#### Sequence

0. **ADR: campaign vs. session identity** —
   [`docs/decisions/0004-campaign-vs-session-identity.md`](docs/decisions/0004-campaign-vs-session-identity.md),
   ACCEPTED. Load-bearing; everything below depends on it.
1. **Schemas and the `WorldState`/`EncounterState` split**, new event types,
   `reduce` refactor — while the log is small and no users exist. **Landed**
   on branch `step-11-campaign-state-split` (all 8 tasks; not yet merged to
   `main`).
   [`docs/superpowers/specs/2026-08-23-campaign-state-split-design.md`](docs/superpowers/specs/2026-08-23-campaign-state-split-design.md),
   plan at
   [`docs/superpowers/plans/2026-08-23-campaign-state-split.md`](docs/superpowers/plans/2026-08-23-campaign-state-split.md).
2. **Static content loaders and a deliberately tiny authored world:** one
   town, two factions, three NPCs, a five-node arc. Enough to prove the
   pipeline, not to be good.
3. **Scene engine:** predicates, edge legality, declared effects. Pure,
   golden tests, no LLM.
4. **Intent router, `free_text`, out-of-combat ability checks.**
5. **The combat bridge:** `encounter_started` / `encounter_resolved`,
   deterministic seed derivation.
6. **Character profiles and NPC affinity projection.**
7. **Episodic memory (step 10 spec #2)** — now with a real consumer. §4.6
   left it undesignable for want of a corpus, a consumer and a producer.
   This sequence supplies all three, and closes one of §4.6's two named
   blockers but not the other — so what remains is stated here rather than
   left to be rediscovered at step 7:
   - *Corpus* — ADR-0004 makes `campaignId` the stream key and an encounter
     a bracketed span, so a log finally spans more than one scene. Before
     that there is nothing to retrieve over.
   - *Consumer* — step 6's NPC affinity projection (`npcId` → band +
     remembered facts) asks a question a two-turn `recentNarrations` window
     genuinely cannot answer.
   - *Producer* — `encounter_resolved` carries a scene summary, and this
     sequence adds the scene-summarizer tier that writes it. Spec #2 no
     longer has to invent its own summary producer, which §4.6 listed as a
     blocker.
   - *Still open — the embedding port.* §4.6's other blocker survives
     untouched: `@ai-dm/memory` depends only on `@ai-dm/schemas`
     (invariant 5), so an adapter living in `@ai-dm/agents` is unreachable
     from where the store lives. Nothing above adds a port. Deciding where
     it belongs is spec #2's first question, not a detail inside it.
   - *Still open — cost.* Embedding calls are a fourth per-turn cost source
     on top of intent, GM and scene summarizer, on the meter that is
     unreportable by construction until the fix below lands.
8. **Closed beta (step 11).**

Two items are independent of this ordering. The
`cache_read_input_tokens`-plus-pricing-relocation fix described for step 11
becomes *more* urgent, not less, because this sequence adds three model tiers
(intent, GM, scene summarizer) — four cost sources once step 7's embeddings
join them — and cost is currently unreportable by construction. And none of
the above requires party play — ADR-0002 stands.
