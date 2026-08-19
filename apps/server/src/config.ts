// Boot configuration, validated with zod and failing fast. A server that
// starts without the key it needs fails on the first player's first turn
// instead of at boot, which is the worst possible time to find out.
//
// No key is ever logged or echoed into an event.
import { z } from "zod";

const LogLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

const RawEnv = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, "PORT must be a number")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535))
    .optional(),
  LOG_LEVEL: LogLevel.optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
});

export interface ServerConfig {
  port: number;
  logLevel: z.infer<typeof LogLevel>;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = RawEnv.parse(env);

  // Which providers are needed depends on `ModelRouting`, which is config; all
  // this can check is that the process could talk to something at all.
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
