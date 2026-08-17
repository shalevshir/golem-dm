import { describe, expect, it } from "vitest";
import { MODEL_PRICING, PRICING_TABLE_DATE, costUsd } from "./pricing.js";

describe("costUsd", () => {
  it("prices a known model from the dated table", () => {
    // gemini-3-flash: $0.25 per M input, $1.50 per M output.
    const cost = costUsd("gemini-3-flash", { promptTokens: 1_000_000, completionTokens: 0 });

    expect(cost).toBeCloseTo(0.25);
  });

  it("adds input and output at their separate rates", () => {
    const cost = costUsd("gemini-3-flash", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(1.75);
  });

  it("returns null for an unpriced model instead of guessing zero", () => {
    expect(
      costUsd("some-unreleased-model", { promptTokens: 1000, completionTokens: 10 }),
    ).toBeNull();
  });

  it("carries a table date, so a stale price is visible in the report", () => {
    expect(PRICING_TABLE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(MODEL_PRICING).length).toBeGreaterThan(0);
  });
});
