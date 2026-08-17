import { describe, expect, it } from "vitest";
import type { TurnRecord } from "./records.js";
import { percentile, summariseLatency, summariseLegality, summariseUsage } from "./metrics.js";

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    armId: "fake@medium",
    scenarioId: "melee-brawl",
    seed: 1,
    round: 1,
    actorId: "goblin_1",
    outcome: "model",
    attempts: 1,
    rejectionReasons: [],
    adapterErrorCodes: [],
    promptTokens: 1000,
    completionTokens: 50,
    usageComplete: true,
    attemptsMissingUsage: 0,
    durationMs: 100,
    callDurationsMs: [100],
    unresolvedActionIds: [],
    ...overrides,
  };
}

describe("percentile", () => {
  it("uses nearest-rank on sorted values", () => {
    const values = Array.from({ length: 100 }, (_unused, index) => index + 1);

    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
  });

  it("returns 0 for an empty sample rather than NaN", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("ignores input order", () => {
    // p50 on this array happens to land on index 2 whether sorted or not
    // ([9,1,5,3,7][2] === 5 === sorted[2]), so it wouldn't catch a version
    // that skipped the sort. p20 diverges: sorted -> 1, raw order -> 9.
    expect(percentile([9, 1, 5, 3, 7], 20)).toBe(1);
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
  });
});

describe("summariseLegality", () => {
  it("counts each outcome and rates the step-7 bar against retry", () => {
    const records = [
      ...Array.from({ length: 90 }, () => record({ outcome: "model" })),
      ...Array.from({ length: 6 }, () => record({ outcome: "retry" })),
      ...Array.from({ length: 3 }, () => record({ outcome: "fallback" })),
      record({ outcome: "no_legal_turn" }),
    ];

    const summary = summariseLegality(records);

    expect(summary.total).toBe(100);
    expect(summary.firstTry).toBe(90);
    expect(summary.afterRetry).toBe(6);
    expect(summary.fallback).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.firstTryRate).toBeCloseTo(0.9);
    // The exit criterion: legal without needing the fallback.
    expect(summary.legalAfterRetryRate).toBeCloseTo(0.96);
  });

  it("reports zero rates for an empty sample rather than NaN", () => {
    expect(summariseLegality([]).firstTryRate).toBe(0);
  });
});

describe("summariseLatency", () => {
  it("summarises per-turn duration", () => {
    const records = Array.from({ length: 100 }, (_unused, index) =>
      record({ durationMs: index + 1 }),
    );
    const summary = summariseLatency(records);

    expect(summary.p50Ms).toBe(50);
    expect(summary.p95Ms).toBe(95);
    expect(summary.meanMs).toBeCloseTo(50.5);
  });
});

describe("summariseUsage", () => {
  it("averages tokens per turn", () => {
    const summary = summariseUsage([record(), record({ promptTokens: 2000 })]);

    expect(summary.promptTokens).toBe(3000);
    expect(summary.completionTokens).toBe(100);
    // (promptTokens + completionTokens) / records.length = (3000 + 100) / 2.
    expect(summary.tokensPerTurn).toBeCloseTo(1550);
  });

  it("declares incompleteness rather than hiding it", () => {
    const summary = summariseUsage([
      record(),
      record({ usageComplete: false, attemptsMissingUsage: 2 }),
    ]);

    expect(summary.usageComplete).toBe(false);
    expect(summary.attemptsMissingUsage).toBe(2);
  });
});
