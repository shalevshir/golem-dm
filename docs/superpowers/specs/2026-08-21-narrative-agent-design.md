# The Hebrew narrative agent — design

Spec #2 of step 9, and the step itself. Spec #1 built the hero the narrator
describes — `nameHebrew` on every creature, action, weapon and armor row, a
real `CharacterSheet` with a `grammaticalGender`, and a `DerivedCharacter`
that crosses HTTP. This spec builds the thing that reads all of it and
speaks.

Today `packages/agents/src/narrative/deterministic.ts` is both the default
`NarrativePort` and the server's turn-timeout fallback, and it emits English.
Spec #2 replaces the first role with a streaming Sonnet 5 agent, rewrites the
second in Hebrew, and defines what happens in the gap between them.

Exit criterion: `goblin-ambush` plays to a conclusion in a browser with every
turn narrated in Hebrew prose; the first narrative token arrives in under
1.5s at p50 measured against a live provider; and a provider that errors,
stalls or runs out of turn budget still leaves the player with complete
Hebrew — never English, never a severed sentence.

## Context

Seven facts were measured against the repo rather than recalled, and each
one moved a decision below.

**Only one file asserts the English prose.** `deterministic.test.ts` holds
all 11 assertions on narration text (`"misses"`, `"Fighter holds position."`,
and so on). No test under `apps/server`, `apps/web` or `e2e.test.ts` reads
narration text at all. Translating the fallback is therefore a one-file
rewrite plus its own test, not a cross-cutting change.

**`narrative_emitted` is a no-op in `reduce`.** Narration is not part of
`SessionState` and never has been. The recent-narration window this design
needs is consequently a server-side derivation from the log, not a protocol
change.

**The client already receives every Hebrew name it needs.**
`CatalogueCombatant.nameHebrew` and `CatalogueAction.nameHebrew` are both
`z.string().min(1)` and already populated. Switching the web UI to Hebrew
labels is a render-site change with no schema or protocol work behind it.

**`grammaticalGender` stops at the character boundary.** It is required on
`CharacterSheet` and `DerivedCharacter`; `CreatureStatBlock` has no such
field. All 11 monster `nameHebrew` values happen to be masculine
(גובלין לוחם, זאב, שלד, אוגר …), so nothing is visibly wrong today and
everything breaks quietly on the first feminine noun.

**Conditions carry rules but no Hebrew.** `data/srd/conditions.json` has a
`ruleEnglish` for every effect of every condition — a transcribed,
notebook-checked rules corpus already in the repo — and no `nameHebrew`
anywhere in the file.

**`EncounterDefinition` already carries `descriptionEnglish`**, currently
"A lone adventurer is ambushed by two goblin warriors in melee range on an
open 12x12 field." That is grid bookkeeping, not atmosphere, which is why
the scene card below is a second field rather than a rewrite of this one.

**`Combatant` carries `maxHp`, `currentHp` and `conditions`.** Severity
banding, the fight pulse and the actor's condition list all read off the
world the engine just produced, with no second lookup.

One measurement from outside this repo bounds the design: step 7b measured
the tactical model (`gpt-5.4-nano` @ high) at **p95 27.8s against a shared
10s turn budget**. Narration runs after the tactical call on a hostile turn
and shares that one budget. The narrator will therefore sometimes be handed
almost no time at all, through no fault of its own, which is why degradation
below is a designed ladder rather than an error path.

## Decisions

- **Cinematic beat, grounded.** Two to three sentences of modern literary
  Hebrew per turn. Sensory, but every fact traceable to something the engine
  produced or the scene card supplied. Not a terse announcer — that is what
  the fallback is for, and if the LLM output were interchangeable with it,
  the LLM would not be worth its latency.
- **Manner, plus a scene card.** The narrator may choose verbs, adverbs and
  framing freely. Nouns come from three sources and nowhere else: creature
  and action `nameHebrew`, condition `nameHebrew`, and a per-encounter scene
  card. Atmosphere becomes data instead of hallucination — the prose may say
  אל האבן only because the card says the ground is stone.
- **The scene card is written in English.** Invariant 2 keeps prompts
  English-inside, and Hebrew tokens cost ~2x, so paying them on a cached
  tier would be the worst possible place to spend them. Hebrew enters the
  prompt only as *values to reproduce* — names, condition labels, and the
  two previous narrations.
- **No digits in the prose.** `CombatLog.tsx` is already a player-facing
  roll log showing attack rolls against AC, damage dice and movement, with
  Hebrew labels. Restating those numbers in the narrative pane duplicates a
  pane the player already has and hands the model a number it can get wrong.
  Instead the engine computes a **severity band** and the narrator renders
  the band as language.
- **The narrator never sees player free text.** `apps/server/CLAUDE.md`
  requires untrusted player input be stripped before it reaches any prompt,
  and this agent has no use for it — it describes what the engine already
  resolved. That removes the agent's entire prompt-injection surface. The
  cost, accepted knowingly: a player who types a flourish will not see it
  echoed back.
- **The pipeline owns degradation; the port does not widen.** The deadline
  cut is a pipeline fact — `untilDeadline` wraps the port, so the agent
  cannot know it was cut — while a provider error is an agent fact. One
  uniform rule applied by the pipeline covers both causes with one mechanism
  and one test surface. `NarrativePort.stream()` stays
  `AsyncIterable<string>`.
- **A pure brief sits between the engine and both narrators.**
  `buildNarrationBrief()` turns a `TurnEffect` plus the world into
  narratable material. The deterministic renderer stops walking `TurnEffect`
  directly, so severity, gender and Hebrew naming are computed once and
  tested once rather than twice.
- **The rules digest is built here, and wired into the narrative role only.**
  `PROJECT_PLAN.md` §4.1 asks for a digest for "the narrative/tactical
  static prompt tier". Adding it to the tactical prompt would change the
  prompt that the step 7b benchmark measured, and that benchmark is the sole
  justification for `DEFAULT_MODEL_ROUTING.tactical`. Tactical adoption is a
  separate slice that must re-run the benchmark.
- **Routing is unchanged.** `narrative` stays `claude-sonnet-5` at
  `temperature: 0.8`. Step 7b found Sonnet the only family whose p95
  (7.2–7.9s) fits inside the 10s budget, and narration is the role
  `PROJECT_PLAN.md` §3 explicitly buys a bigger model for.

## Non-goals

- **Death saving throws.** `diesAtZeroHp` stays pinned `true`
  (`RULES_REFERENCE.md` §8). `rollDeathSave` is implemented and tested but
  nothing drives it, so the pipeline cannot produce an `unconscious`
  combatant. The `unconscious` beat is rendered by both narrators and stays
  unreachable from the pipeline — deleting it would mean rebuilding it the
  day a driver lands.
- **Narrating player-authored flourishes.** See the injection decision above.
  The natural next slice, and it needs a sanitisation design of its own.
- **Non-combat narration.** Social, exploration and out-of-combat scenes are
  step 10 territory. This narrates resolved combat turns.
- **Runtime validation of the model's Hebrew.** Explained under *Degradation*.
- **The tactical prompt adopting the digest.** Needs a re-benchmark.
- **Multi-party pulse.** ADR-0002 makes this a solo game; the pulse reads
  the single party combatant.
- **Text-to-speech, episodic memory, prompt-caching metrics dashboards.**
- **The zod-3 `Partial<Record>` quirk on `DerivedCharacter`.** Consumers
  guard around it; this spec does not change the schema to fix it.

## The narration brief (`@ai-dm/agents/narrative`)

`NarrationInput` stops carrying `TurnEffect` and English names and becomes
the brief both narrators read:

```ts
interface NarratedCreature {
  nameHebrew: string;
  gender: GrammaticalGender;
  /** Board truth, not invention. Hebrew labels, from conditions.json. */
  conditionsHebrew: readonly string[];
}

type Severity = "graze" | "solid" | "severe" | "felling";
type HealthBand = "healthy" | "bloodied" | "critical";

type NarrationBeat =
  | { kind: "move"; feet: number }
  | { kind: "attack";
      target: NarratedCreature;
      actionNameHebrew: string;
      outcome: AttackOutcome;
      /** Absent on a miss. */
      severity?: Severity;
      /** Narrower than `EntityStatus`, which also has `"fled"`. */
      statusAfter: "alive" | "unconscious" | "dead" }
  | { kind: "other-action" }
  | { kind: "unresolved" }
  | { kind: "hold" };

interface NarrationInput {
  actor: NarratedCreature;
  actorSide: "party" | "hostile";
  beats: readonly NarrationBeat[];
  pulse: { hostilesStanding: number; heroBand: HealthBand };
  sceneEnglish: string;                  // the scene card, verbatim
  recentNarrations: readonly string[];   // last 2, Hebrew, oldest first
}
```

`statusAfter` is deliberately narrower than `EntityStatus`. `applyDamage`
only ever derives `alive | unconscious | dead` from a resolved attack, so
`"fled"` is unreachable on an attack beat — the same reasoning
`deterministic.ts` already records for refusing to write a `"fled"` clause
it could never test. The narrowing makes that unreachability a type fact
rather than a comment.

`buildNarrationBrief()` is pure: it takes the `TurnEffect`, the world's
combatants, the stat blocks and the scene card, and returns the brief. It
performs no I/O and reaches no provider. The beat order preserves the
existing renderer's rule — movement first, then swings in engine order.

### Severity bands

Banded on damage as a fraction of the **target's** `maxHp`, which
`Combatant` already carries:

| Band | Rule |
|---|---|
| `felling` | `statusAfter !== "alive"`. Overrides every other band. |
| `severe` | damage ≥ ½ `maxHp` |
| `solid` | damage ≥ ¼ `maxHp` |
| `graze` | anything below, including a hit that dealt 0 |

`felling` overriding by status rather than by damage is what makes the band
incapable of disagreeing with the engine: the engine decides who fell, and
the band reports that decision rather than inferring it from a number. A
`{ outcome: "hit", damage: 0 }` swing is constructible — damage rolls floor
at 0 — and bands as `graze`, never as a miss, for the same reason the
existing renderer refuses to narrate it as one.

`severity` is absent on `miss` and `critical_miss`. `critical_hit` is
carried by `outcome`, not folded into the band, so the narrator can mark a
crit that merely grazed as exactly that.

### The fight pulse and the narration window

`hostilesStanding` counts hostile combatants whose status is alive.
`heroBand` bands the party combatant's `currentHp` against its `maxHp`:
`healthy` above ½, `bloodied` at or below ½, `critical` at or below ¼ —
"bloodied at half" following 5e's own usage.

`recentNarrations` holds the previous two `narrative_emitted` texts, oldest
first. It exists for one reason: across a 20-round fight a narrator with no
memory writes החרב מוצאת פתח for the ninth time, and no amount of prompt
instruction fixes what the model cannot see.

It is **not** added to `SessionState`. `reduce` keeps treating
`narrative_emitted` as a no-op, the wire protocol is untouched, and the
window lives on the server's `Session` beside `built`, rebuilt from the tail
of the event log in `loadSession`. That keeps invariant 3 intact — it is a
projection of the log — without pushing prompt-shaped data at a client that
has no use for it, and without losing the window across a reconnect.

## Schema and data changes

| Change | Where | Why |
|---|---|---|
| `grammaticalGender` on `CreatureStatBlock` | `@ai-dm/schemas` + 11 monster files | Hebrew verbs agree with their subject. Mirrors spec #1's decision for characters. Required, not optional: an optional field would let a new monster ship ungendered and narrate wrong. |
| `nameHebrew` on `ConditionDefinition` and its effects | `@ai-dm/schemas` + `conditions.json` | The narrator cannot name a condition in Hebrew otherwise. |
| `sceneEnglish` on `EncounterDefinition` | `@ai-dm/rules-engine` | The scene card. Held separate from `descriptionEnglish`, whose doc comment gains the distinction: `descriptionEnglish` summarises the encounter for an operator, `sceneEnglish` gives the narrator ground, light and sound. Folding them would drag the operator summary toward prose. |
| `NarrativeEmittedPayload` convention | `@ai-dm/schemas` | Documents the payload the way `ActionRejectedPayload` already does, and adds `promptVersion` and `source: "model" \| "deterministic" \| "completed"`. Without `source` the benchmark cannot tell a narrated turn from a fallback turn, and that ratio is the single most useful number the harness produces. |

Adding fields to `narrative_emitted`'s payload is non-breaking:
`GameEvent.payload` is `z.record(z.string(), z.unknown())`, and the existing
`action_rejected` convention is precedent for a documented payload shape
that lives beside the schema rather than inside it.

`deterministic.ts` is rewritten to render Hebrew from the brief, inflecting
verbs by `gender`. It remains the default `NarrativePort` for any deployment
without a provider key, and remains the fallback afterwards.

## The prompt

Three tiers, matching `providers/prompt.ts`, because a single line of turn
state spliced into a cached tier invalidates the prefix on every call and
the symptom is a bill rather than a failure.

| Tier | Cached | Contents |
|---|---|---|
| `static` | yes | System prompt, Hebrew glossary, `RULES_DIGEST`. English. |
| `semiStatic` | yes | The scene card. Per-encounter — exactly this tier's definition. English. |
| `dynamic` | no | Beats, pulse, and the last two narrations. |

The system prompt carries the rules that make the output what section
*Decisions* chose: describe, never decide; no digits; nouns only from the
supplied vocabulary; agree verbs with `gender`; two to three sentences; end
with terminal punctuation. That last one is not cosmetic — the pipeline's
truncation detection reads it.

Hebrew appears in the prompt only as values: `nameHebrew` strings, condition
labels, and the two prior narrations. Every instruction and the whole scene
card are English.

### The rules digest

An English digest of the conditions, the action economy and cover, pinned
into the static tier. Its narrator-side job is concrete: prose describing a
Prone or Stunned creature has to be *right* about what that condition means,
and the digest is what makes it so.

It is a hand-written TS constant, not a runtime file read. `tactical/
prompt-text.ts` already settled that trade — a runtime `fs` read is I/O in a
package that must stay pure and breaks bundling, and codegen is machinery
bought for one string — so the module *is* the versioned copy and
`docs/prompts/README.md` points at it.

Hand-written text can drift from the data it summarises, so a test walks up
to `data/srd/conditions.json` and fails if any `condition` id is missing
from the digest. That catches drift in the direction that actually happens —
a condition added to the data and forgotten in the prompt — without codegen
and without runtime I/O.

### Versioning and hash pinning

`NARRATIVE_PROMPT_VERSION` and `RULES_DIGEST_VERSION` follow
`TACTICAL_PROMPT_VERSION` exactly: a guard test pins the content hash of
every prompt constant and fails if a string is edited without bumping the
version. `narrative_emitted` stamps `promptVersion`, so a benchmark run can
be attributed to the prompt that produced it rather than pooled across an
edit.

The Hebrew glossary is the one asset that cannot simply move into the
module. `docs/prompts/README.md` draws a deliberate line — prompt *text*
lives in TypeScript, but "`hebrew-glossary.md` stays a data file: it is a
table for non-programmers to edit, not prompt text" — while the same README
rules out loading markdown at runtime, because that is I/O in a package that
must stay pure. Spec #2 is the first thing to need the glossary in a prompt,
and so the first to hit that tension.

Resolution, and it is the same shape as the digest's: **the markdown stays
the editable source of record, `prompt-text.ts` holds the runtime copy, and
a test parses the markdown table and asserts the two agree.** A
non-programmer keeps editing a table; the package keeps its purity; and the
twin cannot drift, because drift fails the suite rather than reaching a
player. `docs/prompts/README.md` gains a row for the narrative module and a
note recording why the glossary is the exception to its own rule.

The current glossary is eight terms, none of them combat vocabulary; it
gains the terms the narrator can actually reach for. Condition labels are
**not** copied into it — they come from `conditions.json`, so that a
condition has exactly one Hebrew name in the repo.

## The Hebrew agent

```ts
interface NarrativeFinish {
  usage?: TokenUsage;
  error?: AdapterError;
  latencyMs: number;
  promptVersion: string;
}

createHebrewNarrative(options: {
  runtime: AgentRuntime;
  onFinish?: (finish: NarrativeFinish) => void;
}): NarrativePort
```

It builds the layered prompt, calls `runtime.stream("narrative", …)`, and
yields the `text-delta` text of each chunk. On a `finish` chunk it reports
usage through `onFinish` and ends. On an `error` chunk it reports the
`AdapterError` through `onFinish` and ends the stream — it does not throw,
because throwing into an async iterator forces every consumer into a
try/catch around a `for await`, which is the exact reasoning that made
`StreamChunk` carry failure in-band in the first place.

`onFinish` is the observability path, deliberately off the token stream:
`apps/server/CLAUDE.md` requires per-turn per-agent instrumentation — tokens
in and out, cached tokens, latency, retries, cost — and a swallowed provider
error would otherwise be invisible. The server wires it to its structured
logger.

## Pipeline integration and the degradation ladder

`narrate()` in `apps/server/src/core/pipeline.ts` keeps its shape and gains
one branch:

```
stream ports.narrative through untilDeadline(deadline), accumulating text

text.trim() === ""        → stream the full deterministic Hebrew   source: "deterministic"
!endsComplete(text)       → stream "… " + full deterministic Hebrew source: "completed"
otherwise                                                          source: "model"
```

Four details carry weight:

- **The completion is not itself deadline-bound.** `untilDeadline` has
  already returned by the time either fallback runs. Template rendering
  cannot hang, and gating it on a spent deadline would only produce silent
  turns — which read to a player as a dropped connection. Today's code
  already works this way for the empty case; this extends the same reasoning
  to the truncated one.
- **`endsComplete` is "`text.trimEnd()` ends with `.`, `!`, `?` or `…`",
  and the stored text stays raw.**
  The pipeline's standing guarantee is that `narrative_emitted` carries
  exactly the concatenation of the `narrative_token` frames it yielded, so
  that a replay cannot diverge from what the client already rendered
  optimistically. The check may look at a trimmed copy. It must never store
  one.
- **The seam is marked.** The completion's first chunk is `"… "`. One
  character, and it makes a truncation read as a truncation rather than as a
  typo.
- **The scene card is resolved once at session creation** and held on
  `Session`, not looked up per turn.

`recentNarrations` is updated after each `narrative_emitted` and truncated
to two.

### What each failure produces

| Failure | Detected by | Result |
|---|---|---|
| No provider key; adapter refuses | agent yields nothing | full deterministic Hebrew — `deterministic` |
| Provider error before the first token | agent ends its stream empty | as above |
| Deadline before the first token | `untilDeadline` returns | as above |
| Provider error mid-stream | agent ends its stream | `… ` + deterministic — `completed` |
| Deadline mid-stream | `untilDeadline` returns | as above |
| Model emits digits, English, or a fact the board contradicts | **not detected at runtime** | prompt and tests only |

That last row is a real limitation, stated here rather than left implicit.
Streaming forbids a post-filter: a token cannot be unsent once it is on the
wire, and stripping it afterwards would break the concatenation guarantee
the row above depends on. Output discipline is bought with the prompt and
with tests, not enforced at runtime. Buffering whole sentences before
yielding would make filtering possible, and was rejected because it
redefines "first token" as "first complete sentence" and puts the step 9
latency criterion at risk before it has ever been measured.

## Web client

`CombatLog.tsx`, `ActionBar.tsx` and `Grid.tsx` render `nameHebrew` instead
of `nameEnglish`. No protocol or schema work: both catalogue schemas already
carry the field and the server already populates it.

The `<bdi>` wrappers stay. They are still load-bearing around the numeric
roll traces, which remain LTR runs inside RTL text, and they are harmless
around names that are now same-direction — and they keep the UI correct if a
name ever contains Latin characters.

This closes the limitation recorded in `PROJECT_PLAN.md` §4.3: "Hebrew name
data now exists throughout `data/srd/` and `data/characters/` … but the web
client does not consume it yet."

## Testing

Colocated `*.test.ts`, Vitest, mocked provider through the existing
`providers/testing/fake-port.ts`. **No live API calls in CI**
(`agents/CLAUDE.md`).

| File | Covers |
|---|---|
| `brief.test.ts` | Beat construction and order; severity band boundaries at ¼ and ½; `felling` driven by status, not damage; `severity` absent on a miss; a 0-damage hit banding as `graze` rather than narrating as a miss; pulse counting. |
| `deterministic.test.ts` | Rewritten to Hebrew. Gender agreement in **both** directions. The downed-but-alive branch keeps its test. |
| `prompt.test.ts` | Tier placement: instructions and scene card English and cached; beats, pulse and history in `dynamic`; nothing dynamic in a cached tier. |
| `prompt-text.test.ts` | Hash pin and version, mirroring the tactical guard. |
| `rules-digest.test.ts` | Every `condition` id in `conditions.json` appears in the digest. |
| `hebrew.test.ts` | Chunks stream through; an in-band `error` chunk ends the stream after yielding prior text and reports through `onFinish`; usage reported on `finish`. |
| pipeline tests | All three degradation paths, each asserting `source` and that the stored text equals the concatenated `narrative_token` frames. |

**Gender agreement is tested against a synthetic feminine creature
constructed inline in the test**, not by adding a feminine character to
`data/characters/`. The hero stays אלדד, masculine, as decided. This matters
because masculine is Hebrew's unmarked form and all 11 monster names are
masculine too: a masculine-only fixture would pass even against a renderer
that ignored `grammaticalGender` entirely, and the bug would first appear
for a real player who is not.

**Every test that exists to protect a single line gets the sabotage check** —
delete the line, watch the test fail, restore it. `PROJECT_PLAN.md` §4.3
records seven tasks that shipped tests whose names promised properties their
assertions could not detect; the gender-agreement test and the
digest-coverage test are precisely that shape.

## The first-token benchmark (`tools/sim`)

A live mode over `goblin-ambush`, reported into `tools/sim/runs/` beside the
step 7b benchmark and reusing `report.ts`'s `costIsUnderreported` flag:

- **TTFT p50 and p95** — the step 9 exit criterion is p50 < 1.5s.
- Tokens in, out and cached; cost per narrated turn.
- **Fallback rate**: the share of turns whose `source` is not `"model"`.

Fallback rate is the number worth watching, and it is partly evidence about
a different agent. Narration shares one 10s budget with the tactical call
that precedes it on a hostile turn, and step 7b measured that call at p95
27.8s. A high fallback rate on hostile turns is therefore evidence about
tactical routing, not about the narrator, and the report must separate
hostile-turn from party-turn fallbacks or it will be read as the wrong
finding.

Live benchmarks belong here rather than in `packages/agents`, per
`agents/CLAUDE.md`.

## The Hebrew review artifact

A generator runs the narrator across a scripted set of turns covering every
beat kind, every severity band, both statuses and both grammatical genders,
and emits one reviewable document: the Hebrew output beside the English
beats that produced it, followed by the ~62 `nameHebrew` values spec #1
shipped and the glossary.

It is committed so it can be read in one sitting, and it is **not a blocking
gate**. `PROJECT_PLAN.md`'s step 9 row lists "Hebrew reviewed by native
speaker" as an exit criterion; this spec's job is to put a concrete artifact
in front of the reviewer rather than to hold the step open on a task only
they can perform. Corrections land as data edits to `nameHebrew` values and
prompt-text edits behind a version bump.

## Limitations this spec knowingly ships

- Nothing validates the model's Hebrew at runtime; a hallucinated noun or a
  stray digit reaches the player.
- The `unconscious` beat is rendered but unreachable, because
  `diesAtZeroHp` stays pinned.
- A player's own free text is never reflected in the narration.
- The rules digest serves the narrative role only; the tactical prompt is
  untouched until a re-benchmark.
- The recent-narration window is two turns. A repetition at distance three
  is invisible to the narrator.
- The fight pulse assumes a single party combatant (ADR-0002).
