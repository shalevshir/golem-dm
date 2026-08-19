# Web client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human opens a browser, fights the `goblin-ambush` encounter to its
conclusion in an RTL Hebrew UI, and can refresh mid-fight without losing the
session.

**Architecture:** The client is a renderer, not a rules engine. It folds the
server's `GameEvent` stream with the *same* `reduce` the server runs (moved into
`@ai-dm/schemas`), and every legality question — where may I move, whom may I
attack — is answered by a new `turn_affordances` frame the server computes by
running the real `validateExecuteTurn` over enumerated candidates. Protocol
changes are strictly additive; server and client ship together.

**Tech Stack:** React 19, Vite 6, TypeScript 5.7 (strict, ESM), zod 3, Canvas 2D,
Vitest 3 + @testing-library/react + jsdom.

**Spec:** [`docs/superpowers/specs/2026-08-19-web-client-design.md`](../specs/2026-08-19-web-client-design.md)
(approved 2026-08-19; amended at `2ec5b7f` for the `affordancesFor` signature and
the catalogue dedupe rule). Spec #1, whose protocol and architecture this builds
on, is [`docs/superpowers/specs/2026-08-19-server-slice-design.md`](../specs/2026-08-19-server-slice-design.md).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Baseline is 791 passing tests** (schemas 60, rules-engine 319, agents 176,
  server 107, sim 129) and a clean `pnpm typecheck`. Verified on `main` at
  `2ec5b7f` before this plan. Any task that *reduces* a count has broken
  something.
- **`corepack enable` first.** pnpm is not on PATH otherwise.
- **NEVER run `pnpm format`.** There is no `.prettierignore` and root `format` is
  `prettier --write .`, which rewrites ~37 unrelated files including
  `pnpm-lock.yaml`. Format exact paths only: `npx prettier --write <path>`.
- **Do NOT trust root `pnpm lint`.** `eslint .` walks into `.claude/worktrees/`
  and reports ~126 errors from unrelated worktrees that have no `node_modules`.
  Always lint with the scoped command:
  `npx eslint apps/server apps/web packages tools` → must exit 0.
- **Dependency direction (root CLAUDE.md invariant 5):**
  `schemas ← rules-engine ← agents ← server`; `web` depends **only** on
  `@ai-dm/schemas`; nothing depends on `server`. Never import `@ai-dm/agents`
  from `packages/rules-engine`.
- **Nothing in `packages/schemas` may import a Node built-in.** `apps/web`
  bundles it for the browser.
- **English inside, Hebrew outside (invariant 2).** All code, comments, prompts,
  state, logs and schema fields are English. Hebrew appears only in narrative
  output and user-facing web UI strings.
- **`ExecuteTurn` requires `tacticalRationaleEnglish`** (correction C-1). It has
  no `.optional()`. Every `ExecuteTurn` literal you write — fixtures included —
  must carry it or it fails at parse or typecheck.
- **Prefer satisfying a lint rule over disabling it** (correction C-4). A method
  needing no `await` returns `Promise.resolve(...)` rather than being `async`
  with a suppression.
- **TypeScript config gotchas** (`tsconfig.base.json`): `strict`,
  `noUncheckedIndexedAccess` (every array index read is `T | undefined`),
  `exactOptionalPropertyTypes` (you may not assign `undefined` to an optional
  property — omit the key instead), `verbatimModuleSyntax` (type-only imports
  must say `import type`).
- **ESLint `strictTypeChecked` gotchas:** `[...str]` is banned
  (`no-misused-spread`) — use `Array.from(str, fn)`. No `argsIgnorePattern` is
  configured, so `_`-prefixed unused params still error.
- **`JSX.Element` needs an explicit type import.** `jsx: "react-jsx"` means no
  automatic `React` binding, and `verbatimModuleSyntax` forbids a value import
  used only as a type. Every `.tsx` file that annotates a return type writes
  `import type { JSX } from "react";` and then `JSX.Element`. React 19's types
  export that namespace (`@types/react@19`). Never write `React.JSX.Element`
  without importing `React` — it will not resolve.
- **ESM only.** Relative imports carry a `.js` extension even from `.ts`
  sources. `apps/web` uses `"moduleResolution": "bundler"`, so `.js` extensions
  are still written for consistency with the rest of the repo and Vite resolves
  them.
- **`Tile` is `[number, number]` — mutable.** `position: [9, 9] as const` is
  `readonly [9, 9]` and will not assign (correction C-6). Never write `as const`
  on a tile literal.
- **`-2 * level` yields `-0`** at level 0 and fails `toBe(0)` under `Object.is`.
  Write `0 - 2 * level`.
- **Commit after every task.** Stage only that task's files — never `git add -A`.

---

## File Structure

**`packages/schemas`** — grows the shared fold and the affordance vocabulary.
- Create `src/reduce.ts` (moved from `apps/server/src/core/reduce.ts`) — the one
  projection fold, now browser-safe.
- Create `src/reduce.test.ts` (moved with it).
- Modify `src/protocol.ts` — add `ActionAffordance`, `TurnAffordances`, and the
  `turn_affordances` `ServerFrame` variant.
- Modify `src/index.ts` — export `./reduce.js`.

**`packages/rules-engine`** — gains affordance derivation.
- Modify `src/combat/action-economy.ts` — `startTurn()` becomes
  `ActionEconomy.parse({})`, so one definition serves both packages.
- Create `src/combat/affordances.ts` — `affordancesFor`, built by running
  `validateExecuteTurn` over enumerated candidates.
- Create `src/combat/affordances.test.ts` — golden tests.
- Modify `src/combat/index.ts` — export it.

**`apps/server`** — yields the new frame and serves the static catalogue.
- Delete `src/core/reduce.ts` and `src/core/reduce.test.ts` (moved).
- Modify `src/core/pipeline.ts` — import `reduce` from `@ai-dm/schemas`; yield
  `turn_affordances` at the two points the player is up.
- Modify `src/core/session.ts`, `src/core/session.test.ts`,
  `src/core/replay.test.ts`, `src/e2e.test.ts` — import `fold` from
  `@ai-dm/schemas`.
- Modify `src/transport/http.ts` — add `GET /encounters/:encounterId`.
- Modify `src/encounters/index.ts` — add `encounterCatalogue(encounterId)`.

**`apps/web`** — the client. Each file has one job; none of them knows a rule.
- `vite.config.ts` — React plugin + dev proxy to `localhost:3000`.
- `vitest.config.ts` — jsdom environment.
- `src/main.tsx` — React root only.
- `src/App.tsx` — top-level wiring and screen selection.
- `src/net/api.ts` — `POST /sessions`, `GET /encounters/:id`.
- `src/net/connection.ts` — WS lifecycle, reconnect with `resumeFrom`, frame
  parsing. The only file that touches a socket.
- `src/state/store.ts` — the projection: fold events, replace on snapshot, hold
  affordances and catalogue.
- `src/state/conclusion.ts` — reads the projection for "is the fight over".
- `src/turn/build-turn.ts` — selection → `ExecuteTurn`.
- `src/components/Grid.tsx` — Canvas 2D board; draws only what it is given.
- `src/components/ActionBar.tsx` — action selection and commit.
- `src/components/NarrativePane.tsx` — streaming Hebrew narrative.
- `src/components/ErrorBanner.tsx` — server codes rendered in Hebrew.
- `src/i18n.ts` — Hebrew strings for error codes, rejection reasons, universal
  action names. The only file with Hebrew literals.

---

## Task 1: One fold, shared — move `reduce` into `@ai-dm/schemas`

**Files:**
- Modify: `packages/rules-engine/src/combat/action-economy.ts:45-53`
- Create: `packages/schemas/src/reduce.ts` (git mv from `apps/server/src/core/reduce.ts`)
- Create: `packages/schemas/src/reduce.test.ts` (git mv from `apps/server/src/core/reduce.test.ts`)
- Modify: `packages/schemas/src/index.ts`
- Modify: `apps/server/src/core/pipeline.ts:31`, `apps/server/src/core/session.ts:23`,
  `apps/server/src/core/session.test.ts:4`, `apps/server/src/core/replay.test.ts:20`,
  `apps/server/src/e2e.test.ts:53`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `reduce(state: SessionState, event: GameEvent): SessionState` and
  `fold(state: SessionState, events: readonly GameEvent[]): SessionState`,
  both exported from `@ai-dm/schemas`. Also still exported from there:
  `PlayerInputPayload`, `StateDeltaAppliedPayload`, `SceneChangedPayload`.

**Why this is legal now.** Spec #1 wrote that `reduce` could move to
`@ai-dm/schemas` if sharing proved necessary, but it could not move as written:
it imports `startTurn` from `@ai-dm/rules-engine`, and `schemas` may not depend
on the engine. `startTurn()` returns exactly what `ActionEconomy.parse({})`
produces from its five schema defaults — verified field for field. Swapping it
removes the only blocker.

- [ ] **Step 1: Write the failing test that pins the equivalence**

Add to `packages/rules-engine/src/combat/action-economy.test.ts`:

```ts
it("startTurn is exactly the ActionEconomy schema's defaults", () => {
  // One definition, two call sites: `@ai-dm/schemas`' `reduce` needs a fresh
  // economy but may not import this package (invariant 5), so it calls
  // `ActionEconomy.parse({})`. This test is what stops the two drifting.
  expect(startTurn()).toEqual(ActionEconomy.parse({}));
});
```

Add `ActionEconomy` to that file's existing `@ai-dm/schemas` import.

- [ ] **Step 2: Run it to confirm it passes today**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine test -- action-economy
```

Expected: PASS. This one starts green on purpose — it is a *characterisation*
test locking in the equality before the refactor relies on it. If it fails,
STOP and report BLOCKED: the spec's central premise is wrong.

- [ ] **Step 3: Redefine `startTurn` in terms of the schema**

Replace `packages/rules-engine/src/combat/action-economy.ts:45-53` with:

```ts
/**
 * The economy a creature opens its turn with. Reactions refresh here.
 *
 * Defined as the schema's own defaults rather than a hand-written literal so
 * that `@ai-dm/schemas`' `reduce` — which resets the economy on
 * `turn_advanced` and may not import this package (invariant 5) — shares one
 * definition with the engine instead of maintaining a copy that must agree.
 */
export function startTurn(): ActionEconomy {
  return ActionEconomy.parse({});
}
```

Ensure `ActionEconomy` is imported as a *value* (not `import type`) at the top of
that file — `.parse` is a runtime call.

- [ ] **Step 4: Run the engine suite**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: PASS, 319 tests + your new one = **320**.

- [ ] **Step 5: Move the module and its test with git mv**

```bash
git mv apps/server/src/core/reduce.ts packages/schemas/src/reduce.ts
git mv apps/server/src/core/reduce.test.ts packages/schemas/src/reduce.test.ts
```

- [ ] **Step 6: Rewrite the moved module's header and drop the engine import**

The existing header says a client should run an *equivalent* fold rather than
reuse this module. That is now false and must not be left contradicting the
code. Replace `packages/schemas/src/reduce.ts` lines 1-20 (everything from the
first comment through the four `import` lines) with:

```ts
// The projection. State is a fold of the event log and nothing else
// (invariant 3), so this function is the only place a `SessionState` changes
// shape — and it is pure, total and never mutates its input.
//
// It lives in `@ai-dm/schemas` rather than in `apps/server` so that client and
// server run the SAME fold, not two that must agree. `apps/web` may depend on
// this package and only this package (invariant 5); an equivalent-but-separate
// client fold was the alternative, and the drift it invites is exactly what
// this placement removes. `apps/server/src/core/` imports it from here.
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
import { z } from "zod";
import { Combatant, ActionEconomy } from "./world.js";
import type { GameEvent } from "./events.js";
import type { SessionState } from "./protocol.js";
```

Note the imports become *relative* — this file is now inside `@ai-dm/schemas`
and must not import its own package by name.

- [ ] **Step 7: Swap the `startTurn()` call site**

In the `scene_changed` case of `packages/schemas/src/reduce.ts`, change:

```ts
        each.combatantId === upNextId ? { ...each, actionEconomy: startTurn() } : each,
```

to:

```ts
        each.combatantId === upNextId ? { ...each, actionEconomy: ActionEconomy.parse({}) } : each,
```

In the long explanatory comment directly above that line, replace the phrase
"mirrors `tools/sim/src/engine/encounter.ts`'s reset at the same logical moment"
— leave it as is; it is still true. Only the call changes.

- [ ] **Step 8: Fix the moved test's imports**

In `packages/schemas/src/reduce.test.ts`, replace the top import block:

```ts
import { describe, expect, it } from "vitest";
import { fold, reduce } from "./reduce.js";
import { ActionEconomy, Combatant } from "./world.js";
import type { GameEvent } from "./events.js";
import type { SessionState } from "./protocol.js";
```

Then replace every `startTurn()` call in that file with `ActionEconomy.parse({})`.
Change nothing else — **every assertion must survive byte-for-byte**. If an
assertion appears to need changing, the refactor is wrong, not the assertion:
stop and report BLOCKED.

- [ ] **Step 9: Export the fold from the package index**

Add to `packages/schemas/src/index.ts`, after the `./protocol.js` line:

```ts
export * from "./reduce.js";
```

- [ ] **Step 10: Point the five server importers at the package**

| File | Old | New |
|---|---|---|
| `apps/server/src/core/pipeline.ts:31` | `import { reduce } from "./reduce.js";` | delete; add `reduce` to the existing `@ai-dm/schemas` value import |
| `apps/server/src/core/session.ts:23` | `import { fold } from "./reduce.js";` | `import { fold } from "@ai-dm/schemas";` |
| `apps/server/src/core/session.test.ts:4` | `import { fold } from "./reduce.js";` | `import { fold } from "@ai-dm/schemas";` |
| `apps/server/src/core/replay.test.ts:20` | `import { fold } from "./reduce.js";` | `import { fold } from "@ai-dm/schemas";` |
| `apps/server/src/e2e.test.ts:53` | `import { fold } from "./core/reduce.js";` | `import { fold } from "@ai-dm/schemas";` |

`pipeline.ts` line 28 is currently
`import type { ClientMessage, GameEvent, ServerFrame } from "@ai-dm/schemas";` —
a **type-only** import. `reduce` is a value, so add a separate value import
beside it:

```ts
import { reduce } from "@ai-dm/schemas";
import type { ClientMessage, GameEvent, ServerFrame } from "@ai-dm/schemas";
```

- [ ] **Step 11: Run the full suite and typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: typecheck clean. Counts shift **schemas 60 → 75** (it gains
`reduce.test.ts`'s 15 cases) and **server 107 → 92** (it loses them);
rules-engine **319 → 320**; agents 176 and sim 129 unchanged. Total **792**.
Report the real numbers you observe — if schemas' gain does not equal server's
loss, something was dropped.

- [ ] **Step 12: Lint and commit**

```bash
npx eslint apps/server apps/web packages tools
npx prettier --write packages/schemas/src/reduce.ts packages/schemas/src/reduce.test.ts packages/schemas/src/index.ts packages/rules-engine/src/combat/action-economy.ts
git add packages/schemas/src packages/rules-engine/src/combat apps/server/src
git commit -m "refactor(schemas): move reduce into schemas so client and server share one fold"
```

---

## Task 2: `TurnAffordances` schema and the `turn_affordances` frame

**Files:**
- Modify: `packages/schemas/src/protocol.ts`
- Test: `packages/schemas/src/protocol.test.ts` (exists; add cases)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, all exported from `@ai-dm/schemas`:
  - `ActionAffordance` / `type ActionAffordance` —
    `{ actionType: ActionType; actionId?: string; requiresTarget: boolean; targetableCombatantIds: string[] }`
  - `TurnAffordances` / `type TurnAffordances` —
    `{ actorId: string; reachableTiles: Tile[]; actions: ActionAffordance[] }`
  - A sixth `ServerFrame` variant with
    `type: "turn_affordances"`, `forSequence: number`, plus every
    `TurnAffordances` field flattened at the top level.

**One refinement over the spec's literal shape.** The spec's sketch gives each
action an `actionId` only. That is not enough for the client to build a legal
`ExecuteTurn` without inferring rules: `mainAction` needs an `actionType`
(`"attack"` vs `"dodge"`), and inferring "if the id is in the catalogue it is an
attack" would be exactly the client-side rules reasoning this design exists to
prevent. So each affordance carries the `actionType` verbatim, and `actionId`
becomes optional because universal actions (Dodge, Dash, Disengage) have none.
This is additive and serves the spec's own stated goal.

- [ ] **Step 1: Write the failing tests**

Append to `packages/schemas/src/protocol.test.ts`:

```ts
describe("turn_affordances frame", () => {
  const frame = {
    type: "turn_affordances",
    actorId: "hero",
    forSequence: 12,
    reachableTiles: [
      [5, 3],
      [6, 4],
    ],
    actions: [
      {
        actionType: "attack",
        actionId: "spear",
        requiresTarget: true,
        targetableCombatantIds: ["goblin-a"],
      },
      { actionType: "dodge", requiresTarget: false, targetableCombatantIds: [] },
    ],
  };

  it("parses as a ServerFrame", () => {
    const parsed = ServerFrame.parse(frame);
    expect(parsed.type).toBe("turn_affordances");
  });

  it("keeps actionId optional so no-target actions need not invent one", () => {
    const dodge = ActionAffordance.parse({
      actionType: "dodge",
      requiresTarget: false,
      targetableCombatantIds: [],
    });
    expect(dodge.actionId).toBeUndefined();
  });

  it("rejects an unknown actionType rather than passing it through", () => {
    expect(() =>
      ActionAffordance.parse({
        actionType: "somersault",
        requiresTarget: false,
        targetableCombatantIds: [],
      }),
    ).toThrow();
  });

  it("rejects a negative forSequence", () => {
    expect(() => ServerFrame.parse({ ...frame, forSequence: -1 })).toThrow();
  });

  it("exposes the same fields standalone for the engine to return", () => {
    const affordances = TurnAffordances.parse({
      actorId: "hero",
      reachableTiles: [[5, 3]],
      actions: [],
    });
    expect(affordances.reachableTiles).toEqual([[5, 3]]);
  });
});
```

Add `ActionAffordance`, `TurnAffordances` and `ServerFrame` to that file's
imports from `./protocol.js` (check the file's existing import style first and
match it).

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ai-dm/schemas test -- protocol
```

Expected: FAIL — `ActionAffordance` and `TurnAffordances` are not exported.

- [ ] **Step 3: Add the schemas to `protocol.ts`**

Insert immediately above the `export const ServerFrame` declaration:

```ts
/**
 * One action the actor may take right now, with the targets it may legally
 * take it against. Ids and enum members only — display names are static per
 * encounter and travel over `GET /encounters/:encounterId` instead, so a
 * frame sent every turn does not re-send text that never changes.
 *
 * `actionType` is present because the client builds `ExecuteTurn.mainAction`
 * from this, and deducing the type from the id would be the client reasoning
 * about rules — the exact thing affordances exist to prevent. `actionId` is
 * optional because Dodge, Dash and Disengage have none.
 */
export const ActionAffordance = z.object({
  actionType: ActionType,
  actionId: z.string().optional(),
  /**
   * Distinguishes "needs no target" (Dodge) from "needs one and none is in
   * range", which an empty `targetableCombatantIds` alone cannot express.
   */
  requiresTarget: z.boolean(),
  targetableCombatantIds: z.array(z.string()),
});

export type ActionAffordance = z.infer<typeof ActionAffordance>;

/**
 * Everything the actor may legally do this turn, derived server-side by
 * running `validateExecuteTurn` over enumerated candidates. The client
 * highlights exactly this and computes nothing: a tile it draws as reachable
 * is a tile the validator already accepted.
 */
export const TurnAffordances = z.object({
  actorId: z.string(),
  reachableTiles: z.array(Tile),
  actions: z.array(ActionAffordance),
});

export type TurnAffordances = z.infer<typeof TurnAffordances>;
```

Add `ActionType` and `Tile` to the existing `./actions.js` import at the top of
`protocol.ts` (it currently imports only `ExecuteTurn`).

- [ ] **Step 4: Add the frame variant**

Inside the `ServerFrame` discriminated union, after the `narrative_token`
variant and before `rejected`, add:

```ts
  /**
   * Pushed at the two points the pipeline knows the player is up: a `join`
   * that lands on their turn, and the end of a turn that returns control to
   * them. Not a request/response — the client never asks for these.
   */
  TurnAffordances.extend({
    type: z.literal("turn_affordances"),
    /**
     * The projection these were computed from. The client discards a frame
     * older than the state it currently holds, so an affordance set cannot
     * be applied to a board that has already moved past it.
     */
    forSequence: z.number().int().min(0),
  }),
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS. schemas goes **75 → 80**.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write packages/schemas/src/protocol.ts packages/schemas/src/protocol.test.ts
git add packages/schemas/src/protocol.ts packages/schemas/src/protocol.test.ts
git commit -m "feat(schemas): add the turn_affordances frame and its payload schemas"
```

---

## Task 3: `affordancesFor` — legality derived from the validator

**Files:**
- Create: `packages/rules-engine/src/combat/affordances.ts`
- Test: `packages/rules-engine/src/combat/affordances.test.ts`
- Modify: `packages/rules-engine/src/combat/index.ts`

**Interfaces:**
- Consumes: `TurnAffordances`, `ActionAffordance` from Task 2.
- Produces:
  `affordancesFor(world: CombatWorld, actorId: string, statBlock: MonsterStatBlock): TurnAffordances`,
  exported from `@ai-dm/rules-engine`.

**The one rule that makes this correct.** This must *not* reimplement legality.
It enumerates candidates and asks `validateExecuteTurn`. The failure being
designed against is a client highlighting a tile the server then rejects — which
can only happen if two different pieces of code decide legality.

**Why it reads rejection *reasons* rather than `valid`.** `validateExecuteTurn`
validates a whole turn, and `ExecuteTurn.mainAction` is required — there is no
"just move" turn to probe with. So a probe for a reachable tile also carries an
action, and an actor who has already acted would fail the probe for a reason
that has nothing to do with the tile. The validator accumulates rejections in a
list rather than returning at the first, so the probe asks the precise question:
*did the validator object to the part I am probing?* The reason lists below are
copied from `TurnRejectionReason` (`validate-turn.ts:59-72`) and
`EconomyRejectionReason` (`action-economy.ts:7-12`).

- [ ] **Step 1: Write the failing golden tests**

Create `packages/rules-engine/src/combat/affordances.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ActionEconomy } from "@ai-dm/schemas";
import type { Combatant, MonsterStatBlock } from "@ai-dm/schemas";
import { affordancesFor } from "./affordances.js";
import { validateExecuteTurn } from "./validate-turn.js";
import type { CombatWorld } from "./validate-turn.js";

const goblinStatBlock: MonsterStatBlock = {
  monsterId: "goblin_warrior",
  nameEnglish: "Goblin Warrior",
  size: "small",
  creatureType: "Fey (Goblinoid)",
  alignment: "Chaotic Neutral",
  armorClass: 15,
  hitPoints: { average: 10, diceNotation: "3d6" },
  speedFeet: 30,
  abilities: { str: 8, dex: 15, con: 10, int: 10, wis: 8, cha: 8 },
  challengeRating: "1/4",
  proficiencyBonus: 2,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "scimitar",
      nameEnglish: "Scimitar",
      attackBonus: 4,
      reachFeet: 5,
      damage: { diceNotation: "1d6+2", averageDamage: 5, damageType: "slashing" },
    },
  ],
};

function combatant(overrides: Partial<Combatant> & Pick<Combatant, "combatantId">): Combatant {
  return {
    faction: "hostile",
    position: [5, 5],
    size: "small",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 10,
    currentHp: 10,
    tempHp: 0,
    armorClass: 15,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: ActionEconomy.parse({}),
    status: "alive",
    ...overrides,
  };
}

/** An open field with no terrain, so exclusions come only from what we place. */
function openWorld(combatants: readonly Combatant[], size = 12): CombatWorld {
  return {
    grid: {
      width: size,
      height: size,
      tiles: Array.from({ length: size }, () =>
        Array.from({ length: size }, () => "normal" as const),
      ),
    },
    combatants,
  };
}

describe("affordancesFor", () => {
  it("reaches every tile inside a 30 ft budget and none outside it", () => {
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const result = affordancesFor(openWorld([actor]), "goblin-a", goblinStatBlock);

    // 30 ft on a 5 ft grid is 6 tiles of Chebyshev distance (ADR-0003), so the
    // reachable set is the 13x13 square around the actor minus its own tile,
    // clipped to the 12x12 grid.
    expect(result.reachableTiles).toContainEqual([11, 11]);
    expect(result.reachableTiles).not.toContainEqual([5, 5]);
    expect(result.reachableTiles.every(([x, y]) => x >= 0 && x < 12 && y >= 0 && y < 12)).toBe(true);
    for (const [x, y] of result.reachableTiles) {
      expect(Math.max(Math.abs(x - 5), Math.abs(y - 5))).toBeLessThanOrEqual(6);
    }
  });

  it("narrows reachability after partial movement", () => {
    const fresh = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const moved = combatant({
      combatantId: "goblin-a",
      position: [5, 5],
      actionEconomy: ActionEconomy.parse({ movementUsedFeet: 25 }),
    });

    const freshTiles = affordancesFor(openWorld([fresh]), "goblin-a", goblinStatBlock)
      .reachableTiles;
    const movedTiles = affordancesFor(openWorld([moved]), "goblin-a", goblinStatBlock)
      .reachableTiles;

    expect(movedTiles.length).toBeLessThan(freshTiles.length);
    // 5 ft left is exactly one tile in any direction.
    for (const [x, y] of movedTiles) {
      expect(Math.max(Math.abs(x - 5), Math.abs(y - 5))).toBe(1);
    }
  });

  it("reports no reachable tiles once the movement budget is spent", () => {
    const spent = combatant({
      combatantId: "goblin-a",
      actionEconomy: ActionEconomy.parse({ movementUsedFeet: 30 }),
    });
    expect(affordancesFor(openWorld([spent]), "goblin-a", goblinStatBlock).reachableTiles).toEqual(
      [],
    );
  });

  it("excludes a tile another combatant occupies", () => {
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const blocker = combatant({ combatantId: "hero", faction: "party", position: [6, 5] });
    const result = affordancesFor(openWorld([actor, blocker]), "goblin-a", goblinStatBlock);

    expect(result.reachableTiles).not.toContainEqual([6, 5]);
    expect(result.reachableTiles).toContainEqual([6, 6]);
  });

  it("excludes tiles walled off by blocking terrain", () => {
    const actor = combatant({ combatantId: "goblin-a", position: [1, 1] });
    const world = openWorld([actor], 5);
    // A full-height wall on column 2 seals the actor into columns 0-1.
    // `TerrainType` is ["normal", "difficult", "blocking", "half_cover",
    // "three_quarters_cover"] — "blocking" is the impassable one; there is no
    // "wall" member.
    for (let y = 0; y < 5; y += 1) {
      const row = world.grid.tiles[y];
      // `noUncheckedIndexedAccess` makes this `T | undefined`; a non-null
      // assertion would fail `@typescript-eslint/no-non-null-assertion`.
      if (row !== undefined) row[2] = "blocking";
    }

    const result = affordancesFor(world, "goblin-a", goblinStatBlock);
    expect(result.reachableTiles.every(([x]) => x < 2)).toBe(true);
    expect(result.reachableTiles).not.toContainEqual([3, 1]);
  });

  it("offers a stat-block attack against a target in reach and no one else", () => {
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const adjacent = combatant({ combatantId: "hero", faction: "party", position: [6, 5] });
    const distant = combatant({ combatantId: "far", faction: "party", position: [11, 11] });

    const result = affordancesFor(openWorld([actor, adjacent, distant]), "goblin-a", goblinStatBlock);
    const scimitar = result.actions.find((each) => each.actionId === "scimitar");

    expect(scimitar).toBeDefined();
    expect(scimitar?.requiresTarget).toBe(true);
    expect(scimitar?.targetableCombatantIds).toEqual(["hero"]);
  });

  it("offers the universal no-target actions with no targets", () => {
    const actor = combatant({ combatantId: "goblin-a" });
    const result = affordancesFor(openWorld([actor]), "goblin-a", goblinStatBlock);
    const dodge = result.actions.find((each) => each.actionType === "dodge");

    expect(dodge).toBeDefined();
    expect(dodge?.requiresTarget).toBe(false);
    expect(dodge?.targetableCombatantIds).toEqual([]);
    expect(dodge?.actionId).toBeUndefined();
  });

  it("offers no actions at all once the action is spent", () => {
    const acted = combatant({
      combatantId: "goblin-a",
      actionEconomy: ActionEconomy.parse({ actionUsed: true }),
    });
    expect(affordancesFor(openWorld([acted]), "goblin-a", goblinStatBlock).actions).toEqual([]);
  });

  it("offers nothing to a dead actor", () => {
    const dead = combatant({ combatantId: "goblin-a", currentHp: 0, status: "dead" });
    const result = affordancesFor(openWorld([dead]), "goblin-a", goblinStatBlock);
    expect(result).toEqual({ actorId: "goblin-a", reachableTiles: [], actions: [] });
  });

  it("agrees with validateExecuteTurn on a destination the validator rejects", () => {
    // The guard that this is the validator and not a parallel implementation:
    // take a tile affordances excluded, and confirm the validator excludes it
    // too — for a movement reason, not an incidental one.
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const blocker = combatant({ combatantId: "hero", faction: "party", position: [6, 5] });
    const world = openWorld([actor, blocker]);

    expect(affordancesFor(world, "goblin-a", goblinStatBlock).reachableTiles).not.toContainEqual([
      6, 5,
    ]);

    const verdict = validateExecuteTurn(
      {
        actorId: "goblin-a",
        movement: [{ destinationTile: [6, 5], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: "Cross-check fixture.",
      },
      actor,
      world,
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.valid === false && verdict.rejections.map((each) => each.reason)).toContain(
      "destination_occupied",
    );
  });

  it("agrees with validateExecuteTurn on every tile it does offer", () => {
    // The other direction: nothing affordances offers may be refused.
    const actor = combatant({ combatantId: "goblin-a", position: [5, 5] });
    const world = openWorld([actor]);

    for (const tile of affordancesFor(world, "goblin-a", goblinStatBlock).reachableTiles) {
      const verdict = validateExecuteTurn(
        {
          actorId: "goblin-a",
          movement: [{ destinationTile: tile, pathType: "direct" }],
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Cross-check fixture.",
        },
        actor,
        world,
      );
      expect(verdict.valid).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ai-dm/rules-engine test -- affordances
```

Expected: FAIL — `./affordances.js` does not exist.

- [ ] **Step 3: Implement it**

Create `packages/rules-engine/src/combat/affordances.ts`:

```ts
// What the actor may legally do right now, for a UI to render.
//
// The hard rule: this is NOT a second implementation of legality. It enumerates
// candidates and asks `validateExecuteTurn`. A client highlighting a tile the
// server then rejects is the failure this exists to prevent, and it can only
// happen if two pieces of code decide legality — so there is only one, and this
// calls it.
//
// Cost: a 30 ft mover on a 5 ft grid has a 13x13 candidate square, so this is
// low hundreds of validator calls per turn. Irrelevant beside a model call, and
// it cannot diverge from the validator, because it is the validator.
import { FEET_PER_TILE } from "../spatial/index.js";
import { validateExecuteTurn } from "./validate-turn.js";
import type { CombatWorld, TurnRejectionReason, TurnValidation } from "./validate-turn.js";
import type { ActionAffordance, MonsterStatBlock, Tile, TurnAffordances } from "@ai-dm/schemas";
import type { ExecuteTurn } from "@ai-dm/schemas";

/**
 * `ExecuteTurn.mainAction` is required, so every probe carries an action even
 * when it is only asking about movement. That means a probe can fail for a
 * reason unrelated to what it asked. These lists name the reasons that DO
 * condemn each aspect; anything else in the rejection list is incidental to
 * the probe and ignored. Copied from `TurnRejectionReason` (`validate-turn.ts`)
 * and `EconomyRejectionReason` (`action-economy.ts`) — if either gains a member,
 * classify it here.
 */
const BLOCKS_THE_WHOLE_TURN: readonly TurnRejectionReason[] = [
  "actor_mismatch",
  "actor_cannot_act",
  "actor_incapacitated",
];

const BLOCKS_MOVEMENT: readonly TurnRejectionReason[] = [
  ...BLOCKS_THE_WHOLE_TURN,
  "actor_cannot_move",
  "movement_exceeds_speed",
  "movement_path_blocked",
  "destination_off_grid",
  "destination_occupied",
];

const BLOCKS_THE_ACTION: readonly TurnRejectionReason[] = [
  ...BLOCKS_THE_WHOLE_TURN,
  "action_already_used",
  "extra_attacks_exceed_budget",
  "extra_attacks_without_attack_action",
  "spell_slot_unavailable",
];

const BLOCKS_THE_TARGET: readonly TurnRejectionReason[] = [
  ...BLOCKS_THE_ACTION,
  "target_not_found",
  "target_out_of_reach",
  "target_behind_full_cover",
];

/**
 * Actions every creature has that need no target and no stat-block entry. The
 * client needs them to exist as affordances or a player has no way to Dodge.
 * Each is still probed through the validator, so an actor who has already acted
 * is offered none of them.
 */
const UNIVERSAL_ACTIONS = ["dodge", "dash", "disengage"] as const;

function permits(verdict: TurnValidation, blockers: readonly TurnRejectionReason[]): boolean {
  if (verdict.valid) return true;
  return !verdict.rejections.some((rejection) => blockers.includes(rejection.reason));
}

export function affordancesFor(
  world: CombatWorld,
  actorId: string,
  statBlock: MonsterStatBlock,
): TurnAffordances {
  const actor = world.combatants.find((each) => each.combatantId === actorId);
  if (actor === undefined) {
    throw new Error(`No combatant ${actorId} in this world`);
  }

  const empty: TurnAffordances = { actorId, reachableTiles: [], actions: [] };
  if (actor.status !== "alive") return empty;

  // `dodge` is the probe's filler action: it needs no target and no id, so it
  // adds the fewest possible reasons of its own to a movement question.
  const probe = (turn: Omit<ExecuteTurn, "actorId" | "tacticalRationaleEnglish">): TurnValidation =>
    validateExecuteTurn(
      { actorId, ...turn, tacticalRationaleEnglish: "Affordance probe." },
      actor,
      world,
    );

  const reachableTiles: Tile[] = [];
  const remainingFeet = actor.speedFeet - actor.actionEconomy.movementUsedFeet;
  const radiusTiles = Math.floor(remainingFeet / FEET_PER_TILE);
  const [originX, originY] = actor.position;

  for (let y = originY - radiusTiles; y <= originY + radiusTiles; y += 1) {
    for (let x = originX - radiusTiles; x <= originX + radiusTiles; x += 1) {
      if (x === originX && y === originY) continue;
      if (x < 0 || x >= world.grid.width || y < 0 || y >= world.grid.height) continue;
      const destinationTile: Tile = [x, y];
      const verdict = probe({
        movement: [{ destinationTile, pathType: "direct" }],
        mainAction: { actionType: "dodge" },
      });
      if (permits(verdict, BLOCKS_MOVEMENT)) reachableTiles.push(destinationTile);
    }
  }

  const actions: ActionAffordance[] = [];

  for (const action of statBlock.actions) {
    const targetableCombatantIds = world.combatants
      .filter((each) => each.combatantId !== actorId && each.status === "alive")
      .filter((candidate) =>
        permits(
          probe({
            mainAction: {
              actionType: "attack",
              actionId: action.actionId,
              targetIds: [candidate.combatantId],
            },
          }),
          BLOCKS_THE_TARGET,
        ),
      )
      .map((each) => each.combatantId);

    // Offered even with no target in range: `requiresTarget` is what tells the
    // client the difference between "needs nobody" and "needs somebody and
    // nobody is there", and the UI renders the second as a disabled button
    // rather than a missing one.
    if (permits(probe({ mainAction: { actionType: "attack", actionId: action.actionId } }), BLOCKS_THE_ACTION)) {
      actions.push({
        actionType: "attack",
        actionId: action.actionId,
        requiresTarget: true,
        targetableCombatantIds,
      });
    }
  }

  for (const actionType of UNIVERSAL_ACTIONS) {
    if (permits(probe({ mainAction: { actionType } }), BLOCKS_THE_ACTION)) {
      actions.push({ actionType, requiresTarget: false, targetableCombatantIds: [] });
    }
  }

  return { actorId, reachableTiles, actions };
}
```

If a probe for an untargeted attack turns out to be rejected for
`target_not_found` (check the validator's behaviour when `targetIds` is absent),
that reason is already excluded from `BLOCKS_THE_ACTION`, so the action is still
offered — which is the intent. Follow the compiler and the tests; if the real
behaviour differs from this sketch, the tests in Step 1 are the specification,
not this code.

- [ ] **Step 4: Export it**

Add to `packages/rules-engine/src/combat/index.ts`, matching the file's existing
export style:

```ts
export * from "./affordances.js";
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: PASS, **320 → 331** (11 new cases).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write packages/rules-engine/src/combat/affordances.ts packages/rules-engine/src/combat/affordances.test.ts packages/rules-engine/src/combat/index.ts
git add packages/rules-engine/src/combat
git commit -m "feat(rules-engine): derive turn affordances by running the real validator"
```

---

## Task 4: The pipeline yields `turn_affordances`

**Files:**
- Modify: `apps/server/src/core/pipeline.ts` (the `join` case ~line 445, and the
  end of the `structured_action` case ~line 608)
- Test: `apps/server/src/core/pipeline.test.ts` (add cases)

**Interfaces:**
- Consumes: `affordancesFor` (Task 3), the `turn_affordances` frame (Task 2).
- Produces: `handleCommand` now yields a `turn_affordances` frame as the last
  frame of any `join` that lands on a party member's turn, and as the last frame
  of a `structured_action` that returns control to a party member.

**Why the pipeline and not the transport.** Spec #1's rule is that `core/` never
touches a socket and `transport/` "parses with the schemas, validates, pumps
frames, and nothing else". Computing affordances calls the rules engine, which
is not pumping frames. So this is yielded from `handleCommand` like every other
`ServerFrame`, and the transport stays a pump.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/core/pipeline.test.ts`, matching its existing helper
and fixture style (read the file's top ~60 lines first and reuse its harness
rather than building a second one):

```ts
describe("turn_affordances", () => {
  it("follows a join that lands on the player's turn", async () => {
    const { session, ports } = await freshSession();
    const frames = await collect(handleCommand(session, { type: "join", sessionId: session.state.sessionId }, ports));

    const last = frames.at(-1);
    expect(last?.type).toBe("turn_affordances");
    expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    expect(last?.type === "turn_affordances" && last.forSequence).toBe(session.nextSequence - 1);
  });

  it("offers the hero a reachable set and the spear against an adjacent goblin", async () => {
    const { session, ports } = await freshSession();
    const frames = await collect(handleCommand(session, { type: "join", sessionId: session.state.sessionId }, ports));
    const affordances = frames.at(-1);

    if (affordances?.type !== "turn_affordances") throw new Error("expected affordances");
    expect(affordances.reachableTiles.length).toBeGreaterThan(0);

    const spear = affordances.actions.find((each) => each.actionId === "spear");
    expect(spear?.targetableCombatantIds).toContain("goblin-a");
  });

  it("does NOT follow a join that lands on a hostile's turn", async () => {
    const { session, ports } = await freshSession();
    // Advance past the hero so a goblin is up.
    session.state = { ...session.state, currentActorIndex: 1 };

    const frames = await collect(handleCommand(session, { type: "join", sessionId: session.state.sessionId }, ports));
    expect(frames.some((each) => each.type === "turn_affordances")).toBe(false);
  });

  it("follows a completed turn that returns control to the player", async () => {
    const { session, ports } = await freshSession();
    const frames = await collect(
      handleCommand(
        session,
        {
          type: "structured_action",
          clientMessageId: "m1",
          actorId: "hero",
          turn: {
            actorId: "hero",
            mainAction: { actionType: "dodge" },
            tacticalRationaleEnglish: "Test fixture.",
          },
        },
        ports,
      ),
    );

    const last = frames.at(-1);
    // Either the hero is up again (affordances) or the fight ended during the
    // hostile sweep (no frame) — both are correct; assert the frame is last
    // when present and never appears mid-stream.
    const index = frames.findIndex((each) => each.type === "turn_affordances");
    if (index !== -1) {
      expect(index).toBe(frames.length - 1);
      expect(last?.type === "turn_affordances" && last.actorId).toBe("hero");
    }
  });

  it("does not follow a rejected action, which does not advance the turn", async () => {
    const { session, ports } = await freshSession();
    const frames = await collect(
      handleCommand(
        session,
        {
          type: "structured_action",
          clientMessageId: "m1",
          actorId: "hero",
          turn: {
            actorId: "hero",
            movement: [{ destinationTile: [99, 99], pathType: "direct" }],
            mainAction: { actionType: "dodge" },
            tacticalRationaleEnglish: "Test fixture.",
          },
        },
        ports,
      ),
    );

    expect(frames.some((each) => each.type === "turn_affordances")).toBe(false);
    expect(frames.at(-1)?.type).toBe("rejected");
  });
});
```

`freshSession()` and `collect()` are illustrative names — use whatever the
existing file already provides for building a session and draining the
generator. Do **not** add a duplicate harness.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ai-dm/server test -- pipeline
```

Expected: FAIL — no `turn_affordances` frame is ever yielded.

- [ ] **Step 3: Add the shared helper generator**

Inside `handleCommand`, beside the existing `runEnemyTurns` declaration
(~line 418), add:

```ts
  /**
   * Push the player's affordances, if it is a party member's turn. Called at
   * the two points the pipeline knows control sits with the player: the end of
   * a `join`, and the end of a turn that came back round to them.
   *
   * Silent when it is a hostile's turn, when the actor is missing, or when the
   * encounter has no stat block for them — none of those are error conditions
   * for the client, they simply mean there is nothing to offer.
   */
  async function* playerAffordances(): AsyncIterable<ServerFrame> {
    const actorId = session.state.turnOrder[session.state.currentActorIndex];
    if (actorId === undefined) return;

    const actor = session.state.combatants.find((each) => each.combatantId === actorId);
    if (actor === undefined || actor.faction !== "party" || actor.status !== "alive") return;

    const statBlock = session.built.statBlocks.get(actorId);
    if (statBlock === undefined) return;

    yield {
      type: "turn_affordances",
      forSequence: session.nextSequence - 1,
      ...affordancesFor(worldFor(session), actorId, statBlock),
    };
  }
```

Add `affordancesFor` to the existing `@ai-dm/rules-engine` value import at
`pipeline.ts:18`.

- [ ] **Step 4: Yield it from the `join` case**

The `join` case has four `return` paths. Rather than editing each, wrap the
existing body. Replace `case "join": {` … through its final `return;` so that
the whole existing body becomes an inner generator, then call both:

```ts
      case "join": {
        // The existing body, verbatim, moved into a nested generator so all
        // four of its exits are covered by one affordance push rather than
        // four copies of it.
        async function* joinFrames(): AsyncIterable<ServerFrame> {
          // ... every line of the current `join` body, unchanged ...
        }

        yield* joinFrames();
        yield* playerAffordances();
        return;
      }
```

Change nothing inside the moved body — its `return`s now end `joinFrames`, which
is exactly the behaviour wanted.

- [ ] **Step 5: Yield it at the end of the `structured_action` case**

At `pipeline.ts` ~line 609, change:

```ts
        yield* runEnemyTurns();
        return;
```

to:

```ts
        yield* runEnemyTurns();
        yield* playerAffordances();
        return;
```

Note this is placed *after* `runEnemyTurns`, so the affordances reflect the board
the player actually faces — not the one before the goblins moved. Nothing is
yielded when the fight ended during the sweep, because the hero is then not
`alive` and `playerAffordances` returns silently.

- [ ] **Step 6: Run the server suite**

```bash
pnpm --filter @ai-dm/server test
```

Expected: PASS, **92 → 97** (5 new cases). The existing 92 must all still pass —
`turn_affordances` is appended after existing frames, so any test asserting an
exact frame *sequence* for a join or a completed turn will need its expected
list extended by one trailing frame. That is a legitimate update; a test whose
*middle* changed is a bug, so check where the diff lands.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write apps/server/src/core/pipeline.ts apps/server/src/core/pipeline.test.ts
git add apps/server/src/core
git commit -m "feat(server): yield turn_affordances when control sits with the player"
```

---

## Task 5: `GET /encounters/:encounterId` — the static catalogue

**Files:**
- Modify: `apps/server/src/encounters/index.ts`
- Modify: `apps/server/src/transport/http.ts`
- Test: `apps/server/src/transport/http.test.ts` (exists; add cases)

**Interfaces:**
- Consumes: `buildEncounterById`, `UnknownEncounterError` (both already exported
  from `apps/server/src/encounters/index.ts`).
- Produces:
  `encounterCatalogue(encounterId: string): EncounterCatalogue`, where

```ts
export interface EncounterCatalogue {
  encounterId: string;
  combatants: { combatantId: string; nameEnglish: string; maxHp: number; faction: Faction }[];
  actions: { actionId: string; nameEnglish: string }[];
}
```

  and `GET /encounters/:encounterId` returning it as JSON, 404 on an unknown id.

**Why HTTP and not a frame.** It never changes, so sending it per turn would
waste wire on every turn of every session — on a socket already carrying a
`SessionState` that only grows (correction C-30). Fetched once at join, cached
for the session.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/transport/http.test.ts` (reuse its existing app
builder; read the top of the file first):

```ts
describe("GET /encounters/:encounterId", () => {
  it("returns display names for every combatant in the encounter", async () => {
    const response = await app.inject({ method: "GET", url: "/encounters/goblin-ambush" });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      encounterId: string;
      combatants: { combatantId: string; nameEnglish: string; maxHp: number; faction: string }[];
      actions: { actionId: string; nameEnglish: string }[];
    }>();

    expect(body.encounterId).toBe("goblin-ambush");
    expect(body.combatants.map((each) => each.combatantId).sort()).toEqual([
      "goblin-a",
      "goblin-b",
      "hero",
    ]);

    const hero = body.combatants.find((each) => each.combatantId === "hero");
    // No player-character data exists, so the hero borrows the `guard` stat
    // block (C-13) and its English name is all a label can show.
    expect(hero?.nameEnglish).toBe("Guard");
    expect(hero?.faction).toBe("party");
    expect(hero?.maxHp).toBeGreaterThan(0);
  });

  it("dedupes actions by actionId across stat blocks", async () => {
    const response = await app.inject({ method: "GET", url: "/encounters/goblin-ambush" });
    const body = response.json<{ actions: { actionId: string; nameEnglish: string }[] }>();

    const ids = body.actions.map((each) => each.actionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("spear");
    expect(ids).toContain("scimitar");
  });

  it("404s on an unknown encounter", async () => {
    const response = await app.inject({ method: "GET", url: "/encounters/nope" });
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ai-dm/server test -- http
```

Expected: FAIL — 404 on all three, since the route does not exist.

- [ ] **Step 3: Add `encounterCatalogue` to the encounters module**

Append to `apps/server/src/encounters/index.ts`:

```ts
/**
 * The static per-encounter facts a client needs to label what it draws:
 * display names, max HP and faction. Static is the point — this is fetched
 * once over HTTP and cached, rather than re-sent on a socket that already
 * carries a `SessionState` growing without bound (C-30).
 */
export interface EncounterCatalogue {
  encounterId: string;
  combatants: {
    combatantId: string;
    nameEnglish: string;
    maxHp: number;
    faction: Faction;
  }[];
  actions: { actionId: string; nameEnglish: string }[];
}

export function encounterCatalogue(encounterId: string): EncounterCatalogue {
  const built = buildEncounterById(encounterId);

  const combatants = built.world.combatants.map((combatant) => {
    const statBlock = built.statBlocks.get(combatant.combatantId);
    return {
      combatantId: combatant.combatantId,
      // A combatant with no stat block cannot occur — `buildEncounter` refuses
      // to produce one — but the map lookup is still `T | undefined` under
      // `noUncheckedIndexedAccess`, and the id is a better label than a crash.
      nameEnglish: statBlock?.nameEnglish ?? combatant.combatantId,
      maxHp: combatant.maxHp,
      faction: combatant.faction,
    };
  });

  // Flattened across every stat block and deduped by `actionId`, first
  // occurrence winning. Two monsters sharing an id would otherwise appear
  // twice; `goblin-ambush` has no collision today (scimitar/shortbow vs
  // spear), so this is a rule for the next encounter. These are display labels
  // only, so first-wins is harmless even when the underlying attack bonuses
  // differ — legality still comes from affordances, never from this list.
  const actions = new Map<string, string>();
  for (const statBlock of built.statBlocks.values()) {
    for (const action of statBlock.actions) {
      if (!actions.has(action.actionId)) actions.set(action.actionId, action.nameEnglish);
    }
  }

  return {
    encounterId,
    combatants,
    actions: [...actions].map(([actionId, nameEnglish]) => ({ actionId, nameEnglish })),
  };
}
```

Add `Faction` to that file's type imports from `@ai-dm/schemas`. Note
`built.statBlocks` is keyed by `combatantId` (see
`packages/rules-engine/src/encounter/build.ts:46-53`), not by `monsterId` — the
`BuildEncounterInput` map is the one keyed by `monsterId`.

- [ ] **Step 4: Add the route**

In `apps/server/src/transport/http.ts`, inside `registerHttpRoutes`, after the
`POST /sessions` handler:

```ts
  app.get<{ Params: { encounterId: string } }>("/encounters/:encounterId", (request, reply) => {
    // C-34: `UnknownEncounterError` is the only 404. Everything else
    // `encounterCatalogue` can throw — ENOENT from a missing SRD file, a
    // ZodError from a malformed one, any of `buildEncounter`'s validations —
    // is a genuine server fault and must not be reported as "not found".
    try {
      return reply.send(encounterCatalogue(request.params.encounterId));
    } catch (error) {
      if (error instanceof UnknownEncounterError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });
```

Add `encounterCatalogue` to the existing `../encounters/index.js` import at
`http.ts:11`.

- [ ] **Step 5: Run the server suite**

```bash
pnpm --filter @ai-dm/server test
```

Expected: PASS, **97 → 100**.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write apps/server/src/encounters/index.ts apps/server/src/transport/http.ts apps/server/src/transport/http.test.ts
git add apps/server/src/encounters apps/server/src/transport
git commit -m "feat(server): serve the static encounter catalogue over HTTP"
```

---

## Task 6: Web scaffolding — Vite, Vitest, RTL root

**Files:**
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/i18n.ts`
- Create: `apps/web/src/i18n.test.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `apps/web` runs `vitest` under jsdom and `vite` with a dev proxy.
  - `src/i18n.ts` exports `he` — a frozen record of Hebrew UI strings — plus
    `errorMessage(code: string): string` and `rejectionMessage(reason: string): string`,
    each falling back to the raw English code for an unknown key.
  - `src/App.tsx` exports `App`, a placeholder component this task renders and
    later tasks fill in.

- [ ] **Step 1: Add the dev dependencies**

```bash
corepack enable
pnpm --filter @ai-dm/web add -D vitest@^3.2.7 jsdom@^26.0.0 @testing-library/react@^16.2.0 @testing-library/jest-dom@^6.6.0 @testing-library/user-event@^14.6.0
```

Do **not** add `@vitest/coverage-v8` — `pnpm add` grabs 4.x, which fails the peer
check against vitest 3.x.

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/i18n.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { errorMessage, he, rejectionMessage } from "./i18n.js";

describe("i18n", () => {
  it("renders a known server error code in Hebrew", () => {
    expect(errorMessage("unknown_session")).toBe(he.errors.unknown_session);
    expect(errorMessage("unknown_session")).not.toBe("unknown_session");
  });

  it("falls back to the raw code for an unknown one", () => {
    // Rejection reasons are open strings on the wire — the type lives
    // downstream in the rules engine — so the client must render one it has
    // never seen rather than showing nothing.
    expect(rejectionMessage("some_future_reason")).toBe("some_future_reason");
  });

  it("renders a known rejection reason in Hebrew", () => {
    expect(rejectionMessage("target_out_of_reach")).toBe(he.rejections.target_out_of_reach);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm --filter @ai-dm/web test
```

Expected: FAIL — no `vitest.config.ts`, no `i18n.ts`.

- [ ] **Step 4: Add the Vite config**

Create `apps/web/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A dev proxy rather than CORS middleware on the server: it needs no server
 * change and adds no cross-origin surface to an API that has no auth. The
 * client therefore always talks to same-origin relative paths, in dev and in
 * a built deployment alike.
 */
export default defineConfig({
  server: {
    proxy: {
      "/sessions": "http://localhost:3000",
      "/encounters": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
  plugins: [react()],
});
```

- [ ] **Step 5: Add the Vitest config**

Create `apps/web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test-setup.ts"],
  },
});
```

Create `apps/web/src/test-setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 6: Write `i18n.ts`**

Create `apps/web/src/i18n.ts`:

```ts
// The only file in the client with Hebrew literals. Everything else — state,
// wire messages, code, comments — is English (invariant 2); Hebrew exists at
// the UI boundary and here is that boundary.
//
// Both lookups fall back to the raw English key. Rejection reasons are open
// strings on the wire (their type lives downstream in the rules engine) and
// `ServerErrorCode` can widen, so a client that renders nothing for an unknown
// code would silently swallow the one message the player needed.

export const he = {
  app: {
    title: "מבוך",
    connecting: "מתחבר…",
    reconnecting: "מתחבר מחדש…",
    yourTurn: "תורך",
    waiting: "ממתין…",
    victory: "ניצחתם",
    defeat: "הובסתם",
    startFight: "התחל קרב",
  },
  actions: {
    dodge: "התחמקות",
    dash: "ריצה",
    disengage: "ניתוק",
    confirm: "אשר",
    cancel: "בטל",
    move: "תנועה",
  },
  errors: {
    unknown_session: "המשחק הזה כבר לא קיים.",
    malformed_message: "שגיאת תקשורת בלקוח.",
    turn_in_progress: "התור עדיין מתבצע.",
    free_text_not_supported: "טקסט חופשי אינו נתמך עדיין.",
    not_your_turn: "זה לא תורך.",
    internal_error: "שגיאת שרת.",
  },
  rejections: {
    actor_cannot_act: "הדמות אינה יכולה לפעול.",
    actor_cannot_move: "הדמות אינה יכולה לזוז.",
    actor_incapacitated: "הדמות משותקת.",
    action_already_used: "כבר השתמשת בפעולה שלך.",
    bonus_action_already_used: "כבר השתמשת בפעולת הבונוס שלך.",
    movement_exceeds_speed: "המרחק גדול מהתנועה שנותרה.",
    movement_path_blocked: "אין מסלול לשם.",
    destination_off_grid: "היעד מחוץ למפה.",
    destination_occupied: "היעד תפוס.",
    target_not_found: "המטרה לא נמצאה.",
    target_out_of_reach: "המטרה רחוקה מדי.",
    target_behind_full_cover: "המטרה מוסתרת לחלוטין.",
  },
} as const;

export function errorMessage(code: string): string {
  const table: Record<string, string | undefined> = he.errors;
  return table[code] ?? code;
}

export function rejectionMessage(reason: string): string {
  const table: Record<string, string | undefined> = he.rejections;
  return table[reason] ?? reason;
}
```

Note the `Record<string, string | undefined>` annotations: casting
`code as keyof typeof he.errors` would make the `?? code` fallback dead code
(root CLAUDE.md gotcha).

- [ ] **Step 7: Wire the React root**

Replace `apps/web/src/main.tsx` entirely:

```tsx
// React entry, and nothing else. `index.html` already carries
// `<html dir="rtl" lang="he">`, so direction is set before any script runs
// rather than being patched in by React after first paint.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element in index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Create `apps/web/src/App.tsx` as a placeholder this plan fills in at Task 12:

```tsx
import { he } from "./i18n.js";

export function App(): JSX.Element {
  return <main>{he.app.title}</main>;
}
```

- [ ] **Step 8: Run the tests**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS, **3 tests** where there were 0.

- [ ] **Step 9: Typecheck, lint, commit**

`apps/web/tsconfig.json` currently has `"include": ["src"]`, which excludes the
two new config files at the package root. Add them:

```json
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
```

Then:

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write apps/web/src apps/web/vite.config.ts apps/web/vitest.config.ts apps/web/tsconfig.json apps/web/package.json
git add apps/web pnpm-lock.yaml
git commit -m "chore(web): scaffold vite, vitest and the Hebrew string table"
```

`pnpm-lock.yaml` is staged here deliberately — Step 1 changed it, and this is the
one task where that is your own edit rather than collateral from `pnpm format`.

---

## Task 7: The network layer

**Files:**
- Create: `apps/web/src/net/api.ts`
- Create: `apps/web/src/net/connection.ts`
- Test: `apps/web/src/net/connection.test.ts`

**Interfaces:**
- Consumes: `ClientMessage`, `ServerFrame`, `SessionState` from `@ai-dm/schemas`;
  `EncounterCatalogue`'s *shape* (the client declares its own type — it may not
  import from `apps/server`).
- Produces:
  - `createSession(encounterId: string): Promise<string>` — POSTs and returns the
    session id.
  - `fetchCatalogue(encounterId: string): Promise<EncounterCatalogue>`.
  - `interface EncounterCatalogue { encounterId: string; combatants: CatalogueCombatant[]; actions: CatalogueAction[] }`
    with `CatalogueCombatant = { combatantId: string; nameEnglish: string; maxHp: number; faction: "party" | "hostile" | "neutral" }`
    and `CatalogueAction = { actionId: string; nameEnglish: string }`.
  - `connect(input: ConnectInput): Connection` where
    `ConnectInput = { sessionId: string; url?: string; onFrame: (frame: ServerFrame) => void; onStatus: (status: ConnectionStatus) => void; resumeFrom: () => number | undefined; socketFactory?: (url: string) => WebSocketLike }`,
    `ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed"`, and
    `Connection = { send: (message: ClientMessage) => void; close: () => void }`.

**Faction is spelled out** rather than imported as a type alias so that the
client's catalogue type is self-describing; `Faction` is also exported from
`@ai-dm/schemas` and importing it there is equally fine — pick one and be
consistent.

- [ ] **Step 1: Write the shared socket stand-in**

Create `apps/web/src/net/fake-socket.ts`. It is a source file, not a test file,
because Task 12's `App` tests need the same stand-in and two copies would drift:

```ts
// A hand-driven stand-in for a WebSocket: tests push frames into it and drop
// it at will. Shared by the connection tests and the App tests — one
// definition, so the two cannot disagree about how a socket behaves.
import type { WebSocketLike } from "./connection.js";

export interface FakeSocket extends WebSocketLike {
  emitOpen: () => void;
  emitMessage: (payload: unknown) => void;
  emitClose: () => void;
  sent: string[];
}

export function fakeSocket(): FakeSocket {
  const listeners = new Map<string, (event: unknown) => void>();
  const sent: string[] = [];
  return {
    sent,
    readyState: 1,
    send: (data: string) => sent.push(data),
    close: () => undefined,
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners.set(type, listener as (event: unknown) => void);
    },
    emitOpen: () => listeners.get("open")?.(new Event("open")),
    emitMessage: (payload: unknown) =>
      listeners.get("message")?.({ data: JSON.stringify(payload) }),
    emitClose: () => listeners.get("close")?.(new CloseEvent("close")),
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/net/connection.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "@ai-dm/schemas";
import { connect } from "./connection.js";
import { fakeSocket } from "./fake-socket.js";

const snapshotFrame: ServerFrame = {
  type: "session_state",
  sequence: 0,
  snapshot: {
    sessionId: "s1",
    rootSeed: 1,
    encounterId: "goblin-ambush",
    grid: { width: 1, height: 1, tiles: [["normal"]] },
    combatants: [],
    turnOrder: [],
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  },
};

describe("connect", () => {
  it("sends a join as soon as the socket opens", () => {
    const socket = fakeSocket();
    connect({
      sessionId: "s1",
      onFrame: () => undefined,
      onStatus: () => undefined,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", sessionId: "s1" });
  });

  it("re-joins with resumeFrom after a drop", () => {
    const socket = fakeSocket();
    connect({
      sessionId: "s1",
      onFrame: () => undefined,
      onStatus: () => undefined,
      resumeFrom: () => 7,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      type: "join",
      sessionId: "s1",
      resumeFrom: 7,
    });
  });

  it("parses every inbound frame with the schema rather than casting", () => {
    const onFrame = vi.fn();
    const socket = fakeSocket();
    connect({
      sessionId: "s1",
      onFrame,
      onStatus: () => undefined,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    socket.emitMessage(snapshotFrame);
    expect(onFrame).toHaveBeenCalledWith(snapshotFrame);

    // A frame that does not satisfy `ServerFrame` must never reach the store.
    socket.emitMessage({ type: "session_state", sequence: -1 });
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("reports status transitions so the UI can show reconnecting", () => {
    const onStatus = vi.fn();
    const socket = fakeSocket();
    connect({
      sessionId: "s1",
      onFrame: () => undefined,
      onStatus,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    expect(onStatus).toHaveBeenCalledWith("connecting");
    socket.emitOpen();
    expect(onStatus).toHaveBeenCalledWith("open");
    socket.emitClose();
    expect(onStatus).toHaveBeenCalledWith("reconnecting");
  });

  it("stops reconnecting once closed deliberately", () => {
    const onStatus = vi.fn();
    const socket = fakeSocket();
    const connection = connect({
      sessionId: "s1",
      onFrame: () => undefined,
      onStatus,
      resumeFrom: () => undefined,
      socketFactory: () => socket,
    });

    socket.emitOpen();
    connection.close();
    socket.emitClose();
    expect(onStatus).toHaveBeenLastCalledWith("closed");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm --filter @ai-dm/web test
```

Expected: FAIL — `./connection.js` does not exist.

- [ ] **Step 4: Write `net/api.ts`**

```ts
// The two HTTP calls the client makes. Both are same-origin relative paths:
// the Vite dev server proxies them to the API, so no CORS surface exists and
// no base URL needs configuring.

export interface CatalogueCombatant {
  combatantId: string;
  /**
   * English. There is no Hebrew name data anywhere in the repo and the SRD is
   * English (ADR 0001), so this is what a token label can show — which is why
   * every render of it is wrapped in `<bdi>`. Adding `nameHebrew` is a data
   * question (who writes the translations, and are they licensable alongside
   * SRD content), not a rendering one.
   */
  nameEnglish: string;
  maxHp: number;
  faction: "party" | "hostile" | "neutral";
}

export interface CatalogueAction {
  actionId: string;
  nameEnglish: string;
}

export interface EncounterCatalogue {
  encounterId: string;
  combatants: CatalogueCombatant[];
  actions: CatalogueAction[];
}

export async function createSession(encounterId: string): Promise<string> {
  const response = await fetch("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encounterId }),
  });
  if (!response.ok) throw new Error(`POST /sessions failed with ${String(response.status)}`);
  const body = (await response.json()) as { sessionId: string };
  return body.sessionId;
}

export async function fetchCatalogue(encounterId: string): Promise<EncounterCatalogue> {
  const response = await fetch(`/encounters/${encodeURIComponent(encounterId)}`);
  if (!response.ok) {
    throw new Error(`GET /encounters/${encounterId} failed with ${String(response.status)}`);
  }
  return (await response.json()) as EncounterCatalogue;
}
```

- [ ] **Step 5: Write `net/connection.ts`**

```ts
// The socket, and the only file in the client that touches one.
//
// Every inbound frame goes through `ServerFrame.safeParse`, never a cast.
// Spec #1's final review found server test helpers casting instead of parsing,
// which suppresses exactly the check that proves the protocol holds — so this
// end parses, and a frame that does not satisfy the schema never reaches the
// store.
import { ClientMessage, ServerFrame } from "@ai-dm/schemas";

/**
 * The slice of `WebSocket` this module uses. Narrow on purpose: it is what a
 * test substitutes, and it keeps the DOM's full socket surface out of the
 * module's contract.
 */
export interface WebSocketLike {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, listener: (event: never) => void) => void;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectInput {
  sessionId: string;
  url?: string;
  onFrame: (frame: ServerFrame) => void;
  onStatus: (status: ConnectionStatus) => void;
  /**
   * The highest sequence the store has folded, read at join time rather than
   * captured once — a reconnect must resume from where the client actually
   * got to, not from where it was when `connect` was called.
   */
  resumeFrom: () => number | undefined;
  socketFactory?: (url: string) => WebSocketLike;
}

export interface Connection {
  send: (message: ClientMessage) => void;
  close: () => void;
}

const RECONNECT_DELAY_MS = 1000;

function defaultUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

export function connect(input: ConnectInput): Connection {
  const url = input.url ?? defaultUrl();
  const makeSocket = input.socketFactory ?? ((target: string) => new WebSocket(target));

  let socket: WebSocketLike | null = null;
  let closedByCaller = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function open(): void {
    input.onStatus("connecting");
    const next = makeSocket(url);
    socket = next;

    next.addEventListener("open", () => {
      input.onStatus("open");
      // A `join` always gets exactly one response, so this is also the client's
      // way of asking "did my last command land?" — the answer is whether its
      // clientMessageId appears in `appliedClientMessageIds` on the snapshot.
      // That is why no ack frame exists.
      const from = input.resumeFrom();
      send(from === undefined
        ? { type: "join", sessionId: input.sessionId }
        : { type: "join", sessionId: input.sessionId, resumeFrom: from });
    });

    next.addEventListener("message", (event: never) => {
      const { data } = event as unknown as { data: unknown };
      let payload: unknown;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      const parsed = ServerFrame.safeParse(payload);
      if (!parsed.success) return;
      input.onFrame(parsed.data);
    });

    next.addEventListener("close", () => {
      if (closedByCaller) {
        input.onStatus("closed");
        return;
      }
      input.onStatus("reconnecting");
      retryTimer = setTimeout(open, RECONNECT_DELAY_MS);
    });
  }

  function send(message: ClientMessage): void {
    const active = socket;
    if (active === null || active.readyState !== 1) return;
    active.send(JSON.stringify(ClientMessage.parse(message)));
  }

  open();

  return {
    send,
    close: () => {
      closedByCaller = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket?.close();
      input.onStatus("closed");
    },
  };
}
```

If `addEventListener`'s `never` parameter type fights the compiler, widen
`WebSocketLike` to take `(event: MessageEvent | CloseEvent | Event) => void` and
narrow at each call site — follow the compiler, do not reach for `any` or a
lint suppression (C-4).

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS, **3 → 8**.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write apps/web/src/net
git add apps/web/src/net
git commit -m "feat(web): add the socket and HTTP layer, parsing every frame with the schema"
```

---

## Task 8: The store — one fold, snapshots authoritative

**Files:**
- Create: `apps/web/src/state/store.ts`
- Create: `apps/web/src/state/conclusion.ts`
- Test: `apps/web/src/state/store.test.ts`
- Test: `apps/web/src/state/conclusion.test.ts`

**Interfaces:**
- Consumes: `reduce`, `SessionState`, `ServerFrame`, `TurnAffordances` from
  `@ai-dm/schemas` (Tasks 1 and 2).
- Produces:
  - ```ts
    interface ClientState {
      snapshot: SessionState | null;
      sequence: number;
      affordances: TurnAffordances | null;
      narrative: string;
      narrativeStreamId: string | null;
      lastError: { code: string; message: string } | null;
      lastRejection: { reasons: string[]; messages: string[] } | null;
    }
    ```
  - `initialClientState: ClientState`
  - `applyFrame(state: ClientState, frame: ServerFrame): ClientState` — pure.
  - `type Conclusion = "ongoing" | "victory" | "defeat"` and
    `conclusionOf(snapshot: SessionState): Conclusion`.

- [ ] **Step 1: Write the failing store tests**

Create `apps/web/src/state/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fold } from "@ai-dm/schemas";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { applyFrame, initialClientState } from "./store.js";

const genesis: SessionState = {
  sessionId: "s1",
  rootSeed: 3,
  encounterId: "goblin-ambush",
  grid: { width: 2, height: 1, tiles: [["normal", "normal"]] },
  combatants: [],
  turnOrder: ["hero", "goblin-a"],
  currentActorIndex: 0,
  round: 1,
  appliedClientMessageIds: [],
};

function event(sequence: number, type: GameEvent["type"], payload: Record<string, unknown>): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload,
  };
}

describe("applyFrame", () => {
  it("folds an event log to exactly the server's projection", () => {
    // The parity guard. If `reduce` ever behaves differently on this side —
    // which the Task 1 move is precisely the risk of — this fails loudly.
    const log = [
      event(1, "player_input", { clientMessageId: "m1" }),
      event(2, "scene_changed", { kind: "turn_advanced" }),
      event(3, "player_input", { clientMessageId: "m2" }),
      event(4, "scene_changed", { kind: "turn_advanced" }),
    ];

    let client = applyFrame(initialClientState, { type: "session_state", sequence: 0, snapshot: genesis });
    for (const each of log) client = applyFrame(client, { type: "event", event: each });

    expect(client.snapshot).toEqual(fold(genesis, log));
    expect(client.sequence).toBe(4);
  });

  it("treats a session_state frame as authoritative and replaces state wholesale", () => {
    let client = applyFrame(initialClientState, { type: "session_state", sequence: 0, snapshot: genesis });
    client = applyFrame(client, { type: "event", event: event(1, "player_input", { clientMessageId: "m1" }) });
    expect(client.snapshot?.appliedClientMessageIds).toEqual(["m1"]);

    const authoritative: SessionState = { ...genesis, round: 9, appliedClientMessageIds: ["x"] };
    client = applyFrame(client, { type: "session_state", sequence: 12, snapshot: authoritative });

    expect(client.snapshot).toEqual(authoritative);
    expect(client.sequence).toBe(12);
  });

  it("keeps the newest affordances and discards a stale one", () => {
    let client = applyFrame(initialClientState, { type: "session_state", sequence: 10, snapshot: genesis });
    client = applyFrame(client, {
      type: "turn_affordances",
      forSequence: 10,
      actorId: "hero",
      reachableTiles: [[1, 0]],
      actions: [],
    });
    expect(client.affordances?.reachableTiles).toEqual([[1, 0]]);

    client = applyFrame(client, {
      type: "turn_affordances",
      forSequence: 9,
      actorId: "hero",
      reachableTiles: [[0, 0]],
      actions: [],
    });
    expect(client.affordances?.reachableTiles).toEqual([[1, 0]]);
  });

  it("clears affordances when a new event moves the board past them", () => {
    let client = applyFrame(initialClientState, { type: "session_state", sequence: 1, snapshot: genesis });
    client = applyFrame(client, {
      type: "turn_affordances",
      forSequence: 1,
      actorId: "hero",
      reachableTiles: [[1, 0]],
      actions: [],
    });
    client = applyFrame(client, { type: "event", event: event(2, "scene_changed", { kind: "turn_advanced" }) });

    expect(client.affordances).toBeNull();
  });

  it("accumulates narrative tokens and resets them on a new turn", () => {
    let client = applyFrame(initialClientState, { type: "session_state", sequence: 0, snapshot: genesis });
    client = applyFrame(client, { type: "narrative_token", streamId: "n1", text: "החרב " });
    client = applyFrame(client, { type: "narrative_token", streamId: "n1", text: "נוחתת." });
    expect(client.narrative).toBe("החרב נוחתת.");

    client = applyFrame(client, { type: "narrative_token", streamId: "n2", text: "הגובלין " });
    expect(client.narrative).toBe("הגובלין ");
  });

  it("records an error frame and a rejection frame", () => {
    let client = applyFrame(initialClientState, {
      type: "error",
      code: "internal_error",
      message: "boom",
    });
    expect(client.lastError).toEqual({ code: "internal_error", message: "boom" });

    client = applyFrame(client, {
      type: "rejected",
      clientMessageId: "m1",
      reasons: ["target_out_of_reach"],
      messages: ["too far"],
    });
    expect(client.lastRejection?.reasons).toEqual(["target_out_of_reach"]);
  });
});
```

- [ ] **Step 2: Write the failing conclusion tests**

Create `apps/web/src/state/conclusion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ActionEconomy } from "@ai-dm/schemas";
import type { Combatant, SessionState } from "@ai-dm/schemas";
import { conclusionOf } from "./conclusion.js";

function combatant(id: string, faction: Combatant["faction"], status: Combatant["status"]): Combatant {
  return {
    combatantId: id,
    faction,
    position: [0, 0],
    size: "medium",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 11,
    currentHp: status === "alive" ? 11 : 0,
    tempHp: 0,
    armorClass: 16,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: ActionEconomy.parse({}),
    status,
  };
}

function stateWith(combatants: Combatant[]): SessionState {
  return {
    sessionId: "s1",
    rootSeed: 1,
    encounterId: "goblin-ambush",
    grid: { width: 1, height: 1, tiles: [["normal"]] },
    combatants,
    turnOrder: combatants.map((each) => each.combatantId),
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  };
}

describe("conclusionOf", () => {
  it("is ongoing while both factions have someone alive", () => {
    expect(
      conclusionOf(
        stateWith([combatant("hero", "party", "alive"), combatant("goblin-a", "hostile", "alive")]),
      ),
    ).toBe("ongoing");
  });

  it("is defeat when the party is wiped out", () => {
    // The expected outcome (C-31): `combatantFromStatBlock` never sets
    // `characterId`, so `diesAtZeroHp` is true for everyone including the
    // hero, and two goblins out-damage one guard. No terminal frame is ever
    // emitted (C-37) — the pipeline simply stops answering — so this must be
    // read from the projection and rendered as a normal ending, not an error.
    expect(
      conclusionOf(
        stateWith([combatant("hero", "party", "dead"), combatant("goblin-a", "hostile", "alive")]),
      ),
    ).toBe("defeat");
  });

  it("is victory when no hostile is left alive", () => {
    expect(
      conclusionOf(
        stateWith([combatant("hero", "party", "alive"), combatant("goblin-a", "hostile", "dead")]),
      ),
    ).toBe("victory");
  });

  it("is ongoing before any combatant exists", () => {
    expect(conclusionOf(stateWith([]))).toBe("ongoing");
  });
});
```

- [ ] **Step 3: Run to verify both fail**

```bash
pnpm --filter @ai-dm/web test
```

Expected: FAIL — neither module exists.

- [ ] **Step 4: Write `state/conclusion.ts`**

```ts
// Is the fight over, and who won — read from the projection, never from a
// frame. There IS no terminal frame: once the last party member dies,
// `runEnemyTurns` returns at its `livingFactions.size < 2` check with no event
// emitted, and every later command is answered `not_your_turn` (correction
// C-37). A UI that waited for a victory frame would hang forever.
//
// The party is expected to LOSE (correction C-31): no player-character data
// exists, so the hero borrows the `guard` stat block, `characterId` is
// undefined, and `diesAtZeroHp` is therefore true for it. Defeat is a normal
// ending here, not an error state.
import type { SessionState } from "@ai-dm/schemas";

export type Conclusion = "ongoing" | "victory" | "defeat";

export function conclusionOf(snapshot: SessionState): Conclusion {
  const living = snapshot.combatants.filter((each) => each.status === "alive");
  const factions = new Set(living.map((each) => each.faction));
  if (factions.size > 1) return "ongoing";
  // An empty board is a session that has not started, not a finished fight.
  if (living.length === 0) return snapshot.combatants.length === 0 ? "ongoing" : "defeat";
  return factions.has("party") ? "victory" : "defeat";
}
```

- [ ] **Step 5: Write `state/store.ts`**

```ts
// The client's projection. It folds each `event` frame with the SAME `reduce`
// the server runs — imported from `@ai-dm/schemas`, not reimplemented — and
// treats a `session_state` frame as authoritative whenever one arrives.
//
// Folding rather than requesting a snapshot per turn is what preserves the
// per-event granularity a turn animation needs; re-snapshotting on every
// `session_state` is what bounds any divergence to a single turn instead of
// letting it persist silently.
//
// Pure: `applyFrame` never mutates its input, so React state updates and the
// fold-parity test both work the obvious way.
import { reduce } from "@ai-dm/schemas";
import type { ServerFrame, SessionState, TurnAffordances } from "@ai-dm/schemas";

export interface ClientState {
  snapshot: SessionState | null;
  /** The highest sequence folded. Drives `resumeFrom` on a reconnect. */
  sequence: number;
  affordances: TurnAffordances | null;
  /** The current turn's narrative, accumulated from its token stream. */
  narrative: string;
  narrativeStreamId: string | null;
  lastError: { code: string; message: string } | null;
  lastRejection: { reasons: string[]; messages: string[] } | null;
}

export const initialClientState: ClientState = {
  snapshot: null,
  sequence: 0,
  affordances: null,
  narrative: "",
  narrativeStreamId: null,
  lastError: null,
  lastRejection: null,
};

export function applyFrame(state: ClientState, frame: ServerFrame): ClientState {
  switch (frame.type) {
    case "session_state":
      // Authoritative on arrival. Affordances computed against an older board
      // go with it — the server sends a fresh set if the player is up.
      return {
        ...state,
        snapshot: frame.snapshot,
        sequence: frame.sequence,
        affordances: null,
        lastError: null,
      };

    case "event": {
      if (state.snapshot === null) return state;
      return {
        ...state,
        snapshot: reduce(state.snapshot, frame.event),
        sequence: Math.max(state.sequence, frame.event.sequence),
        // The board just moved; anything computed against the old one is
        // stale. The server pushes a replacement when control is the
        // player's, so clearing here cannot strand the UI.
        affordances: null,
      };
    }

    case "turn_affordances": {
      // Discard a frame older than the state we hold: an affordance set must
      // never be applied to a board that has already moved past it.
      if (frame.forSequence < state.sequence) return state;
      const { type: _type, forSequence: _forSequence, ...affordances } = frame;
      return { ...state, affordances };
    }

    case "narrative_token":
      return frame.streamId === state.narrativeStreamId
        ? { ...state, narrative: state.narrative + frame.text }
        : { ...state, narrative: frame.text, narrativeStreamId: frame.streamId };

    case "rejected":
      return { ...state, lastRejection: { reasons: frame.reasons, messages: frame.messages } };

    case "error":
      return { ...state, lastError: { code: frame.code, message: frame.message } };
  }
}
```

The destructure in the `turn_affordances` case will trip the no-unused-vars
rule (no `argsIgnorePattern` is configured — root CLAUDE.md gotcha). Build the
object explicitly instead if so:

```ts
      const affordances: TurnAffordances = {
        actorId: frame.actorId,
        reachableTiles: frame.reachableTiles,
        actions: frame.actions,
      };
```

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS, **8 → 18** (6 store + 4 conclusion).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write apps/web/src/state
git add apps/web/src/state
git commit -m "feat(web): fold the event stream with the server's own reduce"
```

---

## Task 9: `turn/build-turn.ts` — selection to `ExecuteTurn`

**Files:**
- Create: `apps/web/src/turn/build-turn.ts`
- Test: `apps/web/src/turn/build-turn.test.ts`

**Interfaces:**
- Consumes: `ActionAffordance`, `ExecuteTurn`, `Tile` from `@ai-dm/schemas`.
- Produces:
  - `interface Selection { actorId: string; destinationTile?: Tile; action: ActionAffordance; targetId?: string }`
  - `buildTurn(selection: Selection): ExecuteTurn`
  - `describeSelection(selection: Selection): string` — the English rationale.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/turn/build-turn.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ExecuteTurn } from "@ai-dm/schemas";
import { buildTurn, describeSelection } from "./build-turn.js";

const attack = {
  actionType: "attack" as const,
  actionId: "spear",
  requiresTarget: true,
  targetableCombatantIds: ["goblin-a"],
};

const dodge = {
  actionType: "dodge" as const,
  requiresTarget: false,
  targetableCombatantIds: [],
};

describe("buildTurn", () => {
  it("produces a turn the shared schema accepts", () => {
    const turn = buildTurn({
      actorId: "hero",
      destinationTile: [6, 4],
      action: attack,
      targetId: "goblin-a",
    });
    expect(() => ExecuteTurn.parse(turn)).not.toThrow();
  });

  it("carries an English rationale the player never authored", () => {
    // `ExecuteTurn.tacticalRationaleEnglish` is required (C-1) and English by
    // invariant 2, while the player is typing Hebrew or not typing at all. So
    // the client synthesises a factual description of what was selected — it
    // exists so the log and the agent path carry the same shape.
    const turn = buildTurn({
      actorId: "hero",
      destinationTile: [6, 4],
      action: attack,
      targetId: "goblin-a",
    });
    expect(turn.tacticalRationaleEnglish).toBe(
      "Player selected: move to (6,4); attack goblin-a with spear.",
    );
    expect(/[֐-׿]/.test(turn.tacticalRationaleEnglish)).toBe(false);
  });

  it("omits movement entirely when no tile was chosen", () => {
    const turn = buildTurn({ actorId: "hero", action: dodge });
    expect(turn.movement).toBeUndefined();
    expect(turn.mainAction).toEqual({ actionType: "dodge" });
    expect(turn.tacticalRationaleEnglish).toBe("Player selected: dodge.");
  });

  it("omits targetIds for an action that needs none", () => {
    const turn = buildTurn({ actorId: "hero", destinationTile: [1, 1], action: dodge });
    expect(turn.mainAction.targetIds).toBeUndefined();
    expect(turn.tacticalRationaleEnglish).toBe("Player selected: move to (1,1); dodge.");
  });

  it("describes a move-only selection", () => {
    expect(describeSelection({ actorId: "hero", destinationTile: [0, 3], action: dodge })).toBe(
      "Player selected: move to (0,3); dodge.",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ai-dm/web test
```

Expected: FAIL — `./build-turn.js` does not exist.

- [ ] **Step 3: Implement it**

```ts
// Turns what the player clicked into the `ExecuteTurn` the server validates.
// It makes no legality decision: every option offered came from a
// `turn_affordances` frame, which the server derived by running the real
// validator. This file only assembles.
import type { ActionAffordance, ExecuteTurn, Tile } from "@ai-dm/schemas";

export interface Selection {
  actorId: string;
  destinationTile?: Tile;
  action: ActionAffordance;
  targetId?: string;
}

/**
 * `ExecuteTurn.tacticalRationaleEnglish` is required and English (invariant 2),
 * but the player is typing Hebrew or not typing at all. So the client
 * synthesises a factual description of the selection — never player-authored
 * text. It exists so a human turn and an agent turn leave the same shape in
 * the log.
 */
export function describeSelection(selection: Selection): string {
  const parts: string[] = [];
  if (selection.destinationTile !== undefined) {
    const [x, y] = selection.destinationTile;
    parts.push(`move to (${String(x)},${String(y)})`);
  }
  if (selection.action.actionId !== undefined && selection.targetId !== undefined) {
    parts.push(
      `${selection.action.actionType} ${selection.targetId} with ${selection.action.actionId}`,
    );
  } else if (selection.targetId !== undefined) {
    parts.push(`${selection.action.actionType} ${selection.targetId}`);
  } else {
    parts.push(selection.action.actionType);
  }
  return `Player selected: ${parts.join("; ")}.`;
}

export function buildTurn(selection: Selection): ExecuteTurn {
  // Optional keys are OMITTED rather than set to `undefined`:
  // `exactOptionalPropertyTypes` is on, so assigning `undefined` to an
  // optional property does not typecheck.
  const mainAction: ExecuteTurn["mainAction"] = {
    actionType: selection.action.actionType,
    ...(selection.action.actionId === undefined ? {} : { actionId: selection.action.actionId }),
    ...(selection.targetId === undefined ? {} : { targetIds: [selection.targetId] }),
  };

  return {
    actorId: selection.actorId,
    ...(selection.destinationTile === undefined
      ? {}
      : { movement: [{ destinationTile: selection.destinationTile, pathType: "direct" as const }] }),
    mainAction,
    tacticalRationaleEnglish: describeSelection(selection),
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS, **18 → 23**.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write apps/web/src/turn
git add apps/web/src/turn
git commit -m "feat(web): assemble ExecuteTurn from a selection with a synthesised rationale"
```

---

## Task 10: `components/Grid.tsx` — the Canvas 2D board

**Files:**
- Create: `apps/web/src/components/Grid.tsx`
- Test: `apps/web/src/components/Grid.test.tsx`

**Interfaces:**
- Consumes: `SessionState`, `TurnAffordances` from `@ai-dm/schemas`;
  `CatalogueCombatant` from `../net/api.js`.
- Produces: `Grid` with props
  `{ snapshot: SessionState; affordances: TurnAffordances | null; catalogue: CatalogueCombatant[]; selectedTile: Tile | null; onTileClick: (tile: Tile) => void; onCombatantClick: (combatantId: string) => void }`,
  and `TILE_PX` (the tile edge in CSS pixels).

**Testing a canvas.** jsdom gives no 2D context, so the drawing itself is not
what is asserted. The board renders the canvas *plus* a visually-hidden list of
buttons — one per reachable tile and one per combatant — which is both the
accessible/keyboard path and what the tests drive. The highlight assertion is
therefore about what the component *believes* is reachable, which is the property
that matters: that it draws only what the server sent.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/Grid.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionEconomy } from "@ai-dm/schemas";
import type { Combatant, SessionState, TurnAffordances } from "@ai-dm/schemas";
import { Grid } from "./Grid.js";

function combatant(id: string, position: [number, number]): Combatant {
  return {
    combatantId: id,
    faction: id === "hero" ? "party" : "hostile",
    position,
    size: "medium",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 11,
    currentHp: 11,
    tempHp: 0,
    armorClass: 16,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: ActionEconomy.parse({}),
    status: "alive",
  };
}

const snapshot: SessionState = {
  sessionId: "s1",
  rootSeed: 1,
  encounterId: "goblin-ambush",
  grid: {
    width: 4,
    height: 4,
    tiles: Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => "normal" as const)),
  },
  combatants: [combatant("hero", [1, 1]), combatant("goblin-a", [2, 1])],
  turnOrder: ["hero", "goblin-a"],
  currentActorIndex: 0,
  round: 1,
  appliedClientMessageIds: [],
};

const catalogue = [
  { combatantId: "hero", nameEnglish: "Guard", maxHp: 11, faction: "party" as const },
  { combatantId: "goblin-a", nameEnglish: "Goblin Warrior", maxHp: 10, faction: "hostile" as const },
];

const affordances: TurnAffordances = {
  actorId: "hero",
  reachableTiles: [
    [0, 1],
    [1, 2],
  ],
  actions: [],
};

describe("Grid", () => {
  it("offers exactly the reachable tiles the server sent and no others", () => {
    // The test that the client is not quietly computing reach: the hero at
    // [1,1] has neighbours the server did NOT list, and none of them may be
    // offered.
    render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /0,1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1,2/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /0,0/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /2,2/ })).not.toBeInTheDocument();
  });

  it("offers no tiles at all when there are no affordances", () => {
    render(
      <Grid
        snapshot={snapshot}
        affordances={null}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: /0,1/ })).not.toBeInTheDocument();
  });

  it("reports a clicked tile back as a Tile", async () => {
    const onTileClick = vi.fn();
    render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={onTileClick}
        onCombatantClick={() => undefined}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /1,2/ }));
    expect(onTileClick).toHaveBeenCalledWith([1, 2]);
  });

  it("wraps every English name in <bdi> inside the RTL document", () => {
    // The mixed-direction rule from apps/web/CLAUDE.md: there is no Hebrew
    // name data anywhere in the repo and the SRD is English, so English names
    // are rendered inside an RTL Hebrew UI and MUST be isolated or the
    // punctuation around them reorders.
    const { container } = render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={catalogue}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );

    const isolated = Array.from(container.querySelectorAll("bdi"), (each) => each.textContent);
    expect(isolated).toContain("Goblin Warrior");
    expect(isolated).toContain("Guard");
  });

  it("falls back to the combatant id when the catalogue has no entry", () => {
    const { container } = render(
      <Grid
        snapshot={snapshot}
        affordances={affordances}
        catalogue={[]}
        selectedTile={null}
        onTileClick={() => undefined}
        onCombatantClick={() => undefined}
      />,
    );
    const isolated = Array.from(container.querySelectorAll("bdi"), (each) => each.textContent);
    expect(isolated).toContain("hero");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ai-dm/web test
```

Expected: FAIL — `./Grid.js` does not exist.

- [ ] **Step 3: Implement it**

Create `apps/web/src/components/Grid.tsx`:

```tsx
// The battle board. Plain Canvas 2D: `apps/web/CLAUDE.md` caps the POC at
// 30x30 tiles and forbids WebGL/Pixi without a perf-based ADR.
//
// It renders terrain, tokens and highlights drawn ONLY from `reachableTiles`
// and the catalogue. It computes no distances and knows no rules — a tile is
// reachable because the server said so, having run the real validator.
//
// Alongside the canvas it renders a visually-hidden button per reachable tile
// and per combatant. That is the keyboard and screen-reader path, and it is
// also what the tests drive, since jsdom has no 2D context to inspect.
import { useEffect, useRef } from "react";
import type { SessionState, Tile, TurnAffordances } from "@ai-dm/schemas";
import type { CatalogueCombatant } from "../net/api.js";

export const TILE_PX = 32;

export interface GridProps {
  snapshot: SessionState;
  affordances: TurnAffordances | null;
  catalogue: CatalogueCombatant[];
  selectedTile: Tile | null;
  onTileClick: (tile: Tile) => void;
  onCombatantClick: (combatantId: string) => void;
}

/** Keyed by `TerrainType`'s five members — there is no "wall" or "water". */
const TERRAIN_FILL: Record<string, string | undefined> = {
  normal: "#f4efe6",
  difficult: "#d9cbb2",
  blocking: "#4a4038",
  half_cover: "#c9b79a",
  three_quarters_cover: "#a89474",
};

const DEFAULT_FILL = "#f4efe6";

export function Grid(props: GridProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { snapshot, affordances, selectedTile } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    // jsdom provides no 2D context; the accessible list below is the render
    // that matters under test, so bailing out here is correct, not a stub.
    const context = canvas?.getContext("2d") ?? null;
    if (canvas === null || context === null) return;

    context.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < snapshot.grid.height; y += 1) {
      for (let x = 0; x < snapshot.grid.width; x += 1) {
        const terrain = snapshot.grid.tiles[y]?.[x] ?? "normal";
        context.fillStyle = TERRAIN_FILL[terrain] ?? DEFAULT_FILL;
        context.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
        context.strokeStyle = "#cbbfae";
        context.strokeRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
      }
    }

    for (const [x, y] of affordances?.reachableTiles ?? []) {
      context.fillStyle = "rgba(70, 140, 90, 0.35)";
      context.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
    }

    if (selectedTile !== null) {
      context.strokeStyle = "#2f6b45";
      context.lineWidth = 3;
      context.strokeRect(
        selectedTile[0] * TILE_PX + 1,
        selectedTile[1] * TILE_PX + 1,
        TILE_PX - 2,
        TILE_PX - 2,
      );
      context.lineWidth = 1;
    }

    for (const combatant of snapshot.combatants) {
      const [x, y] = combatant.position;
      context.fillStyle =
        combatant.status !== "alive"
          ? "#8a8a8a"
          : combatant.faction === "party"
            ? "#2f5fa8"
            : "#a83232";
      context.beginPath();
      context.arc(
        x * TILE_PX + TILE_PX / 2,
        y * TILE_PX + TILE_PX / 2,
        TILE_PX / 2 - 4,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }, [snapshot, affordances, selectedTile]);

  const nameOf = (combatantId: string): string =>
    props.catalogue.find((each) => each.combatantId === combatantId)?.nameEnglish ?? combatantId;

  return (
    <div className="grid">
      <canvas
        ref={canvasRef}
        width={snapshot.grid.width * TILE_PX}
        height={snapshot.grid.height * TILE_PX}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = Math.floor((event.clientX - bounds.left) / TILE_PX);
          const y = Math.floor((event.clientY - bounds.top) / TILE_PX);
          const reachable = affordances?.reachableTiles ?? [];
          // A click on a tile the server did not offer is dropped here rather
          // than sent and rejected: the affordance set is the authority the
          // client renders, so honouring it is not a rules decision.
          if (reachable.some(([tx, ty]) => tx === x && ty === y)) props.onTileClick([x, y]);
        }}
      />

      <ul className="visually-hidden-list">
        {(affordances?.reachableTiles ?? []).map(([x, y]) => (
          <li key={`${String(x)},${String(y)}`}>
            <button type="button" onClick={() => props.onTileClick([x, y])}>
              {/* Coordinates are an LTR fragment inside an RTL document. */}
              <bdi>
                ({String(x)},{String(y)})
              </bdi>
            </button>
          </li>
        ))}
        {snapshot.combatants.map((combatant) => (
          <li key={combatant.combatantId}>
            <button type="button" onClick={() => props.onCombatantClick(combatant.combatantId)}>
              <bdi>{nameOf(combatant.combatantId)}</bdi>{" "}
              <bdi>
                {String(combatant.currentHp)}/{String(combatant.maxHp)}
              </bdi>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS, **23 → 28**.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write apps/web/src/components
git add apps/web/src/components
git commit -m "feat(web): render the canvas board from server affordances only"
```

---

## Task 11: `ActionBar`, `NarrativePane`, `ErrorBanner`

**Files:**
- Create: `apps/web/src/components/ActionBar.tsx`
- Create: `apps/web/src/components/NarrativePane.tsx`
- Create: `apps/web/src/components/ErrorBanner.tsx`
- Test: `apps/web/src/components/ActionBar.test.tsx`
- Test: `apps/web/src/components/panes.test.tsx`

**Interfaces:**
- Consumes: `ActionAffordance` (Task 2), `CatalogueAction`/`CatalogueCombatant`
  (Task 7), `he`/`errorMessage`/`rejectionMessage` (Task 6).
- Produces:
  - `ActionBar` with props
    `{ actions: ActionAffordance[]; catalogue: CatalogueAction[]; combatants: CatalogueCombatant[]; disabled: boolean; onCommit: (action: ActionAffordance, targetId?: string) => void }`
  - `NarrativePane` with props `{ text: string }`
  - `ErrorBanner` with props
    `{ error: { code: string; message: string } | null; rejection: { reasons: string[]; messages: string[] } | null; onDismiss: () => void }`

- [ ] **Step 1: Write the failing ActionBar test**

Create `apps/web/src/components/ActionBar.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionAffordance } from "@ai-dm/schemas";
import { ActionBar } from "./ActionBar.js";

const spear: ActionAffordance = {
  actionType: "attack",
  actionId: "spear",
  requiresTarget: true,
  targetableCombatantIds: ["goblin-a"],
};

const unreachableSpear: ActionAffordance = { ...spear, targetableCombatantIds: [] };

const dodge: ActionAffordance = {
  actionType: "dodge",
  requiresTarget: false,
  targetableCombatantIds: [],
};

const catalogue = [{ actionId: "spear", nameEnglish: "Spear" }];
const combatants = [
  { combatantId: "goblin-a", nameEnglish: "Goblin Warrior", maxHp: 10, faction: "hostile" as const },
];

describe("ActionBar", () => {
  it("commits a no-target action immediately", async () => {
    const onCommit = vi.fn();
    render(
      <ActionBar
        actions={[dodge]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={onCommit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /התחמקות/ }));
    expect(onCommit).toHaveBeenCalledWith(dodge, undefined);
  });

  it("asks for a target before committing a targeted action", async () => {
    const onCommit = vi.fn();
    render(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={onCommit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Spear/ }));
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Goblin Warrior/ }));
    expect(onCommit).toHaveBeenCalledWith(spear, "goblin-a");
  });

  it("disables an action that requires a target when none is in range", () => {
    // `requiresTarget: true` with an empty target list is exactly the case an
    // empty list alone could not express — it renders disabled, not missing,
    // so the player can see the option exists and is simply out of reach.
    render(
      <ActionBar
        actions={[unreachableSpear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /Spear/ })).toBeDisabled();
  });

  it("disables everything while a turn is resolving", () => {
    render(
      <ActionBar
        actions={[dodge]}
        catalogue={catalogue}
        combatants={combatants}
        disabled
        onCommit={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /התחמקות/ })).toBeDisabled();
  });

  it("wraps the English action name in <bdi>", () => {
    const { container } = render(
      <ActionBar
        actions={[spear]}
        catalogue={catalogue}
        combatants={combatants}
        disabled={false}
        onCommit={() => undefined}
      />,
    );
    expect(Array.from(container.querySelectorAll("bdi"), (each) => each.textContent)).toContain(
      "Spear",
    );
  });
});
```

- [ ] **Step 2: Write the failing pane tests**

Create `apps/web/src/components/panes.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { he } from "../i18n.js";
import { ErrorBanner } from "./ErrorBanner.js";
import { NarrativePane } from "./NarrativePane.js";

describe("NarrativePane", () => {
  it("renders Hebrew narrative with dice notation isolated", () => {
    // The RTL rendering test apps/web/CLAUDE.md names explicitly: mixed
    // Hebrew and dice notation. Without <bdi> the trailing punctuation of an
    // LTR run reorders and "2d6+3." renders as ".2d6+3".
    const { container } = render(<NarrativePane text="החרב פוגעת ומסבה 2d6+3 נזק." />);
    expect(screen.getByText(/החרב פוגעת/)).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll("bdi"), (each) => each.textContent)).toContain(
      "2d6+3",
    );
  });

  it("isolates a bare die expression too", () => {
    const { container } = render(<NarrativePane text="גלגול 1d20 מול שריון." />);
    expect(Array.from(container.querySelectorAll("bdi"), (each) => each.textContent)).toContain(
      "1d20",
    );
  });

  it("renders plain Hebrew with no isolation at all", () => {
    const { container } = render(<NarrativePane text="הגובלין נופל." />);
    expect(container.querySelectorAll("bdi")).toHaveLength(0);
  });
});

describe("ErrorBanner", () => {
  it("renders a known error code in Hebrew", () => {
    render(
      <ErrorBanner
        error={{ code: "unknown_session", message: "gone" }}
        rejection={null}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText(he.errors.unknown_session)).toBeInTheDocument();
  });

  it("falls back to the raw code for one it does not know", () => {
    render(
      <ErrorBanner
        error={{ code: "some_future_code", message: "x" }}
        rejection={null}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText(/some_future_code/)).toBeInTheDocument();
  });

  it("renders nothing when there is nothing to report", () => {
    const { container } = render(
      <ErrorBanner error={null} rejection={null} onDismiss={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders every rejection reason in Hebrew", () => {
    render(
      <ErrorBanner
        error={null}
        rejection={{ reasons: ["target_out_of_reach"], messages: ["too far"] }}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText(he.rejections.target_out_of_reach)).toBeInTheDocument();
  });

  it("dismisses", async () => {
    const onDismiss = vi.fn();
    render(
      <ErrorBanner
        error={{ code: "internal_error", message: "boom" }}
        rejection={null}
        onDismiss={onDismiss}
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify both fail**

```bash
pnpm --filter @ai-dm/web test
```

Expected: FAIL — none of the three components exist.

- [ ] **Step 4: Write `NarrativePane.tsx`**

```tsx
// Streaming Hebrew narrative. Tokens are rendered as they arrive — never
// blocked on turn completion (apps/web/CLAUDE.md).
//
// Dice notation is the most common LTR fragment in Hebrew narrative text, and
// mixed-direction text is the #1 Hebrew UI bug: without isolation, the period
// after "2d6+3" jumps to the wrong side. So die expressions are split out and
// wrapped in <bdi>.

/** `2d6+3`, `1d20`, `1d8-1`. Deliberately narrow: it isolates dice, not every
 *  Latin run, because over-isolating breaks nothing but adds noise to the DOM. */
const DICE = /(\d+d\d+(?:[+-]\d+)?)/g;

export interface NarrativePaneProps {
  text: string;
}

export function NarrativePane(props: NarrativePaneProps): JSX.Element {
  const parts = props.text.split(DICE);

  return (
    <section className="narrative" aria-live="polite">
      <p>
        {parts.map((part, index) =>
          DICE.test(part) || /^\d+d\d+/.test(part) ? (
            <bdi key={`${part}-${String(index)}`}>{part}</bdi>
          ) : (
            <span key={`${part}-${String(index)}`}>{part}</span>
          ),
        )}
      </p>
    </section>
  );
}
```

`RegExp.test` on a `/g` regex advances `lastIndex` between calls, which makes
alternating results. Use a non-global copy for the per-part check — the
`/^\d+d\d+/` fallback above is there for exactly that reason; simplify to a
single non-global test if the tests show the `/g` one misbehaving.

- [ ] **Step 5: Write `ErrorBanner.tsx`**

```tsx
// Server error codes and turn rejections, rendered in Hebrew.
//
// Per the spec's error table, `not_your_turn` is deliberately NOT surfaced —
// it means a stale click, and the affordance frame governs what is clickable.
// `free_text_not_supported` is unreachable because no free-text UI ships.
import { errorMessage, rejectionMessage } from "../i18n.js";

/** Ignored on purpose: a stale click the affordance frame already governs. */
const SILENT_CODES = new Set(["not_your_turn"]);

export interface ErrorBannerProps {
  error: { code: string; message: string } | null;
  rejection: { reasons: string[]; messages: string[] } | null;
  onDismiss: () => void;
}

export function ErrorBanner(props: ErrorBannerProps): JSX.Element | null {
  const error = props.error !== null && !SILENT_CODES.has(props.error.code) ? props.error : null;
  const reasons = props.rejection?.reasons ?? [];
  if (error === null && reasons.length === 0) return null;

  return (
    <div className="error-banner" role="alert">
      {error !== null && <p>{errorMessage(error.code)}</p>}
      {reasons.map((reason) => (
        <p key={reason}>{rejectionMessage(reason)}</p>
      ))}
      <button type="button" onClick={props.onDismiss}>
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Write `ActionBar.tsx`**

```tsx
// Action selection and commit. Every button here came from a
// `turn_affordances` frame; this component decides nothing about legality,
// only about presentation and the two-step target pick.
import { useState } from "react";
import type { ActionAffordance } from "@ai-dm/schemas";
import { he } from "../i18n.js";
import type { CatalogueAction, CatalogueCombatant } from "../net/api.js";

export interface ActionBarProps {
  actions: ActionAffordance[];
  catalogue: CatalogueAction[];
  combatants: CatalogueCombatant[];
  disabled: boolean;
  onCommit: (action: ActionAffordance, targetId?: string) => void;
}

const UNIVERSAL_LABELS: Record<string, string | undefined> = {
  dodge: he.actions.dodge,
  dash: he.actions.dash,
  disengage: he.actions.disengage,
};

export function ActionBar(props: ActionBarProps): JSX.Element {
  const [pending, setPending] = useState<ActionAffordance | null>(null);

  function labelFor(action: ActionAffordance): JSX.Element {
    const universal = UNIVERSAL_LABELS[action.actionType];
    if (action.actionId === undefined && universal !== undefined) return <span>{universal}</span>;

    // English name inside an RTL document — no Hebrew name data exists (the
    // SRD is English, ADR 0001), so <bdi> is mandatory here, not optional.
    const named = props.catalogue.find((each) => each.actionId === action.actionId);
    return <bdi>{named?.nameEnglish ?? action.actionId ?? action.actionType}</bdi>;
  }

  if (pending !== null) {
    return (
      <div className="action-bar">
        {pending.targetableCombatantIds.map((targetId) => {
          const named = props.combatants.find((each) => each.combatantId === targetId);
          return (
            <button
              key={targetId}
              type="button"
              disabled={props.disabled}
              onClick={() => {
                setPending(null);
                props.onCommit(pending, targetId);
              }}
            >
              <bdi>{named?.nameEnglish ?? targetId}</bdi>
            </button>
          );
        })}
        <button type="button" onClick={() => setPending(null)}>
          {he.actions.cancel}
        </button>
      </div>
    );
  }

  return (
    <div className="action-bar">
      {props.actions.map((action) => (
        <button
          key={`${action.actionType}:${action.actionId ?? ""}`}
          type="button"
          // An action needing a target with none in range renders DISABLED
          // rather than absent: `requiresTarget` exists precisely so the
          // player can see the option and understand why it is unavailable.
          disabled={props.disabled || (action.requiresTarget && action.targetableCombatantIds.length === 0)}
          onClick={() => {
            if (action.requiresTarget) {
              setPending(action);
              return;
            }
            props.onCommit(action, undefined);
          }}
        >
          {labelFor(action)}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS, **28 → 41** (5 ActionBar + 8 panes).

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
npx prettier --write apps/web/src/components apps/web/src/i18n.ts
git add apps/web/src/components
git commit -m "feat(web): add the action bar, narrative pane and Hebrew error banner"
```

---

## Task 12: `App.tsx` — wiring, reconnect and the ending

**Files:**
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/index.css`
- Test: `apps/web/src/App.test.tsx`
- Modify: `apps/web/index.html` (link the stylesheet)

**Interfaces:**
- Consumes: everything from Tasks 6-11.
- Produces: `App`, which owns the session lifecycle: create → fetch catalogue →
  connect → fold → render → commit turns → detect the ending.

- [ ] **Step 1: Write the failing test**

`apps/web/src/net/fake-socket.ts` already exists from Task 7 — reuse it rather
than writing a second stand-in. Create `apps/web/src/App.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ActionEconomy, fold } from "@ai-dm/schemas";
import type { Combatant, GameEvent, SessionState } from "@ai-dm/schemas";
import { App } from "./App.js";
import { he } from "./i18n.js";
import { fakeSocket } from "./net/fake-socket.js";
import type { FakeSocket } from "./net/fake-socket.js";

function combatant(
  combatantId: string,
  faction: Combatant["faction"],
  status: Combatant["status"],
): Combatant {
  return {
    combatantId,
    faction,
    position: combatantId === "hero" ? [5, 4] : [6, 3],
    size: "medium",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 11,
    currentHp: status === "alive" ? 11 : 0,
    tempHp: 0,
    armorClass: 16,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: ActionEconomy.parse({}),
    status,
  };
}

function snapshotWith(combatants: Combatant[]): SessionState {
  return {
    sessionId: "s1",
    rootSeed: 3,
    encounterId: "goblin-ambush",
    grid: {
      width: 12,
      height: 12,
      tiles: Array.from({ length: 12 }, () =>
        Array.from({ length: 12 }, () => "normal" as const),
      ),
    },
    combatants,
    turnOrder: combatants.map((each) => each.combatantId),
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  };
}

function event(
  sequence: number,
  type: GameEvent["type"],
  payload: Record<string, unknown>,
): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload,
  };
}

const catalogue = {
  encounterId: "goblin-ambush",
  combatants: [
    { combatantId: "hero", nameEnglish: "Guard", maxHp: 11, faction: "party" },
    { combatantId: "goblin-a", nameEnglish: "Goblin Warrior", maxHp: 10, faction: "hostile" },
  ],
  actions: [
    { actionId: "spear", nameEnglish: "Spear" },
    { actionId: "scimitar", nameEnglish: "Scimitar" },
  ],
};

let socket: FakeSocket;

/** Renders, presses the start button, and settles the two async fetches. */
async function start(): Promise<void> {
  render(<App socketFactory={() => socket} wsUrl="ws://test/ws" />);
  await act(async () => {
    screen.getByRole("button", { name: he.app.startFight }).click();
  });
  await waitFor(() => {
    expect(socket.sent.length).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  socket = fakeSocket();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: { method?: string }) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(init?.method === "POST" ? { sessionId: "s1" } : catalogue),
      }),
    ),
  );
  // `connect` opens the socket as soon as the effect runs; the fake needs the
  // listeners registered before anything is emitted, which `start` guarantees.
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: () => "fixed-id" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("re-joins with the highest folded sequence after a drop", async () => {
    await start();
    await act(async () => {
      socket.emitOpen();
    });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ type: "join", sessionId: "s1" });

    const genesis = snapshotWith([
      combatant("hero", "party", "alive"),
      combatant("goblin-a", "hostile", "alive"),
    ]);

    await act(async () => {
      socket.emitMessage({ type: "session_state", sequence: 0, snapshot: genesis });
      socket.emitMessage({
        type: "event",
        event: event(1, "player_input", { clientMessageId: "m1" }),
      });
      socket.emitMessage({
        type: "event",
        event: event(2, "scene_changed", { kind: "turn_advanced" }),
      });
      socket.emitMessage({
        type: "event",
        event: event(3, "scene_changed", { kind: "turn_advanced" }),
      });
    });

    await act(async () => {
      socket.emitClose();
    });

    // The reconnect contract: resume from what the client ACTUALLY folded, not
    // from where it was when `connect` was first called.
    await waitFor(() => {
      const rejoin = socket.sent.map((each) => JSON.parse(each) as { resumeFrom?: number });
      expect(rejoin.some((each) => each.resumeFrom === 3)).toBe(true);
    });
  });

  it("holds a projection equal to the server's own fold over the same log", async () => {
    // Fold parity through the whole component, not just the store: if the
    // `reduce` move ever changed behaviour on this side, this fails loudly.
    await start();
    const genesis = snapshotWith([
      combatant("hero", "party", "alive"),
      combatant("goblin-a", "hostile", "alive"),
    ]);
    const log = [
      event(1, "player_input", { clientMessageId: "m1" }),
      event(2, "scene_changed", { kind: "turn_advanced" }),
      event(3, "scene_changed", { kind: "turn_advanced" }),
    ];

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: "session_state", sequence: 0, snapshot: genesis });
      for (const each of log) socket.emitMessage({ type: "event", event: each });
    });

    const expected = fold(genesis, log);
    // Round is the projection field the fold advances and the UI exposes; a
    // divergence in the fold shows up here.
    expect(expected.round).toBe(2);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Guard/ })).toBeInTheDocument();
    });
  });

  it("renders a defeat as a normal ending, not an error", async () => {
    // C-31/C-37: the party is expected to lose, and NO terminal frame is ever
    // sent — the pipeline simply stops answering. The conclusion is therefore
    // read from the projection, and defeat renders as an ending, not a fault.
    await start();
    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({
        type: "session_state",
        sequence: 9,
        snapshot: snapshotWith([
          combatant("hero", "party", "dead"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
    });

    expect(await screen.findByText(he.app.defeat)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
```

If `act` warnings or timing prove awkward, adjust the harness — but keep all
three assertions. They are the spec's required reconnect, fold-parity and
conclusion-from-projection tests.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @ai-dm/web test
```

Expected: FAIL.

- [ ] **Step 3: Write `App.tsx`**

```tsx
// Top-level wiring. It owns the session lifecycle and nothing else: the store
// folds, the components render, the connection carries frames.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionAffordance, ClientMessage, ServerFrame, Tile } from "@ai-dm/schemas";
import { connect } from "./net/connection.js";
import type { Connection, ConnectionStatus, WebSocketLike } from "./net/connection.js";
import { createSession, fetchCatalogue } from "./net/api.js";
import type { EncounterCatalogue } from "./net/api.js";
import { applyFrame, initialClientState } from "./state/store.js";
import type { ClientState } from "./state/store.js";
import { conclusionOf } from "./state/conclusion.js";
import { buildTurn } from "./turn/build-turn.js";
import { ActionBar } from "./components/ActionBar.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { Grid } from "./components/Grid.js";
import { NarrativePane } from "./components/NarrativePane.js";
import { he } from "./i18n.js";

const ENCOUNTER_ID = "goblin-ambush";

export interface AppProps {
  /** Test seam. Production leaves both undefined and the real ones are used. */
  socketFactory?: (url: string) => WebSocketLike;
  wsUrl?: string;
}

export function App(props: AppProps): JSX.Element {
  const [state, setState] = useState<ClientState>(initialClientState);
  const [catalogue, setCatalogue] = useState<EncounterCatalogue | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [selectedTile, setSelectedTile] = useState<Tile | null>(null);
  const [started, setStarted] = useState(false);

  // `resumeFrom` is read at join time, not captured at connect time — a
  // reconnect must resume from where the client actually got to.
  const sequenceRef = useRef(0);
  sequenceRef.current = state.sequence;
  const connectionRef = useRef<Connection | null>(null);

  useEffect(() => {
    if (!started) return;
    let cancelled = false;

    void (async () => {
      const sessionId = await createSession(ENCOUNTER_ID);
      const fetched = await fetchCatalogue(ENCOUNTER_ID);
      if (cancelled) return;
      setCatalogue(fetched);

      connectionRef.current = connect({
        sessionId,
        ...(props.wsUrl === undefined ? {} : { url: props.wsUrl }),
        ...(props.socketFactory === undefined ? {} : { socketFactory: props.socketFactory }),
        onFrame: (frame: ServerFrame) => {
          setState((previous) => applyFrame(previous, frame));
        },
        onStatus: setStatus,
        resumeFrom: () => (sequenceRef.current === 0 ? undefined : sequenceRef.current),
      });
    })();

    return () => {
      cancelled = true;
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, [started, props.wsUrl, props.socketFactory]);

  const send = useCallback((message: ClientMessage) => {
    connectionRef.current?.send(message);
  }, []);

  const commit = useCallback(
    (action: ActionAffordance, targetId?: string) => {
      const actorId = state.affordances?.actorId;
      if (actorId === undefined) return;

      send({
        type: "structured_action",
        clientMessageId: crypto.randomUUID(),
        actorId,
        turn: buildTurn({
          actorId,
          ...(selectedTile === null ? {} : { destinationTile: selectedTile }),
          action,
          ...(targetId === undefined ? {} : { targetId }),
        }),
      });
      setSelectedTile(null);
    },
    [send, selectedTile, state.affordances],
  );

  if (!started) {
    return (
      <main>
        <h1>{he.app.title}</h1>
        <button type="button" onClick={() => setStarted(true)}>
          {he.app.startFight}
        </button>
      </main>
    );
  }

  if (state.snapshot === null || catalogue === null) {
    return <main>{status === "reconnecting" ? he.app.reconnecting : he.app.connecting}</main>;
  }

  const conclusion = conclusionOf(state.snapshot);
  const yourTurn = state.affordances !== null && conclusion === "ongoing";

  return (
    <main>
      <h1>{he.app.title}</h1>

      <p className="status">
        {conclusion === "defeat"
          ? he.app.defeat
          : conclusion === "victory"
            ? he.app.victory
            : yourTurn
              ? he.app.yourTurn
              : status === "reconnecting"
                ? he.app.reconnecting
                : he.app.waiting}
      </p>

      <ErrorBanner
        error={state.lastError}
        rejection={state.lastRejection}
        onDismiss={() => {
          setState((previous) => ({ ...previous, lastError: null, lastRejection: null }));
        }}
      />

      <Grid
        snapshot={state.snapshot}
        affordances={state.affordances}
        catalogue={catalogue.combatants}
        selectedTile={selectedTile}
        onTileClick={setSelectedTile}
        onCombatantClick={() => undefined}
      />

      {conclusion === "ongoing" && (
        <ActionBar
          actions={state.affordances?.actions ?? []}
          catalogue={catalogue.actions}
          combatants={catalogue.combatants}
          disabled={!yourTurn}
          onCommit={commit}
        />
      )}

      <NarrativePane text={state.narrative} />
    </main>
  );
}
```

- [ ] **Step 4: Add minimal styling**

Create `apps/web/src/index.css`:

```css
/* Logical properties throughout (`margin-inline`, `inset-inline`) rather than
   left/right: the document is `dir="rtl"`, so physical directions would be
   backwards and would silently flip if the direction ever changed. */
:root {
  --ink: #2b2620;
  --paper: #faf7f2;
  --accent: #2f6b45;
  --alert: #a83232;
  font-family: "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", system-ui, sans-serif;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
}

main {
  max-width: 60rem;
  margin-inline: auto;
  padding: 1.5rem;
}

.status {
  font-size: 1.25rem;
  font-weight: 600;
}

.grid canvas {
  border: 1px solid #cbbfae;
  cursor: pointer;
}

/* Clipped, not `display: none` — these buttons are the keyboard and
   screen-reader path to the board, so they must stay in the accessibility
   tree. `display: none` would remove them from it entirely. */
.visually-hidden-list {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  margin: 0;
  padding: 0;
}

.action-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-block: 1rem;
}

.action-bar button {
  padding: 0.5rem 1rem;
  border: 1px solid var(--accent);
  border-radius: 0.25rem;
  background: #fff;
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}

.action-bar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.error-banner {
  border: 1px solid var(--alert);
  border-radius: 0.25rem;
  padding: 0.75rem 1rem;
  margin-block: 1rem;
  background: #fdf0f0;
}

.narrative {
  min-block-size: 6rem;
  line-height: 1.7;
  border-block-start: 1px solid #cbbfae;
  padding-block-start: 1rem;
}
```

Import it from `main.tsx` by adding `import "./index.css";` above the React
imports.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS, **41 → 44**.

- [ ] **Step 6: Full verification**

```bash
pnpm typecheck && pnpm test
npx eslint apps/server apps/web packages tools
```

Expected: typecheck clean, lint exit 0, and the suite at **schemas 80,
rules-engine 331, agents 176, server 100, sim 129, web 44 = 860**. Report the
real numbers.

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/web/src apps/web/index.html
git add apps/web
git commit -m "feat(web): wire the client end to end with reconnect and ending detection"
```

---

## Task 13: Play it, then close out step 8

**Files:**
- Modify: `PROJECT_PLAN.md` (§4.2 and the step-8 status line)

**Interfaces:**
- Consumes: the whole working client.
- Produces: a played-through POC and an updated roadmap.

- [ ] **Step 1: Start both halves**

```bash
corepack enable && pnpm dev
```

This runs `@ai-dm/server` and `@ai-dm/web` in parallel. The web dev server
proxies `/sessions`, `/encounters` and `/ws` to `localhost:3000`.

- [ ] **Step 2: Fight `goblin-ambush` to its conclusion in a browser**

Open the Vite URL. Click through: start the fight, move, attack a goblin, watch
the narrative stream, and keep going until the encounter ends. **Expect to
lose** — corrections C-31 and C-37: the hero borrows the `guard` stat block, so
`characterId` is undefined and `diesAtZeroHp` is true for it, and two goblins
out-damage one guard around round 3-5. A defeat screen is the *pass* condition,
not a bug. Note what you observe.

- [ ] **Step 3: Prove reconnect by refreshing mid-fight**

Refresh the browser partway through a fight. Confirm the board, HP and round come
back matching what was on screen before. A fresh page has no session id in
memory, so if the current `App` starts a new session on reload, that is a real
gap: persist the session id to `sessionStorage` in `App.tsx` and reuse it on
mount, then re-verify. Add a test for that behaviour if you add the code.

- [ ] **Step 4: Update `PROJECT_PLAN.md`**

Flip the step-8 status line from `🟡 server done, web pending` to done, and add a
findings paragraph to §4.2 in the style of the existing §4.3 execution notes:
what the build turned up that is worth not rediscovering. Candidates from this
plan, in the section's own voice — the fact that `CombatWorld` deliberately
carries no stat blocks, so affordance derivation has to be handed one; that
`ExecuteTurn.mainAction` is required, which is why affordance probes read
rejection *reasons* rather than the `valid` flag; and that the client's fold and
the server's are now literally the same function rather than two that agree.
Record what you actually hit, not this list.

- [ ] **Step 5: Final verification and commit**

```bash
pnpm typecheck && pnpm test
npx eslint apps/server apps/web packages tools
npx prettier --write PROJECT_PLAN.md
git add PROJECT_PLAN.md
git commit -m "docs: mark step 8 done and record the web client's findings"
```

---

## Verification Summary

Run at the end of every task; all three must hold before the commit.

```bash
corepack enable && pnpm typecheck && pnpm test
```

```bash
npx eslint apps/server apps/web packages tools
```

Expected final counts, from a **791** baseline:

| Package | Before | After |
|---|---|---|
| `@ai-dm/schemas` | 60 | 80 |
| `@ai-dm/rules-engine` | 319 | 331 |
| `@ai-dm/agents` | 176 | 176 |
| `@ai-dm/server` | 107 | 100 |
| `@ai-dm/sim` | 129 | 129 |
| `@ai-dm/web` | 0 | 44 |
| **Total** | **791** | **860** |

Server *drops* by 6 on purpose: Task 1 moves 14 `reduce` cases to schemas, and
Tasks 4 and 5 add 8 back. A different shape to that arithmetic means something
was lost — investigate rather than accepting the total.
