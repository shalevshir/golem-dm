/**
 * Dice module. All randomness flows through an injected RNG so every
 * roll is reproducible in tests and replayable from the event log.
 */
export type Rng = () => number; // [0, 1)

export interface RollResult {
  notation: string; // e.g. "2d6+3"
  rolls: number[];
  modifier: number;
  total: number;
}

export interface DiceNotation {
  count: number;
  sides: number;
  modifier: number;
}

export interface RollOptions {
  /**
   * Critical hit. Per the 2024 rules (ADR-0001) only the damage dice are
   * doubled; the modifier is added once.
   */
  critical?: boolean;
}

export function rollDie(sides: number, rng: Rng): number {
  return Math.floor(rng() * sides) + 1;
}

export function d20(
  rng: Rng,
  mode: "normal" | "advantage" | "disadvantage" = "normal",
): { result: number; rolls: number[] } {
  const a = rollDie(20, rng);
  if (mode === "normal") return { result: a, rolls: [a] };
  const b = rollDie(20, rng);
  return { result: mode === "advantage" ? Math.max(a, b) : Math.min(a, b), rolls: [a, b] };
}

/** `[count]d<sides>[+/-modifier]` — count defaults to 1, modifier to 0. */
const NOTATION_PATTERN = /^(\d*)d(\d+)(?:([+-])(\d+))?$/i;

export function parseNotation(notation: string): DiceNotation {
  const compact = notation.replace(/\s+/g, "");
  const match = NOTATION_PATTERN.exec(compact);
  if (match === null) {
    throw new Error(`Invalid dice notation: ${JSON.stringify(notation)}`);
  }

  const [, rawCount, rawSides, sign, rawModifier] = match;
  if (rawSides === undefined) {
    throw new Error(`Invalid dice notation: ${JSON.stringify(notation)}`);
  }

  const count = rawCount === undefined || rawCount === "" ? 1 : Number.parseInt(rawCount, 10);
  const sides = Number.parseInt(rawSides, 10);
  const magnitude = rawModifier === undefined ? 0 : Number.parseInt(rawModifier, 10);

  if (count < 1) throw new Error(`Dice count must be at least 1: ${JSON.stringify(notation)}`);
  if (sides < 1) throw new Error(`Die must have at least 1 side: ${JSON.stringify(notation)}`);

  return { count, sides, modifier: sign === "-" ? -magnitude : magnitude };
}

/**
 * Rolls a dice expression. The total is floored at 0 — 5e damage is never
 * negative, and a large penalty must not heal the target.
 */
export function roll(notation: string, rng: Rng, options: RollOptions = {}): RollResult {
  const { count, sides, modifier } = parseNotation(notation);
  const diceCount = options.critical === true ? count * 2 : count;

  const rolls: number[] = [];
  for (let i = 0; i < diceCount; i++) {
    rolls.push(rollDie(sides, rng));
  }

  const sum = rolls.reduce((acc, value) => acc + value, 0);
  return { notation, rolls, modifier, total: Math.max(0, sum + modifier) };
}
