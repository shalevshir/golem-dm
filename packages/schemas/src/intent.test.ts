import { describe, expect, it } from "vitest";
import { CheckDifficulty, IntentClassification } from "./index.js";

describe("CheckDifficulty", () => {
  it.each(["very_easy", "easy", "medium", "hard", "very_hard", "nearly_impossible"])(
    "accepts %s",
    (difficulty) => {
      expect(CheckDifficulty.safeParse(difficulty).success).toBe(true);
    },
  );

  it("rejects an unknown difficulty", () => {
    expect(CheckDifficulty.safeParse("impossible").success).toBe(false);
  });
});

describe("IntentClassification", () => {
  it("parses an exploration classification with a target node", () => {
    const result = IntentClassification.parse({
      category: "exploration",
      targetNodeId: "goblin-camp",
    });
    expect(result).toStrictEqual({ category: "exploration", targetNodeId: "goblin-camp" });
  });

  it("parses an exploration classification with a null target node", () => {
    const result = IntentClassification.parse({ category: "exploration", targetNodeId: null });
    expect(result.category).toBe("exploration");
  });

  it("parses a check classification with a skill", () => {
    const result = IntentClassification.parse({
      category: "check",
      ability: "dex",
      skill: "stealth",
      difficulty: "medium",
    });
    expect(result).toStrictEqual({
      category: "check",
      ability: "dex",
      skill: "stealth",
      difficulty: "medium",
    });
  });

  it("parses a check classification without a skill", () => {
    const result = IntentClassification.parse({
      category: "check",
      ability: "str",
      difficulty: "hard",
    });
    expect(result.category).toBe("check");
  });

  it("parses a social classification", () => {
    expect(IntentClassification.parse({ category: "social" })).toStrictEqual({
      category: "social",
    });
  });

  it("parses a combat classification", () => {
    expect(IntentClassification.parse({ category: "combat" })).toStrictEqual({
      category: "combat",
    });
  });

  it("parses an ooc classification", () => {
    expect(IntentClassification.parse({ category: "ooc" })).toStrictEqual({ category: "ooc" });
  });

  it("rejects a check without a difficulty", () => {
    const result = IntentClassification.safeParse({ category: "check", ability: "dex" });
    expect(result.success).toBe(false);
  });

  it("rejects a check whose skill is not a real skill", () => {
    const result = IntentClassification.safeParse({
      category: "check",
      ability: "dex",
      skill: "banana",
      difficulty: "medium",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown category", () => {
    const result = IntentClassification.safeParse({ category: "shopping" });
    expect(result.success).toBe(false);
  });
});
