// §4.7 step 2's exit criterion for the content half: every file shipped in
// data/world/ parses against the shape it claims to be. Reading the
// filesystem here is fine — this is a test, not package runtime, exactly as
// srd.test.ts says of itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FactionDefinition,
  LocationDefinition,
  NpcDefinition,
  QuestNode,
  WorldManifest,
} from "./index.js";

const WORLD_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../data/world");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(join(WORLD_DIR, file), "utf8"));
}

describe("the authored world", () => {
  it("parses its manifest", () => {
    const manifest = WorldManifest.parse(readJson("world.json"));
    expect(manifest.worldId).toBe("emberfall");
    expect(manifest.startingNodeId).toBe("arrival");
  });

  // Doubles as the scope guard, which is why it asserts exact counts rather
  // than `toBeGreaterThan`. §4.7 sizes this world at one town, two factions
  // and three NPCs; the arc was five nodes until §4.7 step 5 added the one
  // that declares an encounter, which is the whole point of the combat
  // bridge — moved deliberately, not drifted past.
  it("parses every collection, and is still deliberately tiny", () => {
    expect(LocationDefinition.array().parse(readJson("locations.json"))).toHaveLength(1);
    expect(FactionDefinition.array().parse(readJson("factions.json"))).toHaveLength(2);
    expect(NpcDefinition.array().parse(readJson("npcs.json"))).toHaveLength(3);
    expect(QuestNode.array().parse(readJson("arc.json"))).toHaveLength(6);
  });

  // Exercised by real content rather than only by a unit fixture: an NPC who
  // belongs to neither faction is the case the optional field exists for.
  it("ships an unaligned NPC", () => {
    const npcs = NpcDefinition.array().parse(readJson("npcs.json"));
    const sela = npcs.find((each) => each.npcId === "sela-the-innkeeper");
    expect(sela?.factionId).toBeUndefined();
  });

  // The `.default([])` on `edges` is what lets an arc end. If this node ever
  // grows an edge, the arc no longer terminates and the default is untested
  // by real content.
  it("ends on a terminal node with no outbound edges", () => {
    const nodes = QuestNode.array().parse(readJson("arc.json"));
    const reckoning = nodes.find((each) => each.nodeId === "reckoning");
    expect(reckoning?.edges).toEqual([]);
  });

  // Both effect kinds and both predicate kinds appear in the shipped arc, so
  // the schemas are exercised by content and not only by unit fixtures.
  it("uses both predicate kinds and both effect kinds", () => {
    const nodes = QuestNode.array().parse(readJson("arc.json"));
    const predicateKinds = new Set(nodes.flatMap((n) => n.preconditions.map((p) => p.kind)));
    const effectKinds = new Set(nodes.flatMap((n) => n.effects.map((e) => e.kind)));
    expect(predicateKinds).toEqual(new Set(["node_completed", "faction_band_at_least"]));
    expect(effectKinds).toEqual(new Set(["shift_faction_relation", "advance_calendar"]));
  });
});
