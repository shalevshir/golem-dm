# Character Profiles and NPC Affinity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authored quest-node effects shift how an NPC regards the player and record a short English fact about them, projected as a per-campaign overlay the same shape faction standing already has — no new event type, no new agent, no new player-character schema.

**Architecture:** Two new `WorldEffect` variants (`shift_npc_affinity`, `add_npc_fact`) reuse the existing `FactionBand` scale and are applied by the pure scene engine on quest-node completion, exactly like `shift_faction_relation`. The result lives in a new `npcAffinities` overlay array on `SceneSnapshot`, merged from `world_delta_applied`'s already-widened payload the same way `relations` is today. `reckoning`, the arc's terminal node, gets the two new effects added to its existing `effects` array to prove the whole path end to end.

**Tech Stack:** TypeScript 5 strict, ESM, zod, Vitest.

**Spec:** [`docs/superpowers/specs/2026-08-30-character-profiles-design.md`](../specs/2026-08-30-character-profiles-design.md)

## Global Constraints

- `corepack enable` before any `pnpm` command — pnpm is not otherwise on PATH.
- Node 22, ESM only. Every relative import ends in `.js`, including type-only imports.
- TypeScript strict; ESLint `strictTypeChecked`; Prettier at 100 columns.
- **Never run `pnpm format`** — there is no `.prettierignore` and `--write .` rewrites ~37 files including the lockfile. **Never run root `pnpm lint`** — it walks sibling worktrees. Lint with `npx eslint packages apps tools`.
- Tests are colocated `*.test.ts` / `*.test.tsx`, run with Vitest.
- Dependency direction: `schemas ← rules-engine ← agents ← server`; `web` depends only on `@ai-dm/schemas`; nothing depends on `server`.
- **English inside, Hebrew outside.** All code, comments, prompts, payloads and log fields are English. The only sanctioned Hebrew event fields are `narrative_emitted.text` and `player_input.text`; this plan adds no third — `add_npc_fact`'s `fact` is English and internal-only (spec Decision 5).
- No `default` branch in any switch over a discriminated union — exhaustiveness must fail the build. This applies to `applyEffect`, `effectRefs`, and `evaluatePredicate`.
- `packages/rules-engine` line coverage stays ≥ 90%.
- **Do not touch `packages/memory/CLAUDE.md`** — it carries someone else's uncommitted edit.
- Baseline to preserve or beat, measured at `220985c`: `pnpm test` → 1575 passed / 30 skipped / 104 files. `DATABASE_URL=postgres://localhost:5432/aidm_step5_scratch pnpm test` → 1605 passed / 0 skipped / 104 files. `pnpm typecheck` → exit 0. `npx eslint packages apps tools` → exit 0.
- The scratch database `aidm_step5_scratch` already exists on the local brew Postgres 18 with its drizzle migration applied. **Never point tests at `aidm`.**
- All exports in `@ai-dm/schemas` are already re-exported via `export * from "./<file>.js"` in `packages/schemas/src/index.ts` — no task in this plan needs to touch that file.

---

### Task 1: Schema additions — `NpcAffinityEntry`, the two new `WorldEffect` kinds, and the widened payloads

Pure schema surface: one new object type, two new discriminated-union members, and two existing payloads widened by an optional-with-default field. No behavior changes yet — `reduce` and the rules engine still ignore these fields after this task; Tasks 2 and 3 make them do something.

**Files:**
- Modify: `packages/schemas/src/content.ts` (new `NpcAffinityEntry`, `WorldEffect`'s two new members)
- Modify: `packages/schemas/src/content.test.ts`
- Modify: `packages/schemas/src/events.ts` (`WorldDeltaAppliedPayload`)
- Modify: `packages/schemas/src/events.test.ts`
- Modify: `packages/schemas/src/protocol.ts` (`SceneSnapshot`, `sceneFromGenesis`)
- Modify: `packages/schemas/src/protocol.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `NpcAffinityEntry` (`{npcId: string, band: FactionBand, facts: string[]}`), `WorldEffect`'s `shift_npc_affinity`/`add_npc_fact` members, `SceneSnapshot.npcAffinities: NpcAffinityEntry[]`, `WorldDeltaAppliedPayload.npcAffinities: NpcAffinityEntry[]`. Task 2 folds the payload field onto the snapshot field; Task 3 applies the two effect kinds; Task 4 cross-references `npcId` in the loader.

- [ ] **Step 1: Write the failing schema tests**

In `packages/schemas/src/content.test.ts`, add `NpcAffinityEntry` to the existing `./index.js` import (currently `ContentId, FACTION_BANDS, FactionBand, NpcDefinition, QuestNode, WorldEffect, WorldManifest, WorldPredicate`), then replace the `"accepts the two effect kinds"` test and add four more, right after it:

```ts
  it("accepts the four effect kinds", () => {
    expect(
      WorldEffect.safeParse({
        kind: "shift_faction_relation",
        factionA: "ashen-guild",
        factionB: "river-wardens",
        delta: -1,
      }).success,
    ).toBe(true);
    expect(WorldEffect.safeParse({ kind: "advance_calendar", days: 1 }).success).toBe(true);
    expect(
      WorldEffect.safeParse({ kind: "shift_npc_affinity", npcId: "sela-the-innkeeper", delta: 1 })
        .success,
    ).toBe(true);
    expect(
      WorldEffect.safeParse({
        kind: "add_npc_fact",
        npcId: "sela-the-innkeeper",
        fact: "helped broker the reckoning",
      }).success,
    ).toBe(true);
  });

  // Same reason shift_faction_relation's delta is checked: FACTION_BANDS[3.5]
  // is undefined, so a fractional delta would find no band at all.
  it("refuses a fractional shift_npc_affinity delta", () => {
    expect(
      WorldEffect.safeParse({ kind: "shift_npc_affinity", npcId: "sela-the-innkeeper", delta: 0.5 })
        .success,
    ).toBe(false);
  });

  it("refuses an empty add_npc_fact fact string", () => {
    expect(
      WorldEffect.safeParse({ kind: "add_npc_fact", npcId: "sela-the-innkeeper", fact: "" })
        .success,
    ).toBe(false);
  });
```

Then add a new describe block at the end of the file for the entry type itself:

```ts
describe("NpcAffinityEntry", () => {
  it("defaults facts to an empty array", () => {
    const parsed = NpcAffinityEntry.parse({ npcId: "sela-the-innkeeper", band: "cordial" });
    expect(parsed.facts).toEqual([]);
  });

  it("accepts declared facts", () => {
    const parsed = NpcAffinityEntry.parse({
      npcId: "sela-the-innkeeper",
      band: "cordial",
      facts: ["helped broker the reckoning"],
    });
    expect(parsed.facts).toEqual(["helped broker the reckoning"]);
  });

  it("rejects an unrecognised band", () => {
    expect(
      NpcAffinityEntry.safeParse({ npcId: "sela-the-innkeeper", band: "smitten" }).success,
    ).toBe(false);
  });
});
```

In `packages/schemas/src/events.test.ts`, add `NpcAffinityEntry` to the existing `WorldDeltaAppliedPayload` import (check the file's import block at the top for the exact existing import line before editing), replace the `"accepts an empty world_delta_applied payload, defaulting relations to []"` test, and add one more test right after it:

```ts
  it("accepts an empty world_delta_applied payload, defaulting relations and npcAffinities to []", () => {
    expect(WorldDeltaAppliedPayload.parse({})).toEqual({ relations: [], npcAffinities: [] });
  });

  it("accepts a world_delta_applied payload with npcAffinities", () => {
    const parsed = WorldDeltaAppliedPayload.parse({
      npcAffinities: [
        { npcId: "sela-the-innkeeper", band: "cordial", facts: ["helped broker the reckoning"] },
      ],
    });
    expect(parsed.npcAffinities).toEqual([
      { npcId: "sela-the-innkeeper", band: "cordial", facts: ["helped broker the reckoning"] },
    ]);
  });
```

In `packages/schemas/src/protocol.test.ts`, the `"round-trips a populated SceneSnapshot"` test (in `describe("WorldState.scene")`) currently asserts `toStrictEqual` against the exact input object — once `SceneSnapshot` gains a `.default([])` field, the parsed output gains a key the raw input literal does not have, and `toStrictEqual` will fail unless both sides declare it. Update the `scene` object in that test:

```ts
  it("round-trips a populated SceneSnapshot", () => {
    const scene = {
      worldId: "riverbend",
      currentNodeId: "goblin-camp",
      completedNodeIds: ["find-the-trail"],
      relations: [{ factionA: "town-guard", factionB: "goblin-warband", band: "hostile" }],
      npcAffinities: [],
      day: 3,
    };
    const parsed = WorldState.parse({ ...legacy, scene });
    expect(parsed.scene).toStrictEqual(scene);
  });
```

And the `"builds the starting scene from a full genesis quartet"` test in `describe("sceneFromGenesis")`:

```ts
  it("builds the starting scene from a full genesis quartet", () => {
    const scene = sceneFromGenesis({
      rootSeed: 1,
      worldId: "riverbend",
      startingNodeId: "find-the-trail",
      startingDay: 1,
      characterId: "hero",
    });
    expect(scene).toStrictEqual({
      worldId: "riverbend",
      currentNodeId: "find-the-trail",
      completedNodeIds: [],
      relations: [],
      npcAffinities: [],
      day: 1,
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `NpcAffinityEntry` does not exist, `shift_npc_affinity`/`add_npc_fact` are not valid `WorldEffect` kinds, and the two updated round-trip assertions get back an object with no `npcAffinities` key.

- [ ] **Step 3: Add `NpcAffinityEntry` and the two new `WorldEffect` members**

In `packages/schemas/src/content.ts`, insert immediately after `FactionRelationEntry`'s definition (currently at lines 163–167):

```ts
/**
 * An NPC's standing with the player and what the campaign remembers about
 * them — the projection step 7 names as its consumer (`npcId` -> band +
 * facts). `facts` is English and internal-only: never shown to the player
 * verbatim (spec Decision 5).
 */
export const NpcAffinityEntry = z.object({
  npcId: ContentId,
  band: FactionBand,
  facts: z.array(z.string()).default([]),
});
```

Add its type export beside `FactionRelationEntry`'s, near the bottom of the file:

```ts
export type NpcAffinityEntry = z.infer<typeof NpcAffinityEntry>;
```

Replace `WorldEffect`'s definition (currently lines 114–123) with:

```ts
export const WorldEffect = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shift_faction_relation"),
    factionA: ContentId,
    factionB: ContentId,
    /** Bands, not points. Clamping to the -3..+3 ends is the step 3 engine's job. */
    delta: z.number().int().min(-6).max(6),
  }),
  z.object({ kind: z.literal("advance_calendar"), days: z.number().int().min(1) }),
  z.object({
    kind: z.literal("shift_npc_affinity"),
    npcId: ContentId,
    /** Same bound as shift_faction_relation's delta, reusing FactionBand. */
    delta: z.number().int().min(-6).max(6),
  }),
  z.object({
    kind: z.literal("add_npc_fact"),
    npcId: ContentId,
    /** English, internal-only — never shown to the player verbatim (spec Decision 5). */
    fact: z.string().min(1),
  }),
]);
```

- [ ] **Step 4: Widen `WorldDeltaAppliedPayload`**

In `packages/schemas/src/events.ts`, add `NpcAffinityEntry` to the existing `./content.js` import (currently `ContentId, FactionRelationEntry`):

```ts
import { ContentId, FactionRelationEntry, NpcAffinityEntry } from "./content.js";
```

Replace `WorldDeltaAppliedPayload`'s definition:

```ts
/**
 * Payload for `world_delta_applied`. All three fields carry the engine's
 * already-computed, already-clamped RESULT, never a delta to compute (Decision
 * 4 of the combat-bridge spec, extended by Decision 6 of the character-
 * profiles spec) — `reduce` only merges what is here onto `scene`.
 */
export const WorldDeltaAppliedPayload = z.object({
  /** Absolute resulting bands, post-clamp — the fold merges, never computes. */
  relations: z.array(FactionRelationEntry).default([]),
  /** The new absolute day, when the calendar moved. */
  day: z.number().int().min(1).optional(),
  /** Absolute resulting affinity, post-clamp, whole entries. Same contract as `relations`. */
  npcAffinities: z.array(NpcAffinityEntry).default([]),
});
export type WorldDeltaAppliedPayload = z.infer<typeof WorldDeltaAppliedPayload>;
```

- [ ] **Step 5: Widen `SceneSnapshot` and `sceneFromGenesis`**

In `packages/schemas/src/protocol.ts`, add `NpcAffinityEntry` to the existing `./content.js` import (currently `ContentId, FactionRelationEntry`):

```ts
import { ContentId, FactionRelationEntry, NpcAffinityEntry } from "./content.js";
```

Replace `SceneSnapshot`'s definition:

```ts
export const SceneSnapshot = z.object({
  worldId: ContentId,
  currentNodeId: ContentId,
  completedNodeIds: z.array(ContentId),
  /** Overlay: ONLY pairs a completed node has shifted (absolute bands).
   *  Read through `relationBetween`'s authored baseline, never alone. */
  relations: z.array(FactionRelationEntry),
  /** Deltas-only overlay: ONLY NPCs an authored effect has actually touched.
   *  Read through `affinityOf`, never alone — absent means neutral, no
   *  facts. Unlike `relations` there is no authored baseline behind this:
   *  a single hardcoded default covers every NPC nobody has touched yet. */
  npcAffinities: z.array(NpcAffinityEntry).default([]),
  day: z.number().int().min(1),
});
```

In `sceneFromGenesis`, add the field to the returned object:

```ts
  return {
    worldId,
    currentNodeId: startingNodeId,
    completedNodeIds: [],
    relations: [],
    npcAffinities: [],
    day: startingDay,
  };
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: PASS. Watch for any other `@ai-dm/schemas` test asserting a full `SceneSnapshot`-shaped object with `toStrictEqual`/`toEqual` against a literal missing `npcAffinities` — `reduce.test.ts`'s `baseScene` fixture is exactly that and is fixed in Task 2, which touches `reduce.ts` next; if `pnpm --filter @ai-dm/schemas test` fails elsewhere in this step with an unexpected extra `npcAffinities: []` key, note the failing file and fold that fix into Task 2's Step 1 rather than skipping ahead here.

- [ ] **Step 7: Typecheck**

```bash
corepack enable && pnpm --filter @ai-dm/schemas typecheck
```

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/schemas/src/content.ts packages/schemas/src/content.test.ts packages/schemas/src/events.ts packages/schemas/src/events.test.ts packages/schemas/src/protocol.ts packages/schemas/src/protocol.test.ts
git commit -m "feat(schemas): NpcAffinityEntry, shift_npc_affinity, add_npc_fact

New WorldEffect kinds reusing FactionBand, and the two payloads that will
carry them: SceneSnapshot.npcAffinities (deltas-only overlay, no authored
baseline) and WorldDeltaAppliedPayload.npcAffinities (the engine's already-
computed result). No fold or engine behavior yet. Spec Decisions 2 and 4."
```

---

### Task 2: `reduce` merges `npcAffinities` the same way it merges `relations`

**Files:**
- Modify: `packages/schemas/src/reduce.ts` (`world_delta_applied` case)
- Modify: `packages/schemas/src/reduce.test.ts` (`baseScene` fixture, new tests)

**Interfaces:**
- Consumes: `WorldDeltaAppliedPayload.npcAffinities`, `SceneSnapshot.npcAffinities` (Task 1).
- Produces: a `reduce` that projects `npcAffinities` from `world_delta_applied` onto `scene.npcAffinities`, upserting by `npcId`. Task 6's end-to-end test relies on this.

- [ ] **Step 1: Fix the fixture and write the failing tests**

`packages/schemas/src/reduce.test.ts`'s `baseScene` (lines 25–31) is a `SceneSnapshot`-typed literal and will fail to typecheck the moment Task 1 lands, since `npcAffinities` is now part of the inferred (output) type. Fix it first:

```ts
const baseScene: SceneSnapshot = {
  worldId: "riverbend",
  currentNodeId: "find-the-trail",
  completedNodeIds: [],
  relations: [{ factionA: "millers", factionB: "raiders", band: "neutral" }],
  npcAffinities: [],
  day: 1,
};
```

Then add these tests to the `describe` block that already covers `world_delta_applied` (the one containing the `"(c) replaces an existing relation entry..."` / `"(c) appends a relation entry..."` tests around lines 409–446):

```ts
  it("(d) appends an npcAffinities entry for an npc not already present", () => {
    const state = withScene({ npcAffinities: [] });
    const next = reduce(
      state,
      event(28, "world_delta_applied", {
        npcAffinities: [{ npcId: "sela-the-innkeeper", band: "cordial", facts: [] }],
      }),
    );
    expect(next.world.scene?.npcAffinities).toEqual([
      { npcId: "sela-the-innkeeper", band: "cordial", facts: [] },
    ]);
  });

  it("(d) replaces an existing npcAffinities entry for the same npcId", () => {
    const state = withScene({
      npcAffinities: [{ npcId: "sela-the-innkeeper", band: "neutral", facts: [] }],
    });
    const next = reduce(
      state,
      event(29, "world_delta_applied", {
        npcAffinities: [
          { npcId: "sela-the-innkeeper", band: "cordial", facts: ["helped broker the reckoning"] },
        ],
      }),
    );
    expect(next.world.scene?.npcAffinities).toEqual([
      { npcId: "sela-the-innkeeper", band: "cordial", facts: ["helped broker the reckoning"] },
    ]);
  });

  it("(d) leaves other npcAffinities entries untouched", () => {
    const state = withScene({
      npcAffinities: [
        { npcId: "old-tobin", band: "friendly", facts: [] },
        { npcId: "sela-the-innkeeper", band: "neutral", facts: [] },
      ],
    });
    const next = reduce(
      state,
      event(30, "world_delta_applied", {
        npcAffinities: [{ npcId: "sela-the-innkeeper", band: "cordial", facts: [] }],
      }),
    );
    expect(next.world.scene?.npcAffinities).toEqual([
      { npcId: "old-tobin", band: "friendly", facts: [] },
      { npcId: "sela-the-innkeeper", band: "cordial", facts: [] },
    ]);
  });

  it("(d) leaves npcAffinities untouched when the payload carries none", () => {
    const state = withScene({
      npcAffinities: [{ npcId: "old-tobin", band: "friendly", facts: [] }],
    });
    const next = reduce(state, event(31, "world_delta_applied", { relations: [] }));
    expect(next.world.scene?.npcAffinities).toEqual([
      { npcId: "old-tobin", band: "friendly", facts: [] },
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test reduce
```

Expected: FAIL — `npcAffinities` is parsed out of the payload but never merged, so `next.world.scene?.npcAffinities` stays whatever `state` already held.

- [ ] **Step 3: Merge `npcAffinities` in the fold**

Replace the `world_delta_applied` case (`packages/schemas/src/reduce.ts`, currently lines 245–265):

```ts
    // Merges the engine's already-computed, already-clamped results onto
    // `scene` — never computes one. `relations` replaces the entry for the
    // same unordered faction pair (checked both ways, as a plain two-field
    // comparison — no `pairKey`, which lives in `authored-world.ts` and stays
    // there per invariant 4) or appends a new pair; `npcAffinities` replaces
    // the whole entry for the same `npcId` or appends a new one — simpler
    // than the relations merge since there is no pair to check both ways;
    // `day`, when present, replaces `scene.day` outright. None of the three
    // present is a true no-op (character-profiles spec Decision 6).
    case "world_delta_applied": {
      const scene = sceneOrThrow(state, event);
      const { relations, day, npcAffinities } = WorldDeltaAppliedPayload.parse(event.payload);
      const nextRelations = relations.reduce((acc, entry) => {
        const index = acc.findIndex(
          (existing) =>
            (existing.factionA === entry.factionA && existing.factionB === entry.factionB) ||
            (existing.factionA === entry.factionB && existing.factionB === entry.factionA),
        );
        return index === -1
          ? [...acc, entry]
          : acc.map((existing, i) => (i === index ? entry : existing));
      }, scene.relations);
      const nextNpcAffinities = npcAffinities.reduce((acc, entry) => {
        const index = acc.findIndex((existing) => existing.npcId === entry.npcId);
        return index === -1
          ? [...acc, entry]
          : acc.map((existing, i) => (i === index ? entry : existing));
      }, scene.npcAffinities);
      return {
        ...state,
        world: {
          ...state.world,
          scene: {
            ...scene,
            relations: nextRelations,
            npcAffinities: nextNpcAffinities,
            day: day ?? scene.day,
          },
        },
      };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: PASS, whole package.

- [ ] **Step 5: Typecheck and lint**

```bash
corepack enable && pnpm --filter @ai-dm/schemas typecheck && npx eslint packages/schemas
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/reduce.ts packages/schemas/src/reduce.test.ts
git commit -m "feat(schemas): reduce merges npcAffinities from world_delta_applied

Upserts by npcId, the same absolute-result merge relations already gets.
Spec Decision 6."
```

---

### Task 3: The scene engine applies the two new effects

**Files:**
- Modify: `packages/rules-engine/src/scene/index.ts` (`SceneState`, `affinityOf`, `applyEffect`, `startScene`)
- Modify: `packages/rules-engine/src/scene/index.test.ts` (every existing `SceneState` literal, new tests)
- Modify: `packages/rules-engine/src/scene/snapshot.ts` (`sceneStateFrom`, `snapshotOf`, `diffScene`, `SceneDelta`)
- Modify: `packages/rules-engine/src/scene/snapshot.test.ts` (every existing `SceneState`/`SceneSnapshot` literal, new tests)

**Interfaces:**
- Consumes: `NpcAffinityEntry`, `shift_npc_affinity`, `add_npc_fact` (Task 1).
- Produces: `affinityOf(state, npcId)`, exported beside `relationBetween`. `SceneDelta.npcAffinities`. Task 5 reads `diffScene`'s widened return; Task 6's authored content is applied through `completeCurrentNode`, which this task extends.

Note before starting: `SceneState` is a plain TypeScript interface (not a zod schema), so adding a required field means every existing literal typed `SceneState` (or returned from a function declared to return one) needs updating in the same commit or the package stops typechecking. Step 1 below fixes all of them before writing new tests, so the package is green throughout.

- [ ] **Step 1: Add the field and fix every existing `SceneState` literal**

In `packages/rules-engine/src/scene/index.ts`, add to the `SceneState` interface (after `relations`):

```ts
  /** Keyed by bare npcId — no pairKey needed, this is not a pairwise relation. */
  readonly npcAffinities: ReadonlyMap<string, { readonly band: FactionBand; readonly facts: readonly string[] }>;
```

In the same file, `startScene`'s state literal (currently lines 269–274):

```ts
  const state: SceneState = {
    currentNodeId: world.startingNodeId,
    completedNodeIds: new Set<string>(),
    relations: world.relations,
    npcAffinities: new Map(),
    day: world.startingDay,
  };
```

In `packages/rules-engine/src/scene/index.test.ts`, five fresh `SceneState` literals need the same field added — locate each by its `currentNodeId` line and add `npcAffinities: new Map(),` immediately after `relations`:

1. `stateWith()` helper (currently lines 23–32):

```ts
function stateWith(
  relations: readonly (readonly [string, string, FactionBand])[],
): SceneState {
  return {
    currentNodeId: "start",
    completedNodeIds: new Set<string>(),
    relations: new Map(relations.map(([a, b, band]) => [pairKey(a, b), band])),
    npcAffinities: new Map(),
    day: 1,
  };
}
```

2. The `"no-ops a faction shift naming a pair the state does not hold"` test's `partial` (currently lines 260–265):

```ts
    const partial: SceneState = {
      currentNodeId: "solo",
      completedNodeIds: new Set<string>(),
      relations: new Map(),
      npcAffinities: new Map(),
      day: 1,
    };
```

3. The `"refuses to complete a node whose own preconditions are unmet"` test's `stranded` (currently lines 316–321):

```ts
    const stranded: SceneState = {
      currentNodeId: "middle",
      completedNodeIds: new Set<string>(),
      relations: world.relations,
      npcAffinities: new Map(),
      day: 1,
    };
```

4. The `describe("evaluatePredicate")` block's `state` (currently lines 389–394):

```ts
  const state: SceneState = {
    currentNodeId: "start",
    completedNodeIds: new Set<string>(),
    relations: new Map([[pairKey("alpha", "beta"), "hostile"]]),
    npcAffinities: new Map(),
    day: 1,
  };
```

5. `ghostState()` in `describe("acting from a state whose current node does not exist")` (currently lines 631–637):

```ts
  function ghostState(): SceneState {
    return {
      currentNodeId: "ghost",
      completedNodeIds: new Set<string>(),
      relations: new Map(),
      npcAffinities: new Map(),
      day: 1,
    };
  }
```

(`partial: SceneState = { ...state, relations: new Map() }` at line 417 spreads the fixed `state` from item 4, so it needs no separate edit.)

In `packages/rules-engine/src/scene/snapshot.test.ts`, the `"snapshotOf emits relations and completedNodeIds already sorted"` test's `state` (currently lines 90–98):

```ts
    const state: SceneState = {
      currentNodeId: "end",
      completedNodeIds: new Set(["zeta", "alpha"]),
      relations: new Map([
        [pairKey("zulu", "yankee"), "friendly"],
        [pairKey("alpha", "beta"), "cold"],
      ]),
      npcAffinities: new Map(),
      day: 2,
    };
```

Run the package's tests now, before writing anything new, to confirm this step alone restores a green baseline:

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine typecheck && pnpm --filter @ai-dm/rules-engine test
```

Expected: PASS. This step changes no behavior — every literal above sets `npcAffinities` to an empty map, which is what every one of these states implicitly had before the field existed.

- [ ] **Step 2: Write the failing tests for `affinityOf` and the two new `applyEffect` cases**

`applyEffect` is deliberately unexported (spec Decision 2 preserves this), so — matching how the file already tests `shift_faction_relation`'s two edge cases through `completeCurrentNode` with a hand-built world rather than calling `applyEffect` directly — add these to `packages/rules-engine/src/scene/index.test.ts`.

First, extend `describe("relationBetween", ...)`'s neighbor with a new block right after it (after line 102, before the `stateOf` helper):

```ts
describe("affinityOf", () => {
  it("defaults to neutral with no facts for an npc the state has not touched", () => {
    const state = stateWith([]);
    expect(affinityOf(state, "sela-the-innkeeper")).toEqual({ band: "neutral", facts: [] });
  });

  it("reads the overlay for a touched npc", () => {
    const state: SceneState = {
      ...stateWith([]),
      npcAffinities: new Map([["sela-the-innkeeper", { band: "cordial", facts: ["a fact"] }]]),
    };
    expect(affinityOf(state, "sela-the-innkeeper")).toEqual({
      band: "cordial",
      facts: ["a fact"],
    });
  });
});
```

Then add this block inside (or right after) `describe("completeCurrentNode", ...)`, following the existing `"no-ops a faction shift..."` / `"shifts from the authored band..."` pattern of a hand-built one-node world:

```ts
  it("shifts an npc's affinity on node completion", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node whose effect shifts an npc's affinity.",
            locationId: "here",
            preconditions: [],
            effects: [{ kind: "shift_npc_affinity", npcId: "sela-the-innkeeper", delta: 1 }],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const after = stateOf(completeCurrentNode(world, before));
    expect(affinityOf(after, "sela-the-innkeeper")).toEqual({ band: "cordial", facts: [] });
  });

  it("records a fact on node completion, without touching the band", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node whose effect records a fact.",
            locationId: "here",
            preconditions: [],
            effects: [
              { kind: "add_npc_fact", npcId: "sela-the-innkeeper", fact: "helped at the reckoning" },
            ],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const after = stateOf(completeCurrentNode(world, before));
    expect(affinityOf(after, "sela-the-innkeeper")).toEqual({
      band: "neutral",
      facts: ["helped at the reckoning"],
    });
  });

  it("appends a second fact rather than replacing the first", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node with two fact-recording effects.",
            locationId: "here",
            preconditions: [],
            effects: [
              { kind: "add_npc_fact", npcId: "sela-the-innkeeper", fact: "first fact" },
              { kind: "add_npc_fact", npcId: "sela-the-innkeeper", fact: "second fact" },
            ],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const after = stateOf(completeCurrentNode(world, before));
    expect(affinityOf(after, "sela-the-innkeeper").facts).toEqual(["first fact", "second fact"]);
  });

  it("is idempotent for npc effects too — a re-completed node does not double-shift", () => {
    const world: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "solo",
      questNodes: new Map([
        [
          "solo",
          {
            nodeId: "solo",
            titleEnglish: "Solo",
            sceneEnglish: "A node whose effect shifts an npc's affinity.",
            locationId: "here",
            preconditions: [],
            effects: [{ kind: "shift_npc_affinity", npcId: "sela-the-innkeeper", delta: 1 }],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(world));
    const once = stateOf(completeCurrentNode(world, before));
    const twice = stateOf(completeCurrentNode(world, once));
    expect(affinityOf(twice, "sela-the-innkeeper")).toEqual(affinityOf(once, "sela-the-innkeeper"));
  });
```

Add `affinityOf` to the file's existing `./index.js` import list alongside `relationBetween`.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine test scene
```

Expected: FAIL — `affinityOf` does not exist, and `WorldEffect.array().parse`/`QuestNode.parse` (used internally by `completeCurrentNode`'s callers) reject `shift_npc_affinity`/`add_npc_fact` only once Task 1 exists (it does, from Task 1) but `applyEffect`'s switch has no case for them yet, so TypeScript's exhaustiveness check fails to compile `index.ts` itself once the two new members exist — expect a compile error here, not just failing assertions, until Step 4 lands.

- [ ] **Step 4: Add `affinityOf` and the two `applyEffect` cases**

In `packages/rules-engine/src/scene/index.ts`, add this export right after `relationBetween` (after its closing brace, currently ending at line 88):

```ts
/**
 * An NPC's standing and remembered facts, read from the overlay with a
 * hardcoded default for any NPC nobody has interacted with yet. Unlike
 * `relationBetween`, there is no authored baseline to fall back to second —
 * a single sensible default covers every NPC, so declaring one per NPC in
 * `content.ts` would be authoring surface with no consumer (character-
 * profiles spec Decision 5).
 */
export function affinityOf(
  state: SceneState,
  npcId: string,
): { band: FactionBand; facts: readonly string[] } {
  return state.npcAffinities.get(npcId) ?? { band: "neutral", facts: [] };
}
```

Replace `applyEffect`'s switch (currently lines 227–243):

```ts
  switch (effect.kind) {
    case "shift_faction_relation": {
      const current = relationBetween(world, state, effect.factionA, effect.factionB);
      // Still a no-op when neither the state nor the authored world declares
      // the pair, rather than an invention: `loadWorld` refuses an effect
      // naming an unknown faction, so reaching this means a hand-built world,
      // and inventing `neutral` here would put a relation in the map that no
      // author declared.
      if (current === undefined) return state;
      const key = pairKey(effect.factionA, effect.factionB);
      const relations = new Map(state.relations);
      relations.set(key, shiftBand(current, effect.delta));
      return { ...state, relations };
    }
    case "advance_calendar":
      return { ...state, day: state.day + effect.days };
    case "shift_npc_affinity": {
      // No "unknown pair" bail-out like the faction case: `affinityOf`'s
      // fallback always resolves, since a single hardcoded default (neutral,
      // no facts) covers every npc rather than an authored baseline to
      // consult (character-profiles spec Decision 4).
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
  }
```

- [ ] **Step 5: Extend `sceneStateFrom`, `snapshotOf`, and `diffScene`**

In `packages/rules-engine/src/scene/snapshot.ts`, add `NpcAffinityEntry` to the existing `@ai-dm/schemas` type import (currently `ContentId, FactionRelationEntry, SceneSnapshot`).

`sceneStateFrom` (currently lines 22–31) — add after the `relations` line:

```ts
export function sceneStateFrom(snapshot: SceneSnapshot): SceneState {
  return {
    currentNodeId: snapshot.currentNodeId,
    completedNodeIds: new Set(snapshot.completedNodeIds),
    relations: new Map(
      snapshot.relations.map((entry) => [pairKey(entry.factionA, entry.factionB), entry.band]),
    ),
    npcAffinities: new Map(snapshot.npcAffinities.map((entry) => [entry.npcId, entry])),
    day: snapshot.day,
  };
}
```

`snapshotOf` — add, after wherever its `relations` array is built (read the function's current body before editing; it ends by constructing and returning the `SceneSnapshot` object):

```ts
  const npcAffinities: NpcAffinityEntry[] = Array.from(
    state.npcAffinities,
    ([npcId, { band, facts }]) => ({ npcId, band, facts: [...facts] }),
  ).sort((a, b) => a.npcId.localeCompare(b.npcId));
```

and add `npcAffinities` to the returned `SceneSnapshot` object literal, sorted the same way `relations` and `completedNodeIds` already are.

`SceneDelta` (currently lines 57–60):

```ts
export interface SceneDelta {
  relations: FactionRelationEntry[];
  npcAffinities: NpcAffinityEntry[];
  day?: number;
}
```

`diffScene` (currently lines 68–79):

```ts
export function diffScene(before: SceneState, after: SceneState): SceneDelta {
  const relations: FactionRelationEntry[] = [];
  for (const [key, band] of after.relations) {
    if (before.relations.get(key) !== band) {
      const [factionA, factionB] = splitPairKey(key);
      relations.push({ factionA, factionB, band });
    }
  }
  const npcAffinities: NpcAffinityEntry[] = [];
  for (const [npcId, entry] of after.npcAffinities) {
    const beforeEntry = before.npcAffinities.get(npcId);
    const changed =
      beforeEntry === undefined ||
      beforeEntry.band !== entry.band ||
      beforeEntry.facts.length !== entry.facts.length ||
      beforeEntry.facts.some((fact, i) => fact !== entry.facts[i]);
    if (changed) npcAffinities.push({ npcId, band: entry.band, facts: [...entry.facts] });
  }
  const delta: SceneDelta = { relations, npcAffinities };
  if (after.day !== before.day) delta.day = after.day;
  return delta;
}
```

- [ ] **Step 6: Fix `diffScene`'s existing exact-equality tests**

`packages/rules-engine/src/scene/snapshot.test.ts`'s `describe("diffScene", ...)` block has two `toEqual` assertions against the whole `SceneDelta` object that will now fail, since `npcAffinities: []` is always present:

```ts
  it("reports no change for identical states, with no day", () => {
    const state = stateOf(startScene(world));
    const delta = diffScene(state, state);
    expect(delta).toEqual({ relations: [], npcAffinities: [] });
    expect(delta.day).toBeUndefined();
  });
```

```ts
  it("sets day when only the calendar advances, with no relation change", () => {
    const afterMiddle = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    const before = stateOf(traverseEdge(world, afterMiddle, "end")); // day 3, alpha/beta=cold
    // "end" has only advance_calendar; completing it shifts no relation.
    const after = stateOf(completeCurrentNode(world, before)); // day 4
    expect(diffScene(before, after)).toEqual({ relations: [], npcAffinities: [], day: 4 });
  });
```

Also fix the four `SceneSnapshot`-typed literals that need `npcAffinities: []` (`round trip` describe block, lines 44–50, 61–70, 77–83) and the `sceneStateFrom` describe block's literal (lines 120–126) — each currently ends with `day: <n>,` and needs `npcAffinities: [],` added right before it. For example, the first (`"preserves an empty overlay"`):

```ts
    const snapshot: SceneSnapshot = {
      worldId: "fixture",
      currentNodeId: "start",
      completedNodeIds: [],
      relations: [],
      npcAffinities: [],
      day: 1,
    };
```

Apply the same one-line addition to the other three `SceneSnapshot` literals in this file.

Then add a new round-trip test proving the new field actually round-trips, matching `"preserves a multi-pair overlay"`'s shape:

```ts
  it("preserves a populated npcAffinities overlay", () => {
    const snapshot: SceneSnapshot = {
      worldId: "fixture",
      currentNodeId: "middle",
      completedNodeIds: ["start"],
      relations: [],
      npcAffinities: [
        { npcId: "old-tobin", band: "friendly", facts: ["remembered fact"] },
        { npcId: "sela-the-innkeeper", band: "cordial", facts: [] },
      ],
      day: 3,
    };
    expect(sorted(snapshotOf(sceneStateFrom(snapshot), snapshot.worldId))).toEqual(
      sorted(snapshot),
    );
  });
```

`sorted()` (the file's local helper, lines 16–24) only sorts `completedNodeIds` and `relations` — since `snapshotOf` already emits `npcAffinities` pre-sorted by `npcId` (Step 5), the test above needs its input's `npcAffinities` written in that same sorted order for `toEqual` to hold; `old-tobin` before `sela-the-innkeeper` already is.

Also add a `diffScene` test for the npc case, in the `describe("diffScene", ...)` block:

```ts
  it("reports a shifted npc affinity alongside an unrelated relation change", () => {
    const npcWorld = {
      ...world,
      npcs: new Map([
        [
          "sela-the-innkeeper",
          {
            npcId: "sela-the-innkeeper",
            nameEnglish: "Sela",
            nameHebrew: "סלה",
            grammaticalGender: "feminine" as const,
            locationId: "here",
            descriptionEnglish: "A fixture npc.",
          },
        ],
      ]),
      questNodes: new Map([
        ...world.questNodes,
        [
          "npc-node",
          {
            nodeId: "npc-node",
            titleEnglish: "Npc node",
            sceneEnglish: "A fixture node that shifts an npc's affinity.",
            locationId: "here",
            preconditions: [],
            effects: [{ kind: "shift_npc_affinity" as const, npcId: "sela-the-innkeeper", delta: 1 }],
            edges: [],
          },
        ],
      ]),
    };
    const before = stateOf(startScene(npcWorld));
    const traversed = stateOf(traverseEdge(npcWorld, before, "npc-node"));
    const after = stateOf(completeCurrentNode(npcWorld, traversed));
    const delta = diffScene(before, after);
    expect(delta.npcAffinities).toEqual([{ npcId: "sela-the-innkeeper", band: "cordial", facts: [] }]);
  });
```

Before writing this test, check `linearWorld()`'s `"start"` node in `test-fixtures.ts` for its existing `edges` — if `"start"` has no edge to a node named `"npc-node"`, either add one to `npcWorld.questNodes.get("start")` in this test's local `npcWorld` object (via a spread-and-override of the `"start"` entry, not by mutating the shared fixture) or traverse from `"middle"`/`"end"` instead. Adjust node names in the test to whichever existing node actually has a free edge, since `traverseEdge` requires a real declared edge.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine test
```

Expected: PASS.

- [ ] **Step 8: Typecheck, lint, and check coverage**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine typecheck && npx eslint packages/rules-engine
corepack enable && pnpm --filter @ai-dm/rules-engine test:coverage
```

Expected: typecheck and lint exit 0; coverage stays ≥90% lines for the package (the Global Constraints bar). If `applyEffect`'s two new branches show as uncovered, the tests in Step 2 are missing a case — every branch (`shift_npc_affinity`, `add_npc_fact`, the append-not-replace fact case, the idempotency case) already has one above; re-check names match exactly.

- [ ] **Step 9: Commit**

```bash
git add packages/rules-engine/src/scene/index.ts packages/rules-engine/src/scene/index.test.ts packages/rules-engine/src/scene/snapshot.ts packages/rules-engine/src/scene/snapshot.test.ts
git commit -m "feat(rules-engine): apply shift_npc_affinity and add_npc_fact

affinityOf() mirrors relationBetween() with a hardcoded neutral/no-facts
fallback instead of an authored baseline. sceneStateFrom/snapshotOf/diffScene
extended in parallel with their existing relations handling. Spec Decisions
2 and 4."
```

---

### Task 4: The loader cross-references `npcId` in the two new effects

**Files:**
- Modify: `apps/server/src/world/index.ts` (`ContentKind`, `collections`, `effectRefs`)
- Modify: `data/world/fixtures/broken-references/arc.json`
- Modify: `apps/server/src/world/index.test.ts` (`it.each` list, the exact-count test)

**Interfaces:**
- Consumes: `shift_npc_affinity`, `add_npc_fact` (Task 1).
- Produces: `loadWorld` refusing a `shift_npc_affinity`/`add_npc_fact` effect naming an unknown `npcId`. No other task depends on this one.

- [ ] **Step 1: Write the failing tests**

In `data/world/fixtures/broken-references/arc.json`, the `start` node's `effects` array currently holds two `shift_faction_relation` entries naming `no-such-faction` and a self-pair. Add a third entry naming an unknown npc:

```json
    {
      "kind": "shift_npc_affinity",
      "npcId": "no-such-npc",
      "delta": 1
    }
```

In `apps/server/src/world/index.test.ts`, add one entry to the `it.each` array in `describe("loadWorld refusing broken content")` (the list currently ending `'quest node start references unknown encounter "no-such-encounter"'`):

```ts
    'quest node start effect references unknown npc "no-such-npc"',
```

Add the same string to the exact-count `Set` in `describe("loadWorld refusing faction relations")`'s `"reports exactly these eighteen problems and no others"` test, and update its comment from "eighteen" to "nineteen" (the list there is a duplicate enumeration of the same problems for a stronger single assertion — both need the same new line).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/server test world
```

Expected: FAIL — the loader reports no problem for the unknown npc, so the new `it.each` case finds nothing and the exact-count `Set` comparison fails on a missing member.

- [ ] **Step 3: Add `"npc"` as a referenceable content kind**

In `apps/server/src/world/index.ts`, widen `ContentKind` (currently line 88):

```ts
type ContentKind = "faction" | "location" | "npc" | "quest node";
```

Add `npc: npcs` to the `collections` record literal (currently lines 175–179, right after `location: locations,`):

```ts
  const collections: Record<ContentKind, ReadonlyMap<string, unknown>> = {
    faction: factions,
    location: locations,
    npc: npcs,
    "quest node": questNodes,
  };
```

`npcs` is already in scope at this point in the function (indexed at line 172 for `NpcDefinition`'s own checks), so this is the only line needed here.

- [ ] **Step 4: Cross-reference `npcId` in `effectRefs`**

Replace `effectRefs` (currently lines 132–142):

```ts
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
    case "shift_npc_affinity":
      return [{ kind: "npc", id: effect.npcId }];
    case "add_npc_fact":
      return [{ kind: "npc", id: effect.npcId }];
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test world
```

Expected: PASS, including `"accepts the real authored world"` — the shipped `data/world/` content declares no `shift_npc_affinity`/`add_npc_fact` effect yet (Task 6 adds one), so this check has nothing to trip on until then.

- [ ] **Step 6: Run the whole server suite, typecheck, and lint**

```bash
corepack enable && pnpm --filter @ai-dm/server test
corepack enable && pnpm --filter @ai-dm/server typecheck && npx eslint apps/server
```

Expected: all PASS / exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/world/index.ts apps/server/src/world/index.test.ts data/world/fixtures/broken-references/arc.json
git commit -m "feat(server): loader cross-references npcId in the two new effects

ContentKind gains \"npc\"; effectRefs refuses a shift_npc_affinity or
add_npc_fact naming an unknown npc, the same way a bad factionId already
fails at load. Spec Decision 7."
```

---

### Task 5: The pipeline's `world_delta_applied` gate includes `npcAffinities`

**Files:**
- Modify: `apps/server/src/core/pipeline.ts` (both `diffScene` call sites)

**Interfaces:**
- Consumes: `SceneDelta.npcAffinities` (Task 3).
- Produces: a `world_delta_applied` event whenever a node's effects touch either relations, day, or npc affinity — never only for the first two. Task 6's end-to-end test depends on this.

This task has no new test of its own — Task 6's end-to-end test is what proves it, since both call sites already have full coverage for the relations/day gate, and this task is a mechanical widening of that same gate. Verifying it compiles and the existing suite stays green is the right-sized check here; skipping straight to Task 6 without this change would make Task 6's test fail with a missing `world_delta_applied` event, so the ordering still enforces TDD at the task level.

- [ ] **Step 1: Widen the combat-bridge victory branch's gate**

In `apps/server/src/core/pipeline.ts`, the resolution block built from `diffScene(before, transition.state)` (currently around lines 1112–1121):

```ts
      const delta = diffScene(before, transition.state);
      if (delta.relations.length > 0 || delta.npcAffinities.length > 0 || delta.day !== undefined) {
        events.push({
          type: "world_delta_applied",
          payload: {
            relations: delta.relations,
            npcAffinities: delta.npcAffinities,
            ...(delta.day === undefined ? {} : { day: delta.day }),
          },
        });
      }
```

- [ ] **Step 2: Widen the exploration branch's gate**

In the same file, the exploration branch's equivalent block (currently around lines 1423–1435):

```ts
            const delta = diffScene(before, transition.state);
            const sceneEvents: { type: GameEvent["type"]; payload: Record<string, unknown> }[] = [
              { type: "quest_node_completed", payload: { nodeId: before.currentNodeId } },
            ];
            if (
              delta.relations.length > 0 ||
              delta.npcAffinities.length > 0 ||
              delta.day !== undefined
            ) {
              sceneEvents.push({
                type: "world_delta_applied",
                payload: {
                  relations: delta.relations,
                  npcAffinities: delta.npcAffinities,
                  ...(delta.day === undefined ? {} : { day: delta.day }),
                },
              });
            }
```

Read the surrounding function before editing — confirm the exact current line range and variable names (`delta`, `sceneEvents`, `events`) match what is already there in each of the two call sites; they were last touched by the combat bridge (step 5) and a whole-branch review's exact wording may have shifted the line numbers slightly since `220985c`.

- [ ] **Step 3: Run the whole server suite, typecheck, and lint**

```bash
corepack enable && pnpm --filter @ai-dm/server test
corepack enable && pnpm --filter @ai-dm/server typecheck && npx eslint apps/server
```

Expected: PASS / exit 0 — no existing test asserts an *absence* of `npcAffinities` in a `world_delta_applied` payload, so widening the gate changes nothing observable until an effect actually populates it, which Task 6 adds.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/core/pipeline.ts
git commit -m "feat(server): world_delta_applied also gates on npcAffinities

Both diffScene call sites (combat-bridge victory branch, exploration
branch) now emit the event when only npc affinity changed, not only for a
relation or day change. Spec Decision 6."
```

---

### Task 6: `reckoning` gains the two new effects, and an end-to-end walk proves the projection

**Files:**
- Modify: `data/world/arc.json` (`reckoning`'s `effects`)
- Modify: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing further — this is the exit-criterion test.

- [ ] **Step 1: Write the failing end-to-end test**

Add this test to `apps/server/src/core/pipeline.test.ts`, in or near the `describe` block containing the existing `reckoning`-completion tests (around line 1011's `"completes a terminal node with no traversal..."`). It reuses `sceneCampaign`, `portsWith`, `classifiedAs`, `drain`, `eventTypesOf`, and `createInMemoryEventStore`, all already imported in the file, plus `loadCampaign` for the reload-parity check (confirm it is already imported at the top of this file — if not, add it to the existing `../core/campaign.js` import; `loadCampaign` is exported from `apps/server/src/core/campaign.ts` per Task 3 of the combat-bridge plan).

```ts
  it("shifts an npc's affinity and records a fact when reckoning completes, and a reload folds identically", async () => {
    const store = createInMemoryEventStore();
    const before: SceneSnapshot = {
      worldId: "emberfall",
      currentNodeId: "reckoning",
      completedNodeIds: ["arrival", "guild-offer", "the-weir"],
      relations: [{ factionA: "ashen-guild", factionB: "river-wardens", band: "hostile" }],
      npcAffinities: [],
      day: 1,
    };
    const campaign = await sceneCampaign(store, before);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: null }),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "let's settle this" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toEqual([
      "player_input",
      "intent_classified",
      "quest_node_completed",
      "world_delta_applied",
      "narrative_emitted",
    ]);
    expect(campaign.state.world.scene?.npcAffinities).toEqual([
      {
        npcId: "sela-the-innkeeper",
        band: "cordial",
        facts: ["hosted and helped broker the reckoning between the Guild and the Wardens"],
      },
    ]);

    const reloaded = await loadCampaign({ campaignId: campaign.state.world.campaignId, store });
    expect(reloaded?.state.world.scene?.npcAffinities).toEqual(
      campaign.state.world.scene?.npcAffinities,
    );
  });
```

Check `loadCampaign`'s exact parameter shape and `campaign.state.world.campaignId` field name against `apps/server/src/core/campaign.test.ts` or `pipeline.test.ts`'s existing usages before finalizing — the combat-bridge plan's Task 3 used `loadCampaign({ campaignId, store })`, but confirm no drift since `220985c`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test pipeline
```

Expected: FAIL — `campaign.state.world.scene?.npcAffinities` is `[]`, since `reckoning`'s authored effects don't touch it yet.

- [ ] **Step 3: Add the two effects to `reckoning`**

In `data/world/arc.json`, `reckoning`'s `effects` array currently reads:

```json
  "effects": [
    {
      "kind": "shift_faction_relation",
      "factionA": "ashen-guild",
      "factionB": "river-wardens",
      "delta": 2
    },
    {
      "kind": "advance_calendar",
      "days": 2
    }
  ]
```

Replace it with:

```json
  "effects": [
    {
      "kind": "shift_faction_relation",
      "factionA": "ashen-guild",
      "factionB": "river-wardens",
      "delta": 2
    },
    {
      "kind": "advance_calendar",
      "days": 2
    },
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
  ]
```

`sela-the-innkeeper` is unaligned with either faction (`data/world/npcs.json` gives her no `factionId`), so her affinity moving reads as personal rather than a restatement of the faction shift on the same node (spec Decision 8). No other file changes: this is additive to an existing node's `effects` array, not a new node, edge, or arc-length change.

- [ ] **Step 4: Run the test to verify it passes**

```bash
corepack enable && pnpm --filter @ai-dm/server test pipeline
```

Expected: PASS.

- [ ] **Step 5: Run the whole suite, both without and with Postgres**

```bash
corepack enable && pnpm test 2>&1 | grep -E "Tests +[0-9]"
```

Expected: 1576 passed / 30 skipped / 104 files — one more than the 1575/30/104 baseline (this task's one new test; every other task added tests too, so the real total will be higher than 1576 — the point of this check is that nothing regresses, not that this exact number is hit. Compare against the actual total from a `pnpm test` run on `220985c` before this plan's first commit, not the number quoted here).

```bash
corepack enable && DATABASE_URL=postgres://localhost:5432/aidm_step5_scratch pnpm test 2>&1 | grep -E "Tests +[0-9]"
```

Expected: 0 skipped, same relative increase over the 1605/0/104 baseline.

```bash
corepack enable && pnpm typecheck && npx eslint packages apps tools
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add data/world/arc.json apps/server/src/core/pipeline.test.ts
git commit -m "feat(world): reckoning shifts Sela's affinity and records a fact

Proves the projection end to end: the authored effect fires on node
completion, campaign.state.world.scene.npcAffinities reflects it, and a
reload from the event log folds to the identical result. Spec Decision 8,
and this step's exit criterion."
```
