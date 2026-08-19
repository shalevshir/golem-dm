# Web client: RTL Hebrew combat UI over the frozen protocol — design

Spec #2 of step 8. Spec #1 (the server slice) is merged at `cada052`;
`apps/server` plays a full combat over a websocket and the suite stands at
791 tests. This spec covers `apps/web`, whose `src/main.tsx` is still an
`export {}` stub.

Exit criterion: a human opens a browser, fights the `goblin-ambush`
encounter to its conclusion, and can refresh mid-fight without losing the
session.

## Context

`apps/web/CLAUDE.md` already fixes the boundary: **zero game logic in the
client.** It renders server state and sends intents; every rules question is
answered by server-provided affordances, never recomputed locally. Root is
RTL Hebrew. The client depends only on `@ai-dm/schemas` (invariant 5).

Reading the frozen protocol against that promise turned up six gaps. They
are the reason this spec exists in the shape it does, so they are recorded
here rather than left to be rediscovered.

1. **There are no affordances.** `ServerFrame` is
   `session_state | event | narrative_token | rejected | error`. Nothing
   carries reachable tiles or legal actions, so a clickable grid cannot show
   where you may move without recomputing legality — which invariants 1 and
   5 both forbid.
2. **Combatants have no display name.** `Combatant` carries `combatantId`
   and nothing human-readable. `nameEnglish` lives on stat blocks, which are
   deliberately excluded from `SessionState` ("static per encounter,
   re-derived from `encounterId`") and are loaded server-side via `node:fs`.
3. **The spec-#1 fallback for sharing `reduce` was blocked.** Spec #1 said
   `reduce` could move to `@ai-dm/schemas` if sharing proved awkward. It
   cannot move as written: `reduce` imports `startTurn` from
   `@ai-dm/rules-engine`, which would invert the dependency direction.
4. **Nothing acknowledges a command.** A duplicate `clientMessageId` yields
   zero frames by design, so a retrying client cannot distinguish "applied"
   from "swallowed".
5. **Human actions must carry an English rationale.** `ExecuteTurn` requires
   `tacticalRationaleEnglish` and the protocol states there is no second
   action format for players. The client must synthesise it.
6. **There is no "combat over" frame.** Per corrections C-31 and C-37 the
   hero dies (no PC data exists, so `diesAtZeroHp` is true for everyone),
   and the pipeline then returns without emitting a terminal event — further
   commands answer `not_your_turn`. A UI that waits for a victory frame
   hangs forever.

## Decisions

- **The protocol accepts additive changes.** New `ServerFrame` variants and
  new fields are allowed; changing or removing anything existing is not.
  Server and client ship together, so there is no deployed old client to
  break. This is what keeps the client honestly logic-free instead of
  pushing rules into it.
- **The client folds, and re-snapshots to resync.** It applies each `event`
  frame incrementally and treats `session_state` as authoritative whenever
  one arrives. Folding preserves the per-event granularity a turn animation
  needs; the resync bounds any divergence to a single turn instead of
  letting it persist silently.
- **One fold, living in `@ai-dm/schemas`.** See "Package moves" below.
- **Affordances are pushed per turn; static facts are fetched once.** Each
  piece of data travels on the channel matching its lifetime.

## Non-goals

- **Free-text input.** The server answers every `free_text` message with
  `free_text_not_supported` by design in this slice, so the box could only
  ever show an error. It ships when the intent agent does.
- **Move-then-attack previews.** `ExecuteTurn` allows ordered
  move–attack–move segments, but affordances are computed from the current
  projection, so highlights do not update between segments of a planned
  move. Revisit only if playing the POC shows it is missed; the fix is a
  client-requested affordance recompute, which adds a request/response shape
  to an otherwise push-only protocol.
- **Hebrew monster names.** No translation data exists anywhere in the repo;
  the SRD is English. See "The Hebrew name gap".
- Auth, a session browser, more than one concurrent session per tab, and
  anything WebGL (`apps/web/CLAUDE.md` requires a perf-based ADR first).

## Package moves: one fold, shared

`apps/server/src/core/reduce.ts` moves to `packages/schemas/src/reduce.ts`,
with its test file. `apps/server` then imports it from `@ai-dm/schemas`.
This is spec #1's own stated fallback, and gap 3 is the reason it needs one
adjustment to be legal:

- `reduce`'s single engine dependency is `startTurn()`. Replace it with
  `ActionEconomy.parse({})`, which is schemas-only and — verified
  field-for-field — produces the identical
  `{actionUsed: false, bonusActionUsed: false, reactionUsed: false,
  movementUsedFeet: 0, attacksMade: 0}`.
- To stop that equivalence rotting into two definitions that must agree,
  redefine `@ai-dm/rules-engine`'s `startTurn()` as `ActionEconomy.parse({})`
  as well. One definition, two call sites.

Constraint: `packages/schemas` is bundled for the browser, so nothing moved
there may import a Node built-in. `reduce` imports only `zod` and schema
types, so it qualifies as-is.

Invariant 5 stays literally true — `web` still depends only on
`@ai-dm/schemas`. Note `reduce.ts`'s current header says a client should run
an *equivalent* fold rather than reuse this module; that comment is
superseded by this spec and must be rewritten, not left contradicting it.

## Rules engine: affordances derived from the validator

A new `affordancesFor(world: CombatWorld, actorId: string)` in
`packages/rules-engine/src/combat/`, beside `validate-turn.ts`.

**It must not be a parallel implementation of legality.** The failure this
design exists to prevent is a client highlighting a tile the server then
rejects. So affordances are derived by *enumerating candidates and running
the real validator*:

- Reachable tiles: enumerate tiles within the actor's remaining movement
  budget (`speedFeet` minus `actionEconomy.movementUsedFeet`, so a partially
  moved actor narrows correctly), and keep each one `validateExecuteTurn`
  accepts as a move destination.
- Targetable combatants: for each action the actor's stat block grants,
  keep each combatant `validateExecuteTurn` accepts as a target.

A 30 ft mover on a 5 ft grid reaches a diamond of ~113 tiles, so this is
low hundreds of validator calls per turn — irrelevant next to a model call,
and it *cannot* diverge from the validator, because it is the validator.
The existing `findPath`, `movementCostFeet`, `tileDistanceFeet`,
`hasLineOfSight` and `coverBetween` supply the candidate enumeration.

Per `packages/rules-engine/CLAUDE.md`, this needs golden tests: reachability
narrowing after partial movement, terrain and occupancy exclusions, and
agreement with `validateExecuteTurn` on a case the validator rejects.

## Protocol additions

One new `ServerFrame` variant, added to `packages/schemas/src/protocol.ts`:

```ts
z.object({
  type: z.literal("turn_affordances"),
  actorId: z.string(),
  /** The projection these were computed from; the client discards a frame
   *  older than the state it currently holds. */
  forSequence: z.number().int().min(0),
  reachableTiles: z.array(Tile),
  actions: z.array(z.object({
    actionId: z.string(),
    /** Distinguishes "needs no target" (Dodge) from "needs one and none is
     *  in range", which an empty list alone cannot express. */
    requiresTarget: z.boolean(),
    targetableCombatantIds: z.array(z.string()),
  })),
})
```

Ids only — no display names, which are static and belong in the catalogue.

**`handleCommand` yields it, not the transport.** Spec #1's rule is that
`core/` never touches a socket and `transport/` "parses with the schemas,
validates, pumps frames, and nothing else". Computing affordances means
calling the rules engine, which is not pumping frames — so the frame is
yielded from the pipeline like every other `ServerFrame`, at the two points
the pipeline already knows the player is up: when a `join` finds it is the
player's turn, and after a turn resolves with the actor back on the player.
The transport stays a pump.

**No ack frame is added.** Gap 4 is real but already answerable with what
exists: `SessionState.appliedClientMessageIds` *is* the idempotency
projection, and a `join` is now guaranteed exactly one response. A client
unsure whether its command landed re-joins with `resumeFrom` and checks
whether its `clientMessageId` appears in the snapshot. That reuses the
reconnect path the client needs anyway rather than adding a frame.

## HTTP additions

`GET /encounters/:encounterId` returns the static per-encounter facts,
fetched once at join and cached for the session:

```ts
{
  encounterId: string,
  combatants: Array<{ combatantId, nameEnglish, maxHp, faction }>,
  actions: Array<{ actionId, nameEnglish }>,
}
```

It is not a websocket frame because it never changes; sending it per turn
would waste wire on every turn of every session, on a socket already
carrying a `SessionState` that only grows (correction C-30). It 404s on an
unknown id via `instanceof UnknownEncounterError`, matching `POST /sessions`
(correction C-34).

## Client architecture

```
apps/web/src/
  main.tsx              React root; sets dir="rtl" lang="he"
  net/connection.ts     WS lifecycle, reconnect with resumeFrom, frame parsing
  net/api.ts            POST /sessions, GET /encounters/:id
  state/store.ts        SessionState + catalogue + affordances; the fold
  turn/build-turn.ts    selection -> ExecuteTurn
  components/Grid.tsx           Canvas 2D board
  components/NarrativePane.tsx  streaming Hebrew narrative
  components/ActionBar.tsx      action selection and commit
  components/ErrorBanner.tsx    server error codes, in Hebrew
```

**`net/connection.ts`** owns the socket. Every inbound frame is
`ServerFrame.parse(...)`, never a cast — spec #1's final review found both
server test helpers casting, which suppresses exactly the check that proves
the protocol holds. On disconnect it reconnects and re-joins with
`resumeFrom` set to the highest sequence it has folded.

**`state/store.ts`** holds the projection and applies `reduce` from
`@ai-dm/schemas` to each `event` frame. A `session_state` frame replaces
state wholesale. A `turn_affordances` frame whose `forSequence` is older
than the held state is discarded.

**`components/Grid.tsx`** is Canvas 2D (`apps/web/CLAUDE.md` caps the POC at
30×30 and forbids WebGL without an ADR). It renders terrain, combatant
tokens, and highlights drawn *only* from `reachableTiles` and
`targetableCombatantIds`. It computes no distances and knows no rules.

**`turn/build-turn.ts`** assembles the `ExecuteTurn`, including gap 5's
`tacticalRationaleEnglish`. The client synthesises a factual English
description of what the player selected — for example
`"Player selected: move to (6,4); attack goblin-a with scimitar."` It is
never player-authored: the field is English by invariant 2 and the player is
typing Hebrew or not typing at all. It exists so the log and the agent path
carry the same shape.

**Conclusion detection** reads the projection, never a frame: group living
combatants by faction, and when fewer than two factions have a living member
the fight is over. The party is expected to *lose* (correction C-31) — the
hero borrows the `guard` stat block, so `characterId` is undefined and the
hero dies rather than falling unconscious. The UI must render a defeat
outcome as a normal ending, not an error.

## Error handling

`rejected` frames carry `TurnRejectionReason` codes as open strings; the
client maps known codes to Hebrew messages and falls back to the English
code for unknown ones. `error` frames map by code:

| Code | Client behaviour |
|---|---|
| `not_your_turn` | Ignore silently — a stale click, and the affordance frame governs |
| `turn_in_progress` | Disable input until the turn's frames finish arriving |
| `unknown_session` | Return to the start screen; the session is gone |
| `free_text_not_supported` | Unreachable — no free-text UI ships |
| `malformed_message` | Surface loudly; it is a client bug |
| `internal_error` | Surface, and offer reconnect |

## RTL and mixed direction

Root is `<html dir="rtl" lang="he">`. Per `apps/web/CLAUDE.md`, mixed-direction
text is the single most common Hebrew UI bug, so every embedded LTR fragment
— dice notation (`2d6+3`), English names, tile coordinates — is wrapped in
`<bdi>`.

### The Hebrew name gap

There is no Hebrew name data anywhere in the repo, and the SRD is English
(ADR 0001 restricts content to SRD 5.2.1). So the catalogue's `nameEnglish`
is all a token label can show, and the grid renders English names inside an
RTL Hebrew UI — precisely the mixed-direction case above, which is why the
`<bdi>` rule is not optional here.

This is a recorded gap, not a solved problem. Adding a `nameHebrew` field is
a data question (who writes the translations, and are they licensable
alongside SRD content), not a rendering one, so it is deliberately left to
whoever adds player-character data.

## Testing

Per `apps/web/CLAUDE.md`: Vitest with `@testing-library/react`, mocking the
websocket. Required:

- **Fold parity.** The client's fold over a recorded event log equals the
  server's projection over the same log. This is the guard that the `reduce`
  move did not change behaviour, and it fails loudly if the two ever drift.
- **RTL rendering** with mixed Hebrew and dice notation, asserting the `<bdi>`
  wrapping — the one test `apps/web/CLAUDE.md` names explicitly.
- **Reconnect.** Drop the socket mid-fight, re-join with `resumeFrom`, assert
  the client's state equals the server's projection.
- **Affordance rendering.** The grid highlights exactly the tiles in
  `reachableTiles` and no others — the test that the client is not quietly
  computing reach.
- **Conclusion from projection.** A log ending in the hero's death renders a
  defeat outcome without any terminal frame.

## Development setup

The Vite dev server proxies `/sessions`, `/encounters` and `/ws` to
`localhost:3000`. A proxy rather than CORS middleware: it needs no server
change and adds no cross-origin surface to an API that has no auth.

## Consequences

- `apps/server` imports `reduce` from `@ai-dm/schemas` after the move; its
  event-sourcing behaviour is unchanged and the existing replay and
  determinism properties are the regression net for that.
- `PROJECT_PLAN.md` step 8 flips from `🟡 server done, web pending` to done
  when this ships.
- The deferred move-then-attack preview is the most likely first follow-up,
  and it is a protocol addition (a client-sent affordance request), not a
  client-only change.
