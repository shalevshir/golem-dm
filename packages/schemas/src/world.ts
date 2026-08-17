import { z } from "zod";

export const EntityStatus = z.enum(["alive", "dead", "unconscious", "fled"]);

export const TerrainType = z.enum(["normal", "difficult", "blocking", "half_cover", "three_quarters_cover"]);

export const GridMap = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  /** Row-major terrain matrix. */
  tiles: z.array(z.array(TerrainType)),
});

export const FactionRelation = z.object({
  factionId: z.string(),
  score: z.number().int().min(-100).max(100),
});

export type GridMap = z.infer<typeof GridMap>;
export type EntityStatus = z.infer<typeof EntityStatus>;
export type TerrainType = z.infer<typeof TerrainType>;
export type FactionRelation = z.infer<typeof FactionRelation>;
