import { describe, expect, it } from "vitest";
import { adapterSuccess, createAgentRuntime, createTacticalAgent, createTimingPort } from "@ai-dm/agents";
import { SMOKE_ARM } from "../config.js";
import type { TurnLogEntry } from "../engine/encounter.js";
import { scriptedTurn } from "../engine/policy.js";
import { createScriptedPort } from "../smoke/port.js";
import { joinUnresolvedActionIds, runEncounterArm } from "./loop.js";
import type { TurnRecord } from "./records.js";

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    armId: "gemini-3-flash@medium",
    scenarioId: "melee-brawl",
    seed: 1,
    round: 1,
    actorId: "goblin_1",
    outcome: "model",
    attempts: 1,
    rejectionReasons: [],
    adapterErrorCodes: [],
    promptTokens: 0,
    completionTokens: 0,
    usageComplete: true,
    attemptsMissingUsage: 0,
    durationMs: 0,
    callDurationsMs: [],
    unresolvedActionIds: [],
    nonAttackActions: 0,
    ...overrides,
  };
}

function logEntry(overrides: Partial<TurnLogEntry> = {}): TurnLogEntry {
  return {
    round: 1,
    actorId: "goblin_1",
    faction: "hostile",
    effect: {
      attacks: [],
      damageDealt: 0,
      killed: [],
      movedFeet: 0,
      nonAttackAction: false,
      unresolvedActionIds: [],
    },
    ...overrides,
  };
}

describe("joinUnresolvedActionIds", () => {
  it("carries the resolved unresolvedActionIds onto the matching (round, actorId) record", () => {
    const records = [record({ round: 2, actorId: "goblin_1" })];
    const log = [
      logEntry({
        round: 2,
        actorId: "goblin_1",
        effect: {
          attacks: [],
          damageDealt: 0,
          killed: [],
          movedFeet: 0,
          nonAttackAction: false,
          unresolvedActionIds: ["greatclub"],
        },
      }),
    ];

    const joined = joinUnresolvedActionIds(records, log);

    expect(joined[0]?.unresolvedActionIds).toEqual(["greatclub"]);
  });

  it("back-fills nonAttackActions from the matching log entry's effect", () => {
    const records = [record({ round: 2, actorId: "goblin_1", nonAttackActions: 0 })];
    const log = [
      logEntry({
        round: 2,
        actorId: "goblin_1",
        effect: {
          attacks: [],
          damageDealt: 0,
          killed: [],
          movedFeet: 0,
          nonAttackAction: true,
          unresolvedActionIds: [],
        },
      }),
    ];

    const joined = joinUnresolvedActionIds(records, log);

    expect(joined[0]?.nonAttackActions).toBe(1);
  });

  it("leaves a record with no matching log entry as an empty list, without throwing", () => {
    // A decider that returned `aborted` or `no_legal_turn` pushes a record but
    // no turn was ever applied, so `runEncounter`'s log has nothing for it.
    const records = [record({ round: 3, actorId: "goblin_2", outcome: "aborted" })];

    const joined = joinUnresolvedActionIds(records, []);

    expect(joined[0]?.unresolvedActionIds).toEqual([]);
  });

  it("does not cross-join a different round or a different actor", () => {
    const records = [record({ round: 1, actorId: "goblin_1" })];
    const log = [
      logEntry({
        round: 2,
        actorId: "goblin_1",
        effect: {
          attacks: [],
          damageDealt: 0,
          killed: [],
          movedFeet: 0,
          nonAttackAction: false,
          unresolvedActionIds: ["wrong-round"],
        },
      }),
      logEntry({
        round: 1,
        actorId: "goblin_2",
        effect: {
          attacks: [],
          damageDealt: 0,
          killed: [],
          movedFeet: 0,
          nonAttackAction: false,
          unresolvedActionIds: ["wrong-actor"],
        },
      }),
    ];

    const joined = joinUnresolvedActionIds(records, log);

    expect(joined[0]?.unresolvedActionIds).toEqual([]);
  });
});

describe("runEncounterArm", () => {
  it("calls onTurn once per hostile turn — so a live run can log progress turn by turn", async () => {
    const port = createScriptedPort();
    const timingPort = createTimingPort(port);
    const runtime = createAgentRuntime({
      routing: { intent: SMOKE_ARM.spec, tactical: SMOKE_ARM.spec, narrative: SMOKE_ARM.spec },
      port: timingPort,
    });
    const agent = createTacticalAgent({ runtime });

    const seen: TurnRecord[] = [];
    const { records } = await runEncounterArm({
      armId: "test-arm@low",
      scenarioId: "melee-brawl",
      seed: 1,
      agent,
      timingPort,
      beforeTurn: (decide) => {
        const baseline = scriptedTurn({
          world: decide.world,
          actorId: decide.actorId,
          availableActions: decide.availableActions,
        });
        if (baseline === null) throw new Error("expected a legal baseline turn in this fixture");
        port.load({
          structured: [
            adapterSuccess({
              value: baseline.turn,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            }),
          ],
        });
      },
      onTurn: (record) => seen.push(record),
    });

    expect(seen).toHaveLength(records.length);
    expect(seen.map((record) => record.actorId)).toEqual(records.map((each) => each.actorId));
  });
});
