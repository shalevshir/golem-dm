import { describe, expect, it } from "vitest";
import {
  ContentId,
  FACTION_BANDS,
  FactionBand,
  NpcAffinityEntry,
  NpcDefinition,
  QuestNode,
  WorldEffect,
  WorldManifest,
  WorldPredicate,
} from "./index.js";

describe("ContentId", () => {
  // Both separators, because both are already in use in this repo:
  // data/srd/monsters files are `goblin_warrior`, encounters are
  // `goblin-ambush`. A rule this module cannot retrofit onto those should
  // not pretend to.
  it.each(["hero", "goblin_warrior", "goblin-ambush", "a1"])("accepts %s", (id) => {
    expect(ContentId.safeParse(id).success).toBe(true);
  });

  // The point of the regex: §4.7 requires events to reference lore by stable
  // id and never by embedded text. No event carries one yet, so this is the
  // only enforcement available — a field that refuses prose cannot quietly
  // become the thing a narrator wrote.
  it.each(["The Ashen Guild", "Hero", "a--b", "-x", "x-", "", "a b"])(
    "refuses %s",
    (id) => {
      expect(ContentId.safeParse(id).success).toBe(false);
    },
  );
});

describe("FactionBand", () => {
  it("has seven bands, so indexOf - 3 is §4.7's -3..+3 scalar", () => {
    expect(FACTION_BANDS).toHaveLength(7);
    expect(FACTION_BANDS.indexOf("war") - 3).toBe(-3);
    expect(FACTION_BANDS.indexOf("neutral") - 3).toBe(0);
    expect(FACTION_BANDS.indexOf("allied") - 3).toBe(3);
  });

  it("is a closed enum", () => {
    expect(FactionBand.safeParse("cold").success).toBe(true);
    expect(FactionBand.safeParse("chummy").success).toBe(false);
  });
});

describe("NpcDefinition", () => {
  const base = {
    npcId: "old-tobin",
    nameEnglish: "Old Tobin",
    nameHebrew: "טובין הזקן",
    grammaticalGender: "masculine",
    locationId: "emberfall",
    descriptionEnglish: "A river warden who has outlived three floods.",
  };

  it("makes factionId optional — an unaligned NPC is the normal case", () => {
    expect(NpcDefinition.safeParse(base).success).toBe(true);
    expect(NpcDefinition.safeParse({ ...base, factionId: "river-wardens" }).success).toBe(true);
  });

  // Hebrew narration is gendered; the same reason MonsterStatBlock carries it
  // (packages/schemas/src/srd.ts:64).
  it("requires grammaticalGender", () => {
    const { grammaticalGender, ...withoutGender } = base;
    expect(grammaticalGender).toBe("masculine");
    expect(NpcDefinition.safeParse(withoutGender).success).toBe(false);
  });
});

describe("QuestNode", () => {
  const base = {
    nodeId: "arrival",
    titleEnglish: "Arrival at Emberfall",
    sceneEnglish: "The road drops out of the pines and the town is below you.",
    locationId: "emberfall",
  };

  it("defaults preconditions, effects and edges to empty", () => {
    const parsed = QuestNode.parse(base);
    expect(parsed.preconditions).toEqual([]);
    expect(parsed.effects).toEqual([]);
    // Empty rather than min(1): node six of a six-node arc ends it.
    expect(parsed.edges).toEqual([]);
  });

  it("carries no Hebrew scene card — the narrator translates (invariant 2)", () => {
    expect(Object.keys(QuestNode.shape)).not.toContain("sceneHebrew");
  });

  it("accepts a node that declares an encounter, and one that does not", () => {
    const withFight = QuestNode.parse({ ...base, encounterId: "goblin-ambush" });
    expect(withFight.encounterId).toBe("goblin-ambush");
    expect(QuestNode.parse(base).encounterId).toBeUndefined();
  });
});

describe("WorldPredicate and WorldEffect", () => {
  it("accepts the two predicate kinds a six-node arc needs", () => {
    expect(
      WorldPredicate.safeParse({ kind: "node_completed", nodeId: "arrival" }).success,
    ).toBe(true);
    expect(
      WorldPredicate.safeParse({
        kind: "faction_band_at_least",
        factionA: "ashen-guild",
        factionB: "river-wardens",
        band: "cold",
      }).success,
    ).toBe(true);
  });

  it("accepts the four effect kinds", () => {
    expect(
      WorldEffect.safeParse({
        kind: "shift_faction_relation",
        factionA: "ashen-guild",
        factionB: "river-wardens",
        delta: -1,
      }).success,
    ).toBe(true);
    expect(WorldEffect.safeParse({ kind: "advance_calendar", days: 1 }).success).toBe(true);
    expect(
      WorldEffect.safeParse({ kind: "shift_npc_affinity", npcId: "sela-the-innkeeper", delta: 1 })
        .success,
    ).toBe(true);
    expect(
      WorldEffect.safeParse({
        kind: "add_npc_fact",
        npcId: "sela-the-innkeeper",
        fact: "helped broker the reckoning",
      }).success,
    ).toBe(true);
  });

  // Same reason shift_faction_relation's delta is checked: FACTION_BANDS[3.5]
  // is undefined, so a fractional delta would find no band at all.
  it("refuses a fractional shift_npc_affinity delta", () => {
    expect(
      WorldEffect.safeParse({ kind: "shift_npc_affinity", npcId: "sela-the-innkeeper", delta: 0.5 })
        .success,
    ).toBe(false);
  });

  it("refuses an empty add_npc_fact fact string", () => {
    expect(
      WorldEffect.safeParse({ kind: "add_npc_fact", npcId: "sela-the-innkeeper", fact: "" })
        .success,
    ).toBe(false);
  });

  // The one field that could run the calendar BACKWARDS — the replay
  // determinism property §4.7's event-driven time decision protects.
  // `WorldManifest.startingDay` has a "refuses day zero" test just below;
  // this is its structural twin.
  it.each([0, -1])("refuses an advance_calendar of %d days", (days) => {
    expect(WorldEffect.safeParse({ kind: "advance_calendar", days }).success).toBe(false);
  });

  // A fractional delta yields a non-integer band index — FACTION_BANDS[3.5]
  // is undefined — so step 3's lookup would find no band at all.
  it("refuses a fractional shift_faction_relation delta", () => {
    expect(
      WorldEffect.safeParse({
        kind: "shift_faction_relation",
        factionA: "ashen-guild",
        factionB: "river-wardens",
        delta: 0.5,
      }).success,
    ).toBe(false);
  });

  // §4.7: regional danger is DERIVED from faction relations and quest
  // progress, never stored, because derived state cannot drift. There is no
  // effect that writes it and there must not be one.
  it("has no effect that stores regional danger", () => {
    expect(
      WorldEffect.safeParse({ kind: "set_regional_danger", level: 3 }).success,
    ).toBe(false);
  });

  it("refuses an unknown kind", () => {
    expect(WorldPredicate.safeParse({ kind: "flag_set", flag: "x" }).success).toBe(false);
  });
});

describe("WorldManifest", () => {
  it("carries a day counter, a start node and the faction relations", () => {
    const parsed = WorldManifest.parse({
      worldId: "emberfall",
      startingDay: 1,
      startingNodeId: "arrival",
      factionRelations: [
        { factionA: "ashen-guild", factionB: "river-wardens", band: "cold" },
      ],
    });
    expect(parsed.startingDay).toBe(1);
    expect(parsed.factionRelations).toHaveLength(1);
  });

  it("refuses day zero", () => {
    expect(
      WorldManifest.safeParse({
        worldId: "emberfall",
        startingDay: 0,
        startingNodeId: "arrival",
        factionRelations: [],
      }).success,
    ).toBe(false);
  });
});

describe("NpcAffinityEntry", () => {
  it("defaults facts to an empty array", () => {
    const parsed = NpcAffinityEntry.parse({ npcId: "sela-the-innkeeper", band: "cordial" });
    expect(parsed.facts).toEqual([]);
  });

  it("accepts declared facts", () => {
    const parsed = NpcAffinityEntry.parse({
      npcId: "sela-the-innkeeper",
      band: "cordial",
      facts: ["helped broker the reckoning"],
    });
    expect(parsed.facts).toEqual(["helped broker the reckoning"]);
  });

  it("rejects an unrecognised band", () => {
    expect(
      NpcAffinityEntry.safeParse({ npcId: "sela-the-innkeeper", band: "smitten" }).success,
    ).toBe(false);
  });
});
