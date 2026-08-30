import { describe, expect, it } from "vitest";
import { createDeterministicSceneSummary } from "./deterministic.js";

describe("createDeterministicSceneSummary", () => {
  it("assembles a summary from the engine's facts alone", async () => {
    const summary = await createDeterministicSceneSummary().summarize({
      kind: "encounter",
      contextEnglish: "A goblin ambush at the weir.",
      factsEnglish: ["Outcome: victory.", "Survivors: Maren."],
      recentNarrations: ["הגובלינים נסוגו."],
    });

    expect(summary).toBe("A goblin ambush at the weir. Outcome: victory. Survivors: Maren.");
  });

  it("never returns null — a row must always be writable", async () => {
    const summary = await createDeterministicSceneSummary().summarize({
      kind: "quest_node",
      contextEnglish: "The weir.",
      factsEnglish: [],
      recentNarrations: [],
    });

    expect(summary).toBe("The weir.");
  });

  it("never reads the Hebrew narrations — English state stays English", async () => {
    const summary = await createDeterministicSceneSummary().summarize({
      kind: "quest_node",
      contextEnglish: "The inn.",
      factsEnglish: ["Node completed: quiet-word."],
      recentNarrations: ["שלום לך, הולך רגל."],
    });

    expect(summary).not.toMatch(/[֐-׿]/);
  });
});
