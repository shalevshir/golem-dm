# @ai-dm/rules-engine

## Purpose & boundary

Pure, deterministic D&D 5e mechanics: dice, checks/saves, attack resolution, action economy, conditions, grid/pathfinding/LoS/cover. This package is the **only** authority on rule legality and math — it validates every `ExecuteTurn` the LLM proposes and is the single gate before state mutation.

It is also the only authority on **campaign** legality: `scene/` evaluates the
quest graph's predicates and applies its declared effects (`PROJECT_PLAN.md`
§4.7), the same propose-then-validate contract one level above combat.

**Boundary — strictly enforced:**

- Pure functions only. No I/O, no network, no LLM calls, no `Date.now()`, no ambient randomness.
- All randomness through the injected `Rng` (`src/dice`). This makes every roll reproducible in tests and replayable from the event log.
- Depends only on `@ai-dm/schemas`.

## Modules

- `dice/` — rolls, advantage/disadvantage, crits, notation parsing
- `checks/` — ability checks, saves, DCs, proficiency
- `combat/` — attack resolution, damage/temp-HP order, conditions, action-economy state machine, `ExecuteTurn` validation (returns machine-readable rejection reasons for the agent retry loop)
- `spatial/` — grid, A* (5 ft/tile, difficult terrain ×2, diagonals per ADR-0003), LoS/cover (Bresenham house rule, swappable — keep the algorithm behind an interface)
- `scene/` — the scene engine: quest-graph traversal, `WorldPredicate`
  evaluation, `WorldEffect` application, clamped faction-band arithmetic.
  Holds `AuthoredWorld` and `pairKey`, which `apps/server`'s `loadWorld`
  produces and re-exports.

## Rule references

**Read `RULES_REFERENCE.md` at the repo root before writing or changing any rule.** It maps every implemented rule to its SRD 5.2.1 source and code location, flags where 2024 differs from 2014, and lists the known gaps. Verify there rather than from memory.

Quick recall: cover is +2 AC & Dex saves (half), +5 (three-quarters), untargetable (full); 30 ft = 6 tiles. ADR-0001 is settled — **2024 rules, SRD 5.2.1** — so edition-sensitive rules (hiding, surprise, exhaustion, weapon mastery) follow 2024 wording. Note that 2024 removed opposed "contest" checks entirely; use `imposedSaveDc` instead.

## Testing — highest bar in the repo

- Golden tests from SRD worked examples for every resolution path (attack math, cover stacking, difficult-terrain pathfinding, condition interactions). A rules module without golden tests is not done.
- Property tests where cheap (e.g., A* path cost ≤ movement budget; LoS symmetry).
- Coverage target: ≥90% lines for this package.

## Deterministic RNG in tests

- `scripted([0.5, 0.9])` feeds exact `[0,1)` values so each roll is pinned; throws when exhausted.
- `d20Exactly(n)` = `(n - 1) / 20 + 0.0001` — the rng value that makes `rollDie(20)` return exactly `n`.
- `seeded(n)` (mulberry32) for property tests over long streams.
- Shared combat fixtures live in `src/combat/test-fixtures.ts`.

## Commands

```bash
pnpm --filter @ai-dm/rules-engine test | test:coverage | typecheck | build
```
