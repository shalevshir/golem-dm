// The narrative contract, and the material both narrators read.
//
// `NarrationInput` is a BRIEF, not a rule outcome: severity is already
// banded, names are already Hebrew, gender is already resolved. That is
// deliberate — the alternative is each narrator deriving all three from a
// `TurnEffect`, which means the same 5e-adjacent reasoning written twice and
// tested twice.
import type { AttackOutcome, GrammaticalGender } from "@ai-dm/schemas";

export interface NarratedCreature {
  nameHebrew: string;
  /** Hebrew verbs agree with their subject; there is no neutral form. */
  gender: GrammaticalGender;
  /** Board truth, Hebrew-labelled from `conditions.json`. Never invented. */
  conditionsHebrew: readonly string[];
}

/**
 * How hard a landed blow was, as a band rather than a number. `felling` is
 * driven by the engine's own status verdict, never by the damage, so the
 * band cannot disagree with who actually went down.
 */
export type Severity = "graze" | "solid" | "severe" | "felling";

/** "Bloodied at half" follows 5e's own usage. */
export type HealthBand = "healthy" | "bloodied" | "critical";

export type NarrationBeat =
  | { kind: "move"; feet: number }
  | {
      kind: "attack";
      target: NarratedCreature;
      actionNameHebrew: string;
      outcome: AttackOutcome;
      /** Absent on a miss. */
      severity?: Severity;
      /**
       * Narrower than `EntityStatus`, which also has `"fled"`. `applyDamage`
       * only ever derives alive/unconscious/dead from a resolved attack, so
       * `"fled"` is unreachable here — the same reasoning the deterministic
       * renderer already records for refusing a clause it could not test.
       */
      statusAfter: "alive" | "unconscious" | "dead";
    }
  | { kind: "other-action" }
  | { kind: "unresolved" }
  | { kind: "hold" };

export interface FightPulse {
  hostilesStanding: number;
  heroBand: HealthBand;
}

export interface NarrationInput {
  actor: NarratedCreature;
  actorSide: "party" | "hostile";
  beats: readonly NarrationBeat[];
  pulse: FightPulse;
  /** The encounter's scene card. English — see invariant 2. */
  sceneEnglish: string;
  /** The previous two narrations, Hebrew, oldest first. May be empty. */
  recentNarrations: readonly string[];
}

export interface NarrativePort {
  /**
   * Token stream. Language-neutral by contract, unchanged by step 9: the
   * pipeline cannot tell the Hebrew agent from the template renderer.
   */
  stream(input: NarrationInput): AsyncIterable<string>;
}
