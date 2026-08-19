// Shared test fixture for building a `Combatant`, used by both
// `conclusion.test.ts` (faction/status combinations) and `store.test.ts`
// (fold-parity logs that need full, valid `Combatant` objects for a
// `state_delta_applied` event). Not itself a test file — vitest's include
// glob (`**/*.test.ts`) does not pick it up — so it carries no assertions of
// its own.
import { ActionEconomy } from "@ai-dm/schemas";
import type { Combatant } from "@ai-dm/schemas";

export function combatant(
  id: string,
  faction: Combatant["faction"],
  status: Combatant["status"],
  overrides: Partial<Combatant> = {},
): Combatant {
  return {
    combatantId: id,
    faction,
    position: [0, 0],
    size: "medium",
    speedFeet: 30,
    reachFeet: 5,
    maxHp: 11,
    currentHp: status === "alive" ? 11 : 0,
    tempHp: 0,
    armorClass: 16,
    conditions: [],
    exhaustionLevel: 0,
    attacksPerAction: 1,
    spellSlots: {},
    actionEconomy: ActionEconomy.parse({}),
    status,
    ...overrides,
  };
}
