// Single provider-agnostic adapter (Vercel AI SDK). Model choice per role is
// CONFIG, not code:
//   intent:    gemini-3-flash | gpt-5.4-nano
//   tactical:  gemini-3-flash | gpt-5.4-mini   (benchmark in tools/sim)
//   narrative: claude-sonnet-5                  (streaming, prompt caching)
export interface ModelRouting {
  intent: string;
  tactical: string;
  narrative: string;
}
