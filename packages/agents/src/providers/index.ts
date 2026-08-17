// Single provider-agnostic adapter (Vercel AI SDK). Model choice per role is
// CONFIG, not code — see `routing.ts` and PROJECT_PLAN.md section 3:
//   intent:    gemini-3-flash | gpt-5.4-nano
//   tactical:  gemini-3-flash | gpt-5.4-mini   (benchmark in tools/sim)
//   narrative: claude-sonnet-5                  (streaming, prompt caching)
//
// Agents depend on `LanguageModelPort`, never on the SDK. `vercel.ts` is the
// only file that imports it, so adding a provider touches one file.
export * from "./routing.js";
export * from "./errors.js";
export * from "./prompt.js";
export * from "./port.js";
export * from "./runtime.js";
export * from "./tool-schema.js";
export * from "./vercel.js";

// Exported so step 7's tactical-agent tests script the same double rather than
// writing a second one. Kept under `testing/` to keep its status obvious.
export * from "./testing/fake-port.js";
