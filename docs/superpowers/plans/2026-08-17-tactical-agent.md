# Tactical Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the enemy tactical agent in `@ai-dm/agents` — it proposes an `ExecuteTurn`, the rules engine validates it, one retry carries the machine-readable rejection reason back to the model, and a second failure falls back to a deterministic turn.

**Architecture:** A straight-line two-attempt pipeline (not a counted loop) over the step 6 `LanguageModelPort`. A pure `buildSnapshot` projects `CombatWorld` into a JSON combat state that goes in the `dynamic` prompt tier only; the actor's capability card goes in `semiStatic`; the system prompt in `static`. Every rejection becomes an `ActionRejectedPayload` the agent *returns* — the server stamps it into a `GameEvent`, because this package has no clock and no UUID source.

**Tech Stack:** TypeScript (strict, ESM), zod, Vitest, pnpm workspaces. No new dependencies — `@ai-dm/agents` already depends on `@ai-dm/rules-engine` and `@ai-dm/schemas`.

**Spec:** `docs/superpowers/specs/2026-08-17-tactical-agent-design.md`

## Global Constraints

- **`corepack enable` before any pnpm command.** pnpm is not on PATH.
- **Agents propose, never resolve.** No dice, no damage math, no state mutation in `@ai-dm/agents`. `validateExecuteTurn` is called for legality only.
- **Retry exactly once.** Never a third model call, on any path.
- **No live API calls.** Every test drives `createFakePort`. Benchmarking is step 7b, in `tools/sim`.
- **English inside, Hebrew outside.** Prompts, comments, logs, tool schemas: English only.
- **Never hand-write a JSON schema.** Derive from zod (invariant 4).
- **TS strictness that will bite:** `exactOptionalPropertyTypes` (build optional fields with conditional spread — `...(x === undefined ? {} : { x })`), `noUncheckedIndexedAccess` (index access yields `T | undefined`; use `?.` or `.find`), `verbatimModuleSyntax` (`import type` for type-only imports), `.js` extensions on every relative import.
- **ESLint `strictTypeChecked`:** `[...str]` is banned — use `Array.from(str, fn)`. No `argsIgnorePattern`, so `_`-prefixed unused params still error.
- **Do not touch** `DEFAULT_MODEL_ROUTING.tactical` or `REASONING_BUDGET_TOKENS`. Both are unmeasured placeholders; only step 7b's benchmark may change them.
- **Commit after every task.** Branch is `feat/tactical-agent`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/schemas/src/events.ts` | **Modify** — add `ActionRejectedPayload` |
| `packages/schemas/src/index.test.ts` | **Modify** — its tests |
| `packages/agents/src/tactical/test-fixtures.ts` | **Create** — `combatant()`, `parseGrid()` for agent tests |
| `packages/agents/src/tactical/snapshot.ts` | **Create** — `CombatSnapshot`, `buildSnapshot`, `buildCapabilityCard` |
| `packages/agents/src/tactical/prompt-text.ts` | **Create** — the English prompt strings, tool name/description |
| `packages/agents/src/tactical/prompt.ts` | **Create** — `buildTacticalPrompt` → `LayeredPrompt` |
| `packages/agents/src/tactical/fallback.ts` | **Create** — `deterministicFallback` |
| `packages/agents/src/tactical/action-rejected.ts` | **Create** — payload constructors |
| `packages/agents/src/tactical/index.ts` | **Modify** (stub today) — `createTacticalAgent`, the pipeline, re-exports |
| `docs/prompts/README.md` | **Modify** — pointer to `prompt-text.ts` |
| `PROJECT_PLAN.md` | **Modify** — step 7 row and status section |

---

### Task 1: `ActionRejectedPayload` schema

**Files:**
- Modify: `packages/schemas/src/events.ts`
- Test: `packages/schemas/src/index.test.ts`

**Interfaces:**
- Consumes: `ExecuteTurn` from `./actions.js` (same package; `actions.ts` does not import `events.ts`, so no cycle).
- Produces: `ActionRejectedPayload` — both a zod schema and, via `z.infer`, a type. Tasks 5, 6, 7, 8 import it from `@ai-dm/schemas`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/schemas/src/index.test.ts`. Add `ActionRejectedPayload` to the existing import on line 4.

```ts
describe("ActionRejectedPayload", () => {
  it("parses an engine rejection with its machine-readable reasons", () => {
    const payload = ActionRejectedPayload.parse({
      actorId: "gob-1",
      attempt: 1,
      stage: "engine",
      reasons: ["target_out_of_reach"],
      messages: ["pc-1 is 30 ft away, beyond the 5 ft reach of this action"],
      provider: "google",
      modelId: "gemini-3-flash",
    });

    expect(payload.reasons).toStrictEqual(["target_out_of_reach"]);
    expect(payload.stage).toBe("engine");
  });

  it("parses an adapter rejection, which has a code instead of reasons", () => {
    const payload = ActionRejectedPayload.parse({
      actorId: "gob-1",
      attempt: 2,
      stage: "adapter",
      adapterErrorCode: "no_tool_call",
      messages: ["The model answered in prose."],
      provider: "google",
      modelId: "gemini-3-flash",
    });

    expect(payload.adapterErrorCode).toBe("no_tool_call");
    expect(payload.reasons).toBeUndefined();
  });

  it("rejects a third attempt, because the loop only ever makes two", () => {
    const result = ActionRejectedPayload.safeParse({
      actorId: "gob-1",
      attempt: 3,
      stage: "engine",
      messages: [],
      provider: "google",
      modelId: "gemini-3-flash",
    });

    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["attempt"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `ActionRejectedPayload is not exported by ./index.js` (a TypeScript/resolution error, not an assertion failure).

- [ ] **Step 3: Add the schema**

Append to `packages/schemas/src/events.ts`, and add `import { ExecuteTurn } from "./actions.js";` below the existing `import { z } from "zod";`.

```ts
/**
 * Payload convention for the `action_rejected` event. The tactical agent
 * produces these and the server stamps them into a `GameEvent` — the agent has
 * no clock and no UUID source, so it never builds the envelope itself.
 *
 * The code fields are `z.string()` rather than closed enums on purpose. This
 * payload is persisted forever, so a closed enum here becomes a migration the
 * first time a provider or a rejection reason is added. `reasons` additionally
 * cannot be narrowed to `TurnRejectionReason` without inverting the dependency
 * direction — that type lives downstream, in the rules engine.
 */
export const ActionRejectedPayload = z.object({
  actorId: z.string(),
  /** Which of the two model attempts produced this. There is never a third. */
  attempt: z.number().int().min(1).max(2),
  stage: z.enum(["adapter", "engine"]),
  /** An `AdapterErrorCode`. Present when `stage` is "adapter". */
  adapterErrorCode: z.string().optional(),
  /** `TurnRejectionReason` codes. Present when `stage` is "engine". */
  reasons: z.array(z.string()).optional(),
  /** English. Safe to persist in the log; never shown to a player. */
  messages: z.array(z.string()),
  /** The proposal that was rejected, when the model produced one at all. */
  proposedTurn: ExecuteTurn.optional(),
  /** Both stamped so step 7b can group a log of rejections by model. */
  provider: z.string(),
  modelId: z.string(),
});

export type ActionRejectedPayload = z.infer<typeof ActionRejectedPayload>;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS, 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/events.ts packages/schemas/src/index.test.ts && git commit -m "feat(schemas): action_rejected payload convention"
```

---

### Task 2: Combat snapshot

**Files:**
- Create: `packages/agents/src/tactical/test-fixtures.ts`
- Create: `packages/agents/src/tactical/snapshot.ts`
- Test: `packages/agents/src/tactical/snapshot.test.ts`

**Interfaces:**
- Consumes: `CombatWorld` and `footprintDistanceFeet` from `@ai-dm/rules-engine`; `Combatant`, `GridMap` and friends from `@ai-dm/schemas`.
- Produces:
  - `buildSnapshot(input: SnapshotInput): CombatSnapshot`
  - `buildCapabilityCard(actor: Combatant, actions: readonly SnapshotAction[]): CapabilityCard`
  - Types `SnapshotAction { actionId, name, rangeFeet }`, `SnapshotCombatant`, `SnapshotActor`, `CombatSnapshot`, `CapabilityCard`, `SnapshotInput { world, actorId, turnOrder? }`.
  - `combatant()` and `parseGrid()` test helpers.

`test-fixtures.ts` duplicates ~30 lines from `packages/rules-engine/src/combat/test-fixtures.ts`. That file is deliberately absent from the rules engine's `index.ts` ("Not part of the package API"), so it is unreachable across the package boundary. Duplicating test scaffolding is the lesser evil against widening a public API to serve tests.

- [ ] **Step 1: Write the test fixtures**

Create `packages/agents/src/tactical/test-fixtures.ts`:

```ts
// Test scaffolding for the tactical agent's specs. Deliberately absent from
// ./index.ts — the rules engine keeps its equivalent private for the same
// reason, which is also why this is a copy rather than an import.
import type { Combatant, GridMap, TerrainType } from "@ai-dm/schemas";

const BASE: Combatant = {
  combatantId: "unnamed",
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
};

export function combatant(overrides: Partial<Combatant> & { combatantId: string }): Combatant {
  return { ...BASE, ...overrides };
}

/** `.` normal · `~` difficult · `#` blocking · `h` half cover · `q` three-quarters */
const LEGEND: Record<string, TerrainType | undefined> = {
  ".": "normal",
  "~": "difficult",
  "#": "blocking",
  h: "half_cover",
  q: "three_quarters_cover",
};

export function parseGrid(art: string): GridMap {
  const rows = art
    .trim()
    .split("\n")
    .map((row) => row.trim());

  const tiles = rows.map((row) =>
    Array.from(row, (char) => {
      const terrain = LEGEND[char];
      if (terrain === undefined) throw new Error(`Unknown terrain char: ${char}`);
      return terrain;
    }),
  );

  return { width: tiles[0]?.length ?? 0, height: tiles.length, tiles };
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/agents/src/tactical/snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCapabilityCard, buildSnapshot } from "./snapshot.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const grid = parseGrid(`
  .....
  ..~..
  ....#
`);

const goblin = combatant({ combatantId: "gob-1", faction: "hostile", position: [0, 0] });
const hero = combatant({ combatantId: "pc-1", faction: "party", position: [4, 0], currentHp: 9 });

function world(...combatants: ReturnType<typeof combatant>[]) {
  return { grid, combatants };
}

describe("buildSnapshot", () => {
  it("precomputes the distance from the actor to every other combatant", () => {
    const snapshot = buildSnapshot({ world: world(goblin, hero), actorId: "gob-1" });

    // 4 tiles apart on a 5 ft grid.
    expect(snapshot.others[0]?.combatantId).toBe("pc-1");
    expect(snapshot.others[0]?.distanceFeet).toBe(20);
  });

  it("leaves the actor out of its own others list", () => {
    const snapshot = buildSnapshot({ world: world(goblin, hero), actorId: "gob-1" });

    expect(snapshot.actor.combatantId).toBe("gob-1");
    expect(snapshot.others.map((other) => other.combatantId)).toStrictEqual(["pc-1"]);
  });

  it("omits combatants who are dead or have fled, since neither can be targeted", () => {
    const corpse = combatant({ combatantId: "gob-2", position: [1, 0], status: "dead" });
    const runaway = combatant({ combatantId: "gob-3", position: [2, 0], status: "fled" });
    const downed = combatant({ combatantId: "pc-2", position: [3, 0], status: "unconscious" });

    const snapshot = buildSnapshot({
      world: world(goblin, hero, corpse, runaway, downed),
      actorId: "gob-1",
    });

    expect(snapshot.others.map((other) => other.combatantId)).toStrictEqual(["pc-1", "pc-2"]);
  });

  it("emits only the non-normal terrain, not the whole matrix", () => {
    const snapshot = buildSnapshot({ world: world(goblin), actorId: "gob-1" });

    expect(snapshot.grid.width).toBe(5);
    expect(snapshot.grid.height).toBe(3);
    expect(snapshot.grid.terrain).toStrictEqual([
      { tile: [2, 1], terrain: "difficult" },
      { tile: [4, 2], terrain: "blocking" },
    ]);
  });

  it("carries the actor's action economy, which is what limits the turn", () => {
    const spent = combatant({
      combatantId: "gob-1",
      actionEconomy: {
        actionUsed: true,
        bonusActionUsed: false,
        reactionUsed: false,
        movementUsedFeet: 15,
        attacksMade: 1,
      },
    });

    const snapshot = buildSnapshot({ world: world(spent), actorId: "gob-1" });

    expect(snapshot.actor.actionEconomy.actionUsed).toBe(true);
    expect(snapshot.actor.actionEconomy.movementUsedFeet).toBe(15);
  });

  it("omits turnOrder entirely when the caller has none", () => {
    const snapshot = buildSnapshot({ world: world(goblin), actorId: "gob-1" });

    expect("turnOrder" in snapshot).toBe(false);
  });

  it("passes turnOrder through when the caller supplies one", () => {
    const snapshot = buildSnapshot({
      world: world(goblin, hero),
      actorId: "gob-1",
      turnOrder: ["pc-1", "gob-1"],
    });

    expect(snapshot.turnOrder).toStrictEqual(["pc-1", "gob-1"]);
  });

  it("throws when asked for a combatant that is not in the encounter", () => {
    expect(() => buildSnapshot({ world: world(goblin), actorId: "nobody" })).toThrow(
      /No combatant nobody/,
    );
  });
});

describe("buildCapabilityCard", () => {
  it("carries the actor's reach, speed and attack count with its actions", () => {
    const card = buildCapabilityCard(goblin, [
      { actionId: "scimitar", name: "Scimitar", rangeFeet: 5 },
      { actionId: "shortbow", name: "Shortbow", rangeFeet: 80 },
    ]);

    expect(card.combatantId).toBe("gob-1");
    expect(card.speedFeet).toBe(30);
    expect(card.reachFeet).toBe(5);
    expect(card.attacksPerAction).toBe(1);
    expect(card.actions.map((action) => action.actionId)).toStrictEqual(["scimitar", "shortbow"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm --filter @ai-dm/agents test snapshot
```

Expected: FAIL — cannot resolve `./snapshot.js`.

- [ ] **Step 4: Implement the snapshot**

Create `packages/agents/src/tactical/snapshot.ts`:

```ts
// A compact structured projection of the combat state, for the dynamic prompt
// tier. Not dialogue history (`packages/agents/CLAUDE.md`) — a model reasons
// about a board better from the board than from a transcript of it.
import type { CombatWorld } from "@ai-dm/rules-engine";
import { footprintDistanceFeet } from "@ai-dm/rules-engine";
import type {
  ActionEconomy,
  ActiveCondition,
  Combatant,
  CreatureSize,
  EntityStatus,
  Faction,
  GridMap,
  SpellSlots,
  TerrainType,
  Tile,
} from "@ai-dm/schemas";

/** An action the actor may take, with the range the validator will enforce. */
export interface SnapshotAction {
  actionId: string;
  name: string;
  rangeFeet: number;
}

export interface SnapshotCombatant {
  combatantId: string;
  faction: Faction;
  position: Tile;
  size: CreatureSize;
  currentHp: number;
  maxHp: number;
  armorClass: number;
  /** Reused from `@ai-dm/schemas` rather than flattened to names: a duration is
   *  tactically relevant, and a parallel shape would violate invariant 4. */
  conditions: readonly ActiveCondition[];
  exhaustionLevel: number;
  /**
   * Actor-to-target, computed with the same function the validator uses.
   * Absent on the actor itself. This is the single most valuable field here:
   * out-of-reach proposals are the commonest legality failure a model makes,
   * and they come from asking it to do Chebyshev arithmetic on coordinates.
   */
  distanceFeet?: number;
}

export interface SnapshotActor extends SnapshotCombatant {
  spellSlots: SpellSlots;
  actionEconomy: ActionEconomy;
}

export interface SnapshotTerrain {
  tile: Tile;
  terrain: TerrainType;
}

export interface CombatSnapshot {
  actor: SnapshotActor;
  others: readonly SnapshotCombatant[];
  grid: { width: number; height: number; terrain: readonly SnapshotTerrain[] };
  /** Supplied by the caller; `Combatant` models no rolled initiative. */
  turnOrder?: readonly string[];
}

export interface SnapshotInput {
  world: CombatWorld;
  actorId: string;
  turnOrder?: readonly string[];
}

/** What varies per creature rather than per turn — the semi-static tier. */
export interface CapabilityCard {
  combatantId: string;
  speedFeet: number;
  reachFeet: number;
  attacksPerAction: number;
  actions: readonly SnapshotAction[];
}

/** A corpse is scenery and a fled creature has left the map; neither is a target. */
const VISIBLE_STATUSES: readonly EntityStatus[] = ["alive", "unconscious"];

function baseOf(source: Combatant): SnapshotCombatant {
  return {
    combatantId: source.combatantId,
    faction: source.faction,
    position: source.position,
    size: source.size,
    currentHp: source.currentHp,
    maxHp: source.maxHp,
    armorClass: source.armorClass,
    conditions: source.conditions,
    exhaustionLevel: source.exhaustionLevel,
  };
}

/**
 * `GridMap.tiles` is a full row-major matrix — a 20x20 map is 400 strings,
 * nearly all "normal". Emitting only the exceptions is lossless, because
 * "normal" is recoverable as the default.
 */
function sparseTerrain(grid: GridMap): SnapshotTerrain[] {
  const terrain: SnapshotTerrain[] = [];
  grid.tiles.forEach((row, y) => {
    row.forEach((type, x) => {
      if (type !== "normal") terrain.push({ tile: [x, y], terrain: type });
    });
  });
  return terrain;
}

export function buildSnapshot(input: SnapshotInput): CombatSnapshot {
  const { world, actorId } = input;
  const actor = world.combatants.find((each) => each.combatantId === actorId);
  // A caller that names an absent actor has a bug, not a runtime condition.
  if (actor === undefined) throw new Error(`No combatant ${actorId} in this encounter`);

  const actorSpace = { anchor: actor.position, size: actor.size };

  const others = world.combatants
    .filter((each) => each.combatantId !== actorId && VISIBLE_STATUSES.includes(each.status))
    .map((each) => ({
      ...baseOf(each),
      distanceFeet: footprintDistanceFeet(actorSpace, {
        anchor: each.position,
        size: each.size,
      }),
    }));

  return {
    actor: { ...baseOf(actor), spellSlots: actor.spellSlots, actionEconomy: actor.actionEconomy },
    others,
    grid: {
      width: world.grid.width,
      height: world.grid.height,
      terrain: sparseTerrain(world.grid),
    },
    // exactOptionalPropertyTypes: an absent key and an explicit undefined are
    // different types, and the test asserts absence.
    ...(input.turnOrder === undefined ? {} : { turnOrder: input.turnOrder }),
  };
}

export function buildCapabilityCard(
  actor: Combatant,
  actions: readonly SnapshotAction[],
): CapabilityCard {
  return {
    combatantId: actor.combatantId,
    speedFeet: actor.speedFeet,
    reachFeet: actor.reachFeet,
    attacksPerAction: actor.attacksPerAction,
    actions,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/agents test snapshot
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/tactical/snapshot.ts packages/agents/src/tactical/snapshot.test.ts packages/agents/src/tactical/test-fixtures.ts && git commit -m "feat(agents): compact combat snapshot for the tactical prompt"
```

---

### Task 3: Prompt assembly

**Files:**
- Create: `packages/agents/src/tactical/prompt-text.ts`
- Create: `packages/agents/src/tactical/prompt.ts`
- Test: `packages/agents/src/tactical/prompt.test.ts`

**Interfaces:**
- Consumes: `LayeredPrompt` from `../providers/prompt.js`; `CapabilityCard`, `CombatSnapshot` from `./snapshot.js`; `ExecuteTurn` from `@ai-dm/schemas`.
- Produces:
  - `buildTacticalPrompt(input: TacticalPromptInput): LayeredPrompt`
  - `RetryFeedback { codes: readonly string[]; messages: readonly string[]; proposedTurn?: ExecuteTurn }`
  - `TacticalPromptInput { snapshot, card, feedback? }`
  - `TACTICAL_SYSTEM_PROMPT`, `RETRY_PREAMBLE`, `TACTICAL_TOOL_NAME`, `TACTICAL_TOOL_DESCRIPTION`

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/tactical/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTacticalPrompt } from "./prompt.js";
import { buildCapabilityCard, buildSnapshot } from "./snapshot.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const world = {
  grid: parseGrid(`
    .....
    .....
  `),
  combatants: [
    combatant({ combatantId: "gob-1", faction: "hostile", position: [0, 0] }),
    combatant({ combatantId: "pc-1", faction: "party", position: [4, 0] }),
  ],
};

const snapshot = buildSnapshot({ world, actorId: "gob-1" });
const card = buildCapabilityCard(world.combatants[0] ?? combatant({ combatantId: "gob-1" }), [
  { actionId: "scimitar", name: "Scimitar", rangeFeet: 5 },
]);

const feedback = {
  codes: ["target_out_of_reach"],
  messages: ["pc-1 is 20 ft away, beyond the 5 ft reach of this action"],
};

function joined(tier: readonly string[] | undefined): string {
  return (tier ?? []).join("\n");
}

describe("buildTacticalPrompt", () => {
  it("puts the combat state in the dynamic tier", () => {
    const prompt = buildTacticalPrompt({ snapshot, card });

    expect(joined(prompt.dynamic)).toContain("pc-1");
  });

  it("keeps the combat state out of the cached tiers", () => {
    const prompt = buildTacticalPrompt({ snapshot, card });

    // One line of turn state in the cached prefix invalidates the cache on
    // every call, and the symptom is a bill rather than a failure.
    expect(joined(prompt.static)).not.toContain("pc-1");
    expect(joined(prompt.semiStatic)).not.toContain("pc-1");
  });

  it("puts the actor's capabilities in the semi-static tier", () => {
    const prompt = buildTacticalPrompt({ snapshot, card });

    expect(joined(prompt.semiStatic)).toContain("scimitar");
  });

  it("leaves the cached tiers byte-identical when a retry adds feedback", () => {
    const first = buildTacticalPrompt({ snapshot, card });
    const retry = buildTacticalPrompt({ snapshot, card, feedback });

    expect(retry.static).toStrictEqual(first.static);
    expect(retry.semiStatic).toStrictEqual(first.semiStatic);
  });

  it("carries the machine-readable rejection code into the retry", () => {
    const retry = buildTacticalPrompt({ snapshot, card, feedback });

    expect(joined(retry.dynamic)).toContain("target_out_of_reach");
    expect(joined(retry.dynamic)).toContain("beyond the 5 ft reach");
  });

  it("adds no feedback section when there is no feedback", () => {
    const prompt = buildTacticalPrompt({ snapshot, card });

    expect(joined(prompt.dynamic)).not.toContain("rejected");
  });

  it("shows the model the proposal that was rejected, when there was one", () => {
    const retry = buildTacticalPrompt({
      snapshot,
      card,
      feedback: {
        ...feedback,
        proposedTurn: {
          actorId: "gob-1",
          mainAction: { actionType: "attack", targetIds: ["pc-1"] },
          tacticalRationaleEnglish: "Swing at the hero.",
        },
      },
    });

    expect(joined(retry.dynamic)).toContain("Swing at the hero.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @ai-dm/agents test prompt
```

Expected: FAIL — cannot resolve `./prompt.js`. (`providers/prompt.test.ts` will also match this filter and should stay passing.)

- [ ] **Step 3: Write the prompt text**

Create `packages/agents/src/tactical/prompt-text.ts`:

```ts
// The versioned source of record for the tactical agent's prompts.
//
// `docs/prompts/README.md` says prompts live in `docs/prompts/`. Taken
// literally that means runtime `fs` reads — I/O in a package that must stay
// pure, and broken bundling for the server — or codegen to inline markdown into
// ESM. Both are machinery bought for one string. This module IS the versioned
// copy instead, and the README points here, so there is no twin to drift from.
//
// English only (invariant 2). Hebrew exists solely in narrative output.

export const TACTICAL_TOOL_NAME = "execute_turn";

export const TACTICAL_TOOL_DESCRIPTION =
  "Propose one creature's complete turn. The rules engine validates this proposal " +
  "and may reject it; it is a proposal, not a resolution.";

export const TACTICAL_SYSTEM_PROMPT = `You control a single creature during one turn of a Dungeons & Dragons 5th edition (2024 rules) combat encounter.

Call the ${TACTICAL_TOOL_NAME} tool. Never answer in prose.

How this works:
- You PROPOSE a turn. A deterministic rules engine decides whether it is legal.
- You do not roll dice, deal damage, or decide outcomes. Propose only.
- If your proposal is rejected you will be told exactly why, in machine-readable
  codes, and given one chance to correct it.

Reading the combat state:
- Positions are [x, y] tiles. One tile is 5 feet.
- Every other combatant carries a precomputed distanceFeet from you. Use it
  rather than computing distance from coordinates yourself.
- Your capabilities list every action available to you and its range in feet.
  An action whose rangeFeet is less than a target's distanceFeet cannot reach
  that target this turn unless you move first.
- Terrain lists only non-normal tiles. Anything unlisted is normal ground.
- actionEconomy is what you have already spent this turn. An action already
  used cannot be used again.

Write tacticalRationaleEnglish in English, in one short sentence.`;

export const RETRY_PREAMBLE =
  "Your previous proposal was rejected by the rules engine. " +
  "Correct the specific problems below and propose a legal turn.";
```

- [ ] **Step 4: Implement prompt assembly**

Create `packages/agents/src/tactical/prompt.ts`:

```ts
// Assembles the tactical prompt into the three cache tiers. The whole point of
// the tiering is that a retry may only ever add to `dynamic` — anything added
// to a cached tier destroys the prefix match for every later call.
import type { ExecuteTurn } from "@ai-dm/schemas";
import type { LayeredPrompt } from "../providers/prompt.js";
import { RETRY_PREAMBLE, TACTICAL_SYSTEM_PROMPT } from "./prompt-text.js";
import type { CapabilityCard, CombatSnapshot } from "./snapshot.js";

/** Why the previous attempt failed. Rendered into the dynamic tier on a retry. */
export interface RetryFeedback {
  /** Stable codes — a `TurnRejectionReason` or an `AdapterErrorCode`. */
  codes: readonly string[];
  messages: readonly string[];
  /** The rejected proposal, when the model produced one at all. */
  proposedTurn?: ExecuteTurn;
}

export interface TacticalPromptInput {
  snapshot: CombatSnapshot;
  card: CapabilityCard;
  feedback?: RetryFeedback;
}

function renderFeedback(feedback: RetryFeedback): string {
  const lines = [
    RETRY_PREAMBLE,
    `Rejection codes: ${feedback.codes.join(", ")}`,
    ...feedback.messages.map((message) => `- ${message}`),
  ];

  if (feedback.proposedTurn !== undefined) {
    lines.push(`The proposal you sent was: ${JSON.stringify(feedback.proposedTurn)}`);
  }

  return lines.join("\n");
}

export function buildTacticalPrompt(input: TacticalPromptInput): LayeredPrompt {
  const dynamic = [`COMBAT STATE\n${JSON.stringify(input.snapshot)}`];
  if (input.feedback !== undefined) dynamic.push(renderFeedback(input.feedback));

  return {
    static: [TACTICAL_SYSTEM_PROMPT],
    semiStatic: [`YOUR CAPABILITIES\n${JSON.stringify(input.card)}`],
    dynamic,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/agents test prompt
```

Expected: PASS — 7 new tests, plus the existing `providers/prompt.test.ts` still green.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/tactical/prompt.ts packages/agents/src/tactical/prompt-text.ts packages/agents/src/tactical/prompt.test.ts && git commit -m "feat(agents): tactical prompt tiers with retry feedback in dynamic only"
```

---

### Task 4: Deterministic fallback

**Files:**
- Create: `packages/agents/src/tactical/fallback.ts`
- Test: `packages/agents/src/tactical/fallback.test.ts`

**Interfaces:**
- Consumes: `validateExecuteTurn`, `footprintDistanceFeet`, `CombatWorld`, `TurnPlan` from `@ai-dm/rules-engine`; `SnapshotAction` from `./snapshot.js`.
- Produces: `deterministicFallback(actor: Combatant, world: CombatWorld, options?: FallbackOptions): FallbackTurn | null`, where `FallbackTurn { turn: ExecuteTurn; plan: TurnPlan }` and `FallbackOptions { availableActions?: readonly SnapshotAction[] }`.

Returning the validated `plan` alongside the turn — rather than the turn alone — is deliberate. If the caller had to re-validate, its "what if the fallback is invalid" branch would be provably unreachable, which is exactly the untestable dead code step 6 removed.

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/tactical/fallback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deterministicFallback } from "./fallback.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const grid = parseGrid(`
  ......
  ......
  ......
`);

const goblin = combatant({ combatantId: "gob-1", faction: "hostile", position: [0, 0] });

function world(...combatants: ReturnType<typeof combatant>[]) {
  return { grid, combatants };
}

describe("deterministicFallback", () => {
  it("attacks an adjacent enemy", () => {
    const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });

    const fallback = deterministicFallback(goblin, world(goblin, hero));

    expect(fallback?.turn.mainAction.actionType).toBe("attack");
    expect(fallback?.turn.mainAction.targetIds).toStrictEqual(["pc-1"]);
  });

  it("returns the validated plan, so the caller never re-validates", () => {
    const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });

    const fallback = deterministicFallback(goblin, world(goblin, hero));

    expect(fallback?.plan.economyAfter.actionUsed).toBe(true);
  });

  it("attacks the nearest enemy when several are in reach", () => {
    const near = combatant({ combatantId: "pc-near", faction: "party", position: [1, 0] });
    const far = combatant({ combatantId: "pc-far", faction: "party", position: [4, 0] });
    const reacher = combatant({ ...goblin, reachFeet: 30 });

    const fallback = deterministicFallback(reacher, world(reacher, near, far));

    expect(fallback?.turn.mainAction.targetIds).toStrictEqual(["pc-near"]);
  });

  it("breaks a distance tie by id, so the same board always yields the same turn", () => {
    const bravo = combatant({ combatantId: "pc-bravo", faction: "party", position: [1, 0] });
    const alpha = combatant({ combatantId: "pc-alpha", faction: "party", position: [0, 1] });

    // bravo is listed first; alpha must still win on the id tiebreak.
    const fallback = deterministicFallback(goblin, world(goblin, bravo, alpha));

    expect(fallback?.turn.mainAction.targetIds).toStrictEqual(["pc-alpha"]);
  });

  it("dodges when no enemy is in reach", () => {
    const far = combatant({ combatantId: "pc-1", faction: "party", position: [5, 2] });

    const fallback = deterministicFallback(goblin, world(goblin, far));

    expect(fallback?.turn.mainAction.actionType).toBe("dodge");
  });

  it("dodges when there is no enemy at all", () => {
    const ally = combatant({ combatantId: "gob-2", faction: "hostile", position: [1, 0] });

    const fallback = deterministicFallback(goblin, world(goblin, ally));

    expect(fallback?.turn.mainAction.actionType).toBe("dodge");
  });

  it("ignores a downed enemy in favour of one still standing", () => {
    const downed = combatant({
      combatantId: "pc-down",
      faction: "party",
      position: [1, 0],
      status: "unconscious",
    });
    const upright = combatant({ combatantId: "pc-up", faction: "party", position: [0, 1] });

    const fallback = deterministicFallback(goblin, world(goblin, downed, upright));

    expect(fallback?.turn.mainAction.targetIds).toStrictEqual(["pc-up"]);
  });

  it("uses a ranged action when the caller supplies one", () => {
    const far = combatant({ combatantId: "pc-1", faction: "party", position: [5, 0] });
    const bowWorld = {
      ...world(goblin, far),
      actionRangesFeet: { shortbow: 80 },
    };

    const fallback = deterministicFallback(goblin, bowWorld, {
      availableActions: [{ actionId: "shortbow", name: "Shortbow", rangeFeet: 80 }],
    });

    expect(fallback?.turn.mainAction.actionType).toBe("attack");
    expect(fallback?.turn.mainAction.actionId).toBe("shortbow");
  });

  it("gives up when even dodging is illegal", () => {
    // Incapacitated: no action, no bonus action, no reaction.
    const stunned = combatant({
      combatantId: "gob-1",
      conditions: [{ condition: "stunned", durationRounds: 1 }],
    });
    const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });

    expect(deterministicFallback(stunned, world(stunned, hero))).toBeNull();
  });

  it("gives up when the actor has already spent its action", () => {
    const spent = combatant({
      combatantId: "gob-1",
      actionEconomy: {
        actionUsed: true,
        bonusActionUsed: false,
        reactionUsed: false,
        movementUsedFeet: 0,
        attacksMade: 0,
      },
    });
    const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });

    expect(deterministicFallback(spent, world(spent, hero))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @ai-dm/agents test fallback
```

Expected: FAIL — cannot resolve `./fallback.js`.

- [ ] **Step 3: Implement the fallback**

Create `packages/agents/src/tactical/fallback.ts`:

```ts
// What the enemy does when the model has failed twice. Deliberately dumb: it
// does not move. A fallback that pathfinds would be re-implementing the
// tactical judgement the model was supposed to supply, in the one code path
// that has to be trivially correct.
import type { CombatWorld, TurnPlan } from "@ai-dm/rules-engine";
import { footprintDistanceFeet, validateExecuteTurn } from "@ai-dm/rules-engine";
import type { Combatant, ExecuteTurn, Faction } from "@ai-dm/schemas";
import type { SnapshotAction } from "./snapshot.js";

export interface FallbackOptions {
  availableActions?: readonly SnapshotAction[];
}

/** The turn and the plan it validated to, so the caller never validates twice. */
export interface FallbackTurn {
  turn: ExecuteTurn;
  plan: TurnPlan;
}

const ATTACK_RATIONALE = "Fallback: attacking the nearest legal target.";
const DODGE_RATIONALE = "Fallback: nothing is in reach, so taking the Dodge action.";

/**
 * Who this actor will attack. Policy, not rules — 5e permits attacking an ally,
 * so the engine has no opinion here, and policy is what an agent is for.
 */
function opposes(actor: Faction, other: Faction): boolean {
  if (actor === "party") return other === "hostile";
  if (actor === "hostile") return other === "party";
  return false;
}

function attackTurn(actorId: string, targetId: string, actionId: string | undefined): ExecuteTurn {
  return {
    actorId,
    mainAction: {
      actionType: "attack",
      ...(actionId === undefined ? {} : { actionId }),
      targetIds: [targetId],
    },
    tacticalRationaleEnglish: ATTACK_RATIONALE,
  };
}

function dodgeTurn(actorId: string): ExecuteTurn {
  return {
    actorId,
    mainAction: { actionType: "dodge" },
    tacticalRationaleEnglish: DODGE_RATIONALE,
  };
}

export function deterministicFallback(
  actor: Combatant,
  world: CombatWorld,
  options: FallbackOptions = {},
): FallbackTurn | null {
  const actorSpace = { anchor: actor.position, size: actor.size };

  // A downed enemy is not worth the action while one is still upright.
  const targets = world.combatants
    .filter((each) => each.status === "alive" && opposes(actor.faction, each.faction))
    .map((each) => ({
      combatantId: each.combatantId,
      distanceFeet: footprintDistanceFeet(actorSpace, { anchor: each.position, size: each.size }),
    }))
    .sort((left, right) => {
      // The id tiebreak is what makes this replayable: the same board must
      // always produce the same fallback, whatever order the array arrived in.
      if (left.distanceFeet !== right.distanceFeet) return left.distanceFeet - right.distanceFeet;
      return left.combatantId.localeCompare(right.combatantId);
    });

  // With no action list, an attack with no actionId resolves to the actor's
  // melee reach in the validator — the right default when the caller has no
  // stat block data to hand.
  const actionIds: readonly (string | undefined)[] =
    options.availableActions === undefined || options.availableActions.length === 0
      ? [undefined]
      : options.availableActions.map((action) => action.actionId);

  for (const target of targets) {
    for (const actionId of actionIds) {
      const turn = attackTurn(actor.combatantId, target.combatantId, actionId);
      const validation = validateExecuteTurn(turn, actor, world);
      if (validation.valid) return { turn, plan: validation.plan };
    }
  }

  const dodge = dodgeTurn(actor.combatantId);
  const validation = validateExecuteTurn(dodge, actor, world);
  return validation.valid ? { turn: dodge, plan: validation.plan } : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/agents test fallback
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation check the tiebreak**

Temporarily reverse the id comparison in the sort — change `left.combatantId.localeCompare(right.combatantId)` to `right.combatantId.localeCompare(left.combatantId)` — and re-run.

Expected: the test `"breaks a distance tie by id..."` FAILS. If it still passes, the test is not pinning the ordering and must be strengthened before moving on. Restore the line afterwards and re-run to confirm green.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/tactical/fallback.ts packages/agents/src/tactical/fallback.test.ts && git commit -m "feat(agents): deterministic in-place fallback turn"
```

---

### Task 5: Rejection payload constructors

**Files:**
- Create: `packages/agents/src/tactical/action-rejected.ts`
- Test: `packages/agents/src/tactical/action-rejected.test.ts`

**Interfaces:**
- Consumes: `ActionRejectedPayload`, `ExecuteTurn` from `@ai-dm/schemas`; `TurnRejection` from `@ai-dm/rules-engine`; `AdapterError` from `../providers/errors.js`; `ModelSpec` from `../providers/routing.js`.
- Produces:
  - `type AttemptNumber = 1 | 2`
  - `engineRejection(actorId, attempt, rejections, proposedTurn, spec): ActionRejectedPayload`
  - `adapterRejection(actorId, attempt, error, spec): ActionRejectedPayload`

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/tactical/action-rejected.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ActionRejectedPayload } from "@ai-dm/schemas";
import { adapterRejection, engineRejection } from "./action-rejected.js";

const spec = { provider: "google" as const, modelId: "gemini-3-flash" };

const proposedTurn = {
  actorId: "gob-1",
  mainAction: { actionType: "attack" as const, targetIds: ["pc-1"] },
  tacticalRationaleEnglish: "Swing at the hero.",
};

describe("engineRejection", () => {
  it("carries every rejection reason, so one retry sees all the problems", () => {
    const payload = engineRejection(
      "gob-1",
      1,
      [
        { reason: "target_out_of_reach", message: "pc-1 is 20 ft away", subjectId: "pc-1" },
        { reason: "action_already_used", message: "already acted" },
      ],
      proposedTurn,
      spec,
    );

    expect(payload.stage).toBe("engine");
    expect(payload.reasons).toStrictEqual(["target_out_of_reach", "action_already_used"]);
    expect(payload.messages).toStrictEqual(["pc-1 is 20 ft away", "already acted"]);
  });

  it("stamps the model that produced it, which is what step 7b groups by", () => {
    const payload = engineRejection("gob-1", 1, [], proposedTurn, spec);

    expect(payload.provider).toBe("google");
    expect(payload.modelId).toBe("gemini-3-flash");
  });

  it("keeps the rejected proposal", () => {
    const payload = engineRejection("gob-1", 2, [], proposedTurn, spec);

    expect(payload.proposedTurn).toStrictEqual(proposedTurn);
    expect(payload.attempt).toBe(2);
  });

  it("produces something the persisted schema accepts", () => {
    const payload = engineRejection(
      "gob-1",
      1,
      [{ reason: "target_not_found", message: "no such combatant" }],
      proposedTurn,
      spec,
    );

    expect(ActionRejectedPayload.safeParse(payload).success).toBe(true);
  });
});

describe("adapterRejection", () => {
  it("records the adapter's code instead of engine reasons", () => {
    const payload = adapterRejection(
      "gob-1",
      1,
      { code: "no_tool_call", message: "The model answered in prose." },
      spec,
    );

    expect(payload.stage).toBe("adapter");
    expect(payload.adapterErrorCode).toBe("no_tool_call");
    expect(payload.messages).toStrictEqual(["The model answered in prose."]);
    expect(payload.reasons).toBeUndefined();
  });

  it("has no proposal to record, because the model produced none", () => {
    const payload = adapterRejection(
      "gob-1",
      1,
      { code: "provider_error", message: "429 rate limited" },
      spec,
    );

    expect(payload.proposedTurn).toBeUndefined();
    expect(ActionRejectedPayload.safeParse(payload).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @ai-dm/agents test action-rejected
```

Expected: FAIL — cannot resolve `./action-rejected.js`.

- [ ] **Step 3: Implement the constructors**

Create `packages/agents/src/tactical/action-rejected.ts`:

```ts
// Builds `action_rejected` payloads. The agent returns these; it never stamps a
// `GameEvent` around them, because eventId, sequence and timestamp need a UUID
// source, a log cursor and a clock — none of which belong in this package.
import type { TurnRejection } from "@ai-dm/rules-engine";
import type { ActionRejectedPayload, ExecuteTurn } from "@ai-dm/schemas";
import type { AdapterError } from "../providers/errors.js";
import type { ModelSpec } from "../providers/routing.js";

/** There is never a third. The type says so. */
export type AttemptNumber = 1 | 2;

export function engineRejection(
  actorId: string,
  attempt: AttemptNumber,
  rejections: readonly TurnRejection[],
  proposedTurn: ExecuteTurn,
  spec: ModelSpec,
): ActionRejectedPayload {
  return {
    actorId,
    attempt,
    stage: "engine",
    reasons: rejections.map((rejection) => rejection.reason),
    messages: rejections.map((rejection) => rejection.message),
    proposedTurn,
    provider: spec.provider,
    modelId: spec.modelId,
  };
}

export function adapterRejection(
  actorId: string,
  attempt: AttemptNumber,
  error: AdapterError,
  spec: ModelSpec,
): ActionRejectedPayload {
  return {
    actorId,
    attempt,
    stage: "adapter",
    adapterErrorCode: error.code,
    messages: [error.message],
    provider: spec.provider,
    modelId: spec.modelId,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/agents test action-rejected
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/tactical/action-rejected.ts packages/agents/src/tactical/action-rejected.test.ts && git commit -m "feat(agents): action_rejected payload constructors"
```

---

### Task 6: The pipeline — happy path

**Files:**
- Modify: `packages/agents/src/tactical/index.ts` (currently a stub: a contract comment plus `export {}`)
- Test: `packages/agents/src/tactical/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `createAgentRuntime`/`AgentRuntime` from `../providers/runtime.js`; `resolveModelSpec`, `ModelRouting` from `../providers/routing.js`; `TokenUsage` from `../providers/port.js`; `createFakePort` and `adapterSuccess`/`adapterFailure` in tests.
- Produces:
  - `createTacticalAgent(options: TacticalAgentOptions): TacticalAgent`
  - `TacticalAgentOptions { runtime: AgentRuntime; routing: ModelRouting }`
  - `ProposeTurnInput { world; actorId; availableActions?; turnOrder?; abortSignal? }`
  - `TurnProposalResult` — the success/failure union from the spec
  - `TurnProposalSource = "model" | "retry" | "fallback"`

Tasks 7 and 8 extend this same file and test file; they add no new exported names.

- [ ] **Step 1: Write the failing tests**

Create `packages/agents/src/tactical/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { adapterSuccess } from "../providers/errors.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { createAgentRuntime } from "../providers/runtime.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import type { AdapterResult } from "../providers/errors.js";
import type { StructuredOutput } from "../providers/port.js";
import { createTacticalAgent } from "./index.js";
import { combatant, parseGrid } from "./test-fixtures.js";

const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };

const grid = parseGrid(`
  ......
  ......
`);

const goblin = combatant({ combatantId: "gob-1", faction: "hostile", position: [0, 0] });
const hero = combatant({ combatantId: "pc-1", faction: "party", position: [1, 0] });
const world = { grid, combatants: [goblin, hero] };

const legalTurn = {
  actorId: "gob-1",
  mainAction: { actionType: "attack", targetIds: ["pc-1"] },
  tacticalRationaleEnglish: "The hero is adjacent.",
};

function agentWith(...structured: AdapterResult<StructuredOutput<unknown>>[]) {
  const port = createFakePort({ structured });
  const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });
  return { port, agent: createTacticalAgent({ runtime, routing: DEFAULT_MODEL_ROUTING }) };
}

describe("createTacticalAgent — a legal proposal", () => {
  it("returns the model's turn untouched", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a proposal");
    expect(result.turn).toStrictEqual(legalTurn);
    expect(result.source).toBe("model");
  });

  it("makes exactly one model call", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(port.calls).toHaveLength(1);
  });

  it("logs no rejection when nothing was rejected", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.rejections).toStrictEqual([]);
  });

  it("returns the engine's plan, not just the turn", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a proposal");
    expect(result.plan.economyAfter.actionUsed).toBe(true);
  });

  it("accumulates token usage for cost metering", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.usage).toStrictEqual([usage]);
  });

  it("asks the tactical model, with the ExecuteTurn tool", async () => {
    const { port, agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(port.calls[0]?.spec.modelId).toBe("gemini-3-flash");
    expect(port.calls[0]?.request.toolName).toBe("execute_turn");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @ai-dm/agents test tactical/index
```

Expected: FAIL — `createTacticalAgent` is not exported from `./index.js`.

- [ ] **Step 3: Implement the pipeline**

Replace the whole of `packages/agents/src/tactical/index.ts`:

```ts
// Enemy tactical agent: proposes ExecuteTurn via tool call.
// Resilience loop (never trust the proposal):
//   1. rules-engine validates  2. on rejection, retry ONCE with the
//   machine-readable reason    3. on second failure, deterministic fallback
//   (attack nearest legal target, else dodge). Log every rejection to the
//   event stream for offline analysis.
//
// The loop is straight-line rather than a counted `while`. "Never a third model
// call" is then a property of the source you can read off the page, instead of
// a bound a reviewer has to audit — and deleting the second call site kills a
// named test rather than quietly changing a number.
import type { CombatWorld, TurnPlan, TurnRejection } from "@ai-dm/rules-engine";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import type { ActionRejectedPayload, ExecuteTurn } from "@ai-dm/schemas";
import { ExecuteTurn as ExecuteTurnSchema } from "@ai-dm/schemas";
import type { AdapterError } from "../providers/errors.js";
import type { TokenUsage } from "../providers/port.js";
import type { ModelRouting } from "../providers/routing.js";
import { resolveModelSpec } from "../providers/routing.js";
import type { AgentRuntime } from "../providers/runtime.js";
import type { AttemptNumber } from "./action-rejected.js";
import { adapterRejection, engineRejection } from "./action-rejected.js";
import { deterministicFallback } from "./fallback.js";
import type { RetryFeedback } from "./prompt.js";
import { buildTacticalPrompt } from "./prompt.js";
import { TACTICAL_TOOL_DESCRIPTION, TACTICAL_TOOL_NAME } from "./prompt-text.js";
import type { SnapshotAction } from "./snapshot.js";
import { buildCapabilityCard, buildSnapshot } from "./snapshot.js";

export * from "./action-rejected.js";
export * from "./fallback.js";
export * from "./prompt.js";
export * from "./prompt-text.js";
export * from "./snapshot.js";

export interface TacticalAgentOptions {
  runtime: AgentRuntime;
  /** Read for the provider and model id stamped onto rejection payloads. */
  routing: ModelRouting;
}

export interface ProposeTurnInput {
  world: CombatWorld;
  actorId: string;
  availableActions?: readonly SnapshotAction[];
  turnOrder?: readonly string[];
  /** The server's 10s turn budget. */
  abortSignal?: AbortSignal;
}

/** Where the returned turn came from. For metrics — never for correctness. */
export type TurnProposalSource = "model" | "retry" | "fallback";

export interface TurnProposalSuccess {
  ok: true;
  turn: ExecuteTurn;
  /** Always a real plan, whatever the source: the fallback is validated too. */
  plan: TurnPlan;
  source: TurnProposalSource;
  rejections: readonly ActionRejectedPayload[];
  usage: readonly TokenUsage[];
}

export interface TurnProposalFailure {
  ok: false;
  kind: "aborted" | "no_legal_turn";
  rejections: readonly ActionRejectedPayload[];
  usage: readonly TokenUsage[];
}

export type TurnProposalResult = TurnProposalSuccess | TurnProposalFailure;

export interface TacticalAgent {
  proposeTurn(input: ProposeTurnInput): Promise<TurnProposalResult>;
}

/** What one attempt tells the pipeline to do next. */
type AttemptOutcome =
  | { kind: "valid"; turn: ExecuteTurn; plan: TurnPlan }
  | { kind: "retryable"; feedback: RetryFeedback }
  | { kind: "fallback" }
  | { kind: "aborted" };

function engineFeedback(
  rejections: readonly TurnRejection[],
  proposedTurn: ExecuteTurn,
): RetryFeedback {
  return {
    codes: rejections.map((rejection) => rejection.reason),
    messages: rejections.map((rejection) => rejection.message),
    proposedTurn,
  };
}

function adapterFeedback(error: AdapterError): RetryFeedback {
  const issues = error.issues ?? [];
  return {
    codes: [error.code],
    // Quoting the zod issues is the whole reason schema_validation_failed is a
    // separate code from no_tool_call.
    messages:
      issues.length === 0
        ? [error.message]
        : issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

export function createTacticalAgent({ runtime, routing }: TacticalAgentOptions): TacticalAgent {
  const spec = resolveModelSpec(routing, "tactical");

  return {
    async proposeTurn(input: ProposeTurnInput): Promise<TurnProposalResult> {
      const actor = input.world.combatants.find((each) => each.combatantId === input.actorId);
      if (actor === undefined) throw new Error(`No combatant ${input.actorId} in this encounter`);

      const snapshot = buildSnapshot({
        world: input.world,
        actorId: input.actorId,
        ...(input.turnOrder === undefined ? {} : { turnOrder: input.turnOrder }),
      });
      const card = buildCapabilityCard(actor, input.availableActions ?? []);

      const rejections: ActionRejectedPayload[] = [];
      const usage: TokenUsage[] = [];

      const attempt = async (
        number: AttemptNumber,
        feedback?: RetryFeedback,
      ): Promise<AttemptOutcome> => {
        const result = await runtime.structured("tactical", {
          prompt: buildTacticalPrompt({
            snapshot,
            card,
            ...(feedback === undefined ? {} : { feedback }),
          }),
          schema: ExecuteTurnSchema,
          toolName: TACTICAL_TOOL_NAME,
          toolDescription: TACTICAL_TOOL_DESCRIPTION,
          ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
        });

        if (!result.ok) {
          rejections.push(adapterRejection(input.actorId, number, result.error, spec));
          switch (result.error.code) {
            case "aborted":
              return { kind: "aborted" };
            case "provider_error":
              // The SDK's maxRetries already spent the transport budget; a
              // second call would be the same failing call.
              return { kind: "fallback" };
            case "no_tool_call":
            case "schema_validation_failed":
              return { kind: "retryable", feedback: adapterFeedback(result.error) };
          }
        }

        usage.push(result.value.usage);
        const turn = result.value.value;
        const validation = validateExecuteTurn(turn, actor, input.world);
        if (validation.valid) return { kind: "valid", turn, plan: validation.plan };

        rejections.push(engineRejection(input.actorId, number, validation.rejections, turn, spec));
        return { kind: "retryable", feedback: engineFeedback(validation.rejections, turn) };
      };

      // Exactly two call sites, and no loop. This is the invariant.
      const first = await attempt(1);
      if (first.kind === "valid") {
        return { ok: true, turn: first.turn, plan: first.plan, source: "model", rejections, usage };
      }
      if (first.kind === "aborted") return { ok: false, kind: "aborted", rejections, usage };

      if (first.kind === "retryable") {
        const second = await attempt(2, first.feedback);
        if (second.kind === "valid") {
          return {
            ok: true,
            turn: second.turn,
            plan: second.plan,
            source: "retry",
            rejections,
            usage,
          };
        }
        if (second.kind === "aborted") return { ok: false, kind: "aborted", rejections, usage };
      }

      const fallback = deterministicFallback(actor, input.world, {
        ...(input.availableActions === undefined
          ? {}
          : { availableActions: input.availableActions }),
      });
      if (fallback === null) return { ok: false, kind: "no_legal_turn", rejections, usage };

      return {
        ok: true,
        turn: fallback.turn,
        plan: fallback.plan,
        source: "fallback",
        rejections,
        usage,
      };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/agents test tactical/index
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/tactical/index.ts packages/agents/src/tactical/index.test.ts && git commit -m "feat(agents): tactical agent pipeline, legal-proposal path"
```

---

### Task 7: The single retry

**Files:**
- Modify: `packages/agents/src/tactical/index.test.ts`
- Test: same file

**Interfaces:**
- Consumes: everything from Task 6. No production code should need to change — these tests exercise branches Task 6 already wrote. If a test fails, fix the implementation.

- [ ] **Step 1: Write the failing tests**

Append to `packages/agents/src/tactical/index.test.ts`. Add `adapterFailure` to the `../providers/errors.js` import, and add `import { ExecuteTurn as ExecuteTurnSchema } from "@ai-dm/schemas";`.

```ts
const illegalTurn = {
  actorId: "gob-1",
  // pc-1 is 5 ft away; pc-99 does not exist.
  mainAction: { actionType: "attack", targetIds: ["pc-99"] },
  tacticalRationaleEnglish: "Attack someone who is not here.",
};

function dynamicOf(port: ReturnType<typeof createFakePort>, call: number): string {
  return (port.calls[call]?.request.prompt.dynamic ?? []).join("\n");
}

describe("createTacticalAgent — the single retry", () => {
  it("retries once when the engine rejects the first proposal", async () => {
    const { port, agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a proposal");
    expect(port.calls).toHaveLength(2);
    expect(result.source).toBe("retry");
    expect(result.turn).toStrictEqual(legalTurn);
  });

  it("carries the machine-readable reason into the retry", async () => {
    const { port, agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(dynamicOf(port, 1)).toContain("target_not_found");
  });

  it("leaves the cached prompt tiers byte-identical across the retry", async () => {
    const { port, agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    await agent.proposeTurn({ world, actorId: "gob-1" });

    // A retry that touched the cached prefix would silently cost ~10x on every
    // call, and the symptom would be a bill rather than a failure.
    expect(port.calls[1]?.request.prompt.static).toStrictEqual(
      port.calls[0]?.request.prompt.static,
    );
    expect(port.calls[1]?.request.prompt.semiStatic).toStrictEqual(
      port.calls[0]?.request.prompt.semiStatic,
    );
  });

  it("logs the engine rejection that triggered the retry", async () => {
    const { agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.stage).toBe("engine");
    expect(result.rejections[0]?.attempt).toBe(1);
    expect(result.rejections[0]?.reasons).toStrictEqual(["target_not_found"]);
    expect(result.rejections[0]?.modelId).toBe("gemini-3-flash");
  });

  it("retries plainly when the model answered in prose", async () => {
    const { port, agent } = agentWith(
      adapterFailure("no_tool_call", "The model answered in prose."),
      adapterSuccess({ value: legalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a proposal");
    expect(port.calls).toHaveLength(2);
    expect(result.source).toBe("retry");
    expect(result.rejections[0]?.adapterErrorCode).toBe("no_tool_call");
  });

  it("quotes the zod issues back when the tool call did not match the schema", async () => {
    // Real issues from the real schema, so the assertion cannot drift from
    // whatever zod actually emits. A turn missing `mainAction` yields an issue
    // whose path is ["mainAction"].
    const parsed = ExecuteTurnSchema.safeParse({ actorId: "gob-1" });
    if (parsed.success) throw new Error("expected the fixture to be invalid");

    const { port, agent } = agentWith(
      adapterFailure("schema_validation_failed", "Tool call did not match", {
        issues: parsed.error.issues,
      }),
      adapterSuccess({ value: legalTurn, usage }),
    );

    await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(dynamicOf(port, 1)).toContain("mainAction");
    // The issues are what reached the model, not just the generic message.
    expect(dynamicOf(port, 1)).not.toContain("Tool call did not match");
  });

  it("counts only the calls that produced output toward usage", async () => {
    const { agent } = agentWith(
      adapterFailure("no_tool_call", "The model answered in prose."),
      adapterSuccess({ value: legalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.usage).toStrictEqual([usage]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail or pass for the right reason**

```bash
pnpm --filter @ai-dm/agents test tactical/index
```

Expected: these exercise branches Task 6 implemented, so some may pass immediately. Any that fail indicate a real defect in Task 6's implementation — fix the implementation, not the test.

- [ ] **Step 3: Mutation check the retry**

Temporarily delete the second `attempt(2, first.feedback)` call site in `index.ts`, replacing the whole `if (first.kind === "retryable") { ... }` block with nothing, and re-run.

Expected: `"retries once when the engine rejects the first proposal"` and `"carries the machine-readable reason into the retry"` both FAIL. If they pass, the retry is not actually under test. Restore afterwards and confirm green.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/tactical/index.test.ts packages/agents/src/tactical/index.ts && git commit -m "test(agents): the tactical agent retries exactly once, carrying the reason"
```

---

### Task 8: Terminal outcomes — fallback and abandon

**Files:**
- Modify: `packages/agents/src/tactical/index.test.ts`

**Interfaces:**
- Consumes: everything from Task 6. Again, no new production code expected.

- [ ] **Step 1: Write the failing tests**

Append to `packages/agents/src/tactical/index.test.ts`:

```ts
describe("createTacticalAgent — terminal outcomes", () => {
  it("falls back after a second failure, and never makes a third call", async () => {
    const { port, agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: illegalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a fallback proposal");
    expect(port.calls).toHaveLength(2);
    expect(result.source).toBe("fallback");
    expect(result.turn.mainAction.targetIds).toStrictEqual(["pc-1"]);
  });

  it("logs both rejections, one per attempt", async () => {
    const { agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: illegalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    expect(result.rejections.map((rejection) => rejection.attempt)).toStrictEqual([1, 2]);
  });

  it("falls back immediately on a provider error, without a second call", async () => {
    const { port, agent } = agentWith(adapterFailure("provider_error", "429 rate limited"));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a fallback proposal");
    // Retrying transport is the SDK's job and its budget is already spent.
    expect(port.calls).toHaveLength(1);
    expect(result.source).toBe("fallback");
    expect(result.rejections[0]?.adapterErrorCode).toBe("provider_error");
  });

  it("abandons the turn when the caller aborted, with no retry and no fallback", async () => {
    const { port, agent } = agentWith(adapterFailure("aborted", "The turn budget is gone."));

    const result = await agent.proposeTurn({ world, actorId: "gob-1" });

    if (result.ok) throw new Error("expected the turn to be abandoned");
    expect(port.calls).toHaveLength(1);
    expect(result.kind).toBe("aborted");
    // The rejection is still logged: every failure reaches the event stream.
    expect(result.rejections[0]?.adapterErrorCode).toBe("aborted");
  });

  it("dodges as its fallback when nothing is in reach", async () => {
    const distantHero = combatant({ combatantId: "pc-1", faction: "party", position: [5, 1] });
    const distantWorld = { grid, combatants: [goblin, distantHero] };
    const { agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: illegalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world: distantWorld, actorId: "gob-1" });

    if (!result.ok) throw new Error("expected a fallback proposal");
    expect(result.turn.mainAction.actionType).toBe("dodge");
  });

  it("reports no legal turn when even the fallback is illegal", async () => {
    const stunned = combatant({
      combatantId: "gob-1",
      conditions: [{ condition: "stunned", durationRounds: 1 }],
    });
    const stunnedWorld = { grid, combatants: [stunned, hero] };
    const { agent } = agentWith(
      adapterSuccess({ value: illegalTurn, usage }),
      adapterSuccess({ value: illegalTurn, usage }),
    );

    const result = await agent.proposeTurn({ world: stunnedWorld, actorId: "gob-1" });

    if (result.ok) throw new Error("expected no legal turn");
    expect(result.kind).toBe("no_legal_turn");
  });

  it("throws when asked to act for a combatant that is not in the encounter", async () => {
    const { agent } = agentWith(adapterSuccess({ value: legalTurn, usage }));

    await expect(agent.proposeTurn({ world, actorId: "nobody" })).rejects.toThrow(
      /No combatant nobody/,
    );
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
pnpm --filter @ai-dm/agents test tactical/index
```

Expected: PASS. Any failure is a real defect in Task 6 — fix the implementation.

Note on the stunned case: a stunned creature is Incapacitated, so `validateExecuteTurn` rejects every action including Dodge. Per `RULES_REFERENCE.md` §7, 2024 Stunned does **not** set Speed to 0 — that does not affect this test, which turns on the action, not on movement.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/tactical/index.test.ts && git commit -m "test(agents): tactical fallback, provider-error and abort paths"
```

---

### Task 9: Wiring and documentation

**Files:**
- Modify: `docs/prompts/README.md`
- Modify: `PROJECT_PLAN.md`
- Verify: `packages/agents/src/index.ts` already contains `export * from "./tactical/index.js";` — no change needed.

**Interfaces:** none new.

- [ ] **Step 1: Point the prompt docs at the module**

Append to `docs/prompts/README.md`:

```markdown
## Where prompt text actually lives

Agent prompt strings are TypeScript modules, not markdown in this directory,
and those modules are the versioned source of record:

| Agent | Module |
|---|---|
| tactical | `packages/agents/src/tactical/prompt-text.ts` |

A markdown copy here would be a twin that drifts, and loading markdown at
runtime would put file I/O into `@ai-dm/agents`, which must stay pure and
bundleable. `hebrew-glossary.md` stays a data file: it is a table for
non-programmers to edit, not prompt text.
```

- [ ] **Step 2: Update the roadmap row**

In `PROJECT_PLAN.md`, replace the step 7 row's status cell. Find the line beginning `| 7 | **Tactical agent + sim:**` and change its trailing `| 3–4 | ⬜ not started |` to `| 3–4 | 🟡 7a done, 7b pending |`.

- [ ] **Step 3: Update the status section**

In `PROJECT_PLAN.md`, insert this after the paragraph ending "62 tests, no network: behaviour runs against a scripted fake, SDK wiring against `MockLanguageModelV1`." and before the paragraph beginning "Two things there are **deliberately unmeasured**":

```markdown
Step 7a built the tactical agent on that adapter. `proposeTurn` projects the
`CombatWorld` into a compact JSON snapshot — positions, HP, conditions, action
economy, and a *precomputed* `distanceFeet` to every other combatant, which
removes the coordinate arithmetic that produces most out-of-reach proposals —
puts it in the `dynamic` prompt tier only, and asks the tactical model for an
`ExecuteTurn`. The rules engine validates it. On rejection the agent retries
exactly once, carrying the stable `TurnRejectionReason` codes back to the model;
a second failure yields the deterministic fallback (attack the nearest legal
target, else Dodge, without moving). Every rejection becomes an
`ActionRejectedPayload` — new in `@ai-dm/schemas`, stamped with the provider and
model id so step 7b can group a log of rejections by the model that produced it.

The loop is straight-line rather than a counted one, so "never a third model
call" is visible in the source rather than enforced by a bound; a test asserts
`port.calls` never exceeds two on any failure path, and another asserts the
cached prompt tiers are byte-identical across the retry.

Two things step 7a deliberately does not do: it never moves the fallback (a
pathfinding fallback would re-implement the judgement the model owes us, in the
one path that must be trivially correct), and on `aborted` it abandons the turn
rather than falling back, because the abort signal is the caller's.
`deterministicFallback` is exported so the server can choose otherwise at no
cost.
```

- [ ] **Step 4: Amend the "deliberately unmeasured" paragraph**

In `PROJECT_PLAN.md`, that paragraph currently ends "Step 7's benchmark is what should set both." Change `Step 7's benchmark` to `Step 7b's benchmark` so it still points forward now that 7a is done.

- [ ] **Step 5: Commit**

```bash
git add docs/prompts/README.md PROJECT_PLAN.md && git commit -m "docs: record step 7a and point the prompt docs at prompt-text.ts"
```

---

### Task 10: Full verification

**Files:** none — this task changes nothing unless it finds a problem.

- [ ] **Step 1: Run the whole monorepo gate**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
```

Expected: all three exit 0. The agents package should report **well above 62** tests (roughly 62 + 41 new); schemas 46 + 3 = 49; rules-engine unchanged at 300. No package may regress.

- [ ] **Step 2: Confirm the agents package alone is green and offline**

```bash
pnpm --filter @ai-dm/agents test
```

Expected: 0 failures. No network access — every test drives `createFakePort` or `MockLanguageModelV1`; no API key is read anywhere.

- [ ] **Step 3: Fix anything the gate caught, then re-run**

Common failures to expect, given this repo's strictness:

- `exactOptionalPropertyTypes` — an optional field assigned `undefined` instead of omitted. Use `...(x === undefined ? {} : { x })`.
- `noUncheckedIndexedAccess` — `array[0].field` errors; use `array[0]?.field`.
- `verbatimModuleSyntax` — a type imported without `import type`.
- Missing `.js` on a relative import.
- `@typescript-eslint/switch-exhaustiveness-check` on the `AdapterErrorCode` switch if a case is dropped.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix(agents): satisfy the strict typecheck and lint gate"
```

Skip this step if steps 1–2 were clean on the first run.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: control flow → 6; module layout → 2–6; prompt location → 3 + 9; snapshot incl. sparse terrain, turnOrder, availableActions → 2; prompt tiers → 3; decision table → 6–8; fallback → 4; `action_rejected` payload → 1 + 5; public surface → 6; testing → 2–8 + 10; `PROJECT_PLAN.md` consequences → 9.

**Type consistency.** `SnapshotAction` is used identically in `snapshot.ts`, `fallback.ts` (`FallbackOptions.availableActions`) and `index.ts` (`ProposeTurnInput.availableActions`). `RetryFeedback` is produced in `index.ts` and consumed in `prompt.ts`. `AttemptNumber` is defined in `action-rejected.ts` and used in `index.ts`. `deterministicFallback` returns `FallbackTurn | null` in both Task 4 and Task 6 — never a bare `ExecuteTurn`.

**Placeholder scan.** Two defects found and fixed inline: Task 6 gave the `agentWith` helper twice (the redundant type-gymnastics version is gone), and Task 7 left the zod-issue fixture as a hand-written literal with a "adjust the assertion" instruction (it now derives real issues from `ExecuteTurn.safeParse` and asserts a path that cannot drift). No `TBD`, no "handle edge cases", no "similar to Task N" remains.

**One thing the implementer should expect to discover.** Tasks 7 and 8 assert behaviour that Task 6's implementation already contains, so many of their tests will pass on first run. That is intentional — the TDD value there is in the two mutation checks (Task 4 Step 5, Task 7 Step 3), which are what actually prove the tests bite. Do not skip them because the suite is green.
