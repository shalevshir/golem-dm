// Single provider-agnostic adapter (Vercel AI SDK). Model choice per role is
// CONFIG, not code — see `routing.ts` and PROJECT_PLAN.md section 3:
//   intent:    gpt-5.4-nano @ low effort        (google cannot express its union)
//   summary:   gemini-3.1-flash-lite            (text only, no tool schema)
//   tactical:  gpt-5.4-nano @ high effort       (set by the step 7b benchmark)
//   narrative: claude-sonnet-5                  (streaming, prompt caching)
//
// Agents depend on `LanguageModelPort`, never on the SDK. `vercel.ts` is the
// only file that imports it, so adding a provider touches one file.
export * from "./routing.js";
export * from "./errors.js";
export * from "./prompt.js";
export * from "./port.js";
export * from "./runtime.js";
export * from "./timing.js";
export * from "./tool-schema.js";
export * from "./vercel.js";
export * from "./embedding-port.js";
export * from "./vercel-embedding.js";

// Exported so step 7's tactical-agent tests script the same double rather than
// writing a second one. Kept under `testing/` to keep its status obvious.
export * from "./testing/fake-port.js";
export * from "./testing/fake-embedding-port.js";
