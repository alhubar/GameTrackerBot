import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat config. The bot is ESM-only Node, so there is one language setting for everything and a
 * second block that adds the `node:test` globals to the suite.
 *
 * `no-console` stays off on purpose: Discord-facing failures in this codebase are deliberately
 * swallowed into `.catch(console.error)`, so console output *is* the error channel, not a leftover.
 */
export default [
  {
    ignores: ['node_modules/**', 'data/**', 'livedbdatacopy/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        // `(_oldPresence, newPresence)` and friends: Discord hands us positional args we don't want.
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-else-return': 'error',
      // Bare `catch {}` is used deliberately to make a Discord call best-effort.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
