import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTimelineSettings } from '../../composables/useTimelineSettings'

/**
 * 「重新抓取全部订阅」这个运维入口在客户端只需要一件事：**真的把请求发出去**。
 *
 * 这里曾经做过两件收尾（轮询等库名变、换库后重挂 live 复制），因为旧模型的重建是
 * 「换一个空的聚合库」。新模型里用户库就是唯一真相，`/api/timeline/rebuild` 只是
 * 「绕开缓存把全部订阅入队抓一遍」，**不换库** —— 那两件收尾于是变成了「空转 60 秒、
 * 最后什么也没发生」。这条用例钉住的就是：不要再等库名。
 */

const H = vi.hoisted(() => ({
  rebuild: vi.fn(),
  settings: vi.fn(),
  updateSettings: vi.fn()
}))

const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useApi = () => ({
  timeline: { rebuild: H.rebuild, settings: H.settings, updateSettings: H.updateSettings }
})
testGlobals.errorMessage = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

beforeEach(() => {
  H.rebuild.mockReset().mockResolvedValue({ accepted: true, queued: 12 })
  H.settings.mockReset().mockResolvedValue({
    settings: { aiSummaryEnabled: false },
    defaults: { aiSummaryEnabled: false }
  })
})

describe('useTimelineSettings.rebuild', () => {
  it('只发请求，不等库名（新模型不换库）', async () => {
    const timeline = useTimelineSettings()

    await timeline.rebuild()

    expect(H.rebuild).toHaveBeenCalledTimes(1)
    // 没有定时器在跑：调用立刻返回
    expect(timeline.rebuilding.value).toBe(false)
  })

  it('运行中 rebuilding 为真，结束后归假（按钮据此转圈）', async () => {
    let finish!: (value: unknown) => void
    H.rebuild.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    const timeline = useTimelineSettings()

    const running = timeline.rebuild()
    expect(timeline.rebuilding.value).toBe(true)

    finish({ accepted: true })
    await running
    expect(timeline.rebuilding.value).toBe(false)
  })

  it('请求失败也把 rebuilding 放掉（否则按钮永远转着）', async () => {
    H.rebuild.mockRejectedValue(new Error('boom'))
    const timeline = useTimelineSettings()

    await expect(timeline.rebuild()).rejects.toThrow('boom')
    expect(timeline.rebuilding.value).toBe(false)
  })

  it('不改设置对象：重建只是重新抓，不动 aiSummaryEnabled', async () => {
    H.settings.mockResolvedValue({
      settings: { aiSummaryEnabled: true },
      defaults: { aiSummaryEnabled: false }
    })
    const timeline = useTimelineSettings()
    await timeline.load()

    await timeline.rebuild()

    expect(timeline.settings.value.aiSummaryEnabled).toBe(true)
  })
})
