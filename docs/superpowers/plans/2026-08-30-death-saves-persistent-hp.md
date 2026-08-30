# Death saves, persistent HP, and a long rest — implementation plan

**Goal:** Drive `rollDeathSave` from the encounter pipeline, carry the hero's
HP across encounters, and add a long rest that restores it.

**Spec:** [`docs/superpowers/specs/2026-08-30-death-saves-persistent-hp-design.md`](../specs/2026-08-30-death-saves-persistent-hp-design.md)

## Global constraints

- `corepack enable` before any `pnpm` command.
- Never run `pnpm format` (no `.prettierignore`) or root `pnpm lint` (walks
  sibling worktrees) — lint with `npx eslint packages apps tools`.
- Dependency direction: `schemas ← rules-engine ← agents ← server`.
- No `default` branch on any switch over a discriminated union.
- `packages/rules-engine` line coverage stays ≥90%.
- Baseline to preserve or beat, at `ed60f43`: 1662 passed / 31 skipped
  without `DATABASE_URL`; 1700 / 0 with it.

## Task order

### 1. `packages/schemas`

- `world.ts`: add `DeathSaveTally`, add `Combatant.deathSaves` (optional).
- `protocol.ts`: add `SceneSnapshot.heroHp`; `sceneFromGenesis` gains a
  `heroMaxHp: number | undefined` second parameter.
- `content.ts`: add `WorldEffect`'s `long_rest` member.
- `events.ts`: add `EncounterResolvedPayload.heroHp` (optional),
  `WorldDeltaAppliedPayload.heroHp` (optional).
- `conclusion.ts`: rewrite `conclusionOf` per spec Decision 4.
- `reduce.ts`: `encounter_resolved` folds `heroHp` onto `scene`;
  `world_delta_applied` folds `heroHp` onto `scene` (mirrors `day`).
- Tests: extend `world.test.ts`/`protocol.test.ts`/`content.test.ts` (or
  wherever these schemas are tested), `conclusion.test.ts`, `reduce.test.ts`.

### 2. `packages/rules-engine`

- `combat/index.ts`: delete the stale `DamageOptions.diesAtZeroHp` comment
  block, replace with a plain one.
- `encounter/resolve.ts`: `diesAtZeroHp: target.characterId === undefined`;
  delete the stale comment explaining the old pin.
- `scene/index.ts`: `SceneState.heroHp`; `startScene` sets it to `0`;
  `applyEffect` gains the `long_rest` case and an optional `heroMaxHp`
  parameter threaded through `completed`/`traverseEdge`/`completeCurrentNode`.
- `scene/snapshot.ts`: `sceneStateFrom`/`snapshotOf` copy `heroHp`;
  `diffScene` diffs it into `SceneDelta.heroHp`.
- Tests: `resolve.test.ts` (or combat golden tests) for the three combat
  cases in Verify below; `scene/index.test.ts` for `long_rest`;
  `scene/snapshot.test.ts` for the diff.

### 3. `apps/server`

- `encounters/index.ts`: `buildEncounterById(encounterId, heroCurrentHp?)`.
- `core/campaign.ts`: `initialWorldState` resolves the character once and
  passes `maxHp` into `sceneFromGenesis`; `startEncounter` passes
  `Math.max(1, scene.heroHp)` (or `undefined` for a combat-only campaign)
  into `buildEncounterById`.
- `core/pipeline.ts`:
  - `runEnemyTurns`: add the party-unconscious/stable/dead branch (spec
    Decision 5); add `rollDeathSaveTurn`.
  - `resolveIfConcluded`: compute and attach `heroHp` on victory.
  - The two `completeCurrentNode`/`traverseEdge` call sites pass
    `sceneStaticsOf(campaign).character.maxHp`.
- Tests: `pipeline.test.ts` for the death-save driver and HP carry-forward;
  extend `e2e.test.ts` only if a case needs full-stack proof.

### 4. Docs

- `RULES_REFERENCE.md` §8: remove the closed gap, add the long-rest row to
  §4, add the exhaustion-on-long-rest gap line.

## Verify

```bash
corepack enable
pnpm typecheck
npx eslint packages apps tools
pnpm test
```

Golden tests required (rules-engine bar):

- PC at 0 HP goes Unconscious, not dead.
- A monster at 0 HP still dies instantly (regression).
- Three failed death saves kill.
- A natural 20 death save revives at 1 HP.
- `conclusionOf`: pending death save keeps the fight ongoing; stable hero
  with no hostile left is a victory; three failures is a defeat.
- A long rest restores `SceneState.heroHp` to the injected max.
- A hero who ends a fight wounded starts the next one wounded
  (`buildEncounterById` override, or a pipeline-level integration test).
