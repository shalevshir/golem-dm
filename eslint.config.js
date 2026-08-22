// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.gen.ts",
      // Compiled by drizzle-kit, not by any package tsconfig, so the
      // type-aware rules have no project to resolve it against.
      "packages/memory/drizzle.config.ts",
      "packages/memory/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        // Root-level config files live outside every package tsconfig; let the
        // project service fall back to an inferred project for them.
        projectService: { allowDefaultProject: ["*.js"] },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }]
    }
  },
  // Type-aware rules need a tsconfig; plain JS config files have none.
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] }
);
