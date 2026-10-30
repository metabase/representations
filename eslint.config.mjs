// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "core-spec/**", "examples/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_.+$",
          varsIgnorePattern: "^_.+$",
          ignoreRestSiblings: true,
          destructuredArrayIgnorePattern: "^_.+$",
          caughtErrors: "none",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "prefer-const": ["warn", { destructuring: "all" }],
      eqeqeq: ["warn", "smart"],
      curly: ["warn", "all"],
    },
  },
  {
    // The checks run first with a stand-in SQL parser that throws
    // (`withSqlParser`); a catch that swallows that throw makes the lint skip
    // loading the parser and report wrong findings.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CatchClause",
          message:
            "A catch in the lint can swallow the stand-in SQL parser's throw (withSqlParser). Catch only around code that never reads SQL, and say so in the eslint-disable comment.",
        },
      ],
    },
  },
];
