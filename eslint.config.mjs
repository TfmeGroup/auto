import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';

/**
 * Lint for TFME Auto. The recommended rule sets for JavaScript, TypeScript, React hooks and Next.js (including its web-vitals rules),
 * plus a few rules that protect the product's own promises (no AI libraries, no console in server code, no accidental `debugger`).
 * Type correctness is enforced separately by `npm run typecheck` (strict, noUnusedLocals).
 */
export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'src/generated/**', 'storage-data/**', '.local-data/**', 'coverage/**', 'out/**', 'next-env.d.ts', '**/*.tsbuildinfo', '.eslint-report.json'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'no-debugger': 'error',
      // Money and phone formats deliberately contain non-breaking spaces inside strings, templates, comments and patterns.
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipTemplates: true, skipRegExps: true, skipJSXText: true }],
      'no-restricted-imports': ['error', { patterns: [
        { group: ['openai', 'openai/*', '@anthropic-ai/*', '@google/generative-ai', '@google-cloud/vertexai', 'langchain', 'langchain/*', '@langchain/*', 'ai', 'ai/*', '@huggingface/*', 'cohere-ai', 'replicate'], message: 'TFME Auto has no AI: no model providers or AI SDKs.' },
      ] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Server code logs through the structured logger, never console.
    files: ['src/server/**/*.ts', 'src/app/api/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // Tests and one-off scripts may use loose typing and the console.
    files: ['tests/**/*.ts', 'scripts/**/*.{ts,cjs,mjs}', '**/*.cjs'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off', '@typescript-eslint/no-require-imports': 'off' },
  },
);
