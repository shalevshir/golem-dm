# The combat bridge — design

Step 5 of `PROJECT_PLAN.md` §4.7, following step 4's intent router
([`2026-08-28-intent-router-design.md`](2026-08-28-intent-router-design.md),
merged as `c9de726`). Step 4 named the combat bridge as its own explicit
non-goal: "in this step no scene campaign can enter combat and no combat
campaign has a scene." Both halves of the game now exist and neither connects
to the other. Closing that is this step's entire job.

What ships here: a quest node that declares an encounter, an
`encounter_started` payload complete enough for `reduce` to fold a bracket
without a catalogue, the end-of-combat detector that does not exist anywhere
today, and the resolution group that turns a won fight back into scene
progress.

Exit criterion: a campaign created from the Emberfall world walks by typed
Hebrew to a node that declares an encounter, the board opens live on the
already-connected socket, the fight is played to victory through the existing
tactical loop, the node completes and its effects apply, and play returns to
narration at the next node — with a reloaded campaign folding to the same
`CampaignState` the live one held. Meanwhile a combat campaign created with
`{encounterId}` behaves byte-for-byte as it does today.

## Context

Facts checked against the repo at `499841a`, not recalled.

**No fight has ever ended.** `resolveEncounter` (`campaign.ts:336`) has no
production caller: `http.ts` imports `createCampaign`, `loadCampaign` and
`startEncounter`, not it, and nothing else in `apps/server` calls it outside
tests. This is not a wiring gap step 5 completes — the end-of-combat detector
does not exist and this step builds it.

**The only victory rule lives in `apps/web`.** `conclusionOf(EncounterState)`
(`apps/web/src/state/conclusion.ts:16`) returns `"ongoing" | "victory" |
"defeat"` from combatant `status` and `faction`. Its header states the
governing fact outright: *there is no terminal frame* — `runEnemyTurns`
returns at its `livingFactions.size < 2` check (`pipeline.ts:976-981`) with no
event emitted, and every later command is answered `not_your_turn`. A UI that
waited for a victory frame would hang forever. `apps/web` may import only
`@ai-dm/schemas` (invariant 5), so that package is the only place a shared
definition can live.

**`maxRounds` is authored, built and never read.** It is on
`EncounterDefinition`, copied into `BuiltEncounter` (`build.ts:67,78,205`),
and set to 20 for `goblin-ambush` (`encounters/index.ts:41`). Nothing in
`apps/server` or `packages/rules-engine` consults it. A fight in which neither
side can land a killing blow therefore has no terminator at all.

**`encounter_started` is a guard-only no-op in `reduce`.** It parses its
payload and refuses a second open bracket, then returns `state` unchanged,
because the board comes from the encounter catalogue that `@ai-dm/schemas` may
never import. `startEncounter` (`campaign.ts:301`) runs `reduce` for the guard
and then substitutes `initialEncounterState(built)`. `reduce.ts:1-45`
documents the silent client-side gap this opens across forty lines and assigns
closing it to this step by name.

**The gap is now reachable in principle and not yet in practice.** Step 4
landed `worldId` campaigns that never bundle a fight, breaking the old
"campaign creation always starts an encounter" justification. But
`POST /campaigns`'s `encounterId` branch still awaits `startEncounter` before
returning a `campaignId`, so a combat campaign's first visible snapshot always
has its board. Step 5 is what first streams `encounter_started` to an
already-open socket.

**`emitAll` exists and is the right tool.** `pipeline.ts:647` appends an event
group in ONE `EventStore.append`. Its doc comment records why: three separate
appends for one engine transition left a window where a durable
`quest_node_completed` could outlive a never-written `world_delta_applied`,
unrepairable because the scene engine's `completed()` short-circuits on
`completedNodeIds`. Both bracket groups below have that same hazard shape.

**`emit` is a fourth writer of the bracket and `Campaign.built`'s doc comment
predicted this step by name.** It assigns `campaign.state = next` for every
event it appends and never touches `built` — "safe only because no `emit` call
site passes a bracket event today — and the combat bridge's
`encounter_resolved` is exactly the event that will." `builtOf`
(`campaign.ts:534`) guards the resulting desync at the next read.

**`sceneStaticsOf` and `builtOf` are siblings, not a union.**
`campaign.ts:60-115`: a campaign has at most one bracket and at most one
scene, "nothing in this plan lets a single campaign have both at once — but
nothing enforces that either." A bridged campaign is the first to hold both,
and both accessors must be satisfiable simultaneously.

**Free text in combat is already refused.** Guard 2 of the `free_text` case
(`pipeline.ts:1120`) answers `free_text_not_supported` with "Use the on-screen
actions during combat" whenever `state.encounter !== null`. The `combat`
intent category is narrate-only (`pipeline.ts:1429-1439`). Neither needs to
change for a bracket to open mid-scene.

**Seeds are already campaign-scoped.** Every roll calls
`ports.seedFor(campaign.state.world.rootSeed, campaign.nextSequence)`
(`pipeline.ts:924, 1373, 1569`), and `WorldState.rootSeed`'s own comment reads
"every seed in the campaign derives from this and a log sequence." Nothing at
encounter build time is random: spawns, positions and `turnOrder` are all
authored on `EncounterDefinition`, and initiative is never rolled.

**The world loader can see the encounter catalogue.** `loadWorld`
(`apps/server/src/world/index.ts:156`) and `encounterById`
(`apps/server/src/encounters/index.ts:65`) are in the same package. The loader
already refuses broken location, faction and NPC references.

**`data/world/` counts are pinned by test.** `world-content.test.ts:37-39`
asserts exactly two factions, three NPCs and five nodes, with a comment
recording §4.7's sizing. Adding an encounter node moves the last of those.

**The terminal-node gate.** The exploration branch refuses `targetNodeId:
null` unless the current node is structurally terminal (`edges.length === 0`,
`pipeline.ts:1263-1281`). A node whose edges all sit behind permanently-unmet
predicates could never be concluded. Not reachable in the shipped five-node
arc; re-checked below against the sixth.

**Baseline, measured on this branch at `499841a`:** 1550 passed, 30 skipped,
104 files without `DATABASE_URL`; 1580 passed, 0 skipped, 104 files with it
(`packages/memory` 62/62, `apps/server` 209/209) — matching what §4.7 records
for step 4. `pnpm typecheck` and `npx eslint packages apps tools` both exit 0.

## Decisions

### 1. A node declares an encounter by bare id

`QuestNode` gains one field:

```ts
/** Entering this node opens a bracket on the named catalogue encounter. */
encounterId: ContentId.optional(),
```

No parameterization. §4.7's wording anticipates "spawn table, map, starting
positions, surprise", but every one of those is already a field on
`EncounterDefinition`, so a parameterization layer here would be an *override*
mechanism for a catalogue of exactly one entry, with no second caller to shape
it — and `surprise` is not implemented anywhere, so it would be an empty field
with no consumer. The override object is a one-line addition when a second
encounter actually needs one.

Referential integrity is `loadWorld`'s, cross-checking against `encounterById`
the same way it already refuses a broken `locationId`, so a typo fails at
startup rather than mid-campaign. The schema field stays a bare `ContentId` in
`@ai-dm/schemas`: the *reference check* is what needs both catalogues, and
that check lives in `apps/server` where both already are. Invariant 5 holds —
`@ai-dm/schemas` gains no knowledge of encounters it does not already have.

The bracket opens on **entering** the node and the node completes on
**victory**. Preconditions gate entry and effects apply on completion, so an
encounter node reads as "a node whose completion requires winning" with no new
concept added to either half.

### 2. `encounter_started` carries the board; `reduce` folds a bracket completely

`EncounterStartedPayload` grows the serializable half of the initial board:

```ts
EncounterStartedPayload = {
  encounterId: z.string(),
  grid: GridMap,
  combatants: z.array(Combatant),
  turnOrder: z.array(z.string()),
}
```

`reduce`'s `encounter_started` case stops being a guard-only no-op: it keeps
the already-open-bracket refusal and then returns the bracket filled, with
`currentActorIndex: 0` and `round: 1` — the two fields `initialEncounterState`
already derives rather than reads. `startEncounter`'s catalogue substitution
goes away; it builds the payload from `buildEncounterById` and lets the fold
do the rest.

This is the precedent step 4 validated for genesis, applied one level down.
Step 4's Decision 3 chose payloads the fold reads completely *specifically* to
avoid this trap — "the deliberate contrast with `encounter_started`, whose gap
`reduce.ts` spends thirty lines documenting." Step 5 removes the thing being
contrasted against.

Three problems close together:

- The silent client gap. `apps/web`'s `applyFrame` runs bare `reduce`; after
  this it projects a live `encounter_started` into a real board instead of
  returning `state` unchanged with no error.
- `loadCampaign`'s O(encounters) blocking cold-load file I/O
  (`campaign.ts:331-350`): it stops calling `buildEncounterById` once per
  resolved fight in the log, because the log now carries what it was
  rebuilding.
- Retiring or renaming an encounter id no longer makes every campaign that
  ever fought it permanently unloadable, since `UnknownEncounterError` no
  longer propagates out of `loadCampaign` for a *historical* fight. §4.7 lists
  both of these as needing "a decision, not a fix"; this is the decision.

**The substitution does not disappear; it becomes a legacy fallback.** A
persisted old-shape `encounter_started` carries no board, and a fold that
returned `encounter: null` for it would then throw on the very next
`state_delta_applied` — a legacy campaign would become unloadable, which is
the opposite of the third bullet. So `loadCampaign` keeps
`buildEncounterById`, reached only when the board fields are absent. The two
performance bullets above therefore apply to logs written from step 5 onward,
not retroactively — stated here rather than left to be discovered when an old
campaign's cold load is still slow.

The client-side gap does close completely, and the asymmetry is what makes
that true rather than lucky: the only logs still lacking a board are
combat-only campaigns from `POST /campaigns {encounterId}`, and that route
still awaits `startEncounter` before returning a `campaignId`, so their client
always joins *after* `encounter_started` and can never receive it as a live
frame. Every log that could ever hit the gap is one written from step 5
onward, and those fold completely.

**On "a bracket event names a thing and never snapshots it."**
`createCampaign`'s doc comment (`campaign.ts:243-250`) states that rule and
cites `encounter_started` as following it. This decision changes that, and the
comment is updated rather than left to contradict the code.

The rule's purpose is to keep mutable state out of the log, and the board here
is not mutable state: it is the *initial* board, a deterministic starting
condition, which is the class of thing genesis already records. Step 4 made
exactly this argument for `startingNodeId` and `startingDay` — recording them
is the replay property invariant 3 wants, because editing `world.json` must
not retroactively move where an existing campaign began. The same sentence
holds one level down: editing `goblin-ambush`'s spawns or grid in the
catalogue must not retroactively move where an existing campaign's fight
began. What stays forbidden is unchanged — no bracket event carries evolving
combatant state, which is what `state_delta_applied` is for.

**What stays out of the payload.** Stat blocks, for the reason `EncounterState`
already omits them — static per encounter, re-derived server-side from ids, and
"a snapshot holds only what events change." `BuiltEncounter`'s `lineOfSight`
function for the reason `EncounterState` is not `CombatWorld` — it cannot be
serialized and is paired back in at call time. `maxRounds`, because only the
server enforces it (Decision 4) and `builtOf` already reaches it.

**`apps/web` still fetches `EncounterCatalogue`.** That is display metadata —
combatant labels and action descriptions — which the fold never needed and
which no event carries. What changes is *when*: today `App.tsx` fetches it once
at mount and only for a non-`worldId` campaign; a bridged campaign must fetch
it when a bracket opens. The render guard at `App.tsx:465` (`catalogue === null`
→ not-ready) already sits below the `encounter === null` branch, so it needs no
restructuring — only the fetch trigger moves.

**Append-only compatibility.** The three new fields are required on new
payloads but absent from every persisted one. An old `encounter_started` must
still fold, and it cannot fold into a board. It parses via `.default([])` /
optional grid and, when the board fields are absent, `reduce` keeps today's
guard-only behaviour — the legacy path, exercised by a test over a
hand-written old-shape log, exactly as `WorldState.scene`'s `.default(null)`
keeps pre-step-4 genesis payloads folding.

### 3. `conclusionOf` moves to `@ai-dm/schemas`

The function moves verbatim, with its header, into `@ai-dm/schemas` beside
`reduce`. `apps/web` deletes its copy and imports it; the server imports the
same one.

`@ai-dm/schemas` is not where a rules authority belongs, and this is the
narrow exception the package already makes for `reduce`: `apps/web` may import
only this package, so a projection-read both halves need has nowhere else to
go. It qualifies where a rules function would not — it reads `status` and
`faction` off a projection, rolls nothing, consults no DC and no SRD table, so
invariant 1's "the rules engine is the only authority on game legality and
math" is untouched. Two copies of the victory rule is precisely what invariant
4 exists to forbid.

`runEnemyTurns`'s inline `livingFactions.size < 2` check
(`pipeline.ts:976-981`) is the same rule written a second way and becomes a
`conclusionOf` call. One definition, not three.

### 4. Two terminators, checked after the turn batch

A new step in the `structured_action` case, after `runEnemyTurns()` and before
`playerAffordances()` (`pipeline.ts:1593`) — the one point where control is
about to return to the player:

- `conclusionOf(encounter) !== "ongoing"` → `"victory"` or `"defeat"`.
- `encounter.round > builtOf(campaign).maxRounds` → `"stalemate"`.

The second exists because the bridge creates the failure mode it guards. Today
an unresolvable fight is a stuck board on a combat-only campaign, which is
visibly broken and recoverable by reload. Once a fight is a *span inside a
campaign*, the same stalemate strands the campaign out of its own narrative
permanently, with `free_text` refused by Guard 2 for as long as the bracket
stays open. `maxRounds` is already authored and already built; enforcing it is
one comparison.

`outcome` stays `z.string()` on the wire. `EncounterResolvedPayload`'s comment
already gives the reason — the payload is persisted forever, so a closed enum
becomes a migration the first time an outcome is added, and it names "fled,
negotiated, abandoned" as the growth §4.7 expects. `"stalemate"` is the first
of those to arrive.

### 5. Resolution is one `emitAll` group, and effects stay engine-computed

On victory, in one append:

1. `encounter_resolved {encounterId, outcome, survivorIds}` — `survivorIds`
   from the living combatants, ids only, as the payload's comment already
   requires.
2. `quest_node_completed {nodeId}` — the encounter node.
3. `world_delta_applied` — only when something actually changed.

Events 2 and 3 are derived by running `completeCurrentNode(authored,
sceneStateFrom(scene))` and diffing the engine's own pre- and post-transition
`SceneState`, reusing the exact helper the exploration branch already uses.
That keeps the result-carrying-payload rule intact one level up from combat:
the payload records what the **engine actually did**, post-clamp, and cannot
disagree with it. The pipeline never re-reads the node's declared effects and
never computes a band.

On defeat or stalemate: `encounter_resolved` alone. The node is not completed,
no effects apply, and the player lands back in the scene at the same node.
Re-entering rebuilds a fresh board from the catalogue.

**Known ceiling, stated rather than hidden.** `diesAtZeroHp` is pinned true
unconditionally, so a solo PC (ADR-0002) reaching 0 HP is a real party wipe,
and a defeated player narratively walking it off to retry the same fight at
full HP is wrong. Permadeath and campaign-end want a terminal `CampaignState`
concept, a client rendering for it, and a decision about resumption — a
subsystem of its own, and it belongs beside step 6's character profiles rather
than inside a step that already grew an end-detector. The retry loop is what
keeps the campaign playable in the meantime.

**`emitAll` clears `campaign.built`** when the group it appends contains an
`encounter_resolved`. This is the fourth-writer hazard `Campaign.built`'s doc
comment predicted by name; the fix keeps that comment's actual requirement —
that both halves of the bracket are written in one place — rather than leaving
`builtOf`'s guard to catch the desync one call later. `resolveEncounter` in
`campaign.ts` is deliberately not the caller: it appends on its own, and the
resolution group must be one append.

### 6. No new seed; the rule is already true by construction

§4.7 requires that "an encounter's `rootSeed` derives from the campaign seed
and sequence, never fresh randomness." Checked against the code, that is
already the case and there is no second seed to derive: every roll inside a
bracket calls `seedFor(campaign.state.world.rootSeed, campaign.nextSequence)`
on the campaign-scoped sequence, and nothing at encounter build time is
random.

Decision 2 also removes the consumer a per-encounter seed would eventually
have had. A randomized board would be resolved once at `encounter_started` and
baked into the payload, so replay reads the board out of the log rather than
re-deriving it from a seed — the same reason genesis records `startingNodeId`
instead of re-reading `world.json`.

So step 5 adds no field and no derivation. What it adds is the test that pins
the property: a fight started mid-campaign draws from the campaign sequence
and a replayed campaign reproduces it exactly. Inventing a second derivation
scheme is the thing this decision exists to refuse.

### 7. `encounter_resolved` fires only for a campaign with a scene to return to

The detector emits nothing when `campaign.sceneStatics === null`. A combat-only
`{encounterId}` campaign ends its fight exactly as it does today: no event, the
board stays projected, and `apps/web` renders its victory or defeat banner from
`conclusionOf`.

This is not only compatibility. `encounter_resolved` closes a bracket *inside a
campaign that continues*; for a combat-only campaign the fight is the whole
campaign, and closing the bracket would null `state.encounter` with `scene`
already null — projecting a campaign that is in neither combat nor a scene,
which `App.tsx:417-431` can only render as the "not ready" placeholder. Winning
would blank the screen.

The consequence, recorded rather than buried: `resolveEncounter` still has no
production caller after this step. It remains the tested `campaign.ts`-level
sibling of `startEncounter`, and the pipeline's `emitAll` is what actually
closes brackets in play.

### 8. A sixth node, and the count pin moves deliberately

`data/world/arc.json` gains `saboteurs` between `the-weir` and `reckoning`,
carrying `encounterId: "goblin-ambush"` and one outbound edge to `reckoning`.
`world-content.test.ts:39` moves from 5 to 6 with its comment updated to say
why — §4.7's "five-node arc" sizing is superseded by step 5 needing an
encounter node, not drifted past.

Checked against the terminal-node gate: `saboteurs` has an outbound edge, so it
is structurally non-terminal and a `targetNodeId: null` there is refused
exactly as `guild-offer`'s is. `reckoning` keeps `edges: []` and remains the
arc's only terminal node, and its `node_completed: the-weir` precondition is
unaffected by an intervening node. The trap the brief flags — a node whose
edges all sit behind permanently-unmet predicates — is not introduced:
`saboteurs`'s single edge carries no predicate on its target beyond
`reckoning`'s existing pair, which the arc already satisfies on the played
path.

The `data/world/fixtures/` worlds are separate manifests exercising loader
failures and are not touched.

## What this must not make worse

**Combat-only campaigns are byte-for-byte unchanged.** `{encounterId}`
creation, the tactical loop, affordances, combat narration, and the end of a
fight all behave exactly as today (Decision 7). The existing pipeline, e2e and
replay tests pin this and none of them change.

**Append-only compatibility holds.** Every persisted `encounter_started`
payload still parses and still folds — into the guard-only behaviour it folds
into today (Decision 2), pinned by a test over an old-shape log. No payload is
repurposed. `EncounterResolvedPayload` is unchanged.

**The engine's purity is not relaxed.** `packages/rules-engine` gains nothing:
resolution reuses `completeCurrentNode` and the existing state diff. No
`Date.now()`, no I/O, no LLM.

**Invariant 1 is untouched.** No model decides that a fight has started,
ended, or been won. The bracket opens because authored content declares an
`encounterId`; it closes because a pure function reads combatant status. The
intent router's `combat` category stays narrate-only.

**Invariant 5 holds in both directions.** `@ai-dm/schemas` still imports
nothing downstream — it gains a board-shaped payload and a projection read,
not an encounter catalogue. `apps/web` still imports only `@ai-dm/schemas`.

**The fold becomes more total, never less.** After this step `fold` alone
projects a bracket, so `loadCampaign` stops being the only complete projector
— the condition `reduce.ts`'s header describes ceases to hold and that header
is rewritten to describe what is true, not amended to hedge.

**English inside, Hebrew outside.** No new payload field carries Hebrew. The
sanctioned pair stays `narrative_emitted.text` and `player_input.text`; this
step adds no third and needs none.

**Exhaustiveness discipline.** No `default` is added to any switch over a
discriminated union. The new `outcome` values are `z.string()` on the wire by
Decision 4 and are not switched on exhaustively anywhere.

**Coverage does not drop.** `packages/rules-engine` stays ≥90% lines. Every
new guard is sabotaged once, its assertions observed failing, then restored.

## Non-goals

- **Permadeath and campaign-end.** Defeat's known ceiling (Decision 5). A
  terminal campaign state, its client rendering, and resumption are their own
  decision, alongside step 6's character profiles.
- **The scene summary for episodic memory.** §4.7 assigns
  `encounter_resolved`'s summary and the scene-summarizer tier to step 7; this
  step's payload carries `outcome` and `survivorIds` only, as it does today.
- **In-combat free text.** Guard 2 keeps refusing it and the `combat` intent
  category stays narrate-only. Routing `social`/`ooc` during a fight is a
  later question.
- **Spawn tables, encounter parameterization, surprise.** Decision 1. The
  catalogue holds one encounter; an override layer waits for a second caller.
- **A second encounter in the catalogue.** `goblin-ambush` is what the bridge
  is proven against.
- **Initiative rolls.** `turnOrder` stays authored. This is the one change
  that would give a per-encounter seed a consumer, and it is not in scope.
- **Character profiles, NPC affinity** — step 6.
- **`ws.ts`'s missing `clientMessageId`** on the catch-all `internal_error`
  frame. Known and unfixed; `apps/web` compensates by treating an absent id as
  clearing its pending-send latch, and changing it means changing both sides.
- **Cost reporting.** The `cache_read_input_tokens`/pricing relocation stays
  step 11's, as §4.7 states.
- **`packages/memory/CLAUDE.md`.** Carries an uncommitted edit that is not
  this step's; excluded exactly as steps 3 and 4 excluded it.
