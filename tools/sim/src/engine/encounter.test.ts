import { describe, expect, it } from "vitest";
import { buildScenario } from "../scenarios/build.js";
import { MELEE_BRAWL } from "../scenarios/melee-brawl.js";
import { seeded } from "../rng.js";
import { runEncounter } from "./encounter.js";
import { scriptedTurn } from "./policy.js";

function scriptedRun(seed: number) {
  const built = buildScenario(MELEE_BRAWL);
  return runEncounter({
    scenario: built,
    rng: seeded(seed),
    // eslint-disable-next-line @typescript-eslint/require-await
    deciderFor: () => async (input) =>
      scriptedTurn({
        world: input.world,
        actorId: input.actorId,
        availableActions: input.availableActions,
      }),
  });
}

describe("runEncounter", () => {
  it("plays to a decision and names a winner", async () => {
    const result = await scriptedRun(1);

    expect(result.winner === "party" || result.winner === "hostile").toBe(true);
    expect(result.rounds).toBeGreaterThan(0);
    expect(result.log.length).toBeGreaterThan(0);
  });

  it("is exactly reproducible for one seed", async () => {
    const [a, b] = await Promise.all([scriptedRun(7), scriptedRun(7)]);

    expect(a.winner).toBe(b.winner);
    expect(a.rounds).toBe(b.rounds);
    expect(a.log).toEqual(b.log);
  });

  it("diverges on a different seed", async () => {
    const [a, b] = await Promise.all([scriptedRun(1), scriptedRun(2)]);

    expect(a.log).not.toEqual(b.log);
  });

  it("stops at maxRounds when neither side can finish", async () => {
    const built = buildScenario(MELEE_BRAWL);
    const result = await runEncounter({
      scenario: { ...built, maxRounds: 2 },
      rng: seeded(3),
      // Everyone dodges forever, so nobody can ever win.
      // eslint-disable-next-line @typescript-eslint/require-await
      deciderFor: () => async () => null,
    });

    expect(result.rounds).toBe(2);
    expect(result.winner).toBeNull();
  });

  it("skips combatants that are no longer alive", async () => {
    const result = await scriptedRun(5);
    const dead = new Set<string>();

    for (const entry of result.log) {
      expect(dead.has(entry.actorId)).toBe(false);
      for (const killedId of entry.effect.killed) dead.add(killedId);
    }
  });
});
