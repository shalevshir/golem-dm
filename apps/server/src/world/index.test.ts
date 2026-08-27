import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir } from "../encounters/srd.js";
import { loadWorld, pairKey, WorldContentError } from "./index.js";

describe("loadWorld", () => {
  // A default parameter re-evaluates on every call, so every no-argument
  // `loadWorld()` below re-walks up for `data/world`, not just this one — but
  // this is the test that would name it: if `dataDir` could not find it above
  // this file (e.g. because it stopped one directory too early after a
  // `dist/` layout change), this load would fail with "Could not find
  // data/world above this file" rather than returning a parsed world.
  it("finds and parses the authored world", () => {
    const world = loadWorld();
    expect(world.worldId).toBe("emberfall");
    expect(world.startingDay).toBe(1);
    expect(world.startingNodeId).toBe("arrival");
  });

  it("indexes every collection by its own id", () => {
    const world = loadWorld();
    expect(world.factions.get("ashen-guild")?.nameEnglish).toBe("The Ashen Guild");
    expect(world.locations.get("emberfall")?.nameHebrew).toBe("אמברפול");
    expect(world.npcs.get("old-tobin")?.grammaticalGender).toBe("masculine");
    expect(world.questNodes.get("reckoning")?.edges).toEqual([]);
    expect(world.factions.size).toBe(2);
    expect(world.locations.size).toBe(1);
    expect(world.npcs.size).toBe(3);
    expect(world.questNodes.size).toBe(5);
  });

  // A relation is an unordered pair: `pairKey` sorts, so asking in either
  // order finds the one entry. Without this the manifest's argument order
  // would silently become part of the data.
  it("keys faction relations on an unordered pair", () => {
    const world = loadWorld();
    expect(world.relations.get(pairKey("ashen-guild", "river-wardens"))).toBe("cold");
    expect(world.relations.get(pairKey("river-wardens", "ashen-guild"))).toBe("cold");
    expect(world.relations.size).toBe(1);
  });

  it("returns the same cached instance on a second call", () => {
    expect(loadWorld()).toBe(loadWorld());
  });

  // Caching is keyed by directory, not global. Passing the default path
  // explicitly must hit the same entry the no-argument call created — and
  // Task 5 supplies the other half, where a DIFFERENT directory still throws
  // rather than being served this cached world.
  it("caches per directory, so an explicit path hits the same entry", () => {
    expect(loadWorld(dataDir(join("data", "world")))).toBe(loadWorld());
  });

  // The cache key is the RESOLVED directory, not the raw argument string —
  // otherwise a trailing slash or an embedded "." segment is a full reread
  // and re-parse for what is, on disk, the exact same directory.
  it("caches on the resolved directory, so different spellings of one path share an entry", () => {
    const dir = dataDir(join("data", "world"));
    const trailingSlash = `${dir}/`;
    const dotSegment = `${dirname(dir)}/./world`;
    expect(loadWorld(trailingSlash)).toBe(loadWorld(dir));
    expect(loadWorld(dotSegment)).toBe(loadWorld(dir));
  });

  it("throws ENOENT for a directory with no world in it", () => {
    expect(() => loadWorld(join(dataDir(join("data", "world")), "nope"))).toThrow(/ENOENT/);
  });
});

const BROKEN = join(dataDir(join("data", "world")), "fixtures", "broken-references");

/**
 * The problems `loadWorld` threw for `dir`, or a loud failure if it did not
 * throw at all.
 *
 * `expect.unreachable` runs OUTSIDE the try/catch on purpose. Called inside
 * it, its own AssertionError lands in the very same `catch` as the real
 * assertions and gets asserted against instead — the must-fix minor already
 * recorded at `apps/server/src/config.test.ts:36`. The `caught` flag is that
 * file's fix, stated once here so the twelve assertions below are one line
 * each.
 */
function problemsFrom(dir: string): readonly string[] {
  let caught: unknown;
  let threw = false;
  try {
    loadWorld(dir);
  } catch (error) {
    threw = true;
    caught = error;
  }
  if (!threw) expect.unreachable(`loadWorld(${dir}) should have thrown`);
  expect(caught).toBeInstanceOf(WorldContentError);
  return (caught as WorldContentError).problems;
}

describe("loadWorld refusing broken content", () => {
  // The strongest single statement that the checks below do not false-positive.
  it("accepts the real authored world", () => {
    expect(() => loadWorld()).not.toThrow();
  });

  it("throws a named, instanceof-able error", () => {
    expect(() => loadWorld(BROKEN)).toThrow(WorldContentError);
    expect(() => loadWorld(BROKEN)).toThrow(/Invalid world content/);
  });

  // One throw carrying every defect, not the first. Throwing at the first
  // dangling id would make an author fix these one reload at a time.
  it.each([
    'duplicate npc id "twin"',
    'world.json startingNodeId references unknown quest node "no-such-node"',
    'npc twin references unknown location "no-such-place"',
    'npc twin references unknown faction "no-such-faction"',
    'quest node start references unknown location "nowhere-at-all"',
    'quest node start edge references unknown quest node "no-such-node"',
    'quest node start precondition references unknown quest node "no-such-node"',
    'quest node start precondition references unknown faction "no-such-faction"',
    'quest node start effect references unknown faction "no-such-faction"',
    "quest node start precondition alpha/alpha relates a faction to itself",
    "quest node start effect alpha/alpha relates a faction to itself",
  ])("names: %s", (problem) => {
    expect(problemsFrom(BROKEN)).toContain(problem);
  });

  // A duplicate is dropped during indexing, so the surviving entry is the
  // FIRST one. Both twins carry a dangling locationId, and only the first
  // one's is reported — asserting the absence of the second's is what makes
  // this test fail if indexing ever started cross-referencing dropped
  // entries, or started keeping the last entry instead of the first.
  it("keeps the first of two entries sharing an id", () => {
    const problems = problemsFrom(BROKEN);
    expect(problems).toContain('npc twin references unknown location "no-such-place"');
    expect(problems).not.toContain(
      'npc twin references unknown location "also-no-such-place"',
    );
  });

  // Every file in the fixture parses cleanly — these are defects zod cannot
  // see, which is the whole reason the loader has to look. If this ever
  // throws a ZodError instead, the fixture has drifted into being malformed
  // and has stopped testing cross-referencing at all.
  it("throws for defects zod cannot see, not for a malformed file", () => {
    // `problemsFrom` asserts the error is a WorldContentError and not a
    // ZodError, which is the real claim: every file in the fixture parses
    // cleanly, so if this ever came back a ZodError the fixture would have
    // drifted into being malformed and stopped testing cross-referencing.
    expect(problemsFrom(BROKEN).length).toBeGreaterThan(0);
  });
});

describe("loadWorld refusing faction relations", () => {
  it.each([
    'duplicate faction relation for "beta" and "alpha"',
    'faction relation alpha/no-such-faction references unknown faction "no-such-faction"',
    "faction relation gamma/gamma relates a faction to itself",
    'no faction relation declared for "alpha" and "gamma"',
    'no faction relation declared for "beta" and "gamma"',
    'faction relation no-such-faction/beta references unknown faction "no-such-faction"',
  ])("names: %s", (problem) => {
    expect(problemsFrom(BROKEN)).toContain(problem);
  });

  // The complete set, so a check that starts reporting something extra —
  // or stops reporting something — fails here rather than passing quietly.
  it("reports exactly these seventeen problems and no others", () => {
    expect(new Set(problemsFrom(BROKEN))).toEqual(
      new Set([
        'duplicate npc id "twin"',
        'world.json startingNodeId references unknown quest node "no-such-node"',
        'npc twin references unknown location "no-such-place"',
        'npc twin references unknown faction "no-such-faction"',
        'quest node start references unknown location "nowhere-at-all"',
        'quest node start edge references unknown quest node "no-such-node"',
        'quest node start precondition references unknown quest node "no-such-node"',
        'quest node start precondition references unknown faction "no-such-faction"',
        'quest node start effect references unknown faction "no-such-faction"',
        "quest node start precondition alpha/alpha relates a faction to itself",
        "quest node start effect alpha/alpha relates a faction to itself",
        'duplicate faction relation for "beta" and "alpha"',
        'faction relation alpha/no-such-faction references unknown faction "no-such-faction"',
        "faction relation gamma/gamma relates a faction to itself",
        'no faction relation declared for "alpha" and "gamma"',
        'no faction relation declared for "beta" and "gamma"',
        'faction relation no-such-faction/beta references unknown faction "no-such-faction"',
      ]),
    );
  });
});
