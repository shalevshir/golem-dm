// §4.7 step 2's exit criterion for the content half: every file shipped in
// data/world/ parses against the shape it claims to be. Reading the
// filesystem here is fine — this is a test, not package runtime, exactly as
// srd.test.ts says of itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FACTION_BANDS,
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
  // than `toBeGreaterThan`. §4.7 sizes this world at one town, two factions,
  // three NPCs and a five-node arc — "enough to prove the pipeline, not to be
  // good". Growing it should be a deliberate act that edits these numbers,
  // not something that happens while adding colour.
  it("parses every collection, and is still deliberately tiny", () => {
    expect(LocationDefinition.array().parse(readJson("locations.json"))).toHaveLength(1);
    expect(FactionDefinition.array().parse(readJson("factions.json"))).toHaveLength(2);
    expect(NpcDefinition.array().parse(readJson("npcs.json"))).toHaveLength(3);
    expect(QuestNode.array().parse(readJson("arc.json"))).toHaveLength(5);
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

  // Standing in for §4.7 step 3's not-yet-built predicate evaluator: nothing
  // in this codebase evaluates `faction_band_at_least` today, so a changed
  // `delta` or starting `band` could make reckoning's gate unwinnable on
  // every path and nothing would notice until step 3 exists. Every number
  // below is read out of the shipped JSON rather than hard-coded, so an edit
  // to any of them re-runs this same check against the new values instead of
  // going stale.
  it("reckoning's faction_band_at_least gate is satisfiable on both paths through the arc", () => {
    const manifest = WorldManifest.parse(readJson("world.json"));
    const nodes = QuestNode.array().parse(readJson("arc.json"));

    // `FACTION_BANDS.indexOf(band) - 3` is the -3..+3 score; step 3's engine
    // clamps to that range when applying a shift, so this test does too.
    const score = (band: (typeof FACTION_BANDS)[number]): number => FACTION_BANDS.indexOf(band) - 3;
    const clamp = (n: number): number => Math.max(-3, Math.min(3, n));

    const reckoning = nodes.find((each) => each.nodeId === "reckoning");
    if (!reckoning) throw new Error("arc.json must define a reckoning node");
    const gate = reckoning.preconditions.find((each) => each.kind === "faction_band_at_least");
    if (!gate) throw new Error("reckoning must have a faction_band_at_least precondition");

    const startRelation = manifest.factionRelations.find(
      (each) => each.factionA === gate.factionA && each.factionB === gate.factionB,
    );
    if (!startRelation) {
      throw new Error(`world.json has no relation between ${gate.factionA} and ${gate.factionB}`);
    }
    const requiredScore = score(gate.band);
    const startScore = score(startRelation.band);

    // The shift a node's own `shift_faction_relation` effect applies to the
    // gated pair, or 0 if it has none — true of `warden-warning`, whose only
    // effect is `advance_calendar`.
    const deltaAt = (nodeId: string): number => {
      const node = nodes.find((each) => each.nodeId === nodeId);
      if (!node) throw new Error(`arc.json must define a ${nodeId} node`);
      const shift = node.effects.find(
        (each) =>
          each.kind === "shift_faction_relation" &&
          each.factionA === gate.factionA &&
          each.factionB === gate.factionB,
      );
      if (!shift || shift.kind !== "shift_faction_relation") return 0;
      return shift.delta;
    };

    const guildPathScore = clamp(startScore + deltaAt("guild-offer"));
    const wardenPathScore = clamp(startScore + deltaAt("warden-warning"));

    expect(guildPathScore).toBeGreaterThanOrEqual(requiredScore);
    expect(wardenPathScore).toBeGreaterThanOrEqual(requiredScore);
  });
});
