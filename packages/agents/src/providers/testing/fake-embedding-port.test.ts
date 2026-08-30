import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@ai-dm/schemas";
import { createFakeEmbeddingPort } from "./fake-embedding-port.js";
import { DEFAULT_EMBEDDING_SPEC } from "../routing.js";

describe("createFakeEmbeddingPort", () => {
  it("returns one unit vector of the declared width per input text", async () => {
    const port = createFakeEmbeddingPort();
    const result = await port.embed(DEFAULT_EMBEDDING_SPEC, ["a", "b"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectors).toHaveLength(2);
    expect(result.value.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);

    const norm = Math.hypot(...(result.value.vectors[0] ?? []));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("is deterministic — the same text always embeds to the same vector", async () => {
    const port = createFakeEmbeddingPort();
    const first = await port.embed(DEFAULT_EMBEDDING_SPEC, ["the weir at dusk"]);
    const second = await port.embed(DEFAULT_EMBEDDING_SPEC, ["the weir at dusk"]);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.vectors[0]).toEqual(second.value.vectors[0]);
  });

  it("separates unlike texts — a text is nearer itself than a different one", async () => {
    const port = createFakeEmbeddingPort();
    const result = await port.embed(DEFAULT_EMBEDDING_SPEC, ["goblins at the weir", "a quiet inn"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [a, b] = result.value.vectors;
    const dot = (x: readonly number[], y: readonly number[]): number =>
      x.reduce((sum, each, i) => sum + each * (y[i] ?? 0), 0);

    expect(dot(a ?? [], a ?? [])).toBeGreaterThan(dot(a ?? [], b ?? []));
  });

  it("reports usage with no completion tokens", async () => {
    const port = createFakeEmbeddingPort();
    const result = await port.embed(DEFAULT_EMBEDDING_SPEC, ["abc"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usage.completionTokens).toBe(0);
    expect(result.value.usage.totalTokens).toBe(result.value.usage.promptTokens);
  });

  it("records every call for assertion", async () => {
    const port = createFakeEmbeddingPort();
    await port.embed(DEFAULT_EMBEDDING_SPEC, ["x"]);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.texts).toEqual(["x"]);
  });
});
