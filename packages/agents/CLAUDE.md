# @ai-dm/agents

## Purpose & boundary

The LLM cascade: intent router, enemy tactical agent, Hebrew narrative agent, behind one provider-agnostic adapter (Vercel AI SDK: `@ai-sdk/anthropic|google|openai`). Model selection per role is **config** (`ModelRouting`), never hardcoded.

**Boundary:** agents PROPOSE, never RESOLVE. No dice rolling, no damage math, no state mutation here — call into `rules-engine` for validation only. No direct DB access.

## Agent contracts

- **intent/** — classifies free text into combat | check | social | exploration | ooc. Cheapest model (gemini-3-flash / gpt-5.4-nano), `reasoning_effort: low`. Skipped when the client sends structured actions.
- **tactical/** — emits `ExecuteTurn` tool calls. Resilience loop is mandatory: engine validates → on rejection retry ONCE with the machine-readable reason → on second failure use the deterministic fallback (attack nearest legal target, else dodge). Log every rejection as an `action_rejected` event.
- **narrative/** — claude-sonnet-5, streaming. English payload in, Hebrew prose out (≤3 sentences, ends prompting the player). Uses `docs/prompts/hebrew-glossary.md` terms and respects `grammaticalGender`. Never restates numbers the engine didn't produce.

## Prompt rules

- Prompts live in `docs/prompts/`, versioned, English-only internals.
- Cache-stable prefix ordering: static system + glossary → semi-static (character sheet, NPC cards) → dynamic turn state. Don't interleave dynamic content into the static prefix — it breaks prompt caching.
- Combat context = compact structured state snapshot (positions, HP, conditions, initiative), NOT raw dialogue history.

## Testing

- Unit tests with a mocked provider (no live API calls in CI).
- Live-model quality/legality benchmarks belong in `tools/sim`, not here.

## Commands

```bash
pnpm --filter @ai-dm/agents test | typecheck | build
```
