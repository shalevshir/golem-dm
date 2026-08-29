import { describe, expect, it } from "vitest";
import { createDeterministicSceneNarrative } from "./scene-deterministic.js";
import type { SceneBeat, SceneNarrationInput } from "./scene-port.js";

const ELDAD = { playerNameHebrew: "אלדד", playerGender: "masculine" as const };
const RANGER = { playerNameHebrew: "רעות", playerGender: "feminine" as const };

const TERMINATORS = [".", "!", "?", "…"];

function input(
  actor: { playerNameHebrew: string; playerGender: "masculine" | "feminine" },
  beat: SceneBeat,
): SceneNarrationInput {
  return {
    beat,
    sceneEnglish: "A quiet market square.",
    playerNameHebrew: actor.playerNameHebrew,
    playerGender: actor.playerGender,
    npcNamesHebrew: [],
    recentNarrations: [],
  };
}

async function textOf(value: SceneNarrationInput): Promise<string> {
  let text = "";
  for await (const chunk of createDeterministicSceneNarrative().stream(value)) text += chunk;
  return text;
}

function endsComplete(text: string): boolean {
  return TERMINATORS.some((mark) => text.endsWith(mark));
}

describe("createDeterministicSceneNarrative", () => {
  it("names the location on arrival", async () => {
    const text = await textOf(
      input(ELDAD, { kind: "arrived", locationNameHebrew: "הכיכר" }),
    );
    expect(text).toContain("הכיכר");
    expect(endsComplete(text)).toBe(true);
  });

  it("agrees the arrival verb with a feminine subject", async () => {
    const text = await textOf(
      input(RANGER, { kind: "arrived", locationNameHebrew: "הכיכר" }),
    );
    expect(text).toBe("רעות מגיעה אל הכיכר.");
  });

  it("agrees the arrival verb with a masculine subject", async () => {
    const text = await textOf(
      input(ELDAD, { kind: "arrived", locationNameHebrew: "הכיכר" }),
    );
    expect(text).toBe("אלדד מגיע אל הכיכר.");
  });

  // Whole-branch review finding 2: concluding a terminal node in place is
  // NOT an arrival — it must get its own template, never reuse `arrives`.
  it("names the location on conclusion, without an arrival verb", async () => {
    const text = await textOf(input(ELDAD, { kind: "concluded", locationNameHebrew: "הכיכר" }));
    expect(text).toContain("הכיכר");
    expect(text).not.toContain("מגיע");
    expect(endsComplete(text)).toBe(true);
  });

  it("agrees the conclusion verb with a feminine subject", async () => {
    const text = await textOf(input(RANGER, { kind: "concluded", locationNameHebrew: "הכיכר" }));
    expect(text).toBe("רעות מסיימת את העניין ליד הכיכר.");
  });

  it("agrees the conclusion verb with a masculine subject", async () => {
    const text = await textOf(input(ELDAD, { kind: "concluded", locationNameHebrew: "הכיכר" }));
    expect(text).toBe("אלדד מסיים את העניין ליד הכיכר.");
  });

  it("renders a generic blocked-path line for a refusal, never echoing the English messages", async () => {
    const text = await textOf(
      input(ELDAD, { kind: "refused", messages: ["The door to the vault is locked from within."] }),
    );
    expect(text).not.toContain("vault");
    expect(text).not.toContain("locked");
    expect(endsComplete(text)).toBe(true);
    expect(text.length).toBeGreaterThan(0);
  });

  it("renders a success line for a passed check", async () => {
    const text = await textOf(input(ELDAD, { kind: "check", ability: "dex", success: true }));
    expect(text).toBe("אלדד מצליח בניסיון.");
  });

  it("renders a failure line for a failed check, agreeing with a feminine subject", async () => {
    const text = await textOf(input(RANGER, { kind: "check", ability: "wis", skill: "insight", success: false }));
    expect(text).toBe("רעות נכשלת בניסיון.");
  });

  it("says fighting is not possible here for a combat reply", async () => {
    const text = await textOf(input(ELDAD, { kind: "reply", category: "combat" }));
    expect(text).toContain("קרב");
    expect(endsComplete(text)).toBe(true);
  });

  it("renders a non-empty terminated line for a social reply", async () => {
    const text = await textOf(input(ELDAD, { kind: "reply", category: "social" }));
    expect(text.length).toBeGreaterThan(0);
    expect(endsComplete(text)).toBe(true);
  });

  it("renders a non-empty terminated line for an ooc reply", async () => {
    const text = await textOf(input(ELDAD, { kind: "reply", category: "ooc" }));
    expect(text.length).toBeGreaterThan(0);
    expect(endsComplete(text)).toBe(true);
  });

  it("never emits a digit", async () => {
    const text = await textOf(
      input(ELDAD, { kind: "arrived", locationNameHebrew: "הכיכר" }),
    );
    expect(text).not.toMatch(/[0-9]/);
  });

  it("leaves no trailing whitespace", async () => {
    const text = await textOf(input(ELDAD, { kind: "check", ability: "str", success: true }));
    expect(text).toBe(text.trimEnd());
  });
});
