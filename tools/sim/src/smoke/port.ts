// `createFakePort` takes its whole script at construction, but the number of
// model calls in an encounter is not known ahead of time, so one script is
// exhausted mid-run. This wraps it: `load` swaps in a fresh fake for each turn,
// and `calls` still accumulates across all of them.
//
// The run loop loads exactly two responses per turn. The tactical agent
// provably never makes a third call — `packages/agents` has a test pinning it —
// so a third call here is a bug worth the exhaustion error it earns.
import { createFakePort } from "@ai-dm/agents";
import type {
  AdapterResult,
  FakePortCall,
  FakePortScript,
  LanguageModelPort,
  ModelSpec,
  StreamChunk,
  StructuredOutput,
  StructuredRequest,
  TextOutput,
  TextRequest,
} from "@ai-dm/agents";

export interface ScriptedPort extends LanguageModelPort {
  /** Replace the script. Calls already recorded are kept. */
  load(script: FakePortScript): void;
  readonly calls: readonly FakePortCall[];
}

export function createScriptedPort(): ScriptedPort {
  const history: FakePortCall[] = [];
  let inner = createFakePort();

  return {
    load(script: FakePortScript): void {
      history.push(...inner.calls);
      inner = createFakePort(script);
    },

    get calls(): readonly FakePortCall[] {
      return [...history, ...inner.calls];
    },

    generateStructured<T>(
      spec: ModelSpec,
      request: StructuredRequest<T>,
    ): Promise<AdapterResult<StructuredOutput<T>>> {
      return inner.generateStructured(spec, request);
    },

    generateText(spec: ModelSpec, request: TextRequest): Promise<AdapterResult<TextOutput>> {
      return inner.generateText(spec, request);
    },

    streamText(spec: ModelSpec, request: TextRequest): AsyncIterable<StreamChunk> {
      return inner.streamText(spec, request);
    },
  };
}
