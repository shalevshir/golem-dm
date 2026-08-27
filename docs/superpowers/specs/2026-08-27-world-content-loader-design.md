# Static content loaders and a tiny authored world — design

Step 2 of `PROJECT_PLAN.md` §4.7, following step 1's campaign/encounter split
([`2026-08-23-campaign-state-split-design.md`](2026-08-23-campaign-state-split-design.md),
merged as `e6577d1`). Step 1 made the projection a campaign with a bracketed
encounter inside it and left the campaign holding almost nothing. This step
authors the world that campaign is set in, and the loader that refuses to
serve a broken one.

It builds no behaviour. There is no scene engine, no predicate evaluator, no
event, no wiring into `POST /campaigns`. What ships is three things: zod
shapes for authored content, a `data/world/` tree containing one town, two
factions, three NPCs and a five-node arc, and a loader that either returns a
fully cross-referenced world or throws naming every defect it found.

The scope is deliberately too small to be good. Its job is to prove the
pipeline — author, validate, refuse — not to be a setting anyone would want to
play. §4.7 says "enough to prove the pipeline, not to be good", and that is a
constraint on the content, not an apology for it.

Exit criterion: the authored world loads and cross-references cleanly, a
deliberately broken fixture world is refused with every one of its defects
named in one error, and nothing in the running pipeline changed — a fight
plays identically, because no code path outside this step's own tests can
reach any of it.

## Context

Facts checked against the repo rather than recalled, at
`69f0bef`.

**`FactionRelation` is dead code** (`packages/schemas/src/world.ts:17`).
Declared and type-exported, referenced nowhere in `packages`, `apps`, `tools`
or `docs`. Its `score` is `z.number().int().min(-100).max(100)`, which
contradicts §4.7's prescribed coarse −3..+3 band directly. It is not a
foundation to build on; it is a thing to remove.

**`Faction` two lines below it is a combat concept**
(`world.ts:22`): `z.enum(["party", "hostile", "neutral"])`, read by
`Combatant.faction` and by the rules engine's targeting. It shares a word with
§4.7's campaign factions and nothing else. Any campaign-faction shape placed
in `world.ts` sits directly beside it.

**`world.ts` is the combat grid module.** `GridMap`, `TerrainType`,
`Combatant`, `ActionEconomy`, `EntityStatus`. Every consumer is tactical.

**The loader precedent is three files in `apps/server/src/encounters/`.**
`srd.ts` exports `dataDir(relativePath)`, which walks up from
`import.meta.url` until the path exists — written once precisely so `gear.ts`
and `characters.ts` need not repeat it, and correct after `pnpm build` puts
code under `dist/`. `loadMonster` caches per id and lets `ENOENT` and
`ZodError` propagate. `loadGear` parses four files once into a module-level
`let` and returns `Map`s. `loadCharacter` parses, then throws when the file's
own `characterId` disagrees with the id it was requested under — a check zod
cannot express because it compares the file against its filename.

**I/O cannot live in `@ai-dm/schemas`.** `srd.ts:4-6` records why: the rules
engine forbids I/O and `apps/web` bundles `@ai-dm/schemas` for the browser, so
`node:fs` fits in neither. `protocol.ts:5-6` repeats the browser half. This is
what puts the loader in `apps/server` and keeps the shapes in `@ai-dm/schemas`
— the same split `EncounterDefinition` (schema) and `buildEncounterById`
(loader) already have.

**Deliberately broken fixtures are an established habit.**
`data/characters/` ships `inconsistent-fixture.json` and
`mislabeled-fixture.json` next to `hero.json`, each documented in
`data/characters/README.md` as broken on purpose with an instruction not to
"fix" it, and each pinned by a test in
`apps/server/src/encounters/index.test.ts`. The refusal path is treated as a
feature with tests, not as an error branch.

**Reading the filesystem inside a test is already normal.**
`packages/schemas/src/srd.test.ts:1-2` says so in its own header and walks
`data/srd/` to prove every shipped file parses, even though the package itself
does no I/O.

**Ids in this repo are slugs, inconsistently punctuated.**
`CreatureAttack.actionId` constrains itself to `/^[a-z0-9_]+$/`
(`srd.ts:31`); monster files are `goblin_warrior`, encounters are
`goblin-ambush`, characters are `hero` and `second-fixture`. Both separators
are in use and neither is going away.

**Hebrew fields follow one convention.** `nameEnglish` plus
`nameHebrew: z.string().min(1)`, and `grammaticalGender`
(`z.enum(["masculine", "feminine"])`, `character.ts:51`) on anything a
narrator conjugates a verb around — `MonsterStatBlock` carries it,
`srd.ts:64` explaining that without it the narrator "narrates wrong". Scene
prose is English only: `EncounterDefinition.sceneEnglish` has no Hebrew twin,
because the narrative agent translates.

**Baseline, measured on this branch's parent:** 1274 passed, 30 skipped, 90
test files without `DATABASE_URL`; `pnpm typecheck` and
`npx eslint packages apps tools` both exit 0.

## Decisions

**1. The shapes live in a new `packages/schemas/src/content.ts`.**

Not `world.ts`. That file is the combat grid, and its `Faction` enum makes it
the one place in the repo where a campaign-faction shape would be actively
misread. A new module also gives the header somewhere to name all three
neighbours a reader could confuse — `world.ts` (combat grid),
`content.ts` (authored, static, this file) and
`packages/memory/src/world-state.ts` (earned, mutable, a projection of the
log, still `export {}`). §4.7 is explicit that static lore is a loader and
mutable world state is a projection; the filenames should not blur that.

Exported from `src/index.ts` alongside the rest.

**2. `FactionRelation` is deleted, not redefined.**

It is unreferenced, so deleting it is a no-op at every call site, and its
−100..100 range is the shape §4.7 argues against. Redefining it in place would
keep a campaign concept in the combat module and cement the collision with
`Faction`. The replacement is `FactionRelationEntry` in `content.ts`, carrying
a band rather than a score.

**3. Ids are slugs, enforced by the schema.**

```ts
export const ContentId = z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);
```

Every `locationId`, `factionId`, `npcId`, `nodeId` and `worldId` is a
`ContentId`. Both separators are permitted because both are already in use
(`goblin_warrior`, `goblin-ambush`) and a rule this step cannot retrofit onto
`data/srd/` should not pretend to.

This matters more than it looks. §4.7's single load-bearing rule for this step
is that events reference lore **by stable id, never embedded text**, so that
editing a lore file cannot retroactively invalidate a replay. No event exists
yet, so nothing here can enforce that rule at the event boundary. What the
regex does enforce is the half that is available now: an id cannot *be* prose.
A field that will not accept `"The Ashfall Compact"` cannot quietly become the
thing a narrator wrote, and the id is then safe to persist in a payload
forever.

**4. Five shapes, and every one of them is a name plus ids.**

```
LocationDefinition  locationId, nameEnglish, nameHebrew, descriptionEnglish
FactionDefinition   factionId,  nameEnglish, nameHebrew, descriptionEnglish
NpcDefinition       npcId, nameEnglish, nameHebrew, grammaticalGender,
                    locationId, factionId (optional), descriptionEnglish
QuestNode           nodeId, titleEnglish, sceneEnglish, locationId,
                    preconditions[] = [], effects[] = [], edges[]
WorldManifest       worldId, startingDay, startingNodeId, factionRelations[]
```

`grammaticalGender` is on `NpcDefinition` and nowhere else: an NPC is what a
narrator conjugates a verb around, which is the reason `MonsterStatBlock`
carries it. A town is narrated *about*, and adding the field to locations and
factions would be three more authored values with no consumer.

`factionId` is optional on an NPC — an unaligned innkeeper is the normal case,
and a required field would force every NPC into one of two factions in a world
that has exactly two.

`sceneEnglish` has no Hebrew twin, matching `EncounterDefinition`. Invariant 2
puts Hebrew in narrative output, not in state.

`QuestEdge` is `{ to: ContentId, labelEnglish }` and nothing else — see
decision 6.

**4a. A terminal node has no edges.** `edges` carries no `.min(1)`: node five
of a five-node arc ends it. `preconditions` and `effects` both
`.default([])`, matching `CreatureAttack.extraDamage`.

**5. Faction relations are authored as band names over one ordered tuple.**

```ts
export const FACTION_BANDS = [
  "war", "hostile", "cold", "neutral", "cordial", "friendly", "allied",
] as const;
export const FactionBand = z.enum(FACTION_BANDS);
```

Seven bands, so `FACTION_BANDS.indexOf(band) - 3` is §4.7's −3..+3 scalar with
no second table to disagree with the first. §4.7 wants a name because "a model
reads a band name far more reliably than a number"; the arithmetic still needs
an ordering; one ordered tuple is both, and `packages/schemas/CLAUDE.md`'s
"closed enums over free strings" is satisfied rather than worked around.

This step exports the tuple and the enum and **no arithmetic**. Band shifting
is clamped evaluation, which is step 3's engine, and a helper written here
would ship with no caller.

**5a. A relation is an unordered pair, and every pair must be declared.**

`FactionRelationEntry` is `{ factionA, factionB, band }`, indexed by the
loader under a canonical key (the two ids sorted), so declaring `A,B` and
`B,A` is one relation and declaring both is a duplicate — a collected error,
not a silent last-wins.

The manifest must declare **every** unordered pair of distinct factions. With
two factions that is one line, and it buys a real property: "what is the
standing between X and Y" is always answerable from the file, with no default
rule for step 3 to invent and no undeclared pair to discover at runtime. The
ceiling is honest and belongs in a comment — exhaustive declaration is trivial
at two factions and untenable somewhere around eight, at which point an
undeclared pair should default to `neutral` and this check becomes a warning.

**6. Predicates and effects: two kinds each, and predicates sit on the node.**

```
predicate  { kind: "node_completed",        nodeId }
           { kind: "faction_band_at_least", factionA, factionB, band }
effect     { kind: "shift_faction_relation", factionA, factionB, delta }
           { kind: "advance_calendar",       days }
```

Both are `z.discriminatedUnion("kind", …)`. The set is small on purpose: these
four are what a five-node arc actually needs, and a fifth kind is a one-line
addition step 3 can make when a node needs a gate the arc's own history cannot
express.

§4.7 lists predicates and declared effects under step 3, but that is the
*evaluator*. The shapes belong here, with the content that uses them:
invariant 4 puts a shape in `@ai-dm/schemas` once, and if the arc were
authored without gating data, step 3 would have to rewrite every file it
ships.

**Predicates gate the node, not the edge.** §4.7's "the intent router picks an
edge, the engine checks its predicate" reads either way. Putting them on nodes
means traversing an edge is entering its target and checking that target's
preconditions — one place to look, one set of bookkeeping, and the same
sentence is still true. An edge is therefore a destination and a label.

There is no `set_regional_danger` effect and no `regionalDanger` field. §4.7:
regional danger is derived from faction relations and quest progress, never
stored, because derived state cannot drift.

**7. The calendar is a day counter.**

`startingDay: z.number().int().min(1)`, advanced only by `advance_calendar`.
No months, no seasons, no named festivals — those are authoring surface with
no consumer. What the counter buys is the property §4.7 actually asks for:
time moves by declared effect and never by a wall-clock read, which is the
replay-divergence failure the `timestamp`-as-`text` decision already guards
against (§4.6).

**8. `data/world/` splits by collection.**

```
data/world/
  README.md         what is here, and which files are broken on purpose
  world.json        the manifest
  factions.json     2
  locations.json    1
  npcs.json         3
  arc.json          5
  fixtures/
    broken-references/   a minimal world carrying every defect at once
```

Collection files, not one file per entity: this world is loaded whole rather
than looked up by id, which is what separates it from `data/srd/monsters/`,
and it matches the `weapons.json` / `armor.json` / `classes.json` habit a
reader of `data/srd/` already knows. A diff to the arc then does not touch the
NPCs.

The fixture world nests under `data/world/` rather than sitting beside it
because the loader reads six named paths and never scans a directory, so
nested fixtures are inert. `README.md` carries the
`data/characters/README.md` instruction verbatim in spirit: broken on purpose,
do not fix it.

**This is `data/world/`, never `data/srd/`.** Invariant 6 restricts
`data/srd/` to SRD 5.2.1 CC-BY material and `NOTICE.md` fixes the attribution
wording. Every file this step adds is original, so none of it goes there and
none of it touches `NOTICE.md`.

**9. The loader is `apps/server/src/world/index.ts`.**

```ts
export function loadWorld(dir?: string): AuthoredWorld;
```

Mirrors `apps/server/src/encounters/`, and reuses `dataDir()` from
`encounters/srd.ts` rather than writing a second walk-up — that function
exists to be shared and already says so.

`dir` defaults to `dataDir(join("data", "world"))`. The parameter is not
generality for its own sake: the fixture world is a *different directory*, and
without the parameter the refusal path has nothing to point at. That is the
one structural difference from `loadCharacter`, whose broken fixtures can sit
beside the real file because it loads by id.

`AuthoredWorld` is an index of `Map`s, mirroring `loadGear`'s return:

```ts
interface AuthoredWorld {
  worldId: string; startingDay: number; startingNodeId: string;
  factions:  ReadonlyMap<string, FactionDefinition>;
  locations: ReadonlyMap<string, LocationDefinition>;
  npcs:      ReadonlyMap<string, NpcDefinition>;
  questNodes:ReadonlyMap<string, QuestNode>;
  relations: ReadonlyMap<string, FactionBand>;   // canonical pair key
}
```

It is declared in the loader, not in `@ai-dm/schemas`. It holds `Map`s, so it
is neither a wire shape nor a zod schema, and `SrdGear` — the identical case —
lives in `@ai-dm/rules-engine` next to its consumer rather than in the schema
package. Step 3's scene engine takes it injected, exactly as `buildEncounter`
takes `statBlocks` and `characters` today, and can rehome the type then.

Cached per directory in a `Map`. Two lines, and the reason is concrete rather
than habitual: the moment step 3 wires this in, an uncached whole-world reread
per deliberation is precisely the `loadCampaign` O(encounters) blocking I/O
that step 1's review flagged as a thing not to repeat.

**10. One throw, carrying every defect.**

Order of operations, and the failure class at each stage:

1. **Read and parse.** A missing file raises `ENOENT`, a malformed one a
   `ZodError`. Both propagate untouched, as `loadMonster` lets them.
2. **Index.** Building each `Map` collects a problem for every duplicate id
   within a collection, and for every faction pair declared twice under the
   same canonical key.
3. **Cross-reference.** Collects a problem for every id that does not resolve:
   an NPC's `locationId` or `factionId`, a quest node's `locationId`, an
   edge's `to`, a predicate's or effect's `nodeId` / `factionId`, the
   manifest's `startingNodeId`, and any unordered faction pair left
   undeclared.
4. **Throw once** if anything accumulated:
   `class WorldContentError extends Error { readonly problems: readonly string[] }`,
   message listing all of them. Named and `instanceof`-able for the same
   reason `UnknownEncounterError` is — a caller distinguishing this from a
   `ZodError` should not be matching on message text.

Collecting rather than failing fast is the decision worth stating. Throwing at
the first dangling id makes an author fix five ids in five reload cycles. It
also collapses the fixture cost: **one** broken world carrying every defect at
once replaces five near-identical broken worlds, and the test asserting each
defect is named is stronger than five tests each asserting one throw.

`buildEncounter`'s rule is unchanged and is the one being followed — throw
rather than return something half-valid. This only widens what a single throw
reports.

## What this must not make worse

Step 1's review left four edges (§4.7, "What step 1 already leaves for steps
2–4"). This step is additive: no event type, no payload, no `reduce` case, no
`fold`, no `loadCampaign`, no `pipeline.ts`. The loader is unreachable from
the running pipeline until step 3 wires it. Explicitly, against each edge:

- **`fold` cannot project a bracket alone.** Untouched. No event is added, so
  `apps/web`'s fold gap neither widens nor narrows.
- **`loadCampaign`'s O(encounters) cold-load I/O.** Untouched, and decision 9
  keeps this step from adding a second instance of the same pattern.
- **`pipeline.ts`'s `emit` as an unaware fourth bracket writer.** Untouched.
- **`campaign_started` has no corrupt-log guard.** This is the one an eager
  version of this step would have broken. That guard's absence is harmless
  only while nothing in the fold reads the payload; giving `campaign_started`
  an `openingQuestNode` would end that, and the guard would have to be built
  in the same change. So this step does not touch the payload. Step 3 or 4
  takes both together.

Also unchanged: `packages/memory` has no new table and no migration. An
uncommitted note on `packages/memory/CLAUDE.md` records that from §4.7 step 2
onward every schema change must be additive rather than a regenerated
baseline; this step is compatible with that by having no schema change at all.

## Non-goals

- **No scene engine.** No predicate evaluation, no edge legality, no effect
  application, no band arithmetic. Step 3.
- **No events.** No `quest_node_entered`, `quest_node_completed` or
  `world_delta_applied`; no change to the `GameEvent` enum, so `reduce`'s
  exhaustiveness check is not tripped.
- **No wiring.** `POST /campaigns`, `campaign_started`, `pipeline.ts` and
  `apps/web` are not touched.
- **No mutable world state.** `packages/memory/src/world-state.ts` stays
  `export {}`. §4.7 is explicit that static lore is a loader and the mutable
  world is a projection; this step is only the first.
- **No character profiles.** `CharacterProfile`, bonds, ideals, flaws and NPC
  affinity are step 6, and `CharacterSheet` gains no narrative field here.
- **No combat bridge.** A quest node declares no encounter. Step 5.
- **No location graph.** `LocationDefinition` has no `connections`: the
  five-node arc *is* the graph, and one town has nowhere to connect to.
- **No `flag_set` predicate**, no `set_regional_danger` effect, no orphan-node
  detection — an unreferenced node is work in progress, not a corrupt file.
- **No SDD-citation cleanup.** Landed separately on `main` as `69f0bef`.
