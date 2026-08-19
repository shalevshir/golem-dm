import { describe, expect, it } from "vitest";
import { seeded } from "./rng.js";

describe("seeded", () => {
  it("returns the same stream for the same seed", () => {
    const a = seeded(42);
    const b = seeded(42);
    const first = [a(), a(), a()];
    const second = [b(), b(), b()];
    expect(first).toEqual(second);
  });

  it("returns a different stream for a different seed", () => {
    const a = seeded(1);
    const b = seeded(2);
    expect(a()).not.toBe(b());
  });

  it("stays inside [0, 1)", () => {
    const rng = seeded(7);
    for (let i = 0; i < 200; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("is byte-identical to the stream the sim already relies on", () => {
    const rng = seeded(1);
    // Pinned from tools/sim/src/rng.ts's mulberry32 before the move. If this
    // fails, the same seed has stopped meaning the same fight.
    expect([rng(), rng(), rng()].map((value) => value.toFixed(12))).toEqual([
      "0.627073940588",
      "0.002735721180",
      "0.527447039960",
    ]);
  });
});
