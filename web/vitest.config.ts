import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/items/doc.ts'],
      reporter: ['text', 'html', 'json-summary'],
    },
  },
});
