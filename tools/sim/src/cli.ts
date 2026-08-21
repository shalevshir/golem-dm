// Argv parsing, kept pure so it is testable without running anything.
//
// `--live` is the only flag that can cause a network call or read an API key.
// Everything else is orthogonal to it: `--mode probe` and `--mode probe --live`
// run the identical code path with a different port underneath, which is what
// stops the CI path from drifting away from the path that produces real numbers.
import type { Arm, BenchmarkConfig } from "./config.js";
import { ARMS, DEFAULT_CONFIG, SMOKE_ARM, armById } from "./config.js";
import { scenarioById } from "./scenarios/index.js";

const MODES = ["probe", "encounter", "both", "narrative"] as const;
type Mode = (typeof MODES)[number];

const KNOWN_FLAGS = ["--live", "--mode", "--seeds", "--scenarios", "--arms"] as const;

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}

/**
 * Any unrecognised `--`-prefixed token is a typo, not a value: `valueAfter`
 * already refuses to let a flag's value start with `--`, so every such token
 * in `argv` is a flag name. A typo here (`--scenario`, `--seed`) must stop the
 * run rather than silently fall through to the default matrix — the same
 * standard `parseScenarios` and `parseArms` already hold their inputs to.
 */
function assertKnownFlags(argv: readonly string[]): void {
  for (const token of argv) {
    if (token.startsWith("--") && !(KNOWN_FLAGS as readonly string[]).includes(token)) {
      throw new Error(`Unknown flag ${token}; known flags: ${KNOWN_FLAGS.join(", ")}`);
    }
  }
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseSeeds(value: string): number[] {
  return commaSeparated(value).map((part) => {
    const seed = Number(part);
    if (!Number.isInteger(seed)) throw new Error(`Seed must be an integer, got ${part}`);
    return seed;
  });
}

function parseScenarios(value: string): string[] {
  // scenarioById throws on an unknown id, which is what we want: a typo should
  // stop the run rather than quietly benchmark three scenarios instead of four.
  return commaSeparated(value).map((id) => scenarioById(id).scenarioId);
}

function parseArms(value: string): Arm[] {
  return commaSeparated(value).map((id) => armById(id));
}

export function parseArgs(argv: readonly string[]): BenchmarkConfig {
  assertKnownFlags(argv);
  const live = argv.includes("--live");

  const rawMode = valueAfter(argv, "--mode");
  if (rawMode !== undefined && !isMode(rawMode)) {
    throw new Error(`Unknown mode ${rawMode}; expected one of ${MODES.join(", ")}`);
  }

  const rawSeeds = valueAfter(argv, "--seeds");
  const rawScenarios = valueAfter(argv, "--scenarios");
  const rawArms = valueAfter(argv, "--arms");

  // `--mode narrative` always benchmarks the "narrative" role from
  // `DEFAULT_MODEL_ROUTING`, never an arm from this file's tactical matrix —
  // `runNarrativeBenchmark` takes a runtime, not an `Arm`. Honouring `--arms`
  // here would suffer the same two dishonest outcomes the check below
  // rejects it for outside `--live`: either a silent no-op or a report
  // mislabelled with a model that was never called. Checked before the
  // `--live` case so this more specific mistake gets the more specific
  // message, whether or not `--live` was also passed.
  if (rawArms !== undefined && rawMode === "narrative") {
    throw new Error(
      `--arms does not apply to --mode narrative; it always benchmarks the narrative role ` +
        `from DEFAULT_MODEL_ROUTING, never the tactical arm matrix in config.ts. Drop --arms.`,
    );
  }

  // `runSmoke` always benchmarks `SMOKE_ARM` and never reads `config.arms` — a
  // scripted port answers identically regardless of which model id labels the
  // record, so honouring `--arms` outside `--live` would either be a no-op
  // (misleading: the flag looks like it did something) or would mislabel every
  // record with a model that was never called. Reject it instead of choosing
  // between those two dishonest options.
  if (rawArms !== undefined && !live) {
    throw new Error(
      `--arms only applies with --live; a smoke run always benchmarks the scripted arm ` +
        `(${SMOKE_ARM.armId}). Pass --live to select a real arm, or drop --arms.`,
    );
  }

  return {
    mode: rawMode ?? DEFAULT_CONFIG.mode,
    live,
    // A live run with no explicit arms means the whole matrix; a smoke run means
    // the one scripted arm, because there is no model to distinguish arms by.
    arms: rawArms !== undefined ? parseArms(rawArms) : live ? ARMS : DEFAULT_CONFIG.arms,
    seeds: rawSeeds === undefined ? DEFAULT_CONFIG.seeds : parseSeeds(rawSeeds),
    scenarioIds:
      rawScenarios === undefined ? DEFAULT_CONFIG.scenarioIds : parseScenarios(rawScenarios),
  };
}
