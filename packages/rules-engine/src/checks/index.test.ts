import { describe, expect, it } from "vitest";
import {
  abilityCheck,
  abilityModifier,
  contest,
  passiveScore,
  proficiencyBonusForLevel,
  savingThrow,
} from "./index.js";
import type { Rng } from "../dice/index.js";

/** Feeds an exact sequence of [0,1) values so each d20 result is pinned. */
function scripted(values: readonly number[]): Rng {
  let i = 0;
  return () => {
    const v = values[i++];
    if (v === undefined) throw new Error("scripted RNG exhausted");
    return v;
  };
}

/** rng value that makes rollDie(20) produce exactly `target`. */
function d20Exactly(target: number): number {
  return (target - 1) / 20 + 0.0001;
}

describe("abilityModifier", () => {
  it.each([
    [1, -5],
    [7, -2],
    [8, -1],
    [9, -1],
    [10, 0],
    [11, 0],
    [12, 1],
    [16, 3],
    [20, 5],
    [30, 10],
  ])("score %i yields modifier %i", (score, expected) => {
    expect(abilityModifier(score)).toBe(expected);
  });
});

describe("proficiencyBonusForLevel", () => {
  it.each([
    [1, 2],
    [4, 2],
    [5, 3],
    [8, 3],
    [9, 4],
    [12, 4],
    [13, 5],
    [16, 5],
    [17, 6],
    [20, 6],
  ])("level %i yields +%i", (level, expected) => {
    expect(proficiencyBonusForLevel(level)).toBe(expected);
  });
});

describe("abilityCheck", () => {
  it("adds ability modifier and proficiency, then compares to the DC", () => {
    const result = abilityCheck(
      { abilityScore: 16, proficient: true, proficiencyBonus: 2, dc: 15 },
      scripted([d20Exactly(10)]),
    );
    expect(result.naturalRoll).toBe(10);
    expect(result.modifier).toBe(5); // +3 ability, +2 proficiency
    expect(result.total).toBe(15);
    expect(result.success).toBe(true); // meets the DC
  });

  it("fails when the total is below the DC", () => {
    const result = abilityCheck({ abilityScore: 10, dc: 15 }, scripted([d20Exactly(14)]));
    expect(result.total).toBe(14);
    expect(result.success).toBe(false);
  });

  it("omits proficiency when not proficient", () => {
    const result = abilityCheck(
      { abilityScore: 16, proficient: false, proficiencyBonus: 2, dc: 10 },
      scripted([d20Exactly(10)]),
    );
    expect(result.modifier).toBe(3);
  });

  it("doubles proficiency with expertise", () => {
    const result = abilityCheck(
      { abilityScore: 10, proficient: true, proficiencyBonus: 3, expertise: true, dc: 10 },
      scripted([d20Exactly(10)]),
    );
    expect(result.modifier).toBe(6);
  });

  it("takes the higher die with advantage", () => {
    const result = abilityCheck(
      { abilityScore: 10, dc: 10, mode: "advantage" },
      scripted([d20Exactly(4), d20Exactly(17)]),
    );
    expect(result.rolls).toStrictEqual([4, 17]);
    expect(result.naturalRoll).toBe(17);
  });

  it("takes the lower die with disadvantage", () => {
    const result = abilityCheck(
      { abilityScore: 10, dc: 10, mode: "disadvantage" },
      scripted([d20Exactly(4), d20Exactly(17)]),
    );
    expect(result.naturalRoll).toBe(4);
  });

  it("applies a situational penalty such as exhaustion", () => {
    const result = abilityCheck(
      { abilityScore: 10, situationalBonus: -2, dc: 10 },
      scripted([d20Exactly(11)]),
    );
    expect(result.total).toBe(9);
    expect(result.success).toBe(false);
  });

  it("does not auto-succeed on a natural 20 (checks are not attack rolls)", () => {
    const result = abilityCheck({ abilityScore: 1, dc: 30 }, scripted([d20Exactly(20)]));
    expect(result.naturalRoll).toBe(20);
    expect(result.success).toBe(false);
  });
});

describe("savingThrow", () => {
  it("uses the same math as an ability check", () => {
    const result = savingThrow(
      { abilityScore: 14, proficient: true, proficiencyBonus: 3, dc: 15 },
      scripted([d20Exactly(10)]),
    );
    expect(result.modifier).toBe(5); // +2 ability, +3 proficiency
    expect(result.total).toBe(15);
    expect(result.success).toBe(true);
  });
});

describe("passiveScore", () => {
  it("is 10 plus the modifier", () => {
    expect(passiveScore({ abilityScore: 14 })).toBe(12);
  });

  it("includes proficiency when proficient", () => {
    expect(passiveScore({ abilityScore: 14, proficient: true, proficiencyBonus: 3 })).toBe(15);
  });

  it("adds 5 with advantage and subtracts 5 with disadvantage", () => {
    expect(passiveScore({ abilityScore: 10, mode: "advantage" })).toBe(15);
    expect(passiveScore({ abilityScore: 10, mode: "disadvantage" })).toBe(5);
  });
});

describe("contest", () => {
  it("the higher total wins", () => {
    const result = contest(
      { abilityScore: 18 },
      { abilityScore: 10 },
      scripted([d20Exactly(10), d20Exactly(10)]),
    );
    expect(result.initiatorWins).toBe(true);
  });

  it("a tie leaves the situation unchanged", () => {
    const result = contest(
      { abilityScore: 10 },
      { abilityScore: 10 },
      scripted([d20Exactly(10), d20Exactly(10)]),
    );
    expect(result.initiatorTotal).toBe(result.defenderTotal);
    expect(result.initiatorWins).toBe(false);
  });
});
