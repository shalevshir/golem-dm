import { ExecuteTurn } from "@ai-dm/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolJsonSchema } from "./tool-schema.js";

describe("toolJsonSchema", () => {
  // Mirrors the round-trip test in packages/schemas/src/index.test.ts, but
  // against the tool the tactical agent actually calls.
  it("exports ExecuteTurn as a JSON schema usable as a tool definition", () => {
    const schema = toolJsonSchema(ExecuteTurn, "ExecuteTurn");

    expect(schema).toHaveProperty("$ref", "#/definitions/ExecuteTurn");
    expect(JSON.stringify(schema)).toContain("tacticalRationaleEnglish");
    expect(JSON.stringify(schema)).toContain("mainAction");
  });

  it("names the definition after the tool", () => {
    const schema = toolJsonSchema(z.object({ actorId: z.string() }), "execute_turn");

    expect(schema).toHaveProperty("$ref", "#/definitions/execute_turn");
  });

  it("carries the field constraints the model must respect", () => {
    // Spell slots are 1..9 in the schema; a tool definition that drops the
    // bounds invites proposals the engine will only reject later.
    expect(JSON.stringify(toolJsonSchema(ExecuteTurn, "ExecuteTurn"))).toContain('"maximum":9');
  });
});
