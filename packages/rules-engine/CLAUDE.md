# @ai-dm/rules-engine

## Purpose & boundary

Pure, deterministic D&D 5e mechanics: dice, checks/saves, attack resolution, action economy, conditions, grid/pathfinding/LoS/cover. This package is the **only** authority on rule legality and math — it validates every `ExecuteTurn` the LLM proposes and is the single gate before state mutation.

**Boundary — strictly enforced:**

- Pure functions only. No I/O, no network, no LLM calls, no `Date.now()`, no ambient randomness.
- All randomness through the injected `Rng` (`src/dice`). This makes every roll reproducible in tests and replayable from the event log.
- Depends only on `@ai-dm/schemas`.

## Modules

- `dice/` — rolls, advantage/disadvantage, crits, notation parsing
- `checks/` — ability checks, saves, DCs, proficiency
- `combat/` — attack resolution, damage/temp-HP order, conditions, action-economy state machine, `ExecuteTurn` validation (returns machine-readable rejection reasons for the agent retry loop)
- `spatial/` — grid, A* (5 ft/tile, difficult terrain ×2, diagonals per ADR-0003), LoS/cover (Bresenham house rule, swappable — keep the algorithm behind an interface)

## Rule references

Cover: +2 AC & Dex saves (half), +5 (three-quarters), untargetable (full). 30 ft = 6 tiles. Check ADR-0001 (2014 vs 2024 edition) before implementing edition-sensitive rules (hiding, surprise, exhaustion).

## Testing — highest bar in the repo

- Golden tests from SRD worked examples for every resolution path (attack math, cover stacking, difficult-terrain pathfinding, condition interactions). A rules module without golden tests is not done.
- Property tests where cheap (e.g., A* path cost ≤ movement budget; LoS symmetry).
- Coverage target: ≥90% lines for this package.

## Commands

```bash
pnpm --filter @ai-dm/rules-engine test | test:coverage | typecheck | build
```
