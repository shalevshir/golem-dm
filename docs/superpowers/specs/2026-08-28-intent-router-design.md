# The intent router, `free_text`, and out-of-combat ability checks — design

Step 4 of `PROJECT_PLAN.md` §4.7, following step 3's scene engine
([`2026-08-27-scene-engine-design.md`](2026-08-27-scene-engine-design.md),
merged as `88a5904`). Step 3 built a pure evaluator that nothing in the running
pipeline calls; its stated first caller is this step. What ships here is the
path from a player's Hebrew sentence to a validated scene transition: the
third cascade tier (intent), a real `free_text` case in the pipeline, scene
narration, the serialized form of `SceneState`, and the events that make all
of it a fold of the log.

The governing constraint is §4.7's: out of combat, if nothing adjudicates, an
LLM mutates state and invariants 1 and 3 are both gone. So the shape is the
same one `validateExecuteTurn` already enforces one level down — the router
**proposes** from enumerated choices, the scene engine validates, and only
what the engine accepted becomes events. The model never emits a number and
never touches state.

Exit criterion: a campaign created from the Emberfall world plays down a
branch by typed Hebrew alone — arrival narrated, a gated edge refused with the
refusal narrated, an ability check rolled through the engine's own
`abilityCheck` and logged — and a reloaded campaign folds to the same
`SceneSnapshot` the live one held. Meanwhile a combat campaign created with
`{encounterId}` behaves byte-for-byte as it does today.

## Context

Facts checked against the repo at `80202d5`, not recalled.

**`free_text` is a refusal today.** `pipeline.ts:739` answers every one with a
`free_text_not_supported` error frame. The message schema already caps text at
500 chars at transport parse (`MAX_FREE_TEXT_LENGTH`, `protocol.ts:18`).

**The intent tier is `export {}`** (`packages/agents/src/intent/index.ts`),
under a comment naming the five categories. `ModelRouting` already routes an
`intent` role (temperature 0, least reasoning, cheapest model) and
`LanguageModelPort.generateStructured` is the call shape it needs — the
adapter work is already done.

**`reduce` cannot compute a faction shift.** It lives in `@ai-dm/schemas`,
which may not import the rules engine (invariant 5). The house precedent is
`state_delta_applied { combatants }`: the engine computes, the event carries
the **result**, and the fold applies it mechanically. Every new event below
follows that rule.

**`intent_classified` is already in the `GameEvent` enum** (`events.ts:16`)
and already a no-op in `reduce` (`reduce.ts:200`). This step gives it a
payload convention and a producer; the fold is untouched for it.

**`SceneState` deliberately has no serialized form.** Step 3's Decision 3
deferred the choice to this step. It holds a `ReadonlySet` and a
`ReadonlyMap`; `WorldState` (`protocol.ts:33`) is where the serialized fields
land.

**The overlay rule is load-bearing and already centralised.** Step 3's review
fixed four bugs whose shared root was assuming the state carried every faction
pair; the fix made the authored world the baseline and the state an overlay,
written once in `relationBetween` (`scene/index.ts:79`). A deltas-only
serialization keeps that logic live; a full snapshot would orphan it.
**Settled with the user 2026-08-28: deltas-only.**

**Genesis is two events and a campaign between fights is representable.**
`campaign_started` at sequence 0 opens the stream with `{rootSeed}`;
`state.encounter` is null until `startEncounter`. ADR-0004 decision 5 says
genesis "declares the campaign's root seed and opening quest node" — the
second half of that sentence is unimplemented and is this step's to implement.

**The fold gap precedent to avoid.** `encounter_started` is a guard-only
no-op in `reduce` because only the server's catalogue can rebuild the board —
so `fold` alone cannot project a bracket, and `reduce.ts:1-32` documents the
silent client-side gap that opens. Genesis payloads that name the entry-point
facts outright (§Decision 3) are what keep the scene fields out of that trap:
`reduce` folds them completely, no substitution, no second projector.

**Everything a check needs already exists.** `abilityCheck`
(`checks/index.ts:66`) takes `{abilityScore, proficient, proficiencyBonus,
expertise, dc, mode}` and an injected `Rng`. `AbilityKey` and the 18-entry
`Skill` enum are in `character.ts`; `hero.json` under `data/characters/` is a
full `CharacterSheet`, loaded and cached by `loadCharacter` as a
`DerivedCharacter` whose `skills` record **already carries the final modifier
per skill** and whose `abilityModifiers` covers raw ability checks — both
computed by `deriveCharacter` from the SRD skill list (`SrdGear.skills`,
each `SkillDefinition` naming its governing ability). The one thing that does
**not** exist is a difficulty→DC table; it is SRD data and belongs in
`checks/`.

**Scene narration has Hebrew material for a deterministic fallback.**
`LocationDefinition` and `NpcDefinition` carry `nameHebrew`; `QuestNode` does
not (English scene card only). A template fallback can therefore be Hebrew
without any new authored content, which is what keeps the degradation ladder's
bottom rung intact out of combat.

**The player's text is Hebrew and the log is English-only.** `events.ts:21`:
"Never store Hebrew here except narrative_emitted." Replay never re-runs
models, so the text is not needed for determinism — but it is the audit trail
for router misclassifications and the raw input step 7's episodic memory will
want. **Settled with the user 2026-08-28: persist it**; the rule is amended to
name `player_input.text` as the second sanctioned Hebrew field.

**The web client folds with bare `reduce` and has no text input.**
`apps/web/src/state/store.ts` runs `reduce` per event frame; no component
sends `free_text`. `ErrorBanner.tsx` keeps `not_your_turn` silent — correct
only while nothing can send a structured action out of combat, which the UI
gating in §Decision 8 preserves. **Settled with the user 2026-08-28: a
minimal web slice is in scope.**

**Baseline, on this branch at `80202d5`:** 1384 passed, 30 skipped, 95 files
without `DATABASE_URL`; 1414 passed, 0 skipped with it (`packages/memory`
62/62). `pnpm typecheck` and `npx eslint packages apps tools` exit 0.

## Decisions

### 1. A closed-choice router, not a GM tier

The tier this step adds classifies and selects; it does not compose. Free
text becomes one of:

- `exploration` — an edge from the current node's enumerated list, **or null**
  meaning "conclude the current node" (the `completeCurrentNode` hook a
  terminal node needs);
- `check` — an `AbilityKey`, an optional `Skill`, and a difficulty word from a
  closed enum;
- `social` | `combat` | `ooc` — bare categories, narrate-only in this step.

A free-form GM tier (§4.7's `NarrativeMove`) was considered and deferred: in
step 4 it would mean designing NPC interaction against no NPC state (that is
step 6) and would put a model in charge of inventing moves the engine has no
vocabulary to refuse. The closed-choice router is §4.7's own stated design —
"the intent router picks an edge, the engine checks its predicate, the
narrator describes the traversal" — and everything it can propose is either
validated by the scene engine or resolves through `abilityCheck`.

### 2. `SceneSnapshot`: deltas-only, and the converters live with `pairKey`

`WorldState` gains one field, `scene`, nullable with `.default(null)` so every
persisted snapshot and every combat-only campaign parses unchanged:

```ts
export const SceneSnapshot = z.object({
  worldId: ContentId,
  currentNodeId: ContentId,
  completedNodeIds: z.array(ContentId),
  /** Overlay: ONLY pairs a completed node has shifted. Read through
   *  `relationBetween`'s authored baseline, never alone. */
  relations: z.array(FactionRelationEntry),
  day: z.number().int().min(1),
});
// WorldState: scene: SceneSnapshot.nullable().default(null)
```

`relations` reuses `FactionRelationEntry` — the shape already exists and the
band it carries is absolute, so the fold never does band arithmetic. A full
snapshot was rejected (settled with the user): it would need seeding from
`world.json`, which the fold cannot read, so either the genesis payload
snapshots every pair — breaking "a payload names a thing and never snapshots
it" and freezing authored data into the log — or the fold cannot fill it and
the `encounter_started` gap reopens for scene state. Deltas-only needs
neither, and it is the representation `relationBetween` was built for.

Two converters land in `packages/rules-engine/src/scene/` beside `SceneState`:
`sceneStateFrom(snapshot): SceneState` and `snapshotOf(state, worldId):
SceneSnapshot`. They live there because the relations map is keyed by
`pairKey`, and a converter anywhere else would re-derive the key format —
step 2's named invariant-4 duplicate. Round-tripping is property-tested.

### 3. Genesis names the entry point; `reduce` folds it completely

`CampaignStartedPayload` gains four optional fields:

```ts
worldId: ContentId.optional(),
startingNodeId: ContentId.optional(),
startingDay: z.number().int().min(1).optional(),
characterId: z.string().optional(),
```

All four present ⇒ a scene campaign; all four absent ⇒ a combat-only campaign
(every existing log). A payload with some-but-not-all is refused by a
`.refine` — half a scene campaign is a corrupt genesis, not a state.

`campaign_started` stays a no-op in `reduce`, per the fold's existing rule
that "the world [genesis] declares is rebuilt from its payload before the
fold begins". What changes is that the rebuild now has a scene half: a shared
helper in `@ai-dm/schemas`, `sceneFromGenesis(payload): SceneSnapshot | null`
— `{worldId, currentNodeId: startingNodeId, completedNodeIds: [], relations:
[], day: startingDay}` when the quartet is present, null otherwise — is the
one definition, and `campaign.ts`'s `initialWorldState` calls it. No authored
world is consulted anywhere in the rebuild, so there is **no
catalogue-substitution step and no client-side fold gap** — the deliberate
contrast with `encounter_started`, whose gap `reduce.ts` spends thirty lines
documenting.

On "names a thing, never snapshots it": `startingNodeId` and `startingDay`
are sanctioned by ADR-0004 decision 5 in as many words ("declares the
campaign's root seed and opening quest node"), and recording them is the
replay property invariant 3 wants — editing `world.json`'s `startingNodeId`
must not retroactively move where an existing campaign began. `characterId`
names the solo PC (ADR-0002); the sheet is rebuilt via `loadCharacter`, never
persisted.

`POST /campaigns` accepts `{worldId: string}` as an alternative body to
`{encounterId: string}` — exactly one of the two, enforced by the body schema.
The world path validates via `loadWorld` (which already refuses an
unenterable start) and `loadCharacter`, then writes genesis; **no encounter
starts**. The encounter path is unchanged in every byte. `createCampaign`
grows an optional scene input serving both; `loadCampaign` needs no new
substitution logic (Decision 3's point) but does verify on load that the
genesis `worldId`/`characterId` still resolve, throwing the same class of
error as its existing corrupt-log guards. The registry passes its existing
`worldId → AuthoredWorld` lookup through to the pipeline as part of the
campaign's static half, the way `built` already travels for encounters.

### 4. Four new event types; payloads carry results, never arithmetic

The `GameEvent` enum gains `quest_node_entered`, `quest_node_completed`,
`world_delta_applied` (the three §4.7 names) and `check_rolled`. Adding them
trips the exhaustiveness checks in `reduce` and the client's frame handling
by design; no `default` is added anywhere.

```ts
QuestNodeEnteredPayload   = { nodeId: ContentId }
QuestNodeCompletedPayload = { nodeId: ContentId }
WorldDeltaAppliedPayload  = {
  /** Absolute resulting bands, post-clamp — the fold merges, never computes. */
  relations: z.array(FactionRelationEntry).default([]),
  /** The new absolute day, when the calendar moved. */
  day: z.number().int().min(1).optional(),
}
CheckRolledPayload = {
  actorId, ability: AbilityKey, skill: Skill.optional(),
  difficulty: CheckDifficulty, dc, naturalRoll, rolls, modifier, total,
  success: z.boolean(), seed: z.number().int(),
}
```

`reduce` folds the first three mechanically — set `currentNodeId`, append to
`completedNodeIds` (idempotently), merge `relations` entries by pair and
replace `day`. Each throws when `scene` is null, the same corrupt-log posture
as a combat event outside a bracket. `check_rolled` joins `dice_rolled`'s
no-op group: a standalone check changes no state — it exists for
replay/audit, the metrics ratio, and a future client log.

The pipeline derives `world_delta_applied` by diffing the engine's pre- and
post-transition `SceneState` (a small helper beside the converters, since it
compares `pairKey`-keyed maps). Diffing the states rather than re-reading the
node's declared effects means the payload records what the **engine actually
did** — post-clamp — and cannot disagree with it.

Event order for a traversal that completes its node:
`quest_node_completed(from)` → `world_delta_applied` (only if something
changed) → `quest_node_entered(to)`. A `completeCurrentNode` with no
traversal stops after the first two. Replay-equivalence (fold-from-zero
equals live state) is pinned by a test for a scene campaign, as it already
is for combat.

### 5. The intent agent: one structured call, schema-validated, engine-refereed

`packages/agents/src/intent/` exports `createIntentAgent({runtime})` with one
method:

```ts
classify(input: {
  text: string;                       // the player's Hebrew, untrusted
  sceneEnglish: string;               // current node's card
  edges: readonly { to: ContentId; labelEnglish: string; open: boolean }[];
  abortSignal?: AbortSignal;
}): Promise<IntentResult>
```

`IntentClassification` is a zod discriminated union in `@ai-dm/schemas`
(invariant 4: the same schema is the tool schema, the parse, and the type):

```ts
z.discriminatedUnion("category", [
  { category: "exploration", targetNodeId: ContentId.nullable() },
  { category: "check", ability: AbilityKey, skill: Skill.optional(),
    difficulty: CheckDifficulty },
  { category: "social" }, { category: "combat" }, { category: "ooc" },
])
```

`CheckDifficulty` is a six-member enum (`very_easy … nearly_impossible`).
The DC table (5/10/15/20/25/30) is `const` data in
`packages/rules-engine/src/checks/`, golden-tested, with the SRD 5.2.1
"Typical Difficulty Classes" verified against the NotebookLM SRD notebook at
implementation time — per the repo rule, not from memory. The skill→ability
mapping is **not** new data: it already ships as `SrdGear.skills` (each
`SkillDefinition` names its governing ability, and `deriveCharacter` already
folds it into `DerivedCharacter.skills`). The model chooses a *word*; the
engine owns every number. When the router names a skill, the check's ability
is the SRD mapping's, not the model's, so the two cannot disagree.

Prompt posture: the scene card and edge labels are English system material;
the player's text enters once, delimited, as user-turn content — never
interpolated into the system prompt (`apps/server/CLAUDE.md`). Closed edges
are shown *with* their open flags: the router may still propose a closed one,
and `traverseEdge`'s refusal — not the router's judgment — is what the player
hears. Two layers, engine authoritative.

Failure: `generateStructured` already schema-validates and the adapter
already retries transient provider errors, so there is no bespoke
retry-with-feedback loop — nothing machine-checkable exists to feed back that
the schema did not already enforce. An adapter failure becomes an
`internal_error` frame; the player rephrases or retries. The result carries
`usage` for metrics like the tactical agent's does.

### 6. The pipeline's `free_text` case

Guards, in order (each mirrors an existing posture):

1. Dedupe on `appliedClientMessageIds` — the reason ADR-0004 moved the list
   to the campaign.
2. `encounter !== null` → `free_text_not_supported` frame, message now "use
   the on-screen actions during combat". Free text in combat is a later
   step's question.
3. `scene === null` → `free_text_not_supported`, unchanged legacy behaviour
   for combat-only campaigns.

Then, under one 10s deadline struck at entry (the same single-cap rule
`enemyTurn` documents):

1. `emit player_input { clientMessageId, actorId: characterId, text }` —
   the amended Hebrew rule (Context) covers `text`.
2. `classify(...)` → `emit intent_classified { clientMessageId, category,
   proposal, provider, modelId, promptVersion }` (English payload; the
   proposal is ids and enum members only).
3. Route on category:
   - **exploration** — `traverseEdge` (or `completeCurrentNode` for null).
     Valid: emit the Decision-4 events, then narrate the arrival (the new
     node's card). Refused: narrate the refusal from its `SceneRejection`
     messages — refusal is data all the way to the player's ear; **no error
     frame and no state change**.
   - **check** — the modifier straight off the derived sheet
     (`DerivedCharacter.skills[skill]` when a skill is named, else
     `abilityModifiers[ability]` — the engine already computed both), DC from
     the table, `seed = seedFor(rootSeed, nextSequence)`, `abilityCheck` →
     `emit check_rolled` → narrate the outcome.
   - **social / ooc / combat** — narrate a grounded reply (scene card +
     category as the brief; `combat`'s brief says fighting is not available
     here yet). No events beyond 1–2, no state change.

The turn ends with `playerAffordances()` for symmetry; out of combat it
yields nothing, and the client's input re-enables on the `narrative_emitted`
fold rather than on an affordance frame.

### 7. Scene narration: a second brief through the same ladder

`packages/agents/src/narrative/scene.ts` adds a `SceneNarrationInput` — the
scene card, a single what-happened beat as a discriminated union (`arrived {
sceneEnglish }` | `refused { messages }` | `check { ability, skill?, success }`
| `reply { category }`), the PC's `nameHebrew`/gender, Hebrew
names for the node's location and NPCs, and `recentNarrations` — with its own
prompt module (`SCENE_PROMPT_VERSION`) and its own deterministic Hebrew
fallback built from templates over the `nameHebrew` fields. The combat
`NarrationInput` is untouched; the two briefs share the `NarrativePort`
streaming contract.

The degradation ladder in `pipeline.ts`'s `narrate()` — `untilDeadline`,
empty → deterministic, truncated → seam + completion, one
`recordNarrativeTurn`, one `narrative_emitted` carrying exactly the streamed
concatenation — is extracted into one helper parameterized by (stream,
fallback stream, actorId, deadline), used by both the combat and scene paths,
so the two cannot drift on timeout or fallback behaviour. Scene narrations
enter the same `recentNarrations` window; the narrator's memory spans modes
the way the campaign's log does.

`MetricsPort` gains optional `recordIntentCall({category, outcome,
latencyMs, promptTokens, completionTokens, totalTokens})` — the
`recordSnapshotFailure` precedent, so existing implementations keep
compiling. The intent tier is the third model on the meter §4.7 says is
unreportable by construction; per-call structured logs are what step 11's
fix will read.

### 8. The web slice: input where the board isn't

`App.tsx` renders by campaign shape: an open encounter renders the grid and
action bar exactly as today; `encounter === null && scene !== null` renders
the `NarrativePane` plus a new RTL free-text input (`FreeTextBar`), disabled
from send until the turn's `narrative_emitted` folds (or an `error` frame
lands). `encounter === null && scene === null` keeps today's placeholder.

Combat controls existing only inside an open encounter is what keeps the
known `not_your_turn`-in-`SILENT_CODES` trap unreachable: nothing out of
combat can send a `structured_action`, so the silent refusal has no sender. A
test pins that gating. The client folds all four new events through the
shared `reduce` with no client code — `intent_classified` and `check_rolled`
render nothing in this step (the narration is the display), and the combat
log stays combat-only.

`free_text_not_supported` leaves `SILENT_CODES` if it is in it — out of
combat it is now a real answer a typing player can receive on a legacy
campaign, and silence there is the inert-board soft-lock in a new costume.

## What this must not make worse

**The combat path is untouched.** `{encounterId}` campaign creation,
`structured_action`, the tactical loop, combat narration, affordances: no
behavioural change. The only shared code that moves is `narrate()`'s ladder
extraction, and the combat pipeline tests pin its behaviour across the
refactor.

**Append-only compatibility holds.** Old `campaign_started {rootSeed}`
payloads parse (new fields optional); old persisted `CampaignState` snapshots
parse (`scene` defaults to null); no payload is repurposed; new fields on
existing schemas are optional or defaulted.

**The engine's purity is not relaxed.** The scene engine gains converters and
a diff helper — pure data transforms. `applyEffect` stays unexported; the
pipeline shifts bands only by completing nodes that declare shifts. No
`Date.now()`, no I/O, no LLM anywhere in `packages/rules-engine`.

**The fold stays total where it is total today.** No new event type is a
server-substituted no-op; a client folding the full frame stream out of
combat reaches the same `WorldState.scene` the server holds. (The
`encounter_started` gap is not widened; it is also not fixed here — step 5
owns the bracket.)

**English inside, Hebrew outside — with its one amended clause.** Prompts,
payloads, schemas stay English. Hebrew in the log: `narrative_emitted.text`
and now `player_input.text`, nothing else; `events.ts`'s comment is updated
to say exactly that.

**Exhaustiveness discipline.** Every new switch over a discriminated union
returns from every branch with no `default`; `IntentClassification` routing
in the pipeline is written so a sixth category fails to compile.

**Coverage does not drop.** `packages/rules-engine` stays ≥90% lines; the
sabotage step applies to every new check (each new guard is broken once, the
expected assertions observed failing, then restored).

## Non-goals

- **The combat bridge** — a quest node declaring an encounter,
  `encounter_started` seed derivation, `encounter_resolved` effects: step 5.
  In this step no scene campaign can enter combat and no combat campaign has
  a scene.
- **A GM tier / `NarrativeMove`.** The router selects from enumerated
  choices; it composes nothing.
- **Checks that gate traversal.** No `check_passed` predicate kind, no
  authored check content — a check in this step informs narration and the
  log, not the graph. When authored content wants skill-gated edges, that is
  a new predicate kind with its own step.
- **NPC dialogue state, affinity, character profiles** — step 6. `social`
  narrates; it does not remember.
- **Episodic memory** — step 7. `player_input.text` persisting is that
  step's corpus, not its implementation.
- **Growing `data/world/`** — one town, two factions, three NPCs, five
  nodes; counts stay pinned. No Hebrew authored scene text; the deterministic
  fallback works from `nameHebrew` fields that already exist.
- **In-combat free text.** Combat keeps refusing it; routing `social`/`ooc`
  during a fight is a later question.
- **Cost reporting.** `recordIntentCall` emits the raw numbers; the
  `cache_read_input_tokens`/pricing fix stays step 11's, as §4.7 states.
