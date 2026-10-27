import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'app'),
      '@': path.resolve(__dirname, 'app'),
      // 运行时按需加载 `pouchdb-browser`（浏览器构建，见 usePouchDb 的 loadPouchDb）；
      // 单测/集成测试在 Node 里用真 PouchDB（leveldb 适配器）建 /tmp 下的临时库，
      // 所以这里把该 specifier 指回 Node 版 `pouchdb` —— 测试里的 PouchDB 与
      // usePouchDb 拿到的是同一个构造函数（pouchdb-find 只注册一次，库实例也是同一个）。
      'pouchdb-browser': 'pouchdb'
    }
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./app/__tests__/setup.ts'],
    include: ['app/**/*.test.ts']
  }
})
