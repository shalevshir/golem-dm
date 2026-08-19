// Boot configuration, validated with zod and failing fast. A server that
// starts without the key it needs fails on the first player's first turn
// instead of at boot, which is the worst possible time to find out.
//
// No key is ever logged or echoed into an event.
import { z } from "zod";

const LogLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

// A `.env` loader (dotenv, Node's own --env-file) materialises a blank
// `KEY=` line as `""`, not as absent. `.env.example` ships every key blank
// as a self-documenting placeholder, so a blank string must collapse to
// `undefined` here — otherwise copying the template and filling in only the
// one provider key you actually have throws on the other two before the
// "set at least one" check ever runs.
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const RawEnv = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, "PORT must be a number")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535))
    .optional(),
  LOG_LEVEL: LogLevel.optional(),
  ANTHROPIC_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  GOOGLE_GENERATIVE_AI_API_KEY: optionalSecret,
});

export interface ServerConfig {
  port: number;
  logLevel: z.infer<typeof LogLevel>;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = RawEnv.parse(env);

  // Which providers are actually needed depends on `ModelRouting`
  // (`packages/agents/src/providers/routing.ts`'s `DEFAULT_MODEL_ROUTING`),
  // which is a source-level constant today, not env-configurable (Important
  // 4, `apps/server/CLAUDE.md`) — this boot check has no way to read it, so
  // all it can verify is that the process could talk to SOME provider at
  // all, not that it holds the specific key(s) the compiled-in routing
  // will actually call.
  const hasKey =
    parsed.ANTHROPIC_API_KEY !== undefined ||
    parsed.OPENAI_API_KEY !== undefined ||
    parsed.GOOGLE_GENERATIVE_AI_API_KEY !== undefined;
  if (!hasKey) {
    throw new Error(
      "Set at least one provider API key: ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.",
    );
  }

  return { port: parsed.PORT ?? 3000, logLevel: parsed.LOG_LEVEL ?? "info" };
}
