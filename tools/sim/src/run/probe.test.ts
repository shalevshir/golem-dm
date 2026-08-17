import { describe, expect, it } from "vitest";
import { deriveProbeCorpus } from "./probe.js";

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
