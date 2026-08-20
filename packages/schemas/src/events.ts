import { z } from "zod";
import { ExecuteTurn } from "./actions.js";
import { EntityStatus } from "./world.js";
import { DiceNotation } from "./srd.js";

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

export const AttackOutcome = z.enum(["hit", "miss", "critical_hit", "critical_miss"]);
export type AttackOutcome = z.infer<typeof AttackOutcome>;

/**
 * The d20-vs-AC picture for one attack. `rolls` has one entry normally, two
 * when advantage or disadvantage rolled both dice — `naturalRoll` is
 * whichever of `rolls` was actually used. `targetArmorClass` already
 * includes any cover bonus; there is no separate raw-AC field because
 * nothing downstream reads one.
 */
export const AttackRollTrace = z.object({
  naturalRoll: z.number().int().min(1).max(20),
  rolls: z.array(z.number().int()),
  total: z.number().int(),
  targetArmorClass: z.number().int(),
});
export type AttackRollTrace = z.infer<typeof AttackRollTrace>;

/**
 * One damage source's roll. `"dice"` when the stat block has a dice
 * notation; `"flat"` when it only has a printed average (some monsters have
 * no dice at all for a minor rider, e.g. "plus 1 necrotic damage").
 */
export const DamageRollTrace = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dice"),
    notation: DiceNotation,
    rolls: z.array(z.number().int()),
    modifier: z.number().int(),
    total: z.number().int(),
  }),
  z.object({ kind: z.literal("flat"), total: z.number().int() }),
]);
export type DamageRollTrace = z.infer<typeof DamageRollTrace>;

/**
 * Enriched replacement for the rules engine's internal `AttackRecord` shape
 * on the wire. `damage` keeps the name and meaning `AttackRecord.damage`
 * already has — `packages/agents/src/narrative/deterministic.ts` reads it,
 * so it is not renamed here. `damageRolls` is an empty array on a miss (no
 * damage is ever rolled for a miss) and can have more than one entry when a
 * weapon has extra-damage riders (each becomes its own roll).
 */
export const AttackTrace = z.object({
  attackerId: z.string(),
  targetId: z.string(),
  actionId: z.string(),
  outcome: AttackOutcome,
  damage: z.number().int(),
  targetStatusAfter: EntityStatus,
  attackRoll: AttackRollTrace,
  damageRolls: z.array(DamageRollTrace),
});
export type AttackTrace = z.infer<typeof AttackTrace>;

/**
 * Payload for the `dice_rolled` event. `reduce()` still no-ops this event
 * type (it does not change `SessionState`) — this schema exists so the web
 * client's combat log (a client-only display feature, not state) can safely
 * parse what the engine already computed. `movedFeet` is the turn's total
 * movement distance, already accounting for terrain cost.
 */
export const DiceRolledPayload = z.object({
  actorId: z.string(),
  attacks: z.array(AttackTrace),
  /**
   * `movedFeet` departs from the append-only convention of adding new
   * fields `.optional()` (see `packages/schemas/CLAUDE.md`) — deliberately.
   * A legacy `dice_rolled` event persisted before this field existed should
   * fail this parse and be skipped by the client's defensive handling
   * (`foldCombatLog`), not render with a fabricated `movedFeet: 0` that
   * looks like real data. A half-rendered legacy event with a false zero is
   * worse than one uniformly skipped.
   */
  movedFeet: z.number().int().min(0),
  /**
   * The RNG seed the engine used to resolve this turn's rolls. Present for
   * replay/audit even though the client's combat log does not currently
   * read it.
   */
  seed: z.number().int(),
});
export type DiceRolledPayload = z.infer<typeof DiceRolledPayload>;

/**
 * Payload for the `action_validated` event. The server already emits
 * exactly this shape (`pipeline.ts`'s two `action_validated` emit sites);
 * this schema is new, the server payload is not — it lets the client read
 * `turn.mainAction.actionType` to label a non-attack turn in the combat log.
 */
export const ActionValidatedPayload = z.object({
  actorId: z.string(),
  turn: ExecuteTurn,
  source: z.string(),
});
export type ActionValidatedPayload = z.infer<typeof ActionValidatedPayload>;
