# Combat simulator and tactical benchmark — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tools/sim` into a headless, seeded combat simulator that benchmarks the step-7a tactical agent — legality, latency, tokens and cost per model — and greens in CI with no network and no API key.

**Architecture:** Two measurement modes over one agent. Probe mode replays a fixed, model-independent corpus of board states through `proposeTurn` and never resolves anything — that is the paired comparison that picks the model. Encounter mode plays a full fight, hostile side model-driven and party side scripted, to produce win rate and damage efficiency. A sim-owned resolver composes `rules-engine` primitives under an injected `Rng`; `rules-engine` keeps its monopoly on legality and its zero-I/O purity.

**Tech Stack:** TypeScript 5.7 strict ESM (Node 22), pnpm workspaces, Vitest, zod via `@ai-dm/schemas`, Vercel AI SDK v4 behind `LanguageModelPort`.

**Spec:** `docs/superpowers/specs/2026-08-17-sim-benchmark-design.md`

## Global Constraints

- `corepack enable` before any pnpm command — pnpm is not otherwise on PATH.
- Node 22, ESM only (`"type": "module"`). **Every relative import ends in `.js`**, even though the file on disk is `.ts`.
- TypeScript strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Consequences you will hit: `array[0]` is `T | undefined`; an absent key and `{ key: undefined }` are different types, so build optional properties with `...(x === undefined ? {} : { key: x })`; type-only imports must say `import type`.
- ESLint `strictTypeChecked` + `@typescript-eslint/consistent-type-imports` + `no-floating-promises`. `[...str]` is banned (`no-misused-spread`) — use `Array.from(str, fn)`. There is no `argsIgnorePattern`, so an `_`-prefixed unused parameter still errors. `no-console` allows only `console.warn` / `console.error`.
- Prettier, 100 columns. Run `npx prettier --write` on touched files before committing; CI runs `format:check`.
- **English inside, Hebrew outside.** Every identifier, comment, log line and report string in this plan is English. No Hebrew anywhere in `tools/sim`.
- **Agents propose, the engine validates, nothing else decides legality.** The sim never declares a turn legal on its own; every turn it plays reaches `validateExecuteTurn` first.
- **Seeded RNG everywhere.** No `Math.random()`, no `Date.now()` inside decision or resolution logic. Clocks are injected.
- **No live model call in this plan.** Nothing added here may read an API key or open a socket. The `--live` path is written but only exercised by the operator.
- **Do not touch** `DEFAULT_MODEL_ROUTING.tactical`, `REASONING_BUDGET_TOKENS`, or `PROJECT_PLAN.md`'s step 7 row. Those are gated on data this plan does not produce.
- **Do not edit any prompt string** in `packages/agents/src/tactical/prompt-text.ts`. `prompt-text.test.ts` pins a hash and will fail; a prompt edit also requires bumping `TACTICAL_PROMPT_VERSION`, which invalidates comparisons.
- Verification after every task: `corepack enable && pnpm typecheck && pnpm lint && pnpm test`. Baseline before this plan starts is **489 tests passing** (schemas 49, rules-engine 300, agents 140). No package may regress.

---

## File Structure

**Modified — `packages/agents` (Task 1 only):**

| Path                      | Responsibility                                                           |
| ------------------------- | ------------------------------------------------------------------------ |
| `src/providers/usage.ts`  | **New.** Home of `TokenUsage`, so `errors.ts` can use it without a cycle |
| `src/providers/port.ts`   | Re-exports `TokenUsage` from `usage.ts`; no other change                 |
| `src/providers/errors.ts` | Gains `usage?: TokenUsage` on `AdapterError`                             |
| `src/providers/vercel.ts` | Populates `usage` from `NoObjectGeneratedError.usage`                    |
| `src/tactical/index.ts`   | Accumulates usage on the rejection path                                  |

**Created — `tools/sim/src`:**

| Path                                          | Responsibility                                               |
| --------------------------------------------- | ------------------------------------------------------------ |
| `rng.ts`                                      | mulberry32 `seeded`, exact-value `scripted`                  |
| `pricing.ts`                                  | Dated `$`/Mtok table; `costUsd` returns `null` when unpriced |
| `config.ts`                                   | `Arm` (model × effort), default seeds, `BenchmarkConfig`     |
| `cli.ts`                                      | Pure argv parsing                                            |
| `scenarios/types.ts`                          | `SpawnSpec`, `ScenarioDefinition`, `BuiltScenario`           |
| `scenarios/srd.ts`                            | Locate and parse `data/srd/monsters/*.json`                  |
| `scenarios/build.ts`                          | `ScenarioDefinition` → `BuiltScenario`                       |
| `scenarios/melee-brawl.ts` … `ogre-charge.ts` | The four fixtures                                            |
| `scenarios/index.ts`                          | Scenario registry                                            |
| `engine/resolve.ts`                           | `applyTurn` — the only place state mutates                   |
| `engine/policy.ts`                            | Scripted baseline: move to contact, then attack              |
| `engine/encounter.ts`                         | Turn order, rounds, termination                              |
| `smoke/defects.ts`                            | Seeded defect schedule                                       |
| `smoke/port.ts`                               | Refillable scripted port over `createFakePort`               |
| `run/records.ts`                              | `TurnRecord` — the row every mode emits                      |
| `run/metrics.ts`                              | Legality, latency percentiles, usage, cost aggregation       |
| `run/probe.ts`                                | Derive the probe corpus; run one arm against it              |
| `run/loop.ts`                                 | Run one arm through an encounter                             |
| `run/report.ts`                               | `RunReport` → JSON + markdown                                |
| `index.ts`                                    | Entry point                                                  |

---

### Task 1: Honest token usage on rejected attempts

`TurnProposalResult.usage` accumulates only on calls that produced output. A `schema_validation_failed` or `no_tool_call` attempt was billed and is invisible, because `AdapterError` has no usage field. The bias is downward and lands exactly on the retry paths a model comparison most wants to price. Fix it first, so every later task measures the honest number.

**Files:**

- Create: `packages/agents/src/providers/usage.ts`
- Modify: `packages/agents/src/providers/port.ts` (remove the `TokenUsage` declaration, re-export it)
- Modify: `packages/agents/src/providers/errors.ts`
- Modify: `packages/agents/src/providers/vercel.ts`
- Modify: `packages/agents/src/tactical/index.ts`
- Test: `packages/agents/src/providers/errors.test.ts`, `packages/agents/src/providers/vercel.test.ts`, `packages/agents/src/tactical/index.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `AdapterError.usage?: TokenUsage`; `adapterFailure(code, message, { issues?, cause?, usage? })`; `TurnProposalResult.usage` now includes rejected attempts.

- [ ] **Step 1: Create the usage module**

`errors.ts` cannot import `TokenUsage` from `port.ts`, because `port.ts` already imports from `errors.ts`. That is a type-only cycle worth not creating, so the type moves down.

Create `packages/agents/src/providers/usage.ts`:

```ts
// Token accounting, in its own module so both `port.ts` (successful calls) and
// `errors.ts` (billed attempts that produced nothing usable) can name it
// without importing each other.
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

- [ ] **Step 2: Re-export it from `port.ts`**

In `packages/agents/src/providers/port.ts`, delete the `TokenUsage` interface declaration (lines 13-17) and add, beside the other imports at the top:

```ts
export type { TokenUsage } from "./usage.js";
import type { TokenUsage } from "./usage.js";
```

Every existing `import type { TokenUsage } from "./port.js"` in the repo keeps resolving. Do not change any of them.

- [ ] **Step 3: Write the failing test for `AdapterError.usage`**

Append to `packages/agents/src/providers/errors.test.ts`:

```ts
describe("adapterFailure usage", () => {
  it("carries usage for an attempt that was billed but produced nothing usable", () => {
    const failure = adapterFailure("no_tool_call", "The model answered without calling the tool.", {
      usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
    });

    expect(failure.error.usage).toEqual({
      promptTokens: 900,
      completionTokens: 40,
      totalTokens: 940,
    });
  });

  it("omits the key entirely when the provider reported no usage", () => {
    const failure = adapterFailure("provider_error", "Provider call failed: boom");

    expect("usage" in failure.error).toBe(false);
  });
});
```

Check the file's existing imports; add `adapterFailure` to the `./errors.js` import if it is not already there.

- [ ] **Step 4: Run it and watch it fail**

Run: `corepack enable && pnpm --filter @ai-dm/agents test -- errors`
Expected: FAIL — `Object literal may only specify known properties, and 'usage' does not exist in type ...`

- [ ] **Step 5: Add the field**

In `packages/agents/src/providers/errors.ts`, add the import and extend both the interface and the factory:

```ts
import type { TokenUsage } from "./usage.js";
```

Inside `AdapterError`, after `issues`:

```ts
  /**
   * What the attempt cost, when the provider reported it. A rejected tool call
   * was still billed; without this the retry paths — exactly the ones a model
   * comparison wants to price — are invisible in `TurnProposalResult.usage`.
   * Absent when the provider surfaced no usage, which is not the same as zero.
   */
  usage?: TokenUsage;
```

Change the `adapterFailure` signature and body:

```ts
export function adapterFailure(
  code: AdapterErrorCode,
  message: string,
  diagnostics: { issues?: readonly ZodIssue[]; cause?: unknown; usage?: TokenUsage } = {},
): AdapterFailure {
  // Spread conditionally: `exactOptionalPropertyTypes` distinguishes an absent
  // key from one explicitly set to undefined, and the tests assert absence.
  return {
    ok: false,
    error: {
      code,
      message,
      ...(diagnostics.issues === undefined ? {} : { issues: diagnostics.issues }),
      ...(diagnostics.cause === undefined ? {} : { cause: diagnostics.cause }),
      ...(diagnostics.usage === undefined ? {} : { usage: diagnostics.usage }),
    },
  };
}
```

- [ ] **Step 6: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/agents test -- errors`
Expected: PASS

- [ ] **Step 7: Write the failing test for the adapter populating it**

`NoObjectGeneratedError` in the installed `ai@4.3.19` carries `readonly usage: LanguageModelUsage | undefined`. Append to `packages/agents/src/providers/vercel.test.ts`:

```ts
describe("usage on failed structured calls", () => {
  it("reports the tokens a no-tool-call attempt was billed", async () => {
    const port = createVercelPort({
      resolveModel: () =>
        new MockLanguageModelV1({
          doGenerate: () => {
            throw new NoObjectGeneratedError({
              message: "No object generated.",
              text: "I think the goblin should charge.",
              response: { id: "r1", timestamp: new Date(0), modelId: "test" },
              usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
              finishReason: "stop",
            });
          },
        }),
    });

    const result = await port.generateStructured(SPEC, {
      prompt: PROMPT,
      schema: z.object({ actorId: z.string() }),
      toolName: "execute_turn",
      toolDescription: "Take a turn.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("no_tool_call");
    expect(result.error.usage).toEqual({
      promptTokens: 900,
      completionTokens: 40,
      totalTokens: 940,
    });
  });
});
```

Reuse whatever `SPEC` and `PROMPT` constants that file already defines; if it builds them inline per test, follow that style instead. Add `NoObjectGeneratedError` to the existing `from "ai"` import.

- [ ] **Step 8: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/agents test -- vercel`
Expected: FAIL — `expected undefined to equal { promptTokens: 900, ... }`

- [ ] **Step 9: Populate usage in the adapter**

In `packages/agents/src/providers/vercel.ts`, add a helper beside `toUsage`:

```ts
/**
 * Usage the SDK attached to a failure. `NoObjectGeneratedError` carries it for
 * both the no-tool-call and the schema-violation paths; `APICallError` does not,
 * which is correct — nothing was billed for output there.
 */
function usageFromError(error: unknown): TokenUsage | undefined {
  return NoObjectGeneratedError.isInstance(error) && error.usage !== undefined
    ? toUsage(error.usage)
    : undefined;
}
```

Change `schemaFailure` to take and forward it:

```ts
function schemaFailure<T>(
  schema: ZodType<T>,
  value: unknown,
  cause: unknown,
  usage: TokenUsage | undefined,
): AdapterResult<never> {
  const parsed = schema.safeParse(value);
  return adapterFailure(
    "schema_validation_failed",
    "The model's tool call did not match the tool schema.",
    {
      ...(parsed.success ? {} : { issues: parsed.error.issues }),
      cause,
      ...(usage === undefined ? {} : { usage }),
    },
  );
}
```

In `generateStructured`'s catch block, update the two call sites:

```ts
const validation = typeValidationCauseOf(error);
if (validation !== undefined) {
  return schemaFailure(request.schema, validation.value, error, usageFromError(error));
}

if (NoObjectGeneratedError.isInstance(error)) {
  const usage = usageFromError(error);
  return adapterFailure("no_tool_call", "The model answered without calling the tool.", {
    cause: error,
    ...(usage === undefined ? {} : { usage }),
  });
}
```

Note `typeValidationCauseOf` unwraps a `TypeValidationError` nested inside a `NoObjectGeneratedError`, so `usageFromError(error)` is passed the _outer_ error, which is the one carrying usage. A bare `TypeValidationError` yields `undefined` — that gap is what the report's `usageComplete` flag exists to declare.

- [ ] **Step 10: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/agents test -- vercel`
Expected: PASS

- [ ] **Step 11: Write the failing test for the agent accumulating it**

Append to `packages/agents/src/tactical/index.test.ts`, following that file's existing fixture helpers:

```ts
it("counts tokens billed on a rejected attempt", async () => {
  const port = createFakePort({
    structured: [
      adapterFailure("no_tool_call", "The model answered without calling the tool.", {
        usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
      }),
      adapterSuccess({
        value: validTurnFixture(),
        usage: { promptTokens: 1000, completionTokens: 60, totalTokens: 1060 },
      }),
    ],
  });

  const agent = createTacticalAgent({ runtime: runtimeWith(port) });
  const result = await agent.proposeTurn({ world: worldFixture(), actorId: "goblin_1" });

  expect(result.usage).toHaveLength(2);
  expect(result.usage[0]).toEqual({ promptTokens: 900, completionTokens: 40, totalTokens: 940 });
});
```

`validTurnFixture`, `worldFixture` and `runtimeWith` stand for whatever that file already uses — read it and reuse its helpers rather than adding new ones. The turn must be legal on the world so `source` is `"retry"`.

- [ ] **Step 12: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/agents test -- tactical`
Expected: FAIL — `expected length 2, got 1`

- [ ] **Step 13: Accumulate it in the agent**

In `packages/agents/src/tactical/index.ts`, inside `attempt`, in the `if (!result.ok)` branch, immediately after the existing `rejections.push(...)` line:

```ts
// A rejected attempt was billed too. Pushing it here is what keeps
// cost-per-turn from under-reporting exactly the retry paths a model
// comparison is trying to price.
if (result.error.usage !== undefined) usage.push(result.error.usage);
```

- [ ] **Step 14: Run the whole agents package**

Run: `pnpm --filter @ai-dm/agents test`
Expected: PASS, 143 or more tests (was 140), zero failures.

- [ ] **Step 15: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write packages/agents/src/providers/usage.ts packages/agents/src/providers/port.ts packages/agents/src/providers/errors.ts packages/agents/src/providers/vercel.ts packages/agents/src/tactical/index.ts packages/agents/src/providers/errors.test.ts packages/agents/src/providers/vercel.test.ts packages/agents/src/tactical/index.test.ts
git add packages/agents
git commit -m "feat(agents): report tokens billed on rejected model attempts

AdapterError gained an optional usage field, populated from
NoObjectGeneratedError, and the tactical agent accumulates it. Without it
TurnProposalResult.usage under-reported exactly the retry paths step 7b's
benchmark most wants to price.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Sim package scaffold and the seeded RNG

**Files:**

- Create: `tools/sim/src/rng.ts`, `tools/sim/src/rng.test.ts`
- Modify: `tools/sim/package.json`, `.gitignore`

**Interfaces:**

- Consumes: `Rng` from `@ai-dm/rules-engine`.
- Produces: `seeded(seed: number): Rng`, `scripted(values: readonly number[]): Rng`, `d20Exactly(n: number): number`.

- [ ] **Step 1: Write the failing test**

`packages/rules-engine/CLAUDE.md` documents `seeded` and `scripted` as if they were exports of `@ai-dm/rules-engine`. They are not — both are private helpers inside `packages/rules-engine/src/dice/index.test.ts`. The sim carries its own copy, reproducing that implementation exactly so a given seed yields the same stream in both places.

Create `tools/sim/src/rng.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rollDie } from "@ai-dm/rules-engine";
import { d20Exactly, scripted, seeded } from "./rng.js";

describe("seeded", () => {
  it("produces the same stream twice for one seed", () => {
    const draw = (): number[] => {
      const rng = seeded(1234);
      return Array.from({ length: 10 }, () => rng());
    };

    expect(draw()).toEqual(draw());
  });

  it("produces different streams for different seeds", () => {
    expect(seeded(1)()).not.toBe(seeded(2)());
  });

  it("stays inside [0, 1) across a long stream", () => {
    const rng = seeded(99);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("scripted", () => {
  it("replays exact values in order", () => {
    const rng = scripted([0, 0.5, 0.999999]);
    expect(rollDie(20, rng)).toBe(1);
    expect(rollDie(20, rng)).toBe(11);
    expect(rollDie(20, rng)).toBe(20);
  });

  it("throws rather than silently repeating when exhausted", () => {
    const rng = scripted([0.5]);
    rng();
    expect(() => rng()).toThrow("scripted RNG exhausted");
  });
});

describe("d20Exactly", () => {
  it("makes rollDie(20) return the named face", () => {
    for (const face of [1, 7, 15, 20]) {
      expect(rollDie(20, scripted([d20Exactly(face)]))).toBe(face);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `corepack enable && pnpm --filter @ai-dm/sim test`
Expected: FAIL — cannot resolve `./rng.js`.

- [ ] **Step 3: Implement**

Create `tools/sim/src/rng.ts`:

```ts
// Deterministic randomness for the whole simulator. A run must be exactly
// reproducible given (seed, model, scenario), so nothing here reads a clock and
// nothing anywhere in this package calls Math.random.
//
// These duplicate the private helpers in
// `packages/rules-engine/src/dice/index.test.ts`, deliberately and identically:
// `@ai-dm/rules-engine` exports neither, despite its CLAUDE.md listing them, so
// a copy is the only way for the sim to have them without widening that
// package's public API. Keep the implementations byte-identical — if they ever
// diverge, the same seed stops meaning the same stream in the two places.
import type { Rng } from "@ai-dm/rules-engine";

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

/** Feeds an exact sequence of [0,1) values so individual rolls are pinned. */
export function scripted(values: readonly number[]): Rng {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("scripted RNG exhausted");
    return value;
  };
}

/** The `[0,1)` value that makes `rollDie(20, rng)` return exactly `face`. */
export function d20Exactly(face: number): number {
  return (face - 1) / 20 + 0.0001;
}
```

- [ ] **Step 4: Enable real test runs for the package**

In `tools/sim/package.json`, change the `test` script from `"vitest run --passWithNoTests"` to `"vitest run"`. The `--passWithNoTests` flag was scaffolding for an empty package; the package now has tests, and leaving it would let a future deletion of every test file pass silently.

- [ ] **Step 5: Ignore run artefacts**

Reports are per-run measurement output, not source. Append to `.gitignore`, after the `coverage/` line:

```
tools/sim/runs/
```

- [ ] **Step 6: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test`
Expected: PASS, 6 tests.

- [ ] **Step 7: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/rng.ts tools/sim/src/rng.test.ts tools/sim/package.json
git add tools/sim .gitignore
git commit -m "feat(sim): seeded and scripted RNG helpers

Duplicated from the rules-engine test file rather than imported: that package
documents seeded/scripted in its CLAUDE.md but exports neither.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Scenario types, SRD loader, builder, and the first fixture

The load-bearing detail: `world.actionRangesFeet` must come from `actionRangesFeetFrom` over the **same** stat blocks that produce each combatant's `availableActions`. Omit it and every ranged attack is rejected as out of reach — and the failure reads as a model defect, which would corrupt the entire benchmark.

**Files:**

- Create: `tools/sim/src/scenarios/types.ts`, `srd.ts`, `build.ts`, `melee-brawl.ts`
- Test: `tools/sim/src/scenarios/build.test.ts`

**Interfaces:**

- Consumes: `seeded` from Task 2 (not directly here; the builder is pure).
- Produces:
  - `SpawnSpec { combatantId, monsterId, faction, position }`
  - `ScenarioDefinition { scenarioId, descriptionEnglish, width, height, terrain?, spawns, turnOrder, maxRounds }`
  - `BuiltScenario { scenarioId, world, statBlocks, availableActions, turnOrder, maxRounds }`
  - `loadMonster(monsterId: string): MonsterStatBlock`
  - `buildScenario(definition: ScenarioDefinition): BuiltScenario`
  - `MELEE_BRAWL: ScenarioDefinition`

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/scenarios/build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Combatant, GridMap } from "@ai-dm/schemas";
import { buildScenario } from "./build.js";
import { MELEE_BRAWL } from "./melee-brawl.js";

describe("buildScenario", () => {
  const built = buildScenario(MELEE_BRAWL);

  it("produces a world whose grid and combatants satisfy the schemas", () => {
    expect(() => GridMap.parse(built.world.grid)).not.toThrow();
    for (const combatant of built.world.combatants) {
      expect(() => Combatant.parse(combatant)).not.toThrow();
    }
  });

  it("spawns one combatant per spawn spec, at its declared position", () => {
    expect(built.world.combatants).toHaveLength(MELEE_BRAWL.spawns.length);
    for (const spawn of MELEE_BRAWL.spawns) {
      const found = built.world.combatants.find((each) => each.combatantId === spawn.combatantId);
      expect(found?.position).toEqual(spawn.position);
      expect(found?.faction).toBe(spawn.faction);
    }
  });

  // The guard against the failure mode that would corrupt every measurement:
  // an action the model is offered but the validator cannot find a range for.
  it("gives every offered action an entry in actionRangesFeet", () => {
    for (const [combatantId, actions] of built.availableActions) {
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(built.world.actionRangesFeet?.[action.actionId]).toBeGreaterThan(0);
      }
      expect(built.statBlocks.get(combatantId)).toBeDefined();
    }
  });

  it("lists a turn order naming only combatants that exist", () => {
    const ids = new Set(built.world.combatants.map((each) => each.combatantId));
    expect(built.turnOrder.length).toBe(built.world.combatants.length);
    for (const id of built.turnOrder) expect(ids.has(id)).toBe(true);
  });

  it("is pure — two builds produce equal worlds", () => {
    expect(buildScenario(MELEE_BRAWL).world).toEqual(buildScenario(MELEE_BRAWL).world);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- build`
Expected: FAIL — cannot resolve `./build.js`.

- [ ] **Step 3: Write the types**

Create `tools/sim/src/scenarios/types.ts`:

```ts
// A scenario is a fixture: a map, a cast, and a fixed turn order. Everything
// here is data. `buildScenario` is the only thing that turns it into state.
import type { CombatWorld } from "@ai-dm/rules-engine";
import type { AvailableAction } from "@ai-dm/agents";
import type { Faction, MonsterStatBlock, TerrainType, Tile } from "@ai-dm/schemas";

export interface SpawnSpec {
  combatantId: string;
  /** Basename of a file in `data/srd/monsters/`, without the extension. */
  monsterId: string;
  faction: Faction;
  position: Tile;
}

export interface TerrainOverride {
  tile: Tile;
  terrain: TerrainType;
}

export interface ScenarioDefinition {
  scenarioId: string;
  /** English. Says what this fixture is meant to discriminate. */
  descriptionEnglish: string;
  width: number;
  height: number;
  /** Sparse: every unlisted tile is "normal". */
  terrain?: readonly TerrainOverride[];
  spawns: readonly SpawnSpec[];
  /**
   * Declared, never rolled. Initiative is not what the benchmark measures, and
   * rolling it would spend RNG draws that shift every later roll.
   */
  turnOrder: readonly string[];
  maxRounds: number;
}

export interface BuiltScenario {
  scenarioId: string;
  world: CombatWorld;
  /** By `combatantId` — the resolver needs attack bonuses, which `Combatant` lacks. */
  statBlocks: ReadonlyMap<string, MonsterStatBlock>;
  /** By `combatantId`. What that creature may propose this turn. */
  availableActions: ReadonlyMap<string, readonly AvailableAction[]>;
  turnOrder: readonly string[];
  maxRounds: number;
}
```

- [ ] **Step 4: Write the SRD loader**

Create `tools/sim/src/scenarios/srd.ts`:

```ts
// Reads SRD 5.2.1 stat blocks from `data/srd/monsters/`. Content is CC-BY-4.0;
// see NOTICE.md. Parsing goes through `@ai-dm/schemas` so a malformed file
// fails here rather than as a mysterious rejection thirty turns into a run.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MonsterStatBlock } from "@ai-dm/schemas";

const MONSTER_DIR_RELATIVE = join("data", "srd", "monsters");

/**
 * Walk up from this file until `data/srd/monsters` appears. Searching beats a
 * fixed `../../../..`, which would be wrong for `dist/` after `pnpm build`.
 */
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

- [ ] **Step 5: Write the builder**

Create `tools/sim/src/scenarios/build.ts`:

```ts
// Turns a `ScenarioDefinition` into the state the agent and the resolver need.
// Pure and total: it either produces a fully valid world or throws.
import type { AvailableAction } from "@ai-dm/agents";
import { actionRangesFeetFrom, combatantFromStatBlock } from "@ai-dm/rules-engine";
import type { Combatant, GridMap, MonsterStatBlock, TerrainType } from "@ai-dm/schemas";
import { GridMap as GridMapSchema } from "@ai-dm/schemas";
import { loadMonster } from "./srd.js";
import type { BuiltScenario, ScenarioDefinition } from "./types.js";

function buildGrid(definition: ScenarioDefinition): GridMap {
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

  // Parse rather than trust: a fixture is data, and data gets validated.
  return GridMapSchema.parse({ width: definition.width, height: definition.height, tiles });
}

export function buildScenario(definition: ScenarioDefinition): BuiltScenario {
  const statBlocks = new Map<string, MonsterStatBlock>();
  const availableActions = new Map<string, readonly AvailableAction[]>();
  const combatants: Combatant[] = [];

  for (const spawn of definition.spawns) {
    const statBlock = loadMonster(spawn.monsterId);
    statBlocks.set(spawn.combatantId, statBlock);
    availableActions.set(
      spawn.combatantId,
      statBlock.actions.map((action) => ({
        actionId: action.actionId,
        name: action.nameEnglish,
      })),
    );
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
    scenarioId: definition.scenarioId,
    world: {
      grid: buildGrid(definition),
      combatants,
      // Load-bearing. Derived from the same stat blocks that produced
      // availableActions, so what the model is offered and what the validator
      // will enforce cannot disagree.
      actionRangesFeet: actionRangesFeetFrom([...statBlocks.values()]),
    },
    statBlocks,
    availableActions,
    turnOrder: definition.turnOrder,
    maxRounds: definition.maxRounds,
  };
}
```

- [ ] **Step 6: Write the first fixture**

Create `tools/sim/src/scenarios/melee-brawl.ts`:

```ts
// The floor: everyone starts in or near reach on open ground. A model that
// cannot score here has a problem with the tool schema, not with geometry.
import type { ScenarioDefinition } from "./types.js";

export const MELEE_BRAWL: ScenarioDefinition = {
  scenarioId: "melee-brawl",
  descriptionEnglish:
    "Two goblin warriors meet two guards at close quarters on an empty 12x12 field. " +
    "Baseline legality with no spatial reasoning required.",
  width: 12,
  height: 12,
  spawns: [
    { combatantId: "goblin_1", monsterId: "goblin_warrior", faction: "hostile", position: [4, 5] },
    { combatantId: "goblin_2", monsterId: "goblin_warrior", faction: "hostile", position: [4, 7] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [5, 5] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [5, 7] },
  ],
  turnOrder: ["goblin_1", "guard_1", "goblin_2", "guard_2"],
  maxRounds: 15,
};
```

- [ ] **Step 7: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- build`
Expected: PASS, 5 tests.

- [ ] **Step 8: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/scenarios
git add tools/sim
git commit -m "feat(sim): scenario types, SRD loader and the melee-brawl fixture

actionRangesFeet is derived from the same stat blocks that produce
availableActions, and a test asserts every offered action has a range.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The remaining three fixtures and the registry

Each discriminates a distinct failure mode, so a single legality number can be decomposed into what the model actually got wrong.

**Files:**

- Create: `tools/sim/src/scenarios/ranged-approach.ts`, `cover-corridor.ts`, `ogre-charge.ts`, `index.ts`
- Test: `tools/sim/src/scenarios/index.test.ts`

**Interfaces:**

- Consumes: `ScenarioDefinition`, `buildScenario` (Task 3).
- Produces: `SCENARIOS: ReadonlyMap<string, ScenarioDefinition>`, `scenarioById(id: string): ScenarioDefinition`, `ALL_SCENARIO_IDS: readonly string[]`.

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/scenarios/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Combatant, GridMap } from "@ai-dm/schemas";
import { buildScenario } from "./build.js";
import { ALL_SCENARIO_IDS, SCENARIOS, scenarioById } from "./index.js";

describe("scenario registry", () => {
  it("registers four fixtures under matching ids", () => {
    expect(ALL_SCENARIO_IDS).toEqual([
      "melee-brawl",
      "ranged-approach",
      "cover-corridor",
      "ogre-charge",
    ]);
    for (const id of ALL_SCENARIO_IDS) {
      expect(scenarioById(id).scenarioId).toBe(id);
    }
  });

  it("throws on an unknown id rather than returning undefined", () => {
    expect(() => scenarioById("no-such-scenario")).toThrow("no-such-scenario");
  });

  it.each([...SCENARIOS.keys()])("%s builds into a schema-valid world", (id) => {
    const built = buildScenario(scenarioById(id));
    expect(() => GridMap.parse(built.world.grid)).not.toThrow();
    for (const combatant of built.world.combatants) {
      expect(() => Combatant.parse(combatant)).not.toThrow();
    }
  });

  it.each([...SCENARIOS.keys()])("%s gives every offered action a range", (id) => {
    const built = buildScenario(scenarioById(id));
    for (const actions of built.availableActions.values()) {
      for (const action of actions) {
        expect(built.world.actionRangesFeet?.[action.actionId]).toBeGreaterThan(0);
      }
    }
  });

  it.each([...SCENARIOS.keys()])("%s starts with both factions present and alive", (id) => {
    const built = buildScenario(scenarioById(id));
    const factions = new Set(built.world.combatants.map((each) => each.faction));
    expect(factions.has("hostile")).toBe(true);
    expect(factions.has("party")).toBe(true);
    expect(built.world.combatants.every((each) => each.status === "alive")).toBe(true);
  });

  it.each([...SCENARIOS.keys()])("%s spawns no two combatants on one tile", (id) => {
    const built = buildScenario(scenarioById(id));
    const tiles = built.world.combatants.map((each) => each.position.join(","));
    expect(new Set(tiles).size).toBe(tiles.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- scenarios`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Write the ranged fixture**

Create `tools/sim/src/scenarios/ranged-approach.ts`:

```ts
// Goblins hold both a scimitar (5 ft reach) and a shortbow (80 ft range) and
// start well out of melee. This is the fixture `actionRangesFeet` exists for:
// a model that reaches for the scimitar at 60 ft earns target_out_of_reach,
// and one that never closes the distance wastes the turn.
import type { ScenarioDefinition } from "./types.js";

export const RANGED_APPROACH: ScenarioDefinition = {
  scenarioId: "ranged-approach",
  descriptionEnglish:
    "Two goblin warriors face two guards across 60 feet of open ground, holding a " +
    "melee and a ranged option. Discriminates action-range selection.",
  width: 20,
  height: 12,
  spawns: [
    { combatantId: "goblin_1", monsterId: "goblin_warrior", faction: "hostile", position: [2, 5] },
    { combatantId: "goblin_2", monsterId: "goblin_warrior", faction: "hostile", position: [2, 7] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [14, 5] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [14, 7] },
  ],
  turnOrder: ["goblin_1", "guard_1", "goblin_2", "guard_2"],
  maxRounds: 20,
};
```

- [ ] **Step 4: Write the cover fixture**

Create `tools/sim/src/scenarios/cover-corridor.ts`:

```ts
// A wall of blocking terrain with a gap, and three-quarters cover either side
// of it. Targets behind the wall draw target_behind_full_cover; targets in the
// gap are legal but harder to hit. Discriminates line-of-sight reasoning.
import type { ScenarioDefinition, TerrainOverride } from "./types.js";

/** A vertical wall at x = 8, open at y = 6 so the encounter can resolve. */
const WALL: readonly TerrainOverride[] = [
  { tile: [8, 2], terrain: "blocking" },
  { tile: [8, 3], terrain: "blocking" },
  { tile: [8, 4], terrain: "blocking" },
  { tile: [8, 5], terrain: "three_quarters_cover" },
  { tile: [8, 7], terrain: "three_quarters_cover" },
  { tile: [8, 8], terrain: "blocking" },
  { tile: [8, 9], terrain: "blocking" },
  { tile: [8, 10], terrain: "blocking" },
];

export const COVER_CORRIDOR: ScenarioDefinition = {
  scenarioId: "cover-corridor",
  descriptionEnglish:
    "Wolves and guards separated by a wall with a single gap and cover at its edges. " +
    "Discriminates line-of-sight and cover-aware target selection.",
  width: 16,
  height: 13,
  terrain: WALL,
  spawns: [
    { combatantId: "wolf_1", monsterId: "wolf", faction: "hostile", position: [4, 5] },
    { combatantId: "wolf_2", monsterId: "wolf", faction: "hostile", position: [4, 7] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [12, 5] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [12, 7] },
  ],
  turnOrder: ["wolf_1", "guard_1", "wolf_2", "guard_2"],
  maxRounds: 20,
};
```

- [ ] **Step 5: Write the ogre fixture**

Create `tools/sim/src/scenarios/ogre-charge.ts`:

```ts
// A Large creature (2x2 footprint, 10 ft reach) crossing difficult terrain,
// which costs double. Discriminates movement-budget arithmetic and whether the
// model accounts for a footprint bigger than one square.
import type { ScenarioDefinition, TerrainOverride } from "./types.js";

/** A band of mud the ogre must cross or go around. */
const MUD: readonly TerrainOverride[] = [6, 7].flatMap((x) =>
  [3, 4, 5, 6, 7, 8].map((y): TerrainOverride => ({ tile: [x, y], terrain: "difficult" })),
);

export const OGRE_CHARGE: ScenarioDefinition = {
  scenarioId: "ogre-charge",
  descriptionEnglish:
    "One ogre crosses a band of difficult terrain to reach three guards. " +
    "Discriminates movement budgeting and large-creature footprint handling.",
  width: 16,
  height: 12,
  terrain: MUD,
  spawns: [
    { combatantId: "ogre_1", monsterId: "ogre", faction: "hostile", position: [2, 5] },
    { combatantId: "guard_1", monsterId: "guard", faction: "party", position: [12, 4] },
    { combatantId: "guard_2", monsterId: "guard", faction: "party", position: [12, 6] },
    { combatantId: "guard_3", monsterId: "guard", faction: "party", position: [13, 5] },
  ],
  turnOrder: ["ogre_1", "guard_1", "guard_2", "guard_3"],
  maxRounds: 20,
};
```

- [ ] **Step 6: Write the registry**

Create `tools/sim/src/scenarios/index.ts`:

```ts
// The scenario registry. Ordered, because report tables read better in a fixed
// order and `--scenarios` defaults to all of them.
export * from "./types.js";
export * from "./build.js";
export * from "./srd.js";

import { COVER_CORRIDOR } from "./cover-corridor.js";
import { MELEE_BRAWL } from "./melee-brawl.js";
import { OGRE_CHARGE } from "./ogre-charge.js";
import { RANGED_APPROACH } from "./ranged-approach.js";
import type { ScenarioDefinition } from "./types.js";

export { COVER_CORRIDOR, MELEE_BRAWL, OGRE_CHARGE, RANGED_APPROACH };

const ORDERED: readonly ScenarioDefinition[] = [
  MELEE_BRAWL,
  RANGED_APPROACH,
  COVER_CORRIDOR,
  OGRE_CHARGE,
];

export const SCENARIOS: ReadonlyMap<string, ScenarioDefinition> = new Map(
  ORDERED.map((scenario) => [scenario.scenarioId, scenario]),
);

export const ALL_SCENARIO_IDS: readonly string[] = ORDERED.map((each) => each.scenarioId);

/** Throws on an unknown id: a typo in `--scenarios` should stop the run, not skip it. */
export function scenarioById(scenarioId: string): ScenarioDefinition {
  const found = SCENARIOS.get(scenarioId);
  if (found === undefined) {
    throw new Error(`Unknown scenario ${scenarioId}; known: ${ALL_SCENARIO_IDS.join(", ")}`);
  }
  return found;
}
```

- [ ] **Step 7: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- scenarios`
Expected: PASS. If `cover-corridor` fails the "both factions alive" or range assertions, check that `wolf.json` and `ogre.json` exist under `data/srd/monsters/` and that their `actionId` values are what the fixture assumes.

- [ ] **Step 8: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/scenarios
git add tools/sim
git commit -m "feat(sim): three more fixtures and the scenario registry

Ranged selection, line of sight behind cover, and movement across difficult
terrain with a Large footprint. Each isolates one failure mode so a legality
number can be decomposed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The turn resolver

The only place in the sim where state changes. It composes `rules-engine` primitives; it decides no legality of its own.

**Files:**

- Create: `tools/sim/src/engine/resolve.ts`
- Test: `tools/sim/src/engine/resolve.test.ts`

**Interfaces:**

- Consumes: `BuiltScenario` (Task 3), `scripted` / `d20Exactly` (Task 2).
- Produces:
  - `ResolveContext { statBlocks: ReadonlyMap<string, MonsterStatBlock> }`
  - `AttackRecord { attackerId, targetId, actionId, outcome, cover, damage, targetStatusAfter }`
  - `TurnEffect { attacks, damageDealt, killed, movedFeet, nonAttackAction, unresolvedActionIds }`
  - `applyTurn(input: ApplyTurnInput): { world: CombatWorld; effect: TurnEffect }`

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/engine/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateExecuteTurn } from "@ai-dm/rules-engine";
import type { ExecuteTurn } from "@ai-dm/schemas";
import { buildScenario } from "../scenarios/build.js";
import { MELEE_BRAWL } from "../scenarios/melee-brawl.js";
import { d20Exactly, scripted } from "../rng.js";
import { applyTurn } from "./resolve.js";

const built = buildScenario(MELEE_BRAWL);

function attack(actorId: string, targetId: string, actionId: string): ExecuteTurn {
  return {
    actorId,
    mainAction: { actionType: "attack", actionId, targetIds: [targetId] },
    tacticalRationaleEnglish: "Test fixture.",
  };
}

function resolve(turn: ExecuteTurn, rolls: readonly number[]) {
  const actor = built.world.combatants.find((each) => each.combatantId === turn.actorId);
  if (actor === undefined) throw new Error("no actor");
  const validation = validateExecuteTurn(turn, actor, built.world);
  if (!validation.valid) {
    throw new Error(
      `fixture turn is illegal: ${validation.rejections.map((r) => r.reason).join()}`,
    );
  }
  return applyTurn({
    world: built.world,
    actorId: turn.actorId,
    turn,
    plan: validation.plan,
    context: { statBlocks: built.statBlocks },
    rng: scripted(rolls),
  });
}

describe("applyTurn", () => {
  it("applies damage on a hit and leaves the input world untouched", () => {
    // Guard AC 16; scimitar +4 needs a 12. Roll 18, then 1d6 -> 4 (+2 = 6).
    const { world, effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [
      d20Exactly(18),
      0.5,
    ]);

    expect(effect.attacks).toHaveLength(1);
    expect(effect.attacks[0]?.outcome).toBe("hit");
    expect(effect.damageDealt).toBe(6);

    const after = world.combatants.find((each) => each.combatantId === "guard_1");
    const before = built.world.combatants.find((each) => each.combatantId === "guard_1");
    expect(after?.currentHp).toBe((before?.currentHp ?? 0) - 6);
    expect(before?.currentHp).toBe(before?.maxHp);
  });

  it("deals no damage on a miss", () => {
    const { effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [d20Exactly(3)]);

    expect(effect.attacks[0]?.outcome).toBe("miss");
    expect(effect.damageDealt).toBe(0);
  });

  it("doubles only the damage dice on a critical hit", () => {
    // Natural 20, then two d6 at 0.5 -> 4 each, plus the +2 modifier once.
    const { effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [
      d20Exactly(20),
      0.5,
      0.5,
    ]);

    expect(effect.attacks[0]?.outcome).toBe("critical_hit");
    expect(effect.damageDealt).toBe(10);
  });

  it("kills a monster outright at 0 HP rather than downing it", () => {
    const wounded = {
      ...built.world,
      combatants: built.world.combatants.map((each) =>
        each.combatantId === "guard_1" ? { ...each, currentHp: 3 } : each,
      ),
    };
    const turn = attack("goblin_1", "guard_1", "scimitar");
    const actor = wounded.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const validation = validateExecuteTurn(turn, actor, wounded);
    if (!validation.valid) throw new Error("fixture turn is illegal");

    const { world, effect } = applyTurn({
      world: wounded,
      actorId: "goblin_1",
      turn,
      plan: validation.plan,
      context: { statBlocks: built.statBlocks },
      rng: scripted([d20Exactly(18), 0.5]),
    });

    expect(effect.killed).toEqual(["guard_1"]);
    expect(world.combatants.find((each) => each.combatantId === "guard_1")?.status).toBe("dead");
  });

  it("flags a non-attack action as mechanically inert", () => {
    const dodge: ExecuteTurn = {
      actorId: "goblin_1",
      mainAction: { actionType: "dodge" },
      tacticalRationaleEnglish: "Test fixture.",
    };
    const { effect } = resolve(dodge, []);

    expect(effect.nonAttackAction).toBe(true);
    expect(effect.attacks).toHaveLength(0);
  });

  it("records an action the actor does not own instead of throwing", () => {
    // The validator resolves ranges from a world-wide map and never checks that
    // an actionId belongs to the actor, so this turn is legal but unresolvable.
    const foreign = attack("goblin_1", "guard_1", "greatclub");
    const actor = built.world.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const validation = validateExecuteTurn(foreign, actor, built.world);
    if (!validation.valid) throw new Error("expected the engine to accept a foreign actionId");

    const { effect } = applyTurn({
      world: built.world,
      actorId: "goblin_1",
      turn: foreign,
      plan: validation.plan,
      context: { statBlocks: built.statBlocks },
      rng: scripted([]),
    });

    expect(effect.unresolvedActionIds).toEqual(["greatclub"]);
    expect(effect.attacks).toHaveLength(0);
  });

  it("moves the actor to the last segment's destination", () => {
    const move: ExecuteTurn = {
      actorId: "goblin_2",
      movement: [{ destinationTile: [4, 8], pathType: "direct" }],
      mainAction: { actionType: "dodge" },
      tacticalRationaleEnglish: "Test fixture.",
    };
    const { world, effect } = resolve(move, []);

    expect(world.combatants.find((each) => each.combatantId === "goblin_2")?.position).toEqual([
      4, 8,
    ]);
    expect(effect.movedFeet).toBe(5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- resolve`
Expected: FAIL — cannot resolve `./resolve.js`.

- [ ] **Step 3: Implement the resolver**

Create `tools/sim/src/engine/resolve.ts`:

```ts
// Applies a turn the rules engine has already validated. This is the sim's
// stand-in for the server's turn pipeline (step 8), and it is the only place in
// the package where combat state changes.
//
// It decides no legality: `validateExecuteTurn` has already run, and this file
// never second-guesses it. What it owns is sequencing — move, swing, damage,
// die — plus the arithmetic inputs the engine cannot supply, because
// `resolveAttack` needs an attack bonus and `Combatant` has no such field.
//
// Deliberately NOT modelled, all of them RULES_REFERENCE.md section 8 gaps the
// sim must not invent around: opportunity attacks, monster traits and reactions
// (Pack Tactics, Nimble Escape, Undead Fortitude, Parry), and conditional
// damage riders. Most consequentially, Dodge has no mechanical effect, because
// the engine models no dodging state — `TurnEffect.nonAttackAction` exists so
// no report reads a win rate without that in view.
import type { CombatWorld, Rng, TurnPlan } from "@ai-dm/rules-engine";
import { applyDamage, coverAgainst, resolveAttack, roll } from "@ai-dm/rules-engine";
import type { AttackOutcome, CoverLevel } from "@ai-dm/rules-engine";
import type {
  Combatant,
  DamageRoll,
  EntityStatus,
  ExecuteTurn,
  MonsterAttack,
  MonsterStatBlock,
} from "@ai-dm/schemas";

export interface ResolveContext {
  /** By `combatantId`. Supplies attack bonuses and damage dice. */
  statBlocks: ReadonlyMap<string, MonsterStatBlock>;
}

export interface AttackRecord {
  attackerId: string;
  targetId: string;
  actionId: string;
  outcome: AttackOutcome;
  cover: CoverLevel;
  damage: number;
  targetStatusAfter: EntityStatus;
}

export interface TurnEffect {
  attacks: readonly AttackRecord[];
  damageDealt: number;
  killed: readonly string[];
  movedFeet: number;
  /** Dodge, Dash, Hide and friends. Legal, but inert in this harness. */
  nonAttackAction: boolean;
  /**
   * Action ids the engine accepted but the actor's stat block does not contain.
   * `validateExecuteTurn` resolves ranges from a world-wide map and never checks
   * ownership, so this is reachable — and worth counting rather than crashing on.
   */
  unresolvedActionIds: readonly string[];
}

export interface ApplyTurnInput {
  world: CombatWorld;
  actorId: string;
  turn: ExecuteTurn;
  /** From `validateExecuteTurn`. Movement and economy are taken from here. */
  plan: TurnPlan;
  context: ResolveContext;
  rng: Rng;
}

export interface ApplyTurnResult {
  world: CombatWorld;
  effect: TurnEffect;
}

interface Swing {
  targetId: string;
  actionId: string | undefined;
}

function combatantOf(world: CombatWorld, combatantId: string): Combatant {
  const found = world.combatants.find((each) => each.combatantId === combatantId);
  if (found === undefined) throw new Error(`No combatant ${combatantId} in this encounter`);
  return found;
}

function replace(world: CombatWorld, updated: Combatant): CombatWorld {
  return {
    ...world,
    combatants: world.combatants.map((each) =>
      each.combatantId === updated.combatantId ? updated : each,
    ),
  };
}

/**
 * The attack a swing refers to. An absent `actionId` means the actor's first
 * listed attack — matching the validator, which falls back to the actor's melee
 * reach for the same case.
 */
function attackFor(
  statBlock: MonsterStatBlock,
  actionId: string | undefined,
): MonsterAttack | undefined {
  if (actionId === undefined) return statBlock.actions[0];
  return statBlock.actions.find((action) => action.actionId === actionId);
}

/** Dice when the roll has them, the printed average when it is flat damage. */
function damageFrom(damage: DamageRoll, critical: boolean, rng: Rng): number {
  if (damage.diceNotation === undefined) return damage.averageDamage;
  return roll(damage.diceNotation, rng, { critical }).total;
}

/** The swings this turn proposes, in the order the engine budgeted them. */
function swingsOf(turn: ExecuteTurn): Swing[] {
  if (turn.mainAction.actionType !== "attack") return [];

  const main = (turn.mainAction.targetIds ?? []).map((targetId): Swing => ({
    targetId,
    ...(turn.mainAction.actionId === undefined ? {} : { actionId: turn.mainAction.actionId }),
  }));
  const extra = (turn.extraAttacks ?? []).map((each): Swing => ({
    targetId: each.targetId,
    actionId: each.actionId,
  }));
  return [...main, ...extra];
}

export function applyTurn(input: ApplyTurnInput): ApplyTurnResult {
  const { turn, plan, context, rng } = input;

  const statBlock = context.statBlocks.get(input.actorId);
  if (statBlock === undefined) throw new Error(`No stat block for ${input.actorId}`);

  // --- Movement and economy ------------------------------------------------
  const finalSegment = plan.segments[plan.segments.length - 1];
  const startingActor = combatantOf(input.world, input.actorId);
  let world = replace(input.world, {
    ...startingActor,
    ...(finalSegment === undefined ? {} : { position: finalSegment.destinationTile }),
    actionEconomy: plan.economyAfter,
    spellSlots: plan.spellSlotsAfter,
  });

  // --- Attacks -------------------------------------------------------------
  const attacks: AttackRecord[] = [];
  const killed: string[] = [];
  const unresolvedActionIds: string[] = [];
  let damageDealt = 0;

  for (const swing of swingsOf(turn)) {
    const attack = attackFor(statBlock, swing.actionId);
    if (attack === undefined) {
      unresolvedActionIds.push(swing.actionId ?? "<none>");
      continue;
    }

    // Read fresh each swing: an earlier swing may have moved a target's HP, and
    // cover depends on who is still standing between the two.
    const attacker = combatantOf(world, input.actorId);
    const target = combatantOf(world, swing.targetId);
    if (target.status !== "alive" && target.status !== "unconscious") continue;

    const cover = coverAgainst(attacker, target, world);
    // The validator already rejects full cover, so this cannot be "full" here.
    const result = resolveAttack(
      { attackBonus: attack.attackBonus, targetArmorClass: target.armorClass, cover },
      rng,
    );

    let damage = 0;
    let statusAfter: EntityStatus = target.status;

    if (result.hit) {
      const critical = result.outcome === "critical_hit";
      damage = damageFrom(attack.damage, critical, rng);
      for (const extra of attack.extraDamage) damage += damageFrom(extra, critical, rng);

      // Every combatant here is built from a monster stat block and so has no
      // `characterId`: it dies at 0 HP instead of rolling death saves. That
      // keeps the sim off the death-save path, which the engine does not
      // implement (RULES_REFERENCE.md section 8).
      const applied = applyDamage(
        { currentHp: target.currentHp, maxHp: target.maxHp, tempHp: target.tempHp },
        damage,
        { diesAtZeroHp: target.characterId === undefined },
      );
      statusAfter = applied.status;
      if (applied.status === "dead") killed.push(target.combatantId);

      world = replace(world, {
        ...target,
        currentHp: applied.hitPoints.currentHp,
        tempHp: applied.hitPoints.tempHp,
        status: applied.status,
      });
      damageDealt += damage;
    }

    attacks.push({
      attackerId: input.actorId,
      targetId: swing.targetId,
      actionId: attack.actionId,
      outcome: result.outcome,
      cover,
      damage,
      targetStatusAfter: statusAfter,
    });
  }

  return {
    world,
    effect: {
      attacks,
      damageDealt,
      killed,
      movedFeet: plan.totalMovementFeet,
      nonAttackAction: turn.mainAction.actionType !== "attack",
      unresolvedActionIds,
    },
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- resolve`
Expected: PASS, 7 tests.

If the critical-hit test disagrees, re-read `roll` in `packages/rules-engine/src/dice/index.ts`: it doubles the dice count and adds the modifier once. If the damage numbers disagree, check `data/srd/monsters/guard.json` for the guard's actual AC and `goblin_warrior.json` for the scimitar's bonus, and adjust the expected values — do not adjust the implementation to fit a guessed stat block.

- [ ] **Step 5: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/engine
git add tools/sim
git commit -m "feat(sim): resolve a validated turn into a next-state world

Composes rules-engine primitives; decides no legality. Declares its fidelity
gaps in the module header, and counts action ids the engine accepted but the
actor's stat block does not contain rather than throwing on them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Report the validator finding**

`validateExecuteTurn` resolves an action's range from `world.actionRangesFeet`, which is world-wide, and never checks that the `actionId` belongs to the actor. A goblin proposing the ogre's `greatclub` therefore passes validation. Do **not** fix it — `packages/rules-engine` behaviour is out of scope for this step. Write the finding into the task's completion notes so it reaches the user, and confirm `TurnEffect.unresolvedActionIds` counts it.

---

### Task 6: The scripted baseline policy

Drives the party in every run and both sides in the control arm. It must be strictly better than `deterministicFallback` — it moves — or "win rate vs baseline" measures nothing.

**Files:**

- Create: `tools/sim/src/engine/policy.ts`
- Test: `tools/sim/src/engine/policy.test.ts`

**Interfaces:**

- Consumes: `BuiltScenario` (Task 3).
- Produces: `scriptedTurn(input: ScriptedPolicyInput): DecidedTurn | null`, `DecidedTurn { turn: ExecuteTurn; plan: TurnPlan }`.

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/engine/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildScenario } from "../scenarios/build.js";
import { MELEE_BRAWL } from "../scenarios/melee-brawl.js";
import { RANGED_APPROACH } from "../scenarios/ranged-approach.js";
import { scriptedTurn } from "./policy.js";

describe("scriptedTurn", () => {
  it("attacks an adjacent enemy without moving", () => {
    const built = buildScenario(MELEE_BRAWL);
    const decided = scriptedTurn({
      world: built.world,
      actorId: "goblin_1",
      availableActions: built.availableActions.get("goblin_1") ?? [],
    });

    expect(decided?.turn.mainAction.actionType).toBe("attack");
    expect(decided?.turn.mainAction.targetIds).toEqual(["guard_1"]);
    expect(decided?.turn.movement ?? []).toHaveLength(0);
  });

  it("uses a ranged action when the enemy is far away", () => {
    const built = buildScenario(RANGED_APPROACH);
    const decided = scriptedTurn({
      world: built.world,
      actorId: "goblin_1",
      availableActions: built.availableActions.get("goblin_1") ?? [],
    });

    expect(decided?.turn.mainAction.actionType).toBe("attack");
    expect(decided?.turn.mainAction.actionId).toBe("shortbow");
  });

  it("moves into contact when no action reaches from where it stands", () => {
    const built = buildScenario(RANGED_APPROACH);
    // Melee only: the goblin must close the distance to act at all.
    const decided = scriptedTurn({
      world: built.world,
      actorId: "goblin_1",
      availableActions: [{ actionId: "scimitar", name: "Scimitar" }],
    });

    expect(decided?.turn.movement?.length).toBeGreaterThan(0);
    expect(decided?.plan.totalMovementFeet).toBeGreaterThan(0);
  });

  it("is deterministic — the same board yields the same turn", () => {
    const built = buildScenario(RANGED_APPROACH);
    const input = {
      world: built.world,
      actorId: "goblin_1",
      availableActions: built.availableActions.get("goblin_1") ?? [],
    };

    expect(scriptedTurn(input)?.turn).toEqual(scriptedTurn(input)?.turn);
  });

  it("returns a plan the engine validated, never an unchecked turn", () => {
    const built = buildScenario(MELEE_BRAWL);
    const decided = scriptedTurn({
      world: built.world,
      actorId: "goblin_1",
      availableActions: built.availableActions.get("goblin_1") ?? [],
    });

    expect(decided?.plan.economyAfter.actionUsed).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- policy`
Expected: FAIL — cannot resolve `./policy.js`.

- [ ] **Step 3: Implement**

Create `tools/sim/src/engine/policy.ts`:

```ts
// The scripted baseline. It drives the party in every run, and both sides in the
// control arm that "win rate vs baseline" is measured against.
//
// It is deliberately one notch smarter than `deterministicFallback` from
// `@ai-dm/agents`: it moves. A baseline that stands still would make any model
// that walks look good, which is not a finding.
//
// It is not clever. It picks the nearest living enemy, prefers an action that
// already reaches, and otherwise steps to the closest square from which it can
// attack. Every candidate goes through `validateExecuteTurn` — this file never
// decides a turn is legal.
import type { AvailableAction } from "@ai-dm/agents";
import type { CombatWorld, TurnPlan } from "@ai-dm/rules-engine";
import { footprintDistanceFeet, validateExecuteTurn } from "@ai-dm/rules-engine";
import type { Combatant, ExecuteTurn, Faction, Tile } from "@ai-dm/schemas";

export interface ScriptedPolicyInput {
  world: CombatWorld;
  actorId: string;
  availableActions: readonly AvailableAction[];
}

export interface DecidedTurn {
  turn: ExecuteTurn;
  plan: TurnPlan;
}

const ATTACK_RATIONALE = "Baseline: attacking the nearest reachable enemy.";
const ADVANCE_RATIONALE = "Baseline: closing on the nearest enemy, then attacking.";
const DODGE_RATIONALE = "Baseline: nothing reachable, so taking the Dodge action.";

/** Policy, not rules — 5e lets you attack an ally, so the engine has no opinion. */
function opposes(actor: Faction, other: Faction): boolean {
  if (actor === "party") return other === "hostile";
  if (actor === "hostile") return other === "party";
  return false;
}

function actorIn(world: CombatWorld, actorId: string): Combatant {
  const found = world.combatants.find((each) => each.combatantId === actorId);
  if (found === undefined) throw new Error(`No combatant ${actorId} in this encounter`);
  return found;
}

/** Nearest first; ties broken on id so the same board always yields the same turn. */
function enemiesByDistance(actor: Combatant, world: CombatWorld): Combatant[] {
  const actorSpace = { anchor: actor.position, size: actor.size };
  return world.combatants
    .filter((each) => each.status === "alive" && opposes(actor.faction, each.faction))
    .map((each) => ({
      combatant: each,
      distanceFeet: footprintDistanceFeet(actorSpace, { anchor: each.position, size: each.size }),
    }))
    .sort((left, right) =>
      left.distanceFeet !== right.distanceFeet
        ? left.distanceFeet - right.distanceFeet
        : left.combatant.combatantId.localeCompare(right.combatant.combatantId),
    )
    .map((each) => each.combatant);
}

function attackTurn(
  actorId: string,
  targetId: string,
  actionId: string,
  movement?: Tile,
): ExecuteTurn {
  return {
    actorId,
    ...(movement === undefined
      ? {}
      : { movement: [{ destinationTile: movement, pathType: "direct" as const }] }),
    mainAction: { actionType: "attack", actionId, targetIds: [targetId] },
    tacticalRationaleEnglish: movement === undefined ? ATTACK_RATIONALE : ADVANCE_RATIONALE,
  };
}

/**
 * Squares to try stepping to, nearest to the target first. A ring around the
 * target's anchor at a few radii, deduplicated and ordered deterministically —
 * enough for a baseline, and bounded so a big map cannot make this quadratic.
 */
function approachTiles(target: Combatant, world: CombatWorld): Tile[] {
  const [tx, ty] = target.position;
  const tiles: Tile[] = [];
  for (let radius = 1; radius <= 3; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tile: Tile = [tx + dx, ty + dy];
        if (tile[0] < 0 || tile[1] < 0) continue;
        if (tile[0] >= world.grid.width || tile[1] >= world.grid.height) continue;
        tiles.push(tile);
      }
    }
  }
  return tiles;
}

export function scriptedTurn(input: ScriptedPolicyInput): DecidedTurn | null {
  const actor = actorIn(input.world, input.actorId);
  const enemies = enemiesByDistance(actor, input.world);
  const actionIds = input.availableActions.map((action) => action.actionId);

  // 1. Attack from where we stand. Longest-reaching action first, so a bow is
  //    tried before a scimitar at distance and the first legal hit wins.
  const byReach = [...actionIds].sort(
    (left, right) =>
      (input.world.actionRangesFeet?.[right] ?? actor.reachFeet) -
      (input.world.actionRangesFeet?.[left] ?? actor.reachFeet),
  );

  for (const enemy of enemies) {
    for (const actionId of byReach) {
      const turn = attackTurn(input.actorId, enemy.combatantId, actionId);
      const validation = validateExecuteTurn(turn, actor, input.world);
      if (validation.valid) return { turn, plan: validation.plan };
    }
  }

  // 2. Step into contact, then attack. First legal combination wins; candidates
  //    are ordered nearest-target-first, so this is a charge, not a wander.
  for (const enemy of enemies) {
    for (const tile of approachTiles(enemy, input.world)) {
      for (const actionId of byReach) {
        const turn = attackTurn(input.actorId, enemy.combatantId, actionId, tile);
        const validation = validateExecuteTurn(turn, actor, input.world);
        if (validation.valid) return { turn, plan: validation.plan };
      }
    }
  }

  // 3. Nothing worked. Dodge is inert in this harness (see resolve.ts) but it is
  //    a legal turn, which keeps the encounter advancing.
  const dodge: ExecuteTurn = {
    actorId: input.actorId,
    mainAction: { actionType: "dodge" },
    tacticalRationaleEnglish: DODGE_RATIONALE,
  };
  const validation = validateExecuteTurn(dodge, actor, input.world);
  return validation.valid ? { turn: dodge, plan: validation.plan } : null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- policy`
Expected: PASS, 5 tests.

- [ ] **Step 5: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/engine
git add tools/sim
git commit -m "feat(sim): scripted baseline policy

Moves into contact rather than standing still, so win-rate-vs-baseline
measures something. Every candidate turn goes through validateExecuteTurn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The encounter loop

**Files:**

- Create: `tools/sim/src/engine/encounter.ts`
- Test: `tools/sim/src/engine/encounter.test.ts`

**Interfaces:**

- Consumes: `applyTurn` (Task 5), `scriptedTurn` (Task 6), `BuiltScenario` (Task 3), `seeded` (Task 2).
- Produces:
  - `TurnDecider = (input: DecideInput) => Promise<DecidedTurn | null>`
  - `DecideInput { world, actorId, availableActions, round }`
  - `TurnLogEntry { round, actorId, faction, effect }`
  - `EncounterResult { winner: Faction | null; rounds: number; log: readonly TurnLogEntry[]; damageByFaction: Record<Faction, number>; finalWorld: CombatWorld }`
  - `runEncounter(input: RunEncounterInput): Promise<EncounterResult>`

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/engine/encounter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildScenario } from "../scenarios/build.js";
import { MELEE_BRAWL } from "../scenarios/melee-brawl.js";
import { seeded } from "../rng.js";
import { runEncounter } from "./encounter.js";
import { scriptedTurn } from "./policy.js";

function scriptedRun(seed: number) {
  const built = buildScenario(MELEE_BRAWL);
  return runEncounter({
    scenario: built,
    rng: seeded(seed),
    // eslint-disable-next-line @typescript-eslint/require-await
    deciderFor: () => async (input) =>
      scriptedTurn({
        world: input.world,
        actorId: input.actorId,
        availableActions: input.availableActions,
      }),
  });
}

describe("runEncounter", () => {
  it("plays to a decision and names a winner", async () => {
    const result = await scriptedRun(1);

    expect(result.winner === "party" || result.winner === "hostile").toBe(true);
    expect(result.rounds).toBeGreaterThan(0);
    expect(result.log.length).toBeGreaterThan(0);
  });

  it("is exactly reproducible for one seed", async () => {
    const [a, b] = await Promise.all([scriptedRun(7), scriptedRun(7)]);

    expect(a.winner).toBe(b.winner);
    expect(a.rounds).toBe(b.rounds);
    expect(a.log).toEqual(b.log);
  });

  it("diverges on a different seed", async () => {
    const [a, b] = await Promise.all([scriptedRun(1), scriptedRun(2)]);

    expect(a.log).not.toEqual(b.log);
  });

  it("stops at maxRounds when neither side can finish", async () => {
    const built = buildScenario(MELEE_BRAWL);
    const result = await runEncounter({
      scenario: { ...built, maxRounds: 2 },
      rng: seeded(3),
      // Everyone dodges forever, so nobody can ever win.
      // eslint-disable-next-line @typescript-eslint/require-await
      deciderFor: () => async () => null,
    });

    expect(result.rounds).toBe(2);
    expect(result.winner).toBeNull();
  });

  it("skips combatants that are no longer alive", async () => {
    const result = await scriptedRun(5);
    const dead = new Set<string>();

    for (const entry of result.log) {
      expect(dead.has(entry.actorId)).toBe(false);
      for (const killedId of entry.effect.killed) dead.add(killedId);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- encounter`
Expected: FAIL — cannot resolve `./encounter.js`.

- [ ] **Step 3: Implement**

Create `tools/sim/src/engine/encounter.ts`:

```ts
// Round and turn sequencing. Knows nothing about models: a decider is a function
// from a board to a validated turn, and the caller decides whether that is the
// tactical agent or the scripted policy.
import type { AvailableAction } from "@ai-dm/agents";
import type { CombatWorld, Rng } from "@ai-dm/rules-engine";
import { startTurn } from "@ai-dm/rules-engine";
import type { Faction } from "@ai-dm/schemas";
import type { BuiltScenario } from "../scenarios/types.js";
import type { DecidedTurn } from "./policy.js";
import type { TurnEffect } from "./resolve.js";
import { applyTurn } from "./resolve.js";

export interface DecideInput {
  world: CombatWorld;
  actorId: string;
  availableActions: readonly AvailableAction[];
  round: number;
}

/** Returns null when the actor has no legal turn at all; the encounter moves on. */
export type TurnDecider = (input: DecideInput) => Promise<DecidedTurn | null>;

export interface TurnLogEntry {
  round: number;
  actorId: string;
  faction: Faction;
  effect: TurnEffect;
}

export interface EncounterResult {
  /** Null when `maxRounds` ran out with both sides still standing. */
  winner: Faction | null;
  rounds: number;
  log: readonly TurnLogEntry[];
  damageByFaction: Record<Faction, number>;
  finalWorld: CombatWorld;
}

export interface RunEncounterInput {
  scenario: BuiltScenario;
  rng: Rng;
  deciderFor: (faction: Faction) => TurnDecider;
}

const FIGHTING_FACTIONS: readonly Faction[] = ["party", "hostile"];

function livingFactions(world: CombatWorld): Set<Faction> {
  return new Set(
    world.combatants.filter((each) => each.status === "alive").map((each) => each.faction),
  );
}

/** The last faction standing, or null while both are still in it. */
function winnerOf(world: CombatWorld): Faction | null {
  const living = livingFactions(world);
  const remaining = FIGHTING_FACTIONS.filter((faction) => living.has(faction));
  return remaining.length === 1 ? (remaining[0] ?? null) : null;
}

export async function runEncounter(input: RunEncounterInput): Promise<EncounterResult> {
  const { scenario } = input;
  let world = scenario.world;
  const log: TurnLogEntry[] = [];
  const damageByFaction: Record<Faction, number> = { party: 0, hostile: 0, neutral: 0 };

  let round = 0;
  let winner: Faction | null = null;

  while (round < scenario.maxRounds && winner === null) {
    round += 1;

    for (const actorId of scenario.turnOrder) {
      const actor = world.combatants.find((each) => each.combatantId === actorId);
      if (actor === undefined || actor.status !== "alive") continue;

      // A fresh action economy is the start of a turn. Doing it here rather than
      // in the decider keeps every decider honest about its budget.
      world = {
        ...world,
        combatants: world.combatants.map((each) =>
          each.combatantId === actorId ? { ...each, actionEconomy: startTurn() } : each,
        ),
      };

      const decided = await input.deciderFor(actor.faction)({
        world,
        actorId,
        availableActions: scenario.availableActions.get(actorId) ?? [],
        round,
      });
      if (decided === null) continue;

      const applied = applyTurn({
        world,
        actorId,
        turn: decided.turn,
        plan: decided.plan,
        context: { statBlocks: scenario.statBlocks },
        rng: input.rng,
      });

      world = applied.world;
      damageByFaction[actor.faction] += applied.effect.damageDealt;
      log.push({ round, actorId, faction: actor.faction, effect: applied.effect });

      winner = winnerOf(world);
      if (winner !== null) break;
    }
  }

  return { winner, rounds: round, log, damageByFaction, finalWorld: world };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- encounter`
Expected: PASS, 5 tests.

- [ ] **Step 5: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/engine
git add tools/sim
git commit -m "feat(sim): encounter loop with fixed turn order and seeded dice

A decider is a function from a board to a validated turn, so the same loop
drives the scripted control arm and the model.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The scripted port and the seeded defect schedule

This is what makes the smoke run exercise first-try, retry and fallback in known proportions instead of merely proving the process starts.

**Files:**

- Create: `tools/sim/src/smoke/defects.ts`, `tools/sim/src/smoke/port.ts`
- Test: `tools/sim/src/smoke/port.test.ts`

**Interfaces:**

- Consumes: `createFakePort`, `adapterFailure`, `adapterSuccess` from `@ai-dm/agents`; `scripted`/`seeded` (Task 2).
- Produces:
  - `DefectKind = "none" | "schema_validation_failed" | "no_tool_call" | "illegal_target" | "provider_error"`
  - `nextDefect(rng: Rng): DefectKind`
  - `ScriptedPort extends LanguageModelPort { load(script: FakePortScript): void; readonly calls: readonly FakePortCall[] }`
  - `createScriptedPort(): ScriptedPort`
  - `SMOKE_USAGE: TokenUsage`

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/smoke/port.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { adapterFailure, adapterSuccess } from "@ai-dm/agents";
import type { ModelSpec } from "@ai-dm/agents";
import { z } from "zod";
import { seeded } from "../rng.js";
import { nextDefect } from "./defects.js";
import { createScriptedPort } from "./port.js";

const SPEC: ModelSpec = { provider: "google", modelId: "fake-model" };
const REQUEST = {
  prompt: { system: "s", semiStatic: [], dynamic: "d" },
  schema: z.object({ ok: z.boolean() }),
  toolName: "execute_turn",
  toolDescription: "Take a turn.",
};

describe("nextDefect", () => {
  it("is deterministic for a seed", () => {
    const draw = (): string[] => {
      const rng = seeded(42);
      return Array.from({ length: 20 }, () => nextDefect(rng));
    };

    expect(draw()).toEqual(draw());
  });

  it("produces every kind across a long stream", () => {
    const rng = seeded(11);
    const seen = new Set(Array.from({ length: 500 }, () => nextDefect(rng)));

    expect(seen).toEqual(
      new Set([
        "none",
        "schema_validation_failed",
        "no_tool_call",
        "illegal_target",
        "provider_error",
      ]),
    );
  });
});

describe("createScriptedPort", () => {
  it("replays a freshly loaded script", async () => {
    const port = createScriptedPort();
    port.load({ structured: [adapterSuccess({ value: { ok: true }, usage: SMOKE })] });

    const result = await port.generateStructured(SPEC, REQUEST);

    expect(result.ok).toBe(true);
  });

  it("refills rather than exhausting across turns", async () => {
    const port = createScriptedPort();
    for (let turn = 0; turn < 3; turn += 1) {
      port.load({ structured: [adapterSuccess({ value: { ok: true }, usage: SMOKE })] });
      const result = await port.generateStructured(SPEC, REQUEST);
      expect(result.ok).toBe(true);
    }
  });

  it("accumulates calls across every load", async () => {
    const port = createScriptedPort();
    for (let turn = 0; turn < 3; turn += 1) {
      port.load({ structured: [adapterFailure("provider_error", "boom")] });
      await port.generateStructured(SPEC, REQUEST);
    }

    expect(port.calls).toHaveLength(3);
    expect(port.calls.every((call) => call.request.toolName === "execute_turn")).toBe(true);
  });

  it("still throws when a loaded script runs out mid-turn", async () => {
    const port = createScriptedPort();
    port.load({ structured: [] });

    await expect(port.generateStructured(SPEC, REQUEST)).rejects.toThrow("exhausted");
  });
});

const SMOKE = { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 };
```

Check `packages/agents/src/providers/prompt.ts` for the real `LayeredPrompt` field names and correct `REQUEST.prompt` to match before running.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- port`
Expected: FAIL — cannot resolve `./defects.js`.

- [ ] **Step 3: Write the defect schedule**

Create `tools/sim/src/smoke/defects.ts`:

```ts
// What the fake model does wrong, and how often. Drawn from the run's seeded
// RNG so a smoke run exercises first-try, retry and fallback in proportions
// that are fixed for a given seed — which is what lets the smoke test assert
// exact counts and so pin the metrics arithmetic, rather than merely proving
// the process starts.
//
// The weights are a fixture, not a claim about any real model. Nothing here may
// be read as a measurement.
import type { Rng } from "@ai-dm/rules-engine";
import type { TokenUsage } from "@ai-dm/agents";

export type DefectKind =
  "none" | "schema_validation_failed" | "no_tool_call" | "illegal_target" | "provider_error";

interface Weighted {
  kind: DefectKind;
  /** Cumulative upper bound in [0, 1]. The last entry must be exactly 1. */
  upTo: number;
}

const SCHEDULE: readonly Weighted[] = [
  { kind: "none", upTo: 0.75 },
  { kind: "illegal_target", upTo: 0.85 },
  { kind: "schema_validation_failed", upTo: 0.92 },
  { kind: "no_tool_call", upTo: 0.97 },
  { kind: "provider_error", upTo: 1 },
];

/** Consumes exactly one draw, so the schedule never desynchronises the dice. */
export function nextDefect(rng: Rng): DefectKind {
  const value = rng();
  for (const entry of SCHEDULE) {
    if (value < entry.upTo) return entry.kind;
  }
  // Only reachable if rng() returned exactly 1, which the contract excludes.
  return "provider_error";
}

/** Plausible token counts for a tactical turn. A fixture, not a measurement. */
export const SMOKE_USAGE: TokenUsage = {
  promptTokens: 1400,
  completionTokens: 90,
  totalTokens: 1490,
};
```

- [ ] **Step 4: Write the refillable port**

Create `tools/sim/src/smoke/port.ts`:

```ts
// `createFakePort` takes its whole script at construction, but the number of
// model calls in an encounter is not known ahead of time, so one script is
// exhausted mid-run. This wraps it: `load` swaps in a fresh fake for each turn,
// and `calls` still accumulates across all of them.
//
// The run loop loads exactly two responses per turn. The tactical agent
// provably never makes a third call — `packages/agents` has a test pinning it —
// so a third call here is a bug worth the exhaustion error it earns.
import { createFakePort } from "@ai-dm/agents";
import type {
  AdapterResult,
  FakePortCall,
  FakePortScript,
  LanguageModelPort,
  ModelSpec,
  StreamChunk,
  StructuredOutput,
  StructuredRequest,
  TextOutput,
  TextRequest,
} from "@ai-dm/agents";

export interface ScriptedPort extends LanguageModelPort {
  /** Replace the script. Calls already recorded are kept. */
  load(script: FakePortScript): void;
  readonly calls: readonly FakePortCall[];
}

export function createScriptedPort(): ScriptedPort {
  const history: FakePortCall[] = [];
  let inner = createFakePort();

  return {
    load(script: FakePortScript): void {
      history.push(...inner.calls);
      inner = createFakePort(script);
    },

    get calls(): readonly FakePortCall[] {
      return [...history, ...inner.calls];
    },

    generateStructured<T>(
      spec: ModelSpec,
      request: StructuredRequest<T>,
    ): Promise<AdapterResult<StructuredOutput<T>>> {
      return inner.generateStructured(spec, request);
    },

    generateText(spec: ModelSpec, request: TextRequest): Promise<AdapterResult<TextOutput>> {
      return inner.generateText(spec, request);
    },

    streamText(spec: ModelSpec, request: TextRequest): AsyncIterable<StreamChunk> {
      return inner.streamText(spec, request);
    },
  };
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- port`
Expected: PASS, 6 tests. If `FakePortCall` or `FakePortScript` do not resolve from `@ai-dm/agents`, check `packages/agents/src/providers/index.ts` — it re-exports `testing/fake-port.js`, so both should be available.

- [ ] **Step 6: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/smoke
git add tools/sim
git commit -m "feat(sim): refillable scripted port and seeded defect schedule

Lets the smoke run drive first-try, retry and fallback in proportions fixed by
the seed, so CI can assert exact counts instead of just a clean exit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Turn records, metrics and pricing

**Files:**

- Create: `tools/sim/src/run/records.ts`, `tools/sim/src/run/metrics.ts`, `tools/sim/src/pricing.ts`
- Test: `tools/sim/src/run/metrics.test.ts`, `tools/sim/src/pricing.test.ts`

**Interfaces:**

- Consumes: `TurnProposalResult` from `@ai-dm/agents`, `CallTiming` from `@ai-dm/agents`.
- Produces:
  - `TurnRecord` (fields listed in Step 3)
  - `recordFrom(input: RecordInput): TurnRecord`
  - `percentile(values: readonly number[], p: number): number`
  - `LegalitySummary`, `summariseLegality(records): LegalitySummary`
  - `LatencySummary`, `summariseLatency(records): LatencySummary`
  - `UsageSummary`, `summariseUsage(records): UsageSummary`
  - `ModelPricing`, `MODEL_PRICING`, `PRICING_TABLE_DATE`, `costUsd(modelId, usage): number | null`

- [ ] **Step 1: Write the failing metrics test**

Create `tools/sim/src/run/metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TurnRecord } from "./records.js";
import { percentile, summariseLatency, summariseLegality, summariseUsage } from "./metrics.js";

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    armId: "fake@medium",
    scenarioId: "melee-brawl",
    seed: 1,
    round: 1,
    actorId: "goblin_1",
    outcome: "model",
    attempts: 1,
    rejectionReasons: [],
    adapterErrorCodes: [],
    promptTokens: 1000,
    completionTokens: 50,
    usageComplete: true,
    attemptsMissingUsage: 0,
    durationMs: 100,
    callDurationsMs: [100],
    unresolvedActionIds: [],
    ...overrides,
  };
}

describe("percentile", () => {
  it("uses nearest-rank on sorted values", () => {
    const values = Array.from({ length: 100 }, (_unused, index) => index + 1);

    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
  });

  it("returns 0 for an empty sample rather than NaN", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("ignores input order", () => {
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
  });
});

describe("summariseLegality", () => {
  it("counts each outcome and rates the step-7 bar against retry", () => {
    const records = [
      ...Array.from({ length: 90 }, () => record({ outcome: "model" })),
      ...Array.from({ length: 6 }, () => record({ outcome: "retry" })),
      ...Array.from({ length: 3 }, () => record({ outcome: "fallback" })),
      record({ outcome: "no_legal_turn" }),
    ];

    const summary = summariseLegality(records);

    expect(summary.total).toBe(100);
    expect(summary.firstTry).toBe(90);
    expect(summary.afterRetry).toBe(6);
    expect(summary.fallback).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.firstTryRate).toBeCloseTo(0.9);
    // The exit criterion: legal without needing the fallback.
    expect(summary.legalAfterRetryRate).toBeCloseTo(0.96);
  });

  it("reports zero rates for an empty sample rather than NaN", () => {
    expect(summariseLegality([]).firstTryRate).toBe(0);
  });
});

describe("summariseLatency", () => {
  it("summarises per-turn duration", () => {
    const records = Array.from({ length: 100 }, (_unused, index) =>
      record({ durationMs: index + 1 }),
    );
    const summary = summariseLatency(records);

    expect(summary.p50Ms).toBe(50);
    expect(summary.p95Ms).toBe(95);
    expect(summary.meanMs).toBeCloseTo(50.5);
  });
});

describe("summariseUsage", () => {
  it("averages tokens per turn", () => {
    const summary = summariseUsage([record(), record({ promptTokens: 2000 })]);

    expect(summary.promptTokens).toBe(3000);
    expect(summary.completionTokens).toBe(100);
    expect(summary.tokensPerTurn).toBeCloseTo(1575);
  });

  it("declares incompleteness rather than hiding it", () => {
    const summary = summariseUsage([
      record(),
      record({ usageComplete: false, attemptsMissingUsage: 2 }),
    ]);

    expect(summary.usageComplete).toBe(false);
    expect(summary.attemptsMissingUsage).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- metrics`
Expected: FAIL — cannot resolve `./records.js`.

- [ ] **Step 3: Write the record shape**

Create `tools/sim/src/run/records.ts`:

```ts
// One row per turn, emitted identically by probe mode and encounter mode. Every
// aggregate in the report is a fold over these, so the two modes stay
// comparable and the metrics have exactly one input shape.
import type { CallTiming, TokenUsage, TurnProposalResult } from "@ai-dm/agents";

export type TurnOutcome = "model" | "retry" | "fallback" | "aborted" | "no_legal_turn";

export interface TurnRecord {
  armId: string;
  scenarioId: string;
  seed: number;
  round: number;
  actorId: string;
  outcome: TurnOutcome;
  /** Model calls made. Never more than two — the agent's loop is straight-line. */
  attempts: number;
  /** `TurnRejectionReason` codes from the engine. */
  rejectionReasons: readonly string[];
  /** `AdapterErrorCode` values from the port. */
  adapterErrorCodes: readonly string[];
  promptTokens: number;
  completionTokens: number;
  /** False when any attempt was billed but reported no usage. */
  usageComplete: boolean;
  attemptsMissingUsage: number;
  /** Summed across attempts: what the turn cost in wall-clock. */
  durationMs: number;
  callDurationsMs: readonly number[];
  /** Engine-legal action ids the actor's stat block does not contain. */
  unresolvedActionIds: readonly string[];
}

export interface RecordInput {
  armId: string;
  scenarioId: string;
  seed: number;
  round: number;
  actorId: string;
  result: TurnProposalResult;
  /** The slice of `TimingPort.timings` this turn produced. */
  timings: readonly CallTiming[];
  unresolvedActionIds?: readonly string[];
}

function outcomeOf(result: TurnProposalResult): TurnOutcome {
  return result.ok ? result.source : result.kind;
}

function totals(usage: readonly TokenUsage[]): { prompt: number; completion: number } {
  return usage.reduce(
    (accumulator, each) => ({
      prompt: accumulator.prompt + each.promptTokens,
      completion: accumulator.completion + each.completionTokens,
    }),
    { prompt: 0, completion: 0 },
  );
}

export function recordFrom(input: RecordInput): TurnRecord {
  const { result } = input;
  const { prompt, completion } = totals(result.usage);

  // Every model call should have produced one usage entry. Any shortfall is an
  // attempt that was billed and reported nothing — the report says so rather
  // than quietly publishing a low number.
  const attempts = input.timings.length;
  const attemptsMissingUsage = Math.max(0, attempts - result.usage.length);

  return {
    armId: input.armId,
    scenarioId: input.scenarioId,
    seed: input.seed,
    round: input.round,
    actorId: input.actorId,
    outcome: outcomeOf(result),
    attempts,
    rejectionReasons: result.rejections.flatMap((rejection) => rejection.reasons ?? []),
    adapterErrorCodes: result.rejections.flatMap((rejection) =>
      rejection.adapterErrorCode === undefined ? [] : [rejection.adapterErrorCode],
    ),
    promptTokens: prompt,
    completionTokens: completion,
    usageComplete: attemptsMissingUsage === 0,
    attemptsMissingUsage,
    durationMs: input.timings.reduce((sum, timing) => sum + timing.durationMs, 0),
    callDurationsMs: input.timings.map((timing) => timing.durationMs),
    unresolvedActionIds: input.unresolvedActionIds ?? [],
  };
}
```

- [ ] **Step 4: Write the metrics**

Create `tools/sim/src/run/metrics.ts`:

```ts
// Folds over `TurnRecord`. Pure arithmetic, no I/O, so the smoke test can pin
// every number these produce.
import type { TurnRecord } from "./records.js";

/** Nearest-rank, so the result is always an observed value and never interpolated. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

export interface LegalitySummary {
  total: number;
  firstTry: number;
  afterRetry: number;
  fallback: number;
  /** Aborted or no legal turn at all. */
  failed: number;
  firstTryRate: number;
  /**
   * Legal without needing the fallback. This is the number step 7's exit
   * criterion — "legality >= 95% after retry" — is stated against.
   */
  legalAfterRetryRate: number;
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

export function summariseLegality(records: readonly TurnRecord[]): LegalitySummary {
  const count = (outcome: TurnRecord["outcome"]): number =>
    records.filter((record) => record.outcome === outcome).length;

  const total = records.length;
  const firstTry = count("model");
  const afterRetry = count("retry");
  const fallback = count("fallback");

  return {
    total,
    firstTry,
    afterRetry,
    fallback,
    failed: count("aborted") + count("no_legal_turn"),
    firstTryRate: rate(firstTry, total),
    legalAfterRetryRate: rate(firstTry + afterRetry, total),
  };
}

export interface LatencySummary {
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
}

export function summariseLatency(records: readonly TurnRecord[]): LatencySummary {
  const durations = records.map((record) => record.durationMs);
  const sum = durations.reduce((accumulator, value) => accumulator + value, 0);

  return {
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    meanMs: durations.length === 0 ? 0 : sum / durations.length,
  };
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  tokensPerTurn: number;
  /** False when any attempt was billed and reported nothing. */
  usageComplete: boolean;
  attemptsMissingUsage: number;
}

export function summariseUsage(records: readonly TurnRecord[]): UsageSummary {
  const promptTokens = records.reduce((sum, record) => sum + record.promptTokens, 0);
  const completionTokens = records.reduce((sum, record) => sum + record.completionTokens, 0);
  const attemptsMissingUsage = records.reduce(
    (sum, record) => sum + record.attemptsMissingUsage,
    0,
  );

  return {
    promptTokens,
    completionTokens,
    tokensPerTurn: records.length === 0 ? 0 : (promptTokens + completionTokens) / records.length,
    usageComplete: attemptsMissingUsage === 0,
    attemptsMissingUsage,
  };
}
```

- [ ] **Step 5: Run the metrics test and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- metrics`
Expected: PASS, 8 tests.

- [ ] **Step 6: Write the failing pricing test**

Create `tools/sim/src/pricing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MODEL_PRICING, PRICING_TABLE_DATE, costUsd } from "./pricing.js";

describe("costUsd", () => {
  it("prices a known model from the dated table", () => {
    // gemini-3-flash: $0.25 per M input, $1.50 per M output.
    const cost = costUsd("gemini-3-flash", { promptTokens: 1_000_000, completionTokens: 0 });

    expect(cost).toBeCloseTo(0.25);
  });

  it("adds input and output at their separate rates", () => {
    const cost = costUsd("gemini-3-flash", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(1.75);
  });

  it("returns null for an unpriced model instead of guessing zero", () => {
    expect(
      costUsd("some-unreleased-model", { promptTokens: 1000, completionTokens: 10 }),
    ).toBeNull();
  });

  it("carries a table date, so a stale price is visible in the report", () => {
    expect(PRICING_TABLE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(MODEL_PRICING).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- pricing`
Expected: FAIL — cannot resolve `./pricing.js`.

- [ ] **Step 8: Write the pricing table**

Create `tools/sim/src/pricing.ts`:

```ts
// USD per million tokens. Data, dated, with its source named — a price that
// silently goes stale turns a cost comparison into a fiction.
//
// Every figure here is copied from PROJECT_PLAN.md section 2, which records them
// as verified as of August 2026. Adding a model without adding its price is
// safe: `costUsd` returns null and the report prints "unpriced" rather than
// inventing a number.
export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

/** When the figures below were last checked against provider pricing pages. */
export const PRICING_TABLE_DATE = "2026-08-17";

export const MODEL_PRICING: Readonly<Record<string, ModelPricing | undefined>> = {
  "gemini-3-flash": { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5 },
  "gpt-5.4-nano": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.25 },
  "gpt-5.4-mini": { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5 },
  "claude-sonnet-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
};

const PER_MILLION = 1_000_000;

export interface CostInput {
  promptTokens: number;
  completionTokens: number;
}

/** Null when the model has no entry: an unpriced arm must not read as free. */
export function costUsd(modelId: string, usage: CostInput): number | null {
  const pricing = MODEL_PRICING[modelId];
  if (pricing === undefined) return null;

  return (
    (usage.promptTokens / PER_MILLION) * pricing.inputPerMillionUsd +
    (usage.completionTokens / PER_MILLION) * pricing.outputPerMillionUsd
  );
}
```

- [ ] **Step 9: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- pricing`
Expected: PASS, 4 tests.

- [ ] **Step 10: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/run tools/sim/src/pricing.ts tools/sim/src/pricing.test.ts
git add tools/sim
git commit -m "feat(sim): turn records, metric folds and a dated pricing table

costUsd returns null rather than zero for an unpriced model, and usage
summaries carry a completeness flag, so no cost figure is published silently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Config, probe corpus and the two runners

**Files:**

- Create: `tools/sim/src/config.ts`, `tools/sim/src/run/probe.ts`, `tools/sim/src/run/loop.ts`
- Test: `tools/sim/src/run/probe.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2–9.
- Produces:
  - `Arm { armId, spec }`, `ARMS`, `DEFAULT_SEEDS`, `armById(id)`
  - `ProbeState { scenarioId, seed, round, actorId, world, availableActions, statBlocks, turnOrder }`
  - `deriveProbeCorpus(input: { scenarioIds, seeds }): ProbeState[]`
  - `runProbeArm(input: RunProbeArmInput): Promise<TurnRecord[]>`
  - `runEncounterArm(input: RunEncounterArmInput): Promise<{ records: TurnRecord[]; result: EncounterResult }>`

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/run/probe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveProbeCorpus } from "./probe.js";

describe("deriveProbeCorpus", () => {
  it("is model-independent and reproducible", () => {
    const first = deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1, 2] });
    const second = deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1, 2] });

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((state) => state.actorId)).toEqual(second.map((state) => state.actorId));
    expect(first.map((state) => state.world)).toEqual(second.map((state) => state.world));
  });

  it("collects only hostile-side turns", () => {
    const corpus = deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1] });

    for (const state of corpus) {
      const actor = state.world.combatants.find((each) => each.combatantId === state.actorId);
      expect(actor?.faction).toBe("hostile");
      expect(actor?.status).toBe("alive");
    }
  });

  it("gives each state a fresh action economy, so every turn is a full budget", () => {
    const corpus = deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1] });

    for (const state of corpus) {
      const actor = state.world.combatants.find((each) => each.combatantId === state.actorId);
      expect(actor?.actionEconomy.actionUsed).toBe(false);
      expect(actor?.actionEconomy.movementUsedFeet).toBe(0);
    }
  });

  it("grows with more seeds and more scenarios", () => {
    const one = deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1] });
    const two = deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1, 2] });
    const both = deriveProbeCorpus({
      scenarioIds: ["melee-brawl", "ranged-approach"],
      seeds: [1],
    });

    expect(two.length).toBeGreaterThan(one.length);
    expect(both.length).toBeGreaterThan(one.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- probe`
Expected: FAIL — cannot resolve `./probe.js`.

- [ ] **Step 3: Write the config**

Create `tools/sim/src/config.ts`:

```ts
// The benchmark matrix. Arms are data: adding a model or an effort level is an
// edit here, never a branch in code.
//
// NOTHING in this file is a measurement or a recommendation. It is the list of
// candidates to measure. `DEFAULT_MODEL_ROUTING.tactical` in `@ai-dm/agents`
// stays exactly as it is until a live run has produced numbers to change it by.
import type { ModelSpec, ProviderId, ReasoningEffort } from "@ai-dm/agents";
import { ALL_SCENARIO_IDS } from "./scenarios/index.js";

export interface Arm {
  /** `<modelId>@<effort>`. Stable, so reports across runs line up. */
  armId: string;
  spec: ModelSpec;
}

interface Candidate {
  provider: ProviderId;
  modelId: string;
}

/**
 * The plan's tactical candidates (PROJECT_PLAN.md section 2), plus one Claude
 * model as a quality ceiling — if the cheap models all miss the 95% bar, the
 * ceiling says whether the task is hard or the models are weak.
 */
const CANDIDATES: readonly Candidate[] = [
  { provider: "google", modelId: "gemini-3-flash" },
  { provider: "openai", modelId: "gpt-5.4-mini" },
  { provider: "openai", modelId: "gpt-5.4-nano" },
  { provider: "anthropic", modelId: "claude-sonnet-5" },
];

/** Swept, because `REASONING_BUDGET_TOKENS` is an unmeasured placeholder too. */
const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

/** Near-deterministic but not frozen, matching the tactical row's rationale. */
const TACTICAL_TEMPERATURE = 0.2;

export const ARMS: readonly Arm[] = CANDIDATES.flatMap((candidate) =>
  EFFORTS.map((effort) => ({
    armId: `${candidate.modelId}@${effort}`,
    spec: {
      provider: candidate.provider,
      modelId: candidate.modelId,
      temperature: TACTICAL_TEMPERATURE,
      reasoningEffort: effort,
    } satisfies ModelSpec,
  })),
);

export function armById(armId: string): Arm {
  const found = ARMS.find((arm) => arm.armId === armId);
  if (found === undefined) {
    throw new Error(`Unknown arm ${armId}; known: ${ARMS.map((arm) => arm.armId).join(", ")}`);
  }
  return found;
}

/** Five seeds is enough to see variance without making a live sweep expensive. */
export const DEFAULT_SEEDS: readonly number[] = [1, 2, 3, 4, 5];

/** The arm the smoke run uses. Never called: the scripted port answers for it. */
export const SMOKE_ARM: Arm = {
  armId: "scripted-fake@medium",
  spec: { provider: "google", modelId: "scripted-fake", reasoningEffort: "medium" },
};

export interface BenchmarkConfig {
  mode: "probe" | "encounter" | "both";
  live: boolean;
  arms: readonly Arm[];
  seeds: readonly number[];
  scenarioIds: readonly string[];
}

export const DEFAULT_CONFIG: BenchmarkConfig = {
  mode: "both",
  live: false,
  arms: [SMOKE_ARM],
  seeds: DEFAULT_SEEDS,
  scenarioIds: ALL_SCENARIO_IDS,
};
```

- [ ] **Step 4: Write the probe corpus and probe runner**

Create `tools/sim/src/run/probe.ts`:

```ts
// Probe mode: a fixed corpus of board states, replayed identically through every
// arm. This is the paired comparison that picks the model — no arm's legality
// depends on how well it happened to be playing three rounds earlier.
//
// Probe mode never resolves anything. It calls `proposeTurn`, records what came
// back, and throws the turn away.
import type { AvailableAction, TacticalAgent } from "@ai-dm/agents";
import type { CombatWorld } from "@ai-dm/rules-engine";
import { startTurn } from "@ai-dm/rules-engine";
import type { TimingPort } from "@ai-dm/agents";
import { runEncounter } from "../engine/encounter.js";
import { scriptedTurn } from "../engine/policy.js";
import { buildScenario } from "../scenarios/build.js";
import { scenarioById } from "../scenarios/index.js";
import { seeded } from "../rng.js";
import type { TurnRecord } from "./records.js";
import { recordFrom } from "./records.js";

export interface ProbeState {
  scenarioId: string;
  seed: number;
  round: number;
  actorId: string;
  world: CombatWorld;
  availableActions: readonly AvailableAction[];
  turnOrder: readonly string[];
}

export interface DeriveProbeCorpusInput {
  scenarioIds: readonly string[];
  seeds: readonly number[];
}

/**
 * Play the control encounter — scripted on both sides — and snapshot the board
 * at the start of every hostile turn. Deterministic and model-independent by
 * construction, which is exactly what makes the comparison paired.
 */
export function deriveProbeCorpus(input: DeriveProbeCorpusInput): ProbeState[] {
  const corpus: ProbeState[] = [];

  for (const scenarioId of input.scenarioIds) {
    for (const seed of input.seeds) {
      const built = buildScenario(scenarioById(scenarioId));
      let round = 0;

      // A decider that records the board it was asked about, then plays the
      // baseline turn so the encounter advances.
      const capture = (): ReturnType<typeof scriptedTurn> => null;
      void capture;

      // eslint-disable-next-line @typescript-eslint/require-await
      const decider = async (decide: {
        world: CombatWorld;
        actorId: string;
        availableActions: readonly AvailableAction[];
        round: number;
      }): Promise<ReturnType<typeof scriptedTurn>> => {
        const actor = decide.world.combatants.find((each) => each.combatantId === decide.actorId);
        round = decide.round;
        if (actor?.faction === "hostile") {
          corpus.push({
            scenarioId,
            seed,
            round: decide.round,
            actorId: decide.actorId,
            // The loop already reset this actor's economy, so the snapshot is a
            // full-budget turn — same as what a live turn would present.
            world: decide.world,
            availableActions: decide.availableActions,
            turnOrder: built.turnOrder,
          });
        }
        return scriptedTurn({
          world: decide.world,
          actorId: decide.actorId,
          availableActions: decide.availableActions,
        });
      };

      // `runEncounter` is async but fully synchronous underneath here: the
      // scripted decider never awaits I/O, so the corpus is complete when the
      // promise settles.
      void runEncounter({ scenario: built, rng: seeded(seed), deciderFor: () => decider });
      void round;
    }
  }

  return corpus;
}

export interface RunProbeArmInput {
  armId: string;
  corpus: readonly ProbeState[];
  agent: TacticalAgent;
  timingPort: TimingPort;
  /** Called before each turn so the smoke run can load its scripted responses. */
  beforeTurn?: (state: ProbeState) => void;
}

export async function runProbeArm(input: RunProbeArmInput): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];

  for (const state of input.corpus) {
    input.beforeTurn?.(state);

    // `TimingPort.timings` is one append-only array for the whole run, so the
    // only correct way to attribute entries to a turn is to slice.
    const before = input.timingPort.timings.length;
    const result = await input.agent.proposeTurn({
      world: state.world,
      actorId: state.actorId,
      availableActions: state.availableActions,
      turnOrder: state.turnOrder,
    });
    const timings = input.timingPort.timings.slice(before);

    records.push(
      recordFrom({
        armId: input.armId,
        scenarioId: state.scenarioId,
        seed: state.seed,
        round: state.round,
        actorId: state.actorId,
        result,
        timings,
      }),
    );
  }

  return records;
}

/** Re-exported so callers do not need to know the reset lives in the engine. */
export { startTurn };
```

Before running, delete the two dead lines the sketch above leaves in (`const capture` / `void capture` and `void round`) — they are scaffolding and `strictTypeChecked` will reject unused values. Replace `void runEncounter(...)` with `await`ing it from an async `deriveProbeCorpus`, or keep the function synchronous by having `runEncounter` resolve immediately; the simplest correct shape is to make `deriveProbeCorpus` return `Promise<ProbeState[]>` and `await runEncounter(...)`. Update the test's calls to `await` accordingly.

- [ ] **Step 5: Simplify to the async shape and rerun**

Change the signature to `export async function deriveProbeCorpus(input): Promise<ProbeState[]>`, `await runEncounter(...)`, and drop the scaffolding lines. In `probe.test.ts`, make each `it` async and `await` every `deriveProbeCorpus` call, e.g.:

```ts
it("is model-independent and reproducible", async () => {
  const first = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1, 2] });
  const second = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1, 2] });

  expect(first.length).toBeGreaterThan(0);
  expect(first.map((state) => state.actorId)).toEqual(second.map((state) => state.actorId));
  expect(first.map((state) => state.world)).toEqual(second.map((state) => state.world));
});
```

Run: `pnpm --filter @ai-dm/sim test -- probe`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the encounter runner**

Create `tools/sim/src/run/loop.ts`:

```ts
// Encounter mode: play the fight, hostile side model-driven, party side
// scripted. This is where win rate and damage efficiency come from. Legality is
// recorded too, but the report reads it from probe mode — here it is confounded
// by how the fight happened to go.
import type { TacticalAgent, TimingPort } from "@ai-dm/agents";
import type { Faction } from "@ai-dm/schemas";
import type { EncounterResult, TurnDecider } from "../engine/encounter.js";
import { runEncounter } from "../engine/encounter.js";
import { scriptedTurn } from "../engine/policy.js";
import { seeded } from "../rng.js";
import { buildScenario } from "../scenarios/build.js";
import { scenarioById } from "../scenarios/index.js";
import type { TurnRecord } from "./records.js";
import { recordFrom } from "./records.js";

export interface RunEncounterArmInput {
  armId: string;
  scenarioId: string;
  seed: number;
  agent: TacticalAgent;
  timingPort: TimingPort;
  beforeTurn?: (actorId: string, round: number) => void;
}

export interface EncounterArmResult {
  records: TurnRecord[];
  result: EncounterResult;
}

export async function runEncounterArm(input: RunEncounterArmInput): Promise<EncounterArmResult> {
  const built = buildScenario(scenarioById(input.scenarioId));
  const records: TurnRecord[] = [];

  const modelDecider: TurnDecider = async (decide) => {
    input.beforeTurn?.(decide.actorId, decide.round);

    const before = input.timingPort.timings.length;
    const result = await input.agent.proposeTurn({
      world: decide.world,
      actorId: decide.actorId,
      availableActions: decide.availableActions,
      turnOrder: built.turnOrder,
    });
    const timings = input.timingPort.timings.slice(before);

    records.push(
      recordFrom({
        armId: input.armId,
        scenarioId: input.scenarioId,
        seed: input.seed,
        round: decide.round,
        actorId: decide.actorId,
        result,
        timings,
      }),
    );

    return result.ok ? { turn: result.turn, plan: result.plan } : null;
  };

  // eslint-disable-next-line @typescript-eslint/require-await
  const baselineDecider: TurnDecider = async (decide) =>
    scriptedTurn({
      world: decide.world,
      actorId: decide.actorId,
      availableActions: decide.availableActions,
    });

  const result = await runEncounter({
    scenario: built,
    rng: seeded(input.seed),
    deciderFor: (faction: Faction) => (faction === "hostile" ? modelDecider : baselineDecider),
  });

  return { records, result };
}
```

- [ ] **Step 7: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/run tools/sim/src/config.ts
git add tools/sim
git commit -m "feat(sim): arm matrix, derived probe corpus and both runners

The probe corpus comes from the scripted control encounter, so every arm sees
byte-identical boards. Timings are attributed by slicing the timing port's
append-only array around each proposeTurn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: The report writer

**Files:**

- Create: `tools/sim/src/run/report.ts`
- Test: `tools/sim/src/run/report.test.ts`

**Interfaces:**

- Consumes: `TurnRecord` and the metric folds (Task 9), `costUsd` (Task 9), `TACTICAL_PROMPT_VERSION` from `@ai-dm/agents`.
- Produces:
  - `ArmSummary`, `RunReport`, `buildReport(input): RunReport`
  - `renderMarkdown(report: RunReport): string`
  - `writeReport(report: RunReport, runsDir: string): { jsonPath: string; markdownPath: string }`

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/run/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TurnRecord } from "./records.js";
import { buildReport, renderMarkdown } from "./report.js";

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    armId: "gemini-3-flash@medium",
    scenarioId: "melee-brawl",
    seed: 1,
    round: 1,
    actorId: "goblin_1",
    outcome: "model",
    attempts: 1,
    rejectionReasons: [],
    adapterErrorCodes: [],
    promptTokens: 1_000_000,
    completionTokens: 0,
    usageComplete: true,
    attemptsMissingUsage: 0,
    durationMs: 100,
    callDurationsMs: [100],
    unresolvedActionIds: [],
    ...overrides,
  };
}

const BASE = {
  runId: "test-run",
  generatedAt: "2026-08-17T00:00:00.000Z",
  gitCommit: "abc1234",
  promptVersion: "2026-08-17.1",
  live: false,
  seeds: [1],
  scenarioIds: ["melee-brawl"],
  encounters: [],
};

describe("buildReport", () => {
  it("summarises one arm and prices it from the dated table", () => {
    const report = buildReport({ ...BASE, probeRecords: [record()] });
    const arm = report.arms[0];

    expect(arm?.armId).toBe("gemini-3-flash@medium");
    expect(arm?.probe.legality.firstTry).toBe(1);
    expect(arm?.probe.costUsd).toBeCloseTo(0.25);
  });

  it("marks an unpriced model rather than reporting it as free", () => {
    const report = buildReport({
      ...BASE,
      probeRecords: [record({ armId: "mystery-model@low" })],
    });

    expect(report.arms[0]?.probe.costUsd).toBeNull();
  });

  it("flags under-reported usage instead of publishing a silent lower bound", () => {
    const report = buildReport({
      ...BASE,
      probeRecords: [record({ usageComplete: false, attemptsMissingUsage: 3 })],
    });

    expect(report.arms[0]?.probe.usage.usageComplete).toBe(false);
    expect(report.costIsUnderreported).toBe(true);
  });

  it("carries provenance so two runs are never pooled by accident", () => {
    const report = buildReport({ ...BASE, probeRecords: [record()] });

    expect(report.promptVersion).toBe("2026-08-17.1");
    expect(report.gitCommit).toBe("abc1234");
    expect(report.pricingTableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("renderMarkdown", () => {
  it("names the prompt version, the mode and the legality bar", () => {
    const markdown = renderMarkdown(buildReport({ ...BASE, probeRecords: [record()] }));

    expect(markdown).toContain("2026-08-17.1");
    expect(markdown).toContain("gemini-3-flash@medium");
    expect(markdown).toContain("smoke");
  });

  it("says so loudly when cost is under-reported", () => {
    const markdown = renderMarkdown(
      buildReport({
        ...BASE,
        probeRecords: [record({ usageComplete: false, attemptsMissingUsage: 2 })],
      }),
    );

    expect(markdown).toContain("under-reported");
  });

  it("prints unpriced rather than a zero cost", () => {
    const markdown = renderMarkdown(
      buildReport({ ...BASE, probeRecords: [record({ armId: "mystery-model@low" })] }),
    );

    expect(markdown).toContain("unpriced");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- report`
Expected: FAIL — cannot resolve `./report.js`.

- [ ] **Step 3: Implement**

Create `tools/sim/src/run/report.ts`:

```ts
// One JSON and one markdown file per run. The JSON is the artefact; the
// markdown is for a human deciding which model to route to.
//
// Two rules this file exists to enforce. No cost figure is ever printed without
// either completeness or an explicit under-reporting notice. And a report
// records the prompt version that produced it, so two runs either side of a
// prompt edit cannot be pooled silently.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TACTICAL_PROMPT_VERSION } from "@ai-dm/agents";
import { PRICING_TABLE_DATE, costUsd } from "../pricing.js";
import type { LatencySummary, LegalitySummary, UsageSummary } from "./metrics.js";
import { summariseLatency, summariseLegality, summariseUsage } from "./metrics.js";
import type { TurnRecord } from "./records.js";

export interface ModeSummary {
  turns: number;
  legality: LegalitySummary;
  latency: LatencySummary;
  usage: UsageSummary;
  /** Null when the model has no entry in the pricing table. */
  costUsd: number | null;
  costPerTurnUsd: number | null;
  /** PROJECT_PLAN.md section 3 states its cost target per 30-turn session. */
  costPer30TurnSessionUsd: number | null;
  /** Turns whose main action was legal but mechanically inert here (Dodge et al). */
  unresolvedActionIds: readonly string[];
}

export interface EncounterSummary {
  armId: string;
  scenarioId: string;
  seed: number;
  winner: string | null;
  rounds: number;
  damageByFaction: Record<string, number>;
}

export interface ArmSummary {
  armId: string;
  modelId: string;
  probe: ModeSummary;
  encounter: ModeSummary;
  /** Fraction of encounters the model-driven side won. */
  winRate: number;
}

export interface RunReport {
  runId: string;
  /** Excluded from the determinism claim — everything else is reproducible. */
  generatedAt: string;
  gitCommit: string;
  promptVersion: string;
  pricingTableDate: string;
  live: boolean;
  seeds: readonly number[];
  scenarioIds: readonly string[];
  arms: readonly ArmSummary[];
  costIsUnderreported: boolean;
  encounters: readonly EncounterSummary[];
}

export interface BuildReportInput {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  promptVersion?: string;
  live: boolean;
  seeds: readonly number[];
  scenarioIds: readonly string[];
  probeRecords?: readonly TurnRecord[];
  encounterRecords?: readonly TurnRecord[];
  encounters?: readonly EncounterSummary[];
}

const TURNS_PER_SESSION = 30;

function modelIdOf(armId: string): string {
  return armId.split("@")[0] ?? armId;
}

function summarise(armId: string, records: readonly TurnRecord[]): ModeSummary {
  const usage = summariseUsage(records);
  const cost = costUsd(modelIdOf(armId), {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  });
  const perTurn = cost === null || records.length === 0 ? null : cost / records.length;

  return {
    turns: records.length,
    legality: summariseLegality(records),
    latency: summariseLatency(records),
    usage,
    costUsd: cost,
    costPerTurnUsd: perTurn,
    costPer30TurnSessionUsd: perTurn === null ? null : perTurn * TURNS_PER_SESSION,
    unresolvedActionIds: [...new Set(records.flatMap((record) => record.unresolvedActionIds))],
  };
}

function armIdsIn(...groups: readonly (readonly TurnRecord[])[]): string[] {
  return [...new Set(groups.flat().map((record) => record.armId))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function buildReport(input: BuildReportInput): RunReport {
  const probeRecords = input.probeRecords ?? [];
  const encounterRecords = input.encounterRecords ?? [];
  const encounters = input.encounters ?? [];

  const arms: ArmSummary[] = armIdsIn(probeRecords, encounterRecords).map((armId) => {
    const armEncounters = encounters.filter((each) => each.armId === armId);
    const wins = armEncounters.filter((each) => each.winner === "hostile").length;

    return {
      armId,
      modelId: modelIdOf(armId),
      probe: summarise(
        armId,
        probeRecords.filter((record) => record.armId === armId),
      ),
      encounter: summarise(
        armId,
        encounterRecords.filter((record) => record.armId === armId),
      ),
      winRate: armEncounters.length === 0 ? 0 : wins / armEncounters.length,
    };
  });

  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit,
    promptVersion: input.promptVersion ?? TACTICAL_PROMPT_VERSION,
    pricingTableDate: PRICING_TABLE_DATE,
    live: input.live,
    seeds: input.seeds,
    scenarioIds: input.scenarioIds,
    arms,
    costIsUnderreported: arms.some(
      (arm) => !arm.probe.usage.usageComplete || !arm.encounter.usage.usageComplete,
    ),
    encounters,
  };
}

function money(value: number | null): string {
  return value === null ? "unpriced" : `$${value.toFixed(4)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];

  lines.push(`# Tactical benchmark — ${report.runId}`);
  lines.push("");
  lines.push(`- Mode: **${report.live ? "live" : "smoke (scripted port, no network)"}**`);
  lines.push(`- Prompt version: \`${report.promptVersion}\``);
  lines.push(`- Commit: \`${report.gitCommit}\``);
  lines.push(`- Pricing table dated: ${report.pricingTableDate}`);
  lines.push(`- Seeds: ${report.seeds.join(", ")}`);
  lines.push(`- Scenarios: ${report.scenarioIds.join(", ")}`);
  lines.push(`- Generated at: ${report.generatedAt} (not part of the determinism claim)`);
  lines.push("");

  if (!report.live) {
    lines.push(
      "> **Smoke run.** The model here is a scripted policy with a seeded defect " +
        "schedule. These numbers verify the pipeline and the metric arithmetic. " +
        "They say nothing about any real model's tactical quality.",
    );
    lines.push("");
  }

  if (report.costIsUnderreported) {
    lines.push(
      "> **Cost is under-reported.** At least one attempt was billed but reported " +
        "no token usage, so every figure below is a lower bound. See the " +
        "`attemptsMissingUsage` column.",
    );
    lines.push("");
  }

  lines.push("## Probe mode — paired, picks the model");
  lines.push("");
  lines.push(
    "| Arm | Turns | First try | Legal after retry | Fallback | p50 ms | p95 ms | Tokens/turn | $/turn | $/30-turn session | Missing usage |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of report.arms) {
    const { probe } = arm;
    lines.push(
      `| \`${arm.armId}\` | ${String(probe.turns)} | ${percent(probe.legality.firstTryRate)} | ` +
        `${percent(probe.legality.legalAfterRetryRate)} | ${String(probe.legality.fallback)} | ` +
        `${probe.latency.p50Ms.toFixed(0)} | ${probe.latency.p95Ms.toFixed(0)} | ` +
        `${probe.usage.tokensPerTurn.toFixed(0)} | ${money(probe.costPerTurnUsd)} | ` +
        `${money(probe.costPer30TurnSessionUsd)} | ${String(probe.usage.attemptsMissingUsage)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Step 7's exit criterion is **legality >= 95% after retry**. Read it from the " +
      "third column: that is the fraction of turns the engine accepted without the " +
      "deterministic fallback having to step in.",
  );
  lines.push("");

  lines.push("## Encounter mode — unpaired, win rate only");
  lines.push("");
  lines.push("| Arm | Encounters | Win rate | Turns | Legal after retry |");
  lines.push("|---|---|---|---|---|");
  for (const arm of report.arms) {
    const played = report.encounters.filter((each) => each.armId === arm.armId).length;
    lines.push(
      `| \`${arm.armId}\` | ${String(played)} | ${percent(arm.winRate)} | ` +
        `${String(arm.encounter.turns)} | ${percent(arm.encounter.legality.legalAfterRetryRate)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Win rate is measured against the scripted baseline. Read it with the resolver's " +
      "declared gaps in view: **Dodge has no mechanical effect** in this harness, so a " +
      "model that Dodges wisely is penalised, as is the deterministic fallback.",
  );
  lines.push("");

  return lines.join("\n");
}

export function writeReport(
  report: RunReport,
  runsDir: string,
): { jsonPath: string; markdownPath: string } {
  const directory = join(runsDir, report.runId);
  mkdirSync(directory, { recursive: true });

  const jsonPath = join(directory, "report.json");
  const markdownPath = join(directory, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(report), "utf8");

  return { jsonPath, markdownPath };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- report`
Expected: PASS, 7 tests.

- [ ] **Step 5: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src/run
git add tools/sim
git commit -m "feat(sim): JSON and markdown run reports with provenance

Records the prompt version and commit that produced the numbers, prints
'unpriced' rather than zero for a model with no price, and states the cost
under-reporting explicitly when any attempt reported no usage.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: CLI, entry point, and the end-to-end smoke run

The task that makes `pnpm sim` work and proves the whole pipeline in CI with no network and no key.

**Files:**

- Create: `tools/sim/src/cli.ts`, `tools/sim/src/smoke/run.ts`, `tools/sim/src/index.ts` (replaces the stub)
- Test: `tools/sim/src/cli.test.ts`, `tools/sim/src/smoke/run.test.ts`
- Modify: `tools/sim/CLAUDE.md`

**Interfaces:**

- Consumes: everything above.
- Produces: `parseArgs(argv: readonly string[]): BenchmarkConfig`, `runSmoke(input: RunSmokeInput): Promise<RunReport>`.

- [ ] **Step 1: Write the failing CLI test**

Create `tools/sim/src/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("defaults to a smoke run over every scenario", () => {
    const config = parseArgs([]);

    expect(config.live).toBe(false);
    expect(config.mode).toBe("both");
    expect(config.scenarioIds.length).toBe(4);
  });

  it("opts into live only when --live is given", () => {
    expect(parseArgs(["--live"]).live).toBe(true);
  });

  it("reads a mode", () => {
    expect(parseArgs(["--mode", "probe"]).mode).toBe("probe");
  });

  it("rejects an unknown mode rather than silently defaulting", () => {
    expect(() => parseArgs(["--mode", "sideways"])).toThrow("sideways");
  });

  it("parses comma-separated seeds and scenarios", () => {
    const config = parseArgs(["--seeds", "3,4", "--scenarios", "melee-brawl,ogre-charge"]);

    expect(config.seeds).toEqual([3, 4]);
    expect(config.scenarioIds).toEqual(["melee-brawl", "ogre-charge"]);
  });

  it("rejects an unknown scenario", () => {
    expect(() => parseArgs(["--scenarios", "not-a-scenario"])).toThrow("not-a-scenario");
  });

  it("rejects a non-numeric seed rather than running on NaN", () => {
    expect(() => parseArgs(["--seeds", "one"])).toThrow("one");
  });

  it("selects arms by id and rejects unknown ones", () => {
    expect(parseArgs(["--arms", "gemini-3-flash@low"]).arms[0]?.armId).toBe("gemini-3-flash@low");
    expect(() => parseArgs(["--arms", "nope@low"])).toThrow("nope@low");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- cli`
Expected: FAIL — cannot resolve `./cli.js`.

- [ ] **Step 3: Write the CLI**

Create `tools/sim/src/cli.ts`:

```ts
// Argv parsing, kept pure so it is testable without running anything.
//
// `--live` is the only flag that can cause a network call or read an API key.
// Everything else is orthogonal to it: `--mode probe` and `--mode probe --live`
// run the identical code path with a different port underneath, which is what
// stops the CI path from drifting away from the path that produces real numbers.
import type { Arm, BenchmarkConfig } from "./config.js";
import { ARMS, DEFAULT_CONFIG, armById } from "./config.js";
import { scenarioById } from "./scenarios/index.js";

const MODES = ["probe", "encounter", "both"] as const;
type Mode = (typeof MODES)[number];

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseSeeds(value: string): number[] {
  return commaSeparated(value).map((part) => {
    const seed = Number(part);
    if (!Number.isInteger(seed)) throw new Error(`Seed must be an integer, got ${part}`);
    return seed;
  });
}

function parseScenarios(value: string): string[] {
  // scenarioById throws on an unknown id, which is what we want: a typo should
  // stop the run rather than quietly benchmark three scenarios instead of four.
  return commaSeparated(value).map((id) => scenarioById(id).scenarioId);
}

function parseArms(value: string): Arm[] {
  return commaSeparated(value).map((id) => armById(id));
}

export function parseArgs(argv: readonly string[]): BenchmarkConfig {
  const live = argv.includes("--live");

  const rawMode = valueAfter(argv, "--mode");
  if (rawMode !== undefined && !isMode(rawMode)) {
    throw new Error(`Unknown mode ${rawMode}; expected one of ${MODES.join(", ")}`);
  }

  const rawSeeds = valueAfter(argv, "--seeds");
  const rawScenarios = valueAfter(argv, "--scenarios");
  const rawArms = valueAfter(argv, "--arms");

  return {
    mode: rawMode ?? DEFAULT_CONFIG.mode,
    live,
    // A live run with no explicit arms means the whole matrix; a smoke run means
    // the one scripted arm, because there is no model to distinguish arms by.
    arms: rawArms !== undefined ? parseArms(rawArms) : live ? ARMS : DEFAULT_CONFIG.arms,
    seeds: rawSeeds === undefined ? DEFAULT_CONFIG.seeds : parseSeeds(rawSeeds),
    scenarioIds:
      rawScenarios === undefined ? DEFAULT_CONFIG.scenarioIds : parseScenarios(rawScenarios),
  };
}
```

- [ ] **Step 4: Run the CLI test and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- cli`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing smoke-run test**

This is the test that pins the metric arithmetic. Create `tools/sim/src/smoke/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runSmoke } from "./run.js";

const CONFIG = {
  mode: "both" as const,
  live: false,
  seeds: [42],
  scenarioIds: ["melee-brawl"],
};

describe("runSmoke", () => {
  it("produces a report with turns in both modes and no network", async () => {
    const report = await runSmoke({
      ...CONFIG,
      runId: "smoke-1",
      generatedAt: "T",
      gitCommit: "c",
    });

    expect(report.live).toBe(false);
    expect(report.arms).toHaveLength(1);
    expect(report.arms[0]?.probe.turns).toBeGreaterThan(0);
    expect(report.arms[0]?.encounter.turns).toBeGreaterThan(0);
  });

  it("exercises first-try, retry and fallback, not just the happy path", async () => {
    const report = await runSmoke({
      ...CONFIG,
      runId: "smoke-2",
      generatedAt: "T",
      gitCommit: "c",
    });
    const { legality } = report.arms[0]?.probe ?? { legality: undefined };

    expect(legality?.firstTry).toBeGreaterThan(0);
    expect((legality?.afterRetry ?? 0) + (legality?.fallback ?? 0)).toBeGreaterThan(0);
  });

  it("is byte-identical across two runs, apart from the timestamp", async () => {
    const first = await runSmoke({
      ...CONFIG,
      runId: "same",
      generatedAt: "2026-08-17T00:00:00.000Z",
      gitCommit: "c",
    });
    const second = await runSmoke({
      ...CONFIG,
      runId: "same",
      generatedAt: "2026-08-17T00:00:00.000Z",
      gitCommit: "c",
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("uses an injected clock, so even latency is reproducible", async () => {
    const a = await runSmoke({ ...CONFIG, runId: "clock", generatedAt: "T", gitCommit: "c" });
    const b = await runSmoke({ ...CONFIG, runId: "clock", generatedAt: "T", gitCommit: "c" });

    expect(b.arms[0]?.probe.latency).toEqual(a.arms[0]?.probe.latency);
  });
});
```

The first run of this test will fail on the exact counts because the defect weights and the corpus size decide them. **Do not tune the weights to fit a number you wanted.** Run it, read the actual `firstTry` / `afterRetry` / `fallback` values from the failure, confirm they are all non-zero, and if they are, the assertions above already pass. Only if one bucket is empty should you widen the seed list in `CONFIG` — the point is coverage of all three paths, not a particular ratio.

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm --filter @ai-dm/sim test -- smoke`
Expected: FAIL — cannot resolve `./run.js`.

- [ ] **Step 7: Implement the smoke run**

Create `tools/sim/src/smoke/run.ts`:

```ts
// The no-API run. Same code path as a live run — same agent, same runtime, same
// timing port, same records, same report — with a scripted port underneath and
// an injected counter clock, so the whole report is reproducible byte for byte.
import type { ExecuteTurn } from "@ai-dm/schemas";
import {
  createAgentRuntime,
  createTacticalAgent,
  createTimingPort,
  adapterFailure,
  adapterSuccess,
} from "@ai-dm/agents";
import type { ModelRouting } from "@ai-dm/agents";
import { scriptedTurn } from "../engine/policy.js";
import { runEncounterArm } from "../run/loop.js";
import { deriveProbeCorpus, runProbeArm } from "../run/probe.js";
import type { EncounterSummary, RunReport } from "../run/report.js";
import { buildReport } from "../run/report.js";
import { SMOKE_ARM } from "../config.js";
import { seeded } from "../rng.js";
import type { DefectKind } from "./defects.js";
import { SMOKE_USAGE, nextDefect } from "./defects.js";
import { createScriptedPort } from "./port.js";

export interface RunSmokeInput {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  seeds: readonly number[];
  scenarioIds: readonly string[];
  mode: "probe" | "encounter" | "both";
}

/** Milliseconds the counter clock advances per read. A fixture, not a measurement. */
const TICK_MS = 37;

function routingFor(): ModelRouting {
  return {
    intent: SMOKE_ARM.spec,
    tactical: SMOKE_ARM.spec,
    narrative: SMOKE_ARM.spec,
  };
}

/**
 * A turn the engine will reject: it targets a combatant that is not on the board,
 * which earns `target_not_found` and drives the agent's retry path.
 */
function illegalTurn(actorId: string): ExecuteTurn {
  return {
    actorId,
    mainAction: { actionType: "attack", targetIds: ["no_such_combatant"] },
    tacticalRationaleEnglish: "Smoke fixture: deliberately illegal.",
  };
}

/** The two responses one turn may need. The agent never asks for a third. */
function scriptFor(defect: DefectKind, legal: ExecuteTurn | null, actorId: string) {
  const good =
    legal === null
      ? adapterFailure("provider_error", "Smoke fixture: no legal baseline turn.")
      : adapterSuccess({ value: legal, usage: SMOKE_USAGE });

  switch (defect) {
    case "none":
      return { structured: [good, good] };
    case "illegal_target":
      return {
        structured: [adapterSuccess({ value: illegalTurn(actorId), usage: SMOKE_USAGE }), good],
      };
    case "schema_validation_failed":
      return {
        structured: [
          adapterFailure("schema_validation_failed", "Smoke fixture: bad tool call.", {
            usage: SMOKE_USAGE,
          }),
          good,
        ],
      };
    case "no_tool_call":
      return {
        structured: [
          adapterFailure("no_tool_call", "Smoke fixture: prose instead of a tool call.", {
            usage: SMOKE_USAGE,
          }),
          good,
        ],
      };
    case "provider_error":
      // No second call happens on this path; the agent falls straight back.
      return { structured: [adapterFailure("provider_error", "Smoke fixture: provider down.")] };
  }
}

export async function runSmoke(input: RunSmokeInput): Promise<RunReport> {
  const port = createScriptedPort();
  let ticks = 0;
  const timingPort = createTimingPort(port, {
    now: () => {
      ticks += 1;
      return ticks * TICK_MS;
    },
  });
  const runtime = createAgentRuntime({ routing: routingFor(), port: timingPort });
  const agent = createTacticalAgent({ runtime });

  // One defect stream for the whole run, so the schedule is a function of the
  // run's seed rather than of how many turns each scenario happened to take.
  const defectRng = seeded(input.seeds[0] ?? 1);

  const wantsProbe = input.mode !== "encounter";
  const wantsEncounter = input.mode !== "probe";

  const probeRecords = [];
  if (wantsProbe) {
    const corpus = await deriveProbeCorpus({
      scenarioIds: input.scenarioIds,
      seeds: input.seeds,
    });
    probeRecords.push(
      ...(await runProbeArm({
        armId: SMOKE_ARM.armId,
        corpus,
        agent,
        timingPort,
        beforeTurn: (state) => {
          const baseline = scriptedTurn({
            world: state.world,
            actorId: state.actorId,
            availableActions: state.availableActions,
          });
          port.load(scriptFor(nextDefect(defectRng), baseline?.turn ?? null, state.actorId));
        },
      })),
    );
  }

  const encounterRecords = [];
  const encounters: EncounterSummary[] = [];
  if (wantsEncounter) {
    for (const scenarioId of input.scenarioIds) {
      for (const seed of input.seeds) {
        // The port needs the board to script a legal turn, and `beforeTurn` in
        // the encounter runner only names the actor — so the loader closes over
        // the world the encounter runner is about to pass to `proposeTurn`. The
        // runner calls `beforeTurn` immediately before that call, so a script
        // loaded here is the one that turn consumes.
        const armResult = await runEncounterArm({
          armId: SMOKE_ARM.armId,
          scenarioId,
          seed,
          agent,
          timingPort,
          beforeTurn: (actorId) => {
            port.load(scriptFor(nextDefect(defectRng), null, actorId));
          },
        });

        encounterRecords.push(...armResult.records);
        encounters.push({
          armId: SMOKE_ARM.armId,
          scenarioId,
          seed,
          winner: armResult.result.winner,
          rounds: armResult.result.rounds,
          damageByFaction: armResult.result.damageByFaction,
        });
      }
    }
  }

  return buildReport({
    runId: input.runId,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit,
    live: false,
    seeds: input.seeds,
    scenarioIds: input.scenarioIds,
    probeRecords,
    encounterRecords,
    encounters,
  });
}
```

- [ ] **Step 8: Fix the encounter-mode script gap**

As written, encounter mode always scripts `legal = null`, so every model turn falls back and `legality.firstTry` is 0 there. That is wrong: the encounter runner's `beforeTurn` must hand the board over so a legal baseline turn can be scripted.

Widen `RunEncounterArmInput["beforeTurn"]` in `tools/sim/src/run/loop.ts` to take the whole decide input:

```ts
  beforeTurn?: (decide: DecideInput) => void;
```

adding `import type { DecideInput } from "../engine/encounter.js";`, and change the call site inside `modelDecider` from `input.beforeTurn?.(decide.actorId, decide.round)` to `input.beforeTurn?.(decide)`.

Then in `runSmoke`, script the encounter turns from the real board:

```ts
          beforeTurn: (decide) => {
            const baseline = scriptedTurn({
              world: decide.world,
              actorId: decide.actorId,
              availableActions: decide.availableActions,
            });
            port.load(scriptFor(nextDefect(defectRng), baseline?.turn ?? null, decide.actorId));
          },
```

- [ ] **Step 9: Run it and watch it pass**

Run: `pnpm --filter @ai-dm/sim test -- smoke`
Expected: PASS, 4 tests.

If `firstTry` is 0, the scripted baseline is returning null on every board — check `scriptedTurn` against the scenario. If the byte-identical assertion fails, something read an ambient clock or `Math.random`: search `tools/sim/src` for `Date.now`, `new Date`, and `Math.random`, all of which are banned here.

- [ ] **Step 10: Write the entry point**

Replace `tools/sim/src/index.ts` entirely:

```ts
// Headless combat simulator: tactical agent vs scripted enemies, no UI.
// Metrics per model: tool-call legality rate, retries, latency p50/p95,
// tokens & cost per turn, win rate vs baseline scripted AI.
//
// `pnpm sim` runs the smoke path: no network, no API key, a reproducible report
// under `runs/`. Add `--live` to benchmark real models, which requires the
// provider credentials in the environment and is the operator's call to make.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./cli.js";
import { runSmoke } from "./smoke/run.js";
import { writeReport } from "./run/report.js";

const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");

/** Provenance, not behaviour: an unknown commit must not stop a run. */
function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  if (config.live) {
    // Everything for a live run exists — arms, runners, records, reports — but
    // firing one spends money against credentials this process would read from
    // the environment. That is the operator's decision, made explicitly.
    console.error(
      "Live benchmarking is not wired to a provider in this build. See tools/sim/CLAUDE.md.",
    );
    process.exitCode = 1;
    return;
  }

  const generatedAt = new Date().toISOString();
  const report = await runSmoke({
    runId: `smoke-${generatedAt.replaceAll(":", "-")}`,
    generatedAt,
    gitCommit: gitCommit(),
    seeds: config.seeds,
    scenarioIds: config.scenarioIds,
    mode: config.mode,
  });

  const { jsonPath, markdownPath } = writeReport(report, RUNS_DIR);
  console.warn(`Wrote ${jsonPath}`);
  console.warn(`Wrote ${markdownPath}`);
}

await main();
```

`new Date()` here is provenance for the report header, outside the determinism claim — it is the one place in the package allowed to read a clock, and it never touches a decision or a roll.

- [ ] **Step 11: Run the simulator end to end**

```bash
corepack enable && pnpm sim
```

Expected: two "Wrote …" lines naming files under `tools/sim/runs/`. Open the markdown and confirm it carries the smoke-run warning, the prompt version, and a legality table with non-zero first-try and non-zero retry-or-fallback counts.

- [ ] **Step 12: Confirm reproducibility by hand**

```bash
pnpm sim --seeds 42 --scenarios melee-brawl
pnpm sim --seeds 42 --scenarios melee-brawl
```

Then compare the two newest reports, ignoring the fields that are provenance rather than measurement:

```bash
cd tools/sim/runs && ls -1t | head -2 | while read -r d; do
  jq 'del(.runId, .generatedAt, .gitCommit)' "$d/report.json" > "/tmp/$d.json"
done && diff /tmp/*.json && echo "IDENTICAL"
```

Expected: `IDENTICAL`, no diff output.

- [ ] **Step 13: Document the live command**

Append to `tools/sim/CLAUDE.md`, after the existing `## Commands` block:

````markdown
## Modes

`pnpm sim` is a **smoke run**: a scripted port with a seeded defect schedule, no
network, no API key. It verifies the pipeline and the metric arithmetic, and
says nothing about any real model's tactical quality.

| Flag          | Values                                       | Default                 |
| ------------- | -------------------------------------------- | ----------------------- |
| `--mode`      | `probe` \| `encounter` \| `both`             | `both`                  |
| `--live`      | absent \| present                            | absent                  |
| `--arms`      | comma-separated arm ids from `src/config.ts` | every arm when `--live` |
| `--seeds`     | comma-separated integers                     | `1,2,3,4,5`             |
| `--scenarios` | comma-separated scenario ids                 | all four                |

Probe mode is the paired comparison that picks the model: every arm sees
byte-identical boards, derived from the scripted control encounter. Encounter
mode plays the fight out and is the only source of win rate.

## Live benchmarking

Not run yet. Nothing in this repo has ever called a live model, and
`DEFAULT_MODEL_ROUTING.tactical` and `REASONING_BUDGET_TOKENS` are still
unmeasured placeholders.

```bash
export GOOGLE_GENERATIVE_AI_API_KEY=…   # gemini-3-flash
export OPENAI_API_KEY=…                 # gpt-5.4-mini, gpt-5.4-nano
export ANTHROPIC_API_KEY=…              # claude-sonnet-5 (quality ceiling)
pnpm sim --live --mode probe            # 12 arms x 4 scenarios x 5 seeds
```

Keys are read from `process.env` only: never written to disk, never logged,
never included in a report.

**Before publishing any number from a live run:**

- Check `costIsUnderreported` in the report. It is true when an attempt was
  billed but reported no usage, which makes every cost figure a lower bound.
- Check `promptVersion` matches across every run you intend to compare. Two runs
  either side of a prompt edit must not be pooled.
- Read win rate with the resolver's declared gaps in view — Dodge is inert here,
  which penalises both careful play and the deterministic fallback.
````

- [ ] **Step 14: Full verification and commit**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
npx prettier --write tools/sim/src tools/sim/CLAUDE.md
git add tools/sim
git commit -m "feat(sim): CLI, entry point and the end-to-end smoke run

pnpm sim now produces a reproducible report with no network and no API key,
and the smoke test asserts all three legality paths are exercised. The --live
path is documented for the operator but deliberately not wired to a provider.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 15: Report what this step did not do**

Write into the completion notes, for the user:

1. **No live run happened.** `DEFAULT_MODEL_ROUTING.tactical`, `REASONING_BUDGET_TOKENS` and `PROJECT_PLAN.md`'s step 7 row are untouched, exactly as agreed. Step 7 stays `🟡 7a done, 7b pending`.
2. **The validator accepts foreign action ids** (Task 5, Step 6). Reported, not fixed.
3. **`seeded` / `scripted` are duplicated** in `tools/sim/src/rng.ts` because `@ai-dm/rules-engine` documents but does not export them. Worth a follow-up before step 8 needs the same helper.
4. **Dodge is inert** in the resolver, so win rate is biased against careful play. Declared in the report, not silently absorbed.

---

## Self-Review

**Spec coverage.** Every section maps to a task: §1 two modes → Tasks 10, 12; §2 CLI → Task 12; §3 layout → all; §4 determinism → Tasks 2, 7, 12 (Steps 9, 12); §5 smoke mode → Tasks 8, 12; §6 scenarios → Tasks 3, 4; §7 resolver → Task 5; §8 cost honesty → Tasks 1, 9, 11; §9 metrics → Task 9; §10 provenance → Task 11; §11 testing → every task; §12 deliverable → Task 12, Steps 10–13.

**Known rough edge, flagged rather than hidden.** Task 10, Step 4 sketches `deriveProbeCorpus` synchronously and Step 5 corrects it to async. That is deliberate — the sketch is where the shape becomes obviously wrong, and correcting it in place is cheaper than describing the right shape abstractly. Task 12, Step 8 does the same for `beforeTurn`'s signature. An executor following the steps in order lands correctly; one skimming Step 4 alone would not.

**Type consistency.** `TurnRecord` field names are identical in Tasks 9, 10, 11 and 12. `DecidedTurn` is defined once (Task 6) and consumed by Tasks 7 and 10. `ModeSummary.costPerTurnUsd` is `number | null` everywhere. `TurnEffect.unresolvedActionIds` (Task 5) flows through `RecordInput` (Task 9) into `ModeSummary` (Task 11).
