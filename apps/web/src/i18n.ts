// The only file in the client with Hebrew literals. Everything else — state,
// wire messages, code, comments — is English (invariant 2); Hebrew exists at
// the UI boundary and here is that boundary.
//
// Both lookups fall back to the raw English key. Rejection reasons are open
// strings on the wire (their type lives downstream in the rules engine) and
// `ServerErrorCode` can widen, so a client that renders nothing for an unknown
// code would silently swallow the one message the player needed.

export const he = {
  app: {
    title: "מבוך",
    connecting: "מתחבר…",
    reconnecting: "מתחבר מחדש…",
    yourTurn: "תורך",
    waiting: "ממתין…",
    victory: "ניצחתם",
    defeat: "הובסתם",
    startFight: "התחל קרב",
  },
  actions: {
    dodge: "התחמקות",
    dash: "ריצה",
    disengage: "ניתוק",
    confirm: "אשר",
    cancel: "בטל",
    move: "תנועה",
  },
  errors: {
    unknown_session: "המשחק הזה כבר לא קיים.",
    malformed_message: "שגיאת תקשורת בלקוח.",
    turn_in_progress: "התור עדיין מתבצע.",
    free_text_not_supported: "טקסט חופשי אינו נתמך עדיין.",
    not_your_turn: "זה לא תורך.",
    internal_error: "שגיאת שרת.",
  },
  rejections: {
    actor_cannot_act: "הדמות אינה יכולה לפעול.",
    actor_cannot_move: "הדמות אינה יכולה לזוז.",
    actor_incapacitated: "הדמות משותקת.",
    action_already_used: "כבר השתמשת בפעולה שלך.",
    bonus_action_already_used: "כבר השתמשת בפעולת הבונוס שלך.",
    movement_exceeds_speed: "המרחק גדול מהתנועה שנותרה.",
    movement_path_blocked: "אין מסלול לשם.",
    destination_off_grid: "היעד מחוץ למפה.",
    destination_occupied: "היעד תפוס.",
    target_not_found: "המטרה לא נמצאה.",
    target_out_of_reach: "המטרה רחוקה מדי.",
    target_behind_full_cover: "המטרה מוסתרת לחלוטין.",
  },
} as const;

export function errorMessage(code: string): string {
  const table: Record<string, string | undefined> = he.errors;
  return table[code] ?? code;
}

export function rejectionMessage(reason: string): string {
  const table: Record<string, string | undefined> = he.rejections;
  return table[reason] ?? reason;
}
