import { describe, expect, it } from "vitest";
import { RULES_DIGEST } from "../rules-digest.js";
import { buildNarrativePrompt } from "./prompt.js";
import { HEBREW_GLOSSARY, NARRATIVE_SYSTEM_PROMPT } from "./prompt-text.js";
import type { NarrationInput } from "./port.js";

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
