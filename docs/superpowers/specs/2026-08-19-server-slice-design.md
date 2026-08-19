# Server slice: event-sourced turn pipeline over Fastify + WS — design

Roadmap step 8 (`PROJECT_PLAN.md` §4), first of two specs. Step 8's exit
criterion is "full combat playable E2E vs scripted enemy"; this spec covers
everything except the web client — encounter-engine promotion into
`@ai-dm/rules-engine`, the wire protocol in `@ai-dm/schemas`, the narrative
stand-in in `@ai-dm/agents`, and `apps/server` itself. A second spec covers
`apps/web` against the protocol this one freezes. "Playable E2E" is met here
by a scripted WS client driving a full combat; the clickable canvas arrives
with spec #2.

## Context

`apps/server/src/main.ts` is a stub. What exists underneath it:

- `validateExecuteTurn` (`packages/rules-engine`) — the legality gate,
  returning a `TurnPlan` or stable `TurnRejectionReason` codes.
- The tactical agent (`packages/agents`, step 7a) — `proposeTurn` with the
  mandatory validate → retry-once → `deterministicFallback` loop, plus
  `createTimingPort` for per-call latency/token/cost numbers.
- `applyTurn` (`tools/sim/src/engine/resolve.ts`) — the move → swing →
  damage → die state transition. Its own header calls it "the sim's stand-in
  for the server's turn pipeline (step 8)". It lives in a package nothing may
  depend on, so promoting it is this spec's first move.
- `GameEvent` (`packages/schemas/src/events.ts`) — the append-only log entry
  type, with `ActionRejectedPayload` already shaped for the server to stamp.

Two things the handoff assumed exist but do not: `@ai-dm/memory` is 8 lines
of comments (its `package.json` already declares drizzle + postgres, only
code is missing), and `intent/` + `narrative/` in `@ai-dm/agents` are empty
stubs. This spec builds neither the Postgres slice nor the intent agent —
see Non-goals — but it does define the ports both will implement.

Invariants that shape everything below: #1 (rules engine is the only
authority — the server never computes legality or damage), #3 (event log is
the source of truth — state is a projection), #4 (schemas define everything
once — the wire protocol is zod in `@ai-dm/schemas`), #5 (`web` depends only
on `schemas` — another reason the protocol lives there).

## Non-goals

- **Postgres persistence.** The `EventStore` port ships with an in-memory
  implementation only. The port is shaped around the eventual SQL (atomic
  batch append, `(session_id, sequence)` uniqueness) so the drizzle
  implementation in `@ai-dm/memory` is a second implementation of an
  interface, not a refactor. Sessions do not survive a server restart yet.
- **The intent agent and free-text play.** `free_text` exists in the
  protocol envelope (with its length cap) so adding the branch later does
  not reshape the protocol, but the pipeline answers it
  `error { code: "free_text_not_supported" }`. The intent agent gets built
  when something can turn language into actions — until then it has no
  consumer.
- **The real narrative agent.** Step 9. This spec defines `NarrativePort`
  and ships `deterministicNarration`; step 9 is a port swap.
- **The web client.** Spec #2, against this protocol.
- **Multi-session-per-socket, spectators, parties.** ADR 0002 is solo; one
  socket, one session, one player.
- **Choosing the tactical model.** 7b's report does that; the server reads
  `ModelRouting` from config either way.

## Package moves: encounter code into the rules engine

`@ai-dm/rules-engine` gains `src/encounter/`:

- **`applyTurn`** moves from `tools/sim/src/engine/resolve.ts` with
  `TurnEffect`, `AttackRecord`, `ResolveContext` and its test file. It
  already imports only from `@ai-dm/rules-engine` and `@ai-dm/schemas` — a
  move, not a rewrite. Its header comment changes to say the sim and server
  both consume it.
- **`buildEncounter(definition)`** → `{ world, statBlocks, turnOrder,
  maxRounds }` — the agents-free half of the sim's `buildScenario`, together
  with `EncounterDefinition` / `SpawnSpec` / `TerrainOverride` (renamed from
  `ScenarioDefinition`; a scenario is a benchmark fixture, an encounter is a
  game object) and the `data/srd/monsters/` loader. The split is forced:
  `buildScenario` imports `AvailableAction` from `@ai-dm/agents`, which the
  engine may not depend on. The `availableActions` derivation moves to
  `@ai-dm/agents` as `availableActionsFor(statBlock)`.

`tools/sim` keeps `runEncounter` (a batch driver; the server's loop is
message-driven, the opposite shape) and `policy.ts`, and imports the moved
pieces. Sim behaviour must not change; its suite passing unmodified — except
imports — is the regression net for the promotion.

New rules-engine code means golden tests (`packages/rules-engine/CLAUDE.md`):
`buildEncounter` gets them; `applyTurn` brings its own suite along.

## Wire protocol (`@ai-dm/schemas`, new `protocol.ts`)

Session creation is HTTP, not WS: `POST /sessions { encounterId } →
{ sessionId }`. Creating a game is a one-shot request; folding it into
`join` would overload that message.

**`ClientMessage`** — zod discriminated union on `type`:

| Variant | Fields | Notes |
|---|---|---|
| `join` | `sessionId`, `resumeFrom?: number` | Binds the socket to one session; later messages carry no `sessionId` (solo, ADR 0002). |
| `structured_action` | `clientMessageId`, `actorId`, `turn: ExecuteTurn` | The same schema the tactical agent emits, validated by the same `validateExecuteTurn`. No second action format for players (invariant #4). |
| `free_text` | `clientMessageId`, `text` | `.max(500)` in the zod schema — oversized input dies at transport parse, before any prompt. Answered `free_text_not_supported` in this spec. |

**`ServerFrame`** — zod discriminated union on `type`:

| Variant | Fields | Notes |
|---|---|---|
| `session_state` | `sequence`, `snapshot: SessionState` | Projection at a point in the log. Sent on join without `resumeFrom`, or when `resumeFrom` predates the retained log. |
| `event` | `event: GameEvent` | The primary channel. The client's state is a fold of these — the same `reduce` the server runs. |
| `narrative_token` | `streamId`, `text` | Transient, deliberately outside the sequence — see below. |
| `rejected` | `clientMessageId`, `reasons`, `messages` | The player's rejection channel; carries `TurnRejectionReason` codes. |
| `error` | `clientMessageId?`, `code`, `message` | Protocol-level: malformed message, `turn_in_progress`, `free_text_not_supported`, unknown session. |

There is no `your_turn` frame: whose turn it is is in the projection, and a
separate frame would be a second source of truth.

**Narrative tokens are outside the event sequence.** The log gets one
`narrative_emitted` event with the full text on completion. A client
reconnecting mid-stream never sees the tokens — it gets the completed event
on replay. The client renders tokens optimistically and reconciles against
the event; a dropped stream degrades to text appearing at once, not a gap.

**Reconnect.** `join { resumeFrom: n }` replays every event with
`sequence > n` in order, then goes live. Without `resumeFrom`, or when `n`
predates the retained log: `session_state` at the newest snapshot, then the
events since. Snapshots every 50 events (`apps/server/CLAUDE.md`).

**Idempotency falls out of the log.** `player_input` payloads carry
`clientMessageId`, so "already applied?" is a question about the projection
— no per-connection dedup state, and it survives reconnect for free. A
client resending after a dropped ack gets the original outcome replayed,
not a second turn.

## Server architecture: event-sourced core, thin transport

Chosen over a Fastify-native orchestrator (every pipeline test would need a
live socket, and the mandated replay-equivalence test becomes hard to
express) and over stateless replay-per-command (right insight — the
projection must be a pure fold — kept here as a tested property instead of
a runtime cost).

```
apps/server/src/
  core/       session.ts  reduce.ts  pipeline.ts  event-store.ts
  transport/  ws.ts  http.ts
  config.ts   main.ts
```

`core/` never touches a socket. `transport/` parses with the schemas,
validates, pumps frames, and nothing else.

### The pipeline

```ts
async function* handleCommand(
  session: Session,
  command: ClientMessage,
  ports: TurnPorts,   // store, tactical, narrative, rng, clock, uuid, timeoutMs
): AsyncIterable<ServerFrame>
```

One rule inside it: **appending an event and yielding its frame is one
operation.** No path does one without the other, so the socket can never
show an event that was not logged or miss one that was. `clock`, `uuid` and
`rng` are ports, not globals — that is what makes exact-event-stream
assertions possible.

Structured action path:

1. Dedup on `clientMessageId` against the projection; a duplicate is
   dropped silently (the client already has the events via replay).
   Otherwise append `player_input`.
2. `validateExecuteTurn`. Rejection → append `action_rejected`, yield
   `rejected`, turn does not advance. A human gets no auto-retry — that
   loop exists because a model cannot read a UI.
3. On a plan: append `action_validated`, run `applyTurn`, append
   `dice_rolled` and `state_delta_applied`.
4. `narrative.stream(effect)` yields `narrative_token` frames;
   `narrative_emitted` appended on completion.
5. Advance turn order; while the current actor is hostile: tactical agent →
   validate → retry once → `deterministicFallback` (the loop is inside
   `proposeTurn`, step 7a), every rejection appended as `action_rejected`
   stamped per `ActionRejectedPayload`, then the same apply-and-narrate.
   Stops at the player's turn or encounter end.

**Seeded dice.** A turn's seed derives from `(rootSeed, sequence of the
turn's action_validated event)` at play time and is recorded in
`dice_rolled`. Replay reads the seed from the event
rather than re-deriving it — the log stays authoritative and the two paths
agree by construction.

**Timeouts.** A 10s hard cap wraps the narrative stream and the tactical
call; on expiry `deterministicNarration` renders the `TurnEffect` and the
turn completes. A provider failure is already a `deterministicFallback`
inside the tactical agent — no pipeline path can hang on an LLM.

**Concurrency.** One command in flight per session. A command arriving
mid-turn gets `error { code: "turn_in_progress" }`, not a queue — a queued
stale click would land against a changed board and fail validation for
reasons the player cannot see.

### State: a fold, and only a fold

`reduce(state, event) → state` — pure, total, exhaustive over event types.
`SessionState` is fully serializable:

```
{ sessionId, rootSeed, encounterId, grid, combatants,
  turnOrder, currentActorIndex, round, appliedClientMessageIds }
```

Stat blocks are not in it: static per encounter, re-derived from
`encounterId` via `buildEncounter`. `CombatWorld` is assembled on demand by
pairing state with the injected `lineOfSight`, so the non-serializable
algorithm never enters the snapshot.

### `EventStore` port

```ts
append(sessionId, events: readonly GameEvent[]): Promise<void>  // atomic batch
readSince(sessionId, afterSequence: number): Promise<GameEvent[]>
latestSnapshot(sessionId): Promise<{ sequence: number; state: SessionState } | null>
putSnapshot(sessionId, sequence: number, state: SessionState): Promise<void>
```

`append` is an atomic batch because a turn emits several events and a crash
mid-turn must not leave half a turn in the log — that is what makes the
Postgres version a transaction rather than a redesign. It conflicts on
`(sessionId, sequence)`; the in-memory implementation enforces the same
conflict so the two cannot drift. Snapshots are a cache, never authority: a
test asserts `fold(events)` equals the snapshot at every snapshot point, so
a wrong snapshot fails loudly instead of forking state.

## Narrative stand-in (`@ai-dm/agents`, `narrative/`)

`NarrativePort`: `stream(input: NarrationInput) → AsyncIterable<string>`,
where `NarrationInput` carries the `TurnEffect`, actor and target names,
and `grammaticalGender`. Ships with `deterministicNarration` — a template
renderer over the rule outcome ("Goblin hits Fighter for 5 slashing").
This is the same fallback narration `apps/server/CLAUDE.md` requires for
the 10s timeout, so it must exist regardless; building it as the default
port means streaming frames, the timeout path and `narrative_emitted` are
exercised from day one, and step 9 becomes a port swap. Follows the
precedent of `deterministicFallback`, which `tactical/` already exports.

The stand-in emits English. Hebrew arrives with the real agent in step 9 —
the port's contract (a token stream) is language-neutral, and shipping
throwaway Hebrew templates would buy nothing but translation review.

## Config

`config.ts` validates env with zod at boot, fails fast on missing keys:
`PORT`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`
(whichever the configured routing needs), `LOG_LEVEL`. No `DATABASE_URL`
until the Postgres spec. `apps/server/.env.example` is recreated with these
keys (it was deleted in `e92c285`, leaving `apps/server/CLAUDE.md` line 24
dangling — this fixes that). Model routing stays config
(`DEFAULT_MODEL_ROUTING` as the default, overridable), never code.

Per-turn instrumentation from day one via `createTimingPort`: tokens
in/out, cached tokens, latency, retries, cost, emitted as structured logs.

## Testing

Core, no socket anywhere:

- Pipeline tests drive `handleCommand` directly with a fake store, fixed
  `clock`/`uuid`/`rng`, and the mocked provider `@ai-dm/agents` already
  uses — asserting the exact event stream and the exact frame stream.
- Property tests: (1) fold-from-zero equals live projection; (2)
  fold-from-snapshot-plus-events equals fold-from-zero; (3) reconnect at
  any sequence k leaves the client's fold equal to the server's; (4)
  identical `rootSeed` + identical commands → identical event stream.
- The in-memory `EventStore` is tested against the port contract
  (atomicity, sequence conflict) so the Postgres implementation inherits
  the suite.

Transport, thin: `fastify.inject` for `POST /sessions`; a real ws client
for join → action → frames, replay-on-reconnect, and malformed-message
rejection.

E2E, closing the step's criterion: a scripted WS client plays a full
combat — join, alternate player actions with enemy turns, run to a winner —
with the mocked provider, asserting the final projection and that a
mid-fight reconnect resumes identically.

Rules engine: `buildEncounter` golden tests; `applyTurn`'s moved suite; the
unmodified sim suite green as the promotion's regression net.

## Consequences for the rest of step 8

- Spec #2 (web) builds against a frozen `ClientMessage`/`ServerFrame` and
  reuses the server's `reduce` — invariant #5 allows it, since `reduce`
  operates on schema types. If sharing the function itself proves awkward
  across the app boundary, `reduce` moves to `@ai-dm/schemas`' sibling
  utility space rather than being reimplemented.
- The Postgres spec implements `EventStore` in `@ai-dm/memory` with
  drizzle (deps already declared), plus the append→replay→identical-
  projection round-trip its CLAUDE.md requires.
- Step 9 swaps `NarrativePort`'s implementation and touches nothing else
  in the pipeline.
