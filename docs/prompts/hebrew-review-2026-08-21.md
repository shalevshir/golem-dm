# Hebrew review sheet

The Hebrew this change ships — narration samples, SRD proper names, glossary terms and condition labels — in one place, for a native speaker to read and correct (see "Not covered on this sheet" below for what is out of scope). Not a blocking gate — its only job is to give the roadmap's "Hebrew reviewed by native speaker" criterion something concrete to be satisfied against.

## How to review

A correction to a name — a weapon, a piece of armor, a monster, or one of its actions — is a data-only edit to the matching row in `data/srd/weapons.json`, `data/srd/armor.json` or `data/srd/monsters/*.json`. A correction to a condition label is the same kind of edit, to `data/srd/conditions.json` (but read the note below first). A correction to a glossary term — rules vocabulary, never a proper name — is an edit to `docs/prompts/hebrew-glossary.md`; a parity test then requires the identical edit in `packages/agents/src/narrative/prompt-text.ts`, which mirrors this table for runtime use and must never be edited on its own. A correction to the narrator's register or its template wording is an edit to `NARRATIVE_SYSTEM_PROMPT` (`prompt-text.ts`, the model-driven narrator) or to `deterministic.ts` (the terse fallback narrator) — either edit needs a version bump (`NARRATIVE_PROMPT_VERSION`) and a re-pinned content hash, since both are versioned prompt text.

Not covered on this sheet: `apps/web/src/i18n.ts`'s UI strings (the client's own Hebrew, corrected by editing that file directly) and `data/characters/*.json`'s character names — corrected the same way as a weapon or monster row: a data-only edit to that file (but see the note below for the one name that is effectively on this sheet already).

Note: `hero.json`'s `nameHebrew`, "אלדד", is the actor in most of the samples below — but `hero.json` is not what produced them. `tools/sim/src/live/narrative.ts`'s own `ELDAD` fixture is a hardcoded literal, independent of `hero.json`. A correction to `hero.json` alone changes the shipped game's hero and leaves every sample below exactly as it was — correcting אלדד's Hebrew name means editing both files together.

Note: `apps/server/src/encounters/conditions.test.ts` also hardcodes today's Hebrew wording for the `prone` condition, as its own assertion, independently of `conditions.json`. A data-only correction to that row will leave the test asserting the old value — update both together.

Known issue, flagged here rather than left for you to find: `deterministic.ts` (the terse fallback narrator — never the model) glues a preposition directly onto a bare creature name with no definite-article agreement, for example `בגובלין לוחם` and `את גובלין לוחם`. This is the weakest Hebrew this change ships. A fix belongs in `deterministic.ts`, behind the same version bump and re-pinned hash as any other template-wording change described above.

## Narration samples

### Sample 1

- English beats: moves 15ft; attacks גובלין לוחם with חרב ארוכה: outcome=hit, severity=graze, target-status=alive
- Hebrew: אלדד מתקדם על החלוקים המתגלגלים ומצמצם את המרחק בצעד קליל, לוחצת חרבו הארוכה קדימה לעבר גובלין הלוחם. הלהב נוגע בו במגע חטוף בלבד, שריטה שטחית שאינה עוצרת אותו. גובלין הלוחם נותר על רגליו, מוכן להמשיך.
- Source: model

### Sample 2

- English beats: attacks גובלין לוחם with חרב ארוכה: outcome=hit, severity=solid, target-status=alive
- Hebrew: אלדד מסתער קדימה על השביל הצר ומטיח את חרבו הארוכה בגובלין הלוחם, שם ניכר עתה פצע ממשי. חוד הלהב מוצא את מטרתו בדיוק, והגובלין נרתע אך נותר על רגליו בין האבנים הרופפות. האור האדמדם הולך ומעמעם סביבם בעוד הקרב נמשך.
- Source: model

### Sample 3

- English beats: attacks גובלין לוחם with חרב ארוכה: outcome=hit, severity=severe, target-status=alive
- Hebrew: אלדד מסתער קדימה על השביל הצר, ולהב חרבו הארוכה נוחת בחוזקה על גובלין הלוחם. הפגיעה קורעת בו פצע כבד וכמעט מכריע, והוא מתנדנד על רגליו אך עדיין ניצב. האבק והחצץ הרופף מתפזרים סביב רגליהם באור הדועך של בין הערביים.
- Source: model

### Sample 4

- English beats: attacks גובלין לוחם with חרב ארוכה: outcome=critical_hit, severity=felling, target-status=dead
- Hebrew: אלדד פורץ קדימה בתנופה אחת חדה ומטביע את חרבו הארוכה בגוף הגובלין הלוחם, וההכאה נוחתת בדיוק אכזרי שאין ממנו מנוס. הלהב מוצא את המקום הנכון בבת אחת, וגופו של הגובלין קורס ארצה חסר רוח חיים. על השביל הצר, בין האור האדמדם הדועך, אלדד נותר לרגע היחיד הזקוף.
- Source: model

### Sample 5

- English beats: attacks זאבה with חרב ארוכה: outcome=hit, severity=felling, target-status=unconscious
- Hebrew: אלדד מנצל את המדרון הצר ומשלח את חרבו הארוכה בתנועה אחת חדה אל עבר זאבה, וזו נבלמת באמצע נשימתה כשהלהב פוגע בה במלוא עוצמתו. הגוף שלה קורס אל האדמה החצצית, חסר הכרה, וקול ההתרסקות מתגלגל לאורך השביל השקט. עם נפילתה, נדמה כי הקרב על המדרון הזה תם.
- Source: model

### Sample 6

- English beats: attacks אלדד with חרב מעוקלת: outcome=miss, target-status=alive
- Hebrew: הגובלין הלוחם מסתער בחרבו המעוקלת לעבר אלדד, אך הלהב חורק על האוויר בלבד ומחטיא את מטרתו. אלדד, פצוע וכבד־נשימה, נותר עומד על השביל התלול, בעוד האבק הנרמס תחת רגליהם מתערבל באור השוקע.
- Source: model

### Sample 7

- English beats: takes a non-attack action
- Hebrew: רעות נעה בזהירות על השביל הצר, מותאמת את עצמה למדרון ולחצץ הרופף מתחת לרגליה, ובוחרת שלא להסתכן בהתקפה הפעם. היא מתכנסת לתוך עצמה, קשובה וממוקדת, שומרת על יציבותה מול היריב שעדיין ניצב מולה.
- Source: model

### Sample 8

- English beats: attempts an action the engine could not resolve
- Hebrew: אלדד עוצר לרגע על השביל הצר, כאילו מבקש לפעול, אך התנועה מתפוגגת בטרם לבשה צורה. משהו במאמץ נשאר תלוי באוויר הדומם של בין הערביים, בלי שיתרגם לכלום. הוא נותר במקומו, והרגע חולף מבלי להותיר עקבות.
- Source: model

### Sample 9

- English beats: holds position
- Hebrew: אלדד עומד דומם על השביל הצר, בלי לזוז ובלי לפעול, בעוד האור האדמדם של בין הערביים הולך ומעמעם מעליו. האבק הדק שעל הקרקע נותר שאנן תחת רגליו, וקול הנשימה שלו הוא הדבר היחיד שממלא את הדממה. הוא נותר כך, שקוע במקומו, בעוד המדרון השקט משתרע לעברו הערוץ היבש.
- Source: model

## Names

### Weapons

| English | Hebrew |
| --- | --- |
| Club | אלה |
| Dagger | פגיון |
| Greatclub | אלה גדולה |
| Handaxe | גרזן יד |
| Javelin | כידון |
| Light Hammer | פטיש קל |
| Mace | שרביט קרב |
| Quarterstaff | מוט לחימה |
| Sickle | מגל |
| Spear | חנית |
| Dart | חץ יד |
| Light Crossbow | קשת רוחב קלה |
| Shortbow | קשת קצרה |
| Sling | קלע |
| Battleaxe | גרזן קרב |
| Flail | מגלב קרב |
| Glaive | רומח־להב |
| Greataxe | גרזן ענק |
| Greatsword | חרב ענק |
| Halberd | הלברד |
| Lance | רומח פרשים |
| Longsword | חרב ארוכה |
| Maul | קורנס |
| Morningstar | כוכב שחר |
| Pike | כידון ארוך |
| Rapier | סיף |
| Scimitar | חרב מעוקלת |
| Shortsword | חרב קצרה |
| Trident | קלשון |
| Warhammer | פטיש קרב |
| War Pick | מכוש קרב |
| Whip | שוט |
| Blowgun | רובה נשיפה |
| Hand Crossbow | קשת רוחב יד |
| Heavy Crossbow | קשת רוחב כבדה |
| Longbow | קשת ארוכה |
| Musket | מוסקט |
| Pistol | אקדח |

### Armor

| English | Hebrew |
| --- | --- |
| Padded Armor | שריון מרופד |
| Leather Armor | שריון עור |
| Studded Leather Armor | שריון עור ממוסמר |
| Hide Armor | שריון פרווה |
| Chain Shirt | כותונת טבעות |
| Scale Mail | שריון קשקשים |
| Breastplate | שריון חזה |
| Half Plate Armor | חצי שריון לוחות |
| Ring Mail | שריון טבעות |
| Chain Mail | שריון שרשראות |
| Splint Armor | שריון רצועות |
| Plate Armor | שריון לוחות |
| Shield | מגן |

### Monsters

| English | Hebrew |
| --- | --- |
| Bandit | שודד |
| Bandit Captain | קפטן שודדים |
| Boar | חזיר בר |
| Cultist | חבר כת |
| Goblin Minion | גובלין משרת |
| Goblin Warrior | גובלין לוחם |
| Guard | שומר |
| Ogre | אוגר |
| Skeleton | שלד |
| Wolf | זאב |
| Zombie | זומבי |

### Actions

| English | Hebrew |
| --- | --- |
| Scimitar | חרב מעוקלת |
| Light Crossbow | קשת רוחב קלה |
| Pistol | אקדח |
| Gore | נגיחה |
| Ritual Sickle | מגל פולחן |
| Dagger | פגיון |
| Shortbow | קשת קצרה |
| Spear | חנית |
| Greatclub | אלה גדולה |
| Javelin | כידון |
| Shortsword | חרב קצרה |
| Bite | נשיכה |
| Slam | מהלומה |

## Glossary and conditions

### Glossary

| English | Hebrew |
| --- | --- |
| saving throw | גלגול הצלה |
| hit points | נקודות פגיעה |
| armor class | דרגת שריון (דרג"ש) |
| ability check | בדיקת תכונה |
| skill check | בדיקת מיומנות |
| advantage / disadvantage | יתרון / חיסרון |
| initiative | יוזמה |
| spell slot | חריץ לחשים |
| attack roll | גלגול תקיפה |
| hit | פגיעה |
| miss | החטאה |
| critical hit | פגיעה קריטית |
| damage | נזק |
| round | סבב |
| turn | תור |
| action | פעולה |
| bonus action | פעולת בונוס |
| reaction | תגובה |
| movement | תנועה |
| reach | טווח הושטה |
| range | טווח |
| cover | מחסה |
| condition | מצב |
| death saving throw | גלגול הצלה ממוות |

### Conditions

| English | Hebrew |
| --- | --- |
| Blinded | עיוור |
| Charmed | מוקסם |
| Deafened | חירש |
| Exhaustion | תשישות |
| Frightened | מבועת |
| Grappled | אחוז |
| Incapacitated | נטול יכולת |
| Invisible | בלתי נראה |
| Paralyzed | משותק |
| Petrified | מאובן |
| Poisoned | מורעל |
| Prone | שרוע |
| Restrained | כבול |
| Stunned | המום |
| Unconscious | מחוסר הכרה |
