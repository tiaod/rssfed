import { describe, it, expect, vi, afterEach } from 'vitest'
import { useListFirstPaint } from '~/composables/useListFirstPaint'

/**
 * 列表页首屏策略：**内容优先 —— 本地库第一批查询回来就上屏，同步全程在后台**。
 *
 * 三条不变量：
 *   1. `loading` 只表示「本地库的第一批查询还没回来」：`load()` 一结束就放掉，
 *      **与同步跑没跑完无关**（同步再慢也不许把首屏挂住）；
 *   2. 同步拿到的新条目不再自动 `load()` 顶掉列表 —— 那是「已同步 N 条」提示条的职责
 *      （见 useSyncedEntryList / NewEntriesBanner）。本地空、同步随后才到内容时也一样：
 *      提示条在空态下照样浮出、可点，不需要再留一条「列表为空就自动上屏」的例外；
 *   3. 骨架带一个短延迟（`skeletonDelayMs`）：几十毫秒就结束的本地查询连骨架都不画，
 *      免得闪一下；慢查询该显示骨架时一分钟都不多等。
 */

/** 可手动放行的 Promise，用来模拟「查询 / 同步还在跑」 */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** 让已排队的微任务跑完（不动计时器，配合 fake timers 用） */
const flushMicrotasks = () => Promise.resolve()

afterEach(() => {
  vi.useRealTimers()
})

describe('loading 只认本地库查询：同步全程在后台', () => {
  it('load 一结束就放 loading，同步还挂着也不等', async () => {
    const gate = deferred()
    const load = vi.fn(async () => {})
    const sync = vi.fn(() => gate.promise)
    const { loading, renderFirstPaint } = useListFirstPaint({ load, sync })

    const done = renderFirstPaint()
    await done // 同步还挂着，但 renderFirstPaint 已经返回

    expect(load).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(loading.value).toBe(false)

    gate.resolve(undefined)
    await flushMicrotasks()
    // 同步结束后不再重查列表：新条目交给提示条（useSyncedEntryList）
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('本地没有缓存时同样立刻放 loading，不空等同步', async () => {
    const gate = deferred()
    const load = vi.fn(async () => {})
    const { loading, renderFirstPaint } = useListFirstPaint({
      load,
      sync: () => gate.promise
    })

    await renderFirstPaint()

    // 本地是空的（load 没有往列表里写东西），但首屏照样交给页面：显示空态 / 提示条
    expect(loading.value).toBe(false)
    expect(load).toHaveBeenCalledTimes(1)

    gate.resolve(undefined)
    await flushMicrotasks()
    // 关键：不因为「本地空」就再查一次把内容顶上去
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('同步在 load 之后才发起（先上屏，再催同步）', async () => {
    const order: string[] = []
    const { renderFirstPaint } = useListFirstPaint({
      load: async () => {
        order.push('load')
      },
      sync: async () => {
        order.push('sync')
      }
    })

    await renderFirstPaint()
    expect(order).toEqual(['load', 'sync'])
  })

  it('同步抛错不卡首屏：loading 照样放掉，renderFirstPaint 正常 resolve', async () => {
    const load = vi.fn(async () => {})
    const { loading, renderFirstPaint } = useListFirstPaint({
      load,
      sync: () => Promise.reject(new Error('boom'))
    })

    await expect(renderFirstPaint()).resolves.toBeUndefined()
    expect(loading.value).toBe(false)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('同步同步抛错（非 Promise）也不外溢', async () => {
    const { loading, renderFirstPaint } = useListFirstPaint({
      load: async () => {},
      // 例如 syncPriority 在调用前就同步 throw（未登录之类）
      sync: () => {
        throw new Error('sync threw synchronously')
      }
    })

    await expect(renderFirstPaint()).resolves.toBeUndefined()
    expect(loading.value).toBe(false)
  })

  it('load 抛错时 loading 也要放掉，不把首屏永久停在骨架上', async () => {
    const { loading, renderFirstPaint } = useListFirstPaint({
      load: async () => {
        throw new Error('indexeddb broken')
      }
    })

    await expect(renderFirstPaint()).rejects.toThrow('indexeddb broken')
    expect(loading.value).toBe(false)
  })

  it('不传 sync（收藏页 / 历史页只查本地）也能用', async () => {
    const load = vi.fn(async () => {})
    const { loading, renderFirstPaint } = useListFirstPaint({ load })

    await renderFirstPaint()
    expect(load).toHaveBeenCalledTimes(1)
    expect(loading.value).toBe(false)
  })
})

describe('skeletonDelayMs：快到看不见的查询不闪骨架', () => {
  it('查询在延迟窗口内结束 → showSkeleton 一次都不为 true', async () => {
    vi.useFakeTimers()
    const { loading, showSkeleton, renderFirstPaint } = useListFirstPaint({
      load: async () => {},
      skeletonDelayMs: 120
    })

    // 初值必须是 false：SSR 与客户端首帧都渲染「没有骨架」，不给 hydration 留缝
    expect(showSkeleton.value).toBe(false)

    await renderFirstPaint()
    expect(loading.value).toBe(false)
    expect(showSkeleton.value).toBe(false)

    // 定时器该被清掉了：延迟窗口过去也不会再冒出骨架
    await vi.advanceTimersByTimeAsync(500)
    expect(showSkeleton.value).toBe(false)
  })

  it('查询超过延迟窗口 → 先出骨架，查询回来后立刻收掉', async () => {
    vi.useFakeTimers()
    const query = deferred()
    const { loading, showSkeleton, renderFirstPaint } = useListFirstPaint({
      load: () => query.promise,
      skeletonDelayMs: 120
    })

    const done = renderFirstPaint()

    // 未到延迟：还在等本地查询，但先不画骨架
    await vi.advanceTimersByTimeAsync(100)
    expect(loading.value).toBe(true)
    expect(showSkeleton.value).toBe(false)

    // 过了延迟：画骨架
    await vi.advanceTimersByTimeAsync(30)
    expect(showSkeleton.value).toBe(true)

    query.resolve(undefined)
    await done
    expect(loading.value).toBe(false)
    expect(showSkeleton.value).toBe(false)
  })

  it('showSkeleton 恒等价于「loading 且已过延迟」，两者不会独立漂移', async () => {
    vi.useFakeTimers()
    const query = deferred()
    const { loading, showSkeleton, renderFirstPaint } = useListFirstPaint({
      load: () => query.promise,
      skeletonDelayMs: 50
    })

    const done = renderFirstPaint()
    await vi.advanceTimersByTimeAsync(60)
    expect(loading.value).toBe(true)
    expect(showSkeleton.value).toBe(true)

    query.resolve(undefined)
    await done
    expect(loading.value).toBe(false)
    expect(showSkeleton.value).toBe(false)
  })

  it('默认延迟够挡掉「几十毫秒就回来」的本地查询', async () => {
    vi.useFakeTimers()
    const query = deferred()
    const { loading, showSkeleton, renderFirstPaint } = useListFirstPaint({
      load: () => query.promise
    })

    const done = renderFirstPaint()
    // 本地查询的常态：几十毫秒
    await vi.advanceTimersByTimeAsync(40)
    expect(showSkeleton.value).toBe(false)

    query.resolve(undefined)
    await done
    expect(loading.value).toBe(false)
    expect(showSkeleton.value).toBe(false)
  })
})
