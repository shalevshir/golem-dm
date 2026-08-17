// Grid, A* pathfinding, line of sight, cover.
// LoS algorithm is intentionally swappable (Bresenham for POC — documented
// house rule; RAW corner-to-corner may replace it later). See docs/decisions.
// Diagonal rule: PHB default 5 ft/diagonal (ADR-0003).
import type { GridMap, TerrainType, Tile } from "@ai-dm/schemas";
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

/** Cost to enter a tile, or null when it cannot be entered at all. */
export function movementCostFeet(terrain: TerrainType): number | null {
  switch (terrain) {
    case "normal":
      return FEET_PER_TILE;
    case "difficult":
      return FEET_PER_TILE * 2;
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

function neighbors(grid: GridMap, tile: Tile): Tile[] {
  const found: Tile[] = [];
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const next: Tile = [tile[0] + dx, tile[1] + dy];
    if (terrainAt(grid, next) === undefined) continue;
    if (cutsWallCorner(grid, tile, dx, dy)) continue;
    found.push(next);
  }
  return found;
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
 * A* over the grid. Diagonals cost the same as orthogonal steps (ADR-0003) and
 * difficult terrain costs double. Returns null when no route exists.
 */
export function findPath(grid: GridMap, start: Tile, goal: Tile): PathResult | null {
  const startTerrain = terrainAt(grid, start);
  const goalTerrain = terrainAt(grid, goal);
  if (startTerrain === undefined || goalTerrain === undefined) return null;
  if (start[0] === goal[0] && start[1] === goal[1]) {
    return { path: [[start[0], start[1]]], costFeet: 0 };
  }
  if (movementCostFeet(goalTerrain) === null) return null;

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

    for (const neighbor of neighbors(grid, current)) {
      const terrain = terrainAt(grid, neighbor);
      if (terrain === undefined) continue;
      const stepCost = movementCostFeet(terrain);
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

/** The strongest cover granted by any tile between the two endpoints. */
export function coverBetween(
  grid: GridMap,
  from: Tile,
  to: Tile,
  algorithm: LineOfSightAlgorithm = bresenhamLineOfSight,
): CoverLevel {
  let strongest: CoverLevel = "none";
  for (const tile of algorithm.tilesBetween(from, to)) {
    const terrain = terrainAt(grid, tile);
    if (terrain === undefined) continue;
    const cover = coverFromTerrain(terrain);
    if (COVER_RANK[cover] > COVER_RANK[strongest]) strongest = cover;
  }
  return strongest;
}
