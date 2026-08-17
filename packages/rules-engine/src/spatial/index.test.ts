import { describe, expect, it } from "vitest";
import type { GridMap, TerrainType, Tile } from "@ai-dm/schemas";
import {
  bresenhamLineOfSight,
  coverBetween,
  findPath,
  hasLineOfSight,
  tileDistanceFeet,
} from "./index.js";

/**
 * Builds a grid from ASCII art so the fixtures stay readable.
 * `.` normal · `~` difficult · `#` blocking · `h` half cover · `q` three-quarters cover
 */
const LEGEND: Record<string, TerrainType | undefined> = {
  ".": "normal",
  "~": "difficult",
  "#": "blocking",
  h: "half_cover",
  q: "three_quarters_cover",
};

function parseGrid(art: string): GridMap {
  const rows = art
    .trim()
    .split("\n")
    .map((row) => row.trim());

  const tiles = rows.map((row) =>
    Array.from(row, (char) => {
      const terrain = LEGEND[char];
      if (terrain === undefined) throw new Error(`Unknown terrain char: ${char}`);
      return terrain;
    }),
  );

  return { width: tiles[0]?.length ?? 0, height: tiles.length, tiles };
}

describe("tileDistanceFeet", () => {
  it.each<[Tile, Tile, number]>([
    [[0, 0], [0, 0], 0],
    [[0, 0], [3, 0], 15],
    [[0, 0], [0, 3], 15],
    // ADR-0003: every diagonal costs 5 ft, so this is 3 steps, not 4.
    [[0, 0], [3, 3], 15],
    [[0, 0], [3, 1], 15],
    [[2, 2], [0, 0], 10],
  ])("%o to %o is %i ft", (a, b, expected) => {
    expect(tileDistanceFeet(a, b)).toBe(expected);
  });

  it("treats 30 ft of movement as 6 tiles", () => {
    expect(tileDistanceFeet([0, 0], [6, 0])).toBe(30);
  });
});

describe("findPath", () => {
  it("walks a straight line across open ground", () => {
    const grid = parseGrid(`
      .....
      .....
    `);
    const result = findPath(grid, [0, 0], [3, 0]);
    expect(result?.costFeet).toBe(15);
    expect(result?.path).toStrictEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
  });

  it("uses diagonals at 5 ft each", () => {
    const grid = parseGrid(`
      ...
      ...
      ...
    `);
    const result = findPath(grid, [0, 0], [2, 2]);
    expect(result?.costFeet).toBe(10);
    expect(result?.path).toHaveLength(3);
  });

  it("charges double for difficult terrain", () => {
    const grid = parseGrid(`.~~..`);
    // 10 + 10 + 5 + 5
    expect(findPath(grid, [0, 0], [4, 0])?.costFeet).toBe(30);
  });

  it("routes around blocking terrain", () => {
    const grid = parseGrid(`
      .....
      ###..
      .....
    `);
    const result = findPath(grid, [0, 0], [0, 2]);
    expect(result?.costFeet).toBe(30);
    for (const [x, y] of result?.path ?? []) {
      expect(grid.tiles[y]?.[x]).not.toBe("blocking");
    }
  });

  it("returns null when the goal is unreachable", () => {
    const grid = parseGrid(`
      ...
      ###
      ...
    `);
    expect(findPath(grid, [0, 0], [0, 2])).toBeNull();
  });

  it("returns null when the goal is itself impassable", () => {
    const grid = parseGrid(`.#.`);
    expect(findPath(grid, [0, 0], [1, 0])).toBeNull();
  });

  it("costs nothing to stand still", () => {
    const grid = parseGrid(`...`);
    expect(findPath(grid, [1, 0], [1, 0])?.costFeet).toBe(0);
  });

  it("never reports a path cheaper than the unobstructed distance", () => {
    const grid = parseGrid(`
      .....
      .~#~.
      .....
    `);
    const start: Tile = [0, 0];
    const goal: Tile = [4, 2];
    const result = findPath(grid, start, goal);
    expect(result).not.toBeNull();
    expect(result?.costFeet).toBeGreaterThanOrEqual(tileDistanceFeet(start, goal));
  });
});

describe("bresenhamLineOfSight", () => {
  it("excludes both endpoints from the traced line", () => {
    expect(bresenhamLineOfSight.tilesBetween([0, 0], [3, 0])).toStrictEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it("returns nothing between adjacent tiles", () => {
    expect(bresenhamLineOfSight.tilesBetween([0, 0], [1, 0])).toStrictEqual([]);
  });
});

describe("hasLineOfSight", () => {
  it("sees across open ground", () => {
    const grid = parseGrid(`
      .....
      .....
    `);
    expect(hasLineOfSight(grid, [0, 0], [4, 0])).toBe(true);
  });

  it("is blocked by a wall", () => {
    const grid = parseGrid(`
      .....
      ..#..
      .....
    `);
    expect(hasLineOfSight(grid, [0, 1], [4, 1])).toBe(false);
  });

  it("sees over cover-granting terrain", () => {
    const grid = parseGrid(`
      .....
      ..h..
      .....
    `);
    expect(hasLineOfSight(grid, [0, 1], [4, 1])).toBe(true);
  });

  it("is symmetric", () => {
    const grid = parseGrid(`
      .....
      ..#..
      .....
    `);
    const pairs: [Tile, Tile][] = [
      [[0, 0], [4, 2]],
      [[0, 1], [4, 1]],
      [[1, 0], [3, 2]],
      [[0, 2], [4, 0]],
    ];
    for (const [a, b] of pairs) {
      expect(hasLineOfSight(grid, a, b)).toBe(hasLineOfSight(grid, b, a));
    }
  });
});

describe("coverBetween", () => {
  it("reports no cover across open ground", () => {
    const grid = parseGrid(`.....`);
    expect(coverBetween(grid, [0, 0], [4, 0])).toBe("none");
  });

  it("reports half cover", () => {
    const grid = parseGrid(`..h..`);
    expect(coverBetween(grid, [0, 0], [4, 0])).toBe("half");
  });

  it("reports three-quarters cover", () => {
    const grid = parseGrid(`..q..`);
    expect(coverBetween(grid, [0, 0], [4, 0])).toBe("three_quarters");
  });

  it("reports full cover behind a wall", () => {
    const grid = parseGrid(`..#..`);
    expect(coverBetween(grid, [0, 0], [4, 0])).toBe("full");
  });

  it("takes the strongest cover on the line", () => {
    const grid = parseGrid(`.hq..`);
    expect(coverBetween(grid, [0, 0], [4, 0])).toBe("three_quarters");
  });

  it("ignores cover on the endpoints themselves", () => {
    const grid = parseGrid(`h...h`);
    expect(coverBetween(grid, [0, 0], [4, 0])).toBe("none");
  });
});
