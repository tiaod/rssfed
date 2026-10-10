import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTimelineSettings } from '../../composables/useTimelineSettings'

/**
 * 设置页的「重建时间线」在客户端要做两件收尾，否则重建的结果在浏览器里看不见：
 *
 *   ① 服务端重建是**换一个聚合库**（复制是变更投递不是投影，就地清空搬不回来），而且是异步入队的
 *      （202）—— 寻址缓存里的旧库名会被删掉，同步打到不存在的库上；
 *   ② 本地为「被剪掉的条目」留着删除记录（tombstone，修订号更高），重建搬回来的内容在本地会被
 *      判成冲突 —— 必须丢掉本地缓存重新全量拉一遍。
 *
 * 丢本地这件事本身归同步挂载（它记着"上次同步的是哪个远端地址"，一变就丢本地重拉，见
 * usePouchDb 的 startTimelineLiveSync），所以这里只钉住编排：库名变过来就重挂同步、变不过来就
 * 放弃（同步通道自己会重试）、拿不到地址时不轮询。
 */
const H = vi.hoisted(() => ({
  rebuild: vi.fn(),
  settings: vi.fn(),
  updateSettings: vi.fn(),
  dbNameFor: vi.fn(),
  invalidate: vi.fn(),
  ensureTimelineLiveSync: vi.fn()
}))

vi.mock('~/composables/useCouchTargets', () => ({
  TIMELINE_ID: '__timeline__',
  useCouchTargets: () => ({
    dbNameFor: H.dbNameFor,
    invalidate: H.invalidate,
    remoteUrlForId: vi.fn()
  })
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useApi = () => ({
  timeline: { rebuild: H.rebuild, settings: H.settings, updateSettings: H.updateSettings }
})
testGlobals.usePouchDb = () => ({ ensureTimelineLiveSync: H.ensureTimelineLiveSync })
testGlobals.errorMessage = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

beforeEach(() => {
  vi.useFakeTimers()
  H.rebuild.mockReset().mockResolvedValue({ accepted: true })
  H.dbNameFor.mockReset()
  H.invalidate.mockReset()
  H.ensureTimelineLiveSync.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('重建时间线：换库之后客户端要跟上', () => {
  it('库名换过来了：重挂同步（换库检测在那里丢本地缓存重拉，否则重建搬回来的内容被 tombstone 挡住）', async () => {
    H.dbNameFor.mockResolvedValueOnce('user-timeline_old').mockResolvedValue('user-timeline_new')
    const timeline = useTimelineSettings()

    const running = timeline.rebuild()
    expect(timeline.rebuilding.value).toBe(true)

    await vi.advanceTimersByTimeAsync(2500)
    await running

    expect(H.rebuild).toHaveBeenCalledTimes(1)
    expect(H.invalidate).toHaveBeenCalled()
    expect(H.ensureTimelineLiveSync).toHaveBeenCalledWith(true)
    expect(timeline.rebuilding.value).toBe(false)
  })

  it('库名一直没变（服务端还没跑起来）：等够一轮就放弃，不重挂、也不报错', async () => {
    H.dbNameFor.mockResolvedValue('user-timeline_same')
    const timeline = useTimelineSettings()

    const running = timeline.rebuild()
    await vi.advanceTimersByTimeAsync(61_000)
    await running

    expect(H.ensureTimelineLiveSync).not.toHaveBeenCalled()
    expect(timeline.rebuilding.value).toBe(false)
  })

  it('还没拿到过库名（地址未知）：只发重建请求，不轮询', async () => {
    H.dbNameFor.mockResolvedValue(null)
    const timeline = useTimelineSettings()

    await timeline.rebuild()

    expect(H.rebuild).toHaveBeenCalledTimes(1)
    expect(H.ensureTimelineLiveSync).not.toHaveBeenCalled()
    expect(H.invalidate).not.toHaveBeenCalled()
  })
})
