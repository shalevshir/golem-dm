# Provider adapter and `ModelRouting` — design

Roadmap step 6 (`PROJECT_PLAN.md` §4). Exit criteria: mocked-provider tests pass.

## Context

`@ai-dm/agents` is stubs. Three agents — intent, tactical, narrative — need to
reach three different providers through one surface, with the model for each
role chosen by config rather than by code. Step 7 builds the tactical agent on
top of this; step 9 builds the streaming Hebrew narrative agent on it.

The package's own boundary (`packages/agents/CLAUDE.md`) constrains the design:
agents propose and never resolve, prompts and internals are English, and the
cache-stable prefix ordering is load-bearing for the <1.5s first-token budget.

## Non-goals

Deliberately out of scope, and why:

- **The validate → retry → fallback loop.** Step 7 owns it. The adapter is
  single-shot; it reports what happened and lets the caller decide.
- **Prompt content.** Prompts live in `docs/prompts/`. The adapter defines the
  *shape* a prompt must take, never its text.
- **Live API calls.** No test in this package touches a network. Live-model
  legality and quality benchmarks belong in `tools/sim`.
- **Retry/backoff on transport errors.** The AI SDK's `maxRetries` already
  covers this; wrapping it would hide it.

## Module layout

`packages/agents/src/providers/`, one purpose per file:

| File | Contents |
|---|---|
| `routing.ts` | `AgentRole`, `ProviderId`, `ModelSpec`, `ModelRouting`, `DEFAULT_MODEL_ROUTING` |
| `errors.ts` | `AdapterErrorCode`, `AdapterError`, `AdapterResult`, constructors |
| `prompt.ts` | `LayeredPrompt` and `assemblePrompt` |
| `port.ts` | `LanguageModelPort` and its request/response types |
| `vercel.ts` | `createVercelPort` — the only file that imports the AI SDK |
| `runtime.ts` | `createAgentRuntime` — resolves role → `ModelSpec`, delegates |
| `tool-schema.ts` | `toolJsonSchema` over `zod-to-json-schema` |
| `testing/fake-port.ts` | Scripted `LanguageModelPort` double, reused by step 7 |

## Routing is data

```ts
export type AgentRole = "intent" | "tactical" | "narrative";
export type ProviderId = "anthropic" | "google" | "openai";
export type ReasoningEffort = "low" | "medium" | "high";

export interface ModelSpec {
  provider: ProviderId;
  modelId: string;
  temperature?: number;
  /** Mapped to the AI SDK v4 `maxTokens` call setting. */
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Raw per-provider passthrough, merged last so it can override anything. */
  providerOptions?: Partial<Record<ProviderId, Record<string, JSONValue>>>;
}

export type ModelRouting = Record<AgentRole, ModelSpec>;
```

`provider` is explicit. Inferring it from a model-id prefix would be a hidden
branch on data, and would break the first time a provider serves another's
model.

`DEFAULT_MODEL_ROUTING` matches `PROJECT_PLAN.md` §3:

| Role | Provider | Model | Temperature | Effort |
|---|---|---|---|---|
| intent | google | `gemini-3-flash` | 0 | low |
| tactical | google | `gemini-3-flash` | 0.2 | medium |
| narrative | anthropic | `claude-sonnet-5` | 0.8 | — |

Intent classification is a closed-set label, so temperature 0. Tactical wants
near-determinism with enough variety to avoid identical enemy turns every round.
The tactical row is a *starting point*, not a verdict — step 7 benchmarks Flash
against GPT-5.4 mini and rewrites this line from data.

## Errors are results, not throws

`validateExecuteTurn` returns rejections rather than throwing so a caller sees
every problem at once. The adapter follows it:

```ts
export type AdapterErrorCode =
  | "no_tool_call"             // model returned no structured proposal
  | "schema_validation_failed" // returned one, it does not match the zod schema
  | "provider_error"           // transport, auth, rate limit
  | "aborted";                 // caller's AbortSignal fired (10s turn timeout)

export interface AdapterError {
  code: AdapterErrorCode;
  /** English, safe to put in an `action_rejected` event. */
  message: string;
  /** Present only for schema_validation_failed. */
  issues?: readonly ZodIssue[];
  /** The underlying SDK error, for logging. Never rendered to a player. */
  cause?: unknown;
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdapterError };
```

Four codes, each mapping to a different caller decision: retry with the reason
(`schema_validation_failed`), retry plainly (`no_tool_call`), fall back
(`provider_error`), or abandon the turn (`aborted`).

## Streaming carries errors in-band

A stream cannot return a result up front — it may fail after the third token.
So `streamText` yields a discriminated chunk instead of throwing mid-iteration:

```ts
export type StreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "finish"; text: string; usage: TokenUsage }
  | { type: "error"; error: AdapterError };
```

A consumer that forwards deltas to a WebSocket handles all three in one switch,
and a failed stream is still a well-formed sequence rather than an exception
thrown into an async iterator.

## The cache prefix is a type, not a convention

```ts
export interface LayeredPrompt {
  /** Never varies within a campaign: system rules, Hebrew glossary. Cached. */
  static: readonly string[];
  /** Varies per scene: character sheet, NPC cards. Cached. */
  semiStatic?: readonly string[];
  /** Varies every call: turn state, player utterance. Never cached. */
  dynamic?: readonly string[];
}
```

`assemblePrompt` emits one `CoreSystemMessage` per non-empty cached tier — the
`static` tier first, then `semiStatic` — and puts `dynamic` in a single user
message. Separate system messages rather than one concatenated string is what
makes a cache breakpoint expressible at all: `providerOptions.anthropic.
cacheControl = { type: "ephemeral" }` goes on the *last* cached message, marking
everything before it as the reusable prefix. Providers without an explicit
breakpoint (Google, OpenAI cache by prefix automatically) simply ignore it, and
the ordering still does the work.

Interleaving dynamic content into the cached prefix is the specific mistake that
silently destroys the 90% cache discount, and it is invisible in review when the
prompt is one concatenated string. Separate fields make it a type error instead
of a performance regression nobody notices.

## Port and runtime

```ts
export interface LanguageModelPort {
  generateStructured<T>(spec: ModelSpec, req: StructuredRequest<T>):
    Promise<AdapterResult<StructuredOutput<T>>>;
  generateText(spec: ModelSpec, req: TextRequest):
    Promise<AdapterResult<TextOutput>>;
  streamText(spec: ModelSpec, req: TextRequest): AsyncIterable<StreamChunk>;
}
```

The port takes a resolved `ModelSpec` and knows nothing about roles.
`createAgentRuntime({ routing, port })` is the thin layer that maps role → spec:

```ts
runtime.structured("tactical", req); // -> port.generateStructured(routing.tactical, req)
```

Splitting them means "routing picks the configured model for each role" is
testable against a recording fake with no SDK in the picture, and the SDK
implementation is testable without any notion of roles.

## Vercel implementation

`createVercelPort({ resolveModel })`, where
`resolveModel: (spec: ModelSpec) => LanguageModelV1` defaults to switching on
`spec.provider`. That function is the seam: tests inject `MockLanguageModelV1`
and exercise the real adapter code path with no network and no API keys.

Structured output uses `generateObject({ mode: "tool", schema, schemaName })`.

**Revised during implementation.** The design called for re-validating the
result with our own `schema.safeParse` as defence in depth. A mutation check
showed that branch is unreachable — `generateObject` parses with the same zod
schema, so a second parse can never fail — and no test could be written that
kills it. It was removed rather than kept as untestable code.

What we do own is the *failure* path: the SDK raises both "no tool call" and
"tool call that does not match" as `NoObjectGeneratedError`, and those need
different retries. `TypeValidationError.isInstance(error.cause)` separates them,
and re-parsing `cause.value` recovers the zod issues step 7 quotes back at the
model. That safeParse is exercised and mutation-checked.

### Reasoning effort mapping

`ModelSpec.reasoningEffort` is provider-neutral; each provider expresses it
differently. One exported table, no branching on role:

| Provider | Encoding |
|---|---|
| openai | `providerOptions.openai.reasoningEffort = effort` |
| anthropic | `providerOptions.anthropic.thinking = { type: "disabled" }` for low, else `{ type: "enabled", budgetTokens }` |
| google | `providerOptions.google.thinkingConfig = { thinkingBudget }` |

```ts
export const REASONING_BUDGET_TOKENS: Record<ReasoningEffort, number> =
  { low: 0, medium: 4096, high: 16384 };
```

**These budget numbers are unverified.** They are a plausible starting scale, not
a measured one; step 7's sim benchmark is what should set them. They are
exported as named config precisely so tuning them is a one-line change, and
`ModelSpec.providerOptions` merges last for anyone who needs to override.

## Tool schema from zod

`toolJsonSchema(schema, name)` wraps `zod-to-json-schema` (invariant 4 — no
hand-written JSON schema anywhere). The port passes the zod schema itself to
`generateObject`, so this exists for the callers that need the literal
definition: `tools/sim` recording which schema version a model was benchmarked
against, and the server logging it alongside `action_rejected` events. Its
round-trip test copies the pattern in `packages/schemas/src/index.test.ts:82`.

Adds `zod` and `zod-to-json-schema` to the package's dependencies.

## Testing

No network, ever. Two layers:

1. **Behaviour, against `testing/fake-port.ts`** — routing resolves the right
   `ModelSpec` per role; prompt layers assemble in order; results and errors
   propagate. Fast, decoupled from the SDK.
2. **SDK wiring, against `MockLanguageModelV1` from `ai/test`** — the real
   `createVercelPort` code path. Proves the tool schema reaches the model, that
   call settings and provider options are built correctly, that a mismatched
   tool call becomes `schema_validation_failed`, and that streaming yields
   deltas in order. `simulateReadableStream` from `ai` drives the stream cases.

Minimum coverage, from the task brief: routing picks the configured model per
role; tool-call output validates against the zod schema; a malformed tool call
surfaces as a typed error rather than a throw-string; streaming yields tokens in
order.

## Verified SDK facts

Checked against the installed versions rather than recalled, because several
differ from the v5 API:

- `ai@4.3.19` — `CallSettings.maxTokens` (**not** `maxOutputTokens`),
  `abortSignal`, `maxRetries`, `temperature`.
- `generateObject` accepts `mode: "auto" | "json" | "tool"`, `schemaName`,
  `schemaDescription`.
- `TextStreamPart` is `{ type: "text-delta"; textDelta }`,
  `{ type: "finish"; finishReason; usage }`, `{ type: "error"; error }`.
- `LanguageModelUsage` is `{ promptTokens, completionTokens, totalTokens }`.
- `LanguageModelV1`, `APICallError`, `NoObjectGeneratedError`,
  `TypeValidationError` are all re-exported from `ai`.
- `MockLanguageModelV1` and `simulateReadableStream` come from `ai/test`.
- `CoreSystemMessage` accepts `providerOptions`, and the Anthropic provider
  translates `providerOptions.anthropic.cacheControl` into `cache_control` —
  which is what makes the prompt-tier breakpoint above implementable.
- `@ai-sdk/anthropic@1.2.12` — `thinking: { type: "enabled" | "disabled";
  budgetTokens?: number }`.
- `@ai-sdk/google@1.2.22` — `thinkingConfig: { thinkingBudget?: number | null }`.
- `@ai-sdk/openai@1.3.24` — `reasoningEffort?: "low" | "medium" | "high"`.

## Breaking change

The existing `ModelRouting` — three `string` fields — is replaced by
`Record<AgentRole, ModelSpec>`. Nothing consumes it yet, so the change is free
now and would not be later.
