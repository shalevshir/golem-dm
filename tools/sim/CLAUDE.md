# @ai-dm/sim

## Purpose & boundary

Headless combat simulator: runs the tactical agent against scripted enemies on fixture maps with a seeded RNG — no UI, no server. This is where live-model benchmarking happens (it's the only package allowed to make real API calls in bulk).

## What it measures (per model, per scenario)

- Tool-call legality rate (validated on first try / after retry / fallback used)
- Tactical quality vs scripted baseline (win rate, damage per round, non-attack
  action count — Dodge is inert in this harness, so it is counted separately
  rather than folded silently into win rate)
- Latency p50/p95 per turn; tokens and $ per turn (cached vs uncached)

Output: one JSON + markdown report per run under `runs/` (gitignored). Use these numbers to set `ModelRouting` — never pick models by vibes.

## Rules

- Seeded RNG everywhere; a run must be exactly reproducible given (seed, model, scenario).
- Scenarios are fixtures in `src/scenarios/` validated against `@ai-dm/schemas`.
- Keep a no-API "smoke" mode (mocked provider) that runs in CI.

## Commands

```bash
pnpm sim                       # from repo root
pnpm --filter @ai-dm/sim test | typecheck
```

## Modes

`pnpm sim` is a **smoke run**: a scripted port with a seeded defect schedule, no
network, no API key. It verifies the pipeline and the metric arithmetic, and
says nothing about any real model's tactical quality.

| Flag          | Values                                                              | Default                 |
| ------------- | ------------------------------------------------------------------- | ----------------------- |
| `--mode`      | `probe` \| `encounter` \| `both` \| `narrative`                     | `both`                  |
| `--live`      | absent \| present                                                   | absent                  |
| `--arms`      | comma-separated arm ids from `src/config.ts`, **requires `--live`** | every arm when `--live` |
| `--seeds`     | comma-separated integers                                            | `1,2,3,4,5`             |
| `--scenarios` | comma-separated scenario ids                                        | all four                |
| `--review-sheet` | absent \| present, **requires `--mode narrative`**               | absent                  |

An unrecognised `--flag` (including a singular typo like `--scenario` or `--seed`)
is rejected with the list of known flags, rather than silently falling through to
the default matrix. `--arms` without `--live` is rejected too: the smoke run
always benchmarks the scripted arm regardless of which id you name, so honouring
the flag there would either do nothing or mislabel every record with a model
that was never called.

Probe mode is the paired comparison that picks the model: every arm sees
byte-identical boards, derived from the scripted control encounter. Encounter
mode plays the fight out and is the only source of win rate.

`--mode narrative` is its own thing, not a third value on the tactical matrix
above: it measures the narrative agent alone (time-to-first-token, output
discipline, cost — see `src/live/narrative.ts`'s header comment for why it is
scored separately from the tactical call that precedes a hostile turn), always
against the `narrative` role in `DEFAULT_MODEL_ROUTING`, never an arm from
`src/config.ts`. `--arms` is rejected in combination with it for the same
reason it is rejected without `--live` above. `--live` still only swaps the
port — `--mode narrative` alone runs the same benchmark against a scripted one.
`--review-sheet` is rejected outside `--mode narrative` for the same reason
`--arms` is rejected outside it: it prints `src/live/review-sheet.ts`'s
`renderReviewSheet` output (the run's own narration samples plus the SRD
name/glossary/condition tables) to stdout, separate from the `Wrote <path>`
lines on stderr, so redirecting `pnpm --silent sim --live --mode narrative
--review-sheet` to a file captures only the sheet.

## Live benchmarking

**Wired, and every candidate is now either confirmed working end-to-end or
blocked by something outside this repo.** `--live` is plumbed to a real
provider (`tools/sim/src/live/run.ts`'s `runLive`). `DEFAULT_MODEL_ROUTING.tactical`
and `REASONING_BUDGET_TOKENS` are still unmeasured placeholders — no full
benchmark matrix has been run, only single-arm probes while debugging each
candidate's live wiring (2026-08-18). Firing a live run is the operator's
call, made by exporting keys and passing `--live` — nothing in this package
does that on its own.

**Per-candidate status (2026-08-18):**

| Candidate                        | Status                       | Notes                                                                                                                                                                                         |
| -------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-sonnet-5` (anthropic)    | ✅ confirmed working         | 30/30 probe turns at `@low`, `@medium`, `@high`, zero `adapterErrorCodes`, real tokens. Fixed by dropping the `thinking` provider option and stripping `temperature` on the wire — see below. |
| `gpt-5.4-nano` (openai)          | ✅ confirmed working         | 10/10 probe turns, zero `adapterErrorCodes`. Needed **two** fixes: the Responses API _and_ `strictSchemas: false` — see below.                                                                |
| `gpt-5.4-mini` (openai)          | ✅ confirmed working         | 10/10 probe turns at `@low` and `@high`, zero `adapterErrorCodes`. Same two fixes as `gpt-5.4-nano`.                                                                                          |
| `gemini-3.1-flash-lite` (google) | ⛔ blocked outside this repo | The API key's GCP project has a hard-zero request quota. Nothing in this package can fix it; needs an operator action on the project — see below.                                             |

**A correction to the previous entry for `gpt-5.4-nano`.** It was recorded here
as "confirmed working" after the Responses-API fix. That confirmation came from
a raw-SDK `generateObject` probe using a _hand-written_ schema, not from the sim
with the real `ExecuteTurn` schema — and through the sim it failed 10/10 turns.
Treat a raw-SDK probe as evidence about transport only; a candidate is not
confirmed until a `--live` run writes a report with empty `adapterErrorCodes`.

### OpenAI needs the Responses API _and_ non-strict schemas

Two independent 400s, both confirmed live, both fixed in
`packages/agents/src/providers/vercel.ts`:

1. **Chat Completions rejects the call shape.** `Function tools with
reasoning_effort are not supported for gpt-5.4-nano in
/v1/chat/completions. To use function tools, use /v1/responses or set
reasoning_effort to 'none'.` `resolveLanguageModel` calls
   `openai.responses(modelId)` instead of the default `openai(modelId)` for
   every openai call, unconditionally — every call this repo makes combines
   function tools with a reasoning effort.
2. **Strict structured outputs reject `ExecuteTurn`.** The SDK defaults
   `strictSchemas` to `true`, which makes OpenAI validate the tool schema
   against its strict subset and fail before the model is reached, on two
   counts: `Invalid schema for function 'execute_turn': [{'type':
'integer'}, {'type': 'integer'}] is not of type 'object', 'boolean'`
   (the `Tile` tuple in `@ai-dm/schemas`, which strict mode cannot express)
   and `'required' is required to be supplied and to be an array including
every key in properties` (strict mode forbids optional properties, and
   most of `ExecuteTurn` is optional). `providerOptionsFor` now sets
   `strictSchemas: false` on every openai call.

Turning strict mode off does **not** weaken the tool-call guarantee: it is a
provider-side schema check, not the forced tool choice. `tool_choice` still
forces `execute_turn`, and invariant 1 keeps validation on our side — the port
parses every tool call with the same zod schema and reports a violation as
`schema_validation_failed` with the zod issues the tactical retry quotes back.

Rewriting the schema was tried first and rejected: `prefixItems` is refused
outright (`array schema missing items`), and satisfying strict mode would
mean marking every optional field required — a lossy change to the tool
contract, to buy a validator we do not depend on.

### Anthropic: `claude-sonnet-5` is an adaptive-thinking model

**Fixed. The previous "structurally blocked" verdict was wrong** — it read two
real error messages correctly but drew the wrong conclusion from them, because
it diagnosed from error text alone instead of the provider's docs.

The docs' per-model table is decisive: `claude-sonnet-5` supports **adaptive
thinking only** and rejects `thinking: {type: "enabled"}` with a 400. And on
tool use: "Adaptive thinking, including on models where thinking is on by
default, supports forced tool use." The forced-tool-choice conflict is a
constraint on _manual extended thinking_, which this model does not have.

So both observed failures came from the same mistake — sending a `thinking`
option at all:

- `@medium` / `@high` sent `thinking: {type:"enabled", budgetTokens}`, which
  collided with `generateObject`'s forced tool choice: `Thinking may not be
enabled when tool_choice forces tool use.`
- `@low` sent `thinking: {type:"disabled"}`, which suppressed nothing relevant
  and left the SDK's forced `temperature: 0` to be rejected: `` `temperature`
is deprecated for this model. ``

The fix, in `packages/agents/src/providers/vercel.ts`:

- `providerOptionsFor` emits **nothing** for anthropic. With no `thinking` key
  on the request, the model uses its default adaptive thinking, and the forced
  tool call is legal.
- `anthropicBodyFor` rewrites the outgoing request body: it deletes
  `temperature` and adds `output_config: {effort}`. Both are unavoidable at
  this layer. `ai@4.3.19` substitutes `temperature: 0` into every request that
  omits one (`// TODO v5 remove default 0 for temperature` in
  `prepareCallSettings`), so `callSettingsFor` not sending one cannot help;
  and `@ai-sdk/anthropic@1.2.12`'s provider-options schema accepts only
  `thinking`, so there is no supported way to pass an effort level. The
  neutral `ReasoningEffort` names are Anthropic's own effort names, so they
  pass through unmapped.
- `resolveLanguageModel` builds a per-spec client via `createAnthropic({fetch})`
  to carry that rewrite. The key is still read lazily, through the SDK's header
  thunk — resolving a model touches no credential.

One consequence worth knowing: anthropic no longer consults
`REASONING_BUDGET_TOKENS` (only google does). Its three effort arms are now
distinguished by `output_config.effort`, not a token budget.

### Google: the project had a hard-zero quota (resolved 2026-08-19)

**Resolved as of 2026-08-19.** The operator requested/fixed the quota on the
GCP project side (the exact console action taken isn't recorded here — this
session only has the "before" and "after"). Live evidence: the full 12-arm
7b benchmark run that day shows `gemini-3.1-flash-lite@low`/`@medium`/`@high`
completing probe and encounter turns cleanly, `outcome: model`, no
`provider_error` in the stream. One call took 131,813ms against a normal
~2,000–6,000ms range — a genuine latency outlier, not a failure (`1 attempt`,
succeeded) — worth keeping an eye on in the aggregated report's `p95Ms` and
whether it's a one-off or a pattern specific to this provider, but it is not
the quota problem below. The blow-by-blow diagnosis is kept as-is beneath this
note because the same symptom (`provider_error` hiding a real cause) is
exactly what this file exists to help the next person avoid re-diagnosing
from scratch.

`gemini-3.1-flash-lite` is a real, current model id — the config is correct
and the wiring is almost certainly fine. It cannot be confirmed, because the
API key's project cannot make **any** Generative Language API call:

```json
{
  "quota_limit": "ApiRequestsPerMinutePerProjectPerRegion",
  "quota_limit_value": "0",
  "quota_location": "europe-west1",
  "consumer": "projects/1045577149355"
}
```

`quota_limit_value: "0"` is a zero allowance, not exhaustion from our own
traffic — and it is returned for a bare `ListModels`, the cheapest metadata
call there is, so no amount of backing off or narrowing a run will help. This
also revises the earlier note here that blamed per-minute quota _exhaustion_;
the limit was never above zero.

Checked in Cloud Console for project `1045577149355`
(`gen-lang-client-0401551437`, "Gemini Project"), all of which rule out the
usual causes:

- Gemini API (`generativelanguage.googleapis.com`) — **Enabled**.
- Billing — **linked**, to an active paid account, ₪0.00 spend.
- 30 days of API traffic — **429s only**. Nothing has ever succeeded.

That leaves the quota itself, which is an operator action on the GCP project,
not a code change: request an increase for
`ApiRequestsPerMinutePerProjectPerRegion` on
`generativelanguage.googleapis.com` (region `europe-west1`), or check the
Gemini API tier for that project in AI Studio. Until then, exclude the google
arms from live runs with `--arms`.

**Historical — as of 2026-08-18, this was NOT actually resolved, despite an
even earlier pass of this file claiming it was.** Kept verbatim below because
it is the reason the 2026-08-19 resolution note above trusts a live run over
a console screenshot: the project was Tier 1 prepay, and the Cloud Console
Quotas page showed the region's quota as unlimited — but a live call with
`maxRetries: 0` still got back the exact same `quota_limit_value: "0"` for
`ApiRequestsPerMinutePerProjectPerRegion` / `europe-west1` shown above.
Console and live enforcement disagreeing was real; what "unlimited" was
actually describing was some other, more general quota view, not this
specific per-region row. Confirmed distinct from the two schema bugs below —
both were fixed on 2026-08-18 and neither changed this error at all, proving
it was never the cause of the earlier `provider_error` reports either.

The fix (as understood at the time, before the 2026-08-19 resolution above)
was requesting an increase on the *exact* row: Cloud Console → IAM & Admin →
Quotas, filtered to Service = Generative Language API AND Dimension =
region:europe-west1, metric `ApiRequestsPerMinutePerProjectPerRegion` — not
the aggregate/tier-level view. This is an operator action tied to the project
owner's Google identity; it cannot be done from this repo or CLI.

### Google: tuple-schema incompatibility (separate from the quota above)

Once the quota was past, live calls to `gemini-3.1-flash-lite` still failed —
a 400, not a 429:

```
Invalid JSON payload received. Unknown name "items" at
'tools.function_declarations[0].parameters.properties[1].value.items.properties[0].value':
Proto field is not repeating, cannot start list.
```

Gemini's function-declaration schema has no representation for JSON Schema's
tuple form (`items` as an array of per-position schemas).
`@ai-sdk/google@1.2.22` does not paper over this —
`convertJSONSchemaToOpenAPISchema` maps an array `items` straight through —
and `zod-to-json-schema` emits exactly that shape for
`Tile = z.tuple([z.number().int(), z.number().int()])`, used by
`ExecuteTurn.movement[].destinationTile` and `.mainAction.targetTile`. Neither
anthropic nor openai has this problem; it is google-only.

Fixed in `packages/agents/src/providers/vercel.ts`:
`collapseTupleItemsForGoogle` rewrites the JSON Schema handed to google (only)
so `items` is never an array, and `googleCompatibleSchema` wraps it with
`jsonSchema()` while `validate` still parses with the real `ExecuteTurn` zod
schema — so a response is held to the same contract on every provider; only
the wire-format tool declaration google sees is reshaped. Covered by
`vercel.test.ts`'s `"sends google a schema with no tuple-style items array"`
test, which inspects the mock model's captured `mode` rather than requiring a
live call.

**This fix alone was not enough.** With it in place, live calls still failed
as `provider_error` — same code, but every attempt now took 6.5–6.8s instead
of failing instantly, which was the tell that the failure had moved past
client-side schema rejection into an actual round trip. `zodToJsonSchema`
deduplicates repeated subschemas behind a `$ref` by default, and `Tile` is
used twice in `ExecuteTurn` (`destinationTile` and `targetTile`) — so the
second occurrence became `{"$ref": "#/properties/movement/items/properties/
destinationTile"}` rather than an inline schema. Gemini's function-declaration
schema is not general JSON Schema; it has no `$ref` support at all.
`googleCompatibleSchema` now calls `zodToJsonSchema(schema, { $refStrategy:
"none" })` to force full inlining. Covered by `vercel.test.ts`'s `"sends
google a fully inlined schema"` test, same mock-model approach.

Both bugs were invisible from a sim report — `provider_error` looked
identical before and after the tuple fix landed. The only way either was
diagnosed was printing the actual schema sent (`collapseTupleItemsForGoogle`
called directly against `zodToJsonSchema(ExecuteTurn)`) and the actual
`APICallError.responseBody`, per the throwaway-script method below. Neither
would have been caught by unit tests against a mocked provider alone — those
only started failing once written specifically to inspect the serialized
schema shape, after the live failure pointed at it.

The diagnostic path was the one this file already prescribes below: a
throwaway script under `packages/agents/` calling `generateObject` directly
and printing `APICallError.responseBody` is what surfaced this — the sim's
`provider_error` code alone would have looked identical to the quota failure.

`runLive` assembles one `createVercelPort()`-backed `TacticalAgent` per arm —
`createTacticalAgent` binds to a model spec at construction, and a sweep
covers several — and drives it through the same `runProbeArm`/`runEncounterArm`
runners the smoke path uses, so a live run and a smoke run share every line of
code downstream of the port. No credential is ever read by `tools/sim` itself:
`createVercelPort`'s default `resolveModel` goes straight to `@ai-sdk/anthropic`
/ `@ai-sdk/google` / `@ai-sdk/openai`'s own provider clients, which read their
own standard environment variables the moment a call is made — not before, and
not via any `.env` file this package loads.

```bash
export OPENAI_API_KEY=…                 # gpt-5.4-mini, gpt-5.4-nano — both confirmed working
export ANTHROPIC_API_KEY=…              # claude-sonnet-5 — confirmed working
export GOOGLE_GENERATIVE_AI_API_KEY=…   # gemini-3.1-flash-lite — quota and schema bugs fixed, confirmed live 2026-08-19
pnpm sim --live --mode probe --arms claude-sonnet-5@low,gpt-5.4-nano@low   # narrow first
pnpm sim --live --mode probe            # all 12 arms x 4 scenarios x 5 seeds — all three
                                        # providers, including google, confirmed working live
```

Keys are read from `process.env` only: never written to disk, never logged,
never included in a report. A missing key is not a crash — the tactical
agent's `provider_error` handling turns it into a same-turn deterministic
fallback, so a run with no credentials exported still completes and writes a
report; every record in it carries `adapterErrorCodes: ["provider_error"]`
rather than any real model output. Narrow a run with `--arms`, `--seeds` and
`--scenarios` (e.g. `--arms gpt-5.4-mini@low --seeds 1 --scenarios
melee-brawl`) to keep a first pass small before committing to the full matrix.

**`provider_error` is not always a missing key.** `TurnRecord` stores only the
stable `adapterErrorCode`, never the underlying message (deliberately — see
`src/run/records.ts`), so "no key", "bad model id", "quota exceeded",
"malformed tool schema" and "provider outage" are all the same
`provider_error` row in a report. Every live defect found on 2026-08-18 was
diagnosed the same way, and none of them could have been diagnosed from a
report:

1. Write a throwaway script that calls the raw `ai` SDK's
   `generateObject({mode:"tool"})` directly and prints `APICallError.message`,
   `statusCode` and `responseBody`.
2. **Use the real `ExecuteTurn` schema from `@ai-dm/schemas`, not a
   hand-written stand-in.** A simplified schema is exactly what let the
   strict-mode failure hide for a session.
3. Read the provider's docs before the next live call. The anthropic verdict
   was wrong for a whole session because it was inferred from error text; one
   page of the thinking docs settled it.

Put the script inside `packages/agents/` (pnpm will not resolve the SDKs from
a scratch directory) and delete it afterwards. It is far cheaper per iteration
than looping the sim, and does not spend quota on turns you are not reading.

**Before publishing any number from a live run:**

- Check `costIsUnderreported` in the report. It is true when an attempt was
  billed but reported no usage, which makes every cost figure a lower bound.
  A terminal `provider_error` attempt does not trip this — nothing was billed
  for it, so it is excluded from the shortfall count.
- Check `promptVersion` matches across every run you intend to compare. Two runs
  either side of a prompt edit must not be pooled.
- Read win rate with the resolver's declared gaps in view — Dodge is inert here,
  which penalises both careful play and the deterministic fallback.
