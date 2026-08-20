// @ts-check
import tseslint from "typescript-eslint";

/**
 * Lint rules for runmill.
 *
 * Deliberately narrow. `tsc --noEmit` already runs in strict mode and catches
 * most of what a type-aware linter would, so this covers the classes it does
 * not: values that are discarded rather than misused. Floating promises are the
 * one that matters here — an orchestrator that forgets an `await` records a
 * transition before the effect it describes has happened.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "site/**"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The codebase uses `catch {}` deliberately in instrumentation paths,
      // where the comment above each one explains why swallowing is correct.
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/require-await": "off",
      // Reported on template literals holding already-typed values; tsc covers
      // the cases where this would actually be a mistake.
      "@typescript-eslint/restrict-template-expressions": "off",
      // Config and eval-suite parsing reads `unknown` off freshly parsed YAML
      // and JSON and coerces with String(). The linter is right that a nested
      // object would stringify to "[object Object]", but validateConfig is the
      // gate that rejects it, and narrowing every field at the read site would
      // duplicate the schema in imperative code.
      "@typescript-eslint/no-base-to-string": "off",
      // A leading underscore is the codebase's marker for a parameter kept for
      // signature compatibility and deliberately unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Vendor SDK surfaces (Linear, Octokit, better-sqlite3) hand back `any`
      // at the boundary. The adapters narrow immediately; flagging the boundary
      // itself produces noise at exactly the places a type cannot be asserted.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Linear's SDK types some relations as values and some as promises
      // depending on how the query resolved, so awaiting defensively is
      // correct even where the type says it is unnecessary.
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
    },
  },
  {
    // Tests reach into internals and build partial fixtures on purpose.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // contract.test.ts loads package.json and the built CLI through require()
      // on purpose, to see them the way a consumer's resolver would.
      "@typescript-eslint/no-require-imports": "off",
      // `expect(obj.method)` is the assertion, not a call.
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // Fake implementations mirror the shape of the real ones, including the
    // `this` handling their vendor counterparts use.
    files: ["src/testing/**/*.ts"],
    rules: { "@typescript-eslint/no-this-alias": "off" },
  },
);
