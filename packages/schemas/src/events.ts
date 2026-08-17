import { z } from "zod";

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
