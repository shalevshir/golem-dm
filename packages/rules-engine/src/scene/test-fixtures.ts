// Worlds built in TypeScript rather than loaded from `data/world/`. This
// package may not read a file, and a compile-checked fixture is stronger than
// a JSON one for a package that never parses JSON. `src/combat/test-fixtures.ts`
// is the same pattern.
//
// These are NOT miniatures of the shipped Emberfall world. Each exists to put
// a specific input in front of a specific line — the habit step 2's
// whole-branch review prescribed after a fixture built one-defect-per-rule
// left three checks unable to fail.
import type {
  FactionBand,
  FactionDefinition,
  LocationDefinition,
  QuestNode,
} from "@ai-dm/schemas";
import { pairKey } from "./authored-world.js";
import type { AuthoredWorld } from "./authored-world.js";

const HERE: LocationDefinition = {
  locationId: "here",
  nameEnglish: "Here",
  nameHebrew: "כאן",
  descriptionEnglish: "A fixture location.",
};

function faction(factionId: string): FactionDefinition {
  return {
    factionId,
    nameEnglish: factionId,
    nameHebrew: "פלג",
    descriptionEnglish: "A fixture faction.",
  };
}

function node(nodeId: string, rest: Partial<QuestNode> = {}): QuestNode {
  return {
    nodeId,
    titleEnglish: nodeId,
    sceneEnglish: `A fixture node called ${nodeId}.`,
    locationId: "here",
    preconditions: [],
    effects: [],
    edges: [],
    ...rest,
  };
}

function world(
  nodes: readonly QuestNode[],
  options: {
    relations?: readonly (readonly [string, string, FactionBand])[];
  } = {},
): AuthoredWorld {
  const factionIds = new Set(
    (options.relations ?? []).flatMap(([a, b]) => [a, b]),
  );
  return {
    worldId: "fixture",
    startingDay: 1,
    startingNodeId: nodes[0]?.nodeId ?? "start",
    factions: new Map(Array.from(factionIds, (id) => [id, faction(id)])),
    locations: new Map([["here", HERE]]),
    npcs: new Map(),
    questNodes: new Map(nodes.map((each) => [each.nodeId, each])),
    relations: new Map(
      (options.relations ?? []).map(([a, b, band]) => [pairKey(a, b), band]),
    ),
  };
}

/**
 * Three nodes in a line, the middle one gated on the first and carrying both
 * effect kinds. Enough to walk, and enough that "did the effects apply exactly
 * once" has an observable answer.
 */
export function linearWorld(): AuthoredWorld {
  return world(
    [
      node("start", { edges: [{ to: "middle", labelEnglish: "Go on" }] }),
      node("middle", {
        preconditions: [{ kind: "node_completed", nodeId: "start" }],
        effects: [
          { kind: "shift_faction_relation", factionA: "alpha", factionB: "beta", delta: -1 },
          { kind: "advance_calendar", days: 2 },
        ],
        edges: [{ to: "end", labelEnglish: "Finish" }],
      }),
      node("end", {
        effects: [{ kind: "advance_calendar", days: 1 }],
      }),
    ],
    { relations: [["alpha", "beta", "neutral"]] },
  );
}

/**
 * The fixture this step exists for.
 *
 * `start` branches to `open` and `shut`. `shut` demands the two factions be
 * at least `cordial`; they start at `hostile` and nothing shifts them, so the
 * branch is genuinely closed and stays closed. The shipped Emberfall arc
 * CANNOT produce this — `reckoning`'s gate asks for at least `hostile` and
 * `hostile` is the lowest band reachable before it, so an evaluator hard-coded
 * to return true would play that world identically (step 2's whole-branch
 * review).
 *
 * `open` is reachable, so the fixture also proves the closure is specific to
 * the gate rather than to the fixture being broken.
 */
export function blockedWorld(): AuthoredWorld {
  return world(
    [
      node("start", {
        edges: [
          { to: "open", labelEnglish: "The way that works" },
          { to: "shut", labelEnglish: "The way that does not" },
        ],
      }),
      node("open", {
        preconditions: [{ kind: "node_completed", nodeId: "start" }],
      }),
      node("shut", {
        preconditions: [
          {
            kind: "faction_band_at_least",
            factionA: "alpha",
            factionB: "beta",
            band: "cordial",
          },
        ],
      }),
    ],
    { relations: [["alpha", "beta", "hostile"]] },
  );
}
