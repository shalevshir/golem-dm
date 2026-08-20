# Player characters

**Not SRD content.** These are our own character sheets. SRD 5.2.1 material —
monsters, classes, conditions, weapons, armor, skills — lives in `data/srd/`
under the licence and attribution rules described there and in `NOTICE.md`.

Files are JSON validated against `CharacterSheet` in `@ai-dm/schemas`, and
additionally cross-checked at load time against four fields. `proficiencyBonus`,
`combat.armorClass` and `combat.initiativeModifier` are stored here but are
also derivable, and `assertSheetConsistent` refuses a file where a stored
value disagrees with what it derives to. `savingThrowProficiencies` is the
fourth: it is stored here but also declared by the class definition, and is
checked against the class's own list rather than against a derived value.

`inconsistent-fixture.json` is a deliberately-broken test fixture, not a
playable character — a copy of `hero.json` with `proficiencyBonus` changed to
6 so it disagrees with its own derivation. It exists to prove the load-time
cross-check actually runs; do not "fix" it to be consistent.

`second-fixture.json` is a second, fully valid and self-consistent copy of
`hero.json` (own `characterId: "second-fixture"`), kept only so a test can
load a character that is guaranteed never already cached under another
test's key.

`mislabeled-fixture.json` is also a deliberately-broken test fixture: a copy
of `hero.json` whose `characterId` field still says `"hero"`, filed under a
different name. It exists to prove `loadCharacter` refuses a file that
disagrees with the id it was requested under; do not rename it to match.
