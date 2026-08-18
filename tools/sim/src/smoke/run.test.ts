import { describe, expect, it } from "vitest";
import { runSmoke } from "./run.js";

// Seed 1 over melee-brawl is pinned deliberately: it is the smallest config
// that draws all three legality outcomes in probe mode (firstTry: 7,
// afterRetry: 1, fallback: 2 — checked by hand and asserted exactly below,
// not just individually). `provider_error`, the only defect that routes
// straight to the deterministic fallback, sits at 3% of `nextDefect`'s
// table, so most seeds draw zero fallbacks over a corpus this size — seed 42
// does, for instance. Encounter mode over the same seed and scenario draws
// firstTry: 9, afterRetry: 1, fallback: 0 (also checked by hand). Asserting
// exact counts, not just `> 0`, pins the metrics arithmetic itself rather
// than merely proving the pipeline starts — a fold that silently dropped or
// double-counted a turn would not trip a `> 0` check but does trip this one.
const CONFIG = {
  mode: "both" as const,
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

    // Exact, not just `> 0`: pins the metrics arithmetic rather than merely
    // proving the process starts (spec §5). A seed that only ever retries
    // (and never falls back) would still fail this, same as before.
    expect(legality?.firstTry).toBe(7);
    expect(legality?.afterRetry).toBe(1);
    expect(legality?.fallback).toBe(2);

    // Pins Correction 1 / Task 12 Step 8: encounter mode's `beforeTurn` must
    // hand the runner the real board so a legal baseline can be scripted. A
    // regression to the pre-Step-8 shape (scripting from a null board) makes
    // every encounter turn fall straight to the deterministic fallback, which
    // still validates — so `encounter.turns > 0` alone would not catch it.
    // Exact counts catch it more precisely than `firstTry > 0` did: any
    // regression that changes how many turns land on each outcome trips this.
    const encounterLegality = report.arms[0]?.encounter.legality;
    expect(encounterLegality?.firstTry).toBe(9);
    expect(encounterLegality?.afterRetry).toBe(1);
    expect(encounterLegality?.fallback).toBe(0);
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
