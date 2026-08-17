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

  it("selects arms by id and rejects unknown ones", () => {
    expect(parseArgs(["--arms", "gemini-3-flash@low"]).arms[0]?.armId).toBe("gemini-3-flash@low");
    expect(() => parseArgs(["--arms", "nope@low"])).toThrow("nope@low");
  });
});
