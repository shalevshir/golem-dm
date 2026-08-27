// The authored half of §4.7's world: static lore a human edits by hand and a
// loader validates on read. It is NOT a projection of the event log.
//
// Three neighbours are easy to confuse with this file, so all three are named
// here once:
//   - `world.ts` in this package is the COMBAT grid — `GridMap`, `Combatant`,
//     and a `Faction` enum (`party | hostile | neutral`) that is a targeting
//     concept sharing nothing with a campaign faction but the word.
//   - `packages/memory/src/world-state.ts` is the EARNED half: mutable world
//     state projected from the log (§4.7). Still `export {}`.
//   - This file is the AUTHORED half: content under `data/world/`, loaded by
//     `apps/server/src/world/`.
//
// Nothing here may import a Node built-in — `apps/web` bundles this package.
import { z } from "zod";
import { GrammaticalGender } from "./character.js";

/**
 * Every id in authored content. A slug, never prose.
 *
 * §4.7's load-bearing rule for this content is that events reference lore by
 * stable id and never by embedded text, so editing a lore file cannot
 * retroactively invalidate a replay. No event carries one of these yet, so
 * nothing can enforce that at the event boundary today. What this regex
 * enforces is the half available now: a field that refuses "The Ashen Guild"
 * cannot quietly become the thing a narrator wrote, and is therefore safe to
 * persist in a payload forever.
 *
 * Both separators are allowed because both are already in use — `data/srd/`
 * files are `goblin_warrior`, encounters are `goblin-ambush` — and a rule this
 * module cannot retrofit onto those should not pretend to.
 */
export const ContentId = z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

/**
 * Faction standing, coarse and named (§4.7). The order IS the scale:
 * `FACTION_BANDS.indexOf(band) - 3` is the -3..+3 scalar, so there is one
 * table rather than two that can disagree.
 *
 * Named rather than numeric because a model reads a band name far more
 * reliably than a number, and because a coarse bucket is much easier to
 * assert on than a score.
 *
 * No arithmetic ships here. Shifting a band is clamped evaluation and belongs
 * to §4.7's step 3 scene engine; a helper written now would have no caller.
 */
export const FACTION_BANDS = [
  "war",
  "hostile",
  "cold",
  "neutral",
  "cordial",
  "friendly",
  "allied",
] as const;

export const FactionBand = z.enum(FACTION_BANDS);

export const LocationDefinition = z.object({
  locationId: ContentId,
  nameEnglish: z.string().min(1),
  nameHebrew: z.string().min(1),
  descriptionEnglish: z.string().min(1),
});

export const FactionDefinition = z.object({
  factionId: ContentId,
  nameEnglish: z.string().min(1),
  nameHebrew: z.string().min(1),
  descriptionEnglish: z.string().min(1),
});

export const NpcDefinition = z.object({
  npcId: ContentId,
  nameEnglish: z.string().min(1),
  nameHebrew: z.string().min(1),
  /**
   * Hebrew narration is gendered, so a narrator that does not know an NPC's
   * gender conjugates wrong — the reason `MonsterStatBlock` carries this
   * field (`srd.ts:64`). Locations and factions do not: a town is narrated
   * about, not conjugated around, and the field would have no consumer.
   */
  grammaticalGender: GrammaticalGender,
  locationId: ContentId,
  /** Absent for an unaligned NPC — the normal case in a world with two factions. */
  factionId: ContentId.optional(),
  descriptionEnglish: z.string().min(1),
});

/**
 * A gate over world state, checked when entering a quest node. Two kinds,
 * because two is what a five-node arc needs; a third is a one-line addition
 * when a node needs a gate the arc's own history cannot express.
 */
export const WorldPredicate = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node_completed"), nodeId: ContentId }),
  z.object({
    kind: z.literal("faction_band_at_least"),
    factionA: ContentId,
    factionB: ContentId,
    band: FactionBand,
  }),
]);

/**
 * A world change declared as data and applied by the step 3 engine — never by
 * a model, which is what keeps invariant 1 intact one level above combat.
 *
 * There is no effect that writes regional danger. §4.7: regional danger is
 * derived from faction relations and quest progress, never stored, because
 * derived state cannot drift.
 */
export const WorldEffect = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shift_faction_relation"),
    factionA: ContentId,
    factionB: ContentId,
    /** Bands, not points. Clamping to the -3..+3 ends is the step 3 engine's job. */
    delta: z.number().int().min(-6).max(6),
  }),
  z.object({ kind: z.literal("advance_calendar"), days: z.number().int().min(1) }),
]);

/** A destination and a label. Predicates gate the target node, not the edge. */
export const QuestEdge = z.object({
  to: ContentId,
  /** What the choice looks like to the router. English; the narrator translates. */
  labelEnglish: z.string().min(1),
});

export const QuestNode = z.object({
  nodeId: ContentId,
  titleEnglish: z.string().min(1),
  /** The scene card, English only — matching `EncounterDefinition.sceneEnglish`. */
  sceneEnglish: z.string().min(1),
  locationId: ContentId,
  /**
   * Checked when entering this node. Predicates gate the NODE rather than the
   * edge: traversing an edge is entering its target, so this is one place to
   * look instead of two sets of bookkeeping that can disagree.
   */
  preconditions: z.array(WorldPredicate).default([]),
  /** Applied on completion, by the step 3 engine. */
  effects: z.array(WorldEffect).default([]),
  /** Empty for a terminal node — node five of a five-node arc ends it. */
  edges: z.array(QuestEdge).default([]),
});

export const FactionRelationEntry = z.object({
  factionA: ContentId,
  factionB: ContentId,
  band: FactionBand,
});

export const WorldManifest = z.object({
  worldId: ContentId,
  /**
   * A bare day counter. Time moves only through a declared `advance_calendar`
   * effect and never through a wall-clock read — that read is what makes a
   * replay diverge, the failure the `timestamp`-as-`text` decision already
   * guards against (§4.6). No months, no seasons: authoring surface with no
   * consumer.
   */
  startingDay: z.number().int().min(1),
  startingNodeId: ContentId,
  /**
   * Every unordered pair of distinct factions, exactly once. The loader
   * refuses a missing or duplicated pair, so "what is the standing between X
   * and Y" is always answerable from the file with no default rule to invent.
   * Trivial at two factions and untenable somewhere around eight, at which
   * point an undeclared pair should default to `neutral` and that check should
   * become a warning.
   */
  factionRelations: z.array(FactionRelationEntry),
});

export type ContentId = z.infer<typeof ContentId>;
export type FactionBand = z.infer<typeof FactionBand>;
export type LocationDefinition = z.infer<typeof LocationDefinition>;
export type FactionDefinition = z.infer<typeof FactionDefinition>;
export type NpcDefinition = z.infer<typeof NpcDefinition>;
export type WorldPredicate = z.infer<typeof WorldPredicate>;
export type WorldEffect = z.infer<typeof WorldEffect>;
export type QuestEdge = z.infer<typeof QuestEdge>;
export type QuestNode = z.infer<typeof QuestNode>;
export type FactionRelationEntry = z.infer<typeof FactionRelationEntry>;
export type WorldManifest = z.infer<typeof WorldManifest>;
