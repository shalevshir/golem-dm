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
    reconnect: "התחבר מחדש",
  },
  freeText: {
    placeholder: "מה תרצה לעשות?",
    send: "שלח",
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
    unknown_campaign: "המשחק הזה כבר לא קיים.",
    malformed_message: "שגיאת תקשורת בלקוח.",
    turn_in_progress: "התור עדיין מתבצע.",
    free_text_not_supported: "טקסט חופשי אינו נתמך עדיין.",
    not_your_turn: "זה לא תורך.",
    internal_error: "שגיאת שרת.",
  },
  rejections: {
    actor_cannot_act: "הדמות אינה יכולה לפעול.",
    actor_cannot_move: "הדמות אינה יכולה לזוז.",
    actor_incapacitated: "הדמות מנוטרלת ואינה יכולה לפעול.",
    actor_mismatch: "הפעולה מיועדת לדמות אחרת.",
    action_already_used: "כבר השתמשת בפעולה שלך.",
    bonus_action_already_used: "כבר השתמשת בפעולת הבונוס שלך.",
    reaction_already_used: "כבר השתמשת בתגובה שלך.",
    spell_slot_unavailable: "אין לך משבצת לחש פנויה.",
    extra_attacks_exceed_budget: "יותר מדי התקפות בפעולה אחת.",
    extra_attacks_without_attack_action: "התקפות נוספות דורשות פעולת התקפה.",
    movement_exceeds_speed: "המרחק גדול מהתנועה שנותרה.",
    movement_path_blocked: "אין מסלול לשם.",
    destination_off_grid: "היעד מחוץ למפה.",
    destination_occupied: "היעד תפוס.",
    target_not_found: "המטרה לא נמצאה.",
    target_out_of_reach: "המטרה רחוקה מדי.",
    target_behind_full_cover: "המטרה מוסתרת לחלוטין.",
  },
  log: {
    heading: "יומן קרב",
    turnOf: "תור",
    hit: "פגיעה",
    criticalHit: "פגיעה קריטית",
    miss: "החטאה",
    criticalMiss: "החטאה קריטית",
    vsArmor: "מול שריון",
    damage: "נזק",
    moved: "זז",
    feet: "רגל",
    forfeited: "התור פג — לא בוצעה פעולה",
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

const UNIVERSAL_ACTION_LABELS: Record<string, string | undefined> = {
  dodge: he.actions.dodge,
  dash: he.actions.dash,
  disengage: he.actions.disengage,
};

/** Hebrew label for an action type that has no `actionId` (dodge/dash/
 *  disengage). `undefined` for anything else — `attack`/`cast_spell`/etc.
 *  get their name from the catalogue instead, never from this table. */
export function actionLabel(actionType: string): string | undefined {
  return UNIVERSAL_ACTION_LABELS[actionType];
}
