# Episodic memory — design

Step 7 of `PROJECT_PLAN.md` §4.7, and the second half of §4.6's step 10
decomposition. Spec #1 (event-log persistence) merged long ago; spec #2 has
been "not yet designed" since 2026-08-22 for want of a corpus, a consumer and
a producer. §4.7 records that the narrative sequence supplied all three and
left two blockers open — the embedding port and cost.

What ships here: scene summaries written into the event log at the two
boundaries that already close an episode, indexed into a pgvector table
behind the same two-implementations-one-conformance-suite shape the event log
already has, retrieved on scene entry, and delivered to the narrator through
one new English prompt block that authored NPC facts share.

Exit criterion: a campaign walks the arc, fights and resolves the encounter;
`episodic_memories` holds one row per closed episode; re-entering a location
the campaign has already been through puts a retrieved English summary of
what happened there into the scene narration prompt; and a reload of the same
campaign from the event log folds to the identical `CampaignState` the live
one held, with the index rebuildable from the log alone.

## Context

Facts checked against the repo at `2a71326`, not recalled. Three of §4.7's
own statements about this step do not match the code, and each changes the
step's scope.

**§4.7's producer is not built.** §4.7 line 1060 says "`encounter_resolved`
carries a scene summary, and this sequence adds the scene-summarizer tier
that writes it," and lists the producer among the things the sequence
*resolved*. Neither half is true at `2a71326`. `EncounterResolvedPayload`
(`packages/schemas/src/events.ts:104-121`) is `{ encounterId, outcome,
survivorIds }`; `QuestNodeCompletedPayload` (`events.ts:299`) is `{ nodeId }`.
A grep for `summar` across `packages/` and `apps/` returns a doc comment on
`encounter/build.ts`'s `descriptionEnglish`, the placeholder comment in
`packages/memory/src/episodic.ts`, and `tools/sim`'s report helpers — no
schema field, no tier, no call site. This step builds the field *and* the
tier. This is the same class of discovery step 5 recorded about
`resolveEncounter` having no production caller: the section's premise was
aspirational, and the step widens to cover it.

**Step 6's consumer wire is dangling.** §4.7 names step 6's `npcId → band +
facts` projection as the consumer that makes this step designable, and the
projection exists: `affinityOf` (`packages/rules-engine/src/scene/index.ts:109-114`)
and `SceneSnapshot.npcAffinities` (`packages/schemas/src/protocol.ts:42`).
But `affinityOf` has exactly two call sites, both inside the rules engine's
own `applyEffect` (`scene/index.ts:267,273`), and `SceneNarrationInput`
(`packages/agents/src/narrative/scene-port.ts:15-25`) has no affinity field,
no facts field, and no memory field of any kind. The projection reaches the
*client* through the protocol snapshot; it has never reached a *prompt*.
There is therefore no "what the DM remembers" slot for retrieval to land in —
this step builds that slot, and authored facts get to use it too. Closing
step 6's dangling wire is not scope creep here; it is the only way retrieval
has anywhere to go.

**The narrator's existing history is Hebrew, not English.**
`Campaign.recentNarrations` (`apps/server/src/core/campaign.ts:115-125`) is a
projection of `narrative_emitted.text` (`campaign.ts:511-519`), which is one
of the two sanctioned Hebrew payload fields (invariant 2), and
`NARRATION_WINDOW` is `2` (`campaign.ts:51`). `SceneNarrationInput`'s own
comment says so outright: "The previous narrations, Hebrew, oldest first"
(`scene-port.ts:23`). So the summarizer's raw material is Hebrew prose plus
English state, and its output must be English — the summary is internal game
state, not narration, and gets no third sanctioned Hebrew field (character-
profiles spec, Decision 5).

**The embedding port's framing dissolves under inspection.** §4.6 states the
problem as "an adapter living in `@ai-dm/agents` ... is unreachable from
where the store lives," and `packages/memory/CLAUDE.md`'s charter has long
carried the clause that made that a problem: "No LLM calls except embedding
generation for episodic writes." That clause is the whole difficulty. Nothing
requires the store to generate embeddings — a store that accepts vectors has
no LLM dependency, no port to reach, and no invariant to bend. `apps/server`
already composes exactly this pair of packages: `main.ts:19-41` builds an
`EventStore` from `@ai-dm/memory` and `main.ts:165-170` builds a
`SceneNarrativePort` from `@ai-dm/agents`, both injected into one `TurnPorts`
(`pipeline.ts:229-256`). Embedding-then-writing is one more composition at
the same composition root.

**The event store is a complete template for the vector store.** `EventStore`
(`packages/memory/src/event-store/port.ts:71-100`) is a port with two
implementations — `in-memory.ts` and `postgres.ts` — held to one conformance
suite (`event-store/contract.ts`), selected in `main.ts:34-41` from whether
`DATABASE_URL` is set. `packages/memory/CLAUDE.md` states the rule as law: "A
behaviour only one of them has is a bug in the contract, not a feature."
Episodic memory follows this shape exactly, which is what keeps `pnpm test`
and `pnpm dev` working with no database.

**A tier is four files and a routing entry.** The scene narration tier is
`scene-port.ts` (contract), `scene.ts` (implementation over `AgentRuntime`),
`scene-prompt-text.ts` (versioned English prompt strings, guarded by a
SHA-256 pin test that fails CI if the text changes without a version bump),
and `scene-deterministic.ts` (a template-only implementation of the same
port). `AgentRole` is `"intent" | "tactical" | "narrative"`
(`packages/agents/src/providers/routing.ts:8`) and `ModelRouting` is
`Record<AgentRole, ModelSpec>` (`routing.ts:28`) — a total map, so adding a
role is a compile error until `DEFAULT_MODEL_ROUTING` gains its entry.

**Degradation is the pipeline's job, not the agent's.** `narrationLadder`
(`apps/server/src/core/pipeline.ts:390-437`) takes a primary stream, a
deadline, and a fallback thunk, and handles two failure shapes: nothing
arrived (`source: "deterministic"`) and a truncated sentence (`source:
"completed"`, ellipsis seam then fallback). `packages/agents/CLAUDE.md`
states the division: "the agent itself never falls back."

**`LanguageModelPort` is the wrong home for an embedding call.** Its three
methods (`providers/port.ts:50-59`) all take prompt-shaped requests
(`LayeredPrompt`, tool name, tool description); two of `AdapterErrorCode`'s
four values (`no_tool_call`, `schema_validation_failed`,
`providers/errors.ts:18-19`) are meaningless for an embedding; and
`StreamChunk`'s union has no embedding-shaped case. It also has two
implementers (`createVercelPort`, `createFakePort`), so a fourth method is a
breaking change to both for no shared behaviour.

**Prompt caching constrains where the memory block goes.** `LayeredPrompt`
has three tiers (`providers/prompt.ts:12-16`); `static` and `semiStatic` are
concatenated into the cached system message and `dynamic` becomes the user
message (`prompt.ts:48-63`). `packages/agents/CLAUDE.md`: "Don't interleave
dynamic content into the static prefix — it breaks prompt caching."

**Cost is a lower bound today, and knowingly so.** `TokenUsage`
(`providers/usage.ts:4-8`) is `{ promptTokens, completionTokens, totalTokens }`
with no cache field; `vercel.ts:299-309` passes the AI SDK's usage through
verbatim, and Anthropic's `input_tokens` excludes both
`cache_read_input_tokens` and `cache_creation_input_tokens`. The only pricing
table lives in `tools/sim/src/pricing.ts`, which `apps/server` may not depend
on. `costIsUnderreported` (`tools/sim/src/run/report.ts:78,183-185`) exists
to say so out loud. `MetricsPort` (`pipeline.ts:197-224`) has one record
method per existing tier, `IntentCallMetrics` being "the third model tier
§4.7 calls out as unreportable by construction" (`pipeline.ts:220-223`).

**The library surface this step needs already exists at the pinned
versions**, checked in `node_modules`, not assumed:

- `drizzle-orm@0.39.3` exports `vector(name, { dimensions })` from
  `pg-core/columns/vector_extension/vector` — no driver upgrade needed.
- `ai@4.3.19` exports `embedMany`, whose result carries `embeddings` and
  `usage: EmbeddingModelUsage`. That usage type is `{ tokens: number }` —
  a single count, not the prompt/completion pair `TokenUsage` has.
- `@ai-sdk/openai@1.3.24` types `text-embedding-3-small` as a
  `OpenAIEmbeddingModelId` and accepts a `dimensions` setting.
- `ai` also exports `cosineSimilarity`, which the in-memory store may **not**
  use: `@ai-dm/memory` depends only on `@ai-dm/schemas`, drizzle and
  `postgres` (invariant 5), so it writes its own dot-product over normalized
  vectors. That is five lines, and the conformance suite pins it against the
  Postgres implementation's ordering.

**pgvector is available where it matters.** CI's service image is
`pgvector/pgvector:pg17` (`.github/workflows/ci.yml:14`), matching
`apps/server/docker-compose.yml:4`. The local Homebrew PostgreSQL 18.3 has no
vector extension installed and none available (`pg_available_extensions`
returns no match), but `brew install pgvector` offers 0.8.6 bottled.

**Baseline, measured on this branch at `2a71326`:** 1596 passed / 30 skipped
/ 104 files without a database; 1626 passed / 0 skipped with
`DATABASE_URL=postgres://localhost:5432/aidm_step5_scratch`. `pnpm typecheck`
and `npx eslint packages apps tools` both exit 0.

## Decisions

### 1. The store takes vectors; nothing in `@ai-dm/memory` calls a model

`EpisodicStore` accepts an already-computed embedding on write and an
already-computed query embedding on search:

```ts
export interface EpisodicStore {
  /** Idempotent on (campaignId, sequence): re-indexing a replayed log is a no-op. */
  write(record: EpisodicMemory, embedding: readonly number[]): Promise<void>;
  search(
    campaignId: string,
    queryEmbedding: readonly number[],
    limit: number,
  ): Promise<EpisodicHit[]>;
}
```

This is what resolves §4.6's blocker, and it resolves it by deletion rather
than by placement. `@ai-dm/memory` keeps depending only on `@ai-dm/schemas`;
`@ai-dm/agents` gains no dependency at all; no runtime interface is added to
`@ai-dm/schemas` to be shared between them. The composition happens where
composition already happens — `apps/server` embeds through the agents package
and writes through the memory package, exactly as `main.ts` already pairs
`EventStore` with `SceneNarrativePort`.

The alternative considered was defining `EmbeddingPort` in `@ai-dm/schemas`
so both packages could import it and the store could embed internally. It was
rejected on two counts: it puts a non-zod runtime service interface into a
package whose stated job is schemas (invariant 4), and it gives
`@ai-dm/memory` a live network dependency inside a method the conformance
suite has to exercise, which would force either a fake in the suite or an API
key in CI. Vectors in, vectors out keeps the conformance suite pure
arithmetic.

**`packages/memory/CLAUDE.md`'s clause "No LLM calls except embedding
generation for episodic writes" becomes false and must be corrected to "No
LLM calls" outright.** That file carries an uncommitted edit in the main
checkout and is out of scope to touch here; the correction is recorded as a
follow-up in the plan's Global Constraints rather than made.

### 2. `EmbeddingPort` is its own interface, not a fourth `LanguageModelPort` method

In `packages/agents/src/providers/embedding-port.ts`:

```ts
export interface EmbeddingSpec {
  provider: ProviderId;
  modelId: string;
  /** Must equal EMBEDDING_DIMENSIONS — the pgvector column is fixed-width. */
  dimensions: number;
}

export interface EmbeddingOutput {
  vectors: number[][];
  usage: TokenUsage;
}

export interface EmbeddingPort {
  embed(spec: EmbeddingSpec, texts: readonly string[]): Promise<AdapterResult<EmbeddingOutput>>;
}
```

Separate because it shares nothing with the three existing methods but
`AdapterResult`: no `LayeredPrompt`, no tool name, no streaming, no
completion tokens. Adding it to `LanguageModelPort` would break both
implementers and hand every embedding call two error codes that cannot occur.
`AdapterResult`/`AdapterError` are reused as-is — `provider_error` and
`aborted` are exactly the two failure modes an embedding call has.

`TokenUsage` is reused rather than a second usage type invented — `port.ts`
and `errors.ts` deliberately share the one type, and an embedding's cost is
still tokens. The AI SDK reports `EmbeddingModelUsage` as `{ tokens: number }`,
so the adapter maps it exactly one way, and the mapping is part of this
decision rather than left to the implementer:

```ts
{ promptTokens: usage.tokens, completionTokens: 0, totalTokens: usage.tokens }
```

`completionTokens: 0` is truthful, not a placeholder: an embedding call bills
input only.

### 3. Embedding model selection is its own constant, not a fourth `AgentRole`

```ts
export const DEFAULT_EMBEDDING_SPEC: EmbeddingSpec = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  dimensions: EMBEDDING_DIMENSIONS,
};
```

`AgentRole` stays three values. Widening it would force a `ModelSpec` entry
into `DEFAULT_MODEL_ROUTING` whose `temperature`, `maxOutputTokens` and
`reasoningEffort` are all meaningless for an embedding call, and
`resolveModelSpec` would start returning specs that `EmbeddingPort` cannot
accept. `openai` is chosen because it is already a wired `ProviderId` used by
the tactical tier, so no adapter-layer provider work is needed.

### 4. `EMBEDDING_DIMENSIONS` is the one new thing in `@ai-dm/schemas`

The pgvector column is declared `vector(N)` at migration time and the model
returns vectors of length N; a disagreement is a runtime insert failure on a
column width, which is the worst place to discover it. Two packages need the
same integer and `@ai-dm/schemas` is their only common ancestor, so the
constant lives there with the `EpisodicMemory` record schema beside it
(invariant 4 — defined once):

```ts
export const EMBEDDING_DIMENSIONS = 1536;

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
```

Changing the embedding model to one with different dimensions is a migration
plus a full reindex, and Decision 8 makes reindexing cheap on purpose.

### 5. The summary rides on the two events that already close an episode

`EncounterResolvedPayload` and `QuestNodeCompletedPayload` each gain:

```ts
/** English. Optional: a payload written before this step must still load. */
summaryEnglish: z.string().min(1).optional(),
```

Optional, not required, for the reason `campaign.ts:514-517` already gives
about tolerant payload parsing — a log written before this convention existed
must not stop a campaign from loading. An existing event learning to carry
more is the same move step 5 made for `encounter_started`'s board fields and
step 6 made for `world_delta_applied`'s affinity diff; no new event type, no
new member of `GameEvent.type`'s enum.

**`reduce` does not change.** The summary is not campaign state — nothing
projects it, no predicate reads it, and `CampaignState` gains no field. It is
a fact recorded in the log for the indexer to read directly from events. A
step that adds a persisted payload field without touching the fold is the
cheap case, and this is one.

Putting the summary in the log rather than only in the vector table is what
makes the index rebuildable (Decision 8) and keeps invariant 3 intact: the
log remains the source of truth, and `episodic_memories` is a cache over it
in exactly the sense `campaign_snapshots` already is.

### 6. The summarizer is a fourth tier that degrades to a deterministic skeleton

A new `AgentRole`, `"summary"`, and a tier in `packages/agents/src/summary/`
following the scene tier's four-file shape: `port.ts`, `index.ts`,
`prompt-text.ts` (versioned, SHA-256 pinned), `deterministic.ts`.

```ts
export interface SceneSummaryInput {
  kind: "encounter" | "quest_node";
  /** The node card or encounter description. English. */
  contextEnglish: string;
  /** What the engine knows happened: outcome, survivors, effects applied. */
  factsEnglish: readonly string[];
  /** The turn's Hebrew narrations — the interpretive half. */
  recentNarrations: readonly string[];
}

export interface SceneSummaryPort {
  summarize(input: SceneSummaryInput): Promise<string | null>;
}
```

It returns `string | null` rather than throwing or streaming: `null` means
"no usable summary," and the caller substitutes the deterministic one. Not a
stream, because nothing renders a summary to a player token by token.

**The deterministic fallback is assembled from `factsEnglish` alone** — the
outcome, the survivors, the node, and the effects the engine applied — all of
which the pipeline already holds at both call sites. So a summary is always
produced, with or without an API key, and CI needs no provider. This is the
`narrationLadder` bargain applied to a non-streaming call: the model supplies
the interpretive content that makes a memory worth retrieving ("the player
threatened Tobin and he backed down"), and the skeleton guarantees a row
exists regardless.

Rejected: a purely deterministic summarizer with no tier. It would make this
step much smaller, but the retrievable content would collapse to a keyword
line reconstructible with a `WHERE node_id = ...`, and cosine similarity over
it would earn nothing. The interpretive half is the reason episodic memory
exists.

Rejected: a separate `scene_summarized` event appended after the turn. It
keeps the model call off the critical path, but costs a new event type, a new
fold branch, and sequence-conflict handling for a late append racing the
player's next turn — real machinery to dodge a call that happens once per
episode, bounded by a deadline, at a moment when the player is reading a
victory narration.

### 7. Retrieval happens on scene entry, not per turn

The query is the node's `sceneEnglish` card plus the ids of the NPCs present.
Both are static for as long as the campaign stands at that node, so the
retrieved set is cached on `Campaign` beside `recentNarrations` and refreshed
only when the current node changes.

This is the direct answer to §4.7 line 1069's "Embedding calls are a fourth
per-turn cost source": they are not per-turn. A campaign that spends six
turns talking at one node makes one embedding call, not six. Retrieval is
also skipped entirely while an encounter bracket is open — combat narration
does not receive memories (Decision 9), so nothing would read the result.

`limit` is 3. Small because the block is prompt text competing with the scene
card and the glossary for the narrator's attention, and because the authored
world is one town with a six-node arc — a larger k would return the whole
corpus and stop discriminating.

### 8. `episodic_memories` is a derived index, rebuildable from the log

```ts
export const episodicMemories = pgTable(
  "episodic_memories",
  {
    campaignId: text("campaign_id").notNull(),
    sequence: integer("sequence").notNull(),
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

The primary key is the same `(campaignId, sequence)` pair the event log uses,
which makes `write` idempotent: re-indexing a log that has already been
indexed writes the same rows at the same keys. `write` is therefore specified
as an upsert that does nothing on conflict, and rebuilding the index is
"replay the log, re-embed each `summaryEnglish`, write" with no delete pass
and no ordering requirement.

The index is never authority. It holds no fact the log does not already hold,
so a lost or stale `episodic_memories` table costs retrieval quality until a
rebuild and costs correctness nothing. This is the same standing
`campaign_snapshots` has, and it is why `packages/memory/CLAUDE.md`'s "every
projection must be rebuildable by replaying events" is satisfiable here even
though an LLM produced the text: the text is fixed by the log, and only the
embedding is recomputed.

**`CREATE EXTENSION IF NOT EXISTS vector;` is prepended by hand to the
generated `0001` migration.** `drizzle-kit generate` does not emit it, and
without it the `vector` column type fails to create. This does not violate
`packages/memory/CLAUDE.md`'s "never edit applied migrations" — `0001` has
never been applied anywhere at the time it is written. The rule it does bend,
"the SQL is output, never hand-edited," is bent for one line that drizzle-kit
cannot express, and the plan records that line as a required, reviewed
addition rather than a silent one.

### 9. One English memory block, fed by both authored facts and retrieval, scene narration only

`SceneNarrationInput` gains a single field:

```ts
/** What the DM remembers: authored NPC facts and retrieved episodes. English. */
memoryEnglish: readonly string[];
```

Both sources render into it — `affinityOf`'s band and facts for each NPC
present, and the retrieved summaries — because from the narrator's side they
are the same thing: things known about this place and these people that did
not happen this turn. Building two blocks would ask the prompt to care about
a provenance distinction it has no use for.

This is the slot step 6's projection never got. `affinityOf` acquires its
first call site outside the rules engine, and the deterministic half of the
block works with no model, no database and no API key — which also means the
step delivers player-visible value even if every LLM call fails.

It goes in the **`semiStatic`** tier: stable for as long as the campaign
stands at one node, so it belongs with the scene card and the NPC names in
the cached prefix rather than in `dynamic` where it would break caching every
turn. Omitted entirely when empty, following the precedent
`scene.test.ts:39-113` already pins for the NPC section.

**Combat narration (`NarrationInput`) is unchanged.** A fight's narration is
driven by the fight pulse and this turn's beats; a memory of a previous visit
has nothing to add to a hit or a miss, and adding retrieval to the combat
path would put an embedding call inside the loop the 1.5s first-token budget
governs.

### 10. English in, Hebrew out — no third sanctioned payload field

`summaryEnglish` is English, in the log, internal. The summarizer reads
Hebrew narrations as *input* — they are the record of what was actually said
— and emits English, the same direction of travel every other piece of game
state follows. Retrieved summaries reach the narrator in English and are
translated at generation time along with everything else in the prompt.

Invariant 2's two sanctioned Hebrew fields stay two. Step 6's spec declined a
third for NPC facts (its Decision 5) and this step declines a fourth for
summaries on the same reasoning.

### 11. Cost reporting is deferred, and the deferral is instrumented

Fixing the meter — pulling `cache_read_input_tokens` through the adapter and
relocating the pricing table out of `tools/sim` — stays step 11's, as
`PROJECT_PLAN.md:1074-1078` assigns it. This step does not attempt it.

What this step owes instead is that it does not make the meter *silently*
worse. `MetricsPort` gains `recordEmbeddingCall` and `recordSummaryCall`,
following the `IntentCallMetrics` precedent exactly (`pipeline.ts:167-177`),
and both are implemented in `main.ts:109-130`'s existing structured-log
transport. Only `recordEmbeddingCall` is actually called: `indexEpisode` and
`retrieveMemories` wire it end to end. `recordSummaryCall` has no live call
site — `SceneSummaryPort.summarize()` returns only `string | null`,
discarding the `TokenUsage` its own underlying model call receives one layer
down, and widening that port to return `{text, usage}` is out of this step's
scope. When step 11's fix lands, the embedding call site needs no retrofit;
the summary call site still needs that port widened before it can report
anything.

The honest statement, which the plan requires in the relevant doc comments:
the cost meter remains a lower bound, and after this step it has five billed
sources rather than three — intent, tactical and narrative, plus the
summarizer and the embedding call. §4.7 line 1069 counts four because it
omits tactical; the count that matters is that two are added here and neither
is priced.

Note also that Decision 7 makes the embedding call *not* the "fourth
per-turn cost source" §4.7 anticipated. It fires once per node transition,
not once per turn, so the per-turn cost of this step is the summarizer alone
at episode boundaries — which is to say, zero on an ordinary turn.

## What this must not make worse

**Turn latency.** The 1.5s p50 first-narrative-token budget and the 10s hard
turn timeout are unchanged. Summarization happens at episode boundaries only,
under its own deadline, with a fallback that cannot fail. Retrieval happens
on node transitions only, never inside a turn's narration path, and never
during combat.

**Replay identity.** `reduce` is untouched and `CampaignState` gains no
field, so the existing fold-identity tests must keep passing unchanged. The
cross-bracket projection round-trip (`apps/server/src/core/replay.test.ts`)
is the specific test that must not move.

**Invariant 5.** No new dependency edge in any direction. `@ai-dm/memory`
still depends only on `@ai-dm/schemas`; `@ai-dm/agents` gains no dependency
on `@ai-dm/memory`; `web` is untouched.

**The no-database and no-API-key paths.** `pnpm dev` without docker and
`pnpm test` without `DATABASE_URL` must both keep working — in-memory
episodic store, deterministic summaries, and a memory block that still
carries authored facts. A developer with neither Postgres nor a provider key
must see the same campaign work they see today.

**Prompt cache stability.** The memory block goes in `semiStatic`. A
regression that moves it to `dynamic`, or interleaves it into `static`,
breaks caching on every scene turn.

**The skipped-test count is expected to rise without a database, and that is
not a regression.** New Postgres-only episodic tests skip without
`DATABASE_URL`, exactly as the event-store's do. The number to hold is the
*with*-Postgres run: zero skipped.

**Hebrew must not leak into English state, or English into Hebrew output.**
The summarizer consumes Hebrew and emits English; the deterministic
summarizer never sees Hebrew at all. Retrieved English must reach the
narrator as prompt material only, never as narration — the asymmetry
`scene-deterministic.ts:7-12` already documents for `refused` messages.

## Non-goals

**The quest DAG.** §4.6 deferred it out of step 10 entirely and nothing here
changes its status. `quest_nodes` as a table remains unbuilt; this step reads
node ids, never a graph.

**Fixing the cost meter.** Decision 11. Step 11 owns it, and this step's
obligation ends at reporting usage through the existing channel.

**Forgetting, decay, consolidation, or summarizing summaries.** A campaign
that runs long enough for the corpus to need pruning does not exist — the
authored world is one town and a six-node arc. Retrieval by cosine top-3
filtered by campaign is the whole retrieval story until something measurably
outgrows it.

**Semantic deduplication of memories.** Two visits to the same node produce
two rows. Whether that is noise is not answerable without a longer campaign
than exists.

**Party or cross-campaign memory.** ADR-0002 (solo) stands; ADR-0004 makes
`campaignId` the stream key, and every query filters by it. Nothing here
reads another campaign's rows.

**Memory in combat narration.** Decision 9.

**LLM-proposed affinity shifts.** Step 6's spec named this a non-goal and it
stays one — the summarizer describes what happened, it does not propose state
changes. Invariant 1 holds: this tier's output is recorded prose, never a
mutation.

**Env-configurable model routing.** `DEFAULT_EMBEDDING_SPEC` and the new
`summary` routing entry are source-level constants like the three that
precede them; §4.3's config-override TODO is untouched.
