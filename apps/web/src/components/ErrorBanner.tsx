// Server error codes and turn rejections, rendered in Hebrew.
//
// Per the spec's error table, `not_your_turn` is deliberately NOT surfaced —
// it means a stale click, and the affordance frame governs what is clickable.
// `free_text_not_supported` is unreachable because no free-text UI ships.
import type { JSX } from "react";
import { errorMessage, rejectionMessage } from "../i18n.js";

/** Ignored on purpose: a stale click the affordance frame already governs. */
const SILENT_CODES = new Set(["not_your_turn"]);

export interface ErrorBannerProps {
  error: { code: string; message: string } | null;
  rejection: { reasons: string[]; messages: string[] } | null;
  onDismiss: () => void;
}

export function ErrorBanner(props: ErrorBannerProps): JSX.Element | null {
  const error = props.error !== null && !SILENT_CODES.has(props.error.code) ? props.error : null;
  const reasons = props.rejection?.reasons ?? [];
  if (error === null && reasons.length === 0) return null;

  return (
    <div className="error-banner" role="alert">
      {error !== null && <p>{errorMessage(error.code)}</p>}
      {reasons.map((reason) => (
        <p key={reason}>{rejectionMessage(reason)}</p>
      ))}
      <button type="button" onClick={props.onDismiss}>
        ✕
      </button>
    </div>
  );
}
