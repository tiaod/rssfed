import { describe, it, expect } from 'vitest'
import { mapWithLimit } from '~/utils/concurrency'

/**
 * 有并发上限的批量异步映射（列表 enrich 读封面附件 / 源图标用）。
 *
 * 三条不变量：
 *   1. 同时在跑的不超过上限（超了就等于用「字的首帧」换「图的首帧」，见 utils/concurrency 头注释）；
 *   2. 结果顺序与输入一致（enrich 按下标回填，顺序错了封面会串条）；
 *   3. 异常原样抛出、且不会因为一条失败把队伍卡死。
 */

/** 让出一轮事件循环，便于观察「同时有几个在跑」 */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('mapWithLimit', () => {
  it('空数组：不调用 fn，直接返回空数组', async () => {
    let calls = 0
    const out = await mapWithLimit([], 4, async () => {
      calls++
      return 0
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  it('结果顺序与输入一致（不是完成的先后顺序）', async () => {
    // 前面的故意慢、后面的故意快：按完成顺序收就会反过来
    const out = await mapWithLimit([30, 20, 10, 0], 4, async (ms, i) => {
      await new Promise(resolve => setTimeout(resolve, ms))
      return i
    })
    expect(out).toEqual([0, 1, 2, 3])
  })

  it('同时执行的个数不超过上限', async () => {
    let running = 0
    let peak = 0
    await mapWithLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running++
      peak = Math.max(peak, running)
      await tick()
      running--
      return null
    })
    expect(peak).toBeLessThanOrEqual(4)
    // 顺带确认它真的并发了（不是退化成串行）
    expect(peak).toBeGreaterThan(1)
  })

  it('上限大于条数时按条数跑（不会起空工人）', async () => {
    let running = 0
    let peak = 0
    await mapWithLimit([1, 2], 8, async () => {
      running++
      peak = Math.max(peak, running)
      await tick()
      running--
      return null
    })
    expect(peak).toBe(2)
  })

  it('非法上限（0 / 负数 / NaN）退化成 1，不会卡死', async () => {
    for (const limit of [0, -3, Number.NaN]) {
      const out = await mapWithLimit([1, 2, 3], limit, async item => item * 2)
      expect(out).toEqual([2, 4, 6])
    }
  })

  it('fn 抛错时原样抛出（调用方自己决定降级）', async () => {
    await expect(mapWithLimit([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom')
      return item
    })).rejects.toThrow('boom')
  })
})
