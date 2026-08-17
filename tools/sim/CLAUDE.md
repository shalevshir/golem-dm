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
