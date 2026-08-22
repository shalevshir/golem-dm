# @ai-dm/agents

## Purpose & boundary

The LLM cascade: intent router, enemy tactical agent, Hebrew narrative agent, behind one provider-agnostic adapter (Vercel AI SDK: `@ai-sdk/anthropic|google|openai`). Model selection per role is **config** (`ModelRouting`), never hardcoded.

**Boundary:** agents PROPOSE, never RESOLVE. No dice rolling, no damage math, no state mutation here — call into `rules-engine` for validation only. No direct DB access.

## Agent contracts

- **intent/** — classifies free text into combat | check | social | exploration | ooc. Cheapest model (gemini-3-flash / gpt-5.4-nano), `reasoning_effort: low`. Skipped when the client sends structured actions.
- **tactical/** — emits `ExecuteTurn` tool calls. Resilience loop is mandatory: engine validates → on rejection retry ONCE with the machine-readable reason → on second failure use the deterministic fallback (attack nearest legal target, else dodge). Log every rejection as an `action_rejected` event.
- **narrative/** — claude-sonnet-5, streaming. Takes the narration brief (beats, fight pulse, scene card, recent narrations — English) in, streams Hebrew prose out: 2–3 sentences, no numbers at all (digits or words — severity bands instead), nouns only from the brief's supplied vocabulary (creature/action/condition `nameHebrew`, the scene card), verbs and adjectives agreeing with `grammaticalGender`. The agent itself never falls back — a provider error or a spent turn budget is `apps/server`'s problem: the pipeline's `narrate()` owns the degradation ladder (full Hebrew from the deterministic renderer, or that renderer completing a truncated stream), so `NarrativePort.stream()` stays a plain `AsyncIterable<string>` with no failure branch of its own.

## Prompt rules

- Prompt strings are versioned, English-only TypeScript modules — `tactical/prompt-text.ts`, `narrative/prompt-text.ts`, `rules-digest.ts` — not markdown; `docs/prompts/README.md` explains why. `docs/prompts/hebrew-glossary.md` is the one exception: an editable data file, not prompt text.
- Cache-stable prefix ordering: static system + glossary → semi-static (character sheet, NPC cards) → dynamic turn state. Don't interleave dynamic content into the static prefix — it breaks prompt caching.
- Combat context = compact structured state snapshot (positions, HP, conditions, initiative), NOT raw dialogue history.

## Testing

- Unit tests with a mocked provider (no live API calls in CI).
- Live-model quality/legality benchmarks belong in `tools/sim`, not here.

## Commands

```bash
pnpm --filter @ai-dm/agents test | typecheck | build
```
