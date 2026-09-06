// What the GM tier proposes and the scene engine validates — the
// `NarrativeMove` PROJECT_PLAN.md §4.7's "The governing constraint" names.
// See docs/superpowers/specs/2026-08-31-narrative-move-design.md.
//
// A closed union, like `IntentClassification` and for the same reason: the
// model composes a move from a fixed vocabulary of already-existing ids and
// enum words, and a pure engine decides whether it is legal. Nothing here can
// name an NPC, a faction or a node the authored world does not already have.
//
// Note for whoever routes this tier: a `z.discriminatedUnion` compiles to
// `anyOf`, which google's tool-schema subset rejects with a 400. This must
// route to openai, exactly as `intent` does.
import { z } from "zod";
import {
  AddNpcFactEffect,
  AdvanceCalendarEffect,
  ContentId,
  ShiftFactionRelationEffect,
  ShiftNpcAffinityEffect,
} from "./content.js";

/**
 * `WorldEffect` minus `long_rest`, composed from that union's own members
 * rather than re-declared (invariant 4).
 *
 * `long_rest` is excluded because restoring the hero to full HP is the one
 * effect with no narrative reading a conversation should be able to produce.
 * Every other kind is something a scene genuinely can change.
 *
 * The magnitude bound on a shift is NOT tightened here. `validateMove`
 * (`@ai-dm/rules-engine`) refuses an improvised `|delta| > 1`, so this stays
 * a pure subset of `WorldEffect` with no divergent bound to keep in sync —
 * authored content keeps the full -6..+6 range on purpose.
 */
export const ImprovisedEffect = z.discriminatedUnion("kind", [
  ShiftFactionRelationEffect,
  AdvanceCalendarEffect,
  ShiftNpcAffinityEffect,
  AddNpcFactEffect,
]);

/**
 * `none` is always legal and is what EVERY failure path degrades to — a
 * timeout, a provider error, and an engine refusal all produce it. So "the
 * model had nothing to add" and "the call did not work" take the same,
 * already-correct branch rather than needing two.
 *
 * `reasonEnglish` is required on both mutating kinds. §4.7: shifts are
 * "declared effects of specific logged choices, with a reason — not a hidden
 * morality meter", because "why did my character become this" has to be
 * answerable from the event stream. English, so invariant 2 is untouched;
 * `quest_node_completed.summaryEnglish` is the precedent for model-written
 * English in a payload.
 *
 * `enter_detour` carries no effects of its own: a detour node's authored
 * `effects` already fire through `completed()`, and a second path into the
 * same state change is a second path that can disagree with the first.
 */
export const NarrativeMove = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("world"),
    /** At most two: a move is a beat, not a chapter. */
    effects: z.array(ImprovisedEffect).min(1).max(2),
    reasonEnglish: z.string().min(1),
  }),
  z.object({
    kind: z.literal("enter_detour"),
    nodeId: ContentId,
    reasonEnglish: z.string().min(1),
  }),
]);

export type ImprovisedEffect = z.infer<typeof ImprovisedEffect>;
export type NarrativeMove = z.infer<typeof NarrativeMove>;
