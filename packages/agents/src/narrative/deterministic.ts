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

/**
 * The target's status after this swing, as its own sentence — never folded
 * into the hit sentence. ADR 0002 makes this a solo game, so a player
 * character going down is not an edge case, it is the losing beat of the
 * fight, and "dead" and "unconscious" have to read as distinctly different
 * news.
 *
 * No clause for `"fled"`: `applyDamage` (`combat/index.ts`) only ever derives
 * `"alive" | "unconscious" | "dead"` from a resolved attack, so this function
 * can never actually observe `"fled"` on a hit here — a clause for it would
 * be untestable dead code standing in for a status this code path cannot
 * produce. `"alive"` needs nothing said about it either.
 */
function statusSentence(
  target: string,
  status: AttackRecord["targetStatusAfter"],
): string | undefined {
  if (status === "dead") return `${target} falls.`;
  if (status === "unconscious") return `${target} falls unconscious.`;
  return undefined;
}

/**
 * The sentence(s) for one swing. A miss and a hit that downs its target are
 * returned as separate list entries — not concatenated — so each becomes its
 * own stream chunk.
 */
function sentencesForAttack(input: NarrationInput, attack: AttackRecord): string[] {
  const target = nameOf(input, attack.targetId);

  // The engine's verdict is `outcome`, not a derived number: a
  // `{ outcome: "hit", damage: 0 }` swing is constructible (damage rolls
  // floor at 0), and narrating that as a miss would second-guess the
  // engine's call instead of reporting what it produced.
  if (attack.outcome === "miss" || attack.outcome === "critical_miss") {
    return [`${input.actorName} misses ${target}.`];
  }

  const critical = attack.outcome === "critical_hit" ? " critically" : "";
  const hit = `${input.actorName}${critical} hits ${target} for ${String(attack.damage)} damage.`;
  const status = statusSentence(target, attack.targetStatusAfter);
  return status === undefined ? [hit] : [hit, status];
}

function sentencesFor(input: NarrationInput): string[] {
  const sentences = input.effect.attacks.flatMap((attack) => sentencesForAttack(input, attack));

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
 * Sentences joined with a single space between them and no trailing space on
 * the last one. The concatenation of every yielded chunk is exactly what
 * `narrative_emitted` stores (`protocol.ts`), and trailing whitespace has no
 * business going into that permanent log.
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
    // path is then exercised by the default port, not only by step 9's.
    stream(input: NarrationInput): AsyncIterable<string> {
      return toAsyncIterable(chunksFor(sentencesFor(input)));
    },
  };
}
