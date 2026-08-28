import { describe, expect, it } from "vitest";
import { buildIntentPrompt } from "./prompt.js";
import { INTENT_SYSTEM_PROMPT } from "./prompt-text.js";

const edges = [
  { to: "cellar-stairs", labelEnglish: "the cellar stairs", open: true },
  { to: "iron-vault", labelEnglish: "a locked iron door", open: false },
];

const secretText = "אני רוצה לפרוץ את הדלת המנעל";

function joined(tier: readonly string[] | undefined): string {
  return (tier ?? []).join("\n");
}

describe("buildIntentPrompt", () => {
  it("puts the system prompt in the static tier", () => {
    const prompt = buildIntentPrompt({ text: secretText, sceneEnglish: "A dusty tavern.", edges });

    expect(joined(prompt.static)).toContain(INTENT_SYSTEM_PROMPT);
  });

  it("puts the scene card in the semi-static tier", () => {
    const prompt = buildIntentPrompt({
      text: secretText,
      sceneEnglish: "A dusty tavern common room.",
      edges,
    });

    expect(joined(prompt.semiStatic)).toContain("A dusty tavern common room.");
  });

  it("puts the edge list in the semi-static tier, with open/closed marked", () => {
    const prompt = buildIntentPrompt({ text: secretText, sceneEnglish: "A dusty tavern.", edges });

    expect(joined(prompt.semiStatic)).toContain("cellar-stairs");
    expect(joined(prompt.semiStatic)).toContain("open");
    expect(joined(prompt.semiStatic)).toContain("iron-vault");
    expect(joined(prompt.semiStatic)).toContain("closed");
  });

  it("does not filter closed edges out of the prompt", () => {
    const closedOnly = [{ to: "iron-vault", labelEnglish: "a locked iron door", open: false }];
    const prompt = buildIntentPrompt({ text: secretText, sceneEnglish: "A dusty tavern.", edges: closedOnly });

    expect(joined(prompt.semiStatic)).toContain("iron-vault");
  });

  it("puts the player's text in the dynamic tier", () => {
    const prompt = buildIntentPrompt({ text: secretText, sceneEnglish: "A dusty tavern.", edges });

    expect(joined(prompt.dynamic)).toContain(secretText);
  });

  it("delimits the player's text explicitly", () => {
    const prompt = buildIntentPrompt({ text: secretText, sceneEnglish: "A dusty tavern.", edges });

    expect(joined(prompt.dynamic)).toContain("<<<");
    expect(joined(prompt.dynamic)).toContain(">>>");
    expect(joined(prompt.dynamic)).toContain("untrusted");
  });

  it("never lets the player's text reach the static tier", () => {
    const prompt = buildIntentPrompt({ text: secretText, sceneEnglish: "A dusty tavern.", edges });

    expect(joined(prompt.static)).not.toContain(secretText);
  });

  it("never lets the player's text reach the semi-static tier", () => {
    const prompt = buildIntentPrompt({ text: secretText, sceneEnglish: "A dusty tavern.", edges });

    expect(joined(prompt.semiStatic)).not.toContain(secretText);
  });

  it("appears only in the dynamic tier", () => {
    const prompt = buildIntentPrompt({ text: secretText, sceneEnglish: "A dusty tavern.", edges });

    const staticAndSemiStatic = joined(prompt.static) + joined(prompt.semiStatic);
    expect(staticAndSemiStatic).not.toContain(secretText);
    expect(joined(prompt.dynamic)).toContain(secretText);
  });
});
