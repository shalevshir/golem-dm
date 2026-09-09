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

  // Anthropic bills a cache read at a tenth of the input rate and a cache
  // WRITE at one and a quarter times it. Summing them into `promptTokens`
  // would price a working cache as if it were a miss, and a miss as if it
  // were a hit — in opposite directions.
  it("prices Anthropic cache reads at the discounted rate", () => {
    // claude-sonnet-5: $2 per M input, $0.20 per M cache read.
    const cost = costUsd("claude-sonnet-5", {
      promptTokens: 0,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(0.2);
  });

  it("prices Anthropic cache writes at the premium rate", () => {
    const cost = costUsd("claude-sonnet-5", {
      promptTokens: 0,
      completionTokens: 0,
      cacheWritePromptTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(2.5);
  });

  // The bug this whole change exists to fix: a narration whose prefix was
  // served from cache reported 22 uncached prompt tokens, and pricing only
  // those understated the call by nearly two orders of magnitude.
  it("adds cache tokens to the uncached remainder rather than replacing it", () => {
    const cost = costUsd("claude-sonnet-5", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
      cacheWritePromptTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(2 + 0.2 + 2.5);
  });

  // Absent is not zero, and a model with no cache rates must not silently
  // price cache tokens at its full input rate either.
  it("ignores cache tokens for a model with no cache rates in the table", () => {
    const cost = costUsd("gemini-3-flash", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 5_000_000,
    });

    expect(cost).toBeCloseTo(0.25);
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
