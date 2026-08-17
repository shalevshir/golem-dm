// A guard, not a behaviour test. `TACTICAL_PROMPT_VERSION` is only useful to
// step 7b if it actually changes when the prompt changes — a version someone
// forgets to bump is worse than no version at all, because it labels two
// different prompts identically in the benchmark data.
//
// So this pins a hash of every prompt string that reaches the model. Editing
// any of them fails this test, and the only way to make it pass is to bump the
// version and re-pin the hash. The hashing lives here rather than in the
// production module so `@ai-dm/agents` keeps no crypto dependency.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_RETRY_PREAMBLE,
  ENGINE_RETRY_PREAMBLE,
  TACTICAL_PROMPT_VERSION,
  TACTICAL_SYSTEM_PROMPT,
  TACTICAL_TOOL_DESCRIPTION,
  TACTICAL_TOOL_NAME,
} from "./prompt-text.js";

/** Every string this package sends to a model, in a fixed order. */
const PROMPT_SURFACE = [
  TACTICAL_TOOL_NAME,
  TACTICAL_TOOL_DESCRIPTION,
  TACTICAL_SYSTEM_PROMPT,
  ENGINE_RETRY_PREAMBLE,
  ADAPTER_RETRY_PREAMBLE,
].join(" ");

/** Bump `TACTICAL_PROMPT_VERSION` and re-pin this together, never separately. */
const PINNED = {
  version: "2026-08-17.1",
  sha256: "7302a999d33e87dbc16443c41d6706c051938803ef9d0f2a401c2ff9b17f54b1",
};

describe("prompt version guard", () => {
  it("fails when a prompt is edited without bumping the version", () => {
    const actual = createHash("sha256").update(PROMPT_SURFACE, "utf8").digest("hex");

    expect(actual).toBe(PINNED.sha256);
  });

  it("pins the hash against the version it was taken from", () => {
    expect(TACTICAL_PROMPT_VERSION).toBe(PINNED.version);
  });
});
