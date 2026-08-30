// A deterministic stand-in for the embedding adapter: no network, no API
// key, no SDK. Vectors come from a cheap string hash spread over the
// declared width and then normalized, so cosine similarity between two
// fakes is meaningful enough for a conformance suite to assert ordering on,
// and identical text always produces an identical vector.
//
// This is a test double, not a fallback. Nothing in production may use it —
// an unembeddable summary is simply not indexed (see the pipeline's
// `indexEpisode`), never indexed with fake coordinates.
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import { adapterSuccess } from "../errors.js";
import type { AdapterResult } from "../errors.js";
import type { EmbeddingOutput, EmbeddingPort, EmbeddingSpec } from "../embedding-port.js";

export interface FakeEmbeddingCall {
  spec: EmbeddingSpec;
  texts: readonly string[];
}

export interface FakeEmbeddingPort extends EmbeddingPort {
  readonly calls: FakeEmbeddingCall[];
}

/** FNV-1a, seeded per dimension. Cheap, stable, and good enough to separate. */
function hashAt(text: string, dimension: number): number {
  let hash = 0x811c9dc5 ^ dimension;
  for (const code of Array.from(text, (char) => char.codePointAt(0) ?? 0)) {
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Map to [-1, 1) so vectors point in varied directions rather than one octant.
  return (hash / 0x80000000) - 1;
}

function embedOne(text: string, dimensions: number): number[] {
  const raw = Array.from({ length: dimensions }, (_unused, index) => hashAt(text, index));
  const norm = Math.hypot(...raw);
  // A zero vector cannot be normalized; no non-empty text produces one, but
  // dividing by zero would poison the whole suite silently if one did.
  return norm === 0 ? raw : raw.map((each) => each / norm);
}

export function createFakeEmbeddingPort(): FakeEmbeddingPort {
  const calls: FakeEmbeddingCall[] = [];

  return {
    calls,
    embed(spec: EmbeddingSpec, texts: readonly string[]): Promise<AdapterResult<EmbeddingOutput>> {
      calls.push({ spec, texts });
      const dimensions = spec.dimensions === 0 ? EMBEDDING_DIMENSIONS : spec.dimensions;
      const tokens = texts.reduce((sum, text) => sum + text.length, 0);
      return Promise.resolve(
        adapterSuccess({
          vectors: texts.map((text) => embedOne(text, dimensions)),
          usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens },
        }),
      );
    },
  };
}
