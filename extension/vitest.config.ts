import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', '../vision/src/**/*.test.ts'],
    environment: 'happy-dom',
    globals: true
  }
});