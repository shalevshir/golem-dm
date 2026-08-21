import { describe, expect, it } from "vitest";
import { GLOSSARY_TERMS } from "@ai-dm/agents";
import type { NarrativeSample } from "./narrative.js";
import type { ReviewSheetInput } from "./review-sheet.js";
import { buildReviewSheetInput, renderReviewSheet } from "./review-sheet.js";

const INPUT = {
  samples: [
    {
      beatsEnglish: "hero attacks Goblin Warrior with Longsword: critical_hit, severity felling",
      hebrew: "חרבו של אלדד מוצאת פתח מתחת למגן. הגובלין הלוחם מתקפל אל האבן.",
      source: "model" as const,
    },
  ],
  names: [
    { english: "Longsword", hebrew: "חרב ארוכה", kind: "weapon" as const },
    { english: "Goblin Warrior", hebrew: "גובלין לוחם", kind: "monster" as const },
  ],
  glossary: [{ english: "saving throw", hebrew: "גלגול הצלה" }],
  conditions: [{ english: "Prone", hebrew: "שרוע" }],
};

describe("renderReviewSheet", () => {
  // --- The brief's own three tests, verbatim ---------------------------

  it("puts each Hebrew sample next to the English beats that produced it", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("severity felling");
    expect(sheet).toContain("חרבו של אלדד");
  });

  it("lists every name, glossary term and condition for review", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("חרב ארוכה");
    expect(sheet).toContain("גלגול הצלה");
    expect(sheet).toContain("שרוע");
  });

  it("tells the reviewer exactly what to do with a correction", () => {
    expect(renderReviewSheet(INPUT)).toContain("data/srd/");
  });

  // --- Gaps the three tests above do not close --------------------------
  // Each `toContain` above passes as long as the substring appears ANYWHERE
  // in the sheet. None of them prove pairing, completeness across more than
  // one row, or that the specific corrections rulings 3-5 require are
  // actually present. These tests close those gaps.

  it("keeps a sample's Hebrew paired with its OWN English beats, not another sample's", () => {
    const twoSamples: ReviewSheetInput = {
      ...INPUT,
      samples: [
        { beatsEnglish: "FIRST-BEATS-MARKER", hebrew: "טקסט ראשון", source: "model" },
        { beatsEnglish: "SECOND-BEATS-MARKER", hebrew: "טקסט שני", source: "model" },
      ],
    };
    const sheet = renderReviewSheet(twoSamples);
    const firstBeats = sheet.indexOf("FIRST-BEATS-MARKER");
    const firstHebrew = sheet.indexOf("טקסט ראשון");
    const secondBeats = sheet.indexOf("SECOND-BEATS-MARKER");
    const secondHebrew = sheet.indexOf("טקסט שני");

    expect(firstBeats).toBeGreaterThanOrEqual(0);
    // Strictly increasing: sample 1's beats, then sample 1's Hebrew, then
    // sample 2's beats, then sample 2's Hebrew — a swap or a zip-across-
    // samples bug breaks this ordering even though every substring above
    // still individually appears somewhere in the sheet.
    expect(firstHebrew).toBeGreaterThan(firstBeats);
    expect(secondBeats).toBeGreaterThan(firstHebrew);
    expect(secondHebrew).toBeGreaterThan(secondBeats);
  });

  it("renders each sample's source, not just its text", () => {
    const sheet = renderReviewSheet({
      ...INPUT,
      samples: [{ beatsEnglish: "beats", hebrew: "עברית", source: "model" }],
    });
    expect(sheet).toContain("model");
  });

  it("names every entry's English counterpart, not only its Hebrew", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("Longsword");
    expect(sheet).toContain("Goblin Warrior");
    expect(sheet).toContain("saving throw");
    expect(sheet).toContain("Prone");
  });

  it("lists every row of a multi-row glossary and conditions table, not just the first", () => {
    const sheet = renderReviewSheet({
      ...INPUT,
      glossary: [
        { english: "saving throw", hebrew: "גלגול הצלה" },
        { english: "hit points", hebrew: "נקודות פגיעה" },
      ],
      conditions: [
        { english: "Prone", hebrew: "שרוע" },
        { english: "Blinded", hebrew: "עיוור" },
      ],
    });
    expect(sheet).toContain("נקודות פגיעה");
    expect(sheet).toContain("עיוור");
  });

  it("groups names under every kind present, not only the first kind seen", () => {
    const sheet = renderReviewSheet({
      ...INPUT,
      names: [
        { english: "Longsword", hebrew: "חרב ארוכה", kind: "weapon" },
        { english: "Padded Armor", hebrew: "שריון מרופד", kind: "armor" },
        { english: "Goblin Warrior", hebrew: "גובלין לוחם", kind: "monster" },
        { english: "Scimitar", hebrew: "חרב מעוקלת", kind: "action" },
      ],
    });
    expect(sheet).toContain("### Weapons");
    expect(sheet).toContain("### Armor");
    expect(sheet).toContain("### Monsters");
    expect(sheet).toContain("### Actions");
    expect(sheet).toContain("שריון מרופד");
    expect(sheet).toContain("חרב מעוקלת");
  });

  it("omits a name-kind heading with no rows, rather than printing an empty section", () => {
    // INPUT carries only weapon and monster names — no armor, no action.
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).not.toContain("### Armor");
    expect(sheet).not.toContain("### Actions");
  });

  it("documents the glossary correction path by file name", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("hebrew-glossary.md");
    expect(sheet).toContain("prompt-text.ts");
  });

  it("documents the template-wording correction path by name", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("NARRATIVE_SYSTEM_PROMPT");
    expect(sheet).toContain("deterministic.ts");
  });

  it("warns that conditions.json has a second, test-hardcoded copy", () => {
    // Ruling 5: a data-only fix to conditions.json's prone row reds
    // apps/server/src/encounters/conditions.test.ts with no warning unless
    // this sheet says so explicitly.
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("apps/server/src/encounters/conditions.test.ts");
  });

  it("flags the deterministic renderer's bare-preposition Hebrew verbatim", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("בגובלין לוחם");
    expect(sheet).toContain("את גובלין לוחם");
  });
});

describe("buildReviewSheetInput", () => {
  it("loads all 62 primary SRD names, grouped by kind, plus every distinct action name", () => {
    const input = buildReviewSheetInput([]);
    const byKind = (kind: "weapon" | "armor" | "monster" | "action"): number =>
      input.names.filter((name) => name.kind === kind).length;

    // Verified counts: data/srd/weapons.json is 38 rows, armor.json 13,
    // data/srd/monsters/*.json is 11 files.
    expect(byKind("weapon")).toBe(38);
    expect(byKind("armor")).toBe(13);
    expect(byKind("monster")).toBe(11);
    // 16 raw actions across the 11 monster files, with "Scimitar" (x3) and
    // "Shortbow" (x2) repeated identically — 13 distinct (english, hebrew)
    // pairs once deduplicated.
    expect(byKind("action")).toBe(13);
  });

  it("deduplicates an action name repeated identically across several monsters", () => {
    const input = buildReviewSheetInput([]);
    // "Scimitar" also names an unrelated row in weapons.json (kind: "weapon")
    // — the SRD martial weapon, not any one monster's attack — so the dedup
    // claim is specifically about the "action" kind: three monsters
    // (bandit, bandit_captain, goblin_warrior) each carry an identical
    // "Scimitar" attack, and only one row should survive.
    const scimitarActionRows = input.names.filter(
      (name) => name.english === "Scimitar" && name.kind === "action",
    );
    expect(scimitarActionRows).toHaveLength(1);
    expect(scimitarActionRows[0]?.hebrew).toBe("חרב מעוקלת");
  });

  it("loads the glossary straight from hebrew-glossary.md, matching @ai-dm/agents' mirror", () => {
    const input = buildReviewSheetInput([]);
    // Verified fact: 24 data rows. Cross-checked against GLOSSARY_TERMS
    // (packages/agents/src/narrative/prompt-text.ts), which its own parity
    // test already proves matches this same markdown file row for row — so
    // agreement here is evidence this loader's own markdown parsing is
    // correct, not just that the row count matches.
    expect(input.glossary).toHaveLength(24);
    expect(input.glossary).toEqual(GLOSSARY_TERMS);
  });

  it("loads all 15 SRD conditions", () => {
    const input = buildReviewSheetInput([]);
    expect(input.conditions).toHaveLength(15);
    expect(input.conditions.find((row) => row.english === "Prone")?.hebrew).toBe("שרוע");
  });

  function sample(overrides: Partial<NarrativeSample> = {}): NarrativeSample {
    return {
      source: {
        actor: { nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] },
        actorSide: "party",
        beats: [{ kind: "hold" }],
        pulse: { hostilesStanding: 1, heroBand: "healthy" },
        sceneEnglish: "test scene",
        recentNarrations: [],
      },
      beatsEnglish: "holds position",
      hebrew: "אלדד עומד במקומו.",
      ttftMs: 0,
      digitViolation: false,
      nonHebrew: false,
      overLength: false,
      ...overrides,
    };
  }

  it("converts a clean sample to a model-sourced row, never NarrativeSample.source's NarrationInput", () => {
    const input = buildReviewSheetInput([sample()]);
    expect(input.samples).toHaveLength(1);
    expect(input.samples[0]).toEqual({
      beatsEnglish: "holds position",
      hebrew: "אלדד עומד במקומו.",
      source: "model",
    });
  });

  it("drops an errored sample instead of showing an empty row", () => {
    const input = buildReviewSheetInput([
      sample({ errorCode: "provider_error", hebrew: "" }),
      sample(),
    ]);
    expect(input.samples).toHaveLength(1);
    expect(input.samples[0]?.hebrew).toBe("אלדד עומד במקומו.");
  });
});
