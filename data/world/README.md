# Authored world content

**Not SRD content.** This is our own material — original locations, factions,
NPCs and quest nodes. SRD 5.2.1 material lives in `data/srd/` under the licence
and attribution rules described there and in `NOTICE.md`, and nothing in this
directory belongs there or is covered by that licence.

Files are JSON validated against `@ai-dm/schemas` (`content.ts`) and loaded by
`apps/server/src/world/`. `PROJECT_PLAN.md` §4.7 step 2 is the design.

| File | Shape |
|---|---|
| `world.json` | `WorldManifest` — starting day, starting node, faction relations |
| `factions.json` | `FactionDefinition[]` |
| `locations.json` | `LocationDefinition[]` |
| `npcs.json` | `NpcDefinition[]` |
| `arc.json` | `QuestNode[]` |

## Two rules that are not obvious from the schemas

**Ids are forever; text is not.** Events reference this content by id and never
by embedded text, so that editing a description cannot retroactively invalidate
a replay. Rewrite any `*English` or `*Hebrew` field freely. **Renaming an id is
a breaking change** to every event already logged against it.

**Every unordered pair of factions must have a declared relation.** With two
factions that is one entry in `world.json`. The loader refuses a missing pair
and a duplicated one, so there is no default to remember.

## The world is deliberately too small to be good

One town, two factions, three NPCs, a six-node arc (five until §4.7 step 5 added
`saboteurs`). §4.7: "enough to prove the pipeline, not to be good."
`packages/schemas/src/world-content.test.ts` asserts those counts, so growing
the world is a deliberate act that edits that test.

## `fixtures/` is broken on purpose

`fixtures/broken-references/` is a minimal world carrying several deliberate
defects at once — dangling ids, a duplicated id, a missing faction pair. It
exists so `loadWorld`'s refusal path has something to refuse, and
`apps/server/src/world/index.test.ts` asserts that every one of its defects is
named in a single error. **Do not fix it.** The real loader never reads it: it
reads five named JSON files under `data/world/` and never scans a directory.

`fixtures/unenterable-start/` is a world that cross-references perfectly and
still cannot be played: its `startingNodeId` names a node gated on its own
completion, so nothing can ever enter it. Every id in it resolves — that is
the point. It exists so `loadWorld`'s start-node check has something to
refuse, and `apps/server/src/world/index.test.ts` asserts it produces exactly
one problem. **Do not fix it.**
