import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adapterFailure, adapterSuccess } from "./errors.js";

// These construct concrete AdapterSuccess/AdapterFailure values, so no `.ok`
// narrowing is needed here. Narrowing across the union is exercised where it
// actually matters: results returned from a port, in runtime and vercel tests.
describe("adapterSuccess", () => {
  it("wraps a value in a success result", () => {
    const result = adapterSuccess({ actorId: "gob-2" });

    expect(result.ok).toBe(true);
    expect(result.value.actorId).toBe("gob-2");
  });
});

describe("adapterFailure", () => {
  it("carries a stable machine-readable code", () => {
    const result = adapterFailure("provider_error", "Anthropic returned 529.");

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("provider_error");
    expect(result.error.message).toBe("Anthropic returned 529.");
  });

  it("omits diagnostics that were not supplied", () => {
    const result = adapterFailure("no_tool_call", "Model returned prose, not a tool call.");

    expect(result.error.issues).toBeUndefined();
    expect(result.error.cause).toBeUndefined();
  });

  it("carries zod issues so the step 7 retry can quote them back", () => {
    const parsed = z.object({ actorId: z.string() }).safeParse({ actorId: 7 });
    if (parsed.success) throw new Error("fixture should not parse");

    const result = adapterFailure("schema_validation_failed", "Tool call did not match.", {
      issues: parsed.error.issues,
    });

    expect(result.error.issues?.[0]?.path).toStrictEqual(["actorId"]);
  });

  it("keeps the underlying error as a cause for logging", () => {
    const cause = new Error("socket hang up");
    const result = adapterFailure("provider_error", "Transport failed.", { cause });

    expect(result.error.cause).toBe(cause);
  });

  it("is an error value, never a thrown string", () => {
    expect(() => adapterFailure("aborted", "Turn timed out.")).not.toThrow();
  });
});

describe("adapterFailure usage", () => {
  it("carries usage for an attempt that was billed but produced nothing usable", () => {
    const failure = adapterFailure("no_tool_call", "The model answered without calling the tool.", {
      usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
    });

    expect(failure.error.usage).toEqual({
      promptTokens: 900,
      completionTokens: 40,
      totalTokens: 940,
    });
  });

  it("omits the key entirely when the provider reported no usage", () => {
    const failure = adapterFailure("provider_error", "Provider call failed: boom");

    expect("usage" in failure.error).toBe(false);
  });
});
