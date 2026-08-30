// A guard, not a behaviour test. `SUMMARY_PROMPT_VERSION` is only useful if
// it actually changes when the prompt changes — mirrors
// `narrative/scene-prompt-text.test.ts`.
//
// Hashes the WHOLE cached `static` tier `buildSummaryPrompt` sends to the
// model. Unlike the scene prompt, that tier is just `SUMMARY_SYSTEM_PROMPT`
// — a summary call shares no cacheable prefix with the next one, so there is
// no glossary to fold in here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SUMMARY_PROMPT_VERSION, SUMMARY_SYSTEM_PROMPT } from "./prompt-text.js";

/** Every string `buildSummaryPrompt` puts in the cached `static` tier. */
const PROMPT_SURFACE = SUMMARY_SYSTEM_PROMPT;

/** Bump `SUMMARY_PROMPT_VERSION` and re-pin this together, never separately. */
const PINNED = {
  version: "summary-v1",
  sha256: "4c730a164115492e3a026466988b1efd1c5a2f9d679081d3b9e599cc60855e3b",
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
