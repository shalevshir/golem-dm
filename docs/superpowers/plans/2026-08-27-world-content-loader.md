# World Content Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give §4.7's campaign a world to be set in — zod shapes for authored content, a deliberately tiny `data/world/` tree, and a loader that returns a fully cross-referenced world or throws naming every defect at once.

**Architecture:** [Design spec](../specs/2026-08-27-world-content-loader-design.md). Shapes in a new `packages/schemas/src/content.ts`; content in `data/world/` (never `data/srd/`, invariant 6); loader in `apps/server/src/world/`, mirroring `apps/server/src/encounters/` because `node:fs` fits in neither `@ai-dm/rules-engine` (no I/O) nor `@ai-dm/schemas` (browser-bundled). Additive only — no event type, no `reduce` case, no wiring.

**Spec:** [`docs/superpowers/specs/2026-08-27-world-content-loader-design.md`](../specs/2026-08-27-world-content-loader-design.md)

**Tech Stack:** TypeScript 5.7 strict, ESM, Node 22, zod 3.25.76, Vitest 3.

### The one thing this plan gets right or gets wrong

Step 1 was wide and shallow — 36 files, one rename. This one is the opposite: narrow, and every interesting decision is in what the loader **refuses**. A loader that parses six files and hands back four `Map`s is twenty lines and proves nothing. What earns this step its place is that a dangling `factionId` in a hand-edited JSON file is caught at load with the file, the field and the id named — because §4.7's whole premise is that events point at lore by id, and an id that resolves to nothing is the one way that premise fails silently.

So the plan front-loads the content and the happy path (Tasks 2–4), then spends two full tasks on refusal (Tasks 5–6), each with its own fixture defects and its own assertions. If a task ever tempts you to "add validation later", that is the deliverable being deferred.

## Global Constraints

- **Dependency direction:** `schemas ← rules-engine ← agents ← server`. `web` depends only on `schemas`. Nothing depends on `server`.
- **`@ai-dm/schemas` may not import a Node built-in.** `apps/web` bundles it for the browser (`protocol.ts:5-6`, `encounters/srd.ts:4-6`). All file I/O lives in `apps/server`.
- **Schemas define everything once.** Never hand-write an interface duplicating a schema — infer with `z.infer`.
- **English inside, Hebrew outside.** Comments, identifiers, ids and machine fields are English. Hebrew appears only in `*Hebrew`-suffixed content fields.
- **Only SRD 5.2.1 CC-BY material may go in `data/srd/`** (invariant 6). Everything this plan authors is original and goes in `data/world/`. **Do not touch `NOTICE.md`** — its attribution wording is fixed and must be reproduced verbatim with nothing added.
- **ESM with `.js` extensions in relative imports.**
- **TypeScript strict plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.** An indexed read is `T | undefined` and must be guarded.
- **ESLint `strictTypeChecked`:** no `!`, no unnecessary conditions, `_`-prefixed unused params still error, `[...str]` banned (use `Array.from`), `consistent-type-imports` on.
- **`corepack enable` before any pnpm command.** Never run root `pnpm lint` — it walks sibling worktrees; lint with `npx eslint packages apps tools`. **Never run `pnpm format`** (no `.prettierignore`; it rewrites ~37 files including the lockfile).
- **No rules-engine changes.** `packages/rules-engine` is not touched by this plan. If a task wants to, stop — something is wrong.
- **No behaviour.** No scene engine, no predicate evaluation, no band arithmetic, no event type, no `reduce` case, no `pipeline.ts`, no `POST /campaigns`. See the spec's Non-goals.
- **`packages/memory/CLAUDE.md` has an uncommitted edit that is not this plan's.** Leave it alone. Stage files by name in every commit; never `git add -A` or `git add .`.
- **Baseline:** recorded in Task 1. Every later task compares against it and any drop is a regression.

---

## File Structure

**`@ai-dm/schemas`** — `src/content.ts` (new: every authored shape), `src/content.test.ts` (new), `src/world.ts` (delete the dead `FactionRelation`), `src/index.ts` (one export line), `src/world-content.test.ts` (new: proves every shipped `data/world/` file parses, mirroring `src/srd.test.ts`).

**`data/world/`** — `README.md`, `world.json`, `factions.json`, `locations.json`, `npcs.json`, `arc.json`, and `fixtures/broken-references/` holding the same six filenames with deliberate defects.

**`@ai-dm/server`** — `src/world/index.ts` (new: `loadWorld`, `AuthoredWorld`, `WorldContentError`), `src/world/index.test.ts` (new), `src/encounters/srd.ts` (one comment-accuracy line on `dataDir`).

**Docs** — `PROJECT_PLAN.md` §4.7 sequence entry 2.

---

## Task 1: Record the baseline

No code. The number every later task is measured against. **This task is already done** — recorded below at plan-writing time.

- [x] **Step 1: Cut a branch off current `main`**

```bash
git switch -c narrative-step-2-world-content main
git log --oneline -1
```

`main` moved during this plan's authoring: it is `69f0bef`, two commits past step 1's `e6577d1`, having merged `chore/drop-sdd-citations-step11-head` (33 files, comments and test names only). `e6577d1` is still an ancestor. Branch off `69f0bef` — the cleanup is unrelated to this plan and confirmed not to change any count.

- [x] **Step 2: Measure**

```bash
corepack enable
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

**Recorded 2026-08-27**, on `narrative-step-2-world-content` off `69f0bef`:

| Package | Test files | Tests |
|---|---|---|
| `packages/schemas` | 6 | 159 |
| `packages/rules-engine` | 15 | 402 |
| `packages/memory` | 3 passed, 1 skipped (4) | 33 passed, 29 skipped (62) |
| `apps/web` | 12 | 107 |
| `packages/agents` | 21 | 239 |
| `tools/sim` | 22 | 194 |
| `apps/server` | 10 | 140 passed, 1 skipped (141) |
| **Total** | **90** | **1274 passed, 30 skipped (1304)** |

`pnpm typecheck` and `npx eslint packages apps tools` both exit 0. The 30 skips are `packages/memory`'s 29 Postgres cases (skipped without `DATABASE_URL`) plus `apps/server`'s one Postgres-gated bracket test. The `apps/web` run emits jsdom `HTMLCanvasElement.prototype.getContext` warnings throughout and always has.

Measured twice, before and after `main` moved to `69f0bef`: identical both times.

---

## Task 2: The content schemas

**Files:**
- Create: `packages/schemas/src/content.ts`
- Create: `packages/schemas/src/content.test.ts`
- Modify: `packages/schemas/src/world.ts` (delete lines 17-20 and 78)
- Modify: `packages/schemas/src/index.ts` (one export line)

**Interfaces:**
- Consumes: `GrammaticalGender` from `./character.js`.
- Produces: `ContentId`, `FACTION_BANDS`, `FactionBand`, `LocationDefinition`, `FactionDefinition`, `NpcDefinition`, `WorldPredicate`, `WorldEffect`, `QuestEdge`, `QuestNode`, `FactionRelationEntry`, `WorldManifest` — each as a zod schema plus a `z.infer` type of the same name, exported from `@ai-dm/schemas`.

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/content.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ContentId,
  FACTION_BANDS,
  FactionBand,
  NpcDefinition,
  QuestNode,
  WorldEffect,
  WorldManifest,
  WorldPredicate,
} from "./index.js";

describe("ContentId", () => {
  // Both separators, because both are already in use in this repo:
  // data/srd/monsters files are `goblin_warrior`, encounters are
  // `goblin-ambush`. A rule this module cannot retrofit onto those should
  // not pretend to.
  it.each(["hero", "goblin_warrior", "goblin-ambush", "a1"])("accepts %s", (id) => {
    expect(ContentId.safeParse(id).success).toBe(true);
  });

  // The point of the regex: §4.7 requires events to reference lore by stable
  // id and never by embedded text. No event carries one yet, so this is the
  // only enforcement available — a field that refuses prose cannot quietly
  // become the thing a narrator wrote.
  it.each(["The Ashen Guild", "Hero", "a--b", "-x", "x-", "", "a b"])(
    "refuses %s",
    (id) => {
      expect(ContentId.safeParse(id).success).toBe(false);
    },
  );
});

describe("FactionBand", () => {
  it("has seven bands, so indexOf - 3 is §4.7's -3..+3 scalar", () => {
    expect(FACTION_BANDS).toHaveLength(7);
    expect(FACTION_BANDS.indexOf("war") - 3).toBe(-3);
    expect(FACTION_BANDS.indexOf("neutral") - 3).toBe(0);
    expect(FACTION_BANDS.indexOf("allied") - 3).toBe(3);
  });

  it("is a closed enum", () => {
    expect(FactionBand.safeParse("cold").success).toBe(true);
    expect(FactionBand.safeParse("chummy").success).toBe(false);
  });
});

describe("NpcDefinition", () => {
  const base = {
    npcId: "old-tobin",
    nameEnglish: "Old Tobin",
    nameHebrew: "טובין הזקן",
    grammaticalGender: "masculine",
    locationId: "emberfall",
    descriptionEnglish: "A river warden who has outlived three floods.",
  };

  it("makes factionId optional — an unaligned NPC is the normal case", () => {
    expect(NpcDefinition.safeParse(base).success).toBe(true);
    expect(NpcDefinition.safeParse({ ...base, factionId: "river-wardens" }).success).toBe(true);
  });

  // Hebrew narration is gendered; the same reason MonsterStatBlock carries it
  // (packages/schemas/src/srd.ts:64).
  it("requires grammaticalGender", () => {
    const { grammaticalGender, ...withoutGender } = base;
    expect(grammaticalGender).toBe("masculine");
    expect(NpcDefinition.safeParse(withoutGender).success).toBe(false);
  });
});

describe("QuestNode", () => {
  const base = {
    nodeId: "arrival",
    titleEnglish: "Arrival at Emberfall",
    sceneEnglish: "The road drops out of the pines and the town is below you.",
    locationId: "emberfall",
  };

  it("defaults preconditions, effects and edges to empty", () => {
    const parsed = QuestNode.parse(base);
    expect(parsed.preconditions).toEqual([]);
    expect(parsed.effects).toEqual([]);
    // Empty rather than min(1): node five of a five-node arc ends it.
    expect(parsed.edges).toEqual([]);
  });

  it("carries no Hebrew scene card — the narrator translates (invariant 2)", () => {
    expect(Object.keys(QuestNode.shape)).not.toContain("sceneHebrew");
  });
});

describe("WorldPredicate and WorldEffect", () => {
  it("accepts the two predicate kinds a five-node arc needs", () => {
    expect(
      WorldPredicate.safeParse({ kind: "node_completed", nodeId: "arrival" }).success,
    ).toBe(true);
    expect(
      WorldPredicate.safeParse({
        kind: "faction_band_at_least",
        factionA: "ashen-guild",
        factionB: "river-wardens",
        band: "cold",
      }).success,
    ).toBe(true);
  });

  it("accepts the two effect kinds", () => {
    expect(
      WorldEffect.safeParse({
        kind: "shift_faction_relation",
        factionA: "ashen-guild",
        factionB: "river-wardens",
        delta: -1,
      }).success,
    ).toBe(true);
    expect(WorldEffect.safeParse({ kind: "advance_calendar", days: 1 }).success).toBe(true);
  });

  // §4.7: regional danger is DERIVED from faction relations and quest
  // progress, never stored, because derived state cannot drift. There is no
  // effect that writes it and there must not be one.
  it("has no effect that stores regional danger", () => {
    expect(
      WorldEffect.safeParse({ kind: "set_regional_danger", level: 3 }).success,
    ).toBe(false);
  });

  it("refuses an unknown kind", () => {
    expect(WorldPredicate.safeParse({ kind: "flag_set", flag: "x" }).success).toBe(false);
  });
});

describe("WorldManifest", () => {
  it("carries a day counter, a start node and the faction relations", () => {
    const parsed = WorldManifest.parse({
      worldId: "emberfall",
      startingDay: 1,
      startingNodeId: "arrival",
      factionRelations: [
        { factionA: "ashen-guild", factionB: "river-wardens", band: "cold" },
      ],
    });
    expect(parsed.startingDay).toBe(1);
    expect(parsed.factionRelations).toHaveLength(1);
  });

  it("refuses day zero", () => {
    expect(
      WorldManifest.safeParse({
        worldId: "emberfall",
        startingDay: 0,
        startingNodeId: "arrival",
        factionRelations: [],
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `content.ts` does not exist, so `./index.js` exports none of these names.

- [ ] **Step 3: Write `packages/schemas/src/content.ts`**

```ts
// The authored half of §4.7's world: static lore a human edits by hand and a
// loader validates on read. It is NOT a projection of the event log.
//
// Three neighbours are easy to confuse with this file, so all three are named
// here once:
//   - `world.ts` in this package is the COMBAT grid — `GridMap`, `Combatant`,
//     and a `Faction` enum (`party | hostile | neutral`) that is a targeting
//     concept sharing nothing with a campaign faction but the word.
//   - `packages/memory/src/world-state.ts` is the EARNED half: mutable world
//     state projected from the log (§4.7). Still `export {}`.
//   - This file is the AUTHORED half: content under `data/world/`, loaded by
//     `apps/server/src/world/`.
//
// Nothing here may import a Node built-in — `apps/web` bundles this package.
import { z } from "zod";
import { GrammaticalGender } from "./character.js";

/**
 * Every id in authored content. A slug, never prose.
 *
 * §4.7's load-bearing rule for this content is that events reference lore by
 * stable id and never by embedded text, so editing a lore file cannot
 * retroactively invalidate a replay. No event carries one of these yet, so
 * nothing can enforce that at the event boundary today. What this regex
 * enforces is the half available now: a field that refuses "The Ashen Guild"
 * cannot quietly become the thing a narrator wrote, and is therefore safe to
 * persist in a payload forever.
 *
 * Both separators are allowed because both are already in use — `data/srd/`
 * files are `goblin_warrior`, encounters are `goblin-ambush` — and a rule this
 * module cannot retrofit onto those should not pretend to.
 */
export const ContentId = z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

/**
 * Faction standing, coarse and named (§4.7). The order IS the scale:
 * `FACTION_BANDS.indexOf(band) - 3` is the -3..+3 scalar, so there is one
 * table rather than two that can disagree.
 *
 * Named rather than numeric because a model reads a band name far more
 * reliably than a number, and because a coarse bucket is much easier to
 * assert on than a score.
 *
 * No arithmetic ships here. Shifting a band is clamped evaluation and belongs
 * to §4.7's step 3 scene engine; a helper written now would have no caller.
 */
export const FACTION_BANDS = [
  "war",
  "hostile",
  "cold",
  "neutral",
  "cordial",
  "friendly",
  "allied",
] as const;

export const FactionBand = z.enum(FACTION_BANDS);

export const LocationDefinition = z.object({
  locationId: ContentId,
  nameEnglish: z.string().min(1),
  nameHebrew: z.string().min(1),
  descriptionEnglish: z.string().min(1),
});

export const FactionDefinition = z.object({
  factionId: ContentId,
  nameEnglish: z.string().min(1),
  nameHebrew: z.string().min(1),
  descriptionEnglish: z.string().min(1),
});

export const NpcDefinition = z.object({
  npcId: ContentId,
  nameEnglish: z.string().min(1),
  nameHebrew: z.string().min(1),
  /**
   * Hebrew narration is gendered, so a narrator that does not know an NPC's
   * gender conjugates wrong — the reason `MonsterStatBlock` carries this
   * field (`srd.ts:64`). Locations and factions do not: a town is narrated
   * about, not conjugated around, and the field would have no consumer.
   */
  grammaticalGender: GrammaticalGender,
  locationId: ContentId,
  /** Absent for an unaligned NPC — the normal case in a world with two factions. */
  factionId: ContentId.optional(),
  descriptionEnglish: z.string().min(1),
});

/**
 * A gate over world state, checked when entering a quest node. Two kinds,
 * because two is what a five-node arc needs; a third is a one-line addition
 * when a node needs a gate the arc's own history cannot express.
 */
export const WorldPredicate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node_completed"), nodeId: ContentId }),
  z.object({
    kind: z.literal("faction_band_at_least"),
    factionA: ContentId,
    factionB: ContentId,
    band: FactionBand,
  }),
]);

/**
 * A world change declared as data and applied by the step 3 engine — never by
 * a model, which is what keeps invariant 1 intact one level above combat.
 *
 * There is no effect that writes regional danger. §4.7: regional danger is
 * derived from faction relations and quest progress, never stored, because
 * derived state cannot drift.
 */
export const WorldEffect = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shift_faction_relation"),
    factionA: ContentId,
    factionB: ContentId,
    /** Bands, not points. Clamping to the -3..+3 ends is the step 3 engine's job. */
    delta: z.number().int().min(-6).max(6),
  }),
  z.object({ kind: z.literal("advance_calendar"), days: z.number().int().min(1) }),
]);

/** A destination and a label. Predicates gate the target node, not the edge. */
export const QuestEdge = z.object({
  to: ContentId,
  /** What the choice looks like to the router. English; the narrator translates. */
  labelEnglish: z.string().min(1),
});

export const QuestNode = z.object({
  nodeId: ContentId,
  titleEnglish: z.string().min(1),
  /** The scene card, English only — matching `EncounterDefinition.sceneEnglish`. */
  sceneEnglish: z.string().min(1),
  locationId: ContentId,
  /**
   * Checked when entering this node. Predicates gate the NODE rather than the
   * edge: traversing an edge is entering its target, so this is one place to
   * look instead of two sets of bookkeeping that can disagree.
   */
  preconditions: z.array(WorldPredicate).default([]),
  /** Applied on completion, by the step 3 engine. */
  effects: z.array(WorldEffect).default([]),
  /** Empty for a terminal node — node five of a five-node arc ends it. */
  edges: z.array(QuestEdge).default([]),
});

export const FactionRelationEntry = z.object({
  factionA: ContentId,
  factionB: ContentId,
  band: FactionBand,
});

export const WorldManifest = z.object({
  worldId: ContentId,
  /**
   * A bare day counter. Time moves only through a declared `advance_calendar`
   * effect and never through a wall-clock read — that read is what makes a
   * replay diverge, the failure the `timestamp`-as-`text` decision already
   * guards against (§4.6). No months, no seasons: authoring surface with no
   * consumer.
   */
  startingDay: z.number().int().min(1),
  startingNodeId: ContentId,
  /**
   * Every unordered pair of distinct factions, exactly once. The loader
   * refuses a missing or duplicated pair, so "what is the standing between X
   * and Y" is always answerable from the file with no default rule to invent.
   * Trivial at two factions and untenable somewhere around eight, at which
   * point an undeclared pair should default to `neutral` and that check should
   * become a warning.
   */
  factionRelations: z.array(FactionRelationEntry),
});

export type ContentId = z.infer<typeof ContentId>;
export type FactionBand = z.infer<typeof FactionBand>;
export type LocationDefinition = z.infer<typeof LocationDefinition>;
export type FactionDefinition = z.infer<typeof FactionDefinition>;
export type NpcDefinition = z.infer<typeof NpcDefinition>;
export type WorldPredicate = z.infer<typeof WorldPredicate>;
export type WorldEffect = z.infer<typeof WorldEffect>;
export type QuestEdge = z.infer<typeof QuestEdge>;
export type QuestNode = z.infer<typeof QuestNode>;
export type FactionRelationEntry = z.infer<typeof FactionRelationEntry>;
export type WorldManifest = z.infer<typeof WorldManifest>;
```

- [ ] **Step 4: Export it and delete the dead `FactionRelation`**

In `packages/schemas/src/index.ts`, add after the `./world.js` line:

```ts
export * from "./content.js";
```

In `packages/schemas/src/world.ts`, delete these five lines — the schema at 17-20:

```ts
export const FactionRelation = z.object({
  factionId: z.string(),
  score: z.number().int().min(-100).max(100),
});
```

and its type export at line 78:

```ts
export type FactionRelation = z.infer<typeof FactionRelation>;
```

It is unreferenced anywhere in `packages`, `apps`, `tools` or `docs` — verify before deleting and again after:

```bash
grep -rn "FactionRelation\b" packages apps tools docs
```

Before: exactly the two lines above. After: only `FactionRelationEntry` matches in `content.ts` and its test (the `\b` makes `FactionRelationEntry` a non-match for `FactionRelation\b`, so expect **zero** lines after).

Deleting rather than redefining: its `score` is -100..100, which contradicts §4.7's coarse band directly, and keeping a campaign concept in the combat module cements the collision with the `Faction` enum two lines below it.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: PASS. `packages/schemas` goes from 6 files / 159 tests to 7 files / 159 + the new cases.

- [ ] **Step 6: Typecheck and lint the whole tree**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Both must exit 0. The deletion in `world.ts` touches a file five packages import, so a whole-tree typecheck is the check that the schema really was dead.

- [ ] **Step 7: Commit, push, open the PR**

```bash
git add packages/schemas/src/content.ts packages/schemas/src/content.test.ts \
        packages/schemas/src/world.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): add authored world content shapes

New content.ts holds every §4.7 step 2 authored shape: slug-constrained
ContentId, seven named faction bands whose order is the -3..+3 scale, and
the location/faction/NPC/quest-node/manifest definitions.

Deletes the dead FactionRelation from world.ts — unreferenced everywhere,
and its -100..100 score contradicts §4.7's coarse band."
git push -u origin narrative-step-2-world-content
gh pr create --base main --title "§4.7 step 2: world content schemas and loader" --body "..."
```

Open the PR now, not at the end: CI triggers only on `push:main` and `pull_request`, so every commit before the PR exists is unverified. The step-10 branch shipped reviewed-but-unexecuted for exactly this reason. Mark it draft if you prefer; it still runs CI.

---

## Task 3: The authored world

**Files:**
- Create: `data/world/README.md`, `data/world/world.json`, `data/world/factions.json`, `data/world/locations.json`, `data/world/npcs.json`, `data/world/arc.json`
- Create: `packages/schemas/src/world-content.test.ts`

**Interfaces:**
- Consumes: every schema Task 2 produced.
- Produces: the six files `loadWorld` reads in Task 4, and the ids Tasks 4-6 assert on — location `emberfall`; factions `ashen-guild`, `river-wardens`; NPCs `maren-vess`, `old-tobin`, `sela-the-innkeeper`; nodes `arrival`, `guild-offer`, `warden-warning`, `the-weir`, `reckoning`.

**This content goes in `data/world/`, never `data/srd/`.** Invariant 6 restricts that directory to SRD 5.2.1 CC-BY material. Everything below is original. Do not touch `NOTICE.md`.

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/world-content.test.ts`:

```ts
// §4.7 step 2's exit criterion for the content half: every file shipped in
// data/world/ parses against the shape it claims to be. Reading the
// filesystem here is fine — this is a test, not package runtime, exactly as
// srd.test.ts says of itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FactionDefinition,
  LocationDefinition,
  NpcDefinition,
  QuestNode,
  WorldManifest,
} from "./index.js";

const WORLD_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../data/world");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(join(WORLD_DIR, file), "utf8"));
}

describe("the authored world", () => {
  it("parses its manifest", () => {
    const manifest = WorldManifest.parse(readJson("world.json"));
    expect(manifest.worldId).toBe("emberfall");
    expect(manifest.startingNodeId).toBe("arrival");
  });

  it("parses every collection", () => {
    expect(FactionDefinition.array().parse(readJson("factions.json"))).toHaveLength(2);
    expect(LocationDefinition.array().parse(readJson("locations.json"))).toHaveLength(1);
    expect(NpcDefinition.array().parse(readJson("npcs.json"))).toHaveLength(3);
    expect(QuestNode.array().parse(readJson("arc.json"))).toHaveLength(5);
  });

  // A scope guard, not a claim about worlds in general. §4.7 sizes this world
  // at one town, two factions, three NPCs and a five-node arc — "enough to
  // prove the pipeline, not to be good". Growing it should be a deliberate
  // act that edits this line, not something that happens while adding colour.
  it("is still the deliberately tiny world §4.7 asked for", () => {
    expect(LocationDefinition.array().parse(readJson("locations.json"))).toHaveLength(1);
    expect(FactionDefinition.array().parse(readJson("factions.json"))).toHaveLength(2);
    expect(NpcDefinition.array().parse(readJson("npcs.json"))).toHaveLength(3);
    expect(QuestNode.array().parse(readJson("arc.json"))).toHaveLength(5);
  });

  // Exercised by real content rather than only by a unit fixture: an NPC who
  // belongs to neither faction is the case the optional field exists for.
  it("ships an unaligned NPC", () => {
    const npcs = NpcDefinition.array().parse(readJson("npcs.json"));
    const sela = npcs.find((each) => each.npcId === "sela-the-innkeeper");
    expect(sela?.factionId).toBeUndefined();
  });

  // The `.default([])` on `edges` is what lets an arc end. If this node ever
  // grows an edge, the arc no longer terminates and the default is untested
  // by real content.
  it("ends on a terminal node with no outbound edges", () => {
    const nodes = QuestNode.array().parse(readJson("arc.json"));
    const reckoning = nodes.find((each) => each.nodeId === "reckoning");
    expect(reckoning?.edges).toEqual([]);
  });

  // Both effect kinds and both predicate kinds appear in the shipped arc, so
  // the schemas are exercised by content and not only by unit fixtures.
  it("uses both predicate kinds and both effect kinds", () => {
    const nodes = QuestNode.array().parse(readJson("arc.json"));
    const predicateKinds = new Set(nodes.flatMap((n) => n.preconditions.map((p) => p.kind)));
    const effectKinds = new Set(nodes.flatMap((n) => n.effects.map((e) => e.kind)));
    expect(predicateKinds).toEqual(new Set(["node_completed", "faction_band_at_least"]));
    expect(effectKinds).toEqual(new Set(["shift_faction_relation", "advance_calendar"]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test world-content
```

Expected: FAIL with `ENOENT` — `data/world/` does not exist yet.

- [ ] **Step 3: Write the six content files**

`data/world/world.json`:

```json
{
  "worldId": "emberfall",
  "startingDay": 1,
  "startingNodeId": "arrival",
  "factionRelations": [
    { "factionA": "ashen-guild", "factionB": "river-wardens", "band": "cold" }
  ]
}
```

`data/world/factions.json`:

```json
[
  {
    "factionId": "ashen-guild",
    "nameEnglish": "The Ashen Guild",
    "nameHebrew": "גילדת האפר",
    "descriptionEnglish": "Charcoal burners and smelters who hold the hill kilns above Emberfall. They pay well, they pay on time, and they never explain what the ore is for."
  },
  {
    "factionId": "river-wardens",
    "nameEnglish": "The River Wardens",
    "nameHebrew": "שומרי הנהר",
    "descriptionEnglish": "The families who keep the weir and the fish ladders. They were here before the kilns and they intend to be here after."
  }
]
```

`data/world/locations.json`:

```json
[
  {
    "locationId": "emberfall",
    "nameEnglish": "Emberfall",
    "nameHebrew": "אמברפול",
    "descriptionEnglish": "A river town of two hundred, wedged between a working weir and a hillside of charcoal kilns. The water tastes of ash in the dry months, and everyone has an opinion about why."
  }
]
```

`data/world/npcs.json`:

```json
[
  {
    "npcId": "maren-vess",
    "nameEnglish": "Maren Vess",
    "nameHebrew": "מארן וס",
    "grammaticalGender": "feminine",
    "locationId": "emberfall",
    "factionId": "ashen-guild",
    "descriptionEnglish": "Factor for the Ashen Guild. Keeps her ledgers in three colours of ink, and will tell you exactly what each colour means if you ask her."
  },
  {
    "npcId": "old-tobin",
    "nameEnglish": "Old Tobin",
    "nameHebrew": "טובין הזקן",
    "grammaticalGender": "masculine",
    "locationId": "emberfall",
    "factionId": "river-wardens",
    "descriptionEnglish": "Warden of the lower weir for forty years. He has outlived three floods and fully expects to outlive the kilns."
  },
  {
    "npcId": "sela-the-innkeeper",
    "nameEnglish": "Sela the Innkeeper",
    "nameHebrew": "סלה הפונדקאית",
    "grammaticalGender": "feminine",
    "locationId": "emberfall",
    "descriptionEnglish": "Keeps the only inn in town with a roof that holds. Takes no side, serves both, and hears everything twice."
  }
]
```

`data/world/arc.json`:

```json
[
  {
    "nodeId": "arrival",
    "titleEnglish": "Arrival at Emberfall",
    "sceneEnglish": "The road drops out of the pines and Emberfall is below you: a weir throwing white water on the left, a hillside of smoking kilns on the right, and a town wedged between them that has clearly not been sleeping well. Two people are waiting at the bridge, and they are not standing together.",
    "locationId": "emberfall",
    "edges": [
      { "to": "guild-offer", "labelEnglish": "Hear out the guild factor" },
      { "to": "warden-warning", "labelEnglish": "Hear out the river warden" }
    ]
  },
  {
    "nodeId": "guild-offer",
    "titleEnglish": "The Guild's Offer",
    "sceneEnglish": "Maren Vess buys you a meal you did not ask for and lays a ledger open beside it. The wardens, she says, have been opening the weir gates at night and drowning the lower kilns. She wants a witness who is not from here.",
    "locationId": "emberfall",
    "preconditions": [{ "kind": "node_completed", "nodeId": "arrival" }],
    "effects": [
      {
        "kind": "shift_faction_relation",
        "factionA": "ashen-guild",
        "factionB": "river-wardens",
        "delta": -1
      }
    ],
    "edges": [{ "to": "the-weir", "labelEnglish": "Go and look at the weir yourself" }]
  },
  {
    "nodeId": "warden-warning",
    "titleEnglish": "The Warden's Warning",
    "sceneEnglish": "Old Tobin buys you nothing. He walks you along the bank until the water goes grey and stays grey, and points at it without saying anything for a long moment. The kilns, he says, are washing their ash straight into the fish ladder.",
    "locationId": "emberfall",
    "preconditions": [{ "kind": "node_completed", "nodeId": "arrival" }],
    "effects": [{ "kind": "advance_calendar", "days": 1 }],
    "edges": [{ "to": "the-weir", "labelEnglish": "Go and look at the weir yourself" }]
  },
  {
    "nodeId": "the-weir",
    "titleEnglish": "The Weir at Low Water",
    "sceneEnglish": "The weir up close is older than either quarrel. The gate mechanism has been forced, recently and badly, and the ash on the stonework is weeks deep. Both stories are true, which is the one answer nobody in town has offered you.",
    "locationId": "emberfall",
    "preconditions": [{ "kind": "node_completed", "nodeId": "arrival" }],
    "edges": [{ "to": "reckoning", "labelEnglish": "Put both parties in one room" }]
  },
  {
    "nodeId": "reckoning",
    "titleEnglish": "Reckoning at the Inn",
    "sceneEnglish": "Sela clears the long table without being asked and stands where she can see the door. Maren Vess arrives with her ledgers; Old Tobin arrives with a piece of the forced gate mechanism. Nobody has to shout, which surprises everyone present.",
    "locationId": "emberfall",
    "preconditions": [
      { "kind": "node_completed", "nodeId": "the-weir" },
      {
        "kind": "faction_band_at_least",
        "factionA": "ashen-guild",
        "factionB": "river-wardens",
        "band": "hostile"
      }
    ],
    "effects": [
      {
        "kind": "shift_faction_relation",
        "factionA": "ashen-guild",
        "factionB": "river-wardens",
        "delta": 2
      },
      { "kind": "advance_calendar", "days": 2 }
    ]
  }
]
```

Two things about the arc that are deliberate and should survive editing:

**It branches and rejoins.** `arrival` offers two edges, both landing on `the-weir`. Two paths through five nodes is the smallest shape that is a graph rather than a list, which is what makes an edge-picking router in step 4 have anything to pick.

**The `faction_band_at_least` gate on `reckoning` is satisfiable on either path, and is still not free.** The pair starts at `cold` (index 2). Down the guild path, `guild-offer`'s `delta: -1` moves it to `hostile` (index 1); the gate asks for at least `hostile`, so it passes. Down the warden path it never moves, so it passes at `cold`. A third shift downward would close the node — which is the gate doing its job, not a bug. Check this arithmetic if you change any `delta` or the starting band, because nothing in this step evaluates it: the evaluator is step 3, so a broken gate here would ship silently.

- [ ] **Step 4: Write `data/world/README.md`**

```markdown
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

One town, two factions, three NPCs, a five-node arc. §4.7: "enough to prove the
pipeline, not to be good." `packages/schemas/src/world-content.test.ts` asserts
those counts, so growing the world is a deliberate act that edits that test.

## `fixtures/` is broken on purpose

`fixtures/broken-references/` is a minimal world carrying several deliberate
defects at once — dangling ids, a duplicated id, a missing faction pair. It
exists so `loadWorld`'s refusal path has something to refuse, and
`apps/server/src/world/index.test.ts` asserts that every one of its defects is
named in a single error. **Do not fix it.** The real loader never reads it: it
reads six named files under `data/world/` and never scans a directory.
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: PASS, 8 test files.

- [ ] **Step 6: Commit**

```bash
git add data/world packages/schemas/src/world-content.test.ts
git commit -m "feat(data): author the tiny Emberfall world

One town, two factions, three NPCs and a branching five-node arc — §4.7's
'enough to prove the pipeline, not to be good'. data/world/, never
data/srd/ (invariant 6); NOTICE.md untouched.

A schemas-level test parses every shipped file and pins the counts, so
growing the world is a deliberate edit rather than a side effect."
```

---

## Task 4: The loader, happy path

**Files:**
- Create: `apps/server/src/world/index.ts`
- Create: `apps/server/src/world/index.test.ts`
- Modify: `apps/server/src/encounters/srd.ts:14-17` (one comment line)

**Interfaces:**
- Consumes: every schema from Task 2; the six files from Task 3; `dataDir(relativePath: string): string` from `../encounters/srd.js`.
- Produces: `loadWorld(dir?: string): AuthoredWorld`, `pairKey(a: string, b: string): string`, and the `AuthoredWorld` interface. Task 5 adds `WorldContentError` to the same file.

This task ships a loader that reads, parses and indexes. It does **not** cross-reference — that is Tasks 5 and 6, and a loader that only parses is honest about what it checks in the meantime.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/world/index.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir } from "../encounters/srd.js";
import { loadWorld, pairKey } from "./index.js";

describe("loadWorld", () => {
  // This is the only test that exercises the walk-up for `data/world`: if
  // `dataDir` could not find it above this file (e.g. because it stopped one
  // directory too early after a `dist/` layout change), this load would fail
  // with "Could not find data/world above this file" rather than returning a
  // parsed world.
  it("finds and parses the authored world", () => {
    const world = loadWorld();
    expect(world.worldId).toBe("emberfall");
    expect(world.startingDay).toBe(1);
    expect(world.startingNodeId).toBe("arrival");
  });

  it("indexes every collection by its own id", () => {
    const world = loadWorld();
    expect(world.factions.get("ashen-guild")?.nameEnglish).toBe("The Ashen Guild");
    expect(world.locations.get("emberfall")?.nameHebrew).toBe("אמברפול");
    expect(world.npcs.get("old-tobin")?.grammaticalGender).toBe("masculine");
    expect(world.questNodes.get("reckoning")?.edges).toEqual([]);
    expect(world.factions.size).toBe(2);
    expect(world.locations.size).toBe(1);
    expect(world.npcs.size).toBe(3);
    expect(world.questNodes.size).toBe(5);
  });

  // A relation is an unordered pair: `pairKey` sorts, so asking in either
  // order finds the one entry. Without this the manifest's argument order
  // would silently become part of the data.
  it("keys faction relations on an unordered pair", () => {
    const world = loadWorld();
    expect(world.relations.get(pairKey("ashen-guild", "river-wardens"))).toBe("cold");
    expect(world.relations.get(pairKey("river-wardens", "ashen-guild"))).toBe("cold");
    expect(world.relations.size).toBe(1);
  });

  it("returns the same cached instance on a second call", () => {
    expect(loadWorld()).toBe(loadWorld());
  });

  // Caching is keyed by directory, not global. Passing the default path
  // explicitly must hit the same entry the no-argument call created — and
  // Task 5 supplies the other half, where a DIFFERENT directory still throws
  // rather than being served this cached world.
  it("caches per directory, so an explicit path hits the same entry", () => {
    expect(loadWorld(dataDir(join("data", "world")))).toBe(loadWorld());
  });

  it("throws ENOENT for a directory with no world in it", () => {
    expect(() => loadWorld(join(dataDir(join("data", "world")), "nope"))).toThrow(/ENOENT/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test world
```

Expected: FAIL — `./index.js` does not exist under `src/world/`.

- [ ] **Step 3: Write `apps/server/src/world/index.ts`**

```ts
// Loads the authored world from `data/world/` (`PROJECT_PLAN.md` §4.7 step 2).
// Static content, hand-edited, validated on read. The mutable half of the
// world is a projection of the event log and lives in `packages/memory`, not
// here — §4.7 is explicit that static lore is a loader and world state is a
// projection.
//
// Mirrors `apps/server/src/encounters/`: the file I/O sits in this app
// because `@ai-dm/rules-engine` forbids I/O and `@ai-dm/schemas` is bundled
// for the browser by `apps/web`, so `node:fs` fits in neither.
//
// Nothing in the running pipeline calls this yet. §4.7's step 3 scene engine
// is the first consumer, and it takes the result injected — the way
// `buildEncounter` takes `statBlocks` and `characters` — rather than reaching
// for the filesystem itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FactionDefinition,
  LocationDefinition,
  NpcDefinition,
  QuestNode,
  WorldManifest,
} from "@ai-dm/schemas";
import type { FactionBand } from "@ai-dm/schemas";
import { dataDir } from "../encounters/srd.js";

const WORLD_DIR_RELATIVE = join("data", "world");

/**
 * The authored world, indexed. `Map`s rather than arrays for the reason
 * `loadGear` returns them: every consumer looks content up by id.
 *
 * Declared here rather than in `@ai-dm/schemas` because it is neither a wire
 * shape nor a zod schema — it holds `Map`s. `SrdGear` is the identical case
 * and lives in `@ai-dm/rules-engine`, next to its consumer rather than in the
 * schema package. §4.7's step 3 scene engine takes this injected and can
 * rehome the type then.
 */
export interface AuthoredWorld {
  readonly worldId: string;
  readonly startingDay: number;
  readonly startingNodeId: string;
  readonly factions: ReadonlyMap<string, FactionDefinition>;
  readonly locations: ReadonlyMap<string, LocationDefinition>;
  readonly npcs: ReadonlyMap<string, NpcDefinition>;
  readonly questNodes: ReadonlyMap<string, QuestNode>;
  /** Keyed by `pairKey`, so a relation is an unordered pair. */
  readonly relations: ReadonlyMap<string, FactionBand>;
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

/**
 * Canonical key for an unordered faction pair, so declaring `A,B` and `B,A`
 * names one relation rather than two. `|` is safe as a delimiter because
 * `ContentId` forbids it.
 *
 * Exported because a `Map` keyed by a private convention is unusable by a
 * consumer. Step 3 may well want a `relationBetween(world, a, b)` wrapper
 * over it; that is one line and belongs with the code that needs it.
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Parsed once per directory. The files never change at runtime, and the
// reason to cache is concrete rather than habitual: the moment §4.7's step 3
// wires this in, an uncached whole-world reread per deliberation is exactly
// the O(encounters) blocking cold-load I/O that step 1's review flagged in
// `loadCampaign` as a pattern not to repeat.
const cache = new Map<string, AuthoredWorld>();

export function loadWorld(dir: string = dataDir(WORLD_DIR_RELATIVE)): AuthoredWorld {
  const hit = cache.get(dir);
  if (hit !== undefined) return hit;

  const manifest = WorldManifest.parse(readJson(dir, "world.json"));
  const factionList = FactionDefinition.array().parse(readJson(dir, "factions.json"));
  const locationList = LocationDefinition.array().parse(readJson(dir, "locations.json"));
  const npcList = NpcDefinition.array().parse(readJson(dir, "npcs.json"));
  const nodeList = QuestNode.array().parse(readJson(dir, "arc.json"));

  const world: AuthoredWorld = {
    worldId: manifest.worldId,
    startingDay: manifest.startingDay,
    startingNodeId: manifest.startingNodeId,
    factions: new Map(factionList.map((each) => [each.factionId, each])),
    locations: new Map(locationList.map((each) => [each.locationId, each])),
    npcs: new Map(npcList.map((each) => [each.npcId, each])),
    questNodes: new Map(nodeList.map((each) => [each.nodeId, each])),
    relations: new Map(
      manifest.factionRelations.map((each) => [
        pairKey(each.factionA, each.factionB),
        each.band,
      ]),
    ),
  };

  cache.set(dir, world);
  return world;
}
```

- [ ] **Step 4: Fix the `dataDir` comment it just falsified**

`apps/server/src/encounters/srd.ts:14-17` currently says the walk-up is "Shared by every loader under `apps/server/src/encounters/` (`gear.ts`, `characters.ts`)". A loader outside that directory now uses it. Replace that clause:

```ts
/** Walk up until `relativePath` appears — a fixed relative path would be
 * wrong for `dist/` after `pnpm build`. Shared by every loader in this app
 * (`gear.ts`, `characters.ts`, `../world/index.ts`) so the walk-up itself is
 * written once. */
```

Sweep by shape, not by wording: the claim that went stale is "under this directory", not any particular string.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test
```

Expected: PASS, `apps/server` at 11 files.

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/world apps/server/src/encounters/srd.ts
git commit -m "feat(server): load the authored world from data/world/

loadWorld reads six named files, parses each against its schema and
indexes them by id, caching per directory. No cross-referencing yet —
that is the next two commits.

dataDir's doc comment claimed it was shared only by loaders under
encounters/; a sibling now uses it."
```

---

## Task 5: The refusal path — duplicate ids and dangling references

**Files:**
- Modify: `apps/server/src/world/index.ts`
- Modify: `apps/server/src/world/index.test.ts`
- Create: `data/world/fixtures/broken-references/{world,factions,locations,npcs,arc}.json`

**Interfaces:**
- Consumes: `loadWorld`, `pairKey`, `AuthoredWorld` from Task 4.
- Produces: `WorldContentError` with a `readonly problems: readonly string[]`, thrown by `loadWorld`.

This is the task the step exists for. §4.7's premise is that events point at lore by id; an id that resolves to nothing is the one way that premise fails silently.

- [ ] **Step 1: Write the broken fixture world**

Create `data/world/fixtures/broken-references/world.json`:

```json
{
  "worldId": "broken-references",
  "startingDay": 1,
  "startingNodeId": "no-such-node",
  "factionRelations": [
    { "factionA": "alpha", "factionB": "beta", "band": "cold" },
    { "factionA": "beta", "factionB": "alpha", "band": "war" }
  ]
}
```

`data/world/fixtures/broken-references/factions.json`:

```json
[
  { "factionId": "alpha", "nameEnglish": "Alpha", "nameHebrew": "אלפא", "descriptionEnglish": "A fixture faction." },
  { "factionId": "beta", "nameEnglish": "Beta", "nameHebrew": "בטא", "descriptionEnglish": "A fixture faction." },
  { "factionId": "gamma", "nameEnglish": "Gamma", "nameHebrew": "גמא", "descriptionEnglish": "A fixture faction." }
]
```

`data/world/fixtures/broken-references/locations.json`:

```json
[
  { "locationId": "somewhere", "nameEnglish": "Somewhere", "nameHebrew": "אישהו", "descriptionEnglish": "A fixture location." }
]
```

`data/world/fixtures/broken-references/npcs.json`:

```json
[
  {
    "npcId": "twin",
    "nameEnglish": "Twin the First",
    "nameHebrew": "התאום הראשון",
    "grammaticalGender": "masculine",
    "locationId": "no-such-place",
    "factionId": "no-such-faction",
    "descriptionEnglish": "Carries both dangling references. Indexed, so both are checked."
  },
  {
    "npcId": "twin",
    "nameEnglish": "Twin the Second",
    "nameHebrew": "התאום השני",
    "grammaticalGender": "feminine",
    "locationId": "somewhere",
    "factionId": "alpha",
    "descriptionEnglish": "A duplicate id. Dropped during indexing, so its own fields are valid on purpose — a dropped entry is not cross-referenced."
  }
]
```

`data/world/fixtures/broken-references/arc.json`:

```json
[
  {
    "nodeId": "start",
    "titleEnglish": "Start",
    "sceneEnglish": "A fixture node whose every outbound reference is wrong.",
    "locationId": "somewhere",
    "preconditions": [{ "kind": "node_completed", "nodeId": "no-such-node" }],
    "effects": [
      {
        "kind": "shift_faction_relation",
        "factionA": "alpha",
        "factionB": "no-such-faction",
        "delta": 1
      }
    ],
    "edges": [{ "to": "no-such-node", "labelEnglish": "Nowhere" }]
  }
]
```

Every file here **parses** cleanly — the ids are all valid slugs and every required field is present. That is the point: these are defects zod cannot see, which is precisely why the loader has to look.

The fixture also carries a duplicated faction relation (`alpha,beta` declared in both orders) and leaves the `alpha,gamma` and `beta,gamma` pairs undeclared. Task 6 catches those; this task does not, and its test therefore asserts the presence of its own problems rather than a total count.

- [ ] **Step 2: Write the failing test**

Append to `apps/server/src/world/index.test.ts`:

```ts
import { WorldContentError } from "./index.js"; // add to the existing import

const BROKEN = join(dataDir(join("data", "world")), "fixtures", "broken-references");

describe("loadWorld refusing broken content", () => {
  // The strongest single statement that the checks below do not false-positive.
  it("accepts the real authored world", () => {
    expect(() => loadWorld()).not.toThrow();
  });

  it("throws a named, instanceof-able error", () => {
    expect(() => loadWorld(BROKEN)).toThrow(WorldContentError);
    expect(() => loadWorld(BROKEN)).toThrow(/Invalid world content/);
  });

  // One throw carrying every defect, not the first. Throwing at the first
  // dangling id would make an author fix these one reload at a time.
  it.each([
    'duplicate npc id "twin"',
    'world.json startingNodeId references unknown quest node "no-such-node"',
    'npc twin references unknown location "no-such-place"',
    'npc twin references unknown faction "no-such-faction"',
    'quest node start edge references unknown quest node "no-such-node"',
    'quest node start precondition references unknown quest node "no-such-node"',
    'quest node start effect references unknown faction "no-such-faction"',
  ])("names: %s", (problem) => {
    try {
      loadWorld(BROKEN);
      expect.unreachable("loadWorld should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorldContentError);
      expect((error as WorldContentError).problems).toContain(problem);
    }
  });

  // A duplicate is dropped during indexing, so the entry that survives is the
  // first one — which is why the fixture puts both dangling ids on it.
  it("keeps the first of two entries sharing an id", () => {
    try {
      loadWorld(BROKEN);
      expect.unreachable("loadWorld should have thrown");
    } catch (error) {
      expect((error as WorldContentError).problems).not.toContain(
        'npc twin references unknown faction "alpha"',
      );
    }
  });

  // Every file in the fixture parses cleanly — these are defects zod cannot
  // see, which is the whole reason the loader has to look. If this ever
  // throws a ZodError instead, the fixture has drifted into being malformed
  // and has stopped testing cross-referencing at all.
  it("throws for defects zod cannot see, not for a malformed file", () => {
    try {
      loadWorld(BROKEN);
      expect.unreachable("loadWorld should have thrown");
    } catch (error) {
      expect((error as Error).name).toBe("WorldContentError");
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test world
```

Expected: FAIL — `WorldContentError` is not exported, and `loadWorld(BROKEN)` currently returns a world instead of throwing.

- [ ] **Step 4: Add the collection and the throw**

In `apps/server/src/world/index.ts`, add the error class after the imports:

```ts
/**
 * Thrown by `loadWorld` when content parses but does not hang together — a
 * duplicate id, an id that resolves to nothing, a faction pair left
 * undeclared. Named and `instanceof`-able for the reason
 * `UnknownEncounterError` is: a caller distinguishing this from a `ZodError`
 * should not have to match on message text.
 *
 * It carries EVERY problem found rather than the first. An author fixing five
 * dangling ids should need one reload, not five.
 */
export class WorldContentError extends Error {
  readonly problems: readonly string[];

  constructor(dir: string, problems: readonly string[]) {
    super(`Invalid world content in ${dir}:\n  - ${problems.join("\n  - ")}`);
    this.name = "WorldContentError";
    this.problems = problems;
  }
}

/** Which collection an id has to resolve in. */
type ContentKind = "faction" | "location" | "quest node";

interface ContentRef {
  readonly kind: ContentKind;
  readonly id: string;
}

function indexBy<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  what: string,
  problems: string[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = idOf(item);
    if (map.has(id)) {
      problems.push(`duplicate ${what} id "${id}"`);
      continue;
    }
    map.set(id, item);
  }
  return map;
}

/**
 * Every content id a predicate names. Written as a `return` from each branch
 * with no `default`, so adding a `WorldPredicate` kind fails to compile here
 * rather than silently skipping its cross-reference — the same exhaustiveness
 * discipline `packages/schemas/src/reduce.ts` relies on.
 */
function predicateRefs(predicate: WorldPredicate): readonly ContentRef[] {
  switch (predicate.kind) {
    case "node_completed":
      return [{ kind: "quest node", id: predicate.nodeId }];
    case "faction_band_at_least":
      return [
        { kind: "faction", id: predicate.factionA },
        { kind: "faction", id: predicate.factionB },
      ];
  }
}

/** Same exhaustiveness contract as `predicateRefs`. */
function effectRefs(effect: WorldEffect): readonly ContentRef[] {
  switch (effect.kind) {
    case "shift_faction_relation":
      return [
        { kind: "faction", id: effect.factionA },
        { kind: "faction", id: effect.factionB },
      ];
    case "advance_calendar":
      return [];
  }
}
```

Add `WorldPredicate` and `WorldEffect` to the type-only import from `@ai-dm/schemas`:

```ts
import type { FactionBand, WorldEffect, WorldPredicate } from "@ai-dm/schemas";
```

Then replace the body of `loadWorld` between the five `.parse` calls and the `const world` literal:

```ts
  const problems: string[] = [];

  const factions = indexBy(factionList, (each) => each.factionId, "faction", problems);
  const locations = indexBy(locationList, (each) => each.locationId, "location", problems);
  const npcs = indexBy(npcList, (each) => each.npcId, "npc", problems);
  const questNodes = indexBy(nodeList, (each) => each.nodeId, "quest node", problems);

  const collections: Record<ContentKind, ReadonlyMap<string, unknown>> = {
    faction: factions,
    location: locations,
    "quest node": questNodes,
  };

  const checkRef = (ref: ContentRef, where: string): void => {
    if (!collections[ref.kind].has(ref.id)) {
      problems.push(`${where} references unknown ${ref.kind} "${ref.id}"`);
    }
  };

  const relations = new Map<string, FactionBand>();
  for (const entry of manifest.factionRelations) {
    relations.set(pairKey(entry.factionA, entry.factionB), entry.band);
  }

  checkRef({ kind: "quest node", id: manifest.startingNodeId }, "world.json startingNodeId");

  // Iterating the indexed maps rather than the parsed lists: an entry dropped
  // as a duplicate is already reported, and cross-referencing it too would
  // report the same defect twice under one id.
  for (const npc of npcs.values()) {
    const where = `npc ${npc.npcId}`;
    checkRef({ kind: "location", id: npc.locationId }, where);
    if (npc.factionId !== undefined) checkRef({ kind: "faction", id: npc.factionId }, where);
  }

  for (const node of questNodes.values()) {
    const where = `quest node ${node.nodeId}`;
    checkRef({ kind: "location", id: node.locationId }, where);
    for (const edge of node.edges) {
      checkRef({ kind: "quest node", id: edge.to }, `${where} edge`);
    }
    for (const predicate of node.preconditions) {
      for (const ref of predicateRefs(predicate)) checkRef(ref, `${where} precondition`);
    }
    for (const effect of node.effects) {
      for (const ref of effectRefs(effect)) checkRef(ref, `${where} effect`);
    }
  }

  if (problems.length > 0) throw new WorldContentError(dir, problems);
```

The `const world` literal then uses the local `factions` / `locations` / `npcs` / `questNodes` / `relations` bindings instead of building the `Map`s inline, and `cache.set` stays where it is — the cache is only written on a clean load, so a broken directory throws on every call rather than only the first.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test
```

Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/world data/world/fixtures
git commit -m "feat(server): refuse world content whose ids do not resolve

loadWorld now collects duplicate ids and every dangling reference, then
throws one WorldContentError naming all of them — an author fixing five
ids should need one reload, not five.

data/world/fixtures/broken-references/ is a minimal world carrying every
defect at once; it parses cleanly, which is the point."
```

---

## Task 6: The refusal path — faction pairs

**Files:**
- Modify: `apps/server/src/world/index.ts` (the relations loop)
- Modify: `apps/server/src/world/index.test.ts`
- Modify: `data/world/fixtures/broken-references/world.json` (two more relation entries)

**Interfaces:**
- Consumes: `checkRef`, `pairKey`, `problems`, `WorldContentError` from Task 5.
- Produces: no new export. `loadWorld` gains three refusals.

Separate from Task 5 because it is a separate rule with its own justification and its own ceiling: §4.7 does not require exhaustive declaration, this design chose it, and a reviewer could accept dangling-id detection while rejecting this.

- [ ] **Step 1: Add the last two defects to the fixture**

In `data/world/fixtures/broken-references/world.json`, extend `factionRelations` to four entries:

```json
{
  "worldId": "broken-references",
  "startingDay": 1,
  "startingNodeId": "no-such-node",
  "factionRelations": [
    { "factionA": "alpha", "factionB": "beta", "band": "cold" },
    { "factionA": "beta", "factionB": "alpha", "band": "war" },
    { "factionA": "alpha", "factionB": "no-such-faction", "band": "neutral" },
    { "factionA": "gamma", "factionB": "gamma", "band": "neutral" }
  ]
}
```

That is: the same pair declared in both orders (a duplicate), a pair naming a faction that does not exist, a faction related to itself, and — because `gamma` never gets a valid pairing — the `alpha`/`gamma` and `beta`/`gamma` pairs left undeclared.

- [ ] **Step 2: Write the failing test**

Append to `apps/server/src/world/index.test.ts`:

```ts
describe("loadWorld refusing faction relations", () => {
  it.each([
    'duplicate faction relation for "beta" and "alpha"',
    'faction relation alpha/no-such-faction references unknown faction "no-such-faction"',
    "faction relation gamma/gamma relates a faction to itself",
    'no faction relation declared for "alpha" and "gamma"',
    'no faction relation declared for "beta" and "gamma"',
  ])("names: %s", (problem) => {
    try {
      loadWorld(BROKEN);
      expect.unreachable("loadWorld should have thrown");
    } catch (error) {
      expect((error as WorldContentError).problems).toContain(problem);
    }
  });

  // The complete set, so a check that starts reporting something extra —
  // or stops reporting something — fails here rather than passing quietly.
  it("reports exactly these twelve problems and no others", () => {
    try {
      loadWorld(BROKEN);
      expect.unreachable("loadWorld should have thrown");
    } catch (error) {
      expect(new Set((error as WorldContentError).problems)).toEqual(
        new Set([
          'duplicate npc id "twin"',
          'world.json startingNodeId references unknown quest node "no-such-node"',
          'npc twin references unknown location "no-such-place"',
          'npc twin references unknown faction "no-such-faction"',
          'quest node start edge references unknown quest node "no-such-node"',
          'quest node start precondition references unknown quest node "no-such-node"',
          'quest node start effect references unknown faction "no-such-faction"',
          'duplicate faction relation for "beta" and "alpha"',
          'faction relation alpha/no-such-faction references unknown faction "no-such-faction"',
          "faction relation gamma/gamma relates a faction to itself",
          'no faction relation declared for "alpha" and "gamma"',
          'no faction relation declared for "beta" and "gamma"',
        ]),
      );
    }
  });

  // With two factions the real world declares one pair, which is the whole
  // exhaustive requirement. If this ever fails, the completeness rule has
  // started firing on valid content.
  it("accepts the real world's single declared pair", () => {
    expect(loadWorld().relations.size).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test world
```

Expected: FAIL — five problems are missing and the set assertion reports seven of twelve.

- [ ] **Step 4: Replace the relations loop**

In `apps/server/src/world/index.ts`, replace Task 5's three-line relations loop with:

```ts
  const relations = new Map<string, FactionBand>();
  for (const entry of manifest.factionRelations) {
    const where = `faction relation ${entry.factionA}/${entry.factionB}`;
    checkRef({ kind: "faction", id: entry.factionA }, where);
    checkRef({ kind: "faction", id: entry.factionB }, where);
    if (entry.factionA === entry.factionB) {
      problems.push(`${where} relates a faction to itself`);
      continue;
    }
    const key = pairKey(entry.factionA, entry.factionB);
    if (relations.has(key)) {
      problems.push(
        `duplicate faction relation for "${entry.factionA}" and "${entry.factionB}"`,
      );
      continue;
    }
    relations.set(key, entry.band);
  }

  // Every unordered pair of distinct factions must be declared, so "what is
  // the standing between X and Y" is always answerable from the file and
  // there is no default rule for the step 3 engine to invent. Exhaustive
  // declaration is one line at two factions and untenable somewhere around
  // eight, at which point an undeclared pair should default to `neutral` and
  // this should become a warning rather than a refusal.
  const factionIds = Array.from(factions.keys()).sort();
  for (const [index, a] of factionIds.entries()) {
    for (const b of factionIds.slice(index + 1)) {
      if (!relations.has(pairKey(a, b))) {
        problems.push(`no faction relation declared for "${a}" and "${b}"`);
      }
    }
  }
```

`Array.from`, not `[...factions.keys()]`: ESLint's `no-misused-spread` is configured on and the codebase uses `Array.from` throughout. `.entries()` rather than an index loop keeps `a` a `string` instead of `string | undefined` under `noUncheckedIndexedAccess`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test
```

Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/world data/world/fixtures
git commit -m "feat(server): refuse incomplete or contradictory faction relations

Every unordered pair of distinct factions must be declared exactly once:
no duplicate, no self-pair, no unknown faction, no missing pair. That
removes the need for a default the step 3 engine would otherwise invent."
```

---

## Task 7: Docs sweep and final verification

**Files:** `PROJECT_PLAN.md` §4.7 sequence entry 2; `packages/schemas/CLAUDE.md`.

- [ ] **Step 1: Record the step in the §4.7 sequence**

`PROJECT_PLAN.md`'s §4.7 Sequence, entry 2, currently reads:

```markdown
2. **Static content loaders and a deliberately tiny authored world:** one
   town, two factions, three NPCs, a five-node arc. Enough to prove the
   pipeline, not to be good.
```

Extend it in entry 1's format — spec link, plan link, and the merge commit plus CI numbers once the PR is green:

```markdown
2. **Static content loaders and a deliberately tiny authored world:** one
   town, two factions, three NPCs, a five-node arc. Enough to prove the
   pipeline, not to be good. **Merged to `main`** <date> as `<sha>`,
   CI green with Postgres at <passed> passed / 0 skipped / 93 files.
   [`docs/superpowers/specs/2026-08-27-world-content-loader-design.md`](docs/superpowers/specs/2026-08-27-world-content-loader-design.md),
   plan at
   [`docs/superpowers/plans/2026-08-27-world-content-loader.md`](docs/superpowers/plans/2026-08-27-world-content-loader.md).
```

Fill the placeholders from the actual merge; do not guess them.

- [ ] **Step 2: Update the one CLAUDE.md claim this step falsifies**

`packages/schemas/CLAUDE.md`'s Purpose line lists what the package is the source of truth for: "character sheets, tactical actions (`ExecuteTurn`), game events, world/grid types". Authored world content is now a fifth kind and is not covered by any of those four. Add it:

```markdown
Single source of truth for every shared data shape: character sheets, tactical actions (`ExecuteTurn`), game events, world/grid types, authored world content (`content.ts` — locations, factions, NPCs, the quest DAG). Everything else derives from here — TS types via `z.infer`, runtime validation via `.parse()`, LLM tool definitions via `zod-to-json-schema`.

Keep the trailing sentence: the line is one paragraph and the replacement must not truncate it.
```

- [ ] **Step 3: Two files deliberately not swept — record why**

**`packages/memory/CLAUDE.md` is not touched.** Its Stack bullet says the planned world-state tables are "deferred past step 10 — a campaign concept exists now, but the world content and scene engine that would populate them are still ahead, `PROJECT_PLAN.md` §4.7 sequence steps 2–3". After this step, "the world content ... still ahead" is half-false: the content exists, the scene engine does not. That sentence should be narrowed to step 3 alone — but **this file carries an uncommitted edit that is not this plan's**, and staging it would sweep someone else's prose into this PR. Leave it, and flag it in the PR description so whoever owns that edit fixes both lines together.

**`apps/server/CLAUDE.md` is not touched.** Its Purpose section describes what the orchestrator owns — turn pipeline, campaign lifecycle, event log. A content loader that nothing in the pipeline calls falsifies none of that. Sweep by shape: there is no stale claim here, only an unmentioned directory, and CLAUDE.md is not a file index.

- [ ] **Step 4: Full verification**

```bash
corepack enable
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Expected against Task 1's baseline: **93 test files** (90 plus `content.test.ts`, `world-content.test.ts`, `world/index.test.ts`), 1274 + the new cases passed, still 30 skipped, both commands exit 0.

Scope eslint and vitest to real paths. A bare root `eslint .` also walks `.claude/worktrees/` and fails on other worktrees' code.

- [ ] **Step 5: Verify under Postgres**

**Docker cannot pull images on this machine** — do not run `docker compose up`. Use the local Homebrew Postgres 18 and a scratch database:

```bash
createdb aidm_step2 2>/dev/null || true
DATABASE_URL=postgres://localhost:5432/aidm_step2 pnpm --filter @ai-dm/memory db:migrate
DATABASE_URL=postgres://localhost:5432/aidm_step2 pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
```

Expected: 0 skipped, with `packages/memory` executing 62/62 rather than skipping and `apps/server`'s gated bracket test executing.

This step adds no table and no migration, so a Postgres run should differ from Task 1's baseline only by the new offline tests. Do **not** migrate the existing `aidm` database — it still carries the pre-rename schema and is a decision for whoever owns that data, not this plan.

- [ ] **Step 6: Get CI green on the PR**

The PR opened in Task 2 has been running on every push. Confirm the final run is green before merging — CI triggers only on `push:main` and `pull_request`, so a green local run is not a substitute.

```bash
gh pr checks
```

- [ ] **Step 7: Commit and record the outcome**

```bash
git add PROJECT_PLAN.md packages/schemas/CLAUDE.md
git commit -m "docs: record §4.7 step 2 and its one falsified claim"
```

Then record each task's actual outcome inline in this plan, in the style of `2026-08-23-campaign-state-split.md`'s Task 8 note: what shipped, what the final numbers were, and anything found that this plan got wrong. A plan whose outcomes are not written down leaves the next step rediscovering them file by file.

---

## Self-review

Run against the spec after writing, before executing.

**Spec coverage.** Every numbered decision maps to a task: 1 and 2 → Task 2 (new `content.ts`, `FactionRelation` deleted); 3 → Task 2 (`ContentId` regex, tests both ways); 4 and 4a → Task 2; 5 → Task 2 (`FACTION_BANDS`, no arithmetic); 5a → Task 6 (unordered pair, exhaustive declaration); 6 → Task 2 (both unions, predicates on nodes, no `set_regional_danger`); 7 → Task 2 (`startingDay`); 8 → Task 3 (`data/world/`, README, fixture nesting); 9 → Task 4 (`loadWorld`, `dataDir` reuse, `AuthoredWorld` local, per-directory cache); 10 → Tasks 5 and 6 (parse errors propagate, index, cross-reference, one throw). The spec's "what this must not make worse" section is enforced by the Global Constraints' "No behaviour" line and by no task naming `reduce`, `fold`, `loadCampaign`, `pipeline.ts` or `campaign_started`.

**Placeholders.** The only intentional ones are in Task 7 Step 1 — `<date>`, `<sha>`, `<passed>` — which cannot be known before the merge and are explicitly marked "do not guess".

**Type consistency.** `pairKey` is defined in Task 4 and used in Tasks 4, 5 and 6. `checkRef`, `problems`, `indexBy`, `ContentRef` and `ContentKind` are defined in Task 5 and used in Task 6. `WorldContentError` is exported in Task 5 and imported by Task 6's tests through the same `./index.js` import. `FactionBand` is imported type-only in Task 4 and joined by `WorldEffect` and `WorldPredicate` in Task 5. Schema names in the JSON of Task 3 match the schemas of Task 2 field for field.

**One risk this plan does not remove.** Nothing in this step evaluates a predicate, so the arc's `faction_band_at_least` gate on `reckoning` is unexercised arithmetic until step 3. Task 3 Step 3 states the arithmetic explicitly for that reason. If step 3's first act is to evaluate this arc and find the gate unsatisfiable, the fault is here, not there.

**Three defects this self-review found in the plan itself, fixed inline:**
Task 7's `packages/schemas/CLAUDE.md` replacement silently truncated the
sentence following the one it edited; Task 4's per-directory cache test
compared a world object against a path string and so could never fail; and
Task 5's `.not.toThrow(/ZodError/)` matched against a message that never
contains that word, making it vacuous. All three are the same class — an
assertion or an edit that looks like a check and is not one — which is worth
knowing before executing the rest.
