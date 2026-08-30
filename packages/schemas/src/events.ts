import { z } from "zod";
import { ExecuteTurn } from "./actions.js";
import { AbilityKey, Skill } from "./character.js";
import { ContentId, FactionRelationEntry } from "./content.js";
import { CheckDifficulty, IntentClassification } from "./intent.js";
import { Combatant, EntityStatus, GridMap } from "./world.js";
import { DiceNotation } from "./primitives.js";

/**
 * Append-only game event log entry. The event stream is the source of truth;
 * world state is a projection. Enables replay, undo, and campaign restore.
 */
export const GameEvent = z.object({
  eventId: z.string().uuid(),
  campaignId: z.string(),
  sequence: z.number().int().min(0),
  timestamp: z.string().datetime(),
  type: z.enum([
    "player_input", "intent_classified", "action_proposed", "action_validated",
    "action_rejected", "dice_rolled", "state_delta_applied", "narrative_emitted",
    "scene_changed",
    "campaign_started", "encounter_started", "encounter_resolved",
    "quest_node_entered", "quest_node_completed", "world_delta_applied", "check_rolled",
  ]),
  /**
   * English machine payload. Hebrew is allowed in exactly two fields:
   * `narrative_emitted.text` and `player_input.text` (the player's own
   * words).
   */
  payload: z.record(z.string(), z.unknown()),
});

export type GameEvent = z.infer<typeof GameEvent>;

/**
 * The campaign's spine: `campaign_started` opens the stream, and each
 * encounter is the bracketed span between an `encounter_started` and its
 * `encounter_resolved` (ADR-0004). At most one bracket is open at a time,
 * which is what makes `CampaignState.encounter` a nullable field rather than
 * a map.
 *
 * All three payloads carry only what cannot be rebuilt. The projection each
 * one opens is reconstructed from these fields rather than persisted — the
 * same rule genesis already follows today, where the initial board is rebuilt
 * from `encounterId` rather than stored — so a payload here names a thing and
 * never snapshots it.
 *
 * `CampaignStartedPayload`: `rootSeed` alone opens a combat-only campaign, as
 * before. The other four fields are the scene genesis quartet (§4.7 step 4):
 * present together, they let `sceneFromGenesis` (`protocol.ts`) build the
 * starting `SceneSnapshot`. The `.refine` below enforces all-or-none so the
 * fold never has to guess a scene from a partial quartet.
 */
export const CampaignStartedPayload = z
  .object({
    rootSeed: z.number().int(),
    worldId: ContentId.optional(),
    startingNodeId: ContentId.optional(),
    startingDay: z.number().int().min(1).optional(),
    characterId: z.string().optional(),
  })
  .refine(
    (p) =>
      [p.worldId, p.startingNodeId, p.startingDay, p.characterId].every((f) => f === undefined) ||
      [p.worldId, p.startingNodeId, p.startingDay, p.characterId].every((f) => f !== undefined),
    { message: "scene genesis fields are all-or-none" },
  );
export type CampaignStartedPayload = z.infer<typeof CampaignStartedPayload>;

/**
 * `encounter_started` carries the whole initial board, not just a name, so
 * `reduce` can project a bracket with no catalogue substitution — the fold
 * gap `reduce.ts`'s header used to document (spec Decision 2).
 *
 * The three board fields are optional as a group, and only as a group: a
 * persisted pre-step-5 payload has none of them and must still parse and
 * fold (append-only compatibility), while a payload with some but not all is
 * a corrupt producer, not a legacy one. That is the same all-or-nothing
 * `.refine` shape `CampaignStartedPayload`'s genesis quartet uses.
 *
 * Stat blocks are deliberately absent, for the reason `EncounterState` omits
 * them: they are static per encounter and re-derived server-side from ids. So
 * is `maxRounds` — only the server enforces it, and `builtOf` already reaches
 * it.
 */
export const EncounterStartedPayload = z
  .object({
    encounterId: z.string(),
    grid: GridMap.optional(),
    combatants: z.array(Combatant).optional(),
    turnOrder: z.array(z.string()).optional(),
  })
  .refine(
    (payload) => {
      const present = [payload.grid, payload.combatants, payload.turnOrder].filter(
        (each) => each !== undefined,
      ).length;
      return present === 0 || present === 3;
    },
    { message: "encounter_started must declare all three board fields or none of them" },
  );
export type EncounterStartedPayload = z.infer<typeof EncounterStartedPayload>;

export const EncounterResolvedPayload = z.object({
  encounterId: z.string(),
  /**
   * An open string rather than a closed enum, for the reason
   * `ActionRejectedPayload` below spells out: this is persisted forever, so a
   * closed enum becomes a migration the first time an outcome is added — and
   * "victory"/"defeat" is exactly the pair §4.7 expects to grow (fled,
   * negotiated, abandoned).
   */
  outcome: z.string(),
  /**
   * Who walked out. Ids only: everything else about them — HP, position,
   * conditions — leaves the projection with the bracket, and what must
   * outlive the fight travels in declared world-state effects from §4.7's
   * step 5 onward, not here.
   */
  survivorIds: z.array(z.string()),
});
export type EncounterResolvedPayload = z.infer<typeof EncounterResolvedPayload>;

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

/** Where a turn's narration actually came from. Metrics only, never correctness. */
export const NarrationSource = z.enum(["model", "deterministic", "completed"]);
export type NarrationSource = z.infer<typeof NarrationSource>;

/**
 * Payload convention for the `narrative_emitted` event, in the same spirit as
 * `ActionRejectedPayload`: the server stamps the envelope, this documents the
 * body.
 *
 * `text` is the ONLY place Hebrew is allowed in the event log.
 *
 * `source` exists because a narrated turn and a fallback turn are
 * indistinguishable from the text alone once the fallback is Hebrew too, and
 * the ratio between them is the single most useful number the step 9
 * benchmark produces. `promptVersion` does for narration what it already does
 * for `action_rejected`: keeps runs taken either side of a prompt edit from
 * being pooled.
 */
export const NarrativeEmittedPayload = z.object({
  actorId: z.string(),
  streamId: z.string(),
  text: z.string().min(1),
  source: NarrationSource,
  promptVersion: z.string().min(1),
});

export type NarrativeEmittedPayload = z.infer<typeof NarrativeEmittedPayload>;

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
 * type (it does not change `CampaignState`) — this schema exists so the web
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

/**
 * Payload for `quest_node_entered`. `reduce` replaces `scene.currentNodeId`
 * with `nodeId` verbatim — no validation that the traversal was legal, which
 * is `traverseEdge`'s job in `@ai-dm/rules-engine` (invariant 1). The event
 * log only ever records what the engine already decided.
 */
export const QuestNodeEnteredPayload = z.object({ nodeId: ContentId });
export type QuestNodeEnteredPayload = z.infer<typeof QuestNodeEnteredPayload>;

/**
 * Payload for `quest_node_completed`. `reduce` appends `nodeId` to
 * `scene.completedNodeIds`, folding a repeat of the same id to one entry —
 * mechanical, same as the rest of this event's fold.
 */
export const QuestNodeCompletedPayload = z.object({ nodeId: ContentId });
export type QuestNodeCompletedPayload = z.infer<typeof QuestNodeCompletedPayload>;

/**
 * Payload for `world_delta_applied`. Both fields carry the engine's already-
 * computed, already-clamped RESULT, never a delta to compute (Decision 4 of
 * the design spec) — `reduce` only merges what is here onto `scene`.
 */
export const WorldDeltaAppliedPayload = z.object({
  /** Absolute resulting bands, post-clamp — the fold merges, never computes. */
  relations: z.array(FactionRelationEntry).default([]),
  /** The new absolute day, when the calendar moved. */
  day: z.number().int().min(1).optional(),
});
export type WorldDeltaAppliedPayload = z.infer<typeof WorldDeltaAppliedPayload>;

/**
 * Payload for `check_rolled`: the full trace of one out-of-combat ability
 * check, already resolved by `@ai-dm/rules-engine`'s `abilityCheck`. `reduce`
 * no-ops this event — it changes no projected field, and exists for replay,
 * audit, and the step 9 benchmark, the same convention `DiceRolledPayload`
 * already follows for combat rolls.
 */
export const CheckRolledPayload = z.object({
  actorId: z.string(),
  ability: AbilityKey,
  skill: Skill.optional(),
  difficulty: CheckDifficulty,
  dc: z.number().int(),
  naturalRoll: z.number().int().min(1).max(20),
  rolls: z.array(z.number().int()),
  modifier: z.number().int(),
  total: z.number().int(),
  success: z.boolean(),
  seed: z.number().int(),
});
export type CheckRolledPayload = z.infer<typeof CheckRolledPayload>;

/**
 * Payload convention for the `intent_classified` event, in the same spirit
 * as `ActionRejectedPayload`: the server stamps the envelope, this documents
 * the body. Like `dice_rolled`/`check_rolled`, `reduce` folds this as a
 * no-op — it changes no projected field, and exists for replay, audit, and
 * metrics.
 */
export const IntentClassifiedPayload = z.object({
  clientMessageId: z.string(),
  actorId: z.string(),
  classification: IntentClassification,
  provider: z.string(),
  modelId: z.string(),
  promptVersion: z.string(),
});
export type IntentClassifiedPayload = z.infer<typeof IntentClassifiedPayload>;
