// The benchmark matrix. Arms are data: adding a model or an effort level is an
// edit here, never a branch in code.
//
// NOTHING in this file is a measurement or a recommendation. It is the list of
// candidates to measure. `DEFAULT_MODEL_ROUTING.tactical` in `@ai-dm/agents`
// stays exactly as it is until a live run has produced numbers to change it by.
import type { ModelSpec, ProviderId, ReasoningEffort } from "@ai-dm/agents";
import { ALL_SCENARIO_IDS } from "./scenarios/index.js";

export interface Arm {
  /** `<modelId>@<effort>`. Stable, so reports across runs line up. */
  armId: string;
  spec: ModelSpec;
}

interface Candidate {
  provider: ProviderId;
  modelId: string;
}

/**
 * The plan's tactical candidates (PROJECT_PLAN.md section 2), plus one Claude
 * model as a quality ceiling — if the cheap models all miss the 95% bar, the
 * ceiling says whether the task is hard or the models are weak.
 */
const CANDIDATES: readonly Candidate[] = [
  // Was "gemini-3-flash". A live probe against that id returned
  // provider_error on every call (real network round-trip, 0 tokens, $0
  // billed) — the same symptom later confirmed, against this corrected id,
  // to be Google Generate Content API per-minute quota exhaustion rather
  // than an invalid model id. Whether "gemini-3-flash" was ever actually
  // wrong is therefore unconfirmed; it may have hit the same quota. This id
  // has not yet produced a successful live call either — see
  // tools/sim/CLAUDE.md's Live benchmarking section before trusting it.
  { provider: "google", modelId: "gemini-3.1-flash-lite" },
  { provider: "openai", modelId: "gpt-5.4-mini" },
  { provider: "openai", modelId: "gpt-5.4-nano" },
  { provider: "anthropic", modelId: "claude-sonnet-5" },
];

/** Swept, because `REASONING_BUDGET_TOKENS` is an unmeasured placeholder too. */
const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

/** Near-deterministic but not frozen, matching the tactical row's rationale. */
const TACTICAL_TEMPERATURE = 0.2;

export const ARMS: readonly Arm[] = CANDIDATES.flatMap((candidate) =>
  EFFORTS.map((effort) => ({
    armId: `${candidate.modelId}@${effort}`,
    spec: {
      provider: candidate.provider,
      modelId: candidate.modelId,
      temperature: TACTICAL_TEMPERATURE,
      reasoningEffort: effort,
    } satisfies ModelSpec,
  })),
);

/** Five seeds is enough to see variance without making a live sweep expensive. */
export const DEFAULT_SEEDS: readonly number[] = [1, 2, 3, 4, 5];

/** The arm the smoke run uses. Never called: the scripted port answers for it. */
export const SMOKE_ARM: Arm = {
  armId: "scripted-fake@medium",
  spec: { provider: "google", modelId: "scripted-fake", reasoningEffort: "medium" },
};

/**
 * `ARMS` holds only the 12 live candidates, but `SMOKE_ARM.armId` names a real
 * arm too — the one the smoke run always uses. Resolving it here (rather than
 * leaving it a lookup miss) means `--arms scripted-fake@medium` behaves like
 * every other arm id instead of throwing a "known:" list that omits the one
 * arm every non-`--live` run actually exercises.
 */
export function armById(armId: string): Arm {
  if (armId === SMOKE_ARM.armId) return SMOKE_ARM;
  const found = ARMS.find((arm) => arm.armId === armId);
  if (found === undefined) {
    const known = [...ARMS.map((arm) => arm.armId), SMOKE_ARM.armId].join(", ");
    throw new Error(`Unknown arm ${armId}; known: ${known}`);
  }
  return found;
}

export interface BenchmarkConfig {
  mode: "probe" | "encounter" | "both";
  live: boolean;
  arms: readonly Arm[];
  seeds: readonly number[];
  scenarioIds: readonly string[];
}

export const DEFAULT_CONFIG: BenchmarkConfig = {
  mode: "both",
  live: false,
  arms: [SMOKE_ARM],
  seeds: DEFAULT_SEEDS,
  scenarioIds: ALL_SCENARIO_IDS,
};
