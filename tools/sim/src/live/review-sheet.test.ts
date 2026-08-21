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
  // --- Fix round 1: Minor 7 — exactly one trailing newline, no more -----
  // index.ts's `process.stdout.write` no longer appends its own "\n" on top
  // of this — the committed artifact must not gain a trailing blank line.

  it("ends in exactly one trailing newline, not two and not zero", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet.endsWith("\n")).toBe(true);
    expect(sheet.endsWith("\n\n")).toBe(false);
  });

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

  // --- Fix round 1: Important 1 — the sheet no longer claims completeness
  // it does not have -------------------------------------------------------

  it("no longer claims to cover every Hebrew string this change ships", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).not.toContain("Every Hebrew string this change ships");
  });

  it("names apps/web/src/i18n.ts and data/characters/*.json as explicitly out of scope", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("apps/web/src/i18n.ts");
    expect(sheet).toContain("data/characters/*.json");
  });

  // --- Fix round 2: Important 1 (re-opened) — the note written to fix the
  // overclaim contained a new overclaim, and its correction path was inert
  // ---------------------------------------------------------------------

  it("no longer claims the hero's Hebrew name is printed in every sample", () => {
    // False for 2 of 9 SCRIPTED_BRIEFS entries: the ranger acts alone with
    // no target in one, and the goblin — not אלדד — is the ACTOR in
    // another (אלדד is only the target there). Checked against the exact
    // retired phrase, not the bare substring "every sample": the fix's own
    // replacement text legitimately says a hero.json-only correction
    // "leaves every sample above exactly as it was" — a true statement
    // using the same two words for an unrelated claim.
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).not.toContain("printed in every sample");
  });

  it("says correcting the hero's Hebrew name requires editing both hero.json and the narrative.ts fixture", () => {
    // The correction path SCOPE_NOTE states for every other character name
    // — a data-only edit to data/characters/*.json — does nothing here:
    // narrative.ts's own ELDAD fixture is a hardcoded literal, independent
    // of hero.json. A reader must be told to edit both.
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("hero.json");
    expect(sheet).toContain("tools/sim/src/live/narrative.ts");
    expect(sheet).toContain("both files together");
  });

  // --- Fix round 1: Minor 5 — pin the document's own scaffolding ---------

  it("pins the four top-level headings in their required order", () => {
    // Deleting `## Names` or moving `HOW_TO_REVIEW`'s section elsewhere
    // leaves every other test above green — none of them assert order
    // across sections, only substring presence within one.
    const sheet = renderReviewSheet(INPUT);
    const howToReview = sheet.indexOf("## How to review");
    const narrationSamples = sheet.indexOf("## Narration samples");
    const names = sheet.indexOf("## Names");
    const glossaryAndConditions = sheet.indexOf("## Glossary and conditions");

    expect(howToReview).toBeGreaterThanOrEqual(0);
    expect(narrationSamples).toBeGreaterThan(howToReview);
    expect(names).toBeGreaterThan(narrationSamples);
    expect(glossaryAndConditions).toBeGreaterThan(names);
  });

  // --- Fix round 1: Minor 8 — say how many samples were dropped ----------

  it("states how many samples errored and were omitted, when erroredSampleCount is given", () => {
    const sheet = renderReviewSheet({ ...INPUT, erroredSampleCount: 3 });
    expect(sheet).toContain("3 samples errored and were omitted");
  });

  it("uses singular wording for exactly one errored sample", () => {
    // Fix round 2, Minor 2: the realistic live shape (this test suite's
    // own words, in narrative.test.ts) is one transient failure among
    // otherwise-clean samples — not every call failing at once — so the
    // singular case is the common one, not an edge case.
    const sheet = renderReviewSheet({ ...INPUT, erroredSampleCount: 1 });
    expect(sheet).toContain("1 sample errored and was omitted");
    expect(sheet).not.toContain("1 samples");
    expect(sheet).not.toContain("and were omitted");
  });

  it("says nothing about errored samples when erroredSampleCount is absent or zero", () => {
    expect(renderReviewSheet(INPUT)).not.toContain("errored and were omitted");
    expect(renderReviewSheet({ ...INPUT, erroredSampleCount: 0 })).not.toContain(
      "errored and were omitted",
    );
  });

  it("keeps the Narration samples heading non-empty when every sample errored, unlike an empty Names kind", () => {
    // The opposite of how an empty Names kind is handled (omitted
    // entirely) — Narration samples always keeps its heading, but must not
    // print it with nothing at all underneath.
    const sheet = renderReviewSheet({ ...INPUT, samples: [], erroredSampleCount: 9 });
    const heading = sheet.indexOf("## Narration samples");
    const nextHeading = sheet.indexOf("## Names");
    expect(heading).toBeGreaterThanOrEqual(0);
    const between = sheet.slice(heading, nextHeading);
    expect(between).toContain("9 samples errored and were omitted");
  });
});

describe("buildReviewSheetInput", () => {
  it("loads all 62 primary SRD names, grouped by kind, plus every distinct action name", () => {
    const input = buildReviewSheetInput([], true);
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
    const input = buildReviewSheetInput([], true);
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
    const input = buildReviewSheetInput([], true);
    // Verified fact: 24 data rows. Cross-checked against GLOSSARY_TERMS
    // (packages/agents/src/narrative/prompt-text.ts), which its own parity
    // test already proves matches this same markdown file row for row — so
    // agreement here is evidence this loader's own markdown parsing is
    // correct, not just that the row count matches.
    expect(input.glossary).toHaveLength(24);
    expect(input.glossary).toEqual(GLOSSARY_TERMS);
  });

  it("loads all 15 SRD conditions", () => {
    const input = buildReviewSheetInput([], true);
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

  it("converts a clean sample to a model-sourced row on a live run, never NarrativeSample.source's NarrationInput", () => {
    const input = buildReviewSheetInput([sample()], true);
    expect(input.samples).toHaveLength(1);
    expect(input.samples[0]).toEqual({
      beatsEnglish: "holds position",
      hebrew: "אלדד עומד במקומו.",
      source: "model",
    });
  });

  it('labels a surviving sample "scripted", not "model", on a non-live (smoke) run', () => {
    // A smoke run's text is index.ts's own NARRATIVE_SMOKE_TEXT placeholder
    // — never real model output. Stamping it "model" would misrepresent
    // that to a reviewer generating a sheet locally without --live.
    const input = buildReviewSheetInput([sample()], false);
    expect(input.samples[0]?.source).toBe("scripted");
  });

  it("drops an errored sample instead of showing an empty row", () => {
    const input = buildReviewSheetInput(
      [sample({ errorCode: "provider_error", hebrew: "" }), sample()],
      true,
    );
    expect(input.samples).toHaveLength(1);
    expect(input.samples[0]?.hebrew).toBe("אלדד עומד במקומו.");
  });

  it("counts errored samples separately from the ones that survive", () => {
    const input = buildReviewSheetInput(
      [sample({ errorCode: "provider_error", hebrew: "" }), sample(), sample()],
      true,
    );
    expect(input.samples).toHaveLength(2);
    expect(input.erroredSampleCount).toBe(1);
  });

  it("omits erroredSampleCount entirely when nothing errored", () => {
    const input = buildReviewSheetInput([sample(), sample()], true);
    expect(input.erroredSampleCount).toBeUndefined();
  });
});
