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

A markdown copy here would be a twin that drifts, and loading markdown at
runtime would put file I/O into `@ai-dm/agents`, which must stay pure and
bundleable. `hebrew-glossary.md` stays a data file: it is a table for
non-programmers to edit, not prompt text.
