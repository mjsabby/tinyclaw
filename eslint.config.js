// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.js'] },
  js.configs.recommended,
  // `strictTypeChecked` is the type-aware set: it can see across files and
  // catches the things a syntactic linter cannot, like a floating promise or a
  // value that is `any` only because a dependency said so.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── the point of the exercise ──────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // A dropped promise in a bridge means a message silently never sends.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],

      // ── relaxed deliberately ───────────────────────────────────────────
      // Off at the boundaries, re-enabled for pure modules further down.
      //
      // This rule trusts the types, and at every edge of this program the
      // types are more optimistic than reality: state.ts guards a `version`
      // field typed as the literal 1 but parsed from a file that can contain
      // anything, and whatsapp.ts guards a value whose failure path is
      // `undefined as unknown as [number, number, number]`. Both reads are
      // "unnecessary" to the checker and load-bearing at runtime.
      '@typescript-eslint/no-unnecessary-condition': 'off',

      // `a || b` and `a ?? b` differ on the empty string, and several sites
      // here mean the former: an empty mimetype must fall back, not win.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',

      // Deleting a computed key off a copied Record is exactly what
      // forgetSession does, and there is no clearer way to write it.
      '@typescript-eslint/no-dynamic-delete': 'off',
      // `noUncheckedIndexedAccess` is on, which makes `arr[i]!` the idiomatic
      // way to index. Banning it would push this code towards `as` casts,
      // which are strictly worse: they silence the checker instead of
      // asserting one known fact about one expression.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Logging interpolates numbers and booleans constantly and there is
      // nothing ambiguous about how either stringifies.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // `return drop(reason)` keeps each guard clause on one line and reads
      // fine. The rule's own fix rewrites it to `return void drop(reason)`,
      // which no-meaningless-void-operator then rejects — so it is off.
      '@typescript-eslint/no-confusing-void-expression': 'off',

      // The agent adapters switch over message types from an external JSON
      // stream that gains variants without warning; ignoring unknown ones is
      // the correct behaviour, not an oversight.
      '@typescript-eslint/switch-exhaustiveness-check': 'off',

      // Implementing an async interface without needing `await` is normal —
      // most of ConsoleTransport is exactly that.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': [
        'error',
        { allow: ['methods', 'asyncMethods', 'arrowFunctions'] },
      ],

      // Unused code is either a mistake or a leftover; `_` opts out explicitly.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // ── general correctness ────────────────────────────────────────────
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Output goes through the logger or the chat, never straight to stdout.
      'no-console': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-implicit-coercion': 'error',
    },
  },
  {
    // Pure logic with no foreign types flowing in, so the checker's view is
    // the whole truth and a redundant condition really is dead code.
    files: ['src/util/**/*.ts', 'src/media.ts', 'src/security.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
  {
    // The self-test is a script: it reports by printing, and its checks are
    // deliberately written as loose truthiness against runtime shapes.
    files: ['src/selftest.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
);
