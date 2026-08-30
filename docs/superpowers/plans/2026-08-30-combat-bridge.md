# Combat Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a scene campaign enter combat at an authored quest node, play the fight through the existing tactical loop, and return to narration with the node completed and its effects applied.

**Architecture:** A `QuestNode` declares an encounter by bare id. Entering that node appends `encounter_started` — now carrying the full initial board — into the same `emitAll` group as the scene events, so `reduce` folds a bracket with no catalogue substitution. After each turn batch a detector reads `conclusionOf` (moved into `@ai-dm/schemas` so the server and `apps/web` share one victory rule) plus a `maxRounds` terminator, and emits the resolution group. Combat-only campaigns are untouched: the detector is silent when the campaign has no scene to return to.

**Tech Stack:** TypeScript 5 strict, ESM, zod, Vitest, Fastify, React, drizzle-orm/Postgres.

**Spec:** [`docs/superpowers/specs/2026-08-30-combat-bridge-design.md`](../specs/2026-08-30-combat-bridge-design.md)

## Global Constraints

- `corepack enable` before any `pnpm` command — pnpm is not otherwise on PATH.
- Node 22, ESM only. Every relative import ends in `.js`, including type-only imports.
- TypeScript strict; ESLint `strictTypeChecked`; Prettier at 100 columns.
- **Never run `pnpm format`** — there is no `.prettierignore` and `--write .` rewrites ~37 files including the lockfile. **Never run root `pnpm lint`** — it walks sibling worktrees. Lint with `npx eslint packages apps tools`.
- Tests are colocated `*.test.ts` / `*.test.tsx`, run with Vitest.
- Dependency direction: `schemas ← rules-engine ← agents ← server`; `web` depends only on `@ai-dm/schemas`; nothing depends on `server`.
- **English inside, Hebrew outside.** All code, comments, prompts, payloads and log fields are English. The only sanctioned Hebrew event fields are `narrative_emitted.text` and `player_input.text`; this plan adds no third.
- No `default` branch in any switch over a discriminated union — exhaustiveness must fail the build.
- `packages/rules-engine` line coverage stays ≥ 90%.
- **Do not touch `packages/memory/CLAUDE.md`** — it carries someone else's uncommitted edit.
- Baseline to preserve or beat, measured at `499841a`: `pnpm test` → 1550 passed / 30 skipped / 104 files. `DATABASE_URL=postgres://localhost:5432/aidm_step5_scratch pnpm test` → 1580 passed / 0 skipped / 104 files. `pnpm typecheck` → exit 0. `npx eslint packages apps tools` → exit 0.
- The scratch database `aidm_step5_scratch` already exists on the local brew Postgres 18 with its drizzle migration applied. **Never point tests at `aidm`.**

---

### Task 1: Move `conclusionOf` into `@ai-dm/schemas`

One definition of the victory rule, importable by both the server and `apps/web`. Nothing else changes behaviour in this task.

**Files:**
- Create: `packages/schemas/src/conclusion.ts`
- Create: `packages/schemas/src/conclusion.test.ts`
- Modify: `packages/schemas/src/index.ts`
- Delete: `apps/web/src/state/conclusion.ts`, `apps/web/src/state/conclusion.test.ts`
- Modify: `apps/web/src/App.tsx:23`

**Interfaces:**
- Consumes: nothing.
- Produces: `conclusionOf(snapshot: EncounterState): Conclusion` and `type Conclusion = "ongoing" | "victory" | "defeat"`, both exported from `@ai-dm/schemas`. Tasks 6 and 7 import them from there.

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/conclusion.test.ts`. The `rawCombatant` helper mirrors the one already in `reduce.test.ts` — `apps/web`'s `combatant-fixture.ts` stays where it is, still used by three other web test files, and cannot be imported here anyway (`schemas` may not depend on `web`).

```ts
import { describe, expect, it } from "vitest";
import { conclusionOf } from "./conclusion.js";
import { Combatant } from "./world.js";
import type { EncounterState } from "./protocol.js";

function rawCombatant(
  overrides: Record<string, unknown> & { combatantId: string },
): Record<string, unknown> {
  return {
    faction: "hostile",
    position: [0, 0],
    size: "medium",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 10,
    currentHp: 10,
    tempHp: 0,
    armorClass: 12,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementUsedFeet: 0,
      attacksMade: 0,
    },
    status: "alive",
    ...overrides,
  };
}

function stateWith(raw: Record<string, unknown>[]): EncounterState {
  const combatants = Combatant.array().parse(raw);
  return {
    encounterId: "goblin-ambush",
    grid: { width: 1, height: 1, tiles: [["normal"]] },
    combatants,
    turnOrder: combatants.map((each) => each.combatantId),
    currentActorIndex: 0,
    round: 1,
  };
}

describe("conclusionOf", () => {
  it("is ongoing while both factions have someone alive", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party" }),
          rawCombatant({ combatantId: "goblin", faction: "hostile" }),
        ]),
      ),
    ).toBe("ongoing");
  });

  it("is victory when only the party is left standing", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party" }),
          rawCombatant({ combatantId: "goblin", faction: "hostile", status: "dead", currentHp: 0 }),
        ]),
      ),
    ).toBe("victory");
  });

  it("is defeat when only hostiles are left standing", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party", status: "dead", currentHp: 0 }),
          rawCombatant({ combatantId: "goblin", faction: "hostile" }),
        ]),
      ),
    ).toBe("defeat");
  });

  it("is defeat when nobody is left standing on a board that had combatants", () => {
    expect(
      conclusionOf(
        stateWith([
          rawCombatant({ combatantId: "hero", faction: "party", status: "dead", currentHp: 0 }),
          rawCombatant({ combatantId: "goblin", faction: "hostile", status: "dead", currentHp: 0 }),
        ]),
      ),
    ).toBe("defeat");
  });

  it("is ongoing on an empty board — not started, not finished", () => {
    expect(conclusionOf(stateWith([]))).toBe("ongoing");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test conclusion
```

Expected: FAIL — `Failed to resolve import "./conclusion.js"`.

- [ ] **Step 3: Create the implementation**

Create `packages/schemas/src/conclusion.ts` — the function body is moved verbatim from `apps/web/src/state/conclusion.ts`, with the header adapted to say why it lives in this package.

```ts
// Is the fight over, and who won — read from the projection, never from a
// frame. There IS no terminal frame while a fight is running: `runEnemyTurns`
// (`apps/server/src/core/pipeline.ts`) simply stops emitting once one faction
// is left standing, so a UI that waited for a victory frame would hang
// forever. The server's own end-of-combat detector reads this function at the
// end of each turn batch and emits `encounter_resolved` from what it says.
//
// It lives in `@ai-dm/schemas` for the reason `reduce` does: `apps/web` may
// import this package and only this package (invariant 5), so a projection
// read that BOTH halves need has nowhere else to go, and two copies of the
// victory rule is exactly what invariant 4 exists to forbid. It qualifies for
// that narrow exception where a rules function would not — it reads `status`
// and `faction` off a projection, rolls nothing, and consults no DC and no
// SRD table, so invariant 1's rules authority is untouched.
//
// The party is expected to LOSE: `diesAtZeroHp` is pinned true
// unconditionally, so a PC dies at 0 HP rather than falling Unconscious —
// death saves are implemented but not driven by the encounter pipeline
// (RULES_REFERENCE.md §8's gap). Defeat is a normal ending here, not an error
// state.
import type { EncounterState } from "./protocol.js";

export type Conclusion = "ongoing" | "victory" | "defeat";

export function conclusionOf(snapshot: EncounterState): Conclusion {
  const living = snapshot.combatants.filter((each) => each.status === "alive");
  const factions = new Set(living.map((each) => each.faction));
  if (factions.size > 1) return "ongoing";
  // An empty board is an encounter that has not started, not a finished
  // fight. A campaign not in one at all has no board to ask about — its
  // caller holds `encounter === null` and never reaches here.
  if (living.length === 0) return snapshot.combatants.length === 0 ? "ongoing" : "defeat";
  return factions.has("party") ? "victory" : "defeat";
}
```

Add the export to `packages/schemas/src/index.ts`, after the `reduce.js` line:

```ts
export * from "./conclusion.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test conclusion
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Point `apps/web` at the moved function and delete its copy**

```bash
rm apps/web/src/state/conclusion.ts apps/web/src/state/conclusion.test.ts
```

In `apps/web/src/App.tsx`, delete line 23 (`import { conclusionOf } from "./state/conclusion.js";`) and add `conclusionOf` to the existing `@ai-dm/schemas` import in the same file. Find that import with:

```bash
grep -n 'from "@ai-dm/schemas"' apps/web/src/App.tsx
```

- [ ] **Step 6: Verify the whole suite and the toolchain**

```bash
corepack enable && pnpm test 2>&1 | grep -E "Tests +[0-9]"
```

Expected: the same totals as the baseline — 1550 passed / 30 skipped. `apps/web` drops the moved tests and `packages/schemas` gains them; the sum is unchanged.

```bash
corepack enable && pnpm typecheck && npx eslint packages apps tools
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src/conclusion.ts packages/schemas/src/conclusion.test.ts packages/schemas/src/index.ts apps/web/src/App.tsx
git add -A apps/web/src/state
git commit -m "refactor(schemas): move conclusionOf into @ai-dm/schemas

One definition of the victory rule, importable by the server as well as
apps/web. Spec Decision 3."
```

---

### Task 2: `encounter_started` carries the board and `reduce` folds it

The fold gap closes here. The payload grows three optional board fields; when they are present `reduce` fills the bracket outright, and when they are absent it keeps today's guard-only behaviour so persisted logs still fold.

**Files:**
- Modify: `packages/schemas/src/events.ts:70`
- Modify: `packages/schemas/src/reduce.ts` (file header, and the `encounter_started` case)
- Modify: `packages/schemas/src/reduce.test.ts`
- Modify: `packages/schemas/src/events.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `EncounterStartedPayload` with the shape `{encounterId: string, grid?: GridMap, combatants?: Combatant[], turnOrder?: string[]}`. Task 3 builds it; Tasks 5 and 8 rely on `reduce` projecting a bracket from it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/schemas/src/reduce.test.ts`. `rawCombatant` and `base` already exist in that file; `noEncounterOpen` below is a local addition.

```ts
describe("reduce — encounter_started with a board", () => {
  const noEncounterOpen: CampaignState = {
    world: { ...base.world, scene: null },
    encounter: null,
  };

  const boardPayload = {
    encounterId: "goblin-ambush",
    grid: { width: 2, height: 1, tiles: [["normal", "normal"]] },
    combatants: [
      rawCombatant({ combatantId: "hero", faction: "party", position: [0, 0] }),
      rawCombatant({ combatantId: "goblin", faction: "hostile", position: [1, 0] }),
    ],
    turnOrder: ["hero", "goblin"],
  };

  function startedEvent(payload: Record<string, unknown>): GameEvent {
    return {
      eventId: "e-start",
      campaignId: "s1",
      sequence: 3,
      timestamp: "2026-08-30T00:00:00.000Z",
      type: "encounter_started",
      payload,
    };
  }

  it("projects the whole bracket without a catalogue", () => {
    const next = reduce(noEncounterOpen, startedEvent(boardPayload));
    expect(next.encounter).toEqual({
      encounterId: "goblin-ambush",
      grid: boardPayload.grid,
      combatants: Combatant.array().parse(boardPayload.combatants),
      turnOrder: ["hero", "goblin"],
      currentActorIndex: 0,
      round: 1,
    });
  });

  it("leaves the bracket unfilled for a legacy payload with no board", () => {
    const next = reduce(noEncounterOpen, startedEvent({ encounterId: "goblin-ambush" }));
    expect(next.encounter).toBeNull();
  });

  it("still refuses a second open bracket", () => {
    expect(() => reduce(base, startedEvent(boardPayload))).toThrow(/already open/);
  });

  it("folds combat events that follow it, with no substitution step", () => {
    const opened = reduce(noEncounterOpen, startedEvent(boardPayload));
    const advanced = reduce(opened, {
      eventId: "e-turn",
      campaignId: "s1",
      sequence: 4,
      timestamp: "2026-08-30T00:00:01.000Z",
      type: "scene_changed",
      payload: { kind: "turn_advanced" },
    });
    expect(advanced.encounter?.currentActorIndex).toBe(1);
  });
});
```

Add to `packages/schemas/src/events.test.ts`:

```ts
describe("EncounterStartedPayload", () => {
  it("accepts a legacy payload carrying only encounterId", () => {
    const parsed = EncounterStartedPayload.parse({ encounterId: "goblin-ambush" });
    expect(parsed.grid).toBeUndefined();
    expect(parsed.combatants).toBeUndefined();
    expect(parsed.turnOrder).toBeUndefined();
  });

  it("refuses a half-declared board", () => {
    expect(() =>
      EncounterStartedPayload.parse({
        encounterId: "goblin-ambush",
        grid: { width: 1, height: 1, tiles: [["normal"]] },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — the board test gets `encounter: null` back, and `EncounterStartedPayload.parse` accepts the half-declared board instead of throwing.

- [ ] **Step 3: Grow the payload**

In `packages/schemas/src/events.ts`, replace line 70's one-liner. `GridMap` and `Combatant` are already exported from `./world.js`; add them to that file's existing import if they are not already imported.

```ts
/**
 * `encounter_started` carries the whole initial board, not just a name, so
 * `reduce` can project a bracket with no catalogue substitution — the fold
 * gap `reduce.ts`'s header used to document (spec Decision 2).
 *
 * The three board fields are optional as a group, and only as a group: a
 * persisted pre-step-5 payload has none of them and must still parse and
 * fold (append-only compatibility), while a payload with some but not all is
 * a corrupt producer, not a legacy one. That is the same all-or-nothing
 * `.refine` shape `CampaignStartedPayload`'s genesis quartet uses.
 *
 * Stat blocks are deliberately absent, for the reason `EncounterState` omits
 * them: they are static per encounter and re-derived server-side from ids. So
 * is `maxRounds` — only the server enforces it, and `builtOf` already reaches
 * it.
 */
export const EncounterStartedPayload = z
  .object({
    encounterId: z.string(),
    grid: GridMap.optional(),
    combatants: z.array(Combatant).optional(),
    turnOrder: z.array(z.string()).optional(),
  })
  .refine(
    (payload) => {
      const present = [payload.grid, payload.combatants, payload.turnOrder].filter(
        (each) => each !== undefined,
      ).length;
      return present === 0 || present === 3;
    },
    { message: "encounter_started must declare all three board fields or none of them" },
  );
export type EncounterStartedPayload = z.infer<typeof EncounterStartedPayload>;
```

- [ ] **Step 4: Fill the bracket in `reduce`**

In `packages/schemas/src/reduce.ts`, replace the `encounter_started` case's body and its doc comment:

```ts
    // Opens the bracket AND fills it. The payload carries the whole initial
    // board (spec Decision 2), so this is a complete fold with no catalogue
    // substitution — `apps/server/src/core/campaign.ts` no longer patches a
    // board in behind this branch for a log written from §4.7 step 5 onward.
    //
    // `currentActorIndex: 0` and `round: 1` are derived here rather than
    // carried: they are the same two constants `initialEncounterState` always
    // derived, and a payload that could disagree with them would be a second
    // way to express one fact.
    //
    // A legacy payload — one persisted before step 5, carrying no board —
    // still returns `state` unchanged, exactly as this branch always did.
    // `loadCampaign` keeps its `buildEncounterById` substitution for that
    // case alone, so an old campaign stays loadable.
    case "encounter_started": {
      const { encounterId, grid, combatants, turnOrder } = EncounterStartedPayload.parse(
        event.payload,
      );
      if (state.encounter !== null) {
        throw new Error(
          `encounter_started at sequence ${String(event.sequence)} names encounter ` +
            `${encounterId}, but encounter ${state.encounter.encounterId} is already open`,
        );
      }
      if (grid === undefined || combatants === undefined || turnOrder === undefined) {
        return state;
      }
      return {
        ...state,
        encounter: { encounterId, grid, combatants, turnOrder, currentActorIndex: 0, round: 1 },
      };
    }
```

- [ ] **Step 5: Rewrite the file header**

`packages/schemas/src/reduce.ts` opens with roughly forty lines describing the fold gap as a live defect. That description is now false. Replace lines 1–45 (everything from `// The projection.` down to and including the paragraph ending `before step 5 can safely ship.`) with:

```ts
// The projection. State is a fold of the event log and nothing else
// (invariant 3), so this function is the only place a `CampaignState` changes
// shape — and it is pure, total and never mutates its input.
//
// It lives in `@ai-dm/schemas` so that `apps/web` — which may depend on this
// package and only this package (invariant 5) — has a fold to run at all.
//
// `fold` alone projects a whole campaign log, brackets included. That was not
// true between §4.7 steps 1 and 5: `encounter_started` named an encounter and
// nothing more, so only `apps/server/src/core/campaign.ts`'s `loadCampaign`
// could rebuild a board out of the encounter catalogue, and a client folding
// that event onto `encounter: null` got `state` back unchanged with no error
// — a silent gap, not a throw. Step 5 closed it by putting the initial board
// in the payload (see the `encounter_started` case below), which is the same
// rule genesis already followed: an event names what it declares, completely,
// and the fold reads it without consulting anything else.
//
// One residue remains, and it is bounded: a payload persisted BEFORE step 5
// carries no board, and this function cannot invent one. `loadCampaign` keeps
// a catalogue substitution reached only for those. No client can be affected
// by it — the only logs lacking a board are combat-only campaigns, and
// `POST /campaigns`'s `encounterId` branch still awaits `startEncounter`
// before returning a `campaignId`, so their client always joins after
// `encounter_started` and can never receive it as a live frame.
//
// Nothing here may import a Node built-in, or `apps/web`'s bundle breaks — and
// nothing here may import `@ai-dm/rules-engine`, which would invert the
// dependency direction. The fresh action economy below is
// `ActionEconomy.parse({})` for that second reason; the engine's `startTurn()`
// is defined as the same expression, so there is one definition, not two.
//
// `GameEvent.payload` is `z.record(z.string(), z.unknown())` on the wire, so
// every payload this cares about is parsed here rather than cast. An event
// whose payload does not parse is a bug in whoever wrote it, and throwing is
// better than folding a half-understood event into state.
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: PASS. `packages/schemas` gains 6 tests over Task 1's total.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src/events.ts packages/schemas/src/reduce.ts packages/schemas/src/reduce.test.ts packages/schemas/src/events.test.ts
git commit -m "feat(schemas): encounter_started carries the board, reduce folds a bracket

Closes the fold gap reduce.ts documented. Board fields are optional as a
group so persisted pre-step-5 payloads still fold. Spec Decision 2."
```

---

### Task 3: `startEncounter` writes the board; `loadCampaign` keeps a legacy fallback

**Files:**
- Modify: `apps/server/src/core/campaign.ts` (`initialEncounterState` doc, `startEncounter`, `loadCampaign`'s `encounter_started` branch, `createCampaign`'s doc comment)
- Modify: `apps/server/src/core/campaign.test.ts`

**Interfaces:**
- Consumes: `EncounterStartedPayload` from Task 2.
- Produces: `startEncounter` unchanged in signature; after it, `campaign.state.encounter` comes from the fold rather than from a substitution. Task 5 emits the same payload shape from the pipeline.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/core/campaign.test.ts`:

```ts
describe("startEncounter — the board travels in the payload", () => {
  it("writes grid, combatants and turnOrder into encounter_started", async () => {
    const store = new InMemoryEventStore();
    const campaign = await createCampaign({
      campaignId: "c-board",
      rootSeed: 1,
      store,
      clock: () => "2026-08-30T00:00:00.000Z",
      uuid: () => "u1",
    });
    await startEncounter({
      campaign,
      encounterId: "goblin-ambush",
      store,
      clock: () => "2026-08-30T00:00:01.000Z",
      uuid: () => "u2",
    });

    const events = await store.read("c-board");
    const started = events.find((each) => each.type === "encounter_started");
    const payload = EncounterStartedPayload.parse(started?.payload);
    expect(payload.turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
    expect(payload.combatants).toHaveLength(3);
    expect(payload.grid?.width).toBe(12);
  });

  it("projects the same board on a cold load, with no substitution needed", async () => {
    const store = new InMemoryEventStore();
    const campaign = await createCampaign({
      campaignId: "c-parity",
      rootSeed: 1,
      store,
      clock: () => "2026-08-30T00:00:00.000Z",
      uuid: () => "u1",
    });
    await startEncounter({
      campaign,
      encounterId: "goblin-ambush",
      store,
      clock: () => "2026-08-30T00:00:01.000Z",
      uuid: () => "u2",
    });

    const reloaded = await loadCampaign({ campaignId: "c-parity", store });
    expect(reloaded?.state.encounter).toEqual(campaign.state.encounter);
  });
});
```

The cold-load assertion goes through the real projector, which is the property that matters. Match `InMemoryEventStore`/`createInMemoryEventStore` and the `store.read`/`readSince` names to whatever `apps/server/src/core/campaign.test.ts` already imports — do not introduce a second store helper.

- [ ] **Step 2: Run the test to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test campaign
```

Expected: FAIL — `payload.turnOrder` is `undefined`, because `startEncounter` still writes `{encounterId}` only.

- [ ] **Step 3: Write the board into the payload**

In `apps/server/src/core/campaign.ts`'s `startEncounter`, replace the `payload:` line:

```ts
    payload: EncounterStartedPayload.parse({
      encounterId: input.encounterId,
      grid: built.world.grid,
      combatants: built.world.combatants,
      turnOrder: built.turnOrder,
    }),
```

Then replace the substitution that follows the fold. The old three lines were:

```ts
  const guarded = reduce(campaign.state, event);
  await input.store.append(campaignId, [event]);

  campaign.state = { ...guarded, encounter: initialEncounterState(built) };
```

Replace with:

```ts
  // `reduce` now both guards the non-overlap invariant AND fills the bracket
  // from the payload written above (spec Decision 2), so there is no
  // substitution step left here — the fold's own answer is used as-is, the
  // way `resolveEncounter`'s already is.
  const next = reduce(campaign.state, event);
  await input.store.append(campaignId, [event]);

  campaign.state = next;
```

- [ ] **Step 4: Keep `loadCampaign`'s substitution as a legacy-only fallback**

Find `loadCampaign`'s `encounter_started` branch (near `campaign.ts:331-350`) and make the substitution conditional. It must run only when the fold could not fill the bracket:

```ts
      if (event.type === "encounter_started") {
        state = reduce(state, event);
        // Step 5 and later logs carry the board and `reduce` has already
        // filled the bracket. Only a payload persisted BEFORE step 5 leaves
        // it null here, and that one still needs the catalogue — which is
        // why this call, and the O(encounters) cold-load I/O it causes,
        // survives for old logs and disappears for new ones.
        if (state.encounter === null) {
          const legacy = buildEncounterById(EncounterStartedPayload.parse(event.payload).encounterId);
          state = { ...state, encounter: initialEncounterState(legacy) };
          built = legacy;
        } else {
          built = buildEncounterById(state.encounter.encounterId);
        }
        continue;
      }
```

Read the existing branch before editing — the surrounding variable names (`state`, `built`) must match what is already there, and the `built` assignment is what `builtOf` later reads. `built` is still derived from the catalogue in both arms: the payload carries the board, not the stat blocks, and combat needs stat blocks.

- [ ] **Step 5: Update `initialEncounterState`'s doc comment**

Its comment claims `reduce` "cannot do this itself" and that both callers substitute. Replace the second paragraph with:

```ts
 * `reduce` fills this from `encounter_started`'s payload itself since §4.7
 * step 5 (spec Decision 2). What remains here is the legacy path: a payload
 * persisted before that step names an encounter and carries no board, so
 * `loadCampaign` rebuilds one through the catalogue for those logs alone.
```

- [ ] **Step 6: Correct `createCampaign`'s doc comment**

It currently reads "`encounter_started` follows the same rule with `encounterId` — a bracket event names a thing and never snapshots it." Replace that sentence with:

```ts
 * `encounter_started` is the one deliberate exception, taken in §4.7 step 5:
 * it carries its initial board. That is not mutable state leaking into the
 * log — it is a deterministic starting condition, the same class of thing
 * this payload's own `startingNodeId` records, and for the same replay
 * reason: editing an encounter's spawns in the catalogue must not
 * retroactively move where an existing campaign's fight began. Evolving
 * combatant state still travels only in `state_delta_applied`.
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test
```

Expected: PASS, including every pre-existing campaign, pipeline, replay and e2e test.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/core/campaign.ts apps/server/src/core/campaign.test.ts
git commit -m "feat(server): startEncounter writes the board; substitution becomes legacy-only

loadCampaign keeps buildEncounterById for pre-step-5 payloads that carry no
board, and stops calling it for every fight in a modern log. Spec Decision 2."
```

---

### Task 4: `QuestNode.encounterId`, the loader cross-check, and the sixth node

**Files:**
- Modify: `packages/schemas/src/content.ts:132-186`
- Modify: `packages/schemas/src/content.test.ts`
- Modify: `apps/server/src/encounters/index.ts`
- Modify: `apps/server/src/world/index.ts`
- Modify: `apps/server/src/world/index.test.ts`
- Modify: `data/world/arc.json`
- Modify: `packages/schemas/src/world-content.test.ts:31-39`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `QuestNode.encounterId?: string`, and `hasEncounter(encounterId: string): boolean` exported from `apps/server/src/encounters/index.ts`. Task 5 reads `node.encounterId`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/schemas/src/content.test.ts`:

```ts
it("accepts a node that declares an encounter, and one that does not", () => {
  const withFight = QuestNode.parse({ ...base, encounterId: "goblin-ambush" });
  expect(withFight.encounterId).toBe("goblin-ambush");
  expect(QuestNode.parse(base).encounterId).toBeUndefined();
});
```

The loader tests use one shared on-disk fixture whose every outbound reference is wrong (`data/world/fixtures/broken-references/`), asserted through an `it.each` list of expected problem strings. Extend both rather than adding a new fixture directory.

In `data/world/fixtures/broken-references/arc.json`, add one field to the single `start` node, after `"locationId"`:

```json
    "encounterId": "no-such-encounter",
```

In `apps/server/src/world/index.test.ts`, add one entry to the `it.each` array in `describe("loadWorld refusing broken content")` (the list currently ending `"quest node start effect alpha/alpha relates a faction to itself"`):

```ts
    'quest node start references unknown encounter "no-such-encounter"',
```

This is safe against the surrounding tests: they all assert with `toContain` or `not.toContain` on specific strings, and none counts the problems. The "accepts the real authored world" test at the top of that describe is what proves the new check does not false-positive on `data/world/` — and after Task 4's Step 6 the real arc has a node with a *valid* `encounterId`, so that test starts covering the passing case too.

Update the count pin in `packages/schemas/src/world-content.test.ts`. Replace the comment at lines 31–33 and the node assertion at line 39:

```ts
  // than `toBeGreaterThan`. §4.7 sizes this world at one town, two factions
  // and three NPCs; the arc was five nodes until §4.7 step 5 added the one
  // that declares an encounter, which is the whole point of the combat
  // bridge — moved deliberately, not drifted past.
```

```ts
    expect(QuestNode.array().parse(readJson("arc.json"))).toHaveLength(6);
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test && pnpm --filter @ai-dm/server test world
```

Expected: FAIL — `encounterId` is not a `QuestNode` field, the loader reports no such problem, and the arc still has five nodes.

- [ ] **Step 3: Add the schema field**

In `packages/schemas/src/content.ts`, inside the `QuestNode` object, after `effects`:

```ts
  /**
   * Entering this node opens a bracket on the named catalogue encounter, and
   * the node completes on victory (§4.7 step 5). A bare id and nothing else:
   * spawns, map, positions and turn order are already `EncounterDefinition`
   * fields, so a parameterization layer here would be an override mechanism
   * for a catalogue of one, with no second caller to shape it.
   *
   * Nothing in `@ai-dm/schemas` can check that this id resolves — the
   * encounter catalogue lives in `apps/server` and this package may never
   * import it (invariant 5). `loadWorld` does the cross-reference, where both
   * catalogues are in scope.
   */
  encounterId: ContentId.optional(),
```

- [ ] **Step 4: Export a catalogue membership check**

In `apps/server/src/encounters/index.ts`, beside `encounterById`:

```ts
/**
 * Whether the catalogue knows this id, without building the encounter or
 * throwing. `loadWorld` needs the question answered for every node in a world
 * file, and `buildEncounterById` would be both far more expensive and the
 * wrong shape — a dangling reference is a problem to collect, not an
 * exception to catch.
 */
export function hasEncounter(encounterId: string): boolean {
  return CATALOGUE.has(encounterId);
}
```

- [ ] **Step 5: Cross-reference it in the loader**

In `apps/server/src/world/index.ts`, add the import:

```ts
import { hasEncounter } from "../encounters/index.js";
```

This direction is acyclic: `encounters/` imports from `@ai-dm/rules-engine` and `@ai-dm/schemas` and never from `world/`.

In the `for (const node of questNodes.values())` loop, after the `locationId` check:

```ts
    // Not routed through `checkRef`: `collections` indexes the three
    // collections THIS directory's files define, and the encounter catalogue
    // is neither loaded from `dir` nor one of them. The message shape matches
    // `checkRef`'s so an author reading `problems` sees one vocabulary.
    if (node.encounterId !== undefined && !hasEncounter(node.encounterId)) {
      problems.push(`${where} references unknown encounter "${node.encounterId}"`);
    }
```

- [ ] **Step 6: Author the sixth node**

In `data/world/arc.json`, insert this object between `the-weir` and `reckoning`:

```json
  {
    "nodeId": "saboteurs",
    "titleEnglish": "Caught at the Gate",
    "sceneEnglish": "You are still crouched over the forced gate mechanism when the scree above you shifts. They have been waiting for whoever came back to look twice, and they are not from Emberfall at all — which is the second answer nobody in town has offered you.",
    "locationId": "emberfall",
    "encounterId": "goblin-ambush",
    "preconditions": [{ "kind": "node_completed", "nodeId": "the-weir" }],
    "edges": [{ "to": "reckoning", "labelEnglish": "Bring what you found to the inn" }]
  },
```

And change `the-weir`'s edge so the arc runs through it:

```json
    "edges": [{ "to": "saboteurs", "labelEnglish": "Search the forced gate mechanism" }]
```

`reckoning` is untouched: it stays terminal (`edges: []`) and its `node_completed: the-weir` precondition still holds on the played path, since `the-weir` completes when the player leaves it for `saboteurs`.

Checked against the terminal-node gate (`pipeline.ts:1263-1281`): `saboteurs` has one outbound edge, so it is structurally non-terminal and a `targetNodeId: null` there is refused exactly as `guild-offer`'s is. No node in the arc has all its edges behind permanently-unmet predicates.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
corepack enable && pnpm test 2>&1 | grep -E "Tests +[0-9]"
```

Expected: PASS everywhere. Any test that walks the arc to `reckoning` now passes through `saboteurs`; if one breaks, it is asserting a path shape and needs its expected node sequence updated, not the arc reverted.

- [ ] **Step 8: Commit**

```bash
git add packages/schemas/src/content.ts packages/schemas/src/content.test.ts packages/schemas/src/world-content.test.ts apps/server/src/encounters/index.ts apps/server/src/world/index.ts apps/server/src/world/index.test.ts data/world/arc.json
git commit -m "feat(world): a quest node can declare an encounter

Bare encounterId on QuestNode, cross-referenced by loadWorld against the
catalogue, plus the sixth Emberfall node that declares one. The pinned node
count moves 5 -> 6 deliberately. Spec Decisions 1 and 8."
```

---

### Task 5: Opening the bracket from the exploration branch

**Files:**
- Modify: `apps/server/src/core/pipeline.ts` (imports, the `exploration` case's `sceneEvents` group)
- Modify: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `QuestNode.encounterId` (Task 4), the enriched `EncounterStartedPayload` (Task 2).
- Produces: a campaign whose `state.encounter` is non-null after entering an encounter node, with `campaign.built` set. Task 6's detector runs against it.

- [ ] **Step 1: Write the failing test**

Add this block to `apps/server/src/core/pipeline.test.ts`. Every helper it uses already exists in that file: `sceneCampaign` (line 205), `portsWith` (130), `classifiedAs` (229), `scriptedSceneNarrative` (253), `drain` (150), `eventTypesOf` (309), and `createInMemoryEventStore`.

`the-weir` is the node whose edge Task 4 repoints at `saboteurs`. Starting there with `arrival` already completed matters: `traverseEdge` completes the source node *before* checking the target's preconditions (`scene/index.ts:341-342`), so `saboteurs`'s `node_completed: the-weir` gate is satisfied by the very traversal that enters it.

```ts
describe("handleCommand — free text: the combat bridge", () => {
  const atTheWeir = {
    currentNodeId: "the-weir",
    completedNodeIds: ["arrival"],
    relations: [],
    day: 1,
  };

  it("opens a bracket when the entered node declares an encounter", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store, atTheWeir);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: "saboteurs" }),
      sceneNarrative: scriptedSceneNarrative([]),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "search the forced gate" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).toContain("encounter_started");
    expect(campaign.state.world.scene?.currentNodeId).toBe("saboteurs");
    expect(campaign.state.encounter?.encounterId).toBe("goblin-ambush");
    expect(campaign.state.encounter?.turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
    expect(campaign.state.encounter?.round).toBe(1);
    // `emitAll` never touches `built`; the bridge must set it alongside the
    // bracket or `builtOf` throws at the first tactical turn.
    expect(campaign.built?.encounterId).toBe("goblin-ambush");
  });

  it("appends the entry group and the bracket together, in one store append", async () => {
    const inner = createInMemoryEventStore();
    const appendSizes: number[] = [];
    const store: EventStore = {
      ...inner,
      append(campaignId, events) {
        appendSizes.push(events.length);
        return inner.append(campaignId, events);
      },
    };
    const campaign = await sceneCampaign(store, atTheWeir);
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: "saboteurs" }),
      sceneNarrative: scriptedSceneNarrative([]),
    };

    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "search the forced gate" },
        ports,
      ),
    );

    // `quest_node_completed` + `quest_node_entered` + `encounter_started` land
    // as one group. `player_input` and `intent_classified` precede them as
    // their own single-event appends, exactly as they already do — so the
    // group of three is what proves the bracket did not get an append of its
    // own.
    expect(appendSizes).toContain(3);
  });

  it("does not open a bracket for a node that declares no encounter", async () => {
    const store = createInMemoryEventStore();
    const campaign = await sceneCampaign(store, {
      currentNodeId: "arrival",
      completedNodeIds: [],
      relations: [],
      day: 1,
    });
    const ports: TurnPorts = {
      ...portsWith(store),
      intent: classifiedAs({ category: "exploration", targetNodeId: "guild-offer" }),
      sceneNarrative: scriptedSceneNarrative([]),
    };

    const frames = await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "c1", text: "hear out the factor" },
        ports,
      ),
    );

    expect(eventTypesOf(frames)).not.toContain("encounter_started");
    expect(campaign.state.encounter).toBeNull();
    expect(campaign.built).toBeNull();
  });
});
```

If `EventStore` is a class rather than a plain object type, the spread-and-override wrapper above will not typecheck — build the counting store with the same idiom `pipeline.test.ts` already uses for its failing-store tests instead. Check with `grep -n "EventStoreUnavailableError\|append(" apps/server/src/core/pipeline.test.ts | head`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test pipeline
```

Expected: FAIL — no `encounter_started` frame; `campaign.state.encounter` is null.

- [ ] **Step 3: Append the bracket to the entry group**

In `apps/server/src/core/pipeline.ts`, add to the imports from `../encounters/index.js`:

```ts
import { buildEncounterById } from "../encounters/index.js";
```

(If that module is already imported in this file, add `buildEncounterById` to the existing clause rather than writing a second import.)

In the `exploration` case, immediately after the `if (targetNodeId !== null)` block that pushes `quest_node_entered` and before `yield* emitAll(sceneEvents)`:

```ts
            // The bridge (spec Decision 1). Entering a node that declares an
            // encounter opens a bracket, and it joins THIS group rather than
            // taking an `emit` of its own: it is part of the same engine
            // transition, and splitting it off would reopen exactly the
            // window `emitAll` exists to close — a durable
            // `quest_node_entered` whose fight never started, on a node the
            // scene engine's `completed()` short-circuit can never re-enter.
            //
            // Read off the node actually entered, which for a traversal is
            // the target and for a `completeCurrentNode` is the node already
            // current — the same node `sceneNarrate` below narrates.
            const enteredNodeId = targetNodeId ?? before.currentNodeId;
            const enteredNode = statics.authored.questNodes.get(enteredNodeId);
            const bridged =
              enteredNode?.encounterId === undefined
                ? null
                : buildEncounterById(enteredNode.encounterId);
            if (bridged !== null) {
              sceneEvents.push({
                type: "encounter_started",
                payload: {
                  encounterId: bridged.encounterId,
                  grid: bridged.world.grid,
                  combatants: bridged.world.combatants,
                  turnOrder: bridged.turnOrder,
                },
              });
            }

            yield* emitAll(sceneEvents);

            // `emitAll` moves `campaign.state` but never `built` — the
            // fourth-writer hazard `Campaign.built`'s doc comment names. Set
            // it here, in the same place the bracket was opened, so
            // `builtOf`'s guard has nothing to catch.
            if (bridged !== null) campaign.built = bridged;
```

Delete the bare `yield* emitAll(sceneEvents);` that previously stood at this point — the block above replaces it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test
```

Expected: PASS. The `free_text` narration that follows is unchanged — it narrates arrival at the node, and `playerAffordances()` now finds a board and pushes combat affordances, which is the handoff into the tactical loop.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/pipeline.ts apps/server/src/core/pipeline.test.ts
git commit -m "feat(server): entering an encounter node opens the bracket

encounter_started joins the scene entry group in one emitAll append, and
campaign.built is set alongside it. Spec Decision 1."
```

---

### Task 6: The end-of-combat detector and the resolution group

**Files:**
- Modify: `apps/server/src/core/pipeline.ts` (imports, `runEnemyTurns`, a new `resolveIfConcluded` helper, the `structured_action` case)
- Modify: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `conclusionOf` / `Conclusion` from `@ai-dm/schemas` (Task 1); a bracket opened by Task 5.
- Produces: `encounter_resolved` in play, and a campaign back in its scene with the node completed. Task 8 asserts the whole walk.

- [ ] **Step 1: Write the failing tests**

Add this block to `apps/server/src/core/pipeline.test.ts`. It reuses `sceneCampaign`, `portsWith`, `classifiedAs`, `scriptedSceneNarrative`, `drain`, `eventTypesOf`, `defaultTactical`, `agentProposing`, `dodge` and `freshCampaign`, all already in the file.

The board is posed directly rather than fought out over twenty turns: `defaultTactical` only ever dodges, so no stub can kill anything by accident, and each outcome is one specific board plus one legal `dodge`. That keeps each test pinned to the detector rather than to twenty turns of dice.

```ts
describe("handleCommand — end of combat", () => {
  /** A campaign standing in `saboteurs` with its bracket open. */
  async function bridgedCampaign(store: EventStore): Promise<Campaign> {
    const campaign = await sceneCampaign(store, {
      currentNodeId: "the-weir",
      completedNodeIds: ["arrival"],
      relations: [],
      day: 1,
    });
    await drain(
      handleCommand(
        campaign,
        { type: "free_text", clientMessageId: "open", text: "search the forced gate" },
        {
          ...portsWith(store),
          intent: classifiedAs({ category: "exploration", targetNodeId: "saboteurs" }),
          sceneNarrative: scriptedSceneNarrative([]),
        },
      ),
    );
    return campaign;
  }

  /** Rewrites the open board in place — the poser for each outcome below. */
  function poseBoard(campaign: Campaign, patch: (each: Combatant) => Combatant, round = 1): void {
    const encounter = campaign.state.encounter;
    if (encounter === null) throw new Error("poseBoard: no bracket open");
    campaign.state = {
      ...campaign.state,
      encounter: { ...encounter, combatants: encounter.combatants.map(patch), round },
    };
  }

  const slain = (each: Combatant): Combatant =>
    each.faction === "hostile" ? { ...each, status: "dead", currentHp: 0 } : each;

  it("resolves with victory, completes the node and applies its effects", async () => {
    const store = createInMemoryEventStore();
    const campaign = await bridgedCampaign(store);
    poseBoard(campaign, slain);

    const frames = await drain(handleCommand(campaign, dodge("hero", "c-win"), portsWith(store)));

    expect(eventTypesOf(frames)).toContain("encounter_resolved");
    const resolved = frames
      .filter((each): each is Extract<ServerFrame, { type: "event" }> => each.type === "event")
      .map((each) => each.event)
      .find((each) => each.type === "encounter_resolved");
    expect(resolved?.payload).toMatchObject({
      encounterId: "goblin-ambush",
      outcome: "victory",
      survivorIds: ["hero"],
    });
    expect(campaign.state.encounter).toBeNull();
    expect(campaign.built).toBeNull();
    expect(campaign.state.world.scene?.completedNodeIds).toContain("saboteurs");
    // `saboteurs` declares no effects, so there is no delta to record. A
    // `world_delta_applied` here would mean the pipeline invented one.
    expect(eventTypesOf(frames)).not.toContain("world_delta_applied");
  });

  it("resolves with defeat and leaves the node uncompleted", async () => {
    const store = createInMemoryEventStore();
    const campaign = await bridgedCampaign(store);
    // The hero is about to be killed on the goblins' turn: 1 HP behind AC 1,
    // so any attack roll hits and any damage is lethal — no reliance on the
    // seed. `agentProposing` supplies the attack; `defaultTactical` would
    // only dodge.
    poseBoard(campaign, (each) =>
      each.faction === "party" ? { ...each, currentHp: 1, maxHp: 1, armorClass: 1 } : each,
    );

    const frames = await drain(
      handleCommand(
        campaign,
        dodge("hero", "c-lose"),
        portsWith(
          store,
          agentProposing([
            {
              actorId: "goblin-a",
              mainAction: { actionType: "attack", targetId: "hero", weaponId: "scimitar" },
              tacticalRationaleEnglish: "Test fixture: finish the hero.",
            },
          ]),
        ),
      ),
    );

    const resolved = frames
      .filter((each): each is Extract<ServerFrame, { type: "event" }> => each.type === "event")
      .map((each) => each.event)
      .find((each) => each.type === "encounter_resolved");
    expect(resolved?.payload).toMatchObject({ outcome: "defeat" });
    expect(campaign.state.encounter).toBeNull();
    expect(campaign.state.world.scene?.completedNodeIds).not.toContain("saboteurs");
    expect(campaign.state.world.scene?.currentNodeId).toBe("saboteurs");
    expect(eventTypesOf(frames)).not.toContain("quest_node_completed");
  });

  it("resolves a stalemate once the round passes maxRounds", async () => {
    const store = createInMemoryEventStore();
    const campaign = await bridgedCampaign(store);
    // Everyone alive, so `conclusionOf` stays "ongoing"; only the round is
    // past `goblin-ambush`'s maxRounds of 20.
    poseBoard(campaign, (each) => each, 21);

    const frames = await drain(handleCommand(campaign, dodge("hero", "c-draw"), portsWith(store)));

    const resolved = frames
      .filter((each): each is Extract<ServerFrame, { type: "event" }> => each.type === "event")
      .map((each) => each.event)
      .find((each) => each.type === "encounter_resolved");
    expect(resolved?.payload).toMatchObject({ outcome: "stalemate" });
    expect(campaign.state.world.scene?.completedNodeIds).not.toContain("saboteurs");
  });

  it("emits nothing for a combat-only campaign whose fight ends", async () => {
    const store = createInMemoryEventStore();
    const campaign = await freshCampaign(store);
    poseBoard(campaign, slain);

    const frames = await drain(handleCommand(campaign, dodge("hero", "c-solo"), portsWith(store)));

    // Decision 7: the fight IS the campaign, so the bracket stays open and
    // the client keeps reading victory off `conclusionOf` as it does today.
    expect(eventTypesOf(frames)).not.toContain("encounter_resolved");
    expect(campaign.state.encounter).not.toBeNull();
    expect(campaign.built).not.toBeNull();
  });
});
```

Two shapes to confirm against the file before writing this, and adjust to match rather than adding anything: `agentProposing`'s parameter type (`readonly ExecuteTurn[]`, line 351) — check whether an attack turn needs a `weaponId` or a different field name — and whether `dodge` takes `(actorId, clientMessageId)` in that order (line ~318). Also confirm `poseBoard`'s `round` argument does not fight the `turn_advanced` fold: the hero's dodge advances the turn, so `round` may increment during the test. If a stalemate at exactly 21 proves brittle for that reason, pose 25.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/server test pipeline
```

Expected: FAIL — no `encounter_resolved` event is ever produced.

- [ ] **Step 3: Import the shared victory rule and use it in `runEnemyTurns`**

Add `conclusionOf` to the existing `@ai-dm/schemas` import in `apps/server/src/core/pipeline.ts`.

Replace `runEnemyTurns`'s inline check (currently `const livingFactions = new Set(...)` through `if (livingFactions.size < 2) return;`) with:

```ts
      // The same rule `conclusionOf` states, read from the one definition
      // rather than spelled a second way here (spec Decision 3).
      if (conclusionOf(encounterOf(campaign)) !== "ongoing") return;
```

- [ ] **Step 4: Write the detector**

Add this helper next to `playerAffordances` in `apps/server/src/core/pipeline.ts`:

```ts
  /**
   * Ends the fight if it is over, and turns a won one back into scene
   * progress (spec Decisions 4, 5 and 7).
   *
   * Two terminators. `conclusionOf` answers "one faction left standing", the
   * rule the client has always read the board with. `maxRounds` answers the
   * one the bridge itself creates: before step 5 an unresolvable fight was a
   * stuck board on a combat-only campaign, visible and recoverable by
   * reload; now the same stalemate strands a campaign outside its own
   * narrative permanently, because `free_text`'s Guard 2 refuses input for as
   * long as the bracket stays open. The number is already authored and
   * already built — only the comparison was missing.
   *
   * Silent when the campaign has no scene to return to. For a combat-only
   * campaign the fight IS the campaign, and closing its bracket would null
   * `state.encounter` with `scene` already null — a projection in neither
   * combat nor a scene, which `apps/web` can only render as its "not ready"
   * placeholder. Winning would blank the screen. So those campaigns end
   * exactly as they do today: no event, board still projected, and the client
   * reads victory or defeat off `conclusionOf` itself.
   */
  async function* resolveIfConcluded(): AsyncIterable<ServerFrame> {
    const encounter = campaign.state.encounter;
    if (encounter === null) return;
    if (campaign.sceneStatics === null) return;

    const conclusion = conclusionOf(encounter);
    const outcome =
      conclusion !== "ongoing"
        ? conclusion
        : encounter.round > builtOf(campaign).maxRounds
          ? "stalemate"
          : null;
    if (outcome === null) return;

    const events: { type: GameEvent["type"]; payload: Record<string, unknown> }[] = [
      {
        type: "encounter_resolved",
        payload: {
          encounterId: encounter.encounterId,
          outcome,
          survivorIds: encounter.combatants
            .filter((each) => each.status === "alive")
            .map((each) => each.combatantId),
        },
      },
    ];

    // Only a won fight advances the arc. Defeat and stalemate close the
    // bracket and change nothing else, so the player lands back in the scene
    // at the same node and can re-enter — which rebuilds a fresh board from
    // the catalogue. Known ceiling, recorded in the spec: a defeated solo PC
    // narratively walking it off is wrong, and permadeath wants its own
    // decision rather than a subsystem smuggled into this step.
    if (outcome === "victory") {
      const statics = sceneStaticsOf(campaign);
      const before = sceneStateFrom(currentScene());
      const transition = completeCurrentNode(statics.authored, before);
      // Invalid means the node's own entry gate no longer holds, which cannot
      // happen for a node already entered — `completeCurrentNode` short-
      // circuits on an already-completed node and this one is not yet
      // completed. Throw rather than silently skip: a false here means the
      // authored world and the log disagree, the same corrupt-content posture
      // `currentScene` and `sceneStaticsOf` take.
      if (!transition.valid) {
        throw new Error(
          `Campaign ${campaign.state.world.campaignId} cannot complete encounter node ` +
            `${before.currentNodeId}: ${transition.rejections.map((each) => each.message).join("; ")}`,
        );
      }
      events.push({
        type: "quest_node_completed",
        payload: { nodeId: before.currentNodeId },
      });
      // Diffed off the engine's own pre/post states, never re-read from the
      // node's declared effects — the same rule the exploration branch
      // follows, so the payload records what the engine actually did,
      // post-clamp, and cannot disagree with it.
      const delta = diffScene(before, transition.state);
      if (delta.relations.length > 0 || delta.day !== undefined) {
        events.push({
          type: "world_delta_applied",
          payload: {
            relations: delta.relations,
            ...(delta.day === undefined ? {} : { day: delta.day }),
          },
        });
      }
    }

    yield* emitAll(events);
    // `emitAll` moves `campaign.state` and never `built`. Clearing it here
    // keeps both halves of the bracket written in one place, which is what
    // `Campaign.built`'s doc comment actually asks for — rather than leaving
    // `builtOf`'s guard to catch the desync one read later.
    campaign.built = null;
  }
```

Add `completeCurrentNode` to the existing `@ai-dm/rules-engine` import if it is not already there (`diffScene` and `sceneStateFrom` already are, at `pipeline.ts:25-26`).

- [ ] **Step 5: Call it after the turn batch**

In the `structured_action` case (around `pipeline.ts:1593`), insert the call between `runEnemyTurns()` and `playerAffordances()`:

```ts
        yield* runEnemyTurns();
        yield* resolveIfConcluded();
        yield* playerAffordances();
```

`playerAffordances` is already silent when no encounter is open, so a resolved bracket falls through it correctly with no extra guard.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test
```

Expected: PASS, including every existing combat test — the combat-only campaigns they drive have `sceneStatics === null`, so `resolveIfConcluded` returns immediately for all of them.

- [ ] **Step 7: Sabotage check**

Temporarily change `if (campaign.sceneStatics === null) return;` to `if (false) return;` and re-run. Expected: the combat-only test from Step 1 fails, proving it actually pins the asymmetry. Restore the line. Do the same for the `maxRounds` comparison (change `>` to `>=` and confirm a test moves), then restore.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/core/pipeline.ts apps/server/src/core/pipeline.test.ts
git commit -m "feat(server): detect the end of combat and resolve the bracket

conclusionOf plus a maxRounds terminator, with victory completing the
encounter node and applying its effects through one emitAll group. Silent
for combat-only campaigns, which keep today's behaviour exactly.
Spec Decisions 4, 5 and 7."
```

---

### Task 7: The web client folds a live bracket

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `conclusionOf` from `@ai-dm/schemas` (Task 1, already wired); a live `encounter_started` frame the store now folds (Task 2).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe("App (?world= query param)")` block in `apps/web/src/App.test.tsx` (line 1033), reusing its `scene`/`sceneSnapshot` fixtures and the file's `start()` helper, `socket`, `fetchMock` and `catalogue` fixture.

Leave the existing "never fetches an encounter catalogue" test at line 1057 exactly as it is — it stays true and becomes a sharper claim: no catalogue is fetched *while no bracket is open*.

```ts
  it("fetches the catalogue and renders the board when a bracket opens mid-scene", async () => {
    await start();

    act(() => {
      socket.emitMessage({ type: "campaign_state", sequence: 0, snapshot: sceneSnapshot() });
    });
    expect(await screen.findByPlaceholderText(he.freeText.placeholder)).toBeInTheDocument();

    // The bracket opens on the already-open socket — the case that was
    // unreachable before §4.7 step 5 and is the whole point of it. `reduce`
    // now folds this into a real board (Task 2), so the client needs the
    // catalogue it never fetched at mount.
    act(() => {
      socket.emitMessage({
        type: "campaign_state",
        sequence: 1,
        snapshot: { ...sceneSnapshot(), encounter: bracketOpen() },
      });
    });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call: unknown[]) =>
          String(call[0]).includes("/encounters/goblin-ambush"),
        ),
      ).toBe(true);
    });
    // The board replaces the free-text bar once the catalogue lands.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(he.freeText.placeholder)).not.toBeInTheDocument();
    });
  });
```

Add `bracketOpen()` beside `sceneSnapshot()` in that describe, built from the file's existing `snapshotWith` helper (line 24) so the combatants are valid:

```ts
  function bracketOpen(): CampaignState["encounter"] {
    return snapshotWith([/* the same combatants snapshotWith's callers already use */]).encounter;
  }
```

Read `snapshotWith` first — if it returns a whole `CampaignState` with a populated encounter, take `.encounter` from it as above; the `catalogue` fixture at line 59 is what the assertion's fetch resolves to, and its combatant ids must match whatever board you pose or the board will render with unnamed combatants. Match the ids to the `catalogue` fixture, not to `goblin-ambush`'s real spawns, since `fetchMock` returns that fixture for every non-POST call.

Sending the board as a fresh `campaign_state` frame rather than an `event` frame is deliberate: it tests the catalogue fetch, which is Task 7's actual change. Task 2 already covers `reduce` folding a live `encounter_started`, and `apps/web/src/state/store.test.ts` covers `applyFrame` running it.

- [ ] **Step 2: Run the test to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/web test App
```

Expected: FAIL — no catalogue is ever requested, because the fetch happens once at mount and only for a non-`worldId` campaign.

- [ ] **Step 3: Make the catalogue fetch reactive**

In `apps/web/src/App.tsx`, delete the mount-time conditional fetch:

```ts
      if (worldId === null) {
        const fetched = await fetchCatalogue(ENCOUNTER_ID);
        if (runIdRef.current !== runId) return;
        setCatalogue(fetched);
      }
```

Add an effect that keys off whichever encounter is actually open:

```ts
  // The catalogue is display metadata — combatant labels and action
  // descriptions — that no event carries and the fold never needed. Since
  // §4.7 step 5 a bracket can open at any point in a campaign's life, not
  // only before the first frame, so this follows the projection rather than
  // firing once at mount. `encounter_started` now folds into a real board
  // (`reduce` fills it from the payload), so `openEncounterId` becoming
  // non-null is the exact moment a catalogue is needed.
  const openEncounterId = state.snapshot?.encounter?.encounterId ?? null;
  useEffect(() => {
    if (openEncounterId === null) return;
    if (catalogue?.encounterId === openEncounterId) return;
    let cancelled = false;
    void (async () => {
      const fetched = await fetchCatalogue(openEncounterId);
      if (!cancelled) setCatalogue(fetched);
    })();
    return () => {
      cancelled = true;
    };
  }, [openEncounterId, catalogue?.encounterId]);
```

`EncounterCatalogue` already carries `encounterId` (`protocol.ts:272`), so the guard compares against the fetched catalogue itself and no extra ref or schema field is needed.

`ENCOUNTER_ID` (`App.tsx:33`) is still used by the `createCampaign` call on the combat-campaign path; leave it. Only the `fetchCatalogue(ENCOUNTER_ID)` call goes away.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/web test
```

Expected: PASS, including the existing combat-campaign tests — a combat campaign's first snapshot already has its board, so `openEncounterId` is non-null on the first render and the fetch fires exactly where the mount-time one used to.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): fetch the encounter catalogue when a bracket opens

Follows the projection rather than firing once at mount, since a fight can
now start at any point in a campaign's life. Spec Decision 2."
```

---

### Task 8: End-to-end walk, replay determinism, and the plan record

**Files:**
- Modify: `apps/server/src/e2e.test.ts`
- Modify: `apps/server/src/core/replay.test.ts`
- Modify: `PROJECT_PLAN.md` (§4.7 sequence entry 5)

**Interfaces:**
- Consumes: everything above.
- Produces: the exit criterion, proven.

- [ ] **Step 1: Write the failing end-to-end test**

Add to `apps/server/src/e2e.test.ts`'s `describe("end to end")` block, reusing its existing harness: `startServer` (line 80), `connect` (158), `send` (169), `eventFrames` (176), `joinAndAck` (255), `waitForProjection` (290) and `heroDodge` (318).

That file's existing campaign helper is `createCampaignOver(app)` (line 149), which posts the **combat** body. This test needs the `worldId` body instead, so add a sibling beside it rather than changing it — the existing one is what every combat test in the file relies on staying identical:

```ts
async function createWorldCampaignOver(app: FastifyInstance): Promise<string> {
  // Mirrors `createCampaignOver` exactly, with §4.7 step 4's alternative
  // body. Kept separate so the combat path's own helper is untouched.
  const response = await app.inject({
    method: "POST",
    url: "/campaigns",
    payload: { worldId: "emberfall" },
  });
  return CampaignCreated.parse(response.json()).campaignId;
}
```

Then the walk. It goes over the socket like the file's other tests, and the server's real intent agent is not available in this harness — check how `startServer` builds its ports and stub `intent` there the same way the existing tests stub `tactical`, classifying each message to the traversal it should mean:

```ts
it("walks a scene campaign into combat and back out to narration", async () => {
  const { app, url, store } = await startServer();
  const campaignId = await createWorldCampaignOver(app);
  const socket = await connect(url);
  const frames = await joinAndAck(socket, campaignId);

  // Down the arc: arrival -> the-weir -> saboteurs, which declares the fight.
  send(socket, { type: "free_text", clientMessageId: "w1", text: "לשמוע את סוכנת הגילדה" });
  send(socket, { type: "free_text", clientMessageId: "w2", text: "ללכת אל הסכר" });
  send(socket, { type: "free_text", clientMessageId: "w3", text: "לבדוק את מנגנון השער" });

  await waitForProjection(frames, (state) => state.encounter !== null);
  expect(eventFrames(frames).map((each) => each.type)).toContain("encounter_started");

  // Play it out. `heroDodge` plus the harness's tactical stub is what the
  // existing "plays a full combat to a conclusion" test already uses.
  await playToConclusion(socket, frames);

  await waitForProjection(frames, (state) => state.encounter === null);
  const events = eventFrames(frames);
  const resolved = events.find((each) => each.type === "encounter_resolved");
  expect(resolved?.payload).toMatchObject({ outcome: "victory" });
  expect(
    events.filter(
      (each) => each.type === "quest_node_completed" && each.payload["nodeId"] === "saboteurs",
    ),
  ).toHaveLength(1);

  // The exit criterion's last clause: a cold load folds to the live state.
  const reloaded = await loadCampaign({ campaignId, store });
  expect(reloaded?.state.world.scene?.completedNodeIds).toContain("saboteurs");
  expect(reloaded?.state.encounter).toBeNull();
});
```

`playToConclusion` is the one thing to lift from the existing test at line 352 ("plays a full combat to a conclusion over the socket") — read that test and reuse its loop verbatim rather than writing a second one. If it is written inline there, extract it into a helper both tests call, and confirm the original still passes unchanged.

The three Hebrew strings are player input, the one place invariant 2 sanctions Hebrew. The stubbed intent port decides what each classifies to, so their content only has to be plausible to a reader.

- [ ] **Step 2: Extend the existing seed-determinism block**

**Do not write a new seed suite.** `apps/server/src/core/replay.test.ts:408-495` already has `describe("seed determinism across a bracket")`, and it already pins §4.7's rule in as many words — determinism across independent stores, plus the continuity assertion that encounter B's seeds differ from encounter A's because the sequence is campaign-scoped and never resets. Decision 6's property is tested. What that block does *not* cover is a bracket opened by the **bridge** rather than by a direct `startEncounter` call, and that is the only gap to close.

Add one test inside that existing `describe`, reusing its `seedsIn` helper and the file's `startedSceneCampaign`, `classifiedAs`, `portsWith`, `drain` and `dodgeCommand`:

```ts
  it("keeps a bridge-opened bracket on the campaign's own seed sequence", async () => {
    // Decision 6: step 5 adds no per-encounter seed, because there is no
    // second seed to add — a fight the BRIDGE starts draws from exactly the
    // same campaign rootSeed and campaign sequence a directly-started one
    // does. The sibling test above proves that for `startEncounter`; this
    // proves the pipeline's own path did not quietly grow a second scheme.
    async function playBridged(store: EventStore): Promise<GameEvent[]> {
      const campaign = await startedSceneCampaign(store, { rootSeed: 42 });
      // Walk to `saboteurs`, which opens the bracket.
      await drain(
        handleCommand(
          campaign,
          { type: "free_text", clientMessageId: "walk", text: "search the forced gate" },
          {
            ...portsWith(store),
            intent: classifiedAs({ category: "exploration", targetNodeId: "saboteurs" }),
          },
        ),
      );
      await drain(handleCommand(campaign, dodgeCommand("hero", "t1"), portsWith(store)));
      return store.readSince("s1", -1);
    }

    const a = await playBridged(createInMemoryEventStore());
    const b = await playBridged(createInMemoryEventStore());

    const last = (events: readonly GameEvent[]): number => (events.at(-1)?.sequence ?? -1) + 1;
    const seedsA = seedsIn(a, 0, last(a));
    // Guarded non-empty for the reason the sibling test spells out: without
    // it, a regression that stopped `dice_rolled` firing at all would make
    // the comparison pass vacuously on two empty arrays.
    expect(seedsA.length).toBeGreaterThan(0);
    expect(seedsA).toEqual(seedsIn(b, 0, last(b)));
  });
```

`startedSceneCampaign` may need its walk to start further into the arc — check its `PlayOptions` (line 128) and, if it starts at `arrival`, either pass a starting-node override if one exists or chain the two traversals (`arrival` → `the-weir` is not a direct edge; the shipped arc goes `arrival` → `guild-offer` or `warden-warning` → `the-weir` → `saboteurs`). Chaining classifications is fine — each is one more `drain` with its own `clientMessageId`.

- [ ] **Step 3: Run both to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/server test e2e replay
```

Expected: FAIL until the harness helpers are written; the production code from Tasks 1–7 should make them pass without further source changes. If a production change turns out to be needed, that is a real finding — make it and note it in the commit message.

- [ ] **Step 4: Run both to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test
```

Expected: PASS.

- [ ] **Step 5: Full verification**

```bash
corepack enable && pnpm test 2>&1 | grep -E "Test Files +[0-9]|Tests +[0-9]"
```

Expected: ≥ 1550 passed / 30 skipped / 104 files.

```bash
corepack enable && DATABASE_URL=postgres://localhost:5432/aidm_step5_scratch pnpm test 2>&1 | grep -E "Test Files +[0-9]|Tests +[0-9]"
```

Expected: ≥ 1580 passed / 0 skipped / 104 files.

```bash
corepack enable && pnpm typecheck && npx eslint packages apps tools
```

Expected: both exit 0.

- [ ] **Step 6: Record the step in `PROJECT_PLAN.md`**

Update §4.7's sequence entry 5 to match the shape entries 1–4 use, filling in the real merge commit and CI numbers once merged. For now, add the spec and plan links:

```markdown
5. **The combat bridge:** `encounter_started` / `encounter_resolved`,
   deterministic seed derivation.
   [`docs/superpowers/specs/2026-08-30-combat-bridge-design.md`](docs/superpowers/specs/2026-08-30-combat-bridge-design.md),
   plan at
   [`docs/superpowers/plans/2026-08-30-combat-bridge.md`](docs/superpowers/plans/2026-08-30-combat-bridge.md).
```

Also update the four bullets under "What step 1 already leaves for steps 2–4": the first (the fold gap) and the third (`emit` as a fourth writer of the bracket) are both closed by this step, and saying so is what keeps that section a live record rather than a stale one. Leave the second (`loadCampaign`'s coupling to catalogue history) with a note that it now applies only to pre-step-5 logs, and leave the fourth (`campaign_started` having no corrupt-log guard) untouched — this step does not address it.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/e2e.test.ts apps/server/src/core/replay.test.ts PROJECT_PLAN.md
git commit -m "test(server): end-to-end scene -> combat -> scene, and replay determinism

Pins the exit criterion and Decision 6's no-second-seed property, and
records step 5 in the §4.7 sequence."
```

---

## Notes for the executor

**Every test helper this plan calls already exists**, with one exception per file, named as such: `createWorldCampaignOver` (Task 8, `e2e.test.ts`) and possibly a `playToConclusion` extraction from that file's existing combat test. Everything else — `sceneCampaign`, `portsWith`, `classifiedAs`, `scriptedSceneNarrative`, `drain`, `eventTypesOf`, `defaultTactical`, `agentProposing`, `dodge`, `freshCampaign`, `seedsIn`, `startedSceneCampaign`, `dodgeCommand`, `joinAndAck`, `waitForProjection`, `eventFrames`, `heroDodge` — is in the file the task edits. Read the file before writing; do not build a parallel harness beside one that is already there.

**Decision 6's property is mostly already tested.** `replay.test.ts:408-495` pins seed determinism across a bracket, including §4.7's exact "never fresh randomness" rule and the continuity check that a bracket does not reset the sequence. Task 8 adds one test to that block for a bridge-opened bracket and nothing more. Do not write a second seed suite.

**Two known-and-unfixed items are explicitly out of scope.** `apps/server/src/transport/ws.ts`'s catch-all `internal_error` frame carries no `clientMessageId` even when the failing command had one (`apps/web` compensates by treating an absent id as clearing its pending-send latch). And `not_your_turn` sits in `apps/web`'s `ErrorBanner.tsx` `SILENT_CODES`. The second is worth re-checking after Task 7: it was safe because nothing out of combat could send a `structured_action`, and Task 7 does not change that — the board only renders when a bracket is open — but confirm it rather than assuming it.

**Do not touch `packages/memory/CLAUDE.md`.**
