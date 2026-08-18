# @ai-dm/sim

## Purpose & boundary

Headless combat simulator: runs the tactical agent against scripted enemies on fixture maps with a seeded RNG — no UI, no server. This is where live-model benchmarking happens (it's the only package allowed to make real API calls in bulk).

## What it measures (per model, per scenario)

- Tool-call legality rate (validated on first try / after retry / fallback used)
- Tactical quality vs scripted baseline (win rate, damage per round, non-attack
  action count — Dodge is inert in this harness, so it is counted separately
  rather than folded silently into win rate)
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

| Flag          | Values                                                              | Default                 |
| ------------- | ------------------------------------------------------------------- | ----------------------- |
| `--mode`      | `probe` \| `encounter` \| `both`                                    | `both`                  |
| `--live`      | absent \| present                                                   | absent                  |
| `--arms`      | comma-separated arm ids from `src/config.ts`, **requires `--live`** | every arm when `--live` |
| `--seeds`     | comma-separated integers                                            | `1,2,3,4,5`             |
| `--scenarios` | comma-separated scenario ids                                        | all four                |

An unrecognised `--flag` (including a singular typo like `--scenario` or `--seed`)
is rejected with the list of known flags, rather than silently falling through to
the default matrix. `--arms` without `--live` is rejected too: the smoke run
always benchmarks the scripted arm regardless of which id you name, so honouring
the flag there would either do nothing or mislabel every record with a model
that was never called.

Probe mode is the paired comparison that picks the model: every arm sees
byte-identical boards, derived from the scripted control encounter. Encounter
mode plays the fight out and is the only source of win rate.

## Live benchmarking

**Wired, not yet run.** `--live` is plumbed to a real provider
(`tools/sim/src/live/run.ts`'s `runLive`), but no live pass has been executed
against this repo yet, so `DEFAULT_MODEL_ROUTING.tactical` and
`REASONING_BUDGET_TOKENS` are still unmeasured placeholders. Firing a live run
is the operator's call, made by exporting keys and passing `--live` — nothing
in this package does that on its own.

`runLive` assembles one `createVercelPort()`-backed `TacticalAgent` per arm —
`createTacticalAgent` binds to a model spec at construction, and a sweep
covers several — and drives it through the same `runProbeArm`/`runEncounterArm`
runners the smoke path uses, so a live run and a smoke run share every line of
code downstream of the port. No credential is ever read by `tools/sim` itself:
`createVercelPort`'s default `resolveModel` goes straight to `@ai-sdk/anthropic`
/ `@ai-sdk/google` / `@ai-sdk/openai`'s own provider clients, which read their
own standard environment variables the moment a call is made — not before, and
not via any `.env` file this package loads.

```bash
export GOOGLE_GENERATIVE_AI_API_KEY=…   # gemini-3.1-flash-lite
export OPENAI_API_KEY=…                 # gpt-5.4-mini, gpt-5.4-nano
export ANTHROPIC_API_KEY=…              # claude-sonnet-5 (quality ceiling)
pnpm sim --live --mode probe            # 12 arms x 4 scenarios x 5 seeds
```

Keys are read from `process.env` only: never written to disk, never logged,
never included in a report. A missing key is not a crash — the tactical
agent's `provider_error` handling turns it into a same-turn deterministic
fallback, so a run with no credentials exported still completes and writes a
report; every record in it carries `adapterErrorCodes: ["provider_error"]`
rather than any real model output. Narrow a run with `--arms`, `--seeds` and
`--scenarios` (e.g. `--arms gemini-3.1-flash-lite@low --seeds 1 --scenarios
melee-brawl`) to keep a first pass small before committing to the full matrix.

**`provider_error` is not always a missing key.** The first attempted live
pass (2026-08-18) produced `provider_error` on every call — real network
round-trips (~100-300ms), 0 tokens, $0 billed — and it took a raw-SDK probe
outside `tools/sim` (bypassing `createVercelPort`'s error classification,
which discards the message and keeps only the stable code) to learn the
actual cause: Google Generate Content API per-minute quota exhaustion, not
an invalid model id, even though the report's `adapterErrorCodes` look
identical either way. `TurnRecord` never stores the underlying message —
only the code — so a report alone cannot distinguish "no key", "bad model
id", "quota exceeded" and "provider outage"; all four currently show up as
the same `provider_error` row. If every call in a run falls back with 0
tokens, check the quota/billing page for the project behind the key before
assuming the model id or the wiring is wrong.

**`claude-sonnet-5` cannot currently complete a live turn at any effort
level.** Confirmed by probing `generateObject({ mode: "tool" })` directly
(the tactical agent's actual call shape) against `ai@4.3.19` +
`@ai-sdk/anthropic@1.2.12`:

- `@low` (thinking disabled): the AI SDK defaults `temperature` to `0`
  internally whenever the caller doesn't set one (`// TODO v5 remove default
  0 for temperature` — a known, not-yet-fixed v4 behavior) and only clears it
  when `thinking` is enabled. With thinking off, that forced `0` reaches
  Anthropic, which now rejects any explicit `temperature` outright: `` `temperature`
  is deprecated for this model ``. `callSettingsFor` (`packages/agents/src/providers/vercel.ts`)
  was fixed to never pass an explicit temperature for the anthropic provider,
  but that does not change this outcome — the SDK's own default fills the gap
  regardless of what we send.
- `@medium` / `@high` (thinking enabled): thinking correctly clears the
  forced temperature, but then `generateObject`'s forced tool-choice
  conflicts with it directly: `` Thinking may not be enabled when tool_choice
  forces tool use. `` — a documented Anthropic constraint, not an SDK bug.

These two failure modes are mutually exclusive for this SDK version and this
model: there is no effort level where forced-tool-call structured output
currently works. A real fix (an SDK upgrade, or switching Anthropic to
non-forced tool choice) is bigger than a config change — it touches the
reliability guarantee the tactical agent's retry/fallback logic depends on —
and is intentionally not attempted here. Until resolved, exclude
`claude-sonnet-5` from any live run (`--arms` naming only the google/openai
arms) rather than spending quota rediscovering this.

**Before publishing any number from a live run:**

- Check `costIsUnderreported` in the report. It is true when an attempt was
  billed but reported no usage, which makes every cost figure a lower bound.
  A terminal `provider_error` attempt does not trip this — nothing was billed
  for it, so it is excluded from the shortfall count.
- Check `promptVersion` matches across every run you intend to compare. Two runs
  either side of a prompt edit must not be pooled.
- Read win rate with the resolver's declared gaps in view — Dodge is inert here,
  which penalises both careful play and the deterministic fallback.
