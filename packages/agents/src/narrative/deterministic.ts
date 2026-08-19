// A template renderer over the rule outcome. Two jobs: it is the default
// `NarrativePort` until step 9 lands, and it is the terse fallback narration
// the server's 10s turn timeout falls back to (apps/server/CLAUDE.md) — which
// it will still be after step 9. Mirrors `deterministicFallback` in
// `tactical/`: the boring, always-correct path the LLM path degrades into.
//
// It states only what the engine produced. No adjectives, no invented numbers.
import type { AttackRecord } from "@ai-dm/rules-engine";
import type { NarrationInput, NarrativePort } from "./port.js";

function nameOf(input: NarrationInput, combatantId: string): string {
  return input.namesByCombatantId[combatantId] ?? combatantId;
}

function sentenceFor(input: NarrationInput, attack: AttackRecord): string {
  const target = nameOf(input, attack.targetId);
  if (attack.damage === 0) return `${input.actorName} misses ${target}.`;

  const critical = attack.outcome === "critical_hit" ? " critically" : "";
  const killed = attack.targetStatusAfter === "dead" ? ` ${target} falls.` : "";
  return `${input.actorName}${critical} hits ${target} for ${String(attack.damage)} damage.${killed}`;
}

function sentencesFor(input: NarrationInput): string[] {
  const sentences = input.effect.attacks.map((attack) => sentenceFor(input, attack));

  if (input.effect.movedFeet > 0) {
    sentences.unshift(`${input.actorName} moves ${String(input.effect.movedFeet)} feet.`);
  }

  // Reachable when the engine accepts an actionId the actor's stat block does
  // not own (see `TurnEffect.unresolvedActionIds`'s doc comment): the swing
  // produces no `AttackRecord`, so without this line a turn that in fact
  // attempted something would otherwise narrate as nothing at all.
  if (input.effect.unresolvedActionIds.length > 0) {
    sentences.push(`${input.actorName} attempts an action the engine could not resolve.`);
  }

  // Never zero sentences: a silent turn reads to a player as a dropped
  // connection, and the client has nothing else to render for this turn.
  if (sentences.length === 0) sentences.push(`${input.actorName} holds position.`);
  return sentences;
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
    // path is then exercised by the default port, not only by step 9's.
    stream(input: NarrationInput): AsyncIterable<string> {
      return toAsyncIterable(sentencesFor(input).map((sentence) => `${sentence} `));
    },
  };
}
