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
