// Assembles the narrative prompt into the three cache tiers.
//
// The rule this file exists to enforce: NO DIGIT reaches the model. The
// engine's numbers are already banded into severities and health bands, and
// a model that never sees a digit cannot echo one into prose that forbids
// them. Distances and counts are therefore rendered as words here, not
// interpolated.
import { RULES_DIGEST } from "../rules-digest.js";
import type { LayeredPrompt } from "../providers/prompt.js";
import type { NarrationBeat, NarrationInput } from "./port.js";
import { HEBREW_GLOSSARY, NARRATIVE_SYSTEM_PROMPT } from "./prompt-text.js";

const COUNT_WORDS = [
  "none",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

function countWord(count: number): string {
  return COUNT_WORDS[count] ?? "many";
}

/**
 * Movement as a phrase, never as feet. The brief carries the true distance
 * because it is true; this is the only place that decides how much of it the
 * model is allowed to know, and the answer is "the shape, not the number".
 */
function moveWord(feet: number): string {
  if (feet <= 5) return "a single step";
  if (feet <= 15) return "a short move";
  return "a long move across open ground";
}

function renderBeat(beat: NarrationBeat): string {
  switch (beat.kind) {
    case "move":
      return `- moves: ${moveWord(beat.feet)}`;
    case "attack": {
      const conditions =
        beat.target.conditionsHebrew.length > 0
          ? `, target conditions: ${beat.target.conditionsHebrew.join(", ")}`
          : "";
      const severity = beat.severity === undefined ? "" : `, severity: ${beat.severity}`;
      return (
        `- attacks ${beat.target.nameHebrew} (${beat.target.gender}) ` +
        `with ${beat.actionNameHebrew}: ${beat.outcome}${severity}` +
        `, target after: ${beat.statusAfter}${conditions}`
      );
    }
    case "other-action":
      return "- takes a non-attack action (Dodge, Dash, Hide or similar): legal, mechanically inert";
    case "unresolved":
      return "- attempted an action the engine could not resolve";
    case "hold":
      return "- did nothing this turn";
  }
}

function renderTurn(input: NarrationInput): string {
  const actorConditions =
    input.actor.conditionsHebrew.length > 0
      ? `\nActor conditions: ${input.actor.conditionsHebrew.join(", ")}`
      : "";

  return [
    "THIS TURN",
    `Actor: ${input.actor.nameHebrew} (${input.actor.gender})`,
    `Side: ${input.actorSide === "party" ? "the player's side" : "hostile"}${actorConditions}`,
    ...input.beats.map(renderBeat),
  ].join("\n");
}

function renderPulse(input: NarrationInput): string {
  return [
    "FIGHT PULSE",
    `Enemies still standing: ${countWord(input.pulse.hostilesStanding)}`,
    `The player's condition: ${input.pulse.heroBand}`,
  ].join("\n");
}

export function buildNarrativePrompt(input: NarrationInput): LayeredPrompt {
  const dynamic = [renderTurn(input), renderPulse(input)];

  // Omitted rather than sent empty on turn one: an empty section is a line of
  // uncached tokens that says nothing, and "do not repeat this" pointing at
  // nothing is a confusing instruction.
  if (input.recentNarrations.length > 0) {
    dynamic.push(
      ["RECENT NARRATION (do not reuse its verbs, imagery or sentence shapes)"]
        .concat(input.recentNarrations.map((each) => `- ${each}`))
        .join("\n"),
    );
  }

  return {
    static: [NARRATIVE_SYSTEM_PROMPT, HEBREW_GLOSSARY, RULES_DIGEST],
    semiStatic: [`SCENE\n${input.sceneEnglish}`],
    dynamic,
  };
}
