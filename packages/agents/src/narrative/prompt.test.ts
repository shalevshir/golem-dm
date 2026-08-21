import { describe, expect, it } from "vitest";
import { RULES_DIGEST } from "../rules-digest.js";
import { buildNarrativePrompt } from "./prompt.js";
import { HEBREW_GLOSSARY, NARRATIVE_SYSTEM_PROMPT } from "./prompt-text.js";
import type { NarrationBeat, NarrationInput } from "./port.js";

const INPUT: NarrationInput = {
  actor: { nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] },
  actorSide: "party",
  beats: [
    { kind: "move", feet: 25 },
    {
      kind: "attack",
      target: { nameHebrew: "גובלין לוחם", gender: "masculine", conditionsHebrew: ["שרוע"] },
      actionNameHebrew: "חרב ארוכה",
      outcome: "critical_hit",
      severity: "felling",
      statusAfter: "dead",
    },
  ],
  pulse: { hostilesStanding: 2, heroBand: "bloodied" },
  sceneEnglish: "A dry hillside track of broken stone.",
  recentNarrations: ["אלדד מתקדם.", "גובלין לוחם מחטיא את אלדד."],
};

function joined(segments: readonly string[] | undefined): string {
  return (segments ?? []).join("\n");
}

describe("buildNarrativePrompt", () => {
  it("puts the system prompt, glossary and rules digest in the cached static tier", () => {
    const prompt = buildNarrativePrompt(INPUT);
    expect(prompt.static).toEqual([NARRATIVE_SYSTEM_PROMPT, HEBREW_GLOSSARY, RULES_DIGEST]);
  });

  it("puts the scene card in the semi-static tier, where it is cached per encounter", () => {
    expect(joined(buildNarrativePrompt(INPUT).semiStatic)).toContain(
      "A dry hillside track of broken stone.",
    );
  });

  it("spells the scene header exactly SCENE, on its own line — NARRATIVE_SYSTEM_PROMPT " +
    "(Task 8) tells the model about a section by that exact name, and a silent rename " +
    "here would leave that instruction dangling", () => {
    expect(joined(buildNarrativePrompt(INPUT).semiStatic)).toMatch(/^SCENE$/m);
  });

  it("keeps turn state out of every cached tier", () => {
    const prompt = buildNarrativePrompt(INPUT);

    // The exact pin: combined with the exact `static` pin above, nothing beyond
    // the scene card can be in a cached tier — leaked turn state cannot pass
    // this regardless of whether it happens to carry Hebrew. A bare, Hebrew-free
    // fragment (e.g. a stray "- moves: a short move" line, or the whole
    // FIGHT PULSE block) would slip past the two `not.toContain` checks below;
    // it cannot slip past this one.
    expect(prompt.semiStatic).toEqual([`SCENE\n${INPUT.sceneEnglish}`]);

    // Kept as the readable statement of intent for why the pin above matters:
    // named turn state is the costliest and most likely real-world leak.
    const cached = `${joined(prompt.static)}\n${joined(prompt.semiStatic)}`;
    expect(cached).not.toContain("אלדד");
    expect(cached).not.toContain("גובלין לוחם");
  });

  // The static tier is exempt on purpose: RULES_DIGEST and NARRATIVE_SYSTEM_PROMPT
  // legitimately carry digits ("+2 to Armor Class", "5 feet", "5th edition (2024
  // rules)") as rules constants and authored prose, hash-pinned and frozen already —
  // not turn facts. What the spec actually buys is that the ENGINE's turn numbers
  // never reach the model, and those live only in semiStatic (the scene card) and
  // dynamic (beats, pulse, recent narrations). So the sweep below covers only those
  // two tiers, plus a second, narrower assertion on dynamic alone below it.
  it("emits no digit in the semi-static or dynamic tiers — turn facts stay out of the model's view", () => {
    const prompt = buildNarrativePrompt(INPUT);
    const turnFacing = `${joined(prompt.semiStatic)}\n${joined(prompt.dynamic)}`;
    expect(turnFacing).not.toMatch(/[0-9]/);
  });

  it("emits no digit in the dynamic tier alone — the engine's turn numbers never reach the model", () => {
    const prompt = buildNarrativePrompt(INPUT);
    expect(joined(prompt.dynamic)).not.toMatch(/[0-9]/);
  });

  it("names the actor, its gender, the action and the severity in the dynamic tier", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    expect(dynamic).toContain("אלדד");
    expect(dynamic).toContain("masculine");
    expect(dynamic).toContain("חרב ארוכה");
    expect(dynamic).toContain("felling");
    expect(dynamic).toContain("critical_hit");
  });

  it("carries a target's conditions and the fight pulse as words", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    expect(dynamic).toContain("שרוע");
    expect(dynamic).toContain("two");
    expect(dynamic).toContain("bloodied");
  });

  it("spells the fight-pulse header exactly FIGHT PULSE, on its own line — NARRATIVE_SYSTEM_PROMPT " +
    "(Task 8) says \"the fight pulse tells you how the fight stands\", naming the block this labels", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    expect(dynamic).toMatch(/^FIGHT PULSE$/m);
  });

  it("renders exactly the beats given, in order, and no others", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    const turnSection = dynamic.slice(0, dynamic.indexOf("FIGHT PULSE"));
    const beatLines = turnSection.split("\n").filter((line) => line.startsWith("- "));
    expect(beatLines).toHaveLength(INPUT.beats.length);
    expect(beatLines[0]).toContain("moves");
    expect(beatLines[1]).toContain("attacks");
  });

  it("includes recent narration so the model can avoid repeating itself", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    expect(dynamic).toContain("גובלין לוחם מחטיא את אלדד.");
  });

  it("spells the recent-narration header exactly RECENT NARRATION at the start of its line " +
    "— NARRATIVE_SYSTEM_PROMPT (Task 8) refers to a section by that exact name", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    expect(dynamic).toMatch(/^RECENT NARRATION\b/m);
  });

  it("omits the recent-narration section entirely on the first turn", () => {
    const dynamic = joined(buildNarrativePrompt({ ...INPUT, recentNarrations: [] }).dynamic);
    expect(dynamic).not.toContain("RECENT NARRATION");
  });
});

interface BeatRenderCase {
  name: string;
  beat: NarrationBeat;
  expectedLine: string;
}

// Every case is driven through buildNarrativePrompt, the public API — moveWord
// itself is not exported and should not be. Each expectation is the beat's
// full literal rendered line, not a substring, so a wording or boundary edit
// anywhere in renderBeat/moveWord shows up here.
const BEAT_RENDER_CASES: readonly BeatRenderCase[] = [
  {
    name: "a 5-foot move sits on the <= 5 band's own boundary",
    beat: { kind: "move", feet: 5 },
    expectedLine: "- moves: a single step",
  },
  {
    name: "a 15-foot move sits on the <= 15 band's own boundary",
    beat: { kind: "move", feet: 15 },
    expectedLine: "- moves: a short move",
  },
  {
    name: "a 25-foot move falls past both boundaries",
    beat: { kind: "move", feet: 25 },
    expectedLine: "- moves: a long move across open ground",
  },
  {
    name: "an other-action beat",
    beat: { kind: "other-action" },
    expectedLine:
      "- takes a non-attack action (Dodge, Dash, Hide or similar): legal, mechanically inert",
  },
  {
    name: "an unresolved beat",
    beat: { kind: "unresolved" },
    expectedLine: "- attempted an action the engine could not resolve",
  },
  {
    name: "a hold beat",
    beat: { kind: "hold" },
    expectedLine: "- did nothing this turn",
  },
  {
    name: "a miss carries no severity clause at all",
    beat: {
      kind: "attack",
      target: { nameHebrew: "גובלין לוחם", gender: "masculine", conditionsHebrew: [] },
      actionNameHebrew: "חץ",
      outcome: "miss",
      statusAfter: "alive",
    },
    expectedLine: "- attacks גובלין לוחם (masculine) with חץ: miss, target after: alive",
  },
];

describe("buildNarrativePrompt beat rendering", () => {
  it.each(BEAT_RENDER_CASES)("renders $name with its exact literal text", ({ beat, expectedLine }) => {
    const input: NarrationInput = { ...INPUT, beats: [beat] };
    const dynamic = joined(buildNarrativePrompt(input).dynamic);
    expect(dynamic).toContain(expectedLine);
  });
});
