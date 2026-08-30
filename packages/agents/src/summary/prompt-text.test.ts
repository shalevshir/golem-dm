// A guard, not a behaviour test. `SUMMARY_PROMPT_VERSION` is only useful if
// it actually changes when the prompt changes — mirrors
// `narrative/scene-prompt-text.test.ts`.
//
// Hashes every fixed string `buildSummaryPrompt` sends to the model, not just
// `SUMMARY_SYSTEM_PROMPT`'s `static` tier: `SUMMARY_TASK_HEADING`,
// `SUMMARY_FACTS_HEADING` and `SUMMARY_NARRATION_HEADING` all land in the
// `dynamic` tier on every call. Pinning only the system prompt would let a
// heading edit change what the model sees while `SUMMARY_PROMPT_VERSION`
// stayed stale — the exact failure mode `scene-prompt-text.test.ts` warns
// about for `HEBREW_GLOSSARY`. Order is declaration order, i.e. the order
// `buildSummaryPrompt` itself appends them in.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SUMMARY_FACTS_HEADING,
  SUMMARY_NARRATION_HEADING,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_TASK_HEADING,
} from "./prompt-text.js";

/** Every fixed string `buildSummaryPrompt` sends to the model. */
const PROMPT_SURFACE = [
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_TASK_HEADING,
  SUMMARY_FACTS_HEADING,
  SUMMARY_NARRATION_HEADING,
].join("\n");

/** Bump `SUMMARY_PROMPT_VERSION` and re-pin this together, never separately. */
const PINNED = {
  version: "summary-v1",
  sha256: "ce52fe85176c1577ea755bd6d38ad567d542c175e115c9212411ad4b7cfa9e02",
};

describe("summary prompt version guard", () => {
  it("fails when the prompt is edited without bumping the version", () => {
    const actual = createHash("sha256").update(PROMPT_SURFACE, "utf8").digest("hex");
    expect(actual).toBe(PINNED.sha256);
  });

  it("pins the hash against the version it was taken from", () => {
    expect(SUMMARY_PROMPT_VERSION).toBe(PINNED.version);
  });

  it("keeps the system prompt English — Hebrew in a cached tier is invariant 2's line", () => {
    expect(SUMMARY_SYSTEM_PROMPT).not.toMatch(/[֐-׿]/);
  });

  it("tells the model to write English only, not translate the Hebrew narration", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("ENGLISH only");
  });
});
