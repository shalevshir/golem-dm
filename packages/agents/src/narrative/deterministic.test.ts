import { describe, expect, it } from "vitest";
import { createDeterministicNarrative } from "./deterministic.js";
import type { NarrationBeat, NarrationInput } from "./port.js";

const ELDAD = { nameHebrew: "אלדד", gender: "masculine" as const, conditionsHebrew: [] };
const RANGER = { nameHebrew: "רעות", gender: "feminine" as const, conditionsHebrew: [] };
const GOBLIN = { nameHebrew: "גובלין לוחם", gender: "masculine" as const, conditionsHebrew: [] };
const WOLF_F = { nameHebrew: "זאבה", gender: "feminine" as const, conditionsHebrew: [] };

function input(actor: NarrationInput["actor"], beats: NarrationBeat[]): NarrationInput {
  return {
    actor,
    actorSide: "party",
    beats,
    pulse: { hostilesStanding: 1, heroBand: "healthy" },
    sceneEnglish: "A dry hillside track.",
    recentNarrations: [],
  };
}

async function textOf(value: NarrationInput): Promise<string> {
  let text = "";
  for await (const chunk of createDeterministicNarrative().stream(value)) text += chunk;
  return text;
}

async function chunksOf(value: NarrationInput): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of createDeterministicNarrative().stream(value)) chunks.push(chunk);
  return chunks;
}

describe("createDeterministicNarrative", () => {
  it("agrees the actor's verb with a masculine subject", async () => {
    expect(await textOf(input(ELDAD, [{ kind: "hold" }]))).toBe("אלדד עומד במקומו.");
  });

  it("agrees the actor's verb with a feminine subject", async () => {
    expect(await textOf(input(RANGER, [{ kind: "hold" }]))).toBe("רעות עומדת במקומה.");
  });

  it("agrees a falling target's verb with the TARGET's gender, not the actor's", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: WOLF_F, actionNameHebrew: "חרב ארוכה",
      outcome: "hit", severity: "felling", statusAfter: "dead",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד פוגע בזאבה. זאבה נופלת.");
  });

  it("says nothing about a target that is still standing", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה",
      outcome: "hit", severity: "graze", statusAfter: "alive",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד פוגע בגובלין לוחם.");
  });

  it("distinguishes falling unconscious from falling dead", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: RANGER, actionNameHebrew: "חרב מעוקלת",
      outcome: "hit", severity: "felling", statusAfter: "unconscious",
    };
    expect(await textOf(input(GOBLIN, [beat]))).toBe("גובלין לוחם פוגע ברעות. רעות מאבדת את הכרתה.");
  });

  it("narrates a miss without inventing a hit", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה",
      outcome: "miss", statusAfter: "alive",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד מחטיא את גובלין לוחם.");
  });

  it("marks a critical hit as one", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה",
      outcome: "critical_hit", severity: "severe", statusAfter: "alive",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד פוגע בגובלין לוחם פגיעה אנושה.");
  });

  it("narrates a non-attack action rather than calling it holding position", async () => {
    expect(await textOf(input(ELDAD, [{ kind: "other-action" }]))).toBe("אלדד נוקט פעולה.");
  });

  it("reports an action the engine could not resolve", async () => {
    expect(await textOf(input(ELDAD, [{ kind: "unresolved" }]))).toBe(
      "אלדד מנסה פעולה שהמנוע לא הצליח לפתור.",
    );
  });

  it("never emits a digit", async () => {
    const beats: NarrationBeat[] = [
      { kind: "move", feet: 25 },
      { kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "hit", severity: "solid", statusAfter: "alive" },
    ];
    expect(await textOf(input(ELDAD, beats))).not.toMatch(/[0-9]/);
  });

  it("puts movement before the swing and yields one chunk per sentence", async () => {
    const beats: NarrationBeat[] = [
      { kind: "move", feet: 10 },
      { kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "miss", statusAfter: "alive" },
    ];
    expect(await chunksOf(input(ELDAD, beats))).toEqual([
      "אלדד מתקדם. ",
      "אלדד מחטיא את גובלין לוחם.",
    ]);
  });

  it("leaves no trailing whitespace on the concatenated text", async () => {
    const text = await textOf(input(ELDAD, [{ kind: "move", feet: 5 }, { kind: "hold" }]));
    expect(text).toBe(text.trimEnd());
  });
});
