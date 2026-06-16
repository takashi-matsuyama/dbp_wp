// @ts-check
import eslint from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output (dist = app/lib build, demo-dist = browser-demo bundle) is generated,
    // not source; never lint it. `scripts/` holds Node build tooling (e.g. the demo-seed
    // generator), not app/library source, so it is excluded like the config files are.
    ignores: [
      '**/dist/**',
      '**/demo-dist/**',
      '**/node_modules/**',
      '**/scripts/**',
      '**/*.config.{js,ts}',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: {
      // Parse <script lang="ts"> blocks with the TypeScript parser.
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    // TypeScript and the Svelte compiler resolve identifiers themselves; eslint's
    // no-undef otherwise reports false positives on platform globals.
    files: ['**/*.{ts,svelte}'],
    rules: {
      'no-undef': 'off',
      // Allow `_`-prefixed identifiers to signal an intentionally unused binding (e.g. a
      // positional parameter required by a shared interface but unused in one impl).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
