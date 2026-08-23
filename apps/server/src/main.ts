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
import { connectPostgresEventStore, createInMemoryEventStore } from "@ai-dm/memory";
import type { EventStore, PostgresEventStoreHandle } from "@ai-dm/memory";
import type { FastifyBaseLogger } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { MetricsPort } from "./core/pipeline.js";
import { loadConditions } from "./encounters/index.js";
import { createCampaignRegistry } from "./transport/http.js";

const config = loadConfig(process.env);

// Chosen before `buildApp`, because both `createCampaignRegistry` and `ports`
// need it — which is also why the boot log below goes through `logHolder`
// rather than `app.log`, which does not exist yet.
const postgresHandle: PostgresEventStoreHandle | null =
  config.databaseUrl === undefined ? null : connectPostgresEventStore(config.databaseUrl);
if (postgresHandle !== null) {
  // Fails at boot rather than on the first player's first turn — the same
  // reasoning `loadConfig` applies to provider keys.
  await postgresHandle.probe();
}
const store: EventStore = postgresHandle?.store ?? createInMemoryEventStore();
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
  recordSnapshotFailure(record) {
    // `warn`, not `error`: the turn it happened in completed normally
    // (`emit` contains this deliberately — a snapshot is a cache, never
    // authority), so nothing is broken yet. What it costs is a full replay
    // on the next reconnect, and what it usually means is that the store is
    // about to start rejecting appends too — which is exactly why this must
    // not be silent.
    logHolder.current?.warn(
      { campaignId: record.campaignId, sequence: record.sequence, err: record.error },
      "snapshot_write_failed",
    );
  },
};

const app = buildApp({
  logLevel: config.logLevel,
  registry: createCampaignRegistry({
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

if (postgresHandle === null) {
  // A valid configuration, and a lossy one. The only thing distinguishing a
  // deliberate dev run from a misconfigured deploy is this line.
  app.log.warn("event log: in-memory — campaigns are lost on restart");
} else {
  app.log.info("event log: postgres");
}

// Named at boot, not just per-turn: a missing/invalid key for this exact
// provider is otherwise only diagnosable from a turn that quietly fell back,
// which could be minutes into the first campaign. This line makes the
// configured provider/model the first thing an operator checks.
app.log.info(
  {
    provider: DEFAULT_MODEL_ROUTING.narrative.provider,
    model: DEFAULT_MODEL_ROUTING.narrative.modelId,
  },
  "narrative_model_configured",
);

await app.listen({ port: config.port, host: "0.0.0.0" });

/** pino's own `flush`, which fastify's `FastifyBaseLogger` — a `Pick` of
 *  eight members — does not expose. */
interface FlushableLogger {
  flush(cb: (err?: Error) => void): void;
}

function isFlushable(logger: unknown): logger is FlushableLogger {
  return (
    typeof logger === "object" &&
    logger !== null &&
    typeof (logger as { flush?: unknown }).flush === "function"
  );
}

/**
 * pino writes asynchronously, so a `process.exit` immediately after a log
 * call can truncate or lose the very line it was called to produce — which
 * would make the shutdown-failure branch below silent in exactly the case it
 * exists for. Reached through a structural check rather than an assertion
 * because the method is not on the type fastify hands out: ESLint bans `!`,
 * and a cast claiming it is always there would be a lie the day fastify
 * swaps its logger. A logger without `flush` has nothing buffered to drain,
 * so skipping is correct rather than a silent failure.
 */
async function flushLog(): Promise<void> {
  const logger: unknown = app.log;
  if (!isFlushable(logger)) return;
  await new Promise<void>((resolve) => {
    logger.flush(() => {
      resolve();
    });
  });
}

// The process had no shutdown path before there was a connection to close.
// Both signals, because a container stop sends SIGTERM and a terminal sends
// SIGINT, and a half-closed pool keeps the process alive in either case.
// `app.log.error` (not a swallowed rejection) so an operator gets a
// structured line instead of a raw stderr stack trace, and `process.exit`
// makes termination depend on this code's own verdict, not on Node's
// default unhandled-rejection behaviour.
//
// Sequential and in this order, NOT the `Promise.allSettled` this started
// as: `ws.ts` drains an in-flight `handleCommand` to completion in a
// detached task that `app.close()` does not await, so starting both closes
// at once can end the pool under a turn that is still appending — every
// remaining `emit` then rejects with `CONNECTION_ENDED` wrapped as
// `EventStoreUnavailableError`, which is a torn turn in the log. The reason
// `allSettled` was there — a rejected `app.close()` must not skip the pool
// close — survives, because each close is caught on its own rather than
// awaited in a chain that an earlier rejection could short-circuit; that is
// also what keeps both diagnostics when both fail.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void (async () => {
      const failures: unknown[] = [];
      try {
        await app.close();
      } catch (error) {
        failures.push(error);
      }
      // Unconditional: reached whether or not the close above rejected,
      // which is the guarantee `Promise.allSettled` was here for.
      try {
        await postgresHandle?.close();
      } catch (error) {
        failures.push(error);
      }
      for (const failure of failures) {
        app.log.error({ err: failure }, "shutdown: close failed");
      }
      await flushLog();
      process.exit(failures.length > 0 ? 1 : 0);
    })();
  });
}
