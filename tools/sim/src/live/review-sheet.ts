// Renders the Hebrew review sheet: one markdown artifact that puts every
// Hebrew string this change ships — narration samples, proper names,
// glossary terms, condition labels — in front of a native speaker, next to
// exactly where a correction to each one belongs. Not a blocking gate (see
// tools/sim/CLAUDE.md); its only job is to give PROJECT_PLAN.md's "Hebrew
// reviewed by native speaker" criterion (task 9) something concrete to be
// satisfied against.
//
// `tools/sim` may do file I/O against `data/srd/` and `docs/prompts/` —
// unlike `@ai-dm/agents`, which must stay pure and bundleable
// (docs/prompts/README.md) — so the name, glossary and condition tables
// below are read straight from those source-of-record files rather than
// from `@ai-dm/agents`' TypeScript mirrors of them.
//
// This file only ever REPRODUCES Hebrew strings taken verbatim from data
// files or from a benchmark sample; it never edits or invents one.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NarrationSource } from "@ai-dm/schemas";
import { ArmorDefinition, ConditionDefinition, MonsterStatBlock, WeaponDefinition } from "@ai-dm/schemas";
import type { NarrativeSample } from "./narrative.js";

export type ReviewSheetNameKind = "weapon" | "armor" | "monster" | "action";

export interface ReviewSheetSample {
  beatsEnglish: string;
  hebrew: string;
  /**
   * `NarrationSource` (@ai-dm/schemas) has three values —
   * `"model" | "deterministic" | "completed"` — but `buildReviewSheetInput`
   * below can only ever produce `"model"`: the narrative benchmark calls
   * `createHebrewNarrative` directly rather than running the server
   * pipeline (live/narrative.ts's header comment), so a `"deterministic"` or
   * `"completed"` rung is never observed here. Kept as the full type,
   * rather than the narrower literal, so a future non-benchmark input (a
   * real session transcript, say) can carry those values without a type
   * change to this interface.
   */
  source: NarrationSource;
}

export interface ReviewSheetName {
  english: string;
  hebrew: string;
  kind: ReviewSheetNameKind;
}

export interface ReviewSheetGlossaryTerm {
  english: string;
  hebrew: string;
}

export interface ReviewSheetCondition {
  english: string;
  hebrew: string;
}

export interface ReviewSheetInput {
  samples: readonly ReviewSheetSample[];
  names: readonly ReviewSheetName[];
  glossary: readonly ReviewSheetGlossaryTerm[];
  conditions: readonly ReviewSheetCondition[];
}

const NAME_KIND_ORDER: readonly ReviewSheetNameKind[] = ["weapon", "armor", "monster", "action"];
const NAME_KIND_LABEL: Readonly<Record<ReviewSheetNameKind, string>> = {
  weapon: "Weapons",
  armor: "Armor",
  monster: "Monsters",
  action: "Actions",
};

/**
 * One paragraph mapping each kind of correction to the file it belongs in —
 * the review sheet's whole "so what do I do about it" payoff. Every path
 * named here is a real file this repo builds from; a reviewer who fixes the
 * wrong copy (e.g. `prompt-text.ts` instead of `hebrew-glossary.md`) will
 * have that fix silently overwritten the next time the parity test's source
 * of record is re-read.
 */
const HOW_TO_REVIEW =
  "A correction to a name — a weapon, a piece of armor, a monster, or one of its actions — " +
  "is a data-only edit to the matching row in `data/srd/weapons.json`, `data/srd/armor.json` " +
  "or `data/srd/monsters/*.json`. A correction to a condition label is the same kind of edit, " +
  "to `data/srd/conditions.json` (but read the note below first). A correction to a glossary " +
  "term — rules vocabulary, never a proper name — is an edit to `docs/prompts/hebrew-glossary.md`; " +
  "a parity test then requires the identical edit in `packages/agents/src/narrative/prompt-text.ts`, " +
  "which mirrors this table for runtime use and must never be edited on its own. A correction to " +
  "the narrator's register or its template wording is an edit to `NARRATIVE_SYSTEM_PROMPT` " +
  "(`prompt-text.ts`, the model-driven narrator) or to `deterministic.ts` (the terse fallback " +
  "narrator) — either edit needs a version bump (`NARRATIVE_PROMPT_VERSION`) and a re-pinned " +
  "content hash, since both are versioned prompt text.";

/**
 * Required reading before touching `conditions.json`: `nameHebrew` is not
 * the condition's only copy in the repo. Without this note, a reviewer's
 * data-only correction to the `prone` row reds
 * `apps/server/src/encounters/conditions.test.ts` with no warning — that
 * test hardcodes today's wording as its own assertion, independently of the
 * data file.
 */
const CONDITIONS_TEST_NOTE =
  "Note: `apps/server/src/encounters/conditions.test.ts` also hardcodes today's Hebrew wording " +
  "for the `prone` condition, as its own assertion, independently of `conditions.json`. A " +
  "data-only correction to that row will leave the test asserting the old value — update both " +
  "together.";

/**
 * Flagged here rather than left for the reviewer to find, per the plan this
 * sheet implements: the deterministic (non-model) narrator's template
 * wording glues a preposition directly onto a bare creature name, with no
 * definite-article agreement. Neither Hebrew example below is edited —
 * both are reproduced exactly as `deterministic.ts` emits them for the
 * "Goblin Warrior" fixture (`packages/agents/src/narrative/deterministic.test.ts`,
 * `live/narrative.ts`).
 */
const PREPOSITION_FLAG =
  "Known issue, flagged here rather than left for you to find: `deterministic.ts` (the terse " +
  "fallback narrator — never the model) glues a preposition directly onto a bare creature name " +
  "with no definite-article agreement, for example `בגובלין לוחם` and `את גובלין לוחם`. This is " +
  "the weakest Hebrew this change ships. A fix belongs in `deterministic.ts`, behind the same " +
  "version bump and re-pinned hash as any other template-wording change described above.";

function renderTable(rows: readonly { english: string; hebrew: string }[]): string[] {
  const lines = ["| English | Hebrew |", "| --- | --- |"];
  for (const row of rows) lines.push(`| ${row.english} | ${row.hebrew} |`);
  return lines;
}

function renderSample(sample: ReviewSheetSample, index: number): string[] {
  return [
    `### Sample ${String(index + 1)}`,
    "",
    `- English beats: ${sample.beatsEnglish}`,
    `- Hebrew: ${sample.hebrew}`,
    `- Source: ${sample.source}`,
    "",
  ];
}

/**
 * Four sections, in the order a reviewer should read them: what to do with a
 * finding, the narration samples themselves, every proper name, then the
 * rules-vocabulary and condition tables. Groups with zero rows (e.g. a
 * fixture with no armor names) are omitted rather than printed as an empty
 * heading.
 */
export function renderReviewSheet(input: ReviewSheetInput): string {
  const lines: string[] = [];

  lines.push("# Hebrew review sheet");
  lines.push("");
  lines.push(
    "Every Hebrew string this change ships, in one place, for a native speaker to read and " +
      'correct. Not a blocking gate — its only job is to give the roadmap\'s "Hebrew reviewed ' +
      'by native speaker" criterion something concrete to be satisfied against.',
  );
  lines.push("");

  lines.push("## How to review");
  lines.push("");
  lines.push(HOW_TO_REVIEW);
  lines.push("");
  lines.push(CONDITIONS_TEST_NOTE);
  lines.push("");
  lines.push(PREPOSITION_FLAG);
  lines.push("");

  lines.push("## Narration samples");
  lines.push("");
  input.samples.forEach((sample, index) => {
    lines.push(...renderSample(sample, index));
  });

  lines.push("## Names");
  lines.push("");
  for (const kind of NAME_KIND_ORDER) {
    const rows = input.names.filter((name) => name.kind === kind);
    if (rows.length === 0) continue;
    lines.push(`### ${NAME_KIND_LABEL[kind]}`);
    lines.push("");
    lines.push(...renderTable(rows));
    lines.push("");
  }

  lines.push("## Glossary and conditions");
  lines.push("");
  lines.push("### Glossary");
  lines.push("");
  lines.push(...renderTable(input.glossary));
  lines.push("");
  lines.push("### Conditions");
  lines.push("");
  lines.push(...renderTable(input.conditions));
  lines.push("");

  return lines.join("\n");
}

// --- Real-data loading, for the `--review-sheet` CLI flag -----------------
//
// Everything below assembles a real `ReviewSheetInput` from the repo's own
// SRD data and the narrative benchmark's own samples. `renderReviewSheet`
// above never calls any of it: keeping the pure renderer and the I/O layer
// separate is what let step 1's fixture-based tests run with no filesystem
// dependency at all.

/**
 * Walk up from this file until `relativePath` appears. A fixed relative
 * path (`../../../..`) would be wrong once `tools/sim` builds to `dist/`
 * (same reasoning as `scenarios/srd.ts` and `apps/server/src/encounters/srd.ts`,
 * which this duplicates rather than imports — neither exposes a directory
 * finder, and there is no shared home for one across `tools/sim`'s own
 * modules any more than there is across packages).
 */
function findUpward(relativePath: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${relativePath} above this file`);
    dir = parent;
  }
}

function srdDir(): string {
  return findUpward(join("data", "srd"));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadWeaponNames(dir: string): ReviewSheetName[] {
  const weapons = WeaponDefinition.array().parse(readJson(join(dir, "weapons.json")));
  return weapons.map((weapon) => ({
    english: weapon.nameEnglish,
    hebrew: weapon.nameHebrew,
    kind: "weapon",
  }));
}

function loadArmorNames(dir: string): ReviewSheetName[] {
  const armor = ArmorDefinition.array().parse(readJson(join(dir, "armor.json")));
  return armor.map((piece) => ({ english: piece.nameEnglish, hebrew: piece.nameHebrew, kind: "armor" }));
}

/**
 * Monster names plus every action name, deduplicated: several stat blocks
 * share an identical attack (e.g. "Scimitar" on both goblin files and the
 * bandit), and reviewing the same correct pair three times over would waste
 * the one thing this sheet asks of a reviewer — their attention. Deduping
 * on the (english, hebrew) PAIR, not on english alone, means two monsters
 * that disagreed on a name's Hebrew would still show as two distinct rows —
 * exactly the mistake a reviewer needs to see, not one dedup would hide.
 */
function loadMonsterAndActionNames(dir: string): { monsters: ReviewSheetName[]; actions: ReviewSheetName[] } {
  const monsterDir = join(dir, "monsters");
  // Sorted: `readdirSync`'s order is filesystem-dependent, and this sheet
  // becomes a committed file — an unsorted read would make its row order
  // (and therefore its diff against a prior version) vary by machine for no
  // reason connected to the data itself.
  const files = readdirSync(monsterDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  const monsters: ReviewSheetName[] = [];
  const actionsSeen = new Map<string, ReviewSheetName>();

  for (const file of files) {
    const monster = MonsterStatBlock.parse(readJson(join(monsterDir, file)));
    monsters.push({ english: monster.nameEnglish, hebrew: monster.nameHebrew, kind: "monster" });
    for (const action of monster.actions) {
      const key = `${action.nameEnglish} ${action.nameHebrew}`;
      if (!actionsSeen.has(key)) {
        actionsSeen.set(key, { english: action.nameEnglish, hebrew: action.nameHebrew, kind: "action" });
      }
    }
  }

  return { monsters, actions: Array.from(actionsSeen.values()) };
}

function loadConditionRows(dir: string): ReviewSheetCondition[] {
  const conditions = ConditionDefinition.array().parse(readJson(join(dir, "conditions.json")));
  return conditions.map((condition) => ({ english: condition.nameEnglish, hebrew: condition.nameHebrew }));
}

/**
 * Parses `docs/prompts/hebrew-glossary.md`'s table directly — the source of
 * record `HOW_TO_REVIEW` above points a correction at — rather than
 * importing `@ai-dm/agents`' `GLOSSARY_TERMS` mirror. Same row/column shape
 * `prompt-text.test.ts`'s own parity check already parses the same file
 * with, so a change to the table's markdown shape breaks that guard too,
 * not just this one.
 */
function loadGlossaryRows(): ReviewSheetGlossaryTerm[] {
  const path = join(findUpward(join("docs", "prompts")), "hebrew-glossary.md");
  const markdown = readFileSync(path, "utf8");
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.includes("---") && !line.includes("English"))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return { english: cells[1] ?? "", hebrew: cells[2] ?? "" };
    });
}

/**
 * The samples this benchmark can produce are narrower than
 * `ReviewSheetSample.source`'s full `NarrationSource` type allows — see that
 * field's doc comment. An errored sample (`NarrativeSample.errorCode` set)
 * carries no Hebrew worth a reviewer's time — `hebrew` is partial or empty,
 * per that field's own doc comment in `live/narrative.ts` — so it is left
 * out entirely rather than shown as a blank row.
 */
function reviewSheetSamplesFrom(samples: readonly NarrativeSample[]): ReviewSheetSample[] {
  return samples
    .filter((sample) => sample.errorCode === undefined)
    .map((sample) => ({
      beatsEnglish: sample.beatsEnglish,
      hebrew: sample.hebrew,
      source: "model",
    }));
}

/**
 * Assembles a real `ReviewSheetInput`: the given benchmark samples, plus
 * every name/glossary/condition table read fresh off disk. Kept separate
 * from `renderReviewSheet` so the CLI's `--review-sheet` flag is the only
 * caller that ever touches a filesystem.
 */
export function buildReviewSheetInput(samples: readonly NarrativeSample[]): ReviewSheetInput {
  const dir = srdDir();
  const { monsters, actions } = loadMonsterAndActionNames(dir);

  return {
    samples: reviewSheetSamplesFrom(samples),
    names: [...loadWeaponNames(dir), ...loadArmorNames(dir), ...monsters, ...actions],
    glossary: loadGlossaryRows(),
    conditions: loadConditionRows(dir),
  };
}
