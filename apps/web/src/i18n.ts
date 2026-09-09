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
    stalemate: "הקרב הגיע למבוי סתום",
    startFight: "התחל קרב",
    reset: "סיפור חדש",
    resetConfirm: "לוותר על הסיפור הזה ולהתחיל מחדש?",
    reconnect: "התחבר מחדש",
  },
  freeText: {
    placeholder: "מה תרצה לעשות?",
    send: "שלח",
  },
  scene: {
    optionsTitle: "מה אפשר לעשות כאן",
    /** The closing beat of a terminal node, pressed rather than fired on entry. */
    conclude: "לסיים את הפרק",
    /** After it is pressed: the arc is complete and there is nothing further. */
    storyOver: "הסיפור הגיע לסופו",
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
    catalogue_fetch_failed: "טעינת נתוני הקרב נכשלה.",
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
  sheet: {
    level: "רמה",
    hp: "נקודות חיים",
    tempHp: "חיים זמניים",
    armorClass: "שריון",
    speed: "תנועה",
    initiative: "יוזמה",
    passivePerception: "תפיסה פסיבית",
    proficiency: "מיומנות",
    hitDice: "קוביות חיים",
    abilities: "מאפיינים",
    savingThrows: "הצלות",
    skills: "כישורים",
    attacks: "התקפות",
    armor: "שריון גוף",
    carried: "ציוד",
    equipped: "מצויד",
    /** Rendered when the derived sheet has not arrived yet. */
    loading: "טוען גיליון…",
    /** Rendered when it is not coming — the fetch failed and nothing retries. */
    unavailable: "הגיליון אינו זמין כרגע.",
  },
  classes: {
    fighter: "לוחם",
    wizard: "קוסם",
    rogue: "נוכל",
    cleric: "כומר",
  },
  abilities: {
    str: "כוח",
    dex: "זריזות",
    con: "חוסן",
    int: "תבונה",
    wis: "חוכמה",
    cha: "כריזמה",
  },
  skills: {
    acrobatics: "אקרובטיקה",
    animal_handling: "טיפול בבעלי חיים",
    arcana: "כישוף",
    athletics: "אתלטיקה",
    deception: "הטעיה",
    history: "היסטוריה",
    insight: "תובנה",
    intimidation: "הפחדה",
    investigation: "חקירה",
    medicine: "רפואה",
    nature: "טבע",
    perception: "תפיסה",
    performance: "מופע",
    persuasion: "שכנוע",
    religion: "דת",
    sleight_of_hand: "זריזות ידיים",
    stealth: "התגנבות",
    survival: "הישרדות",
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

/**
 * Hebrew label for an ability / skill / class key, falling back to the raw
 * key exactly as `errorMessage` and `rejectionMessage` do: these keys come
 * from `DerivedCharacter`, whose `Skill` and `CharacterClass` unions can
 * widen server-side, and a sheet row rendering blank is worse than one
 * rendering `sleight_of_hand`. A caller showing a fallback is showing Latin
 * text in an RTL page and must wrap it accordingly.
 */
export function abilityLabel(key: string): string {
  const table: Record<string, string | undefined> = he.abilities;
  return table[key] ?? key;
}

export function skillLabel(key: string): string {
  const table: Record<string, string | undefined> = he.skills;
  return table[key] ?? key;
}

export function classLabel(key: string): string {
  const table: Record<string, string | undefined> = he.classes;
  return table[key] ?? key;
}

/** True when the label above fell through to the raw Latin key. */
export function isFallbackLabel(label: string, key: string): boolean {
  return label === key;
}
