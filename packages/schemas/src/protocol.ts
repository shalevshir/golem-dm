// The client/server wire protocol. It lives here, not in `apps/server`,
// because `apps/web` may depend only on this package (invariant 5) and both
// ends must read the same definition (invariant 4).
//
// Nothing in this file may import a Node built-in: `apps/web` bundles it for
// the browser.
import { z } from "zod";
import { ExecuteTurn } from "./actions.js";
import { GameEvent } from "./events.js";
import { Combatant, GridMap } from "./world.js";

/**
 * Player free text is untrusted. Capping it in the schema means an oversized
 * message dies during transport parsing, before any code path could put it in
 * front of a model.
 */
export const MAX_FREE_TEXT_LENGTH = 500;

/**
 * The serializable projection. Deliberately not `CombatWorld`: that carries a
 * `lineOfSight` function, which cannot be snapshotted. The algorithm is paired
 * back in at call time.
 *
 * Stat blocks are absent for the same reason they are absent from the event
 * log — they are static per encounter and re-derived from `encounterId`. A
 * snapshot holds only what events change.
 */
export const SessionState = z.object({
  sessionId: z.string(),
  /** Every turn's dice seed derives from this and the turn's sequence. */
  rootSeed: z.number().int(),
  encounterId: z.string(),
  grid: GridMap,
  combatants: z.array(Combatant),
  turnOrder: z.array(z.string()),
  currentActorIndex: z.number().int().min(0),
  round: z.number().int().min(1),
  /** Idempotency, as a projection of the log rather than connection state. */
  appliedClientMessageIds: z.array(z.string()),
});

export type SessionState = z.infer<typeof SessionState>;

export const JoinMessage = z.object({
  type: z.literal("join"),
  sessionId: z.string(),
  /** Replay everything after this sequence. Absent means "send me a snapshot". */
  resumeFrom: z.number().int().min(0).optional(),
});

export const StructuredActionMessage = z.object({
  type: z.literal("structured_action"),
  clientMessageId: z.string(),
  actorId: z.string(),
  /**
   * The same schema the tactical agent emits, validated by the same
   * `validateExecuteTurn`. There is no second action format for players.
   */
  turn: ExecuteTurn,
});

/**
 * Accepted by the envelope, but not implemented in this slice: the pipeline
 * answers every `free_text` message with a `free_text_not_supported` error
 * frame rather than routing it to a model. The `.max` cap still matters even
 * so — it stops an oversized message at transport parse, before any future
 * implementation could put it in front of a prompt.
 */
export const FreeTextMessage = z.object({
  type: z.literal("free_text"),
  clientMessageId: z.string(),
  text: z.string().min(1).max(MAX_FREE_TEXT_LENGTH),
});

export const ClientMessage = z.discriminatedUnion("type", [
  JoinMessage,
  StructuredActionMessage,
  FreeTextMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerErrorCode = z.enum([
  "unknown_session",
  "malformed_message",
  "turn_in_progress",
  "free_text_not_supported",
  "not_your_turn",
  "internal_error",
]);

export type ServerErrorCode = z.infer<typeof ServerErrorCode>;

export const ServerFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_state"),
    sequence: z.number().int().min(0),
    snapshot: SessionState,
  }),
  z.object({ type: z.literal("event"), event: GameEvent }),
  /**
   * Transient, deliberately outside the event sequence. The log gets one
   * `narrative_emitted` event with the full text on completion; a client that
   * reconnects mid-stream reconciles against that event rather than seeing a
   * gap.
   */
  z.object({ type: z.literal("narrative_token"), streamId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("rejected"),
    clientMessageId: z.string(),
    /** `TurnRejectionReason` codes. Open strings — that type lives downstream. */
    reasons: z.array(z.string()),
    messages: z.array(z.string()),
  }),
  z.object({
    type: z.literal("error"),
    clientMessageId: z.string().optional(),
    code: ServerErrorCode,
    message: z.string(),
  }),
]);

export type ServerFrame = z.infer<typeof ServerFrame>;
