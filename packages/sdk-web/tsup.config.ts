import { defineConfig } from 'tsup';

export default defineConfig([
  // ESM + CJS + type declarations for npm consumers.
  {
    entry: { zinid: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
  },
  // Minified IIFE for CDN <script> usage (unpkg/jsdelivr), exposed as window.ZinID.
  {
    entry: { zinid: 'src/index.ts' },
    format: ['iife'],
    globalName: 'ZinID',
    minify: true,
    sourcemap: true,
    target: 'es2020',
    outExtension: () => ({ js: '.min.js' }),
  },
]);
