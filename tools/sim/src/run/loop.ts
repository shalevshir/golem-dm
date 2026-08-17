// Encounter mode: play the fight, hostile side model-driven, party side
// scripted. This is where win rate and damage efficiency come from. Legality is
// recorded too, but the report reads it from probe mode — here it is confounded
// by how the fight happened to go.
import type { TacticalAgent, TimingPort } from "@ai-dm/agents";
import type { Faction } from "@ai-dm/schemas";
import type { DecideInput, EncounterResult, TurnDecider } from "../engine/encounter.js";
import { runEncounter } from "../engine/encounter.js";
import { scriptedTurn } from "../engine/policy.js";
import { seeded } from "../rng.js";
import { buildScenario } from "../scenarios/build.js";
import { scenarioById } from "../scenarios/index.js";
import type { TurnRecord } from "./records.js";
import { recordFrom } from "./records.js";

export interface RunEncounterArmInput {
  armId: string;
  scenarioId: string;
  seed: number;
  agent: TacticalAgent;
  timingPort: TimingPort;
  /**
   * Called before each hostile turn with the full decide input — not just the
   * actor id — so a caller (the smoke run's fake port) can script a legal turn
   * from the actual board rather than an unreachable guess.
   */
  beforeTurn?: (decide: DecideInput) => void;
}

export interface EncounterArmResult {
  records: TurnRecord[];
  result: EncounterResult;
}

export async function runEncounterArm(input: RunEncounterArmInput): Promise<EncounterArmResult> {
  const built = buildScenario(scenarioById(input.scenarioId));
  const records: TurnRecord[] = [];

  const modelDecider: TurnDecider = async (decide) => {
    input.beforeTurn?.(decide);

    // `TimingPort.timings` is one append-only array for the whole run, so the
    // only correct way to attribute entries to a turn is to slice.
    const before = input.timingPort.timings.length;
    const result = await input.agent.proposeTurn({
      world: decide.world,
      actorId: decide.actorId,
      availableActions: decide.availableActions,
      turnOrder: built.turnOrder,
    });
    const timings = input.timingPort.timings.slice(before);

    records.push(
      recordFrom({
        armId: input.armId,
        scenarioId: input.scenarioId,
        seed: input.seed,
        round: decide.round,
        actorId: decide.actorId,
        result,
        timings,
      }),
    );

    return result.ok ? { turn: result.turn, plan: result.plan } : null;
  };

  const baselineDecider: TurnDecider = (decide) =>
    Promise.resolve(
      scriptedTurn({
        world: decide.world,
        actorId: decide.actorId,
        availableActions: decide.availableActions,
      }),
    );

  const result = await runEncounter({
    scenario: built,
    rng: seeded(input.seed),
    deciderFor: (faction: Faction) => (faction === "hostile" ? modelDecider : baselineDecider),
  });

  return { records, result };
}
