// The out-of-combat narration contract. A sibling of `port.ts`'s
// `NarrationInput`, not a replacement — a scene turn is one thing that
// happened (the player arrived, was refused, rolled a check, or said
// something that needs a grounded reply), so one `beat` replaces the combat
// brief's array of several actors' beats in a round.
import type { AbilityKey, GrammaticalGender, Skill } from "@ai-dm/schemas";

export type SceneBeat =
  /**
   * The campaign's first beat: the player is standing at the world's
   * `startingNodeId` and nothing has been narrated yet.
   *
   * Distinct from `arrived` because the player did not travel here — the
   * starting node is established by `campaign_started`'s genesis quartet, not
   * by a traversal, so nothing in the log says they went anywhere. Narrating
   * it as `arrived` would open every campaign by describing a journey that
   * never happened. Its own variant rather than a flag, for the reason
   * `ambushed` is: an exhaustive switch then forces each renderer to decide.
   */
  | { kind: "opening"; locationNameHebrew: string }
  | { kind: "arrived"; locationNameHebrew: string }
  // `arrived`'s twin for a node whose entry ALSO opens a combat bracket (the
  // encounter bridge in `pipeline.ts`). A separate variant rather than a flag
  // on `arrived`, so every renderer's exhaustive switch is forced to decide
  // what to do with it: live playtesting found the arrival paragraph
  // describing a quiet walk up to a gate while a fight was already waiting
  // one frame later, purely because nothing in the brief had ever mentioned
  // the ambush. `hostileNamesHebrew` is deduplicated by the caller — two
  // goblins off one stat block are one name here, not the same word twice.
  | { kind: "ambushed"; locationNameHebrew: string; hostileNamesHebrew: readonly string[] }
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
  /**
   * The people standing in this scene. May be empty.
   *
   * Names AND descriptions, where this used to be bare `npcNamesHebrew`: a
   * narrator handed only `מארן וס` can name her and nothing else, so every
   * introduction read as a list of strangers. `descriptionEnglish` is the
   * same authored `NpcDefinition` text the intent router and the GM tier
   * already receive — English, translated at generation time like every
   * other piece of game state (invariant 2), never copied through.
   */
  npcsPresent: readonly { nameHebrew: string; descriptionEnglish: string }[];
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
