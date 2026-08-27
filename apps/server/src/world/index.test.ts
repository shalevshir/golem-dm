import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir } from "../encounters/srd.js";
import { loadWorld, pairKey } from "./index.js";

describe("loadWorld", () => {
  // This is the only test that exercises the walk-up for `data/world`: if
  // `dataDir` could not find it above this file (e.g. because it stopped one
  // directory too early after a `dist/` layout change), this load would fail
  // with "Could not find data/world above this file" rather than returning a
  // parsed world.
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

  it("throws ENOENT for a directory with no world in it", () => {
    expect(() => loadWorld(join(dataDir(join("data", "world")), "nope"))).toThrow(/ENOENT/);
  });
});
