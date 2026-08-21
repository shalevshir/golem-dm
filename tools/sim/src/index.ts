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
import { writeNarrativeReport } from "./live/narrative-report.js";
import { buildReviewSheetInput, renderReviewSheet } from "./live/review-sheet.js";
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
  reviewSheet: boolean;
}): Promise<{ jsonPath: string; markdownPath: string }> {
  const runtime = createAgentRuntime({
    routing: DEFAULT_MODEL_ROUTING,
    port: options.live ? createVercelPort() : narrativeSmokePort(),
  });

  const report = options.live
    ? await runNarrativeBenchmark({ runtime })
    : await runNarrativeBenchmark({ runtime, now: narrativeSmokeClock() });

  const written = writeNarrativeReport(
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

  // `process.stdout.write`, not `console.log`: this repo's `no-console`
  // lint rule only allows `warn`/`error` (see apps/server/src/main.ts's own
  // note on the same rule), and the sheet is the command's actual
  // deliverable rather than a log line, so a logger would be the wrong tool
  // even where one exists. Deliberately separate from the `Wrote ...` lines
  // `main()` prints below (console.warn, i.e. stderr):
  // `pnpm --filter @ai-dm/sim start --live --mode narrative --review-sheet >
  // docs/prompts/hebrew-review-....md` redirects stdout only, so this is the
  // one thing that command's redirect captures.
  if (options.reviewSheet) {
    process.stdout.write(`${renderReviewSheet(buildReviewSheetInput(report.samples))}\n`);
  }

  return written;
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
      reviewSheet: config.reviewSheet,
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
