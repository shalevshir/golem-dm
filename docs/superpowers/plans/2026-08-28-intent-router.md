# Intent Router, `free_text`, Out-of-Combat Ability Checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scene engine reachable by a player: a `free_text` message classified by a cheap intent tier, validated by the scene engine, resolved into events the shared fold projects, and narrated in Hebrew — plus out-of-combat ability checks through the engine's existing `abilityCheck`.

**Architecture:** [Design spec](../specs/2026-08-28-intent-router-design.md). Deltas-only `SceneSnapshot` on `WorldState`; genesis names the entry point (`worldId`, `startingNodeId`, `startingDay`, `characterId`) and a shared `sceneFromGenesis` rebuilds it; three new fold events carry engine-computed results; a closed-choice intent agent (`generateStructured`, role `intent`); a second narration brief through the extracted degradation ladder; a minimal web slice (RTL text input when no encounter is open).

**Spec:** [`docs/superpowers/specs/2026-08-28-intent-router-design.md`](../specs/2026-08-28-intent-router-design.md)

**Tech Stack:** TypeScript 5.9 strict, ESM, Node 22, zod 3.25.76, Vitest 3, Fastify + ws, React 18.

### The one thing this plan gets right or gets wrong

**A refused proposal must leave state untouched and the log must prove it.**
The router is a model; it will propose closed edges, unknown nodes, and
categories that fit nothing. Every refusal path in this plan ends in
narration, never in an event that changes `WorldState.scene` — and the
backstop is Task 10's replay-equivalence test, which folds the log back and
asserts it equals the live projection after a session containing at least one
refusal. If a refused traversal ever half-applies (an emitted
`quest_node_completed` with no `quest_node_entered`, a delta from a
transition that was rejected), replay diverges and that test is what catches
it. Write the refusal tests first in Tasks 9–10, not as an afterthought — a
mocked classifier makes the happy path easy and the refusal path is where the
invariant lives.

The second hazard is quieter: `reduce` gains three cases that must stay
**mechanical**. If any fold case computes a band, clamps, or consults the
authored world, invariant 5 is breached even though nothing crashes. The
payloads carry absolute results; the fold merges. Any arithmetic in
`reduce.ts` beyond an array append/replace is a bug.

## Global Constraints

- **Dependency direction:** `schemas ← rules-engine ← agents ← server`; `web` depends only on `schemas`. `reduce` may never import the rules engine; the scene engine may never import `apps/server`.
- **The engine is the only authority (invariant 1).** The router proposes ids and enum words; `traverseEdge`/`completeCurrentNode`/`abilityCheck` decide. `applyEffect` stays unexported. The model never emits a number that reaches state.
- **Event log is the source of truth (invariant 3).** Every scene mutation is an event; payloads carry engine-computed **results** (absolute bands, absolute day), never deltas to compute.
- **Schemas define everything once (invariant 4).** `IntentClassification` is the tool schema, the parse, and the type. Never re-derive `pairKey`'s format outside `authored-world.ts`.
- **English inside, Hebrew outside — amended clause:** Hebrew in the log is `narrative_emitted.text` and (new, this plan) `player_input.text`. Everything else stays English.
- **Append-only compatibility:** new payload fields optional, `WorldState.scene` defaults to null, no payload repurposed.
- **Exhaustiveness:** switches over discriminated unions return from every branch with **no `default`** (`strictNullChecks` makes a missing case TS2366). Never add a `default`.
- **TypeScript strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.** ESLint `strictTypeChecked`: no `!`, `_`-prefixed unused params still error, `[...str]` banned.
- **ESM, `.js` extensions in relative imports.**
- **`corepack enable` before any pnpm command.** Lint with `npx eslint packages apps tools` — **never** root `pnpm lint` (walks sibling worktrees). **Never** `pnpm format`.
- **Do not touch `packages/memory/CLAUDE.md`** (carries someone else's uncommitted edit in the main checkout). **Stage files by name; never `git add -A` / `git add .`.**
- **No new predicate or effect kinds; `data/world/` counts stay pinned** (one town, two factions, three NPCs, five nodes).
- **Combat path unchanged:** `{encounterId}` creation, `structured_action`, tactical loop, combat narration — the existing pipeline tests (49 in `pipeline.test.ts`) must pass unmodified except where a task explicitly says otherwise.
- **Coverage:** `packages/rules-engine` ≥90% lines.
- **Sabotage step:** every new guard/check gets broken once, the suite run, the expected failures observed, then restored. A check whose test cannot fail is a decoration.
- **Rule verification:** before committing the DC table, verify SRD 5.2.1 "Typical Difficulty Classes" via `RULES_REFERENCE.md` and the NotebookLM SRD notebook (`notebook_query`, notebook `3a0d4f39-93c2-48ee-b1d1-258c7f7583ab`) — never from memory.
- **Baseline** (branch `claude/intent-router-ability-checks-708fd2` at `e09a4b2`): 1384 passed / 30 skipped / 95 files without `DATABASE_URL`; 1414 / 0 with it; typecheck and eslint exit 0. Every task ends at least this green.

---

## File Structure

**`@ai-dm/schemas`** —
`src/protocol.ts` (add `SceneSnapshot`, `WorldState.scene`, `sceneFromGenesis`),
`src/intent.ts` (new: `CheckDifficulty`, `IntentClassification`),
`src/events.ts` (genesis quartet; four new enum members; five new payload schemas),
`src/reduce.ts` (three fold cases, one no-op, `sceneOrThrow` helper),
`src/index.ts` (exports), colocated tests.

**`@ai-dm/rules-engine`** —
`src/checks/index.ts` (add `DC_BY_DIFFICULTY`),
`src/scene/authored-world.ts` (add `splitPairKey`),
`src/scene/snapshot.ts` (new: `sceneStateFrom`, `snapshotOf`, `diffScene`),
`src/scene/index.ts` (re-export), colocated tests.

**`@ai-dm/agents`** —
`src/intent/prompt-text.ts`, `src/intent/prompt.ts`, `src/intent/index.ts` (new: the intent agent),
`src/narrative/scene-port.ts`, `src/narrative/scene-prompt-text.ts`, `src/narrative/scene.ts`, `src/narrative/scene-deterministic.ts` (new: scene narration),
`src/index.ts` (exports), colocated tests.

**`@ai-dm/server`** —
`src/core/campaign.ts` (`sceneStatics`, `CreateCampaignInput.scene`, `sceneStaticsOf`, `loadCampaign` scene rebuild),
`src/core/pipeline.ts` (ladder extraction; the `free_text` case; `TurnPorts` + `MetricsPort` additions),
`src/transport/http.ts` (body union, `create` union, `UnknownWorldError` handling),
`src/world/index.ts` (`UnknownWorldError`),
`src/main.ts` (wire intent agent, scene narrator, `skillAbilities`), colocated tests.

**`@ai-dm/web`** —
`src/components/FreeTextBar.tsx` (new), `src/App.tsx` (scene view gating, `?world=` creation), `src/net/api.ts` (world-mode create), `src/i18n.ts` (labels), colocated tests.

**Docs** — `PROJECT_PLAN.md` §4.7 sequence entry 4; `packages/schemas/src/events.ts` Hebrew-rule comment (in Task 3); `packages/rules-engine/CLAUDE.md` Modules line for `checks/` (in Task 2); `packages/agents/CLAUDE.md` intent contract check (in Task 5).

---

### Task 1: `SceneSnapshot`, the genesis quartet, `sceneFromGenesis`

**Files:**
- Modify: `packages/schemas/src/protocol.ts` (imports from `./content.js`; new schema + field + helper)
- Modify: `packages/schemas/src/events.ts` (`CampaignStartedPayload`)
- Modify: `packages/schemas/src/index.ts` (exports, if `SceneSnapshot`/`sceneFromGenesis` are not covered by an existing `export *`)
- Modify: `apps/server/src/core/campaign.ts` (`initialWorldState` gains `scene`)
- Test: `packages/schemas/src/protocol.test.ts` (or the file that already tests `WorldState`), `packages/schemas/src/events.test.ts`

**Interfaces:**
- Consumes: `ContentId`, `FactionRelationEntry` from `content.ts`.
- Produces (later tasks rely on these exact names):

```ts
// protocol.ts
export const SceneSnapshot = z.object({
  worldId: ContentId,
  currentNodeId: ContentId,
  completedNodeIds: z.array(ContentId),
  /** Overlay: ONLY pairs a completed node has shifted (absolute bands).
   *  Read through `relationBetween`'s authored baseline, never alone. */
  relations: z.array(FactionRelationEntry),
  day: z.number().int().min(1),
});
export type SceneSnapshot = z.infer<typeof SceneSnapshot>;
// WorldState gains: scene: SceneSnapshot.nullable().default(null)
export function sceneFromGenesis(payload: CampaignStartedPayload): SceneSnapshot | null;

// events.ts — CampaignStartedPayload becomes:
export const CampaignStartedPayload = z
  .object({
    rootSeed: z.number().int(),
    worldId: ContentId.optional(),
    startingNodeId: ContentId.optional(),
    startingDay: z.number().int().min(1).optional(),
    characterId: z.string().optional(),
  })
  .refine(
    (p) =>
      [p.worldId, p.startingNodeId, p.startingDay, p.characterId].every((f) => f === undefined) ||
      [p.worldId, p.startingNodeId, p.startingDay, p.characterId].every((f) => f !== undefined),
    { message: "scene genesis fields are all-or-none" },
  );
```

- [ ] **Step 1: Write the failing tests.** In the schemas tests: (a) `WorldState.parse` of a legacy object without `scene` yields `scene: null`; (b) `WorldState` round-trips a populated `SceneSnapshot`; (c) `CampaignStartedPayload` accepts `{rootSeed}` alone and the full quartet, and **rejects** a payload with `worldId` but no `characterId` (assert the refine message); (d) `sceneFromGenesis({rootSeed: 1})` is `null`; (e) `sceneFromGenesis` of a full quartet is `{worldId, currentNodeId: startingNodeId, completedNodeIds: [], relations: [], day: startingDay}`.
- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @ai-dm/schemas test` — expect failures on the missing schema/exports.
- [ ] **Step 3: Implement.** Add the schema, field, refine, and helper exactly as above. `sceneFromGenesis` returns null when `worldId === undefined`; the refine guarantees the rest of the quartet is present otherwise (guard each field anyway — `exactOptionalPropertyTypes` will force honest narrowing).
- [ ] **Step 4: Run schemas tests; then `pnpm typecheck` from the root.** Expect typecheck failures at every `WorldState` object literal (`initialWorldState` in `campaign.ts`, plus any test fixtures across packages). Fix each by adding `scene: null` — a mechanical sweep; list the files touched in the commit message. Note: `sceneFromGenesis` is not yet called anywhere — Task 8 wires it; this task only proves it.
- [ ] **Step 5: Full check.** `pnpm test`, `pnpm typecheck`, `npx eslint packages apps tools` — all green, counts ≥ baseline.
- [ ] **Step 6: Commit; push; open the draft PR.** Stage by name. Then `git push -u origin claude/intent-router-ability-checks-708fd2` and `gh pr create --draft` titled "§4.7 step 4: intent router, free_text, out-of-combat ability checks" — CI runs only on `push:main` and `pull_request`, so the PR must exist from the first task, not the last.

### Task 2: `CheckDifficulty`, `IntentClassification`, `DC_BY_DIFFICULTY`

**Files:**
- Create: `packages/schemas/src/intent.ts`
- Modify: `packages/schemas/src/index.ts`
- Modify: `packages/rules-engine/src/checks/index.ts`
- Modify: `packages/rules-engine/CLAUDE.md` (Modules line: `checks/` now also holds the typical-DC table)
- Test: `packages/schemas/src/intent.test.ts` (new), `packages/rules-engine/src/checks/index.test.ts`

**Interfaces:**
- Consumes: `AbilityKey`, `Skill` from `character.ts`; `ContentId` from `content.ts`.
- Produces:

```ts
// schemas/src/intent.ts
export const CheckDifficulty = z.enum([
  "very_easy", "easy", "medium", "hard", "very_hard", "nearly_impossible",
]);
export type CheckDifficulty = z.infer<typeof CheckDifficulty>;

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

// rules-engine/src/checks/index.ts
export const DC_BY_DIFFICULTY: Record<CheckDifficulty, number> = {
  very_easy: 5, easy: 10, medium: 15, hard: 20, very_hard: 25, nearly_impossible: 30,
};
```

- [ ] **Step 1: Verify the DC values against the SRD before writing them.** Check `RULES_REFERENCE.md`; if it does not carry the typical-DC table, query the NotebookLM SRD notebook (`notebook_query`, notebook id in Global Constraints) for "Typical Difficulty Classes". The values above are the expected answer; if the SRD disagrees, the SRD wins and the spec gets a one-line correction.
- [ ] **Step 2: Write the failing tests.** Schemas: each union member parses; a `check` without `difficulty` fails; an unknown `category` fails; a `check` whose `skill` is `"banana"` fails. Engine: `DC_BY_DIFFICULTY` matches the six verified values exactly (golden), and `Object.keys(DC_BY_DIFFICULTY).length === CheckDifficulty.options.length` so a widened enum cannot silently miss a DC.
- [ ] **Step 3: Run to verify they fail**, then implement both files. `checks/index.ts` imports `CheckDifficulty` as a type from `@ai-dm/schemas`.
- [ ] **Step 4: Run both packages' tests; typecheck; lint.** All green.
- [ ] **Step 5: Update `packages/rules-engine/CLAUDE.md`'s `checks/` module line** to mention the typical-DC table. **Commit** (stage by name).

### Task 3: Four event types and the fold

**Files:**
- Modify: `packages/schemas/src/events.ts` (enum members; payload schemas; amend the Hebrew-rule comment)
- Modify: `packages/schemas/src/reduce.ts` (three fold cases; `check_rolled` in the no-op group; `sceneOrThrow`)
- Modify: `packages/schemas/src/index.ts` (exports)
- Test: `packages/schemas/src/reduce.test.ts`, `packages/schemas/src/events.test.ts`
- Possibly modify: any exhaustive switch over `GameEvent["type"]` that typecheck flags (e.g. `apps/web`'s combat-log fold) — add explicit pass-through cases, never a `default`.

**Interfaces:**
- Consumes: `ContentId`, `FactionRelationEntry` (content), `AbilityKey`, `Skill` (character), `CheckDifficulty`, `IntentClassification` (intent), `SceneSnapshot` — note `reduce.ts` imports from `./protocol.js` already (`CampaignState`).
- Produces:

```ts
// events.ts — enum gains: "quest_node_entered", "quest_node_completed",
// "world_delta_applied", "check_rolled"
export const QuestNodeEnteredPayload = z.object({ nodeId: ContentId });
export const QuestNodeCompletedPayload = z.object({ nodeId: ContentId });
export const WorldDeltaAppliedPayload = z.object({
  /** Absolute resulting bands, post-clamp — the fold merges, never computes. */
  relations: z.array(FactionRelationEntry).default([]),
  /** The new absolute day, when the calendar moved. */
  day: z.number().int().min(1).optional(),
});
export const CheckRolledPayload = z.object({
  actorId: z.string(), ability: AbilityKey, skill: Skill.optional(),
  difficulty: CheckDifficulty, dc: z.number().int(),
  naturalRoll: z.number().int().min(1).max(20), rolls: z.array(z.number().int()),
  modifier: z.number().int(), total: z.number().int(),
  success: z.boolean(), seed: z.number().int(),
});
/** Convention for `intent_classified` (a fold no-op), like ActionRejectedPayload. */
export const IntentClassifiedPayload = z.object({
  clientMessageId: z.string(), actorId: z.string(),
  classification: IntentClassification,
  provider: z.string(), modelId: z.string(), promptVersion: z.string(),
});
// + z.infer type exports for all five
```

- [ ] **Step 1: Write the failing fold tests.** For a state whose `world.scene` is populated: (a) `quest_node_entered` replaces `currentNodeId`; (b) `quest_node_completed` appends to `completedNodeIds` and appending the **same node twice folds to one entry** (idempotent); (c) `world_delta_applied` with a relations entry **replaces** an existing entry for the same unordered pair (test both orderings: payload `{factionA: "b", factionB: "a"}` must replace state entry `{factionA: "a", factionB: "b"}`) and **appends** a new pair; (d) `world_delta_applied` with `day` replaces `scene.day`; with neither field, state is returned unchanged; (e) each of the three throws with a message containing "no scene" when `world.scene` is null; (f) `check_rolled` returns state identically (no-op). Also: `fold` over the sequence completed→delta→entered lands the composite state.
- [ ] **Step 2: Run to verify failures** (enum members missing → TS errors are the expected first failure).
- [ ] **Step 3: Implement.** Enum members; payload schemas; in `reduce.ts` a private `sceneOrThrow(state, event)` mirroring the encounter-null throws ("Scene event ${type} at sequence ${n} with no scene open" — same wording family). The three cases parse their payloads and merge mechanically; unordered pair matching is a plain two-field comparison both ways — **no `pairKey`, no band arithmetic, no authored world.** `check_rolled` joins the listed no-op cases (it changes no projected field; it exists for replay, audit, and metrics). Amend the events.ts payload comment to: "English machine payload. Hebrew is allowed in exactly two fields: `narrative_emitted.text` and `player_input.text` (the player's own words)."
- [ ] **Step 4: Run schemas tests; root typecheck.** The new enum members will trip any exhaustive event-type switch outside `reduce` — extend each with explicit cases (no `default`). Run the full suite.
- [ ] **Step 5: Sabotage.** Break the `sceneOrThrow` guard (return state instead of throwing) — confirm exactly the (e) tests fail; restore. Break idempotent append — confirm (b) fails; restore.
- [ ] **Step 6: Commit.**

### Task 4: Scene converters and `diffScene`

**Files:**
- Modify: `packages/rules-engine/src/scene/authored-world.ts` (add `splitPairKey`)
- Create: `packages/rules-engine/src/scene/snapshot.ts`
- Modify: `packages/rules-engine/src/scene/index.ts` (`export * from "./snapshot.js"`)
- Test: `packages/rules-engine/src/scene/snapshot.test.ts`

**Interfaces:**
- Consumes: `SceneState`, `pairKey` (scene), `SceneSnapshot`, `FactionRelationEntry`, `FactionBand`, `ContentId` (schemas).
- Produces:

```ts
// authored-world.ts — beside pairKey, the ONE inverse of its format:
export function splitPairKey(key: string): [string, string];

// snapshot.ts
export function sceneStateFrom(snapshot: SceneSnapshot): SceneState;
export function snapshotOf(state: SceneState, worldId: ContentId): SceneSnapshot;
export interface SceneDelta {
  relations: FactionRelationEntry[];
  day?: number;
}
export function diffScene(before: SceneState, after: SceneState): SceneDelta;
```

- [ ] **Step 1: Write the failing tests.** (a) Round-trip property: for a handful of snapshots (empty overlay; multi-pair overlay; multi-node completed set), `snapshotOf(sceneStateFrom(s), s.worldId)` deep-equals `s` up to array order — sort both `relations` (by `factionA` then `factionB`) and `completedNodeIds` before comparing, and have `snapshotOf` emit them **sorted** so serialized snapshots are canonical. (b) `sceneStateFrom` keys `relations` by `pairKey` (assert a lookup through `relationBetween` with a hand-built world sees the overlay value). (c) `diffScene`: identical states → `{relations: []}` with no `day`; a state after `traverseEdge` down the Emberfall-shaped guild fixture (reuse `test-fixtures.ts` worlds from step 3) → exactly the shifted pair at its **post-clamp** band; a calendar advance → `day` set; both → both. (d) `splitPairKey(pairKey("b", "a"))` is `["a", "b"]`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** `splitPairKey` is the only code that reads the `|` separator besides `pairKey` itself (its doc comment says so). `diffScene` compares the two maps: entries whose band differs or which are absent from `before` become `FactionRelationEntry` values via `splitPairKey`; `day` is set when `after.day !== before.day`. No effect application, no authored world.
- [ ] **Step 4: Run engine tests + coverage** (`pnpm --filter @ai-dm/rules-engine test:coverage`, ≥90%). Typecheck, lint.
- [ ] **Step 5: Commit.**

### Task 5: The intent agent

**Files:**
- Create: `packages/agents/src/intent/prompt-text.ts`, `packages/agents/src/intent/prompt.ts`
- Modify: `packages/agents/src/intent/index.ts` (replace `export {}`)
- Modify: `packages/agents/src/index.ts` (exports)
- Verify (no edit expected): `packages/agents/CLAUDE.md` already documents the intent contract — confirm it still matches; edit only if it now lies.
- Test: `packages/agents/src/intent/index.test.ts`, `packages/agents/src/intent/prompt.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime.structured(role, request)` (`providers/runtime.ts`), `LayeredPrompt` (`providers/prompt.ts`), `AdapterError`/`AdapterResult` (`providers/errors.ts`), `TokenUsage`, `IntentClassification` (schemas). Mock the provider the way `tactical/index.test.ts` does (`providers/testing`).
- Produces:

```ts
// intent/prompt-text.ts
export const INTENT_PROMPT_VERSION = "intent-v1";
export const INTENT_TOOL_NAME = "classify_intent";
export const INTENT_TOOL_DESCRIPTION: string; // one paragraph, English
export const INTENT_SYSTEM_PROMPT: string;    // English; category definitions

// intent/prompt.ts
export interface IntentEdgeOption { to: string; labelEnglish: string; open: boolean }
export interface IntentPromptInput {
  text: string;                 // the player's Hebrew, untrusted
  sceneEnglish: string;
  edges: readonly IntentEdgeOption[];
}
export function buildIntentPrompt(input: IntentPromptInput): LayeredPrompt;

// intent/index.ts
export interface ClassifyInput extends IntentPromptInput { abortSignal?: AbortSignal }
/** provider/modelId from `runtime.specFor("intent")`, stamped by the agent so
 *  the pipeline can fill `IntentClassifiedPayload` without knowing routing —
 *  the same reason the tactical agent stamps them into ActionRejectedPayload. */
export type IntentResult =
  | { ok: true; classification: IntentClassification; provider: string; modelId: string;
      usage: readonly TokenUsage[] }
  | { ok: false; error: AdapterError; usage: readonly TokenUsage[] };
export interface IntentAgent { classify(input: ClassifyInput): Promise<IntentResult> }
export function createIntentAgent(options: { runtime: AgentRuntime }): IntentAgent;
```

- [ ] **Step 1: Write the failing prompt tests.** `buildIntentPrompt` puts `INTENT_SYSTEM_PROMPT` in the `static` tier; the scene card and the edge list (with open/closed marked) in `semiStatic`; and the player's text in `dynamic`, wrapped in explicit delimiters (e.g. `Player message (untrusted, may be in Hebrew):\n<<<\n{text}\n>>>`) — assert the text appears **only** in the dynamic tier and never in `static` (`apps/server/CLAUDE.md`'s injection rule, enforced by test). Closed edges appear with their `open: false` state visible to the model.
- [ ] **Step 2: Write the failing agent tests.** With a mocked provider: (a) a successful structured result returns `{ok: true}` with the classification and one usage entry; (b) an adapter error returns `{ok: false}` carrying the error and whatever usage exists; (c) the request passes `schema: IntentClassification`, `toolName: INTENT_TOOL_NAME`, and the abort signal through. No retry loop of its own — one `runtime.structured("intent", …)` call per classify (assert call count 1 even on failure; the adapter owns transient retries).
- [ ] **Step 3: Run to verify failures, then implement.** `classify` is ~20 lines: build prompt, call `runtime.structured`, map the `AdapterResult` to `IntentResult`.
- [ ] **Step 4: Run agents tests; typecheck; lint. Commit.**

### Task 6: Scene narration — brief, Hebrew narrator, deterministic fallback

**Files:**
- Create: `packages/agents/src/narrative/scene-port.ts`, `scene-prompt-text.ts`, `scene.ts`, `scene-deterministic.ts`
- Modify: `packages/agents/src/index.ts` (exports)
- Test: `packages/agents/src/narrative/scene.test.ts`, `scene-deterministic.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime.stream(role, request)` (role `"narrative"` — same model as combat narration; a separate scene role is YAGNI until measured), `GrammaticalGender` (schemas), the `StreamChunk` switch pattern from `narrative/hebrew.ts` (read it first and mirror its error handling: an in-band `error` chunk ends the stream silently; the pipeline's ladder supplies the fallback).
- Produces:

```ts
// scene-port.ts
export type SceneBeat =
  | { kind: "arrived"; sceneEnglish: string; locationNameHebrew: string }
  | { kind: "refused"; messages: readonly string[] }
  | { kind: "check"; ability: AbilityKey; skill?: Skill; success: boolean }
  | { kind: "reply"; category: "social" | "combat" | "ooc" };
export interface SceneNarrationInput {
  beat: SceneBeat;
  /** The current node's card. English — invariant 2. */
  sceneEnglish: string;
  playerNameHebrew: string;
  playerGender: GrammaticalGender;
  /** Hebrew names of NPCs present at the node's location. May be empty. */
  npcNamesHebrew: readonly string[];
  /** The previous narrations, Hebrew, oldest first. */
  recentNarrations: readonly string[];
}
export interface SceneNarrativePort {
  stream(input: SceneNarrationInput): AsyncIterable<string>;
}

// scene-prompt-text.ts
export const SCENE_PROMPT_VERSION = "scene-v1";

// scene.ts
export function createHebrewSceneNarrative(options: {
  runtime: AgentRuntime;
  onFinish?: (finish: NarrativeFinish) => void;  // same type combat narration uses
}): SceneNarrativePort;

// scene-deterministic.ts
export function createDeterministicSceneNarrative(): SceneNarrativePort;
```

- [ ] **Step 1: Write the failing deterministic tests.** One template per beat kind, Hebrew output, no numbers, built only from the input's Hebrew fields (mirror `deterministic.ts`'s discipline — read it first): `arrived` names `locationNameHebrew`; `refused` is a generic blocked-path line (the English rejection messages are **not** echoed — they are for the model tier and the log, not the fallback's Hebrew); `check` has a success and a failure line; `reply` for `combat` says fighting is not possible here. Assert each yields non-empty Hebrew ending in a terminator (`.`/`!`/`?`/`…`) so `endsComplete` treats a fallback as complete.
- [ ] **Step 2: Write the failing model-tier tests.** With a mocked provider: the prompt layers put `SCENE_PROMPT_VERSION`-stamped system text + glossary rules in `static`, the scene card and NPC names in `semiStatic`, the beat and recent narrations in `dynamic`; the port yields exactly the provider's text deltas; an in-band error chunk ends the stream without throwing (the ladder upstream handles emptiness). Mirror `hebrew.ts`'s structure — read it before writing.
- [ ] **Step 3: Run to verify failures, then implement.** Prompt rules for the model tier: 1–3 sentences, Hebrew, no digits or number-words, only supplied proper nouns (player name, NPC names), verbs agreeing with `playerGender`; for `refused`, explain in-world *why* using the beat's English messages as ground truth to translate from, never invent an alternative route.
- [ ] **Step 4: Run agents tests; typecheck; lint. Commit.**

### Task 7: Extract the narration ladder (pure refactor)

**Files:**
- Modify: `apps/server/src/core/pipeline.ts` (extract from `narrate()`; no behaviour change)
- Test: existing `apps/server/src/core/pipeline.test.ts` (must pass **unmodified** — that is the point)

**Interfaces:**
- Produces (module-private to `pipeline.ts`; Task 9–10 call it):

```ts
interface LadderOutcome { text: string; source: NarrationSource }
/** Streams `primary` until `deadline`, then applies the ladder:
 *  empty → fallback; truncated → seam + fallback completion.
 *  Yields narrative_token frames only; mutates `out` for the caller,
 *  which owns the narrative_emitted emit and the metrics call. */
async function* narrationLadder(args: {
  streamId: string;
  primary: AsyncIterable<string>;
  fallback: () => AsyncIterable<string>;
  deadline: number;
  out: LadderOutcome;
}): AsyncIterable<ServerFrame>
```

- [ ] **Step 1: Run the pipeline tests green as the pinned baseline.** `pnpm --filter @ai-dm/server test` — note the count.
- [ ] **Step 2: Refactor.** Move the body of `narrate()` between the stream loop and the `narrative_emitted` emit into `narrationLadder` exactly as sketched: the `untilDeadline` loop, the empty/`endsComplete` decision, the `"… "` seam, the fallback drain — token frames yielded, `out.text`/`out.source` accumulated. `narrate()` becomes: build brief → `yield* narrationLadder({primary: ports.narrative.stream(input), fallback: () => createDeterministicNarrative().stream(input), …})` → metrics + `narrative_emitted` emit + `recentNarrations` window, reading `out`. The `out` parameter is mutated because a generator's return value is unreachable through `yield*` — say so in its doc comment.
- [ ] **Step 3: Run the pipeline tests.** All pass with zero edits to the test file. Any test edit means the refactor changed behaviour — stop and fix the refactor, not the test.
- [ ] **Step 4: Typecheck; lint; commit** (`refactor(server): extract the narration degradation ladder`).

### Task 8: Scene campaigns — creation, statics, load

**Files:**
- Modify: `apps/server/src/core/campaign.ts`
- Modify: `apps/server/src/world/index.ts` (`UnknownWorldError`)
- Modify: `apps/server/src/transport/http.ts` (body union; `create` union; 404 mapping)
- Test: `apps/server/src/core/campaign.test.ts`, `apps/server/src/transport/http.test.ts`

**Interfaces:**
- Consumes: `loadWorld` (world), `loadCharacter` (encounters/characters), `sceneFromGenesis` (schemas), `AuthoredWorld` (rules-engine).
- Produces:

```ts
// campaign.ts
export interface SceneStatics {
  authored: AuthoredWorld;
  character: DerivedCharacter;
}
// Campaign gains: sceneStatics: SceneStatics | null  (mirrors `built`'s doc contract)
// CreateCampaignInput gains: scene?: SceneStatics
export function sceneStaticsOf(campaign: Campaign): SceneStatics;  // throws when
// state.world.scene is null, or statics missing/mismatched (mirror builtOf)

// world/index.ts
export class UnknownWorldError extends Error { constructor(worldId: string) }

// http.ts
const CreateCampaignBody = z.union([
  z.object({ encounterId: z.string().min(1) }),
  z.object({ worldId: z.string().min(1) }),
]);
// CampaignRegistry.create(input: { encounterId: string } | { worldId: string })
const HERO_CHARACTER_ID = "hero";  // ADR-0002: one solo PC; a body field is YAGNI
```

- [ ] **Step 1: Write the failing campaign tests.** (a) `createCampaign` with `scene` writes a genesis whose payload carries the quartet derived from the statics (`authored.worldId`, `authored.startingNodeId`, `authored.startingDay`, `character.characterId` — read `AuthoredWorld`'s actual field names in `authored-world.ts` first and use those), and returns a campaign whose `state.world.scene` equals `sceneFromGenesis` of that payload and whose `sceneStatics` is set; (b) without `scene`, genesis and state are byte-identical to today (pin with an exact-payload assertion); (c) `sceneStaticsOf` throws on a combat-only campaign; (d) `loadCampaign` of a scene campaign's log rebuilds `state.world.scene` **and** `sceneStatics` (it re-runs `loadWorld`/`loadCharacter` from the genesis ids and verifies `authored.worldId` matches the payload's, throwing on mismatch — the same load-time coupling `buildEncounterById` already has, noted in its comment); (e) `loadCampaign` of a legacy log is unchanged.
- [ ] **Step 2: Write the failing http tests.** `POST /campaigns {worldId: "emberfall"}` → 201, and a `join` snapshot shows `scene.currentNodeId === "arrival"`, `encounter === null`; `POST {worldId: "atlantis"}` → 404; `POST {encounterId: "goblin-ambush"}` → unchanged 201-with-board (existing test still green).
- [ ] **Step 3: Run to verify failures, then implement.** `initialWorldState` computes `scene` via `sceneFromGenesis` (it needs the genesis payload — thread it through; `loadCampaign` already parses it). The world create path: `loadWorld()`, refuse `body.worldId !== authored.worldId` with `UnknownWorldError` → 404 (map it exactly where `UnknownEncounterError` is mapped), `loadCharacter(HERO_CHARACTER_ID)`, then `createCampaign({…, scene})` — **no `startEncounter` call**, and the comment on the old always-start-a-fight block is updated to say step 4 landed the gap it predicted.
- [ ] **Step 4: Run server tests; full suite; typecheck; lint.**
- [ ] **Step 5: Sabotage.** Make `loadCampaign` skip rebuilding `sceneStatics` — confirm (d) fails; restore.
- [ ] **Step 6: Commit.**

### Task 9: `free_text` — guards, classification, exploration

**Files:**
- Modify: `apps/server/src/core/pipeline.ts` (ports; the `free_text` case; a `sceneNarrate` sibling of `narrate`)
- Modify: `apps/server/src/main.ts` (wire `intent`, `sceneNarrative`, `skillAbilities`, intent metrics log line)
- Test: `apps/server/src/core/pipeline.test.ts`

**Interfaces:**
- Consumes: `IntentAgent`, `createIntentAgent`, `SceneNarrativePort`, `createDeterministicSceneNarrative`, `SCENE_PROMPT_VERSION` (agents); `sceneStateFrom`, `snapshotOf`, `diffScene`, `availableEdges`, `traverseEdge`, `completeCurrentNode` (rules-engine); `sceneStaticsOf` (campaign); `loadGear` (main.ts wiring only).
- Produces:

```ts
// TurnPorts gains:
intent: IntentAgent;
sceneNarrative: SceneNarrativePort;
/** Governing ability per skill, from SrdGear.skills. A port: the pipeline does no I/O. */
skillAbilities: ReadonlyMap<Skill, AbilityKey>;

// MetricsPort gains (optional, like recordSnapshotFailure):
recordIntentCall?(record: IntentCallMetrics): void;
export interface IntentCallMetrics {
  outcome: "ok" | string;          // AdapterError code on failure
  category?: string;               // present when outcome === "ok"
  latencyMs: number;
  promptTokens: number; completionTokens: number; totalTokens: number;
}
```

- [ ] **Step 1: Write the failing guard tests.** On a scene campaign with a mocked classifier: (a) a duplicate `clientMessageId` yields zero frames; (b) `free_text` during an open encounter → `free_text_not_supported` with the during-combat message, **no events appended**; (c) on a legacy combat-only campaign → `free_text_not_supported` unchanged (the existing test for today's behaviour keeps passing — only the message text may differ if you change it; keep the legacy branch's message as-is); (d) classifier adapter failure → `player_input` appended (the message WAS received), then an `internal_error` frame, no `intent_classified`, scene untouched.
- [ ] **Step 2: Write the failing exploration tests.** With the classifier mocked to return `{category: "exploration", targetNodeId: X}`: (e) an open edge emits, in order, `player_input` → `intent_classified` → `quest_node_completed(from)` → `world_delta_applied` (asserting the **post-clamp absolute band** and/or day from the fixture arithmetic) → `quest_node_entered(X)` → `narrative_token`s → `narrative_emitted` (source `deterministic` when the mocked scene port yields nothing — exercise the ladder), and `campaign.state.world.scene` equals `snapshotOf` of the engine's post-state **up to array order** (sort both sides the way Task 4's round-trip test does — `reduce` appends in event order while `snapshotOf` emits sorted, and that difference is fine); (f) a **closed** edge emits `player_input` → `intent_classified` → narration only — assert `world.scene` deep-equals its before value and no quest/delta event exists in the yielded frames; (g) `targetNodeId: null` on a terminal node runs `completeCurrentNode`: `quest_node_completed` + `world_delta_applied`, no `quest_node_entered`; (h) re-completing (g)'s node again is refused/no-op per the engine's idempotency — no second `world_delta_applied`.
- [ ] **Step 3: Run to verify failures, then implement.** The case follows the spec's §Decision 6 order exactly. `player_input` payload: `{clientMessageId, actorId: statics.character.characterId, text: command.text}`. One deadline struck at entry covers the classify call (via an `AbortController` wired like `enemyTurn`'s) and the narration. `intent_classified` payload uses `IntentClassifiedPayload` fields with `INTENT_PROMPT_VERSION` and the `provider`/`modelId` the agent result carries (Task 5 stamps them from `runtime.specFor("intent")`). `sceneNarrate` mirrors `narrate`: build `SceneNarrationInput` (current node card, location `nameHebrew` via `statics.authored`, NPC Hebrew names at that location, `recentNarrations`), call `narrationLadder` with `ports.sceneNarrative.stream` primary and `createDeterministicSceneNarrative().stream` fallback, then metrics + `narrative_emitted` + window update. The category switch has **no default**; `social`/`check`/`combat`/`ooc` throw a plain `Error("unreachable until Task 10")` for now — they are replaced in Task 10 (the switch still names every member explicitly so exhaustiveness holds).
- [ ] **Step 4: Wire `main.ts`.** Intent agent on its own `createAgentRuntime` (mirroring the tactical/narrative split's reasoning), scene narrative on the narrative runtime, `skillAbilities` built once from `loadGear().skills` (`new Map(Array.from(gear.skills, ([skill, def]) => [skill, def.ability]))` — read `SkillDefinition`'s field name first), `recordIntentCall` logging an `intent_call_metrics` line like its siblings.
- [ ] **Step 5: Run server tests; full suite; typecheck; lint.**
- [ ] **Step 6: Sabotage.** Invert the closed-edge refusal (commit the transition anyway) — confirm (f) and nothing else fails; restore.
- [ ] **Step 7: Commit.**

### Task 10: `free_text` — checks and narrate-only categories; replay equivalence

**Files:**
- Modify: `apps/server/src/core/pipeline.ts` (the four remaining categories)
- Test: `apps/server/src/core/pipeline.test.ts`, `apps/server/src/core/replay.test.ts`

**Interfaces:**
- Consumes: `abilityCheck`, `seeded`, `DC_BY_DIFFICULTY` (rules-engine); `CheckRolledPayload` (schemas); Task 9's `sceneNarrate` and ports.

- [ ] **Step 1: Write the failing check tests.** Classifier mocked to `{category: "check", ability: "str", skill: "athletics", difficulty: "medium"}`: (a) emits `player_input` → `intent_classified` → `check_rolled` → narration; the payload's `dc` is 15, its `seed` is `seedFor(rootSeed, sequence-of-check_rolled)`, and its `modifier` equals the hero's derived `skills.athletics` — compute the expected roll by calling `abilityCheck` in the test with the same seeded rng and assert `naturalRoll`/`total`/`success` match exactly (determinism is the assertion); (b) a skill-less check uses `abilityModifiers[ability]`; (c) when a skill is named, the payload's `ability` is the SRD mapping's (`skillAbilities`), even if the mocked classifier proposed a mismatched one; (d) scene state is unchanged by any check.
- [ ] **Step 2: Write the failing narrate-only tests.** For `social`, `ooc`, `combat`: `player_input` + `intent_classified` + narration frames and **nothing else**; the `combat` beat reaches the scene port with `{kind: "reply", category: "combat"}`.
- [ ] **Step 3: Run to verify failures, then implement.** Check resolution per the spec: `modifier` from `character.skills[skill] ?? character.abilityModifiers[ability]` (skill named) else `abilityModifiers[ability]`; call `abilityCheck({ abilityScore: 10, situationalBonus: modifier, dc }, seeded(seed))` with a comment stating why: *the derived sheet already folded ability + proficiency into one modifier; abilityScore 10 contributes +0, so situationalBonus IS the modifier.*
- [ ] **Step 4: Write the failing replay-equivalence test** (in `replay.test.ts`, following its existing pattern): drive a scene campaign through traverse → refused traverse → check → social over the socket-less pipeline with mocked agents, then `loadCampaign` the same store and assert the reloaded `state` deep-equals the live `campaign.state` and `nextSequence` matches. This is the plan's named backstop — it must include the refusal.
- [ ] **Step 5: Run server tests; full suite with and without `DATABASE_URL` (scratch DB, never `aidm`); typecheck; lint.**
- [ ] **Step 6: Commit.**

### Task 11: The web slice

**Files:**
- Create: `apps/web/src/components/FreeTextBar.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/net/api.ts`, `apps/web/src/i18n.ts`
- Test: `apps/web/src/components/FreeTextBar.test.tsx`, `apps/web/src/App.test.tsx`, `apps/web/src/state/store.test.ts`

**Interfaces:**
- Consumes: `SceneSnapshot` via the folded `CampaignState` (schemas), the existing `connection.send`, `NarrativePane`, `applyFrame`.
- Produces:

```tsx
// FreeTextBar.tsx
export interface FreeTextBarProps {
  disabled: boolean;
  onSend: (text: string) => void;   // App builds the free_text ClientMessage
}
export function FreeTextBar(props: FreeTextBarProps): JSX.Element;
// RTL input (dir="rtl"), maxLength = MAX_FREE_TEXT_LENGTH, submit on Enter,
// Hebrew placeholder + send label from i18n's `he`.

// net/api.ts
export function createCampaign(body: { encounterId: string } | { worldId: string }): Promise<CampaignCreated>;
// App.tsx: new URLSearchParams(window.location.search).get("world") — when
// present, create with { worldId }, skip the encounter-catalogue fetch, and
// render the scene view.
```

- [ ] **Step 1: Write the failing store/fold tests.** `applyFrame` of `quest_node_entered` / `quest_node_completed` / `world_delta_applied` event frames updates `snapshot.world.scene` (the shared `reduce` does the work — the test proves the client actually reaches it); `check_rolled` and `intent_classified` frames change nothing and throw nothing.
- [ ] **Step 2: Write the failing component tests.** `FreeTextBar`: renders RTL, respects `disabled`, calls `onSend` with the trimmed text on Enter and clears itself, refuses empty submits. `App` (mock socket, the file's existing pattern): with a snapshot where `encounter === null` and `scene !== null` — renders `NarrativePane` + `FreeTextBar` and does **not** render `Grid`/`ActionBar` (this is the assertion that keeps the silent `not_your_turn` trap unreachable — say so in the test name); sending disables the bar; a folded `narrative_emitted` re-enables it; an `error` frame re-enables it and shows the banner (`free_text_not_supported` is not in `SILENT_CODES` — no change needed there, assert it stays visible).
- [ ] **Step 3: Run to verify failures, then implement.** App state: a `pendingFreeTextId: string | null` — set on send (`clientMessageId: crypto.randomUUID()`), cleared when a `narrative_emitted` event frame or a matching `error`/`rejected` frame folds. World mode: `?world=emberfall` → `createCampaign({worldId})`, catalogue stays null and the scene view must render without it (adjust the "not ready" placeholder condition to require a catalogue only when an encounter is open). Streaming `narrative_token` frames already render through the existing pane path — verify, don't rebuild.
- [ ] **Step 4: Run web tests; full suite; typecheck; lint.**
- [ ] **Step 5: Manually smoke it.** `pnpm dev` (with `PORT=3000` — the `.env` says 3001 but the Vite proxy expects 3000), open the app with `?world=emberfall`, type a sentence, watch the round trip (a real provider key is required for the model tiers; without one, the deterministic rungs answering is the expected and acceptable demonstration). Screenshot for the PR.
- [ ] **Step 6: Commit.**

### Task 12: Docs, whole-branch verification, PR ready

**Files:**
- Modify: `PROJECT_PLAN.md` (§4.7 sequence entry 4: link spec + plan, mark built pending merge)
- Verify: the whole branch

- [ ] **Step 1: Update `PROJECT_PLAN.md` §4.7 entry 4** in the style of entries 1–3: spec and plan links; leave the "Merged" line for the merge-status commit that follows the PR, as step 3 did.
- [ ] **Step 2: Stale-claim sweep (by shape, not wording).** The claims this branch invalidates: `pipeline.ts`'s and `protocol.ts`'s "free_text is not handled/not implemented" comments; `campaign.ts`/`http.ts` comments saying campaign creation always bundles a fight and "§4.7's step 4 is what separates them"; `reduce.ts`'s header saying step 4 *will* make the `encounter_started` gap reachable (it now IS reachable for combat campaigns joined before their fight — re-read that comment against the new reality and update only if it now lies; scene campaigns have no bracket, and this plan does not fix the bracket gap — step 5 owns it, say so rather than silently narrowing); `intent/index.ts`'s stub comment. Grep each shape, fix what lies, leave what still holds.
- [ ] **Step 3: Full verification, recorded.** `corepack enable`; `pnpm test` (expect ≥ baseline + the new tests; record exact counts); `DATABASE_URL=postgres://localhost:5432/<scratch> pnpm test` (create the scratch DB first; **never** point at `aidm`; expect 0 skipped); `pnpm typecheck`; `npx eslint packages apps tools`; `pnpm --filter @ai-dm/rules-engine test:coverage` ≥90%.
- [ ] **Step 4: Sabotage audit.** Confirm each task's sabotage step was actually run (Tasks 3, 8, 9) — if any was skipped, run it now.
- [ ] **Step 5: Request review.** Use superpowers:requesting-code-review for a whole-branch review against the spec; fix what it finds.
- [ ] **Step 6: Mark the PR ready** (`gh pr ready`), update its description with the verification numbers and the Task 11 screenshot, and hand off per superpowers:finishing-a-development-branch.
