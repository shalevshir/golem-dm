// The narrative contract. Step 9 swaps in a streaming Hebrew agent; nothing
// else in the pipeline changes when it does.
import type { TurnEffect } from "@ai-dm/rules-engine";

export interface NarrationInput {
  /** Display name of whoever took the turn. */
  actorName: string;
  effect: TurnEffect;
  /** Display names by `combatantId`; a missing entry falls back to the id. */
  namesByCombatantId: Readonly<Record<string, string | undefined>>;
}

export interface NarrativePort {
  /**
   * Token stream. Language-neutral by contract: the stand-in emits English,
   * step 9's agent emits Hebrew, and the pipeline cannot tell the difference.
   */
  stream(input: NarrationInput): AsyncIterable<string>;
}
