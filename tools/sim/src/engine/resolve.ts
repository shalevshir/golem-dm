// `applyTurn` moved to `@ai-dm/rules-engine` (step 8): the server needs it too,
// and nothing may depend on this package. Re-exported here so the sim's own
// imports and its historical module path keep working.
export {
  applyTurn,
  type ApplyTurnInput,
  type ApplyTurnResult,
  type AttackRecord,
  type ResolveContext,
  type TurnEffect,
} from "@ai-dm/rules-engine";
