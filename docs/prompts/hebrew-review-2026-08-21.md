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
- Hebrew: אלדד מתקדם בצעדים קלים לעבר הגובלין הלוחם, ומייד משיב בחרב הארוכה שלו. הלהב נוגע במטרה בקצה, פציעה שטחית שכמעט אינה מאטה אותו. הגובלין הלוחם עדיין עומד על רגליו, נכון ועוין.
- Source: model

### Sample 2

- English beats: attacks גובלין לוחם with חרב ארוכה: outcome=hit, severity=solid, target-status=alive
- Hebrew: אלדד מניף את חרבו הארוכה בתנועה נחושה ופוגע בגובלין הלוחם, שמפלט קול כאב כשהלהב חורת בו פצע של ממש. הגובלין מתנדנד אך נותר על רגליו, נחוש להמשיך ולהילחם.
- Source: model

### Sample 3

- English beats: attacks גובלין לוחם with חרב ארוכה: outcome=hit, severity=severe, target-status=alive
- Hebrew: אלדד מסתער בחרבו הארוכה על הגובלין הלוחם ומנחית עליו מכה כבדה שכמעט מכריעה אותו. הגובלין מתנודד מן העוצמה אך עודו נותר על רגליו, מוכן להמשיך ולהילחם. הקרב נמשך, ואלדד עצמו כבר סופג פציעות ניכרות.
- Source: model

### Sample 4

- English beats: attacks גובלין לוחם with חרב ארוכה: outcome=critical_hit, severity=felling, target-status=dead
- Hebrew: אלדד מוציא את חרבו הארוכה בתנופה חדה ופוגע בגובלין הלוחם במלוא הדיוק, פגיעה קריטית שאינה מותירה ספק. הלהב שוקע עמוק, והגובלין הלוחם צונח ללא רוח חיים. על אף הפציעה שספג, אלדד עומד איתן מול האויב האחרון שנותר.
- Source: model

### Sample 5

- English beats: attacks זאבה with חרב ארוכה: outcome=hit, severity=felling, target-status=unconscious
- Hebrew: אלדד מסתער עם חרבו הארוכה ומנחית על זאבה מכה כבדה וחדה, שאינה מותירה לה סיכוי. הגובלינית קורסת תחתיה חסרת הכרה, ושתיקה כבדה נופלת על מה שנותר מן המארב. רק אויב אחד עוד עומד על רגליו מול אלדד.
- Source: model

### Sample 6

- English beats: attacks אלדד with חרב מעוקלת: outcome=miss, target-status=alive
- Hebrew: הגובלין הלוחם מסתער על אלדד ומטיח את חרבו המעוקלת בתנועה חדה, אך הלהב חולף במרחק זעום מגופו. אלדד, אף שפצוע, מצליח להתחמק מן המכה בעור שיניים.
- Source: model

### Sample 7

- English beats: takes a non-attack action
- Hebrew: רעות מגבירה את ערנותה ומתמקדת אך ורק בתנועותיה של האויב שנותר, שוקלת כל צעד בטרם תפעל. גופה נשאר גמיש ומוכן, מותאם לכל תזוזה פתאומית מצד הגובלין. היא ממתינה, קשובה, בלי לחשוף את עצמה למכה.
- Source: model

### Sample 8

- English beats: attempts an action the engine could not resolve
- Hebrew: אלדד מהסס לרגע על השביל היבש, מנסה לבצע מהלך שאינו מתגבש לכדי פעולה של ממש. הרגע חומק בין אצבעותיו מבלי שדבר קורה בפועל.
- Source: model

### Sample 9

- English beats: holds position
- Hebrew: אלדד עומד על עומדו כשהאבק שקע סביבו, ומביט בשני הגובלינים ששכבו חסרי תנועה על השביל היבש. הקרב תם בלי שנדרשה ממנו כל פעולה נוספת, וכוחו נותר שלם ובלתי פגוע. שקט כבד משתרר על המדרון.
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
