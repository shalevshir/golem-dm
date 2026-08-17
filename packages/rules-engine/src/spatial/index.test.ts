import { describe, expect, it } from "vitest";
import type { CreatureSize, GridMap, TerrainType, Tile } from "@ai-dm/schemas";
import {
  bresenhamLineOfSight,
  coverBetween,
  findPath,
  footprintDistanceFeet,
  footprintEdgeSquares,
  hasLineOfSight,
  occupiedTiles,
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
    // 40 ft, not 30: rounding the end of the wall costs two orthogonal steps
    // because the diagonals at (2,0)->(3,1) and (3,1)->(2,2) would each cut the
    // corner of a wall square, which SRD 5.2.1 forbids.
    expect(result?.costFeet).toBe(40);
    for (const [x, y] of result?.path ?? []) {
      expect(grid.tiles[y]?.[x]).not.toBe("blocking");
    }
  });

  it("cannot cut the corner of a wall diagonally", () => {
    // SRD 5.2.1, Combat/Grid: "Diagonal movement can't cross the corner of a
    // wall, a large tree, or another terrain feature that fills its space."
    const grid = parseGrid(`
      ..
      #.
    `);
    // (0,0) -> (1,1) would slip past the corner of the wall at (0,1).
    // The legal route is (0,0) -> (1,0) -> (1,1): two steps, 10 ft.
    const result = findPath(grid, [0, 0], [1, 1]);
    expect(result?.costFeet).toBe(10);
    expect(result?.path).toStrictEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it("still allows a diagonal when both flanking squares are open", () => {
    const grid = parseGrid(`
      ..
      ..
    `);
    expect(findPath(grid, [0, 0], [1, 1])?.costFeet).toBe(5);
  });

  // SRD 5.2.1, "Crawling": each foot of movement costs 1 extra foot, and
  // 2 extra feet in Difficult Terrain — so a crawled difficult square is 15 ft,
  // not the 20 ft that doubling an already-doubled cost would give.
  it("charges a crawling creature double on open ground", () => {
    const grid = parseGrid(`.....`);
    expect(findPath(grid, [0, 0], [3, 0], { crawling: true })?.costFeet).toBe(30);
  });

  it("charges a crawling creature triple in difficult terrain, not quadruple", () => {
    const grid = parseGrid(`~~~~~`);
    expect(findPath(grid, [0, 0], [1, 0], { crawling: true })?.costFeet).toBe(15);
  });

  it("leaves costs alone for a creature that is not crawling", () => {
    const grid = parseGrid(`.~...`);
    expect(findPath(grid, [0, 0], [1, 0], { crawling: false })?.costFeet).toBe(10);
  });

  // Occupancy is supplied by the caller — spatial knows nothing of factions or
  // conditions, only whether a tile is clear, hindered, or blocked.
  describe("occupancy", () => {
    const at =
      (blocked: Tile, verdict: "hindered" | "blocked") =>
      (tile: Tile): "clear" | "hindered" | "blocked" =>
        tile[0] === blocked[0] && tile[1] === blocked[1] ? verdict : "clear";

    it("routes around a blocked tile", () => {
      const grid = parseGrid(`
        .....
        .....
      `);
      const result = findPath(grid, [0, 0], [4, 0], { occupancy: at([2, 0], "blocked") });
      expect(result?.path).not.toContainEqual([2, 0]);
    });

    it("returns null when a blocked tile seals the only route", () => {
      const grid = parseGrid(`.....`);
      expect(findPath(grid, [0, 0], [4, 0], { occupancy: at([2, 0], "blocked") })).toBeNull();
    });

    it("charges a hindered tile as difficult terrain", () => {
      const grid = parseGrid(`.....`);
      const result = findPath(grid, [0, 0], [4, 0], { occupancy: at([2, 0], "hindered") });
      // 5 + 10 + 5 + 5
      expect(result?.costFeet).toBe(25);
    });

    // SRD: movement "costs 1 extra foot, even if multiple things in a space
    // count as Difficult Terrain" — a hindered difficult square is still 10 ft.
    it("does not stack a hindered tile with difficult terrain", () => {
      const grid = parseGrid(`..~..`);
      const result = findPath(grid, [0, 0], [4, 0], { occupancy: at([2, 0], "hindered") });
      expect(result?.costFeet).toBe(25);
    });

    it("charges a crawling creature 15 ft for a hindered square", () => {
      const grid = parseGrid(`...`);
      const result = findPath(grid, [0, 0], [1, 0], {
        crawling: true,
        occupancy: at([1, 0], "hindered"),
      });
      expect(result?.costFeet).toBe(15);
    });

    it("leaves costs untouched when no occupancy is supplied", () => {
      const grid = parseGrid(`.....`);
      expect(findPath(grid, [0, 0], [4, 0])?.costFeet).toBe(20);
    });
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

// SRD "Creature Size and Space": Large fills 4 squares (2x2), Huge 9 (3x3),
// Gargantuan 16 (4x4). The anchor is the north-west square of that space.
describe("footprints", () => {
  it.each<[CreatureSize, number]>([
    ["tiny", 1],
    ["small", 1],
    ["medium", 1],
    ["large", 2],
    ["huge", 3],
    ["gargantuan", 4],
  ])("%s spans %i square(s) per edge", (size, expected) => {
    expect(footprintEdgeSquares(size)).toBe(expected);
  });

  it("lists the four squares a Large creature fills", () => {
    expect(occupiedTiles({ anchor: [1, 1], size: "large" })).toStrictEqual([
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ]);
  });

  it("lists nine squares for a Huge creature", () => {
    expect(occupiedTiles({ anchor: [0, 0], size: "huge" })).toHaveLength(9);
  });

  describe("footprintDistanceFeet", () => {
    it("matches Chebyshev distance for two single-square creatures", () => {
      const a = { anchor: [0, 0] as Tile, size: "medium" as const };
      const b = { anchor: [3, 0] as Tile, size: "medium" as const };
      expect(footprintDistanceFeet(a, b)).toBe(tileDistanceFeet([0, 0], [3, 0]));
    });

    it("is 5 ft between adjacent single-square creatures", () => {
      expect(
        footprintDistanceFeet(
          { anchor: [0, 0], size: "medium" },
          { anchor: [1, 0], size: "medium" },
        ),
      ).toBe(5);
    });

    it("measures from the edge of a Large creature, not its anchor", () => {
      // Large fills [0,0]..[1,1], so [2,0] is adjacent to it.
      expect(
        footprintDistanceFeet({ anchor: [0, 0], size: "large" }, { anchor: [2, 0], size: "medium" }),
      ).toBe(5);
    });

    it("counts the gap beyond a Large creature's edge", () => {
      expect(
        footprintDistanceFeet({ anchor: [0, 0], size: "large" }, { anchor: [3, 0], size: "medium" }),
      ).toBe(10);
    });

    it("is zero for overlapping spaces", () => {
      expect(
        footprintDistanceFeet({ anchor: [0, 0], size: "huge" }, { anchor: [1, 1], size: "medium" }),
      ).toBe(0);
    });

    it("is symmetric", () => {
      const a = { anchor: [0, 0] as Tile, size: "large" as const };
      const b = { anchor: [4, 2] as Tile, size: "huge" as const };
      expect(footprintDistanceFeet(a, b)).toBe(footprintDistanceFeet(b, a));
    });
  });

  describe("findPath with a footprint", () => {
    // Row 2 leaves a single-square gap: wide enough for Medium, not for Large.
    const PINCH = parseGrid(`
      ......
      ......
      ##.###
      ......
      ......
    `);

    it("lets a Medium creature through a one-square gap", () => {
      expect(findPath(PINCH, [0, 0], [0, 3], { size: "medium" })).not.toBeNull();
    });

    it("refuses to squeeze a Large creature through a one-square gap", () => {
      expect(findPath(PINCH, [0, 0], [0, 3], { size: "large" })).toBeNull();
    });

    it("keeps the whole footprint on the grid", () => {
      const grid = parseGrid(`
        ...
        ...
        ...
      `);
      // A Large creature anchored at [2,2] would hang off the south-east edge.
      expect(findPath(grid, [0, 0], [2, 2], { size: "large" })).toBeNull();
      expect(findPath(grid, [0, 0], [1, 1], { size: "large" })).not.toBeNull();
    });

    it("charges difficult terrain when any square of the footprint is difficult", () => {
      const grid = parseGrid(`
        ....
        ...~
      `);
      // Entering anchor [2,0] puts the creature's corner on the difficult square.
      const result = findPath(grid, [0, 0], [2, 0], { size: "large" });
      expect(result?.costFeet).toBe(15);
    });

    it("defaults to a single square when no size is given", () => {
      expect(findPath(PINCH, [0, 0], [0, 3])).not.toBeNull();
    });
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
