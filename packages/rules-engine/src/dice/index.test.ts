import { describe, expect, it } from "vitest";
import { d20, parseNotation, roll, rollDie } from "./index.js";
import type { Rng } from "./index.js";

/**
 * Deterministic PRNG (mulberry32). The engine takes its randomness by
 * injection, so tests pin the stream instead of stubbing globals.
 */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Feeds an exact sequence of [0,1) values so individual rolls are pinned. */
function scripted(values: readonly number[]): Rng {
  let i = 0;
  return () => {
    const v = values[i++];
    if (v === undefined) throw new Error("scripted RNG exhausted");
    return v;
  };
}

describe("rollDie", () => {
  it("maps the RNG range onto 1..sides inclusive", () => {
    expect(rollDie(20, scripted([0]))).toBe(1);
    expect(rollDie(20, scripted([0.999999]))).toBe(20);
    expect(rollDie(6, scripted([0.5]))).toBe(4);
  });

  it("stays within bounds across a long seeded stream", () => {
    const rng = seeded(1234);
    for (let i = 0; i < 1000; i++) {
      const roll = rollDie(20, rng);
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(20);
      expect(Number.isInteger(roll)).toBe(true);
    }
  });
});

describe("d20", () => {
  it("consumes exactly one roll in normal mode", () => {
    expect(d20(scripted([0.5]))).toStrictEqual({ result: 11, rolls: [11] });
  });

  it("takes the higher of two rolls with advantage", () => {
    expect(d20(scripted([0.1, 0.9]), "advantage")).toStrictEqual({
      result: 19,
      rolls: [3, 19],
    });
  });

  it("takes the lower of two rolls with disadvantage", () => {
    expect(d20(scripted([0.9, 0.1]), "disadvantage")).toStrictEqual({
      result: 3,
      rolls: [19, 3],
    });
  });
});

describe("replay determinism", () => {
  it("reproduces an identical roll sequence from the same seed", () => {
    const run = (): number[] => {
      const rng = seeded(99);
      return Array.from({ length: 50 }, () => d20(rng, "advantage").result);
    };
    expect(run()).toStrictEqual(run());
  });

  it("diverges for different seeds", () => {
    const run = (seed: number): number[] => {
      const rng = seeded(seed);
      return Array.from({ length: 50 }, () => rollDie(20, rng));
    };
    expect(run(1)).not.toStrictEqual(run(2));
  });
});

describe("parseNotation", () => {
  it("parses count, sides, and a positive modifier", () => {
    expect(parseNotation("2d6+3")).toStrictEqual({ count: 2, sides: 6, modifier: 3 });
  });

  it("defaults a missing modifier to zero", () => {
    expect(parseNotation("1d20")).toStrictEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it("defaults a missing count to one", () => {
    expect(parseNotation("d20")).toStrictEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it("parses a negative modifier", () => {
    expect(parseNotation("3d8-1")).toStrictEqual({ count: 3, sides: 8, modifier: -1 });
  });

  it("tolerates surrounding whitespace and capital D", () => {
    expect(parseNotation("  2D6 + 3 ")).toStrictEqual({ count: 2, sides: 6, modifier: 3 });
  });

  it.each(["", "abc", "2x6", "0d6", "2d0", "2d6+", "-1d6"])("rejects %o", (bad) => {
    expect(() => parseNotation(bad)).toThrow();
  });
});

describe("roll", () => {
  it("sums the dice and adds the modifier", () => {
    // 0.0 -> 1, 0.999999 -> 6; +3 modifier
    const result = roll("2d6+3", scripted([0, 0.999999]));
    expect(result).toStrictEqual({ notation: "2d6+3", rolls: [1, 6], modifier: 3, total: 10 });
  });

  it("applies a negative modifier", () => {
    expect(roll("1d8-2", scripted([0.5])).total).toBe(3);
  });

  it("never returns a negative total", () => {
    expect(roll("1d4-10", scripted([0])).total).toBe(0);
  });
});

describe("critical damage (2024 rules)", () => {
  it("doubles the dice but not the modifier", () => {
    // 1d8+3 crit -> roll 2d8, add 3 once.
    const result = roll("1d8+3", scripted([0.999999, 0.999999]), { critical: true });
    expect(result.rolls).toStrictEqual([8, 8]);
    expect(result.modifier).toBe(3);
    expect(result.total).toBe(19);
  });

  it("doubles a multi-die pool", () => {
    const result = roll("2d6", scripted([0, 0, 0, 0]), { critical: true });
    expect(result.rolls).toHaveLength(4);
  });
});
