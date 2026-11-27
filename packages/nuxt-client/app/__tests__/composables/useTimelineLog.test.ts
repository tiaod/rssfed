import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTimelineLog } from '../../composables/useTimelineLog'

/**
 * 同步日志的数据口子：**两段数据来自两个地方**，这条接线是这块面板最容易漂的地方。
 *
 *   - 轮次流水与心跳 → 服务端 PG（`/api/timeline/events`），晚一轮出现；
 *   - 各源当前状态 → 用户自己的库（`_local/schedule` → 订阅列表接口），实时。
 *
 * 前者失败要让用户看见错误；后者失败必须**静默保留旧名单**（离线时面板主体照常显示），
 * 不能因为订阅列表读不到就把整块面板变成错误块。
 */

const H = vi.hoisted(() => ({
  events: vi.fn(),
  subscriptions: vi.fn(),
  clearEvents: vi.fn()
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
// errorMessage 在源码里是 Nuxt 自动导入（没有 import 语句），只能挂全局桩
testGlobals.errorMessage = (e: unknown, fallback = '未知错误') =>
  e instanceof Error && e.message ? e.message : fallback
testGlobals.useApi = () => ({
  timeline: { events: H.events, clearEvents: H.clearEvents },
  feeds: { subscriptions: H.subscriptions }
})

const SUB = {
  feedId: 'f1',
  title: '源',
  status: 'active' as const,
  lastFetchedAt: '2026-10-17T06:00:00.000Z'
}

beforeEach(() => {
  H.events.mockReset().mockResolvedValue({ events: [], heartbeat: null })
  H.subscriptions.mockReset().mockResolvedValue([])
  H.clearEvents.mockReset().mockResolvedValue({ ok: true })
})

describe('useTimelineLog', () => {
  it('一次 load 同时拉流水与各源状态', async () => {
    H.subscriptions.mockResolvedValue([SUB])
    const log = useTimelineLog()

    await log.load()

    expect(H.events).toHaveBeenCalledWith(120)
    expect(H.subscriptions).toHaveBeenCalledTimes(1)
    expect(log.sources.value).toEqual([
      { feedId: 'f1', title: '源', status: 'active', lastFetchedAt: SUB.lastFetchedAt, errorMessage: undefined }
    ])
    expect(log.loaded.value).toBe(true)
  })

  it('订阅列表读不到时不算失败：流水照常上屏，旧名单保留', async () => {
    H.subscriptions.mockResolvedValue([SUB])
    const log = useTimelineLog()
    await log.load()

    // 第二次刷新时离线
    H.subscriptions.mockRejectedValue(new Error('offline'))
    H.events.mockResolvedValue({ events: [{ id: 1, at: '', kind: 'fetch', level: 'info', message: '抓取', data: null }], heartbeat: null })
    await log.load()

    expect(log.error.value).toBeNull()
    expect(log.events.value).toHaveLength(1)
    // 名单不清空：侧栏与面板都靠它说「哪个源失败了」
    expect(log.sources.value).toHaveLength(1)
  })

  it('流水接口失败要如实报错（这是面板的正文，不能静默）', async () => {
    H.events.mockRejectedValue(new Error('boom'))
    const log = useTimelineLog()

    await log.load()

    // 有 message 时用它（真实 errorMessage 的优先级：error.data.error → message → 兜底文案）
    expect(log.error.value).toBe('boom')
    expect(log.loaded.value).toBe(false)
  })

  it('清空只清流水，不动源名单', async () => {
    H.subscriptions.mockResolvedValue([SUB])
    const log = useTimelineLog()
    await log.load()

    await log.clear()

    expect(log.events.value).toEqual([])
    expect(log.sources.value).toHaveLength(1)
  })

  it('「加载更多」把条数翻倍，到 500 封顶', async () => {
    const log = useTimelineLog()
    // 服务端返回满额才允许继续翻
    H.events.mockResolvedValue({
      events: Array.from({ length: 500 }, (_, i) => ({ id: i, at: '', kind: 'fetch', level: 'info', message: '', data: null })),
      heartbeat: null
    })
    await log.load()
    await log.loadMore()
    expect(log.limit.value).toBe(240)
    expect(log.canLoadMore.value).toBe(true)
  })
})
