// A scripted `LanguageModelPort` for tests that care about what an agent asked
// for, not about what a model would answer. Exported from the package because
// step 7's tactical-agent tests need the same double.
import type { AdapterResult } from "../errors.js";
import type {
  LanguageModelPort,
  StreamChunk,
  StructuredOutput,
  StructuredRequest,
  TextOutput,
  TextRequest,
} from "../port.js";
import type { LayeredPrompt } from "../prompt.js";
import type { ModelSpec } from "../routing.js";

export type FakeCallKind = "structured" | "text" | "stream";

/** What the double saw. Enough to assert routing and prompt construction. */
export interface RecordedRequest {
  prompt: LayeredPrompt;
  toolName?: string;
  abortSignal?: AbortSignal;
}

export interface FakePortCall {
  kind: FakeCallKind;
  spec: ModelSpec;
  request: RecordedRequest;
}

export interface FakePortScript {
  structured?: readonly AdapterResult<StructuredOutput<unknown>>[];
  text?: readonly AdapterResult<TextOutput>[];
  stream?: readonly (readonly StreamChunk[])[];
}

export interface FakePort extends LanguageModelPort {
  readonly calls: readonly FakePortCall[];
}

function recordedFrom(request: TextRequest, toolName?: string): RecordedRequest {
  return {
    prompt: request.prompt,
    ...(toolName === undefined ? {} : { toolName }),
    ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
  };
}

export function createFakePort(script: FakePortScript = {}): FakePort {
  const calls: FakePortCall[] = [];
  const structured = [...(script.structured ?? [])];
  const text = [...(script.text ?? [])];
  const stream = [...(script.stream ?? [])];

  // A double that quietly returns undefined turns one test failure into a
  // baffling one somewhere else. Run out of script, say so.
  function exhausted(kind: FakeCallKind): Error {
    return new Error(`Fake port script exhausted: no ${kind} result left to replay.`);
  }

  return {
    calls,

    generateStructured<T>(
      spec: ModelSpec,
      request: StructuredRequest<T>,
    ): Promise<AdapterResult<StructuredOutput<T>>> {
      calls.push({ kind: "structured", spec, request: recordedFrom(request, request.toolName) });
      const next = structured.shift();
      // Reject rather than throw: the contract is promise-returning, and a
      // synchronous throw from an async-looking call surprises every caller.
      return next === undefined
        ? Promise.reject(exhausted("structured"))
        : Promise.resolve(next as AdapterResult<StructuredOutput<T>>);
    },

    generateText(spec: ModelSpec, request: TextRequest): Promise<AdapterResult<TextOutput>> {
      calls.push({ kind: "text", spec, request: recordedFrom(request) });
      const next = text.shift();
      return next === undefined ? Promise.reject(exhausted("text")) : Promise.resolve(next);
    },

    streamText(spec: ModelSpec, request: TextRequest): AsyncIterable<StreamChunk> {
      // Record on call, not on first iteration — a caller that never iterates
      // still made the call, and the test should see it.
      calls.push({ kind: "stream", spec, request: recordedFrom(request) });
      const chunks = stream.shift();
      if (chunks === undefined) throw exhausted("stream");

      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<StreamChunk> {
          yield* chunks;
        },
      };
    },
  };
}
