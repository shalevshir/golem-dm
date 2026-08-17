import { describe, expect, it } from "vitest";
import {
  applyDamage,
  applyHealing,
  coverArmorClassBonus,
  exhaustionD20Penalty,
  exhaustionSpeedPenaltyFeet,
  isDeadFromExhaustion,
  resolveAttack,
  rollDeathSave,
} from "./index.js";
import type { Rng } from "../dice/index.js";

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

describe("coverArmorClassBonus", () => {
  it.each([
    ["none", 0],
    ["half", 2],
    ["three_quarters", 5],
  ] as const)("%s cover grants +%i", (cover, expected) => {
    expect(coverArmorClassBonus(cover)).toBe(expected);
  });

  it("has no bonus for full cover — the target cannot be targeted at all", () => {
    expect(() => coverArmorClassBonus("full")).toThrow(/full cover/i);
  });
});

describe("resolveAttack", () => {
  it("hits when the total meets the AC", () => {
    const result = resolveAttack(
      { attackBonus: 5, targetArmorClass: 15 },
      scripted([d20Exactly(10)]),
    );
    expect(result.total).toBe(15);
    expect(result.outcome).toBe("hit");
    expect(result.hit).toBe(true);
  });

  it("misses when the total is below the AC", () => {
    const result = resolveAttack(
      { attackBonus: 5, targetArmorClass: 15 },
      scripted([d20Exactly(9)]),
    );
    expect(result.total).toBe(14);
    expect(result.outcome).toBe("miss");
    expect(result.hit).toBe(false);
  });

  it("critically hits on a natural 20 even against an unreachable AC", () => {
    const result = resolveAttack(
      { attackBonus: 0, targetArmorClass: 30 },
      scripted([d20Exactly(20)]),
    );
    expect(result.outcome).toBe("critical_hit");
    expect(result.hit).toBe(true);
  });

  it("critically misses on a natural 1 even when the total would clear the AC", () => {
    const result = resolveAttack(
      { attackBonus: 20, targetArmorClass: 15 },
      scripted([d20Exactly(1)]),
    );
    expect(result.outcome).toBe("critical_miss");
    expect(result.hit).toBe(false);
  });

  it("adds +2 effective AC for half cover", () => {
    const result = resolveAttack(
      { attackBonus: 5, targetArmorClass: 15, cover: "half" },
      scripted([d20Exactly(11)]),
    );
    expect(result.effectiveArmorClass).toBe(17);
    expect(result.total).toBe(16);
    expect(result.hit).toBe(false);
  });

  it("adds +5 effective AC for three-quarters cover", () => {
    const result = resolveAttack(
      { attackBonus: 5, targetArmorClass: 15, cover: "three_quarters" },
      scripted([d20Exactly(14)]),
    );
    expect(result.effectiveArmorClass).toBe(20);
    expect(result.hit).toBe(false);
  });

  it("rejects targeting a creature behind full cover", () => {
    expect(() =>
      resolveAttack(
        { attackBonus: 5, targetArmorClass: 15, cover: "full" },
        scripted([d20Exactly(20)]),
      ),
    ).toThrow(/full cover/i);
  });

  it("takes the higher die with advantage", () => {
    const result = resolveAttack(
      { attackBonus: 0, targetArmorClass: 10, mode: "advantage" },
      scripted([d20Exactly(3), d20Exactly(18)]),
    );
    expect(result.naturalRoll).toBe(18);
  });
});

describe("applyDamage", () => {
  it("consumes temporary hit points before real hit points", () => {
    const result = applyDamage({ currentHp: 10, maxHp: 10, tempHp: 5 }, 3);
    expect(result.absorbedByTempHp).toBe(3);
    expect(result.appliedToHp).toBe(0);
    expect(result.hitPoints).toStrictEqual({ currentHp: 10, maxHp: 10, tempHp: 2 });
  });

  it("spills over to hit points once temporary hit points are exhausted", () => {
    const result = applyDamage({ currentHp: 10, maxHp: 10, tempHp: 5 }, 8);
    expect(result.absorbedByTempHp).toBe(5);
    expect(result.appliedToHp).toBe(3);
    expect(result.hitPoints).toStrictEqual({ currentHp: 7, maxHp: 10, tempHp: 0 });
  });

  it("floors hit points at zero and knocks the creature unconscious", () => {
    const result = applyDamage({ currentHp: 5, maxHp: 20, tempHp: 0 }, 10);
    expect(result.hitPoints.currentHp).toBe(0);
    expect(result.status).toBe("unconscious");
    expect(result.instantDeath).toBe(false);
  });

  it("kills outright when leftover damage equals max hit points", () => {
    const result = applyDamage({ currentHp: 4, maxHp: 10, tempHp: 0 }, 14);
    expect(result.instantDeath).toBe(true);
    expect(result.status).toBe("dead");
  });

  it("does not kill outright when leftover damage is below max hit points", () => {
    const result = applyDamage({ currentHp: 4, maxHp: 10, tempHp: 0 }, 13);
    expect(result.instantDeath).toBe(false);
    expect(result.status).toBe("unconscious");
  });

  it("leaves a creature alive above zero", () => {
    expect(applyDamage({ currentHp: 10, maxHp: 10, tempHp: 0 }, 1).status).toBe("alive");
  });

  it("rejects negative damage", () => {
    expect(() => applyDamage({ currentHp: 10, maxHp: 10, tempHp: 0 }, -1)).toThrow();
  });
});

describe("applyHealing", () => {
  it("restores hit points without exceeding the maximum", () => {
    expect(applyHealing({ currentHp: 8, maxHp: 10, tempHp: 0 }, 5).currentHp).toBe(10);
  });

  it("revives an unconscious creature from zero", () => {
    expect(applyHealing({ currentHp: 0, maxHp: 10, tempHp: 0 }, 3).currentHp).toBe(3);
  });

  it("does not restore temporary hit points", () => {
    expect(applyHealing({ currentHp: 0, maxHp: 10, tempHp: 4 }, 3).tempHp).toBe(4);
  });
});

describe("rollDeathSave", () => {
  it("counts a roll of 10 or higher as a success", () => {
    const result = rollDeathSave({ successes: 0, failures: 0 }, scripted([d20Exactly(10)]));
    expect(result.state).toStrictEqual({ successes: 1, failures: 0 });
    expect(result.outcome).toBe("pending");
  });

  it("counts a roll below 10 as a failure", () => {
    const result = rollDeathSave({ successes: 0, failures: 0 }, scripted([d20Exactly(9)]));
    expect(result.state).toStrictEqual({ successes: 0, failures: 1 });
  });

  it("counts a natural 1 as two failures", () => {
    const result = rollDeathSave({ successes: 0, failures: 0 }, scripted([d20Exactly(1)]));
    expect(result.state.failures).toBe(2);
  });

  it("stabilises on the third success", () => {
    const result = rollDeathSave({ successes: 2, failures: 0 }, scripted([d20Exactly(15)]));
    expect(result.outcome).toBe("stable");
  });

  it("dies on the third failure", () => {
    const result = rollDeathSave({ successes: 0, failures: 2 }, scripted([d20Exactly(5)]));
    expect(result.outcome).toBe("dead");
  });

  it("revives with 1 hit point on a natural 20 and clears the tally", () => {
    const result = rollDeathSave({ successes: 1, failures: 2 }, scripted([d20Exactly(20)]));
    expect(result.outcome).toBe("revived");
    expect(result.state).toStrictEqual({ successes: 0, failures: 0 });
  });
});

describe("exhaustion (2024 unified track)", () => {
  it.each([
    [0, 0],
    [1, -2],
    [3, -6],
    [5, -10],
  ])("level %i applies %i to d20 tests", (level, expected) => {
    expect(exhaustionD20Penalty(level)).toBe(expected);
  });

  it.each([
    [0, 0],
    [1, -5],
    [4, -20],
  ])("level %i applies %i ft of speed", (level, expected) => {
    expect(exhaustionSpeedPenaltyFeet(level)).toBe(expected);
  });

  it("is fatal at level 6", () => {
    expect(isDeadFromExhaustion(5)).toBe(false);
    expect(isDeadFromExhaustion(6)).toBe(true);
  });
});
