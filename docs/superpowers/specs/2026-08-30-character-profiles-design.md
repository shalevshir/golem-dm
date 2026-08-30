# Character profiles and NPC affinity projection — design

Step 6 of `PROJECT_PLAN.md` §4.7, following step 5's combat bridge (merged as
`bf36567`). §4.7's own placeholder for this step was one line: "Character
profiles and NPC affinity projection." No spec, plan, or code existed before
this document. Step 7's section names step 6 as its future *consumer*: an
episodic-memory retrieval needs "a question a two-turn `recentNarrations`
window genuinely cannot answer," and names that question as step 6's own
projection, `npcId → band + remembered facts`.

What ships here: an authored, deterministic way for a quest node's completion
to shift how an NPC regards the player and to record a short English fact
about them, projected as a per-campaign overlay the same shape as faction
standing already is, with no new event type, no new agent, and no new
schema surface for the player character.

Exit criterion: a campaign walks the six-node arc to `reckoning`, whose
authored effects now include one that shifts an NPC's affinity band and one
that records a fact; `campaign.state.world.scene.npcAffinities` reflects
both after the node completes; and a reload of the same campaign from the
event log folds to the identical `CampaignState` the live one held.

## Context

Facts checked against the repo at `220985c`, not recalled.

**"Character profile" adds nothing new.** `DerivedCharacter`
(`packages/schemas/src/derived.ts`) is already a complete computed 5e stat
block — abilities, HP, skills, attacks, saves — plus `nameHebrew` and
`grammaticalGender` for gendered narration. Nothing downstream of this step,
including step 7's own description, names a PC-side field this schema is
missing. ADR-0002 (solo PC, ACCEPTED) means there is exactly one character to
profile, and it is already fully profiled for every mechanical and narrative
purpose the codebase has. §4.7's "character profiles" half of this step's
name is satisfied by this paragraph, not by new code: this step's entire
schema and behavior surface is NPC affinity.

**`social` is the one intent category that changes nothing today.** Step 4's
spec, Decision 6: `social`, `ooc`, and `combat` are narrate-only — "a
grounded reply off the scene card and the category alone... no state change"
(`pipeline.ts:1555-1571`). That decision was deliberate, not an oversight,
and this step does not reopen it: NPC affinity's only mutator remains an
authored `WorldEffect`, applied by the pure scene engine on quest-node
completion, exactly the shape `shift_faction_relation` already has. A social
conversation cannot move affinity in this step — only completing an authored
node with the effect declared on it can. Whether a live conversation should
someday propose its own shift is named as a non-goal below, deliberately, the
way step 5 named permadeath beside this step rather than deciding it there.

**The faction-band precedent is a near-exact template, with one
combinatorial difference.** `FACTION_BANDS`
(`packages/schemas/src/content.ts:48-58`) is a named seven-value scale whose
order *is* the -3..+3 scalar. `FactionRelationEntry` values live in two
places: `WorldManifest.factionRelations` declares the full authored baseline
(every unordered pair, exactly once — the loader refuses a missing or
duplicated pair), and `SceneSnapshot.relations` (`protocol.ts:31-39`) is a
deltas-only overlay carrying only pairs a completed node has actually
shifted. `relationBetween` (`rules-engine/scene/index.ts:80-88`) is the one
place that merges them: state first, authored baseline second. NPC affinity
does not have the combinatorial problem a pairwise scale has — there is one
sensible default for an NPC nobody has interacted with (`neutral`, no facts),
so there is no missing-pair ambiguity to guard against and no authored
baseline to declare. The overlay is therefore the *whole* of NPC affinity's
storage; its "baseline" is a hardcoded constant, not a second table.

**Effects are reachable only through a node completing, by design.**
`applyEffect` (`rules-engine/scene/index.ts:222-244`) is deliberately not
exported — its doc comment states the reason outright: "nothing can shift a
faction band by asking." `completed()` applies a node's effects exactly once,
guarded by `completedNodeIds`, so a cycle cannot pump the same shift twice.
NPC affinity's two new effects reuse this exact gate with no changes to it.

**`world_delta_applied` already carries "the engine's already-computed,
already-clamped RESULT, never a delta to compute"**
(`events.ts:302-313`) — its doc comment states the rule this step's payload
extension follows verbatim. `diffScene` (`rules-engine/scene/snapshot.ts:68-79`)
is the one place that rule is implemented: it compares `before`/`after`
`SceneState` and emits only what changed. The pipeline calls it in exactly
two places — the combat-bridge's victory branch (`pipeline.ts:1108-1121`) and
the exploration branch's own node-completion path (`pipeline.ts:1429`) — and
both already gate the event on "did anything change," which this step's
addition must join rather than duplicate.

**No new event type is needed.** `world_delta_applied` is already a member of
`GameEvent.type`'s enum (`events.ts:23`). This step only grows that event's
payload, the same move `encounter_started` made in step 5 for its board
fields — an existing event learning to carry more, not a new one.

**The loader already tracks NPCs and already has the cross-reference
machinery this step needs.** `AuthoredWorld.npcs`
(`rules-engine/scene/authored-world.ts:31`) and the loader's `npcs` map
(`apps/server/src/world/index.ts:172`) already exist for `NpcDefinition`'s
own `locationId`/`factionId` checks. `ContentKind`
(`world/index.ts:88`) is `"faction" | "location" | "quest node"` today — it
has never needed `"npc"` as a *target* kind, because nothing has referenced
an NPC from a predicate or effect before. `effectRefs`/`predicateRefs`
(`world/index.ts:119-142`) are the two exhaustive switches a new effect kind
must extend, following the same no-`default` discipline `reduce.ts` and
`evaluatePredicate` already enforce.

**Authored content today:** three NPCs (`data/world/npcs.json`) —
`maren-vess` (Ashen Guild factor), `old-tobin` (River Wardens' weir warden),
and `sela-the-innkeeper` (unaligned) — and the six-node arc step 5 completed,
ending at `reckoning`, whose scene card already stages all three NPCs at one
table and whose existing effects shift the two factions' standing and
advance the calendar two days.

**Baseline, measured on this branch at `220985c`:** matches step 5's
recorded numbers — 1605 passed / 0 skipped / 104 files with
`DATABASE_URL=postgres://localhost:5432/aidm_step5_scratch`; `pnpm typecheck`
and `npx eslint packages apps tools` both exit 0.

## Decisions

### 1. No new player-character schema

`DerivedCharacter` is unchanged. This step's "character profile" half is
satisfied by the Context section above, not by code. If a future step
genuinely needs backstory, goals, or personality fields for narration, that
is its own decision against its own consumer — none exists today.

### 2. Affinity shifts only through an authored `WorldEffect`, applied on node completion

Two new `WorldEffect` variants, each single-purpose like the two effects
already there:

```ts
z.object({
  kind: z.literal("shift_npc_affinity"),
  npcId: ContentId,
  /** Bands, not points, same bound as shift_faction_relation. Clamping is the engine's job. */
  delta: z.number().int().min(-6).max(6),
}),
z.object({
  kind: z.literal("add_npc_fact"),
  npcId: ContentId,
  /** English, internal-only — never shown to the player verbatim. See Decision 5. */
  fact: z.string().min(1),
}),
```

Two effects rather than one combined `{npcId, delta?, fact?}` shape, matching
how `shift_faction_relation` and `advance_calendar` are already split by
concern rather than merged — a node that wants both simply lists both in its
`effects` array, which is already how `reckoning` combines a faction shift
with a calendar advance today.

No dynamic path. No LLM proposes an affinity shift, no validator adjudicates
one, and `social`'s narrate-only behavior (step 4 Decision 6) is untouched.
This is the same propose-nothing shape `shift_faction_relation` already has:
invariant 1 stays intact because nothing shifts a band "by asking" — only
authored content, applied by a pure function, on a node that already
completed through the existing gate.

No `npc_affinity_at_least` predicate. `faction_band_at_least` exists because
step 3's arc needs to gate `reckoning` on faction standing; nothing in this
step's content or step 7's stated needs gates entry on NPC standing, and a
predicate with no caller is the override-with-no-second-caller shape the
combat-bridge spec already declined to build (its Decision 1, for
`encounterId` parameterization). One-line addition later if an authored node
ever needs it.

### 3. One shared band scale, reused rather than duplicated

NPC affinity is scored on the existing `FactionBand`/`FACTION_BANDS`
(`content.ts:48-58`), not a second enum. The band names ("cordial",
"friendly", "cold") read naturally for a person, not only a faction; a
duplicate enum with the same seven values would be exactly the "one table
rather than two that can disagree" problem `FACTION_BANDS`'s own doc comment
exists to prevent, for zero present benefit — nothing in this step or step 7
needs affinity semantics faction standing cannot express. `shiftBand`
(`rules-engine/scene/index.ts:55-62`) is reused unchanged: NPC affinity
shifts by the identical clamped index arithmetic.

### 4. The overlay is the whole store; the fallback is a constant, not a second baseline

`SceneSnapshot` (`protocol.ts:31-39`) gains:

```ts
/** Deltas-only overlay: ONLY NPCs an authored effect has actually touched.
 *  Read through `affinityOf`, never alone — absent means neutral, no facts,
 *  the same "state overlays baseline" shape `relations` has, except the
 *  baseline here is a constant rather than a second authored table (no
 *  per-NPC starting affinity is declared anywhere; see Decision 5). */
npcAffinities: z.array(NpcAffinityEntry).default([]),
```

`NpcAffinityEntry` (new, `content.ts`, beside `FactionRelationEntry`):

```ts
export const NpcAffinityEntry = z.object({
  npcId: ContentId,
  band: FactionBand,
  facts: z.array(z.string()).default([]),
});
```

`.default([])` on the `SceneSnapshot` field for the same reason
`WorldState.scene` defaults to `null`: a pre-step-6 snapshot — in a stored
`campaign_snapshots` row or a hand-built fixture — has no such field, and it
must still parse (append-only compatibility). `sceneFromGenesis`
(`protocol.ts:78-95`) is updated to set `npcAffinities: []` alongside
`relations: []`.

In `rules-engine`, `SceneState` (`scene/index.ts:31-38`) gains:

```ts
/** Keyed by bare npcId — no pairKey needed, this is not a pairwise relation. */
readonly npcAffinities: ReadonlyMap<string, { band: FactionBand; facts: readonly string[] }>;
```

and a new exported function beside `relationBetween`:

```ts
/**
 * An NPC's standing and remembered facts, read from the overlay with a
 * hardcoded default for any NPC nobody has interacted with yet. Unlike
 * `relationBetween`, there is no authored baseline to fall back to second —
 * a single sensible default covers every NPC, so declaring one per NPC in
 * `content.ts` would be authoring surface with no consumer (Decision 5).
 */
export function affinityOf(
  state: SceneState,
  npcId: string,
): { band: FactionBand; facts: readonly string[] } {
  return state.npcAffinities.get(npcId) ?? { band: "neutral", facts: [] };
}
```

`applyEffect`'s switch (`scene/index.ts:222-244`) gains two cases, both
reading the current value through `affinityOf` and writing the whole record
back — there is no "unknown pair" bail-out like `shift_faction_relation`'s,
because `affinityOf`'s fallback always resolves:

```ts
case "shift_npc_affinity": {
  const current = affinityOf(state, effect.npcId);
  const npcAffinities = new Map(state.npcAffinities);
  npcAffinities.set(effect.npcId, { ...current, band: shiftBand(current.band, effect.delta) });
  return { ...state, npcAffinities };
}
case "add_npc_fact": {
  const current = affinityOf(state, effect.npcId);
  const npcAffinities = new Map(state.npcAffinities);
  npcAffinities.set(effect.npcId, { ...current, facts: [...current.facts, effect.fact] });
  return { ...state, npcAffinities };
}
```

`sceneStateFrom`/`snapshotOf`/`diffScene` (`scene/snapshot.ts`) extend in
parallel with their existing `relations` handling: `sceneStateFrom` builds
the map from the snapshot array; `snapshotOf` serializes it back sorted by
`npcId` (canonical, the same reason `relations` sorts); `diffScene` emits a
`NpcAffinityEntry` for any `npcId` whose `band` or `facts` differ between
`before` and `after` — the same "compare the two states, never recompute
from effects" rule the faction half already follows.

### 5. Facts are English, internal-only — no third sanctioned Hebrew field

`add_npc_fact`'s `fact` is plain English, short, structured content an
author writes (e.g. `"helped broker peace between the Guild and the
Wardens"`), stored only in `SceneSnapshot.npcAffinities` and never rendered
to the player directly. This is a deliberate reading of invariant 2: Hebrew
is sanctioned to leave the system through exactly two fields today
(`narrative_emitted.text`, `player_input.text`), and this step adds no
third. A fact becomes player-visible only if some future narration step
chooses to read it and have the narrative agent phrase it in Hebrew at
generation time — the same place every other piece of English game state
already crosses into Hebrew. Storing the fact itself in Hebrew would be
storing narration, which is exactly what invariant 2 exists to keep out of
the log.

### 6. `world_delta_applied` carries the affinity diff exactly like it carries the faction diff

`WorldDeltaAppliedPayload` (`events.ts:307-313`) gains:

```ts
/** Absolute resulting affinity, post-clamp, whole entries — the fold merges,
 *  never computes. Same contract as `relations`. */
npcAffinities: z.array(NpcAffinityEntry).default([]),
```

`reduce.ts`'s `world_delta_applied` case gains an upsert of `npcAffinities`
onto `scene.npcAffinities` keyed by `npcId` — replace the whole entry for a
touched id, leave every other entry untouched — mirroring the existing
`relations` merge (keyed by pair) exactly.

Both call sites that build this payload (`pipeline.ts:1108-1121` and the
exploration branch's equivalent, `~1429`) extend their existing "does
anything actually differ" gate to include `delta.npcAffinities.length > 0`,
so a node whose effects touch nothing still emits no `world_delta_applied` —
unchanged behavior for every node that declares no NPC effect, including
every node before `reckoning`'s update below.

### 7. The loader learns `"npc"` as a referenceable content kind

`ContentKind` (`world/index.ts:88`) gains `"npc"`; `collections`
(`world/index.ts:175-179`) gains `npc: npcs` — the map is already built at
line 172 for `NpcDefinition`'s own checks, so this is a one-line addition to
an existing record literal, not new indexing.

`effectRefs` (`world/index.ts:132-142`) gains:

```ts
case "shift_npc_affinity":
  return [{ kind: "npc", id: effect.npcId }];
case "add_npc_fact":
  return [{ kind: "npc", id: effect.npcId }];
```

so a typo'd `npcId` in an authored effect fails at `loadWorld` the same way a
bad `factionId` does today, rather than silently no-oping at runtime through
`affinityOf`'s fallback.

### 8. Demonstrated on the existing arc, not a new node

`reckoning`'s scene card already stages all three NPCs together
("Sela clears the long table... Maren Vess arrives with her ledgers; Old
Tobin arrives with a piece of the forced gate mechanism") and its `effects`
array already mixes a faction shift with a calendar advance. Its effects
gain two more entries:

```json
{
  "kind": "shift_npc_affinity",
  "npcId": "sela-the-innkeeper",
  "delta": 1
},
{
  "kind": "add_npc_fact",
  "npcId": "sela-the-innkeeper",
  "fact": "hosted and helped broker the reckoning between the Guild and the Wardens"
}
```

`sela-the-innkeeper` is unaligned with either faction (`npcs.json` gives her
no `factionId`), so her affinity moving reads as personal rather than a
restatement of the faction shift already on the same node. No seventh arc
node, no change to `arc.json`'s node count or any test pinning it — this
step adds fields to an existing node's `effects`, not new nodes or edges.

## What this must not make worse

**`social` stays narrate-only.** Step 4 Decision 6 is untouched; nothing in
this step lets a conversation mutate state. The only mutator is an authored
effect applied on node completion, exactly `shift_faction_relation`'s shape.

**Append-only compatibility holds.** `SceneSnapshot.npcAffinities` and
`WorldDeltaAppliedPayload.npcAffinities` both default to `[]`, so a payload
or stored snapshot from before this step still parses and folds to a valid
state with no NPC affinity recorded — the same guarantee `WorldState.scene`'s
`.default(null)` gives pre-step-4 genesis payloads.

**No new event type.** `world_delta_applied` already exists; this step widens
its payload, not `GameEvent.type`'s enum.

**The engine's purity is not relaxed.** `applyEffect`'s two new cases are
pure functions over `SceneState`, called only from `completed()`'s
already-existing once-per-node gate. No `Date.now()`, no I/O, no LLM,
`applyEffect` stays unexported.

**Invariant 1 is untouched.** Nothing shifts an NPC's standing "by asking."
The two new effects reach the engine only through a node that already
completed via the existing precondition-gated traversal.

**Invariant 5 holds in both directions.** `@ai-dm/schemas` gains a data
shape and no behavior; `apps/web` still imports only `@ai-dm/schemas`, and
`affinityOf`/`applyEffect`/`diffScene` all stay in `rules-engine`, reachable
by `apps/server` but not by `apps/web`.

**English inside, Hebrew outside.** No new sanctioned Hebrew field.
`add_npc_fact`'s `fact` is English and internal-only (Decision 5).

**Exhaustiveness discipline.** `applyEffect`, `effectRefs`, and `evaluatePredicate`
all stay `default`-free switches; the two new `WorldEffect` members force a
case in every switch that already covers the union, the same way adding
`encounterId` forced Decision 7's cross-reference in step 5.

**Coverage does not drop.** `packages/rules-engine` stays ≥90% lines; the two
new `applyEffect` cases and `affinityOf`'s fallback need their own tests, not
incidental coverage from an existing one.

## Non-goals

- **Dynamic, LLM-proposed affinity shifts from live social dialogue.** The
  crux question this step could have answered differently: an agent
  proposing "the player complimented the blacksmith, shift +1" would need a
  rules-engine validator and new tool-schema surface, the same
  propose-then-validate shape combat already has. Nothing in this step's
  scope or step 7's stated needs requires it, and step 4 deliberately made
  `social` narrate-only for exactly this reason. Belongs beside step 7 or
  later, the way step 5 named permadeath beside this step rather than
  deciding it there.
- **`npc_affinity_at_least` predicate.** No authored caller exists (Decision 2).
- **Authored per-NPC starting affinity.** No per-NPC baseline field is added
  to `NpcDefinition` or `WorldManifest`; every NPC starts at the hardcoded
  `neutral`/no-facts default (Decision 4).
- **Any new player-character schema** — backstory, personality, goals.
  `DerivedCharacter` is unchanged (Decision 1).
- **Episodic memory itself (step 7).** This step produces the projection step
  7 names as its consumer; it does not build retrieval, embeddings, or the
  scene-summarizer tier §4.7 assigns to step 7.
- **Facts visible to the player, or a third sanctioned Hebrew field.**
  Decision 5.
- **Party mechanics.** ADR-0002 is untouched; affinity is scoped to the one
  human-controlled character's relationships, not a party's.
- **`packages/memory/CLAUDE.md`.** Carries an uncommitted edit that is not
  this step's; excluded exactly as steps 3, 4, and 5 excluded it.
