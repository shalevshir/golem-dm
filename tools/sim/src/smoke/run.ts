// The no-API run. Same code path as a live run — same agent, same runtime, same
// timing port, same records, same report — with a scripted port underneath and
// an injected counter clock, so the whole report is reproducible byte for byte.
import type { ExecuteTurn } from "@ai-dm/schemas";
import {
  createAgentRuntime,
  createTacticalAgent,
  createTimingPort,
  adapterFailure,
  adapterSuccess,
} from "@ai-dm/agents";
import type { ModelRouting } from "@ai-dm/agents";
import { scriptedTurn } from "../engine/policy.js";
import { runEncounterArm } from "../run/loop.js";
import { deriveProbeCorpus, runProbeArm } from "../run/probe.js";
import type { EncounterSummary, RunReport } from "../run/report.js";
import { buildReport } from "../run/report.js";
import { SMOKE_ARM } from "../config.js";
import { seeded } from "../rng.js";
import type { DefectKind } from "./defects.js";
import { SMOKE_USAGE, nextDefect } from "./defects.js";
import { createScriptedPort } from "./port.js";

export interface RunSmokeInput {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  seeds: readonly number[];
  scenarioIds: readonly string[];
  mode: "probe" | "encounter" | "both";
}

/** Milliseconds the counter clock advances per read. A fixture, not a measurement. */
const TICK_MS = 37;

function routingFor(): ModelRouting {
  return {
    intent: SMOKE_ARM.spec,
    tactical: SMOKE_ARM.spec,
    narrative: SMOKE_ARM.spec,
  };
}

/**
 * A turn the engine will reject: it targets a combatant that is not on the board,
 * which earns `target_not_found` and drives the agent's retry path.
 */
function illegalTurn(actorId: string): ExecuteTurn {
  return {
    actorId,
    mainAction: { actionType: "attack", targetIds: ["no_such_combatant"] },
    tacticalRationaleEnglish: "Smoke fixture: deliberately illegal.",
  };
}

/** The two responses one turn may need. The agent never asks for a third. */
function scriptFor(defect: DefectKind, legal: ExecuteTurn | null, actorId: string) {
  const good =
    legal === null
      ? adapterFailure("provider_error", "Smoke fixture: no legal baseline turn.")
      : adapterSuccess({ value: legal, usage: SMOKE_USAGE });

  switch (defect) {
    case "none":
      return { structured: [good, good] };
    case "illegal_target":
      return {
        structured: [adapterSuccess({ value: illegalTurn(actorId), usage: SMOKE_USAGE }), good],
      };
    case "schema_validation_failed":
      return {
        structured: [
          adapterFailure("schema_validation_failed", "Smoke fixture: bad tool call.", {
            usage: SMOKE_USAGE,
          }),
          good,
        ],
      };
    case "no_tool_call":
      return {
        structured: [
          adapterFailure("no_tool_call", "Smoke fixture: prose instead of a tool call.", {
            usage: SMOKE_USAGE,
          }),
          good,
        ],
      };
    case "provider_error":
      // No second call happens on this path; the agent falls straight back.
      return { structured: [adapterFailure("provider_error", "Smoke fixture: provider down.")] };
  }
}

export async function runSmoke(input: RunSmokeInput): Promise<RunReport> {
  const port = createScriptedPort();
  let ticks = 0;
  const timingPort = createTimingPort(port, {
    now: () => {
      ticks += 1;
      return ticks * TICK_MS;
    },
  });
  const runtime = createAgentRuntime({ routing: routingFor(), port: timingPort });
  const agent = createTacticalAgent({ runtime });

  // One defect stream for the whole run, so the schedule is a function of the
  // run's seed rather than of how many turns each scenario happened to take.
  const defectRng = seeded(input.seeds[0] ?? 1);

  const wantsProbe = input.mode !== "encounter";
  const wantsEncounter = input.mode !== "probe";

  const probeRecords = [];
  if (wantsProbe) {
    const corpus = await deriveProbeCorpus({
      scenarioIds: input.scenarioIds,
      seeds: input.seeds,
    });
    probeRecords.push(
      ...(await runProbeArm({
        armId: SMOKE_ARM.armId,
        corpus,
        agent,
        timingPort,
        beforeTurn: (state) => {
          const baseline = scriptedTurn({
            world: state.world,
            actorId: state.actorId,
            availableActions: state.availableActions,
          });
          port.load(scriptFor(nextDefect(defectRng), baseline?.turn ?? null, state.actorId));
        },
      })),
    );
  }

  const encounterRecords = [];
  const encounters: EncounterSummary[] = [];
  if (wantsEncounter) {
    for (const scenarioId of input.scenarioIds) {
      for (const seed of input.seeds) {
        // The port needs the board to script a legal turn, and `beforeTurn` in
        // the encounter runner hands over the full decide input — so the loader
        // closes over the world the encounter runner is about to pass to
        // `proposeTurn`. The runner calls `beforeTurn` immediately before that
        // call, so a script loaded here is the one that turn consumes.
        const armResult = await runEncounterArm({
          armId: SMOKE_ARM.armId,
          scenarioId,
          seed,
          agent,
          timingPort,
          beforeTurn: (decide) => {
            const baseline = scriptedTurn({
              world: decide.world,
              actorId: decide.actorId,
              availableActions: decide.availableActions,
            });
            port.load(scriptFor(nextDefect(defectRng), baseline?.turn ?? null, decide.actorId));
          },
        });

        encounterRecords.push(...armResult.records);
        encounters.push({
          armId: SMOKE_ARM.armId,
          scenarioId,
          seed,
          winner: armResult.result.winner,
          rounds: armResult.result.rounds,
          damageByFaction: armResult.result.damageByFaction,
        });
      }
    }
  }

  return buildReport({
    runId: input.runId,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit,
    live: false,
    seeds: input.seeds,
    scenarioIds: input.scenarioIds,
    probeRecords,
    encounterRecords,
    encounters,
  });
}
