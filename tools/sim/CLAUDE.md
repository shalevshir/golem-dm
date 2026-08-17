# @ai-dm/sim

## Purpose & boundary

Headless combat simulator: runs the tactical agent against scripted enemies on fixture maps with a seeded RNG — no UI, no server. This is where live-model benchmarking happens (it's the only package allowed to make real API calls in bulk).

## What it measures (per model, per scenario)

- Tool-call legality rate (validated on first try / after retry / fallback used)
- Tactical quality vs scripted baseline (win rate, avg damage efficiency)
- Latency p50/p95 per turn; tokens and $ per turn (cached vs uncached)

Output: one JSON + markdown report per run under `runs/` (gitignored). Use these numbers to set `ModelRouting` — never pick models by vibes.

## Rules

- Seeded RNG everywhere; a run must be exactly reproducible given (seed, model, scenario).
- Scenarios are fixtures in `src/scenarios/` validated against `@ai-dm/schemas`.
- Keep a no-API "smoke" mode (mocked provider) that runs in CI.

## Commands

```bash
pnpm sim                       # from repo root
pnpm --filter @ai-dm/sim test | typecheck
```
