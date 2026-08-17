import { describe, expect, it } from "vitest";
import { runSmoke } from "./run.js";

// Seed 1 over melee-brawl is pinned deliberately: it is the smallest config
// that draws all three legality outcomes in probe mode (firstTry: 7,
// afterRetry: 1, fallback: 2 — checked by hand and asserted individually
// below). `provider_error`, the only defect that routes straight to the
// deterministic fallback, sits at 3% of `nextDefect`'s table, so most seeds
// draw zero fallbacks over a corpus this size — seed 42 does, for instance.
const CONFIG = {
  mode: "both" as const,
  live: false,
  seeds: [1],
  scenarioIds: ["melee-brawl"],
};

describe("runSmoke", () => {
  it("produces a report with turns in both modes and no network", async () => {
    const report = await runSmoke({
      ...CONFIG,
      runId: "smoke-1",
      generatedAt: "T",
      gitCommit: "c",
    });

    expect(report.live).toBe(false);
    expect(report.arms).toHaveLength(1);
    expect(report.arms[0]?.probe.turns).toBeGreaterThan(0);
    expect(report.arms[0]?.encounter.turns).toBeGreaterThan(0);
  });

  it("exercises first-try, retry and fallback, not just the happy path", async () => {
    const report = await runSmoke({
      ...CONFIG,
      runId: "smoke-2",
      generatedAt: "T",
      gitCommit: "c",
    });
    const { legality } = report.arms[0]?.probe ?? { legality: undefined };

    // Checked individually, not just combined, so a seed that only ever
    // retries (and never falls back) cannot slip this assertion.
    expect(legality?.firstTry).toBeGreaterThan(0);
    expect(legality?.afterRetry).toBeGreaterThan(0);
    expect(legality?.fallback).toBeGreaterThan(0);

    // Pins Correction 1 / Task 12 Step 8: encounter mode's `beforeTurn` must
    // hand the runner the real board so a legal baseline can be scripted. A
    // regression to the pre-Step-8 shape (scripting from a null board) makes
    // every encounter turn fall straight to the deterministic fallback, which
    // still validates — so `encounter.turns > 0` alone would not catch it.
    // `firstTry > 0` here can only hold if a legal, non-fallback turn was
    // scripted from the actual board at least once.
    expect(report.arms[0]?.encounter.legality.firstTry).toBeGreaterThan(0);
  });

  it("is byte-identical across two runs, apart from the timestamp", async () => {
    const first = await runSmoke({
      ...CONFIG,
      runId: "same",
      generatedAt: "2026-08-17T00:00:00.000Z",
      gitCommit: "c",
    });
    const second = await runSmoke({
      ...CONFIG,
      runId: "same",
      generatedAt: "2026-08-17T00:00:00.000Z",
      gitCommit: "c",
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("uses an injected clock, so even latency is reproducible", async () => {
    const a = await runSmoke({ ...CONFIG, runId: "clock", generatedAt: "T", gitCommit: "c" });
    const b = await runSmoke({ ...CONFIG, runId: "clock", generatedAt: "T", gitCommit: "c" });

    expect(b.arms[0]?.probe.latency).toEqual(a.arms[0]?.probe.latency);
  });
});
