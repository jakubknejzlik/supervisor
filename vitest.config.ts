import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/*/test/*.test.mjs', 'packages/*/test/*.test.mjs', 'infra/test/*.test.mjs', 'scripts/test/*.test.mjs'], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false } });
