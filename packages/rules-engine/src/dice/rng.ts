// Deterministic PRNG. Pure, so it belongs inside this package's boundary —
// and exported, so the sim and the server share one stream rather than each
// keeping a copy that can drift.
import type { Rng } from "./index.js";

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
