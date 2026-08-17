// Hebrew narrative agent (claude-sonnet-5). Streams tokens to the client.
// Prompt prefix order (cache stability): static system + glossary ->
// semi-static character sheet -> dynamic turn state. English input payload,
// Hebrew output only. Never recomputes numbers — trusts rule-engine outcome.
export {};
