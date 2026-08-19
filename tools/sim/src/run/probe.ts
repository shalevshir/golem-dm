// Probe mode: a fixed corpus of board states, replayed identically through every
// arm. This is the paired comparison that picks the model — no arm's legality
// depends on how well it happened to be playing three rounds earlier.
//
// Probe mode never resolves anything. It calls `proposeTurn`, records what came
// back, and throws the turn away.
import type { AvailableAction, TacticalAgent, TimingPort } from "@ai-dm/agents";
import type { CombatWorld } from "@ai-dm/rules-engine";
import type { DecideInput, TurnDecider } from "../engine/encounter.js";
import { runEncounter } from "../engine/encounter.js";
import { scriptedTurn } from "../engine/policy.js";
import { buildScenario } from "../scenarios/build.js";
import { scenarioById } from "../scenarios/index.js";
import { seeded } from "../rng.js";
import type { TurnRecord } from "./records.js";
import { recordFrom } from "./records.js";
import { timedPropose } from "./timed-propose.js";

export interface ProbeState {
  scenarioId: string;
  seed: number;
  round: number;
  actorId: string;
  world: CombatWorld;
  availableActions: readonly AvailableAction[];
  turnOrder: readonly string[];
}

export interface DeriveProbeCorpusInput {
  scenarioIds: readonly string[];
  seeds: readonly number[];
}

/**
 * Play the control encounter — scripted on both sides — and snapshot the board
 * at the start of every hostile turn. Deterministic and model-independent by
 * construction, which is exactly what makes the comparison paired.
 */
export async function deriveProbeCorpus(input: DeriveProbeCorpusInput): Promise<ProbeState[]> {
  const corpus: ProbeState[] = [];

  for (const scenarioId of input.scenarioIds) {
    for (const seed of input.seeds) {
      const built = buildScenario(scenarioById(scenarioId));

      // A decider that records the board it was asked about, then plays the
      // baseline turn so the encounter advances. `runEncounter` has already
      // reset this actor's action economy before calling it, so the snapshot
      // is a full-budget turn — same as what a live turn would present.
      const decider: TurnDecider = (decide: DecideInput) => {
        const actor = decide.world.combatants.find((each) => each.combatantId === decide.actorId);
        if (actor?.faction === "hostile") {
          corpus.push({
            scenarioId,
            seed,
            round: decide.round,
            actorId: decide.actorId,
            world: decide.world,
            availableActions: decide.availableActions,
            turnOrder: built.turnOrder,
          });
        }
        return Promise.resolve(
          scriptedTurn({
            world: decide.world,
            actorId: decide.actorId,
            availableActions: decide.availableActions,
          }),
        );
      };

      await runEncounter({ scenario: built, rng: seeded(seed), deciderFor: () => decider });
    }
  }

  return corpus;
}

export interface RunProbeArmInput {
  armId: string;
  corpus: readonly ProbeState[];
  agent: TacticalAgent;
  timingPort: TimingPort;
  /** Called before each turn so the smoke run can load its scripted responses. */
  beforeTurn?: (state: ProbeState) => void;
  /** Called after each turn's record is built, e.g. so a live run can log progress. */
  onTurn?: (record: TurnRecord) => void;
}

export async function runProbeArm(input: RunProbeArmInput): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];

  for (const state of input.corpus) {
    input.beforeTurn?.(state);

    const { result, timings } = await timedPropose(input.agent, input.timingPort, {
      world: state.world,
      actorId: state.actorId,
      availableActions: state.availableActions,
      turnOrder: state.turnOrder,
    });

    const record = recordFrom({
      armId: input.armId,
      scenarioId: state.scenarioId,
      seed: state.seed,
      round: state.round,
      actorId: state.actorId,
      result,
      timings,
    });
    records.push(record);
    input.onTurn?.(record);
  }

  return records;
}
