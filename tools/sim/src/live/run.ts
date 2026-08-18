// The live run: same code path as the smoke run — same agent, same runtime,
// same records, same report — with `createVercelPort()` underneath instead of
// a scripted port. `createTacticalAgent` captures `runtime.specFor("tactical")`
// at construction, so a sweep across models needs one `AgentRuntime` /
// `TacticalAgent` per arm rather than one shared instance.
//
// The probe corpus is derived once, outside the arm loop: it is deterministic
// and model-independent by construction (spec §1), and probe mode's whole
// point is that every arm sees byte-identical boards.
import {
  createAgentRuntime,
  createTacticalAgent,
  createTimingPort,
  createVercelPort,
} from "@ai-dm/agents";
import type { ModelRouting, ModelSpec, VercelPortOptions } from "@ai-dm/agents";
import type { Arm } from "../config.js";
import { runEncounterArm } from "../run/loop.js";
import { deriveProbeCorpus, runProbeArm } from "../run/probe.js";
import type { EncounterSummary, RunReport } from "../run/report.js";
import { buildReport } from "../run/report.js";
import type { TurnRecord } from "../run/records.js";

export interface RunLiveInput {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  arms: readonly Arm[];
  seeds: readonly number[];
  scenarioIds: readonly string[];
  mode: "probe" | "encounter" | "both";
  /**
   * Test seam, mirroring `VercelPortOptions`: overrides which `LanguageModelV1`
   * a spec resolves to. Defaults to the real provider clients, which read
   * their API keys from `process.env` themselves (`ANTHROPIC_API_KEY`,
   * `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`) — this module never
   * touches an env var directly.
   */
  resolveModel?: VercelPortOptions["resolveModel"];
}

/**
 * Every role points at the same spec. Only `tactical` is ever read — the sim
 * benchmarks the tactical agent alone — but `ModelRouting` is total over
 * `AgentRole`, so `intent`/`narrative` need a value too.
 */
function routingFor(spec: ModelSpec): ModelRouting {
  return { intent: spec, tactical: spec, narrative: spec };
}

export async function runLive(input: RunLiveInput): Promise<RunReport> {
  const wantsProbe = input.mode !== "encounter";
  const wantsEncounter = input.mode !== "probe";

  const corpus = wantsProbe
    ? await deriveProbeCorpus({ scenarioIds: input.scenarioIds, seeds: input.seeds })
    : [];

  const probeRecords: TurnRecord[] = [];
  const encounterRecords: TurnRecord[] = [];
  const encounters: EncounterSummary[] = [];

  for (const arm of input.arms) {
    const timingPort = createTimingPort(
      createVercelPort(
        input.resolveModel === undefined ? {} : { resolveModel: input.resolveModel },
      ),
    );
    const runtime = createAgentRuntime({ routing: routingFor(arm.spec), port: timingPort });
    const agent = createTacticalAgent({ runtime });

    if (wantsProbe) {
      probeRecords.push(...(await runProbeArm({ armId: arm.armId, corpus, agent, timingPort })));
    }

    if (wantsEncounter) {
      for (const scenarioId of input.scenarioIds) {
        for (const seed of input.seeds) {
          const armResult = await runEncounterArm({
            armId: arm.armId,
            scenarioId,
            seed,
            agent,
            timingPort,
          });

          encounterRecords.push(...armResult.records);
          encounters.push({
            armId: arm.armId,
            scenarioId,
            seed,
            winner: armResult.result.winner,
            rounds: armResult.result.rounds,
            damageByFaction: armResult.result.damageByFaction,
          });
        }
      }
    }
  }

  return buildReport({
    runId: input.runId,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit,
    live: true,
    seeds: input.seeds,
    scenarioIds: input.scenarioIds,
    probeRecords,
    encounterRecords,
    encounters,
  });
}
