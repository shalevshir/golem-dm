# Episodic Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the narrator a memory: scene summaries written into the event
log at episode boundaries, indexed into pgvector, retrieved on scene entry,
and delivered to the scene narration prompt alongside step 6's authored NPC
facts.

**Architecture:** `@ai-dm/memory` gains an `EpisodicStore` that takes
**vectors, never text** — two implementations (in-memory, Postgres/pgvector)
held to one conformance suite, exactly like `EventStore`. `@ai-dm/agents`
gains a separate `EmbeddingPort` and a fourth tier (`summary`) with a
deterministic fallback. `apps/server` composes them: summarize at the two
events that close an episode, embed, write, retrieve on node transitions,
render one English memory block into `SceneNarrationInput`. No new dependency
edge in any direction.

**Tech Stack:** TypeScript strict, ESM, Node 22, vitest, zod, drizzle-orm
0.39.3 (`vector` column), `ai` 4.3.19 (`embedMany`), `@ai-sdk/openai` 1.3.24
(`text-embedding-3-small`), Postgres 17 + pgvector.

**Spec:** [`docs/superpowers/specs/2026-08-30-episodic-memory-design.md`](../specs/2026-08-30-episodic-memory-design.md)

## Global Constraints

- **Base commit:** `2a71326` (current `main` tip). Branch:
  `claude/step-7-episodic-memory-2d8dc4`.
- **`corepack enable` before any pnpm command** — pnpm is not on PATH.
- **This worktree has no `node_modules`.** Run `pnpm install` once before the
  first test run.
- **Baseline that must not regress:** 1596 passed / 30 skipped / 104 files
  without a database. With Postgres: 1626 passed / **0 skipped**. `pnpm
  typecheck` and `npx eslint packages apps tools` both exit 0.
- **Never point tests at the plain `aidm` database.** Use a scratch DB.
  `aidm_step5_scratch` exists but has **no pgvector** — see Task 4 for the
  one-time local setup.
- **Never run `pnpm format`** — there is no `.prettierignore`, so
  `--write .` rewrites ~37 files including the lockfile.
- **Scope eslint runs:** `npx eslint packages apps tools` from this
  worktree. A bare `eslint .` walks sibling worktrees and fails on their code.
- **Do not touch `packages/memory/CLAUDE.md`** — it carries someone else's
  uncommitted edit in the main checkout. Its clause "No LLM calls except
  embedding generation for episodic writes" becomes false with Task 1 and
  should be corrected to "No LLM calls" in a **separate follow-up PR**, not
  here.
- **Invariant 2 — English inside, Hebrew outside.** `summaryEnglish` is
  English. The only Hebrew payload fields remain `narrative_emitted.text` and
  `player_input.text`. Do not add a third.
- **Invariant 5 — dependency direction.** `@ai-dm/memory` may import only
  `@ai-dm/schemas` (plus drizzle and `postgres`). It may **not** import
  `@ai-dm/agents`, and must not use `ai`'s `cosineSimilarity`.
- **Invariant 4 — schemas define types once.** Shared constants and record
  shapes go in `@ai-dm/schemas`; never hand-duplicate a type across packages.
- **ESLint `strictTypeChecked` gotchas:** `[...str]` is banned — use
  `Array.from(str, fn)`. No `argsIgnorePattern` is configured, so
  `_`-prefixed unused params still error; stubs will not lint until
  implemented. Type lookups as `Record<string, T | undefined>` rather than
  casting `x as keyof typeof obj`.
- **Tests colocated** as `*.test.ts`. New packages/dirs need `vitest run
  --passWithNoTests` until they have a test file.
- **Prompt text is versioned and hash-pinned.** Any edit to a
  `*-prompt-text.ts` surface must bump its version constant, or the SHA-256
  pin test fails CI.

## File Structure

**`packages/schemas/src/`**
- Modify `episodic.ts` *(new)* — `EMBEDDING_DIMENSIONS`, `EpisodicMemory`.
- Modify `events.ts:104-121, 299` — `summaryEnglish` on the two closing payloads.
- Modify `index.ts` — export the new module.

**`packages/agents/src/`**
- Create `providers/embedding-port.ts` — `EmbeddingSpec`, `EmbeddingOutput`, `EmbeddingPort`.
- Create `providers/vercel-embedding.ts` — `createVercelEmbeddingPort`.
- Create `providers/testing/fake-embedding-port.ts` — deterministic vectors, no network.
- Modify `providers/routing.ts` — `AgentRole` gains `"summary"`; `DEFAULT_MODEL_ROUTING.summary`; `DEFAULT_EMBEDDING_SPEC`.
- Create `summary/port.ts`, `summary/prompt-text.ts`, `summary/index.ts`, `summary/deterministic.ts`.
- Modify `narrative/scene-port.ts` — `SceneNarrationInput.memoryEnglish`.
- Modify `narrative/scene.ts` — render the memory block into `semiStatic`.
- Modify `providers/index.ts`, `src/index.ts` — exports.

**`packages/memory/src/`**
- Create `episodic/port.ts`, `episodic/in-memory.ts`, `episodic/postgres.ts`, `episodic/contract.ts`.
- Modify `schema.ts` — `episodicMemories` table.
- Delete-and-replace `episodic.ts` (currently `export {}`) → re-export barrel.
- Modify `index.ts` — exports.
- Create `drizzle/0001_*.sql` + meta — generated, with one hand-added extension line.

**`apps/server/src/`**
- Modify `core/campaign.ts` — `Campaign.recentMemories`, its projection.
- Modify `core/pipeline.ts` — `TurnPorts.embedding`/`.episodic`/`.summary`, `MetricsPort` methods, summarize/index/retrieve call sites, memory-block assembly.
- Modify `main.ts` — wire the three new ports.

---

### Task 1: `@ai-dm/schemas` — the shared constant, the record, and the two payload fields

**Files:**
- Create: `packages/schemas/src/episodic.ts`
- Create: `packages/schemas/src/episodic.test.ts`
- Modify: `packages/schemas/src/events.ts` (`EncounterResolvedPayload` ~104-121, `QuestNodeCompletedPayload` ~299)
- Modify: `packages/schemas/src/index.ts`
- Test: `packages/schemas/src/episodic.test.ts`, `packages/schemas/src/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EMBEDDING_DIMENSIONS: 1536`; `EpisodicMemory` (zod object + inferred type) with fields `campaignId: string`, `sequence: number`, `kind: "encounter" | "quest_node"`, `refId: string`, `summaryEnglish: string`, `day: number`; `EncounterResolvedPayload.summaryEnglish?: string`; `QuestNodeCompletedPayload.summaryEnglish?: string`.

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/episodic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS, EpisodicMemory } from "./episodic.js";

describe("EMBEDDING_DIMENSIONS", () => {
  it("is the width text-embedding-3-small returns and the pgvector column declares", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1536);
  });
});

describe("EpisodicMemory", () => {
  const valid = {
    campaignId: "c1",
    sequence: 12,
    kind: "encounter" as const,
    refId: "goblin-ambush",
    summaryEnglish: "The party drove off the goblins at the weir.",
    day: 3,
  };

  it("accepts a well-formed record", () => {
    expect(EpisodicMemory.parse(valid)).toEqual(valid);
  });

  it("accepts the quest_node kind", () => {
    expect(EpisodicMemory.parse({ ...valid, kind: "quest_node" }).kind).toBe("quest_node");
  });

  it("rejects an unknown kind", () => {
    expect(EpisodicMemory.safeParse({ ...valid, kind: "conversation" }).success).toBe(false);
  });

  it("rejects an empty summary — a memory with no text is not retrievable", () => {
    expect(EpisodicMemory.safeParse({ ...valid, summaryEnglish: "" }).success).toBe(false);
  });

  it("rejects a negative sequence", () => {
    expect(EpisodicMemory.safeParse({ ...valid, sequence: -1 }).success).toBe(false);
  });
});
```

Append to `packages/schemas/src/events.test.ts`:

```ts
describe("summaryEnglish on the closing payloads", () => {
  it("accepts an encounter_resolved payload carrying a summary", () => {
    const parsed = EncounterResolvedPayload.parse({
      encounterId: "e1",
      outcome: "victory",
      survivorIds: ["pc1"],
      summaryEnglish: "The party won.",
    });
    expect(parsed.summaryEnglish).toBe("The party won.");
  });

  it("still accepts an encounter_resolved payload written before summaries existed", () => {
    const parsed = EncounterResolvedPayload.parse({
      encounterId: "e1",
      outcome: "victory",
      survivorIds: ["pc1"],
    });
    expect(parsed.summaryEnglish).toBeUndefined();
  });

  it("accepts a quest_node_completed payload with and without a summary", () => {
    expect(QuestNodeCompletedPayload.parse({ nodeId: "n1" }).summaryEnglish).toBeUndefined();
    expect(
      QuestNodeCompletedPayload.parse({ nodeId: "n1", summaryEnglish: "Tobin talked." })
        .summaryEnglish,
    ).toBe("Tobin talked.");
  });

  it("rejects an empty summary rather than storing a blank memory", () => {
    expect(
      QuestNodeCompletedPayload.safeParse({ nodeId: "n1", summaryEnglish: "" }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
corepack enable && pnpm install
```

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: FAIL — `Cannot find module './episodic.js'`, and the
`summaryEnglish` assertions fail because the field is stripped by zod.

- [ ] **Step 3: Write the implementation**

Create `packages/schemas/src/episodic.ts`:

```ts
// Episodic memory's shared surface. The dimension constant lives here rather
// than in either consumer because both need the same integer and this is
// their only common ancestor (invariant 5): `@ai-dm/agents` asks the model
// for vectors of this width, and `@ai-dm/memory` declares a fixed-width
// `vector(N)` column. A disagreement surfaces as an insert failure on a
// column width, which is the worst place to find it.
import { z } from "zod";

/**
 * `text-embedding-3-small`'s native width. Changing this is a migration plus
 * a full reindex — the index is rebuildable from the log by design, so that
 * is cheap, but it is not a no-op.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * One closed episode, as stored. The text is a projection of the log — the
 * `summaryEnglish` a closing event already carried — so this record holds no
 * fact the log does not, which is what keeps the vector table a rebuildable
 * index rather than a second source of truth (invariant 3).
 */
export const EpisodicMemory = z.object({
  campaignId: z.string(),
  /** The log sequence of the event whose payload carried this summary. */
  sequence: z.number().int().min(0),
  kind: z.enum(["encounter", "quest_node"]),
  /** The `encounterId` or `nodeId` the episode closed on. */
  refId: z.string(),
  /** English — internal game state, never shown to a player verbatim. */
  summaryEnglish: z.string().min(1),
  day: z.number().int().min(1),
});

export type EpisodicMemory = z.infer<typeof EpisodicMemory>;
```

In `packages/schemas/src/events.ts`, add to `EncounterResolvedPayload`'s
object (after `survivorIds`):

```ts
  /**
   * What happened, in English, for episodic retrieval to index. Optional
   * because this payload is persisted forever and a log written before
   * summaries existed must still load — the same tolerance `campaign.ts`
   * applies when projecting `recentNarrations`.
   *
   * Not folded: `reduce` ignores it and `CampaignState` gains no field. It
   * is a fact recorded for the indexer, not campaign state.
   */
  summaryEnglish: z.string().min(1).optional(),
```

Replace `QuestNodeCompletedPayload` (line ~299) with:

```ts
export const QuestNodeCompletedPayload = z.object({
  nodeId: ContentId,
  /** Same contract as `EncounterResolvedPayload.summaryEnglish`. */
  summaryEnglish: z.string().min(1).optional(),
});
```

Add to `packages/schemas/src/index.ts`, in the existing export block:

```ts
export * from "./episodic.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test
```

Expected: PASS.

- [ ] **Step 5: Confirm the fold is genuinely untouched**

```bash
corepack enable && pnpm --filter @ai-dm/schemas test -- reduce
```

Expected: PASS with no changes to `reduce.test.ts`. If a reduce test needed
editing, the payload change leaked into state — revert and re-read Decision 5.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/episodic.ts packages/schemas/src/episodic.test.ts packages/schemas/src/events.ts packages/schemas/src/events.test.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): episodic memory record, dimension constant, and summary payload fields"
```

---

### Task 2: `@ai-dm/agents` — `EmbeddingPort`, its adapter, and a deterministic fake

**Files:**
- Create: `packages/agents/src/providers/embedding-port.ts`
- Create: `packages/agents/src/providers/vercel-embedding.ts`
- Create: `packages/agents/src/providers/vercel-embedding.test.ts`
- Create: `packages/agents/src/providers/testing/fake-embedding-port.ts`
- Create: `packages/agents/src/providers/testing/fake-embedding-port.test.ts`
- Modify: `packages/agents/src/providers/routing.ts`
- Modify: `packages/agents/src/providers/index.ts`
- Test: the two `.test.ts` files above

**Interfaces:**
- Consumes: `EMBEDDING_DIMENSIONS` from `@ai-dm/schemas` (Task 1); existing `ProviderId`, `TokenUsage`, `AdapterResult`, `adapterSuccess`, `adapterFailure` from this package.
- Produces:
  - `EmbeddingSpec { provider: ProviderId; modelId: string; dimensions: number }`
  - `EmbeddingOutput { vectors: number[][]; usage: TokenUsage }`
  - `EmbeddingPort { embed(spec: EmbeddingSpec, texts: readonly string[]): Promise<AdapterResult<EmbeddingOutput>> }`
  - `DEFAULT_EMBEDDING_SPEC: EmbeddingSpec`
  - `createVercelEmbeddingPort(options: { apiKey?: string }): EmbeddingPort`
  - `createFakeEmbeddingPort(): EmbeddingPort & { calls: { spec: EmbeddingSpec; texts: readonly string[] }[] }`

- [ ] **Step 1: Write the failing test for the fake port**

Create `packages/agents/src/providers/testing/fake-embedding-port.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import { createFakeEmbeddingPort } from "./fake-embedding-port.js";
import { DEFAULT_EMBEDDING_SPEC } from "../routing.js";

describe("createFakeEmbeddingPort", () => {
  it("returns one unit vector of the declared width per input text", async () => {
    const port = createFakeEmbeddingPort();
    const result = await port.embed(DEFAULT_EMBEDDING_SPEC, ["a", "b"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectors).toHaveLength(2);
    expect(result.value.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);

    const norm = Math.hypot(...(result.value.vectors[0] ?? []));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("is deterministic — the same text always embeds to the same vector", async () => {
    const port = createFakeEmbeddingPort();
    const first = await port.embed(DEFAULT_EMBEDDING_SPEC, ["the weir at dusk"]);
    const second = await port.embed(DEFAULT_EMBEDDING_SPEC, ["the weir at dusk"]);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.vectors[0]).toEqual(second.value.vectors[0]);
  });

  it("separates unlike texts — a text is nearer itself than a different one", async () => {
    const port = createFakeEmbeddingPort();
    const result = await port.embed(DEFAULT_EMBEDDING_SPEC, ["goblins at the weir", "a quiet inn"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [a, b] = result.value.vectors;
    const dot = (x: readonly number[], y: readonly number[]): number =>
      x.reduce((sum, each, i) => sum + each * (y[i] ?? 0), 0);

    expect(dot(a ?? [], a ?? [])).toBeGreaterThan(dot(a ?? [], b ?? []));
  });

  it("reports usage with no completion tokens", async () => {
    const port = createFakeEmbeddingPort();
    const result = await port.embed(DEFAULT_EMBEDDING_SPEC, ["abc"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usage.completionTokens).toBe(0);
    expect(result.value.usage.totalTokens).toBe(result.value.usage.promptTokens);
  });

  it("records every call for assertion", async () => {
    const port = createFakeEmbeddingPort();
    await port.embed(DEFAULT_EMBEDDING_SPEC, ["x"]);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.texts).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/agents test -- fake-embedding-port
```

Expected: FAIL — `Cannot find module './fake-embedding-port.js'`.

- [ ] **Step 3: Write the port interface and the routing constant**

Create `packages/agents/src/providers/embedding-port.ts`:

```ts
// The embedding boundary. Deliberately NOT a fourth method on
// `LanguageModelPort`: that port's three methods all take prompt-shaped
// requests (a `LayeredPrompt`, a tool name, a tool description), two of
// `AdapterErrorCode`'s four values cannot occur for an embedding, and
// `StreamChunk` has no embedding-shaped case. Adding a method there would
// break both implementers for no shared behaviour.
//
// `@ai-dm/memory` never sees this type. The store takes vectors; the
// composition root (`apps/server`) embeds and then writes, which is what
// keeps memory's dependency list at `@ai-dm/schemas` alone (invariant 5).
import type { ProviderId } from "./routing.js";
import type { TokenUsage } from "./usage.js";
import type { AdapterResult } from "./errors.js";

export interface EmbeddingSpec {
  provider: ProviderId;
  modelId: string;
  /**
   * Must equal `EMBEDDING_DIMENSIONS`. The pgvector column is fixed-width, so
   * a mismatch is an insert failure rather than a degraded result.
   */
  dimensions: number;
}

export interface EmbeddingOutput {
  /** One vector per input text, in input order. */
  vectors: number[][];
  /**
   * The AI SDK reports `EmbeddingModelUsage` as `{ tokens }` — a single
   * count. It maps onto the shared `TokenUsage` as prompt-only:
   * `completionTokens: 0` is truthful, not a placeholder, because an
   * embedding call bills input alone.
   */
  usage: TokenUsage;
}

export interface EmbeddingPort {
  embed(spec: EmbeddingSpec, texts: readonly string[]): Promise<AdapterResult<EmbeddingOutput>>;
}
```

In `packages/agents/src/providers/routing.ts`, append (leaving `AgentRole`
and `DEFAULT_MODEL_ROUTING` alone for now — Task 5 adds the `summary` role):

```ts
/**
 * Embedding model selection, deliberately its own constant rather than a
 * fourth `AgentRole`. A `ModelSpec` carries `temperature`,
 * `maxOutputTokens` and `reasoningEffort`, all meaningless for an embedding
 * call, and `resolveModelSpec` would start returning specs `EmbeddingPort`
 * cannot accept.
 *
 * `openai` because it is already a wired `ProviderId` — no adapter-layer
 * provider work is needed.
 */
export const DEFAULT_EMBEDDING_SPEC: EmbeddingSpec = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  dimensions: EMBEDDING_DIMENSIONS,
};
```

with these imports added at the top of `routing.ts`:

```ts
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import type { EmbeddingSpec } from "./embedding-port.js";
```

Create `packages/agents/src/providers/testing/fake-embedding-port.ts`:

```ts
// A deterministic stand-in for the embedding adapter: no network, no API
// key, no SDK. Vectors come from a cheap string hash spread over the
// declared width and then normalized, so cosine similarity between two
// fakes is meaningful enough for a conformance suite to assert ordering on,
// and identical text always produces an identical vector.
//
// This is a test double, not a fallback. Nothing in production may use it —
// an unembeddable summary is simply not indexed (see the pipeline's
// `indexEpisode`), never indexed with fake coordinates.
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import { adapterSuccess } from "../errors.js";
import type { AdapterResult } from "../errors.js";
import type { EmbeddingOutput, EmbeddingPort, EmbeddingSpec } from "../embedding-port.js";

export interface FakeEmbeddingCall {
  spec: EmbeddingSpec;
  texts: readonly string[];
}

export interface FakeEmbeddingPort extends EmbeddingPort {
  readonly calls: FakeEmbeddingCall[];
}

/** FNV-1a, seeded per dimension. Cheap, stable, and good enough to separate. */
function hashAt(text: string, dimension: number): number {
  let hash = 0x811c9dc5 ^ dimension;
  for (const code of Array.from(text, (char) => char.codePointAt(0) ?? 0)) {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Map to [-1, 1) so vectors point in varied directions rather than one octant.
  return (hash / 0x80000000) - 1;
}

function embedOne(text: string, dimensions: number): number[] {
  const raw = Array.from({ length: dimensions }, (_unused, index) => hashAt(text, index));
  const norm = Math.hypot(...raw);
  // A zero vector cannot be normalized; no non-empty text produces one, but
  // dividing by zero would poison the whole suite silently if one did.
  return norm === 0 ? raw : raw.map((each) => each / norm);
}

export function createFakeEmbeddingPort(): FakeEmbeddingPort {
  const calls: FakeEmbeddingCall[] = [];

  return {
    calls,
    embed(spec: EmbeddingSpec, texts: readonly string[]): Promise<AdapterResult<EmbeddingOutput>> {
      calls.push({ spec, texts });
      const dimensions = spec.dimensions === 0 ? EMBEDDING_DIMENSIONS : spec.dimensions;
      const tokens = texts.reduce((sum, text) => sum + text.length, 0);
      return Promise.resolve(
        adapterSuccess({
          vectors: texts.map((text) => embedOne(text, dimensions)),
          usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens },
        }),
      );
    },
  };
}
```

- [ ] **Step 4: Run the fake-port tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/agents test -- fake-embedding-port
```

Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing test for the real adapter**

Create `packages/agents/src/providers/vercel-embedding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createVercelEmbeddingPort } from "./vercel-embedding.js";
import { DEFAULT_EMBEDDING_SPEC } from "./routing.js";

describe("createVercelEmbeddingPort", () => {
  it("fails with provider_error rather than throwing when the provider rejects", async () => {
    // No API key and an unroutable model id: the call must surface as a
    // typed failure, because the caller's contract is "skip indexing", not
    // "crash the turn".
    const port = createVercelEmbeddingPort({ apiKey: "sk-not-a-real-key" });
    const result = await port.embed(
      { ...DEFAULT_EMBEDDING_SPEC, modelId: "definitely-not-a-model" },
      ["anything"],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["provider_error", "aborted"]).toContain(result.error.code);
  });

  it("returns a failure, not an empty success, for an empty input list", async () => {
    const port = createVercelEmbeddingPort({ apiKey: "sk-not-a-real-key" });
    const result = await port.embed(DEFAULT_EMBEDDING_SPEC, []);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/agents test -- vercel-embedding
```

Expected: FAIL — `Cannot find module './vercel-embedding.js'`.

- [ ] **Step 7: Write the adapter**

Create `packages/agents/src/providers/vercel-embedding.ts`:

```ts
// The one place the AI SDK's embedding surface is touched, mirroring
// `vercel.ts`'s role for the chat surface. Kept in its own file rather than
// added to `vercel.ts` because it shares no request shaping with it — no
// `LayeredPrompt`, no tool schema, no streaming.
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { adapterFailure, adapterSuccess } from "./errors.js";
import type { AdapterResult } from "./errors.js";
import type { EmbeddingOutput, EmbeddingPort, EmbeddingSpec } from "./embedding-port.js";

export interface VercelEmbeddingOptions {
  /** Falls back to the provider SDK's own env lookup when absent. */
  apiKey?: string;
}

export function createVercelEmbeddingPort(options: VercelEmbeddingOptions = {}): EmbeddingPort {
  const openai = createOpenAI(options.apiKey === undefined ? {} : { apiKey: options.apiKey });

  return {
    async embed(
      spec: EmbeddingSpec,
      texts: readonly string[],
    ): Promise<AdapterResult<EmbeddingOutput>> {
      // `embedMany` with no values is a provider round trip that cannot
      // succeed usefully; refuse it here so callers get one failure shape.
      if (texts.length === 0) {
        return adapterFailure({ code: "provider_error", message: "No texts to embed" });
      }
      // Only openai is wired for embeddings today. A different provider is a
      // deliberate change here, not a silent fallthrough to the wrong model.
      if (spec.provider !== "openai") {
        return adapterFailure({
          code: "provider_error",
          message: `No embedding adapter for provider ${spec.provider}`,
        });
      }

      try {
        const result = await embedMany({
          model: openai.textEmbeddingModel(spec.modelId, { dimensions: spec.dimensions }),
          values: [...texts],
        });

        // The width the column expects is not negotiable — a provider that
        // honours `dimensions` differently must fail here, not at INSERT.
        const wrong = result.embeddings.find((vector) => vector.length !== spec.dimensions);
        if (wrong !== undefined) {
          return adapterFailure({
            code: "provider_error",
            message: `Expected ${String(spec.dimensions)}-dimension vectors, got ${String(wrong.length)}`,
          });
        }

        return adapterSuccess({
          vectors: result.embeddings.map((vector) => [...vector]),
          usage: {
            promptTokens: result.usage.tokens,
            completionTokens: 0,
            totalTokens: result.usage.tokens,
          },
        });
      } catch (cause) {
        return adapterFailure({
          code: "provider_error",
          message: cause instanceof Error ? cause.message : "Embedding call failed",
        });
      }
    },
  };
}
```

If `adapterFailure`'s signature in `errors.ts` differs from
`{ code, message }`, match the existing signature — read `errors.ts:21-52`
and adapt; do not change `errors.ts`.

- [ ] **Step 8: Export the new surface**

Add to `packages/agents/src/providers/index.ts`:

```ts
export * from "./embedding-port.js";
export * from "./vercel-embedding.js";
```

Do **not** export `testing/fake-embedding-port.js` from the package barrel —
follow whatever `testing/fake-port.ts` already does (check
`providers/index.ts`; test doubles are imported by path in this repo).

- [ ] **Step 9: Run the full agents suite**

```bash
corepack enable && pnpm --filter @ai-dm/agents test && pnpm --filter @ai-dm/agents typecheck
```

Expected: PASS, and typecheck exits 0.

- [ ] **Step 10: Commit**

```bash
git add packages/agents/src/providers/embedding-port.ts packages/agents/src/providers/vercel-embedding.ts packages/agents/src/providers/vercel-embedding.test.ts packages/agents/src/providers/testing/fake-embedding-port.ts packages/agents/src/providers/testing/fake-embedding-port.test.ts packages/agents/src/providers/routing.ts packages/agents/src/providers/index.ts
git commit -m "feat(agents): EmbeddingPort, its openai adapter, and a deterministic fake"
```

---

### Task 3: `@ai-dm/memory` — `EpisodicStore`, the in-memory implementation, and the conformance suite

**Files:**
- Create: `packages/memory/src/episodic/port.ts`
- Create: `packages/memory/src/episodic/in-memory.ts`
- Create: `packages/memory/src/episodic/contract.ts`
- Create: `packages/memory/src/episodic/in-memory.test.ts`
- Modify: `packages/memory/src/episodic.ts` (currently `export {}`)
- Modify: `packages/memory/src/index.ts`
- Test: `packages/memory/src/episodic/in-memory.test.ts`

**Interfaces:**
- Consumes: `EpisodicMemory`, `EMBEDDING_DIMENSIONS` from `@ai-dm/schemas` (Task 1).
- Produces:
  - `EpisodicHit { memory: EpisodicMemory; score: number }`
  - `EpisodicStore { write(record, embedding): Promise<void>; search(campaignId, queryEmbedding, limit): Promise<EpisodicHit[]> }`
  - `EpisodicStoreUnavailableError`
  - `createInMemoryEpisodicStore(): EpisodicStore`
  - `runEpisodicStoreContract(name: string, makeStore: () => Promise<EpisodicStore> | EpisodicStore): void`

- [ ] **Step 1: Write the conformance suite (this IS the failing test)**

Create `packages/memory/src/episodic/contract.ts`:

```ts
// The shared contract both episodic stores answer to, mirroring
// `event-store/contract.ts`. A behaviour only one implementation has is a
// bug in this file, not a feature of that implementation.
//
// Every vector here is hand-built and unit-length so the expected cosine
// ordering is arithmetic a reader can check, not a property of an embedding
// model.
import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import type { EpisodicMemory } from "@ai-dm/schemas";
import type { EpisodicStore } from "./port.js";

/** A unit vector pointing along one axis — trivially orthogonal to the others. */
export function axisVector(axis: number): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  vector[axis] = 1;
  return vector;
}

function memory(overrides: Partial<EpisodicMemory> = {}): EpisodicMemory {
  return {
    campaignId: "c1",
    sequence: 1,
    kind: "quest_node",
    refId: "weir",
    summaryEnglish: "Tobin let the party pass.",
    day: 1,
    ...overrides,
  };
}

export function runEpisodicStoreContract(
  name: string,
  makeStore: () => Promise<EpisodicStore> | EpisodicStore,
): void {
  describe(`EpisodicStore contract: ${name}`, () => {
    it("returns nothing for a campaign with no memories", async () => {
      const store = await makeStore();
      expect(await store.search("c1", axisVector(0), 3)).toEqual([]);
    });

    it("returns a written memory whose text survives the round trip", async () => {
      const store = await makeStore();
      await store.write(memory(), axisVector(0));

      const hits = await store.search("c1", axisVector(0), 3);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.memory).toEqual(memory());
    });

    it("orders hits by similarity, nearest first", async () => {
      const store = await makeStore();
      await store.write(memory({ sequence: 1, refId: "near" }), axisVector(0));
      await store.write(memory({ sequence: 2, refId: "far" }), axisVector(1));

      const hits = await store.search("c1", axisVector(0), 3);
      expect(hits.map((hit) => hit.memory.refId)).toEqual(["near", "far"]);
    });

    it("honours the limit", async () => {
      const store = await makeStore();
      await store.write(memory({ sequence: 1 }), axisVector(0));
      await store.write(memory({ sequence: 2 }), axisVector(1));
      await store.write(memory({ sequence: 3 }), axisVector(2));

      expect(await store.search("c1", axisVector(0), 2)).toHaveLength(2);
    });

    it("never leaks another campaign's memories", async () => {
      const store = await makeStore();
      await store.write(memory({ campaignId: "c1", refId: "mine" }), axisVector(0));
      await store.write(memory({ campaignId: "c2", refId: "theirs" }), axisVector(0));

      const hits = await store.search("c1", axisVector(0), 5);
      expect(hits.map((hit) => hit.memory.refId)).toEqual(["mine"]);
    });

    it("is idempotent on (campaignId, sequence) so a reindex is a no-op", async () => {
      const store = await makeStore();
      await store.write(memory({ sequence: 7 }), axisVector(0));
      await store.write(memory({ sequence: 7 }), axisVector(0));

      expect(await store.search("c1", axisVector(0), 5)).toHaveLength(1);
    });

    it("scores an exact match at 1 and an orthogonal one at 0", async () => {
      const store = await makeStore();
      await store.write(memory({ sequence: 1, refId: "same" }), axisVector(0));
      await store.write(memory({ sequence: 2, refId: "orthogonal" }), axisVector(1));

      const hits = await store.search("c1", axisVector(0), 5);
      expect(hits[0]?.score).toBeCloseTo(1, 5);
      expect(hits[1]?.score).toBeCloseTo(0, 5);
    });

    it("returns a limit of zero as an empty list rather than everything", async () => {
      const store = await makeStore();
      await store.write(memory(), axisVector(0));
      expect(await store.search("c1", axisVector(0), 0)).toEqual([]);
    });
  });
}
```

Create `packages/memory/src/episodic/in-memory.test.ts`:

```ts
import { runEpisodicStoreContract } from "./contract.js";
import { createInMemoryEpisodicStore } from "./in-memory.js";

runEpisodicStoreContract("in-memory", () => createInMemoryEpisodicStore());
```

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/memory test -- episodic
```

Expected: FAIL — `Cannot find module './port.js'` / `'./in-memory.js'`.

- [ ] **Step 3: Write the port and the in-memory store**

Create `packages/memory/src/episodic/port.ts`:

```ts
// Episodic memory's storage boundary.
//
// The store takes VECTORS, never text to embed. That is the whole reason
// this package still depends only on `@ai-dm/schemas`: an embedding adapter
// lives in `@ai-dm/agents`, which this package may not import (invariant 5),
// so the composition root embeds first and writes second. There is no
// embedding port here to reach for, by design.
//
// The table this backs is a rebuildable INDEX, never authority. Every fact
// it holds also sits in the event log as a closing event's `summaryEnglish`,
// so losing it costs retrieval quality until a reindex and costs correctness
// nothing (invariant 3).
import type { EpisodicMemory } from "@ai-dm/schemas";

/** A retrieved memory and its cosine similarity in [-1, 1]; 1 is identical. */
export interface EpisodicHit {
  memory: EpisodicMemory;
  score: number;
}

/**
 * Mirrors `EventStoreUnavailableError`: every way a durable store can fail
 * that is not a caller error. The in-memory store never raises it, which the
 * shared contract permits rather than requires.
 */
export class EpisodicStoreUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(`Episodic store unavailable during ${operation}`, { cause });
    this.name = "EpisodicStoreUnavailableError";
    this.operation = operation;
  }
}

export interface EpisodicStore {
  /**
   * Idempotent on `(campaignId, sequence)` — the same key the event log uses.
   * Re-indexing a log that has already been indexed rewrites the same rows,
   * so a rebuild needs no delete pass and no ordering.
   *
   * `embedding` must have exactly `EMBEDDING_DIMENSIONS` entries.
   */
  write(record: EpisodicMemory, embedding: readonly number[]): Promise<void>;

  /**
   * The `limit` nearest memories in this campaign by cosine similarity,
   * highest score first. Always filtered by `campaignId` — no query crosses
   * campaigns (ADR-0004). A `limit` of zero returns an empty list.
   */
  search(
    campaignId: string,
    queryEmbedding: readonly number[],
    limit: number,
  ): Promise<EpisodicHit[]>;
}
```

Create `packages/memory/src/episodic/in-memory.ts`:

```ts
// The no-database implementation, so `pnpm test` and `pnpm dev` work without
// docker — the same bargain `event-store/in-memory.ts` strikes.
//
// Cosine is written out by hand rather than imported: `ai` exports a
// `cosineSimilarity`, but this package may not depend on `@ai-dm/agents` or
// the SDK beneath it (invariant 5). It is five lines.
import type { EpisodicMemory } from "@ai-dm/schemas";
import type { EpisodicHit, EpisodicStore } from "./port.js";

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  // A zero vector has no direction, so it is similar to nothing.
  return denominator === 0 ? 0 : dot / denominator;
}

interface Row {
  memory: EpisodicMemory;
  embedding: readonly number[];
}

export function createInMemoryEpisodicStore(): EpisodicStore {
  // Keyed exactly like the Postgres primary key, which is what makes `write`
  // idempotent without a separate existence check.
  const rows = new Map<string, Row>();

  return {
    write(record: EpisodicMemory, embedding: readonly number[]): Promise<void> {
      rows.set(JSON.stringify([record.campaignId, record.sequence]), {
        // Stored by value: the caller may mutate what it passed.
        memory: { ...record },
        embedding: [...embedding],
      });
      return Promise.resolve();
    },

    search(
      campaignId: string,
      queryEmbedding: readonly number[],
      limit: number,
    ): Promise<EpisodicHit[]> {
      if (limit <= 0) return Promise.resolve([]);

      const hits = [...rows.values()]
        .filter((row) => row.memory.campaignId === campaignId)
        .map((row) => ({ memory: { ...row.memory }, score: cosine(queryEmbedding, row.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return Promise.resolve(hits);
    },
  };
}
```

Replace the whole of `packages/memory/src/episodic.ts` with:

```ts
// Episodic memory: pgvector embeddings of scene summaries (not raw turns).
// Same Postgres instance as world state — transactional consistency, one
// service. The store takes vectors; embedding happens at the composition
// root, so nothing here calls a model.
export * from "./episodic/port.js";
export * from "./episodic/in-memory.js";
```

`packages/memory/src/index.ts` already re-exports `./episodic.js`, so no edit
is needed there yet — Task 4 adds the Postgres export.

- [ ] **Step 4: Run the contract suite to verify it passes**

```bash
corepack enable && pnpm --filter @ai-dm/memory test -- episodic
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/episodic packages/memory/src/episodic.ts
git commit -m "feat(memory): EpisodicStore port, in-memory implementation, conformance suite"
```

---

### Task 4: The pgvector table, its migration, and the Postgres store

**Files:**
- Modify: `packages/memory/src/schema.ts`
- Create: `packages/memory/src/episodic/postgres.ts`
- Create: `packages/memory/src/episodic/postgres.test.ts`
- Modify: `packages/memory/src/episodic.ts`
- Modify: `packages/memory/src/index.ts`
- Create: `packages/memory/drizzle/0001_*.sql` and its `drizzle/meta` entries (generated)

**Interfaces:**
- Consumes: `EpisodicStore`, `EpisodicHit`, `EpisodicStoreUnavailableError`, `runEpisodicStoreContract`, `axisVector` (Task 3); `EMBEDDING_DIMENSIONS`, `EpisodicMemory` (Task 1).
- Produces:
  - `episodicMemories` drizzle table
  - `connectPostgresEpisodicStore(databaseUrl: string): PostgresEpisodicStoreHandle`
  - `PostgresEpisodicStoreHandle { store: EpisodicStore; close(): Promise<void> }`

- [ ] **Step 1: One-time local setup for pgvector**

The Homebrew PostgreSQL 18 on this machine has **no** vector extension, and
`aidm_step5_scratch` cannot host this table. Install the extension and make a
fresh scratch database:

```bash
brew install pgvector
```

```bash
createdb aidm_step7_scratch && psql -d aidm_step7_scratch -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Verify it took:

```bash
psql -d aidm_step7_scratch -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';"
```

Expected: a version string such as `0.8.6`. If `brew install pgvector` fails,
CI still covers this task (`.github/workflows/ci.yml:14` runs
`pgvector/pgvector:pg17`) — say so explicitly in the task's report rather
than marking the Postgres tests as passing locally.

For the rest of this task, `DATABASE_URL` means
`postgres://localhost:5432/aidm_step7_scratch`.

- [ ] **Step 2: Add the table to the schema**

In `packages/memory/src/schema.ts`, add `vector` to the drizzle import and
append:

```ts
/**
 * The episodic index. A cache over the log in exactly the sense
 * `campaign_snapshots` is: every row's `summary_english` also sits in the
 * event that produced it, so this table is rebuildable and never authority.
 *
 * The primary key is the event log's own `(campaign_id, sequence)`, which is
 * what makes `write` idempotent and a reindex a no-op.
 */
export const episodicMemories = pgTable(
  "episodic_memories",
  {
    campaignId: text("campaign_id").notNull(),
    sequence: integer("sequence").notNull(),
    // `text`, not a PG enum, for the reason `game_events.type` gives: the zod
    // enum is the authority (invariant 4) and an enum here is a migration per
    // new kind.
    kind: text("kind").notNull(),
    refId: text("ref_id").notNull(),
    summaryEnglish: text("summary_english").notNull(),
    day: integer("day").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.campaignId, table.sequence] })],
);
```

with this import added:

```ts
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
```

No ANN index is created. The corpus is one campaign's episodes — a sequential
scan over a handful of rows beats an `ivfflat` index that needs training data
this project does not have. Add one when a campaign's row count makes it
measurable, not before.

- [ ] **Step 3: Generate the migration and hand-add the extension line**

```bash
corepack enable && pnpm --filter @ai-dm/memory db:generate
```

Then open the generated `packages/memory/drizzle/0001_*.sql` and add as its
**first** line:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

This is the one hand-edit the spec sanctions (Decision 8): drizzle-kit cannot
emit it, and without it `CREATE TABLE ... vector(1536)` fails. It does not
violate `packages/memory/CLAUDE.md`'s "never edit applied migrations" — this
migration has never been applied anywhere at the moment it is written.

- [ ] **Step 4: Apply it and confirm the table exists**

```bash
cd packages/memory && DATABASE_URL=postgres://localhost:5432/aidm_step7_scratch corepack pnpm exec drizzle-kit migrate
```

```bash
psql -d aidm_step7_scratch -c "\d episodic_memories"
```

Expected: the table, with `embedding` typed `vector(1536)`.

- [ ] **Step 5: Write the failing test**

Create `packages/memory/src/episodic/postgres.test.ts`:

```ts
import { afterAll, describe, it } from "vitest";
import { runEpisodicStoreContract } from "./contract.js";
import { connectPostgresEpisodicStore } from "./postgres.js";

const databaseUrl = process.env["DATABASE_URL"];

// Skipped without a database, exactly as the event store's Postgres suite is.
// The number to hold green is the WITH-Postgres run: zero skipped.
if (databaseUrl === undefined) {
  describe.skip("EpisodicStore contract: postgres (no DATABASE_URL)", () => {
    it("is skipped", () => undefined);
  });
} else {
  const handle = connectPostgresEpisodicStore(databaseUrl);

  afterAll(async () => {
    await handle.close();
  });

  runEpisodicStoreContract("postgres", async () => {
    // Each contract case assumes an empty store; the suite reuses campaign
    // ids, so clear between them rather than relying on unique keys.
    await handle.truncate();
    return handle.store;
  });
}
```

Note this needs a `truncate()` on the handle — a test-support method, so
declare it on `PostgresEpisodicStoreHandle` and document it as such.

- [ ] **Step 6: Run it to verify it fails**

```bash
corepack enable && DATABASE_URL=postgres://localhost:5432/aidm_step7_scratch pnpm --filter @ai-dm/memory test -- episodic/postgres
```

Expected: FAIL — `Cannot find module './postgres.js'`.

- [ ] **Step 7: Write the Postgres store**

Create `packages/memory/src/episodic/postgres.ts`:

```ts
// The durable episodic index. Follows `event-store/postgres.ts`'s shape: a
// connect function returning a handle that owns the connection, so the
// caller closes what it opened.
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { EpisodicMemory } from "@ai-dm/schemas";
import { episodicMemories } from "../schema.js";
import { EpisodicStoreUnavailableError } from "./port.js";
import type { EpisodicHit, EpisodicStore } from "./port.js";

export interface PostgresEpisodicStoreHandle {
  store: EpisodicStore;
  close(): Promise<void>;
  /** Test support: empties the table. Never called in production. */
  truncate(): Promise<void>;
}

export function connectPostgresEpisodicStore(databaseUrl: string): PostgresEpisodicStoreHandle {
  const client = postgres(databaseUrl);
  const db = drizzle(client);

  const store: EpisodicStore = {
    async write(record: EpisodicMemory, embedding: readonly number[]): Promise<void> {
      try {
        await db
          .insert(episodicMemories)
          .values({
            campaignId: record.campaignId,
            sequence: record.sequence,
            kind: record.kind,
            refId: record.refId,
            summaryEnglish: record.summaryEnglish,
            day: record.day,
            embedding: [...embedding],
          })
          // Idempotent by primary key: re-indexing a replayed log rewrites
          // the same row rather than erroring or duplicating.
          .onConflictDoUpdate({
            target: [episodicMemories.campaignId, episodicMemories.sequence],
            set: {
              kind: record.kind,
              refId: record.refId,
              summaryEnglish: record.summaryEnglish,
              day: record.day,
              embedding: [...embedding],
            },
          });
      } catch (cause) {
        throw new EpisodicStoreUnavailableError("write", cause);
      }
    },

    async search(
      campaignId: string,
      queryEmbedding: readonly number[],
      limit: number,
    ): Promise<EpisodicHit[]> {
      if (limit <= 0) return [];

      try {
        // `<=>` is pgvector's cosine DISTANCE (0 identical, 2 opposite), so
        // similarity is 1 - distance. Ordering ascending by distance is
        // ordering descending by similarity, which is what the contract asks.
        const distance = sql<number>`${episodicMemories.embedding} <=> ${JSON.stringify([...queryEmbedding])}::vector`;

        const rows = await db
          .select({
            campaignId: episodicMemories.campaignId,
            sequence: episodicMemories.sequence,
            kind: episodicMemories.kind,
            refId: episodicMemories.refId,
            summaryEnglish: episodicMemories.summaryEnglish,
            day: episodicMemories.day,
            distance,
          })
          .from(episodicMemories)
          .where(eq(episodicMemories.campaignId, campaignId))
          .orderBy(distance)
          .limit(limit);

        return rows.map((row) => ({
          // Parsed, not cast: a stored row that no longer matches the schema
          // is a store failure, the same stance `event-store/validate.ts` takes.
          memory: EpisodicMemory.parse({
            campaignId: row.campaignId,
            sequence: row.sequence,
            kind: row.kind,
            refId: row.refId,
            summaryEnglish: row.summaryEnglish,
            day: row.day,
          }),
          score: 1 - Number(row.distance),
        }));
      } catch (cause) {
        throw new EpisodicStoreUnavailableError("search", cause);
      }
    },
  };

  return {
    store,
    async close(): Promise<void> {
      await client.end();
    },
    async truncate(): Promise<void> {
      await db.delete(episodicMemories);
    },
  };
}
```

The `and` import is unused if the final `where` needs only one predicate —
remove it rather than leaving it, or lint fails.

- [ ] **Step 8: Export it**

Append to `packages/memory/src/episodic.ts`:

```ts
export * from "./episodic/postgres.js";
```

- [ ] **Step 9: Run the contract against Postgres**

```bash
corepack enable && DATABASE_URL=postgres://localhost:5432/aidm_step7_scratch pnpm --filter @ai-dm/memory test
```

Expected: PASS — the same 8 contract cases now green against pgvector, plus
the in-memory 8 and the existing event-store suites.

- [ ] **Step 10: Confirm the no-database path still works**

```bash
corepack enable && pnpm --filter @ai-dm/memory test
```

Expected: PASS with the Postgres episodic suite reported as skipped.

- [ ] **Step 11: Commit**

```bash
git add packages/memory/src/schema.ts packages/memory/src/episodic packages/memory/src/episodic.ts packages/memory/drizzle
git commit -m "feat(memory): pgvector episodic store, migration, and contract parity with in-memory"
```

---

### Task 5: The summarizer tier and its deterministic fallback

**Files:**
- Create: `packages/agents/src/summary/port.ts`
- Create: `packages/agents/src/summary/prompt-text.ts`
- Create: `packages/agents/src/summary/prompt-text.test.ts`
- Create: `packages/agents/src/summary/deterministic.ts`
- Create: `packages/agents/src/summary/deterministic.test.ts`
- Create: `packages/agents/src/summary/index.ts`
- Create: `packages/agents/src/summary/index.test.ts`
- Modify: `packages/agents/src/providers/routing.ts` (`AgentRole`, `DEFAULT_MODEL_ROUTING`)
- Modify: `packages/agents/src/index.ts`
- Test: the four `.test.ts` files above

**Interfaces:**
- Consumes: `AgentRuntime`, `LayeredPrompt`, `DEFAULT_MODEL_ROUTING` from this package.
- Produces:
  - `SceneSummaryInput { kind: "encounter" | "quest_node"; contextEnglish: string; factsEnglish: readonly string[]; recentNarrations: readonly string[] }`
  - `SceneSummaryPort { summarize(input: SceneSummaryInput): Promise<string | null> }`
  - `SUMMARY_PROMPT_VERSION: string`
  - `createSceneSummarizer(options: { runtime: AgentRuntime }): SceneSummaryPort`
  - `createDeterministicSceneSummary(): SceneSummaryPort`
  - `AgentRole` now includes `"summary"`.

- [ ] **Step 1: Write the failing deterministic test**

Create `packages/agents/src/summary/deterministic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDeterministicSceneSummary } from "./deterministic.js";

describe("createDeterministicSceneSummary", () => {
  it("assembles a summary from the engine's facts alone", async () => {
    const summary = await createDeterministicSceneSummary().summarize({
      kind: "encounter",
      contextEnglish: "A goblin ambush at the weir.",
      factsEnglish: ["Outcome: victory.", "Survivors: Maren."],
      recentNarrations: ["הגובלינים נסוגו."],
    });

    expect(summary).toBe("A goblin ambush at the weir. Outcome: victory. Survivors: Maren.");
  });

  it("never returns null — a row must always be writable", async () => {
    const summary = await createDeterministicSceneSummary().summarize({
      kind: "quest_node",
      contextEnglish: "The weir.",
      factsEnglish: [],
      recentNarrations: [],
    });

    expect(summary).toBe("The weir.");
  });

  it("never reads the Hebrew narrations — English state stays English", async () => {
    const summary = await createDeterministicSceneSummary().summarize({
      kind: "quest_node",
      contextEnglish: "The inn.",
      factsEnglish: ["Node completed: quiet-word."],
      recentNarrations: ["שלום לך, הולך רגל."],
    });

    expect(summary).not.toMatch(/[֐-׿]/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/agents test -- summary/deterministic
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the port and the deterministic implementation**

Create `packages/agents/src/summary/port.ts`:

```ts
// The scene-summarizer contract. Its output is internal English game state
// for episodic retrieval to index — not narration, and never shown to a
// player. That is why it returns a plain string rather than a token stream:
// nothing renders a summary as it arrives.
export interface SceneSummaryInput {
  kind: "encounter" | "quest_node";
  /** The node card or encounter description. English. */
  contextEnglish: string;
  /**
   * What the engine knows happened — outcome, survivors, effects applied.
   * English, and the sole material the deterministic fallback uses.
   */
  factsEnglish: readonly string[];
  /**
   * The turn's narrations, Hebrew, oldest first. The interpretive half: the
   * facts say a node completed, these say how it felt and what was said.
   * Read as INPUT only — the summary itself is English (invariant 2).
   */
  recentNarrations: readonly string[];
}

export interface SceneSummaryPort {
  /**
   * `null` means "no usable summary" — a provider failure, an empty
   * completion, or a spent deadline. The caller substitutes the
   * deterministic summary rather than skipping the memory, so a null here is
   * a quality loss and never a missing row.
   */
  summarize(input: SceneSummaryInput): Promise<string | null>;
}
```

Create `packages/agents/src/summary/deterministic.ts`:

```ts
// The floor under the summarizer: a summary assembled from the engine's own
// English facts, with no model, no key and no network. It is what makes an
// episodic row unconditional — the model supplies the interpretive content
// that makes a memory worth retrieving, and this guarantees there is
// something to retrieve when the model is absent.
//
// It never reads `recentNarrations`. Those are Hebrew, and this output is
// English internal state — the same asymmetry `scene-deterministic.ts`
// documents for `refused` messages, for the same invariant-2 reason.
import type { SceneSummaryInput, SceneSummaryPort } from "./port.js";

export function createDeterministicSceneSummary(): SceneSummaryPort {
  return {
    summarize(input: SceneSummaryInput): Promise<string | null> {
      const parts = [input.contextEnglish, ...input.factsEnglish]
        .map((part) => part.trim())
        .filter((part) => part !== "");

      return Promise.resolve(parts.join(" "));
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
corepack enable && pnpm --filter @ai-dm/agents test -- summary/deterministic
```

Expected: PASS (3 tests).

- [ ] **Step 5: Add the `summary` role to routing**

In `packages/agents/src/providers/routing.ts`:

```ts
export type AgentRole = "intent" | "tactical" | "narrative" | "summary";
```

and add to `DEFAULT_MODEL_ROUTING`:

```ts
  /**
   * Cheap and cold: a summary is a compression of material already in hand,
   * not a creative act. `temperature: 0` so the same episode summarizes the
   * same way, which keeps the corpus stable across a reindex.
   */
  summary: {
    provider: "google",
    modelId: "gemini-3-flash",
    temperature: 0,
    reasoningEffort: "low",
  },
```

`ModelRouting` is `Record<AgentRole, ModelSpec>`, so omitting this entry is a
compile error — that is the intended guard, not a nuisance.

- [ ] **Step 6: Write the prompt text and its pin test**

Create `packages/agents/src/summary/prompt-text.ts`:

```ts
// Versioned English prompt surface. Bump SUMMARY_PROMPT_VERSION whenever any
// string here changes — `prompt-text.test.ts` hashes this surface and fails
// CI otherwise, so a silent prompt drift cannot ship.
export const SUMMARY_PROMPT_VERSION = "summary-v1";

export const SUMMARY_SYSTEM_PROMPT = `You compress one finished episode of a tabletop campaign into a single English paragraph that a future retrieval will read.

Rules:
- Write ENGLISH only. The narration you are shown is Hebrew; do not copy it, translate what happened.
- Two to three sentences. No preamble, no heading, no bullet points.
- Record what HAPPENED and what it MEANT for the people involved: who was there, what the player did, how they reacted, what changed between them.
- Prefer the specific over the general. "Tobin let them cross after they mentioned the Guild" beats "the party made progress".
- Use no numbers, no dice, no mechanics, no rule names.
- Do not invent anything the facts or the narration do not support.
- Do not address the player. Write it as a record, not as narration.`;

export const SUMMARY_TASK_HEADING = "Summarize this episode.";
export const SUMMARY_FACTS_HEADING = "What the engine recorded:";
export const SUMMARY_NARRATION_HEADING = "How it was narrated (Hebrew, for meaning only):";
```

Create `packages/agents/src/summary/prompt-text.test.ts`, copying the shape
of `packages/agents/src/narrative/scene-prompt-text.test.ts` exactly (read
that file first — it hashes the concatenated surface and compares against a
`PINNED` constant). Compute the hash by running the test once, then paste the
actual value into `PINNED`.

- [ ] **Step 7: Write the failing test for the model-backed summarizer**

Create `packages/agents/src/summary/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../providers/runtime.js";
import { createFakePort } from "../providers/testing/fake-port.js";
import { DEFAULT_MODEL_ROUTING } from "../providers/routing.js";
import { adapterFailure, adapterSuccess } from "../providers/errors.js";
import { createSceneSummarizer } from "./index.js";
import type { SceneSummaryInput } from "./port.js";

const input: SceneSummaryInput = {
  kind: "quest_node",
  contextEnglish: "The weir at dusk.",
  factsEnglish: ["Node completed: quiet-word."],
  recentNarrations: ["טובין הנהן ופתח את השער."],
};

// `createFakePort` takes a script per call kind; the summarizer only ever
// calls `text`. Read `providers/testing/fake-port.ts` and match its actual
// option names before running this.
function summarizerWith(...text: readonly unknown[]) {
  const port = createFakePort({ text } as Parameters<typeof createFakePort>[0]);
  const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });
  return { port, agent: createSceneSummarizer({ runtime }) };
}

describe("createSceneSummarizer", () => {
  it("returns the model's text", async () => {
    const { agent } = summarizerWith(
      adapterSuccess({
        text: "Tobin opened the weir gate once the player invoked the Guild.",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    );

    expect(await agent.summarize(input)).toBe(
      "Tobin opened the weir gate once the player invoked the Guild.",
    );
  });

  it("calls the summary role's model, not the narrative one", async () => {
    const { port, agent } = summarizerWith(
      adapterSuccess({
        text: "x",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    );
    await agent.summarize(input);

    expect(port.calls[0]?.spec.modelId).toBe(DEFAULT_MODEL_ROUTING.summary.modelId);
  });

  it("returns null on a provider failure rather than throwing", async () => {
    const { agent } = summarizerWith(
      adapterFailure({ code: "provider_error", message: "down" }),
    );
    expect(await agent.summarize(input)).toBeNull();
  });

  it("returns null for an empty completion", async () => {
    const { agent } = summarizerWith(
      adapterSuccess({
        text: "   ",
        usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
      }),
    );
    expect(await agent.summarize(input)).toBeNull();
  });
});
```

Read `providers/testing/fake-port.ts` first and match its actual script
shape; the `summarizerWith` helper above assumes a `{ text: [...] }` script
and must be adjusted to whatever that file really takes.

- [ ] **Step 8: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/agents test -- summary/index
```

Expected: FAIL — module not found.

- [ ] **Step 9: Write the summarizer**

Create `packages/agents/src/summary/index.ts`:

```ts
// The fourth tier. Unlike the narrative tiers it does not stream, and unlike
// the intent tier it does not use structured output — a paragraph of English
// is the whole product, so `runtime.text` is the right call shape.
//
// It never falls back on its own. `null` goes back to `apps/server`, which
// owns the degradation ladder for every tier (see packages/agents/CLAUDE.md).
import type { AgentRuntime } from "../providers/runtime.js";
import type { LayeredPrompt } from "../providers/prompt.js";
import {
  SUMMARY_FACTS_HEADING,
  SUMMARY_NARRATION_HEADING,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_TASK_HEADING,
} from "./prompt-text.js";
import type { SceneSummaryInput, SceneSummaryPort } from "./port.js";

export function buildSummaryPrompt(input: SceneSummaryInput): LayeredPrompt {
  const dynamic = [SUMMARY_TASK_HEADING, input.contextEnglish];

  if (input.factsEnglish.length > 0) {
    dynamic.push([SUMMARY_FACTS_HEADING, ...input.factsEnglish.map((fact) => `- ${fact}`)].join("\n"));
  }
  if (input.recentNarrations.length > 0) {
    dynamic.push(
      [SUMMARY_NARRATION_HEADING, ...input.recentNarrations.map((each) => `- ${each}`)].join("\n"),
    );
  }

  // Everything is dynamic: an episode summary shares no prefix with the next
  // episode's, so there is nothing cacheable to hoist into `static` beyond
  // the system prompt itself.
  return { static: [SUMMARY_SYSTEM_PROMPT], dynamic };
}

export interface SceneSummarizerOptions {
  runtime: AgentRuntime;
}

export function createSceneSummarizer(options: SceneSummarizerOptions): SceneSummaryPort {
  return {
    async summarize(input: SceneSummaryInput): Promise<string | null> {
      const result = await options.runtime.text("summary", {
        prompt: buildSummaryPrompt(input),
      });

      if (!result.ok) return null;
      const text = result.value.text.trim();
      return text === "" ? null : text;
    },
  };
}

export * from "./port.js";
export * from "./deterministic.js";
export * from "./prompt-text.js";
```

Add to `packages/agents/src/index.ts`:

```ts
export * from "./summary/index.js";
```

- [ ] **Step 10: Run the whole agents suite**

```bash
corepack enable && pnpm --filter @ai-dm/agents test && pnpm --filter @ai-dm/agents typecheck
```

Expected: PASS. If `routing.test.ts` asserts the exact set of `AgentRole`
values or the shape of `DEFAULT_MODEL_ROUTING`, update it to include
`summary` — that is a real assertion doing its job, not a broken test.

- [ ] **Step 11: Commit**

```bash
git add packages/agents/src/summary packages/agents/src/providers/routing.ts packages/agents/src/index.ts packages/agents/src/providers/routing.test.ts
git commit -m "feat(agents): scene-summarizer tier with a deterministic fallback"
```

---

### Task 6: The memory block reaches the scene narration prompt

**Files:**
- Modify: `packages/agents/src/narrative/scene-port.ts`
- Modify: `packages/agents/src/narrative/scene.ts`
- Modify: `packages/agents/src/narrative/scene.test.ts`
- Modify: `packages/agents/src/narrative/scene-prompt-text.ts` (heading + version bump)
- Modify: `packages/agents/src/narrative/scene-prompt-text.test.ts` (re-pin the hash)
- Test: `packages/agents/src/narrative/scene.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SceneNarrationInput.memoryEnglish: readonly string[]` — every existing construction site of `SceneNarrationInput` must supply it.

- [ ] **Step 1: Write the failing test**

Add to `packages/agents/src/narrative/scene.test.ts`, inside the
`buildScenePrompt` describe block (read the existing cases first and reuse
their input helper):

```ts
it("puts the memory block in semiStatic so it rides the cached prefix", () => {
  const prompt = buildScenePrompt(
    sceneInput({ memoryEnglish: ["Tobin regards you warmly.", "You broke the weir gate here."] }),
  );

  const semiStatic = (prompt.semiStatic ?? []).join("\n");
  expect(semiStatic).toContain("Tobin regards you warmly.");
  expect(semiStatic).toContain("You broke the weir gate here.");
  expect((prompt.dynamic ?? []).join("\n")).not.toContain("Tobin regards you warmly.");
});

it("omits the memory section entirely when there is nothing remembered", () => {
  const prompt = buildScenePrompt(sceneInput({ memoryEnglish: [] }));
  expect((prompt.semiStatic ?? []).join("\n")).not.toContain(SCENE_MEMORY_HEADING);
});
```

Add `memoryEnglish: []` to whatever helper builds a `SceneNarrationInput` in
that file, so the existing cases keep compiling.

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/agents test -- narrative/scene
```

Expected: FAIL — `memoryEnglish` is not a property of `SceneNarrationInput`,
and `SCENE_MEMORY_HEADING` is undefined.

- [ ] **Step 3: Add the field, the heading, and the rendering**

In `packages/agents/src/narrative/scene-port.ts`, add to
`SceneNarrationInput`:

```ts
  /**
   * What the DM remembers about this place and these people: step 6's
   * authored NPC facts and standing, plus episodes retrieved from episodic
   * memory. English — translated at generation time like every other piece
   * of game state (invariant 2), never a third sanctioned Hebrew field.
   *
   * Both sources render into one list on purpose. From the narrator's side
   * they are the same thing — things known that did not happen this turn —
   * and a provenance split would be a distinction the prompt has no use for.
   */
  memoryEnglish: readonly string[];
```

In `packages/agents/src/narrative/scene-prompt-text.ts`, add the heading and
bump the version:

```ts
export const SCENE_PROMPT_VERSION = "scene-v2";

export const SCENE_MEMORY_HEADING = "What you remember about this place and these people:";
```

Add one line to `SCENE_SYSTEM_PROMPT`'s rule list so the model knows what to
do with the block:

```
- The memory section is what you already know. Let it colour how people treat the player; never state it as news.
```

In `packages/agents/src/narrative/scene.ts`, inside `buildScenePrompt`, add
the block to the **`semiStatic`** tier beside the scene card and NPC names —
it is stable for as long as the campaign stands at one node, so putting it in
`dynamic` would break prompt caching every turn:

```ts
  if (input.memoryEnglish.length > 0) {
    semiStatic.push(
      [SCENE_MEMORY_HEADING, ...input.memoryEnglish.map((each) => `- ${each}`)].join("\n"),
    );
  }
```

Match the existing local variable name for the semiStatic array in that
function rather than introducing a new one.

- [ ] **Step 4: Re-pin the prompt hash**

```bash
corepack enable && pnpm --filter @ai-dm/agents test -- scene-prompt-text
```

Expected: FAIL, reporting the received hash. Paste that hash into the
`PINNED` constant in `scene-prompt-text.test.ts` and re-run. This is the
guard working: the version bump and the hash move together.

- [ ] **Step 5: Fix every other construction site**

```bash
corepack enable && pnpm --filter @ai-dm/agents typecheck && pnpm --filter @ai-dm/server typecheck
```

Every `SceneNarrationInput` literal now needs `memoryEnglish`. In
`apps/server/src/core/pipeline.ts:805-812` pass `memoryEnglish: []` for now —
Task 7 fills it. In tests, pass `[]`.

- [ ] **Step 6: Run both suites**

```bash
corepack enable && pnpm --filter @ai-dm/agents test && pnpm --filter @ai-dm/server test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agents/src/narrative apps/server/src/core/pipeline.ts
git commit -m "feat(agents): scene narration accepts an English memory block in the cached prefix"
```

---

### Task 7: The pipeline summarizes, indexes, retrieves, and renders

**Files:**
- Modify: `apps/server/src/core/campaign.ts` (`Campaign` interface ~115-135, `loadCampaign`'s projection ~508-528)
- Modify: `apps/server/src/core/pipeline.ts` (`TurnPorts` ~229-256, `MetricsPort` ~197-224, the `encounter_resolved` emit site ~1108-1121, the node-completion site ~1429-1440, `sceneNarrate` ~797-833)
- Modify: `apps/server/src/main.ts`
- Create: `apps/server/src/core/episodic.ts`
- Create: `apps/server/src/core/episodic.test.ts`
- Test: `apps/server/src/core/episodic.test.ts`, plus additions to the existing pipeline tests

**Interfaces:**
- Consumes: `EpisodicStore`, `createInMemoryEpisodicStore`, `connectPostgresEpisodicStore` (Tasks 3-4); `EmbeddingPort`, `DEFAULT_EMBEDDING_SPEC`, `createVercelEmbeddingPort` (Task 2); `SceneSummaryPort`, `createSceneSummarizer`, `createDeterministicSceneSummary` (Task 5); `SceneNarrationInput.memoryEnglish` (Task 6).
- Produces:
  - `summarizeEpisode(args): Promise<string>` — never null; falls back.
  - `indexEpisode(args): Promise<void>` — embeds then writes; swallows failure.
  - `retrieveMemories(args): Promise<string[]>` — the rendered English lines.
  - `Campaign.recentMemories: string[]`
  - `TurnPorts.episodic`, `.embedding`, `.summary`
  - `MetricsPort.recordSummaryCall`, `.recordEmbeddingCall`

- [ ] **Step 1: Write the failing test for the episodic helpers**

Create `apps/server/src/core/episodic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInMemoryEpisodicStore } from "@ai-dm/memory";
import { createFakeEmbeddingPort } from "@ai-dm/agents/src/providers/testing/fake-embedding-port.js";
import { DEFAULT_EMBEDDING_SPEC, createDeterministicSceneSummary } from "@ai-dm/agents";
import { indexEpisode, memoryLines, retrieveMemories, summarizeEpisode } from "./episodic.js";

describe("summarizeEpisode", () => {
  it("uses the model's summary when it returns one", async () => {
    const summary = await summarizeEpisode({
      summary: { summarize: () => Promise.resolve("The gate opened.") },
      input: {
        kind: "quest_node",
        contextEnglish: "The weir.",
        factsEnglish: ["Node completed: quiet-word."],
        recentNarrations: [],
      },
    });

    expect(summary).toBe("The gate opened.");
  });

  it("falls back to the deterministic summary when the model returns null", async () => {
    const summary = await summarizeEpisode({
      summary: { summarize: () => Promise.resolve(null) },
      input: {
        kind: "quest_node",
        contextEnglish: "The weir.",
        factsEnglish: ["Node completed: quiet-word."],
        recentNarrations: [],
      },
    });

    expect(summary).toBe("The weir. Node completed: quiet-word.");
  });

  it("falls back when the model throws, rather than failing the turn", async () => {
    const summary = await summarizeEpisode({
      summary: { summarize: () => Promise.reject(new Error("boom")) },
      input: {
        kind: "encounter",
        contextEnglish: "An ambush.",
        factsEnglish: ["Outcome: victory."],
        recentNarrations: [],
      },
    });

    expect(summary).toBe("An ambush. Outcome: victory.");
  });
});

describe("indexEpisode", () => {
  it("embeds the summary and writes it so retrieval can find it", async () => {
    const store = createInMemoryEpisodicStore();
    const embedding = createFakeEmbeddingPort();
    const record = {
      campaignId: "c1",
      sequence: 4,
      kind: "quest_node" as const,
      refId: "weir",
      summaryEnglish: "Tobin opened the gate.",
      day: 2,
    };

    await indexEpisode({ store, embedding, spec: DEFAULT_EMBEDDING_SPEC, record });

    // Embed the same text again to get the query vector: the fake port is
    // deterministic, so this is the vector the record was written under.
    const query = await embedding.embed(DEFAULT_EMBEDDING_SPEC, ["Tobin opened the gate."]);
    expect(query.ok).toBe(true);
    if (!query.ok) return;

    const hits = await store.search("c1", query.value.vectors[0] ?? [], 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.memory.summaryEnglish).toBe("Tobin opened the gate.");
    expect(hits[0]?.score).toBeCloseTo(1, 5);
  });

  it("reports the embedding's usage to its caller", async () => {
    const store = createInMemoryEpisodicStore();
    const embedding = createFakeEmbeddingPort();
    let reported = 0;

    await indexEpisode({
      store,
      embedding,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: "c1",
        sequence: 4,
        kind: "quest_node" as const,
        refId: "weir",
        summaryEnglish: "Tobin opened the gate.",
        day: 2,
      },
      onUsage: (usage) => {
        reported = usage.totalTokens;
      },
    });

    expect(reported).toBeGreaterThan(0);
  });

  it("writes nothing and does not throw when embedding fails", async () => {
    const store = createInMemoryEpisodicStore();
    const failing = {
      embed: () =>
        Promise.resolve({ ok: false as const, error: { code: "provider_error" as const, message: "down" } }),
    };

    await indexEpisode({
      store,
      embedding: failing,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: "c1",
        sequence: 4,
        kind: "quest_node" as const,
        refId: "weir",
        summaryEnglish: "Tobin opened the gate.",
        day: 2,
      },
    });

    expect(await store.search("c1", [1, 0, 0], 3)).toEqual([]);
  });
});

describe("memoryLines", () => {
  it("renders an NPC's band and facts as English lines", () => {
    const lines = memoryLines({
      npcs: [{ nameEnglish: "Tobin", band: "friendly", facts: ["You mended his weir."] }],
      retrieved: [],
    });

    expect(lines).toEqual(["Tobin regards you as friendly. You mended his weir."]);
  });

  it("appends retrieved episodes after the authored facts", () => {
    const lines = memoryLines({
      npcs: [{ nameEnglish: "Tobin", band: "neutral", facts: [] }],
      retrieved: ["Goblins were driven off at the weir."],
    });

    expect(lines).toEqual([
      "Tobin regards you as neutral.",
      "Goblins were driven off at the weir.",
    ]);
  });

  it("is empty when nothing is known", () => {
    expect(memoryLines({ npcs: [], retrieved: [] })).toEqual([]);
  });
});
```

Simplify the first `indexEpisode` assertion when writing it for real — embed
once, keep the vector in a local, then search with it. The nested expression
above is illustrative of intent, not of style.

- [ ] **Step 2: Run it to verify it fails**

```bash
corepack enable && pnpm --filter @ai-dm/server test -- core/episodic
```

Expected: FAIL — `Cannot find module './episodic.js'`.

- [ ] **Step 3: Write the helpers**

Create `apps/server/src/core/episodic.ts`:

```ts
// Episodic memory's composition point. This is the one place the embedding
// adapter (`@ai-dm/agents`) and the vector store (`@ai-dm/memory`) meet —
// they cannot import each other (invariant 5), and they do not need to: the
// store takes vectors, so `apps/server` embeds and then writes.
import { createDeterministicSceneSummary } from "@ai-dm/agents";
import type { EmbeddingPort, EmbeddingSpec, SceneSummaryInput, SceneSummaryPort } from "@ai-dm/agents";
import type { EpisodicStore } from "@ai-dm/memory";
import type { EpisodicMemory, FactionBand } from "@ai-dm/schemas";

/**
 * A summary, unconditionally. The model supplies the interpretive content
 * that makes a memory worth retrieving; the deterministic skeleton
 * guarantees a row exists when it cannot — so an episode is never lost to a
 * provider outage, a missing key, or a spent deadline.
 */
export async function summarizeEpisode(args: {
  summary: SceneSummaryPort;
  input: SceneSummaryInput;
}): Promise<string> {
  const fallback = async (): Promise<string> =>
    (await createDeterministicSceneSummary().summarize(args.input)) ?? args.input.contextEnglish;

  try {
    const summary = await args.summary.summarize(args.input);
    return summary ?? (await fallback());
  } catch {
    // A summarizer failure must not fail the turn that closed the episode.
    return fallback();
  }
}

/**
 * Embed, then write. Best-effort on purpose: the summary is already durable
 * in the event log by the time this runs, so a failure here costs retrieval
 * quality until the next reindex and costs correctness nothing (invariant 3).
 * It must never throw into the turn pipeline.
 */
export async function indexEpisode(args: {
  store: EpisodicStore;
  embedding: EmbeddingPort;
  spec: EmbeddingSpec;
  record: EpisodicMemory;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
}): Promise<void> {
  try {
    const result = await args.embedding.embed(args.spec, [args.record.summaryEnglish]);
    if (!result.ok) return;
    args.onUsage?.(result.value.usage);

    const vector = result.value.vectors[0];
    if (vector === undefined) return;

    await args.store.write(args.record, vector);
  } catch {
    // Swallowed deliberately — see the doc comment above.
  }
}

/**
 * The `limit` nearest episodes' summaries, or an empty list on any failure.
 * Retrieval is a prompt-quality nicety; it never blocks or fails a turn.
 */
export async function retrieveMemories(args: {
  store: EpisodicStore;
  embedding: EmbeddingPort;
  spec: EmbeddingSpec;
  campaignId: string;
  queryEnglish: string;
  limit: number;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;
}): Promise<string[]> {
  try {
    const result = await args.embedding.embed(args.spec, [args.queryEnglish]);
    if (!result.ok) return [];
    args.onUsage?.(result.value.usage);

    const vector = result.value.vectors[0];
    if (vector === undefined) return [];

    const hits = await args.store.search(args.campaignId, vector, args.limit);
    return hits.map((hit) => hit.memory.summaryEnglish);
  } catch {
    return [];
  }
}

export interface NpcMemory {
  nameEnglish: string;
  band: FactionBand;
  facts: readonly string[];
}

/**
 * One English list from both memory sources. Authored NPC facts come first
 * because they are certain; retrieved episodes follow because they are not.
 * The narrator sees one block — the provenance split matters to us, not to
 * the prompt.
 */
export function memoryLines(args: {
  npcs: readonly NpcMemory[];
  retrieved: readonly string[];
}): string[] {
  const npcLines = args.npcs.map((npc) =>
    [`${npc.nameEnglish} regards you as ${npc.band}.`, ...npc.facts].join(" "),
  );

  return [...npcLines, ...args.retrieved];
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

```bash
corepack enable && pnpm --filter @ai-dm/server test -- core/episodic
```

Expected: PASS.

- [ ] **Step 5: Add the ports, the metrics methods, and the campaign field**

In `apps/server/src/core/pipeline.ts`, add to `TurnPorts`:

```ts
  episodic: EpisodicStore;
  embedding: EmbeddingPort;
  summary: SceneSummaryPort;
```

Declare the two metric types beside `IntentCallMetrics` (`pipeline.ts:167-177`),
copying its field list exactly:

```ts
/**
 * The fourth billed source. `outcome` is `"ok"` or an `AdapterErrorCode`,
 * an open `string` for the same reason `IntentCallMetrics.outcome` is.
 */
export interface SummaryCallMetrics {
  outcome: string;
  /** `"model"` when the tier produced the summary, `"deterministic"` when it fell back. */
  source: string;
  promptVersion: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * The fifth. `completionTokens` is always 0 — an embedding bills input only,
 * which is truthful rather than a gap.
 *
 * Cost is still not computed here: `cache_read_input_tokens` is unreported
 * and the pricing table lives in `tools/sim`, which this app may not import.
 * These are tokens and latency only, so step 11's fix prices them without
 * touching these call sites (episodic-memory spec, Decision 11).
 */
export interface EmbeddingCallMetrics {
  outcome: string;
  /** `"index"` when writing a closed episode, `"retrieve"` when reading on node entry. */
  purpose: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

and add to `MetricsPort`, optional like `recordSnapshotFailure` so the
existing pipeline tests need not supply them:

```ts
  recordSummaryCall?(metrics: SummaryCallMetrics): void;
  recordEmbeddingCall?(metrics: EmbeddingCallMetrics): void;
```

Implement both in `main.ts:109-130` as structured pino lines named
`summary_call_metrics` and `embedding_call_metrics`, matching the three
existing ones.

In `apps/server/src/core/campaign.ts`, add to the `Campaign` interface:

```ts
  /**
   * Retrieved episode summaries for the current node, English. Refreshed
   * only when the current node changes — the query is the node's card and
   * the NPCs there, both static while the campaign stands at one node, so a
   * six-turn conversation costs one embedding call rather than six
   * (episodic-memory spec, Decision 7).
   */
  recentMemories: string[];
```

initialise it to `[]` at `campaign.ts:292` and in `loadCampaign`'s return at
`campaign.ts:522-528`. It is a cache, not a projection: a reloaded campaign
starts with an empty list and refills on the next node transition.

- [ ] **Step 6: Summarize and index at the two closing sites**

At the `encounter_resolved` emit (`pipeline.ts` ~1108-1121), before emitting,
build the facts and summarize:

```ts
    const summaryEnglish = await summarizeEpisode({
      summary: ports.summary,
      input: {
        kind: "encounter",
        contextEnglish: builtOf(campaign).descriptionEnglish,
        factsEnglish: [
          `Outcome: ${outcome}.`,
          `Survivors: ${survivorIds.join(", ")}.`,
        ],
        recentNarrations: campaign.recentNarrations,
      },
    });
```

include `summaryEnglish` in the emitted payload, and after the append, index
it with the sequence the event actually received:

```ts
    const indexStartedAt = ports.clock();
    await indexEpisode({
      store: ports.episodic,
      embedding: ports.embedding,
      spec: DEFAULT_EMBEDDING_SPEC,
      record: {
        campaignId: campaign.state.world.campaignId,
        sequence: resolvedSequence,
        kind: "encounter",
        refId: encounterId,
        summaryEnglish,
        day: campaign.state.world.scene.day,
      },
      onUsage: (usage) => {
        ports.metrics?.recordEmbeddingCall?.({
          outcome: "ok",
          purpose: "index",
          latencyMs: Date.parse(ports.clock()) - Date.parse(indexStartedAt),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        });
      },
    });
```

Do the same at the node-completion site (~1429-1440) with `kind:
"quest_node"`, `refId: nodeId`, `purpose: "index"`, and `factsEnglish` built
as:

```ts
        factsEnglish: [
          `Node completed: ${nodeId}.`,
          ...delta.npcAffinities.map(
            (entry) => `${entry.npcId} now regards the player as ${entry.band}.`,
          ),
          ...delta.relations.map(
            (entry) => `${entry.factionA} and ${entry.factionB} now stand at ${entry.band}.`,
          ),
        ],
```

Read both sites before editing — the exact local variable names for outcome,
survivors, node id, the delta and the emitted sequence differ, and `emit`
returns the event whose `sequence` the record needs. If `emit` does not
return the sequence, take it from `campaign.nextSequence` immediately before
the call.

- [ ] **Step 7: Retrieve on node transition and render the block**

In `sceneNarrate` (`pipeline.ts:797-833`), replace the `memoryEnglish: []`
placeholder from Task 6 with the assembled block, and refresh
`campaign.recentMemories` only when the node changed since the last refresh
(track the node id the cache was built for — a `campaign.memoriesForNodeId`
field, or recompute when `currentNodeId` differs from a stored value):

First widen `questNodeCard` (`pipeline.ts:452-468`) — it currently returns
`{ sceneEnglish, locationNameHebrew, npcNamesHebrew }` and the affinity
lookup needs ids, not Hebrew names. Change its return type to include
`npcIds: string[]` and build both from the same filtered list:

```ts
): { sceneEnglish: string; locationNameHebrew: string; npcNamesHebrew: string[]; npcIds: string[] } {
  // ...unchanged lookups...
  const present = Array.from(authored.npcs.values()).filter(
    (npc) => npc.locationId === node.locationId,
  );
  return {
    sceneEnglish: node.sceneEnglish,
    locationNameHebrew: location.nameHebrew,
    npcNamesHebrew: present.map((npc) => npc.nameHebrew),
    npcIds: present.map((npc) => npc.npcId),
  };
}
```

Then, in `sceneNarrate`:

```ts
    const nodeId = currentScene().currentNodeId;
    if (campaign.memoriesForNodeId !== nodeId) {
      const retrieveStartedAt = ports.clock();
      campaign.recentMemories = await retrieveMemories({
        store: ports.episodic,
        embedding: ports.embedding,
        spec: DEFAULT_EMBEDDING_SPEC,
        campaignId: campaign.state.world.campaignId,
        // Static for as long as the campaign stands at this node, which is
        // what makes this one embedding call per transition, not per turn.
        queryEnglish: [card.sceneEnglish, ...card.npcIds].join(" "),
        limit: 3,
        onUsage: (usage) => {
          ports.metrics?.recordEmbeddingCall?.({
            outcome: "ok",
            purpose: "retrieve",
            latencyMs: Date.parse(ports.clock()) - Date.parse(retrieveStartedAt),
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          });
        },
      });
      campaign.memoriesForNodeId = nodeId;
    }

    const input: SceneNarrationInput = {
      // ...existing fields, unchanged...
      memoryEnglish: memoryLines({
        npcs: card.npcIds.map((npcId) => {
          const affinity = affinityOf(currentScene(), npcId);
          return {
            nameEnglish: statics.authored.npcs.get(npcId)?.nameEnglish ?? npcId,
            band: affinity.band,
            facts: affinity.facts,
          };
        }),
        retrieved: campaign.recentMemories,
      }),
    };
```

Add `memoriesForNodeId: string | null` to `Campaign` beside `recentMemories`,
initialised to `null`, so the first scene turn after a load always retrieves.

`affinityOf` comes from `@ai-dm/rules-engine`; this is its **first call site
outside that package**, and it is what finally connects step 6's projection
to a prompt.

- [ ] **Step 8: Wire the three ports in `main.ts`**

```ts
const episodicHandle: PostgresEpisodicStoreHandle | null =
  config.databaseUrl === undefined ? null : connectPostgresEpisodicStore(config.databaseUrl);

const episodic: EpisodicStore = episodicHandle?.store ?? createInMemoryEpisodicStore();

const embedding = createVercelEmbeddingPort({});

const summary = createSceneSummarizer({
  runtime: createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port: createVercelPort({}) }),
});
```

and pass `episodic`, `embedding`, `summary` into `buildApp`'s `ports`. Close
`episodicHandle` wherever `postgresHandle` is closed on shutdown.

- [ ] **Step 9: Fix every test that constructs `TurnPorts`**

```bash
corepack enable && pnpm --filter @ai-dm/server typecheck
```

Every pipeline test now needs the three new ports. Use
`createInMemoryEpisodicStore()`, `createFakeEmbeddingPort()`, and
`createDeterministicSceneSummary()` — all three are real implementations that
need no network, so no mocking is required.

- [ ] **Step 10: Run the full suite both ways**

```bash
corepack enable && pnpm test
```

Expected: PASS. Passed count rises above 1596; skipped rises above 30 by the
new Postgres-only episodic cases.

```bash
corepack enable && DATABASE_URL=postgres://localhost:5432/aidm_step7_scratch pnpm test
```

Expected: PASS with **0 skipped**. That is the number that must hold.

- [ ] **Step 11: Commit**

```bash
git add apps/server/src
git commit -m "feat(server): summarize at episode boundaries, index, retrieve on node entry"
```

---

### Task 8: End-to-end proof, the reindex test, and the docs

**Files:**
- Create: `apps/server/src/core/episodic-e2e.test.ts`
- Modify: `PROJECT_PLAN.md` (§4.7 sequence entry 7, and §4.6's spec #2 paragraph)
- Test: `apps/server/src/core/episodic-e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: nothing new.

- [ ] **Step 1: Write the end-to-end test**

Create `apps/server/src/core/episodic-e2e.test.ts`. It must prove the three
claims the spec's exit criterion makes. Model it on the existing
`apps/server/src/core/replay.test.ts` for campaign setup and event driving:

Reuse `replay.test.ts`'s existing campaign fixture and its event-driving
helpers rather than building a new world — read that file first and copy its
setup verbatim, substituting the three new ports.

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  EncounterResolvedPayload,
  EpisodicMemory,
  QuestNodeCompletedPayload,
} from "@ai-dm/schemas";
import { createInMemoryEpisodicStore } from "@ai-dm/memory";
import { DEFAULT_EMBEDDING_SPEC } from "@ai-dm/agents";
import { createFakeEmbeddingPort } from "@ai-dm/agents/src/providers/testing/fake-embedding-port.js";
import { indexEpisode } from "./episodic.js";

describe("episodic memory end to end", () => {
  it("writes one memory per closed episode, and the log carries the same text", async () => {
    const { store, events } = await runCampaignThroughAnEpisodeAndAFight();

    const summariesInLog = events.flatMap((event) => {
      if (event.type === "quest_node_completed") {
        return [QuestNodeCompletedPayload.parse(event.payload).summaryEnglish].filter(
          (each): each is string => each !== undefined,
        );
      }
      if (event.type === "encounter_resolved") {
        return [EncounterResolvedPayload.parse(event.payload).summaryEnglish].filter(
          (each): each is string => each !== undefined,
        );
      }
      return [];
    });

    expect(summariesInLog.length).toBeGreaterThanOrEqual(2);

    // Every summary the log recorded is retrievable, with identical text.
    const embedding = createFakeEmbeddingPort();
    for (const summary of summariesInLog) {
      const query = await embedding.embed(DEFAULT_EMBEDDING_SPEC, [summary]);
      expect(query.ok).toBe(true);
      if (!query.ok) continue;

      const hits = await store.search(CAMPAIGN_ID, query.value.vectors[0] ?? [], 5);
      expect(hits.map((hit) => hit.memory.summaryEnglish)).toContain(summary);
    }
  });

  it("puts a retrieved summary into the scene narration prompt on re-entry", async () => {
    const { sceneInputs } = await runCampaignThroughAnEpisodeAndAFight();

    // The first scene turn has nothing remembered; a later one, after an
    // episode closed, must carry something.
    const last = sceneInputs[sceneInputs.length - 1];
    expect(last?.memoryEnglish.length).toBeGreaterThan(0);
  });

  it("rebuilds the index from the log alone", async () => {
    const { store, events } = await runCampaignThroughAnEpisodeAndAFight();
    const live = await store.search(CAMPAIGN_ID, PROBE_VECTOR, 5);

    // Rebuild into a fresh store from nothing but the event log.
    const rebuilt = createInMemoryEpisodicStore();
    const embedding = createFakeEmbeddingPort();
    for (const event of events) {
      const summaryEnglish =
        event.type === "quest_node_completed"
          ? QuestNodeCompletedPayload.parse(event.payload).summaryEnglish
          : event.type === "encounter_resolved"
            ? EncounterResolvedPayload.parse(event.payload).summaryEnglish
            : undefined;
      if (summaryEnglish === undefined) continue;

      await indexEpisode({
        store: rebuilt,
        embedding,
        spec: DEFAULT_EMBEDDING_SPEC,
        record: EpisodicMemory.parse({
          campaignId: event.campaignId,
          sequence: event.sequence,
          kind: event.type === "encounter_resolved" ? "encounter" : "quest_node",
          refId:
            event.type === "encounter_resolved"
              ? EncounterResolvedPayload.parse(event.payload).encounterId
              : QuestNodeCompletedPayload.parse(event.payload).nodeId,
          summaryEnglish,
          day: DAY_AT_CLOSE,
        }),
      });
    }

    expect((await rebuilt.search(CAMPAIGN_ID, PROBE_VECTOR, 5)).map((hit) => hit.memory)).toEqual(
      live.map((hit) => hit.memory),
    );
  });

  it("folds to an identical CampaignState after a reload — summaries are not state", async () => {
    const { liveState, reloadedState } = await runCampaignThroughAnEpisodeAndAFight();
    expect(reloadedState).toEqual(liveState);
  });
});
```

`runCampaignThroughAnEpisodeAndAFight`, `CAMPAIGN_ID`, `PROBE_VECTOR` and
`DAY_AT_CLOSE` are this file's own fixture helpers — write them on top of
`replay.test.ts`'s existing campaign driver, returning the episodic store, the
full event list, the `SceneNarrationInput`s the fake narrative port received,
and the live-vs-reloaded `CampaignState` pair. `PROBE_VECTOR` is
`axisVector(0)` from the memory package's contract helpers, or any fixed
unit vector — the rebuild assertion compares two stores under one query, so
the query only has to be the same on both sides.

- [ ] **Step 2: Run it**

```bash
corepack enable && DATABASE_URL=postgres://localhost:5432/aidm_step7_scratch pnpm --filter @ai-dm/server test -- episodic-e2e
```

Expected: PASS.

- [ ] **Step 3: Record the merge status in `PROJECT_PLAN.md` §4.7 entry 7**

Entry 7 already carries this step's summary and its spec/plan links — the
design session wrote them. What it lacks is the status line every merged
entry ends with. Add one in the same shape entries 1-6 use, with the real
commit and the real numbers from Step 4:

```markdown
   **Merged to `main`** 2026-MM-DD as `<sha>` (PR
   [#N](https://github.com/shalevshir/golem-dm/pull/N)), CI green at
   <passed> passed / <skipped> skipped (<passed> passed / 0 skipped with
   Postgres).
```

Do not invent these values — take them from the actual merge and the actual
run. If the branch has not merged yet when this task runs, leave the line
out rather than writing a predicted one.

- [ ] **Step 4: Full verification**

```bash
corepack enable && pnpm typecheck && npx eslint packages apps tools
```

Expected: both exit 0.

Confirm invariant 5 held — `@ai-dm/memory` must have gained no dependency:

```bash
git diff main -- packages/memory/package.json packages/agents/package.json
```

Expected: **no change to either file's `dependencies`**. If
`@ai-dm/memory` acquired `@ai-dm/agents` or the `ai` SDK, the store started
embedding and Decision 1 was violated — stop and re-read it.

```bash
corepack enable && DATABASE_URL=postgres://localhost:5432/aidm_step7_scratch pnpm test
```

Expected: PASS, 0 skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/core/episodic-e2e.test.ts PROJECT_PLAN.md
git commit -m "test(server): end-to-end episodic memory proof, and record step 7 in the plan"
```

---

## Follow-ups (not this plan)

- **`packages/memory/CLAUDE.md`** — its clause "No LLM calls except embedding
  generation for episodic writes" is false after Task 1 and should read "No
  LLM calls". Excluded here because that file carries an uncommitted edit in
  the main checkout; every prior step excluded it too. Also update its
  "Planned, not built" bullets and its "Once episodic memory is built" testing
  note, which this plan makes current.
- **`apps/server/CLAUDE.md`** — the turn-pipeline section does not mention
  summarization or retrieval; add them once the shape is settled by review.
- **An ANN index on `episodic_memories`** — deliberately omitted (Task 4,
  Step 2). Add when a campaign's row count makes a sequential scan
  measurable.
- **Pricing the two new call sites** — step 11's `cache_read_input_tokens`
  and pricing-table relocation, per the spec's Decision 11.
