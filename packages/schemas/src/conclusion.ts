// Is the fight over, and who won — read from the projection, never from a
// frame. There IS no terminal frame while a fight is running: `runEnemyTurns`
// (`apps/server/src/core/pipeline.ts`) simply stops emitting once one faction
// is left standing, so a UI that waited for a victory frame would hang
// forever. The server's own end-of-combat detector reads this function at the
// end of each turn batch and emits `encounter_resolved` from what it says.
//
// It lives in `@ai-dm/schemas` for the reason `reduce` does: `apps/web` may
// import this package and only this package (invariant 5), so a projection
// read that BOTH halves need has nowhere else to go, and two copies of the
// victory rule is exactly what invariant 4 exists to forbid. It qualifies for
// that narrow exception where a rules function would not — it reads `status`
// and `faction` off a projection, rolls nothing, and consults no DC and no
// SRD table, so invariant 1's rules authority is untouched.
//
// The party is expected to LOSE: `diesAtZeroHp` is pinned true
// unconditionally, so a PC dies at 0 HP rather than falling Unconscious —
// death saves are implemented but not driven by the encounter pipeline
// (RULES_REFERENCE.md §8's gap). Defeat is a normal ending here, not an
// error state.
import type { EncounterState } from "./protocol.js";

export type Conclusion = "ongoing" | "victory" | "defeat";

export function conclusionOf(snapshot: EncounterState): Conclusion {
  const living = snapshot.combatants.filter((each) => each.status === "alive");
  const factions = new Set(living.map((each) => each.faction));
  if (factions.size > 1) return "ongoing";
  // An empty board is an encounter that has not started, not a finished
  // fight. A campaign not in one at all has no board to ask about — its
  // caller holds `encounter === null` and never reaches here.
  if (living.length === 0) return snapshot.combatants.length === 0 ? "ongoing" : "defeat";
  return factions.has("party") ? "victory" : "defeat";
}
