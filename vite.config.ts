/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Browser-only app: no backend, no env secrets. Pipeline modules are pure and
// DOM-free, so tests run under Vitest's default node environment.
export default defineConfig({
  root: '.',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
