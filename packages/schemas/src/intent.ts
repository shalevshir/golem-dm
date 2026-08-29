// The intent router's closed-choice classification of free-text player input.
// See docs/superpowers/specs/2026-08-28-intent-router-design.md, Decision 5:
// a closed discriminated union (never freeform prose) is what keeps invariant
// 1 intact — the model proposes a category and enum words, never a number.
import { z } from "zod";
import { AbilityKey, Skill } from "./character.js";
import { ContentId } from "./content.js";

/**
 * SRD 5.2.1 "Typical Difficulty Classes" task-difficulty labels. The DCs
 * behind these labels live in `@ai-dm/rules-engine`'s `checks/` module
 * (`DC_BY_DIFFICULTY`), not here — this package has no DC authority.
 */
export const CheckDifficulty = z.enum([
  "very_easy",
  "easy",
  "medium",
  "hard",
  "very_hard",
  "nearly_impossible",
]);
export type CheckDifficulty = z.infer<typeof CheckDifficulty>;

/**
 * The intent router's tool schema, parse, and type all at once (invariant
 * 4). A `check` proposes an ability, an optional skill, and a difficulty
 * label — never a DC number — leaving DC resolution to the rules engine.
 */
export const IntentClassification = z.discriminatedUnion("category", [
  z.object({ category: z.literal("exploration"), targetNodeId: ContentId.nullable() }),
  z.object({
    category: z.literal("check"),
    ability: AbilityKey,
    skill: Skill.optional(),
    difficulty: CheckDifficulty,
  }),
  z.object({ category: z.literal("social") }),
  z.object({ category: z.literal("combat") }),
  z.object({ category: z.literal("ooc") }),
]);
export type IntentClassification = z.infer<typeof IntentClassification>;
