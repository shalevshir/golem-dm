import { describe, expect, it } from "vitest";
import { createVercelEmbeddingPort } from "./vercel-embedding.js";
import { DEFAULT_EMBEDDING_SPEC } from "./routing.js";

describe("createVercelEmbeddingPort", () => {
  it("fails with provider_error rather than throwing when the provider rejects", async () => {
    // No API key and an unroutable model id: the call must surface as a
    // typed failure, because the caller's contract is "skip indexing", not
    // "crash the turn".
    const port = createVercelEmbeddingPort({ apiKey: "sk-not-a-real-key" });
    const result = await port.embed(
      { ...DEFAULT_EMBEDDING_SPEC, modelId: "definitely-not-a-model" },
      ["anything"],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["provider_error", "aborted"]).toContain(result.error.code);
  });

  it("returns a failure, not an empty success, for an empty input list", async () => {
    const port = createVercelEmbeddingPort({ apiKey: "sk-not-a-real-key" });
    const result = await port.embed(DEFAULT_EMBEDDING_SPEC, []);
    expect(result.ok).toBe(false);
  });
});
