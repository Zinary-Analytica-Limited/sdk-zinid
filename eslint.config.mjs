import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import noSecrets from 'eslint-plugin-no-secrets';

export default tseslint.config(
  {
    ignores: ['**/dist/', '**/coverage/', '**/playwright-report/', '**/test-results/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: { 'no-secrets': noSecrets },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-secrets/no-secrets': ['error', { tolerance: 4.5 }],
    },
  },
);
