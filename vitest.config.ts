import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
  resolve: {
    // Allow test files to import source modules via their .js extensions
    // (NodeNext/ESM style) while vitest resolves them to .ts files directly.
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
});
