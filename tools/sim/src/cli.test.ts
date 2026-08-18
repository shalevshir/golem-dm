import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("defaults to a smoke run over every scenario", () => {
    const config = parseArgs([]);

    expect(config.live).toBe(false);
    expect(config.mode).toBe("both");
    expect(config.scenarioIds.length).toBe(4);
  });

  it("opts into live only when --live is given", () => {
    expect(parseArgs(["--live"]).live).toBe(true);
  });

  it("reads a mode", () => {
    expect(parseArgs(["--mode", "probe"]).mode).toBe("probe");
  });

  it("rejects an unknown mode rather than silently defaulting", () => {
    expect(() => parseArgs(["--mode", "sideways"])).toThrow("sideways");
  });

  it("parses comma-separated seeds and scenarios", () => {
    const config = parseArgs(["--seeds", "3,4", "--scenarios", "melee-brawl,ogre-charge"]);

    expect(config.seeds).toEqual([3, 4]);
    expect(config.scenarioIds).toEqual(["melee-brawl", "ogre-charge"]);
  });

  it("rejects an unknown scenario", () => {
    expect(() => parseArgs(["--scenarios", "not-a-scenario"])).toThrow("not-a-scenario");
  });

  it("rejects a non-numeric seed rather than running on NaN", () => {
    expect(() => parseArgs(["--seeds", "one"])).toThrow("one");
  });

  it("selects arms by id and rejects unknown ones, when live", () => {
    expect(parseArgs(["--live", "--arms", "gemini-3.1-flash-lite@low"]).arms[0]?.armId).toBe(
      "gemini-3.1-flash-lite@low",
    );
    expect(() => parseArgs(["--live", "--arms", "nope@low"])).toThrow("nope@low");
  });

  it("rejects --arms outside live mode instead of silently ignoring it", () => {
    expect(() => parseArgs(["--arms", "gemini-3.1-flash-lite@low"])).toThrow("--live");
  });

  it("resolves the smoke arm's own id through --arms, when live", () => {
    // `SMOKE_ARM` is not in `ARMS` — `armById` special-cases its id so
    // `--arms scripted-fake@medium` behaves like any other known arm instead
    // of throwing a "known:" list that omits the one arm every smoke run
    // actually exercises.
    expect(parseArgs(["--live", "--arms", "scripted-fake@medium"]).arms[0]?.armId).toBe(
      "scripted-fake@medium",
    );
  });

  it("rejects an unknown flag rather than silently running the default matrix", () => {
    expect(() => parseArgs(["--scenario", "melee-brawl"])).toThrow("--scenario");
    expect(() => parseArgs(["--seed", "42"])).toThrow("--seed");
  });
});
