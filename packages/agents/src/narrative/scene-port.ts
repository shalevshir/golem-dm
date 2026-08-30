// The out-of-combat narration contract. A sibling of `port.ts`'s
// `NarrationInput`, not a replacement — a scene turn is one thing that
// happened (the player arrived, was refused, rolled a check, or said
// something that needs a grounded reply), so one `beat` replaces the combat
// brief's array of several actors' beats in a round.
import type { AbilityKey, GrammaticalGender, Skill } from "@ai-dm/schemas";

export type SceneBeat =
  | { kind: "arrived"; locationNameHebrew: string }
  | { kind: "concluded"; locationNameHebrew: string }
  | { kind: "refused"; messages: readonly string[] }
  | { kind: "check"; ability: AbilityKey; skill?: Skill; success: boolean }
  | { kind: "reply"; category: "social" | "combat" | "ooc" };

export interface SceneNarrationInput {
  beat: SceneBeat;
  /** The current node's card. English — invariant 2. */
  sceneEnglish: string;
  playerNameHebrew: string;
  playerGender: GrammaticalGender;
  /** Hebrew names of NPCs present at the node's location. May be empty. */
  npcNamesHebrew: readonly string[];
  /** The previous narrations, Hebrew, oldest first. */
  recentNarrations: readonly string[];
  /**
   * What the DM remembers about this place and these people: step 6's
   * authored NPC facts and standing, plus episodes retrieved from episodic
   * memory. English — translated at generation time like every other piece
   * of game state (invariant 2), never a third sanctioned Hebrew field.
   *
   * Both sources render into one list on purpose. From the narrator's side
   * they are the same thing — things known that did not happen this turn —
   * and a provenance split would be a distinction the prompt has no use for.
   */
  memoryEnglish: readonly string[];
}

export interface SceneNarrativePort {
  /** Token stream. Same streaming contract combat narration uses. */
  stream(input: SceneNarrationInput): AsyncIterable<string>;
}
