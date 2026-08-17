// A compact structured projection of the combat state, for the dynamic prompt
// tier. Not dialogue history (`packages/agents/CLAUDE.md`) — a model reasons
// about a board better from the board than from a transcript of it.
import type { CombatWorld } from "@ai-dm/rules-engine";
import { footprintDistanceFeet } from "@ai-dm/rules-engine";
import type {
  ActionEconomy,
  ActiveCondition,
  Combatant,
  CreatureSize,
  EntityStatus,
  Faction,
  GridMap,
  SpellSlots,
  TerrainType,
  Tile,
} from "@ai-dm/schemas";

/**
 * An action the actor may take, as the caller supplies it. Deliberately carries
 * no range: the validator resolves range from `CombatWorld.actionRangesFeet`
 * and never reads anything the caller passes here, so a `rangeFeet` on the input
 * would be a second source of truth that the model believes and the engine
 * ignores. `CardAction.rangeFeet` is derived from the world instead.
 */
export interface AvailableAction {
  actionId: string;
  name: string;
}

/** An action as the model reads it, with the range the validator will enforce. */
export interface CardAction extends AvailableAction {
  rangeFeet: number;
}

export interface SnapshotCombatant {
  combatantId: string;
  faction: Faction;
  position: Tile;
  size: CreatureSize;
  currentHp: number;
  maxHp: number;
  armorClass: number;
  /** Reused from `@ai-dm/schemas` rather than flattened to names: a duration is
   *  tactically relevant, and a parallel shape would violate invariant 4. */
  conditions: readonly ActiveCondition[];
  exhaustionLevel: number;
  /**
   * Actor-to-target, computed with the same function the validator uses.
   * Absent on the actor itself. This is the single most valuable field here:
   * out-of-reach proposals are the commonest legality failure a model makes,
   * and they come from asking it to do Chebyshev arithmetic on coordinates.
   */
  distanceFeet?: number;
}

export interface SnapshotActor extends SnapshotCombatant {
  spellSlots: SpellSlots;
  actionEconomy: ActionEconomy;
}

export interface SnapshotTerrain {
  tile: Tile;
  terrain: TerrainType;
}

export interface CombatSnapshot {
  actor: SnapshotActor;
  others: readonly SnapshotCombatant[];
  grid: { width: number; height: number; terrain: readonly SnapshotTerrain[] };
  /** Supplied by the caller; `Combatant` models no rolled initiative. */
  turnOrder?: readonly string[];
}

export interface SnapshotInput {
  world: CombatWorld;
  actorId: string;
  turnOrder?: readonly string[];
}

/** What varies per creature rather than per turn — the semi-static tier. */
export interface CapabilityCard {
  combatantId: string;
  speedFeet: number;
  reachFeet: number;
  attacksPerAction: number;
  actions: readonly CardAction[];
}

/** A corpse is scenery and a fled creature has left the map; neither is a target. */
const VISIBLE_STATUSES: readonly EntityStatus[] = ["alive", "unconscious"];

function baseOf(source: Combatant): SnapshotCombatant {
  return {
    combatantId: source.combatantId,
    faction: source.faction,
    position: source.position,
    size: source.size,
    currentHp: source.currentHp,
    maxHp: source.maxHp,
    armorClass: source.armorClass,
    conditions: source.conditions,
    exhaustionLevel: source.exhaustionLevel,
  };
}

/**
 * `GridMap.tiles` is a full row-major matrix — a 20x20 map is 400 strings,
 * nearly all "normal". Emitting only the exceptions is lossless, because
 * "normal" is recoverable as the default.
 */
function sparseTerrain(grid: GridMap): SnapshotTerrain[] {
  const terrain: SnapshotTerrain[] = [];
  grid.tiles.forEach((row, y) => {
    row.forEach((type, x) => {
      if (type !== "normal") terrain.push({ tile: [x, y], terrain: type });
    });
  });
  return terrain;
}

export function buildSnapshot(input: SnapshotInput): CombatSnapshot {
  const { world, actorId } = input;
  const actor = world.combatants.find((each) => each.combatantId === actorId);
  // A caller that names an absent actor has a bug, not a runtime condition.
  if (actor === undefined) throw new Error(`No combatant ${actorId} in this encounter`);

  const actorSpace = { anchor: actor.position, size: actor.size };

  const others = world.combatants
    .filter((each) => each.combatantId !== actorId && VISIBLE_STATUSES.includes(each.status))
    .map((each) => ({
      ...baseOf(each),
      distanceFeet: footprintDistanceFeet(actorSpace, {
        anchor: each.position,
        size: each.size,
      }),
    }));

  return {
    actor: { ...baseOf(actor), spellSlots: actor.spellSlots, actionEconomy: actor.actionEconomy },
    others,
    grid: {
      width: world.grid.width,
      height: world.grid.height,
      terrain: sparseTerrain(world.grid),
    },
    // exactOptionalPropertyTypes: an absent key and an explicit undefined are
    // different types, and the test asserts absence.
    ...(input.turnOrder === undefined ? {} : { turnOrder: input.turnOrder }),
  };
}

/**
 * The rule `rangeFeetFor` applies in the validator
 * (`packages/rules-engine/src/combat/validate-turn.ts`), restated here because
 * the card has to promise the model exactly what the engine will enforce. A
 * disagreement is not a bad answer, it is a rejection loop the model cannot win.
 */
function rangeFeetFor(actor: Combatant, world: CombatWorld, actionId: string): number {
  return world.actionRangesFeet?.[actionId] ?? actor.reachFeet;
}

export function buildCapabilityCard(
  actor: Combatant,
  world: CombatWorld,
  actions: readonly AvailableAction[],
): CapabilityCard {
  return {
    combatantId: actor.combatantId,
    speedFeet: actor.speedFeet,
    reachFeet: actor.reachFeet,
    attacksPerAction: actor.attacksPerAction,
    actions: actions.map((action) => ({
      ...action,
      rangeFeet: rangeFeetFor(actor, world, action.actionId),
    })),
  };
}
