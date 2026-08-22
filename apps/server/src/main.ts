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
  createHebrewNarrative,
  createTacticalAgent,
  createVercelPort,
  DEFAULT_MODEL_ROUTING,
} from "@ai-dm/agents";
import { createInMemoryEventStore } from "@ai-dm/memory";
import type { FastifyBaseLogger } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { MetricsPort } from "./core/pipeline.js";
import { loadConditions } from "./encounters/index.js";
import { createSessionRegistry } from "./transport/http.js";

const config = loadConfig(process.env);

const store = createInMemoryEventStore();
const clock = (): string => new Date().toISOString();

// The pipeline does no file I/O of its own (`TurnPorts.conditionNamesHebrew`'s
// doc comment) — this is where `loadConditions()`'s SRD data is turned into
// the plain label lookup `buildNarrationBrief` reads from.
const conditionNamesHebrew = new Map(
  Array.from(
    loadConditions(),
    ([condition, definition]) => [condition, definition.nameHebrew] as const,
  ),
);

// Per-turn latency, tokens and retries are recorded from day one
// (apps/server/CLAUDE.md) through the pipeline's own `metrics` port (below),
// not through `@ai-dm/agents`' `createTimingPort`. That decorator's
// `timings` is an append-only array with no drain/reset API — wrapping the
// provider in it here and never reading it back would be exactly the dead
// code and unbounded growth task-corrections.md's C-23 flagged in the
// original plan. `TurnProposalResult.usage` and this file's own wall-clock
// around the tactical call already cover what `TimingPort` would have
// offered for this purpose.

// C-23/C-39: one structured log line per turn that reached the tactical
// agent, written through the app's own pino logger rather than a bare
// `process.stdout.write` (review finding, task 14 round 2: a bare JSON
// object carries no `time`/`level`, ignores `LOG_LEVEL` entirely, and can't
// be told apart from the pino lines Fastify writes to the same stream).
// The logger is filled in via a holder object, late-bound, because of the
// ordering this file is stuck with: `metrics` has to exist before
// `buildApp` is called (it goes into `ports`, one of `buildApp`'s inputs),
// but the logger to write through only exists once `buildApp` returns the
// `app` it belongs to. A holder (mutated property) rather than a bare
// `let` reassigned once: the latter is exactly what this repo's
// `prefer-const` flags, since it cannot see that the single assignment
// below is load-bearing rather than incidental. `console.log` was avoided
// for the same reason as before — this repo's `no-console` lint rule only
// allows `warn`/`error` — but is moot now that there's a real logger to
// use instead.
const logHolder: { current?: FastifyBaseLogger } = {};

// A runtime of its own, separate from the tactical one above (each wraps its
// own `createVercelPort({})`): the two agents call different roles and are
// instrumented independently, so nothing is gained by sharing one instance
// and it would tie their lifecycles together for no reason.
const narrativeRuntime = createAgentRuntime({
  routing: DEFAULT_MODEL_ROUTING,
  port: createVercelPort({}),
});

const metrics: MetricsPort = {
  recordTacticalTurn(turn) {
    logHolder.current?.info(turn, "tactical_turn_metrics");
  },
  recordNarrativeTurn(record) {
    logHolder.current?.info(record, "narrative_turn_metrics");
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
    // Wired unconditionally — `loadConfig`'s own comment is that it proves
    // only that *some* provider key is set, not the one
    // `DEFAULT_MODEL_ROUTING.narrative` names. A missing Anthropic key
    // degrades through `narrate()`'s ladder (pipeline.ts) instead: one failed
    // call per turn, logged via `onFinish` below and `narrative_turn_metrics`
    // above. A silently English game would be worse than a logged,
    // Hebrew-fallback one.
    narrative: createHebrewNarrative({
      runtime: narrativeRuntime,
      onFinish: (finish) => {
        // `actorId` is stamped by the pipeline, which knows whose turn it
        // is; the agent does not.
        logHolder.current?.info({ ...finish, agent: "narrative" }, "narrative_stream_finished");
      },
    }),
    clock,
    uuid: randomUUID,
    // Derived, not random: the same root seed and the same commands must
    // replay the same fight. The value is recorded in `dice_rolled` anyway,
    // and replay reads it from there.
    seedFor: (rootSeed, sequence) => (rootSeed + sequence * 2_654_435_761) >>> 0,
    turnTimeoutMs: 10_000,
    metrics,
    conditionNamesHebrew,
  },
});
logHolder.current = app.log;

// Named at boot, not just per-turn: a missing/invalid key for this exact
// provider is otherwise only diagnosable from a turn that quietly fell back,
// which could be minutes into the first session. This line makes the
// configured provider/model the first thing an operator checks.
app.log.info(
  {
    provider: DEFAULT_MODEL_ROUTING.narrative.provider,
    model: DEFAULT_MODEL_ROUTING.narrative.modelId,
  },
  "narrative_model_configured",
);

await app.listen({ port: config.port, host: "0.0.0.0" });
