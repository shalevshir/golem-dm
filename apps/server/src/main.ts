// Fastify + WebSocket entrypoint. Reads the environment, wires the real ports,
// listens. Everything interesting is in `core/`, which knows nothing about
// either.
//
// `.env` itself is loaded by the process, not by this file: `dev`/`start` in
// `package.json` pass Node 22's `--env-file-if-exists=.env`, which needs no
// dependency and matches `.env.example`'s "Copy to .env" instruction — see
// the task report for why this over hand-rolling a loader here.
import { randomUUID } from "node:crypto";
import {
  createAgentRuntime,
  createDeterministicNarrative,
  createTacticalAgent,
  createVercelPort,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createInMemoryEventStore } from "./core/event-store.js";
import type { MetricsPort } from "./core/pipeline.js";
import { createSessionRegistry } from "./transport/http.js";

const config = loadConfig(process.env);

const store = createInMemoryEventStore();
const clock = (): string => new Date().toISOString();

// Per-turn latency, tokens and retries are recorded from day one
// (apps/server/CLAUDE.md) through the pipeline's own `metrics` port (below),
// not through `@ai-dm/agents`' `createTimingPort`. That decorator's
// `timings` is an append-only array with no drain/reset API — wrapping the
// provider in it here and never reading it back would be exactly the dead
// code and unbounded growth task-corrections.md's C-23 flagged in the
// original plan. `TurnProposalResult.usage` and this file's own wall-clock
// around the tactical call already cover what `TimingPort` would have
// offered for this purpose.

// C-23/C-39: one structured JSON line per turn that reached the tactical
// agent, written straight to stdout rather than through a logging library —
// `MetricsPort`'s only contract is "one structured log line per turn," and
// `console.log` is disallowed by this repo's `no-console` lint rule (only
// `warn`/`error` are), so `process.stdout.write` is the plain way to satisfy
// both. Cached tokens and cost are not part of this line: `TokenUsage`
// carries no cache-read field, and a cost figure derived from raw tokens
// alone would misprice cache reads rather than merely omit them — see the
// task report.
const metrics: MetricsPort = {
  recordTacticalTurn(turn) {
    process.stdout.write(`${JSON.stringify({ log: "tactical_turn_metrics", ...turn })}\n`);
  },
};

const app = buildApp({
  logLevel: config.logLevel,
  registry: createSessionRegistry({
    store,
    uuid: randomUUID,
    clock,
    seed: () => Math.floor(Math.random() * 2 ** 31),
  }),
  ports: {
    store,
    tactical: createTacticalAgent({
      runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port: createVercelPort({}) }),
    }),
    narrative: createDeterministicNarrative(),
    clock,
    uuid: randomUUID,
    // Derived, not random: the same root seed and the same commands must
    // replay the same fight. The value is recorded in `dice_rolled` anyway,
    // and replay reads it from there.
    seedFor: (rootSeed, sequence) => (rootSeed + sequence * 2_654_435_761) >>> 0,
    turnTimeoutMs: 10_000,
    metrics,
  },
});

await app.listen({ port: config.port, host: "0.0.0.0" });
