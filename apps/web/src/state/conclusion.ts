// Is the fight over, and who won — read from the projection, never from a
// frame. There IS no terminal frame: once the last party member dies,
// `runEnemyTurns` returns at its `livingFactions.size < 2` check with no event
// emitted, and every later command is answered `not_your_turn` (correction
// C-37). A UI that waited for a victory frame would hang forever.
//
// The party is expected to LOSE (correction C-31): `diesAtZeroHp` is pinned
// true unconditionally, so a PC dies at 0 HP rather than falling Unconscious
// — death saves are not implemented (RULES_REFERENCE.md §8's gap). Defeat is
// a normal ending here, not an error state.
import type { SessionState } from "@ai-dm/schemas";

export type Conclusion = "ongoing" | "victory" | "defeat";

export function conclusionOf(snapshot: SessionState): Conclusion {
  const living = snapshot.combatants.filter((each) => each.status === "alive");
  const factions = new Set(living.map((each) => each.faction));
  if (factions.size > 1) return "ongoing";
  // An empty board is a session that has not started, not a finished fight.
  if (living.length === 0) return snapshot.combatants.length === 0 ? "ongoing" : "defeat";
  return factions.has("party") ? "victory" : "defeat";
}
