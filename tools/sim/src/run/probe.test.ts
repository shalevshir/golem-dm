import { describe, expect, it } from "vitest";
import { adapterSuccess, createAgentRuntime, createTacticalAgent, createTimingPort } from "@ai-dm/agents";
import { SMOKE_ARM } from "../config.js";
import { scriptedTurn } from "../engine/policy.js";
import { createScriptedPort } from "../smoke/port.js";
import { deriveProbeCorpus, runProbeArm } from "./probe.js";
import type { TurnRecord } from "./records.js";

describe("deriveProbeCorpus", () => {
  it("is model-independent and reproducible", async () => {
    const first = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1, 2] });
    const second = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1, 2] });

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((state) => state.actorId)).toEqual(second.map((state) => state.actorId));
    expect(first.map((state) => state.world)).toEqual(second.map((state) => state.world));
  });

  it("collects only hostile-side turns", async () => {
    const corpus = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1] });

    for (const state of corpus) {
      const actor = state.world.combatants.find((each) => each.combatantId === state.actorId);
      expect(actor?.faction).toBe("hostile");
      expect(actor?.status).toBe("alive");
    }
  });

  it("gives each state a fresh action economy, so every turn is a full budget", async () => {
    const corpus = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1] });

    for (const state of corpus) {
      const actor = state.world.combatants.find((each) => each.combatantId === state.actorId);
      expect(actor?.actionEconomy.actionUsed).toBe(false);
      expect(actor?.actionEconomy.movementUsedFeet).toBe(0);
    }
  });

  it("grows with more seeds and more scenarios", async () => {
    const one = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1] });
    const two = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1, 2] });
    const both = await deriveProbeCorpus({
      scenarioIds: ["melee-brawl", "ranged-approach"],
      seeds: [1],
    });

    expect(two.length).toBeGreaterThan(one.length);
    expect(both.length).toBeGreaterThan(one.length);
  });
});

describe("runProbeArm", () => {
  it("calls onTurn once per corpus state, with that state's finished record — so a live run can log progress turn by turn", async () => {
    const corpus = await deriveProbeCorpus({ scenarioIds: ["melee-brawl"], seeds: [1] });
    const port = createScriptedPort();
    const timingPort = createTimingPort(port);
    const runtime = createAgentRuntime({
      routing: { intent: SMOKE_ARM.spec, tactical: SMOKE_ARM.spec, narrative: SMOKE_ARM.spec },
      port: timingPort,
    });
    const agent = createTacticalAgent({ runtime });

    const seen: TurnRecord[] = [];
    await runProbeArm({
      armId: "test-arm@low",
      corpus,
      agent,
      timingPort,
      beforeTurn: (state) => {
        const baseline = scriptedTurn({
          world: state.world,
          actorId: state.actorId,
          availableActions: state.availableActions,
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

    expect(seen).toHaveLength(corpus.length);
    expect(seen.map((record) => record.actorId)).toEqual(corpus.map((state) => state.actorId));
  });
});
