import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'app'),
      '@': path.resolve(__dirname, 'app')
    }
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./app/__tests__/setup.ts'],
    include: ['app/**/*.test.ts']
  }
})
