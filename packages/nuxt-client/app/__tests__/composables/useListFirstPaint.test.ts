import { describe, it, expect, vi } from 'vitest'
import { useListFirstPaint } from '~/composables/useListFirstPaint'

/**
 * 列表页首屏策略：**先上屏、再优先同步**。
 *
 * 两条不变量：
 *   1. 本地有缓存时，`renderFirstPaint()` 不许等同步就把 `loading` 放掉（点进列表不该空白几秒，
 *      更不该把正在读的内容推走）——同步在后台跑，新条目走折叠的提示条；
 *   2. 本地空的才等同步跑完再渲染一次，把内容直接上屏（不折叠）。
 */

/** 可手动放行的 Promise，用来模拟「复制还在跑」 */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('有缓存：先上屏，不等同步', () => {
  it('load 后立刻放 loading，且同步未结束也不影响', async () => {
    const gate = deferred()
    const entries = { value: 3 }
    const load = vi.fn(async () => {})
    const sync = vi.fn(() => gate.promise)
    const { loading, renderFirstPaint } = useListFirstPaint({
      load,
      hasEntries: () => entries.value > 0,
      sync
    })

    const done = renderFirstPaint()
    await done // 同步还挂着，但 renderFirstPaint 已经返回

    expect(load).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(loading.value).toBe(false)

    gate.resolve(undefined)
    await Promise.resolve()
    // 同步结束后不再重查列表：新条目交给提示条（useSyncedEntryList）
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('没缓存：等同步跑完再上屏', () => {
  it('loading 保持到同步结束，然后重查一次列表', async () => {
    const gate = deferred()
    const state = { count: 0 }
    const load = vi.fn(async () => {})
    const sync = vi.fn(() => gate.promise)
    const { loading, renderFirstPaint } = useListFirstPaint({
      load,
      hasEntries: () => state.count > 0,
      sync
    })

    const done = renderFirstPaint()
    // 让 load 与同步判定都跑完（同步仍挂着）→ loading 不该放掉，否则先闪一个空态
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(loading.value).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)

    state.count = 5 // 同步把内容拉回来了
    gate.resolve(undefined)
    await done

    expect(load).toHaveBeenCalledTimes(2)
    expect(loading.value).toBe(false)
  })

  it('同步抛错也不卡住首屏：照样渲染、照样放 loading', async () => {
    const load = vi.fn(async () => {})
    const { loading, renderFirstPaint } = useListFirstPaint({
      load,
      hasEntries: () => false,
      sync: () => Promise.reject(new Error('boom'))
    })

    await expect(renderFirstPaint()).resolves.toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
    expect(loading.value).toBe(false)
  })
})
