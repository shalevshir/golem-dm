// A Hebrew template renderer over the scene brief. Mirrors `deterministic.ts`
// for out-of-combat beats: the port any deployment without a provider key
// gets, and the fallback the pipeline degrades into on a provider failure or
// a blown turn budget.
//
// States only what the brief carries. No invented nouns, no numbers.
//
// `refused` is deliberately asymmetric with the model tier: the model
// explains WHY using the beat's English messages as ground truth, but this
// renderer never echoes them — they are English, and this is the one place
// in the pipeline where invariant 2 would otherwise leak English into Hebrew
// output. A single generic blocked-path line stands in for all of them.
import type { GrammaticalGender } from "@ai-dm/schemas";
import type { SceneNarrationInput, SceneNarrativePort } from "./scene-port.js";

type GenderedForms = Readonly<Record<GrammaticalGender, string>>;

const FORMS: Readonly<Record<string, GenderedForms>> = {
  arrives: { masculine: "מגיע", feminine: "מגיעה" },
  succeeds: { masculine: "מצליח", feminine: "מצליחה" },
  fails: { masculine: "נכשל", feminine: "נכשלת" },
};

function form(key: string, gender: GrammaticalGender): string {
  const forms: GenderedForms | undefined = FORMS[key];
  if (forms === undefined) throw new Error(`No inflected forms for ${key}`);
  return forms[gender];
}

function replyLine(category: "social" | "combat" | "ooc"): string {
  switch (category) {
    case "combat":
      return "קרב אינו אפשרי כאן.";
    case "social":
      return "השיחה נמשכת.";
    case "ooc":
      return "ההערה נקלטת.";
  }
}

function sentenceFor(input: SceneNarrationInput): string {
  const { beat, playerNameHebrew, playerGender } = input;
  switch (beat.kind) {
    case "arrived":
      return `${playerNameHebrew} ${form("arrives", playerGender)} אל ${beat.locationNameHebrew}.`;
    // Generic on purpose — see the file header. `beat.messages` is never read.
    case "refused":
      return "הדרך חסומה כרגע.";
    case "check":
      return beat.success
        ? `${playerNameHebrew} ${form("succeeds", playerGender)} בניסיון.`
        : `${playerNameHebrew} ${form("fails", playerGender)} בניסיון.`;
    case "reply":
      return replyLine(beat.category);
  }
}

/** Wraps a single precomputed sentence as an `AsyncIterable`. See `deterministic.ts`'s twin for why this is not an `async function*`. */
function toAsyncIterable(chunk: string): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let done = false;
      return {
        next(): Promise<IteratorResult<string>> {
          if (done) return Promise.resolve({ done: true, value: undefined });
          done = true;
          return Promise.resolve({ done: false, value: chunk });
        },
      };
    },
  };
}

export function createDeterministicSceneNarrative(): SceneNarrativePort {
  return {
    stream(input: SceneNarrationInput): AsyncIterable<string> {
      return toAsyncIterable(sentenceFor(input));
    },
  };
}
