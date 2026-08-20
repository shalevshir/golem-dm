// What a creature may propose this turn, derived from its stat block. Lives
// here rather than in the rules engine because `AvailableAction` is this
// package's type — the engine may not depend on it.
import type { CreatureStatBlock } from "@ai-dm/schemas";
import type { AvailableAction } from "./snapshot.js";

export function availableActionsFor(statBlock: CreatureStatBlock): readonly AvailableAction[] {
  return statBlock.actions.map((action) => ({
    actionId: action.actionId,
    name: action.nameEnglish,
  }));
}
