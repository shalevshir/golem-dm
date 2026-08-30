// Episodic memory's shared surface. The dimension constant lives here rather
// than in either consumer because both need the same integer and this is
// their only common ancestor (invariant 5): `@ai-dm/agents` asks the model
// for vectors of this width, and `@ai-dm/memory` declares a fixed-width
// `vector(N)` column. A disagreement surfaces as an insert failure on a
// column width, which is the worst place to find it.
import { z } from "zod";

/**
 * `text-embedding-3-small`'s native width. Changing this is a migration plus
 * a full reindex — the index is rebuildable from the log by design, so that
 * is cheap, but it is not a no-op.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * One closed episode, as stored. The text is a projection of the log — the
 * `summaryEnglish` a closing event already carried — so this record holds no
 * fact the log does not, which is what keeps the vector table a rebuildable
 * index rather than a second source of truth (invariant 3).
 */
export const EpisodicMemory = z.object({
  campaignId: z.string(),
  /** The log sequence of the event whose payload carried this summary. */
  sequence: z.number().int().min(0),
  kind: z.enum(["encounter", "quest_node"]),
  /** The `encounterId` or `nodeId` the episode closed on. */
  refId: z.string(),
  /** English — internal game state, never shown to a player verbatim. */
  summaryEnglish: z.string().min(1),
  day: z.number().int().min(1),
});

export type EpisodicMemory = z.infer<typeof EpisodicMemory>;
