# Combat roll log: surfacing dice detail in the web client — design

Spec #3 of step 8. Spec #2 (the web client) is merged at `fbfb420`; a live
play-through against the real tactical model (`gpt-5.4-nano`) confirmed
`goblin-ambush` fights to conclusion with `"source":"model"` on every enemy
turn. That play-through is what motivates this spec: the player sees only
prose narrative ("Goblin Warrior misses Guard") and has no way to see the
mechanics underneath it — no roll, no AC, no damage dice.

Exit criterion: a human fights `goblin-ambush` in the browser and can read,
for every attack, damage roll, and movement, the actual numbers the engine
computed — not just the narrated outcome.

## Context

Six findings from reading the engine and protocol against this goal, in the
order they change the design:

1. **The numbers already exist; the wire just doesn't carry them.**
   `resolveAttack()` (`rules-engine/combat/index.ts`) returns
   `{ naturalRoll, rolls, total, effectiveArmorClass, outcome, hit }` — the
   entire attack-vs-AC picture. `roll()` (`rules-engine/dice/index.ts`)
   returns `{ notation, rolls, modifier, total }` for a damage roll. Both are
   computed by `encounter/resolve.ts` and discarded down to
   `{ outcome, damage: number }` before an `AttackRecord` is built. This is a
   threading problem, not a missing-computation problem.
2. **`movedFeet` is computed and never emitted at all.** `TurnEffect` carries
   it (`plan.totalMovementFeet`, already accounting for difficult terrain),
   but `pipeline.ts`'s two `dice_rolled` emit sites only send
   `{ actorId, seed, attacks }`. Client-side recomputation is not a safe
   alternative: `FEET_PER_TILE` and the terrain-cost function live in
   `rules-engine`, which `apps/web` may not import (invariant 5), and
   duplicating cost math client-side is exactly the "two definitions that
   must agree" hazard the prior slice's fix wave (M-1) called out.
3. **`AttackRecord.cover` has no reader anywhere in the codebase; `.damage`
   has exactly one** — `packages/agents/src/narrative/deterministic.ts:54`,
   building the English fallback narrative. `cover` is dropped as dead
   output; `damage` keeps its name and meaning unchanged rather than being
   renamed, so that consumer is untouched.
4. **`AttackOutcome` is a hand-duplicated type**, declared as a plain TS
   union in `rules-engine/combat/index.ts` with no schema counterpart —
   invariant 4 already governs this and the wire payload needs it as a zod
   type regardless, so this is promoted to `@ai-dm/schemas` rather than
   duplicated a second time.
5. **`dice_rolled` and `action_validated` payloads are untyped on both ends
   today.** `reduce()` no-ops both event types (they don't affect
   `SessionState`), so neither has ever had a zod schema. `action_validated`
   already emits exactly `{ actorId, turn, source }` — the server needs no
   change there, only a schema so the client can safely read what's already
   being sent.
6. **A 10-second tactical-budget abort is currently invisible to the
   player.** Confirmed live during the model play-through: a goblin's turn
   timed out (`outcome: "aborted"`, `latencyMs: 10023`), `pipeline.ts`
   forfeits the turn (`scene_changed: turn_advanced` with no preceding
   `action_validated`/`dice_rolled`), and nothing downstream ever says so —
   no narrative line, no error, nothing. The grouping logic this spec
   introduces can detect and surface this almost for free (§ Web client
   architecture), so it is included rather than deferred.

## Decisions

- **Scope is attack rolls, damage rolls, and movement.** Death saves are
  explicitly out: nothing in the encounter loop drives `rollDeathSave`
  today (`resolve.ts:183`'s own comment calls this a gap, matching
  `RULES_REFERENCE.md` §8), and the `goblin-ambush` hero has no
  `characterId` — it dies instantly at 0 HP per SRD monster rules rather
  than falling unconscious, so death saves cannot fire in this encounter
  regardless. Surfacing them needs a PC combatant and a rules-engine change
  first; that is a separate spec.
- **Full roll detail, including target AC.** "18 + 5 = 23 vs AC 15" is
  shown, not just "hit" or a bracketed estimate. This is a deliberate
  departure from table convention (a DM does not usually state a monster's
  AC outright) — for a solo game against a deterministic engine, an
  auditable "is the engine right" view was judged worth more than
  information hiding.
- **Player-facing, not a debug toggle.** Every new string is Hebrew,
  through `i18n.ts`, matching invariant 2.
- **Grouped by turn**, one header per actor's turn with its rolls nested
  under it — matching how `action_validated`/`dice_rolled` already arrive
  clustered per turn, and easier to scan than a flat per-roll stream.
- **Everything the turn did gets a line**, not just rolls — a dodge/dash
  turn with no attack still logs, so the log reads as a full turn
  transcript rather than only "interesting" turns.
- **This connection only.** The log accumulates from `event` frames in
  memory, same as `narrative`, and resets on refresh. It is not persisted
  to `sessionStorage` (a second source of truth next to the folded state —
  see invariant 3) and the server does not replay history beyond what
  `resumeFrom` already provides.
- **Layout: a dedicated panel below the narrative pane**, its own
  scrollable feed — chosen over an inline per-sentence annotation and a
  persistent grid-side sidebar (both mocked and compared).

## Non-goals

- Death saves (needs a PC combatant + a rules-engine mechanic; separate spec).
- Advantage/disadvantage labeling beyond showing both dice when the engine
  provides two — no attack in the current build passes a `RollMode` other
  than `"normal"` to `resolveAttack`, so this is forward-compatible
  plumbing, not a feature being built now.
- Persisting the log across a refresh or a reconnect.
- Any change to combat math, HP application, or death handling — every
  rules-engine change here is additive capture of numbers already computed.

## Schema additions (`packages/schemas`)

Added alongside the existing SRD/action schemas:

```ts
export const AttackOutcome = z.enum(["hit", "miss", "critical_hit", "critical_miss"]);

export const AttackRollTrace = z.object({
  naturalRoll: z.number().int().min(1).max(20),
  rolls: z.array(z.number().int()),        // 2 entries only when advantage/disadvantage rolled both dice
  total: z.number().int(),
  targetArmorClass: z.number().int(),       // already includes any cover bonus
});

export const DamageRollTrace = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dice"), notation: z.string(), rolls: z.array(z.number().int()), modifier: z.number().int(), total: z.number().int() }),
  z.object({ kind: z.literal("flat"), total: z.number().int() }),
]);

export const AttackTrace = z.object({
  attackerId: z.string(),
  targetId: z.string(),
  actionId: z.string(),
  outcome: AttackOutcome,
  damage: z.number().int(),                 // unchanged name/meaning from AttackRecord.damage
  targetStatusAfter: EntityStatus,           // reused as-is
  attackRoll: AttackRollTrace,
  damageRolls: z.array(DamageRollTrace),     // empty array on a miss
});

export const DiceRolledPayload = z.object({
  actorId: z.string(),
  attacks: z.array(AttackTrace),
  movedFeet: z.number().int().min(0),
});

export const ActionValidatedPayload = z.object({ actorId: z.string(), turn: ExecuteTurn, source: z.string() });
```

`EntityStatus`, `ExecuteTurn` are reused unchanged. `rules-engine/combat/index.ts`
switches its local `AttackOutcome` declaration to
`import type { AttackOutcome } from "@ai-dm/schemas"`, removing the duplicate.

## Rules engine (`packages/rules-engine`)

`AttackRecord` (`encounter/resolve.ts`) becomes:

```ts
interface AttackRecord {
  attackerId: string;
  targetId: string;
  actionId: string;
  outcome: AttackOutcome;         // imported from @ai-dm/schemas
  damage: number;                 // unchanged
  targetStatusAfter: EntityStatus;
  attackRoll: AttackRollTrace;    // new — type imported from schemas
  damageRolls: DamageRollTrace[]; // new — empty on a miss
}
```

Structurally identical to the wire's `AttackTrace` by construction (imported
types, not a second hand-written shape), so the server needs no mapping step
— `effect.attacks` can be passed straight through.

`damageFrom` changes from returning a bare number to returning a
`DamageRollTrace`:

```ts
function damageFrom(damage: DamageRoll, critical: boolean, rng: Rng): DamageRollTrace {
  if (damage.diceNotation === undefined) return { kind: "flat", total: damage.averageDamage };
  const r = roll(damage.diceNotation, rng, { critical });
  return { kind: "dice", notation: r.notation, rolls: r.rolls, modifier: r.modifier, total: r.total };
}
```

The attack loop keeps accumulating `damage: number` exactly as today (no
change to HP application or death handling); it additionally pushes each
trace into `damageRolls`, and builds `attackRoll` directly from
`resolveAttack`'s return (`targetArmorClass: result.effectiveArmorClass`).

## Server (`apps/server`)

`action_validated`'s two emit sites already send `{ actorId, turn, source }`
— no change. `dice_rolled`'s two emit sites (`pipeline.ts:399`, `:666`) gain
one field each:

```ts
yield* emit("dice_rolled", { actorId, seed, attacks: effect.attacks, movedFeet: effect.movedFeet });
```

`emit()` does not validate payloads against a schema at write time today
(only `reduce()` parses, and only for event types it reads) — this design
does not add write-side validation either, matching the existing pattern.

## Web client architecture (`apps/web`)

**State** — `state/store.ts` gains a `combatLog: CombatLogTurn[]` field on
`ClientState`, folded the same way `narrative`/`lastError` already are
(client-only bookkeeping alongside, not inside, `reduce()`):

```ts
export interface CombatLogTurn {
  actorId: string;
  actionType: ActionType | undefined;  // undefined only for a forfeited turn
  movedFeet: number;
  attacks: AttackTrace[];
  forfeited: boolean;
}
```

Inside `applyFrame`'s `case "event"`, a new `foldCombatLog(log, snapshotBefore, event)`
groups by `event.type`:

- `action_validated` → push a fresh group (`actionType` from
  `turn.mainAction.actionType`, empty `attacks`, `movedFeet: 0`).
- `dice_rolled` → fill the *last* group's `attacks`/`movedFeet` (defensively
  checked against the last group's `actorId` matching; should always hold
  by construction).
- `scene_changed: turn_advanced` → normally a no-op (already logged via
  `action_validated`). If the last group's actor does **not** match
  `snapshotBefore.turnOrder[snapshotBefore.currentActorIndex]`, no group was
  ever opened for the actor whose turn just ended — the forfeit case (§
  Context, finding 6). Push `{ actorId: currentActorId, actionType:
  undefined, movedFeet: 0, attacks: [], forfeited: true }`.

`session_state` clears `combatLog`, matching how it already clears
`lastError`/`lastRejection` on a resync.

**Parsing is defensive, unlike `reduce()`.** `reduce()` throws on a
malformed payload because the game cannot render without valid state. The
combat log is supplementary: a `DiceRolledPayload`/`ActionValidatedPayload`
parse failure is caught, `console.warn`ed, and the frame is skipped for
logging purposes only (state folding via `reduce()` is unaffected — that
call is separate and unconditional). This is also what makes an event
persisted before this feature shipped safe to encounter on replay: it lacks
the new fields, fails the schema, and simply produces no log entry rather
than breaking reconnect.

**Component** — `components/CombatLog.tsx`. One `.log-panel` with one
`.log-entry` per turn: a `— {he.log.turnOf} {name} —` header (actor name via
the existing catalogue lookup, same as `Grid`/`ActionBar`), then per-attack
lines from an `AttackLine` sub-component formatting `attackRoll`/
`damageRolls` into `"18 + 5 = 23 מול שריון 15 ← פגיעה · 1d6+3 = 7 נזק"`, a
movement line when `movedFeet > 0`, a forfeit line when `forfeited`, and the
plain action label (dodge/dash/disengage) when the turn had no attack and no
movement. The numeric/roll-trace fragment of each line is wrapped in
`<bdi>`, the same isolation `NarrativePane` already applies to dice
notation — this is a denser LTR run than a narrative sentence, so the whole
trace is isolated rather than just the dice substring.

Mounts in `App.tsx` immediately after `<NarrativePane>`, receiving
`state.combatLog` and `catalogue.combatants`.

**Cleanup along the way:** `ActionBar.tsx`'s private `UNIVERSAL_LABELS`
lookup (dodge/dash/disengage → Hebrew) moves to `i18n.ts` as an
`actionLabel()` helper, alongside the existing `errorMessage`/
`rejectionMessage` functions, since `CombatLog` becomes a second consumer of
the same mapping.

**i18n** — new flat `log:` namespace in `i18n.ts`, matching the existing
convention (plain string fragments, sentences composed in the component,
not template functions):

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

Drafted, not reviewed — see "Needs the user" below, matching how spec #2
handled its own Hebrew additions.

## Testing

- `rules-engine`: golden tests on `resolve.ts`'s new `attackRoll`/
  `damageRolls` fields — a hit, a miss (empty `damageRolls`), a critical
  (doubled dice), and a flat-damage stat block (`kind: "flat"`).
- `schemas`: round-trip parse tests for `DiceRolledPayload` and
  `ActionValidatedPayload` against fixtures matching the new engine shapes,
  plus a rejection test for a payload missing the new fields (the
  pre-migration/legacy-event case).
- `apps/web`: a `store.test.ts` (or extension of the existing store tests)
  covering `foldCombatLog` for the ordinary case, the forfeit case, and a
  malformed payload being skipped without throwing. An `App.test.tsx` case
  exercising one full turn through the real store and asserting the
  rendered log content, following the existing pattern of testing through
  the real component tree rather than the reducer in isolation.
- Manual: a live play-through (real model, per the prior spec's exit
  criterion) confirming the log renders correctly for real, non-fixture
  rolls.

## Needs the user, not this session

- **The Hebrew wording above.** Drafted without a glossary, same caveat as
  spec #2's additions (`actor_incapacitated`, `extra_attacks_exceed_budget`).
  None of it affects logic — a wording change is a string edit in `i18n.ts`.
- **Whether the forfeit line (§ Context, finding 6) belongs in this slice
  at all**, versus being pulled into its own fix. Included here because the
  same grouping logic already needs to exist for the ordinary case and
  detecting it costs one comparison — but it's a second thing this spec
  does beyond "show me the dice," worth a deliberate look.

## Consequences

Positive: the player can audit the engine's math directly from the UI,
closing the "narrative says it, but is it right" gap the model play-through
exposed. The 10-second-abort forfeit case, previously silent, becomes
visible. `AttackOutcome`'s duplicate declaration is removed as a side
effect.

Cost: `dice_rolled` events grow in the persisted, append-only log — this is
new persisted volume, not just wire traffic, though it is the same category
of data `action_rejected` already persists without being replayed by
anything. The web client gains one more piece of derived state to keep in
sync with events, following an established pattern rather than a novel one.
