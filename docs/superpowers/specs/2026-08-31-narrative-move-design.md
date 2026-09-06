# The GM tier, `NarrativeMove`, and authored detours — design

The `NarrativeMove` that `PROJECT_PLAN.md` §4.7's **"The governing
constraint"** names and defers. It lands after step 7 (episodic memory) and
before §4.7's step 8, the closed beta — it is not a new numbered step in that
sequence but the piece the sequence's own opening section says must exist. The
intent-router spec
([`2026-08-28-intent-router-design.md`](2026-08-28-intent-router-design.md))
defers it in one line of its Non-goals: *"A GM tier / `NarrativeMove`. The
router selects from enumerated choices; it composes nothing."*

Playing the shipped arc end to end exposes what that deferral costs. **Only
authored edges can change the world.** The intent router is a closed-set
classifier and only its `exploration` category mutates state. `check` rolls
and logs but never gates anything. `social`, `ooc` and `combat` narrate a
grounded reply and change nothing at all. A player who says something the
six-node DAG has no branch for gets fluent Hebrew and an unmoved world; and
once `reckoning` concludes, the arc is simply over.

That is deliberate, not a bug — nothing may happen that the engine has no
vocabulary to refuse. This step gives the engine that vocabulary.

The governing constraint is unchanged and is the reason for every decision
below: an LLM **proposes**, a pure engine **validates**, and only what the
engine accepted becomes events. What is new is that the proposal is now a
world move rather than a choice from a menu — which is exactly why the
validator has to be stricter than a menu ever needed to be.

Exit criterion: in a live Emberfall campaign, a player who says something the
DAG has no branch for sees the world change in a way the log can explain — an
NPC's regard shifts with a recorded reason, or an authored detour opens — and
no sequence of improvised moves can make the arc's own ending unreachable.
A campaign that improvises nothing behaves exactly as it does today.

## Context

Facts checked against the repo at `bfaf0a2`, not recalled.

**The effect vocabulary already exists and is locked behind the DAG.**
`WorldEffect` (`packages/schemas/src/content.ts`) has five kinds:
`shift_faction_relation`, `advance_calendar`, `shift_npc_affinity`,
`add_npc_fact` and `long_rest`. `applyEffect`
(`packages/rules-engine/src/scene/index.ts`) is **deliberately not exported**,
with a doc comment saying why: "An effect is reachable only through a node
completing, which is what keeps invariant 1 intact one level above combat:
nothing can shift a faction band by asking." So the machinery to make a detour
matter is built, tested, and unreachable.

**The arc's ending has zero margin.** `apps/server/src/world/arc.test.ts:126`
states it directly: `reckoning` gates on `faction_band_at_least ... hostile`,
and `hostile` is the *lowest band reachable before it*. `world.json` starts the
pair at `cold`; `guild-offer` applies `-1`, landing on exactly `hostile`. A
single improvised `-1` on that pair would put the campaign at `war` and make
the arc's own ending permanently unenterable. This is one conversation away,
and it is what §2's door guard exists to make structurally impossible.

**The loader has no orphan rule.** `apps/server/src/world/index.ts`
cross-references edge targets, predicate node ids and effect faction ids, but
nothing asserts that a node is *reachable*. A quest node with no inbound edge
loads silently today.

**`intent_classified` is the precedent for an audit event.** It is in the
`GameEvent` enum and a no-op in `reduce` (`packages/schemas/src/reduce.ts:313`,
grouped with `check_rolled`). It exists to record what a model proposed, not to
move state. `narrative_move_applied` is the same thing one tier up.

**Model-written English already lands in event payloads.**
`quest_node_completed.summaryEnglish` is written by the summary tier. So a
model-written `reasonEnglish` on a move sets no new precedent — and it is
English, so invariant 2 is untouched.

**A `z.discriminatedUnion` compiles to `anyOf`, which google's tool-schema
subset rejects with a 400.** That is why `intent` routes to openai
(`google-cannot-express-unions`, and the 2026-08-30 outage `IntentCallMetrics.message`
was added for). `NarrativeMove` is a discriminated union, so the GM tier
inherits the same routing constraint.

**Content counts are pinned.** `apps/server/src/world/index.test.ts:26-29`
asserts 2 factions, 1 location, 3 NPCs, 6 quest nodes.

## Decisions

### 1. A `NarrativeMove` is a closed union, and its effect vocabulary is a subset of the authored one

`packages/schemas/src/narrative-move.ts`:

```
NarrativeMove =
  | { kind: "none" }
  | { kind: "world",        effects: ImprovisedEffect[1..2], reasonEnglish }
  | { kind: "enter_detour", nodeId: ContentId,               reasonEnglish }
```

Three kinds and no more. `none` is always legal and is what every failure
path degrades to, so "the model had nothing to add" and "the model call
failed" produce the same, already-correct behaviour.

`ImprovisedEffect` is `WorldEffect` **minus `long_rest`**. Healing to full is
the one effect with no narrative reading that a conversation should be able to
produce; every other kind is a thing a scene genuinely can change.

Expressing "one union minus a member" without a hand-written duplicate
(invariant 4) means refactoring `content.ts` so each effect member is its own
named schema, with `WorldEffect` defined as the union of all five and
`ImprovisedEffect` as the union of four. One definition per member, two unions
over them, nothing duplicated. This is a mechanical refactor of an existing
file and changes no shipped behaviour.

`enter_detour` carries no effects of its own. A detour node's authored
`effects` already fire when it completes, through `completed()` — giving the
move its own effect list too would be a second path into the same state change
that could disagree with the first.

`reasonEnglish` is required on both mutating kinds. §4.7: shifts are "declared
effects of specific logged choices, **with a reason** — not a hidden morality
meter", because "why did my character become this" must be answerable from the
event stream. A move with no reason is not loggable in the sense the plan
requires.

Because this is an `anyOf`, the GM tier routes to **openai**, for the same
reason and with the same failure mode as `intent`.

### 2. The safety net: a move may not close a door that is currently open

This is the whole answer to "what stops the model contradicting the arc", and
it is one rule:

> Apply the proposed effects to a candidate state. For every quest node **not
> yet completed**, every precondition that evaluated `true` against the state
> before must still evaluate `true` against the candidate. Any `true → false`
> flip refuses the entire move.

Three properties make this the right rule rather than a faction special-case:

- It is written over `evaluatePredicate`, so it covers `node_completed` and
  `faction_band_at_least` today and **every predicate kind added later for
  free** — including the check-gated traversal the intent-router spec defers.
- It refuses only *closing*. A gate that was already shut staying shut is
  fine; a gate opening is fine. Improvisation may make the world more
  reachable and never less.
- It makes the `reckoning` lockout described in Context **structurally
  impossible**, without the engine knowing anything about `reckoning`.

The whole move is refused, not the offending effect. A partially applied
two-effect move is a state no author and no model asked for.

Alongside it, one cheap ceiling: an improvised `shift_faction_relation` or
`shift_npc_affinity` with `|delta| > 1` is refused. Authored content keeps the
full `-6..+6` range — an author declaring "as hostile as this gets" is
deliberate; a model swinging a town from `cold` to `allied` because the player
was polite is not. This lives in the validator, **not** in the schema, so
`ImprovisedEffect` stays a pure subset of `WorldEffect` with no divergent
bound to keep in sync.

`SceneRejectionReason` gains one member, `would_close_door`.

### 3. Detour nodes are marked, and the marker pays for itself

`QuestNode` gains `detour: z.boolean().default(false)`. A detour node has no
authored inbound edge and may be entered **only** by a validated
`enter_detour`.

The marker does three jobs for one field:

1. **It bounds the GM tier.** A move may name only a `detour: true` node, so
   the model cannot jump the player into a spine node out of order. Combined
   with §2, an improvised move can neither skip the arc nor break it.
2. **It buys the loader an orphan check it does not have today.** Once
   detours are declared rather than merely unreferenced, the loader can assert
   that every non-detour node except `startingNodeId` has an inbound edge, and
   that no authored edge points *at* a detour node. A typo'd edge target stops
   being silently unreachable content.
3. **It keeps `availableEdges` honest.** Detours never appear in a node's
   edge list, so the affordances the player is shown and the edges the intent
   router sees are unchanged. A detour arrives through the fiction, not
   through a button.

Entry sets a return pointer to the node being left. **No nesting**: a move may
not enter a detour while already standing in one. One level is what a detour
means; a stack is a feature nothing has asked for and would need its own
serialized form.

### 4. Lifecycle: none

A detour node is an ordinary `QuestNode`. It ends through its own authored
edges — including one back to the spine — abandoning it is leaving without
completing it, and "did they ever finish it" is already answerable by the
existing `node_completed` predicate.

So there is no thread status, no `opened`/`resolved`/`abandoned` enum, and no
second bookkeeping system next to `completedNodeIds` that could disagree with
it. A multi-step thread is free: a detour node may edge to another detour node,
and the return pointer set on entry survives until the player leaves the
detour region.

### 5. One new state field, one new event

**State.** `SceneState` gains exactly one field,
`detourReturnNodeId: string | null`. It rides on `quest_node_entered`'s payload
as a new optional field rather than needing an event of its own: `reduce` sets
it when the payload carries one and clears it otherwise, so a normal spine
traversal clears the pointer as a side effect of the event it already emits.
`SceneDelta` (`diffScene`) and `SceneSnapshot` carry the field.

**Event.** One new `GameEvent` type, `narrative_move_applied`, payload
`{ actorId, move, reasonEnglish, provider, modelId, promptVersion }`, mirroring
`intent_classified`'s shape field for field. It is a **no-op in `reduce`**, for
the same reason `intent_classified` is: the state change is already carried by
the `world_delta_applied` and `quest_node_entered` events emitted alongside it,
and this event exists purely as the audit record. Extending the enum trips
`reduce`'s exhaustiveness check, which §4.7 says is by design.

A **refused** move emits nothing at all. It is reported through
`MetricsPort.recordGmCall` — the same audit-versus-metrics split
`IntentCallMetrics` already established, where a failed classification produces
metrics and no event.

Every event a single move produces goes through **one** `emitAll` call, not
several `emit`s. This is the rule Task 9's review established for the
exploration branch: separate appends leave a window where a store failure
durably records half a transition that no later turn can repair.

### 6. The GM tier

`packages/agents/src/gm/`, mirroring `intent/` file for file:
`prompt-text.ts` (with `GM_PROMPT_VERSION = "gm-v1"` and its sha256 pinned in
`prompt-text.test.ts`, per the repo's convention), `prompt.ts` for the layered
brief, and `index.ts` exporting a `GmAgent` port, `createGmAgent`, and a
`GmResult` shaped like `IntentResult`.

Its brief carries: the scene card for the node the player is standing in, the
NPCs present (from the same `questNodeCard` the router and narrator already
share, so all three cannot disagree about who is in the room), the
classification just made, the check outcome when the turn rolled one, and the
detours currently enterable. The player's Hebrew message arrives delimited as
untrusted user-turn content, exactly as it does for `intent`.

The engine builds the detour list, not the model: one new pure function,
`availableDetours(world, state)`, reusing `entryRejections`. Faction pairs need
no enumeration — the loader guarantees every pair exists, `applyEffect` no-ops
an unknown one, and §2's guard catches the dangerous ones.

### 7. The pipeline: every `free_text` turn, after whatever the category did

The GM tier runs on **every** `free_text` classification, not only the ones
that change nothing today. This is a deliberate cost choice: it pays for a
second model call on `exploration` turns the DAG already answered, in exchange
for one uniform rule and one code path. `recordGmCall`'s metrics are what make
it revisitable with data rather than argument.

Integration is a local generator, `gmStep(deadline)`, invoked with `yield*`
immediately **before** each `sceneNarrate` call — four sites, and no
restructuring of the 450-line `free_text` branch. It runs against the
**post-transition** state, so on `exploration` the traversal happens first and
the improvised move colours the node the player now stands in. Ordering is
therefore never ambiguous: the DAG moves, then improvisation decorates.

It also runs on an exploration **refusal**, where the traversal did not happen.
An improvised move salvaging a refused traversal is the same thing a human DM
does when a player reaches for something that is not there, and excluding that
case would mean a rule with an exception in it.

The call shares the turn's existing budget — the same `deadline` the classify
call and `sceneNarrate` already run under — and a timeout, a provider failure,
or an engine refusal all degrade to `{ kind: "none" }`. A turn never fails
because improvisation did not work out; it just does not improvise. This is the
degradation posture `sceneNarrate` already takes.

The intent router is **untouched**: no `intent-v3`, no re-pinned sha256, no
larger tool schema fighting google's subset.

### 8. Content

Two detour nodes in `data/world/arc.json`, both `detour: true` and both
non-combat — the encounter catalogue stays at `goblin-ambush`, which is a
known separate gap. One is enterable from the town at large; one is enterable
after `reckoning`, which is what gives a concluded arc somewhere to go and
closes the "the arc is simply over" half of the problem this step exists for.

`world.questNodes.size` in `apps/server/src/world/index.test.ts` moves 6 → 8.
The other three pinned counts are unchanged: no new factions, locations or
NPCs, so a detour reuses the cast the player already knows.

## What this must not make worse

- **Invariant 1.** The model proposes a move; `validateMove` decides whether
  it is legal, and `applyEffect` stays unexported. Nothing here lets an LLM
  write state, invent an NPC the world does not have, or open a node whose
  predicate refuses.
- **Invariant 3.** Every mutation is still an event, and `reduce` still folds
  a campaign from its log alone. The one new state field is folded from an
  existing event's payload.
- **Invariant 4.** `ImprovisedEffect` is composed from `WorldEffect`'s own
  members, never re-declared. The refactor that makes that possible is the
  price of not duplicating a schema.
- **Replay.** `validateMove` is pure, takes the world injected, and reads no
  clock and no random source. A move's effects are recorded as a
  `world_delta_applied` diffed from the engine's own pre/post states, never
  re-read from the proposal — so replaying a log reproduces the state the live
  campaign held even if the GM prompt changes.
- **The existing arc.** A campaign that never improvises emits no
  `narrative_move_applied`, folds identically, and plays byte-for-byte as it
  does today. `detour` defaults to `false`, so every existing authored node is
  unchanged.
- **Combat.** `free_text` is still refused while a bracket is open, so no GM
  move can fire mid-fight.
- **Cost.** One extra tier call per `free_text` turn, reported through
  `recordGmCall` alongside the four existing billed sources.

## Known ceilings

- **The door guard scans all uncompleted nodes, not only reachable ones.** A
  node the player can no longer get to still constrains what may be improvised.
  Over-strict in theory, irrelevant across eight nodes, and reachability
  analysis is a great deal of machinery to buy a distinction nothing currently
  notices. Marked in the code; revisit when the graph is large enough for it
  to bite.
- **Detours do not nest.** One level, by §3.
- **A detour cannot declare an encounter.** Not a limitation of the design —
  `encounterId` works on any node — but the catalogue has one entry, so
  authoring a combat detour would ship the same goblins twice.

## Non-goals

- **Growing the encounter catalogue.** A known separate gap.
- **Check-gated traversal.** Still the intent-router spec's deferred predicate
  kind. A check informs what the GM tier may propose; it does not open an edge.
  §2's guard is written so that predicate kind needs no changes here when it
  lands.
- **A second Hebrew event payload field.** `reasonEnglish` is English, and
  detour nodes use the existing `labelHebrew`/`nameHebrew` authored-label
  precedent. Nothing here asks for a third sanctioned Hebrew payload field.
- **Re-opening the authored-DAG-versus-emergent-world decision.** §4.7 settled
  it; this design is what "authored spine, simulation as texture" cashes out to.
- **Emergent NPCs, locations or factions.** The model reaches authored content
  by id and never creates any. Improvisation is in *when* and *how*, never in
  *what exists*.
- **In-combat free text.** Unchanged.
- **Re-running the step 7b model benchmark.** Routing is settled.
