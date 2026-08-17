// Wall-clock timing for model calls, as an optional decorator around any
// `LanguageModelPort`.
//
// It lives beside the port rather than in `tools/sim` because two callers need
// it and they cannot share code any other way: the step 7b benchmark wants
// per-attempt tactical latency, and the server wants per-turn latency for its
// metrics — and `server` cannot depend on `sim`. The port is the only seam
// both already stand on.
//
// Timing at the port rather than inside an agent is what makes step 9's
// "first token < 1.5s p50" measurable at all: that is a property of a stream,
// which no wrapper around `proposeTurn` can observe.
//
// The clock is a parameter, never ambient. Agent logic stays clock-free — a
// caller opts into timing by wrapping, and nothing underneath can read a clock.
import type { AdapterResult } from "./errors.js";
import type {
  LanguageModelPort,
  StreamChunk,
  StructuredOutput,
  StructuredRequest,
  TextOutput,
  TextRequest,
} from "./port.js";
import type { ModelSpec } from "./routing.js";

export type TimedCallKind = "structured" | "text" | "stream";

export interface CallTiming {
  kind: TimedCallKind;
  /** Call to settled. Failures are timed too — a slow failure still spends the turn budget. */
  durationMs: number;
  /**
   * Call to first chunk. Streams only, and absent when the stream yielded
   * nothing. This is the number step 9's first-token budget is measured against.
   */
  firstChunkMs?: number;
}

export interface TimingPortOptions {
  /** Injected so tests can script exact values instead of racing a real clock. */
  now?: () => number;
}

export interface TimingPort extends LanguageModelPort {
  readonly timings: readonly CallTiming[];
}

export function createTimingPort(
  inner: LanguageModelPort,
  options: TimingPortOptions = {},
): TimingPort {
  const now = options.now ?? ((): number => Date.now());
  const timings: CallTiming[] = [];

  async function timed<T>(kind: TimedCallKind, run: () => Promise<T>): Promise<T> {
    const started = now();
    try {
      // `await` inside the try, not a bare return: without it the `finally`
      // would record the time to *start* the call rather than to finish it.
      return await run();
    } finally {
      timings.push({ kind, durationMs: now() - started });
    }
  }

  return {
    timings,

    generateStructured<T>(
      spec: ModelSpec,
      request: StructuredRequest<T>,
    ): Promise<AdapterResult<StructuredOutput<T>>> {
      return timed("structured", () => inner.generateStructured(spec, request));
    },

    generateText(spec: ModelSpec, request: TextRequest): Promise<AdapterResult<TextOutput>> {
      return timed("text", () => inner.generateText(spec, request));
    },

    streamText(spec: ModelSpec, request: TextRequest): AsyncIterable<StreamChunk> {
      // Start the clock where the caller made the call, not where it first
      // iterates — the provider is already working in between.
      const started = now();
      const source = inner.streamText(spec, request);

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<StreamChunk> {
          let firstChunkMs: number | undefined;
          try {
            for await (const chunk of source) {
              // `??=` short-circuits, so the clock is read once, not per chunk.
              firstChunkMs ??= now() - started;
              yield chunk;
            }
          } finally {
            // In `finally` so a consumer that breaks out early is still timed.
            timings.push({
              kind: "stream",
              durationMs: now() - started,
              ...(firstChunkMs === undefined ? {} : { firstChunkMs }),
            });
          }
        },
      };
    },
  };
}
