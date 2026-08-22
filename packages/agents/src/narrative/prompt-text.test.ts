// Two guards, no behaviour. The hash pin does for the narrative prompt what
// `tactical/prompt-text.test.ts` does for the tactical one. The parity check
// is the price of keeping `hebrew-glossary.md` editable by a non-programmer
// while the package stays free of runtime file I/O.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULES_DIGEST } from "../rules-digest.js";
import {
  GLOSSARY_TERMS,
  HEBREW_GLOSSARY,
  NARRATIVE_PROMPT_VERSION,
  NARRATIVE_SYSTEM_PROMPT,
} from "./prompt-text.js";

function repoFile(relativePath: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${relativePath} above this file`);
    dir = parent;
  }
}

/** Bump `NARRATIVE_PROMPT_VERSION` and re-pin this together, never separately. */
const PINNED = {
  version: "2026-08-21.1",
  sha256: "a687941d2e527e35d23f7ffadebf55e8fac274f20b812b784dbef126b9e0b4d0",
};

describe("narrative prompt text", () => {
  it("pins the hash against the version it was taken from", () => {
    expect(NARRATIVE_PROMPT_VERSION).toBe(PINNED.version);
    // RULES_DIGEST is folded into this hash too, even though it already has
    // its own pin in rules-digest.test.ts: prompt.ts's buildNarrativePrompt
    // puts it in the SAME cached `static` tier as NARRATIVE_SYSTEM_PROMPT
    // and HEBREW_GLOSSARY. If it were left out here, editing the digest
    // would trip only RULES_DIGEST_VERSION — NARRATIVE_PROMPT_VERSION (and
    // every narrative_emitted.promptVersion and benchmark report keyed on
    // it) would stay stale even though the cached prefix the model actually
    // sees had just changed, silently pooling runs across the edit.
    const combined = `${NARRATIVE_SYSTEM_PROMPT}\n${HEBREW_GLOSSARY}\n${RULES_DIGEST}`;
    expect(createHash("sha256").update(combined).digest("hex")).toBe(PINNED.sha256);
  });

  it("keeps the system prompt English — Hebrew in a cached tier is invariant 2's line", () => {
    expect(NARRATIVE_SYSTEM_PROMPT).not.toMatch(/[֐-׿]/);
  });

  it("tells the model to end on a full stop, which truncation detection depends on", () => {
    expect(NARRATIVE_SYSTEM_PROMPT).toContain("full stop");
  });

  it("matches docs/prompts/hebrew-glossary.md row for row", () => {
    const markdown = readFileSync(repoFile(join("docs", "prompts", "hebrew-glossary.md")), "utf8");
    const rows = markdown
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.includes("---") && !line.includes("English"))
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        return { english: cells[1] ?? "", hebrew: cells[2] ?? "" };
      });

    expect(rows.length).toBeGreaterThan(0);
    expect(GLOSSARY_TERMS).toEqual(rows);
    for (const term of rows) expect(HEBREW_GLOSSARY).toContain(term.hebrew);
  });
});
