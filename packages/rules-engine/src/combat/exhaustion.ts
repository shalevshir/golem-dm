// 2024 unified exhaustion track (ADR-0001). Kept in its own module so the
// action-economy state machine can use it without cycling through ./index.js.

/** 2024 unified exhaustion (ADR-0001): −2 per level to every d20 test. */
export function exhaustionD20Penalty(level: number): number {
  return 0 - 2 * level;
}

/** 2024 unified exhaustion (ADR-0001): −5 ft of speed per level. */
export function exhaustionSpeedPenaltyFeet(level: number): number {
  return 0 - 5 * level;
}

export function isDeadFromExhaustion(level: number): boolean {
  return level >= 6;
}
