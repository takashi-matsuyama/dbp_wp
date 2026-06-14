// @ts-check
import eslint from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.{js,ts}'],
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
    rules: { 'no-undef': 'off' },
  },
);
