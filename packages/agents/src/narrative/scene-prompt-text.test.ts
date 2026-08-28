// A guard, not a behaviour test. `SCENE_PROMPT_VERSION` is only useful if it
// actually changes when the prompt changes — mirrors
// `intent/prompt-text.test.ts` and `tactical/prompt-text.test.ts`.
//
// Only pins the strings this module owns. `HEBREW_GLOSSARY`, which
// `scene.ts` also puts in the cached static tier, already has its own pin in
// `narrative/prompt-text.test.ts` — pinning it a second time here would let
// one glossary edit trip two independent version bumps for the same change.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SCENE_PROMPT_VERSION, SCENE_SYSTEM_PROMPT } from "./scene-prompt-text.js";

/** Bump `SCENE_PROMPT_VERSION` and re-pin this together, never separately. */
const PINNED = {
  version: "scene-v1",
  sha256: "4efddcc5710e46e1efa74d8f3ac1f0d9a146f627166fad1e5fa5f3d700edc7ec",
};

describe("scene prompt version guard", () => {
  it("fails when the prompt is edited without bumping the version", () => {
    const actual = createHash("sha256").update(SCENE_SYSTEM_PROMPT, "utf8").digest("hex");
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
