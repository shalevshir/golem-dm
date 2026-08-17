// Enemy tactical agent: proposes ExecuteTurn via tool call.
// Resilience loop (never trust the proposal):
//   1. rules-engine validates  2. on rejection, retry ONCE with the
//   machine-readable reason    3. on second failure, deterministic fallback
//   (attack nearest legal target, else dodge). Log every rejection to the
//   event stream for offline analysis.
export {};
