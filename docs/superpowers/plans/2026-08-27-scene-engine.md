# Scene Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate the predicates and apply the effects §4.7 step 2 shipped as data — a pure scene engine that plays the authored quest graph, refuses an illegal traversal with reasons, and clamps faction bands.

**Architecture:** [Design spec](../specs/2026-08-27-scene-engine-design.md). A new `packages/rules-engine/src/scene/` module holding `AuthoredWorld` and `pairKey` (moved from `apps/server`, re-exported there), an engine-local `SceneState`, and seven exported functions returning `validateExecuteTurn`-shaped result unions. `loadWorld` gains exactly one new check. No event type, no `reduce` case, no `pipeline.ts` change, no LLM.

**Spec:** [`docs/superpowers/specs/2026-08-27-scene-engine-design.md`](../specs/2026-08-27-scene-engine-design.md)

**Tech Stack:** TypeScript 5.9 strict, ESM, Node 22, zod 3.25.76, Vitest 3.

### The one thing this plan gets right or gets wrong

Step 2's whole-branch review named the failure mode for this step before the
step existed: **an evaluator hard-coded to `return true` for
`faction_band_at_least` would play the shipped world identically and pass
every test on `main`.** The shipped arc's gate cannot fail — `reckoning` asks
for at least `hostile` and `hostile` is the lowest band reachable before it.

So the fixture that earns this step its place is Task 4's blocked world, and
the discipline that earns it is the sabotage step: every check this plan adds
gets broken deliberately, run, and confirmed to fail exactly the assertions it
should. Step 2 shipped three checks that could not fail — same file, same
cause, caught only by review. A test that passes when the code is wrong is not
a test.

Build each fixture by asking, of each line of the implementation, "what input
reaches this line". Do not build it by adding one defect per rule. That is
literally the mistake step 2's review diagnosed.

## Global Constraints

- **Dependency direction:** `schemas ← rules-engine ← agents ← server`. `web` depends only on `schemas`. Nothing depends on `server`. **The scene engine may never import `apps/server`.**
- **`packages/rules-engine` is pure:** no I/O, no `node:fs`, no network, no LLM, no `Date.now()`, no `Math.random()`, no ambient randomness. Depends only on `@ai-dm/schemas`.
- **Schemas define everything once.** Never hand-write an interface duplicating a schema — infer with `z.infer`. Never re-derive `pairKey`'s `a < b ? a|b : b|a` format anywhere.
- **English inside, Hebrew outside.** Comments, identifiers, ids, rejection messages: English. Hebrew only in `*Hebrew`-suffixed content fields.
- **ESM with `.js` extensions in relative imports.**
- **TypeScript strict plus `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.** An indexed read is `T | undefined` and must be guarded — this bites `FACTION_BANDS[index]` directly, in Task 2.
- **Exhaustiveness rests on `strictNullChecks`, not `noImplicitReturns`** (this repo does not set the latter). A switch returning from every branch with **no `default`** fails with TS2366 when a union member is added. Write every predicate/effect switch that way. Never add a `default` branch to one.
- **ESLint `strictTypeChecked`:** no `!`, no unnecessary conditions, `_`-prefixed unused params still error, `[...str]` banned (use `Array.from`), `consistent-type-imports` on.
- **`corepack enable` before any pnpm command.** Never run root `pnpm lint` — it walks sibling worktrees; lint with `npx eslint packages apps tools`. **Never run `pnpm format`** (no `.prettierignore`; it rewrites ~37 files including the lockfile).
- **No new predicate or effect kinds.** `packages/schemas/src/content.ts` is not edited by this plan. If a task wants to, stop — something is wrong.
- **No wiring.** No event type, no `reduce` case, no `pipeline.ts`, no `POST /campaigns`, no `protocol.ts`. The only file outside `packages/rules-engine/src/scene/` that changes behaviour is `apps/server/src/world/index.ts`.
- **Do not touch `packages/memory/CLAUDE.md`** — it carries an uncommitted edit belonging to someone else in the main checkout. **Stage files by name in every commit; never `git add -A` or `git add .`.**
- **Coverage:** `packages/rules-engine` targets ≥90% lines. Do not drop it.
- **Baseline:** recorded in Task 1. Every later task compares against it and any drop is a regression.

---

## File Structure

**`@ai-dm/rules-engine`** —
`src/scene/authored-world.ts` (new: `AuthoredWorld`, `pairKey`, moved verbatim from `apps/server`),
`src/scene/index.ts` (new: `SceneState`, the seven exported functions, the private applier),
`src/scene/test-fixtures.ts` (new: TS-built worlds),
`src/scene/index.test.ts` (new),
`src/index.ts` (one export line),
`CLAUDE.md` (Purpose and Modules narrowed to describe what the package now holds).

**`@ai-dm/server`** —
`src/world/index.ts` (delete the moved declarations, import and re-export them, add the start-node check),
`src/world/index.test.ts` (the new fixture's assertions),
`src/world/arc.test.ts` (new: the end-to-end golden test over the real Emberfall world).

**`data/world/`** —
`fixtures/unenterable-start/{world,factions,locations,npcs,arc}.json` (new),
`README.md` (one paragraph describing the new fixture).

**Docs** — `PROJECT_PLAN.md` §4.7 sequence entry 3.

### Why the engine is one module and not two packages

The spec's Decision 1. `packages/rules-engine/CLAUDE.md` already states the
exact boundary the scene engine satisfies — pure functions, no I/O, depends
only on `@ai-dm/schemas`. A separate package buys a conceptual line at the
cost of a `package.json`, a `tsconfig`, an eslint entry, CI wiring and a new
dependency edge, for a few hundred lines whose tooling is already configured
next door.

---

## Task 1: Record the baseline

No code. The number every later task is measured against. **This task is
already done** — recorded below at plan-writing time.

- [x] **Step 1: Cut a branch off current `main`**

```bash
git fetch origin
git switch -c narrative-step-3-scene-engine main
git log --oneline -1
```

`main` is `7b5e865` and `origin/main` is the same commit — verified with
`git merge-base --is-ancestor`. The branch already exists and carries the
design spec at `2ba09e0`.

- [x] **Step 2: Bootstrap and measure**

```bash
corepack enable
pnpm install
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

**A fresh worktree has no `node_modules`.** `pnpm install` first or every
`test` script dies with `vitest: command not found`, which looks like a broken
test and is not one.

**Recorded 2026-08-27**, on `narrative-step-3-scene-engine` off `7b5e865`:

| Package | Test files | Tests |
|---|---|---|
| `packages/schemas` | 8 | 191 |
| `packages/rules-engine` | 15 | 402 |
| `packages/memory` | 3 passed, 1 skipped (4) | 33 passed, 29 skipped (62) |
| `apps/web` | 12 | 107 |
| `packages/agents` | 21 | 239 |
| `tools/sim` | 22 | 194 |
| `apps/server` | 11 | 169 passed, 1 skipped (170) |
| **Total** | **93** | **1335 passed, 30 skipped (1365)** |

`pnpm typecheck` and `npx eslint packages apps tools` both exit 0. The 30
skips are `packages/memory`'s 29 Postgres cases plus `apps/server`'s one
Postgres-gated bracket test. With `DATABASE_URL` set the total is 1365 passed
/ 0 skipped. The `apps/web` run emits jsdom
`HTMLCanvasElement.prototype.getContext` warnings throughout and always has.

---

## Task 2: The move, and band arithmetic

**Files:**
- Create: `packages/rules-engine/src/scene/authored-world.ts`
- Create: `packages/rules-engine/src/scene/index.ts`
- Create: `packages/rules-engine/src/scene/index.test.ts`
- Modify: `packages/rules-engine/src/index.ts` (one export line)
- Modify: `apps/server/src/world/index.ts` (delete two declarations, import and re-export them)

**Interfaces:**
- Consumes: `FactionBand`, `FACTION_BANDS`, `FactionDefinition`, `LocationDefinition`, `NpcDefinition`, `QuestNode` from `@ai-dm/schemas`.
- Produces: `AuthoredWorld` and `pairKey(a: string, b: string): string` from `@ai-dm/rules-engine`, still re-exported from `apps/server/src/world/index.ts`; `SceneState`, and `shiftBand(band: FactionBand, delta: number): FactionBand` and `relationBetween(state: SceneState, a: string, b: string): FactionBand | undefined` from `@ai-dm/rules-engine`.

This task moves the two declarations and adds the arithmetic. It adds no
traversal — that is Tasks 3 and 4 — so its whole surface is testable in
isolation and the move can be reviewed without the behaviour on top of it.

- [ ] **Step 1: Write the failing test**

Create `packages/rules-engine/src/scene/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pairKey, relationBetween, shiftBand } from "./index.js";
import type { SceneState } from "./index.js";
import type { FactionBand } from "@ai-dm/schemas";

function stateWith(
  relations: readonly (readonly [string, string, FactionBand])[],
): SceneState {
  return {
    currentNodeId: "start",
    completedNodeIds: new Set<string>(),
    relations: new Map(relations.map(([a, b, band]) => [pairKey(a, b), band])),
    day: 1,
  };
}

describe("pairKey", () => {
  // Moved here from apps/server. The engine is pure and may never import the
  // server (invariant 5), and an engine that cannot import this would
  // hand-write `a < b ? a|b : b|a` a second time — the invariant-4 duplicate
  // step 2's whole-branch review predicted for this step.
  it("is order-independent", () => {
    expect(pairKey("alpha", "beta")).toBe(pairKey("beta", "alpha"));
  });

  it("distinguishes different pairs", () => {
    expect(pairKey("alpha", "beta")).not.toBe(pairKey("alpha", "gamma"));
  });
});

describe("shiftBand", () => {
  it("moves along FACTION_BANDS by the delta", () => {
    expect(shiftBand("cold", 1)).toBe("neutral");
    expect(shiftBand("cold", -1)).toBe("hostile");
    expect(shiftBand("neutral", 0)).toBe("neutral");
  });

  // The schema permits -6..+6 precisely so clamping is reachable rather than
  // theoretical. Both ends, because a clamp written with one bound is a clamp
  // that is wrong in one direction.
  it("clamps at allied and never wraps", () => {
    expect(shiftBand("cordial", 6)).toBe("allied");
    expect(shiftBand("allied", 1)).toBe("allied");
  });

  it("clamps at war and never wraps", () => {
    expect(shiftBand("hostile", -6)).toBe("war");
    expect(shiftBand("war", -1)).toBe("war");
  });

  it("spans the whole scale in one shift", () => {
    expect(shiftBand("war", 6)).toBe("allied");
    expect(shiftBand("allied", -6)).toBe("war");
  });
});

describe("relationBetween", () => {
  it("finds a relation asked in either order", () => {
    const state = stateWith([["ashen-guild", "river-wardens", "cold"]]);
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("cold");
    expect(relationBetween(state, "river-wardens", "ashen-guild")).toBe("cold");
  });

  // Unreachable through `loadWorld`, which refuses a missing pair and a
  // self-pair. Reachable through a hand-built SceneState, which is what step
  // 4 will assemble from a projection.
  it("returns undefined for a pair it does not hold", () => {
    const state = stateWith([["ashen-guild", "river-wardens", "cold"]]);
    expect(relationBetween(state, "ashen-guild", "nobody")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine test scene
```

Expected: FAIL — `./index.js` does not exist under `src/scene/`.

- [ ] **Step 3: Create `packages/rules-engine/src/scene/authored-world.ts`**

Move both declarations out of `apps/server/src/world/index.ts` **verbatim**,
adjusting only the doc comments that described their old home:

```ts
// The authored world as the scene engine consumes it, and the key format its
// relations map uses.
//
// This lives here rather than in `apps/server`, where `loadWorld` produced it
// through §4.7's step 2, because the scene engine is pure and may never
// import an app (invariant 5). `loadWorld` stays where it is — it reads
// `node:fs`, which neither this package nor browser-bundled `@ai-dm/schemas`
// may — and imports these two back from here.
//
// Declared as an interface rather than a zod schema because it holds `Map`s:
// it is neither a wire shape nor something that round-trips through JSON as
// written. `SrdGear` is the identical case in this package.
import type {
  FactionBand,
  FactionDefinition,
  LocationDefinition,
  NpcDefinition,
  QuestNode,
} from "@ai-dm/schemas";

/**
 * The authored world, indexed. `Map`s rather than arrays for the reason
 * `loadGear` returns them: every consumer looks content up by id.
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

/**
 * Canonical key for an unordered faction pair, so declaring `A,B` and `B,A`
 * names one relation rather than two. `|` is safe as a delimiter because
 * `ContentId` forbids it.
 *
 * There is exactly one implementation of this format, and it is here. A
 * second one written inline anywhere is the invariant-4 duplicate.
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
```

- [ ] **Step 4: Create `packages/rules-engine/src/scene/index.ts`**

```ts
// The scene engine (`PROJECT_PLAN.md` §4.7 step 3): evaluates the predicates
// and applies the effects step 2 authored as data.
//
// Pure, like everything else in this package. It takes the world injected —
// the way `buildEncounter` takes `statBlocks` — and never reads a file, a
// clock or a random source. The calendar advances only through a declared
// `advance_calendar` effect, because a wall-clock read is what makes a replay
// diverge (§4.6).
//
// Its relationship to combat is the one §4.7 describes: `validateExecuteTurn`
// adjudicates an LLM's proposed turn, and this adjudicates an LLM's proposed
// world move one level up. Same shape, same refusal-as-data contract.
import { FACTION_BANDS } from "@ai-dm/schemas";
import type { FactionBand, WorldEffect, WorldPredicate } from "@ai-dm/schemas";
import { pairKey } from "./authored-world.js";

export * from "./authored-world.js";

/**
 * What the engine tracks across a campaign. Every function returns a new one;
 * none mutates its input, which the `readonly` markers make a compile error
 * rather than a convention.
 *
 * An interface rather than a zod schema for `AuthoredWorld`'s reason — it
 * holds a `Set` and a `Map`. Choosing a serialized form now would mean
 * deciding it before anything serializes it; §4.7's step 4 is what folds
 * these fields into `WorldState` and is where that choice belongs.
 */
export interface SceneState {
  readonly currentNodeId: string;
  readonly completedNodeIds: ReadonlySet<string>;
  /** Keyed by `pairKey`. */
  readonly relations: ReadonlyMap<string, FactionBand>;
  /** A bare counter. Advanced only by a declared `advance_calendar` effect. */
  readonly day: number;
}

/**
 * Faction standing shifted along `FACTION_BANDS`, clamped to its ends.
 *
 * The band list's order IS the -3..+3 scale (`content.ts`), so this is index
 * arithmetic and there is one table rather than two that can disagree.
 * Clamping rather than wrapping or throwing: `delta` is schema-bounded to
 * -6..+6, which is wider than the seven-band scale on purpose, so an author
 * can declare "as hostile as this gets" without knowing the starting band.
 */
export function shiftBand(band: FactionBand, delta: number): FactionBand {
  const shifted = FACTION_BANDS.indexOf(band) + delta;
  const clamped = Math.min(Math.max(shifted, 0), FACTION_BANDS.length - 1);
  // `noUncheckedIndexedAccess` types this as possibly undefined; the clamp
  // above is what makes it not, and `?? band` is the honest way to say so
  // without a non-null assertion, which eslint bans.
  return FACTION_BANDS[clamped] ?? band;
}

/**
 * Standing between two factions, asked in either order.
 *
 * `undefined` for a pair the state does not hold. A world from `loadWorld`
 * cannot produce that — it refuses a missing pair and a self-pair — but a
 * hand-assembled state can, and step 4 assembles one from a projection.
 */
export function relationBetween(
  state: SceneState,
  a: string,
  b: string,
): FactionBand | undefined {
  return state.relations.get(pairKey(a, b));
}

/**
 * Is this gate open, given what the campaign has done so far?
 *
 * Written as a `return` from each branch with no `default`, so adding a
 * `WorldPredicate` kind fails to compile here rather than silently
 * evaluating true — the same exhaustiveness discipline `reduce.ts` and the
 * loader's `predicateRefs` rely on. Do not add a `default`.
 */
export function evaluatePredicate(predicate: WorldPredicate, state: SceneState): boolean {
  switch (predicate.kind) {
    case "node_completed":
      return state.completedNodeIds.has(predicate.nodeId);
    case "faction_band_at_least": {
      const band = relationBetween(state, predicate.factionA, predicate.factionB);
      // An unknown standing does not establish that standing is at least
      // anything. False, not a throw: the caller is a router deciding what to
      // offer, and an unknown pair makes a gate closed rather than broken.
      if (band === undefined) return false;
      return FACTION_BANDS.indexOf(band) >= FACTION_BANDS.indexOf(predicate.band);
    }
  }
}

/**
 * One declared world change, applied. Same exhaustiveness contract as
 * `evaluatePredicate`.
 *
 * Deliberately NOT exported. An effect is reachable only by completing a node
 * that declares it, which is what keeps invariant 1 intact one level above
 * combat: nothing can shift a faction band by asking. It is fully exercised
 * through `traverseEdge` and `completeCurrentNode`, which is a stronger test
 * than calling it directly would be.
 */
function applyEffect(effect: WorldEffect, state: SceneState): SceneState {
  switch (effect.kind) {
    case "shift_faction_relation": {
      const key = pairKey(effect.factionA, effect.factionB);
      const current = state.relations.get(key);
      // A shift over a pair the state does not hold is a no-op rather than an
      // invention: `loadWorld` refuses an effect naming an unknown faction, so
      // reaching this means a hand-built state, and inventing `neutral` here
      // would put a relation in the map that no author declared.
      if (current === undefined) return state;
      const relations = new Map(state.relations);
      relations.set(key, shiftBand(current, effect.delta));
      return { ...state, relations };
    }
    case "advance_calendar":
      return { ...state, day: state.day + effect.days };
  }
}
```

Tasks 3 and 4 append to this file. `applyEffect` is unused until Task 3 —
which eslint's `no-unused-vars` will flag. Write Task 3 in the same session
if that blocks you, or add the function in Task 3 instead; do **not** silence
the rule.

- [ ] **Step 5: Export the module**

In `packages/rules-engine/src/index.ts`, add after the `./character/index.js`
line:

```ts
export * from "./scene/index.js";
```

- [ ] **Step 6: Move the declarations out of `apps/server/src/world/index.ts`**

Delete the `AuthoredWorld` interface (currently at `:106-126`) and the
`pairKey` function (currently at `:132-143`) outright. In their place, add to
the imports:

```ts
import { pairKey } from "@ai-dm/rules-engine";
import type { AuthoredWorld } from "@ai-dm/rules-engine";
```

and, next to the other exports, the re-export:

```ts
/**
 * Re-exported from `@ai-dm/rules-engine`, where both moved when §4.7's step 3
 * scene engine — pure, and forbidden from importing an app — became their
 * consumer. `loadWorld` is what produces an `AuthoredWorld`, so a caller
 * holding the loader should not have to know which package the type was
 * hoisted into. There is still exactly one declaration of each.
 */
export { pairKey };
export type { AuthoredWorld };
```

Verify there is exactly one declaration of each afterwards:

```bash
grep -rn "export function pairKey\|export interface AuthoredWorld" packages apps tools
```

Expected: exactly one line each, both in
`packages/rules-engine/src/scene/authored-world.ts`.

And verify nothing hand-wrote the key format a second time:

```bash
grep -rn '`\${a}|\${b}`\|a < b ?' packages apps tools
```

Expected: exactly one line, in `authored-world.ts`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
corepack enable
pnpm --filter @ai-dm/rules-engine test
pnpm --filter @ai-dm/server test
```

Expected: PASS both. `packages/rules-engine` goes to 16 files. **`apps/server`
must stay at 11 files / 169 passed / 1 skipped** — the move is invisible to
it, and any change in that number means the re-export is not equivalent.

- [ ] **Step 8: Sabotage the clamp, watch it fail, restore**

Change `Math.min(Math.max(shifted, 0), FACTION_BANDS.length - 1)` to
`Math.max(shifted, 0)` and run
`pnpm --filter @ai-dm/rules-engine test scene`.

Expected: the two `clamps at allied` assertions fail and nothing else does. If
they pass, the upper clamp has no test and the test is a decoration. Restore
the line and confirm green.

- [ ] **Step 9: Typecheck and lint the whole tree**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

Both must exit 0. A whole-tree typecheck is the check that the move really
was equivalent — `AuthoredWorld` is referenced across two packages now.

- [ ] **Step 10: Commit, push, open the PR**

```bash
git add packages/rules-engine/src/scene/authored-world.ts \
        packages/rules-engine/src/scene/index.ts \
        packages/rules-engine/src/scene/index.test.ts \
        packages/rules-engine/src/index.ts \
        apps/server/src/world/index.ts
git commit -m "feat(rules-engine): move AuthoredWorld and pairKey, add band arithmetic

The scene engine is pure and may never import apps/server (invariant 5),
and an engine that could not import pairKey would hand-write the relations
map's key format a second time (invariant 4). Both move to
packages/rules-engine/src/scene/; apps/server re-exports them, so no call
site changes.

shiftBand is the clamped band arithmetic content.ts deliberately deferred
to this step. Clamps at both ends of FACTION_BANDS, never wraps."
git push -u origin narrative-step-3-scene-engine
gh pr create --base main --title "§4.7 step 3: the scene engine" \
  --body "Implements docs/superpowers/specs/2026-08-27-scene-engine-design.md. Draft until the plan's tasks are done."
```

Open the PR now, not at the end: **CI triggers only on `push:main` and
`pull_request`**, so every commit before the PR exists is unverified. Mark it
draft if you prefer; it still runs CI.

---

## Task 3: Traversal, on the happy path

**Files:**
- Modify: `packages/rules-engine/src/scene/index.ts`
- Create: `packages/rules-engine/src/scene/test-fixtures.ts`
- Modify: `packages/rules-engine/src/scene/index.test.ts`

**Interfaces:**
- Consumes: `SceneState`, `shiftBand`, `relationBetween`, `evaluatePredicate`, `applyEffect`, `AuthoredWorld`, `pairKey` from Task 2.
- Produces: `SceneRejectionReason`, `SceneRejection`, `SceneTransition`, `EdgeOption`, `startScene(world: AuthoredWorld): SceneTransition`, `availableEdges(world: AuthoredWorld, state: SceneState): readonly EdgeOption[]`, `traverseEdge(world: AuthoredWorld, state: SceneState, to: string): SceneTransition`, `completeCurrentNode(world: AuthoredWorld, state: SceneState): SceneTransition`. Also `linearWorld()` and `blockedWorld()` from `./test-fixtures.js`.

Task 4 is the refusal path. This task builds the graph walk and the fixtures
both tasks share.

- [ ] **Step 1: Write the fixtures**

Create `packages/rules-engine/src/scene/test-fixtures.ts`:

```ts
// Worlds built in TypeScript rather than loaded from `data/world/`. This
// package may not read a file, and a compile-checked fixture is stronger than
// a JSON one for a package that never parses JSON. `src/combat/test-fixtures.ts`
// is the same pattern.
//
// These are NOT miniatures of the shipped Emberfall world. Each exists to put
// a specific input in front of a specific line — the habit step 2's
// whole-branch review prescribed after a fixture built one-defect-per-rule
// left three checks unable to fail.
import type {
  FactionBand,
  FactionDefinition,
  LocationDefinition,
  QuestNode,
} from "@ai-dm/schemas";
import { pairKey } from "./authored-world.js";
import type { AuthoredWorld } from "./authored-world.js";

const HERE: LocationDefinition = {
  locationId: "here",
  nameEnglish: "Here",
  nameHebrew: "כאן",
  descriptionEnglish: "A fixture location.",
};

function faction(factionId: string): FactionDefinition {
  return {
    factionId,
    nameEnglish: factionId,
    nameHebrew: "פלג",
    descriptionEnglish: "A fixture faction.",
  };
}

function node(nodeId: string, rest: Partial<QuestNode> = {}): QuestNode {
  return {
    nodeId,
    titleEnglish: nodeId,
    sceneEnglish: `A fixture node called ${nodeId}.`,
    locationId: "here",
    preconditions: [],
    effects: [],
    edges: [],
    ...rest,
  };
}

function world(
  nodes: readonly QuestNode[],
  options: {
    startingNodeId?: string;
    startingDay?: number;
    relations?: readonly (readonly [string, string, FactionBand])[];
  } = {},
): AuthoredWorld {
  const factionIds = new Set(
    (options.relations ?? []).flatMap(([a, b]) => [a, b]),
  );
  return {
    worldId: "fixture",
    startingDay: options.startingDay ?? 1,
    startingNodeId: options.startingNodeId ?? nodes[0]?.nodeId ?? "start",
    factions: new Map(Array.from(factionIds, (id) => [id, faction(id)])),
    locations: new Map([["here", HERE]]),
    npcs: new Map(),
    questNodes: new Map(nodes.map((each) => [each.nodeId, each])),
    relations: new Map(
      (options.relations ?? []).map(([a, b, band]) => [pairKey(a, b), band]),
    ),
  };
}

/**
 * Three nodes in a line, the middle one gated on the first and carrying both
 * effect kinds. Enough to walk, and enough that "did the effects apply exactly
 * once" has an observable answer.
 */
export function linearWorld(): AuthoredWorld {
  return world(
    [
      node("start", { edges: [{ to: "middle", labelEnglish: "Go on" }] }),
      node("middle", {
        preconditions: [{ kind: "node_completed", nodeId: "start" }],
        effects: [
          { kind: "shift_faction_relation", factionA: "alpha", factionB: "beta", delta: -1 },
          { kind: "advance_calendar", days: 2 },
        ],
        edges: [{ to: "end", labelEnglish: "Finish" }],
      }),
      node("end", {
        effects: [{ kind: "advance_calendar", days: 1 }],
      }),
    ],
    { relations: [["alpha", "beta", "neutral"]] },
  );
}

/**
 * The fixture this step exists for.
 *
 * `start` branches to `open` and `shut`. `shut` demands the two factions be
 * at least `cordial`; they start at `hostile` and nothing shifts them, so the
 * branch is genuinely closed and stays closed. The shipped Emberfall arc
 * CANNOT produce this — `reckoning`'s gate asks for at least `hostile` and
 * `hostile` is the lowest band reachable before it, so an evaluator hard-coded
 * to return true would play that world identically (step 2's whole-branch
 * review).
 *
 * `open` is reachable, so the fixture also proves the closure is specific to
 * the gate rather than to the fixture being broken.
 */
export function blockedWorld(): AuthoredWorld {
  return world(
    [
      node("start", {
        edges: [
          { to: "open", labelEnglish: "The way that works" },
          { to: "shut", labelEnglish: "The way that does not" },
        ],
      }),
      node("open", {
        preconditions: [{ kind: "node_completed", nodeId: "start" }],
      }),
      node("shut", {
        preconditions: [
          {
            kind: "faction_band_at_least",
            factionA: "alpha",
            factionB: "beta",
            band: "cordial",
          },
        ],
      }),
    ],
    { relations: [["alpha", "beta", "hostile"]] },
  );
}
```

- [ ] **Step 2: Write the failing test**

Append to `packages/rules-engine/src/scene/index.test.ts` (add
`availableEdges`, `completeCurrentNode`, `startScene`, `traverseEdge` to the
existing `./index.js` import, and add
`import { blockedWorld, linearWorld } from "./test-fixtures.js";`):

```ts
/**
 * The state from a transition, or a loud failure naming the rejections.
 *
 * `expect.unreachable` is called OUTSIDE any try/catch for the reason
 * `apps/server/src/config.test.ts:36-61` records — but here the reason to
 * factor it out is different and simpler: unwrapping a union inline in twenty
 * assertions is twenty chances to write `transition.state` behind a check that
 * does not narrow.
 */
function stateOf(transition: SceneTransition): SceneState {
  if (!transition.valid) {
    expect.unreachable(
      `expected a valid transition, got: ${transition.rejections.map((r) => r.reason).join(", ")}`,
    );
  }
  return transition.state;
}

describe("startScene", () => {
  it("opens at the manifest's node, day and relations, with nothing completed", () => {
    const world = linearWorld();
    const state = stateOf(startScene(world));
    expect(state.currentNodeId).toBe("start");
    expect(state.day).toBe(1);
    expect(state.completedNodeIds.size).toBe(0);
    expect(relationBetween(state, "alpha", "beta")).toBe("neutral");
  });
});

describe("traverseEdge", () => {
  it("completes the node it leaves and enters the one it names", () => {
    const world = linearWorld();
    const state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    expect(state.currentNodeId).toBe("middle");
    expect(state.completedNodeIds.has("start")).toBe(true);
    // `middle`'s own effects have NOT run — it was entered, not completed.
    expect(state.day).toBe(1);
  });

  // The order that makes the shipped arc playable: `middle` requires
  // `node_completed: start`, and it is reached by leaving `start`. Evaluating
  // preconditions before the current node completes would make the first move
  // of every authored arc illegal.
  it("evaluates the target's preconditions after the current node completes", () => {
    const world = linearWorld();
    const opening = stateOf(startScene(world));
    expect(evaluatePredicate({ kind: "node_completed", nodeId: "start" }, opening)).toBe(false);
    expect(traverseEdge(world, opening, "middle").valid).toBe(true);
  });

  it("applies the leaving node's effects, both kinds", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(state.currentNodeId).toBe("end");
    expect(state.day).toBe(3); // 1 + middle's advance_calendar of 2
    expect(relationBetween(state, "alpha", "beta")).toBe("cold"); // neutral - 1
  });

  it("does not mutate the state it was given", () => {
    const world = linearWorld();
    const before = stateOf(startScene(world));
    traverseEdge(world, before, "middle");
    expect(before.currentNodeId).toBe("start");
    expect(before.completedNodeIds.size).toBe(0);
  });
});

describe("completeCurrentNode", () => {
  // `reckoning` in the shipped arc is terminal AND carries effects. Without
  // this function those effects are declared by an author and applied by
  // nothing.
  it("applies a terminal node's effects", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(state.day).toBe(3);
    state = stateOf(completeCurrentNode(world, state));
    expect(state.completedNodeIds.has("end")).toBe(true);
    expect(state.day).toBe(4); // end's advance_calendar of 1
  });

  // A node re-entered by a cycle must not pump its faction shift a second
  // time. The graph has no cycle today; the guard is what makes adding one
  // safe rather than silently wrong.
  it("is idempotent — effects apply on first completion only", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    const once = stateOf(completeCurrentNode(world, state));
    const twice = stateOf(completeCurrentNode(world, once));
    expect(twice.day).toBe(once.day);
    expect(twice.completedNodeIds.size).toBe(once.completedNodeIds.size);
  });
});

describe("availableEdges", () => {
  it("reports an open edge as open with no rejections", () => {
    const world = linearWorld();
    const options = availableEdges(world, stateOf(startScene(world)));
    expect(options).toHaveLength(1);
    expect(options[0]?.edge.to).toBe("middle");
    expect(options[0]?.open).toBe(true);
    expect(options[0]?.rejections).toEqual([]);
  });

  it("reports every edge, not only the open ones", () => {
    const world = blockedWorld();
    const options = availableEdges(world, stateOf(startScene(world)));
    expect(options.map((each) => each.edge.to)).toEqual(["open", "shut"]);
  });

  it("returns nothing for a terminal node", () => {
    const world = linearWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "middle"));
    state = stateOf(traverseEdge(world, state, "end"));
    expect(availableEdges(world, state)).toEqual([]);
  });
});
```

Add `SceneState` and `SceneTransition` to the type-only import at the top of
the file.

- [ ] **Step 3: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine test scene
```

Expected: FAIL — `startScene`, `traverseEdge`, `completeCurrentNode` and
`availableEdges` are not exported.

- [ ] **Step 4: Append the traversal API to `packages/rules-engine/src/scene/index.ts`**

```ts
export type SceneRejectionReason = "no_such_node" | "no_such_edge" | "precondition_unmet";

export interface SceneRejection {
  reason: SceneRejectionReason;
  /** English detail, for step 4's retry prompt and for an operator's log. */
  message: string;
  /** The node this rejection concerns, when there is one. */
  subjectId?: string;
}

/**
 * What a move resolves to. Nothing throws for a refusal, for the reason
 * `validateExecuteTurn` does not: the caller is a retry loop around a model,
 * and a refusal it has to read and explain is data rather than an exception.
 *
 * A rejection list carries EVERY failed precondition, not the first — the
 * same argument `WorldContentError` makes about defects.
 */
export type SceneTransition =
  | { valid: true; state: SceneState }
  | { valid: false; rejections: SceneRejection[] };

export interface EdgeOption {
  edge: QuestEdge;
  /** True exactly when `traverseEdge` to this edge's target would succeed. */
  open: boolean;
  /** Empty when `open`. Why not, otherwise. */
  rejections: readonly SceneRejection[];
}

/** Why entering `nodeId` from `state` would be refused. Empty means it would not. */
function entryRejections(
  world: AuthoredWorld,
  state: SceneState,
  nodeId: string,
): SceneRejection[] {
  const node = world.questNodes.get(nodeId);
  if (node === undefined) {
    return [
      { reason: "no_such_node", message: `no quest node "${nodeId}"`, subjectId: nodeId },
    ];
  }
  return node.preconditions
    .filter((precondition) => !evaluatePredicate(precondition, state))
    .map((precondition) => ({
      reason: "precondition_unmet" as const,
      message: `entering "${nodeId}" requires ${describePredicate(precondition)}`,
      subjectId: nodeId,
    }));
}

/** English, for a rejection message. Same no-`default` exhaustiveness contract. */
function describePredicate(predicate: WorldPredicate): string {
  switch (predicate.kind) {
    case "node_completed":
      return `"${predicate.nodeId}" to be completed`;
    case "faction_band_at_least":
      return `${predicate.factionA} and ${predicate.factionB} to be at least ${predicate.band}`;
  }
}

/**
 * The state a node completing produces: itself marked done and its effects
 * applied — but only the first time, so a cycle cannot pump a faction shift
 * twice.
 */
function completed(node: QuestNode, state: SceneState): SceneState {
  if (state.completedNodeIds.has(node.nodeId)) return state;
  const completedNodeIds = new Set(state.completedNodeIds);
  completedNodeIds.add(node.nodeId);
  return node.effects.reduce<SceneState>(
    (each, effect) => applyEffect(effect, each),
    { ...state, completedNodeIds },
  );
}

/**
 * The campaign's opening state, or why the authored world has no enterable
 * entry point.
 *
 * Total rather than throwing on a missing start node, so `loadWorld` can call
 * it as a check rather than as a thing to catch.
 */
export function startScene(world: AuthoredWorld): SceneTransition {
  const state: SceneState = {
    currentNodeId: world.startingNodeId,
    completedNodeIds: new Set<string>(),
    relations: world.relations,
    day: world.startingDay,
  };
  const rejections = entryRejections(world, state, world.startingNodeId);
  if (rejections.length > 0) return { valid: false, rejections };
  return { valid: true, state };
}

/**
 * Every edge out of the current node, each with whether it can be taken.
 *
 * Returns the closed ones too: step 4's router has to be able to say why a
 * choice is unavailable, and a caller wanting only the open ones filters in
 * one line. It shares `entryRejections` with `traverseEdge`, so what this
 * calls open and what that accepts cannot drift apart.
 */
export function availableEdges(
  world: AuthoredWorld,
  state: SceneState,
): readonly EdgeOption[] {
  const current = world.questNodes.get(state.currentNodeId);
  if (current === undefined) return [];
  const after = completed(current, state);
  return current.edges.map((edge) => {
    const rejections = entryRejections(world, after, edge.to);
    return { edge, open: rejections.length === 0, rejections };
  });
}

/**
 * Leave the current node by an edge: complete it, then enter the target.
 *
 * Preconditions are evaluated against the POST-completion state because
 * `content.ts` says predicates gate the node and "traversing an edge is
 * entering its target" — the shipped arc's second node requires the first to
 * be completed and is reached by leaving it, so any other order makes every
 * authored arc illegal at its first move.
 *
 * Nothing is committed when the target refuses: the returned rejections
 * describe a move that did not happen.
 */
export function traverseEdge(
  world: AuthoredWorld,
  state: SceneState,
  to: string,
): SceneTransition {
  const current = world.questNodes.get(state.currentNodeId);
  if (current === undefined) {
    return {
      valid: false,
      rejections: [
        {
          reason: "no_such_node",
          message: `no quest node "${state.currentNodeId}"`,
          subjectId: state.currentNodeId,
        },
      ],
    };
  }
  if (!current.edges.some((edge) => edge.to === to)) {
    return {
      valid: false,
      rejections: [
        {
          reason: "no_such_edge",
          message: `"${state.currentNodeId}" has no edge to "${to}"`,
          subjectId: to,
        },
      ],
    };
  }
  const after = completed(current, state);
  const rejections = entryRejections(world, after, to);
  if (rejections.length > 0) return { valid: false, rejections };
  return { valid: true, state: { ...after, currentNodeId: to } };
}

/**
 * Finish the current node without leaving it. What applies a terminal node's
 * effects — the shipped arc's `reckoning` has effects and no edges, so without
 * this they are declared by an author and applied by nothing.
 *
 * Idempotent, through the same first-completion guard as traversal.
 */
export function completeCurrentNode(
  world: AuthoredWorld,
  state: SceneState,
): SceneTransition {
  const current = world.questNodes.get(state.currentNodeId);
  if (current === undefined) {
    return {
      valid: false,
      rejections: [
        {
          reason: "no_such_node",
          message: `no quest node "${state.currentNodeId}"`,
          subjectId: state.currentNodeId,
        },
      ],
    };
  }
  return { valid: true, state: completed(current, state) };
}
```

Add `QuestEdge` and `QuestNode` to the type-only `@ai-dm/schemas` import, and
`AuthoredWorld` to the `./authored-world.js` type import at the top of the
file.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine test
```

Expected: PASS, 16 files.

- [ ] **Step 6: Sabotage the first-completion guard, watch it fail, restore**

Delete the `if (state.completedNodeIds.has(node.nodeId)) return state;` line
from `completed` and run `pnpm --filter @ai-dm/rules-engine test scene`.

Expected: the `is idempotent` assertion fails and nothing else does. If
everything still passes, idempotency has no test. Restore and confirm green.

- [ ] **Step 7: Typecheck and lint**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 8: Commit**

```bash
git add packages/rules-engine/src/scene/index.ts \
        packages/rules-engine/src/scene/test-fixtures.ts \
        packages/rules-engine/src/scene/index.test.ts
git commit -m "feat(rules-engine): walk the quest graph

startScene, traverseEdge, completeCurrentNode and availableEdges. A
traversal completes the node it leaves — applying its effects, once — and
then evaluates the target's preconditions against that state, which is the
order the authored arc requires.

completeCurrentNode exists because a terminal node carries effects that no
edge would ever apply."
```

---

## Task 4: The refusal path

**Files:**
- Modify: `packages/rules-engine/src/scene/index.test.ts`

**Interfaces:**
- Consumes: everything Tasks 2 and 3 produced, plus `blockedWorld()` and `linearWorld()` from `./test-fixtures.js`.
- Produces: no new exports. Tests only.

No implementation. Task 3 wrote the refusal branches; this task proves each of
them can actually be reached, which is the thing step 2 shipped three failures
of.

- [ ] **Step 1: Write the failing tests**

Append to `packages/rules-engine/src/scene/index.test.ts`:

```ts
/**
 * The rejections from a transition, or a loud failure if it succeeded.
 *
 * The mirror of `stateOf`, and the reason both exist: a union unwrapped
 * inline is a union that can be read behind a check that does not narrow.
 */
function rejectionsOf(transition: SceneTransition): readonly SceneRejection[] {
  if (transition.valid) {
    expect.unreachable(`expected a refusal, got node "${transition.state.currentNodeId}"`);
  }
  return transition.rejections;
}

describe("refusing a traversal", () => {
  it("refuses an edge the current node does not have", () => {
    const world = linearWorld();
    const rejections = rejectionsOf(
      traverseEdge(world, stateOf(startScene(world)), "end"),
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("no_such_edge");
    expect(rejections[0]?.subjectId).toBe("end");
  });

  it("refuses an edge to a node that does not exist", () => {
    const world = blockedWorld();
    const rejections = rejectionsOf(
      traverseEdge(world, stateOf(startScene(world)), "nowhere"),
    );
    // `start` has no edge to "nowhere", so this is the edge check, not the
    // node check — the two reasons are distinguishable and this pins which
    // one fires first.
    expect(rejections[0]?.reason).toBe("no_such_edge");
  });

  // The test this whole step exists for. `shut` demands `cordial` and the
  // pair is at `hostile` with nothing to shift it. An evaluator hard-coded to
  // return true for `faction_band_at_least` passes every other test in this
  // repo and fails exactly this one.
  it("refuses a traversal whose faction gate is not met", () => {
    const world = blockedWorld();
    const rejections = rejectionsOf(
      traverseEdge(world, stateOf(startScene(world)), "shut"),
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("precondition_unmet");
    expect(rejections[0]?.subjectId).toBe("shut");
    expect(rejections[0]?.message).toContain("cordial");
  });

  it("leaves the state untouched when the target refuses", () => {
    const world = blockedWorld();
    const before = stateOf(startScene(world));
    traverseEdge(world, before, "shut");
    expect(before.currentNodeId).toBe("start");
    expect(before.completedNodeIds.has("start")).toBe(false);
  });

  // The sibling branch is open from the same state, so the closure above is
  // the gate refusing and not the fixture being broken.
  it("still allows the open branch from the same state", () => {
    const world = blockedWorld();
    expect(traverseEdge(world, stateOf(startScene(world)), "open").valid).toBe(true);
  });

  // Two unmet preconditions on one node is a shape no authored content has,
  // so this replaces the fixture's node rather than adding a fixture world
  // that exists only to hold it. Both kinds, so a bug that reported only one
  // branch of `entryRejections`' filter would show up here.
  it("names every unmet precondition, not the first", () => {
    const gated: AuthoredWorld = {
      ...linearWorld(),
      startingNodeId: "gate",
      questNodes: new Map([
        [
          "gate",
          {
            nodeId: "gate",
            titleEnglish: "Gate",
            sceneEnglish: "Two gates, both shut.",
            locationId: "here",
            preconditions: [
              { kind: "node_completed", nodeId: "never" },
              {
                kind: "faction_band_at_least",
                factionA: "alpha",
                factionB: "beta",
                band: "allied",
              },
            ],
            effects: [],
            edges: [],
          },
        ],
      ]),
    };
    const rejections = rejectionsOf(startScene(gated));
    expect(rejections).toHaveLength(2);
    expect(rejections.every((each) => each.reason === "precondition_unmet")).toBe(true);
  });
});

describe("availableEdges under a closed gate", () => {
  it("marks the closed edge closed and the open one open", () => {
    const world = blockedWorld();
    const options = availableEdges(world, stateOf(startScene(world)));
    const byTarget = new Map(options.map((each) => [each.edge.to, each]));
    expect(byTarget.get("open")?.open).toBe(true);
    expect(byTarget.get("shut")?.open).toBe(false);
    expect(byTarget.get("shut")?.rejections[0]?.reason).toBe("precondition_unmet");
  });

  // The two must agree by construction — they share `entryRejections` — and
  // this is what would catch someone "optimising" one of them apart from the
  // other.
  it("agrees with traverseEdge on every edge", () => {
    const world = blockedWorld();
    const state = stateOf(startScene(world));
    for (const option of availableEdges(world, state)) {
      expect(traverseEdge(world, state, option.edge.to).valid).toBe(option.open);
    }
  });
});

describe("startScene on a world it cannot open", () => {
  // Exactly the hazard step 2 left open: a start node gated on its own
  // completion loads clean and yields no enterable entry point. Task 5 makes
  // `loadWorld` refuse it; this is the evaluator half.
  it("refuses a start node that requires its own completion", () => {
    const world = linearWorld();
    const selfGated: AuthoredWorld = {
      ...world,
      questNodes: new Map([
        [
          "start",
          {
            nodeId: "start",
            titleEnglish: "Start",
            sceneEnglish: "A node that requires itself.",
            locationId: "here",
            preconditions: [{ kind: "node_completed", nodeId: "start" }],
            effects: [],
            edges: [],
          },
        ],
      ]),
    };
    const rejections = rejectionsOf(startScene(selfGated));
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("precondition_unmet");
  });

  it("refuses a starting node id that resolves to nothing", () => {
    const world = linearWorld();
    const rejections = rejectionsOf(
      startScene({ ...world, startingNodeId: "no-such-node" }),
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("no_such_node");
  });
});
```

Add `SceneRejection` and `AuthoredWorld` to the type-only `./index.js` import.
`QuestNode` is not needed — the node literal above is inferred.

- [ ] **Step 2: Run to verify — some pass, and that is the point**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine test scene
```

These test branches Task 3 already wrote, so they should pass on the first
run. **A test that passes immediately has proved nothing yet** — Step 3 is
what turns each one into a check.

- [ ] **Step 3: Sabotage each branch in turn, one at a time**

For each, make the edit, run
`pnpm --filter @ai-dm/rules-engine test scene`, confirm **exactly** the named
assertions fail, then restore and confirm green before the next.

| Sabotage | Must fail |
|---|---|
| `evaluatePredicate`'s `faction_band_at_least` branch → `return true` | `refuses a traversal whose faction gate is not met`, `marks the closed edge closed`, `names every unmet precondition` |
| `evaluatePredicate`'s `node_completed` branch → `return true` | `evaluates the target's preconditions after the current node completes`, `refuses a start node that requires its own completion`, `names every unmet precondition` |
| `entryRejections`' `.filter(...)` → `.filter(() => false)` | every `precondition_unmet` assertion above |
| `traverseEdge`'s `no_such_edge` guard deleted | `refuses an edge the current node does not have`, `refuses an edge to a node that does not exist` |
| `startScene`'s `if (rejections.length > 0)` deleted | both `startScene on a world it cannot open` cases |
| `entryRejections`' `no_such_node` branch → `return []` | `refuses a starting node id that resolves to nothing` |

`agrees with traverseEdge` is deliberately not listed against the
`faction_band_at_least` row above: it was predicted there originally, and
execution proved that prediction wrong — the test stayed green under that
sabotage. Both `availableEdges` and `traverseEdge` call the same
`entryRejections`, so a bug inside that shared evaluator flips both sides of
the comparison together and the equality still holds. The test is a
mutual-consistency check between the two callers, not a correctness check on
the evaluator itself — it cannot catch a shared-helper bug, only a bug where
the two callers disagree with each other. It stays in the suite as a guard
against `availableEdges` and `traverseEdge` being reimplemented apart.

**If any sabotage leaves the suite green, that branch has no test.** Write one
before moving on — that is the finding this whole plan is shaped around, and
it is worth more than finishing the task on time.

- [ ] **Step 4: Confirm coverage did not drop**

```bash
pnpm --filter @ai-dm/rules-engine test:coverage 2>&1 | grep -E "scene|All files"
```

`src/scene/` should be at or above the package's ≥90% line target. An
uncovered line here is a branch no input reaches.

- [ ] **Step 5: Typecheck and lint**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 6: Commit**

```bash
git add packages/rules-engine/src/scene/index.test.ts
git commit -m "test(rules-engine): prove every scene refusal can be reached

The blocked-gate fixture is the one the shipped Emberfall arc cannot
produce: reckoning's gate asks for at least hostile and hostile is the
lowest band reachable before it, so an evaluator hard-coded to return true
would play that world identically.

Every refusal branch was sabotaged and confirmed to fail exactly the
assertions naming it."
```

---

## Task 5: `loadWorld` refuses an unenterable world

**Files:**
- Modify: `apps/server/src/world/index.ts`
- Modify: `apps/server/src/world/index.test.ts`
- Create: `data/world/fixtures/unenterable-start/{world,factions,locations,npcs,arc}.json`
- Modify: `data/world/README.md`

**Interfaces:**
- Consumes: `startScene` from `@ai-dm/rules-engine`; `loadWorld` and `WorldContentError` from `apps/server/src/world/index.ts`.
- Produces: no new exports. `loadWorld` gains one refusal reason.

- [ ] **Step 1: Write the fixture world**

Create `data/world/fixtures/unenterable-start/world.json`:

```json
{
  "worldId": "unenterable-start",
  "startingDay": 1,
  "startingNodeId": "start",
  "factionRelations": [
    { "factionA": "alpha", "factionB": "beta", "band": "cold" }
  ]
}
```

`data/world/fixtures/unenterable-start/factions.json`:

```json
[
  { "factionId": "alpha", "nameEnglish": "Alpha", "nameHebrew": "אלפא", "descriptionEnglish": "A fixture faction." },
  { "factionId": "beta", "nameEnglish": "Beta", "nameHebrew": "בטא", "descriptionEnglish": "A fixture faction." }
]
```

`data/world/fixtures/unenterable-start/locations.json`:

```json
[
  { "locationId": "here", "nameEnglish": "Here", "nameHebrew": "כאן", "descriptionEnglish": "A fixture location." }
]
```

`data/world/fixtures/unenterable-start/npcs.json`:

```json
[]
```

`data/world/fixtures/unenterable-start/arc.json`:

```json
[
  {
    "nodeId": "start",
    "titleEnglish": "Start",
    "sceneEnglish": "The starting node, gated on its own completion. It can never be entered, so this world can never be played.",
    "locationId": "here",
    "preconditions": [{ "kind": "node_completed", "nodeId": "start" }]
  }
]
```

**This world is otherwise perfect.** Every id resolves, the one faction pair
is declared exactly once, no duplicates. That is deliberate and it is what
makes the test able to assert the start-node problem is the *only* problem —
the seventeen-defect fixture proves the checks compose, and this one proves
this check fires.

- [ ] **Step 2: Write the failing test**

Append to `apps/server/src/world/index.test.ts` (the file already defines
`problemsFrom` and the `BROKEN` path constant; reuse them):

```ts
const UNENTERABLE = join(
  dataDir(join("data", "world")),
  "fixtures",
  "unenterable-start",
);

describe("loadWorld's start-node check", () => {
  // The hazard step 2 recorded and left open: `startingNodeId` pointing at a
  // node gated on its own completion loads clean and yields a world with no
  // enterable entry point. Cross-referencing cannot see it — every id
  // resolves — so it takes an evaluator, which is why the check lands with
  // step 3 and not with step 2.
  it("refuses a world whose starting node can never be entered", () => {
    const problems = problemsFrom(UNENTERABLE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("startingNodeId");
    expect(problems[0]).toContain("start");
  });

  // The check runs only over a world that is otherwise sound: evaluating
  // preconditions across dangling ids produces noise about a graph already
  // known to be broken, and a dangling startingNodeId would be reported twice
  // in two wordings.
  it("leaves the broken-references fixture's problem count untouched", () => {
    expect(problemsFrom(BROKEN)).toHaveLength(17);
  });

  it("still loads the authored world", () => {
    expect(loadWorld().startingNodeId).toBe("arrival");
  });
});
```

If the existing exhaustive assertion in this file already pins seventeen
problems, the second case duplicates it — check first and drop it if so
rather than asserting the same thing twice.

- [ ] **Step 3: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test world
```

Expected: FAIL — the fixture loads cleanly today, so `problemsFrom` hits its
`expect.unreachable` for a load that did not throw.

- [ ] **Step 4: Add the check to `apps/server/src/world/index.ts`**

Add `startScene` to the `@ai-dm/rules-engine` import, then insert immediately
before the existing `if (problems.length > 0) throw ...` line:

```ts
  // A world can cross-reference perfectly and still have no way in: a
  // starting node gated on its own completion resolves every id it names and
  // can never be entered. Cross-referencing cannot see that — it takes an
  // evaluator, which is why this check arrives with §4.7's step 3 rather than
  // with the loader itself.
  //
  // Only over a world that is otherwise sound. Evaluating preconditions
  // across dangling ids describes a graph already known to be broken, and a
  // dangling `startingNodeId` would be reported twice in two wordings.
  if (problems.length === 0) {
    const opening = startScene({
      worldId: manifest.worldId,
      startingDay: manifest.startingDay,
      startingNodeId: manifest.startingNodeId,
      factions,
      locations,
      npcs,
      questNodes,
      relations,
    });
    if (!opening.valid) {
      for (const rejection of opening.rejections) {
        problems.push(`world.json startingNodeId is unenterable: ${rejection.message}`);
      }
    }
  }
```

The world object is built twice — once here and once below. Leave it: hoisting
it above the `problems` check means constructing an `AuthoredWorld` from
content already known to be broken, and the duplication is five fields in one
function rather than a shape declared twice.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test
```

Expected: PASS. `apps/server` stays at 11 files with the new cases added.

- [ ] **Step 6: Sabotage the check, watch it fail, restore**

Change `if (!opening.valid)` to `if (false)` — or delete the whole block —
and run `pnpm --filter @ai-dm/server test world`.

Expected: the `refuses a world whose starting node can never be entered` case
fails and nothing else does. Restore and confirm green.

- [ ] **Step 7: Document the fixture**

In `data/world/README.md`, under the existing `fixtures/` section, add:

```markdown
`fixtures/unenterable-start/` is a world that cross-references perfectly and
still cannot be played: its `startingNodeId` names a node gated on its own
completion, so nothing can ever enter it. Every id in it resolves — that is
the point. It exists so `loadWorld`'s start-node check has something to
refuse, and `apps/server/src/world/index.test.ts` asserts it produces exactly
one problem. **Do not fix it.**
```

Read the section's existing wording first and match it — the file already
explains that `fixtures/broken-references/` is broken on purpose, and the two
paragraphs should read as siblings.

- [ ] **Step 8: Typecheck and lint**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/world/index.ts apps/server/src/world/index.test.ts \
        data/world/fixtures/unenterable-start data/world/README.md
git commit -m "feat(server): refuse a world whose starting node cannot be entered

Step 2 left this open: startingNodeId naming a node gated on its own
completion cross-references perfectly and yields no enterable entry point.
Seeing it takes an evaluator, which is why the check arrives now.

Runs only over a world with no other problem, so the broken-references
fixture still reports exactly its seventeen."
```

---

## Task 6: The arc plays, end to end

**Files:**
- Create: `apps/server/src/world/arc.test.ts`

**Interfaces:**
- Consumes: `loadWorld` from `./index.js`; `availableEdges`, `completeCurrentNode`, `relationBetween`, `startScene`, `traverseEdge` from `@ai-dm/rules-engine`.
- Produces: no exports. The golden test over real content.

The engine's own tests use TS fixtures because the rules engine may not read a
file. This is the test that plays the world an author actually edits, and it
is what turns a changed `delta` in `arc.json` into a failing test rather than
a silent ship. Step 2 could only assert this arithmetic in a comment.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/world/arc.test.ts`:

```ts
// The authored Emberfall arc, played by the scene engine, both branches, to
// their terminal states.
//
// It lives in `apps/server` because this is the only package that may read
// `data/world/` — `@ai-dm/rules-engine` forbids I/O, so its own tests use
// TypeScript fixtures. This is the half those fixtures cannot cover: whether
// the world a human edits actually plays.
//
// §4.7 step 2 shipped this arithmetic asserted only in a plan comment,
// because nothing evaluated a predicate yet. These are the same numbers,
// now executable.
import { describe, expect, it } from "vitest";
import {
  availableEdges,
  completeCurrentNode,
  relationBetween,
  startScene,
  traverseEdge,
} from "@ai-dm/rules-engine";
import type { SceneState, SceneTransition } from "@ai-dm/rules-engine";
import { loadWorld } from "./index.js";

function stateOf(transition: SceneTransition): SceneState {
  if (!transition.valid) {
    expect.unreachable(
      `expected a valid transition, got: ${transition.rejections.map((r) => r.message).join("; ")}`,
    );
  }
  return transition.state;
}

describe("the Emberfall arc", () => {
  it("opens at arrival, day 1, with the factions cold", () => {
    const world = loadWorld();
    const state = stateOf(startScene(world));
    expect(state.currentNodeId).toBe("arrival");
    expect(state.day).toBe(1);
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("cold");
  });

  it("offers both branches from arrival, both open", () => {
    const world = loadWorld();
    const options = availableEdges(world, stateOf(startScene(world)));
    expect(options.map((each) => each.edge.to).sort()).toEqual([
      "guild-offer",
      "warden-warning",
    ]);
    expect(options.every((each) => each.open)).toBe(true);
  });

  // Guild branch: guild-offer shifts the pair -1 from cold to hostile, and
  // nothing on this branch advances the calendar before reckoning.
  it("plays the guild branch to day 3 and neutral", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "guild-offer"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    expect(state.day).toBe(1);
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("hostile");

    state = stateOf(traverseEdge(world, state, "reckoning"));
    expect(state.currentNodeId).toBe("reckoning");
    state = stateOf(completeCurrentNode(world, state));
    // reckoning: +2 bands from hostile, +2 days from 1.
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("neutral");
    expect(state.day).toBe(3);
    expect(availableEdges(world, state)).toEqual([]);
  });

  // Warden branch: warden-warning advances a day and shifts nothing.
  it("plays the warden branch to day 4 and cordial", () => {
    const world = loadWorld();
    let state = stateOf(traverseEdge(world, stateOf(startScene(world)), "warden-warning"));
    state = stateOf(traverseEdge(world, state, "the-weir"));
    expect(state.day).toBe(2);
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("cold");

    state = stateOf(traverseEdge(world, state, "reckoning"));
    state = stateOf(completeCurrentNode(world, state));
    // reckoning: +2 bands from cold, +2 days from 2.
    expect(relationBetween(state, "ashen-guild", "river-wardens")).toBe("cordial");
    expect(state.day).toBe(4);
  });

  // Two branches that end in the same place would make every assertion above
  // a tautology. This is what says the graph is a graph.
  it("ends the two branches in different world states", () => {
    const world = loadWorld();
    const play = (second: string): SceneState => {
      let state = stateOf(traverseEdge(world, stateOf(startScene(world)), second));
      state = stateOf(traverseEdge(world, state, "the-weir"));
      state = stateOf(traverseEdge(world, state, "reckoning"));
      return stateOf(completeCurrentNode(world, state));
    };
    const guild = play("guild-offer");
    const warden = play("warden-warning");
    expect(guild.day).not.toBe(warden.day);
    expect(
      relationBetween(guild, "ashen-guild", "river-wardens"),
    ).not.toBe(relationBetween(warden, "ashen-guild", "river-wardens"));
  });

  // reckoning's gate asks for at least `hostile`, and `hostile` is the LOWEST
  // band reachable before it, so it passes on both branches. That is not a
  // bug — it is the gate being satisfiable, which the arc intends — but it
  // does mean this file cannot prove the gate works. `blockedWorld()` in
  // packages/rules-engine/src/scene/test-fixtures.ts is what does.
  it("reaches reckoning on both branches, so the gate is never the blocker", () => {
    const world = loadWorld();
    for (const second of ["guild-offer", "warden-warning"]) {
      let state = stateOf(traverseEdge(world, stateOf(startScene(world)), second));
      state = stateOf(traverseEdge(world, state, "the-weir"));
      const options = availableEdges(world, state);
      expect(options).toHaveLength(1);
      expect(options[0]?.open).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test arc
```

Expected: FAIL — the file does not exist yet, so this is a first run rather
than a red-then-green. If it passes on the first run, that is correct and
expected here: Tasks 3 and 4 built the behaviour. Step 3 is what makes it a
check.

- [ ] **Step 3: Sabotage the content, watch it fail, restore**

The point of this file is that editing `data/world/arc.json` breaks a test.
Prove it: change `reckoning`'s `shift_faction_relation` `delta` from `2` to
`1` and run `pnpm --filter @ai-dm/server test arc`.

Expected: both branch cases fail on the band, and
`ends the two branches in different world states` still passes. Restore and
confirm green.

Then change `warden-warning`'s `advance_calendar` `days` from `1` to `0`.

Expected: it fails to **parse** — the schema requires `days ≥ 1` — so
`loadWorld` throws a `ZodError` before the engine sees it. That is the schema
doing its job, and it is worth seeing once. Restore.

- [ ] **Step 4: Run the full suite**

```bash
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
```

Expected: 94 files, and no package below its Task 1 baseline.

- [ ] **Step 5: Typecheck and lint**

```bash
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/world/arc.test.ts
git commit -m "test(server): play the authored arc end to end, both branches

Step 2 shipped this arithmetic asserted only in a plan comment, because
nothing evaluated a predicate. Editing a delta in arc.json now fails a
test instead of shipping silently.

The two branches end at day 3/neutral and day 4/cordial — different world
states, which is what makes the assertions above non-tautological."
```

---

## Task 7: Docs sweep and final verification

**Files:**
- Modify: `packages/rules-engine/CLAUDE.md`
- Modify: `PROJECT_PLAN.md` (§4.7 sequence entry 3)
- Modify: `docs/superpowers/plans/2026-08-27-scene-engine.md` (this file's Outcomes)

- [ ] **Step 1: Narrow `packages/rules-engine/CLAUDE.md`**

Its Purpose line says "Pure, deterministic D&D 5e mechanics: dice,
checks/saves, attack resolution, action economy, conditions, grid/pathfinding/
LoS/cover" and its Modules list names four directories, of which the package
has had six for some time. Both now describe two-thirds of the package.

Add to the Purpose paragraph, after the existing first sentence:

```markdown
It is also the only authority on **campaign** legality: `scene/` evaluates the
quest graph's predicates and applies its declared effects (`PROJECT_PLAN.md`
§4.7), the same propose-then-validate contract one level above combat.
```

And add to the Modules list:

```markdown
- `scene/` — the scene engine: quest-graph traversal, `WorldPredicate`
  evaluation, `WorldEffect` application, clamped faction-band arithmetic.
  Holds `AuthoredWorld` and `pairKey`, which `apps/server`'s `loadWorld`
  produces and re-exports.
```

A boundary document that describes two-thirds of its package is how the next
person puts a file in the wrong place.

- [ ] **Step 2: Sweep for claims this branch falsified**

Sweep **by shape, not by wording** — step 2's review found a count wrong in
four documents because the first sweep matched one phrase. Search the repo
root too: `RULES_REFERENCE.md` and `CLAUDE.md` are in none of `packages`,
`apps`, `tools`, `docs`, and that is exactly how a stale claim survived step 2.

```bash
grep -rn "scene engine" --include="*.md" --include="*.ts" . \
  | grep -v node_modules | grep -v ".claude/worktrees"
grep -rn "AuthoredWorld\|pairKey" --include="*.md" . \
  | grep -v node_modules | grep -v ".claude/worktrees"
```

Every hit saying the scene engine does not exist, is "still ahead", or lives
in `apps/server` is now false. Fix each in place.

**Do not touch `packages/memory/CLAUDE.md`** even though its Stack bullet is
one of the false ones — it carries someone else's uncommitted edit in the main
checkout, and staging it would sweep their prose into this PR. Note it in the
PR description instead, exactly as step 2 did.

- [ ] **Step 3: Update `PROJECT_PLAN.md` §4.7 sequence entry 3**

Replace the bare line

```markdown
3. **Scene engine:** predicates, edge legality, declared effects. Pure,
   golden tests, no LLM.
```

with the merged form the entries above it use — **do not guess the date, sha
or counts; fill them from the actual merge**:

```markdown
3. **Scene engine:** predicates, edge legality, declared effects. Pure,
   golden tests, no LLM. **Merged to `main`** <date> as `<sha>`, CI green
   with Postgres at <passed> passed / 0 skipped / <files> files.
   [`docs/superpowers/specs/2026-08-27-scene-engine-design.md`](docs/superpowers/specs/2026-08-27-scene-engine-design.md),
   plan at
   [`docs/superpowers/plans/2026-08-27-scene-engine.md`](docs/superpowers/plans/2026-08-27-scene-engine.md).
```

- [ ] **Step 4: Full verification, both ways**

```bash
corepack enable
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
DATABASE_URL=postgres://localhost:5432/aidm_step3 pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL"
pnpm typecheck && npx eslint packages apps tools && echo "LINT+TYPES OK"
```

**Docker cannot pull images on this machine.** Use the running Homebrew
Postgres 18 and a scratch database — `createdb aidm_step3` — never
`docker compose up`. **Never migrate the `aidm` database**: it holds a
pre-rename schema and someone else's data.

Expected without `DATABASE_URL`: 94 files, 30 skipped, no package below
baseline. With it: 0 skipped and `packages/memory` at 62/62.

- [ ] **Step 5: Record the Outcomes**

Fill in this plan's Outcomes table below with the real commits and counts.

- [ ] **Step 6: Commit and take the PR out of draft**

```bash
git add packages/rules-engine/CLAUDE.md PROJECT_PLAN.md \
        docs/superpowers/plans/2026-08-27-scene-engine.md
git commit -m "docs: record the scene engine

rules-engine's CLAUDE.md described two-thirds of its package; scene/ is
named in both its Purpose and its Modules list now.

PROJECT_PLAN.md §4.7 sequence entry 3 carries its merge status."
git push
gh pr ready
```

---

## Outcomes

Recorded as each task closes, in the style of steps 1 and 2. The commits named
here exist in git whether or not this file is read again.

| Task | Commits | Result |
|---|---|---|
| 1 Baseline | — | 93 files, 1335 passed, 30 skipped; typecheck and eslint 0. Fresh worktree needed `pnpm install` first. |
| 2 Move + band arithmetic | `e03dbc2` | Review clean first pass. 94 files, 1343 passed. |
| 3 Traversal | `ced41f4` | Review clean first pass (one Important finding deferred into Task 4 by controller ruling). 94 files, 1353 passed. |
| 4 Refusal path | `ddc4e7c`, `d0b37b6` | One fix round — the faction gate had no *passing* case, so `>` instead of `>=` would have shipped green. 11 sabotage rows run; 2 of the plan's own predictions were wrong. 94 files, 1371 passed. `src/scene` reached 100% lines. |
| 5 Loader start check | `dd1ac08` | Review clean first pass. 94 files, 1371 passed. |
| 6 End-to-end arc | `5c6df06` | Review clean first pass; reviewer independently re-derived both branches' arithmetic. 95 files, 1377 passed. |
| 7 Docs sweep | this commit | Sweep of every "scene engine"/`AuthoredWorld`/`pairKey` hit outside `packages/memory/CLAUDE.md` (excluded per controller instruction — someone else's uncommitted edit). Postgres run (migrated onto scratch `aidm_step3`): 95 files, 1407 passed, **0 skipped**, `packages/memory` 62/62. Without `DATABASE_URL`: 95 files, 1377 passed, 30 skipped. `pnpm typecheck` and `npx eslint packages apps tools` both exit 0. |

---

## Self-review

Run against the spec after writing, before executing.

**Spec coverage.** Every numbered decision maps to a task: 1 (engine is a
rules-engine module) → Tasks 2 and 7; 2 (`AuthoredWorld`/`pairKey` move and
re-export) → Task 2; 3 (`SceneState` is an interface) → Task 2; 4 (seven
functions, refusal-as-value, `applyEffect` unexported, `availableEdges`
returns closed edges) → Tasks 2, 3 and 4; 5 (traversal completes then enters,
first-completion-only effects, `completeCurrentNode` for terminal nodes) →
Task 3; 6 (clamped band arithmetic, one implementation, `undefined` pair is
false) → Task 2; 7 (`loadWorld`'s start check, runs only over an otherwise
sound world, its own fixture) → Task 5; 8 (fixtures built by what reaches each
line, TS fixtures, sabotage) → Tasks 3, 4 and 5; 9 (end-to-end golden test in
`apps/server`) → Task 6. The spec's "what this must not make worse" is
enforced by the Global Constraints' "No wiring" and "No new predicate or
effect kinds" lines, and by no task naming `reduce`, `pipeline.ts`,
`protocol.ts`, `content.ts` or `POST /campaigns`.

**Placeholders.** The only intentional ones are Task 7 Step 3's `<date>`,
`<sha>`, `<passed>` and `<files>`, which cannot be known before the merge and
are explicitly marked "do not guess".

**Type consistency.** `AuthoredWorld` and `pairKey` are declared in Task 2 and
used in Tasks 2–6. `SceneState`, `shiftBand`, `relationBetween` and
`evaluatePredicate` are declared in Task 2 and used in Tasks 3–6.
`SceneTransition`, `SceneRejection`, `SceneRejectionReason` and `EdgeOption`
are declared in Task 3 and used in Tasks 3–6. `stateOf` is defined in Task 3's
test and reused in Tasks 4 and 6 (Task 6 redefines it — it is a different
file). `rejectionsOf` is defined in Task 4 and used only there. `linearWorld`
and `blockedWorld` are defined in Task 3 and used in Tasks 3 and 4.
`problemsFrom` and `BROKEN` are step 2's, reused in Task 5. `startScene`'s
signature is identical in its declaration (Task 3), its loader call site
(Task 5) and its test uses.

**One risk this plan does not remove.** Task 4's sabotage table is the whole
plan's load-bearing step, and it is the one step whose skipping leaves no
trace: the suite is green either way. An executor under time pressure will be
tempted to mark it done. If the reviewer checks one thing in this branch, it
should be that each sabotage in that table was actually run.

**Two defects this self-review found in the plan itself, fixed inline:**
Task 4's `names every unmet precondition` case originally built its fixture by
spreading `linearWorld()` and mutating one node, which left an unused
intermediate binding that eslint's `no-unused-vars` would reject; and Task 2's
`stateWith` helper originally typed its band parameter as `string`, which
`FACTION_BANDS.indexOf` rejects under `strictTypeChecked`. Both are the same
class — a test helper written loosely enough that the linter, not the test,
is what fails.
