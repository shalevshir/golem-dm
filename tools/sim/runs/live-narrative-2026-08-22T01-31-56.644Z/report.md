# Narrative benchmark — live-narrative-2026-08-22T01-31-56.644Z

- Mode: **live**
- Prompt version: `2026-08-21.1`
- Commit: `13eab18`
- Generated at: 2026-08-22T01:31:56.644Z (not part of the determinism claim)
- Samples: 9

## Time to first token

- p50: 1156 ms (exit criterion: < 1500 ms)
- p95: 2320 ms

## Output discipline

- Digit violations: 0 / 9
- Non-Hebrew outputs: 0 / 9
- Over-length outputs: 0 / 9

Any non-zero count above is a prompt bug, not a tolerance: fix the prompt, bump `NARRATIVE_PROMPT_VERSION`, re-pin the hash, and re-measure.

## Cost

- Prompt tokens: 939
- Completion tokens: 1423
- Cost: $0.0161 total, $0.0018 per narration
- Cached-token share: not reported — no adapter in this repo surfaces a cache-read count.
- Note: the cost above excludes cache-read tokens and is a lower bound whether or not the under-reported flag below is set — `promptTokens` is the provider's `input_tokens`, which does not include `cache_read_input_tokens` (see `NarrativeUsageSummary.costIsUnderreported`'s doc comment in live/narrative.ts).
