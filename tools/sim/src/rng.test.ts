import { describe, expect, it } from "vitest";
import { rollDie } from "@ai-dm/rules-engine";
import { d20Exactly, scripted, seeded } from "./rng.js";

describe("seeded", () => {
  it("produces the same stream twice for one seed", () => {
    const draw = (): number[] => {
      const rng = seeded(1234);
      return Array.from({ length: 10 }, () => rng());
    };

    expect(draw()).toEqual(draw());
  });

  it("produces different streams for different seeds", () => {
    expect(seeded(1)()).not.toBe(seeded(2)());
  });

  it("stays inside [0, 1) across a long stream", () => {
    const rng = seeded(99);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  // Literals captured by running seeded(1234) via the rules-engine's OWN local
  // helper in packages/rules-engine/src/dice/index.test.ts (not via this
  // file's copy), so this test proves the two streams actually agree rather
  // than just pinning whatever this copy happens to compute. If these ever
  // need regenerating, re-capture them from the rules-engine helper again,
  // never from rng.ts.
  it("matches the rules-engine stream for a known seed", () => {
    const rng = seeded(1234);
    expect(Array.from({ length: 4 }, () => rng())).toEqual([
      0.07329497812315822, 0.7034119898453355, 0.9028560190927237, 0.9705493662040681,
    ]);
  });
});

describe("scripted", () => {
  it("replays exact values in order", () => {
    const rng = scripted([0, 0.5, 0.999999]);
    expect(rollDie(20, rng)).toBe(1);
    expect(rollDie(20, rng)).toBe(11);
    expect(rollDie(20, rng)).toBe(20);
  });

  it("throws rather than silently repeating when exhausted", () => {
    const rng = scripted([0.5]);
    rng();
    expect(() => rng()).toThrow("scripted RNG exhausted");
  });
});

describe("d20Exactly", () => {
  it("makes rollDie(20) return the named face", () => {
    for (const face of [1, 7, 15, 20]) {
      expect(rollDie(20, scripted([d20Exactly(face)]))).toBe(face);
    }
  });
});
