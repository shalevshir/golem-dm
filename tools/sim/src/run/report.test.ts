import { describe, expect, it } from "vitest";
import type { TurnRecord } from "./records.js";
import { buildReport, renderMarkdown } from "./report.js";

function record(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    armId: "gemini-3-flash@medium",
    scenarioId: "melee-brawl",
    seed: 1,
    round: 1,
    actorId: "goblin_1",
    outcome: "model",
    attempts: 1,
    rejectionReasons: [],
    adapterErrorCodes: [],
    promptTokens: 1_000_000,
    completionTokens: 0,
    usageComplete: true,
    attemptsMissingUsage: 0,
    durationMs: 100,
    callDurationsMs: [100],
    unresolvedActionIds: [],
    ...overrides,
  };
}

const BASE = {
  runId: "test-run",
  generatedAt: "2026-08-17T00:00:00.000Z",
  gitCommit: "abc1234",
  promptVersion: "2026-08-17.1",
  live: false,
  seeds: [1],
  scenarioIds: ["melee-brawl"],
  encounters: [],
};

describe("buildReport", () => {
  it("summarises one arm and prices it from the dated table", () => {
    const report = buildReport({ ...BASE, probeRecords: [record()] });
    const arm = report.arms[0];

    expect(arm?.armId).toBe("gemini-3-flash@medium");
    expect(arm?.probe.legality.firstTry).toBe(1);
    expect(arm?.probe.costUsd).toBeCloseTo(0.25);
  });

  it("marks an unpriced model rather than reporting it as free", () => {
    const report = buildReport({
      ...BASE,
      probeRecords: [record({ armId: "mystery-model@low" })],
    });

    expect(report.arms[0]?.probe.costUsd).toBeNull();
  });

  it("flags under-reported usage instead of publishing a silent lower bound", () => {
    const report = buildReport({
      ...BASE,
      probeRecords: [record({ usageComplete: false, attemptsMissingUsage: 3 })],
    });

    expect(report.arms[0]?.probe.usage.usageComplete).toBe(false);
    expect(report.costIsUnderreported).toBe(true);
  });

  it("carries provenance so two runs are never pooled by accident", () => {
    const report = buildReport({ ...BASE, probeRecords: [record()] });

    expect(report.promptVersion).toBe("2026-08-17.1");
    expect(report.gitCommit).toBe("abc1234");
    expect(report.pricingTableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("renderMarkdown", () => {
  it("names the prompt version, the mode and the legality bar", () => {
    const markdown = renderMarkdown(buildReport({ ...BASE, probeRecords: [record()] }));

    expect(markdown).toContain("2026-08-17.1");
    expect(markdown).toContain("gemini-3-flash@medium");
    expect(markdown).toContain("smoke");
  });

  it("says so loudly when cost is under-reported", () => {
    const markdown = renderMarkdown(
      buildReport({
        ...BASE,
        probeRecords: [record({ usageComplete: false, attemptsMissingUsage: 2 })],
      }),
    );

    expect(markdown).toContain("under-reported");
  });

  it("prints unpriced rather than a zero cost", () => {
    const markdown = renderMarkdown(
      buildReport({ ...BASE, probeRecords: [record({ armId: "mystery-model@low" })] }),
    );

    expect(markdown).toContain("unpriced");
  });
});
