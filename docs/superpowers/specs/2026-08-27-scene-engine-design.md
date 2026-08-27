# The scene engine — design

Step 3 of `PROJECT_PLAN.md` §4.7, following step 2's content loader
([`2026-08-27-world-content-loader-design.md`](2026-08-27-world-content-loader-design.md),
merged as `b66de41`). Step 2 authored predicates and effects **as data** and
built a loader that refuses a world whose ids do not resolve. Nothing
evaluates that data. This step builds the thing that does.

What ships is one new module under `packages/rules-engine/src/scene/`: a pure
evaluator for `WorldPredicate`, a pure applier for `WorldEffect`, the band
arithmetic step 2 deliberately did not write, and a small traversal API over
the quest graph. Plus one move — `AuthoredWorld` and `pairKey` leave
`apps/server` for the engine, because the engine may not import the server
(invariant 5) and must not re-derive the relations map's key format
(invariant 4).

It builds no wiring. No new event type, no `reduce` case, no `pipeline.ts`
change, no `POST /campaigns` change, no LLM. §4.7's step 4 intent router is
the first caller; this step's only consumers are its own tests and one new
check inside `loadWorld`.

Exit criterion: the shipped Emberfall arc plays end to end, down both
branches, to two measurably different world states; a fixture world whose
gate genuinely blocks is genuinely refused; a world whose starting node can
never be entered is refused at load; and a fight plays identically, because
no code path outside this step's tests and that one loader check can reach any
of it.

## Context

Facts checked against the repo at `7b5e865`, not recalled.

**The predicates and effects exist and mean nothing yet.**
`packages/schemas/src/content.ts` ships two `WorldPredicate` kinds
(`node_completed`, `faction_band_at_least`) and two `WorldEffect` kinds
(`shift_faction_relation` with a `delta` of −6..+6, `advance_calendar` with
`days ≥ 1`). `content.ts:320` states in as many words that shifting a band is
"clamped evaluation and belongs to §4.7's step 3 scene engine; a helper
written now would have no caller." That helper is this step's, and it now has
callers.

**`FACTION_BANDS` order is the scale.** Seven entries,
`["war", "hostile", "cold", "neutral", "cordial", "friendly", "allied"]`, with
`indexOf(band) - 3` giving §4.7's −3..+3 scalar. There is one table, not two
that can disagree, and `content.test.ts` pins that property. Band arithmetic
is therefore index arithmetic, and clamping is clamping the index to `[0, 6]`.

**`AuthoredWorld` and `pairKey` are in the wrong package for their next
consumer.** Both live in `apps/server/src/world/index.ts` — `AuthoredWorld` at
`:116` with a doc comment already anticipating that "§4.7's step 3 scene
engine takes this injected and can rehome the type then", and `pairKey` at
`:141`, whose comment predicts a `relationBetween` wrapper "one line and
[belonging] with the code that needs it". Step 2's whole-branch review made
the consequence explicit: an engine handed a `ReadonlyMap<string, FactionBand>`
and unable to import `pairKey` will hand-write `a < b ? a|b : b|a` a second
time, which is the invariant-4 duplicate.

**The dependency edge this step needs already exists.**
`apps/server/package.json:16` depends on `@ai-dm/rules-engine`, which depends
only on `@ai-dm/schemas`. `server → rules-engine → schemas` is the sanctioned
direction, so the loader may call the engine and the engine may not call back.
No `package.json` changes anywhere.

**The result-union precedent is `validateExecuteTurn`.**
`packages/rules-engine/src/combat/validate-turn.ts:99` returns
`{ valid: true; plan } | { valid: false; rejections: TurnRejection[] }`, where
a `TurnRejection` carries a machine-readable `reason`, an English `message`
for the retry prompt, and an optional `subjectId`. It never throws for a
refusal. This is the shape the scene engine copies, one level up: a refusal is
data the router reads, not an exception it catches.

**The exhaustiveness mechanism is `strictNullChecks`, not
`noImplicitReturns`.** `tsconfig.base.json` does not set the latter. A switch
that returns from every branch with no `default` fails with TS2366 the moment
a union member is added, because the declared return type excludes
`undefined`. `reduce.ts` relies on it, and so do
`predicateRefs`/`effectRefs` in the loader. The scene engine's evaluator and
applier are the third and fourth users of it.

**The shipped arc cannot exercise a blocked precondition.** Step 2's review
recorded this as carried work. `reckoning`'s gate asks for at least `hostile`
(index 1); the lowest band reachable before it is exactly `hostile`, down the
guild branch. An evaluator hard-coded to `return true` for
`faction_band_at_least` would play the shipped world identically and pass
every test on `main`. Golden tests for the blocked path need their own
fixture, and `data/world/` cannot produce one.

**A quest node can currently be its own precondition.** `startingNodeId: "n1"`
where `n1` requires `node_completed: "n1"` loads clean today and yields a world
with no enterable entry point. Orphan detection was a stated non-goal in step
2; an unreachable *start* node is not the same thing, and the evaluator this
step builds is exactly what makes the check one line.

**The arc's arithmetic, worked by hand.** Stated here because the plan's
golden tests assert these exact numbers, and if they disagree with the shipped
JSON it is the JSON that is wrong:

| | guild branch | warden branch |
|---|---|---|
| after `arrival` | day 1, `cold` (2) | day 1, `cold` (2) |
| after the second node | `guild-offer` shifts −1 → `hostile` (1) | `warden-warning` advances 1 → day 2 |
| at `the-weir` | day 1, `hostile` | day 2, `cold` |
| `reckoning` gate (≥ `hostile`) | 1 ≥ 1, passes | 2 ≥ 1, passes |
| after `reckoning` (+2 bands, +2 days) | day 3, `neutral` (3) | day 4, `cordial` (4) |

Two branches, two genuinely different end states. That difference is what
makes an end-to-end golden test worth writing rather than a tautology.

**Baseline, on `main` at `7b5e865`:** 1335 passed, 30 skipped, 93 files
without `DATABASE_URL`; 1365 passed, 0 skipped with it, `packages/memory` at
62/62. `pnpm typecheck` and `npx eslint packages apps tools` both exit 0.

## Decisions

### 1. The engine is a module in `packages/rules-engine`, not a new package

§4.7 calls the scene engine "a pure *scene engine* — sibling to the rules
engine". Sibling describes its role, not its `package.json`. It lands as
`packages/rules-engine/src/scene/`, exported through that package's
`src/index.ts` alongside `dice/`, `checks/`, `combat/`, `spatial/`,
`encounter/` and `character/`.

The boundary that matters is the one it satisfies either way: pure functions,
no I/O, no LLM, no ambient randomness, depending only on `@ai-dm/schemas`.
That is `packages/rules-engine/CLAUDE.md`'s stated contract verbatim, and the
scene engine meets every clause of it. A separate package would buy a
conceptual line between "5e mechanics" and "campaign legality" at the cost of
a `package.json`, a `tsconfig`, an eslint entry, a CI wiring, a new dependency
edge from `apps/server`, and edits to the root `CLAUDE.md` layout table — for
a module of a few hundred lines whose test bar and tooling are already
configured next door.

`packages/rules-engine/CLAUDE.md`'s Purpose line says "Pure, deterministic
D&D 5e mechanics" and its Modules list names four directories. Both are
narrowed by this step to say what the package now actually holds. That edit is
part of the work, not an afterthought: a boundary document that describes
two-thirds of its package is how the next person puts a file in the wrong
place.

### 2. `AuthoredWorld` and `pairKey` move; `apps/server` re-exports them

Both move to `packages/rules-engine/src/scene/authored-world.ts`.
`apps/server/src/world/index.ts` imports them from `@ai-dm/rules-engine` and
re-exports both under their existing names, so every current import site —
including step 2's own tests — keeps working unchanged.

The re-export is not indecision. `loadWorld` is the function that *produces*
an `AuthoredWorld`, so a caller holding the loader and reaching for the type
should not need to know which package the type was hoisted into; that is the
same courtesy `apps/server/src/encounters/` already extends around
`EncounterDefinition`. What must not happen is the type living in two places,
and a re-export is precisely the construct that guarantees it does not.

`loadWorld` itself does **not** move. It reads `node:fs`, which the rules
engine forbids and `apps/web`'s bundle of `@ai-dm/schemas` forbids — the split
step 2 established and this step does not disturb.

### 3. `SceneState` is an engine-local interface, not a zod schema

```ts
export interface SceneState {
  readonly currentNodeId: string;
  readonly completedNodeIds: ReadonlySet<string>;
  /** Keyed by `pairKey`. */
  readonly relations: ReadonlyMap<string, FactionBand>;
  /** A bare counter. Advanced only by a declared `advance_calendar` effect. */
  readonly day: number;
}
```

It holds a `Set` and a `Map`, which is the same reason `AuthoredWorld` and
`SrdGear` are interfaces rather than schemas: neither is a wire shape and
neither round-trips through JSON as written. Declaring a zod schema now would
mean choosing its serialized form — arrays? records? — before anything
serializes it, and the choice would be made by this step and paid for by step
4, which is when these fields actually join `WorldState` in `protocol.ts` and
have to survive a snapshot.

Every function returns a new `SceneState`; none mutates its input. `readonly`
on every field and `ReadonlySet`/`ReadonlyMap` make that a compile error
rather than a convention, matching how `CombatWorld` documents itself as
"assembled by the caller; never mutated".

### 4. The API is seven functions, and a refusal is a value

```ts
export function shiftBand(band: FactionBand, delta: number): FactionBand;
export function relationBetween(
  state: SceneState, a: string, b: string,
): FactionBand | undefined;
export function evaluatePredicate(predicate: WorldPredicate, state: SceneState): boolean;
export function startScene(world: AuthoredWorld): SceneTransition;
export function availableEdges(world: AuthoredWorld, state: SceneState): readonly EdgeOption[];
export function traverseEdge(world: AuthoredWorld, state: SceneState, to: string): SceneTransition;
export function completeCurrentNode(world: AuthoredWorld, state: SceneState): SceneTransition;
```

with

```ts
export type SceneRejectionReason = "no_such_node" | "no_such_edge" | "precondition_unmet";

export interface SceneRejection {
  reason: SceneRejectionReason;
  /** English detail, for the router's retry prompt and for an operator's log. */
  message: string;
  /** The node this rejection concerns, when there is one. */
  subjectId?: string;
}

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
```

Nothing throws for a refusal, for `validateExecuteTurn`'s reason: the caller
in step 4 is a retry loop around a model, and a refusal it must read and
explain is data, not an exception. A rejection carries every failed
precondition, not the first — same argument as `WorldContentError` carrying
every defect.

`applyEffect` is deliberately **not** exported. It is reachable only through a
node completing, which is what keeps invariant 1 intact one level above
combat: a caller cannot shift a faction band except by completing a node that
declares the shift. An unexported applier is also fully tested — through
`traverseEdge` and `completeCurrentNode`, which is a stronger test than
calling it directly.

`availableEdges` returns every edge with its status rather than only the open
ones, because both callers this step can name need the closed ones: the router
must be able to say why a choice is unavailable, and the golden tests assert
that a blocked edge is blocked for the stated reason. It shares one internal
`entryRejections(world, state, nodeId)` helper with `traverseEdge`, so
"what `availableEdges` says is open" and "what `traverseEdge` accepts" cannot
drift apart.

### 5. Traversal is: complete the current node, then enter the target

`traverseEdge(world, state, to)`:

1. If `to` is not among the current node's `edges`, reject `no_such_edge`.
2. Compute the post-completion state: add `currentNodeId` to
   `completedNodeIds` and apply the current node's effects — **only if it was
   not already completed**.
3. Evaluate the target node's `preconditions` against *that* state. Any that
   fail become `precondition_unmet` rejections and nothing is committed.
4. Otherwise return the post-completion state with `currentNodeId` set to
   `to`.

Preconditions are evaluated after the current node completes because that is
what the shipped arc requires and what step 2's schema comment already says:
predicates gate the node, and "traversing an edge is entering its target". The
arc's `guild-offer` requires `node_completed: "arrival"` and is reached by
traversing out of `arrival`; evaluating before completion would make the
shipped world unplayable at its first move.

**Effects apply on first completion only.** A node re-entered later — which
the graph does not do today but a cycle would — must not pump its faction
shift a second time. The `completedNodeIds` set is the guard, and it is
checked before applying rather than after, so the state a precondition sees is
the state the effects produced exactly once.

`completeCurrentNode` exists because `reckoning` is terminal: it has effects
and no outbound edges, so without it the arc's final `+2` bands and `+2` days
would never be applied by any path. It is step 4's hook for "the node is
finished and no edge was taken", and it is idempotent for the same reason.

### 6. Band arithmetic clamps at the ends and there is one implementation

`shiftBand(band, delta)` is `FACTION_BANDS[clamp(indexOf(band) + delta, 0, 6)]`.
No wrapping, no error on overflow: a `delta` of `+6` from `cold` is `allied`,
and a further `+1` is still `allied`. The schema permits −6..+6 precisely so
clamping is reachable rather than theoretical, and both ends get a golden test.

`shiftBand` is exported because it is the band arithmetic §4.7 asks for and
because clamping is exactly the behaviour worth pinning directly rather than
inferring through a traversal. `evaluatePredicate`'s
`faction_band_at_least` comparison uses `indexOf` on the same table, so the
comparison and the shift cannot disagree about what the scale is.

`relationBetween` returns `undefined` for a pair the map does not hold. In a
world produced by `loadWorld` that cannot happen — the loader refuses a
missing pair and a self-pair. In a hand-built `SceneState` it can, and a
`faction_band_at_least` predicate over an unknown pair evaluates **false**:
the gate is a claim that standing is at least some band, and an unknown
standing does not establish it.

### 7. `loadWorld` gains one check: the starting node must be enterable

After cross-referencing succeeds and before caching, `loadWorld` calls
`startScene(world)` and pushes a problem per unmet precondition. This closes
the hazard step 2 recorded: a world whose start node requires its own
completion loads clean today and yields no enterable entry point.

The check runs **only when no other problem was found.** Evaluating
preconditions over a world with dangling ids produces noise about a graph
that is already known to be broken, and a dangling `startingNodeId` would
otherwise be reported twice under two different wordings. The existing
broken-references fixture therefore keeps its seventeen problems exactly.

This is the one place this step touches code outside its own module, and it is
worth the exception: the check is a call to a function that must exist anyway,
in the file that already owns every other reason a world is refused, and
putting it anywhere else would mean a second place that knows what "a valid
world" means. `apps/server → @ai-dm/rules-engine` is a legal edge that already
exists in `package.json`.

A new fixture, `data/world/fixtures/unenterable-start/`, carries exactly this
defect and nothing else — it is otherwise a clean, tiny world — so its test
asserts the *only* problem is the one under test. That is deliberate: a
fixture with one defect proves the check fires; the seventeen-defect fixture
proves the checks compose.

### 8. Fixtures are built by asking what input reaches each line

Step 2 shipped three checks that could not fail, in one file, for one reason:
its fixture was built by adding one defect per rule rather than by asking, of
each check, "what input reaches this line". Two were caught in task review and
the third only by the whole-branch review.

The engine's fixtures live in `packages/rules-engine/src/scene/test-fixtures.ts`
as TypeScript-built `AuthoredWorld` values — the engine cannot call
`loadWorld`, and a compile-checked fixture is stronger than a JSON one for a
package that never reads a file. Shared combat fixtures already live at
`src/combat/test-fixtures.ts`, so the placement is the house pattern.

The fixture that matters most is a world whose gate genuinely blocks: a
starting band low enough, or a gate high enough, that a branch is closed and
`availableEdges` reports it closed. Without it, `faction_band_at_least`
hard-coded to `true` passes everything — the exact defect step 2's review
predicted for this step.

The plan mandates the sabotage step for every check this step adds: break it,
run the suite, confirm exactly the expected assertions fail, restore. Step 2's
review found that this — not the existence of a test — is what separates a
check from a decoration.

### 9. The end-to-end golden test lives in `apps/server`

The engine's own tests use TS fixtures. One more test, in
`apps/server/src/world/`, loads the real Emberfall world through `loadWorld`
and plays both branches to their terminal states, asserting the day and band
table in the Context section above.

It lives in `apps/server` because that is the only package that may read
`data/world/`. It is the test that would have caught step 2's unexercised
arithmetic at authoring time, and it is what makes editing a `delta` in
`arc.json` a change that fails a test rather than one that ships silently.

## What this must not make worse

**Nothing in the running pipeline may change behaviour.** No event type, no
`reduce` case, no `pipeline.ts` edit, no `POST /campaigns` edit, no
`protocol.ts` edit. The only non-additive change in the entire step is
`loadWorld`'s start-node check and the `AuthoredWorld`/`pairKey` move, and the
move is re-exported so no call site changes.

**The `WorldContentError` contract does not change.** Seventeen problems for
the broken-references fixture, in one throw. The new check adds problems only
for worlds that have none of the old kind.

**The rules engine's purity is not relaxed.** No `node:fs`, no `Date.now()`,
no `Math.random()`, no LLM. The scene engine takes `day` as data and advances
it only through a declared effect — a wall-clock read is exactly the failure
`timestamp`-as-`text` already guards against (§4.6).

**No new predicate or effect kinds.** Two of each is what the arc needs. A
third is a one-line addition to `content.ts` plus a branch in three
exhaustive switches — and adding one now, with no content that uses it, would
ship an unexercised branch of exactly the kind this spec spends a section
guarding against.

**Coverage does not drop.** `packages/rules-engine` targets ≥90% lines.

## Non-goals

- **The intent router, `free_text`, out-of-combat ability checks** — step 4.
  This step builds what the router will call and does not call it.
- **Events and persistence.** `quest_node_entered`, `quest_node_completed`
  and `world_delta_applied` are §4.7's, and they arrive when something
  produces them. `SceneState` becoming part of `WorldState` in `protocol.ts`
  is step 4's, and it is what will decide `SceneState`'s serialized form.
- **The combat bridge** — step 5. No `encounter_started` seed derivation here.
- **Orphan and reachability analysis over the whole graph.** The start node
  must be enterable; whether every node is reachable from it is a different
  question with a different answer (an intentionally unreachable node is a
  legitimate authoring state mid-edit), and it stays a non-goal.
- **Regional danger.** §4.7 says derived, never stored. Nothing here stores
  it, and nothing here derives it either — it has no consumer until something
  presents a node.
- **Town events and `scheduledFor`.** The calendar advances; nothing watches
  it yet.
- **Growing the authored world.** One town, two factions, three NPCs, five
  nodes. The counts are pinned by a test and this step does not edit them.
