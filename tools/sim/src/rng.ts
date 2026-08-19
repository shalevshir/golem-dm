// Deterministic randomness for the whole simulator. A run must be exactly
// reproducible given (seed, model, scenario), so nothing here reads a clock and
// nothing anywhere in this package calls Math.random.
import type { Rng } from "@ai-dm/rules-engine";

export { seeded } from "@ai-dm/rules-engine";

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
