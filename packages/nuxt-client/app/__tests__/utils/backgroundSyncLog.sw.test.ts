import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BACKGROUND_SYNC_LOG_DB,
  BACKGROUND_SYNC_LOG_KEEP
} from '~/utils/backgroundSyncLog'

/**
 * Service Worker 与页面共用同一个 IndexedDB 日志库，但**不能共享代码**：
 * `public/sw.js` 是静态文件，不经打包，`import` 一个 TS 模块在运行时并不存在。
 * 所以两边各写了一份实现，共用的是「库名 / store 名 / 保留条数 / kind 字符串」这些
 * 数据形状。
 *
 * 这组测试就是钉住这些字面量。漂移的后果很隐蔽：库名不一致会变成两个库，面板只显示
 * 一半事件（看起来像「SW 从没跑过」）；保留条数不一致会让裁剪行为莫名其妙。两者都不会
 * 报错，只会让排查结论错掉 —— 所以必须由测试而不是注释来保证。
 */

// 用 cwd 而不是 import.meta.url：vitest 跑在 happy-dom 环境里，import.meta.url 不是 file: 协议
const SW_PATH = resolve(process.cwd(), 'public/sw.js')
const swSource = readFileSync(SW_PATH, 'utf8')

/** 从 sw.js 源码里抠出一个 `const NAME = <字面量>` 的值 */
function readSwConst(name: string): string | null {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*([^\\n]+)`).exec(swSource)
  if (!match) return null
  return match[1]!.trim().replace(/;$/, '').replace(/^['"]|['"]$/g, '')
}

describe('sw.js 与 backgroundSyncLog 的字面量一致', () => {
  it('日志库名一致', () => {
    expect(readSwConst('SYNC_LOG_DB')).toBe(BACKGROUND_SYNC_LOG_DB)
  })

  it('store 名一致', () => {
    expect(readSwConst('SYNC_LOG_STORE')).toBe('events')
  })

  it('保留条数一致', () => {
    expect(Number(readSwConst('SYNC_LOG_KEEP'))).toBe(BACKGROUND_SYNC_LOG_KEEP)
  })

  it('SW 侧用自增主键（与 TS 侧 keyPath: id 对应）', () => {
    // 主键策略不一致会让两边写到不同的记录形状上，读出来字段缺失
    expect(swSource).toMatch(/keyPath:\s*'id'\s*,\s*autoIncrement:\s*true/)
  })
})

describe('sw.js 记录的 kind 都在 TS 的联合类型里', () => {
  /** TS 侧 BackgroundSyncEventKind 的全部取值 */
  const TS_KINDS = [
    'unsupported',
    'armed',
    'arm-failed',
    'sync-start',
    'sync-ok',
    'sync-failed'
  ]

  it('SW 里出现的每个 kind 字面量都被 TS 侧认识', () => {
    // 找 logBackgroundSync('kind', ...) 的第一个实参
    const kinds = [...swSource.matchAll(/logBackgroundSync\(\s*'([^']+)'/g)].map(m => m[1]!)
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) {
      expect(TS_KINDS).toContain(kind)
    }
  })

  it('SW 会记 sync-start 与 sync-ok（这两条是「到底触发没触发」的核心证据）', () => {
    const kinds = [...swSource.matchAll(/logBackgroundSync\(\s*'([^']+)'/g)].map(m => m[1]!)
    expect(kinds).toContain('sync-start')
    expect(kinds).toContain('sync-ok')
  })
})
