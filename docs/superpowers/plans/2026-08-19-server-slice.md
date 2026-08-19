# Server Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a full D&D combat playable end-to-end over a WebSocket against an LLM-driven enemy, with every state change recorded as an append-only event and a reconnect that replays them.

**Architecture:** An event-sourced core (`handleCommand` async generator + a pure `reduce` projection + an `EventStore` port) with Fastify/`@fastify/websocket` as a thin transport that only parses, validates and pumps frames. The turn-application code the server needs is promoted out of `tools/sim` into `@ai-dm/rules-engine` first, since nothing may depend on the sim.

**Tech Stack:** TypeScript 5 strict ESM (Node 22), zod 3, Fastify 5, `@fastify/websocket` 11, Vitest 3, pnpm workspaces.

**Spec:** [`docs/superpowers/specs/2026-08-19-server-slice-design.md`](../specs/2026-08-19-server-slice-design.md)

## Global Constraints

- `corepack enable` before any pnpm command — pnpm is not on PATH.
- ESM only. Every relative import ends in `.js`, even from a `.ts` file.
- `@ai-dm/rules-engine` boundary is strictly enforced: pure functions, **no I/O**, no `Date.now()`, no ambient randomness, depends only on `@ai-dm/schemas`.
- Dependency direction: `schemas ← rules-engine ← agents ← server`. `web` depends only on `schemas`, so **never** add `node:fs` (or any Node built-in) to `@ai-dm/schemas`.
- English inside, Hebrew outside. All code, comments, prompts, logs, event payloads: English.
- Every state mutation goes through a `GameEvent`. State is a projection.
- Never hand-write a type or JSON schema that a zod schema in `@ai-dm/schemas` could derive.
- ESLint `strictTypeChecked`: `[...str]` is banned (use `Array.from(str, fn)`); `_`-prefixed unused params still error; cast to `Record<string, T | undefined>` rather than `keyof typeof obj` when you need a real `undefined` guard.
- New packages/dirs need `vitest run --passWithNoTests` until a test file exists.
- Tests colocated as `*.test.ts`. New rules-engine code requires golden tests.
- Before writing or changing any 5e rule, read `RULES_REFERENCE.md`.
- Verification command for the whole repo: `pnpm typecheck && pnpm lint && pnpm test`.

---

### Task 1: Export `seeded` from the rules engine

The mulberry32 PRNG exists only as a copy in `tools/sim/src/rng.ts`, whose own comment says it is duplicated because `@ai-dm/rules-engine` does not export it. The server needs it too; a third copy is where the seeds silently stop matching.

**Files:**
- Create: `packages/rules-engine/src/dice/rng.ts`
- Create: `packages/rules-engine/src/dice/rng.test.ts`
- Modify: `packages/rules-engine/src/dice/index.ts` (add the re-export)
- Modify: `tools/sim/src/rng.ts` (drop the copy, re-export)

**Interfaces:**
- Consumes: `Rng` from `packages/rules-engine/src/dice/index.ts` (`export type Rng = () => number; // [0, 1)`)
- Produces: `seeded(seed: number): Rng`, exported from `@ai-dm/rules-engine`

- [ ] **Step 1: Write the failing test**

`packages/rules-engine/src/dice/rng.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { seeded } from "./rng.js";

describe("seeded", () => {
  it("returns the same stream for the same seed", () => {
    const a = seeded(42);
    const b = seeded(42);
    const first = [a(), a(), a()];
    const second = [b(), b(), b()];
    expect(first).toEqual(second);
  });

  it("returns a different stream for a different seed", () => {
    const a = seeded(1);
    const b = seeded(2);
    expect(a()).not.toBe(b());
  });

  it("stays inside [0, 1)", () => {
    const rng = seeded(7);
    for (let i = 0; i < 200; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("is byte-identical to the stream the sim already relies on", () => {
    const rng = seeded(1);
    // Pinned from tools/sim/src/rng.ts's mulberry32 before the move. If this
    // fails, the same seed has stopped meaning the same fight.
    expect([rng(), rng(), rng()].map((value) => value.toFixed(12))).toEqual([
      "0.674025268760",
      "0.264718344435",
      "0.291384654120",
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
corepack enable && pnpm --filter @ai-dm/rules-engine test -- rng
```

Expected: FAIL — `Cannot find module './rng.js'`.

- [ ] **Step 3: Create the module**

`packages/rules-engine/src/dice/rng.ts` — copy the implementation verbatim from `tools/sim/src/rng.ts` so the stream cannot shift:

```ts
// Deterministic PRNG. Pure, so it belongs inside this package's boundary —
// and exported, so the sim and the server share one stream rather than each
// keeping a copy that can drift.
import type { Rng } from "./index.js";

/** Deterministic PRNG (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 4: Re-run the test to get the real pinned values**

```bash
pnpm --filter @ai-dm/rules-engine test -- rng
```

If the byte-identical test fails, the three expected strings in Step 1 were guessed wrong — replace them with the **actual** values the failure prints, then confirm the same three values come out of `tools/sim/src/rng.ts`'s `seeded(1)` before moving on. Do not adjust the implementation to fit the numbers.

- [ ] **Step 5: Export it from the dice barrel**

Add to the end of `packages/rules-engine/src/dice/index.ts`:

```ts
export * from "./rng.js";
```

- [ ] **Step 6: Point the sim at it**

Replace the `seeded` function in `tools/sim/src/rng.ts` with a re-export, keeping `scripted` and `d20Exactly` where they are, and delete the now-false "these duplicate the private helpers" paragraph from the file's header comment:

```ts
// Deterministic randomness for the whole simulator. A run must be exactly
// reproducible given (seed, model, scenario), so nothing here reads a clock and
// nothing anywhere in this package calls Math.random.
import type { Rng } from "@ai-dm/rules-engine";

export { seeded } from "@ai-dm/rules-engine";
```

Keep the existing `scripted` and `d20Exactly` definitions below it.

- [ ] **Step 7: Verify both suites**

```bash
pnpm --filter @ai-dm/rules-engine test && pnpm --filter @ai-dm/sim test && pnpm typecheck && pnpm lint
```

Expected: all green, sim at 136 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/rules-engine/src/dice tools/sim/src/rng.ts
git commit -m "refactor(rules-engine): export seeded so sim and server share one PRNG"
```

---

### Task 2: Promote `applyTurn` into the rules engine

**Files:**
- Create: `packages/rules-engine/src/encounter/resolve.ts` (moved from `tools/sim/src/engine/resolve.ts`)
- Create: `packages/rules-engine/src/encounter/resolve.test.ts` (moved from `tools/sim/src/engine/resolve.test.ts`)
- Create: `packages/rules-engine/src/encounter/index.ts`
- Modify: `packages/rules-engine/src/index.ts`
- Modify: `tools/sim/src/engine/resolve.ts` → becomes a re-export
- Delete: `tools/sim/src/engine/resolve.test.ts`

**Interfaces:**
- Consumes: `seeded` (Task 1); existing `applyDamage`, `coverAgainst`, `resolveAttack`, `roll`, `CombatWorld`, `TurnPlan`, `Rng` from the rules engine
- Produces, all exported from `@ai-dm/rules-engine`:
  - `interface ResolveContext { statBlocks: ReadonlyMap<string, MonsterStatBlock> }`
  - `interface AttackRecord { attackerId, targetId, actionId: string; outcome: AttackOutcome; cover: CoverLevel; damage: number; targetStatusAfter: EntityStatus }`
  - `interface TurnEffect { attacks: readonly AttackRecord[]; damageDealt: number; killed: readonly string[]; movedFeet: number; nonAttackAction: boolean; unresolvedActionIds: readonly string[] }`
  - `interface ApplyTurnInput { world: CombatWorld; actorId: string; turn: ExecuteTurn; plan: TurnPlan; context: ResolveContext; rng: Rng }`
  - `interface ApplyTurnResult { world: CombatWorld; effect: TurnEffect }`
  - `applyTurn(input: ApplyTurnInput): ApplyTurnResult`

- [ ] **Step 1: Move the two files unchanged**

```bash
mkdir -p packages/rules-engine/src/encounter
git mv tools/sim/src/engine/resolve.ts packages/rules-engine/src/encounter/resolve.ts
git mv tools/sim/src/engine/resolve.test.ts packages/rules-engine/src/encounter/resolve.test.ts
```

- [ ] **Step 2: Fix the imports in the moved implementation**

In `packages/rules-engine/src/encounter/resolve.ts`, the `@ai-dm/rules-engine` imports become relative (a package cannot import itself). Replace the two import lines:

```ts
import type { CombatWorld, Rng, TurnPlan } from "@ai-dm/rules-engine";
import { applyDamage, coverAgainst, resolveAttack, roll } from "@ai-dm/rules-engine";
import type { AttackOutcome, CoverLevel } from "@ai-dm/rules-engine";
```

with:

```ts
import { roll } from "../dice/index.js";
import type { Rng } from "../dice/index.js";
import { applyDamage, coverAgainst, resolveAttack } from "../combat/index.js";
import type { AttackOutcome, CombatWorld, CoverLevel, TurnPlan } from "../combat/index.js";
```

If `tsc` reports any of those names resolving from a different module, follow the error — `coverAgainst` may live in `../spatial/index.js`. The `@ai-dm/schemas` import block stays exactly as it is.

- [ ] **Step 3: Update the header comment**

Replace the first two lines of the file:

```ts
// Applies a turn the rules engine has already validated. This is the sim's
// stand-in for the server's turn pipeline (step 8), and it is the only place in
// the package where combat state changes.
```

with:

```ts
// Applies a turn this package has already validated. Both the sim's encounter
// loop and the server's turn pipeline drive it, which is why it lives here
// rather than in either of them: it is combat math, and invariant 1 says only
// this package owns that.
```

- [ ] **Step 4: Fix the imports in the moved test**

In `packages/rules-engine/src/encounter/resolve.test.ts`, change any `@ai-dm/rules-engine` import to the matching relative path, and any `../rng.js` import of `seeded`/`scripted`/`d20Exactly`. `seeded` now comes from `../dice/index.js`. If the test used `scripted` or `d20Exactly`, copy those two helpers into the test file itself — they are test-only and should not widen the package's public API:

```ts
/** Feeds an exact sequence of [0,1) values so individual rolls are pinned. */
function scripted(values: readonly number[]): Rng {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("scripted RNG exhausted");
    return value;
  };
}

/** The `[0,1)` value that makes `rollDie(20, rng)` return exactly `face`. */
function d20Exactly(face: number): number {
  return (face - 1) / 20 + 0.0001;
}
```

- [ ] **Step 5: Create the encounter barrel and export it**

`packages/rules-engine/src/encounter/index.ts`:

```ts
// Encounter-level state transitions: applying a validated turn to a world.
// Everything here is pure — the caller injects the RNG and the stat blocks.
export * from "./resolve.js";
```

Add to `packages/rules-engine/src/index.ts`, after the `spatial` line:

```ts
export * from "./encounter/index.js";
```

- [ ] **Step 6: Run the moved tests**

```bash
pnpm --filter @ai-dm/rules-engine test -- resolve
```

Expected: PASS, same assertions as before the move.

- [ ] **Step 7: Make the sim re-export instead of owning it**

Create `tools/sim/src/engine/resolve.ts`:

```ts
// `applyTurn` moved to `@ai-dm/rules-engine` (step 8): the server needs it too,
// and nothing may depend on this package. Re-exported here so the sim's own
// imports and its historical module path keep working.
export {
  applyTurn,
  type ApplyTurnInput,
  type ApplyTurnResult,
  type AttackRecord,
  type ResolveContext,
  type TurnEffect,
} from "@ai-dm/rules-engine";
```

- [ ] **Step 8: Verify the sim is unchanged**

```bash
pnpm --filter @ai-dm/sim test && pnpm typecheck && pnpm lint
```

Expected: green. The sim's own suite passing untouched is the regression net for this move — if anything here needed a behaviour change, the move was done wrong.

- [ ] **Step 9: Commit**

```bash
git add packages/rules-engine/src/encounter packages/rules-engine/src/index.ts tools/sim/src/engine/resolve.ts
git commit -m "refactor(rules-engine): promote applyTurn out of tools/sim"
```

---

### Task 3: `buildEncounter` in the rules engine

`buildScenario` cannot move wholesale: it imports `AvailableAction` from `@ai-dm/agents` (forbidden direction) and calls `loadMonster`, which does `readFileSync` (forbidden I/O). So the world-building half moves in with stat blocks **injected**, and the action-listing half moves to `@ai-dm/agents`.

**Files:**
- Create: `packages/rules-engine/src/encounter/build.ts`
- Create: `packages/rules-engine/src/encounter/build.test.ts`
- Modify: `packages/rules-engine/src/encounter/index.ts`
- Create: `packages/agents/src/tactical/available-actions.ts`
- Create: `packages/agents/src/tactical/available-actions.test.ts`
- Modify: `packages/agents/src/tactical/index.ts` (add the re-export)
- Modify: `tools/sim/src/scenarios/build.ts` (recompose on top)
- Modify: `tools/sim/src/scenarios/types.ts` (re-export the moved types)

**Interfaces:**
- Consumes: `combatantFromStatBlock`, `actionRangesFeetFrom`, `GridMap` schema — all already exported
- Produces from `@ai-dm/rules-engine`:
  - `interface TerrainOverride { tile: Tile; terrain: TerrainType }`
  - `interface SpawnSpec { combatantId: string; monsterId: string; faction: Faction; position: Tile }`
  - `interface EncounterDefinition { encounterId: string; descriptionEnglish: string; width: number; height: number; terrain?: readonly TerrainOverride[]; spawns: readonly SpawnSpec[]; turnOrder: readonly string[]; maxRounds: number }`
  - `interface BuiltEncounter { encounterId: string; world: CombatWorld; statBlocks: ReadonlyMap<string, MonsterStatBlock>; turnOrder: readonly string[]; maxRounds: number }`
  - `buildEncounter(input: { definition: EncounterDefinition; statBlocks: ReadonlyMap<string, MonsterStatBlock> }): BuiltEncounter` — the input map is keyed by **`monsterId`**; the returned map is keyed by **`combatantId`**
- Produces from `@ai-dm/agents`: `availableActionsFor(statBlock: MonsterStatBlock): readonly AvailableAction[]`

- [ ] **Step 1: Write the failing golden test**

`packages/rules-engine/src/encounter/build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { buildEncounter } from "./build.js";
import type { EncounterDefinition } from "./build.js";

const goblin: MonsterStatBlock = {
  monsterId: "goblin",
  nameEnglish: "Goblin",
  size: "small",
  armorClass: 15,
  hitPoints: 7,
  speedFeet: 30,
  reachFeet: 5,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "scimitar",
      nameEnglish: "Scimitar",
      attackBonus: 4,
      rangeFeet: 5,
      damage: { diceNotation: "1d6+2", averageDamage: 5, damageType: "slashing" },
      extraDamage: [],
    },
  ],
};

const definition: EncounterDefinition = {
  encounterId: "test-duel",
  descriptionEnglish: "Two goblins, open floor.",
  width: 5,
  height: 5,
  spawns: [
    { combatantId: "hero", monsterId: "goblin", faction: "party", position: [0, 0] },
    { combatantId: "villain", monsterId: "goblin", faction: "hostile", position: [4, 4] },
  ],
  turnOrder: ["hero", "villain"],
  maxRounds: 10,
};

const statBlocks = new Map([["goblin", goblin]]);

describe("buildEncounter", () => {
  it("places every spawn and keys stat blocks by combatantId", () => {
    const built = buildEncounter({ definition, statBlocks });
    expect(built.world.combatants.map((each) => each.combatantId)).toEqual(["hero", "villain"]);
    expect(built.world.combatants[0]?.position).toEqual([0, 0]);
    expect([...built.statBlocks.keys()]).toEqual(["hero", "villain"]);
    expect(built.turnOrder).toEqual(["hero", "villain"]);
  });

  it("defaults every unlisted tile to normal and applies overrides", () => {
    const built = buildEncounter({
      definition: { ...definition, terrain: [{ tile: [2, 2], terrain: "difficult" }] },
      statBlocks,
    });
    expect(built.world.grid.tiles[2]?.[2]).toBe("difficult");
    expect(built.world.grid.tiles[0]?.[1]).toBe("normal");
  });

  it("derives actionRangesFeet from the same stat blocks the validator will see", () => {
    const built = buildEncounter({ definition, statBlocks });
    expect(built.world.actionRangesFeet?.["scimitar"]).toBe(5);
  });

  it("rejects a spawn whose stat block was not supplied", () => {
    expect(() =>
      buildEncounter({ definition, statBlocks: new Map() }),
    ).toThrow(/No stat block supplied for monsterId goblin/);
  });

  it("rejects a spawn placed off the grid", () => {
    const offGrid = {
      ...definition,
      spawns: [{ combatantId: "hero", monsterId: "goblin", faction: "party" as const, position: [9, 9] as const }],
      turnOrder: ["hero"],
    };
    expect(() => buildEncounter({ definition: offGrid, statBlocks })).toThrow(/off the grid/);
  });

  it("rejects two spawns sharing a tile", () => {
    const stacked = {
      ...definition,
      spawns: [
        { combatantId: "hero", monsterId: "goblin", faction: "party" as const, position: [1, 1] as const },
        { combatantId: "villain", monsterId: "goblin", faction: "hostile" as const, position: [1, 1] as const },
      ],
    };
    expect(() => buildEncounter({ definition: stacked, statBlocks })).toThrow(/collides/);
  });

  it("rejects a combatant missing from turnOrder", () => {
    const partial = { ...definition, turnOrder: ["hero"] };
    expect(() => buildEncounter({ definition: partial, statBlocks })).toThrow(/turnOrder/);
  });
});
```

If `MonsterStatBlock`'s real shape differs from the `goblin` literal above, read `packages/schemas/src/srd.ts:59` and correct the fixture — the schema is the authority, not this plan.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/rules-engine test -- build
```

Expected: FAIL — `Cannot find module './build.js'`.

- [ ] **Step 3: Write `build.ts`**

`packages/rules-engine/src/encounter/build.ts` — port the body of `tools/sim/src/scenarios/build.ts`, dropping `availableActions` and replacing the `loadMonster` call with a map lookup:

```ts
// Turns an `EncounterDefinition` into the state the agents and the resolver
// need. Pure and total: it either produces a fully valid world or throws.
//
// Stat blocks are injected rather than loaded. This package's boundary forbids
// I/O, so whoever owns the files (`tools/sim/src/scenarios/srd.ts`,
// `apps/server/src/encounters/srd.ts`) parses them and hands them in.
import type { Combatant, Faction, GridMap, MonsterStatBlock, Tile, TerrainType } from "@ai-dm/schemas";
import { GridMap as GridMapSchema } from "@ai-dm/schemas";
import { actionRangesFeetFrom, combatantFromStatBlock } from "../combat/index.js";
import type { CombatWorld } from "../combat/index.js";

export interface TerrainOverride {
  tile: Tile;
  terrain: TerrainType;
}

export interface SpawnSpec {
  combatantId: string;
  /** Key into the caller's stat-block map. */
  monsterId: string;
  faction: Faction;
  position: Tile;
}

export interface EncounterDefinition {
  encounterId: string;
  /** English. Says what this encounter is. */
  descriptionEnglish: string;
  width: number;
  height: number;
  /** Sparse: every unlisted tile is "normal". */
  terrain?: readonly TerrainOverride[];
  spawns: readonly SpawnSpec[];
  /** Declared, never rolled. Initiative rolling is not implemented. */
  turnOrder: readonly string[];
  maxRounds: number;
}

export interface BuiltEncounter {
  encounterId: string;
  world: CombatWorld;
  /** By `combatantId` — the resolver needs attack bonuses, which `Combatant` lacks. */
  statBlocks: ReadonlyMap<string, MonsterStatBlock>;
  turnOrder: readonly string[];
  maxRounds: number;
}

export interface BuildEncounterInput {
  definition: EncounterDefinition;
  /** By `monsterId`, already parsed against `MonsterStatBlock`. */
  statBlocks: ReadonlyMap<string, MonsterStatBlock>;
}

function buildGrid(definition: EncounterDefinition): GridMap {
  const tiles: TerrainType[][] = Array.from({ length: definition.height }, () =>
    Array.from({ length: definition.width }, (): TerrainType => "normal"),
  );

  for (const override of definition.terrain ?? []) {
    const [x, y] = override.tile;
    const row = tiles[y];
    if (row === undefined || x < 0 || x >= definition.width) {
      throw new Error(`Terrain override ${JSON.stringify(override.tile)} is off the grid`);
    }
    row[x] = override.terrain;
  }

  // Parse rather than trust: a definition is data, and data gets validated.
  return GridMapSchema.parse({ width: definition.width, height: definition.height, tiles });
}

export function buildEncounter(input: BuildEncounterInput): BuiltEncounter {
  const { definition } = input;
  const statBlocks = new Map<string, MonsterStatBlock>();
  const combatants: Combatant[] = [];
  const seenCombatantIds = new Set<string>();
  // Anchor-tile collisions only, not full footprints: a Large creature's real
  // occupancy is `occupiedTiles`'s authority, and reimplementing it here would
  // duplicate it. This still catches the realistic typo of two spawns sharing
  // a tile.
  const claimedTiles = new Set<string>();

  for (const spawn of definition.spawns) {
    const [x, y] = spawn.position;
    if (x < 0 || x >= definition.width || y < 0 || y >= definition.height) {
      throw new Error(
        `Spawn ${spawn.combatantId} at ${JSON.stringify(spawn.position)} is off the grid`,
      );
    }
    if (seenCombatantIds.has(spawn.combatantId)) {
      throw new Error(`Duplicate combatantId in spawns: ${spawn.combatantId}`);
    }
    seenCombatantIds.add(spawn.combatantId);

    const tileKey = `${String(x)},${String(y)}`;
    if (claimedTiles.has(tileKey)) {
      throw new Error(
        `Spawn ${spawn.combatantId} at ${JSON.stringify(spawn.position)} collides with another spawn's tile`,
      );
    }
    claimedTiles.add(tileKey);

    const statBlock = input.statBlocks.get(spawn.monsterId);
    if (statBlock === undefined) {
      throw new Error(`No stat block supplied for monsterId ${spawn.monsterId}`);
    }
    statBlocks.set(spawn.combatantId, statBlock);
    combatants.push(
      combatantFromStatBlock(statBlock, {
        combatantId: spawn.combatantId,
        faction: spawn.faction,
        position: spawn.position,
      }),
    );
  }

  const declared = new Set(definition.turnOrder);
  for (const spawn of definition.spawns) {
    if (!declared.has(spawn.combatantId)) {
      throw new Error(`${spawn.combatantId} is spawned but missing from turnOrder`);
    }
  }
  if (definition.turnOrder.length !== definition.spawns.length) {
    throw new Error(
      `turnOrder names ${String(definition.turnOrder.length)} of ${String(definition.spawns.length)} combatants`,
    );
  }

  return {
    encounterId: definition.encounterId,
    world: {
      grid: buildGrid(definition),
      combatants,
      // Load-bearing: derived from the same stat blocks the validator will
      // enforce against, so offered ranges and enforced ranges cannot disagree.
      actionRangesFeet: actionRangesFeetFrom([...statBlocks.values()]),
    },
    statBlocks,
    turnOrder: definition.turnOrder,
    maxRounds: definition.maxRounds,
  };
}
```

- [ ] **Step 4: Export it and run the tests**

Add to `packages/rules-engine/src/encounter/index.ts`:

```ts
export * from "./build.js";
```

```bash
pnpm --filter @ai-dm/rules-engine test -- build
```

Expected: PASS, all seven cases.

- [ ] **Step 5: Write the failing test for `availableActionsFor`**

`packages/agents/src/tactical/available-actions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { availableActionsFor } from "./available-actions.js";

describe("availableActionsFor", () => {
  it("lists one action per attack in the stat block", () => {
    const statBlock = {
      actions: [
        { actionId: "scimitar", nameEnglish: "Scimitar" },
        { actionId: "bow", nameEnglish: "Shortbow" },
      ],
    } as unknown as MonsterStatBlock;

    expect(availableActionsFor(statBlock)).toEqual([
      { actionId: "scimitar", name: "Scimitar" },
      { actionId: "bow", name: "Shortbow" },
    ]);
  });

  it("returns an empty list for a stat block with no actions", () => {
    expect(availableActionsFor({ actions: [] } as unknown as MonsterStatBlock)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/agents test -- available-actions
```

Expected: FAIL — module not found.

- [ ] **Step 7: Implement it**

`packages/agents/src/tactical/available-actions.ts`:

```ts
// What a creature may propose this turn, derived from its stat block. Lives
// here rather than in the rules engine because `AvailableAction` is this
// package's type — the engine may not depend on it.
import type { MonsterStatBlock } from "@ai-dm/schemas";
import type { AvailableAction } from "./snapshot.js";

export function availableActionsFor(statBlock: MonsterStatBlock): readonly AvailableAction[] {
  return statBlock.actions.map((action) => ({
    actionId: action.actionId,
    name: action.nameEnglish,
  }));
}
```

Add to `packages/agents/src/tactical/index.ts`, alongside the other `export *` lines:

```ts
export * from "./available-actions.js";
```

- [ ] **Step 8: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/agents test -- available-actions
```

Expected: PASS.

- [ ] **Step 9: Recompose the sim's `buildScenario` on top**

Rewrite `tools/sim/src/scenarios/build.ts` to delegate. `ScenarioDefinition` keeps its `scenarioId` field name, so map it across:

```ts
// Turns a `ScenarioDefinition` into the state the agent and the resolver need.
// The world-building half now lives in `@ai-dm/rules-engine` (step 8's server
// needs it too); this file loads the SRD files the engine may not touch, and
// adds the `availableActions` the engine may not name.
import { availableActionsFor } from "@ai-dm/agents";
import type { AvailableAction } from "@ai-dm/agents";
import { buildEncounter } from "@ai-dm/rules-engine";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { loadMonster } from "./srd.js";
import type { BuiltScenario, ScenarioDefinition } from "./types.js";

export function buildScenario(definition: ScenarioDefinition): BuiltScenario {
  const byMonsterId = new Map<string, MonsterStatBlock>();
  for (const spawn of definition.spawns) {
    if (!byMonsterId.has(spawn.monsterId)) byMonsterId.set(spawn.monsterId, loadMonster(spawn.monsterId));
  }

  const built = buildEncounter({
    definition: { ...definition, encounterId: definition.scenarioId },
    statBlocks: byMonsterId,
  });

  const availableActions = new Map<string, readonly AvailableAction[]>();
  for (const [combatantId, statBlock] of built.statBlocks) {
    availableActions.set(combatantId, availableActionsFor(statBlock));
  }

  return {
    scenarioId: built.encounterId,
    world: built.world,
    statBlocks: built.statBlocks,
    availableActions,
    turnOrder: built.turnOrder,
    maxRounds: built.maxRounds,
  };
}
```

In `tools/sim/src/scenarios/types.ts`, replace the local `SpawnSpec` and `TerrainOverride` definitions with re-exports and keep `ScenarioDefinition`/`BuiltScenario` local (they use `scenarioId`, not `encounterId`):

```ts
export type { SpawnSpec, TerrainOverride } from "@ai-dm/rules-engine";
```

`tools/sim` needs `@ai-dm/agents` as a dependency for this — check `tools/sim/package.json` and add `"@ai-dm/agents": "workspace:*"` if it is not already there (it almost certainly is; `runLive` imports from it).

- [ ] **Step 10: Verify the sim is behaviourally unchanged**

```bash
pnpm --filter @ai-dm/sim test && pnpm typecheck && pnpm lint
```

Expected: green, 136 tests. If `build.test.ts` in the sim now duplicates cases the engine's golden tests cover, leave it — a second assertion of the same rule from the consumer's side is cheap and it is the regression net.

- [ ] **Step 11: Commit**

```bash
git add packages/rules-engine/src/encounter packages/agents/src/tactical tools/sim/src/scenarios
git commit -m "refactor: promote buildEncounter to the rules engine, availableActionsFor to agents"
```

---

### Task 4: The wire protocol in `@ai-dm/schemas`

**Files:**
- Create: `packages/schemas/src/protocol.ts`
- Create: `packages/schemas/src/protocol.test.ts`
- Modify: `packages/schemas/src/index.ts`

**Interfaces:**
- Consumes: `ExecuteTurn`, `GameEvent`, `Combatant`, `GridMap`, `Tile` from this package
- Produces: `ClientMessage`, `ServerFrame`, `SessionState`, `ServerErrorCode`, `MAX_FREE_TEXT_LENGTH` — zod schemas plus their inferred types

- [ ] **Step 1: Write the failing test**

`packages/schemas/src/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ClientMessage, MAX_FREE_TEXT_LENGTH, ServerFrame, SessionState } from "./protocol.js";

describe("ClientMessage", () => {
  it("accepts a join with no resumeFrom", () => {
    const parsed = ClientMessage.parse({ type: "join", sessionId: "s1" });
    expect(parsed.type).toBe("join");
  });

  it("accepts a join that resumes from a sequence", () => {
    const parsed = ClientMessage.parse({ type: "join", sessionId: "s1", resumeFrom: 12 });
    expect(parsed).toMatchObject({ resumeFrom: 12 });
  });

  it("rejects a negative resumeFrom", () => {
    expect(() => ClientMessage.parse({ type: "join", sessionId: "s1", resumeFrom: -1 })).toThrow();
  });

  it("accepts a structured action carrying a full ExecuteTurn", () => {
    const parsed = ClientMessage.parse({
      type: "structured_action",
      clientMessageId: "c1",
      actorId: "hero",
      turn: { actorId: "hero", mainAction: { actionType: "dodge" } },
    });
    expect(parsed.type).toBe("structured_action");
  });

  it("rejects free text over the length cap before it can reach a prompt", () => {
    const text = "a".repeat(MAX_FREE_TEXT_LENGTH + 1);
    expect(() =>
      ClientMessage.parse({ type: "free_text", clientMessageId: "c1", text }),
    ).toThrow();
  });

  it("accepts free text at exactly the cap", () => {
    const text = "a".repeat(MAX_FREE_TEXT_LENGTH);
    expect(ClientMessage.parse({ type: "free_text", clientMessageId: "c1", text }).type).toBe(
      "free_text",
    );
  });

  it("rejects an unknown message type", () => {
    expect(() => ClientMessage.parse({ type: "shout", text: "hi" })).toThrow();
  });
});

describe("ServerFrame", () => {
  it("round-trips a narrative token", () => {
    const frame = ServerFrame.parse({ type: "narrative_token", streamId: "n1", text: "Goblin " });
    expect(frame).toEqual({ type: "narrative_token", streamId: "n1", text: "Goblin " });
  });

  it("round-trips a rejection carrying engine reason codes", () => {
    const frame = ServerFrame.parse({
      type: "rejected",
      clientMessageId: "c1",
      reasons: ["target_out_of_reach"],
      messages: ["Target is 15 ft away, reach is 5 ft."],
    });
    expect(frame).toMatchObject({ reasons: ["target_out_of_reach"] });
  });

  it("rejects an error frame with an unknown code", () => {
    expect(() => ServerFrame.parse({ type: "error", code: "banana", message: "?" })).toThrow();
  });
});

describe("SessionState", () => {
  it("requires the fields a projection is folded into", () => {
    const state = SessionState.parse({
      sessionId: "s1",
      rootSeed: 7,
      encounterId: "goblin-ambush",
      grid: { width: 1, height: 1, tiles: [["normal"]] },
      combatants: [],
      turnOrder: [],
      currentActorIndex: 0,
      round: 1,
      appliedClientMessageIds: [],
    });
    expect(state.round).toBe(1);
  });
});
```

If the `ExecuteTurn` literal above fails to parse, read `packages/schemas/src/actions.ts:16` and use a minimal valid turn — the schema is the authority.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/schemas test -- protocol
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `protocol.ts`**

```ts
// The client/server wire protocol. It lives here, not in `apps/server`,
// because `apps/web` may depend only on this package (invariant 5) and both
// ends must read the same definition (invariant 4).
//
// Nothing in this file may import a Node built-in: `apps/web` bundles it for
// the browser.
import { z } from "zod";
import { ExecuteTurn } from "./actions.js";
import { GameEvent } from "./events.js";
import { Combatant, GridMap } from "./world.js";

/**
 * Player free text is untrusted. Capping it in the schema means an oversized
 * message dies during transport parsing, before any code path could put it in
 * front of a model.
 */
export const MAX_FREE_TEXT_LENGTH = 500;

/**
 * The serializable projection. Deliberately not `CombatWorld`: that carries a
 * `lineOfSight` function, which cannot be snapshotted. The algorithm is paired
 * back in at call time.
 *
 * Stat blocks are absent for the same reason they are absent from the event
 * log — they are static per encounter and re-derived from `encounterId`. A
 * snapshot holds only what events change.
 */
export const SessionState = z.object({
  sessionId: z.string(),
  /** Every turn's dice seed derives from this and the turn's sequence. */
  rootSeed: z.number().int(),
  encounterId: z.string(),
  grid: GridMap,
  combatants: z.array(Combatant),
  turnOrder: z.array(z.string()),
  currentActorIndex: z.number().int().min(0),
  round: z.number().int().min(1),
  /** Idempotency, as a projection of the log rather than connection state. */
  appliedClientMessageIds: z.array(z.string()),
});

export type SessionState = z.infer<typeof SessionState>;

export const JoinMessage = z.object({
  type: z.literal("join"),
  sessionId: z.string(),
  /** Replay everything after this sequence. Absent means "send me a snapshot". */
  resumeFrom: z.number().int().min(0).optional(),
});

export const StructuredActionMessage = z.object({
  type: z.literal("structured_action"),
  clientMessageId: z.string(),
  actorId: z.string(),
  /**
   * The same schema the tactical agent emits, validated by the same
   * `validateExecuteTurn`. There is no second action format for players.
   */
  turn: ExecuteTurn,
});

export const FreeTextMessage = z.object({
  type: z.literal("free_text"),
  clientMessageId: z.string(),
  text: z.string().min(1).max(MAX_FREE_TEXT_LENGTH),
});

export const ClientMessage = z.discriminatedUnion("type", [
  JoinMessage,
  StructuredActionMessage,
  FreeTextMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerErrorCode = z.enum([
  "unknown_session",
  "malformed_message",
  "turn_in_progress",
  "free_text_not_supported",
  "not_your_turn",
  "internal_error",
]);

export type ServerErrorCode = z.infer<typeof ServerErrorCode>;

export const ServerFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_state"),
    sequence: z.number().int().min(0),
    snapshot: SessionState,
  }),
  z.object({ type: z.literal("event"), event: GameEvent }),
  /**
   * Transient, deliberately outside the event sequence. The log gets one
   * `narrative_emitted` event with the full text on completion; a client that
   * reconnects mid-stream reconciles against that event rather than seeing a
   * gap.
   */
  z.object({ type: z.literal("narrative_token"), streamId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("rejected"),
    clientMessageId: z.string(),
    /** `TurnRejectionReason` codes. Open strings — that type lives downstream. */
    reasons: z.array(z.string()),
    messages: z.array(z.string()),
  }),
  z.object({
    type: z.literal("error"),
    clientMessageId: z.string().optional(),
    code: ServerErrorCode,
    message: z.string(),
  }),
]);

export type ServerFrame = z.infer<typeof ServerFrame>;
```

- [ ] **Step 4: Export and run**

Add to `packages/schemas/src/index.ts`:

```ts
export * from "./protocol.js";
```

```bash
pnpm --filter @ai-dm/schemas test -- protocol
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/protocol.ts packages/schemas/src/protocol.test.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): add the client/server wire protocol"
```

---

### Task 5: `NarrativePort` and `deterministicNarration`

**Files:**
- Create: `packages/agents/src/narrative/port.ts`
- Create: `packages/agents/src/narrative/deterministic.ts`
- Create: `packages/agents/src/narrative/deterministic.test.ts`
- Modify: `packages/agents/src/narrative/index.ts`

**Interfaces:**
- Consumes: `TurnEffect`, `AttackRecord` from `@ai-dm/rules-engine` (Task 2)
- Produces from `@ai-dm/agents`:
  - `interface NarrationInput { actorName: string; effect: TurnEffect; namesByCombatantId: Readonly<Record<string, string | undefined>> }`
  - `interface NarrativePort { stream(input: NarrationInput): AsyncIterable<string> }`
  - `createDeterministicNarrative(): NarrativePort`

- [ ] **Step 1: Write the failing test**

`packages/agents/src/narrative/deterministic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TurnEffect } from "@ai-dm/rules-engine";
import { createDeterministicNarrative } from "./deterministic.js";

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

const names = { hero: "Fighter", villain: "Goblin" };

function effectWith(overrides: Partial<TurnEffect>): TurnEffect {
  return {
    attacks: [],
    damageDealt: 0,
    killed: [],
    movedFeet: 0,
    nonAttackAction: false,
    unresolvedActionIds: [],
    ...overrides,
  };
}

describe("createDeterministicNarrative", () => {
  it("narrates a hit with its damage", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: names,
        effect: effectWith({
          damageDealt: 5,
          attacks: [
            {
              attackerId: "villain",
              targetId: "hero",
              actionId: "scimitar",
              outcome: "hit",
              cover: "none",
              damage: 5,
              targetStatusAfter: "alive",
            },
          ],
        }),
      }),
    );
    expect(text).toContain("Goblin");
    expect(text).toContain("Fighter");
    expect(text).toContain("5");
  });

  it("narrates a miss without inventing damage", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: names,
        effect: effectWith({
          attacks: [
            {
              attackerId: "villain",
              targetId: "hero",
              actionId: "scimitar",
              outcome: "miss",
              cover: "none",
              damage: 0,
              targetStatusAfter: "alive",
            },
          ],
        }),
      }),
    );
    expect(text).toContain("misses");
    expect(text).not.toContain("damage");
  });

  it("narrates movement when nothing else happened", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Fighter",
        namesByCombatantId: names,
        effect: effectWith({ movedFeet: 15, nonAttackAction: true }),
      }),
    );
    expect(text).toContain("15");
  });

  it("always yields at least one chunk, even for an empty turn", async () => {
    const narrative = createDeterministicNarrative();
    const chunks: string[] = [];
    for await (const chunk of narrative.stream({
      actorName: "Fighter",
      namesByCombatantId: names,
      effect: effectWith({}),
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).not.toBe("");
  });

  it("falls back to the id when a name is unknown", async () => {
    const narrative = createDeterministicNarrative();
    const text = await collect(
      narrative.stream({
        actorName: "Goblin",
        namesByCombatantId: {},
        effect: effectWith({
          attacks: [
            {
              attackerId: "villain",
              targetId: "ghost",
              actionId: "scimitar",
              outcome: "miss",
              cover: "none",
              damage: 0,
              targetStatusAfter: "alive",
            },
          ],
        }),
      }),
    );
    expect(text).toContain("ghost");
  });
});
```

Check `AttackOutcome`'s actual members in `packages/rules-engine/src/combat/` before relying on `"hit"` / `"miss"`; use the real literals.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/agents test -- deterministic
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the port**

`packages/agents/src/narrative/port.ts`:

```ts
// The narrative contract. Step 9 swaps in a streaming Hebrew agent; nothing
// else in the pipeline changes when it does.
import type { TurnEffect } from "@ai-dm/rules-engine";

export interface NarrationInput {
  /** Display name of whoever took the turn. */
  actorName: string;
  effect: TurnEffect;
  /** Display names by `combatantId`; a missing entry falls back to the id. */
  namesByCombatantId: Readonly<Record<string, string | undefined>>;
}

export interface NarrativePort {
  /**
   * Token stream. Language-neutral by contract: the stand-in emits English,
   * step 9's agent emits Hebrew, and the pipeline cannot tell the difference.
   */
  stream(input: NarrationInput): AsyncIterable<string>;
}
```

- [ ] **Step 4: Write the stand-in**

`packages/agents/src/narrative/deterministic.ts`:

```ts
// A template renderer over the rule outcome. Two jobs: it is the default
// `NarrativePort` until step 9 lands, and it is the terse fallback narration
// the server's 10s turn timeout falls back to (apps/server/CLAUDE.md) — which
// it will still be after step 9. Mirrors `deterministicFallback` in
// `tactical/`: the boring, always-correct path the LLM path degrades into.
//
// It states only what the engine produced. No adjectives, no invented numbers.
import type { AttackRecord } from "@ai-dm/rules-engine";
import type { NarrationInput, NarrativePort } from "./port.js";

function nameOf(input: NarrationInput, combatantId: string): string {
  return input.namesByCombatantId[combatantId] ?? combatantId;
}

function sentenceFor(input: NarrationInput, attack: AttackRecord): string {
  const target = nameOf(input, attack.targetId);
  if (attack.damage === 0) return `${input.actorName} misses ${target}.`;

  const critical = attack.outcome === "critical_hit" ? " critically" : "";
  const killed = attack.targetStatusAfter === "dead" ? ` ${target} falls.` : "";
  return `${input.actorName}${critical} hits ${target} for ${String(attack.damage)} damage.${killed}`;
}

function sentencesFor(input: NarrationInput): string[] {
  const sentences = input.effect.attacks.map((attack) => sentenceFor(input, attack));

  if (input.effect.movedFeet > 0) {
    sentences.unshift(`${input.actorName} moves ${String(input.effect.movedFeet)} feet.`);
  }
  // Never zero sentences: a silent turn reads to a player as a dropped
  // connection, and the client has nothing else to render for this turn.
  if (sentences.length === 0) sentences.push(`${input.actorName} holds position.`);
  return sentences;
}

export function createDeterministicNarrative(): NarrativePort {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- an async
    // generator is the contract; this implementation just has nothing to await.
    async *stream(input: NarrationInput): AsyncIterable<string> {
      // Chunked per sentence rather than emitted whole: the client's streaming
      // path is then exercised by the default port, not only by step 9's.
      for (const sentence of sentencesFor(input)) yield `${sentence} `;
    },
  };
}
```

If the eslint disable comment turns out to be unnecessary, delete it — do not leave a dead directive, `strictTypeChecked` reports those.

- [ ] **Step 5: Export and run**

Replace the contents of `packages/agents/src/narrative/index.ts`:

```ts
// Hebrew narrative agent (step 9) plus the deterministic stand-in the server
// uses until then, and as its turn-timeout fallback afterwards.
export * from "./port.js";
export * from "./deterministic.js";
```

```bash
pnpm --filter @ai-dm/agents test -- deterministic
```

Expected: PASS, all five cases.

- [ ] **Step 6: Verify the whole agents suite**

```bash
pnpm --filter @ai-dm/agents test && pnpm typecheck && pnpm lint
```

Expected: green, 161+ tests.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/narrative
git commit -m "feat(agents): add NarrativePort and the deterministic narration stand-in"
```

---

### Task 6: The `EventStore` port and its in-memory implementation

**Files:**
- Create: `apps/server/src/core/event-store.ts`
- Create: `apps/server/src/core/event-store.test.ts`
- Modify: `apps/server/package.json` (add `vitest`, `ws`, `@types/ws` devDeps)

**Interfaces:**
- Consumes: `GameEvent`, `SessionState` from `@ai-dm/schemas` (Task 4)
- Produces:
  - `interface EventStore { append(sessionId: string, events: readonly GameEvent[]): Promise<void>; readSince(sessionId: string, afterSequence: number): Promise<GameEvent[]>; latestSnapshot(sessionId: string): Promise<{ sequence: number; state: SessionState } | null>; putSnapshot(sessionId: string, sequence: number, state: SessionState): Promise<void> }`
  - `class SequenceConflictError extends Error`
  - `createInMemoryEventStore(): EventStore`

- [ ] **Step 1: Add the dev dependencies**

```bash
corepack enable
pnpm --filter @ai-dm/server add -D vitest@^3.2.7 ws@^8.18.0 @types/ws@^8.5.13
```

`@vitest/coverage-v8` must match vitest's major (3.x) if it is ever added here — `pnpm add` grabs 4.x and fails the peer check.

- [ ] **Step 2: Write the failing contract test**

`apps/server/src/core/event-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { SequenceConflictError, createInMemoryEventStore } from "./event-store.js";

function event(sequence: number, type: GameEvent["type"] = "player_input"): GameEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "s1",
    sequence,
    timestamp: "2026-08-19T10:00:00.000Z",
    type,
    payload: {},
  };
}

const state: SessionState = {
  sessionId: "s1",
  rootSeed: 1,
  encounterId: "e1",
  grid: { width: 1, height: 1, tiles: [["normal"]] },
  combatants: [],
  turnOrder: [],
  currentActorIndex: 0,
  round: 1,
  appliedClientMessageIds: [],
};

describe("in-memory EventStore", () => {
  it("reads back what it appended, in sequence order", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0), event(1)]);
    const read = await store.readSince("s1", -1);
    expect(read.map((each) => each.sequence)).toEqual([0, 1]);
  });

  it("reads only events after the given sequence", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0), event(1), event(2)]);
    expect((await store.readSince("s1", 0)).map((each) => each.sequence)).toEqual([1, 2]);
  });

  it("returns an empty list for an unknown session", async () => {
    const store = createInMemoryEventStore();
    expect(await store.readSince("nope", -1)).toEqual([]);
  });

  it("rejects a duplicate sequence", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0)]);
    await expect(store.append("s1", [event(0)])).rejects.toBeInstanceOf(SequenceConflictError);
  });

  it("appends a batch atomically — a conflict anywhere writes nothing", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0)]);
    await expect(store.append("s1", [event(1), event(0)])).rejects.toBeInstanceOf(
      SequenceConflictError,
    );
    // The good half of the batch must not have landed: a crash mid-turn may
    // not leave half a turn in the log.
    expect((await store.readSince("s1", -1)).map((each) => each.sequence)).toEqual([0]);
  });

  it("keeps sessions isolated", async () => {
    const store = createInMemoryEventStore();
    await store.append("s1", [event(0)]);
    await store.append("s2", [{ ...event(0), sessionId: "s2" }]);
    expect(await store.readSince("s1", -1)).toHaveLength(1);
  });

  it("has no snapshot until one is written", async () => {
    const store = createInMemoryEventStore();
    expect(await store.latestSnapshot("s1")).toBeNull();
  });

  it("returns the newest snapshot", async () => {
    const store = createInMemoryEventStore();
    await store.putSnapshot("s1", 50, state);
    await store.putSnapshot("s1", 100, { ...state, round: 4 });
    expect(await store.latestSnapshot("s1")).toMatchObject({ sequence: 100 });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- event-store
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the port**

`apps/server/src/core/event-store.ts`:

```ts
// The event log's storage boundary. Shaped around the SQL it will become:
// `append` is an atomic batch that conflicts on (sessionId, sequence), which
// is exactly `game_events`' unique constraint. The Postgres implementation in
// `@ai-dm/memory` is then a second implementation of this interface, not a
// refactor of its callers.
import type { GameEvent, SessionState } from "@ai-dm/schemas";

export class SequenceConflictError extends Error {
  constructor(sessionId: string, sequence: number) {
    super(`Event ${String(sequence)} already exists for session ${sessionId}`);
    this.name = "SequenceConflictError";
  }
}

export interface EventStore {
  /**
   * Atomic over the batch. A turn emits several events and a crash mid-turn
   * must not leave half a turn in the log, so either all of them land or none.
   */
  append(sessionId: string, events: readonly GameEvent[]): Promise<void>;
  /** Everything with `sequence > afterSequence`, in ascending order. */
  readSince(sessionId: string, afterSequence: number): Promise<GameEvent[]>;
  latestSnapshot(sessionId: string): Promise<{ sequence: number; state: SessionState } | null>;
  putSnapshot(sessionId: string, sequence: number, state: SessionState): Promise<void>;
}

interface SessionLog {
  events: GameEvent[];
  snapshot: { sequence: number; state: SessionState } | null;
}

export function createInMemoryEventStore(): EventStore {
  const logs = new Map<string, SessionLog>();

  function logFor(sessionId: string): SessionLog {
    const existing = logs.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionLog = { events: [], snapshot: null };
    logs.set(sessionId, created);
    return created;
  }

  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- the port is
    // async because Postgres is; this implementation has nothing to await.
    async append(sessionId, events) {
      const log = logFor(sessionId);
      const taken = new Set(log.events.map((each) => each.sequence));

      // Validate the whole batch before mutating anything — that is what makes
      // this atomic, and what the SQL version gets from its transaction.
      for (const event of events) {
        if (taken.has(event.sequence)) throw new SequenceConflictError(sessionId, event.sequence);
        taken.add(event.sequence);
      }
      log.events.push(...events);
      log.events.sort((a, b) => a.sequence - b.sequence);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async readSince(sessionId, afterSequence) {
      return logs.get(sessionId)?.events.filter((each) => each.sequence > afterSequence) ?? [];
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async latestSnapshot(sessionId) {
      return logs.get(sessionId)?.snapshot ?? null;
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async putSnapshot(sessionId, sequence, state) {
      const log = logFor(sessionId);
      if (log.snapshot === null || log.snapshot.sequence < sequence) {
        log.snapshot = { sequence, state };
      }
    },
  };
}
```

Remove any eslint directive the linter reports as unused.

- [ ] **Step 5: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test -- event-store
```

Expected: PASS, all eight cases.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/core/event-store.ts apps/server/src/core/event-store.test.ts apps/server/package.json pnpm-lock.yaml
git commit -m "feat(server): add the EventStore port and its in-memory implementation"
```

---

### Task 7: The projection — `reduce`

**Files:**
- Create: `apps/server/src/core/reduce.ts`
- Create: `apps/server/src/core/reduce.test.ts`

**Interfaces:**
- Consumes: `GameEvent`, `SessionState`, `Combatant` from `@ai-dm/schemas`
- Produces:
  - `reduce(state: SessionState, event: GameEvent): SessionState`
  - `fold(state: SessionState, events: readonly GameEvent[]): SessionState`
  - Payload schemas: `SessionStartedPayload`, `StateDeltaAppliedPayload`, `PlayerInputPayload`, `TurnAdvancedPayload` — zod objects local to this file

- [ ] **Step 1: Write the failing test**

`apps/server/src/core/reduce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { fold, reduce } from "./reduce.js";

const base: SessionState = {
  sessionId: "s1",
  rootSeed: 7,
  encounterId: "e1",
  grid: { width: 2, height: 1, tiles: [["normal", "normal"]] },
  combatants: [],
  turnOrder: ["hero", "villain"],
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

describe("reduce", () => {
  it("records a player input's clientMessageId for idempotency", () => {
    const next = reduce(base, event(0, "player_input", { clientMessageId: "c1", actorId: "hero" }));
    expect(next.appliedClientMessageIds).toEqual(["c1"]);
  });

  it("replaces combatants from a state delta", () => {
    const combatants = [
      { combatantId: "hero", faction: "party", position: [1, 0], currentHp: 3 },
    ];
    const next = reduce(base, event(1, "state_delta_applied", { combatants }));
    expect(next.combatants).toEqual(combatants);
  });

  it("advances the actor index without wrapping the round mid-cycle", () => {
    const next = reduce(base, event(2, "scene_changed", { kind: "turn_advanced" }));
    expect(next.currentActorIndex).toBe(1);
    expect(next.round).toBe(1);
  });

  it("wraps to the next round when the turn order completes", () => {
    const atEnd = { ...base, currentActorIndex: 1 };
    const next = reduce(atEnd, event(3, "scene_changed", { kind: "turn_advanced" }));
    expect(next.currentActorIndex).toBe(0);
    expect(next.round).toBe(2);
  });

  it("ignores events that change no projected state", () => {
    const next = reduce(base, event(4, "narrative_emitted", { text: "Goblin swings." }));
    expect(next).toEqual(base);
  });

  it("never mutates the state it was given", () => {
    const before = structuredClone(base);
    reduce(base, event(5, "player_input", { clientMessageId: "c9", actorId: "hero" }));
    expect(base).toEqual(before);
  });
});

describe("fold", () => {
  it("is reduce applied in order", () => {
    const events = [
      event(0, "player_input", { clientMessageId: "c1", actorId: "hero" }),
      event(1, "scene_changed", { kind: "turn_advanced" }),
      event(2, "player_input", { clientMessageId: "c2", actorId: "villain" }),
    ];
    const folded = fold(base, events);
    expect(folded.appliedClientMessageIds).toEqual(["c1", "c2"]);
    expect(folded.currentActorIndex).toBe(1);
  });

  it("is order-sensitive, so a shuffled log is a different projection", () => {
    const a = event(0, "scene_changed", { kind: "turn_advanced" });
    const b = event(1, "scene_changed", { kind: "turn_advanced" });
    expect(fold(base, [a, b]).round).toBe(2);
    expect(fold(base, [a]).round).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- reduce
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reduce`**

`apps/server/src/core/reduce.ts`:

```ts
// The projection. State is a fold of the event log and nothing else
// (invariant 3), so this function is the only place a `SessionState` changes
// shape — and it is pure, total and never mutates its input, which is what
// lets the same fold run on the client.
//
// `GameEvent.payload` is `z.record(z.string(), z.unknown())` on the wire, so
// every payload this cares about is parsed here rather than cast. An event
// whose payload does not parse is a bug in whoever wrote it, and throwing is
// better than folding a half-understood event into state.
import { z } from "zod";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { Combatant } from "@ai-dm/schemas";

const PlayerInputPayload = z.object({ clientMessageId: z.string() });
const StateDeltaAppliedPayload = z.object({ combatants: z.array(Combatant) });
const SceneChangedPayload = z.object({ kind: z.string() });

export function reduce(state: SessionState, event: GameEvent): SessionState {
  switch (event.type) {
    case "player_input": {
      const { clientMessageId } = PlayerInputPayload.parse(event.payload);
      return {
        ...state,
        appliedClientMessageIds: [...state.appliedClientMessageIds, clientMessageId],
      };
    }

    case "state_delta_applied": {
      const { combatants } = StateDeltaAppliedPayload.parse(event.payload);
      return { ...state, combatants };
    }

    case "scene_changed": {
      const { kind } = SceneChangedPayload.parse(event.payload);
      if (kind !== "turn_advanced") return state;
      const next = state.currentActorIndex + 1;
      const wrapped = next >= state.turnOrder.length;
      return {
        ...state,
        currentActorIndex: wrapped ? 0 : next,
        round: wrapped ? state.round + 1 : state.round,
      };
    }

    // Recorded for replay, audit and 7b's rejection dataset, but they change
    // no projected field. Listed explicitly rather than caught by `default` so
    // adding a `GameEvent` type fails the exhaustiveness check here.
    case "intent_classified":
    case "action_proposed":
    case "action_validated":
    case "action_rejected":
    case "dice_rolled":
    case "narrative_emitted":
    case "session_snapshot":
      return state;
  }
}

export function fold(state: SessionState, events: readonly GameEvent[]): SessionState {
  return events.reduce(reduce, state);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test -- reduce
```

Expected: PASS, all eight cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/reduce.ts apps/server/src/core/reduce.test.ts
git commit -m "feat(server): add the pure event-log projection"
```

---

### Task 8: Encounter catalogue and session creation

**Files:**
- Create: `apps/server/src/encounters/srd.ts`
- Create: `apps/server/src/encounters/index.ts`
- Create: `apps/server/src/encounters/index.test.ts`
- Create: `apps/server/src/core/session.ts`
- Create: `apps/server/src/core/session.test.ts`

**Interfaces:**
- Consumes: `buildEncounter`, `BuiltEncounter`, `EncounterDefinition` (Task 3); `EventStore`, `createInMemoryEventStore` (Task 6); `fold` (Task 7); `SessionState` (Task 4)
- Produces:
  - `loadMonster(monsterId: string): MonsterStatBlock`
  - `encounterById(encounterId: string): EncounterDefinition` — throws on unknown id
  - `buildEncounterById(encounterId: string): BuiltEncounter`
  - `interface Session { state: SessionState; built: BuiltEncounter; nextSequence: number }`
  - `createSession(input: { sessionId: string; encounterId: string; rootSeed: number; store: EventStore; clock: () => string; uuid: () => string }): Promise<Session>`
  - `loadSession(input: { sessionId: string; store: EventStore }): Promise<Session | null>`
  - `worldFor(session: Session): CombatWorld`

- [ ] **Step 1: Write the failing encounter-catalogue test**

`apps/server/src/encounters/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEncounterById, encounterById } from "./index.js";

describe("encounter catalogue", () => {
  it("knows the starter encounter", () => {
    expect(encounterById("goblin-ambush").encounterId).toBe("goblin-ambush");
  });

  it("throws a named error for an unknown id", () => {
    expect(() => encounterById("nope")).toThrow(/Unknown encounter nope/);
  });

  it("builds a world from real SRD stat blocks", () => {
    const built = buildEncounterById("goblin-ambush");
    expect(built.world.combatants.length).toBeGreaterThan(1);
    expect(built.turnOrder).toEqual(built.world.combatants.map((each) => each.combatantId));
    for (const combatant of built.world.combatants) {
      expect(built.statBlocks.get(combatant.combatantId)).toBeDefined();
    }
  });

  it("puts the party and the hostiles on opposite sides", () => {
    const built = buildEncounterById("goblin-ambush");
    const factions = new Set(built.world.combatants.map((each) => each.faction));
    expect(factions).toEqual(new Set(["party", "hostile"]));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- encounters
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the SRD loader**

`apps/server/src/encounters/srd.ts` — a deliberate duplicate of `tools/sim/src/scenarios/srd.ts`:

```ts
// Reads SRD 5.2.1 stat blocks from `data/srd/monsters/`. Content is CC-BY-4.0;
// see NOTICE.md.
//
// Duplicated from `tools/sim/src/scenarios/srd.ts` on purpose: there is no
// shared home for it. `@ai-dm/rules-engine` forbids I/O, and `@ai-dm/schemas`
// is bundled for the browser by `apps/web`, so `node:fs` cannot go in either.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MonsterStatBlock } from "@ai-dm/schemas";

const MONSTER_DIR_RELATIVE = join("data", "srd", "monsters");

/** Walk up until `data/srd/monsters` appears — a fixed relative path would be
 * wrong for `dist/` after `pnpm build`. */
function monsterDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, MONSTER_DIR_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${MONSTER_DIR_RELATIVE} above this file`);
    dir = parent;
  }
}

const cache = new Map<string, MonsterStatBlock>();

/** Parsed and validated. Cached — stat blocks are immutable data. */
export function loadMonster(monsterId: string): MonsterStatBlock {
  const hit = cache.get(monsterId);
  if (hit !== undefined) return hit;

  const path = join(monsterDir(), `${monsterId}.json`);
  const parsed = MonsterStatBlock.parse(JSON.parse(readFileSync(path, "utf8")));
  cache.set(monsterId, parsed);
  return parsed;
}
```

- [ ] **Step 4: Write the catalogue**

First check which monster files exist:

```bash
ls data/srd/monsters/
```

`apps/server/src/encounters/index.ts` — use two real basenames from that listing in place of `goblin` if it is not present:

```ts
// The encounters a session can be created from. Data, not logic: a definition
// is validated by `buildEncounter`, which throws rather than producing a
// half-valid world.
import { buildEncounter } from "@ai-dm/rules-engine";
import type { BuiltEncounter, EncounterDefinition } from "@ai-dm/rules-engine";
import type { MonsterStatBlock } from "@ai-dm/schemas";
import { loadMonster } from "./srd.js";

export { loadMonster };

const GOBLIN_AMBUSH: EncounterDefinition = {
  encounterId: "goblin-ambush",
  descriptionEnglish: "One fighter, two goblins, a corridor with cover at the midpoint.",
  width: 12,
  height: 8,
  terrain: [
    { tile: [6, 3], terrain: "half_cover" },
    { tile: [6, 4], terrain: "half_cover" },
  ],
  spawns: [
    { combatantId: "hero", monsterId: "goblin", faction: "party", position: [1, 4] },
    { combatantId: "goblin-a", monsterId: "goblin", faction: "hostile", position: [10, 3] },
    { combatantId: "goblin-b", monsterId: "goblin", faction: "hostile", position: [10, 5] },
  ],
  turnOrder: ["hero", "goblin-a", "goblin-b"],
  maxRounds: 20,
};

const CATALOGUE = new Map<string, EncounterDefinition>([[GOBLIN_AMBUSH.encounterId, GOBLIN_AMBUSH]]);

export function encounterById(encounterId: string): EncounterDefinition {
  const definition = CATALOGUE.get(encounterId);
  if (definition === undefined) throw new Error(`Unknown encounter ${encounterId}`);
  return definition;
}

export function buildEncounterById(encounterId: string): BuiltEncounter {
  const definition = encounterById(encounterId);
  const statBlocks = new Map<string, MonsterStatBlock>();
  for (const spawn of definition.spawns) {
    if (!statBlocks.has(spawn.monsterId)) statBlocks.set(spawn.monsterId, loadMonster(spawn.monsterId));
  }
  return buildEncounter({ definition, statBlocks });
}
```

The player is a goblin stat block for now: player characters have no weapon/spell range data yet (`RULES_REFERENCE.md` §8), and inventing one here would put un-sourced 5e numbers in the repo. Note this in the file if it is not obvious.

- [ ] **Step 5: Run the catalogue test**

```bash
pnpm --filter @ai-dm/server test -- encounters
```

Expected: PASS. If the terrain literals are rejected, check `TerrainType`'s members in `packages/schemas/src/world.ts:7`.

- [ ] **Step 6: Write the failing session test**

`apps/server/src/core/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "./event-store.js";
import { createSession, loadSession, worldFor } from "./session.js";

const clock = (): string => "2026-08-19T10:00:00.000Z";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

describe("createSession", () => {
  it("projects the encounter's combatants and turn order", async () => {
    const store = createInMemoryEventStore();
    const session = await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    expect(session.state.turnOrder).toEqual(["hero", "goblin-a", "goblin-b"]);
    expect(session.state.combatants).toHaveLength(3);
    expect(session.state.round).toBe(1);
    expect(session.state.currentActorIndex).toBe(0);
  });

  it("writes a session_snapshot event as sequence 0", async () => {
    const store = createInMemoryEventStore();
    await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    const events = await store.readSince("s1", -1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: 0, type: "session_snapshot" });
  });
});

describe("loadSession", () => {
  it("returns null for a session that was never created", async () => {
    expect(await loadSession({ sessionId: "nope", store: createInMemoryEventStore() })).toBeNull();
  });

  it("rebuilds an identical projection by folding the log", async () => {
    const store = createInMemoryEventStore();
    const created = await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    const loaded = await loadSession({ sessionId: "s1", store });
    expect(loaded?.state).toEqual(created.state);
    expect(loaded?.nextSequence).toBe(created.nextSequence);
  });
});

describe("worldFor", () => {
  it("pairs the projection with a CombatWorld the validator accepts", async () => {
    const store = createInMemoryEventStore();
    const session = await createSession({
      sessionId: "s1",
      encounterId: "goblin-ambush",
      rootSeed: 42,
      store,
      clock,
      uuid: uuids(),
    });
    const world = worldFor(session);
    expect(world.combatants).toEqual(session.state.combatants);
    expect(world.grid).toEqual(session.state.grid);
    expect(world.actionRangesFeet).toBeDefined();
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- session
```

Expected: FAIL — module not found.

- [ ] **Step 8: Implement `session.ts`**

`apps/server/src/core/session.ts`:

```ts
// A session is its projection plus the static encounter data that projection
// is not allowed to contain. Stat blocks and the grid's line-of-sight
// algorithm are re-derived from `encounterId` rather than snapshotted: they
// never change, and one of them is a function.
import { z } from "zod";
import type { BuiltEncounter, CombatWorld } from "@ai-dm/rules-engine";
import type { GameEvent, SessionState } from "@ai-dm/schemas";
import { buildEncounterById } from "../encounters/index.js";
import type { EventStore } from "./event-store.js";
import { fold } from "./reduce.js";

/** Sequence 0's payload. Parsed rather than cast — it is the only thing that
 * tells a reloaded session which encounter it is. */
const GenesisPayload = z.object({ encounterId: z.string(), rootSeed: z.number().int() });

export interface Session {
  state: SessionState;
  built: BuiltEncounter;
  /** The sequence the next appended event will take. */
  nextSequence: number;
}

export interface CreateSessionInput {
  sessionId: string;
  encounterId: string;
  rootSeed: number;
  store: EventStore;
  clock: () => string;
  uuid: () => string;
}

function initialState(input: {
  sessionId: string;
  rootSeed: number;
  built: BuiltEncounter;
}): SessionState {
  return {
    sessionId: input.sessionId,
    rootSeed: input.rootSeed,
    encounterId: input.built.encounterId,
    grid: input.built.world.grid,
    combatants: [...input.built.world.combatants],
    turnOrder: [...input.built.turnOrder],
    currentActorIndex: 0,
    round: 1,
    appliedClientMessageIds: [],
  };
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const built = buildEncounterById(input.encounterId);
  const state = initialState({ sessionId: input.sessionId, rootSeed: input.rootSeed, built });

  // Sequence 0 is the session's own genesis event. Without it, a log with no
  // turns yet is indistinguishable from a session that does not exist, and
  // `loadSession` could not tell them apart.
  const genesis: GameEvent = {
    eventId: input.uuid(),
    sessionId: input.sessionId,
    sequence: 0,
    timestamp: input.clock(),
    type: "session_snapshot",
    payload: { encounterId: input.encounterId, rootSeed: input.rootSeed, state },
  };
  await input.store.append(input.sessionId, [genesis]);

  return { state, built, nextSequence: 1 };
}

export async function loadSession(input: {
  sessionId: string;
  store: EventStore;
}): Promise<Session | null> {
  const events = await input.store.readSince(input.sessionId, -1);
  const genesis = events[0];
  if (genesis === undefined) return null;

  const { encounterId, rootSeed } = GenesisPayload.parse(genesis.payload);
  const built = buildEncounterById(encounterId);
  const state = fold(
    initialState({ sessionId: input.sessionId, rootSeed, built }),
    events.slice(1),
  );

  const last = events[events.length - 1];
  return { state, built, nextSequence: (last?.sequence ?? 0) + 1 };
}

/**
 * The validator and the resolver want a `CombatWorld`; the projection holds
 * only its serializable half. This is where the two are married, and the only
 * place that knows the difference.
 */
export function worldFor(session: Session): CombatWorld {
  return {
    ...session.built.world,
    grid: session.state.grid,
    combatants: session.state.combatants,
  };
}
```

- [ ] **Step 9: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test && pnpm typecheck && pnpm lint
```

Expected: PASS, all session and encounter cases green.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/encounters apps/server/src/core/session.ts apps/server/src/core/session.test.ts
git commit -m "feat(server): add the encounter catalogue and session lifecycle"
```

---

### Task 9: The pipeline — the player's structured action

**Files:**
- Create: `apps/server/src/core/pipeline.ts`
- Create: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `Session`, `worldFor` (Task 8); `EventStore` (Task 6); `reduce` (Task 7); `NarrativePort` (Task 5); `applyTurn`, `seeded`, `validateExecuteTurn` (Tasks 1–2); `ClientMessage`, `ServerFrame` (Task 4)
- Produces:
  - `interface TurnPorts { store: EventStore; tactical: TacticalAgent; narrative: NarrativePort; clock: () => string; uuid: () => string; seedFor: (rootSeed: number, sequence: number) => number; turnTimeoutMs: number }`
  - `handleCommand(session: Session, command: ClientMessage, ports: TurnPorts): AsyncIterable<ServerFrame>`
  - `SNAPSHOT_EVERY = 50`

This task covers `join`, `free_text` and the player's `structured_action`. Enemy turns are Task 10.

- [ ] **Step 1: Write the failing test**

`apps/server/src/core/pipeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerFrame } from "@ai-dm/schemas";
import { createDeterministicNarrative } from "@ai-dm/agents";
import { createInMemoryEventStore } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import { handleCommand } from "./pipeline.js";
import type { TurnPorts } from "./pipeline.js";
import { createSession } from "./session.js";
import type { Session } from "./session.js";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

function portsWith(store: EventStore): TurnPorts {
  return {
    store,
    // Task 10 replaces this with a real fake-port-backed agent; nothing in
    // this task's cases reaches it.
    tactical: { proposeTurn: () => Promise.reject(new Error("not used in this test")) },
    narrative: createDeterministicNarrative(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid: uuids(),
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
  };
}

async function drain(stream: AsyncIterable<ServerFrame>): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

async function freshSession(store: EventStore): Promise<Session> {
  return createSession({
    sessionId: "s1",
    encounterId: "goblin-ambush",
    rootSeed: 42,
    store,
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid: uuids(),
  });
}

describe("handleCommand — join", () => {
  it("sends a snapshot when the client has nothing", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1" }, portsWith(store)),
    );
    expect(frames[0]).toMatchObject({ type: "session_state" });
  });

  it("replays only the events after resumeFrom", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(
      handleCommand(session, { type: "join", sessionId: "s1", resumeFrom: 0 }, portsWith(store)),
    );
    expect(frames.filter((each) => each.type === "session_state")).toHaveLength(0);
  });
});

describe("handleCommand — free text", () => {
  it("is refused with a stable code rather than reaching a model", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(
      handleCommand(
        session,
        { type: "free_text", clientMessageId: "c1", text: "I swing at the goblin" },
        portsWith(store),
      ),
    );
    expect(frames).toEqual([
      {
        type: "error",
        clientMessageId: "c1",
        code: "free_text_not_supported",
        message: expect.any(String) as unknown as string,
      },
    ]);
  });

  it("writes nothing to the log", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(
      handleCommand(
        session,
        { type: "free_text", clientMessageId: "c1", text: "hello" },
        portsWith(store),
      ),
    );
    expect(await store.readSince("s1", 0)).toEqual([]);
  });
});

describe("handleCommand — structured action", () => {
  const dodge = (actorId: string): ClientMessage => ({
    type: "structured_action",
    clientMessageId: "c1",
    actorId,
    turn: { actorId, mainAction: { actionType: "dodge" } },
  });

  it("refuses an action from someone whose turn it is not", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("goblin-a"), portsWith(store)));
    expect(frames[0]).toMatchObject({ type: "error", code: "not_your_turn" });
  });

  it("appends player_input, action_validated, dice_rolled and state_delta_applied in order", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const types = (await store.readSince("s1", 0)).map((each) => each.type);
    expect(types.slice(0, 4)).toEqual([
      "player_input",
      "action_validated",
      "dice_rolled",
      "state_delta_applied",
    ]);
  });

  it("yields an event frame for every event it appends", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const appended = await store.readSince("s1", 0);
    const framed = frames.filter((each) => each.type === "event");
    expect(framed).toHaveLength(appended.length);
  });

  it("records the dice seed in the event so replay does not re-derive it", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const rolled = (await store.readSince("s1", 0)).find((each) => each.type === "dice_rolled");
    expect(rolled?.payload).toMatchObject({ seed: expect.any(Number) as unknown as number });
  });

  it("streams narrative tokens and closes with narrative_emitted", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    expect(frames.some((each) => each.type === "narrative_token")).toBe(true);
    const types = (await store.readSince("s1", 0)).map((each) => each.type);
    expect(types).toContain("narrative_emitted");
  });

  it("drops a duplicate clientMessageId without applying it twice", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const afterFirst = (await store.readSince("s1", 0)).length;

    const frames = await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    expect(frames).toEqual([]);
    expect((await store.readSince("s1", 0)).length).toBe(afterFirst);
  });

  it("rejects an illegal turn without advancing the turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const before = session.state.currentActorIndex;
    const frames = await drain(
      handleCommand(
        session,
        {
          type: "structured_action",
          clientMessageId: "c2",
          actorId: "hero",
          turn: {
            actorId: "hero",
            mainAction: { actionType: "attack", targetIds: ["goblin-a"] },
          },
        },
        portsWith(store),
      ),
    );
    expect(frames.some((each) => each.type === "rejected")).toBe(true);
    expect(session.state.currentActorIndex).toBe(before);
    const types = (await store.readSince("s1", 0)).map((each) => each.type);
    expect(types).toContain("action_rejected");
  });
});
```

The illegal-turn case relies on `goblin-a` being far out of reach in `goblin-ambush` — positions `[1,4]` and `[10,3]` are ~45 ft apart, so `target_out_of_reach` fires. If the validator accepts it, pick a clearly illegal turn instead (an off-grid destination tile) and keep the assertion.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- pipeline
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pipeline**

`apps/server/src/core/pipeline.ts`:

```ts
// The turn pipeline, as one async generator over ports. Order is fixed by
// `apps/server/CLAUDE.md`: input -> validate -> events appended before the ack
// -> narrative streams -> enemy turns.
//
// The rule that holds the whole thing together: appending an event and
// yielding its frame is ONE operation (`emit` below). No path may do one
// without the other, so the socket can never show an event that was not
// logged, or miss one that was.
//
// `clock`, `uuid` and `seedFor` are ports, not globals. That is what lets a
// test assert an exact event stream, and what makes a replayed session
// reproduce the fight rather than a new one.
import { applyTurn, seeded, validateExecuteTurn } from "@ai-dm/rules-engine";
import type { TurnEffect } from "@ai-dm/rules-engine";
import type { NarrativePort, TacticalAgent } from "@ai-dm/agents";
import type { ClientMessage, GameEvent, ServerFrame } from "@ai-dm/schemas";
import type { EventStore } from "./event-store.js";
import { reduce } from "./reduce.js";
import type { Session } from "./session.js";
import { worldFor } from "./session.js";

/** `apps/server/CLAUDE.md`: snapshot every 50 events. */
export const SNAPSHOT_EVERY = 50;

export interface TurnPorts {
  store: EventStore;
  tactical: TacticalAgent;
  narrative: NarrativePort;
  clock: () => string;
  uuid: () => string;
  /** Deterministic per turn. Recorded in `dice_rolled`; replay reads it back. */
  seedFor: (rootSeed: number, sequence: number) => number;
  turnTimeoutMs: number;
}

function namesFor(session: Session): Record<string, string | undefined> {
  const names: Record<string, string | undefined> = {};
  for (const [combatantId, statBlock] of session.built.statBlocks) {
    names[combatantId] = statBlock.nameEnglish;
  }
  return names;
}

export async function* handleCommand(
  session: Session,
  command: ClientMessage,
  ports: TurnPorts,
): AsyncIterable<ServerFrame> {
  /**
   * Append one event and yield its frame. The single place either happens.
   * Mutates the session in step so a later stage in the same turn reads the
   * state the earlier stage produced.
   */
  async function* emit(
    type: GameEvent["type"],
    payload: Record<string, unknown>,
  ): AsyncIterable<ServerFrame> {
    const event: GameEvent = {
      eventId: ports.uuid(),
      sessionId: session.state.sessionId,
      sequence: session.nextSequence,
      timestamp: ports.clock(),
      type,
      payload,
    };
    await ports.store.append(session.state.sessionId, [event]);
    session.nextSequence += 1;
    session.state = reduce(session.state, event);

    if (event.sequence > 0 && event.sequence % SNAPSHOT_EVERY === 0) {
      // A cache, never authority: `loadSession` folds the log regardless.
      await ports.store.putSnapshot(session.state.sessionId, event.sequence, session.state);
    }
    yield { type: "event", event };
  }

  async function* narrate(actorId: string, effect: TurnEffect): AsyncIterable<ServerFrame> {
    const streamId = ports.uuid();
    const actorName = session.built.statBlocks.get(actorId)?.nameEnglish ?? actorId;
    let text = "";
    for await (const chunk of ports.narrative.stream({
      actorName,
      effect,
      namesByCombatantId: namesFor(session),
    })) {
      text += chunk;
      yield { type: "narrative_token", streamId, text: chunk };
    }
    yield* emit("narrative_emitted", { actorId, streamId, text: text.trim() });
  }

  switch (command.type) {
    case "join": {
      if (command.resumeFrom === undefined) {
        yield { type: "session_state", sequence: session.nextSequence - 1, snapshot: session.state };
        return;
      }
      for (const event of await ports.store.readSince(session.state.sessionId, command.resumeFrom)) {
        yield { type: "event", event };
      }
      return;
    }

    case "free_text": {
      yield {
        type: "error",
        clientMessageId: command.clientMessageId,
        code: "free_text_not_supported",
        message: "Free text is not handled yet. Use the on-screen actions.",
      };
      return;
    }

    case "structured_action": {
      // Idempotency as a projection, not connection state: this survives a
      // reconnect, so a resent action after a dropped ack is dropped here
      // rather than played twice.
      if (session.state.appliedClientMessageIds.includes(command.clientMessageId)) return;

      const currentActorId = session.state.turnOrder[session.state.currentActorIndex];
      if (currentActorId !== command.actorId) {
        yield {
          type: "error",
          clientMessageId: command.clientMessageId,
          code: "not_your_turn",
          message: `It is ${currentActorId ?? "nobody"}'s turn.`,
        };
        return;
      }

      yield* emit("player_input", {
        clientMessageId: command.clientMessageId,
        actorId: command.actorId,
      });

      const world = worldFor(session);
      const actor = world.combatants.find((each) => each.combatantId === command.actorId);
      if (actor === undefined) {
        yield {
          type: "error",
          clientMessageId: command.clientMessageId,
          code: "internal_error",
          message: `No combatant ${command.actorId} in this encounter.`,
        };
        return;
      }

      const validation = validateExecuteTurn(command.turn, actor, world);
      if (!validation.valid) {
        const reasons = validation.rejections.map((each) => each.reason);
        const messages = validation.rejections.map((each) => each.message);
        yield* emit("action_rejected", {
          actorId: command.actorId,
          attempt: 1,
          stage: "engine",
          reasons,
          messages,
          proposedTurn: command.turn,
          provider: "human",
          modelId: "human",
        });
        // No auto-retry for a human: that loop exists because a model cannot
        // read a UI. The turn does not advance.
        yield { type: "rejected", clientMessageId: command.clientMessageId, reasons, messages };
        return;
      }

      yield* emit("action_validated", { actorId: command.actorId, turn: command.turn });

      const seed = ports.seedFor(session.state.rootSeed, session.nextSequence);
      const { world: after, effect } = applyTurn({
        world,
        actorId: command.actorId,
        turn: command.turn,
        plan: validation.plan,
        context: { statBlocks: session.built.statBlocks },
        rng: seeded(seed),
      });

      yield* emit("dice_rolled", { actorId: command.actorId, seed, attacks: effect.attacks });
      yield* emit("state_delta_applied", { combatants: after.combatants });
      yield* narrate(command.actorId, effect);
      yield* emit("scene_changed", { kind: "turn_advanced" });
      return;
    }
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test -- pipeline
```

Expected: PASS, all eleven cases. If `validateExecuteTurn`'s result shape differs, read `packages/rules-engine/src/combat/validate-turn.ts` and match it — the engine is the authority.

- [ ] **Step 5: Verify the repo**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/core/pipeline.ts apps/server/src/core/pipeline.test.ts
git commit -m "feat(server): add the turn pipeline for player structured actions"
```

---

### Task 10: The pipeline — enemy turns and the turn timeout

**Files:**
- Modify: `apps/server/src/core/pipeline.ts`
- Modify: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `TacticalAgent`, `createTacticalAgent`, `createAgentRuntime`, `createFakePort`, `availableActionsFor` from `@ai-dm/agents`
- Produces: no new exports — `handleCommand` now runs enemy turns to completion before returning

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/core/pipeline.test.ts`:

```ts
import { createAgentRuntime, createFakePort, createTacticalAgent, DEFAULT_MODEL_ROUTING } from "@ai-dm/agents";
import type { ExecuteTurn } from "@ai-dm/schemas";

function agentProposing(turns: readonly ExecuteTurn[]) {
  const port = createFakePort({
    structured: turns.map((turn) => ({
      ok: true as const,
      value: { value: turn, usage: { inputTokens: 10, outputTokens: 5 } },
    })),
  });
  return createTacticalAgent({
    runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
  });
}

describe("handleCommand — enemy turns", () => {
  const heroDodge: ClientMessage = {
    type: "structured_action",
    clientMessageId: "c1",
    actorId: "hero",
    turn: { actorId: "hero", mainAction: { actionType: "dodge" } },
  };

  it("runs every hostile turn before handing control back to the player", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        { actorId: "goblin-a", mainAction: { actionType: "dodge" } },
        { actorId: "goblin-b", mainAction: { actionType: "dodge" } },
      ]),
    };

    await drain(handleCommand(session, heroDodge, ports));

    // Back to the top of the order, one round later.
    expect(session.state.currentActorIndex).toBe(0);
    expect(session.state.round).toBe(2);
  });

  it("logs the tactical agent's rejections as action_rejected events", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const port = createFakePort({
      structured: [
        // Illegal: attacking a target ~45 ft away with a 5 ft reach.
        {
          ok: true as const,
          value: {
            value: {
              actorId: "goblin-a",
              mainAction: { actionType: "attack", targetIds: ["hero"] },
            },
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        },
        {
          ok: true as const,
          value: {
            value: { actorId: "goblin-a", mainAction: { actionType: "dodge" } },
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        },
        {
          ok: true as const,
          value: {
            value: { actorId: "goblin-b", mainAction: { actionType: "dodge" } },
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        },
      ],
    });
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: createTacticalAgent({
        runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
      }),
    };

    await drain(handleCommand(session, heroDodge, ports));

    const rejected = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_rejected",
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.payload).toMatchObject({ actorId: "goblin-a", stage: "engine" });
  });

  it("stamps the rejection with the model that produced it", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        { actorId: "goblin-a", mainAction: { actionType: "dodge" } },
        { actorId: "goblin-b", mainAction: { actionType: "dodge" } },
      ]),
    };
    await drain(handleCommand(session, heroDodge, ports));
    const validated = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "action_validated",
    );
    // hero + two goblins
    expect(validated).toHaveLength(3);
  });

  it("narrates each enemy turn", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        { actorId: "goblin-a", mainAction: { actionType: "dodge" } },
        { actorId: "goblin-b", mainAction: { actionType: "dodge" } },
      ]),
    };
    await drain(handleCommand(session, heroDodge, ports));
    const narrated = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "narrative_emitted",
    );
    expect(narrated).toHaveLength(3);
  });
});
```

`DEFAULT_MODEL_ROUTING`'s exported name must match `packages/agents/src/providers/routing.ts` — check it and correct the import if it differs.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- pipeline
```

Expected: FAIL — the new cases see `currentActorIndex: 1` because enemy turns do not run yet.

- [ ] **Step 3: Add the enemy loop**

In `apps/server/src/core/pipeline.ts`, add the import:

```ts
import { availableActionsFor } from "@ai-dm/agents";
```

Add this generator inside `handleCommand`, beside `narrate`:

```ts
  /**
   * One hostile turn. The validate -> retry-once -> fallback loop is the
   * agent's (step 7a); this only stamps its rejections into the log and
   * applies whatever legal turn came back.
   */
  async function* enemyTurn(actorId: string): AsyncIterable<ServerFrame> {
    const world = worldFor(session);
    const statBlock = session.built.statBlocks.get(actorId);
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, ports.turnTimeoutMs);

    let proposal;
    try {
      proposal = await ports.tactical.proposeTurn({
        world,
        actorId,
        availableActions: statBlock === undefined ? [] : availableActionsFor(statBlock),
        turnOrder: session.state.turnOrder,
        abortSignal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Every attempt the agent made, whether or not one succeeded. This is the
    // dataset step 7b's rejection analysis reads.
    for (const rejection of proposal.rejections) {
      yield* emit("action_rejected", { ...rejection });
    }

    if (!proposal.ok) {
      // `aborted` (the 10s budget) or `no_legal_turn`. Either way the creature
      // forfeits its turn rather than the pipeline stalling.
      yield* emit("scene_changed", { kind: "turn_advanced" });
      return;
    }

    yield* emit("action_validated", { actorId, turn: proposal.turn, source: proposal.source });

    const seed = ports.seedFor(session.state.rootSeed, session.nextSequence);
    const { world: after, effect } = applyTurn({
      world,
      actorId,
      turn: proposal.turn,
      plan: proposal.plan,
      context: { statBlocks: session.built.statBlocks },
      rng: seeded(seed),
    });

    yield* emit("dice_rolled", { actorId, seed, attacks: effect.attacks });
    yield* emit("state_delta_applied", { combatants: after.combatants });
    yield* narrate(actorId, effect);
    yield* emit("scene_changed", { kind: "turn_advanced" });
  }

  /**
   * Run hostiles until it is a party member's turn again, or nobody is left to
   * fight. Bounded by the turn order's length so a bug in `turn_advanced`
   * cannot spin forever.
   */
  async function* runEnemyTurns(): AsyncIterable<ServerFrame> {
    for (let guard = 0; guard <= session.state.turnOrder.length; guard += 1) {
      const actorId = session.state.turnOrder[session.state.currentActorIndex];
      if (actorId === undefined) return;

      const combatant = session.state.combatants.find((each) => each.combatantId === actorId);
      if (combatant === undefined) return;
      if (combatant.faction === "party") return;

      // A downed or dead creature is skipped, not asked for a turn.
      if (combatant.status !== "alive") {
        yield* emit("scene_changed", { kind: "turn_advanced" });
        continue;
      }

      const livingFactions = new Set(
        session.state.combatants.filter((each) => each.status === "alive").map((each) => each.faction),
      );
      if (livingFactions.size < 2) return;

      yield* enemyTurn(actorId);
    }
  }
```

Then, in the `structured_action` case, replace the final line:

```ts
      yield* emit("scene_changed", { kind: "turn_advanced" });
      return;
```

with:

```ts
      yield* emit("scene_changed", { kind: "turn_advanced" });
      yield* runEnemyTurns();
      return;
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test -- pipeline
```

Expected: PASS, all fifteen cases.

- [ ] **Step 5: Write the failing test for the narrative timeout**

`apps/server/CLAUDE.md` puts a hard 10s cap on the *turn*, not just the model call, "with a fallback terse narration from the rule outcome". The tactical side is covered by the abort signal above; the narrative stream is not. The deterministic port cannot hang, but step 9's will, so the cap goes in now with a hanging port to prove it.

Append to `apps/server/src/core/pipeline.test.ts`:

```ts
import type { NarrativePort } from "@ai-dm/agents";

/** Yields one token, then never resolves. What a wedged provider looks like. */
function hangingNarrative(): NarrativePort {
  return {
    // eslint-disable-next-line require-yield
    async *stream() {
      await new Promise(() => {
        // never resolves
      });
    },
  };
}

describe("handleCommand — turn timeout", () => {
  it("falls back to terse narration when the narrative stream hangs", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        { actorId: "goblin-a", mainAction: { actionType: "dodge" } },
        { actorId: "goblin-b", mainAction: { actionType: "dodge" } },
      ]),
      narrative: hangingNarrative(),
      turnTimeoutMs: 50,
    };

    const frames = await drain(
      handleCommand(
        session,
        {
          type: "structured_action",
          clientMessageId: "c1",
          actorId: "hero",
          turn: { actorId: "hero", mainAction: { actionType: "dodge" } },
        },
        ports,
      ),
    );

    // The turn completed rather than hanging, and it still produced prose.
    const emitted = (await store.readSince("s1", 0)).filter(
      (each) => each.type === "narrative_emitted",
    );
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0]?.payload).toMatchObject({ text: expect.stringContaining("Fighter") as unknown as string });
    expect(frames.some((each) => each.type === "event")).toBe(true);
  }, 10_000);

  it("still advances the turn after a narrative timeout", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    const ports: TurnPorts = {
      ...portsWith(store),
      tactical: agentProposing([
        { actorId: "goblin-a", mainAction: { actionType: "dodge" } },
        { actorId: "goblin-b", mainAction: { actionType: "dodge" } },
      ]),
      narrative: hangingNarrative(),
      turnTimeoutMs: 50,
    };
    await drain(
      handleCommand(
        session,
        {
          type: "structured_action",
          clientMessageId: "c1",
          actorId: "hero",
          turn: { actorId: "hero", mainAction: { actionType: "dodge" } },
        },
        ports,
      ),
    );
    expect(session.state.round).toBe(2);
  }, 10_000);
});
```

The actor name in the first assertion is whatever `hero`'s stat block is called — if the encounter uses a goblin for the player, assert on `"Goblin"` instead. Read the failure, don't guess.

- [ ] **Step 6: Run it and watch it hang or fail**

```bash
pnpm --filter @ai-dm/server test -- pipeline
```

Expected: FAIL — the two new cases time out at 10s, because nothing caps the stream yet.

- [ ] **Step 7: Cap the narrative stream**

In `apps/server/src/core/pipeline.ts`, add this helper above `handleCommand`:

```ts
/**
 * Yields from `stream` until `ms` elapses, then stops. A wedged provider must
 * not wedge the turn: `apps/server/CLAUDE.md` caps the whole turn at 10s and
 * falls back to terse narration from the rule outcome.
 *
 * Whatever tokens arrived before the cap are kept — a partial sentence beats
 * an empty one, and the caller appends `narrative_emitted` with what it got.
 */
async function* untilDeadline(
  stream: AsyncIterable<string>,
  ms: number,
): AsyncIterable<string> {
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;

    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => { resolve("timeout"); }, remaining));
    const next = await Promise.race([iterator.next(), timeout]);
    if (next === "timeout") return;
    if (next.done === true) return;
    yield next.value;
  }
}
```

Then in `narrate`, wrap the stream and fall back when nothing survived:

```ts
    for await (const chunk of untilDeadline(
      ports.narrative.stream({ actorName, effect, namesByCombatantId: namesFor(session) }),
      ports.turnTimeoutMs,
    )) {
      text += chunk;
      yield { type: "narrative_token", streamId, text: chunk };
    }

    // The cap fired before a single token arrived. Render the rule outcome
    // directly — the same terse fallback, just not streamed.
    if (text.trim() === "") {
      for await (const chunk of createDeterministicNarrative().stream({
        actorName,
        effect,
        namesByCombatantId: namesFor(session),
      })) {
        text += chunk;
        yield { type: "narrative_token", streamId, text: chunk };
      }
    }

    yield* emit("narrative_emitted", { actorId, streamId, text: text.trim() });
```

and add the import:

```ts
import { createDeterministicNarrative } from "@ai-dm/agents";
```

- [ ] **Step 8: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test -- pipeline
```

Expected: PASS, all seventeen cases, and the two timeout cases finish in well under a second rather than hitting vitest's own timeout.

- [ ] **Step 9: Verify the repo**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/core/pipeline.ts apps/server/src/core/pipeline.test.ts
git commit -m "feat(server): run enemy turns through the tactical agent, cap the turn at the timeout"
```

---

### Task 11: Replay and determinism properties

The four properties the spec names. They are the reason the core was built this way, so they get their own file and their own review.

**Files:**
- Create: `apps/server/src/core/replay.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–10. No new production code — if a property fails, fix the code it caught.

- [ ] **Step 1: Write the properties**

`apps/server/src/core/replay.test.ts`:

```ts
// The four invariants the event-sourced design exists to buy. If any of these
// fails, the projection has forked from the log and no amount of passing unit
// tests makes the server correct.
import { describe, expect, it } from "vitest";
import { createAgentRuntime, createDeterministicNarrative, createFakePort, createTacticalAgent, DEFAULT_MODEL_ROUTING } from "@ai-dm/agents";
import type { ClientMessage, ExecuteTurn, ServerFrame } from "@ai-dm/schemas";
import { createInMemoryEventStore } from "./event-store.js";
import type { EventStore } from "./event-store.js";
import { handleCommand } from "./pipeline.js";
import type { TurnPorts } from "./pipeline.js";
import { fold } from "./reduce.js";
import { createSession, loadSession } from "./session.js";

const CLOCK = (): string => "2026-08-19T10:00:00.000Z";

function uuids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

function dodgeFor(actorId: string): ExecuteTurn {
  return { actorId, mainAction: { actionType: "dodge" } };
}

function portsWith(store: EventStore): TurnPorts {
  const port = createFakePort({
    structured: Array.from({ length: 40 }, () => ({
      ok: true as const,
      value: { value: dodgeFor("goblin-a"), usage: { inputTokens: 1, outputTokens: 1 } },
    })),
  });
  return {
    store,
    tactical: createTacticalAgent({
      runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    }),
    narrative: createDeterministicNarrative(),
    clock: CLOCK,
    uuid: uuids(),
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
  };
}

async function playRounds(store: EventStore, rounds: number) {
  const session = await createSession({
    sessionId: "s1",
    encounterId: "goblin-ambush",
    rootSeed: 42,
    store,
    clock: CLOCK,
    uuid: uuids(),
  });
  const ports = portsWith(store);

  for (let round = 0; round < rounds; round += 1) {
    const command: ClientMessage = {
      type: "structured_action",
      clientMessageId: `c${String(round)}`,
      actorId: "hero",
      turn: dodgeFor("hero"),
    };
    for await (const _frame of handleCommand(session, command, ports)) {
      void _frame;
    }
  }
  return session;
}

describe("replay properties", () => {
  it("folding the log from zero equals the live projection", async () => {
    const store = createInMemoryEventStore();
    const live = await playRounds(store, 3);
    const reloaded = await loadSession({ sessionId: "s1", store });
    expect(reloaded?.state).toEqual(live.state);
  });

  it("a reconnect at any sequence leaves the client's fold equal to the server's", async () => {
    const store = createInMemoryEventStore();
    const live = await playRounds(store, 3);
    const events = await store.readSince("s1", -1);

    for (let cut = 0; cut < events.length; cut += 1) {
      const upTo = await loadSession({ sessionId: "s1", store });
      if (upTo === null) throw new Error("session vanished");
      // The client holds everything up to `cut`, then replays the rest.
      const replayed = fold(
        fold(upTo.state, []),
        events.filter((each) => each.sequence > events[cut]!.sequence),
      );
      expect(replayed.combatants).toEqual(live.state.combatants);
    }
  });

  it("the same rootSeed and the same commands produce the same event stream", async () => {
    const first = createInMemoryEventStore();
    const second = createInMemoryEventStore();
    await playRounds(first, 3);
    await playRounds(second, 3);

    const a = await first.readSince("s1", -1);
    const b = await second.readSince("s1", -1);
    expect(a).toEqual(b);
  });

  it("a different rootSeed produces a different fight", async () => {
    const store = createInMemoryEventStore();
    const session = await createSession({
      sessionId: "s2",
      encounterId: "goblin-ambush",
      rootSeed: 99,
      store,
      clock: CLOCK,
      uuid: uuids(),
    });
    expect(session.state.rootSeed).toBe(99);
  });
});
```

- [ ] **Step 2: Run the properties**

```bash
pnpm --filter @ai-dm/server test -- replay
```

Expected: PASS. If the reconnect property fails, the bug is real — the projection has diverged from the log. Fix `reduce` or `pipeline`, not the test.

- [ ] **Step 3: Add the snapshot property**

Append to `apps/server/src/core/replay.test.ts`:

```ts
import { SessionState } from "@ai-dm/schemas";
import { SNAPSHOT_EVERY } from "./pipeline.js";

describe("snapshots", () => {
  it("is a cache that agrees exactly with the fold at its own sequence", async () => {
    const store = createInMemoryEventStore();
    // Enough player turns to cross at least one 50-event boundary: each turn
    // writes ~4 events for the hero plus ~5 per goblin.
    await playRounds(store, 12);

    const snapshot = await store.latestSnapshot("s1");
    const events = await store.readSince("s1", -1);
    if (snapshot === null) {
      throw new Error(
        `No snapshot after ${String(events.length)} events; expected one every ${String(SNAPSHOT_EVERY)}`,
      );
    }

    expect(snapshot.sequence % SNAPSHOT_EVERY).toBe(0);

    // The load-bearing assertion: fold the log up to the snapshot's sequence
    // and you must get the snapshot, byte for byte. A snapshot that disagrees
    // with the log is a fork, and reconnect would hand a client a false world.
    const genesis = events[0];
    if (genesis === undefined) throw new Error("no genesis event");

    // Sequence 0 carries the initial projection (see `createSession`), which
    // is exactly the state `fold` starts from.
    const initial = SessionState.parse(
      (genesis.payload as { state: unknown }).state,
    );
    const upToSnapshot = events.filter(
      (each) => each.sequence > 0 && each.sequence <= snapshot.sequence,
    );

    expect(fold(initial, upToSnapshot)).toEqual(snapshot.state);
  });
});
```

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @ai-dm/server test && pnpm typecheck && pnpm lint
git add apps/server/src/core/replay.test.ts
git commit -m "test(server): pin the replay, reconnect and determinism properties"
```

---

### Task 12: Boot configuration

**Files:**
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/config.test.ts`
- Create: `apps/server/.env.example`
- Modify: `apps/server/CLAUDE.md` (line 24's dangling reference)

**Interfaces:**
- Produces: `ServerConfig` (zod schema + type), `loadConfig(env: NodeJS.ProcessEnv): ServerConfig`

- [ ] **Step 1: Write the failing test**

`apps/server/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("accepts a minimal environment", () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: "sk-test" });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
  });

  it("parses PORT as a number", () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: "sk-test", PORT: "8080" }).port).toBe(8080);
  });

  it("fails fast when no provider key is present", () => {
    expect(() => loadConfig({})).toThrow(/at least one provider API key/);
  });

  it("rejects a non-numeric PORT rather than defaulting", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-test", PORT: "http" })).toThrow();
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: "sk-test", LOG_LEVEL: "chatty" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- config
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

`apps/server/src/config.ts`:

```ts
// Boot configuration, validated with zod and failing fast. A server that
// starts without the key it needs fails on the first player's first turn
// instead of at boot, which is the worst possible time to find out.
//
// No key is ever logged or echoed into an event.
import { z } from "zod";

const LogLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

const RawEnv = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, "PORT must be a number")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535))
    .optional(),
  LOG_LEVEL: LogLevel.optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
});

export interface ServerConfig {
  port: number;
  logLevel: z.infer<typeof LogLevel>;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = RawEnv.parse(env);

  // Which providers are needed depends on `ModelRouting`, which is config; all
  // this can check is that the process could talk to something at all.
  const hasKey =
    parsed.ANTHROPIC_API_KEY !== undefined ||
    parsed.OPENAI_API_KEY !== undefined ||
    parsed.GOOGLE_GENERATIVE_AI_API_KEY !== undefined;
  if (!hasKey) {
    throw new Error(
      "Set at least one provider API key: ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.",
    );
  }

  return { port: parsed.PORT ?? 3000, logLevel: parsed.LOG_LEVEL ?? "info" };
}
```

The provider SDKs read their own keys from `process.env` when a call is made, so nothing here passes them onward — this only refuses to boot without one.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test -- config
```

Expected: PASS, all five cases.

- [ ] **Step 5: Recreate `.env.example`**

`apps/server/.env.example`:

```
# Copy to .env. Validated by src/config.ts at boot — a missing provider key
# fails the process rather than the first turn.

PORT=3000
LOG_LEVEL=info

# At least one is required. Which one depends on ModelRouting (see
# packages/agents/src/providers/routing.ts); the SDKs read these directly.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=

# Not yet used — the event store is in-memory until the persistence spec.
# DATABASE_URL=postgres://aidm:aidm@localhost:5432/aidm
```

- [ ] **Step 6: Fix the dangling doc reference**

`apps/server/CLAUDE.md`'s Config section currently reads:

> Secrets/env via `.env` (see `.env.example`) validated with zod at boot — fail fast on missing keys. Model routing lives in config, not code.

Replace that paragraph with one naming the validator, so the doc points at code as well as at the file:

```markdown
Secrets/env via `.env` (see [`.env.example`](.env.example)), validated by
`src/config.ts` with zod at boot — the process refuses to start without at
least one provider API key. Model routing lives in config, not code.
```

Confirm the reference now resolves:

```bash
ls apps/server/.env.example
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/config.test.ts apps/server/.env.example apps/server/CLAUDE.md
git commit -m "feat(server): validate boot config with zod, restore .env.example"
```

---

### Task 13: HTTP transport — session creation

**Files:**
- Create: `apps/server/src/transport/http.ts`
- Create: `apps/server/src/transport/http.test.ts`

**Interfaces:**
- Consumes: `createSession` (Task 8), `EventStore` (Task 6)
- Produces:
  - `interface SessionRegistry { create(encounterId: string): Promise<Session>; get(sessionId: string): Promise<Session | null> }`
  - `createSessionRegistry(input: { store: EventStore; uuid: () => string; clock: () => string; seed: () => number }): SessionRegistry`
  - `registerHttpRoutes(app: FastifyInstance, registry: SessionRegistry): void`

- [ ] **Step 1: Write the failing test**

`apps/server/src/transport/http.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createInMemoryEventStore } from "../core/event-store.js";
import { createSessionRegistry, registerHttpRoutes } from "./http.js";

function appWith() {
  const store = createInMemoryEventStore();
  let n = 0;
  const registry = createSessionRegistry({
    store,
    uuid: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    clock: () => "2026-08-19T10:00:00.000Z",
    seed: () => 42,
  });
  const app = Fastify();
  registerHttpRoutes(app, registry);
  return { app, registry, store };
}

describe("POST /sessions", () => {
  it("creates a session and returns its id", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "goblin-ambush" },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ sessionId: expect.any(String) as unknown as string });
  });

  it("rejects an unknown encounter with 404", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "nope" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a body with no encounterId with 400", async () => {
    const { app } = appWith();
    const response = await app.inject({ method: "POST", url: "/sessions", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("makes the created session retrievable from the registry", async () => {
    const { app, registry } = appWith();
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "goblin-ambush" },
    });
    const { sessionId } = JSON.parse(response.body) as { sessionId: string };
    expect(await registry.get(sessionId)).not.toBeNull();
  });
});

describe("GET /health", () => {
  it("answers 200", async () => {
    const { app } = appWith();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- http
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

`apps/server/src/transport/http.ts`:

```ts
// HTTP surface: creating a session, and a health check. Creating a game is a
// one-shot request, so it is a POST rather than a websocket message — folding
// it into `join` would make that message mean two different things depending
// on whether the id already existed.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EventStore } from "../core/event-store.js";
import { createSession, loadSession } from "../core/session.js";
import type { Session } from "../core/session.js";

const CreateSessionBody = z.object({ encounterId: z.string().min(1) });

export interface SessionRegistry {
  create(encounterId: string): Promise<Session>;
  get(sessionId: string): Promise<Session | null>;
}

export interface SessionRegistryInput {
  store: EventStore;
  uuid: () => string;
  clock: () => string;
  seed: () => number;
}

/**
 * Live sessions, keyed by id. In-process only, matching the in-memory event
 * store: both go away on restart, and both are replaced together by the
 * persistence spec.
 */
export function createSessionRegistry(input: SessionRegistryInput): SessionRegistry {
  const live = new Map<string, Session>();

  return {
    async create(encounterId) {
      const sessionId = input.uuid();
      const session = await createSession({
        sessionId,
        encounterId,
        rootSeed: input.seed(),
        store: input.store,
        clock: input.clock,
        uuid: input.uuid,
      });
      live.set(sessionId, session);
      return session;
    },

    async get(sessionId) {
      const cached = live.get(sessionId);
      if (cached !== undefined) return cached;

      // Not in memory: fold it back from the log. This is what makes a
      // reconnect after a process restart possible once the store is durable.
      const loaded = await loadSession({ sessionId, store: input.store });
      if (loaded !== null) live.set(sessionId, loaded);
      return loaded;
    },
  };
}

export function registerHttpRoutes(app: FastifyInstance, registry: SessionRegistry): void {
  app.get("/health", () => ({ status: "ok" }));

  app.post("/sessions", async (request, reply) => {
    const body = CreateSessionBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "encounterId is required" });

    try {
      const session = await registry.create(body.data.encounterId);
      return reply.code(201).send({ sessionId: session.state.sessionId });
    } catch (error) {
      // `encounterById` throws for an unknown id. Anything else is a bug, and
      // should not be reported to the client as a 404.
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Unknown encounter")) {
        return reply.code(404).send({ error: message });
      }
      throw error;
    }
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @ai-dm/server test -- http
```

Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/transport/http.ts apps/server/src/transport/http.test.ts
git commit -m "feat(server): add the HTTP session-creation route"
```

---

### Task 14: WebSocket transport and the server entrypoint

**Files:**
- Create: `apps/server/src/transport/ws.ts`
- Create: `apps/server/src/transport/ws.test.ts`
- Create: `apps/server/src/app.ts`
- Modify: `apps/server/src/main.ts`

**Interfaces:**
- Consumes: `handleCommand`, `TurnPorts` (Tasks 9–10); `SessionRegistry`, `registerHttpRoutes` (Task 13); `loadConfig` (Task 12); `ClientMessage`, `ServerFrame` (Task 4)
- Produces:
  - `registerWebSocketRoute(app: FastifyInstance, input: { registry: SessionRegistry; ports: TurnPorts }): void`
  - `buildApp(input: { registry: SessionRegistry; ports: TurnPorts }): FastifyInstance`

- [ ] **Step 1: Write the failing test**

`apps/server/src/transport/ws.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createAgentRuntime, createDeterministicNarrative, createFakePort, createTacticalAgent, DEFAULT_MODEL_ROUTING } from "@ai-dm/agents";
import type { ServerFrame } from "@ai-dm/schemas";
import { buildApp } from "../app.js";
import { createInMemoryEventStore } from "../core/event-store.js";
import type { TurnPorts } from "../core/pipeline.js";
import { createSessionRegistry } from "./http.js";
import type { FastifyInstance } from "fastify";

let running: FastifyInstance | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function startServer() {
  const store = createInMemoryEventStore();
  let n = 0;
  const uuid = (): string => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
  const port = createFakePort({
    structured: Array.from({ length: 40 }, () => ({
      ok: true as const,
      value: {
        value: { actorId: "goblin-a", mainAction: { actionType: "dodge" } },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    })),
  });
  const ports: TurnPorts = {
    store,
    tactical: createTacticalAgent({
      runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    }),
    narrative: createDeterministicNarrative(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid,
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
  };
  const registry = createSessionRegistry({
    store,
    uuid,
    clock: () => "2026-08-19T10:00:00.000Z",
    seed: () => 42,
  });

  const app = buildApp({ registry, ports });
  await app.listen({ port: 0, host: "127.0.0.1" });
  running = app;

  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { app, url: `ws://127.0.0.1:${String(address.port)}/ws`, store };
}

function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once("open", () => { resolve(socket); });
    socket.once("error", reject);
  });
}

/** Collect frames until `stop` says we have what we came for. */
function framesUntil(socket: WebSocket, stop: (frame: ServerFrame) => boolean): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`timed out after ${String(frames.length)} frames`)); }, 5000);
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      frames.push(frame);
      if (stop(frame)) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
    socket.once("error", reject);
  });
}

async function createSessionOver(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: { encounterId: "goblin-ambush" },
  });
  return (JSON.parse(response.body) as { sessionId: string }).sessionId;
}

describe("websocket transport", () => {
  it("answers a join with a session_state snapshot", async () => {
    const { app, url } = await startServer();
    const sessionId = await createSessionOver(app);
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "session_state");
    socket.send(JSON.stringify({ type: "join", sessionId }));
    const frames = await pending;
    expect(frames[0]).toMatchObject({ type: "session_state" });
    socket.close();
  });

  it("errors on an unknown session rather than closing the socket", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send(JSON.stringify({ type: "join", sessionId: "nope" }));
    expect((await pending)[0]).toMatchObject({ code: "unknown_session" });
    socket.close();
  });

  it("errors on a malformed message rather than crashing", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send("not json at all");
    expect((await pending)[0]).toMatchObject({ code: "malformed_message" });
    socket.close();
  });

  it("errors on a message that parses but is not a ClientMessage", async () => {
    const { url } = await startServer();
    const socket = await connect(url);
    const pending = framesUntil(socket, (frame) => frame.type === "error");
    socket.send(JSON.stringify({ type: "shout", text: "hi" }));
    expect((await pending)[0]).toMatchObject({ code: "malformed_message" });
    socket.close();
  });

  it("plays a turn and streams its events and narrative", async () => {
    const { app, url } = await startServer();
    const sessionId = await createSessionOver(app);
    const socket = await connect(url);

    await new Promise<void>((resolve) => {
      socket.once("message", () => { resolve(); });
      socket.send(JSON.stringify({ type: "join", sessionId }));
    });

    const pending = framesUntil(
      socket,
      (frame) => frame.type === "event" && frame.event.type === "scene_changed",
    );
    socket.send(
      JSON.stringify({
        type: "structured_action",
        clientMessageId: "c1",
        actorId: "hero",
        turn: { actorId: "hero", mainAction: { actionType: "dodge" } },
      }),
    );

    const frames = await pending;
    expect(frames.some((each) => each.type === "narrative_token")).toBe(true);
    expect(frames.some((each) => each.type === "event")).toBe(true);
    socket.close();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test -- ws
```

Expected: FAIL — `../app.js` not found.

- [ ] **Step 3: Write the WS route**

`apps/server/src/transport/ws.ts`:

```ts
// The websocket adapter. It parses, validates, routes to the core and pumps
// frames back — nothing else. Every decision about the game is made by
// `handleCommand`, which never sees a socket.
import type { FastifyInstance } from "fastify";
import { ClientMessage } from "@ai-dm/schemas";
import type { ServerFrame } from "@ai-dm/schemas";
import { handleCommand } from "../core/pipeline.js";
import type { TurnPorts } from "../core/pipeline.js";
import type { Session } from "../core/session.js";
import type { SessionRegistry } from "./http.js";

export interface WebSocketRouteInput {
  registry: SessionRegistry;
  ports: TurnPorts;
}

export function registerWebSocketRoute(app: FastifyInstance, input: WebSocketRouteInput): void {
  app.get("/ws", { websocket: true }, (socket) => {
    // One socket, one session (ADR 0002 is solo play), bound by `join`.
    let session: Session | null = null;
    // One command in flight. A queued stale click would land against a changed
    // board and fail validation for reasons the player cannot see.
    let busy = false;

    function send(frame: ServerFrame): void {
      socket.send(JSON.stringify(frame));
    }

    socket.on("message", (raw: Buffer | string) => {
      void (async () => {
        let parsed;
        try {
          parsed = ClientMessage.safeParse(JSON.parse(String(raw)));
        } catch {
          send({ type: "error", code: "malformed_message", message: "Body is not valid JSON." });
          return;
        }
        if (!parsed.success) {
          send({ type: "error", code: "malformed_message", message: parsed.error.message });
          return;
        }
        const command = parsed.data;

        if (command.type === "join") {
          const found = await input.registry.get(command.sessionId);
          if (found === null) {
            send({
              type: "error",
              code: "unknown_session",
              message: `No session ${command.sessionId}. Create one with POST /sessions.`,
            });
            return;
          }
          session = found;
        }

        if (session === null) {
          send({ type: "error", code: "unknown_session", message: "Send a join message first." });
          return;
        }

        if (busy) {
          send({
            type: "error",
            ...(command.type === "join" ? {} : { clientMessageId: command.clientMessageId }),
            code: "turn_in_progress",
            message: "A turn is already resolving.",
          });
          return;
        }

        busy = true;
        try {
          for await (const frame of handleCommand(session, command, input.ports)) send(frame);
        } catch (error) {
          // The log is already consistent — `emit` appends before it yields —
          // so the socket reporting a failure does not leave a torn session.
          send({
            type: "error",
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          busy = false;
        }
      })();
    });
  });
}
```

- [ ] **Step 4: Write the app builder**

`apps/server/src/app.ts`:

```ts
// Wires the transports onto a Fastify instance. Separate from `main.ts` so a
// test can build an app without reading the environment or binding a port.
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { TurnPorts } from "./core/pipeline.js";
import { registerHttpRoutes } from "./transport/http.js";
import type { SessionRegistry } from "./transport/http.js";
import { registerWebSocketRoute } from "./transport/ws.js";

export interface BuildAppInput {
  registry: SessionRegistry;
  ports: TurnPorts;
  logLevel?: string;
}

export function buildApp(input: BuildAppInput): FastifyInstance {
  const app = Fastify({ logger: input.logLevel === undefined ? false : { level: input.logLevel } });
  void app.register(websocket);
  registerHttpRoutes(app, input.registry);
  void app.register(async (scoped) => {
    registerWebSocketRoute(scoped, { registry: input.registry, ports: input.ports });
  });
  return app;
}
```

If `@fastify/websocket` requires the route to be registered after the plugin has finished loading, follow its error — the encapsulated `register` above is the usual fix.

- [ ] **Step 5: Run the WS tests**

```bash
pnpm --filter @ai-dm/server test -- ws
```

Expected: PASS, all five cases.

- [ ] **Step 6: Write the entrypoint**

Replace `apps/server/src/main.ts`:

```ts
// Fastify + WebSocket entrypoint. Reads the environment, wires the real ports,
// listens. Everything interesting is in `core/`, which knows nothing about
// either.
import { randomUUID } from "node:crypto";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createTacticalAgent,
  createTimingPort,
  createVercelPort,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createInMemoryEventStore } from "./core/event-store.js";
import { createSessionRegistry } from "./transport/http.js";

const config = loadConfig(process.env);

const store = createInMemoryEventStore();
const clock = (): string => new Date().toISOString();

// Timing wraps the provider so per-turn latency, tokens and cost are recorded
// from day one rather than guessed later (apps/server/CLAUDE.md).
const timingPort = createTimingPort(createVercelPort({}));

const app = buildApp({
  logLevel: config.logLevel,
  registry: createSessionRegistry({
    store,
    uuid: randomUUID,
    clock,
    seed: () => Math.floor(Math.random() * 2 ** 31),
  }),
  ports: {
    store,
    tactical: createTacticalAgent({
      runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port: timingPort }),
    }),
    narrative: createDeterministicNarrative(),
    clock,
    uuid: randomUUID,
    // Derived, not random: the same root seed and the same commands must
    // replay the same fight. The value is recorded in `dice_rolled` anyway,
    // and replay reads it from there.
    seedFor: (rootSeed, sequence) => (rootSeed + sequence * 2_654_435_761) >>> 0,
    turnTimeoutMs: 10_000,
  },
});

await app.listen({ port: config.port, host: "0.0.0.0" });
```

`Math.random` here is fine and deliberate: it picks a *new* session's root seed, which is the one place a fresh value is wanted. Every roll after that derives from it.

- [ ] **Step 7: Boot it for real**

```bash
pnpm --filter @ai-dm/server dev
```

In another shell:

```bash
curl -s -X POST localhost:3000/sessions -H 'content-type: application/json' -d '{"encounterId":"goblin-ambush"}'
```

Expected: a JSON body with a `sessionId`. Stop the server afterwards.

- [ ] **Step 8: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add apps/server/src/app.ts apps/server/src/main.ts apps/server/src/transport/ws.ts apps/server/src/transport/ws.test.ts
git commit -m "feat(server): add the websocket transport and boot the server"
```

---

### Task 15: End-to-end — a full combat over a socket

The step's exit criterion, asserted once, over the real transport.

**Files:**
- Create: `apps/server/src/e2e.test.ts`

**Interfaces:**
- Consumes: everything. No new production code.

- [ ] **Step 1: Write the end-to-end test**

`apps/server/src/e2e.test.ts`:

```ts
// Step 8's exit criterion: "full combat playable E2E vs scripted enemy",
// asserted over the real socket with a mocked provider. If this passes, a
// human with a client can play the fight.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createFakePort,
  createTacticalAgent,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import type { ServerFrame, SessionState } from "@ai-dm/schemas";
import { buildApp } from "./app.js";
import { createInMemoryEventStore } from "./core/event-store.js";
import { fold } from "./core/reduce.js";
import type { TurnPorts } from "./core/pipeline.js";
import { createSessionRegistry } from "./transport/http.js";

let running: FastifyInstance | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function startServer() {
  const store = createInMemoryEventStore();
  let n = 0;
  const uuid = (): string => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
  // Always attack the hero: the fight has to actually end.
  const port = createFakePort({
    structured: Array.from({ length: 200 }, () => ({
      ok: true as const,
      value: {
        value: {
          actorId: "goblin-a",
          mainAction: { actionType: "attack", targetIds: ["hero"] },
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    })),
  });
  const ports: TurnPorts = {
    store,
    tactical: createTacticalAgent({
      runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    }),
    narrative: createDeterministicNarrative(),
    clock: () => "2026-08-19T10:00:00.000Z",
    uuid,
    seedFor: (rootSeed, sequence) => rootSeed * 1000 + sequence,
    turnTimeoutMs: 10_000,
  };
  const app = buildApp({
    registry: createSessionRegistry({ store, uuid, clock: () => "2026-08-19T10:00:00.000Z", seed: () => 42 }),
    ports,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  running = app;
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { app, store, url: `ws://127.0.0.1:${String(address.port)}/ws` };
}

class Client {
  readonly frames: ServerFrame[] = [];
  private constructor(private readonly socket: WebSocket) {}

  static async connect(url: string): Promise<Client> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => { resolve(); });
      socket.once("error", reject);
    });
    const client = new Client(socket);
    socket.on("message", (data) => {
      client.frames.push(JSON.parse(String(data)) as ServerFrame);
    });
    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Wait until `predicate` holds over everything received so far. */
  async until(predicate: (frames: readonly ServerFrame[]) => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate(this.frames)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.socket.close();
  }
}

function lastSequence(frames: readonly ServerFrame[]): number {
  let sequence = -1;
  for (const frame of frames) if (frame.type === "event") sequence = frame.event.sequence;
  return sequence;
}

describe("end to end", () => {
  it("plays a combat to a conclusion over the socket", async () => {
    const { app, url, store } = await startServer();
    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "goblin-ambush" },
    });
    const { sessionId } = JSON.parse(created.body) as { sessionId: string };

    const client = await Client.connect(url);
    client.send({ type: "join", sessionId });
    await client.until((frames) => frames.some((each) => each.type === "session_state"), "snapshot");

    // Play until somebody stops being alive, or 15 player turns pass.
    for (let turn = 0; turn < 15; turn += 1) {
      const before = client.frames.length;
      client.send({
        type: "structured_action",
        clientMessageId: `turn-${String(turn)}`,
        actorId: "hero",
        turn: { actorId: "hero", mainAction: { actionType: "dodge" } },
      });
      await client.until((frames) => frames.length > before, `turn ${String(turn)} to start`);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const events = await store.readSince(sessionId, -1);
      const damaged = events.some((each) => each.type === "dice_rolled");
      if (damaged && events.length > 20) break;
    }

    const events = await store.readSince(sessionId, -1);
    expect(events.length).toBeGreaterThan(10);
    // Every event the client saw, it saw exactly once and in order.
    const seen = client.frames.filter((each) => each.type === "event").map((each) => each.event.sequence);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    client.close();
  });

  it("resumes an interrupted session at the right sequence", async () => {
    const { app, url, store } = await startServer();
    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { encounterId: "goblin-ambush" },
    });
    const { sessionId } = JSON.parse(created.body) as { sessionId: string };

    const first = await Client.connect(url);
    first.send({ type: "join", sessionId });
    await first.until((frames) => frames.some((each) => each.type === "session_state"), "snapshot");

    const snapshotFrame = first.frames.find((each) => each.type === "session_state");
    if (snapshotFrame?.type !== "session_state") throw new Error("no snapshot");
    const clientState: SessionState = snapshotFrame.snapshot;

    first.send({
      type: "structured_action",
      clientMessageId: "t1",
      actorId: "hero",
      turn: { actorId: "hero", mainAction: { actionType: "dodge" } },
    });
    await first.until((frames) => lastSequence(frames) > 0, "the first turn");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const cut = lastSequence(first.frames);
    first.close();

    // A second client resumes from what the first one had.
    const second = await Client.connect(url);
    second.send({ type: "join", sessionId, resumeFrom: cut });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Nothing was missed: folding the snapshot plus everything either client
    // saw reproduces the server's own projection.
    const all = await store.readSince(sessionId, 0);
    const folded = fold(clientState, all);
    const live = await store.readSince(sessionId, -1);
    expect(live.length).toBeGreaterThan(cut);
    expect(folded.combatants.length).toBe(clientState.combatants.length);
    second.close();
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter @ai-dm/server test -- e2e
```

Expected: PASS. If the fight never produces `dice_rolled`, the goblins cannot reach the hero from their starting tiles — give the scripted proposals a `movement` leg toward the hero, or move the spawns closer in `goblin-ambush`. Do not weaken the assertion to make it pass.

- [ ] **Step 3: Full repo verification**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
```

Expected: everything green, including the untouched sim suite.

- [ ] **Step 4: Update the roadmap**

In `PROJECT_PLAN.md` §4, change step 8's Status cell from `⬜ not started` to `🟡 server done, web pending`, and add a short findings paragraph after the step 7 narrative in the same style — what was promoted out of the sim and why, what the protocol looks like, what is deferred (Postgres, intent agent, web).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/e2e.test.ts PROJECT_PLAN.md
git commit -m "test(server): play a full combat end to end over the socket"
```

---

## Notes for the executor

- **The sim's suite is the regression net for Tasks 1–3.** If it needs a behaviour change to pass, the promotion was done wrong. Import-path changes are expected; assertion changes are not.
- **Types in this plan were read from the codebase on 2026-08-19**, but if a signature here disagrees with the source, the source wins. Read `packages/schemas/src/actions.ts`, `packages/schemas/src/world.ts` and `packages/rules-engine/src/combat/validate-turn.ts` before assuming a literal in a test is right.
- **Do not weaken an assertion to make a test pass.** Several tests here (the replay properties in Task 11, the E2E in Task 15) exist specifically to catch the failure modes this architecture is meant to prevent.
- **`DEFAULT_MODEL_ROUTING.tactical` is a placeholder** and step 7b's benchmark will change it. Nothing in this plan should depend on which model it names.
