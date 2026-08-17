// Builds `action_rejected` payloads. The agent returns these; it never stamps a
// `GameEvent` around them, because eventId, sequence and timestamp need a UUID
// source, a log cursor and a clock — none of which belong in this package.
import type { TurnRejection } from "@ai-dm/rules-engine";
import type { ActionRejectedPayload, ExecuteTurn } from "@ai-dm/schemas";
import type { AdapterError } from "../providers/errors.js";
import type { ModelSpec } from "../providers/routing.js";
import { TACTICAL_PROMPT_VERSION } from "./prompt-text.js";

/** There is never a third. The type says so. */
export type AttemptNumber = 1 | 2;

export function engineRejection(
  actorId: string,
  attempt: AttemptNumber,
  rejections: readonly TurnRejection[],
  proposedTurn: ExecuteTurn,
  spec: ModelSpec,
): ActionRejectedPayload {
  return {
    actorId,
    attempt,
    stage: "engine",
    reasons: rejections.map((rejection) => rejection.reason),
    messages: rejections.map((rejection) => rejection.message),
    proposedTurn,
    provider: spec.provider,
    modelId: spec.modelId,
    promptVersion: TACTICAL_PROMPT_VERSION,
  };
}

export function adapterRejection(
  actorId: string,
  attempt: AttemptNumber,
  error: AdapterError,
  spec: ModelSpec,
): ActionRejectedPayload {
  return {
    actorId,
    attempt,
    stage: "adapter",
    adapterErrorCode: error.code,
    messages: [error.message],
    provider: spec.provider,
    modelId: spec.modelId,
    promptVersion: TACTICAL_PROMPT_VERSION,
  };
}
