# @ai-dm/web

## Purpose & boundary

React 19 + Vite client: interactive canvas battle grid, streaming Hebrew narrative pane, action bar.

**Boundary:** ZERO game logic in the client. Render server state, send intents. Depends only on `@ai-dm/schemas` (message types). All rules questions ("can I move there?") are answered by server-provided affordances (e.g., reachable-tiles set sent with each turn), not recomputed locally.

## UX rules

- Root is RTL Hebrew: `<html dir="rtl" lang="he">`. Wrap embedded LTR fragments (dice notation "2d6+3", English names) in `<bdi>`/`dir="ltr"` spans — mixed-direction text is the #1 Hebrew UI bug.
- Structured actions first: tile clicks and action buttons send typed WS messages that bypass the server's intent parser (cheaper + faster). Free-text input is for social/exploration.
- Render narrative tokens as they stream; never block on turn completion.
- Reconnect: resend last seen event `sequence`; render replayed events idempotently. A **reload** is not a
  reconnect — the fresh tab holds no snapshot, so it rejoins WITHOUT `resumeFrom` (a tail of bare `event`
  frames would be dropped against a null snapshot) and restores the roll log and narration, which the
  server's projection does not carry, from `sessionStorage` via `src/state/persistence.ts`.
- Canvas grid: plain Canvas 2D is fine for POC (≤30×30 tiles); don't add WebGL/Pixi without a perf-based ADR.

## Testing

Vitest + @testing-library/react for components; mock WS. Include one RTL rendering test with mixed Hebrew/dice-notation content.

## Commands

```bash
pnpm --filter @ai-dm/web dev | build | test | typecheck
```
