// Encounter mode: play the fight, hostile side model-driven, party side
// scripted. This is where win rate and damage efficiency come from. Legality is
// recorded too, but the report reads it from probe mode — here it is confounded
// by how the fight happened to go.
import type { TacticalAgent, TimingPort } from "@ai-dm/agents";
import type { Faction } from "@ai-dm/schemas";
import type {
  DecideInput,
  EncounterResult,
  TurnDecider,
  TurnLogEntry,
} from "../engine/encounter.js";
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

/**
 * `recordFrom` runs inside the decider, before `applyTurn` has produced this
 * turn's `TurnEffect` — so `unresolvedActionIds` (Task 5's count of engine-legal
 * action ids the actor's stat block does not contain) and `nonAttackActions`
 * are not known yet at push time and are back-filled here from
 * `runEncounter`'s log once it resolves.
 *
 * `(round, actorId)` is a safe join key because this loop gives each combatant
 * exactly one turn per round (`engine/encounter.ts`'s `for (const actorId of
 * scenario.turnOrder)`), so at most one log entry can match a given record.
 *
 * A record with no matching log entry is a decider failure (`aborted` or
 * `no_legal_turn`) — no turn was ever applied, so there is nothing to join and
 * the record keeps `recordFrom`'s defaults (`[]` and `0`).
 */
export function joinUnresolvedActionIds(
  records: readonly TurnRecord[],
  log: readonly TurnLogEntry[],
): TurnRecord[] {
  return records.map((record) => {
    const entry = log.find(
      (each) => each.round === record.round && each.actorId === record.actorId,
    );
    return entry === undefined
      ? record
      : {
          ...record,
          unresolvedActionIds: entry.effect.unresolvedActionIds,
          nonAttackActions: entry.effect.nonAttackAction ? 1 : 0,
        };
  });
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

  return { records: joinUnresolvedActionIds(records, result.log), result };
}
