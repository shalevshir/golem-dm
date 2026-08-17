# Tactical agent and the validate → retry → fallback loop — design

Roadmap step 7a (`PROJECT_PLAN.md` §4). Exit criteria for the step as a whole are
"legality ≥95% after retry on fixture scenarios; model chosen from data" — the
measurement half is step 7b, in `tools/sim`. This design covers the agent that
step 7b benchmarks.

## Context

`packages/agents/src/tactical/index.ts` is a stub. Step 6 landed everything
underneath it: a `LanguageModelPort` with structured tool calls, `ModelRouting`
keyed by role, discriminated `AdapterResult` errors with four stable codes, and
`LayeredPrompt` for cache-stable prefix ordering.

The contract this implements is stated in `packages/agents/CLAUDE.md`:

> **tactical/** — emits `ExecuteTurn` tool calls. Resilience loop is mandatory:
> engine validates → on rejection retry ONCE with the machine-readable reason →
> on second failure use the deterministic fallback (attack nearest legal target,
> else dodge). Log every rejection as an `action_rejected` event.

Two repo invariants shape every decision below. Invariant 1 — the rules engine is
the only authority on legality — means the agent never decides a turn is legal,
including its own fallback. Invariant 3 — the event log is the source of truth —
means every rejection has to become an event, but this package has no clock and
no UUID source, so it produces payloads and the server stamps them.

## Non-goals

- **Live model calls.** No test here touches a network. Benchmarking is 7b.
- **Choosing the tactical model.** `DEFAULT_MODEL_ROUTING.tactical` and
  `REASONING_BUDGET_TOKENS` stay untouched; both are unmeasured placeholders and
  only 7b's data should move them.
- **Encounter flow.** Whose turn it is, initiative order, round advancement —
  step 8's server owns all of it.
- **Resolution.** No dice, no damage, no state mutation. The agent proposes.
- **Transport retry.** The AI SDK's `maxRetries` already covers it; a
  `provider_error` reaching us means that budget is spent.

## Control flow: straight-line, not a loop

"Retry exactly once, never a third model call" is the invariant most likely to
rot. A `while (attempts < 2)` loop expresses it as a bound someone has to audit,
and a later edit raising the cap reads as harmless.

So `proposeTurn` is straight-line: one private `attempt()` helper invoked from
exactly two visible call sites. The count is a property of the source you can
read off the page, and deleting the second call site kills a named test rather
than quietly changing a number. The cost is a few lines of explicit sequencing,
which is the thing being bought.

## Module layout

`packages/agents/src/tactical/`, one purpose per file:

| File | Contents |
|---|---|
| `snapshot.ts` | `CombatSnapshot`, `SnapshotInput`, `buildSnapshot` |
| `prompt-text.ts` | The English prompt strings — system, retry framing |
| `prompt.ts` | `buildTacticalPrompt` → `LayeredPrompt` |
| `fallback.ts` | `deterministicFallback` |
| `action-rejected.ts` | Constructors for `ActionRejectedPayload` |
| `index.ts` | `createTacticalAgent`, `proposeTurn`, the two-attempt pipeline |

No new package dependencies: `@ai-dm/agents` already depends on
`@ai-dm/rules-engine` and `@ai-dm/schemas`.

## Where prompt text lives

`docs/prompts/README.md` says prompts live in `docs/prompts/`, versioned. Taken
literally that means either runtime `fs` reads — I/O in a package that must stay
pure, and broken bundling for the server — or a codegen step to inline markdown
into ESM. Both are machinery bought for one string.

Instead `prompt-text.ts` **is** the versioned source of record, and
`docs/prompts/README.md` gains a line pointing at it. One copy, so it cannot
drift from a markdown twin.

This sets a pattern step 9 can follow, but does not decide for it:
`hebrew-glossary.md` is a table non-programmers should be able to edit, and
whether it stays a data file is the narrative agent's call, not this one's.

## The snapshot

Combat context is a compact structured state snapshot, never dialogue history
(`packages/agents/CLAUDE.md`). It is serialised as JSON: unambiguous for the
model, and step 7b can parse a recorded prompt back into the object it came from
when comparing models. That costs tokens against a line-oriented rendering and
is worth it for a benchmark's reproducibility.

```ts
export interface SnapshotCombatant {
  combatantId: string;
  faction: Faction;
  position: Tile;
  size: CreatureSize;
  currentHp: number;
  maxHp: number;
  armorClass: number;
  /** `alive` or `unconscious`; nothing else is admitted. The fallback filters on
   *  it, so hiding it would leave the model knowing less than the backstop. */
  status: EntityStatus;
  /** Reused from `@ai-dm/schemas`, not flattened to names — `durationRounds` is
   *  tactically relevant, and inventing a parallel shape violates invariant 4. */
  conditions: readonly ActiveCondition[];
  exhaustionLevel: number;
  /** Actor-to-target, via `footprintDistanceFeet`. Absent on the actor. */
  distanceFeet?: number;
}
```

`distanceFeet` is the highest-leverage field in the whole design. Out-of-reach
proposals are the most common legality failure available to a model, and they
come from asking it to do Chebyshev arithmetic on coordinate tuples. Precomputing
the distance with the same function the validator uses
(`footprintDistanceFeet`, `packages/rules-engine/src/spatial/index.ts:87`) removes
the arithmetic and the disagreement at once.

Combatants whose `status` is `dead` or `fled` are excluded — they are not on the
board for targeting, and `validate-turn.ts:102` already treats them as
non-occupying. The surviving two statuses are kept rather than collapsed: in 5e
a melee hit on an unconscious creature is an automatic critical, and spending a
turn on a downed foe while one is still upright is a real mistake, so the model
needs the distinction the fallback already has.

The actor carries what the action economy depends on: `speedFeet`, `reachFeet`,
`attacksPerAction`, `spellSlots`, and the remaining `actionEconomy`.

### Terrain is emitted sparsely

`GridMap.tiles` (`packages/schemas/src/world.ts:9`) is a full row-major matrix. A
20×20 map is 400 JSON strings, nearly all `"normal"`. The snapshot emits `width`,
`height`, and only the non-normal tiles as `{ tile, terrain }[]`. Lossless,
because `normal` is recoverable as the default, and an order of magnitude
smaller on a typical map.

### Initiative is an input, not a projection

`packages/agents/CLAUDE.md` names initiative as part of the snapshot, but
`Combatant` (`packages/schemas/src/world.ts:49`) has no initiative field.
`CharacterSheet.initiativeModifier` exists; a *rolled order* does not, anywhere
in `@ai-dm/schemas`. Inventing one here would put encounter flow in the wrong
package.

So `SnapshotInput` accepts `turnOrder?: readonly string[]` and the snapshot
passes it through. The server supplies it in step 8; until then it is absent and
the prompt omits the section.

### Available actions come from the caller

`Combatant` carries no action list — `MonsterStatBlock.actions` does. Loading SRD
data inside `@ai-dm/agents` would cross a package boundary for no reason, so the
caller passes `availableActions?: readonly AvailableAction[]`, i.e.
`{ actionId, name }`, derived from stat blocks by the server or sim.

**Range is not among them.** The validator resolves range as
`world.actionRangesFeet[actionId] ?? actor.reachFeet` (`rangeFeetFor`,
`validate-turn.ts:192`) and never reads anything the caller hands the agent. A
caller-supplied `rangeFeet` would therefore be a second source of truth that the
model believes and the engine ignores — advertise an 80 ft bow with no
`actionRangesFeet` entry and every shot beyond 5 ft is rejected, retried against
feedback that contradicts the capability card, rejected again, and lost to the
fallback, with the `action_rejected` log blaming the model. So
`buildCapabilityCard` takes the `CombatWorld` and derives each `CardAction`'s
`rangeFeet` with the validator's own rule. `AvailableAction` is what comes in;
`CardAction` is what the model reads.

## Prompt tiers

| Tier | Contents | Cadence |
|---|---|---|
| `static` | Role, tool contract, "you propose, the engine decides", English-only | Never varies |
| `semiStatic` | The actor's capability card: actions and ranges, reach, speed, attacks per action | Per creature |
| `dynamic` | The JSON snapshot; on a retry, the rejection feedback | Every call |

The retry adds to `dynamic` only. This is the load-bearing property of the whole
prompt design and it is asserted directly: a test compares the `static` and
`semiStatic` tiers of call 1 and call 2 recorded by the fake port and requires
them byte-identical. Cache discipline stops being a convention someone has to
remember during review and becomes a failing test.

## Decision table

| Attempt 1 outcome | Then |
|---|---|
| adapter ok, engine valid | return, `source: "model"` |
| adapter ok, engine rejects | log, retry carrying the `TurnRejectionReason` codes |
| `schema_validation_failed` | log, retry quoting the zod issues |
| `no_tool_call` | log, retry plainly |
| `provider_error` | log, **fallback immediately** — no second call |
| `aborted` | log, **abandon** — no second call, no fallback |

Attempt 2: valid → `source: "retry"`. Any failure except `aborted` → fallback.
`aborted` → abandon.

The four adapter codes map exactly as
`docs/superpowers/specs/2026-08-17-provider-adapter-design.md` prescribed them;
this design does not reopen that. `provider_error` skipping the retry follows
from the SDK owning transport retries: a second call would be the same failing
call, spending latency out of a 10s turn budget for nothing.

**Abandoning on `aborted` is deliberate.** The signal is the caller's, and
returning a turn for a cancelled request hands back work nobody asked for.
`deterministicFallback` is exported, so a server that would rather have a turn
than a gap calls it directly — it costs no model call and no time.

## The fallback

Per decision: it does not move. For each hostile ordered by `(distanceFeet,
combatantId)` — the tiebreak is what makes it deterministic and therefore
replayable — build an in-place Attack and run it through `validateExecuteTurn`.
The first that validates wins. Otherwise Dodge in place.

Target selection by faction is *policy*, not rules — 5e permits attacking an
ally, so the engine has no opinion — and policy is exactly what belongs in an
agent. The proposal still goes through the validator, so invariant 1 holds: the
fallback is a proposal like any other, not a shortcut around the gate.

When `availableActions` is supplied the fallback tries each; when it is absent it
proposes an Attack with no `actionId`, which `rangeFeetFor`
(`validate-turn.ts:192`) resolves to the actor's melee reach. Both paths work,
so a caller with no stat block data still gets a sane fallback.

**The fallback can fail, and that is not a bug.** An incapacitated actor cannot
take an action at all (`validate-turn.ts:315`), so Dodge is rejected too; an
actor who has already spent its action this turn likewise. That surfaces as
`{ ok: false, kind: "no_legal_turn" }` rather than a thrown error or a turn the
engine would refuse.

## `action_rejected` payload

`action_rejected` is already in the `GameEvent` type enum with an open
`payload: z.record(z.string(), z.unknown())` (`packages/schemas/src/events.ts:12`).
This defines the payload convention; it adds no event type.

```ts
export const ActionRejectedPayload = z.object({
  actorId: z.string(),
  /** Which model attempt produced this. 1 or 2. */
  attempt: z.number().int().min(1).max(2),
  stage: z.enum(["adapter", "engine"]),
  /** Present when stage is "adapter". */
  adapterErrorCode: z.string().optional(),
  /** Present when stage is "engine". Stable `TurnRejectionReason` codes. */
  reasons: z.array(z.string()).optional(),
  /** English. Safe to persist; never shown to a player. */
  messages: z.array(z.string()),
  /** The proposal that was rejected, when the model produced one. */
  proposedTurn: ExecuteTurn.optional(),
  provider: z.string(),
  modelId: z.string(),
});
```

It lives in `packages/schemas/src/events.ts` rather than in `@ai-dm/agents`:
invariant 4 puts shared shapes in `@ai-dm/schemas`, both `apps/server` and
`tools/sim` consume it, and a replayed log needs to re-validate it at runtime.
Additive, so stored-event compatibility is unaffected.

`provider` and `modelId` are what make step 7b possible at all — without them a
log of rejections cannot be grouped by the model that produced them, which is the
entire benchmark. They are typed as `z.string()` rather than the `ProviderId`
union deliberately: an event written today must still parse after someone adds a
provider, and a closed enum in a persisted payload is a migration waiting to
happen.

`reasons` is `z.array(z.string())` for the same reason — `TurnRejectionReason` is
a rules-engine type, and `@ai-dm/schemas` sits upstream of the rules engine in
the dependency direction (`schemas ← rules-engine ← agents ← server`). Narrowing
it there would invert the dependency.

The agent returns payloads and never stamps `GameEvent`s: `eventId`, `sequence`
and `timestamp` need a UUID source, a log cursor and a clock, none of which
belong in this package. The server wraps and appends.

## Public surface

```ts
export interface TacticalAgentOptions {
  runtime: AgentRuntime;
  /** For the provider/modelId stamped on rejection payloads. */
  routing: ModelRouting;
}

export type TurnProposalResult =
  | {
      ok: true;
      turn: ExecuteTurn;
      plan: TurnPlan;
      source: "model" | "retry" | "fallback";
      rejections: readonly ActionRejectedPayload[];
      usage: readonly TokenUsage[];
    }
  | {
      ok: false;
      kind: "aborted" | "no_legal_turn";
      rejections: readonly ActionRejectedPayload[];
      usage: readonly TokenUsage[];
    };
```

A successful result always carries a real `TurnPlan` whatever the `source`,
because the fallback is validated like everything else — the caller never has to
branch on provenance to know whether the plan is trustworthy. `source` exists for
metrics, not for correctness.

`usage` accumulates per model call so the server can meter cost per turn against
the §3 target, and so 7b can price a model rather than only score it.

## Testing

No network. Behaviour runs against `createFakePort`, scripted per case.

From the task brief: a legal proposal passes through untouched; an illegal one
triggers exactly one retry carrying the `TurnRejectionReason`; a second failure
produces the fallback; `no_tool_call` and `provider_error` each route correctly;
every rejection emits an `action_rejected` payload.

Beyond it:

- **Never a third call** — `port.calls.length <= 2` on every failure path.
- **Cached prefix is stable** across the retry, per the prompt-tiers section.
- **The retry actually carries the reason** — the second call's `dynamic` tier
  contains the rejection codes, not merely a generic "try again".
- **`aborted` makes no second call and no fallback.**
- **`provider_error` makes no second call** but does fall back.
- **Fallback ordering** — nearest wins; equal distances tiebreak by
  `combatantId`; Dodge when nothing is in reach.
- **Fallback failure** — an incapacitated actor yields `no_legal_turn`.
- **Snapshot** — excludes dead and fled combatants; emits terrain sparsely;
  omits `turnOrder` when absent.

Mutation checks, not first-run passes, on the two branches most likely to be
silently wrong: deleting the second call site must kill the retry test, and
reversing the fallback's sort must kill the ordering test. Step 6 found an
unreachable branch this way, which is why it is written down as a requirement
rather than left to taste.

## Consequences for `PROJECT_PLAN.md`

Step 7's row stays open when this lands: the loop exists, but "model chosen from
data" is 7b's half and the tactical routing row is still an unmeasured
placeholder. The status section records 7a as done and names the two numbers 7b
must set.
