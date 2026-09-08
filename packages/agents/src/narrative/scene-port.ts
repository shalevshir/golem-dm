// The out-of-combat narration contract. A sibling of `port.ts`'s
// `NarrationInput`, not a replacement — a scene turn is one thing that
// happened (the player arrived, was refused, rolled a check, or said
// something that needs a grounded reply), so one `beat` replaces the combat
// brief's array of several actors' beats in a round.
import type { AbilityKey, CharacterClass, GrammaticalGender, Skill } from "@ai-dm/schemas";
import type { HealthBand } from "./port.js";

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

/**
 * The player's stable gear and class — the sheet's mirror of `npcsPresent`'s
 * `descriptionEnglish` fix (2026-09-06): a narrator handed only a name and a
 * gender cannot mention class, armor, or weapon, so every fight and every
 * introduction read as though the player carried nothing at all.
 *
 * `level` is a number in the type — same treatment `moveWord`/`countWord`
 * (`narrative/prompt.ts`) give distances and counts — but `scene.ts` renders
 * it as an ordinal WORD, never a digit: `SCENE_SYSTEM_PROMPT`'s "Numbers"
 * rule forbids the narrator from ever stating one, as digits or as words.
 */
export interface PlayerSheet {
  class: CharacterClass;
  /** 1–20. Rendered as an ordinal word ("third"), never a digit. */
  level: number;
  /** Absent when the player wears no body armor. */
  armorNameEnglish?: string;
  /**
   * Always present: an Unarmed Strike is always derived
   * (`DerivedCharacter.attacks` never empty), so a player with nothing else
   * equipped still has a weapon to name.
   */
  weaponNameEnglish: string;
}

export interface SceneNarrationInput {
  beat: SceneBeat;
  /** The current node's card. English — invariant 2. */
  sceneEnglish: string;
  playerNameHebrew: string;
  playerGender: GrammaticalGender;
  /**
   * Stable for as long as the campaign runs — renders unconditionally into
   * the PLAYER block (`scene.ts`'s `semiStatic`), never gated on a per-turn
   * condition: a varying cached prefix costs more than the tokens it would
   * ever save.
   */
  playerSheet: PlayerSheet;
  /**
   * Volatile. Mirrors combat's `FightPulse.heroBand` (`port.ts`) exactly
   * rather than inventing a second health scale (invariant 4). Renders into
   * `dynamic` only when not `"healthy"` — the common turn adds zero tokens.
   *
   * No sibling `conditions` field: conditions exist only on a combat
   * `Combatant` (`world.ts`) today — there is no out-of-combat condition
   * state to source one from. Add it back here once that state exists, not
   * before.
   */
  playerHealthBand: HealthBand;
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
