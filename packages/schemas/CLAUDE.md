# @ai-dm/schemas

## Purpose & boundary

Single source of truth for every shared data shape: character sheets, tactical actions (`ExecuteTurn`), game events, world/grid types. Everything else derives from here — TS types via `z.infer`, runtime validation via `.parse()`, LLM tool definitions via `zod-to-json-schema`.

**Boundary:** zod is the only runtime dependency. No I/O, no game logic, no LLM code. If you're writing behavior, it belongs in `rules-engine` or `agents`.

## Rules

- Never hand-write an interface that duplicates a schema; always `z.infer`.
- Closed enums over free strings (conditions, action types, classes). Widening an enum is a reviewed change — the tactical LLM's tool schema is generated from it.
- Breaking schema changes require updating stored-event compatibility (events are append-only forever; add optional fields or new event types, don't repurpose old ones).
- All field names English camelCase. Hebrew appears only in `*Hebrew`-suffixed content fields.
- `grammaticalGender` is required on characters — Hebrew narration is gendered.

## Testing

Vitest. Each schema: valid fixture parses; invalid fixtures fail with the expected path. Round-trip test for JSON-schema export used by tool calling.

## Commands

```bash
pnpm --filter @ai-dm/schemas test | typecheck | build
```
