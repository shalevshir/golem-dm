// A drift guard, not a behaviour test. The digest is hand-written English
// summarising data that lives in `data/srd/conditions.json`; the failure
// that actually happens is a condition added to the data and forgotten in
// the prompt, so that is the direction this checks.
import { ConditionDefinition } from "@ai-dm/schemas";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULES_DIGEST, RULES_DIGEST_VERSION } from "./rules-digest.js";

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

// `JSON.parse`'s return type is `any`; routing it through a function whose
// declared return type is `unknown` (the same shape `srd.test.ts` uses) turns
// that into a type the schema below must actually validate, rather than an
// unchecked assignment eslint's `no-unsafe-assignment` would flag.
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Bump `RULES_DIGEST_VERSION` and re-pin this together, never separately. */
const PINNED = {
  version: "2026-08-21.1",
  sha256: "8fe368d941b6b21740837b90acb8f51634135c7e0c7ddb9068cbfb6e2036f20b",
};

describe("RULES_DIGEST", () => {
  it("names every condition the SRD data defines, each with its own dedicated line", () => {
    const path = repoFile(join("data", "srd", "conditions.json"));
    const rows = ConditionDefinition.array().parse(readJson(path));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Anchored on `- Name:` rather than a bare substring so a condition
      // demoted from its own bullet to a passing mention inside another
      // condition's line (as happened with Prone, Incapacitated, and
      // Poisoned here) still trips this guard.
      expect(RULES_DIGEST).toContain(`- ${row.nameEnglish}:`);
    }
  });

  it("is English only — no Hebrew reaches a cached prompt tier", () => {
    expect(RULES_DIGEST).not.toMatch(/[֐-׿]/);
  });

  it("pins the hash against the version it was taken from", () => {
    expect(RULES_DIGEST_VERSION).toBe(PINNED.version);
    expect(createHash("sha256").update(RULES_DIGEST).digest("hex")).toBe(PINNED.sha256);
  });
});
