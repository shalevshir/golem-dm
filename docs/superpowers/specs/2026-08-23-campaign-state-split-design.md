# Campaign state split — design

Step 1 of `PROJECT_PLAN.md` §4.7, and the first code to follow
[ADR-0004](../../decisions/0004-campaign-vs-session-identity.md). It builds no
story: no quest nodes, no factions, no calendar, no NPCs, no free text. It
performs the structural refactor those things need underneath them — the event
stream becomes a campaign, the projection splits in two, and an encounter
becomes a bracketed span rather than the whole of existence.

This is deliberately the least interesting change in §4.7's sequence and the
one that must land first. It touches session identity, `SessionState` and
`reduce`, which is exactly why it is scheduled before the closed beta puts data
in Postgres (§4.7's decision).

Exit criterion: the existing suite passes with renames only and no behavioural
diff — a fight plays identically — plus new coverage proving one campaign can
run two encounters in sequence, that a combat event outside a bracket is
refused, and that a campaign spanning two encounters replays to an identical
projection.

## Context

Facts checked against the repo rather than recalled.

**`SessionState` is eight fields and all of them are combat**
(`packages/schemas/src/protocol.ts:29`): `sessionId`, `rootSeed`,
`encounterId`, `grid`, `combatants`, `turnOrder`, `currentActorIndex`,
`round`, `appliedClientMessageIds`. There is no world, no time, no place.

**Five of them are never written by `reduce`.** `initialState`'s doc comment
(`apps/server/src/core/session.ts:63`) names them: `sessionId`, `rootSeed`,
`encounterId`, `grid`, `turnOrder`. That is the seam the split follows almost
exactly — the immutable five are campaign identity plus encounter setup, and
the mutable rest is encounter progress.

**`reduce` meaningfully handles three event types of ten.** `player_input`
appends an idempotency key, `state_delta_applied` replaces combatants, and
`scene_changed` advances the turn. The other seven return `state` unchanged,
listed explicitly so a new type fails the exhaustiveness check
(`packages/schemas/src/reduce.ts:85`).

**`scene_changed` is a combat signal wearing a narrative name.** Its payload
schema is `{kind: string}` and `reduce` acts on exactly one kind,
`turn_advanced` (`reduce.ts:53`).

**`session_snapshot` as an *event type* is genesis and nothing else.** Its only
non-test write is `createSession` (`session.ts:106`) and its only read is
`loadSession`'s guard (`session.ts:134`). The `session_snapshots` *table* is
written by `putSnapshot`, never by an event. Two unrelated things share a name.

**Genesis rebuilds rather than persists.** `createSession`'s payload carries
only `{encounterId, rootSeed}`, and the comment above it is explicit that
`state` is deliberately absent — `loadSession` reconstructs `initialState` from
those two fields (`session.ts:96`). This pattern generalizes exactly: campaign
genesis carries the root seed, `encounter_started` carries the encounter id,
and both initial projections are rebuilt rather than stored.

**`seedFor` is already an injected port**, `(rootSeed, sequence) => number`
(`pipeline.ts:182`), implemented once in `main.ts:142`. ADR-0004's fourth
decision needs no new mechanism — only this port applied at one more sequence.

**Blast radius, measured:** 26 files reference `SessionState`; 36 reference
`sessionId` or `session_id`, 17 of them non-test. It spans all five workspace
packages that have code. This is a wide, shallow change, and the plan should
sequence it so the tree compiles between tasks rather than after all of them.

## Decisions

**1. The projection splits in two, and `mode` is not stored.**

```
CampaignState = { world: WorldState, encounter: EncounterState | null }
```

*This refines ADR-0004's second decision,* which listed a `mode` field. At this
step `mode` would be exactly `encounter === null ? "exploration" : "encounter"`
— derivable, and §4.7 already argues against storing what can be derived
(regional danger, for the same reason). The three-valued enum earns its place in
§4.7's step 4, when exploration and social actually diverge. The ADR is still
PROPOSED and should be amended rather than contradicted.

**2. `WorldState` starts nearly empty, and that is the point.**

`{ campaignId, rootSeed, appliedClientMessageIds }`. The dials — calendar,
faction relations, current quest node — arrive in §4.7's steps 2 and 3. A step
that both restructures the projection *and* fills it is not reviewable.

`appliedClientMessageIds` moves to the world, not the encounter: idempotency
has to survive an encounter ending, and it must cover free text and narrative
moves later, not only turns.

**3. `EncounterState` is what remains**, unchanged in shape and meaning:
`{ encounterId, grid, combatants, turnOrder, currentActorIndex, round }`.

**4. Three event types replace one.** `campaign_started` (root seed),
`encounter_started` (encounter id), `encounter_resolved` (outcome).
`session_snapshot` leaves the enum: its sole use was genesis, and the name
described the table rather than the event.

**5. Seeds use the existing port, unchanged.** A turn's seed stays
`seedFor(world.rootSeed, sequence)` — the formula does not change, it simply
runs over the campaign's sequence space, which remains globally unique per
turn. Encounter-scoped randomness (rolled initiative, when it exists) uses the
same port at the `encounter_started` sequence. Nothing derives from fresh
randomness, so campaign replay cannot diverge at an encounter boundary.

**6. The rename reaches the wire and the schema.** `POST /sessions` becomes
`POST /campaigns`; `SessionCreated` becomes `CampaignCreated`; `join` takes
`campaignId`; the `session_state` frame becomes `campaign_state` and carries a
`CampaignState`. `game_events.session_id` becomes `campaign_id` and
`session_snapshots` becomes `campaign_snapshots`, with the drizzle baseline
regenerated rather than altered (ADR-0004).

**7. `recentNarrations` does not move.** It is on the server's `Session`
record, deliberately outside the projection (`session.ts:44`), and that
reasoning is untouched by this split. `Session` itself becomes `Campaign`.

## Non-goals

- **No story content.** No quest nodes, factions, calendar, NPCs, locations.
- **No new player-facing behaviour.** `free_text` stays closed, the intent
  router stays a stub, no out-of-combat checks. A player cannot tell this
  shipped.
- **No `mode` enum** (decision 1).
- **No episodic memory.** Step 10's spec #2 waits for §4.7's step 7.
- **No party play.** ADR-0002 stands.
- **No authored second encounter.** The machinery must support one and is
  tested for it; the catalogue still holds only `goblin-ambush`.

## Structure

**`@ai-dm/schemas`**
- `src/protocol.ts` — *modify.* `SessionState` → `WorldState` +
  `EncounterState` + `CampaignState`; frame and message renames.
- `src/events.ts` — *modify.* Enum: drop `session_snapshot`, add
  `campaign_started`, `encounter_started`, `encounter_resolved`; payload
  conventions for the three.
- `src/reduce.ts` — *modify.* The dispatch below.
- `src/reduce.test.ts`, `src/protocol.test.ts`, `src/events.test.ts` — *modify.*

**`@ai-dm/memory`**
- `src/schema.ts` — *modify.* Column and table renames.
- `drizzle/` — *regenerate.* New baseline.
- `src/event-store/port.ts`, `in-memory.ts`, `postgres.ts`, `validate.ts`,
  `contract.ts` — *modify.* `sessionId` → `campaignId`; `EventSnapshot.state`
  becomes `CampaignState`.
- `src/event-store/replay.test.ts` — *modify + extend.* Round-trip over a
  campaign spanning two encounters.

**`@ai-dm/server`**
- `src/core/session.ts` → `src/core/campaign.ts` — *rename + modify.*
  `initialState` splits into `initialWorldState` and `initialEncounterState`;
  `createCampaign` writes `campaign_started`; `startEncounter` writes
  `encounter_started`; `loadCampaign` rebuilds both.
- `src/core/pipeline.ts` — *modify.* Reads move behind `campaign.encounter`;
  the bracket guard below.
- `src/transport/http.ts`, `src/transport/ws.ts`, `src/main.ts` — *modify.*
- `src/encounters/index.ts` — *modify.* Unchanged catalogue, new call shape.

**`@ai-dm/web`** — `App.tsx`, `net/api.ts`, `net/connection.ts`,
`state/store.ts`, `state/conclusion.ts`, `state/persistence.ts` (landed in
`0b8e10f`), `components/Grid.tsx` — *modify.* `snapshot` becomes
`CampaignState`; board components read `snapshot.encounter`.

`state/persistence.ts` needs one judgement beyond the rename: it stores display
state keyed by session id and compares on the way back in. Keyed by campaign
id, that check now spans encounters, so a restored roll log can describe a
fight the campaign has already left. The sequence comparison in `applyFrame`
already guards it — the stored sequence will not match a post-`encounter_resolved`
projection — but the plan should assert that explicitly rather than infer it.

## Schema

```ts
export const WorldState = z.object({
  campaignId: z.string(),
  /** Every seed in the campaign derives from this and a log sequence. */
  rootSeed: z.number().int(),
  appliedClientMessageIds: z.array(z.string()),
});

export const EncounterState = z.object({
  encounterId: z.string(),
  grid: GridMap,
  combatants: z.array(Combatant),
  turnOrder: z.array(z.string()),
  currentActorIndex: z.number().int().min(0),
  round: z.number().int().min(1),
});

export const CampaignState = z.object({
  world: WorldState,
  /** Non-null exactly between `encounter_started` and `encounter_resolved`. */
  encounter: EncounterState.nullable(),
});
```

Payload conventions, following `ActionRejectedPayload`'s precedent of open
strings over closed enums for anything persisted forever:

```ts
export const CampaignStartedPayload = z.object({ rootSeed: z.number().int() });
export const EncounterStartedPayload = z.object({ encounterId: z.string() });
export const EncounterResolvedPayload = z.object({
  encounterId: z.string(),
  /** Open string, not an enum: this is persisted forever. */
  outcome: z.string(),
  survivorIds: z.array(z.string()),
});
```

## Semantics

**`reduce` dispatches on where the event lands.** The three campaign-scope
types write `world` or the bracket; the three combat-scope types write
`encounter`. The seven no-op types stay listed explicitly, so the
exhaustiveness check keeps forcing a decision per new type.

**A combat event outside a bracket is a parse failure, not a silent no-op.**
`state_delta_applied` or `scene_changed` arriving with `encounter === null`
means the log is corrupt or a producer is wrong; swallowing it would project a
plausible-looking board out of an impossible history. `reduce` already throws
on malformed payloads via `.parse` — this is the same class and should fail the
same way.

**`encounter_started` with an encounter already open is likewise a failure.**
The bracket is strictly non-overlapping, which is what makes
`encounter: EncounterState | null` correct rather than a map.

**`encounter_resolved` clears the bracket and keeps the world.** Combatant HP,
positions and conditions are gone from the projection with it; whatever must
outlive the fight travels in the payload and, from §4.7's step 5 onward, into
declared world-state effects.

**Idempotency spans the campaign.** `player_input` appends to
`world.appliedClientMessageIds` regardless of bracket.

**Genesis is two events, not one.** Sequence 0 is `campaign_started`; the first
`encounter_started` is a separate, later event. This is what makes a campaign
that has not yet entered combat representable — the state §4.7's step 4 needs
and today's model cannot express.

## Wiring

`createCampaign` writes sequence 0 and returns a campaign with
`encounter: null`. `startEncounter` calls `buildEncounterById`, writes
`encounter_started`, and folds. `loadCampaign` reads the log, rebuilds
`initialWorldState` from `campaign_started`'s payload, and folds the rest —
rebuilding each encounter's initial state from its `encounter_started` exactly
as `loadSession` rebuilds from genesis today.

The pipeline's turn path reads `campaign.encounter` and refuses a turn when it
is null, with an existing-shaped `error` frame rather than a new code where one
fits. `seedFor(campaign.state.world.rootSeed, campaign.nextSequence)` replaces
`seedFor(session.state.rootSeed, ...)` at both call sites.

HTTP creates a campaign and, for now, immediately starts its one encounter, so
the client-visible flow is unchanged. That temporary coupling is the seam
§4.7's step 4 removes.

## Testing

The existing suite is the specification: it must pass with renames only. The
plan's first task records the baseline count before anything moves, and any
drop is a regression rather than an expected consequence.

New coverage:
- **One campaign, two encounters in sequence** — start, resolve, start again;
  the second encounter's board is fresh and the world's idempotency set
  survives across the boundary.
- **A combat event outside a bracket throws**, and a second
  `encounter_started` inside one throws.
- **Replay across a bracket** — the round-trip in
  `src/event-store/replay.test.ts`, extended to a campaign spanning two
  encounters, still projects identically.
- **Seed determinism across a boundary** — the same campaign seed and log
  produce the same rolls in the second encounter as in the first run.
- **A campaign with no encounter yet** projects `encounter: null` and serves a
  `campaign_state` frame without one.

## Documentation

`PROJECT_PLAN.md` §4.7's step 1 line; ADR-0004 amended for decision 1 and
flipped to ACCEPTED on merge; root `CLAUDE.md`'s ADR line.
`packages/memory/CLAUDE.md:5` and `:12` name `session_snapshots` and the
composite PK `(session_id, sequence)` and must follow the rename; `:12` also
still says "no campaign concept exists yet", which this spec makes false. No
`CLAUDE.md` names `SessionState`, so the type rename itself needs no charter
edit.

The stale-reference sweep matches by shape, not wording — a comment describing
a session-scoped projection is stale whether or not it uses the word.

## Limitations this spec knowingly ships

- **`WorldState` holds almost nothing**, so the split's value is structural
  and invisible until §4.7's step 2. That is the cost of a reviewable change.
- **HTTP still starts an encounter at campaign creation**, so no user-visible
  campaign exists yet — only a campaign-shaped log.
- **The `campaign_state` frame still resends the whole projection**, and the
  projection is now strictly larger. The C-30 unbounded-growth concern
  (`encounters/index.ts:95`) grows with it and is not addressed here.
- **`scene_changed` keeps its misleading name and its `{kind: string}`
  payload.** Renaming it is a second, independent sweep and mixing it into this
  one would make the diff unreviewable.
