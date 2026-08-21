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
      costUsd: 0.0022,
      costPerNarrationUsd: 0.0022,
      costIsUnderreported: false,
      cachedTokenShare: null,
    },
    ...overrides,
  };
}

describe("renderNarrativeMarkdown", () => {
  it("declares the cached-token-share gap unconditionally, even on a healthy run", () => {
    // Regression check for the review's finding 2: this sentence used to
    // live only inside the costIsUnderreported branch, which does not fire
    // here (costIsUnderreported: false) — so the healthy-run markdown said
    // nothing about the gap at all.
    const markdown = renderNarrativeMarkdown(report({ usage: { ...report().usage, costIsUnderreported: false } }));
    expect(markdown).toContain("Cached-token share: not reported");
    expect(markdown).not.toContain("Cost is under-reported");
  });

  it("still declares the cached-token-share gap, alongside the under-reported notice, on an unhealthy run", () => {
    const markdown = renderNarrativeMarkdown(
      report({ usage: { ...report().usage, costIsUnderreported: true } }),
    );
    expect(markdown).toContain("Cached-token share: not reported");
    expect(markdown).toContain("Cost is under-reported");
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
    expect(markdown).toMatch(/p50: \d+ ms \(exit criterion: < 1500 ms\) — errored samples excluded/);
    expect(markdown).toMatch(/p95: \d+ ms — errored samples excluded/);
  });

  it("annotates neither TTFT line when nothing errored", () => {
    const markdown = renderNarrativeMarkdown(report({ erroredSamples: 0 }));
    expect(markdown).not.toContain("errored samples excluded");
  });

  it("states the cost figure excludes cache-read tokens and is a lower bound, even on a healthy run", () => {
    // Regression check for finding 4: this used to say nothing about
    // cache-read exclusion at all, on a run where costIsUnderreported is
    // false — exactly the run this benchmark's own cache-stable prompt
    // produces in practice.
    const markdown = renderNarrativeMarkdown(
      report({ usage: { ...report().usage, costIsUnderreported: false } }),
    );
    expect(markdown).toContain("excludes cache-read tokens");
    expect(markdown).toContain("REGARDLESS");
  });

  it("calls out errored samples and excludes them from the discipline denominator", () => {
    // Regression check for finding 1's markdown-surfacing requirement: a
    // reader must never mistake an errored-stream count for a discipline
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

  it("writes both files, with erroredSamples and cachedTokenShare present in the JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "ai-dm-sim-narrative-"));
    const { jsonPath, markdownPath } = writeNarrativeReport(
      report({ samples: samplesWithErrors(5, 2), erroredSamples: 2 }),
      dir,
    );

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      erroredSamples: number;
      usage: { cachedTokenShare: null };
    };
    expect(parsed.erroredSamples).toBe(2);
    expect(parsed.usage.cachedTokenShare).toBeNull();
  });
});
