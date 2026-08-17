// One row per turn, emitted identically by probe mode and encounter mode. Every
// aggregate in the report is a fold over these, so the two modes stay
// comparable and the metrics have exactly one input shape.
import type { CallTiming, TokenUsage, TurnProposalResult } from "@ai-dm/agents";

export type TurnOutcome = "model" | "retry" | "fallback" | "aborted" | "no_legal_turn";

export interface TurnRecord {
  armId: string;
  scenarioId: string;
  seed: number;
  round: number;
  actorId: string;
  outcome: TurnOutcome;
  /** Model calls made. Never more than two — the agent's loop is straight-line. */
  attempts: number;
  /** `TurnRejectionReason` codes from the engine. */
  rejectionReasons: readonly string[];
  /** `AdapterErrorCode` values from the port. */
  adapterErrorCodes: readonly string[];
  promptTokens: number;
  completionTokens: number;
  /** False when any attempt was billed but reported no usage. */
  usageComplete: boolean;
  attemptsMissingUsage: number;
  /** Summed across attempts: what the turn cost in wall-clock. */
  durationMs: number;
  callDurationsMs: readonly number[];
  /** Engine-legal action ids the actor's stat block does not contain. */
  unresolvedActionIds: readonly string[];
}

export interface RecordInput {
  armId: string;
  scenarioId: string;
  seed: number;
  round: number;
  actorId: string;
  result: TurnProposalResult;
  /** The slice of `TimingPort.timings` this turn produced. */
  timings: readonly CallTiming[];
  unresolvedActionIds?: readonly string[];
}

function outcomeOf(result: TurnProposalResult): TurnOutcome {
  return result.ok ? result.source : result.kind;
}

function totals(usage: readonly TokenUsage[]): { prompt: number; completion: number } {
  return usage.reduce(
    (accumulator, each) => ({
      prompt: accumulator.prompt + each.promptTokens,
      completion: accumulator.completion + each.completionTokens,
    }),
    { prompt: 0, completion: 0 },
  );
}

export function recordFrom(input: RecordInput): TurnRecord {
  const { result } = input;
  const { prompt, completion } = totals(result.usage);

  // Every model call should have produced one usage entry. Any shortfall is an
  // attempt that was billed and reported nothing — the report says so rather
  // than quietly publishing a low number.
  const attempts = input.timings.length;
  const attemptsMissingUsage = Math.max(0, attempts - result.usage.length);

  return {
    armId: input.armId,
    scenarioId: input.scenarioId,
    seed: input.seed,
    round: input.round,
    actorId: input.actorId,
    outcome: outcomeOf(result),
    attempts,
    rejectionReasons: result.rejections.flatMap((rejection) => rejection.reasons ?? []),
    adapterErrorCodes: result.rejections.flatMap((rejection) =>
      rejection.adapterErrorCode === undefined ? [] : [rejection.adapterErrorCode],
    ),
    promptTokens: prompt,
    completionTokens: completion,
    usageComplete: attemptsMissingUsage === 0,
    attemptsMissingUsage,
    durationMs: input.timings.reduce((sum, timing) => sum + timing.durationMs, 0),
    callDurationsMs: input.timings.map((timing) => timing.durationMs),
    unresolvedActionIds: input.unresolvedActionIds ?? [],
  };
}
