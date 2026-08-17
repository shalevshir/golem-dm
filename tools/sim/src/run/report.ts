// One JSON and one markdown file per run. The JSON is the artefact; the
// markdown is for a human deciding which model to route to.
//
// Two rules this file exists to enforce. No cost figure is ever printed without
// either completeness or an explicit under-reporting notice. And a report
// records the prompt version that produced it, so two runs either side of a
// prompt edit cannot be pooled silently.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TACTICAL_PROMPT_VERSION } from "@ai-dm/agents";
import { PRICING_TABLE_DATE, costUsd } from "../pricing.js";
import type { LatencySummary, LegalitySummary, UsageSummary } from "./metrics.js";
import { summariseLatency, summariseLegality, summariseUsage } from "./metrics.js";
import type { TurnRecord } from "./records.js";

export interface ModeSummary {
  turns: number;
  legality: LegalitySummary;
  latency: LatencySummary;
  usage: UsageSummary;
  /** Null when the model has no entry in the pricing table. */
  costUsd: number | null;
  costPerTurnUsd: number | null;
  /** PROJECT_PLAN.md section 3 states its cost target per 30-turn session. */
  costPer30TurnSessionUsd: number | null;
  /**
   * Engine-legal action ids the actor's stat block does not contain. Only ever
   * populated in encounter mode — probe mode resolves nothing by design, so
   * this is structurally always empty there. The report labels it
   * encounter-only rather than printing an empty probe-mode value that would
   * read as a clean bill of health for a mode that never looked.
   */
  unresolvedActionIds: readonly string[];
}

export interface EncounterSummary {
  armId: string;
  scenarioId: string;
  seed: number;
  winner: string | null;
  rounds: number;
  damageByFaction: Record<string, number>;
}

export interface ArmSummary {
  armId: string;
  modelId: string;
  probe: ModeSummary;
  encounter: ModeSummary;
  /** Fraction of encounters the model-driven side won. */
  winRate: number;
}

export interface RunReport {
  runId: string;
  /** Excluded from the determinism claim — everything else is reproducible. */
  generatedAt: string;
  gitCommit: string;
  promptVersion: string;
  pricingTableDate: string;
  live: boolean;
  seeds: readonly number[];
  scenarioIds: readonly string[];
  arms: readonly ArmSummary[];
  costIsUnderreported: boolean;
  encounters: readonly EncounterSummary[];
}

export interface BuildReportInput {
  runId: string;
  generatedAt: string;
  gitCommit: string;
  promptVersion?: string;
  live: boolean;
  seeds: readonly number[];
  scenarioIds: readonly string[];
  probeRecords?: readonly TurnRecord[];
  encounterRecords?: readonly TurnRecord[];
  encounters?: readonly EncounterSummary[];
}

const TURNS_PER_SESSION = 30;

function modelIdOf(armId: string): string {
  return armId.split("@")[0] ?? armId;
}

function summarise(armId: string, records: readonly TurnRecord[]): ModeSummary {
  const usage = summariseUsage(records);
  const cost = costUsd(modelIdOf(armId), {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  });
  const perTurn = cost === null || records.length === 0 ? null : cost / records.length;

  return {
    turns: records.length,
    legality: summariseLegality(records),
    latency: summariseLatency(records),
    usage,
    costUsd: cost,
    costPerTurnUsd: perTurn,
    costPer30TurnSessionUsd: perTurn === null ? null : perTurn * TURNS_PER_SESSION,
    unresolvedActionIds: [...new Set(records.flatMap((record) => record.unresolvedActionIds))],
  };
}

function armIdsIn(...groups: readonly (readonly TurnRecord[])[]): string[] {
  return [...new Set(groups.flat().map((record) => record.armId))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function buildReport(input: BuildReportInput): RunReport {
  const probeRecords = input.probeRecords ?? [];
  const encounterRecords = input.encounterRecords ?? [];
  const encounters = input.encounters ?? [];

  const arms: ArmSummary[] = armIdsIn(probeRecords, encounterRecords).map((armId) => {
    const armEncounters = encounters.filter((each) => each.armId === armId);
    const wins = armEncounters.filter((each) => each.winner === "hostile").length;

    return {
      armId,
      modelId: modelIdOf(armId),
      probe: summarise(
        armId,
        probeRecords.filter((record) => record.armId === armId),
      ),
      encounter: summarise(
        armId,
        encounterRecords.filter((record) => record.armId === armId),
      ),
      winRate: armEncounters.length === 0 ? 0 : wins / armEncounters.length,
    };
  });

  return {
    runId: input.runId,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit,
    promptVersion: input.promptVersion ?? TACTICAL_PROMPT_VERSION,
    pricingTableDate: PRICING_TABLE_DATE,
    live: input.live,
    seeds: input.seeds,
    scenarioIds: input.scenarioIds,
    arms,
    costIsUnderreported: arms.some(
      (arm) => !arm.probe.usage.usageComplete || !arm.encounter.usage.usageComplete,
    ),
    encounters,
  };
}

function money(value: number | null): string {
  return value === null ? "unpriced" : `$${value.toFixed(4)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function unresolvedActionsCell(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.join(", ");
}

export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];

  lines.push(`# Tactical benchmark — ${report.runId}`);
  lines.push("");
  lines.push(`- Mode: **${report.live ? "live" : "smoke (scripted port, no network)"}**`);
  lines.push(`- Prompt version: \`${report.promptVersion}\``);
  lines.push(`- Commit: \`${report.gitCommit}\``);
  lines.push(`- Pricing table dated: ${report.pricingTableDate}`);
  lines.push(`- Seeds: ${report.seeds.join(", ")}`);
  lines.push(`- Scenarios: ${report.scenarioIds.join(", ")}`);
  lines.push(`- Generated at: ${report.generatedAt} (not part of the determinism claim)`);
  lines.push("");

  if (!report.live) {
    lines.push(
      "> **Smoke run.** The model here is a scripted policy with a seeded defect " +
        "schedule. These numbers verify the pipeline and the metric arithmetic. " +
        "They say nothing about any real model's tactical quality.",
    );
    lines.push("");
  }

  if (report.costIsUnderreported) {
    lines.push(
      "> **Cost is under-reported.** At least one attempt was billed but reported " +
        "no token usage, so every figure below is a lower bound. This can happen two " +
        "ways: a bare `TypeValidationError` that was not wrapped in " +
        "`NoObjectGeneratedError` carries no usage, and an abort landing after the " +
        "provider already billed the call also drops usage. See the " +
        "`attemptsMissingUsage` column.",
    );
    lines.push("");
  }

  lines.push("## Probe mode — paired, picks the model");
  lines.push("");
  lines.push(
    "| Arm | Turns | First try | Legal after retry | Fallback | p50 ms | p95 ms | Tokens/turn | $/turn | $/30-turn session | Missing usage |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of report.arms) {
    const { probe } = arm;
    lines.push(
      `| \`${arm.armId}\` | ${String(probe.turns)} | ${percent(probe.legality.firstTryRate)} | ` +
        `${percent(probe.legality.legalAfterRetryRate)} | ${String(probe.legality.fallback)} | ` +
        `${probe.latency.p50Ms.toFixed(0)} | ${probe.latency.p95Ms.toFixed(0)} | ` +
        `${probe.usage.tokensPerTurn.toFixed(0)} | ${money(probe.costPerTurnUsd)} | ` +
        `${money(probe.costPer30TurnSessionUsd)} | ${String(probe.usage.attemptsMissingUsage)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Step 7's exit criterion is **legality >= 95% after retry**. Read it from the " +
      "third column: that is the fraction of turns the engine accepted without the " +
      "deterministic fallback having to step in.",
  );
  lines.push("");
  lines.push(
    "This legality figure is measured on the scripted baseline's state " +
      "distribution: the probe corpus is snapshotted from a scripted-both-sides " +
      "control encounter, not from the states a model would actually drive itself " +
      "into. That is the right comparison for a paired, apples-to-apples read across " +
      "arms — encounter mode below covers the model-driven distribution — but do not " +
      'over-read this column as "legality in the wild".',
  );
  lines.push("");

  lines.push("## Encounter mode — unpaired, win rate only");
  lines.push("");
  lines.push("| Arm | Encounters | Win rate | Turns | Legal after retry | Unresolved actions |");
  lines.push("|---|---|---|---|---|---|");
  for (const arm of report.arms) {
    const played = report.encounters.filter((each) => each.armId === arm.armId).length;
    lines.push(
      `| \`${arm.armId}\` | ${String(played)} | ${percent(arm.winRate)} | ` +
        `${String(arm.encounter.turns)} | ${percent(arm.encounter.legality.legalAfterRetryRate)} | ` +
        `${unresolvedActionsCell(arm.encounter.unresolvedActionIds)} |`,
    );
  }
  lines.push("");
  lines.push(
    '"Unresolved actions" is **encounter-only**: probe mode resolves nothing by ' +
      "design, so that field is structurally always empty there and is omitted from " +
      "the probe table above rather than shown as a false-clean empty list.",
  );
  lines.push("");
  lines.push(
    "Win rate is measured against the scripted baseline. Read it with the resolver's " +
      "declared gaps in view. **Dodge has no mechanical effect** in this harness, so a " +
      "model that Dodges wisely is penalised, as is the deterministic fallback. Attacks " +
      'are also always resolved at `"normal"` mode — condition-driven advantage or ' +
      "disadvantage is never applied (currently unreachable, since nothing in the sim " +
      "inflicts conditions) — and a swing at a target that already died earlier in the " +
      "same turn is dropped rather than redirected to a new target.",
  );
  lines.push("");

  return lines.join("\n");
}

export function writeReport(
  report: RunReport,
  runsDir: string,
): { jsonPath: string; markdownPath: string } {
  const directory = join(runsDir, report.runId);
  mkdirSync(directory, { recursive: true });

  const jsonPath = join(directory, "report.json");
  const markdownPath = join(directory, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(report), "utf8");

  return { jsonPath, markdownPath };
}
