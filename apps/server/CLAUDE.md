# @ai-dm/server

## Purpose & boundary

The orchestrator: Fastify + `@fastify/websocket`. Owns the turn pipeline, session lifecycle, and the append-only event log. The ONLY place where rules-engine, agents, and memory meet — none of those packages may import each other's runtime services directly.

## Turn pipeline (keep this order)

1. Client message arrives: structured action (tile click / button — intent already explicit) or free text (→ intent agent).
2. Rules engine validates & resolves (dice via seeded RNG; seed recorded in the event).
3. Events appended (`action_validated`, `dice_rolled`, `state_delta_applied`) BEFORE side effects are acked.
4. Narrative agent streams Hebrew tokens to the client as they arrive; `narrative_emitted` appended on completion.
5. Enemy turns: tactical agent → validate → retry once → deterministic fallback (see agents/CLAUDE.md).

## Latency & resilience requirements

- Time-to-first-narrative-token < 1.5s p50; hard turn timeout 10s with a fallback terse narration from the rule outcome.
- WS reconnect: client sends last seen `sequence`; server replays events since — full session restore from log + snapshot. Snapshot every 50 events.
- The event store is selected in `main.ts` from `DATABASE_URL`: set means Postgres (probed at boot), absent means in-memory with a warning. Both implementations live in `@ai-dm/memory`; `apps/server` never imports a database driver.
- Instrument per turn per agent: tokens in/out, cached tokens, latency, retries, cost. Emit as structured logs from day one (replaces guessed cost tables with data).
- Player free text is untrusted: length-cap, strip prompt-injection patterns before it reaches any prompt; never interpolate it into system prompts.

## Config

Secrets/env via `.env` (see [`.env.example`](.env.example)), validated by
`src/config.ts` with zod at boot — the process refuses to start without at
least one provider API key. Model routing is a source-level data edit in
`packages/agents/src/providers/routing.ts` (`DEFAULT_MODEL_ROUTING`), not an
env var — the spec calls for it to be config-overridable, and that override
is not yet implemented (see `PROJECT_PLAN.md` §4.3).

## Testing

Vitest + fastify inject for HTTP; ws client for socket tests. Pipeline integration test with mocked providers: input → events → projected state → replay equivalence.

## Commands

```bash
docker compose up -d          # from apps/server — Postgres+pgvector
pnpm --filter @ai-dm/server dev | test | typecheck | build
```
