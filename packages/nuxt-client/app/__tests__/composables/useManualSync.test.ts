import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useManualSync } from '../../composables/useManualSync'

/**
 * 手动同步门面：toast 文案 + 交给调用方的结果对象。
 *
 * SyncButton 把结果转成 `synced` 事件，列表页据此判断「这一轮有没有带来新条目」：
 * added 为 0 且同步正常收尾时，才可以顺手把折叠着的「已同步 N 条」展开上屏。
 *
 * 服务端聚合之后还要区分一种新情况：服务端在本轮请求里超时（completed=false，仍在后台聚合），
 * 这时既不能说「已是最新」，也不能说「失败」。
 *
 * 还有范围口径：一次同步聚合的是全部订阅，单源 / 分组页传 scope 后，toast 与 outcome.added
 * 只报**这个列表**多了几条 —— 别的源有更新不该被算进来（否则在单源页点同步会显示
 * 「新增 N 条」而列表一条都没多）。
 */

const H = vi.hoisted(() => ({
  syncNow: vi.fn(),
  storageBroken: null as { value: string | null } | null,
  toastAdd: vi.fn()
}))

// 只替换掉真正依赖的几样东西：同步入口、本地存储故障、toast
vi.mock('~/composables/usePouchDb', async () => {
  const { ref: rf } = await import('vue')
  return {
    usePouchDb: () => ({
      syncNow: H.syncNow,
      storageBroken: (H.storageBroken ??= rf(null) as unknown as { value: string | null })
    })
  }
})

// Nuxt auto-import 的 useToast：这里只关心给了什么反馈
const testGlobals = globalThis as unknown as Record<string, unknown>
testGlobals.useToast = () => ({ add: H.toastAdd })

/** syncNow 的结果，用例只覆盖关心的字段 */
function syncResult(over: Partial<{
  ok: string[]
  failed: Array<{ id: string, error: string }>
  skipped: number
  added: number
  addedByFeed: Record<string, number>
  serverPending: boolean
}> = {}) {
  return { ok: [], failed: [], skipped: 0, added: 0, addedByFeed: {}, serverPending: false, ...over }
}

beforeEach(() => {
  H.storageBroken = null
  H.syncNow.mockReset()
  H.toastAdd.mockClear()
})

describe('useManualSync（手动同步）', () => {
  it('服务端本轮没有新内容 → 报「已是最新」，结果里 added 为 0', async () => {
    H.syncNow.mockResolvedValue(syncResult({ skipped: 1 }))

    const outcome = await useManualSync().sync()

    expect(outcome).toEqual({ added: 0, skipped: 1, failed: 0, storageBroken: false })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '已是最新' }))
  })

  it('有新增内容 → 报「同步完成」并带上条数', async () => {
    H.syncNow.mockResolvedValue(syncResult({ ok: ['__timeline__'], added: 5 }))

    const outcome = await useManualSync().sync()

    expect(outcome).toMatchObject({ added: 5, failed: 0 })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: '同步完成',
      description: '新增 5 条'
    }))
  })

  it('服务端仍在后台聚合（本轮请求超时）→ 报「仍在聚合」，不谎报已是最新', async () => {
    H.syncNow.mockResolvedValue(syncResult({ ok: ['__timeline__'], serverPending: true }))

    const outcome = await useManualSync().sync()

    // 结果对象只报「本轮没带来新条目」，是不是服务端还在聚合由 toast 说明
    expect(outcome).toMatchObject({ added: 0, failed: 0 })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '服务端仍在聚合' }))
  })

  it('同步失败 → 结果里报出失败数，并弹失败提示', async () => {
    H.syncNow.mockResolvedValue(syncResult({ failed: [{ id: '__timeline__', error: '网络错误' }] }))

    const outcome = await useManualSync().sync()

    expect(outcome).toMatchObject({ failed: 1, added: 0 })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: '同步失败',
      description: '网络错误',
      color: 'error'
    }))
  })

  it('本地存储熔断 → 结果标记 storageBroken（调用方不能据此改列表）', async () => {
    H.syncNow.mockResolvedValue(syncResult({ added: 0 }))
    const { sync } = useManualSync()
    H.storageBroken!.value = '本地缓存写入失败（存储空间不足或数据库已损坏）'

    const outcome = await sync()

    expect(outcome!.storageBroken).toBe(true)
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '本地缓存写入失败' }))
  })

  it('上一轮还在跑时再点：本轮不执行，返回 null', async () => {
    let release!: (value: unknown) => void
    H.syncNow.mockImplementation(() => new Promise((resolve) => {
      release = resolve
    }))
    const { sync } = useManualSync()

    const first = sync()
    const second = await sync()

    expect(second).toBeNull()
    expect(H.syncNow).toHaveBeenCalledTimes(1)

    release(syncResult({ added: 1 }))
    await expect(first).resolves.toMatchObject({ added: 1 })
  })

  it('带 scope 时只报这个列表的条数（别的源的新增不算进来）', async () => {
    H.syncNow.mockResolvedValue(syncResult({
      ok: ['__timeline__'],
      added: 13,
      addedByFeed: { 'feed-a': 3, 'feed-b': 10 }
    }))

    const outcome = await useManualSync().sync(['feed-a'])

    expect(outcome).toMatchObject({ added: 3 })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: '同步完成',
      description: '新增 3 条'
    }))
  })

  it('带 scope 但本轮新条目都在别的源：added=0，toast 说清「本列表没有新条目」', async () => {
    H.syncNow.mockResolvedValue(syncResult({
      ok: ['__timeline__'],
      added: 10,
      addedByFeed: { 'feed-b': 10 }
    }))

    const outcome = await useManualSync().sync(['feed-a'])

    expect(outcome).toMatchObject({ added: 0 })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: '同步完成',
      description: '本列表没有新条目'
    }))
  })

  it('不带 scope 仍是全库口径（toast 条数取 syncNow 的 added）', async () => {
    H.syncNow.mockResolvedValue(syncResult({
      ok: ['__timeline__'],
      added: 13,
      addedByFeed: { 'feed-a': 3, 'feed-b': 10 }
    }))

    const outcome = await useManualSync().sync()

    expect(outcome).toMatchObject({ added: 13 })
    expect(H.toastAdd).toHaveBeenCalledWith(expect.objectContaining({ description: '新增 13 条' }))
  })
})
