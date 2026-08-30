import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 15000,
    testTimeout: 15000,
  },
})
