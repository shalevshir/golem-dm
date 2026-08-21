// Headless combat simulator: tactical agent vs scripted enemies, no UI.
// Metrics per model: tool-call legality rate, retries, latency p50/p95,
// tokens & cost per turn, win rate vs baseline scripted AI.
//
// `pnpm sim` runs the smoke path: no network, no API key, a reproducible report
// under `runs/`. Add `--live` to benchmark real models, which requires the
// provider credentials in the environment and is the operator's call to make.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentRuntime,
  createFakePort,
  createVercelPort,
  DEFAULT_MODEL_ROUTING,
  NARRATIVE_PROMPT_VERSION,
} from "@ai-dm/agents";
import { parseArgs } from "./cli.js";
import { runLive } from "./live/run.js";
import { runNarrativeBenchmark, SCRIPTED_BRIEFS } from "./live/narrative.js";
import type { NarrativeReport } from "./live/narrative.js";
import { runSmoke } from "./smoke/run.js";
import { writeReport } from "./run/report.js";

const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");

/** Provenance, not behaviour: an unknown commit must not stop a run. */
function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Plausible token counts for a smoke narration. A fixture, not a measurement — mirrors smoke/defects.ts's SMOKE_USAGE for the tactical path. */
const NARRATIVE_SMOKE_USAGE = { promptTokens: 400, completionTokens: 20, totalTokens: 420 };

/**
 * The clean, always-correct sentence deterministic.ts also renders for
 * `{ kind: "hold" }` — reused here so a smoke narrative run reports zero
 * classification violations, the same "verifies the pipeline, not any real
 * model" spirit runSmoke's own comment states for the tactical side.
 */
const NARRATIVE_SMOKE_TEXT = "אלדד עומד במקומו.";

/** No network, no API key: one scripted stream reply per brief in the corpus. */
function narrativeSmokePort(): ReturnType<typeof createFakePort> {
  return createFakePort({
    stream: SCRIPTED_BRIEFS.map(() => [
      { type: "text-delta" as const, text: NARRATIVE_SMOKE_TEXT },
      { type: "finish" as const, text: NARRATIVE_SMOKE_TEXT, usage: NARRATIVE_SMOKE_USAGE },
    ]),
  });
}

/** Milliseconds the smoke clock advances per read. A fixture, distinct from runSmoke's own TICK_MS so the two are never confused in a log. */
const NARRATIVE_TICK_MS = 41;

function narrativeSmokeClock(): () => number {
  let ticks = 0;
  return () => {
    ticks += 1;
    return ticks * NARRATIVE_TICK_MS;
  };
}

interface NarrativeRunReport extends NarrativeReport {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  promptVersion: string;
  live: boolean;
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
function renderNarrativeMarkdown(report: NarrativeRunReport): string {
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

  lines.push("## Time to first token");
  lines.push("");
  lines.push(`- p50: ${report.ttftMsP50.toFixed(0)} ms (exit criterion: < 1500 ms)`);
  lines.push(`- p95: ${report.ttftMsP95.toFixed(0)} ms`);
  lines.push("");

  lines.push("## Output discipline");
  lines.push("");
  lines.push(`- Digit violations: ${String(report.digitViolations)} / ${String(report.samples.length)}`);
  lines.push(`- Non-Hebrew outputs: ${String(report.nonHebrewOutputs)} / ${String(report.samples.length)}`);
  lines.push(`- Over-length outputs: ${String(report.overLengthOutputs)} / ${String(report.samples.length)}`);
  lines.push("");
  lines.push(
    "Any non-zero count above is a prompt bug, not a tolerance: fix the prompt, bump " +
      "`NARRATIVE_PROMPT_VERSION`, re-pin the hash, and re-measure.",
  );
  lines.push("");

  lines.push("## Cost");
  lines.push("");
  lines.push(`- Prompt tokens: ${String(report.usage.promptTokens)}`);
  lines.push(`- Completion tokens: ${String(report.usage.completionTokens)}`);
  lines.push(
    `- Cost: ${money(report.usage.costUsd)} total, ${money(report.usage.costPerNarrationUsd)} per narration`,
  );
  if (report.usage.costIsUnderreported) {
    lines.push("");
    lines.push(
      "> **Cost is under-reported.** At least one narration was billed but reported no " +
        "token usage, so the figures above are a lower bound. Cached-token share is not " +
        "reported at all: no adapter in this repo surfaces a cache-read count.",
    );
  }
  lines.push("");

  return lines.join("\n");
}

function writeNarrativeReport(
  report: NarrativeRunReport,
  runsDir: string,
): { jsonPath: string; markdownPath: string } {
  const directory = join(runsDir, report.runId);
  mkdirSync(directory, { recursive: true });

  const jsonPath = join(directory, "report.json");
  const markdownPath = join(directory, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderNarrativeMarkdown(report), "utf8");

  return { jsonPath, markdownPath };
}

/**
 * `--mode narrative` benchmarks the narrative agent alone (see
 * `live/narrative.ts`'s header comment for why), entirely separately from
 * this file's tactical `runLive`/`runSmoke` path below: it takes an
 * `AgentRuntime` built straight from `DEFAULT_MODEL_ROUTING`, never an `Arm`
 * from `config.ts`'s 12-arm matrix (`cli.ts` rejects `--arms` combined with
 * this mode for that reason). `--live` swaps the port only, matching every
 * other mode's own philosophy (`cli.ts`'s header comment) — a scripted run
 * needs no network and no key.
 */
async function runNarrativeMode(options: {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  live: boolean;
}): Promise<{ jsonPath: string; markdownPath: string }> {
  const runtime = createAgentRuntime({
    routing: DEFAULT_MODEL_ROUTING,
    port: options.live ? createVercelPort() : narrativeSmokePort(),
  });

  const report = options.live
    ? await runNarrativeBenchmark({ runtime })
    : await runNarrativeBenchmark({ runtime, now: narrativeSmokeClock() });

  return writeNarrativeReport(
    {
      ...report,
      runId: options.runId,
      generatedAt: options.generatedAt,
      gitCommit: options.gitCommit,
      promptVersion: NARRATIVE_PROMPT_VERSION,
      live: options.live,
    },
    RUNS_DIR,
  );
}

export async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();

  if (config.mode === "narrative") {
    const { jsonPath, markdownPath } = await runNarrativeMode({
      runId: `${config.live ? "live" : "smoke"}-narrative-${generatedAt.replaceAll(":", "-")}`,
      generatedAt,
      gitCommit: gitCommit(),
      live: config.live,
    });
    console.warn(`Wrote ${jsonPath}`);
    console.warn(`Wrote ${markdownPath}`);
    return;
  }

  // `config.mode` is narrowed to "probe" | "encounter" | "both" here by the
  // early return above — `runLive`/`runSmoke` never see "narrative".
  //
  // `--live` and the smoke path share everything downstream of `report` — the
  // only difference is which port produced the records. Real credentials are
  // read from `process.env` deep inside `createVercelPort`'s provider clients,
  // never here: firing a live call is still the operator's decision, made by
  // exporting keys and passing `--live`, not by anything this branch decides.
  const report = config.live
    ? await runLive({
        runId: `live-${generatedAt.replaceAll(":", "-")}`,
        generatedAt,
        gitCommit: gitCommit(),
        arms: config.arms,
        seeds: config.seeds,
        scenarioIds: config.scenarioIds,
        mode: config.mode,
      })
    : await runSmoke({
        runId: `smoke-${generatedAt.replaceAll(":", "-")}`,
        generatedAt,
        gitCommit: gitCommit(),
        seeds: config.seeds,
        scenarioIds: config.scenarioIds,
        mode: config.mode,
      });

  const { jsonPath, markdownPath } = writeReport(report, RUNS_DIR);
  console.warn(`Wrote ${jsonPath}`);
  console.warn(`Wrote ${markdownPath}`);
}

/**
 * Guards the top-level run so importing this module (from a test, say) does
 * not itself trigger a full smoke run — only running it directly, the way
 * `tsx src/index.ts` does, does.
 */
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    // `parseArgs` throws plain `Error`s for the CLI's common mistakes (an
    // unknown flag, `--arms` outside `--live`) — without this, those surface
    // as a raw Node stack trace instead of the message the error was written
    // to carry.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
