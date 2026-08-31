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
// A PC falls Unconscious and rolls death saves at 0 HP rather than dying
// outright (`diesAtZeroHp` is read off `characterId`, not pinned —
// death-saves-persistent-hp spec, Decision 3), and the encounter pipeline
// drives those rolls on the hero's own turn (Decision 5). Defeat is still a
// normal ending, reached honestly now: three failed saves, not an
// instant flip the moment HP hits 0.
import type { EncounterState } from "./protocol.js";

export type Conclusion = "ongoing" | "victory" | "defeat";

/**
 * Who won, or whether the fight is still deciding that.
 *
 * A death save still pending is not a settled fact about the outcome — the
 * combatant could yet stabilize, wake on a natural 20, or die — so it keeps
 * the fight "ongoing" regardless of who else is standing (death-saves-
 * persistent-hp spec, Decision 4). Once no save is pending, "standing" means
 * alive OR unconscious-but-stable: a stabilized combatant did not lose just
 * by falling, and a won fight can end with the hero down but not dead.
 */
export function conclusionOf(snapshot: EncounterState): Conclusion {
  const combatants = snapshot.combatants;
  // An empty board is an encounter that has not started, not a finished
  // fight. A campaign not in one at all has no board to ask about — its
  // caller holds `encounter === null` and never reaches here.
  if (combatants.length === 0) return "ongoing";

  const pending = combatants.some(
    (each) => each.status === "unconscious" && (each.deathSaves?.successes ?? 0) < 3,
  );
  if (pending) return "ongoing";

  const standing = combatants.filter(
    (each) => each.status === "alive" || each.status === "unconscious",
  );
  const factions = new Set(standing.map((each) => each.faction));
  if (factions.size > 1) return "ongoing";
  if (standing.length === 0) return "defeat";
  return factions.has("party") ? "victory" : "defeat";
}
