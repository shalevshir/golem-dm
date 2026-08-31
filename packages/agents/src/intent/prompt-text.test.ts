// A guard, not a behaviour test. `INTENT_PROMPT_VERSION` is only useful to
// step 7b — and to `IntentClassifiedPayload.promptVersion`, which lands in
// the append-only, unrepairable event log — if it actually changes when the
// prompt changes. A version someone forgets to bump is worse than no version
// at all, because it labels two different prompts identically in the log.
// Mirrors `tactical/prompt-text.test.ts`.
//
// So this pins a hash of every prompt string that reaches the model. Editing
// any of them fails this test, and the only way to make it pass is to bump the
// version and re-pin the hash. The hashing lives here rather than in the
// production module so `@ai-dm/agents` keeps no crypto dependency.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INTENT_PROMPT_VERSION,
  INTENT_SYSTEM_PROMPT,
  INTENT_TOOL_DESCRIPTION,
  INTENT_TOOL_NAME,
} from "./prompt-text.js";

/** Every string this package sends to a model, in a fixed order. */
const PROMPT_SURFACE = [INTENT_TOOL_NAME, INTENT_TOOL_DESCRIPTION, INTENT_SYSTEM_PROMPT].join(" ");

/** Bump `INTENT_PROMPT_VERSION` and re-pin this together, never separately. */
const PINNED = {
  version: "intent-v2",
  sha256: "9a71518230266332e53b0f320a8d6e80d814146c8f29df40c93a1a6b54daeca7",
};

describe("prompt version guard", () => {
  it("fails when a prompt is edited without bumping the version", () => {
    const actual = createHash("sha256").update(PROMPT_SURFACE, "utf8").digest("hex");

    expect(actual).toBe(PINNED.sha256);
  });

  it("pins the hash against the version it was taken from", () => {
    expect(INTENT_PROMPT_VERSION).toBe(PINNED.version);
  });
});
