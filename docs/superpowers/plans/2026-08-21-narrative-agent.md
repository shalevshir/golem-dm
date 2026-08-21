# Hebrew Narrative Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the English deterministic stand-in narrator with a streaming Sonnet 5 agent that emits grounded Hebrew prose, and make every failure path emit complete Hebrew rather than English or a severed sentence.

**Architecture:** A pure `buildNarrationBrief()` converts a `TurnEffect` plus the world into narratable material — Hebrew names, grammatical gender, engine-computed severity bands, a fight pulse. Both narrators consume that brief: `createHebrewNarrative()` streams it through a layered prompt, and a rewritten Hebrew `createDeterministicNarrative()` renders it as terse templates. `NarrativePort` is unchanged; the pipeline owns a single degradation ladder covering a provider error and a spent turn budget alike.

**Tech Stack:** TypeScript 5 strict, ESM, Node 22, zod 3, Vitest 3, Vercel AI SDK v4 (via the existing `LanguageModelPort`), React 19 for the web slice.

**Spec:** [`docs/superpowers/specs/2026-08-21-narrative-agent-design.md`](../specs/2026-08-21-narrative-agent-design.md)

## Global Constraints

- **English inside, Hebrew outside.** Prompts, state, tool schemas, logs and code comments are English. Hebrew exists only in narrative output, `nameHebrew` data values, and the web UI.
- **The rules engine is the only authority on legality and math.** The narrator describes what already happened; it never decides an outcome.
- **Event log is the source of truth.** Every mutation goes through an event; appending an event and yielding its frame is one operation.
- **Schemas define everything once.** Types, runtime validation and LLM tool definitions all derive from `@ai-dm/schemas`. Never hand-write a duplicate interface.
- **Dependency direction:** `schemas ← rules-engine ← agents ← server`. `web` depends only on `schemas`. Nothing depends on `server`.
- **`diesAtZeroHp` stays pinned `true`.** Do not unpin it. Nothing in the pipeline can produce an `unconscious` combatant; the `unconscious` beat is rendered but unreachable.
- **No live API calls in CI.** Agent tests use `packages/agents/src/providers/testing/fake-port.ts`. Live benchmarks live in `tools/sim`.
- **`narrative_emitted` must carry exactly the concatenation of the `narrative_token` frames yielded for that turn.** No trimming, no retroactive replacement.
- **ESM with `.js` extensions in relative imports.** `"type": "module"` everywhere.
- **ESLint `strictTypeChecked`:** `[...str]` is banned (use `Array.from(str, fn)`); `_`-prefixed unused params still error; type lookups as `Record<string, T | undefined>` rather than `as keyof typeof`.
- **`corepack enable` before any pnpm command.** Never run root `pnpm lint` (walks sibling worktrees) or `pnpm format` (rewrites ~37 files). Lint with `npx eslint packages apps tools`.
- **Baseline to preserve:** `pnpm test` 1042 passed / 76 files, `pnpm typecheck` exit 0, `npx eslint packages apps tools` exit 0.

---

## File Structure

**`@ai-dm/schemas`**
- `src/srd.ts` — `CreatureStatBlock.grammaticalGender`; `ConditionDefinition.nameHebrew`
- `src/events.ts` — `NarrativeEmittedPayload` convention

**`@ai-dm/rules-engine`**
- `src/encounter/build.ts` — `EncounterDefinition.sceneEnglish`, carried onto `BuiltEncounter`
- `src/character/derive.ts` — `characterStatBlock` passes gender through

**`@ai-dm/agents`**
- `src/rules-digest.ts` (+ test) — English conditions/economy/cover digest, hash-pinned
- `src/narrative/port.ts` — brief types; `NarrativePort` unchanged
- `src/narrative/brief.ts` (+ test) — `buildNarrationBrief`, severity, pulse. Pure.
- `src/narrative/deterministic.ts` (+ test) — Hebrew template renderer
- `src/narrative/prompt-text.ts` (+ test) — system prompt, glossary, version, hash pin
- `src/narrative/prompt.ts` (+ test) — `buildNarrativePrompt`
- `src/narrative/hebrew.ts` (+ test) — `createHebrewNarrative`
- `src/narrative/index.ts` — exports

**`@ai-dm/server`**
- `src/encounters/conditions.ts` (+ test) — the first runtime loader for `conditions.json`
- `src/encounters/index.ts` — `goblin-ambush` scene card
- `src/core/session.ts` — `Session` gains `sceneEnglish` and `recentNarrations`
- `src/core/pipeline.ts` — `narrate()` builds the brief and applies the ladder
- `src/main.ts` — wires the Hebrew agent when a provider key exists

**`@ai-dm/web`** — `CombatLog.tsx`, `ActionBar.tsx`, `Grid.tsx` render `nameHebrew`

**`@ai-dm/sim`** — `src/scenarios/*` gain scene cards; `src/live/narrative.ts` TTFT benchmark; `src/live/review-sheet.ts` generator

**Data** — 11 files under `data/srd/monsters/`; `data/srd/conditions.json`

**Docs** — `docs/prompts/README.md`, `docs/prompts/hebrew-glossary.md`, `PROJECT_PLAN.md`, `RULES_REFERENCE.md`

---

## Task 1: `grammaticalGender` on every stat block

**Files:**
- Modify: `packages/schemas/src/srd.ts:50-60` (`CreatureStatBlock`)
- Modify: `packages/rules-engine/src/character/derive.ts:159-170` (`characterStatBlock`)
- Modify: `data/srd/monsters/*.json` — all 11 files
- Test: `packages/schemas/src/srd.test.ts`, `packages/rules-engine/src/character/derive.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CreatureStatBlock.grammaticalGender: GrammaticalGender` (required, `"masculine" | "feminine"`). Every later task that names a creature reads it.

- [ ] **Step 1: Write the failing schema test**

In `packages/schemas/src/srd.test.ts`, add:

```ts
it("requires a grammaticalGender on every creature stat block", () => {
  const { grammaticalGender, ...withoutGender } = MINIMAL_STAT_BLOCK;
  expect(grammaticalGender).toBe("masculine");
  expect(() => CreatureStatBlock.parse(withoutGender)).toThrow();
});

it("rejects a grammatical gender outside the enum", () => {
  expect(() => CreatureStatBlock.parse({ ...MINIMAL_STAT_BLOCK, grammaticalGender: "neuter" })).toThrow();
});
```

Add `grammaticalGender: "masculine"` to whatever minimal fixture that file already uses, naming it `MINIMAL_STAT_BLOCK` if it is currently inline.

- [ ] **Step 2: Run it and watch it fail**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `CreatureStatBlock.parse(withoutGender)` currently succeeds, because the field does not exist.

- [ ] **Step 3: Add the field**

In `packages/schemas/src/srd.ts`, import `GrammaticalGender` from `./character.js` and add to `CreatureStatBlock`:

```ts
  /**
   * Hebrew verbs agree with their subject, so a narrator cannot write a
   * sentence about a creature without knowing this. Required rather than
   * defaulted: a default would let a new monster ship silently ungendered
   * and narrate wrong, which is exactly the failure `nameHebrew` being
   * required already rules out.
   */
  grammaticalGender: GrammaticalGender,
```

- [ ] **Step 4: Add the field to all 11 monster files**

Every current SRD monster name is masculine in Hebrew (גובלין לוחם, גובלין משרת, זאב, שלד, זומבי, אוגר, שודד, קפטן שודדים, שומר, חבר כת, חזיר בר), so all 11 take the same value:

```bash
for f in data/srd/monsters/*.json; do
  python3 - "$f" <<'PY'
import json, sys, collections
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh, object_pairs_hook=collections.OrderedDict)
if "grammaticalGender" not in data:
    rebuilt = collections.OrderedDict()
    for key, value in data.items():
        rebuilt[key] = value
        if key == "nameHebrew":
            rebuilt["grammaticalGender"] = "masculine"
    data = rebuilt
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY
done
```

Then confirm all 11 were touched:

```bash
grep -l grammaticalGender data/srd/monsters/*.json | wc -l
```

Expected: `11`.

- [ ] **Step 5: Write the failing character-projection test**

In `packages/rules-engine/src/character/derive.test.ts`:

```ts
it("carries the sheet's grammatical gender onto the projected stat block", () => {
  const derived = deriveCharacter(HERO_SHEET, GEAR);
  expect(characterStatBlock(derived).grammaticalGender).toBe(derived.grammaticalGender);
});
```

Reuse the sheet and gear fixtures already in that file.

- [ ] **Step 6: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/rules-engine test
```

Expected: FAIL — the projection omits the field, so it reads `undefined`.

- [ ] **Step 7: Pass it through the projection**

In `packages/rules-engine/src/character/derive.ts`, inside `characterStatBlock`'s returned object, after `nameHebrew`:

```ts
    grammaticalGender: derived.grammaticalGender,
```

- [ ] **Step 8: Run the full suite**

```bash
pnpm test
```

Expected: PASS everywhere. If a monster fixture built inline in some other test now fails to parse, add `grammaticalGender: "masculine"` to it — do not relax the schema.

- [ ] **Step 9: Commit**

```bash
git add packages/schemas/src/srd.ts packages/schemas/src/srd.test.ts \
        packages/rules-engine/src/character/derive.ts packages/rules-engine/src/character/derive.test.ts \
        data/srd/monsters
git commit -m "feat(schemas): require grammaticalGender on every creature stat block"
```

---

## Task 2: Hebrew condition names and their first runtime loader

**Files:**
- Modify: `packages/schemas/src/srd.ts:74-78` (`ConditionDefinition`)
- Modify: `data/srd/conditions.json` — all 15 conditions
- Create: `apps/server/src/encounters/conditions.ts`
- Test: `apps/server/src/encounters/conditions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ConditionDefinition.nameHebrew: string`; `loadConditions(): ReadonlyMap<Condition, ConditionDefinition>` exported from `apps/server/src/encounters/conditions.ts` and re-exported from `apps/server/src/encounters/index.ts`.

Note: `nameHebrew` goes on the condition only, **not** on each effect. Effects carry `ruleEnglish`, which feeds the English rules digest in Task 6; Hebrew there would be ~40 unused strings.

- [ ] **Step 1: Write the failing schema and data test**

In `packages/schemas/src/srd.test.ts`, extend the existing conditions test (the file already parses `conditions.json` at line ~58):

```ts
it("gives every SRD condition a Hebrew name", () => {
  const parsed = ConditionDefinition.array().parse(readJson(join(SRD_DIR, "conditions.json")));
  expect(parsed).toHaveLength(15);
  for (const definition of parsed) {
    expect(definition.nameHebrew.trim()).not.toBe("");
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `nameHebrew` is not on the schema, so it is stripped and reads `undefined`.

- [ ] **Step 3: Add the field**

In `packages/schemas/src/srd.ts`:

```ts
export const ConditionDefinition = z.object({
  condition: Condition,
  nameEnglish: z.string(),
  /**
   * The one place a condition's Hebrew name lives. Deliberately not
   * duplicated into `docs/prompts/hebrew-glossary.md`, which covers rules
   * vocabulary rather than anything that has a data row of its own.
   */
  nameHebrew: z.string().min(1),
  effects: z.array(z.object({ nameEnglish: z.string(), ruleEnglish: z.string() })).min(1),
});
```

- [ ] **Step 4: Add the Hebrew names to the data**

These 15 values are the narrator's condition vocabulary. They are review items — Task 16's sheet puts them in front of a native speaker.

```bash
python3 - <<'PY'
import json, collections, pathlib
NAMES = {
    "blinded": "עיוור", "charmed": "מוקסם", "deafened": "חירש",
    "frightened": "מבועת", "grappled": "אחוז", "incapacitated": "נטול יכולת",
    "invisible": "בלתי נראה", "paralyzed": "משותק", "petrified": "מאובן",
    "poisoned": "מורעל", "prone": "שרוע", "restrained": "כבול",
    "stunned": "המום", "unconscious": "מחוסר הכרה", "exhaustion": "תשישות",
}
path = pathlib.Path("data/srd/conditions.json")
rows = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
assert len(rows) == len(NAMES), f"expected {len(NAMES)} conditions, found {len(rows)}"
out = []
for row in rows:
    rebuilt = collections.OrderedDict()
    for key, value in row.items():
        rebuilt[key] = value
        if key == "nameEnglish":
            rebuilt["nameHebrew"] = NAMES[row["condition"]]
    out.append(rebuilt)
path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("ok")
PY
```

- [ ] **Step 5: Run the schema test**

```bash
pnpm --filter @ai-dm/schemas test
```

Expected: PASS.

- [ ] **Step 6: Write the failing loader test**

Create `apps/server/src/encounters/conditions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConditions } from "./conditions.js";

describe("loadConditions", () => {
  it("loads every SRD condition keyed by its id", () => {
    const conditions = loadConditions();
    expect(conditions.size).toBe(15);
    expect(conditions.get("prone")?.nameHebrew).toBe("שרוע");
  });

  it("returns the same cached instance on a second call", () => {
    expect(loadConditions()).toBe(loadConditions());
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test conditions
```

Expected: FAIL — `./conditions.js` does not exist. `conditions.json` has had no runtime loader at all; only `packages/schemas/src/srd.test.ts` has ever read it.

- [ ] **Step 8: Write the loader**

Create `apps/server/src/encounters/conditions.ts`:

```ts
// Reads `data/srd/conditions.json`. Content is CC-BY-4.0; see NOTICE.md.
//
// This file is the first runtime consumer of that data — before it, only
// `packages/schemas/src/srd.test.ts` read it. File I/O lives here for the
// same reason it lives in `srd.ts` and `gear.ts`: `@ai-dm/rules-engine`
// forbids I/O and `@ai-dm/schemas` is bundled for the browser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConditionDefinition } from "@ai-dm/schemas";
import type { Condition } from "@ai-dm/schemas";
import { dataDir } from "./srd.js";

const SRD_DIR_RELATIVE = join("data", "srd");

let cached: ReadonlyMap<Condition, ConditionDefinition> | undefined;

/** Parsed once — the file never changes at runtime. */
export function loadConditions(): ReadonlyMap<Condition, ConditionDefinition> {
  if (cached !== undefined) return cached;

  const path = join(dataDir(SRD_DIR_RELATIVE), "conditions.json");
  const rows = ConditionDefinition.array().parse(JSON.parse(readFileSync(path, "utf8")));
  cached = new Map(rows.map((each) => [each.condition, each]));
  return cached;
}
```

Re-export it from `apps/server/src/encounters/index.ts` beside `loadCharacter` and `loadMonster`:

```ts
import { loadConditions } from "./conditions.js";
export { loadCharacter, loadConditions, loadMonster };
```

- [ ] **Step 9: Run the tests**

```bash
pnpm --filter @ai-dm/server test conditions && pnpm test
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/schemas/src/srd.ts packages/schemas/src/srd.test.ts data/srd/conditions.json \
        apps/server/src/encounters/conditions.ts apps/server/src/encounters/conditions.test.ts \
        apps/server/src/encounters/index.ts
git commit -m "feat: give SRD conditions Hebrew names and a runtime loader"
```

---

## Task 3: The scene card on `EncounterDefinition`

**Files:**
- Modify: `packages/rules-engine/src/encounter/build.ts:45-65` (`EncounterDefinition`, `BuiltEncounter`)
- Modify: `apps/server/src/encounters/index.ts` (`GOBLIN_AMBUSH`)
- Modify: `tools/sim/src/scenarios/types.ts`, `melee-brawl.ts`, `ranged-approach.ts`, `cover-corridor.ts`, `ogre-charge.ts`
- Test: `packages/rules-engine/src/encounter/build.test.ts`, `apps/server/src/encounters/index.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EncounterDefinition.sceneEnglish: string` (required) and `BuiltEncounter.sceneEnglish: string`. Task 11 reads it off the built encounter.

- [ ] **Step 1: Write the failing test**

In `packages/rules-engine/src/encounter/build.test.ts`:

```ts
it("carries the scene card onto the built encounter", () => {
  const built = buildEncounter({
    definition: { ...MINIMAL_DEFINITION, sceneEnglish: "A damp stone cellar lit by one guttering torch." },
    statBlocks: MINIMAL_STAT_BLOCKS,
  });
  expect(built.sceneEnglish).toBe("A damp stone cellar lit by one guttering torch.");
});
```

Reuse the fixtures already in that file.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/rules-engine test build
```

Expected: FAIL — `built.sceneEnglish` is `undefined`.

- [ ] **Step 3: Add the field to both interfaces**

In `packages/rules-engine/src/encounter/build.ts`, on `EncounterDefinition` immediately after `descriptionEnglish`:

```ts
  /**
   * English atmosphere for the narrative agent: ground, light, sound. Held
   * apart from `descriptionEnglish`, which summarises the encounter for an
   * operator ("two goblin warriors on an open 12x12 field") — folding the
   * two would drag that summary toward prose. Required, so an encounter
   * cannot narrate against an empty stage without someone noticing.
   */
  sceneEnglish: string;
```

Amend `descriptionEnglish`'s own comment to `/** English. Says what this encounter is, for an operator. See sceneEnglish for the narrator's copy. */`.

Add `sceneEnglish: string;` to `BuiltEncounter`, and copy it through in `buildEncounter`'s returned object.

- [ ] **Step 4: Give `goblin-ambush` its card**

In `apps/server/src/encounters/index.ts`, inside `GOBLIN_AMBUSH` after `descriptionEnglish`:

```ts
  sceneEnglish:
    "Late afternoon on a rocky hillside track. The ground is dry, broken stone " +
    "and loose scree; low thorn scrub crowds both sides of the path. The light " +
    "is flat and orange, the air still, and sound carries.",
```

- [ ] **Step 5: Give the four sim scenarios cards**

Add `sceneEnglish` to the scenario type in `tools/sim/src/scenarios/types.ts` (mirroring how `descriptionEnglish` is declared there), then one line per scenario. These are benchmark fixtures, so the cards say so honestly rather than inventing atmosphere:

```ts
sceneEnglish: "A featureless benchmark arena. No terrain features worth describing.",
```

- [ ] **Step 6: Run everything**

```bash
pnpm test && pnpm typecheck
```

Expected: PASS, exit 0. Any remaining `EncounterDefinition` literal the compiler flags needs a card, not an optional field.

- [ ] **Step 7: Commit**

```bash
git add packages/rules-engine/src/encounter apps/server/src/encounters/index.ts \
        apps/server/src/encounters/index.test.ts tools/sim/src/scenarios
git commit -m "feat(rules-engine): add a narrator-facing scene card to every encounter"
```

---

## Task 4: The `narrative_emitted` payload convention

**Files:**
- Modify: `packages/schemas/src/events.ts`
- Test: `packages/schemas/src/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NarrativeEmittedPayload` (zod schema + inferred type) and `NarrationSource = "model" | "deterministic" | "completed"`. Task 12 emits it; Task 15 reads `source` out of the log.

- [ ] **Step 1: Write the failing test**

In `packages/schemas/src/events.test.ts`:

```ts
describe("NarrativeEmittedPayload", () => {
  const valid = {
    actorId: "hero",
    streamId: "s-1",
    text: "אלדד מתקדם.",
    source: "model",
    promptVersion: "2026-08-21.1",
  };

  it("accepts a well-formed payload", () => {
    expect(NarrativeEmittedPayload.parse(valid).source).toBe("model");
  });

  it("rejects a source outside the three the pipeline can produce", () => {
    expect(() => NarrativeEmittedPayload.parse({ ...valid, source: "guess" })).toThrow();
  });

  it("rejects empty narration text", () => {
    expect(() => NarrativeEmittedPayload.parse({ ...valid, text: "" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/schemas test events
```

Expected: FAIL — `NarrativeEmittedPayload` is not exported.

- [ ] **Step 3: Add the convention**

In `packages/schemas/src/events.ts`, beside the existing `ActionRejectedPayload`:

```ts
/** Where a turn's narration actually came from. Metrics only, never correctness. */
export const NarrationSource = z.enum(["model", "deterministic", "completed"]);
export type NarrationSource = z.infer<typeof NarrationSource>;

/**
 * Payload convention for the `narrative_emitted` event, in the same spirit as
 * `ActionRejectedPayload`: the server stamps the envelope, this documents the
 * body.
 *
 * `text` is the ONLY place Hebrew is allowed in the event log.
 *
 * `source` exists because a narrated turn and a fallback turn are
 * indistinguishable from the text alone once the fallback is Hebrew too, and
 * the ratio between them is the single most useful number the step 9
 * benchmark produces. `promptVersion` does for narration what it already does
 * for `action_rejected`: keeps runs taken either side of a prompt edit from
 * being pooled.
 */
export const NarrativeEmittedPayload = z.object({
  actorId: z.string(),
  streamId: z.string(),
  text: z.string().min(1),
  source: NarrationSource,
  promptVersion: z.string().min(1),
});

export type NarrativeEmittedPayload = z.infer<typeof NarrativeEmittedPayload>;
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @ai-dm/schemas test && pnpm typecheck
```

Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/events.ts packages/schemas/src/events.test.ts
git commit -m "feat(schemas): document the narrative_emitted payload with source and promptVersion"
```

---
## Task 5: The narration brief

**Files:**
- Modify: `packages/agents/src/narrative/port.ts` (replaced wholesale)
- Create: `packages/agents/src/narrative/brief.ts`
- Test: `packages/agents/src/narrative/brief.test.ts`
- Modify: `packages/agents/src/narrative/index.ts`

**Interfaces:**
- Consumes: `CreatureStatBlock.grammaticalGender` (Task 1), `ConditionDefinition.nameHebrew` (Task 2).
- Produces: `NarratedCreature`, `Severity`, `HealthBand`, `NarrationBeat`, `FightPulse`, `NarrationInput`, `NarrativePort` (signature unchanged), and `buildNarrationBrief(input: NarrationBriefInput): NarrationInput`, `severityFor(damage, targetMaxHp, statusAfter): Severity`, `healthBandFor(currentHp, maxHp): HealthBand`.

This task **breaks** `deterministic.ts` and `pipeline.ts`, which still read the old `NarrationInput`. Tasks 7 and 12 repair them. Expect `pnpm typecheck` to fail between here and Task 7 — that is the intended shape of the change, not a mistake.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/narrative/brief.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Combatant, Condition, CreatureStatBlock } from "@ai-dm/schemas";
import type { TurnEffect } from "@ai-dm/rules-engine";
import { buildNarrationBrief, healthBandFor, severityFor } from "./brief.js";

const GOBLIN: CreatureStatBlock = {
  nameEnglish: "Goblin Warrior",
  nameHebrew: "גובלין לוחם",
  grammaticalGender: "masculine",
  size: "small",
  armorClass: 13,
  hitPoints: { average: 8, diceNotation: "2d6+1" },
  speedFeet: 30,
  attacksPerAction: 1,
  actions: [
    {
      actionId: "scimitar",
      nameEnglish: "Scimitar",
      nameHebrew: "חרב מעוקלת",
      attackBonus: 4,
      reachFeet: 5,
      damage: { diceNotation: "1d6+2", damageType: "slashing" },
      extraDamage: [],
    },
  ],
};

const HERO: CreatureStatBlock = { ...GOBLIN, nameEnglish: "hero", nameHebrew: "אלדד", hitPoints: { average: 28, diceNotation: "3d10+6" } };

function combatant(overrides: Partial<Combatant> & Pick<Combatant, "combatantId">): Combatant {
  return {
    faction: "hostile", position: [0, 0], size: "medium", speedFeet: 30, reachFeet: 5,
    maxHp: 8, currentHp: 8, tempHp: 0, armorClass: 13, conditions: [], exhaustionLevel: 0,
    attacksPerAction: 1, spellSlots: {}, actionEconomy: {}, status: "alive", ...overrides,
  };
}

const EMPTY_EFFECT: TurnEffect = {
  attacks: [], damageDealt: 0, killed: [], movedFeet: 0,
  nonAttackAction: false, unresolvedActionIds: [],
};

const CONDITION_NAMES = new Map<Condition, string>([["prone", "שרוע"]]);

function briefInput(effect: TurnEffect, combatants: Combatant[]) {
  return {
    actorId: "hero",
    effect,
    combatants,
    statBlocks: new Map<string, CreatureStatBlock>([["hero", HERO], ["goblin-a", GOBLIN]]),
    conditionNamesHebrew: CONDITION_NAMES,
    sceneEnglish: "A dry hillside track.",
    recentNarrations: [],
  };
}

describe("severityFor", () => {
  it("bands by status before it bands by damage", () => {
    expect(severityFor(1, 100, "dead")).toBe("felling");
    expect(severityFor(1, 100, "unconscious")).toBe("felling");
  });

  it("bands a surviving target at the quarter and half thresholds", () => {
    expect(severityFor(1, 8, "alive")).toBe("graze");
    expect(severityFor(2, 8, "alive")).toBe("solid");
    expect(severityFor(4, 8, "alive")).toBe("severe");
  });

  it("bands a hit that dealt zero as a graze, never as a miss", () => {
    expect(severityFor(0, 8, "alive")).toBe("graze");
  });
});

describe("healthBandFor", () => {
  it("calls half bloodied and a quarter critical", () => {
    expect(healthBandFor(28, 28)).toBe("healthy");
    expect(healthBandFor(14, 28)).toBe("bloodied");
    expect(healthBandFor(7, 28)).toBe("critical");
  });
});

describe("buildNarrationBrief", () => {
  it("names the actor in Hebrew with its grammatical gender", () => {
    const brief = buildNarrationBrief(briefInput(EMPTY_EFFECT, [combatant({ combatantId: "hero", faction: "party", maxHp: 28, currentHp: 28 })]));
    expect(brief.actor).toEqual({ nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] });
    expect(brief.actorSide).toBe("party");
  });

  it("emits a hold beat for a turn that did nothing", () => {
    const brief = buildNarrationBrief(briefInput(EMPTY_EFFECT, [combatant({ combatantId: "hero", faction: "party" })]));
    expect(brief.beats).toEqual([{ kind: "hold" }]);
  });

  it("puts movement before the swings", () => {
    const effect: TurnEffect = {
      ...EMPTY_EFFECT,
      movedFeet: 10,
      attacks: [{
        attackerId: "hero", targetId: "goblin-a", actionId: "scimitar", outcome: "hit",
        damage: 4, targetStatusAfter: "alive",
        attackRoll: { naturalRoll: 15, rolls: [15], modifier: 5, total: 20, targetArmorClass: 13 },
        damageRolls: [],
      }],
    };
    const brief = buildNarrationBrief(briefInput(effect, [
      combatant({ combatantId: "hero", faction: "party" }),
      combatant({ combatantId: "goblin-a" }),
    ]));
    expect(brief.beats[0]).toEqual({ kind: "move", feet: 10 });
    expect(brief.beats[1]).toMatchObject({ kind: "attack", actionNameHebrew: "חרב מעוקלת", severity: "severe" });
  });

  it("omits severity on a miss", () => {
    const effect: TurnEffect = {
      ...EMPTY_EFFECT,
      attacks: [{
        attackerId: "hero", targetId: "goblin-a", actionId: "scimitar", outcome: "miss",
        damage: 0, targetStatusAfter: "alive",
        attackRoll: { naturalRoll: 3, rolls: [3], modifier: 5, total: 8, targetArmorClass: 13 },
        damageRolls: [],
      }],
    };
    const [beat] = buildNarrationBrief(briefInput(effect, [
      combatant({ combatantId: "hero", faction: "party" }),
      combatant({ combatantId: "goblin-a" }),
    ])).beats;
    expect(beat).not.toHaveProperty("severity");
  });

  it("labels a target's conditions in Hebrew from the supplied map", () => {
    const effect: TurnEffect = {
      ...EMPTY_EFFECT,
      attacks: [{
        attackerId: "hero", targetId: "goblin-a", actionId: "scimitar", outcome: "hit",
        damage: 1, targetStatusAfter: "alive",
        attackRoll: { naturalRoll: 15, rolls: [15], modifier: 5, total: 20, targetArmorClass: 13 },
        damageRolls: [],
      }],
    };
    const [beat] = buildNarrationBrief(briefInput(effect, [
      combatant({ combatantId: "hero", faction: "party" }),
      combatant({ combatantId: "goblin-a", conditions: [{ condition: "prone", durationRounds: null }] }),
    ])).beats;
    expect(beat).toMatchObject({ kind: "attack", target: { conditionsHebrew: ["שרוע"] } });
  });

  it("counts only living hostiles in the pulse and bands the party member", () => {
    const brief = buildNarrationBrief(briefInput(EMPTY_EFFECT, [
      combatant({ combatantId: "hero", faction: "party", maxHp: 28, currentHp: 10 }),
      combatant({ combatantId: "goblin-a" }),
      combatant({ combatantId: "goblin-b", status: "dead", currentHp: 0 }),
    ]));
    expect(brief.pulse).toEqual({ hostilesStanding: 1, heroBand: "bloodied" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/agents test brief
```

Expected: FAIL — `./brief.js` does not exist.

- [ ] **Step 3: Replace `port.ts`**

```ts
// The narrative contract, and the material both narrators read.
//
// `NarrationInput` is a BRIEF, not a rule outcome: severity is already
// banded, names are already Hebrew, gender is already resolved. That is
// deliberate — the alternative is each narrator deriving all three from a
// `TurnEffect`, which means the same 5e-adjacent reasoning written twice and
// tested twice.
import type { AttackOutcome, GrammaticalGender } from "@ai-dm/schemas";

export interface NarratedCreature {
  nameHebrew: string;
  /** Hebrew verbs agree with their subject; there is no neutral form. */
  gender: GrammaticalGender;
  /** Board truth, Hebrew-labelled from `conditions.json`. Never invented. */
  conditionsHebrew: readonly string[];
}

/**
 * How hard a landed blow was, as a band rather than a number. `felling` is
 * driven by the engine's own status verdict, never by the damage, so the
 * band cannot disagree with who actually went down.
 */
export type Severity = "graze" | "solid" | "severe" | "felling";

/** "Bloodied at half" follows 5e's own usage. */
export type HealthBand = "healthy" | "bloodied" | "critical";

export type NarrationBeat =
  | { kind: "move"; feet: number }
  | {
      kind: "attack";
      target: NarratedCreature;
      actionNameHebrew: string;
      outcome: AttackOutcome;
      /** Absent on a miss. */
      severity?: Severity;
      /**
       * Narrower than `EntityStatus`, which also has `"fled"`. `applyDamage`
       * only ever derives alive/unconscious/dead from a resolved attack, so
       * `"fled"` is unreachable here — the same reasoning the deterministic
       * renderer already records for refusing a clause it could not test.
       */
      statusAfter: "alive" | "unconscious" | "dead";
    }
  | { kind: "other-action" }
  | { kind: "unresolved" }
  | { kind: "hold" };

export interface FightPulse {
  hostilesStanding: number;
  heroBand: HealthBand;
}

export interface NarrationInput {
  actor: NarratedCreature;
  actorSide: "party" | "hostile";
  beats: readonly NarrationBeat[];
  pulse: FightPulse;
  /** The encounter's scene card. English — see invariant 2. */
  sceneEnglish: string;
  /** The previous two narrations, Hebrew, oldest first. May be empty. */
  recentNarrations: readonly string[];
}

export interface NarrativePort {
  /**
   * Token stream. Language-neutral by contract, unchanged by step 9: the
   * pipeline cannot tell the Hebrew agent from the template renderer.
   */
  stream(input: NarrationInput): AsyncIterable<string>;
}
```

- [ ] **Step 4: Write `brief.ts`**

```ts
// Turns one resolved turn into narratable material. Pure: no I/O, no
// provider, no clock. Everything a narrator needs to write a sentence is
// computed here exactly once.
import type { AttackRecord, TurnEffect } from "@ai-dm/rules-engine";
import type { Combatant, Condition, CreatureStatBlock } from "@ai-dm/schemas";
import type {
  FightPulse,
  HealthBand,
  NarratedCreature,
  NarrationBeat,
  NarrationInput,
  Severity,
} from "./port.js";

export interface NarrationBriefInput {
  actorId: string;
  effect: TurnEffect;
  combatants: readonly Combatant[];
  statBlocks: ReadonlyMap<string, CreatureStatBlock>;
  /** Hebrew condition labels by id, from the server's `loadConditions()`. */
  conditionNamesHebrew: ReadonlyMap<Condition, string>;
  sceneEnglish: string;
  recentNarrations: readonly string[];
}

const SEVERE_FRACTION = 0.5;
const SOLID_FRACTION = 0.25;
const BLOODIED_FRACTION = 0.5;
const CRITICAL_FRACTION = 0.25;

/**
 * Status first, damage second. A creature the engine put down is `felling`
 * however little damage did it, and a creature still standing is never
 * `felling` however much did — which is what makes this band incapable of
 * contradicting the engine.
 */
export function severityFor(
  damage: number,
  targetMaxHp: number,
  statusAfter: AttackRecord["targetStatusAfter"],
): Severity {
  if (statusAfter !== "alive") return "felling";
  if (damage >= targetMaxHp * SEVERE_FRACTION) return "severe";
  if (damage >= targetMaxHp * SOLID_FRACTION) return "solid";
  return "graze";
}

export function healthBandFor(currentHp: number, maxHp: number): HealthBand {
  if (currentHp <= maxHp * CRITICAL_FRACTION) return "critical";
  if (currentHp <= maxHp * BLOODIED_FRACTION) return "bloodied";
  return "healthy";
}

/**
 * `"fled"` cannot reach an attack beat — `applyDamage` never derives it — but
 * the type must still be total. Mapping it to `"alive"` is the least-wrong
 * choice of the three: a creature that fled is emphatically not down, and
 * narrating it as down would be the one actively false reading.
 */
function narrowStatus(status: AttackRecord["targetStatusAfter"]): "alive" | "unconscious" | "dead" {
  if (status === "dead") return "dead";
  if (status === "unconscious") return "unconscious";
  return "alive";
}

function creatureFor(input: NarrationBriefInput, combatantId: string): NarratedCreature {
  const statBlock = input.statBlocks.get(combatantId);
  const combatant = input.combatants.find((each) => each.combatantId === combatantId);
  const conditions = combatant?.conditions ?? [];

  return {
    // Falling back to the id mirrors what the English renderer did with a
    // missing name: an id on screen beats a blank.
    nameHebrew: statBlock?.nameHebrew ?? combatantId,
    // Masculine is Hebrew's unmarked form, so it is the least-wrong default
    // for a creature with no stat block — which only a malformed world has.
    gender: statBlock?.grammaticalGender ?? "masculine",
    conditionsHebrew: conditions.map(
      (active) => input.conditionNamesHebrew.get(active.condition) ?? active.condition,
    ),
  };
}

function maxHpOf(input: NarrationBriefInput, combatantId: string): number {
  // 1 rather than 0: this is a divisor for the severity band, and a stray 0
  // would band every graze as `severe`.
  return input.combatants.find((each) => each.combatantId === combatantId)?.maxHp ?? 1;
}

function actionNameHebrewFor(input: NarrationBriefInput, attack: AttackRecord): string {
  const actions = input.statBlocks.get(attack.attackerId)?.actions ?? [];
  return actions.find((each) => each.actionId === attack.actionId)?.nameHebrew ?? attack.actionId;
}

function attackBeat(input: NarrationBriefInput, attack: AttackRecord): NarrationBeat {
  const landed = attack.outcome === "hit" || attack.outcome === "critical_hit";
  return {
    kind: "attack",
    target: creatureFor(input, attack.targetId),
    actionNameHebrew: actionNameHebrewFor(input, attack),
    outcome: attack.outcome,
    ...(landed
      ? { severity: severityFor(attack.damage, maxHpOf(input, attack.targetId), attack.targetStatusAfter) }
      : {}),
    statusAfter: narrowStatus(attack.targetStatusAfter),
  };
}

function pulseFor(input: NarrationBriefInput): FightPulse {
  const hostilesStanding = input.combatants.filter(
    (each) => each.faction === "hostile" && each.status === "alive",
  ).length;

  // ADR-0002 makes this a solo game, so there is one party member. If a
  // future party has several, the grimmest band is the honest summary.
  const party = input.combatants.filter((each) => each.faction === "party");
  const bands = party.map((each) => healthBandFor(each.currentHp, each.maxHp));
  const heroBand: HealthBand = bands.includes("critical")
    ? "critical"
    : bands.includes("bloodied")
      ? "bloodied"
      : "healthy";

  return { hostilesStanding, heroBand };
}

export function buildNarrationBrief(input: NarrationBriefInput): NarrationInput {
  const beats: NarrationBeat[] = [];

  if (input.effect.movedFeet > 0) beats.push({ kind: "move", feet: input.effect.movedFeet });
  for (const attack of input.effect.attacks) beats.push(attackBeat(input, attack));

  // Dodge, Dash, Hide: legal and mechanically inert, but not nothing. The
  // English renderer had no branch for this and narrated a Dodge as "holds
  // position", which was simply wrong.
  if (input.effect.nonAttackAction) beats.push({ kind: "other-action" });

  // Reachable when the engine accepts an actionId the actor's stat block does
  // not own (see `TurnEffect.unresolvedActionIds`).
  if (input.effect.unresolvedActionIds.length > 0) beats.push({ kind: "unresolved" });

  // Never zero beats: a silent turn reads to a player as a dropped connection.
  if (beats.length === 0) beats.push({ kind: "hold" });

  const actor = input.combatants.find((each) => each.combatantId === input.actorId);

  return {
    actor: creatureFor(input, input.actorId),
    actorSide: actor?.faction === "party" ? "party" : "hostile",
    beats,
    pulse: pulseFor(input),
    sceneEnglish: input.sceneEnglish,
    recentNarrations: input.recentNarrations,
  };
}
```

- [ ] **Step 5: Export it**

In `packages/agents/src/narrative/index.ts`, add `export * from "./brief.js";` above the existing exports.

- [ ] **Step 6: Run the brief tests**

```bash
pnpm --filter @ai-dm/agents test brief
```

Expected: PASS. `pnpm typecheck` still fails in `deterministic.ts` and `pipeline.ts` — expected until Tasks 7 and 12.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/narrative/port.ts packages/agents/src/narrative/brief.ts \
        packages/agents/src/narrative/brief.test.ts packages/agents/src/narrative/index.ts
git commit -m "feat(agents): add the narration brief between the engine and the narrators"
```

---

## Task 6: The rules digest

**Files:**
- Create: `packages/agents/src/rules-digest.ts`
- Test: `packages/agents/src/rules-digest.test.ts`
- Modify: `packages/agents/src/index.ts`

**Interfaces:**
- Consumes: nothing at runtime; the drift test reads `data/srd/conditions.json`.
- Produces: `RULES_DIGEST: string`, `RULES_DIGEST_VERSION: string`. Task 9 puts `RULES_DIGEST` in the static tier.

Wired into the **narrative role only**. Adding it to `tactical/prompt.ts` would change the prompt the step 7b benchmark measured, which is the sole justification for `DEFAULT_MODEL_ROUTING.tactical`.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/rules-digest.test.ts`:

```ts
// A drift guard, not a behaviour test. The digest is hand-written English
// summarising data that lives in `data/srd/conditions.json`; the failure
// that actually happens is a condition added to the data and forgotten in
// the prompt, so that is the direction this checks.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULES_DIGEST, RULES_DIGEST_VERSION } from "./rules-digest.js";

function repoFile(relativePath: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${relativePath} above this file`);
    dir = parent;
  }
}

/** Bump `RULES_DIGEST_VERSION` and re-pin this together, never separately. */
const PINNED = { version: "2026-08-21.1", sha256: "REPLACE_WITH_ACTUAL_HASH" };

describe("RULES_DIGEST", () => {
  it("names every condition the SRD data defines", () => {
    const path = repoFile(join("data", "srd", "conditions.json"));
    const rows: { condition: string; nameEnglish: string }[] = JSON.parse(readFileSync(path, "utf8"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(RULES_DIGEST).toContain(row.nameEnglish);
    }
  });

  it("is English only — no Hebrew reaches a cached prompt tier", () => {
    expect(RULES_DIGEST).not.toMatch(/[֐-׿]/);
  });

  it("pins the hash against the version it was taken from", () => {
    expect(RULES_DIGEST_VERSION).toBe(PINNED.version);
    expect(createHash("sha256").update(RULES_DIGEST).digest("hex")).toBe(PINNED.sha256);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/agents test rules-digest
```

Expected: FAIL — `./rules-digest.js` does not exist.

- [ ] **Step 3: Write the digest**

Create `packages/agents/src/rules-digest.ts`. Every line is verified against SRD 5.2.1 — query the notebook (`3a0d4f39-93c2-48ee-b1d1-258c7f7583ab`) for anything `RULES_REFERENCE.md` does not already state, per `PROJECT_PLAN.md` §4.1.

```ts
// A curated English summary of the 5e rules a prompt tier needs, pinned into
// the cache-stable prefix (PROJECT_PLAN.md section 4.1).
//
// Hand-written rather than generated from `data/srd/conditions.json`: a
// runtime file read is I/O in a package that must stay pure and breaks
// bundling, and codegen is machinery bought for one string — the same trade
// `tactical/prompt-text.ts` already settled. A test walks up to that data
// file and fails if a condition it defines is missing here, which catches the
// drift that actually happens.
//
// English only (invariant 2).

/** Bump whenever any string in this file changes. A hash guard enforces it. */
export const RULES_DIGEST_VERSION = "2026-08-21.1";

export const RULES_DIGEST = `RULES REFERENCE (D&D 5th edition, 2024 rules)

Action economy. On its turn a creature may take one action, one bonus action,
and movement up to its Speed, in any order. A reaction is taken outside its
own turn, at most once per round.

Conditions and what they mean:
- Blinded: cannot see; attacks against it have Advantage, its own have Disadvantage.
- Charmed: cannot attack the charmer; the charmer has Advantage on social checks.
- Deafened: cannot hear.
- Frightened: Disadvantage while the source is in sight; cannot willingly move closer.
- Grappled: Speed 0; ends if the grappler is Incapacitated or the two are separated.
- Incapacitated: no action, bonus action or reaction; concentration ends.
- Invisible: cannot be seen unaided; attacks against it have Disadvantage, its own have Advantage.
- Paralyzed: Incapacitated, Speed 0, fails Strength and Dexterity saves; attacks against it have Advantage and any hit from within 5 feet is a critical hit.
- Petrified: turned to solid substance, Incapacitated, resistant to all damage.
- Poisoned: Disadvantage on attack rolls and ability checks.
- Prone: can only crawl; attacks from within 5 feet have Advantage, from further away Disadvantage.
- Restrained: Speed 0; attacks against it have Advantage, its own have Disadvantage.
- Stunned: Incapacitated, fails Strength and Dexterity saves, attacks against it have Advantage.
- Unconscious: Incapacitated, Prone, drops what it holds, unaware of its surroundings; attacks against it have Advantage and any hit from within 5 feet is a critical hit.
- Exhaustion: a level from 1 to 6; each level worsens D20 tests and reduces Speed. Level 6 is death.

Cover. Half Cover gives +2 to Armor Class and Dexterity saves; Three-Quarters
Cover gives +5; Total Cover cannot be targeted directly.

Distance. One tile is 5 feet. Melee reach is 5 feet unless the weapon or the
creature's size says otherwise.
`;
```

- [ ] **Step 4: Pin the real hash**

```bash
pnpm --filter @ai-dm/agents test rules-digest 2>&1 | grep -B2 -A2 "sha256"
```

Take the actual hash from the failure message and replace `REPLACE_WITH_ACTUAL_HASH` in the test. A `REPLACE_WITH_ACTUAL_HASH` left in the file is a task failure.

- [ ] **Step 5: Export it and run the tests**

Add `export * from "./rules-digest.js";` to `packages/agents/src/index.ts`, then:

```bash
pnpm --filter @ai-dm/agents test rules-digest
```

Expected: PASS, all three.

- [ ] **Step 6: Sabotage-check the drift guard**

Delete one condition line from `RULES_DIGEST` (say `Prone`), re-run, confirm the "names every condition" test FAILS, then restore it. A guard that cannot fail is not a guard — `PROJECT_PLAN.md` §4.3 records seven tasks that shipped exactly that.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/rules-digest.ts packages/agents/src/rules-digest.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): add the hash-pinned English rules digest for the static prompt tier"
```

---
## Task 7: The Hebrew deterministic renderer

**Files:**
- Modify: `packages/agents/src/narrative/deterministic.ts` (replaced wholesale)
- Test: `packages/agents/src/narrative/deterministic.test.ts` (replaced wholesale)

**Interfaces:**
- Consumes: `NarrationInput`, `NarrationBeat` (Task 5).
- Produces: `createDeterministicNarrative(): NarrativePort` — signature unchanged, output language changed. Task 12 streams it as the fallback.

The renderer is **numberless**, like the LLM narrator. Two reasons: `CombatLog.tsx` already shows every number, and a "completed" turn concatenates model prose with these sentences, so the two sources have to be stylistically compatible or the seam reads as a bug rather than a fallback.

- [ ] **Step 1: Replace the test file**

Replace `packages/agents/src/narrative/deterministic.test.ts` entirely:

```ts
import { describe, expect, it } from "vitest";
import { createDeterministicNarrative } from "./deterministic.js";
import type { NarrationBeat, NarrationInput } from "./port.js";

const ELDAD = { nameHebrew: "אלדד", gender: "masculine" as const, conditionsHebrew: [] };
const RANGER = { nameHebrew: "רעות", gender: "feminine" as const, conditionsHebrew: [] };
const GOBLIN = { nameHebrew: "גובלין לוחם", gender: "masculine" as const, conditionsHebrew: [] };
const WOLF_F = { nameHebrew: "זאבה", gender: "feminine" as const, conditionsHebrew: [] };

function input(actor: NarrationInput["actor"], beats: NarrationBeat[]): NarrationInput {
  return {
    actor,
    actorSide: "party",
    beats,
    pulse: { hostilesStanding: 1, heroBand: "healthy" },
    sceneEnglish: "A dry hillside track.",
    recentNarrations: [],
  };
}

async function textOf(value: NarrationInput): Promise<string> {
  let text = "";
  for await (const chunk of createDeterministicNarrative().stream(value)) text += chunk;
  return text;
}

async function chunksOf(value: NarrationInput): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of createDeterministicNarrative().stream(value)) chunks.push(chunk);
  return chunks;
}

describe("createDeterministicNarrative", () => {
  it("agrees the actor's verb with a masculine subject", async () => {
    expect(await textOf(input(ELDAD, [{ kind: "hold" }]))).toBe("אלדד עומד במקומו.");
  });

  it("agrees the actor's verb with a feminine subject", async () => {
    expect(await textOf(input(RANGER, [{ kind: "hold" }]))).toBe("רעות עומדת במקומה.");
  });

  it("agrees a falling target's verb with the TARGET's gender, not the actor's", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: WOLF_F, actionNameHebrew: "חרב ארוכה",
      outcome: "hit", severity: "felling", statusAfter: "dead",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד פוגע בזאבה. זאבה נופלת.");
  });

  it("says nothing about a target that is still standing", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה",
      outcome: "hit", severity: "graze", statusAfter: "alive",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד פוגע בגובלין לוחם.");
  });

  it("distinguishes falling unconscious from falling dead", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: RANGER, actionNameHebrew: "חרב מעוקלת",
      outcome: "hit", severity: "felling", statusAfter: "unconscious",
    };
    expect(await textOf(input(GOBLIN, [beat]))).toBe("גובלין לוחם פוגע ברעות. רעות מאבדת את הכרתה.");
  });

  it("narrates a miss without inventing a hit", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה",
      outcome: "miss", statusAfter: "alive",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד מחטיא את גובלין לוחם.");
  });

  it("marks a critical hit as one", async () => {
    const beat: NarrationBeat = {
      kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה",
      outcome: "critical_hit", severity: "severe", statusAfter: "alive",
    };
    expect(await textOf(input(ELDAD, [beat]))).toBe("אלדד פוגע בגובלין לוחם פגיעה אנושה.");
  });

  it("narrates a non-attack action rather than calling it holding position", async () => {
    expect(await textOf(input(ELDAD, [{ kind: "other-action" }]))).toBe("אלדד נוקט פעולה.");
  });

  it("reports an action the engine could not resolve", async () => {
    expect(await textOf(input(ELDAD, [{ kind: "unresolved" }]))).toBe(
      "אלדד מנסה פעולה שהמנוע לא הצליח לפתור.",
    );
  });

  it("never emits a digit", async () => {
    const beats: NarrationBeat[] = [
      { kind: "move", feet: 25 },
      { kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "hit", severity: "solid", statusAfter: "alive" },
    ];
    expect(await textOf(input(ELDAD, beats))).not.toMatch(/[0-9]/);
  });

  it("puts movement before the swing and yields one chunk per sentence", async () => {
    const beats: NarrationBeat[] = [
      { kind: "move", feet: 10 },
      { kind: "attack", target: GOBLIN, actionNameHebrew: "חרב ארוכה", outcome: "miss", statusAfter: "alive" },
    ];
    expect(await chunksOf(input(ELDAD, beats))).toEqual([
      "אלדד מתקדם. ",
      "אלדד מחטיא את גובלין לוחם.",
    ]);
  });

  it("leaves no trailing whitespace on the concatenated text", async () => {
    const text = await textOf(input(ELDAD, [{ kind: "move", feet: 5 }, { kind: "hold" }]));
    expect(text).toBe(text.trimEnd());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/agents test deterministic
```

Expected: FAIL — the renderer still walks `TurnEffect` and emits English.

- [ ] **Step 3: Replace the renderer**

Replace `packages/agents/src/narrative/deterministic.ts` entirely:

```ts
// A Hebrew template renderer over the narration brief. Two jobs, both of
// which outlive step 9: it is the `NarrativePort` any deployment without a
// provider key gets, and it is the terse fallback the pipeline degrades into
// when a provider fails or the turn budget runs out (apps/server/CLAUDE.md).
// Mirrors `deterministicFallback` in `tactical/`: the boring, always-correct
// path the LLM path degrades into.
//
// It states only what the brief carries. No adjectives, no invented nouns,
// and NO NUMBERS — `CombatLog.tsx` already shows every one of them, and a
// truncated model narration is completed by concatenating these sentences
// onto it, so the two sources have to read as the same game.
//
// Hebrew here is output, not internals: invariant 2 permits it in exactly
// this position.
import type { NarratedCreature, NarrationBeat, NarrationInput, NarrativePort } from "./port.js";

type GenderedForms = Readonly<Record<NarratedCreature["gender"], string>>;

/**
 * Every inflected form the renderer can emit, keyed by the gender of the
 * creature the verb belongs to. A table rather than string surgery: Hebrew
 * agreement is not a suffix rule that survives being guessed, and `מנסה`
 * being spelled identically in both genders is a fact about that verb, not a
 * licence to skip the lookup for others.
 */
const FORMS: Readonly<Record<string, GenderedForms>> = {
  advances: { masculine: "מתקדם", feminine: "מתקדמת" },
  misses: { masculine: "מחטיא", feminine: "מחטיאה" },
  hits: { masculine: "פוגע", feminine: "פוגעת" },
  falls: { masculine: "נופל", feminine: "נופלת" },
  actsOtherwise: { masculine: "נוקט פעולה", feminine: "נוקטת פעולה" },
  holds: { masculine: "עומד במקומו", feminine: "עומדת במקומה" },
  attempts: { masculine: "מנסה", feminine: "מנסה" },
  losesConsciousness: { masculine: "מאבד את הכרתו", feminine: "מאבדת את הכרתה" },
};

function form(key: string, creature: NarratedCreature): string {
  const forms: GenderedForms | undefined = FORMS[key];
  if (forms === undefined) throw new Error(`No inflected forms for ${key}`);
  return forms[creature.gender];
}

/**
 * The target's status after this swing, as its own sentence — never folded
 * into the hit sentence. ADR 0002 makes this a solo game, so a player
 * character going down is not an edge case, it is the losing beat of the
 * fight, and "dead" and "unconscious" have to read as distinctly different
 * news. The verb agrees with the TARGET, not the attacker.
 *
 * `"alive"` needs nothing said about it. The brief's `statusAfter` cannot be
 * `"fled"` — see `port.ts`.
 */
function statusSentence(beat: Extract<NarrationBeat, { kind: "attack" }>): string | undefined {
  if (beat.statusAfter === "dead") return `${beat.target.nameHebrew} ${form("falls", beat.target)}.`;
  if (beat.statusAfter === "unconscious") {
    return `${beat.target.nameHebrew} ${form("losesConsciousness", beat.target)}.`;
  }
  return undefined;
}

/**
 * The sentence(s) for one swing. A hit and the fall it caused are returned as
 * separate entries — not concatenated — so each becomes its own stream chunk.
 *
 * The verdict narrated is `outcome`, not a derived number: a
 * `{ outcome: "hit", severity: "graze" }` swing that dealt 0 is
 * constructible, and narrating it as a miss would second-guess the engine.
 */
function sentencesForAttack(actor: NarratedCreature, beat: Extract<NarrationBeat, { kind: "attack" }>): string[] {
  if (beat.outcome === "miss" || beat.outcome === "critical_miss") {
    return [`${actor.nameHebrew} ${form("misses", actor)} את ${beat.target.nameHebrew}.`];
  }

  const critical = beat.outcome === "critical_hit" ? " פגיעה אנושה" : "";
  const hit = `${actor.nameHebrew} ${form("hits", actor)} ב${beat.target.nameHebrew}${critical}.`;
  const status = statusSentence(beat);
  return status === undefined ? [hit] : [hit, status];
}

function sentencesForBeat(actor: NarratedCreature, beat: NarrationBeat): string[] {
  switch (beat.kind) {
    // `feet` is deliberately unread: the brief carries the true distance, and
    // this renderer states no numbers.
    case "move":
      return [`${actor.nameHebrew} ${form("advances", actor)}.`];
    case "attack":
      return sentencesForAttack(actor, beat);
    case "other-action":
      return [`${actor.nameHebrew} ${form("actsOtherwise", actor)}.`];
    case "unresolved":
      return [`${actor.nameHebrew} ${form("attempts", actor)} פעולה שהמנוע לא הצליח לפתור.`];
    case "hold":
      return [`${actor.nameHebrew} ${form("holds", actor)}.`];
  }
}

/**
 * Sentences joined with a single space between them and no trailing space on
 * the last one. The concatenation of every yielded chunk is exactly what
 * `narrative_emitted` stores, and trailing whitespace has no business going
 * into that permanent log.
 */
function chunksFor(sentences: readonly string[]): string[] {
  return sentences.map((sentence, index) =>
    index === sentences.length - 1 ? sentence : `${sentence} `,
  );
}

/**
 * Wraps a precomputed chunk list as an `AsyncIterable`. Written as a plain
 * (non-`async`) function delegating to the array's own synchronous iterator,
 * rather than an `async function*`, because this renderer never actually
 * awaits anything — see `@typescript-eslint/require-await`.
 */
function toAsyncIterable(chunks: readonly string[]): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const iterator = chunks[Symbol.iterator]();
      return {
        next(): Promise<IteratorResult<string>> {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}

export function createDeterministicNarrative(): NarrativePort {
  return {
    // Chunked per sentence rather than emitted whole: the client's streaming
    // path is then exercised by the default port, not only by the LLM one.
    stream(input: NarrationInput): AsyncIterable<string> {
      const sentences = input.beats.flatMap((beat) => sentencesForBeat(input.actor, beat));
      return toAsyncIterable(chunksFor(sentences));
    },
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @ai-dm/agents test deterministic
```

Expected: PASS, all 12.

- [ ] **Step 5: Sabotage-check gender agreement**

Change `form("holds", actor)` to the hard-coded string `"עומד במקומו"`. Re-run. The feminine test MUST fail. Restore it. Masculine is Hebrew's unmarked form and every current data name is masculine, so without this check a renderer that ignored `gender` entirely would ship green.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/narrative/deterministic.ts packages/agents/src/narrative/deterministic.test.ts
git commit -m "feat(agents): render the deterministic fallback in Hebrew, inflected by gender"
```

---

## Task 8: Narrative prompt text, glossary and hash guard

**Files:**
- Create: `packages/agents/src/narrative/prompt-text.ts`
- Test: `packages/agents/src/narrative/prompt-text.test.ts`
- Modify: `docs/prompts/hebrew-glossary.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `NARRATIVE_PROMPT_VERSION: string`, `NARRATIVE_SYSTEM_PROMPT: string`, `GLOSSARY_TERMS: readonly GlossaryTerm[]`, `HEBREW_GLOSSARY: string`. Task 9 assembles them; Task 12 stamps the version onto `narrative_emitted`.

The markdown stays the editable source of record and the module holds the runtime copy — see the spec's *Versioning and hash pinning*. A parity test keeps them honest.

- [ ] **Step 1: Extend the glossary markdown**

`docs/prompts/hebrew-glossary.md` currently has 8 terms, none of them combat vocabulary. Replace its table with these 24 rows, keeping the existing 8 and their spellings:

| English | Hebrew |
|---|---|
| saving throw | גלגול הצלה |
| hit points | נקודות פגיעה |
| armor class | דרגת שריון (דרג"ש) |
| ability check | בדיקת תכונה |
| skill check | בדיקת מיומנות |
| advantage / disadvantage | יתרון / חיסרון |
| initiative | יוזמה |
| spell slot | חריץ לחשים |
| attack roll | גלגול תקיפה |
| hit | פגיעה |
| miss | החטאה |
| critical hit | פגיעה קריטית |
| damage | נזק |
| round | סבב |
| turn | תור |
| action | פעולה |
| bonus action | פעולת בונוס |
| reaction | תגובה |
| movement | תנועה |
| reach | טווח הושטה |
| range | טווח |
| cover | מחסה |
| condition | מצב |
| death saving throw | גלגול הצלה ממוות |

Keep the existing note about `grammaticalGender`, and add: "Condition names are **not** listed here — they live as `nameHebrew` on `data/srd/conditions.json`, so a condition has exactly one Hebrew name in the repo. This table is rules vocabulary only. `packages/agents/src/narrative/prompt-text.ts` holds the runtime copy of this table; a parity test fails if the two disagree."

- [ ] **Step 2: Write the failing test**

Create `packages/agents/src/narrative/prompt-text.test.ts`:

```ts
// Two guards, no behaviour. The hash pin does for the narrative prompt what
// `tactical/prompt-text.test.ts` does for the tactical one. The parity check
// is the price of keeping `hebrew-glossary.md` editable by a non-programmer
// while the package stays free of runtime file I/O.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GLOSSARY_TERMS,
  HEBREW_GLOSSARY,
  NARRATIVE_PROMPT_VERSION,
  NARRATIVE_SYSTEM_PROMPT,
} from "./prompt-text.js";

function repoFile(relativePath: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${relativePath} above this file`);
    dir = parent;
  }
}

/** Bump `NARRATIVE_PROMPT_VERSION` and re-pin this together, never separately. */
const PINNED = { version: "2026-08-21.1", sha256: "REPLACE_WITH_ACTUAL_HASH" };

describe("narrative prompt text", () => {
  it("pins the hash against the version it was taken from", () => {
    expect(NARRATIVE_PROMPT_VERSION).toBe(PINNED.version);
    const combined = `${NARRATIVE_SYSTEM_PROMPT}\n${HEBREW_GLOSSARY}`;
    expect(createHash("sha256").update(combined).digest("hex")).toBe(PINNED.sha256);
  });

  it("keeps the system prompt English — Hebrew in a cached tier is invariant 2's line", () => {
    expect(NARRATIVE_SYSTEM_PROMPT).not.toMatch(/[֐-׿]/);
  });

  it("tells the model to end on a full stop, which truncation detection depends on", () => {
    expect(NARRATIVE_SYSTEM_PROMPT).toContain("full stop");
  });

  it("matches docs/prompts/hebrew-glossary.md row for row", () => {
    const markdown = readFileSync(repoFile(join("docs", "prompts", "hebrew-glossary.md")), "utf8");
    const rows = markdown
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.includes("---") && !line.includes("English"))
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        return { english: cells[1] ?? "", hebrew: cells[2] ?? "" };
      });

    expect(rows.length).toBeGreaterThan(0);
    expect(GLOSSARY_TERMS).toEqual(rows);
    for (const term of rows) expect(HEBREW_GLOSSARY).toContain(term.hebrew);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/agents test prompt-text
```

Expected: FAIL — `./prompt-text.js` does not exist. Two prompt-text test files now exist (tactical's and this one); run with the path if the name filter is ambiguous.

- [ ] **Step 4: Write the module**

Create `packages/agents/src/narrative/prompt-text.ts`:

```ts
// The versioned source of record for the narrative agent's prompt.
//
// Same trade `tactical/prompt-text.ts` settled: a runtime markdown read is
// I/O in a package that must stay pure and breaks bundling, so this module IS
// the versioned copy. The glossary is the one exception to
// `docs/prompts/README.md`'s "prompt text lives in TypeScript" rule — that
// README deliberately keeps `hebrew-glossary.md` editable by a
// non-programmer, so the markdown stays the source of record and a parity
// test fails when this copy disagrees with it.
//
// English only (invariant 2), except `GLOSSARY_TERMS`' Hebrew column, which
// is a VALUE the model reproduces rather than an instruction it reads.

/**
 * Identifies which prompt produced a given narration, so a benchmark run can
 * be attributed rather than pooled across a prompt edit — the same job
 * `TACTICAL_PROMPT_VERSION` does for rejections.
 *
 * **Bump this whenever you change any prompt string in this file.** A guard
 * test pins the content hash and fails if you forget.
 */
export const NARRATIVE_PROMPT_VERSION = "2026-08-21.1";

export interface GlossaryTerm {
  english: string;
  hebrew: string;
}

/** Mirrors `docs/prompts/hebrew-glossary.md`, row for row. A test proves it. */
export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  { english: "saving throw", hebrew: "גלגול הצלה" },
  { english: "hit points", hebrew: "נקודות פגיעה" },
  { english: "armor class", hebrew: 'דרגת שריון (דרג"ש)' },
  { english: "ability check", hebrew: "בדיקת תכונה" },
  { english: "skill check", hebrew: "בדיקת מיומנות" },
  { english: "advantage / disadvantage", hebrew: "יתרון / חיסרון" },
  { english: "initiative", hebrew: "יוזמה" },
  { english: "spell slot", hebrew: "חריץ לחשים" },
  { english: "attack roll", hebrew: "גלגול תקיפה" },
  { english: "hit", hebrew: "פגיעה" },
  { english: "miss", hebrew: "החטאה" },
  { english: "critical hit", hebrew: "פגיעה קריטית" },
  { english: "damage", hebrew: "נזק" },
  { english: "round", hebrew: "סבב" },
  { english: "turn", hebrew: "תור" },
  { english: "action", hebrew: "פעולה" },
  { english: "bonus action", hebrew: "פעולת בונוס" },
  { english: "reaction", hebrew: "תגובה" },
  { english: "movement", hebrew: "תנועה" },
  { english: "reach", hebrew: "טווח הושטה" },
  { english: "range", hebrew: "טווח" },
  { english: "cover", hebrew: "מחסה" },
  { english: "condition", hebrew: "מצב" },
  { english: "death saving throw", hebrew: "גלגול הצלה ממוות" },
];

export const HEBREW_GLOSSARY = `HEBREW RULES VOCABULARY
Use these renderings when a rules term has to appear at all. Prefer plain
narration over terminology.

${GLOSSARY_TERMS.map((term) => `${term.english} = ${term.hebrew}`).join("\n")}`;

export const NARRATIVE_SYSTEM_PROMPT = `You are the narrator of a Dungeons & Dragons 5th edition (2024 rules) combat encounter, writing for one player, in Hebrew.

A deterministic rules engine has ALREADY resolved the turn described below. Your job is to describe what it produced. You never decide an outcome, never change one, and never contradict one.

Form:
- Write 2 to 3 sentences. Never more.
- Write modern literary Hebrew. Not spoken slang, not archaic or biblical register.
- Output Hebrew prose only: no English, no headings, no bullet points, no stage directions, no quotation marks wrapping the whole answer.
- End your last sentence with a full stop.

Numbers — the hard rule:
- Never state a number, as digits or as words. No damage, no hit points, no distances, no dice, no counts.
- The player has a separate panel showing every number already. Repeating one here is at best redundant and at worst wrong.
- Each landed blow carries a severity instead. Render it as language: graze is a shallow, glancing blow; solid is a real wound that tells; severe is a heavy, near-crippling blow; felling is the blow that put the target down.

Nouns — the other hard rule. You may name:
- The creatures listed this turn, using their Hebrew names EXACTLY as written.
- The actions listed this turn, using their Hebrew names EXACTLY as written.
- The conditions listed on a creature, using the Hebrew labels given.
- Anything the SCENE section describes.
Name nothing else concrete. No wounds you were not told about, no blood, no weather, no bystanders, no torches, no dialogue, no thoughts. Verbs, adverbs, rhythm and framing are yours; nouns are not.

Grammatical gender:
- Every creature carries a gender, masculine or feminine. Hebrew verbs and adjectives must agree with it.
- A verb about the actor agrees with the actor. A verb about a target agrees with that target.

What to describe:
- Describe only the beats listed. Do not narrate a creature that has no beat this turn — it did not act, and saying it flinched or stepped back is inventing board state.
- The fight pulse tells you how the fight stands. Let it set intensity, never facts.

Repetition:
- The RECENT NARRATION section holds what you wrote on the previous turns. Do not reuse its verbs, its imagery, or its sentence shapes.`;
```

- [ ] **Step 5: Pin the real hash**

```bash
pnpm --filter @ai-dm/agents test prompt-text 2>&1 | grep -B2 -A2 "sha256"
```

Replace `REPLACE_WITH_ACTUAL_HASH` with the actual value from the failure. Leaving the placeholder is a task failure.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @ai-dm/agents test prompt-text
```

Expected: PASS, all four.

- [ ] **Step 7: Sabotage-check the parity guard**

Change one Hebrew value in `GLOSSARY_TERMS` (not in the markdown). Re-run. The parity test MUST fail. Restore it.

- [ ] **Step 8: Commit**

```bash
git add packages/agents/src/narrative/prompt-text.ts packages/agents/src/narrative/prompt-text.test.ts \
        docs/prompts/hebrew-glossary.md
git commit -m "feat(agents): add the narrative system prompt, glossary copy and hash guard"
```

---
## Task 9: `buildNarrativePrompt`

**Files:**
- Create: `packages/agents/src/narrative/prompt.ts`
- Test: `packages/agents/src/narrative/prompt.test.ts`

**Interfaces:**
- Consumes: `NarrationInput` (Task 5), `RULES_DIGEST` (Task 6), `NARRATIVE_SYSTEM_PROMPT` / `HEBREW_GLOSSARY` (Task 8), `LayeredPrompt` from `../providers/prompt.js`.
- Produces: `buildNarrativePrompt(input: NarrationInput): LayeredPrompt`. Task 10 calls it.

The load-bearing property: **the assembled prompt contains no digits**. The engine's numbers are already banded, and a model that never sees a digit cannot echo one into prose the spec forbids digits in.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/narrative/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RULES_DIGEST } from "../rules-digest.js";
import { buildNarrativePrompt } from "./prompt.js";
import { HEBREW_GLOSSARY, NARRATIVE_SYSTEM_PROMPT } from "./prompt-text.js";
import type { NarrationInput } from "./port.js";

const INPUT: NarrationInput = {
  actor: { nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] },
  actorSide: "party",
  beats: [
    { kind: "move", feet: 25 },
    {
      kind: "attack",
      target: { nameHebrew: "גובלין לוחם", gender: "masculine", conditionsHebrew: ["שרוע"] },
      actionNameHebrew: "חרב ארוכה",
      outcome: "critical_hit",
      severity: "felling",
      statusAfter: "dead",
    },
  ],
  pulse: { hostilesStanding: 2, heroBand: "bloodied" },
  sceneEnglish: "A dry hillside track of broken stone.",
  recentNarrations: ["אלדד מתקדם.", "גובלין לוחם מחטיא את אלדד."],
};

function joined(segments: readonly string[] | undefined): string {
  return (segments ?? []).join("\n");
}

describe("buildNarrativePrompt", () => {
  it("puts the system prompt, glossary and rules digest in the cached static tier", () => {
    const prompt = buildNarrativePrompt(INPUT);
    expect(prompt.static).toEqual([NARRATIVE_SYSTEM_PROMPT, HEBREW_GLOSSARY, RULES_DIGEST]);
  });

  it("puts the scene card in the semi-static tier, where it is cached per encounter", () => {
    expect(joined(buildNarrativePrompt(INPUT).semiStatic)).toContain(
      "A dry hillside track of broken stone.",
    );
  });

  it("keeps turn state out of every cached tier", () => {
    const prompt = buildNarrativePrompt(INPUT);
    const cached = `${joined(prompt.static)}\n${joined(prompt.semiStatic)}`;
    expect(cached).not.toContain("אלדד");
    expect(cached).not.toContain("גובלין לוחם");
  });

  it("emits no digit anywhere in the assembled prompt", () => {
    const prompt = buildNarrativePrompt(INPUT);
    const all = `${joined(prompt.static)}\n${joined(prompt.semiStatic)}\n${joined(prompt.dynamic)}`;
    expect(all).not.toMatch(/[0-9]/);
  });

  it("names the actor, its gender, the action and the severity in the dynamic tier", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    expect(dynamic).toContain("אלדד");
    expect(dynamic).toContain("masculine");
    expect(dynamic).toContain("חרב ארוכה");
    expect(dynamic).toContain("felling");
    expect(dynamic).toContain("critical_hit");
  });

  it("carries a target's conditions and the fight pulse as words", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    expect(dynamic).toContain("שרוע");
    expect(dynamic).toContain("two");
    expect(dynamic).toContain("bloodied");
  });

  it("includes recent narration so the model can avoid repeating itself", () => {
    const dynamic = joined(buildNarrativePrompt(INPUT).dynamic);
    expect(dynamic).toContain("גובלין לוחם מחטיא את אלדד.");
  });

  it("omits the recent-narration section entirely on the first turn", () => {
    const dynamic = joined(buildNarrativePrompt({ ...INPUT, recentNarrations: [] }));
    expect(dynamic).not.toContain("RECENT NARRATION");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/agents test narrative/prompt.test
```

Expected: FAIL — `./prompt.js` does not exist.

- [ ] **Step 3: Write the builder**

Create `packages/agents/src/narrative/prompt.ts`:

```ts
// Assembles the narrative prompt into the three cache tiers.
//
// The rule this file exists to enforce: NO DIGIT reaches the model. The
// engine's numbers are already banded into severities and health bands, and
// a model that never sees a digit cannot echo one into prose that forbids
// them. Distances and counts are therefore rendered as words here, not
// interpolated.
import { RULES_DIGEST } from "../rules-digest.js";
import type { LayeredPrompt } from "../providers/prompt.js";
import type { NarrationBeat, NarrationInput } from "./port.js";
import { HEBREW_GLOSSARY, NARRATIVE_SYSTEM_PROMPT } from "./prompt-text.js";

const COUNT_WORDS = [
  "none", "one", "two", "three", "four", "five",
  "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
];

function countWord(count: number): string {
  return COUNT_WORDS[count] ?? "many";
}

/**
 * Movement as a phrase, never as feet. The brief carries the true distance
 * because it is true; this is the only place that decides how much of it the
 * model is allowed to know, and the answer is "the shape, not the number".
 */
function moveWord(feet: number): string {
  if (feet <= 5) return "a single step";
  if (feet <= 15) return "a short move";
  return "a long move across open ground";
}

function renderBeat(beat: NarrationBeat): string {
  switch (beat.kind) {
    case "move":
      return `- moves: ${moveWord(beat.feet)}`;
    case "attack": {
      const conditions =
        beat.target.conditionsHebrew.length > 0
          ? `, target conditions: ${beat.target.conditionsHebrew.join(", ")}`
          : "";
      const severity = beat.severity === undefined ? "" : `, severity: ${beat.severity}`;
      return (
        `- attacks ${beat.target.nameHebrew} (${beat.target.gender}) ` +
        `with ${beat.actionNameHebrew}: ${beat.outcome}${severity}` +
        `, target after: ${beat.statusAfter}${conditions}`
      );
    }
    case "other-action":
      return "- takes a non-attack action (Dodge, Dash, Hide or similar): legal, mechanically inert";
    case "unresolved":
      return "- attempted an action the engine could not resolve";
    case "hold":
      return "- did nothing this turn";
  }
}

function renderTurn(input: NarrationInput): string {
  const actorConditions =
    input.actor.conditionsHebrew.length > 0
      ? `\nActor conditions: ${input.actor.conditionsHebrew.join(", ")}`
      : "";

  return [
    "THIS TURN",
    `Actor: ${input.actor.nameHebrew} (${input.actor.gender})`,
    `Side: ${input.actorSide === "party" ? "the player's side" : "hostile"}${actorConditions}`,
    ...input.beats.map(renderBeat),
  ].join("\n");
}

function renderPulse(input: NarrationInput): string {
  return [
    "FIGHT PULSE",
    `Enemies still standing: ${countWord(input.pulse.hostilesStanding)}`,
    `The player's condition: ${input.pulse.heroBand}`,
  ].join("\n");
}

export function buildNarrativePrompt(input: NarrationInput): LayeredPrompt {
  const dynamic = [renderTurn(input), renderPulse(input)];

  // Omitted rather than sent empty on turn one: an empty section is a line of
  // uncached tokens that says nothing, and "do not repeat this" pointing at
  // nothing is a confusing instruction.
  if (input.recentNarrations.length > 0) {
    dynamic.push(
      ["RECENT NARRATION (do not reuse its verbs, imagery or sentence shapes)"]
        .concat(input.recentNarrations.map((each) => `- ${each}`))
        .join("\n"),
    );
  }

  return {
    static: [NARRATIVE_SYSTEM_PROMPT, HEBREW_GLOSSARY, RULES_DIGEST],
    semiStatic: [`SCENE\n${input.sceneEnglish}`],
    dynamic,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @ai-dm/agents test narrative/prompt.test
```

Expected: PASS, all eight. If the no-digit test fails, the culprit is a digit in `sceneEnglish` or in the scene card written in Task 3 — fix the card, not the test.

- [ ] **Step 5: Sabotage-check the no-digit guard**

Change `moveWord(beat.feet)` to `String(beat.feet)`. Re-run. The no-digit test MUST fail. Restore it.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/narrative/prompt.ts packages/agents/src/narrative/prompt.test.ts
git commit -m "feat(agents): assemble the narrative prompt with no digit reaching the model"
```

---

## Task 10: `createHebrewNarrative`

**Files:**
- Create: `packages/agents/src/narrative/hebrew.ts`
- Test: `packages/agents/src/narrative/hebrew.test.ts`
- Modify: `packages/agents/src/narrative/index.ts`

**Interfaces:**
- Consumes: `AgentRuntime` (`../providers/runtime.js`), `StreamChunk` / `TokenUsage` (`../providers/port.js`), `AdapterError` (`../providers/errors.js`), `buildNarrativePrompt` (Task 9).
- Produces: `createHebrewNarrative(options: HebrewNarrativeOptions): NarrativePort`, `NarrativeFinish`, `HebrewNarrativeOptions`. Task 13 wires it.

- [ ] **Step 1: Write the failing test**

Create `packages/agents/src/narrative/hebrew.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../providers/runtime.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import type { StreamChunk } from "../providers/port.js";
import { createHebrewNarrative } from "./hebrew.js";
import type { NarrativeFinish } from "./hebrew.js";
import { NARRATIVE_PROMPT_VERSION } from "./prompt-text.js";
import type { NarrationInput } from "./port.js";

const INPUT: NarrationInput = {
  actor: { nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] },
  actorSide: "party",
  beats: [{ kind: "hold" }],
  pulse: { hostilesStanding: 1, heroBand: "healthy" },
  sceneEnglish: "A dry hillside track.",
  recentNarrations: [],
};

const USAGE = { inputTokens: 900, outputTokens: 40, cachedInputTokens: 850 };

function narrativeFor(chunks: StreamChunk[]) {
  const port = createFakePort({ stream: [chunks] });
  const finishes: NarrativeFinish[] = [];
  const narrative = createHebrewNarrative({
    runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port }),
    onFinish: (finish) => finishes.push(finish),
    now: () => 0,
  });
  return { port, narrative, finishes };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("createHebrewNarrative", () => {
  it("yields the provider's text deltas verbatim", async () => {
    const { narrative } = narrativeFor([
      { type: "text-delta", text: "אלדד " },
      { type: "text-delta", text: "עומד במקומו." },
      { type: "finish", text: "אלדד עומד במקומו.", usage: USAGE },
    ]);
    expect(await collect(narrative.stream(INPUT))).toEqual(["אלדד ", "עומד במקומו."]);
  });

  it("calls the narrative role, not another one", async () => {
    const { port, narrative } = narrativeFor([{ type: "finish", text: "", usage: USAGE }]);
    await collect(narrative.stream(INPUT));
    expect(port.calls[0]?.kind).toBe("stream");
    expect(port.calls[0]?.spec.modelId).toBe(DEFAULT_MODEL_ROUTING.narrative.modelId);
  });

  it("reports usage and the prompt version on a clean finish", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד עומד במקומו." },
      { type: "finish", text: "אלדד עומד במקומו.", usage: USAGE },
    ]);
    await collect(narrative.stream(INPUT));
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.usage).toEqual(USAGE);
    expect(finishes[0]?.error).toBeUndefined();
    expect(finishes[0]?.promptVersion).toBe(NARRATIVE_PROMPT_VERSION);
  });

  it("ends the stream after an in-band error rather than throwing", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד מתק" },
      { type: "error", error: { code: "provider_error", message: "socket closed", retryable: true } },
    ]);
    // Must not reject: throwing into an async iterator forces every consumer
    // into a try/catch around its for-await, which is exactly why StreamChunk
    // carries failure in-band.
    expect(await collect(narrative.stream(INPUT))).toEqual(["אלדד מתק"]);
    expect(finishes[0]?.error?.code).toBe("provider_error");
  });

  it("reports a finish even when the consumer abandons the stream early", async () => {
    const { narrative, finishes } = narrativeFor([
      { type: "text-delta", text: "אלדד " },
      { type: "text-delta", text: "עומד במקומו." },
      { type: "finish", text: "אלדד עומד במקומו.", usage: USAGE },
    ]);
    for await (const chunk of narrative.stream(INPUT)) {
      expect(chunk).toBe("אלדד ");
      break;
    }
    expect(finishes).toHaveLength(1);
  });
});
```

Check `AdapterError`'s real field names in `packages/agents/src/providers/errors.ts` and match them; the `{ code, message, retryable }` above is the expected shape.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/agents test hebrew
```

Expected: FAIL — `./hebrew.js` does not exist.

- [ ] **Step 3: Write the agent**

Create `packages/agents/src/narrative/hebrew.ts`:

```ts
// The Hebrew narrative agent: brief in, Hebrew tokens out.
//
// It does exactly one thing beyond assembling the prompt — it declines to
// throw. A provider error ends the stream after whatever text arrived, and
// the pipeline decides what to do about the shortfall. That split is
// deliberate: the pipeline owns the turn deadline, so it is the only place
// that can see BOTH ways a narration can come up short, and one rule applied
// there beats two rules applied in two places.
import type { AdapterError } from "../providers/errors.js";
import type { TokenUsage } from "../providers/port.js";
import type { AgentRuntime } from "../providers/runtime.js";
import type { NarrationInput, NarrativePort } from "./port.js";
import { buildNarrativePrompt } from "./prompt.js";
import { NARRATIVE_PROMPT_VERSION } from "./prompt-text.js";

/** Instrumentation, deliberately off the token stream. */
export interface NarrativeFinish {
  usage?: TokenUsage;
  /** Present when the provider failed in-band. The stream still ended cleanly. */
  error?: AdapterError;
  latencyMs: number;
  promptVersion: string;
}

export interface HebrewNarrativeOptions {
  runtime: AgentRuntime;
  /**
   * Called exactly once per stream, including when the consumer abandons it
   * early. `apps/server/CLAUDE.md` requires per-turn per-agent instrumentation,
   * and without this a swallowed provider error would be invisible.
   */
  onFinish?: (finish: NarrativeFinish) => void;
  /** Injected so a test can assert latency without a real clock. */
  now?: () => number;
}

async function* streamNarration(
  options: HebrewNarrativeOptions,
  input: NarrationInput,
): AsyncIterable<string> {
  const now = options.now ?? ((): number => Date.now());
  const startedAt = now();
  let usage: TokenUsage | undefined;
  let error: AdapterError | undefined;

  try {
    for await (const chunk of options.runtime.stream("narrative", {
      prompt: buildNarrativePrompt(input),
    })) {
      if (chunk.type === "text-delta") {
        yield chunk.text;
        continue;
      }
      if (chunk.type === "finish") {
        usage = chunk.usage;
        return;
      }
      error = chunk.error;
      return;
    }
  } finally {
    // `finally` rather than the happy path: a consumer that breaks out of its
    // for-await propagates `.return()` in here, and the turn still deserves a
    // metrics record. The pipeline's deadline cap does exactly that.
    options.onFinish?.({
      ...(usage === undefined ? {} : { usage }),
      ...(error === undefined ? {} : { error }),
      latencyMs: now() - startedAt,
      promptVersion: NARRATIVE_PROMPT_VERSION,
    });
  }
}

export function createHebrewNarrative(options: HebrewNarrativeOptions): NarrativePort {
  return {
    stream(input: NarrationInput): AsyncIterable<string> {
      return streamNarration(options, input);
    },
  };
}
```

- [ ] **Step 4: Export it**

Add `export * from "./hebrew.js";` and `export * from "./prompt.js";` and `export * from "./prompt-text.js";` to `packages/agents/src/narrative/index.ts`.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ai-dm/agents test && npx eslint packages/agents
```

Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/narrative/hebrew.ts packages/agents/src/narrative/hebrew.test.ts \
        packages/agents/src/narrative/index.ts
git commit -m "feat(agents): add the streaming Hebrew narrative agent"
```

---

## Task 11: `Session` carries the scene and the narration window

**Files:**
- Modify: `apps/server/src/core/session.ts`
- Test: `apps/server/src/core/session.test.ts`

**Interfaces:**
- Consumes: `BuiltEncounter.sceneEnglish` (Task 3), `NarrativeEmittedPayload` (Task 4).
- Produces: `Session.sceneEnglish: string` and `Session.recentNarrations: string[]`. Task 12 reads and writes them.

Deliberately **not** in `SessionState`: `reduce` keeps treating `narrative_emitted` as a no-op, the wire protocol is untouched, and the window is a projection of the log rebuilt at load — so invariant 3 holds without pushing prompt-shaped data at a client that has no use for it.

- [ ] **Step 1: Write the failing test**

In `apps/server/src/core/session.test.ts`:

```ts
const NARRATION_WINDOW = 2;

it("resolves the encounter's scene card once at creation", async () => {
  const session = await createSession({ ...baseInput(), encounterId: "goblin-ambush" });
  expect(session.sceneEnglish).toContain("hillside");
  expect(session.recentNarrations).toEqual([]);
});

it("rebuilds the narration window from the log tail on load", async () => {
  const store = createMemoryStore();
  const session = await createSession({ ...baseInput(), store, encounterId: "goblin-ambush" });

  for (const text of ["ראשון.", "שני.", "שלישי."]) {
    await store.append(session.state.sessionId, [{
      eventId: `e-${text}`,
      sessionId: session.state.sessionId,
      sequence: session.nextSequence++,
      timestamp: "2026-08-21T00:00:00.000Z",
      type: "narrative_emitted",
      payload: { actorId: "hero", streamId: "s", text, source: "model", promptVersion: "v" },
    }]);
  }

  const loaded = await loadSession(session.state.sessionId, store);
  expect(loaded.recentNarrations).toEqual(["שני.", "שלישי."]);
  expect(loaded.recentNarrations).toHaveLength(NARRATION_WINDOW);
});
```

Match the existing helpers in that file (`baseInput`, the store double) rather than inventing new ones.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test session
```

Expected: FAIL — neither field exists.

- [ ] **Step 3: Add the fields**

In `apps/server/src/core/session.ts`:

```ts
/**
 * How many past narrations the narrative agent is shown. Two: enough to stop
 * it reusing a verb it just used, small enough that the uncached tier stays
 * cheap. Not in `SessionState` — see the doc comment on `recentNarrations`.
 */
export const NARRATION_WINDOW = 2;

export interface Session {
  state: SessionState;
  built: BuiltEncounter;
  /** The sequence the next appended event will take. */
  nextSequence: number;
  /** The encounter's narrator-facing scene card. Static; resolved once here. */
  sceneEnglish: string;
  /**
   * The last `NARRATION_WINDOW` narrations, oldest first. A projection of the
   * `narrative_emitted` events in the log, held here rather than in
   * `SessionState` because the client has no use for it and `reduce` keeps
   * treating that event as a no-op. Rebuilt by `loadSession`, so a reconnect
   * does not hand the narrator an empty memory.
   */
  recentNarrations: string[];
}
```

Populate `sceneEnglish: built.sceneEnglish` and `recentNarrations: []` in `createSession`. In `loadSession`, collect while folding:

```ts
const recentNarrations: string[] = [];
for (const event of events) {
  if (event.type !== "narrative_emitted") continue;
  const parsed = NarrativeEmittedPayload.safeParse(event.payload);
  // Tolerant on purpose: this is a prompt-quality nicety, and a payload from
  // before this convention existed must not stop a session from loading.
  if (!parsed.success) continue;
  recentNarrations.push(parsed.data.text);
}
```

then `recentNarrations.slice(0 - NARRATION_WINDOW)` on the way into the `Session`.

Note: write `slice(0 - NARRATION_WINDOW)`, not `slice(-NARRATION_WINDOW)`, only if a lint rule demands it — the `-0` gotcha in `CLAUDE.md` applies to arithmetic results compared with `toBe(0)`, not here. Plain `slice(-NARRATION_WINDOW)` is correct.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @ai-dm/server test session
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/session.ts apps/server/src/core/session.test.ts
git commit -m "feat(server): carry the scene card and a narration window on Session"
```

---
## Task 12: The pipeline's degradation ladder

**Files:**
- Modify: `apps/server/src/core/pipeline.ts` (`TurnPorts`, `narrate`, new `endsComplete`)
- Modify: `apps/server/src/transport/ws.test.ts`, `apps/server/src/e2e.test.ts`, `apps/server/src/core/replay.test.ts` — each constructs `TurnPorts` and needs the new field
- Test: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `buildNarrationBrief` (Task 5), `createDeterministicNarrative` (Task 7), `NARRATIVE_PROMPT_VERSION` (Task 8), `Session.sceneEnglish` / `Session.recentNarrations` / `NARRATION_WINDOW` (Task 11), `NarrationSource` (Task 4).
- Produces: `TurnPorts.conditionNamesHebrew: ReadonlyMap<Condition, string>`; `narrative_emitted` payloads carrying `source` and `promptVersion`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/core/pipeline.test.ts`, using whatever harness that file already uses to drive one turn and collect frames:

```ts
function narrativeOf(frames: ServerFrame[]): { tokens: string[]; emitted: NarrativeEmittedPayload } {
  const tokens = frames.filter((f) => f.type === "narrative_token").map((f) => f.text);
  const event = frames.find((f) => f.type === "event" && f.event.type === "narrative_emitted");
  if (event?.type !== "event") throw new Error("no narrative_emitted frame");
  return { tokens, emitted: NarrativeEmittedPayload.parse(event.event.payload) };
}

/** A port that yields exactly these chunks and then stops. */
function scriptedNarrative(chunks: string[]): NarrativePort {
  return {
    stream(): AsyncIterable<string> {
      return (async function* gen() { for (const chunk of chunks) yield chunk; })();
    },
  };
}

it("marks a complete model narration as source model and stores it verbatim", async () => {
  const frames = await runOneTurn({ narrative: scriptedNarrative(["אלדד ", "פוגע בגובלין לוחם."]) });
  const { tokens, emitted } = narrativeOf(frames);
  expect(emitted.source).toBe("model");
  expect(emitted.text).toBe(tokens.join(""));
  expect(emitted.text).toBe("אלדד פוגע בגובלין לוחם.");
});

it("falls back to full Hebrew when the model yields nothing at all", async () => {
  const frames = await runOneTurn({ narrative: scriptedNarrative([]) });
  const { tokens, emitted } = narrativeOf(frames);
  expect(emitted.source).toBe("deterministic");
  expect(emitted.text).toBe(tokens.join(""));
  expect(emitted.text).toMatch(/[֐-׿]/);
  expect(emitted.text).not.toMatch(/[a-zA-Z]/);
});

it("completes a truncated narration instead of storing a severed sentence", async () => {
  const frames = await runOneTurn({ narrative: scriptedNarrative(["חרבו של אלדד מוצאת פתח מתח"]) });
  const { tokens, emitted } = narrativeOf(frames);
  expect(emitted.source).toBe("completed");
  expect(emitted.text).toBe(tokens.join(""));
  expect(emitted.text).toContain("… ");
  expect(emitted.text.trimEnd().endsWith(".")).toBe(true);
});

it("treats a stream that ends on a full stop as complete, not truncated", async () => {
  const frames = await runOneTurn({ narrative: scriptedNarrative(["אלדד עומד במקומו."]) });
  expect(narrativeOf(frames).emitted.source).toBe("model");
});

it("stamps the prompt version on every narration whatever produced it", async () => {
  const frames = await runOneTurn({ narrative: scriptedNarrative([]) });
  expect(narrativeOf(frames).emitted.promptVersion).toBe(NARRATIVE_PROMPT_VERSION);
});

it("feeds each narration into the next turn's window, newest last", async () => {
  const session = await freshSession();
  await drainTurn(session, { narrative: scriptedNarrative(["ראשון."]) });
  await drainTurn(session, { narrative: scriptedNarrative(["שני."]) });
  await drainTurn(session, { narrative: scriptedNarrative(["שלישי."]) });
  expect(session.recentNarrations).toEqual(["שני.", "שלישי."]);
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @ai-dm/server test pipeline
```

Expected: FAIL — `narrate` still builds the old input shape and emits no `source`.

- [ ] **Step 3: Add the port and the terminator check**

In `apps/server/src/core/pipeline.ts`, add to `TurnPorts`:

```ts
  /** Hebrew condition labels, from `loadConditions()`. A port, not a file read:
   *  the pipeline does no I/O of its own. */
  conditionNamesHebrew: ReadonlyMap<Condition, string>;
```

and, beside `untilDeadline`:

```ts
/**
 * Whether a narration ended on a sentence rather than mid-word.
 *
 * This is how the pipeline detects BOTH ways a narration comes up short — a
 * provider that errored mid-stream, and a deadline that cut it — with one
 * check. Neither cause is visible to the narrative port: the agent cannot see
 * the deadline, and `untilDeadline` cannot see the provider. What both leave
 * behind is the same artifact, an unterminated sentence, so that is what gets
 * inspected.
 *
 * Inspects a trimmed copy and never a stored one: `narrative_emitted` must
 * carry exactly the concatenation of the frames yielded for this turn.
 */
const NARRATION_TERMINATORS = [".", "!", "?", "…"] as const;

function endsComplete(text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed !== "" && NARRATION_TERMINATORS.some((mark) => trimmed.endsWith(mark));
}
```

- [ ] **Step 4: Rewrite `narrate`**

Replace the body of `narrate` (keeping its existing doc comment about the shared deadline):

```ts
  async function* narrate(
    actorId: string,
    effect: TurnEffect,
    deadline: number,
  ): AsyncIterable<ServerFrame> {
    const streamId = ports.uuid();
    const input = buildNarrationBrief({
      actorId,
      effect,
      combatants: session.state.combatants,
      statBlocks: session.built.statBlocks,
      conditionNamesHebrew: ports.conditionNamesHebrew,
      sceneEnglish: session.sceneEnglish,
      recentNarrations: session.recentNarrations,
    });

    let text = "";
    for await (const chunk of untilDeadline(ports.narrative.stream(input), deadline)) {
      text += chunk;
      yield { type: "narrative_token", streamId, text: chunk };
    }

    // The ladder. Neither rung is deadline-bound: `untilDeadline` has already
    // returned, template rendering cannot hang, and gating a fallback on a
    // spent deadline would produce a silent turn — which reads to a player as
    // a dropped connection.
    let source: NarrationSource = "model";

    if (text.trim() === "") {
      // Nothing arrived at all. Render the rule outcome through the terse,
      // always-available Hebrew port `apps/server/CLAUDE.md` names as the
      // fallback — still streamed as narrative_token frames, just from a
      // source that cannot itself hang.
      source = "deterministic";
    } else if (!endsComplete(text)) {
      // Tokens arrived and then stopped mid-sentence. Those tokens are
      // already on the player's screen and cannot be unsent, so the shortfall
      // is repaired by streaming MORE rather than by rewriting less. The
      // ellipsis marks the seam so a truncation reads as a truncation.
      source = "completed";
      const seam = "… ";
      text += seam;
      yield { type: "narrative_token", streamId, text: seam };
    }

    if (source !== "model") {
      for await (const chunk of createDeterministicNarrative().stream(input)) {
        text += chunk;
        yield { type: "narrative_token", streamId, text: chunk };
      }
    }

    // No `.trim()`: this must carry exactly the concatenation of the
    // narrative_token chunks yielded above, so that a replay cannot diverge
    // from what the client already rendered optimistically while streaming.
    //
    // `promptVersion` is stamped even on a fallback turn: it records which
    // prompt was in force when the turn ran, which is what a benchmark needs
    // to avoid pooling runs across a prompt edit.
    yield* emit("narrative_emitted", {
      actorId,
      streamId,
      text,
      source,
      promptVersion: NARRATIVE_PROMPT_VERSION,
    });

    session.recentNarrations = [...session.recentNarrations, text].slice(-NARRATION_WINDOW);
  }
```

Delete the now-unused `namesFor` helper and its `nameEnglish` lookup — `buildNarrationBrief` reads names off the stat blocks itself.

- [ ] **Step 5: Supply the new port at every construction site**

`apps/server/src/transport/ws.test.ts`, `apps/server/src/e2e.test.ts` and `apps/server/src/core/replay.test.ts` each build a `TurnPorts`. Add to each:

```ts
conditionNamesHebrew: new Map([["prone", "שרוע"]]),
```

A real map from `loadConditions()` is fine too; a one-entry map is enough for tests that never narrate a condition.

- [ ] **Step 6: Run the whole server suite**

```bash
pnpm --filter @ai-dm/server test && pnpm typecheck
```

Expected: PASS, exit 0. This is the point where the tree goes green again after Task 5 broke it.

- [ ] **Step 7: Sabotage-check the concatenation guarantee**

Change the `completed` branch to append the seam to `text` **without** yielding a frame for it. Re-run. The `emitted.text === tokens.join("")` assertion MUST fail. Restore it. That assertion is the whole reason a replay cannot diverge from a live session.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/core/pipeline.ts apps/server/src/core/pipeline.test.ts \
        apps/server/src/transport/ws.test.ts apps/server/src/e2e.test.ts apps/server/src/core/replay.test.ts
git commit -m "feat(server): narrate from the brief and complete a truncated narration in Hebrew"
```

---

## Task 13: Wire the Hebrew agent into the server

**Files:**
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/core/pipeline.ts` (`MetricsPort`)
- Test: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `createHebrewNarrative`, `NarrativeFinish` (Task 10), `loadConditions` (Task 2).
- Produces: `MetricsPort.recordNarrativeTurn(record: NarrativeTurnMetrics): void`.

`loadConfig` only proves that *some* provider key is set, not the one `DEFAULT_MODEL_ROUTING.narrative` names — its own comment says so. So the Hebrew agent is wired unconditionally and a missing Anthropic key degrades through the ladder, one failed call per turn, logged. That is the honest behaviour: a silently English game would be worse than a logged, Hebrew-fallback one.

- [ ] **Step 1: Write the failing test**

```ts
it("reports narrative metrics for the turn, including the actor", async () => {
  const records: NarrativeTurnMetrics[] = [];
  await runOneTurn({
    narrative: createHebrewNarrative({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({ stream: [[{ type: "finish", text: "", usage: USAGE }]] }),
      }),
      onFinish: (finish) => records.push({ ...finish, actorId: "hero" }),
    }),
    metrics: { recordTacticalTurn: () => undefined, recordNarrativeTurn: (r) => records.push(r) },
  });
  expect(records.some((r) => r.promptVersion === NARRATIVE_PROMPT_VERSION)).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/server test pipeline
```

Expected: FAIL — `recordNarrativeTurn` is not on `MetricsPort`.

- [ ] **Step 3: Extend `MetricsPort`**

In `apps/server/src/core/pipeline.ts`, beside `recordTacticalTurn`:

```ts
export interface NarrativeTurnMetrics extends NarrativeFinish {
  actorId: string;
}

export interface MetricsPort {
  recordTacticalTurn(turn: TacticalTurnMetrics): void;
  /**
   * The narrative agent reports through `onFinish` rather than through the
   * token stream, so this is the only place a provider error on a narration
   * becomes visible. `apps/server/CLAUDE.md` requires per-turn per-agent
   * instrumentation; without this, a stream that died after two tokens looks
   * from the log exactly like one that finished.
   */
  recordNarrativeTurn(record: NarrativeTurnMetrics): void;
}
```

Keep the existing `TacticalTurnMetrics` name if that file already uses a different one — match it, do not rename.

- [ ] **Step 4: Wire `main.ts`**

```ts
const narrativeRuntime = createAgentRuntime({
  routing: DEFAULT_MODEL_ROUTING,
  port: createVercelPort({}),
});

const metrics: MetricsPort = {
  recordTacticalTurn(turn) {
    logHolder.current?.info(turn, "tactical_turn_metrics");
  },
  recordNarrativeTurn(record) {
    logHolder.current?.info(record, "narrative_turn_metrics");
  },
};
```

and in `ports`:

```ts
    narrative: createHebrewNarrative({
      runtime: narrativeRuntime,
      onFinish: (finish) => {
        // `actorId` is stamped by the pipeline, which knows whose turn it is;
        // the agent does not.
        logHolder.current?.info({ ...finish, agent: "narrative" }, "narrative_stream_finished");
      },
    }),
    conditionNamesHebrew: new Map(
      Array.from(loadConditions(), ([condition, definition]) => [condition, definition.nameHebrew]),
    ),
```

Add a boot log line naming the configured narrative provider, so a missing key is diagnosable from the first line rather than from a turn that quietly fell back:

```ts
app.log.info(
  { provider: DEFAULT_MODEL_ROUTING.narrative.provider, model: DEFAULT_MODEL_ROUTING.narrative.modelId },
  "narrative_model_configured",
);
```

Note the `Array.from(map, fn)` form — `CLAUDE.md` bans spread over iterables under `no-misused-spread`.

- [ ] **Step 5: Run everything**

```bash
pnpm test && pnpm typecheck && npx eslint packages apps tools
```

Expected: PASS, exit 0, exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/main.ts apps/server/src/core/pipeline.ts apps/server/src/core/pipeline.test.ts
git commit -m "feat(server): stream Hebrew narration from the model, with metrics"
```

---

## Task 14: The web client renders Hebrew names

**Files:**
- Modify: `apps/web/src/components/CombatLog.tsx:94`, `apps/web/src/components/ActionBar.tsx:54,72`, `apps/web/src/components/Grid.tsx:103`
- Test: `apps/web/src/components/CombatLog.test.tsx`, `ActionBar.test.tsx`, `Grid.test.tsx`

**Interfaces:**
- Consumes: `CatalogueCombatant.nameHebrew`, `CatalogueAction.nameHebrew` — both already shipped and populated.
- Produces: nothing downstream.

No protocol or schema work. This closes the limitation `PROJECT_PLAN.md` §4.3 records: Hebrew name data exists throughout `data/` but the client renders `nameEnglish`.

- [ ] **Step 1: Update the failing assertions**

Each of the three test files already fixtures both names (e.g. `{ nameEnglish: "Goblin Warrior", nameHebrew: "גובלין לוחם" }`). Change each assertion that expects the English string to expect the Hebrew one, and add one negative per file:

```ts
it("renders the Hebrew name, not the English one", () => {
  render(<CombatLog turns={turns} catalogue={catalogue} />);
  expect(screen.getByText(/גובלין לוחם/)).toBeInTheDocument();
  expect(screen.queryByText(/Goblin Warrior/)).not.toBeInTheDocument();
});
```

`Grid.test.tsx:112` carries a comment asserting the component "renders `nameEnglish`, not the `nameHebrew` the catalogue now also carries" — that comment is now false and must be rewritten, not left.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @ai-dm/web test
```

Expected: FAIL in all three files.

- [ ] **Step 3: Switch the four render sites**

- `CombatLog.tsx:94` — `?.nameEnglish ?? id` becomes `?.nameHebrew ?? id`
- `Grid.tsx:103` — `?.nameEnglish ?? combatantId` becomes `?.nameHebrew ?? combatantId`
- `ActionBar.tsx:54` — `named?.nameEnglish ?? action.actionId ?? action.actionType` becomes `named?.nameHebrew ?? ...`
- `ActionBar.tsx:72` — `named?.nameEnglish ?? targetId` becomes `named?.nameHebrew ?? targetId`

`ActionBar.tsx:50` carries a comment explaining that `<bdi>` is mandatory *because* the value is English. Rewrite it: the wrappers stay, because they are still load-bearing around the numeric roll traces and because the id fallback on each of these lines is still Latin text.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @ai-dm/web test
```

Expected: PASS.

- [ ] **Step 5: Verify in a browser**

```bash
PORT=3000 pnpm dev
```

Open the app, play `goblin-ambush` to a conclusion, and confirm: combatant names, action buttons and the roll log all read Hebrew; the narrative pane streams Hebrew; nothing renders reversed or mirrored. `apps/server/.env` sets `PORT=3001` while the Vite proxy targets 3000, and `--env-file` yields to an already-set variable — hence the explicit `PORT=3000`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components
git commit -m "feat(web): render Hebrew combatant and action names"
```

---
## Task 15: The first-token benchmark

**Files:**
- Create: `tools/sim/src/live/narrative.ts`
- Test: `tools/sim/src/live/narrative.test.ts`
- Modify: `tools/sim/src/cli.ts` (add `narrative` to the `--mode` values), `tools/sim/src/index.ts`

**Interfaces:**
- Consumes: `createHebrewNarrative` (Task 10), `createVercelPort` / `createAgentRuntime` (existing), `NarrationInput` (Task 5).
- Produces: `runNarrativeBenchmark(options): Promise<NarrativeReport>` with `NarrativeReport { samples, ttftMsP50, ttftMsP95, digitViolations, nonHebrewOutputs, overLengthOutputs, usage }`.

This measures the **agent**, not the whole turn, which is the right granularity: the roadmap's criterion is time-to-first-narrative-token, and measuring it through the pipeline would fold in the tactical call's p95 27.8s tail and report a property of a different agent.

Fallback rate is a *session* property, not an agent one, so it is computed separately from `narrative_emitted.source` in a played session's log — see Step 6.

- [ ] **Step 1: Write the failing test**

Create `tools/sim/src/live/narrative.test.ts`. It runs against a scripted port, never a live one — CI makes no network calls.

```ts
import { describe, expect, it } from "vitest";
import { createAgentRuntime, createFakePort, DEFAULT_MODEL_ROUTING } from "@ai-dm/agents";
import { runNarrativeBenchmark, SCRIPTED_BRIEFS } from "./narrative.js";

const USAGE = { inputTokens: 900, outputTokens: 40, cachedInputTokens: 850 };

describe("runNarrativeBenchmark", () => {
  it("covers every beat kind and severity band in its corpus", () => {
    const kinds = new Set(SCRIPTED_BRIEFS.flatMap((brief) => brief.beats.map((beat) => beat.kind)));
    expect(kinds).toEqual(new Set(["move", "attack", "other-action", "unresolved", "hold"]));

    const severities = new Set(
      SCRIPTED_BRIEFS.flatMap((brief) =>
        brief.beats.flatMap((beat) => (beat.kind === "attack" && beat.severity !== undefined ? [beat.severity] : [])),
      ),
    );
    expect(severities).toEqual(new Set(["graze", "solid", "severe", "felling"]));
  });

  it("counts a digit in the output as a violation", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "אלדד פוגע ב-7 נזק." },
            { type: "finish" as const, text: "אלדד פוגע ב-7 נזק.", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.digitViolations).toBe(SCRIPTED_BRIEFS.length);
    expect(report.nonHebrewOutputs).toBe(0);
  });

  it("counts English output as a non-Hebrew violation", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "Eldad holds position." },
            { type: "finish" as const, text: "Eldad holds position.", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.nonHebrewOutputs).toBe(SCRIPTED_BRIEFS.length);
  });

  it("reports the median time to the first token, not to the last", async () => {
    const report = await runNarrativeBenchmark({
      runtime: createAgentRuntime({
        routing: DEFAULT_MODEL_ROUTING,
        port: createFakePort({
          stream: SCRIPTED_BRIEFS.map(() => [
            { type: "text-delta" as const, text: "אלדד " },
            { type: "text-delta" as const, text: "עומד במקומו." },
            { type: "finish" as const, text: "אלדד עומד במקומו.", usage: USAGE },
          ]),
        }),
      }),
      now: (() => { let t = 0; return () => (t += 100); })(),
    });
    expect(report.samples).toHaveLength(SCRIPTED_BRIEFS.length);
    expect(report.ttftMsP50).toBeLessThan(report.ttftMsP95 + 1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/sim test narrative
```

Expected: FAIL — `./narrative.js` does not exist.

- [ ] **Step 3: Write the harness**

Create `tools/sim/src/live/narrative.ts`, exporting:

- `SCRIPTED_BRIEFS: readonly NarrationInput[]` — a hand-written corpus covering every `NarrationBeat` kind, all four severity bands, both `statusAfter` values that the brief can carry beyond `alive`, both grammatical genders (a synthetic feminine creature, since every shipped name is masculine), and a turn with a non-empty `recentNarrations`.
- `runNarrativeBenchmark({ runtime, now })` — for each brief, times the gap from calling `stream()` to the first yielded chunk, accumulates the full text, and classifies it.

Classification rules, each one a property the spec promised and nothing enforces at runtime:

```ts
const HEBREW = /[֐-׿]/;
const DIGIT = /[0-9]/;
const SENTENCE_LIMIT = 3;

function sentenceCount(text: string): number {
  return text.split(/[.!?…]/).filter((part) => part.trim() !== "").length;
}
```

- `digitViolations` — outputs matching `DIGIT`.
- `nonHebrewOutputs` — outputs not matching `HEBREW`.
- `overLengthOutputs` — outputs whose `sentenceCount` exceeds `SENTENCE_LIMIT`.

Percentiles: sort the per-sample TTFT values and index at `Math.floor(length * 0.5)` and `Math.floor(length * 0.95)`, matching whatever `tools/sim/src/run/metrics.ts` already does — read it and reuse its helper rather than writing a second percentile function.

Cost: reuse `tools/sim/src/pricing.ts` and carry `report.ts`'s `costIsUnderreported` flag through, so a provider that does not report cached-token counts is declared rather than quietly averaged in.

- [ ] **Step 4: Add the CLI mode**

In `tools/sim/src/cli.ts`, add `"narrative"` to the accepted `--mode` values beside `probe`, and route it in `tools/sim/src/index.ts` to `runNarrativeBenchmark`, writing its report into `tools/sim/runs/` in the same shape the step 7b runs use.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ai-dm/sim test && pnpm typecheck
```

Expected: PASS, exit 0.

- [ ] **Step 6: Take the live measurement**

```bash
pnpm --filter @ai-dm/sim start --live --mode narrative
```

Record in the report, and in `PROJECT_PLAN.md` (Task 17):
- `ttftMsP50` against the **< 1.5s** exit criterion.
- `ttftMsP95`, cost per narrated turn, cached-token share.
- All three violation counts. Any non-zero count is a prompt bug, not a tolerance — fix the prompt, bump `NARRATIVE_PROMPT_VERSION`, re-pin the hash, re-measure.

Then play one full `goblin-ambush` session in the browser and compute the fallback rate from the log:

```bash
PORT=3000 pnpm dev
```

Count `narrative_emitted` events by `source`. Report party-turn and hostile-turn fallbacks **separately**: narration shares one 10s budget with the tactical call that precedes a hostile turn, and step 7b measured that call at p95 27.8s, so a hostile-turn fallback is evidence about tactical routing rather than about the narrator. Pooling them would read as the wrong finding.

- [ ] **Step 7: Commit**

```bash
git add tools/sim/src/live/narrative.ts tools/sim/src/live/narrative.test.ts \
        tools/sim/src/cli.ts tools/sim/src/index.ts tools/sim/runs
git commit -m "feat(sim): measure narrative time-to-first-token and output discipline"
```

---

## Task 16: The Hebrew review sheet

**Files:**
- Create: `tools/sim/src/live/review-sheet.ts`
- Test: `tools/sim/src/live/review-sheet.test.ts`
- Create: `docs/prompts/hebrew-review-2026-08-21.md` (generated, committed)

**Interfaces:**
- Consumes: `SCRIPTED_BRIEFS` and `runNarrativeBenchmark` (Task 15). Name, glossary and condition tables are read straight from `data/srd/` and `docs/prompts/` — `tools/sim` may do file I/O, unlike `@ai-dm/agents`.
- Produces: `renderReviewSheet(input: ReviewSheetInput): string`.

Not a blocking gate. Its job is to put one readable artifact in front of a native speaker, so the roadmap's "Hebrew reviewed by native speaker" criterion has something concrete to be satisfied against.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { renderReviewSheet } from "./review-sheet.js";

const INPUT = {
  samples: [
    {
      beatsEnglish: "hero attacks Goblin Warrior with Longsword: critical_hit, severity felling",
      hebrew: "חרבו של אלדד מוצאת פתח מתחת למגן. הגובלין הלוחם מתקפל אל האבן.",
      source: "model" as const,
    },
  ],
  names: [
    { english: "Longsword", hebrew: "חרב ארוכה", kind: "weapon" as const },
    { english: "Goblin Warrior", hebrew: "גובלין לוחם", kind: "monster" as const },
  ],
  glossary: [{ english: "saving throw", hebrew: "גלגול הצלה" }],
  conditions: [{ english: "Prone", hebrew: "שרוע" }],
};

describe("renderReviewSheet", () => {
  it("puts each Hebrew sample next to the English beats that produced it", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("severity felling");
    expect(sheet).toContain("חרבו של אלדד");
  });

  it("lists every name, glossary term and condition for review", () => {
    const sheet = renderReviewSheet(INPUT);
    expect(sheet).toContain("חרב ארוכה");
    expect(sheet).toContain("גלגול הצלה");
    expect(sheet).toContain("שרוע");
  });

  it("tells the reviewer exactly what to do with a correction", () => {
    expect(renderReviewSheet(INPUT)).toContain("data/srd/");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ai-dm/sim test review-sheet
```

Expected: FAIL — `./review-sheet.js` does not exist.

- [ ] **Step 3: Write the renderer**

`renderReviewSheet` emits a markdown document with four sections:

1. **How to review** — one paragraph. A correction to a name is an edit to `data/srd/weapons.json`, `armor.json`, `monsters/*.json` or `conditions.json`; a correction to a glossary term is an edit to `docs/prompts/hebrew-glossary.md` (and the parity test will demand the matching edit in `prompt-text.ts`); a correction to the register or the template wording is an edit to `NARRATIVE_SYSTEM_PROMPT` or `deterministic.ts`, each behind a version bump and a re-pinned hash.
2. **Narration samples** — for each sample, the English beats, then the Hebrew, then which source produced it.
3. **Names** — the ~62 `nameHebrew` values (38 weapons, 13 armors, 11 monsters) plus every action name, as an English/Hebrew table grouped by kind.
4. **Glossary and conditions** — the 24 glossary rows and the 15 condition labels.

Flag explicitly for review: the deterministic renderer's template wording, which attaches prepositions to bare names (`בגובלין לוחם`, `את גובלין לוחם`) without definite-article agreement. That is the weakest Hebrew in the change and the reviewer should see it called out rather than have to find it.

- [ ] **Step 4: Generate and commit the sheet**

```bash
pnpm --silent sim --live --mode narrative --review-sheet > docs/prompts/hebrew-review-2026-08-21.md
```

Add `--review-sheet` to `KNOWN_FLAGS` in `tools/sim/src/cli.ts`.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ai-dm/sim test && pnpm typecheck
```

Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add tools/sim/src/live/review-sheet.ts tools/sim/src/live/review-sheet.test.ts \
        tools/sim/src/cli.ts docs/prompts/hebrew-review-2026-08-21.md
git commit -m "feat(sim): generate the Hebrew review sheet"
```

---

## Task 17: Documentation

**Files:**
- Modify: `PROJECT_PLAN.md` (§4 roadmap row 9, §4.1 task list, §4.3, §4.5)
- Modify: `RULES_REFERENCE.md` (§8)
- Modify: `docs/prompts/README.md`
- Modify: `packages/agents/CLAUDE.md`

**Interfaces:**
- Consumes: the measured numbers from Task 15.
- Produces: nothing in code.

- [ ] **Step 1: Update `PROJECT_PLAN.md`**

- **§4 roadmap row 9** — `⬜ not started` becomes `✅ done`, with the measured first-token p50 in the criterion column, replacing the target with the number.
- **§4.1 task list** — check off "**Step 9:** build the rules digest for the narrative/tactical static prompt tier", and amend it to record that it is wired into the **narrative role only**, because adding it to the tactical prompt would change the prompt the step 7b benchmark measured.
- **§4.3** — delete the two limitations this change closes: "The narrative pane currently renders **English**…" and "Hebrew name data now exists throughout `data/srd/`… but the web client does not consume it yet." Replace them with the ones it ships, from the spec's *Limitations this spec knowingly ships*.
- **§4.5** — record spec #2 as implemented, with the commit range and the before/after suite counts, in the same form spec #1's paragraph uses.

- [ ] **Step 2: Update `RULES_REFERENCE.md` §8**

The `diesAtZeroHp` gap entry stays open and unchanged — this change does not close it. Add one sentence to it recording the new consequence: both narrators render an `unconscious` beat that the pipeline cannot currently produce, so a death-save driver gains working narration the day it lands.

- [ ] **Step 3: Update `docs/prompts/README.md`**

Add the narrative module to the "Where prompt text actually lives" table:

| narrative | `packages/agents/src/narrative/prompt-text.ts` |
| rules digest | `packages/agents/src/rules-digest.ts` |

and rewrite the `hebrew-glossary.md` paragraph to record the resolution rather than leaving the contradiction: the markdown stays the editable source of record, `prompt-text.ts` holds the runtime copy because the package may not read files, and a parity test fails when the two disagree.

- [ ] **Step 4: Update `packages/agents/CLAUDE.md`**

The `narrative/` bullet currently promises output that "ends prompting the player". It does not — a closing prompt on every goblin's turn reads wrong, and the design dropped it. Rewrite the bullet to match what shipped: claude-sonnet-5, streaming, brief in and Hebrew out, 2–3 sentences, no digits, nouns only from supplied vocabulary, gender agreement, and the pipeline-owned degradation ladder.

- [ ] **Step 5: Full verification**

```bash
corepack enable && pnpm test && pnpm typecheck && npx eslint packages apps tools
```

Expected: all three green. Record the final test count — it replaces 1042/76 as the new baseline.

- [ ] **Step 6: Commit**

```bash
git add PROJECT_PLAN.md RULES_REFERENCE.md docs/prompts/README.md packages/agents/CLAUDE.md
git commit -m "docs: record the Hebrew narrative agent as shipped"
```

---

## Definition of done

- `pnpm test`, `pnpm typecheck` and `npx eslint packages apps tools` all green.
- `goblin-ambush` plays to a conclusion in a browser with every turn narrated in Hebrew, names and roll log in Hebrew, nothing reversed.
- Measured first-token p50 recorded against the < 1.5s criterion, with party-turn and hostile-turn fallback rates reported separately.
- Zero digit, non-Hebrew or over-length violations in the benchmark corpus.
- `docs/prompts/hebrew-review-2026-08-21.md` committed and handed to the reviewer.
- Every hash pin holds a real hash. A `REPLACE_WITH_ACTUAL_HASH` anywhere in the tree is a failed task.
