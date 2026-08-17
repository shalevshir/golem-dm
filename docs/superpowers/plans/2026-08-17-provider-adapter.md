# Provider Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@ai-dm/agents` one provider-agnostic surface over the Vercel AI SDK, with per-role model selection as config, so steps 7 and 9 can build the tactical and narrative agents on it.

**Architecture:** A narrow `LanguageModelPort` (structured / text / stream) that agents depend on, a `ModelRouting` record mapping role → `ModelSpec`, a thin `createAgentRuntime` binding the two, and a single `vercel.ts` that is the only file importing the SDK. Errors come back as discriminated results, never thrown strings.

**Tech Stack:** TypeScript 5.7 strict ESM, `ai@4.3.19`, `@ai-sdk/anthropic|google|openai`, zod 3, `zod-to-json-schema`, Vitest 3.

Full design: [`docs/superpowers/specs/2026-08-17-provider-adapter-design.md`](../specs/2026-08-17-provider-adapter-design.md).

## Global Constraints

- Architectural invariants 1–6 in `CLAUDE.md` — agents propose, never resolve; no dice, damage math, or state mutation in this package.
- English only in all code, comments, prompts, logs, and tool schemas. Hebrew appears only in narrative-agent *output*, which this step does not produce.
- Dependency direction `schemas ← rules-engine ← agents ← server`. Nothing here may import from `apps/server`.
- No live API calls in any test. `MockLanguageModelV1` and hand-written fakes only.
- Never hand-write a JSON schema — derive from zod via `zod-to-json-schema` (invariant 4).
- ESLint `strictTypeChecked`: no `[...str]` spread, no `_`-prefixed unused params, type dynamic lookups as `Record<string, T | undefined>` rather than casting `keyof typeof`.
- Node 22, ESM, `.js` extensions on all relative imports.
- Tests colocated as `*.test.ts`.
- AI SDK v4 call setting is `maxTokens`, **not** v5's `maxOutputTokens`.

---

### Task 1: Dependencies and routing config

**Files:**
- Modify: `packages/agents/package.json` (add `zod`, `zod-to-json-schema`)
- Create: `packages/agents/src/providers/routing.ts`
- Test: `packages/agents/src/providers/routing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentRole = "intent" | "tactical" | "narrative"`; `ProviderId = "anthropic" | "google" | "openai"`; `ReasoningEffort = "low" | "medium" | "high"`; `interface ModelSpec { provider, modelId, temperature?, maxOutputTokens?, reasoningEffort?, providerOptions? }`; `type ModelRouting = Record<AgentRole, ModelSpec>`; `const DEFAULT_MODEL_ROUTING: ModelRouting`; `resolveModelSpec(routing: ModelRouting, role: AgentRole): ModelSpec`.

- [ ] **Step 1: Add deps**

```bash
cd /Users/shalev/Desktop/ai-dm-scaffold
pnpm --filter @ai-dm/agents add zod@^3.24.0 zod-to-json-schema@^3.24.0
```

- [ ] **Step 2: Write failing tests** — `DEFAULT_MODEL_ROUTING` matches `PROJECT_PLAN.md` §3 exactly (narrative is `anthropic`/`claude-sonnet-5`; intent and tactical are `google`/`gemini-3-flash`; intent temperature 0 and effort `low`); `resolveModelSpec` returns the spec for each role; a caller-supplied routing overrides the default per role.

- [ ] **Step 3: Run, verify fail** — `pnpm --filter @ai-dm/agents test`, expect "Cannot find module ./routing.js".

- [ ] **Step 4: Implement `routing.ts`**

- [ ] **Step 5: Run, verify pass**

- [ ] **Step 6: Commit** — `feat(agents): model routing config keyed by agent role`

---

### Task 2: Result and error types

**Files:**
- Create: `packages/agents/src/providers/errors.ts`
- Test: `packages/agents/src/providers/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AdapterErrorCode = "no_tool_call" | "schema_validation_failed" | "provider_error" | "aborted"`; `interface AdapterError { code, message, issues?, cause? }`; `type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: AdapterError }`; helpers `ok<T>(value: T)`, `fail(code, message, extra?)`.

- [ ] **Step 1: Write failing tests** — `ok`/`fail` build correctly discriminated values; `fail` carries zod issues when given them; narrowing on `.ok` gives the right type (compile-time, asserted via a runtime branch).

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `errors.ts`**

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit** — `feat(agents): discriminated adapter results with stable error codes`

---

### Task 3: Layered prompt assembly

**Files:**
- Create: `packages/agents/src/providers/prompt.ts`
- Test: `packages/agents/src/providers/prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface LayeredPrompt { static: readonly string[]; semiStatic?: readonly string[]; dynamic?: readonly string[] }`; `assemblePrompt(prompt: LayeredPrompt, provider: ProviderId): CoreMessage[]`.

This is the cache-prefix rule made mechanical. Tests to write:

```ts
it("orders static before semi-static before dynamic", () => {
  const messages = assemblePrompt(
    { static: ["RULES"], semiStatic: ["SHEET"], dynamic: ["TURN"] },
    "anthropic",
  );
  expect(messages.map((m) => m.role)).toStrictEqual(["system", "system", "user"]);
  expect(messages.map((m) => m.content)).toStrictEqual(["RULES", "SHEET", "TURN"]);
});

it("keeps dynamic content out of the cached system prefix", () => {
  const messages = assemblePrompt(
    { static: ["RULES"], dynamic: ["TURN"] },
    "anthropic",
  );
  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join();
  expect(systemText).not.toContain("TURN");
});

it("marks the last cached tier as the Anthropic cache breakpoint", () => {
  const messages = assemblePrompt(
    { static: ["RULES"], semiStatic: ["SHEET"], dynamic: ["TURN"] },
    "anthropic",
  );
  expect(messages[0]?.providerOptions).toBeUndefined();
  expect(messages[1]?.providerOptions).toStrictEqual({
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
});

it("puts the breakpoint on the static tier when there is no semi-static tier", ...);
it("omits cache control for providers that cache by prefix automatically", ...); // google, openai
it("omits empty tiers rather than emitting blank messages", ...);
```

- [ ] **Step 1: Write the failing tests above**
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement `prompt.ts`**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat(agents): layered prompt assembly with cache-stable ordering`

---

### Task 4: Port types and the test double

**Files:**
- Create: `packages/agents/src/providers/port.ts`
- Create: `packages/agents/src/providers/testing/fake-port.ts`
- Test: `packages/agents/src/providers/testing/fake-port.test.ts`

**Interfaces:**
- Consumes: `ModelSpec` (Task 1), `AdapterResult` (Task 2), `LayeredPrompt` (Task 3).
- Produces:
  - `interface StructuredRequest<T> { prompt: LayeredPrompt; schema: ZodType<T>; toolName: string; toolDescription: string; abortSignal?: AbortSignal }`
  - `interface TextRequest { prompt: LayeredPrompt; abortSignal?: AbortSignal }`
  - `interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number }`
  - `interface StructuredOutput<T> { value: T; usage: TokenUsage }`
  - `interface TextOutput { text: string; usage: TokenUsage }`
  - `type StreamChunk = { type: "text-delta"; text: string } | { type: "finish"; text: string; usage: TokenUsage } | { type: "error"; error: AdapterError }`
  - `interface LanguageModelPort { generateStructured, generateText, streamText }`
  - `createFakePort(script)` recording every `(spec, request)` call it receives on `.calls`, replaying scripted results.

The fake is exported from the package because step 7's tactical-agent tests need the same double.

- [ ] **Step 1: Write failing tests** — the fake records the `ModelSpec` it was called with; replays a scripted structured result; replays a scripted stream in order; throws a clear error when the script is exhausted (a test-double bug should be loud).
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement `port.ts` then `testing/fake-port.ts`**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat(agents): language model port and scripted test double`

---

### Task 5: Role → model runtime

**Files:**
- Create: `packages/agents/src/providers/runtime.ts`
- Test: `packages/agents/src/providers/runtime.test.ts`

**Interfaces:**
- Consumes: all of Tasks 1–4.
- Produces: `createAgentRuntime({ routing, port }): AgentRuntime` where `AgentRuntime` is `{ structured<T>(role, req), text(role, req), stream(role, req) }`.

This is where the brief's "routing picks the configured model per role" is proven:

```ts
it("calls the model configured for each role", async () => {
  const port = createFakePort({ /* structured results */ });
  const runtime = createAgentRuntime({ routing: DEFAULT_MODEL_ROUTING, port });

  await runtime.structured("tactical", tacticalRequest);

  expect(port.calls[0]?.spec.modelId).toBe("gemini-3-flash");
  expect(port.calls[0]?.spec.provider).toBe("google");
});

it("honours a custom routing over the default", async () => {
  const routing = { ...DEFAULT_MODEL_ROUTING,
    tactical: { provider: "openai", modelId: "gpt-5.4-mini" } } satisfies ModelRouting;
  ...
  expect(port.calls[0]?.spec.modelId).toBe("gpt-5.4-mini");
});

it("routes narrative to the streaming-capable model", ...);
it("passes the caller's request through untouched", ...);
```

- [ ] **Step 1: Write the failing tests above**
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement `runtime.ts`**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat(agents): bind agent roles to their configured models`

---

### Task 6: Tool schema export

**Files:**
- Create: `packages/agents/src/providers/tool-schema.ts`
- Test: `packages/agents/src/providers/tool-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toolJsonSchema(schema: ZodType, name: string): JsonSchema7Type`.

Round-trip test copies `packages/schemas/src/index.test.ts:82`, using the real `ExecuteTurn` schema so the assertion covers the tool the tactical agent will actually call.

- [ ] **Step 1: Write failing test** — `toolJsonSchema(ExecuteTurn, "ExecuteTurn")` has `$ref` `#/definitions/ExecuteTurn` and its serialisation contains `tacticalRationaleEnglish` and `mainAction`.
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement `tool-schema.ts`**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat(agents): export tool JSON schemas derived from zod`

---

### Task 7: Vercel AI SDK implementation

**Files:**
- Create: `packages/agents/src/providers/vercel.ts`
- Test: `packages/agents/src/providers/vercel.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `createVercelPort(options?: { resolveModel?: (spec: ModelSpec) => LanguageModelV1 }): LanguageModelPort`; `resolveLanguageModel(spec): LanguageModelV1`; `callSettingsFor(spec)`; `providerOptionsFor(spec)`; `REASONING_BUDGET_TOKENS: Record<ReasoningEffort, number>`.

The only file importing the SDK. Tests drive the real code path with `MockLanguageModelV1` from `ai/test`, injected through `resolveModel` — no network, no API keys.

Cases to cover:

```ts
it("returns the parsed object for a well-formed tool call", ...);          // ok: true, value matches
it("surfaces a schema-violating tool call as a typed error", async () => {
  // model returns { actorId: 123 } — actorId must be a string
  const result = await port.generateStructured(spec, executeTurnRequest);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("schema_validation_failed");
  expect(result.error.issues?.[0]?.path).toContain("actorId");
  expect(typeof result.error.message).toBe("string");   // typed error, not a thrown string
});
it("surfaces a missing tool call as no_tool_call", ...);
it("surfaces a provider failure as provider_error", ...);                  // doGenerate rejects with APICallError
it("surfaces an aborted call as aborted", ...);                            // pre-aborted AbortSignal
it("maps maxOutputTokens onto the SDK maxTokens setting", ...);
it("encodes reasoning effort per provider", ...);                          // 3 providers, table-driven
it("merges ModelSpec.providerOptions last", ...);
it("streams text deltas in order", async () => {
  const chunks = [];
  for await (const chunk of port.streamText(spec, textRequest)) chunks.push(chunk);
  expect(chunks.filter((c) => c.type === "text-delta").map((c) => c.text))
    .toStrictEqual(["Hello", " ", "world"]);
  expect(chunks.at(-1)?.type).toBe("finish");
});
it("ends a failed stream with an error chunk rather than throwing", ...);
```

- [ ] **Step 1: Write the failing tests above**
- [ ] **Step 2: Run, verify fail**
- [ ] **Step 3: Implement `vercel.ts`**
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat(agents): Vercel AI SDK implementation of the language model port`

---

### Task 8: Package wiring and full verification

**Files:**
- Modify: `packages/agents/src/providers/index.ts` (re-export the modules; the old three-string `ModelRouting` stub goes away here)
- Modify: `packages/agents/package.json` (drop `--passWithNoTests`, now that tests exist)
- Modify: `PROJECT_PLAN.md` (step 6 row → done; refresh "Status as of")

**Interfaces:**
- Consumes: all tasks.
- Produces: the package's public surface via `packages/agents/src/index.ts`.

- [ ] **Step 1: Re-export from `providers/index.ts`, delete the stub interface**
- [ ] **Step 2: Full verification**

```bash
corepack enable && pnpm typecheck && pnpm lint && pnpm test
```

Expected: all three green; agents test count > 0.

- [ ] **Step 3: Update `PROJECT_PLAN.md` step 6 status**
- [ ] **Step 4: Commit** — `feat(agents): land the provider adapter (roadmap step 6)`

---

## Self-Review

**Spec coverage:** routing → T1; errors/results → T2; layered prompt → T3; port + fake → T4; runtime → T5; tool schema → T6; Vercel impl, reasoning mapping, streaming → T7; breaking replacement of the old `ModelRouting` stub → T8. The spec's four brief-mandated test cases land in T5 (routing per role), T7 (schema validation, typed malformed-call error, stream ordering).

**Placeholders:** none — every task names exact files and the tests carry real assertions.

**Type consistency:** `ModelSpec` field is `maxOutputTokens` throughout, mapped to the SDK's `maxTokens` only inside `callSettingsFor` (T7). `StreamChunk` uses `text`, not the SDK's `textDelta`; the translation happens in `vercel.ts`. `AdapterResult` is `{ ok, value | error }` in every task.
