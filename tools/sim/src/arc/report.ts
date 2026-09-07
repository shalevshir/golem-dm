// Markdown rendering and disk-writing for an arc run. Beside `run.ts` for the
// same reason `live/narrative-report.ts` sits beside `live/narrative.ts`:
// `run/report.ts`'s `RunReport` is shaped around the tactical arm matrix,
// which an arc walk has none of. Only the "write JSON + markdown under
// runsDir/<runId>/" plumbing is shared, and that is `writeRunArtifacts`.
import { writeRunArtifacts } from "../run/report.js";
import type { ArcReport } from "./run.js";

export interface ArcRunReport extends ArcReport {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  serverUrl: string;
  worldId: string;
}

const FINISH_NOTES: Readonly<Record<ArcReport["finish"], string>> = {
  concluded: "The arc reached its terminal node and concluded.",
  dead_end:
    "The walk stopped at a node with no open edge and no legal conclusion. Either content " +
    "gates the player out, or a precondition never became satisfiable.",
  stalled:
    "Every open edge out of a node was tried and none moved the player. The content offers " +
    "somewhere to go and the pipeline is not taking it — read the `error` column below.",
  step_cap: "The step budget ran out before the arc ended. Raise `--steps` to see further.",
  timeout:
    "The server stopped handing control back. This is the interesting failure: the turn " +
    "either never completed or never emitted affordances.",
};

export function renderArcMarkdown(report: ArcRunReport): string {
  const lines: string[] = [];
  const totalSteps = report.steps.length;
  const rate = (count: number): string =>
    totalSteps === 0 ? "—" : `${((100 * count) / totalSteps).toFixed(0)}%`;

  lines.push(`# Arc walk — ${report.runId}`);
  lines.push("");
  lines.push(`- World: \`${report.worldId}\` against ${report.serverUrl}`);
  lines.push(`- Campaign: \`${report.campaignId}\``);
  lines.push(`- Commit: \`${report.gitCommit}\``);
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- Finish: **${report.finish}** — ${FINISH_NOTES[report.finish]}`);
  lines.push("");

  lines.push(
    "> Every model in this run is the one the server wired, not a fixture. Token cost and " +
      "per-agent retries are **not** here: they never cross the wire (they go to the " +
      "server's own `MetricsPort`). Latency below is client-observed, send to the frame " +
      "that hands control back, so it includes the whole turn — router, GM tier, engine " +
      "and narration together.",
  );
  lines.push("");

  lines.push("## Router");
  lines.push("");
  lines.push("| outcome | steps | share |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| landed on the chosen edge | ${String(report.routerHits)} | ${rate(report.routerHits)} |`);
  lines.push(`| traversed somewhere else | ${String(report.routerMisses)} | ${rate(report.routerMisses)} |`);
  lines.push(
    `| no traversal at all | ${String(report.routerNoTraversals)} | ${rate(report.routerNoTraversals)} |`,
  );
  lines.push("");
  lines.push(
    "Each step sends an edge's own `labelHebrew` verbatim — the easiest input the router " +
      "will ever get. A miss here is a floor failure, not a paraphrase failure.",
  );
  lines.push("");

  lines.push("## Turn latency");
  lines.push("");
  lines.push(`- p50: ${String(report.latencyMsP50)} ms`);
  lines.push(`- p95: ${String(report.latencyMsP95)} ms`);
  lines.push("");

  lines.push("## Narration sources");
  lines.push("");
  const sources = Object.entries(report.narrationSources);
  if (sources.length === 0) {
    lines.push("No narration was emitted.");
  } else {
    lines.push("| source | narrations |");
    lines.push("| --- | ---: |");
    for (const [source, count] of sources) lines.push(`| \`${source}\` | ${String(count)} |`);
    lines.push("");
    lines.push(
      "`deterministic` is the fallback: the model failed or was rejected and the " +
        "hand-written Hebrew stood in. A high share means the narrative agent is not " +
        "actually carrying the session.",
    );
  }
  lines.push("");

  lines.push("## Encounters");
  lines.push("");
  if (report.encounters.length === 0) {
    lines.push("The walk never entered a fight.");
  } else {
    lines.push("| encounter | hero turns | outcome |");
    lines.push("| --- | ---: | --- |");
    for (const encounter of report.encounters) {
      lines.push(
        `| \`${encounter.encounterId}\` | ${String(encounter.heroTurns)} | ${encounter.outcome ?? "unresolved"} |`,
      );
    }
  }
  lines.push("");

  if (report.gmMoves.length > 0) {
    lines.push("## GM tier");
    lines.push("");
    for (const move of report.gmMoves) lines.push(`- \`${move.kind}\` — ${move.reasonEnglish}`);
    lines.push("");
  }

  lines.push("## Walk");
  lines.push("");
  lines.push("| # | from | sent | wanted | classified | entered | routing | ms | error |");
  lines.push("| ---: | --- | --- | --- | --- | --- | --- | ---: | --- |");
  for (const step of report.steps) {
    const classified =
      step.classifiedCategory === null
        ? "—"
        : `${step.classifiedCategory}${step.classifiedTargetNodeId === null ? "" : ` → ${step.classifiedTargetNodeId}`}`;
    lines.push(
      `| ${String(step.index)} | \`${step.fromNodeId}\` | ${step.sentText} | ` +
        `${step.intendedNodeId === null ? "*conclude*" : `\`${step.intendedNodeId}\``} | ${classified} | ` +
        `${step.enteredNodeId === null ? "—" : `\`${step.enteredNodeId}\``} | ${step.routing} | ` +
        `${String(step.latencyMs)} | ${step.serverError ?? ""} |`,
    );
  }
  lines.push("");

  lines.push("## Narration, in order");
  lines.push("");
  lines.push(
    "For a native-speaker read. English context is the step it answers; the Hebrew is " +
      "verbatim from `narrative_emitted.text`.",
  );
  lines.push("");
  for (const step of report.steps) {
    if (step.narrations.length === 0) continue;
    lines.push(`**${String(step.index)}. ${step.fromNodeId} → ${step.enteredNodeId ?? "(nowhere)"}**`);
    lines.push("");
    for (const narration of step.narrations) lines.push(`- (\`${narration.source}\`) ${narration.text}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function writeArcReport(
  report: ArcRunReport,
  runsDir: string,
): { jsonPath: string; markdownPath: string } {
  return writeRunArtifacts(report, runsDir, renderArcMarkdown);
}
