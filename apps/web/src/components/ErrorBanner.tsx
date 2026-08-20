// Server error codes and turn rejections, rendered in Hebrew.
//
// Per the spec's error table, `not_your_turn` is deliberately NOT surfaced —
// it means a stale click, and the affordance frame governs what is clickable.
// `free_text_not_supported` is unreachable because no free-text UI ships.
import type { JSX } from "react";
import { errorMessage, he, rejectionMessage } from "../i18n.js";

/** Ignored on purpose: a stale click the affordance frame already governs. */
const SILENT_CODES = new Set(["not_your_turn"]);

export interface ErrorBannerProps {
  error: { code: string; message: string } | null;
  rejection: { reasons: string[]; messages: string[] } | null;
  onDismiss: () => void;
  /**
   * The spec's error table lists `internal_error` as "surface, and offer
   * reconnect" — dismiss alone leaves the player on a dead screen, since an
   * `error` frame does not close the socket and nothing else ever retries.
   * Genuinely a reconnect, not a restart: the session survives the faults
   * that raise this code, so `App`'s handler rejoins the same session id
   * from the sequence already folded rather than discarding the fight.
   */
  onReconnect: () => void;
}

export function ErrorBanner(props: ErrorBannerProps): JSX.Element | null {
  const error = props.error !== null && !SILENT_CODES.has(props.error.code) ? props.error : null;
  const reasons = props.rejection?.reasons ?? [];
  if (error === null && reasons.length === 0) return null;

  return (
    <div className="error-banner" role="alert">
      {error !== null && <p>{errorMessage(error.code)}</p>}
      {reasons.map((reason, index) => (
        // Index included: `reasons` is a plain `z.array(z.string())` on the
        // wire (`protocol.ts`), built from `validation.rejections.map(each
        // => each.reason)` in `pipeline.ts` — two sub-actions failing the
        // same way is reachable, so `reason` alone can collide.
        <p key={`${String(index)}-${reason}`}>{rejectionMessage(reason)}</p>
      ))}
      {error?.code === "internal_error" && (
        <button type="button" onClick={props.onReconnect}>
          {he.app.reconnect}
        </button>
      )}
      <button type="button" onClick={props.onDismiss}>
        ✕
      </button>
    </div>
  );
}
