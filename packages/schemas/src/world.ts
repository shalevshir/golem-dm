import { z } from "zod";
import { Tile } from "./actions.js";
import { ActiveCondition, SpellSlots } from "./character.js";

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

export const Faction = z.enum(["party", "hostile", "neutral"]);

/**
 * SRD 5.2.1 Creature Size and Space. Order matters — the rule for moving
 * through another creature's space is stated in size categories apart.
 */
export const CreatureSize = z.enum(["tiny", "small", "medium", "large", "huge", "gargantuan"]);

/**
 * What the creature has already spent during the current turn. The rules engine
 * resets this at the start of a turn and rejects any `ExecuteTurn` that would
 * overspend it — this object is the whole action-economy budget.
 */
export const ActionEconomy = z.object({
  actionUsed: z.boolean().default(false),
  bonusActionUsed: z.boolean().default(false),
  /** Reactions refresh at the start of the creature's own turn. */
  reactionUsed: z.boolean().default(false),
  movementUsedFeet: z.number().int().min(0).default(0),
  /** Attacks already made under the current Attack action. */
  attacksMade: z.number().int().min(0).default(0),
});

/**
 * A creature taking part in an encounter — the positional and action-economy
 * view the rules engine needs to validate a proposed turn. A player character
 * additionally has a `CharacterSheet`; this is the combat projection of it.
 */
export const Combatant = z.object({
  combatantId: z.string(),
  /** Present when this combatant is driven by a `CharacterSheet`. */
  characterId: z.string().optional(),
  faction: Faction,
  /**
   * Anchor tile. Creatures larger than Medium occupy several squares in the
   * SRD; footprints are not modelled yet, so every combatant holds one tile.
   */
  position: Tile,
  size: CreatureSize.default("medium"),
  speedFeet: z.number().int().min(0).multipleOf(5),
  /** Melee reach. Most creatures 5 ft; large or reach weapons 10 ft. */
  reachFeet: z.number().int().min(0).multipleOf(5).default(5),
  maxHp: z.number().int().min(1),
  currentHp: z.number().int().min(0),
  tempHp: z.number().int().min(0).default(0),
  armorClass: z.number().int(),
  conditions: z.array(ActiveCondition).default([]),
  /**
   * 2024 unified exhaustion track (ADR-0001). Authoritative over a bare
   * `exhaustion` entry in `conditions`, which carries no level.
   */
  exhaustionLevel: z.number().int().min(0).max(6).default(0),
  /** Attacks a single Attack action grants (Extra Attack / Multiattack). */
  attacksPerAction: z.number().int().min(1).default(1),
  spellSlots: SpellSlots.default({}),
  actionEconomy: ActionEconomy.default({}),
  status: EntityStatus.default("alive"),
});

export type GridMap = z.infer<typeof GridMap>;
export type EntityStatus = z.infer<typeof EntityStatus>;
export type TerrainType = z.infer<typeof TerrainType>;
export type FactionRelation = z.infer<typeof FactionRelation>;
export type Faction = z.infer<typeof Faction>;
export type CreatureSize = z.infer<typeof CreatureSize>;
export type ActionEconomy = z.infer<typeof ActionEconomy>;
export type Combatant = z.infer<typeof Combatant>;
