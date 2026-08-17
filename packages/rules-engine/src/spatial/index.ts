// Grid, A* pathfinding, line of sight, cover.
// LoS algorithm is intentionally swappable (Bresenham for POC — documented
// house rule; RAW corner-to-corner may replace it later). See docs/decisions.
// Diagonal rule: PHB default 5 ft/diagonal (ADR-0003).
import type { CreatureSize, GridMap, TerrainType, Tile } from "@ai-dm/schemas";
import type { CoverLevel } from "../combat/index.js";

export const FEET_PER_TILE = 5;

export interface PathResult {
  /** Includes both the starting tile and the goal. */
  path: Tile[];
  costFeet: number;
}

/** Swappable line-tracing strategy — Bresenham is the POC house rule. */
export interface LineOfSightAlgorithm {
  readonly name: string;
  /** Tiles strictly between the two endpoints, in order. */
  tilesBetween(from: Tile, to: Tile): Tile[];
}

/** Orthogonal moves first so straight lines win cost ties over diagonals. */
const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const COVER_RANK: Record<CoverLevel, number> = {
  none: 0,
  half: 1,
  three_quarters: 2,
  full: 3,
};

/** A creature's space on the grid: `anchor` is its north-west square. */
export interface Footprint {
  anchor: Tile;
  size: CreatureSize;
}

/** SRD Creature Size and Space: Large fills 2x2, Huge 3x3, Gargantuan 4x4. */
export function footprintEdgeSquares(size: CreatureSize): number {
  switch (size) {
    // Tiny creatures share a square four to a square; modelled as one square.
    case "tiny":
    case "small":
    case "medium":
      return 1;
    case "large":
      return 2;
    case "huge":
      return 3;
    case "gargantuan":
      return 4;
  }
}

/** Every square the creature's space covers, in row-major order. */
export function occupiedTiles(footprint: Footprint): Tile[] {
  const edge = footprintEdgeSquares(footprint.size);
  const tiles: Tile[] = [];
  for (let dy = 0; dy < edge; dy += 1) {
    for (let dx = 0; dx < edge; dx += 1) {
      tiles.push([footprint.anchor[0] + dx, footprint.anchor[1] + dy]);
    }
  }
  return tiles;
}

/** Gap along one axis between two spans, in squares; 0 when they touch or overlap. */
function axisGap(aStart: number, aEdge: number, bStart: number, bEdge: number): number {
  return Math.max(0, aStart - (bStart + bEdge - 1), bStart - (aStart + aEdge - 1));
}

/**
 * SRD range on a grid: "count squares from a square adjacent to one of them and
 * stop in the other's space" — i.e. measure to the nearest square of each
 * space. Reduces to Chebyshev distance when both creatures fill one square.
 */
export function footprintDistanceFeet(a: Footprint, b: Footprint): number {
  const aEdge = footprintEdgeSquares(a.size);
  const bEdge = footprintEdgeSquares(b.size);
  return (
    Math.max(
      axisGap(a.anchor[0], aEdge, b.anchor[0], bEdge),
      axisGap(a.anchor[1], aEdge, b.anchor[1], bEdge),
    ) * FEET_PER_TILE
  );
}

/** The closest pair of squares between two spaces — where a line is traced from. */
export function nearestSquares(a: Footprint, b: Footprint): [Tile, Tile] {
  let best: [Tile, Tile] = [a.anchor, b.anchor];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const from of occupiedTiles(a)) {
    for (const to of occupiedTiles(b)) {
      const distance = tileDistanceFeet(from, to);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [from, to];
      }
    }
  }
  return best;
}

/**
 * How a tile's occupant affects a creature moving through it. Whether an
 * occupant blocks or merely hinders depends on factions, conditions and
 * relative size — rules this module deliberately knows nothing about.
 */
export type TilePassability = "clear" | "hindered" | "blocked";

export type OccupancyLookup = (tile: Tile) => TilePassability;

export interface MovementOptions {
  /**
   * SRD 5.2.1 ("Crawling"): each foot of movement costs 1 extra foot, or
   * 2 extra feet in Difficult Terrain. Per 5 ft square that is 10 ft on open
   * ground and 15 ft in Difficult Terrain — note the latter is *not* twice the
   * ordinary difficult cost. Prone creatures crawl unless they stand up.
   */
  crawling?: boolean;
  /** Creatures standing in the way. Absent means an empty battlefield. */
  occupancy?: OccupancyLookup;
  /**
   * The mover's size. Its whole space must fit in every position it enters, so
   * a Large creature cannot pass through a one-square gap — 2024 has no
   * squeezing rule. Absent means a single square.
   */
  size?: CreatureSize;
}

/** Cost to enter a tile, or null when it cannot be entered at all. */
export function movementCostFeet(
  terrain: TerrainType,
  options: MovementOptions = {},
): number | null {
  const crawling = options.crawling === true;
  switch (terrain) {
    case "normal":
      return crawling ? FEET_PER_TILE * 2 : FEET_PER_TILE;
    case "difficult":
      return crawling ? FEET_PER_TILE * 3 : FEET_PER_TILE * 2;
    // Walls and cover-granting scenery are physical obstacles: you shoot over
    // them or around them, you do not walk through them.
    case "blocking":
    case "half_cover":
    case "three_quarters_cover":
      return null;
  }
}

export function coverFromTerrain(terrain: TerrainType): CoverLevel {
  switch (terrain) {
    case "normal":
    case "difficult":
      return "none";
    case "half_cover":
      return "half";
    case "three_quarters_cover":
      return "three_quarters";
    case "blocking":
      return "full";
  }
}

export function blocksLineOfSight(terrain: TerrainType): boolean {
  return terrain === "blocking";
}

/** ADR-0003: every step, diagonal included, is 5 ft — i.e. Chebyshev distance. */
export function tileDistanceFeet(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) * FEET_PER_TILE;
}

function terrainAt(grid: GridMap, tile: Tile): TerrainType | undefined {
  return grid.tiles[tile[1]]?.[tile[0]];
}

function key(tile: Tile): string {
  return `${String(tile[0])},${String(tile[1])}`;
}

/**
 * SRD 5.2.1 (Combat, "Squares"): "Diagonal movement can't cross the corner of a
 * wall, a large tree, or another terrain feature that fills its space." A square
 * counts as filling its space when it blocks line of sight — cover-granting
 * scenery is low enough to move diagonally past.
 */
function cutsWallCorner(grid: GridMap, tile: Tile, dx: number, dy: number): boolean {
  if (dx === 0 || dy === 0) return false;
  const flanks: Tile[] = [
    [tile[0] + dx, tile[1]],
    [tile[0], tile[1] + dy],
  ];
  return flanks.some((flank) => {
    const terrain = terrainAt(grid, flank);
    return terrain !== undefined && blocksLineOfSight(terrain);
  });
}

function spaceAt(anchor: Tile, options: MovementOptions): Tile[] {
  return occupiedTiles({ anchor, size: options.size ?? "medium" });
}

function neighbors(grid: GridMap, tile: Tile, options: MovementOptions): Tile[] {
  const found: Tile[] = [];
  const space = spaceAt(tile, options);
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const next: Tile = [tile[0] + dx, tile[1] + dy];
    if (terrainAt(grid, next) === undefined) continue;
    // No part of the creature's body may cut a wall corner.
    if (space.some((part) => cutsWallCorner(grid, part, dx, dy))) continue;
    found.push(next);
  }
  return found;
}

/**
 * Cost of moving the mover's whole space so that it is anchored at `anchor`, or
 * null when it cannot stand there — any square off the grid, impassable, or
 * blocked by a creature rules the position out. Difficult Terrain never stacks,
 * so one difficult or hindered square makes the whole step difficult.
 */
function stepCostFeet(grid: GridMap, anchor: Tile, options: MovementOptions): number | null {
  let difficult = false;
  for (const tile of spaceAt(anchor, options)) {
    const terrain = terrainAt(grid, tile);
    if (terrain === undefined) return null;
    if (movementCostFeet(terrain, options) === null) return null;

    const passability = options.occupancy?.(tile) ?? "clear";
    if (passability === "blocked") return null;
    if (terrain === "difficult" || passability === "hindered") difficult = true;
  }
  return movementCostFeet(difficult ? "difficult" : "normal", options);
}

function reconstruct(cameFrom: Map<string, Tile>, goal: Tile, costFeet: number): PathResult {
  const path: Tile[] = [goal];
  let cursor = goal;
  for (;;) {
    const previous = cameFrom.get(key(cursor));
    if (previous === undefined) break;
    path.unshift(previous);
    cursor = previous;
  }
  return { path, costFeet };
}

/**
 * A* over the grid, moving the creature's whole space (`options.size`).
 * Diagonals cost the same as orthogonal steps (ADR-0003), difficult terrain
 * costs double, and a crawling creature pays the surcharge in
 * `movementCostFeet`. Returns null when no route exists.
 */
export function findPath(
  grid: GridMap,
  start: Tile,
  goal: Tile,
  options: MovementOptions = {},
): PathResult | null {
  const startTerrain = terrainAt(grid, start);
  const goalTerrain = terrainAt(grid, goal);
  if (startTerrain === undefined || goalTerrain === undefined) return null;
  if (start[0] === goal[0] && start[1] === goal[1]) {
    return { path: [[start[0], start[1]]], costFeet: 0 };
  }
  if (stepCostFeet(grid, goal, options) === null) return null;

  const goalKey = key(goal);
  const open = new Map<string, Tile>([[key(start), start]]);
  const gScore = new Map<string, number>([[key(start), 0]]);
  const cameFrom = new Map<string, Tile>();

  while (open.size > 0) {
    let currentKey: string | undefined;
    let current: Tile | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const [candidateKey, candidate] of open) {
      const g = gScore.get(candidateKey) ?? Number.POSITIVE_INFINITY;
      const f = g + tileDistanceFeet(candidate, goal);
      if (f < bestScore) {
        bestScore = f;
        currentKey = candidateKey;
        current = candidate;
      }
    }

    if (currentKey === undefined || current === undefined) break;
    if (currentKey === goalKey) {
      return reconstruct(cameFrom, current, gScore.get(currentKey) ?? 0);
    }

    open.delete(currentKey);
    const currentG = gScore.get(currentKey) ?? Number.POSITIVE_INFINITY;

    for (const neighbor of neighbors(grid, current, options)) {
      const stepCost = stepCostFeet(grid, neighbor, options);
      if (stepCost === null) continue;

      const neighborKey = key(neighbor);
      const tentative = currentG + stepCost;
      if (tentative < (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentative);
        open.set(neighborKey, neighbor);
      }
    }
  }

  return null;
}

export const bresenhamLineOfSight: LineOfSightAlgorithm = {
  name: "bresenham-center-to-center",
  tilesBetween(from: Tile, to: Tile): Tile[] {
    const dx = Math.abs(to[0] - from[0]);
    const dy = Math.abs(to[1] - from[1]);
    const stepX = from[0] < to[0] ? 1 : -1;
    const stepY = from[1] < to[1] ? 1 : -1;

    let x = from[0];
    let y = from[1];
    let error = dx - dy;
    const points: Tile[] = [];

    for (;;) {
      points.push([x, y]);
      if (x === to[0] && y === to[1]) break;
      const doubled = 2 * error;
      if (doubled > -dy) {
        error -= dy;
        x += stepX;
      }
      if (doubled < dx) {
        error += dx;
        y += stepY;
      }
    }

    return points.slice(1, -1);
  },
};

export function hasLineOfSight(
  grid: GridMap,
  from: Tile,
  to: Tile,
  algorithm: LineOfSightAlgorithm = bresenhamLineOfSight,
): boolean {
  return !algorithm.tilesBetween(from, to).some((tile) => {
    const terrain = terrainAt(grid, tile);
    return terrain !== undefined && blocksLineOfSight(terrain);
  });
}

/**
 * Cover granted by a creature standing on a tile. Supplied by the caller, which
 * decides who counts — the attacker and the target never give the target cover.
 */
export type CreatureCoverLookup = (tile: Tile) => CoverLevel;

export interface CoverOptions {
  /**
   * Swappable per ADR-0003; defaults to the Bresenham house rule. Explicitly
   * `undefined` is allowed so callers can forward an optional field straight in.
   */
  algorithm?: LineOfSightAlgorithm | undefined;
  /** Absent means terrain is the only thing in the way. */
  creatureCover?: CreatureCoverLookup | undefined;
}

/**
 * The strongest cover granted by anything between the two endpoints.
 *
 * SRD: "If a target is behind multiple sources of cover, only the most
 * protective degree of cover applies; the degrees aren't added together."
 */
export function coverBetween(
  grid: GridMap,
  from: Tile,
  to: Tile,
  options: CoverOptions = {},
): CoverLevel {
  const algorithm = options.algorithm ?? bresenhamLineOfSight;
  let strongest: CoverLevel = "none";

  for (const tile of algorithm.tilesBetween(from, to)) {
    const terrain = terrainAt(grid, tile);
    if (terrain !== undefined) {
      const cover = coverFromTerrain(terrain);
      if (COVER_RANK[cover] > COVER_RANK[strongest]) strongest = cover;
    }

    const fromCreature = options.creatureCover?.(tile) ?? "none";
    if (COVER_RANK[fromCreature] > COVER_RANK[strongest]) strongest = fromCreature;
  }

  return strongest;
}
