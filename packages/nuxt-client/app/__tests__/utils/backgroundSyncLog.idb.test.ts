import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import {
  BACKGROUND_SYNC_LOG_KEEP,
  appendBackgroundSyncEvent,
  clearBackgroundSyncEvents,
  readBackgroundSyncEvents
} from '~/utils/backgroundSyncLog'

/**
 * 真实的 IndexedDB 读写（用 fake-indexeddb 顶掉浏览器实现）。
 *
 * 为什么必须有这组：上面那组「无 IndexedDB」的降级测试只能证明**失败时不崩**，
 * 证明不了**成功时写得对**。而写坏了的表现是面板永远空白 —— 与「后台同步没触发」
 * 完全一样，正是排查时最不能接受的假阴性。
 *
 * 这里钉三件事：写入能读回、最新在前、超过上限裁掉最旧的。
 */

/** 每个用例从一个空库开始，避免相互污染 */
async function resetDb(): Promise<void> {
  await clearBackgroundSyncEvents()
}

beforeEach(async () => {
  vi.resetModules()
  await resetDb()
})

describe('backgroundSyncLog 真实读写', () => {
  it('写进去能读回来（字段完整）', async () => {
    await appendBackgroundSyncEvent('armed', '已登记后台同步')

    const events = await readBackgroundSyncEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'armed',
      message: '已登记后台同步'
    })
    expect(events[0]!.id).toBeTypeOf('number')
    // 时间是 ISO 字符串，且能被 Date 解析
    expect(Number.isNaN(new Date(events[0]!.at).getTime())).toBe(false)
  })

  it('data 会原样带上', async () => {
    await appendBackgroundSyncEvent('sync-failed', '失败', { status: 500 })

    const events = await readBackgroundSyncEvents()
    expect(events[0]!.data).toEqual({ status: 500 })
  })

  it('没给 data 时字段不存在（而不是 null）', async () => {
    await appendBackgroundSyncEvent('sync-start', '开始')

    const events = await readBackgroundSyncEvents()
    expect(events[0]!.data).toBeUndefined()
  })

  it('最新在前', async () => {
    await appendBackgroundSyncEvent('armed', '第一条')
    await appendBackgroundSyncEvent('sync-start', '第二条')
    await appendBackgroundSyncEvent('sync-ok', '第三条')

    const events = await readBackgroundSyncEvents()
    expect(events.map(e => e.kind)).toEqual(['sync-ok', 'sync-start', 'armed'])
  })

  it('limit 只取最近 N 条', async () => {
    for (let i = 0; i < 5; i += 1) {
      await appendBackgroundSyncEvent('armed', `第 ${i} 条`)
    }

    const events = await readBackgroundSyncEvents(2)
    expect(events).toHaveLength(2)
    expect(events[0]!.message).toBe('第 4 条')
  })

  it('超过上限时裁掉最旧的，且总数不超过上限', async () => {
    // 上限是 200，写 203 条（多写几条确保裁剪真的触发）
    const total = BACKGROUND_SYNC_LOG_KEEP + 3
    for (let i = 0; i < total; i += 1) {
      await appendBackgroundSyncEvent('armed', `第 ${i} 条`)
    }

    const events = await readBackgroundSyncEvents(BACKGROUND_SYNC_LOG_KEEP + 10)
    expect(events).toHaveLength(BACKGROUND_SYNC_LOG_KEEP)
    // 留下的是最新的那一批：最后一条在最前
    expect(events[0]!.message).toBe(`第 ${total - 1} 条`)
    // 最旧的三条已经被删掉
    expect(events.some(e => e.message === '第 0 条')).toBe(false)
  }, 30_000)

  it('清空后读回空数组', async () => {
    await appendBackgroundSyncEvent('armed', 'x')
    await clearBackgroundSyncEvents()

    await expect(readBackgroundSyncEvents()).resolves.toEqual([])
  })
})
