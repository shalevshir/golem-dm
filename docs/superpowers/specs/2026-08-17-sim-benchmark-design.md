# Headless combat simulator and tactical-model benchmark — design

Roadmap step 7b (`PROJECT_PLAN.md` §4). Step 7's exit criteria are "legality ≥95%
after retry on fixture scenarios; model chosen from data". Step 7a built the
agent; this is the measurement half that closes the step.

## Context

`tools/sim/src/index.ts` is a comment and `export {}`. Everything it needs exists:
`createTacticalAgent` proposes an `ExecuteTurn` and validates it through the rules
engine, `createTimingPort` records per-call latency, `createFakePort` scripts a
provider without a network, and `combatantFromStatBlock` / `actionRangesFeetFrom`
turn `data/srd/` into a `CombatWorld`.

The contract is stated in `tools/sim/CLAUDE.md`:

> Headless combat simulator: runs the tactical agent against scripted enemies on
> fixture maps with a seeded RNG — no UI, no server. [...] Tool-call legality rate
> (validated on first try / after retry / fallback used) · Tactical quality vs
> scripted baseline (win rate, avg damage efficiency) · Latency p50/p95 per turn;
> tokens and $ per turn. [...] Use these numbers to set `ModelRouting` — never pick
> models by vibes.

**No API keys exist anywhere in this repo and nothing has ever called a live
model.** This step therefore builds the harness and greens it in CI against a
mocked provider; the live pass is a separate, documented invocation the operator
fires once credentials are in the environment.

## The gap that shapes everything

**Nothing in the repo resolves a validated turn into a next-state world.**
`resolveAttack`, `applyDamage` and `coverAgainst` are primitives; sequencing them
— move, then N attacks, then damage, then death, then the next actor — is
unwritten. `apps/server` would own it, and that is step 8.

Resolution lands in `tools/sim`, not in `rules-engine`. The deciding argument is
concrete rather than aesthetic: `resolveAttack` needs an `attackBonus`, and
`Combatant` has no such field — it lives on `MonsterAttack` in the stat block. So
resolution needs a stat-block index that `CombatWorld` deliberately does not
carry, which makes it orchestration rather than rules math. `rules-engine`
remains the authority on _legality_ (invariant 1) and keeps its zero-I/O purity;
the sim owns the sequencing that the server will later own for real, and step 8
promotes this code once it knows about events.

## Non-goals

- **Live model calls in this step.** CI runs with no network and no key.
- **Writing measured values into config.** `DEFAULT_MODEL_ROUTING.tactical` and
  `REASONING_BUDGET_TOKENS` stay untouched. Editing them is a separate commit
  after the operator has run the live pass, and `PROJECT_PLAN.md` step 7 stays
  `🟡 7a done, 7b pending` until then.
- **Changing rules-engine behaviour.** The sim composes it; it does not correct it.
- **Rewriting the tactical agent.** If the benchmark exposes a defect, the finding
  is reported before any change to `packages/agents` behaviour. (The `usage`
  change in §8 is additive and was agreed in advance.)
- **`apps/server`, `apps/web`, the narrative agent, memory.** Steps 8–10.

## 1. Two measurement modes

`tools/sim/CLAUDE.md` asks for two kinds of number that want opposite
experimental designs, so there are two modes.

**Probe mode — paired.** A fixed corpus of board states. Every arm receives
byte-identical `proposeTurn` inputs, so legality, latency, tokens and cost carry
no variance from divergent play. **This is the mode that picks the model.** Probe
mode never resolves anything: it calls `proposeTurn`, records what came back, and
discards the turn. The resolver is not on its path at all.

**Encounter mode — unpaired.** A full playout: hostile side driven by the model,
party side by the scripted policy. Measures win rate and damage efficiency. The
encounter diverges the moment two models differ, which is the point — and also
why legality must not be read off it.

The probe corpus is _derived_, never authored. Run the control encounter
(scripted on both sides) across the seed set and snapshot every hostile-side
board state at the moment its turn begins. That corpus is deterministic,
model-independent and free to produce.

The two numbers are diagnostic together: an arm scoring 92% on probes and 97% on
encounters is failing on the hard boards a scripted party never walks into.

_Rejected:_ a single loop producing both. It makes an arm's legality a function
of how well that same arm happened to be playing three rounds earlier — exactly
the confound that would make "Flash beat mini" unfalsifiable.

## 2. CLI surface

Two orthogonal axes, which the flags keep separate rather than conflating into
one "mode" word:

| Flag          | Values                                   | Default                                |
| ------------- | ---------------------------------------- | -------------------------------------- |
| `--mode`      | `probe` \| `encounter` \| `both`         | `both`                                 |
| `--live`      | absent \| present                        | absent — the scripted port, no network |
| `--arms`      | comma-separated arm ids from `config.ts` | every arm                              |
| `--seeds`     | comma-separated integers                 | the config's default seed set          |
| `--scenarios` | comma-separated scenario ids             | all four                               |

`--live` is the only flag that can cause a network call, and it is the only one
that reads `process.env`. Without it the run is a smoke run: `--mode probe --live`
and `--mode probe` differ solely in which port is underneath. That is deliberate —
the smoke run exercises the same code path the live run will, rather than a
parallel one that can drift.

## 3. Module layout

`tools/sim/src/`, one purpose per file:

| Path                  | Contents                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| `index.ts`            | Entry point: dispatch on the parsed CLI, write the report                    |
| `cli.ts`              | Argv parsing, pure and separately testable                                   |
| `config.ts`           | `BenchmarkConfig`, `Arm` = (provider, modelId, effort), seeds, scenario ids  |
| `pricing.ts`          | `$`/Mtok per model id — dated data with a source note, not code              |
| `rng.ts`              | mulberry32 `seeded` and `scripted`, mirroring the engine's test helpers (§4) |
| `scenarios/types.ts`  | `ScenarioDefinition`, `BuiltScenario`, `SpawnSpec`                           |
| `scenarios/srd.ts`    | Read and `MonsterStatBlock.parse` the files in `data/srd/monsters/`          |
| `scenarios/build.ts`  | `ScenarioDefinition` → `BuiltScenario`                                       |
| `scenarios/*.ts`      | The four fixtures                                                            |
| `scenarios/index.ts`  | Registry: id → `ScenarioDefinition`                                          |
| `engine/resolve.ts`   | `applyTurn(world, actor, turn, plan, ctx, rng)` → `{ world, effect }`        |
| `engine/policy.ts`    | The scripted baseline policy                                                 |
| `engine/encounter.ts` | `runEncounter`: turn order, rounds, termination                              |
| `run/probe.ts`        | Derive the probe corpus; run one arm against it                              |
| `run/loop.ts`         | Run one arm × scenario × seed in encounter mode                              |
| `run/metrics.ts`      | Aggregation: legality, percentiles, tokens, cost                             |
| `run/report.ts`       | `RunReport` → JSON + markdown under `runs/`                                  |
| `smoke/port.ts`       | Refillable scripted port built on `createFakePort`                           |
| `smoke/defects.ts`    | The seeded defect schedule                                                   |

## 4. Determinism

A run must be exactly reproducible given (seed, model, scenario). Three sources of
non-determinism are closed by construction:

- **Dice.** One `Rng` per run, threaded explicitly. No ambient randomness
  anywhere in the package.
- **Turn order.** Fixed per scenario, not rolled. Initiative is not what is being
  measured, and rolling it would spend Rng draws that shift every later roll.
- **Iteration order.** Combatants are addressed by the scenario's declared order;
  ties in the scripted policy break on `combatantId.localeCompare`, matching
  `deterministicFallback`.

What is _not_ deterministic, and is therefore excluded from the claim and marked
as such in the report: `generatedAt`, and wall-clock timings in live mode. In
smoke mode the clock is injected into `createTimingPort` as a counter, so even
timings are fixed and the whole report is byte-identical run to run except
`generatedAt`.

That makes "the same (seed, model, scenario) produces identical results twice" a
CI assertion rather than a README promise.

**Where the seeded RNG comes from.** `packages/rules-engine/CLAUDE.md` documents
`seeded(n)` (mulberry32) and `scripted([...])` under "Deterministic RNG in tests"
as though they were package exports. They are not: both are private helpers
inside `packages/rules-engine/src/dice/index.test.ts`, and `@ai-dm/rules-engine`
exports neither. The sim therefore carries its own `rng.ts` with the same
mulberry32 and the same `scripted`, reproducing that file's implementation
exactly so the two streams agree for a given seed.

This is duplication, and it is the lesser of the options on the table. Exporting
them from `rules-engine` would be the better long-term home — replay determinism
is an engine-wide concern and step 8 will want the same helper — but it widens
that package's public API, which this step's brief fences off. Flagged here as a
finding for a follow-up rather than fixed in passing.

## 5. Smoke mode

`createFakePort` takes a fixed script at construction, but the number of model
calls in an encounter is not known ahead of time, so one script is exhausted
mid-run. `smoke/port.ts` therefore wraps it: `createScriptedPort()` holds a
`createFakePort` instance and exposes `load(script)`, delegating the three port
methods to whichever instance is current. The run loop refills it with **two**
responses before each `proposeTurn` — the agent provably never makes a third
call, and a test in `packages/agents` already pins that.

What goes in those two slots comes from a **seeded defect schedule**
(`smoke/defects.ts`). Each turn draws from the run's `Rng` and selects one of:

| Defect                             | Exercises                                     |
| ---------------------------------- | --------------------------------------------- |
| none                               | first-try legality, `source: "model"`         |
| `schema_validation_failed`         | adapter rejection carrying zod issues → retry |
| `no_tool_call`                     | adapter rejection with no proposal → retry    |
| illegal turn (target out of reach) | engine rejection → retry with reason codes    |
| `provider_error`                   | straight to fallback, no second call          |

So the smoke run drives first-try, retry and fallback in known proportions, and
the CI test asserts _exact_ counts — "seed 42 yields 31 first-try, 6 retry, 3
fallback". The smoke mode pins the metrics arithmetic rather than merely proving
the process starts.

**Accepted limitation:** the smoke mode's "model" is a scripted policy, so it
carries no signal about tactical quality. It verifies the pipeline and the
metrics, nothing more. Quality numbers require the live pass.

## 6. Scenarios

Four fixtures, each discriminating a distinct failure mode. All are built from
`data/srd/monsters/*.json` through `MonsterStatBlock.parse`, spawned with
`combatantFromStatBlock`, and — critically — `world.actionRangesFeet` is set from
`actionRangesFeetFrom` over the _same_ stat blocks that produce each combatant's
`availableActions`. Omitting it would make every ranged attack fail as out of
reach, and the failure would look like a model defect.

| Scenario          | Composition                                                     | Discriminates                                                                               |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `melee-brawl`     | 2 goblin warriors vs 2 guards, open 12×12, adjacent             | Floor: legality with no spatial reasoning required                                          |
| `ranged-approach` | Goblins at 60 ft, holding scimitar and shortbow                 | Whether the model picks the action whose range reaches — what `actionRangesFeet` exists for |
| `cover-corridor`  | Wolves vs guards, `blocking` and `three_quarters_cover` terrain | LoS/cover targeting; `target_behind_full_cover`                                             |
| `ogre-charge`     | Ogre (Large, 10 ft reach) across `difficult` terrain            | Movement budget arithmetic and a footprint larger than one square                           |

Every fixture is validated against `@ai-dm/schemas` at build time: `GridMap.parse`
on the map, `Combatant.parse` on each spawn. A malformed fixture fails loudly at
construction, not as a mysterious rejection thirty turns in.

**Accepted limitation:** the party side is scripted stat-block creatures
(`guard`), not player characters. `data/srd/classes.json` holds class definitions,
not sheets, and §8 of `RULES_REFERENCE.md` records that player weapon and spell
ranges have no data at all. Step 8 brings real sheets.

## 7. The resolver

```ts
function applyTurn(
  world: CombatWorld,
  actor: Combatant,
  turn: ExecuteTurn,
  plan: TurnPlan,
  ctx: ResolveContext, // statBlocks by combatantId
  rng: Rng,
): { world: CombatWorld; effect: TurnEffect };
```

Sequence: apply movement from `plan.segments` (position ← final destination),
apply `plan.economyAfter` and `plan.spellSlotsAfter`, then for each attack —
`mainAction.targetIds` plus `extraAttacks` — look up the `MonsterAttack` by
`actionId`, compute `coverAgainst`, `resolveAttack`, and on a hit
`roll(damage.diceNotation, rng, { critical: outcome === "critical_hit" })`
followed by `applyDamage`. Returns a new world; never mutates its input.

`diesAtZeroHp: true` for every combatant, since none has a `characterId`. This is
not a shortcut — it means the death-save path, listed unimplemented in
`RULES_REFERENCE.md` §8 ("damage taken at 0 HP → death-save failures"), is never
reached, so the sim cannot silently depend on behaviour the engine does not have.

**Declared fidelity gaps**, all of them §8 entries the sim must not invent around:
no opportunity attacks, no monster traits/reactions (Pack Tactics, Nimble Escape,
Undead Fortitude, Parry), no conditional damage riders.

Most consequential: **Dodge has no mechanical effect**, because the engine models
no dodging state. That penalises both the deterministic fallback and any model
that Dodges correctly. The report therefore counts non-attack actions as their own
line, so no win-rate figure is ever read without it in view.

## 8. Cost honesty

`TurnProposalResult.usage` accumulates only on adapter calls that produced output.
A `schema_validation_failed` or `no_tool_call` attempt was billed and is invisible,
because `AdapterError` carries no usage. The bias is downward and lands precisely
on the retry paths a model comparison most wants to price.

Fixed additively in `packages/agents`:

1. `TokenUsage` moves to `providers/usage.ts` and is re-exported from `port.ts`.
   `errors.ts` cannot import it from `port.ts` — `port.ts` already imports from
   `errors.ts`, and that is a type-only cycle worth not creating. No public API
   changes: every existing import path still resolves.
2. `usage?: TokenUsage` on `AdapterError`, with `adapterFailure`'s diagnostics
   bag gaining the same optional key, spread conditionally like `issues` and
   `cause` for `exactOptionalPropertyTypes`.
3. `vercel.ts` populates it from `NoObjectGeneratedError.usage` — verified present
   as `readonly usage: LanguageModelUsage | undefined` in the installed
   `ai@4.3.19` — on both the `no_tool_call` and the wrapped-`TypeValidationError`
   paths. `APICallError` has no usage and gets none; nothing was billed for output.
4. `tactical/index.ts` pushes `result.error.usage` onto its accumulator on the
   rejection path.

A bare `TypeValidationError` that is not wrapped in `NoObjectGeneratedError` still
carries no usage. So the report keeps a `usageComplete` flag and a count of
attempts where usage was unavailable. **No cost figure is ever emitted without one
or the other**: complete, or labelled with exactly how many attempts are missing.

## 9. Metrics

Recorded per (arm, scenario, seed, turn): `source` (`model` / `retry` / `fallback`)
or the failure kind, rejections by stage and code, `TokenUsage` per attempt, and
the `CallTiming` entries for that turn. Timings are attributed by snapshotting
`timings.length` before `proposeTurn` and slicing after — `createTimingPort`
accumulates into one append-only array, so slicing is the only correct attribution.

Aggregated per arm: legality first-try / after-retry / fallback (against step 7's
≥95%-after-retry bar), latency p50/p95 per turn and per call, tokens per turn,
cost per turn, projected cost per 30-turn session (which is what `PROJECT_PLAN.md`
§3's estimate is stated in), win rate and damage per round against the scripted
control arm.

## 10. Provenance

Every report records `TACTICAL_PROMPT_VERSION`, the git commit, the full
`ModelSpec` for each arm, the seed set, the scenario ids, and the pricing table's
date. The aggregator **groups by `promptVersion` and refuses to pool arms that
disagree** — which is the entire reason 7a's follow-up added the field. A prompt
edited between two runs would otherwise merge them silently.

Reports are written to `tools/sim/runs/<runId>/report.json` and `report.md`.
`runs/` is added to `.gitignore` — the repo's current file has no such entry.

## 11. Testing

Vitest, colocated `*.test.ts`, no network anywhere:

- `engine/resolve.test.ts` — scripted `Rng` pins each attack: hit, crit doubling,
  temp-HP ordering, death at 0 HP, a Large attacker's reach.
- `engine/encounter.test.ts` — termination on a wiped faction and on `maxRounds`;
  the same seed produces an identical transcript twice.
- `scenarios/*.test.ts` — every fixture parses against `@ai-dm/schemas`, and every
  `actionId` in a combatant's `availableActions` has an entry in
  `world.actionRangesFeet`. That last assertion is the guard against the
  load-bearing-map failure named above.
- `run/metrics.test.ts` — percentiles and rate arithmetic on hand-written records.
- `smoke/run.test.ts` — a full smoke run: exact first-try/retry/fallback counts for a
  fixed seed, and byte-identical reports across two runs modulo `generatedAt`.

## 12. Deliverable and the operator's next step

`pnpm sim` runs smoke mode by default: no network, no key, a report under `runs/`.
The live pass is a single documented command taking the arm matrix — the plan's
`gemini-3-flash`, `gpt-5.4-mini`, `gpt-5.4-nano`, plus a Claude ceiling, swept
across `low` / `medium` / `high` reasoning effort — which the operator runs once
credentials are exported. Keys are read from `process.env` only: never written to
disk, never logged, never included in a report.

Only after that run, and as its own commit: `DEFAULT_MODEL_ROUTING.tactical`,
`REASONING_BUDGET_TOKENS`, and `PROJECT_PLAN.md`'s step 7 row and status section.
