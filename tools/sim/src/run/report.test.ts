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
    nonAttackActions: 0,
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

  it("sums nonAttackActions across a mode's records", () => {
    const report = buildReport({
      ...BASE,
      encounterRecords: [record({ nonAttackActions: 1 }), record({ nonAttackActions: 0 })],
    });

    expect(report.arms[0]?.encounter.nonAttackActions).toBe(1);
  });

  it("computes damage per round against the scripted control arm", () => {
    const report = buildReport({
      ...BASE,
      encounterRecords: [record()],
      encounters: [
        {
          armId: "gemini-3-flash@medium",
          scenarioId: "melee-brawl",
          seed: 1,
          winner: "hostile",
          rounds: 4,
          damageByFaction: { hostile: 20, party: 5 },
        },
        {
          armId: "gemini-3-flash@medium",
          scenarioId: "melee-brawl",
          seed: 2,
          winner: "party",
          rounds: 6,
          damageByFaction: { hostile: 10, party: 8 },
        },
      ],
    });

    // (20 + 10) / (4 + 6) = 3.
    expect(report.arms[0]?.damagePerRound).toBeCloseTo(3);
  });

  it("reports damagePerRound as null rather than dividing by zero when no rounds were played", () => {
    const report = buildReport({ ...BASE, encounterRecords: [record()] });

    expect(report.arms[0]?.damagePerRound).toBeNull();
  });

  it("carries the raw per-turn records, split by mode, so a run can be decomposed by scenario or seed", () => {
    const probe = record({ scenarioId: "melee-brawl", seed: 1 });
    const encounter = record({ scenarioId: "ogre-charge", seed: 2 });
    const report = buildReport({ ...BASE, probeRecords: [probe], encounterRecords: [encounter] });

    expect(report.records.probe).toEqual([probe]);
    expect(report.records.encounter).toEqual([encounter]);
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

  it("renders non-attack actions and damage per round in the encounter table", () => {
    const markdown = renderMarkdown(
      buildReport({
        ...BASE,
        encounterRecords: [record({ nonAttackActions: 1 })],
        encounters: [
          {
            armId: "gemini-3-flash@medium",
            scenarioId: "melee-brawl",
            seed: 1,
            winner: "hostile",
            rounds: 2,
            damageByFaction: { hostile: 8, party: 0 },
          },
        ],
      }),
    );

    expect(markdown).toContain("Non-attack actions");
    expect(markdown).toContain("Dmg/round");
    expect(markdown).toContain("4.0");
  });
});

// Each caveat below is pinned to a substring distinctive enough that it
// cannot be satisfied by unrelated text elsewhere in the document — a plain
// "smoke" or "encounter-only" alone is too easy to keep alive by accident
// (e.g. the header's `- Mode: **smoke ...**` line already contains "smoke").
// If a later edit deletes the sentence carrying a caveat, one of these should
// fail even if some other, unrelated word happens to survive nearby.
describe("renderMarkdown — fidelity caveats", () => {
  it("names the exact legality column, not its position, next to the 95% bar", () => {
    const markdown = renderMarkdown(buildReport({ ...BASE, probeRecords: [record()] }));

    expect(markdown).toContain('Read it from the "Legal after retry" column');
  });

  it("warns that probe-mode legality is measured on the scripted baseline's distribution", () => {
    const markdown = renderMarkdown(buildReport({ ...BASE, probeRecords: [record()] }));

    expect(markdown).toContain("not from the states a model would actually drive itself into");
  });

  it("says smoke numbers verify the pipeline, not a model's tactical quality", () => {
    const markdown = renderMarkdown(buildReport({ ...BASE, probeRecords: [record()] }));

    expect(markdown).toContain("scripted policy with a seeded defect");
  });

  it("labels unresolved-action data as encounter-only when encounter mode ran", () => {
    const markdown = renderMarkdown(
      buildReport({ ...BASE, probeRecords: [record()], encounterRecords: [record()] }),
    );

    expect(markdown).toContain('"Unresolved actions" is **encounter-only**');
  });

  it("states Dodge has no mechanical effect when encounter mode ran", () => {
    const markdown = renderMarkdown(
      buildReport({ ...BASE, probeRecords: [record()], encounterRecords: [record()] }),
    );

    expect(markdown).toContain("**Dodge has no mechanical effect**");
  });

  it("declares the resolver's normal-mode-only and dropped-swing gaps when encounter mode ran", () => {
    const markdown = renderMarkdown(
      buildReport({ ...BASE, probeRecords: [record()], encounterRecords: [record()] }),
    );

    expect(markdown).toContain("condition-driven advantage or disadvantage is never applied");
    expect(markdown).toContain("dropped rather than redirected to a new target");
  });

  it("suppresses the encounter table rather than inventing zeros for a probe-only run", () => {
    const markdown = renderMarkdown(buildReport({ ...BASE, probeRecords: [record()] }));

    expect(markdown).toContain("Encounter mode was not run in this session");
    expect(markdown).not.toContain("Unresolved actions |");
  });

  it("suppresses the probe table rather than inventing zeros for an encounter-only run", () => {
    const markdown = renderMarkdown(buildReport({ ...BASE, encounterRecords: [record()] }));

    expect(markdown).toContain("Probe mode was not run in this session");
    expect(markdown).not.toContain("Tokens/turn |");
  });
});
