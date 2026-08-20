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
 * The `pathType` every affordance probe and every client-built movement
 * segment uses when nothing more specific is being tested. Two packages
 * relied on the literal `"direct"` matching by coincidence (the rules-engine
 * probe in `combat/affordances.ts`, the web client's `turn/build-turn.ts`) —
 * the affordance guarantee ("a tile the client draws is a tile the validator
 * accepted") holds only because both agree. A shared constant makes that
 * agreement structural instead of a fact both sides had to independently get
 * right.
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
