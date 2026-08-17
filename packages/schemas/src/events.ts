import { z } from "zod";
import { ExecuteTurn } from "./actions.js";

/**
 * Append-only game event log entry. The event stream is the source of truth;
 * world state is a projection. Enables replay, undo, and session restore.
 */
export const GameEvent = z.object({
  eventId: z.string().uuid(),
  sessionId: z.string(),
  sequence: z.number().int().min(0),
  timestamp: z.string().datetime(),
  type: z.enum([
    "player_input", "intent_classified", "action_proposed", "action_validated",
    "action_rejected", "dice_rolled", "state_delta_applied", "narrative_emitted",
    "scene_changed", "session_snapshot",
  ]),
  /** English machine payload. Never store Hebrew here except narrative_emitted. */
  payload: z.record(z.string(), z.unknown()),
});

export type GameEvent = z.infer<typeof GameEvent>;

/**
 * Payload convention for the `action_rejected` event. The tactical agent
 * produces these and the server stamps them into a `GameEvent` — the agent has
 * no clock and no UUID source, so it never builds the envelope itself.
 *
 * The code fields are `z.string()` rather than closed enums on purpose. This
 * payload is persisted forever, so a closed enum here becomes a migration the
 * first time a provider or a rejection reason is added. `reasons` additionally
 * cannot be narrowed to `TurnRejectionReason` without inverting the dependency
 * direction — that type lives downstream, in the rules engine.
 */
export const ActionRejectedPayload = z.object({
  actorId: z.string(),
  /** Which of the two model attempts produced this. There is never a third. */
  attempt: z.number().int().min(1).max(2),
  stage: z.enum(["adapter", "engine"]),
  /** An `AdapterErrorCode`. Present when `stage` is "adapter". */
  adapterErrorCode: z.string().optional(),
  /** `TurnRejectionReason` codes. Present when `stage` is "engine". */
  reasons: z.array(z.string()).optional(),
  /** English. Safe to persist in the log; never shown to a player. */
  messages: z.array(z.string()),
  /** The proposal that was rejected, when the model produced one at all. */
  proposedTurn: ExecuteTurn.optional(),
  /** Both stamped so step 7b can group a log of rejections by model. */
  provider: z.string(),
  modelId: z.string(),
  /**
   * Which prompt produced this. Optional because events written before the
   * field existed cannot be back-filled, and this log is append-only.
   */
  promptVersion: z.string().optional(),
});

export type ActionRejectedPayload = z.infer<typeof ActionRejectedPayload>;
