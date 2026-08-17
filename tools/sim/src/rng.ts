// Deterministic randomness for the whole simulator. A run must be exactly
// reproducible given (seed, model, scenario), so nothing here reads a clock and
// nothing anywhere in this package calls Math.random.
//
// These duplicate the private helpers in
// `packages/rules-engine/src/dice/index.test.ts`, deliberately and identically:
// `@ai-dm/rules-engine` exports neither, despite its CLAUDE.md listing them, so
// a copy is the only way for the sim to have them without widening that
// package's public API. Keep the implementations byte-identical — if they ever
// diverge, the same seed stops meaning the same stream in the two places.
import type { Rng } from "@ai-dm/rules-engine";

/** Deterministic PRNG (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Feeds an exact sequence of [0,1) values so individual rolls are pinned. */
export function scripted(values: readonly number[]): Rng {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("scripted RNG exhausted");
    return value;
  };
}

/** The `[0,1)` value that makes `rollDie(20, rng)` return exactly `face`. */
export function d20Exactly(face: number): number {
  return (face - 1) / 20 + 0.0001;
}
