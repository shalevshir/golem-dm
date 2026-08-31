# Death saves, persistent HP, and a long rest — design

Not a numbered §4.7 step — a wave-1 MVP-playability fix (post-step-7 gaps,
tracked informally, not in the roadmap sequence). §4.7 steps 1–7 are merged;
the story loop runs end to end, but nothing survives losing a fight.

Facts checked against the repo at `ed60f43`, not recalled.

## The one problem behind three symptoms

`RULES_REFERENCE.md` §8 names the first gap outright: `resolve.ts` pins
`diesAtZeroHp: true` unconditionally, so a player character dies instantly at
0 HP exactly like a monster. `rollDeathSave` (`combat/index.ts`) is fully
implemented and tested, but nothing in the encounter pipeline ever calls it —
its own doc comment says so. Both narrators already render an `unconscious`
beat neither can ever reach, because `targetStatusAfter` never comes back as
anything but `"dead"` or `"alive"`.

Carrying HP between fights and adding a long rest hit the same wall from a
different angle: there is nowhere to put the number. `WorldState`
(`protocol.ts:66`) holds `campaignId`, `rootSeed`, `appliedClientMessageIds`,
`scene`. `SceneSnapshot` (`:31`) holds `worldId`/`currentNodeId`/
`completedNodeIds`/`relations`/`npcAffinities`/`day`. Neither has a hit point
in it. `EncounterState` has HP on every `Combatant`, but it is discarded
whole the moment `encounter_resolved` closes the bracket
(`reduce.ts:210`: `return { ...state, encounter: null }` — nothing survives).

One decision unblocks all three: give the hero's current HP a home that
outlives an encounter. Death saves become drivable because a PC can now
survive to 0 HP instead of dying there. HP carries forward because there is
somewhere to write it when a fight ends. A long rest is one authored effect
that writes the same field.

## Decision 1 — `heroHp` lives inside `SceneSnapshot`, as current HP only

```ts
export const SceneSnapshot = z.object({
  worldId: ContentId,
  currentNodeId: ContentId,
  completedNodeIds: z.array(ContentId),
  relations: z.array(FactionRelationEntry),
  npcAffinities: z.array(NpcAffinityEntry).default([]),
  day: z.number().int().min(1),
  /** The hero's current HP. Never their maximum — that is re-derived from
   *  the loaded CharacterSheet every time, exactly like every other derived
   *  stat, and is never stored twice. */
  heroHp: z.number().int().min(0),
});
```

Not on bare `WorldState`. `SceneSnapshot` is already null for exactly the
cases that have no hero to have HP: a combat-only `{encounterId}` campaign,
and — append-only compatibility — every campaign that predates §4.7 step 4's
genesis quartet. A hero's condition is scene-shaped by construction: it
exists exactly when `characterId` does, which is exactly when `scene` does.
Nesting it there means "no HP to track" is the same `null` that already means
"no scene," not a second nullable field that could disagree with the first.

**Why current HP only, never max.** Max HP is a `DerivedCharacter` fact
(`derived.ts:29`), recomputed from `data/characters/<id>.json` by
`loadCharacter` every time it is needed — `apps/server` already never
persists it anywhere. Storing a second copy in the event log would be a
value that can drift from the character sheet it was derived from, which is
exactly the class of duplication invariant 4 forbids one level down (schemas
defining shapes twice). Every consumer below reads current HP off `scene`
and max HP off `loadCharacter(characterId)` — never invents a third figure.

**Genesis.** `sceneFromGenesis` (`protocol.ts`) stays pure — it cannot call
`loadCharacter`, and does not need to: it gains a second parameter,
`heroMaxHp: number | undefined`, and sets `heroHp: heroMaxHp ?? 0` (the
`?? 0` branch is dead for any real quartet — all four genesis fields are
already all-or-none, so `heroMaxHp` is present exactly when `characterId` is).
`campaign.ts`'s `initialWorldState`, the ONE place both `createCampaign` and
`loadCampaign` construct a starting `WorldState`, resolves the character once
and threads its `maxHp` in. A campaign always starts full HP; there is no
scenario where a fresh genesis needs anything else.

**Append-only compatibility.** `SceneSnapshot` is never itself parsed back
out of stored JSON — it is *projected*, fresh, every time `initialWorldState`
+ `reduce` run over a log (`sceneFromGenesis` is called from source each
load, not deserialized). So there is no legacy-payload shape to tolerate for
this field the way `EncounterStartedPayload`'s board fields need `.optional()`
— every campaign, old or new, gets a freshly computed `heroHp` the moment it
loads. What DOES need append-only handling is the two event payloads that
carry a *delta* into this field forever afterward (Decisions 3 and 4).

## Decision 2 — a `Combatant` carries its own death-save tally

```ts
export const DeathSaveTally = z.object({
  successes: z.number().int().min(0).max(3),
  failures: z.number().int().min(0).max(3),
});

// On Combatant:
deathSaves: DeathSaveTally.optional(),
```

`rollDeathSave` (`combat/index.ts`) already takes and returns exactly this
shape (`DeathSaveState`) — the schema mirrors it structurally rather than
importing it, for the same reason `Combatant.status`/`HitPoints` already
don't import from `rules-engine`: `@ai-dm/schemas` may not depend on it
(dependency direction, root `CLAUDE.md` §5).

Absent means "never rolled" — a combatant who has never been unconscious, or
one whose tally reset because it woke or stabilized. It does not outlive the
encounter (Decision 5 does not carry it into `SceneSnapshot`); a fresh fight
always starts with no pending death save, which is correct even for a hero
who ended the last fight Stable — RAW gives a full recovery from 1 HP or a
short/long rest before the next threat, and nothing here models a
perpetually-dying hero walking into their next encounter already 2 failures
deep.

## Decision 3 — `diesAtZeroHp` is read, not pinned

`resolve.ts:205-209`:

```ts
const applied = applyDamage(
  { currentHp: target.currentHp, maxHp: target.maxHp, tempHp: target.tempHp },
  damage,
  { diesAtZeroHp: target.characterId === undefined },
);
```

Exactly the rule `DamageOptions.diesAtZeroHp`'s own doc comment in
`combat/index.ts` already states was correct and deferred: "A `Combatant`
without a `characterId` is a monster." The stale comments explaining why it
was pinned `true` (`resolve.ts:198-204`, `combat/index.ts:56-64`) are deleted
— they document a gap this change closes, and a comment describing a
workaround for a bug that no longer exists is worse than none.

## Decision 4 — `conclusionOf` treats a pending death save as still ongoing

The current rule (`conclusion.ts`) filters combatants to `status === "alive"`
and asks how many factions remain. The moment Decision 3 lets a PC reach
`"unconscious"` instead of `"dead"`, that filter breaks: an unconscious hero
is immediately excluded from "living," so `conclusionOf` would report
`"defeat"` the instant the hero drops — before a single death save is ever
rolled. Death saves would be implemented and driven and still never fire.

```ts
export function conclusionOf(snapshot: EncounterState): Conclusion {
  const combatants = snapshot.combatants;
  if (combatants.length === 0) return "ongoing";

  // A death save still pending is not a settled fact about who won — the
  // hero could yet stabilize, wake on a natural 20, or die. Keep the fight
  // open until it resolves one way or the other.
  const pending = combatants.some(
    (c) => c.status === "unconscious" && (c.deathSaves?.successes ?? 0) < 3,
  );
  if (pending) return "ongoing";

  // "Standing" is alive, or unconscious-but-stable (down, not dead, no
  // longer rolling) — a stabilized hero did not lose just by falling.
  const standing = combatants.filter((c) => c.status === "alive" || c.status === "unconscious");
  const factions = new Set(standing.map((c) => c.faction));
  if (factions.size > 1) return "ongoing";
  if (standing.length === 0) return "defeat";
  return factions.has("party") ? "victory" : "defeat";
}
```

Walked through the cases that matter:

- Hero drops to 0 HP mid-fight, goblins still up: `pending` is true
  immediately → `"ongoing"`, regardless of enemy count. The turn driver
  (Decision 6) gets to run.
- Hero fails three saves: the driver has already flipped `status` to
  `"dead"` by the time this runs (Decision 6), so `pending` is false and
  `standing` excludes them → `"defeat"`, same outcome §8 already documented
  for "every combatant dies at 0 HP," reached the honest way now.
- Hero rolls a natural 20: `status` flips back to `"alive"` before this
  runs → ordinary victory/ongoing logic, unaffected.
- Hero stabilizes (3 successes) while a goblin is still alive: `pending` is
  now false, but `standing` still has two factions → `"ongoing"`. The
  goblin's own turn keeps running (existing `enemyTurn` path); the hero's own
  turn is silently skipped from here on (Decision 6) — RAW: a stable
  creature makes no more death saves.
- Hero stabilizes and no hostile is left alive: `standing = [hero]`,
  one faction, party → `"victory"`. A won fight can now leave the hero
  Unconscious-but-Stable, which Decision 7 accounts for.
- Everyone dead: `standing = []` → `"defeat"`, same as today.

No monster ever reaches `"unconscious"` — Decision 3 keeps `diesAtZeroHp`
true for every `Combatant` without a `characterId`, and ADR-0002 caps a
campaign at one PC — so `pending`/`standing`'s unconscious branch has exactly
one combatant that can ever hit it in practice, but the check is written
generally rather than hardcoded to `"hero"`, matching how nothing else in
`conclusion.ts` special-cases a combatant id.

## Decision 5 — the encounter pipeline drives death saves on the hero's own turn

`runEnemyTurns` (`pipeline.ts:1115`) currently returns control to the player
the instant the turn order reaches ANY party-faction combatant, regardless of
status — the exact strand §8 names: an Unconscious PC never submits a
`structured_action`, so nothing downstream of that return ever runs again for
that bracket.

The loop gains one branch, checked before the existing unconditional
party-return:

```ts
if (combatant.faction === "party") {
  if (combatant.status === "alive") return; // control returns to the player, as today
  if (combatant.status === "unconscious" && (combatant.deathSaves?.successes ?? 0) < 3) {
    yield* rollDeathSaveTurn(actorId);
    continue;
  }
  // Dead, fled, or stabilized-and-unconscious: nothing to do this turn —
  // the same silent skip a downed monster already gets below.
  yield* emit("scene_changed", { kind: "turn_advanced" });
  continue;
}
```

`rollDeathSaveTurn` mirrors `enemyTurn`'s own shape at the point it commits a
roll — one seed off the campaign sequence, one `state_delta_applied`, one
`turn_advanced` — with no tactical call and no narration, because there is no
proposal to make and (per the brief) no new narration to write:

```ts
async function* rollDeathSaveTurn(actorId: string): AsyncIterable<ServerFrame> {
  const encounter = encounterOf(campaign);
  const combatant = encounter.combatants.find((each) => each.combatantId === actorId);
  if (combatant === undefined) throw new Error(`No combatant ${actorId} in this encounter`);

  const seed = ports.seedFor(campaign.state.world.rootSeed, campaign.nextSequence);
  const result = rollDeathSave(combatant.deathSaves ?? { successes: 0, failures: 0 }, seeded(seed));

  const status: EntityStatus =
    result.outcome === "dead" ? "dead" : result.outcome === "revived" ? "alive" : "unconscious";
  const currentHp = result.outcome === "revived" ? Math.max(1, combatant.currentHp) : combatant.currentHp;

  const combatants = encounter.combatants.map((each) =>
    each.combatantId === actorId ? { ...each, status, currentHp, deathSaves: result.state } : each,
  );
  yield* emit("state_delta_applied", { combatants });
  yield* emit("scene_changed", { kind: "turn_advanced" });
}
```

No new `GameEvent` type. `state_delta_applied` already carries the whole
combatant array (`StateDeltaAppliedPayload`, `reduce.ts:53`) and is exactly
what replay needs to reproduce this roll's result — the natural-roll trace
itself (worth a `dice_rolled`-shaped audit event the way attacks and checks
get one) is real but has no consumer today: no test and no combat-log UI
asks for it. Skipped rather than spec'd in; add a `death_save_rolled` trace
event the day something reads one, the same way `check_rolled` earned its
place when the intent router needed it.

**Why this needs no new narration, matching the brief.** The moment of
falling unconscious is an attack outcome — `applyTurn`'s existing
`targetStatusAfter` (`resolve.ts`) already flows into `AttackTrace` and from
there into both narrators' existing `unconscious` beat
(`narrative/brief.ts:37-39`, `narrative/deterministic.ts:55`). Decision 3
alone makes that beat reachable. The roll itself — succeed, fail, stabilize,
wake — has no attack, no target, nothing for a narrator's existing brief
shape to hang a beat on, and inventing one is out of scope by the brief's own
words ("do not write new narration for it").

**Bounded the same way `runEnemyTurns` already is.** The function's existing
guard (`guard <= turnOrder.length`) already bounds one call to at most
`turnOrder.length + 1` iterations; a death-save turn is one more `continue`
inside that same loop, not a new unbounded path. `resolveIfConcluded`'s
`maxRounds` terminator (existing, `combat-bridge` Decision 4) remains the
backstop for the case Decision 4 leaves open on purpose — a hero Stable while
a hostile survives can never act again to end the fight themselves, and the
existing round cap forces a `"stalemate"` rather than a true hang. That
combination (stable hero + surviving hostile, both unable to end the fight)
is the one case this design does not fully resolve, and it is bounded, not
silent — recorded as an explicit known ceiling below, not hidden.

## Decision 6 — HP leaves the fight through `encounter_resolved`, on victory only

```ts
export const EncounterResolvedPayload = z.object({
  encounterId: z.string(),
  outcome: z.string(),
  survivorIds: z.array(z.string()),
  summaryEnglish: z.string().min(1).optional(),
  /** The hero's ending current HP, when this encounter had one and it was
   *  won. Absent for a combat-only campaign, an encounter with no
   *  characterId combatant, or any non-victory outcome — those leave
   *  `scene.heroHp` exactly where it already was. */
  heroHp: z.number().int().min(0).optional(),
});
```

`resolveIfConcluded` (`pipeline.ts:1212`) computes it directly from the
resolved `EncounterState`'s own hero combatant — no scene-engine
involvement, because this is combat state leaving a bracket, not a quest
effect:

```ts
const hero = encounter.combatants.find((each) => each.characterId !== undefined);
...
payload: {
  encounterId: encounter.encounterId,
  outcome,
  survivorIds,
  summaryEnglish,
  ...(outcome === "victory" && hero !== undefined ? { heroHp: hero.currentHp } : {}),
},
```

`reduce`'s `encounter_resolved` case applies it after closing the bracket,
guarded the same way `sceneOrThrow`'s siblings already are — a payload
carrying `heroHp` with no scene open is a corrupt log, the same class of
error `state_delta_applied` outside a bracket already throws for:

```ts
if (heroHp !== undefined) {
  if (state.world.scene === null) {
    throw new Error(`encounter_resolved at sequence ${event.sequence} carries heroHp with no scene open`);
  }
  return { ...state, encounter: null, world: { ...state.world, scene: { ...state.world.scene, heroHp } } };
}
return { ...state, encounter: null };
```

**Why victory only.** Defeat and stalemate already "change nothing else" —
no `quest_node_completed`, no `world_delta_applied`, the player lands back at
the same node and can re-enter, which rebuilds a fresh board from the
catalogue (combat-bridge spec, Decision 5). Persisting HP on a loss would
mean persisting whatever the hero's HP was at the moment they died or the
clock ran out — 0, for a death, immediately corrupting the very next spawn
(Decision 8's floor notwithstanding, this is data nothing should record).
Leaving `heroHp` untouched on a loss means a retry uses the HP the hero had
walking IN, exactly matching how retrying already works today for every
other piece of state a lost fight does not move.

**The stable-but-won edge case.** Decision 4 lets `"victory"` land with the
hero Unconscious-and-Stable (0 HP). This payload persists that `heroHp: 0`
faithfully — the hero genuinely is at 0 HP, won or not — and Decision 8's
floor is what keeps the NEXT spawn from starting already-down. Modeling the
hero actually waking up (1d4-hour natural recovery) stays out of scope, per
the brief; the floor is the seam that keeps that gap from cascading into an
unplayable next encounter, not a fix for the gap itself.

## Decision 7 — the next encounter spawns at the persisted HP, floored at 1

`buildEncounterById` (`apps/server/src/encounters/index.ts`) gains an
optional override:

```ts
export function buildEncounterById(encounterId: string, heroCurrentHp?: number): BuiltEncounter {
  const definition = encounterById(encounterId);
  ...
  for (const spawn of definition.spawns) {
    if ("characterId" in spawn) {
      if (!characters.has(spawn.characterId)) {
        const derived = loadCharacter(spawn.characterId);
        characters.set(
          spawn.characterId,
          heroCurrentHp === undefined ? derived : { ...derived, currentHp: heroCurrentHp },
        );
      }
      continue;
    }
    ...
  }
  return buildEncounter({ definition, statBlocks, characters });
}
```

No change to `buildEncounter`/`resolveSpawn` (`rules-engine/encounter/build.ts`)
at all — `resolveSpawn`'s own comment already anticipates exactly this: "A
character can join below full health; a monster never does," reading
`derived.currentHp` off whatever `DerivedCharacter` it is handed. The seam
already existed; nothing used it yet.

`campaign.ts`'s `startEncounter` supplies the override:

```ts
const heroCurrentHp =
  campaign.state.world.scene === null ? undefined : Math.max(1, campaign.state.world.scene.heroHp);
const built = buildEncounterById(input.encounterId, heroCurrentHp);
```

The `Math.max(1, ...)` floor is the one place this design deliberately papers
over a gap it does not close: natural recovery from Stable-at-0 is out of
scope, so a hero who won their last fight only by stabilizing starts the next
one at 1 HP rather than 0 — conscious and able to act, not spawned already
face-down. Recorded here rather than left to be discovered as a surprising
`Combatant.currentHp: 1` in a test.

A combat-only `{encounterId}` campaign passes `undefined` — `scene` is
always null for one, so `buildEncounterById` behaves byte-for-byte as it does
today, matching the same compatibility promise the combat-bridge spec made
for the same class of campaign.

## Decision 8 — a long rest is a fifth `WorldEffect`, engine-applied

```ts
export const WorldEffect = z.discriminatedUnion("kind", [
  ...,
  z.object({ kind: z.literal("long_rest") }),
]);
```

No fields — it always means "restore to max," the one absolute value that
needs no delta math and cannot disagree with any starting HP. Calendar
advancement, when a long rest should also cost narrative time, is a SEPARATE
`advance_calendar` effect on the same node — the two are orthogonal facts
(SRD: a long rest is time-boxed, "advancing the day" is this campaign's own
coarse clock) and `advance_calendar` already exists; composing two effects on
one node is zero new mechanism, matching how `saboteurs` already composes
`advance_calendar` with `shift_npc_affinity`.

**Why the scene engine, not the pipeline, computes the restored value —**
per the brief's own framing: "never model-proposed." A long rest is declared
content (`QuestNode.effects`), applied by the same pure `applyEffect` switch
every other effect goes through, so invariant 1 holds one level above combat
exactly the way it already does for faction shifts. The alternative — the
pipeline reading `long_rest` off a completing node's own declared effects
and computing `maxHp` itself — is the exact anti-pattern the combat-bridge
spec's Decision 5 already forbade for a harder case ("the pipeline never
re-reads the node's declared effects and never computes a band"); nothing
about this effect is a special case that earns an exception.

**Threading max HP into a `SceneState` that has never known it.**
`SceneState` (`scene/index.ts`) gains `heroHp: number`, mirroring `day`
structurally. `applyEffect`'s new case needs the character's max HP to
restore TO — the one fact nowhere in `SceneState` or `AuthoredWorld`, both of
which are pure and know nothing about a specific character. It arrives as an
injected, optional last argument, the same way `buildEncounter` takes
`statBlocks`/`characters` injected rather than loaded:

```ts
export function applyEffect(
  world: AuthoredWorld,
  effect: WorldEffect,
  state: SceneState,
  heroMaxHp?: number,
): SceneState {
  switch (effect.kind) {
    ...
    case "long_rest":
      return heroMaxHp === undefined ? state : { ...state, heroHp: heroMaxHp };
  }
}
```

Threaded through `completed`, `traverseEdge` and `completeCurrentNode` as the
same optional trailing parameter — every existing call site in tests and
`tools/sim` keeps compiling unchanged, since a long rest is authored content
no existing fixture declares. `pipeline.ts`'s two live call sites
(`resolveIfConcluded`'s combat-victory completion, and the exploration
branch's `traverseEdge`/`completeCurrentNode` pair) both pass
`sceneStaticsOf(campaign).character.maxHp` — cheap, already loaded, already
on hand at both sites today for other reasons.

`startScene` (`scene/index.ts`, `loadWorld`'s enterability self-check only —
never the live genesis path, which is `sceneFromGenesis`+`initialWorldState`)
sets `heroHp: 0` unconditionally. That check never applies an effect, so the
value is inert; inventing a `heroMaxHp` parameter for a function real play
never calls would be exactly the "override mechanism with no second caller"
the combat-bridge spec already declined once for a similar case.

**Converters.** `sceneStateFrom`/`snapshotOf` (`scene/snapshot.ts`) copy
`heroHp` across verbatim, the same one-line treatment `day` already gets.
`diffScene` adds one more absolute-value field:

```ts
if (after.heroHp !== before.heroHp) delta.heroHp = after.heroHp;
```

**The wire payload.** `WorldDeltaAppliedPayload` (`events.ts`) gains
`heroHp: z.number().int().min(0).optional()`, following its own established
contract exactly — "absolute resulting value, post-clamp; the fold merges,
never computes," the same words already governing `day`. `reduce`'s
`world_delta_applied` case sets `scene.heroHp = heroHp ?? scene.heroHp`,
mirroring the existing `day: day ?? scene.day` line beside it.

**What this does not touch.** Exhaustion. SRD 2024's Long Rest also removes
one exhaustion level (RULES_REFERENCE.md §6), but `exhaustionLevel` lives
only on `Combatant` and has no cross-encounter persistence at all today — a
strictly bigger gap than this task's brief, and out of scope by the same
"unless unavoidable" test the brief applies to stabilising and short rests.
Recorded as a new, explicit §8 gap rather than silently half-implementing the
SRD rule under one effect name.

## What this closes in `RULES_REFERENCE.md` §8

- "Every combatant dies at 0 HP, PCs included" — closed by Decisions 3–5.
- Nothing else in §8 changes. "Damage taken at 0 HP → death-save failures"
  and "Stabilising, and the 1d4-hour natural recovery" stay open — neither
  is what the brief asks this change to close, and Decision 5's known
  ceiling (a stable hero next to a surviving hostile) is exactly the shape
  those two gaps would need to close to resolve. One new row is added for
  Long Rest (§4), and one new gap line for exhaustion-on-long-rest
  (Decision 8's closing paragraph).

## What this must not make worse

**Combat-only campaigns are byte-for-byte unchanged.** `scene` stays null,
`buildEncounterById` receives `undefined`, `conclusionOf`'s new branches are
unreachable without a `characterId` combatant (a combat-only encounter can
still spawn one in principle, but the shipped catalogue's `{encounterId}`
route builds from data with no scene behind it either way, matching today).

**Append-only compatibility holds.** `EncounterResolvedPayload.heroHp` and
`WorldDeltaAppliedPayload.heroHp` are both `.optional()`, following the
established precedent (`protocol.ts:71`'s `.default(null)`, cited by the
brief) — an event persisted before this change parses and folds exactly as
it does today, leaving `scene.heroHp` at whatever genesis or an earlier
delta already set.

**Invariant 1 holds.** No model proposes a death save, an HP carry-forward,
or a long rest. `rollDeathSave` is deterministic-RNG rules-engine math;
`long_rest` is declared content applied by the same pure switch every other
`WorldEffect` already goes through; HP carry-forward is the pipeline reading
a combatant's already-engine-computed `currentHp`, never inventing one.

**Invariant 5 holds.** `@ai-dm/schemas` gains a number field and a
zero-field discriminated-union member, not a dependency. `apps/web` still
imports only `@ai-dm/schemas`.

**Coverage does not drop.** `packages/rules-engine` stays ≥90% lines; the new
`applyEffect` branch, `diesAtZeroHp` read, and `conclusionOf` branches each
need a golden test per `packages/rules-engine/CLAUDE.md`'s bar.

## Non-goals

- Stabilising (the DC 10 Wisdom (Medicine) check) — ADR-0002 is solo play;
  there is no ally to make it.
- The 1d4-hour natural recovery from Stable. Decision 7's floor is the seam
  that keeps its absence from cascading, not an implementation of it.
- Short rests, healing items.
- Exhaustion reduction on a long rest (Decision 8's closing paragraph) —
  exhaustion has no persistence mechanism to reduce.
- A second encounter, or any change to `data/world/arc.json` — no quest node
  in the shipped Emberfall arc declares a `long_rest` effect; this ships the
  mechanism, exercised by rules-engine/schemas tests and a hand-built world
  fixture, not by new authored content.
- Permadeath and campaign-end semantics beyond what the combat-bridge spec
  already accepted as a known ceiling for defeat.

## Addendum (2026-08-31) — the Decision 5 known ceiling is closed

Decision 5's "known ceiling" — a Stable hero next to a surviving hostile,
which neither side could ever end without `runEnemyTurns` grinding a real
tactical call for every remaining hostile turn up to its own bound
(`turnOrder.length * (maxRounds + 1)`, up to ~20 rounds of live LLM calls for
one player action) — is now closed at the source: `conclusionOf`
(`packages/schemas/src/conclusion.ts`) gained a fourth `Conclusion` value,
`"stalemate"`, returned the instant no party combatant left standing can
still act (alive) while an opposing faction remains. `runEnemyTurns`'s
existing `conclusionOf(...) !== "ongoing"` check and `resolveIfConcluded`'s
existing `conclusion !== "ongoing" ? conclusion : ...` fallback both already
treated any non-"ongoing" result as terminal, so neither needed to change —
the fight now ends the round the hero stabilizes rather than up to 19 rounds
later. `apps/web/src/App.tsx` gained a dedicated `he.app.stalemate` status
branch, since a combat-only campaign never gets an `encounter_resolved`
event (`resolveIfConcluded` is silent when there's no scene) and reads
`conclusionOf` directly. `resolveIfConcluded`'s `round > maxRounds` fallback
is left in place as a harmless backstop, though this closes what was
practically its only reachable trigger.
