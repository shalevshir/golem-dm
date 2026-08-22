# Prompt Assets

Versioned prompt templates. English-only internal prompts; Hebrew appears only
in the narrative agent's output instructions and the HE glossary
(hebrew-glossary.md). Order sections static -> semi-static -> dynamic to keep
the cacheable prefix byte-stable.

## Where prompt text actually lives

Agent prompt strings are TypeScript modules, not markdown in this directory,
and those modules are the versioned source of record:

| Agent | Module |
|---|---|
| tactical | `packages/agents/src/tactical/prompt-text.ts` |
| narrative | `packages/agents/src/narrative/prompt-text.ts` |
| rules digest | `packages/agents/src/rules-digest.ts` |

A markdown copy here would be a twin that drifts, and loading markdown at
runtime would put file I/O into `@ai-dm/agents`, which must stay pure and
bundleable. `hebrew-glossary.md` is the one exception, and a deliberate one:
it stays a data file, editable by a non-programmer who is not going to open
a TypeScript module, so it remains the source of record rather than moving
into `prompt-text.ts` like everything else here. The runtime copy the
narrative agent actually sends still has to live in TypeScript for the same
purity reason as the rest of this table — so `narrative/prompt-text.ts`
holds `GLOSSARY_TERMS`, a byte-for-byte copy of this file's table, and a
parity test (`prompt-text.test.ts`) parses `hebrew-glossary.md` and fails
the suite the moment the two disagree. Neither copy can drift silently: the
table is the one a person edits, the module is the one that ships, and the
test is what keeps them the same table.

Creature, action, weapon and armor Hebrew names now live in `data/srd/` and
`data/characters/` as `nameHebrew` fields, not in the glossary. The glossary
covers game *terms* only — rules vocabulary like "saving throw" and
"advantage" — never a proper name.
