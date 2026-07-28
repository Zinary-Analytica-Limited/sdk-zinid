import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Type-level assertions (expectTypeOf / @ts-expect-error) are erased at
    // runtime, so they only mean anything under typecheck mode.
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
