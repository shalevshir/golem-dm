import { describe, expect, it } from "vitest";
import { loadMonster } from "./srd.js";

describe("loadMonster", () => {
  // This is the only test that exercises `monsterDir()`'s walk-up directly:
  // if it could not find `data/srd/monsters` above this file (e.g. because
  // it stopped one directory too early after a `dist/` layout change), this
  // load would fail with "Could not find data/srd/monsters above this file"
  // rather than returning parsed data.
  it("finds and parses a real SRD stat block", () => {
    const guard = loadMonster("guard");
    expect(guard.monsterId).toBe("guard");
    expect(guard.armorClass).toBe(16);
    expect(guard.hitPoints).toEqual({ average: 11, diceNotation: "2d8+2" });
  });

  it("returns the same cached instance on a second call", () => {
    expect(loadMonster("guard")).toBe(loadMonster("guard"));
  });

  it("throws ENOENT for a monsterId with no file", () => {
    expect(() => loadMonster("no-such-monster")).toThrow(/ENOENT/);
  });
});
