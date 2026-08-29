// A guard, not a behaviour test. `SCENE_PROMPT_VERSION` is only useful if it
// actually changes when the prompt changes — mirrors
// `intent/prompt-text.test.ts` and `tactical/prompt-text.test.ts`.
//
// Hashes the WHOLE cached `static` tier `buildScenePrompt` sends to the
// model — `SCENE_SYSTEM_PROMPT` AND `HEBREW_GLOSSARY` — even though
// `HEBREW_GLOSSARY` already has its own pin in `narrative/prompt-text.test.ts`.
// `narrative/prompt-text.test.ts` folds `RULES_DIGEST` into its own hash for
// the identical reason despite `RULES_DIGEST` also having its own pin: two
// version bumps for one glossary edit is correct, because both prompts
// actually changed. Pinning only this file's own string would let a glossary
// edit change what the model sees while `SCENE_PROMPT_VERSION` — and every
// `narrative_emitted.promptVersion` keyed on it — stayed stale.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HEBREW_GLOSSARY } from "./prompt-text.js";
import { SCENE_PROMPT_VERSION, SCENE_SYSTEM_PROMPT } from "./scene-prompt-text.js";

/** Every string `buildScenePrompt` puts in the cached `static` tier. */
const PROMPT_SURFACE = `${SCENE_SYSTEM_PROMPT}\n${HEBREW_GLOSSARY}`;

/** Bump `SCENE_PROMPT_VERSION` and re-pin this together, never separately. */
const PINNED = {
  version: "scene-v1",
  sha256: "15968546114cb7e3fabc5554048cc8db1f81b3b72c8b31b3424eea6485dca0b6",
};

describe("scene prompt version guard", () => {
  it("fails when the prompt is edited without bumping the version", () => {
    const actual = createHash("sha256").update(PROMPT_SURFACE, "utf8").digest("hex");
    expect(actual).toBe(PINNED.sha256);
  });

  it("pins the hash against the version it was taken from", () => {
    expect(SCENE_PROMPT_VERSION).toBe(PINNED.version);
  });

  it("keeps the system prompt English — Hebrew in a cached tier is invariant 2's line", () => {
    expect(SCENE_SYSTEM_PROMPT).not.toMatch(/[֐-׿]/);
  });

  it("tells the model to end on a full stop, which truncation detection depends on", () => {
    expect(SCENE_SYSTEM_PROMPT).toContain("full stop");
  });
});
