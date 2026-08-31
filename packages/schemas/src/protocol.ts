// The client/server wire protocol. It lives here, not in `apps/server`,
// because `apps/web` may depend only on this package (invariant 5) and both
// ends must read the same definition (invariant 4).
//
// Nothing in this file may import a Node built-in: `apps/web` bundles it for
// the browser.
import { z } from "zod";
import { ActionType, ExecuteTurn, Tile } from "./actions.js";
import { ContentId, FactionRelationEntry, NpcAffinityEntry } from "./content.js";
import { DerivedCharacter } from "./derived.js";
import { GameEvent } from "./events.js";
import type { CampaignStartedPayload } from "./events.js";
import { Combatant, Faction, GridMap } from "./world.js";

/**
 * Player free text is untrusted. Capping it in the schema means an oversized
 * message dies during transport parsing, before any code path could put it in
 * front of a model.
 */
export const MAX_FREE_TEXT_LENGTH = 500;

/**
 * The exploration/social projection (§4.7 step 4), deltas-only against the
 * world's authored baseline (see the design spec's Decision 2): `relations`
 * carries ONLY the faction pairs a completed node has actually shifted, as
 * absolute bands, never the full authored table. Reading standing between any
 * two factions always goes through `relationBetween` (the step 3 scene
 * engine), which falls back to the authored baseline for a pair absent here —
 * never through this array alone.
 */
export const SceneSnapshot = z.object({
  worldId: ContentId,
  currentNodeId: ContentId,
  completedNodeIds: z.array(ContentId),
  /** Overlay: ONLY pairs a completed node has shifted (absolute bands).
   *  Read through `relationBetween`'s authored baseline, never alone. */
  relations: z.array(FactionRelationEntry),
  /** Deltas-only overlay: ONLY NPCs an authored effect has actually touched.
   *  Read through `affinityOf`, never alone — absent means neutral, no
   *  facts. Unlike `relations` there is no authored baseline behind this:
   *  a single hardcoded default covers every NPC nobody has touched yet. */
  npcAffinities: z.array(NpcAffinityEntry).default([]),
  day: z.number().int().min(1),
});

export type SceneSnapshot = z.infer<typeof SceneSnapshot>;

/**
 * What outlives every encounter: the campaign's identity, its randomness, and
 * the ids it has already acted on.
 *
 * It holds almost nothing on purpose. The dials a campaign will eventually
 * need — calendar, faction standing, current quest node — arrive with the
 * §4.7 steps that give them meaning; a change that both restructures the
 * projection and fills it could not be reviewed.
 *
 * `appliedClientMessageIds` sits here rather than on the encounter because
 * idempotency has to survive a fight ending, and must cover free text and
 * narrative moves later rather than turns alone.
 *
 * `scene` is null for a combat-only campaign (a `campaign_started` with no
 * genesis quartet) and for every campaign that predates §4.7 step 4 — the
 * `.default(null)` is what keeps a legacy `campaign_started` payload folding
 * to a valid `WorldState` (append-only compatibility).
 */
export const WorldState = z.object({
  campaignId: z.string(),
  /** Every seed in the campaign derives from this and a log sequence. */
  rootSeed: z.number().int(),
  appliedClientMessageIds: z.array(z.string()),
  scene: SceneSnapshot.nullable().default(null),
});

export type WorldState = z.infer<typeof WorldState>;

/**
 * The starting `SceneSnapshot`, or null for a campaign with no scene genesis.
 * `payload.worldId === undefined` is the null case; `CampaignStartedPayload`'s
 * `.refine` guarantees the other three quartet fields are present whenever it
 * is not, but each is still narrowed here rather than asserted — a payload
 * this function is handed may not have gone through that parse.
 */
export function sceneFromGenesis(payload: CampaignStartedPayload): SceneSnapshot | null {
  const { worldId, startingNodeId, startingDay, characterId } = payload;
  if (
    worldId === undefined ||
    startingNodeId === undefined ||
    startingDay === undefined ||
    characterId === undefined
  ) {
    return null;
  }
  return {
    worldId,
    currentNodeId: startingNodeId,
    completedNodeIds: [],
    relations: [],
    npcAffinities: [],
    day: startingDay,
  };
}

/**
 * One fight's board, and nothing that outlives it. Deliberately not
 * `CombatWorld`: that carries a `lineOfSight` function, which cannot be
 * snapshotted. The algorithm is paired back in at call time.
 *
 * Stat blocks are absent for the same reason they are absent from the event
 * log — they are static per encounter and re-derived from `encounterId`. A
 * snapshot holds only what events change.
 */
export const EncounterState = z.object({
  encounterId: z.string(),
  grid: GridMap,
  combatants: z.array(Combatant),
  turnOrder: z.array(z.string()),
  currentActorIndex: z.number().int().min(0),
  round: z.number().int().min(1),
});

export type EncounterState = z.infer<typeof EncounterState>;

/**
 * The serializable projection: a campaign, and the one encounter open inside
 * it if there is one (ADR-0004).
 *
 * A field rather than a map because the bracket is strictly non-overlapping —
 * at most one encounter runs at a time, and a second `encounter_started`
 * inside an open one is a corrupt log, not a second fight. Whether the
 * campaign is in a fight is therefore `encounter !== null`, derived rather
 * than stored: a `mode` enum would be exactly that expression today, and it
 * earns its place only once exploration and social genuinely diverge (§4.7's
 * step 4).
 */
export const CampaignState = z.object({
  world: WorldState,
  /** Non-null exactly between `encounter_started` and `encounter_resolved`. */
  encounter: EncounterState.nullable(),
});

export type CampaignState = z.infer<typeof CampaignState>;

export const JoinMessage = z.object({
  type: z.literal("join"),
  campaignId: z.string(),
  /**
   * Replay everything after this sequence. Absent means "send me a
   * snapshot". A `join` always gets exactly one guaranteed response, never
   * silence: when there is nothing to replay (`resumeFrom` is already at or
   * past the newest sequence — a client that missed nothing), the server
   * still answers with a `campaign_state` frame at the current projection,
   * the same shape used when `resumeFrom` is absent — so "you're caught up"
   * is never indistinguishable from a dropped join.
   */
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
 * The pipeline routes this to the intent router out of combat (§4.7 step 4);
 * in combat, or with no scene open at all, it still answers with a
 * `free_text_not_supported` error frame. The `.max` cap matters regardless of
 * routing — it stops an oversized message at transport parse, before it ever
 * reaches a prompt.
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
  "unknown_campaign",
  "malformed_message",
  "turn_in_progress",
  "free_text_not_supported",
  "not_your_turn",
  "internal_error",
]);

export type ServerErrorCode = z.infer<typeof ServerErrorCode>;

/**
 * One action the actor may take right now, with the targets it may legally
 * take it against. Ids and enum members only — display names are static per
 * encounter and travel over `GET /encounters/:encounterId` instead, so a
 * frame sent every turn does not re-send text that never changes.
 *
 * `actionType` is present because the client builds `ExecuteTurn.mainAction`
 * from this, and deducing the type from the id would be the client reasoning
 * about rules — the exact thing affordances exist to prevent. `actionId` is
 * optional because Dodge, Dash and Disengage have none.
 */
export const ActionAffordance = z.object({
  actionType: ActionType,
  actionId: z.string().optional(),
  /**
   * Distinguishes "needs no target" (Dodge) from "needs one and none is in
   * range", which an empty `targetableCombatantIds` alone cannot express.
   */
  requiresTarget: z.boolean(),
  targetableCombatantIds: z.array(z.string()),
});

export type ActionAffordance = z.infer<typeof ActionAffordance>;

/**
 * Everything the actor may legally do this turn, derived server-side by
 * running `validateExecuteTurn` over enumerated candidates. The client
 * highlights exactly this and computes nothing: a tile it draws as reachable
 * is a tile the validator already accepted.
 */
export const TurnAffordances = z.object({
  actorId: z.string(),
  reachableTiles: z.array(Tile),
  actions: z.array(ActionAffordance),
});

export type TurnAffordances = z.infer<typeof TurnAffordances>;

/**
 * One combatant's display facts for the encounter catalogue: what a client
 * needs to label what it draws. Nothing here changes turn to turn — current
 * HP, position and conditions live in `CampaignState`/`GameEvent` instead;
 * this is only ever `maxHp`, the ceiling that never moves.
 */
export const CatalogueCombatant = z.object({
  combatantId: z.string(),
  nameEnglish: z.string(),
  nameHebrew: z.string().min(1),
  maxHp: z.number().int().min(1),
  faction: Faction,
});

export type CatalogueCombatant = z.infer<typeof CatalogueCombatant>;

/** One action's display label in the encounter catalogue. */
export const CatalogueAction = z.object({
  actionId: z.string(),
  nameEnglish: z.string(),
  nameHebrew: z.string().min(1),
});

export type CatalogueAction = z.infer<typeof CatalogueAction>;

/**
 * The response body of `GET /encounters/:encounterId`. It is HTTP rather
 * than a frame because it is static per encounter — pushing it on the socket
 * would re-send unchanging text on every turn of every campaign, on a
 * connection that already carries a `CampaignState` which only grows.
 * A client fetches it once at join and caches it for the campaign.
 *
 * It is also the one contract in this file that both ends *parse*: every
 * other schema here is server-authored and only ever read by the client.
 * That is exactly what invariant 4 means by "schemas define everything
 * once" — defining the shape here, rather than a second hand-rolled copy on
 * the client, is what makes that parsing possible on both sides.
 */
export const EncounterCatalogue = z.object({
  encounterId: z.string(),
  combatants: z.array(CatalogueCombatant),
  actions: z.array(CatalogueAction),
  /**
   * Every player character in this encounter, fully derived. The client
   * renders these numbers and computes none of them: AC and attack bonuses
   * are game math, which invariant 1 keeps in the rules engine and invariant 5
   * keeps out of `apps/web`. Empty for a monster-only encounter.
   */
  characters: z.array(DerivedCharacter).default([]),
});

export type EncounterCatalogue = z.infer<typeof EncounterCatalogue>;

/**
 * The response body of `POST /campaigns`. Like `EncounterCatalogue`, this is
 * a contract both ends read from one definition: the server constructs the
 * value from typed data, and the client parses the JSON it receives rather
 * than casting it.
 */
export const CampaignCreated = z.object({ campaignId: z.string() });

export type CampaignCreated = z.infer<typeof CampaignCreated>;

export const ServerFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("campaign_state"),
    sequence: z.number().int().min(0),
    snapshot: CampaignState,
  }),
  z.object({ type: z.literal("event"), event: GameEvent }),
  /**
   * Transient, deliberately outside the event sequence. The log gets one
   * `narrative_emitted` event with the full text on completion; a client that
   * reconnects mid-stream reconciles against that event rather than seeing a
   * gap.
   */
  z.object({ type: z.literal("narrative_token"), streamId: z.string(), text: z.string() }),
  /**
   * Pushed at the two points the pipeline knows the player is up: a `join`
   * that lands on their turn, and the end of a turn that returns control to
   * them. Not a request/response — the client never asks for these.
   */
  TurnAffordances.extend({
    type: z.literal("turn_affordances"),
    /**
     * The projection these were computed from. The client discards a frame
     * older than the state it currently holds, so an affordance set cannot
     * be applied to a board that has already moved past it.
     */
    forSequence: z.number().int().min(0),
  }),
  /**
   * The out-of-combat twin of `turn_affordances`, and the answer to the
   * question a scene could not previously answer: what can I actually do
   * here? Combat has always shown its options — a board, a turn order, an
   * action bar — while a scene showed a paragraph of Hebrew and an empty
   * text box, with the node's edges reachable only by guessing the phrasing
   * that the router would read as `exploration`. A player had no way to
   * learn that `arrival`'s two edges are both conversations.
   *
   * Pushed at the same points `turn_affordances` is, from the same
   * `playerAffordances()` call: exactly one of the two frames is emitted per
   * turn, whichever matches the mode the campaign is in.
   *
   * Labels are Hebrew because this frame is read by a person, not a model —
   * the one direction invariant 2 sanctions. `labelEnglish` stays on the
   * content and keeps going to the router.
   */
  z.object({
    type: z.literal("scene_affordances"),
    /** The node the player is standing in, for the client to key renders on. */
    nodeId: ContentId,
    edges: z.array(
      z.object({
        to: ContentId,
        labelHebrew: z.string().min(1),
        /**
         * Closed edges are sent, not filtered. The player learns the arc has
         * somewhere else to go and that they cannot go there yet, which is
         * strictly more information than an edge that silently does not
         * exist. The client renders these disabled.
         */
        open: z.boolean(),
      }),
    ),
    /**
     * The closing beat is available: this node is terminal (no edges) and has
     * not been completed yet, so `completeCurrentNode` is a legal move.
     *
     * Server-computed rather than inferred client-side from `edges.length`,
     * even though the client holds `completedNodeIds` and could: which
     * transitions are legal is the engine's judgment (invariant 1), and a
     * client that re-derives the rule is a second implementation to keep in
     * step. The end of an arc is also the one place where guessing wrong is
     * unrecoverable — it is the difference between "press this to finish" and
     * "this story is over".
     */
    canConclude: z.boolean(),
    /** Same contract as `turn_affordances.forSequence` — see its comment. */
    forSequence: z.number().int().min(0),
  }),
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
