# Narrative benchmark — live-narrative-2026-08-21T17-39-09.022Z

- Mode: **live**
- Prompt version: `2026-08-21.1`
- Commit: `3e55b50`
- Generated at: 2026-08-21T17:39:09.022Z (not part of the determinism claim)
- Samples: 9

## Time to first token

- p50: 1842 ms (exit criterion: < 1500 ms)
- p95: 2378 ms

## Output discipline

- Digit violations: 0 / 9
- Non-Hebrew outputs: 0 / 9
- Over-length outputs: 0 / 9

Any non-zero count above is a prompt bug, not a tolerance: fix the prompt, bump `NARRATIVE_PROMPT_VERSION`, re-pin the hash, and re-measure.

## Cost

- Prompt tokens: 939
- Completion tokens: 1186
- Cost: $0.0137 total, $0.0015 per narration
- Cached-token share: not reported — no adapter in this repo surfaces a cache-read count.
