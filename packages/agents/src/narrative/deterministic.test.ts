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
      // severity is deliberately NOT "severe": severityFor bands purely on
      // damage/maxHp with no reference to outcome, so an ordinary heavy hit
      // can legitimately carry severity "severe" too. Keeping it "graze"
      // here means only a renderer that keys the marker off `outcome` (not
      // `severity`) can pass this test.
      outcome: "critical_hit", severity: "graze", statusAfter: "alive",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד פוגע בגובלין לוחם פגיעה אנושה.");
  });

  it("narrates a critical miss as a miss, not a landed hit", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה",
      outcome: "critical_miss", statusAfter: "alive",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד מחטיא את גובלין לוחם.");
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

  interface FormCase {
    readonly label: string;
    readonly actor: NarrationInput["actor"];
    readonly beats: NarrationBeat[];
    readonly expected: string;
  }

  // Every one of the 16 strings in the FORMS table (8 keys x 2 genders),
  // each reached through the public stream() API rather than read off the
  // table directly — this table IS the completeness check, not a restatement
  // of the implementation's own lookup. Every name involved (ELDAD, RANGER,
  // GOBLIN, WOLF_F) is reused from the fixtures above; nothing new is
  // introduced. The two masculine forms that a real game actually ships
  // today — `falls` and `losesConsciousness` on a masculine target — are
  // exercised here (rows "falls, masculine" / "losesConsciousness,
  // masculine") since every current `data/` name is masculine and neither
  // was previously asserted anywhere.
  const FORM_TABLE: readonly FormCase[] = [
    { label: "advances, masculine", actor: ELDAD, beats: [{ kind: "move", feet: 10 }], expected: "אלדד מתקדם." },
    { label: "advances, feminine", actor: RANGER, beats: [{ kind: "move", feet: 10 }], expected: "רעות מתקדמת." },
    {
      label: "misses, masculine",
      actor: ELDAD,
      beats: [{ kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "miss", statusAfter: "alive" }],
      expected: "אלדד מחטיא את גובלין לוחם.",
    },
    {
      label: "misses, feminine",
      actor: RANGER,
      beats: [{ kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "miss", statusAfter: "alive" }],
      expected: "רעות מחטיאה את גובלין לוחם.",
    },
    {
      label: "hits, masculine",
      actor: ELDAD,
      beats: [{ kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "hit", severity: "solid", statusAfter: "alive" }],
      expected: "אלדד פוגע בגובלין לוחם.",
    },
    {
      label: "hits, feminine",
      actor: RANGER,
      beats: [{ kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "hit", severity: "solid", statusAfter: "alive" }],
      expected: "רעות פוגעת בגובלין לוחם.",
    },
    {
      label: "falls, masculine",
      actor: ELDAD,
      beats: [{ kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "hit", severity: "felling", statusAfter: "dead" }],
      expected: "אלדד פוגע בגובלין לוחם. גובלין לוחם נופל.",
    },
    {
      label: "falls, feminine",
      actor: ELDAD,
      beats: [{ kind: "attack", target: WOLF_F, actionNameHebrew: "חרב ארוכה", outcome: "hit", severity: "felling", statusAfter: "dead" }],
      expected: "אלדד פוגע בזאבה. זאבה נופלת.",
    },
    { label: "actsOtherwise, masculine", actor: ELDAD, beats: [{ kind: "other-action" }], expected: "אלדד נוקט פעולה." },
    { label: "actsOtherwise, feminine", actor: RANGER, beats: [{ kind: "other-action" }], expected: "רעות נוקטת פעולה." },
    { label: "holds, masculine", actor: ELDAD, beats: [{ kind: "hold" }], expected: "אלדד עומד במקומו." },
    { label: "holds, feminine", actor: RANGER, beats: [{ kind: "hold" }], expected: "רעות עומדת במקומה." },
    {
      label: "attempts, masculine",
      actor: ELDAD,
      beats: [{ kind: "unresolved" }],
      expected: "אלדד מנסה פעולה שהמנוע לא הצליח לפתור.",
    },
    {
      label: "attempts, feminine",
      actor: RANGER,
      beats: [{ kind: "unresolved" }],
      expected: "רעות מנסה פעולה שהמנוע לא הצליח לפתור.",
    },
    {
      label: "losesConsciousness, masculine",
      actor: ELDAD,
      beats: [{ kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "hit", severity: "felling", statusAfter: "unconscious" }],
      expected: "אלדד פוגע בגובלין לוחם. גובלין לוחם מאבד את הכרתו.",
    },
    {
      label: "losesConsciousness, feminine",
      actor: GOBLIN,
      beats: [{ kind: "attack", target: RANGER, actionNameHebrew: "חרב מעוקלת", outcome: "hit", severity: "felling", statusAfter: "unconscious" }],
      expected: "גובלין לוחם פוגע ברעות. רעות מאבדת את הכרתה.",
    },
  ];

  it.each(FORM_TABLE)("renders $label", async ({ actor, beats, expected }) => {
    expect(await textOf(input(actor, beats))).toBe(expected);
  });
});
