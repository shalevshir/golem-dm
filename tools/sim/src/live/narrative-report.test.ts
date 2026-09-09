import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NarrativeSample } from "./narrative.js";
import type { NarrativeRunReport } from "./narrative-report.js";
import { renderNarrativeMarkdown, writeNarrativeReport } from "./narrative-report.js";

function sample(overrides: Partial<NarrativeSample> = {}): NarrativeSample {
  return {
    source: {
      actor: { nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] },
      actorSide: "party",
      beats: [{ kind: "hold" }],
      pulse: { hostilesStanding: 1, heroBand: "healthy" },
      sceneEnglish: "test scene",
      recentNarrations: [],
    },
    beatsEnglish: "holds position",
    hebrew: "",
    ttftMs: 0,
    digitViolation: false,
    nonHebrew: false,
    overLength: false,
    ...overrides,
  };
}

/** N minimal samples, `count` of them errored — for markdown/writer tests, where content does not matter but the sample/erroredSamples ratio must be realistic. */
function samplesWithErrors(total: number, erroredCount: number): NarrativeSample[] {
  return Array.from({ length: total }, (_, index) =>
    index < erroredCount ? sample({ errorCode: "provider_error" }) : sample(),
  );
}

function report(overrides: Partial<NarrativeRunReport> = {}): NarrativeRunReport {
  return {
    runId: "smoke-narrative-test",
    generatedAt: "2026-08-21T00:00:00.000Z",
    gitCommit: "abc1234",
    promptVersion: "2026-08-21.1",
    live: false,
    samples: [],
    ttftMsP50: 500,
    ttftMsP95: 900,
    digitViolations: 0,
    nonHebrewOutputs: 0,
    overLengthOutputs: 0,
    erroredSamples: 0,
    usage: {
      promptTokens: 900,
      completionTokens: 40,
      cachedPromptTokens: 1800,
      cacheWritePromptTokens: 0,
      costUsd: 0.0022,
      costPerNarrationUsd: 0.0022,
      costIsUnderreported: false,
      cachedTokenShare: 0.9,
    },
    ...overrides,
  };
}

describe("renderNarrativeMarkdown", () => {
  // This used to assert the opposite — that the markdown declared the share
  // as unmeasurable — because no adapter surfaced a cache-read count. It does
  // now, so the report states the measured share instead of the gap.
  it("reports the measured cached-token share on a healthy run", () => {
    const markdown = renderNarrativeMarkdown(
      report({ usage: { ...report().usage, costIsUnderreported: false } }),
    );
    expect(markdown).toContain("Cached-token share: 90.0%");
    expect(markdown).not.toContain("Cost is under-reported");
  });

  // Reads and writes bill in opposite directions, so a summed "prompt tokens"
  // line would make a prefix written on every call look like one being reused.
  it("breaks cache reads and writes out from the uncached prompt tokens", () => {
    const markdown = renderNarrativeMarkdown(
      report({
        usage: { ...report().usage, cachedPromptTokens: 0, cacheWritePromptTokens: 1800 },
      }),
    );
    expect(markdown).toContain("Cache reads: 0 prompt tokens");
    expect(markdown).toContain("Cache writes: 1800 prompt tokens");
    expect(markdown).toContain("Prompt tokens: 900 uncached");
  });

  it("says n/a for the share when nothing was counted, never 0%", () => {
    const markdown = renderNarrativeMarkdown(
      report({ usage: { ...report().usage, cachedTokenShare: null } }),
    );
    expect(markdown).toContain("Cached-token share: n/a");
    expect(markdown).not.toContain("Cached-token share: 0.0%");
  });

  it("says nothing about provider errors when there were none", () => {
    const markdown = renderNarrativeMarkdown(report({ erroredSamples: 0 }));
    expect(markdown).not.toContain("provider error");
  });

  it("annotates p95 the same way it annotates p50 when samples errored", () => {
    // Regression check: the annotation used to suffix only the p50 line,
    // wrongly implying p95 was computed from every sample including the
    // errored ones. Both are computed from the identical ttftValues array.
    const markdown = renderNarrativeMarkdown(
      report({ samples: samplesWithErrors(9, 2), erroredSamples: 2 }),
    );
    expect(markdown).toMatch(
      /p50: \d+ ms \(exit criterion: < 1500 ms\) — errored samples excluded/,
    );
    expect(markdown).toMatch(/p95: \d+ ms — errored samples excluded/);
  });

  it("annotates neither TTFT line when nothing errored", () => {
    const markdown = renderNarrativeMarkdown(report({ erroredSamples: 0 }));
    expect(markdown).not.toContain("errored samples excluded");
  });

  it("calls out errored samples and excludes them from the discipline denominator", () => {
    // A reader must never mistake an errored-stream count for a discipline
    // failure under the "any non-zero count is a prompt bug" line.
    const markdown = renderNarrativeMarkdown(
      report({
        samples: samplesWithErrors(9, 3),
        erroredSamples: 3,
        digitViolations: 0,
        nonHebrewOutputs: 0,
        overLengthOutputs: 0,
      }),
    );
    expect(markdown).toMatch(/3 \/ 9 streams ended in a.*provider error/s);
    expect(markdown).toContain("not about the prompt");
  });
});

describe("writeNarrativeReport", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes both files, with erroredSamples and the measured cache counts in the JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "ai-dm-sim-narrative-"));
    const { jsonPath, markdownPath } = writeNarrativeReport(
      report({ samples: samplesWithErrors(5, 2), erroredSamples: 2 }),
      dir,
    );

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      erroredSamples: number;
      usage: { cachedTokenShare: number | null; cachedPromptTokens: number };
    };
    expect(parsed.erroredSamples).toBe(2);
    // A measured share, where this used to assert `null` for "unmeasurable".
    expect(parsed.usage.cachedTokenShare).toBeCloseTo(0.9);
    expect(parsed.usage.cachedPromptTokens).toBe(1800);
  });
});
