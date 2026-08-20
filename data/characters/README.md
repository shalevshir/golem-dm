# Player characters

**Not SRD content.** These are our own character sheets. SRD 5.2.1 material —
monsters, classes, conditions, weapons, armor, skills — lives in `data/srd/`
under the licence and attribution rules described there and in `NOTICE.md`.

Files are JSON validated against `CharacterSheet` in `@ai-dm/schemas`, and
additionally cross-checked at load time: `proficiencyBonus`,
`combat.armorClass` and `combat.initiativeModifier` are stored here but are
also derivable, and `assertSheetConsistent` refuses a file where the two
disagree.

`inconsistent-fixture.json` is a deliberately-broken test fixture, not a
playable character — a copy of `hero.json` with `proficiencyBonus` changed to
6 so it disagrees with its own derivation. It exists to prove the load-time
cross-check actually runs; do not "fix" it to be consistent.
