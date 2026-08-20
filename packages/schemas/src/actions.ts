import { z } from "zod";

export const Tile = z.tuple([z.number().int(), z.number().int()]);
export type Tile = z.infer<typeof Tile>;

export const ActionType = z.enum([
  "attack", "cast_spell", "dash", "disengage", "dodge",
  "help", "hide", "ready", "shove", "grapple", "use_object",
]);

export const PathType = z.enum(["direct", "flank", "retreat_to_cover"]);
export type PathType = z.infer<typeof PathType>;

/**
 * The `pathType` to write when a movement segment is being built and nothing
 * more specific is being expressed: the rules-engine affordance probe
 * (`combat/affordances.ts`), the web client's `turn/build-turn.ts`, and the
 * simulator's policy all mean "just go there".
 *
 * Deliberately NOT claimed as a correctness guarantee. Nothing reads the
 * field today — `validate-turn.ts` ignores it entirely, so the affordance
 * property ("a tile the client draws is a tile the validator accepted") does
 * not depend on the writers agreeing. The value of naming it is that the day
 * something DOES read it, the sites that must move together are already one
 * definition instead of three literals to find.
 */
export const DEFAULT_PATH_TYPE: PathType = "direct";

/**
 * Tactical turn proposed by the LLM tactical agent.
 * The rules engine VALIDATES this; illegal proposals are rejected with a
 * machine-readable reason and the agent retries once (see @ai-dm/agents).
 */
export const ExecuteTurn = z.object({
  actorId: z.string(),
  /** Ordered segments allow move–attack–move. */
  movement: z.array(z.object({ destinationTile: Tile, pathType: PathType })).optional(),
  mainAction: z.object({
    actionType: ActionType,
    actionId: z.string().optional(),
    /** Spell slot level when actionType is cast_spell. */
    slotLevel: z.number().int().min(1).max(9).optional(),
    targetIds: z.array(z.string()).optional(),
    targetTile: Tile.optional(),
  }),
  /** Multiattack: additional attacks granted by the actor's stat block. */
  extraAttacks: z.array(z.object({ actionId: z.string(), targetId: z.string() })).optional(),
  bonusAction: z.object({ abilityId: z.string(), targetId: z.string().optional() }).optional(),
  tacticalRationaleEnglish: z.string(),
});

export type ExecuteTurn = z.infer<typeof ExecuteTurn>;
