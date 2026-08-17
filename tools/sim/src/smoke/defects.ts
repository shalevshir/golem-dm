// What the fake model does wrong, and how often. Drawn from the run's seeded
// RNG so a smoke run exercises first-try, retry and fallback in proportions
// that are fixed for a given seed — which is what lets the smoke test assert
// exact counts and so pin the metrics arithmetic, rather than merely proving
// the process starts.
//
// The weights are a fixture, not a claim about any real model. Nothing here may
// be read as a measurement.
import type { Rng } from "@ai-dm/rules-engine";
import type { TokenUsage } from "@ai-dm/agents";

export type DefectKind =
  "none" | "schema_validation_failed" | "no_tool_call" | "illegal_target" | "provider_error";

interface Weighted {
  kind: DefectKind;
  /** Cumulative upper bound in [0, 1]. The last entry must be exactly 1. */
  upTo: number;
}

const SCHEDULE: readonly Weighted[] = [
  { kind: "none", upTo: 0.75 },
  { kind: "illegal_target", upTo: 0.85 },
  { kind: "schema_validation_failed", upTo: 0.92 },
  { kind: "no_tool_call", upTo: 0.97 },
  { kind: "provider_error", upTo: 1 },
];

/** Consumes exactly one draw, so the schedule never desynchronises the dice. */
export function nextDefect(rng: Rng): DefectKind {
  const value = rng();
  for (const entry of SCHEDULE) {
    if (value < entry.upTo) return entry.kind;
  }
  // Only reachable if rng() returned exactly 1, which the contract excludes.
  return "provider_error";
}

/** Plausible token counts for a tactical turn. A fixture, not a measurement. */
export const SMOKE_USAGE: TokenUsage = {
  promptTokens: 1400,
  completionTokens: 90,
  totalTokens: 1490,
};
