// Headless combat simulator: tactical agent vs scripted enemies, no UI.
// Metrics per model: tool-call legality rate, retries, latency p50/p95,
// tokens & cost per turn, win rate vs baseline scripted AI.
//
// `pnpm sim` runs the smoke path: no network, no API key, a reproducible report
// under `runs/`. Add `--live` to benchmark real models, which requires the
// provider credentials in the environment and is the operator's call to make.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./cli.js";
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

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  if (config.live) {
    // Everything for a live run exists — arms, runners, records, reports — but
    // firing one spends money against credentials this process would read from
    // the environment. That is the operator's decision, made explicitly.
    console.error(
      "Live benchmarking is not wired to a provider in this build. See tools/sim/CLAUDE.md.",
    );
    process.exitCode = 1;
    return;
  }

  const generatedAt = new Date().toISOString();
  const report = await runSmoke({
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

await main();
