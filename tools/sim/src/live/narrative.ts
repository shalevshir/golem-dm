// Time-to-first-token and output-discipline benchmark for the Hebrew
// narrative agent, run against SCRIPTED_BRIEFS — never a live one in CI.
//
// This measures the AGENT alone, deliberately: `createHebrewNarrative`'s
// `stream()` is called directly here, the same call the server pipeline
// makes for the "narrative" role, with nothing else around it. Going
// through the pipeline would fold in the tactical call's own p95 tail
// (27.8s at step 7b, see `packages/agents/src/providers/routing.ts`) into
// what should be a property of a different agent. Fallback rate is a
// session property for the same reason — computed separately from
// `narrative_emitted.source` in a played session's log, not here.
import type {
  AdapterErrorCode,
  AgentRuntime,
  NarratedCreature,
  NarrationBeat,
  NarrationInput,
  NarrativeFinish,
} from "@ai-dm/agents";
import { createHebrewNarrative } from "@ai-dm/agents";
import { costUsd } from "../pricing.js";
import { percentile } from "../run/metrics.js";

const ELDAD: NarratedCreature = { nameHebrew: "אלדד", gender: "masculine", conditionsHebrew: [] };
const GOBLIN: NarratedCreature = { nameHebrew: "גובלין לוחם", gender: "masculine", conditionsHebrew: [] };

/**
 * Every shipped creature (`data/srd/monsters/*.json`, `data/characters/*.json`)
 * is masculine, so exercising Hebrew gender agreement needs a synthetic
 * feminine creature. Reused verbatim from
 * `packages/agents/src/narrative/deterministic.test.ts`, which established
 * these exact two fixtures for the same reason, rather than re-invented here
 * — a native-speaker review of this corpus is then reviewing Hebrew already
 * vetted once, not a second, possibly-inconsistent pair of names.
 */
const RANGER: NarratedCreature = { nameHebrew: "רעות", gender: "feminine", conditionsHebrew: [] };
const WOLF_F: NarratedCreature = { nameHebrew: "זאבה", gender: "feminine", conditionsHebrew: [] };

const SCENE_ENGLISH =
  "A goblin ambush on a dry hillside track: two goblins break from cover as the party rounds a switchback.";

/**
 * A hand-written corpus, not a random sample: every `NarrationBeat` kind,
 * all four `Severity` bands, both non-`"alive"` `statusAfter` values, both
 * grammatical genders, and one turn with prior narrations in view — so a
 * live run of this corpus exercises every dimension the prompt makes a
 * promise about (see the classification rules below) at least once.
 *
 * Kept intentionally small — every entry is one real Sonnet call in a live
 * run — rather than padded for statistical smoothing on the percentiles.
 */
export const SCRIPTED_BRIEFS: readonly NarrationInput[] = [
  // move, then a graze that leaves the target standing
  {
    actor: ELDAD,
    actorSide: "party",
    beats: [
      { kind: "move", feet: 15 },
      {
        kind: "attack",
        target: GOBLIN,
        actionNameHebrew: "חרב ארוכה",
        outcome: "hit",
        severity: "graze",
        statusAfter: "alive",
      },
    ],
    pulse: { hostilesStanding: 2, heroBand: "healthy" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: [],
  },
  // a solid hit, with prior narration in view — the corpus's one non-empty
  // `recentNarrations`, reused verbatim from deterministic.test.ts's
  // FORM_TABLE rather than freshly authored.
  {
    actor: ELDAD,
    actorSide: "party",
    beats: [
      {
        kind: "attack",
        target: GOBLIN,
        actionNameHebrew: "חרב ארוכה",
        outcome: "hit",
        severity: "solid",
        statusAfter: "alive",
      },
    ],
    pulse: { hostilesStanding: 2, heroBand: "healthy" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: ["אלדד מתקדם.", "אלדד פוגע בגובלין לוחם."],
  },
  // a severe hit while the hero is already bloodied
  {
    actor: ELDAD,
    actorSide: "party",
    beats: [
      {
        kind: "attack",
        target: GOBLIN,
        actionNameHebrew: "חרב ארוכה",
        outcome: "hit",
        severity: "severe",
        statusAfter: "alive",
      },
    ],
    pulse: { hostilesStanding: 2, heroBand: "bloodied" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: [],
  },
  // a felling, killing blow
  {
    actor: ELDAD,
    actorSide: "party",
    beats: [
      {
        kind: "attack",
        target: GOBLIN,
        actionNameHebrew: "חרב ארוכה",
        outcome: "critical_hit",
        severity: "felling",
        statusAfter: "dead",
      },
    ],
    pulse: { hostilesStanding: 1, heroBand: "bloodied" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: [],
  },
  // a felling blow that downs rather than kills, on a feminine target
  {
    actor: ELDAD,
    actorSide: "party",
    beats: [
      {
        kind: "attack",
        target: WOLF_F,
        actionNameHebrew: "חרב ארוכה",
        outcome: "hit",
        severity: "felling",
        statusAfter: "unconscious",
      },
    ],
    pulse: { hostilesStanding: 1, heroBand: "healthy" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: [],
  },
  // a hostile-side turn: the goblin swings back and misses
  {
    actor: GOBLIN,
    actorSide: "hostile",
    beats: [
      {
        kind: "attack",
        target: ELDAD,
        actionNameHebrew: "חרב מעוקלת",
        outcome: "miss",
        statusAfter: "alive",
      },
    ],
    pulse: { hostilesStanding: 1, heroBand: "bloodied" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: [],
  },
  // a non-attack action (e.g. Dodge), on a feminine actor
  {
    actor: RANGER,
    actorSide: "party",
    beats: [{ kind: "other-action" }],
    pulse: { hostilesStanding: 1, heroBand: "healthy" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: [],
  },
  // an action the engine could not resolve
  {
    actor: ELDAD,
    actorSide: "party",
    beats: [{ kind: "unresolved" }],
    pulse: { hostilesStanding: 1, heroBand: "healthy" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: [],
  },
  // a silent turn
  {
    actor: ELDAD,
    actorSide: "party",
    beats: [{ kind: "hold" }],
    pulse: { hostilesStanding: 0, heroBand: "healthy" },
    sceneEnglish: SCENE_ENGLISH,
    recentNarrations: [],
  },
];

// Classification rules: each one a property the narrative prompt promises
// (packages/agents/src/narrative/prompt-text.ts) and nothing enforces at
// runtime. A live run finding any of these non-zero is a prompt bug, not a
// tolerance — see tools/sim/CLAUDE.md's live-benchmarking section: fix the
// prompt, bump `NARRATIVE_PROMPT_VERSION`, re-pin the hash, re-measure.
//
// `HEBREW` is the Hebrew Unicode block (U+0590-U+05FF) spelled as an escape
// rather than the literal glyphs, so the source stays unambiguous in a plain
// diff — same range, same rule.
const HEBREW = /[\u0590-\u05FF]/;
const DIGIT = /[0-9]/;
const SENTENCE_LIMIT = 3;

function sentenceCount(text: string): number {
  return text.split(/[.!?…]/).filter((part) => part.trim() !== "").length;
}

function describeBeat(beat: NarrationBeat): string {
  switch (beat.kind) {
    case "move":
      return `moves ${String(beat.feet)}ft`;
    case "attack": {
      const severity = beat.severity === undefined ? "" : `, severity=${beat.severity}`;
      return (
        `attacks ${beat.target.nameHebrew} with ${beat.actionNameHebrew}: ` +
        `outcome=${beat.outcome}${severity}, target-status=${beat.statusAfter}`
      );
    }
    case "other-action":
      return "takes a non-attack action";
    case "unresolved":
      return "attempts an action the engine could not resolve";
    case "hold":
      return "holds position";
  }
}

/**
 * An English gloss of a brief's beats, for a reviewer scanning the benchmark
 * output next to its Hebrew (task 16's review sheet). Hebrew proper nouns
 * (creature and action names) are embedded as-is — the brief carries no
 * English equivalent for them — inside otherwise-English scaffolding.
 */
function describeBeatsEnglish(beats: readonly NarrationBeat[]): string {
  return beats.map(describeBeat).join("; ");
}

export interface NarrativeSample {
  /**
   * The brief that produced this sample: full identity, not just an index,
   * so a downstream consumer (task 16's review sheet) never needs to
   * re-run the benchmark or re-import `SCRIPTED_BRIEFS` in lockstep to know
   * what produced a given row.
   */
  source: NarrationInput;
  beatsEnglish: string;
  /** The full accumulated stream text. Named for the expected case; a non-Hebrew failure still lands here, not dropped. */
  hebrew: string;
  ttftMs: number;
  digitViolation: boolean;
  nonHebrew: boolean;
  overLength: boolean;
  /**
   * Present when `createHebrewNarrative` ended this stream on a provider
   * error (`NarrativeFinish.error`) rather than a clean finish. `hebrew` is
   * then whatever partial (often empty) text arrived before the failure —
   * not evidence about the prompt's Hebrew discipline, and `ttftMs` is not
   * evidence about first-token latency either (an empty stream measures
   * time-to-error, not time-to-first-token). Every sample here is still
   * excluded from `digitViolations`/`nonHebrewOutputs`/`overLengthOutputs`/
   * `ttftMsP50`/`ttftMsP95` on the report, and its own three violation
   * booleans are forced `false` rather than computed from that partial text
   * — so summing the per-sample booleans directly, instead of reading the
   * report's own aggregates, cannot silently reintroduce this bug either.
   */
  errorCode?: AdapterErrorCode;
}

export interface NarrativeUsageSummary {
  promptTokens: number;
  completionTokens: number;
  /** Null when the model has no entry in tools/sim/src/pricing.ts. */
  costUsd: number | null;
  costPerNarrationUsd: number | null;
  /**
   * Shaped like `run/report.ts`'s `costIsUnderreported`: true when a stream
   * finished without reporting usage, so the cost above is a lower bound.
   *
   * This detects only ABSENT usage — a finish with no usage object at all.
   * It says nothing about usage that IS present but itself undercounts:
   * `providers/vercel.ts` passes the AI SDK's `promptTokens` through
   * verbatim, and for Anthropic that is `input_tokens`, which excludes
   * `cache_read_input_tokens`. So `costUsd` above is a lower bound on a
   * cache-stable prompt (this benchmark's prompt is exactly that — three
   * static tiers, byte-identical across every sample) even when this flag
   * reads `false`. `narrative-report.ts`'s Cost section says so
   * unconditionally, not only inside this flag's own branch.
   */
  costIsUnderreported: boolean;
  /**
   * Always `null`: no `TokenUsage` field and no adapter in this repo
   * surfaces a cache-read count (verified by grep across `packages/agents`),
   * so the share cannot be measured. Typed as the literal `null` rather than
   * `number | null` on purpose — an actual implementation would have to
   * change this field's type, not just its value, which is a stronger
   * signal than a comment that this is still unmeasured. Declared as a
   * field, not just a comment, so `report.json` states the gap too, and
   * printed unconditionally in the markdown Cost section rather than only
   * inside the `costIsUnderreported` branch, which does not fire on a
   * healthy run.
   */
  cachedTokenShare: null;
}

export interface NarrativeReport {
  samples: readonly NarrativeSample[];
  ttftMsP50: number;
  ttftMsP95: number;
  digitViolations: number;
  nonHebrewOutputs: number;
  overLengthOutputs: number;
  /**
   * Streams that ended in a provider error rather than a clean finish.
   * Excluded from every count and percentile above — see
   * `NarrativeSample.errorCode`. A live run finding this non-zero is a
   * transient provider issue (rate limit, transport failure), not a prompt
   * bug — "any non-zero count is a prompt bug" applies to the three
   * discipline counters above, never to this one.
   */
  erroredSamples: number;
  usage: NarrativeUsageSummary;
}

export interface RunNarrativeBenchmarkOptions {
  runtime: AgentRuntime;
  /** Injected so a test can assert TTFT without a real clock. */
  now?: () => number;
}

export async function runNarrativeBenchmark(
  options: RunNarrativeBenchmarkOptions,
): Promise<NarrativeReport> {
  const now = options.now ?? ((): number => Date.now());

  // Instrumentation is off the token stream by design (`hebrew.ts`), so
  // usage/error for the brief just consumed is read back out of this after
  // its `for await` loop below has run to completion — the `finally` inside
  // `createHebrewNarrative` has already fired by then. Pushed to by
  // `onFinish` and read by index, rather than one shared `let` reassigned by
  // the closure and reset every iteration: a reset needed a type-narrowing
  // workaround (TypeScript cannot see that the loop below indirectly
  // triggers the closure, so a bare `finish = undefined` narrowed every
  // later read in the same iteration to the literal type `undefined`).
  // Indexing a plain array carries no such narrowing to fight.
  const finishes: NarrativeFinish[] = [];
  const narrator = createHebrewNarrative({
    runtime: options.runtime,
    onFinish: (result) => {
      finishes.push(result);
    },
  });

  const samples: NarrativeSample[] = [];
  const ttftValues: number[] = [];
  let digitViolations = 0;
  let nonHebrewOutputs = 0;
  let overLengthOutputs = 0;
  let erroredSamples = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let attemptsMissingUsage = 0;

  for (const [index, brief] of SCRIPTED_BRIEFS.entries()) {
    const startedAt = now();
    let firstTokenAt: number | undefined;
    let text = "";

    // The gap timed here is to the first yielded chunk, never to the last:
    // `firstTokenAt` is set at most once per brief, on the first iteration
    // (`??=` short-circuits every iteration after). A benchmark that instead
    // called `now()` on every delta and kept the latest would report total
    // latency under this name — a different, larger number, and exactly the
    // confusion the < 1.5s TTFT exit criterion must not be measured against.
    for await (const delta of narrator.stream(brief)) {
      firstTokenAt ??= now();
      text += delta;
    }

    const ttftMs = (firstTokenAt ?? now()) - startedAt;
    const finish = finishes[index];
    const errorCode = finish?.error?.code;

    // A stream that ended in a provider error is not evidence about either
    // measurement: an empty or truncated `text` is a transient failure, not
    // the model failing Hebrew discipline, and `ttftMs` on a stream with no
    // token at all measures the gap to the ERROR, not to a first token.
    // Neither is folded into the aggregates below, and the sample's own
    // three booleans are forced `false` — not computed from that partial
    // text — so summing them directly instead of reading the report's own
    // counters cannot silently reintroduce this bug either.
    let digitViolation = false;
    let nonHebrew = false;
    let overLength = false;

    if (errorCode === undefined) {
      ttftValues.push(ttftMs);
      digitViolation = DIGIT.test(text);
      nonHebrew = !HEBREW.test(text);
      overLength = sentenceCount(text) > SENTENCE_LIMIT;
      if (digitViolation) digitViolations += 1;
      if (nonHebrew) nonHebrewOutputs += 1;
      if (overLength) overLengthOutputs += 1;
    } else {
      erroredSamples += 1;
    }

    samples.push({
      source: brief,
      beatsEnglish: describeBeatsEnglish(brief.beats),
      hebrew: text,
      ttftMs,
      digitViolation,
      nonHebrew,
      overLength,
      ...(errorCode === undefined ? {} : { errorCode }),
    });

    if (finish?.usage === undefined) {
      attemptsMissingUsage += 1;
    } else {
      promptTokens += finish.usage.promptTokens;
      completionTokens += finish.usage.completionTokens;
    }
  }

  const modelId = options.runtime.specFor("narrative").modelId;
  const cost = costUsd(modelId, { promptTokens, completionTokens });
  // Divided by the samples that actually produced a narration, never by
  // `samples.length`: an errored sample contributes nothing to `cost` (its
  // usage, if any, is excluded from `promptTokens`/`completionTokens`
  // above), so dividing by the full count would understate the true cost of
  // a successful narration — undermining the markdown report's own claim
  // that an errored sample "is excluded from every count and percentile
  // below" it (narrative-report.ts).
  const disciplineSampleCount = samples.length - erroredSamples;
  const costPerNarrationUsd =
    cost === null || disciplineSampleCount === 0 ? null : cost / disciplineSampleCount;

  return {
    samples,
    ttftMsP50: percentile(ttftValues, 50),
    ttftMsP95: percentile(ttftValues, 95),
    digitViolations,
    nonHebrewOutputs,
    overLengthOutputs,
    erroredSamples,
    usage: {
      promptTokens,
      completionTokens,
      costUsd: cost,
      costPerNarrationUsd,
      costIsUnderreported: attemptsMissingUsage > 0,
      cachedTokenShare: null,
    },
  };
}
