// Adapter outcomes are returned, never thrown — the same choice
// `validateExecuteTurn` makes in the rules engine. A caller branches on a
// stable code instead of parsing an exception message, and the tactical
// resilience loop in step 7 can log the code straight into an
// `action_rejected` event.
import type { ZodIssue } from "zod";

/**
 * Every way a model call can fail to produce something usable. Each code maps
 * to a different caller decision:
 *
 * - `no_tool_call`             — retry plainly; the model answered in prose.
 * - `schema_validation_failed` — retry quoting `issues` back at the model.
 * - `provider_error`           — the model is not the problem; fall back.
 * - `aborted`                  — the turn budget is gone; abandon it.
 */
export type AdapterErrorCode =
  | "no_tool_call"
  | "schema_validation_failed"
  | "provider_error"
  | "aborted";

export interface AdapterError {
  code: AdapterErrorCode;
  /** English. Safe to persist in the event log; never shown to a player. */
  message: string;
  /** Why the proposal did not match. Only for `schema_validation_failed`. */
  issues?: readonly ZodIssue[];
  /** The originating SDK error, kept for logs. Never rendered. */
  cause?: unknown;
}

export interface AdapterSuccess<T> {
  ok: true;
  value: T;
}

export interface AdapterFailure {
  ok: false;
  error: AdapterError;
}

export type AdapterResult<T> = AdapterSuccess<T> | AdapterFailure;

export function adapterSuccess<T>(value: T): AdapterSuccess<T> {
  return { ok: true, value };
}

export function adapterFailure(
  code: AdapterErrorCode,
  message: string,
  diagnostics: { issues?: readonly ZodIssue[]; cause?: unknown } = {},
): AdapterFailure {
  // Spread conditionally: `exactOptionalPropertyTypes` distinguishes an absent
  // key from one explicitly set to undefined, and the tests assert absence.
  return {
    ok: false,
    error: {
      code,
      message,
      ...(diagnostics.issues === undefined ? {} : { issues: diagnostics.issues }),
      ...(diagnostics.cause === undefined ? {} : { cause: diagnostics.cause }),
    },
  };
}
