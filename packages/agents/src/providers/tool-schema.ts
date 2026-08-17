// The literal tool definition sent to a model, derived from zod (invariant 4 —
// a hand-written JSON schema would be a second source of truth that silently
// drifts from the one the engine validates against).
//
// The port hands `generateObject` the zod schema directly, so this exists for
// the callers that need the definition itself: tools/sim recording which schema
// version a model was benchmarked against, and the server logging it beside
// `action_rejected` events.
import type { ZodTypeAny } from "zod";
import type { JsonSchema7Type } from "zod-to-json-schema";
import { zodToJsonSchema } from "zod-to-json-schema";

export function toolJsonSchema(schema: ZodTypeAny, name: string): JsonSchema7Type {
  return zodToJsonSchema(schema, name);
}
