// Argv parsing, kept pure so it is testable without running anything.
//
// `--live` is the only flag that can cause a network call or read an API key.
// Everything else is orthogonal to it: `--mode probe` and `--mode probe --live`
// run the identical code path with a different port underneath, which is what
// stops the CI path from drifting away from the path that produces real numbers.
import type { Arm, BenchmarkConfig } from "./config.js";
import { ARMS, DEFAULT_CONFIG, armById } from "./config.js";
import { scenarioById } from "./scenarios/index.js";

const MODES = ["probe", "encounter", "both"] as const;
type Mode = (typeof MODES)[number];

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
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
  const live = argv.includes("--live");

  const rawMode = valueAfter(argv, "--mode");
  if (rawMode !== undefined && !isMode(rawMode)) {
    throw new Error(`Unknown mode ${rawMode}; expected one of ${MODES.join(", ")}`);
  }

  const rawSeeds = valueAfter(argv, "--seeds");
  const rawScenarios = valueAfter(argv, "--scenarios");
  const rawArms = valueAfter(argv, "--arms");

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
