# Combat Roll Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread attack rolls, damage rolls, and movement distance — already computed by the rules engine and already discarded before reaching an event — out through the wire and onto a new combat-log panel in the web client, so a player can see the numbers behind every narrated outcome.

**Architecture:** Enrich the existing `dice_rolled`/`action_validated` events with data the engine already computes (no new event types, no change to `reduce()` or combat math). The client folds these into a new `combatLog` field on `ClientState`, the same way `narrative`/`lastError` already work — client-only derived state, alongside `reduce()`, not inside it. A new `CombatLog` component renders it as a dedicated panel below the narrative pane.

**Tech Stack:** TypeScript strict, Zod schemas, Vitest, React 18.

**Spec:** `docs/superpowers/specs/2026-08-20-combat-roll-log-design.md`

## Global Constraints

- English inside, Hebrew outside (invariant 2): every new string in `apps/web/src/i18n.ts`, nowhere else.
- Schemas define types once (invariant 4): `AttackOutcome`, `AttackRollTrace`, `DamageRollTrace` live in `@ai-dm/schemas`; `rules-engine` imports the types, never redeclares them.
- Dependency direction (invariant 5): `schemas ← rules-engine ← agents ← server`; `web` depends only on `schemas`. No task below violates this.
- Never rename or remove `AttackRecord.damage` — `packages/agents/src/narrative/deterministic.ts:54` is a live reader of that exact field name.
- `AttackRecord.cover` has no reader anywhere in the codebase and is dropped, not threaded through.
- Death saves, advantage/disadvantage mode selection, and log persistence across a refresh are explicitly out of scope (see spec's Non-goals).
- `corepack enable` before any `pnpm` command (pnpm is not on PATH otherwise).
- Never run `pnpm format` (no `.prettierignore`; rewrites ~37 unrelated files). Format only the exact files this plan touches, if at all.
- Do not trust root `pnpm lint`; use package-scoped `npx eslint <package-dir>` or the exact paths this plan modifies.

---

## Task 1: Schema additions for roll detail

**Files:**
- Modify: `packages/schemas/src/events.ts`
- Test: `packages/schemas/src/index.test.ts`

**Interfaces:**
- Produces: `AttackOutcome`, `AttackRollTrace`, `DamageRollTrace`, `AttackTrace`, `DiceRolledPayload`, `ActionValidatedPayload` — all zod schemas exported from `@ai-dm/schemas` (via `events.ts` → `index.ts`'s existing `export * from "./events.js"`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/schemas/src/index.test.ts`. First, extend the top-of-file import block:

```ts
import {
  ActionRejectedPayload,
  ActionValidatedPayload,
  AttackOutcome,
  AttackRollTrace,
  AttackTrace,
  CharacterSheet,
  Combatant,
  DamageRollTrace,
  DiceRolledPayload,
  ExecuteTurn,
  GameEvent,
  GridMap,
} from "./index.js";
```

Then append these `describe` blocks after the existing `describe("ActionRejectedPayload", ...)` block:

```ts
describe("AttackTrace", () => {
  it("parses a hit with a single damage roll", () => {
    const trace = AttackTrace.parse({
      attackerId: "goblin-a",
      targetId: "hero",
      actionId: "scimitar",
      outcome: "hit",
      damage: 6,
      targetStatusAfter: "alive",
      attackRoll: { naturalRoll: 18, rolls: [18], total: 22, targetArmorClass: 16 },
      damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [4], modifier: 2, total: 6 }],
    });

    expect(trace.outcome).toBe("hit");
    expect(trace.damageRolls).toHaveLength(1);
  });

  it("parses a miss with an empty damageRolls array", () => {
    const trace = AttackTrace.parse({
      attackerId: "goblin-a",
      targetId: "hero",
      actionId: "scimitar",
      outcome: "miss",
      damage: 0,
      targetStatusAfter: "alive",
      attackRoll: { naturalRoll: 3, rolls: [3], total: 7, targetArmorClass: 16 },
      damageRolls: [],
    });

    expect(trace.damageRolls).toEqual([]);
  });

  it("parses flat (non-dice) damage", () => {
    const trace = AttackTrace.parse({
      attackerId: "cultist",
      targetId: "hero",
      actionId: "dagger",
      outcome: "hit",
      damage: 1,
      targetStatusAfter: "alive",
      attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 12 },
      damageRolls: [{ kind: "flat", total: 1 }],
    });

    expect(trace.damageRolls).toEqual([{ kind: "flat", total: 1 }]);
  });

  it("rejects an outcome outside the closed AttackOutcome enum", () => {
    const result = AttackTrace.safeParse({
      attackerId: "goblin-a",
      targetId: "hero",
      actionId: "scimitar",
      outcome: "grazed", // not a real AttackOutcome
      damage: 0,
      targetStatusAfter: "alive",
      attackRoll: { naturalRoll: 3, rolls: [3], total: 7, targetArmorClass: 16 },
      damageRolls: [],
    });

    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["outcome"]);
  });
});

describe("DiceRolledPayload", () => {
  it("parses a turn with one attack and movement", () => {
    const payload = DiceRolledPayload.parse({
      actorId: "goblin-a",
      movedFeet: 10,
      attacks: [
        {
          attackerId: "goblin-a",
          targetId: "hero",
          actionId: "scimitar",
          outcome: "critical_hit",
          damage: 10,
          targetStatusAfter: "alive",
          attackRoll: { naturalRoll: 20, rolls: [20], total: 24, targetArmorClass: 16 },
          damageRolls: [{ kind: "dice", notation: "1d6+2", rolls: [4, 4], modifier: 2, total: 10 }],
        },
      ],
    });

    expect(payload.movedFeet).toBe(10);
    expect(payload.attacks[0]?.outcome).toBe("critical_hit");
  });

  it("parses a turn with no attacks, movement only", () => {
    const payload = DiceRolledPayload.parse({ actorId: "hero", movedFeet: 15, attacks: [] });
    expect(payload.attacks).toEqual([]);
  });

  it("rejects a payload missing movedFeet, the pre-migration shape", () => {
    // A `dice_rolled` event persisted before this feature shipped has no
    // `movedFeet` field at all. The web client must treat this as a parse
    // failure (see store.ts's defensive handling in Task 5), not a crash —
    // this test only pins that the schema itself is strict about it.
    const result = DiceRolledPayload.safeParse({ actorId: "hero", attacks: [] });
    if (result.success) throw new Error("expected the parse to fail");
    expect(result.error.issues[0]?.path).toStrictEqual(["movedFeet"]);
  });
});

describe("ActionValidatedPayload", () => {
  it("parses actorId, a full ExecuteTurn, and source", () => {
    const payload = ActionValidatedPayload.parse({
      actorId: "hero",
      turn: {
        actorId: "hero",
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: "Test fixture.",
      },
      source: "human",
    });

    expect(payload.turn.mainAction.actionType).toBe("dodge");
    expect(payload.source).toBe("human");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable
pnpm --filter @ai-dm/schemas exec vitest run src/index.test.ts
```

Expected: FAIL — `AttackTrace`, `DiceRolledPayload`, `ActionValidatedPayload` etc. are not exported from `./index.js` yet (TypeScript compile error via vitest, or a runtime `undefined is not a function`).

- [ ] **Step 3: Add the schemas**

In `packages/schemas/src/events.ts`, change the import block at the top from:

```ts
import { z } from "zod";
import { ExecuteTurn } from "./actions.js";
```

to:

```ts
import { z } from "zod";
import { ExecuteTurn } from "./actions.js";
import { EntityStatus } from "./world.js";
import { DiceNotation } from "./srd.js";
```

Then append this block at the end of the file, after the existing `ActionRejectedPayload` type export:

```ts
export const AttackOutcome = z.enum(["hit", "miss", "critical_hit", "critical_miss"]);
export type AttackOutcome = z.infer<typeof AttackOutcome>;

/**
 * The d20-vs-AC picture for one attack. `rolls` has one entry normally, two
 * when advantage or disadvantage rolled both dice — `naturalRoll` is
 * whichever of `rolls` was actually used. `targetArmorClass` already
 * includes any cover bonus; there is no separate raw-AC field because
 * nothing downstream reads one.
 */
export const AttackRollTrace = z.object({
  naturalRoll: z.number().int().min(1).max(20),
  rolls: z.array(z.number().int()),
  total: z.number().int(),
  targetArmorClass: z.number().int(),
});
export type AttackRollTrace = z.infer<typeof AttackRollTrace>;

/**
 * One damage source's roll. `"dice"` when the stat block has a dice
 * notation; `"flat"` when it only has a printed average (some monsters have
 * no dice at all for a minor rider, e.g. "plus 1 necrotic damage").
 */
export const DamageRollTrace = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dice"),
    notation: DiceNotation,
    rolls: z.array(z.number().int()),
    modifier: z.number().int(),
    total: z.number().int(),
  }),
  z.object({ kind: z.literal("flat"), total: z.number().int() }),
]);
export type DamageRollTrace = z.infer<typeof DamageRollTrace>;

/**
 * Enriched replacement for the rules engine's internal `AttackRecord` shape
 * on the wire. `damage` keeps the name and meaning `AttackRecord.damage`
 * already has — `packages/agents/src/narrative/deterministic.ts` reads it,
 * so it is not renamed here. `damageRolls` is an empty array on a miss (no
 * damage is ever rolled for a miss) and can have more than one entry when a
 * weapon has extra-damage riders (each becomes its own roll).
 */
export const AttackTrace = z.object({
  attackerId: z.string(),
  targetId: z.string(),
  actionId: z.string(),
  outcome: AttackOutcome,
  damage: z.number().int(),
  targetStatusAfter: EntityStatus,
  attackRoll: AttackRollTrace,
  damageRolls: z.array(DamageRollTrace),
});
export type AttackTrace = z.infer<typeof AttackTrace>;

/**
 * Payload for the `dice_rolled` event. `reduce()` still no-ops this event
 * type (it does not change `SessionState`) — this schema exists so the web
 * client's combat log (a client-only display feature, not state) can safely
 * parse what the engine already computed. `movedFeet` is the turn's total
 * movement distance, already accounting for terrain cost.
 */
export const DiceRolledPayload = z.object({
  actorId: z.string(),
  attacks: z.array(AttackTrace),
  movedFeet: z.number().int().min(0),
});
export type DiceRolledPayload = z.infer<typeof DiceRolledPayload>;

/**
 * Payload for the `action_validated` event. The server already emits
 * exactly this shape (`pipeline.ts`'s two `action_validated` emit sites);
 * this schema is new, the server payload is not — it lets the client read
 * `turn.mainAction.actionType` to label a non-attack turn in the combat log.
 */
export const ActionValidatedPayload = z.object({
  actorId: z.string(),
  turn: ExecuteTurn,
  source: z.string(),
});
export type ActionValidatedPayload = z.infer<typeof ActionValidatedPayload>;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/schemas exec vitest run src/index.test.ts
```

Expected: PASS, all new `describe` blocks green.

- [ ] **Step 5: Typecheck and full schemas suite**

```bash
pnpm --filter @ai-dm/schemas typecheck
pnpm --filter @ai-dm/schemas test
```

Expected: 0 typecheck errors; all schemas tests pass (85 + the new cases).

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/events.ts packages/schemas/src/index.test.ts
git commit -m "feat(schemas): add AttackTrace, DiceRolledPayload, ActionValidatedPayload

Enriched wire shapes for the combat roll log (spec #3, step 8):
attack rolls, damage rolls, and the payloads that carry them. reduce()
is unchanged -- these event types stay no-ops for state purposes; this
is purely additive schema for a client-side display feature."
```

---

## Task 2: Rules engine — capture roll detail in AttackRecord

**Files:**
- Modify: `packages/rules-engine/src/combat/index.ts`
- Modify: `packages/rules-engine/src/encounter/resolve.ts`
- Test: `packages/rules-engine/src/encounter/resolve.test.ts`

**Interfaces:**
- Consumes: `AttackOutcome`, `AttackRollTrace`, `DamageRollTrace` from `@ai-dm/schemas` (Task 1).
- Produces: `AttackRecord` gains `attackRoll: AttackRollTrace` and `damageRolls: DamageRollTrace[]`; loses `cover`. `TurnEffect.attacks` is now `AttackRecord[]` with these new fields — Task 3 depends on this.

- [ ] **Step 1: Write the failing tests**

In `packages/rules-engine/src/encounter/resolve.test.ts`, extend the existing hit/miss/critical tests (they already exist — do not duplicate them, add assertions to them) and add two new tests. First, extend `"applies damage on a hit and leaves the input world untouched"`:

```ts
  it("applies damage on a hit and leaves the input world untouched", () => {
    // Guard AC 16; scimitar +4 needs a 12. Roll 18, then 1d6 -> 4 (+2 = 6).
    const { world, effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [
      d20Exactly(18),
      0.5,
    ]);

    expect(effect.attacks).toHaveLength(1);
    expect(effect.attacks[0]?.outcome).toBe("hit");
    expect(effect.damageDealt).toBe(6);
    expect(effect.attacks[0]?.attackRoll).toEqual({
      naturalRoll: 18,
      rolls: [18],
      total: 22,
      targetArmorClass: 16,
    });
    expect(effect.attacks[0]?.damageRolls).toEqual([
      { kind: "dice", notation: "1d6+2", rolls: [4], modifier: 2, total: 6 },
    ]);

    const after = world.combatants.find((each) => each.combatantId === "guard_1");
    const before = built.world.combatants.find((each) => each.combatantId === "guard_1");
    expect(after?.currentHp).toBe((before?.currentHp ?? 0) - 6);
    expect(before?.currentHp).toBe(before?.maxHp);
  });
```

Extend `"deals no damage on a miss"`:

```ts
  it("deals no damage on a miss", () => {
    const { effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [d20Exactly(3)]);

    expect(effect.attacks[0]?.outcome).toBe("miss");
    expect(effect.damageDealt).toBe(0);
    expect(effect.attacks[0]?.attackRoll).toEqual({
      naturalRoll: 3,
      rolls: [3],
      total: 7,
      targetArmorClass: 16,
    });
    expect(effect.attacks[0]?.damageRolls).toEqual([]);
  });
```

Extend `"doubles only the damage dice on a critical hit"`:

```ts
  it("doubles only the damage dice on a critical hit", () => {
    // Natural 20, then two d6 at 0.5 -> 4 each, plus the +2 modifier once.
    const { effect } = resolve(attack("goblin_1", "guard_1", "scimitar"), [
      d20Exactly(20),
      0.5,
      0.5,
    ]);

    expect(effect.attacks[0]?.outcome).toBe("critical_hit");
    expect(effect.damageDealt).toBe(10);
    expect(effect.attacks[0]?.attackRoll).toEqual({
      naturalRoll: 20,
      rolls: [20],
      total: 24,
      targetArmorClass: 16,
    });
    // The dice double (two rolls), the notation and modifier do not.
    expect(effect.attacks[0]?.damageRolls).toEqual([
      { kind: "dice", notation: "1d6+2", rolls: [4, 4], modifier: 2, total: 10 },
    ]);
  });
```

Add two new tests after the existing `"kills a monster outright at 0 HP rather than downing it"` test:

```ts
  it("records flat damage as kind: flat, with no dice rolled", () => {
    const flatDamageBlock: MonsterStatBlock = {
      ...GOBLIN_WARRIOR,
      monsterId: "cultist_test_fixture",
      actions: [
        {
          actionId: "dagger",
          nameEnglish: "Dagger",
          attackBonus: 4,
          reachFeet: 5,
          damage: { averageDamage: 1, damageType: "piercing" }, // no diceNotation
          extraDamage: [],
        },
      ],
    };
    const statBlocks = new Map([...STAT_BLOCKS, ["cultist_test_fixture", flatDamageBlock]]);
    const world = {
      ...built.world,
      combatants: built.world.combatants.map((each) =>
        each.combatantId === "goblin_1" ? { ...each, monsterId: "cultist_test_fixture" } : each,
      ),
    };
    const actor = world.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const turn = attack("goblin_1", "guard_1", "dagger");
    const validation = validateExecuteTurn(turn, actor, world);
    if (!validation.valid) {
      throw new Error(`fixture turn is illegal: ${validation.rejections.map((r) => r.reason).join()}`);
    }
    const { effect } = applyTurn({
      world,
      actorId: "goblin_1",
      turn,
      plan: validation.plan,
      context: { statBlocks },
      rng: scripted([d20Exactly(18)]),
    });

    expect(effect.attacks[0]?.outcome).toBe("hit");
    expect(effect.attacks[0]?.damageRolls).toEqual([{ kind: "flat", total: 1 }]);
    expect(effect.damageDealt).toBe(1);
  });

  it("gives each extra-damage rider its own entry in damageRolls", () => {
    const riderBlock: MonsterStatBlock = {
      ...GOBLIN_WARRIOR,
      monsterId: "rider_test_fixture",
      actions: [
        {
          actionId: "scimitar",
          nameEnglish: "Scimitar",
          attackBonus: 4,
          reachFeet: 5,
          damage: { diceNotation: "1d6+2", averageDamage: 5, damageType: "slashing" },
          extraDamage: [{ diceNotation: "1d4", averageDamage: 2, damageType: "poison" }],
        },
      ],
    };
    const statBlocks = new Map([...STAT_BLOCKS, ["rider_test_fixture", riderBlock]]);
    const world = {
      ...built.world,
      combatants: built.world.combatants.map((each) =>
        each.combatantId === "goblin_1" ? { ...each, monsterId: "rider_test_fixture" } : each,
      ),
    };
    const actor = world.combatants.find((each) => each.combatantId === "goblin_1");
    if (actor === undefined) throw new Error("no actor");
    const turn = attack("goblin_1", "guard_1", "scimitar");
    const validation = validateExecuteTurn(turn, actor, world);
    if (!validation.valid) {
      throw new Error(`fixture turn is illegal: ${validation.rejections.map((r) => r.reason).join()}`);
    }
    // Attack roll: 18. Main damage 1d6+2 at 0.5 -> floor(0.5*6)+1=4, +2=6.
    // Extra 1d4 at 0.5 -> floor(0.5*4)+1=3 (a d4 and a d6 give DIFFERENT
    // faces for the same 0.5 rng value -- rollDie's formula is
    // floor(rng()*sides)+1, so this is not the same 4 the d6 above rolled).
    const { effect } = applyTurn({
      world,
      actorId: "goblin_1",
      turn,
      plan: validation.plan,
      context: { statBlocks },
      rng: scripted([d20Exactly(18), 0.5, 0.5]),
    });

    expect(effect.attacks[0]?.damageRolls).toEqual([
      { kind: "dice", notation: "1d6+2", rolls: [4], modifier: 2, total: 6 },
      { kind: "dice", notation: "1d4", rolls: [3], modifier: 0, total: 3 },
    ]);
    expect(effect.damageDealt).toBe(9);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @ai-dm/rules-engine exec vitest run src/encounter/resolve.test.ts
```

Expected: FAIL — `effect.attacks[0]?.attackRoll` and `.damageRolls` are `undefined` (the field doesn't exist yet).

- [ ] **Step 3: Promote AttackOutcome to schemas**

In `packages/rules-engine/src/combat/index.ts`, add an import at the top (after the existing `import type { RollMode } from "../checks/index.js";` line):

```ts
import type { AttackOutcome } from "@ai-dm/schemas";
```

Then delete this line (the local declaration):

```ts
export type AttackOutcome = "hit" | "miss" | "critical_hit" | "critical_miss";
```

and replace it with a type-only re-export so every existing importer (`resolve.ts`'s `import type { AttackOutcome, ... } from "../combat/index.js"`) keeps working unchanged:

```ts
export type { AttackOutcome };
```

- [ ] **Step 4: Enrich AttackRecord and damageFrom in resolve.ts**

In `packages/rules-engine/src/encounter/resolve.ts`, change the import block from:

```ts
import { roll } from "../dice/index.js";
import type { Rng } from "../dice/index.js";
import { applyDamage, coverAgainst, resolveAttack } from "../combat/index.js";
import type { AttackOutcome, CombatWorld, CoverLevel, TurnPlan } from "../combat/index.js";
import type {
  Combatant,
  DamageRoll,
  EntityStatus,
  ExecuteTurn,
  MonsterAttack,
  MonsterStatBlock,
} from "@ai-dm/schemas";
```

to:

```ts
import { roll } from "../dice/index.js";
import type { Rng } from "../dice/index.js";
import { applyDamage, coverAgainst, resolveAttack } from "../combat/index.js";
import type { AttackOutcome, CombatWorld, TurnPlan } from "../combat/index.js";
import type {
  AttackRollTrace,
  Combatant,
  DamageRoll,
  DamageRollTrace,
  EntityStatus,
  ExecuteTurn,
  MonsterAttack,
  MonsterStatBlock,
} from "@ai-dm/schemas";
```

(`CoverLevel` is removed — it was only used by the field being dropped below.)

Find the `AttackRecord` interface:

```ts
export interface AttackRecord {
  attackerId: string;
  targetId: string;
  actionId: string;
  outcome: AttackOutcome;
  cover: CoverLevel;
  damage: number;
  targetStatusAfter: EntityStatus;
}
```

Replace it with:

```ts
export interface AttackRecord {
  attackerId: string;
  targetId: string;
  actionId: string;
  outcome: AttackOutcome;
  damage: number;
  targetStatusAfter: EntityStatus;
  attackRoll: AttackRollTrace;
  damageRolls: DamageRollTrace[];
}
```

Find `damageFrom`:

```ts
/** Dice when the roll has them, the printed average when it is flat damage. */
function damageFrom(damage: DamageRoll, critical: boolean, rng: Rng): number {
  if (damage.diceNotation === undefined) return damage.averageDamage;
  return roll(damage.diceNotation, rng, { critical }).total;
}
```

Replace it with:

```ts
/** Dice when the roll has them, the printed average when it is flat damage.
 *  Returns the full trace, not just the total, so the combat log can show
 *  the roll itself, not only its result. */
function damageFrom(damage: DamageRoll, critical: boolean, rng: Rng): DamageRollTrace {
  if (damage.diceNotation === undefined) return { kind: "flat", total: damage.averageDamage };
  const r = roll(damage.diceNotation, rng, { critical });
  return { kind: "dice", notation: r.notation, rolls: r.rolls, modifier: r.modifier, total: r.total };
}
```

Find the attack loop's damage section:

```ts
    let damage = 0;
    let statusAfter: EntityStatus = target.status;

    if (result.hit) {
      const critical = result.outcome === "critical_hit";
      damage = damageFrom(attack.damage, critical, rng);
      for (const extra of attack.extraDamage) damage += damageFrom(extra, critical, rng);
```

Replace it with:

```ts
    let damage = 0;
    const damageRolls: DamageRollTrace[] = [];
    let statusAfter: EntityStatus = target.status;

    if (result.hit) {
      const critical = result.outcome === "critical_hit";
      const mainTrace = damageFrom(attack.damage, critical, rng);
      damageRolls.push(mainTrace);
      damage = mainTrace.total;
      for (const extra of attack.extraDamage) {
        const extraTrace = damageFrom(extra, critical, rng);
        damageRolls.push(extraTrace);
        damage += extraTrace.total;
      }
```

Find the `attacks.push` call:

```ts
    attacks.push({
      attackerId: input.actorId,
      targetId: swing.targetId,
      actionId: attack.actionId,
      outcome: result.outcome,
      cover,
      damage,
      targetStatusAfter: statusAfter,
    });
```

Replace it with:

```ts
    attacks.push({
      attackerId: input.actorId,
      targetId: swing.targetId,
      actionId: attack.actionId,
      outcome: result.outcome,
      damage,
      targetStatusAfter: statusAfter,
      attackRoll: {
        naturalRoll: result.naturalRoll,
        rolls: result.rolls,
        total: result.total,
        targetArmorClass: result.effectiveArmorClass,
      },
      damageRolls,
    });
```

Note: `cover` (the local variable computed via `coverAgainst`, a few lines above the loop body shown here) is still used — it's still passed into `resolveAttack({ ..., cover })` above this block. Only the field on the pushed `AttackRecord` is removed; the variable and the call that uses it stay exactly as they are.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/rules-engine exec vitest run src/encounter/resolve.test.ts
```

Expected: PASS, all extended and new tests green.

- [ ] **Step 6: Full rules-engine suite and typecheck**

```bash
pnpm --filter @ai-dm/rules-engine typecheck
pnpm --filter @ai-dm/rules-engine test
```

Expected: 0 typecheck errors; 332 + the new tests, all passing. (If any *other* existing test in this package references `AttackRecord.cover`, it will fail here — grep confirmed no such reference exists as of this plan's writing, but if the grep is stale, fix the failing test by removing its `cover` assertion, not by re-adding the field.)

- [ ] **Step 7: Commit**

```bash
git add packages/rules-engine/src/combat/index.ts packages/rules-engine/src/encounter/resolve.ts packages/rules-engine/src/encounter/resolve.test.ts
git commit -m "feat(rules-engine): capture attack and damage roll detail on AttackRecord

resolveAttack() and roll() already compute everything needed to show
'18 + 5 = 23 vs AC 15' and '1d6+3 -> 7' -- this was being discarded
down to {outcome, damage: number} before an AttackRecord was built.
No change to combat math, HP application, or death handling.

Also promotes AttackOutcome to @ai-dm/schemas (it had no schema
counterpart despite being a closed enum on the wire) and drops
AttackRecord.cover, which had no reader anywhere in the codebase."
```

---

## Task 3: Server — emit movedFeet on dice_rolled

**Files:**
- Modify: `apps/server/src/core/pipeline.ts`
- Test: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `effect.attacks` (Task 2's enriched shape, already flowing through unchanged), `effect.movedFeet` (already existed on `TurnEffect`, unchanged).
- Produces: `dice_rolled` event payloads now include `movedFeet`. `action_validated` payloads are unchanged (already match `ActionValidatedPayload` from Task 1).

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/core/pipeline.test.ts`, in the `describe("handleCommand — structured action", ...)` block (the same block containing `"records the dice seed in the event so replay does not re-derive it"` — add this test right after it):

```ts
  it("records movedFeet on the dice_rolled event for a turn that moved", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    // Hero starts at [5, 4] in goblin-ambush. Move 2 tiles east (Chebyshev
    // distance 2, normal terrain) then dodge -- legal, and a clean 2 * 5ft
    // = 10ft to assert against.
    const moveAndDodge: ClientMessage = {
      type: "structured_action",
      clientMessageId: "c1",
      actorId: "hero",
      turn: {
        actorId: "hero",
        movement: [{ destinationTile: [7, 4], pathType: "direct" }],
        mainAction: { actionType: "dodge" },
        tacticalRationaleEnglish: "Test fixture: move then dodge.",
      },
    };

    await drain(handleCommand(session, moveAndDodge, portsWith(store)));
    const rolled = (await store.readSince("s1", 0)).find((each) => each.type === "dice_rolled");
    expect(rolled?.payload).toMatchObject({ movedFeet: 10 });
  });

  it("records movedFeet: 0 on a dice_rolled event for a turn with no movement", async () => {
    const store = createInMemoryEventStore();
    const session = await freshSession(store);
    await drain(handleCommand(session, dodge("hero"), portsWith(store)));
    const rolled = (await store.readSince("s1", 0)).find((each) => each.type === "dice_rolled");
    expect(rolled?.payload).toMatchObject({ movedFeet: 0 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable
pnpm --filter @ai-dm/server exec vitest run src/core/pipeline.test.ts -t "movedFeet"
```

Expected: FAIL — `rolled?.payload` has no `movedFeet` key (`toMatchObject` fails on the missing property).

- [ ] **Step 3: Add movedFeet to both dice_rolled emit sites**

In `apps/server/src/core/pipeline.ts`, find (in `enemyTurn`):

```ts
    yield* emit("dice_rolled", { actorId, seed, attacks: effect.attacks });
```

Replace with:

```ts
    yield* emit("dice_rolled", { actorId, seed, attacks: effect.attacks, movedFeet: effect.movedFeet });
```

Find (in the `structured_action` handler):

```ts
        yield* emit("dice_rolled", { actorId: command.actorId, seed, attacks: effect.attacks });
```

Replace with:

```ts
        yield* emit("dice_rolled", {
          actorId: command.actorId,
          seed,
          attacks: effect.attacks,
          movedFeet: effect.movedFeet,
        });
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/server exec vitest run src/core/pipeline.test.ts -t "movedFeet"
```

Expected: PASS, both new tests green.

- [ ] **Step 5: Full server suite and typecheck**

```bash
pnpm --filter @ai-dm/server typecheck
pnpm --filter @ai-dm/server test
```

Expected: 0 typecheck errors; 100 + the 2 new tests, all passing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/core/pipeline.ts apps/server/src/core/pipeline.test.ts
git commit -m "feat(server): emit movedFeet on dice_rolled events

TurnEffect.movedFeet was already computed (accounting for terrain
cost) and never emitted. action_validated needed no change -- it
already sends exactly {actorId, turn, source}, which Task 1's new
ActionValidatedPayload schema just gives the client a safe way to
read."
```

---

## Task 4: Web — i18n additions and the ActionBar label cleanup

**Files:**
- Modify: `apps/web/src/i18n.ts`
- Modify: `apps/web/src/components/ActionBar.tsx`
- Test: `apps/web/src/i18n.test.ts`

**Interfaces:**
- Produces: `he.log.*` namespace; `actionLabel(actionType: string): string | undefined` exported from `i18n.ts`.
- Consumed by: Task 6 (`CombatLog.tsx`), and `ActionBar.tsx` (this task, replacing its private lookup).

- [ ] **Step 1: Write the failing test**

Read `apps/web/src/i18n.test.ts` first to match its exact existing style, then add:

```ts
describe("actionLabel", () => {
  it("returns the Hebrew label for a universal (no-actionId) action", () => {
    expect(actionLabel("dodge")).toBe(he.actions.dodge);
    expect(actionLabel("dash")).toBe(he.actions.dash);
    expect(actionLabel("disengage")).toBe(he.actions.disengage);
  });

  it("returns undefined for an action type with no universal label", () => {
    expect(actionLabel("attack")).toBeUndefined();
  });
});
```

Add `actionLabel` to the existing import from `./i18n.js` (or `./i18n.ts` relative import, matching whatever the file's other imports already use) at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

```bash
corepack enable
pnpm --filter @ai-dm/web exec vitest run src/i18n.test.ts -t "actionLabel"
```

Expected: FAIL — `actionLabel` is not exported from `i18n.ts`.

- [ ] **Step 3: Add the log namespace and actionLabel helper to i18n.ts**

In `apps/web/src/i18n.ts`, add a new `log:` key to the `he` object, after the existing `rejections:` block and before the closing `} as const;`:

```ts
  log: {
    heading: "יומן קרב",
    turnOf: "תור",
    hit: "פגיעה",
    criticalHit: "פגיעה קריטית",
    miss: "החטאה",
    criticalMiss: "החטאה קריטית",
    vsArmor: "מול שריון",
    damage: "נזק",
    moved: "זז",
    feet: "רגל",
    forfeited: "התור פג — לא בוצעה פעולה",
  },
```

Then, after the existing `rejectionMessage` function at the bottom of the file, add:

```ts
const UNIVERSAL_ACTION_LABELS: Record<string, string | undefined> = {
  dodge: he.actions.dodge,
  dash: he.actions.dash,
  disengage: he.actions.disengage,
};

/** Hebrew label for an action type that has no `actionId` (dodge/dash/
 *  disengage). `undefined` for anything else — `attack`/`cast_spell`/etc.
 *  get their name from the catalogue instead, never from this table. */
export function actionLabel(actionType: string): string | undefined {
  return UNIVERSAL_ACTION_LABELS[actionType];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @ai-dm/web exec vitest run src/i18n.test.ts -t "actionLabel"
```

Expected: PASS.

- [ ] **Step 5: Point ActionBar.tsx at the shared helper**

In `apps/web/src/components/ActionBar.tsx`, delete the private lookup:

```ts
const UNIVERSAL_LABELS: Record<string, string | undefined> = {
  dodge: he.actions.dodge,
  dash: he.actions.dash,
  disengage: he.actions.disengage,
};
```

Change the import line from:

```ts
import { he } from "../i18n.js";
```

to:

```ts
import { actionLabel, he } from "../i18n.js";
```

Find the one usage site:

```ts
      action.actionId === undefined ? UNIVERSAL_LABELS[action.actionType] : undefined;
```

Replace with:

```ts
      action.actionId === undefined ? actionLabel(action.actionType) : undefined;
```

- [ ] **Step 6: Run the full web test suite to confirm no regression**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS — `ActionBar.test.tsx` is unchanged and should pass unmodified, since this is a pure extraction with identical behavior.

- [ ] **Step 7: Typecheck and lint the touched files**

```bash
pnpm --filter @ai-dm/web typecheck
npx eslint apps/web/src/i18n.ts apps/web/src/i18n.test.ts apps/web/src/components/ActionBar.tsx
```

Expected: 0 typecheck errors; eslint exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/i18n.ts apps/web/src/i18n.test.ts apps/web/src/components/ActionBar.tsx
git commit -m "feat(web): add combat-log i18n strings and share the action-label lookup

New he.log.* namespace for the upcoming CombatLog component (Task 6).
ActionBar's private UNIVERSAL_LABELS moves to i18n.ts as actionLabel(),
since CombatLog becomes a second consumer of the same dodge/dash/
disengage -> Hebrew mapping -- one definition instead of two that must
agree."
```

---

## Task 5: Web — fold combat-log state in the store

**Files:**
- Modify: `apps/web/src/state/store.ts`
- Test: `apps/web/src/state/store.test.ts`

**Interfaces:**
- Consumes: `DiceRolledPayload`, `ActionValidatedPayload` from `@ai-dm/schemas` (Task 1).
- Produces: `ClientState.combatLog: CombatLogTurn[]`, and the `CombatLogTurn` interface itself — Task 6 (`CombatLog.tsx`) and Task 7 (`App.tsx`) both depend on this exact shape:

```ts
export interface CombatLogTurn {
  actorId: string;
  actionType: ActionType | undefined;
  movedFeet: number;
  attacks: AttackTrace[];
  forfeited: boolean;
}
```

- [ ] **Step 1: Write the failing tests**

First, extend the top-of-file imports in `apps/web/src/state/store.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fold } from "@ai-dm/schemas";
import type { GameEvent, ServerFrame, SessionState } from "@ai-dm/schemas";
import { applyFrame, initialClientState } from "./store.js";
import type { ClientState } from "./store.js";
import { combatant } from "./combatant-fixture.js";
```

(Adds `vi` for a `console.warn` spy in the malformed-payload test below.)

Add these tests, in a new `describe("combatLog", ...)` block after the existing `describe("applyFrame", ...)` block's closing brace:

```ts
describe("combatLog", () => {
  it("opens a group on action_validated and fills it in on dice_rolled", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis,
    });
    client = applyFrame(client, {
      type: "event",
      event: event(1, "action_validated", {
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "attack", actionId: "spear", targetIds: ["goblin-a"] },
          tacticalRationaleEnglish: "Test fixture.",
        },
        source: "human",
      }),
    });

    expect(client.combatLog).toHaveLength(1);
    expect(client.combatLog[0]).toEqual({
      actorId: "hero",
      actionType: "attack",
      movedFeet: 0,
      attacks: [],
      forfeited: false,
    });

    const attackTrace = {
      attackerId: "hero",
      targetId: "goblin-a",
      actionId: "spear",
      outcome: "hit" as const,
      damage: 6,
      targetStatusAfter: "alive" as const,
      attackRoll: { naturalRoll: 18, rolls: [18], total: 21, targetArmorClass: 15 },
      damageRolls: [{ kind: "dice" as const, notation: "1d6+1", rolls: [5], modifier: 1, total: 6 }],
    };
    client = applyFrame(client, {
      type: "event",
      event: event(2, "dice_rolled", { actorId: "hero", movedFeet: 10, attacks: [attackTrace] }),
    });

    expect(client.combatLog).toHaveLength(1);
    expect(client.combatLog[0]?.movedFeet).toBe(10);
    expect(client.combatLog[0]?.attacks).toEqual([attackTrace]);
  });

  it("marks a forfeited turn when scene_changed arrives with no matching action_validated", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis, // currentActorIndex: 0 -> "hero" is up
    });

    // No action_validated / dice_rolled for "hero" at all -- straight to
    // turn_advanced, the shape of a 10s tactical-budget abort.
    client = applyFrame(client, {
      type: "event",
      event: event(1, "scene_changed", { kind: "turn_advanced" }),
    });

    expect(client.combatLog).toEqual([
      { actorId: "hero", actionType: undefined, movedFeet: 0, attacks: [], forfeited: true },
    ]);
  });

  it("does not duplicate a group when scene_changed follows a normal action_validated", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis,
    });
    client = applyFrame(client, {
      type: "event",
      event: event(1, "action_validated", {
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
        source: "human",
      }),
    });
    client = applyFrame(client, {
      type: "event",
      event: event(2, "dice_rolled", { actorId: "hero", movedFeet: 0, attacks: [] }),
    });
    client = applyFrame(client, {
      type: "event",
      event: event(3, "scene_changed", { kind: "turn_advanced" }),
    });

    expect(client.combatLog).toHaveLength(1);
  });

  it("skips a malformed dice_rolled payload without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis,
    });
    client = applyFrame(client, {
      type: "event",
      event: event(1, "action_validated", {
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
        source: "human",
      }),
    });

    // Missing movedFeet -- the pre-migration shape from Task 1's schema test.
    client = applyFrame(client, {
      type: "event",
      event: event(2, "dice_rolled", { actorId: "hero", attacks: [] }),
    });

    expect(client.combatLog).toHaveLength(1);
    expect(client.combatLog[0]?.movedFeet).toBe(0); // untouched, group stays as action_validated left it
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("clears combatLog on a session_state resync", () => {
    let client = applyFrame(initialClientState, {
      type: "session_state",
      sequence: 0,
      snapshot: genesis,
    });
    client = applyFrame(client, {
      type: "event",
      event: event(1, "action_validated", {
        actorId: "hero",
        turn: {
          actorId: "hero",
          mainAction: { actionType: "dodge" },
          tacticalRationaleEnglish: "Test fixture.",
        },
        source: "human",
      }),
    });
    expect(client.combatLog).toHaveLength(1);

    client = applyFrame(client, { type: "session_state", sequence: 12, snapshot: genesis });
    expect(client.combatLog).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable
pnpm --filter @ai-dm/web exec vitest run src/state/store.test.ts -t "combatLog"
```

Expected: FAIL — `client.combatLog` is `undefined` (the field does not exist on `ClientState` yet).

- [ ] **Step 3: Add CombatLogTurn, combatLog, and foldCombatLog to store.ts**

In `apps/web/src/state/store.ts`, change the import block from:

```ts
import { reduce } from "@ai-dm/schemas";
import type { ServerFrame, SessionState, TurnAffordances } from "@ai-dm/schemas";
```

to:

```ts
import { reduce } from "@ai-dm/schemas";
import { ActionValidatedPayload, DiceRolledPayload } from "@ai-dm/schemas";
import type { ActionType, AttackTrace, ServerFrame, SessionState, TurnAffordances } from "@ai-dm/schemas";
```

Add this interface and constant after the existing `ClientState` interface's closing brace:

```ts
/**
 * One turn's worth of combat-log content, built client-side from
 * `action_validated` + `dice_rolled` + `scene_changed` events. Not part of
 * `SessionState` and not folded by `reduce()` -- purely additive display
 * state, the same category as `narrative` below.
 */
export interface CombatLogTurn {
  actorId: string;
  /** `undefined` only when `forfeited` is true -- no action was ever validated. */
  actionType: ActionType | undefined;
  movedFeet: number;
  attacks: AttackTrace[];
  forfeited: boolean;
}
```

Add `combatLog: CombatLogTurn[];` to the `ClientState` interface, and `combatLog: [],` to `initialClientState`.

Add this function before `applyFrame`:

```ts
/**
 * Folds one event into the combat log. Parsing is defensive here, unlike
 * `reduce()`: a malformed `dice_rolled`/`action_validated` payload -- most
 * likely a `dice_rolled` event persisted before this feature shipped, which
 * lacks `movedFeet` -- is skipped with a warning rather than thrown, because
 * the combat log is a display feature layered on top of state, not state
 * itself. `reduce()`'s own throw-on-malformed-payload policy for
 * `state_delta_applied`/`scene_changed`/`player_input` is untouched by this
 * function and remains correct: the game genuinely cannot render without
 * valid state, but it can render just fine with an incomplete log.
 *
 * `snapshotBefore` is the snapshot as it stood before THIS event -- needed
 * on `scene_changed: turn_advanced` to know whose turn just ended, since the
 * fold that actually updates `currentActorIndex` happens separately (in
 * `reduce`, called alongside this from `applyFrame`).
 */
function foldCombatLog(
  log: readonly CombatLogTurn[],
  snapshotBefore: SessionState,
  event: GameEvent,
): CombatLogTurn[] {
  switch (event.type) {
    case "action_validated": {
      const parsed = ActionValidatedPayload.safeParse(event.payload);
      if (!parsed.success) {
        console.warn("combatLog: skipping malformed action_validated payload", parsed.error);
        return [...log];
      }
      return [
        ...log,
        {
          actorId: parsed.data.actorId,
          actionType: parsed.data.turn.mainAction.actionType,
          movedFeet: 0,
          attacks: [],
          forfeited: false,
        },
      ];
    }

    case "dice_rolled": {
      const parsed = DiceRolledPayload.safeParse(event.payload);
      if (!parsed.success) {
        console.warn("combatLog: skipping malformed dice_rolled payload", parsed.error);
        return [...log];
      }
      const last = log.at(-1);
      if (last === undefined || last.actorId !== parsed.data.actorId) return [...log];
      return [
        ...log.slice(0, -1),
        { ...last, attacks: parsed.data.attacks, movedFeet: parsed.data.movedFeet },
      ];
    }

    case "scene_changed": {
      // No .safeParse() here, unlike the two cases above: reduce()'s own
      // scene_changed case DOES call SceneChangedPayload.parse and throws on
      // a malformed kind, and applyFrame computes `snapshot: reduce(...)`
      // before `combatLog: foldCombatLog(...)` in the same object literal --
      // so a bad payload never reaches this branch at all, it throws first.
      // dice_rolled and action_validated get no such upstream gate (reduce()
      // no-ops both), which is exactly why they need their own parse above.
      if (event.payload["kind"] !== "turn_advanced") return [...log];
      const currentActorId = snapshotBefore.turnOrder[snapshotBefore.currentActorIndex];
      if (currentActorId === undefined) return [...log];
      const last = log.at(-1);
      if (last !== undefined && last.actorId === currentActorId) return [...log];
      // No group was ever opened for the actor whose turn just ended -- a
      // forfeit (e.g. the tactical-budget timeout).
      return [
        ...log,
        { actorId: currentActorId, actionType: undefined, movedFeet: 0, attacks: [], forfeited: true },
      ];
    }

    default:
      return [...log];
  }
}
```

Note: `GameEvent` must be imported as a type. Check the top-of-file type import — if `GameEvent` is not already imported, add it to the `import type { ... } from "@ai-dm/schemas";` line.

Now wire it into `applyFrame`. Find the `session_state` case:

```ts
    case "session_state":
      // Authoritative on arrival. Affordances computed against an older board
      // go with it — the server sends a fresh set if the player is up. A
      // `session_state` only ever arrives on join or resync, so any
      // transient UI state from before it — an in-flight error, a rejection
      // toast — describes a moment that is now stale; both are cleared with
      // it rather than surviving to render as if they just happened.
      return {
        ...state,
        snapshot: frame.snapshot,
        sequence: frame.sequence,
        affordances: null,
        lastError: null,
        lastRejection: null,
      };
```

Replace with (adds `combatLog: []` and the comment explaining it):

```ts
    case "session_state":
      // Authoritative on arrival. Affordances computed against an older board
      // go with it — the server sends a fresh set if the player is up. A
      // `session_state` only ever arrives on join or resync, so any
      // transient UI state from before it — an in-flight error, a rejection
      // toast, prior combat-log entries — describes a moment that is now
      // stale; all are cleared with it rather than surviving to render as
      // if they just happened.
      return {
        ...state,
        snapshot: frame.snapshot,
        sequence: frame.sequence,
        affordances: null,
        lastError: null,
        lastRejection: null,
        combatLog: [],
      };
```

Find the `event` case:

```ts
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
```

Replace with:

```ts
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
        combatLog: foldCombatLog(state.combatLog, state.snapshot, frame.event),
      };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/web exec vitest run src/state/store.test.ts
```

Expected: PASS — every test in the file, including the pre-existing fold-parity tests (unaffected by this change) and the new `combatLog` block.

- [ ] **Step 5: Typecheck and full web suite**

```bash
pnpm --filter @ai-dm/web typecheck
pnpm --filter @ai-dm/web test
```

Expected: 0 typecheck errors; all web tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/state/store.ts apps/web/src/state/store.test.ts
git commit -m "feat(web): fold combat-log state from action_validated/dice_rolled

CombatLogTurn accumulates client-side, grouped by turn, the same way
narrative/lastError already work -- additive display state alongside
reduce(), not inside it. Detects the forfeit case (a scene_changed
with no matching action_validated -- the 10s tactical-budget timeout)
almost for free, since the same grouping already has to track whose
turn is open.

Parsing is defensive: a malformed dice_rolled/action_validated payload
(e.g. one persisted before this shipped, missing movedFeet) is skipped
with a console.warn rather than thrown, since the combat log is a
display feature layered on state, not state itself."
```

---

## Task 6: Web — the CombatLog component

**Files:**
- Create: `apps/web/src/components/CombatLog.tsx`
- Test: `apps/web/src/components/CombatLog.test.tsx`

**Interfaces:**
- Consumes: `CombatLogTurn` (Task 5), `CatalogueCombatant` (existing, `net/api.js`), `he.log.*` / `actionLabel()` (Task 4).
- Produces: `CombatLog` component, `CombatLogProps` — Task 7 (`App.tsx`) mounts it with `turns={state.combatLog}` and `catalogue={catalogue.combatants}`.

- [ ] **Step 1: Write the failing tests**

Check `apps/web/src/components/panes.test.tsx` or `ActionBar.test.tsx` first for the exact `render`/`screen` import convention this codebase uses (`@testing-library/react`), then create `apps/web/src/components/CombatLog.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CatalogueCombatant } from "../net/api.js";
import type { CombatLogTurn } from "../state/store.js";
import { CombatLog } from "./CombatLog.js";
import { he } from "../i18n.js";

const catalogue: CatalogueCombatant[] = [
  { combatantId: "hero", nameEnglish: "Guard", maxHp: 11, faction: "party" },
  { combatantId: "goblin-a", nameEnglish: "Goblin Warrior", maxHp: 10, faction: "hostile" },
];

describe("CombatLog", () => {
  it("renders nothing when there are no turns yet", () => {
    const { container } = render(<CombatLog turns={[]} catalogue={catalogue} />);
    expect(container.querySelector(".log-entry")).toBeNull();
  });

  it("renders a turn header naming the actor via the catalogue", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "hero", actionType: "dodge", movedFeet: 0, attacks: [], forfeited: false },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(/Guard/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(he.log.turnOf))).toBeInTheDocument();
  });

  it("renders a non-attack action's label", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "hero", actionType: "dodge", movedFeet: 0, attacks: [], forfeited: false },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.actions.dodge)).toBeInTheDocument();
  });

  it("renders a movement line when movedFeet is greater than zero", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "hero", actionType: "dash", movedFeet: 30, attacks: [], forfeited: false },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(/30/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(he.log.feet))).toBeInTheDocument();
  });

  it("renders an attack line with the roll, target AC, outcome and damage", () => {
    const turns: CombatLogTurn[] = [
      {
        actorId: "goblin-a",
        actionType: "attack",
        movedFeet: 0,
        forfeited: false,
        attacks: [
          {
            attackerId: "goblin-a",
            targetId: "hero",
            actionId: "scimitar",
            outcome: "critical_hit",
            damage: 10,
            targetStatusAfter: "alive",
            attackRoll: { naturalRoll: 20, rolls: [20], total: 24, targetArmorClass: 16 },
            damageRolls: [
              { kind: "dice", notation: "1d6+2", rolls: [4, 4], modifier: 2, total: 10 },
            ],
          },
        ],
      },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.criticalHit)).toBeInTheDocument();
    expect(screen.getByText(/20/)).toBeInTheDocument(); // natural roll
    expect(screen.getByText(/24/)).toBeInTheDocument(); // total
    expect(screen.getByText(/16/)).toBeInTheDocument(); // target AC
    expect(screen.getByText(/10/)).toBeInTheDocument(); // damage total
  });

  it("renders a miss with no damage line", () => {
    const turns: CombatLogTurn[] = [
      {
        actorId: "goblin-a",
        actionType: "attack",
        movedFeet: 0,
        forfeited: false,
        attacks: [
          {
            attackerId: "goblin-a",
            targetId: "hero",
            actionId: "scimitar",
            outcome: "miss",
            damage: 0,
            targetStatusAfter: "alive",
            attackRoll: { naturalRoll: 3, rolls: [3], total: 7, targetArmorClass: 16 },
            damageRolls: [],
          },
        ],
      },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.miss)).toBeInTheDocument();
    expect(screen.queryByText(he.log.damage)).not.toBeInTheDocument();
  });

  it("renders a flat damage roll without dice notation", () => {
    const turns: CombatLogTurn[] = [
      {
        actorId: "goblin-a",
        actionType: "attack",
        movedFeet: 0,
        forfeited: false,
        attacks: [
          {
            attackerId: "goblin-a",
            targetId: "hero",
            actionId: "dagger",
            outcome: "hit",
            damage: 1,
            targetStatusAfter: "alive",
            attackRoll: { naturalRoll: 15, rolls: [15], total: 18, targetArmorClass: 12 },
            damageRolls: [{ kind: "flat", total: 1 }],
          },
        ],
      },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.hit)).toBeInTheDocument();
  });

  it("renders the forfeited line and no action label for a timed-out turn", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "goblin-a", actionType: undefined, movedFeet: 0, attacks: [], forfeited: true },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(he.log.forfeited)).toBeInTheDocument();
  });

  it("falls back to the raw actorId when the catalogue has no matching entry", () => {
    const turns: CombatLogTurn[] = [
      { actorId: "unknown-id", actionType: "dodge", movedFeet: 0, attacks: [], forfeited: false },
    ];
    render(<CombatLog turns={turns} catalogue={catalogue} />);
    expect(screen.getByText(/unknown-id/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable
pnpm --filter @ai-dm/web exec vitest run src/components/CombatLog.test.tsx
```

Expected: FAIL — `./CombatLog.js` does not exist.

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/CombatLog.tsx`:

```tsx
// The mechanical trace behind the narrated outcome: attack rolls vs AC,
// damage dice, movement, grouped by turn. Player-facing (spec
// docs/superpowers/specs/2026-08-20-combat-roll-log-design.md) -- every
// number here comes straight from an AttackTrace the server already
// computed and validated; this component decides nothing about legality or
// outcome, only how to display it.
//
// The numeric/roll-trace fragment of each line is wrapped in <bdi>, the
// same mixed-direction isolation NarrativePane already applies to dice
// notation in free-form narrative text -- this is a denser LTR run (a full
// "18 + 5 = 23" comparison), so the whole trace is isolated rather than
// just a single dice substring.
import type { JSX } from "react";
import type { AttackTrace } from "@ai-dm/schemas";
import { actionLabel, he } from "../i18n.js";
import type { CatalogueCombatant } from "../net/api.js";
import type { CombatLogTurn } from "../state/store.js";

export interface CombatLogProps {
  turns: CombatLogTurn[];
  catalogue: CatalogueCombatant[];
}

const OUTCOME_LABEL: Record<AttackTrace["outcome"], string> = {
  hit: he.log.hit,
  critical_hit: he.log.criticalHit,
  miss: he.log.miss,
  critical_miss: he.log.criticalMiss,
};

function formatDamageRolls(rolls: AttackTrace["damageRolls"]): string {
  return rolls
    .map((each) => (each.kind === "dice" ? `${each.notation} = ${each.total}` : String(each.total)))
    .join(" + ");
}

function AttackLine(props: { attack: AttackTrace; nameOf: (id: string) => string }): JSX.Element {
  const { attack, nameOf } = props;
  const { naturalRoll, rolls, total, targetArmorClass } = attack.attackRoll;
  const rollsText = rolls.length > 1 ? `${rolls.join(", ")} (${String(naturalRoll)})` : String(naturalRoll);
  const modifier = total - naturalRoll;
  const modifierText = modifier >= 0 ? `+ ${String(modifier)}` : `- ${String(-modifier)}`;

  return (
    <p>
      {nameOf(attack.attackerId)} ← {nameOf(attack.targetId)} ·{" "}
      <bdi>
        {rollsText} {modifierText} = {total}
      </bdi>{" "}
      {he.log.vsArmor} <bdi>{targetArmorClass}</bdi> ← {OUTCOME_LABEL[attack.outcome]}
      {attack.damageRolls.length > 0 && (
        <>
          {" "}
          · <bdi>{formatDamageRolls(attack.damageRolls)}</bdi> {he.log.damage}
        </>
      )}
    </p>
  );
}

export function CombatLog(props: CombatLogProps): JSX.Element {
  const nameOf = (id: string): string =>
    props.catalogue.find((each) => each.combatantId === id)?.nameEnglish ?? id;

  return (
    <section>
      <p className="label">{he.log.heading}</p>
      <div className="log-panel">
        {props.turns.map((turn, index) => (
          // Composite key, matching NarrativePane/ErrorBanner's convention
          // in this codebase (never a bare index): turns can repeat the same
          // actorId across a fight, so actorId alone would collide.
          <div className="log-entry" key={`${String(index)}-${turn.actorId}`}>
            <p className="log-turn-header">
              — {he.log.turnOf} {nameOf(turn.actorId)} —
            </p>
            {turn.forfeited && <p>{he.log.forfeited}</p>}
            {turn.attacks.map((attack, attackIndex) => (
              <AttackLine
                key={`${String(attackIndex)}-${attack.attackerId}-${attack.targetId}`}
                attack={attack}
                nameOf={nameOf}
              />
            ))}
            {turn.movedFeet > 0 && (
              <p>
                {nameOf(turn.actorId)} {he.log.moved} <bdi>{turn.movedFeet}</bdi> {he.log.feet}
              </p>
            )}
            {!turn.forfeited && turn.attacks.length === 0 && turn.movedFeet === 0 && turn.actionType !== undefined && (
              <p>{actionLabel(turn.actionType) ?? turn.actionType}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @ai-dm/web exec vitest run src/components/CombatLog.test.tsx
```

Expected: PASS, all 9 tests green.

- [ ] **Step 5: Typecheck and lint**

```bash
pnpm --filter @ai-dm/web typecheck
npx eslint apps/web/src/components/CombatLog.tsx apps/web/src/components/CombatLog.test.tsx
```

Expected: 0 typecheck errors; eslint exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/CombatLog.tsx apps/web/src/components/CombatLog.test.tsx
git commit -m "feat(web): add the CombatLog component

Renders CombatLogTurn[] (Task 5) as a dedicated panel: one .log-entry
per turn with a header, attack lines (roll vs AC, outcome, damage),
a movement line, and a forfeited line -- matching the layout chosen
during brainstorming (option B: a dedicated panel below the narrative
pane, over an inline-per-sentence and a persistent-sidebar alternative
that were also mocked and compared)."
```

---

## Task 7: Web — mount CombatLog in App.tsx

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `CombatLog` (Task 6), `state.combatLog` (Task 5), `catalogue.combatants` (existing).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/App.test.tsx`, after the existing full-turn test (search for the test asserting `structured.turn` parses against `ExecuteTurn` — add this new test directly after it):

```tsx
  it("shows the roll detail for a resolved attack in the combat log", async () => {
    await start();
    act(() => {
      socket.emitMessage({
        type: "session_state",
        sequence: 0,
        snapshot: snapshotWith([
          combatant("hero", "party", "alive"),
          combatant("goblin-a", "hostile", "alive"),
        ]),
      });
      socket.emitMessage({
        type: "event",
        event: event(1, "action_validated", {
          actorId: "hero",
          turn: {
            actorId: "hero",
            mainAction: { actionType: "attack", actionId: "spear", targetIds: ["goblin-a"] },
            tacticalRationaleEnglish: "Test fixture.",
          },
          source: "human",
        }),
      });
      socket.emitMessage({
        type: "event",
        event: event(2, "dice_rolled", {
          actorId: "hero",
          movedFeet: 0,
          attacks: [
            {
              attackerId: "hero",
              targetId: "goblin-a",
              actionId: "spear",
              outcome: "hit",
              damage: 6,
              targetStatusAfter: "alive",
              attackRoll: { naturalRoll: 18, rolls: [18], total: 21, targetArmorClass: 15 },
              damageRolls: [
                { kind: "dice", notation: "1d6+1", rolls: [5], modifier: 1, total: 6 },
              ],
            },
          ],
        }),
      });
    });

    expect(await screen.findByText(he.log.hit)).toBeInTheDocument();
    expect(screen.getByText(/18/)).toBeInTheDocument();
  });
```

Check the exact `event()` helper's parameter order already used elsewhere in this file (it should match `event(sequence, type, payload)` — the same helper already defined near the top of `App.test.tsx`, seen in the earlier `App.test.tsx` reads this session).

- [ ] **Step 2: Run the test to verify it fails**

```bash
corepack enable
pnpm --filter @ai-dm/web exec vitest run src/App.test.tsx -t "roll detail"
```

Expected: FAIL — `screen.findByText(he.log.hit)` never resolves (`CombatLog` is not mounted).

- [ ] **Step 3: Mount CombatLog in App.tsx**

In `apps/web/src/App.tsx`, add the import (alongside the other component imports):

```ts
import { CombatLog } from "./components/CombatLog.js";
```

Find the last line of the main render's JSX, just before the closing `</main>`:

```tsx
      <NarrativePane text={state.narrative} />
    </main>
  );
}
```

Replace with:

```tsx
      <NarrativePane text={state.narrative} />

      <CombatLog turns={state.combatLog} catalogue={catalogue.combatants} />
    </main>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @ai-dm/web exec vitest run src/App.test.tsx -t "roll detail"
```

Expected: PASS.

- [ ] **Step 5: Full web suite, typecheck, lint**

```bash
pnpm --filter @ai-dm/web typecheck
pnpm --filter @ai-dm/web test
npx eslint apps/web/src/App.tsx apps/web/src/App.test.tsx
```

Expected: 0 typecheck errors; every web test passes (73 existing + this plan's new ones); eslint exit 0.

- [ ] **Step 6: Full monorepo verification**

```bash
pnpm typecheck
npx eslint apps/server apps/web packages tools
pnpm test
```

Expected: 0 typecheck errors across all packages; eslint exit 0; full suite green (895 baseline + this plan's new tests — count precisely from the output, don't assume a number).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): mount CombatLog below the narrative pane

Closes spec #3 (docs/superpowers/specs/2026-08-20-combat-roll-log-design.md):
a player can now see the actual roll behind every narrated outcome --
attack vs AC, damage dice, movement -- not just the prose. Also
surfaces the previously-silent tactical-budget-timeout forfeit case."
```

---

## Final verification (after all 7 tasks)

- [ ] Run the full suite twice consecutively (this repo's convention for anything touching timing-sensitive server tests):

```bash
corepack enable
pnpm test
pnpm test
```

Expected: identical pass counts both times, 0 failures.

- [ ] Manual browser check against the real model (per the spec's exit criterion): start both servers (`PORT=3000 pnpm dev` from the main checkout, which holds a real provider key — see `docs/superpowers/specs/2026-08-20-combat-roll-log-design.md`'s exit criterion), play `goblin-ambush`, and confirm the combat log renders real, non-fixture roll numbers for at least one player attack and one enemy attack.

- [ ] Use `superpowers:finishing-a-development-branch` once the manual check passes.
