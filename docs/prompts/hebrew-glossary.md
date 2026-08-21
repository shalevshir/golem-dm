# Hebrew TTRPG Glossary (canonical terms for the narrative agent)

| English | Hebrew |
|---|---|
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

Note: narration must respect the player's grammatical gender
(CharacterSheet.grammaticalGender).

Condition names are **not** listed here — they live as `nameHebrew` on
`data/srd/conditions.json`, so a condition has exactly one Hebrew name in the
repo. This table is rules vocabulary only. `packages/agents/src/narrative/prompt-text.ts`
holds the runtime copy of this table; a parity test fails if the two disagree.
