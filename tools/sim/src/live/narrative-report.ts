// Markdown rendering and disk-writing for a narrative benchmark run. Kept
// beside `narrative.ts` rather than folded into `run/report.ts`: that file's
// `RunReport`/`renderMarkdown` are shaped around the tactical arm matrix
// (arms, encounters, legality), which narrative mode has none of — only the
// low-level "write JSON + markdown under runsDir/<runId>/" plumbing is
// actually shared, and that lives in `writeRunArtifacts`.
import { writeRunArtifacts } from "../run/report.js";
import type { NarrativeReport } from "./narrative.js";

export interface NarrativeRunReport extends NarrativeReport {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  promptVersion: string;
  live: boolean;
}

/**
 * A cache count, or an explicit "not reported" when the provider said nothing
 * about caching. Never printed as 0, which would claim a measured miss for a
 * provider that may well be serving a cached prefix it folds into its own
 * prompt count.
 */
function tokensOrNotReported(tokens: number | null): string {
  return tokens === null ? "not reported by this provider" : `${String(tokens)} prompt tokens`;
}

/**
 * A share as a percentage, or an explanation of why there is none. Never
 * printed as 0%, which would claim a measured cache miss.
 *
 * Two different nulls reach here and they mean opposite things: the provider
 * reported no cache accounting at all, or it did and there were no prompt
 * tokens to divide (every sample errored). One message for both told the
 * reader the run was empty when the run was fine and the provider was silent,
 * so the caller passes which it was.
 */
function percentOrNa(share: number | null, reported: boolean): string {
  if (share !== null) return `${(share * 100).toFixed(1)}%`;
  return reported ? "n/a (no prompt tokens counted)" : "n/a (not reported by this provider)";
}

function money(value: number | null): string {
  return value === null ? "unpriced" : `$${value.toFixed(4)}`;
}

/**
 * Minimal by design: aggregate stats a human can read at a glance. The
 * per-sample review — English beats next to Hebrew text, for a native
 * speaker — is task 16's `renderReviewSheet`, built from this same report's
 * `samples`, not duplicated here.
 */
export function renderNarrativeMarkdown(report: NarrativeRunReport): string {
  const lines: string[] = [];

  lines.push(`# Narrative benchmark — ${report.runId}`);
  lines.push("");
  lines.push(`- Mode: **${report.live ? "live" : "smoke (scripted port, no network)"}**`);
  lines.push(`- Prompt version: \`${report.promptVersion}\``);
  lines.push(`- Commit: \`${report.gitCommit}\``);
  lines.push(`- Generated at: ${report.generatedAt} (not part of the determinism claim)`);
  lines.push(`- Samples: ${String(report.samples.length)}`);
  lines.push("");

  if (!report.live) {
    lines.push(
      "> **Smoke run.** The output above is a scripted placeholder, not a real model " +
        "response. These numbers verify the pipeline and the metric arithmetic; they say " +
        "nothing about the real narrative agent's latency or Hebrew quality.",
    );
    lines.push("");
  }

  if (report.erroredSamples > 0) {
    lines.push(
      `> **${String(report.erroredSamples)} / ${String(report.samples.length)} streams ended in a ` +
        "provider error** (rate limit, transport failure, etc.), not a clean finish. Those " +
        "samples are excluded from every count and percentile below — see each sample's " +
        "`errorCode` in `report.json`. This is evidence about the provider or the live run's " +
        "circumstances, not about the prompt.",
    );
    lines.push("");
  }

  // Both lines get the same "— errored samples excluded" suffix, under the
  // same condition: p50 and p95 are computed from the identical `ttftValues`
  // array (narrative.ts), which already omits an errored sample's ttftMs
  // entirely — annotating one percentile but not the other would wrongly
  // imply only p50 is affected.
  const ttftSuffix = report.erroredSamples > 0 ? " — errored samples excluded" : "";
  lines.push("## Time to first token");
  lines.push("");
  lines.push(`- p50: ${report.ttftMsP50.toFixed(0)} ms (exit criterion: < 1500 ms)${ttftSuffix}`);
  lines.push(`- p95: ${report.ttftMsP95.toFixed(0)} ms${ttftSuffix}`);
  lines.push("");

  const disciplineSampleCount = report.samples.length - report.erroredSamples;
  lines.push("## Output discipline");
  lines.push("");
  lines.push(
    `- Digit violations: ${String(report.digitViolations)} / ${String(disciplineSampleCount)}`,
  );
  lines.push(
    `- Non-Hebrew outputs: ${String(report.nonHebrewOutputs)} / ${String(disciplineSampleCount)}`,
  );
  lines.push(
    `- Over-length outputs: ${String(report.overLengthOutputs)} / ${String(disciplineSampleCount)}`,
  );
  lines.push("");
  lines.push(
    "Any non-zero count above is a prompt bug, not a tolerance: fix the prompt, bump " +
      "`NARRATIVE_PROMPT_VERSION`, re-pin the hash, and re-measure.",
  );
  lines.push("");

  lines.push("## Cost");
  lines.push("");
  // Broken out rather than summed into one "prompt tokens" line: the three
  // bill at different rates, and a run whose prefix is written on every call
  // looks identical to one that reads it if they are added together.
  lines.push(`- Prompt tokens: ${String(report.usage.promptTokens)} uncached`);
  lines.push(`- Cache reads: ${tokensOrNotReported(report.usage.cachedPromptTokens)}`);
  lines.push(`- Cache writes: ${tokensOrNotReported(report.usage.cacheWritePromptTokens)}`);
  lines.push(`- Completion tokens: ${String(report.usage.completionTokens)}`);
  lines.push(
    `- Cost: ${money(report.usage.costUsd)} total, ${money(report.usage.costPerNarrationUsd)} per narration`,
  );
  lines.push(
    `- Cached-token share: ${percentOrNa(
      report.usage.cachedTokenShare,
      report.usage.cachedPromptTokens !== null,
    )}`,
  );
  if (report.usage.costIsUnderreported) {
    lines.push("");
    lines.push(
      "> **Cost is under-reported.** At least one narration was billed but reported no " +
        "token usage, so the figures above are a lower bound.",
    );
  }
  lines.push("");

  return lines.join("\n");
}

export function writeNarrativeReport(
  report: NarrativeRunReport,
  runsDir: string,
): { jsonPath: string; markdownPath: string } {
  return writeRunArtifacts(report, runsDir, renderNarrativeMarkdown);
}
