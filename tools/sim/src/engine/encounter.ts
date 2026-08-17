// Round and turn sequencing. Knows nothing about models: a decider is a function
// from a board to a validated turn, and the caller decides whether that is the
// tactical agent or the scripted policy.
import type { AvailableAction } from "@ai-dm/agents";
import type { CombatWorld, Rng } from "@ai-dm/rules-engine";
import { startTurn } from "@ai-dm/rules-engine";
import type { Faction } from "@ai-dm/schemas";
import type { BuiltScenario } from "../scenarios/types.js";
import type { DecidedTurn } from "./policy.js";
import type { TurnEffect } from "./resolve.js";
import { applyTurn } from "./resolve.js";

export interface DecideInput {
  world: CombatWorld;
  actorId: string;
  availableActions: readonly AvailableAction[];
  round: number;
}

/** Returns null when the actor has no legal turn at all; the encounter moves on. */
export type TurnDecider = (input: DecideInput) => Promise<DecidedTurn | null>;

export interface TurnLogEntry {
  round: number;
  actorId: string;
  faction: Faction;
  effect: TurnEffect;
}

export interface EncounterResult {
  /** Null when `maxRounds` ran out with both sides still standing. */
  winner: Faction | null;
  rounds: number;
  log: readonly TurnLogEntry[];
  damageByFaction: Record<Faction, number>;
  finalWorld: CombatWorld;
}

export interface RunEncounterInput {
  scenario: BuiltScenario;
  rng: Rng;
  deciderFor: (faction: Faction) => TurnDecider;
}

const FIGHTING_FACTIONS: readonly Faction[] = ["party", "hostile"];

function livingFactions(world: CombatWorld): Set<Faction> {
  return new Set(
    world.combatants.filter((each) => each.status === "alive").map((each) => each.faction),
  );
}

/** The last faction standing, or null while both are still in it. */
function winnerOf(world: CombatWorld): Faction | null {
  const living = livingFactions(world);
  const remaining = FIGHTING_FACTIONS.filter((faction) => living.has(faction));
  return remaining.length === 1 ? (remaining[0] ?? null) : null;
}

export async function runEncounter(input: RunEncounterInput): Promise<EncounterResult> {
  const { scenario } = input;
  let world = scenario.world;
  const log: TurnLogEntry[] = [];
  const damageByFaction: Record<Faction, number> = { party: 0, hostile: 0, neutral: 0 };

  let round = 0;
  let winner: Faction | null = null;

  while (round < scenario.maxRounds && winner === null) {
    round += 1;

    for (const actorId of scenario.turnOrder) {
      const actor = world.combatants.find((each) => each.combatantId === actorId);
      if (actor === undefined || actor.status !== "alive") continue;

      // A fresh action economy is the start of a turn. Doing it here rather than
      // in the decider keeps every decider honest about its budget.
      world = {
        ...world,
        combatants: world.combatants.map((each) =>
          each.combatantId === actorId ? { ...each, actionEconomy: startTurn() } : each,
        ),
      };

      const decided = await input.deciderFor(actor.faction)({
        world,
        actorId,
        availableActions: scenario.availableActions.get(actorId) ?? [],
        round,
      });
      if (decided === null) continue;

      const applied = applyTurn({
        world,
        actorId,
        turn: decided.turn,
        plan: decided.plan,
        context: { statBlocks: scenario.statBlocks },
        rng: input.rng,
      });

      world = applied.world;
      damageByFaction[actor.faction] += applied.effect.damageDealt;
      log.push({ round, actorId, faction: actor.faction, effect: applied.effect });

      winner = winnerOf(world);
      if (winner !== null) break;
    }
  }

  return { winner, rounds: round, log, damageByFaction, finalWorld: world };
}
