import { describe, expect, it } from "vitest";
import { NarrativeEmittedPayload } from "./events.js";

describe("NarrativeEmittedPayload", () => {
  const valid = {
    actorId: "hero",
    streamId: "s-1",
    text: "אלדד מתקדם.",
    source: "model",
    promptVersion: "2026-08-21.1",
  };

  it("accepts a well-formed payload", () => {
    expect(NarrativeEmittedPayload.parse(valid).source).toBe("model");
  });

  it("rejects a source outside the three the pipeline can produce", () => {
    expect(() => NarrativeEmittedPayload.parse({ ...valid, source: "guess" })).toThrow();
  });

  it("rejects empty narration text", () => {
    expect(() => NarrativeEmittedPayload.parse({ ...valid, text: "" })).toThrow();
  });
});
